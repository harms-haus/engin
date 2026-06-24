// ─── Error Classifier ────────────────────────────────────────────────────────
//
// Classifies unknown thrown errors and assistant-message metadata into a
// structured `ErrorKind` + retryability verdict, so callers can decide
// whether to retry, abort, or escalate.
//
// Classification precedence: abort > empty > permanent > transient > unknown.

import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';
import { safeErrorMessage } from './utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorKind = 'transient' | 'permanent' | 'abort' | 'empty' | 'unknown';

export interface Classification {
  kind: ErrorKind;
  retryable: boolean;
  delayMs?: number;
}

export interface LastAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown[];
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export interface ClassifyOptions {
  lastAssistantMessage?: LastAssistantMessage;
  contextWindow?: number;
  attempt?: number;
}

/**
 * Subset of {@link AssistantMessage} relevant to `isContextOverflow`.
 * Derived from the real type so the compiler catches structural drift.
 */
type OverflowCheckInput = Pick<AssistantMessage, 'stopReason' | 'errorMessage' | 'usage' | 'content'>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns `true` when the content array has at least one block with
 * `type === 'text'` and a non-empty `text` field.
 */
function hasTextContent(content?: unknown[]): boolean {
  if (!content || content.length === 0) return false;
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: string }).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string' &&
      ((block as Record<string, string>).text as string).length > 0,
  );
}

/** Minimum delay for transient errors (ms). */
const TRANSIENT_BASE_DELAY = 2000;
/** Maximum delay cap for transient errors (ms). */
const TRANSIENT_MAX_DELAY = 30000;

/** Compute exponential backoff with jitter, capped. */
function computeTransientDelay(attempt: number): number {
  const base = TRANSIENT_BASE_DELAY * Math.pow(2, attempt - 1);
  // Jitter: random value in [0, 500]
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, TRANSIENT_MAX_DELAY);
}

// ─── Provider-limit / billing pattern (permanent) ───────────────────────────

const PROVIDER_LIMIT_RE =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

// ─── Config / auth error patterns (permanent) ───────────────────────────────

const CONFIG_ERROR_RE =
  /unknown model|model not found|no api key|no api key for|authentication failed|invalid_api_key|\b401\b|\b403\b/i;

// ─── Context-overflow fallback regex ────────────────────────────────────────
// Secondary safety-net regex for overflow patterns pi-ai's
// isContextOverflow does not yet cover.

export const CONTEXT_OVERFLOW_FALLBACK_RE = /context.*length|maximum.*context|context window|too many tokens/i;

// ─── Transient error pattern ────────────────────────────────────────────────

const TRANSIENT_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|ECONNRESET|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

// ─── Main classification function ───────────────────────────────────────────

/**
 * Classify an error together with optional assistant-message context.
 *
 * Returns a `{ kind, retryable, delayMs? }` verdict.
 */
export function classify(err: unknown, opts?: ClassifyOptions): Classification {
  const msg = safeErrorMessage(err);
  const lastAssistant = opts?.lastAssistantMessage;
  const contextWindow = opts?.contextWindow;
  const attempt = opts?.attempt ?? 1;

  // ── 1. Abort ───────────────────────────────────────────────────────────
  if (isAbortError(err, msg)) {
    return { kind: 'abort', retryable: false };
  }

  // ── 2. Empty ───────────────────────────────────────────────────────────
  if (lastAssistant && !hasTextContent(lastAssistant.content)) {
    return { kind: 'empty', retryable: true };
  }

  // ── 3. Permanent ───────────────────────────────────────────────────────
  // (a) Provider limit / billing via assistant errorMessage
  if (lastAssistant?.errorMessage && PROVIDER_LIMIT_RE.test(lastAssistant.errorMessage)) {
    return { kind: 'permanent', retryable: false };
  }
  // (b) Config / auth errors via thrown error message
  if (CONFIG_ERROR_RE.test(msg)) {
    return { kind: 'permanent', retryable: false };
  }
  // (c) Context overflow — prefer pi-ai's isContextOverflow, fall back to regex
  if (isContextOverflowCheck(lastAssistant, contextWindow)) {
    return { kind: 'permanent', retryable: false };
  }

  // ── 4. Transient ───────────────────────────────────────────────────────
  if (isTransientCheck(lastAssistant, msg)) {
    return {
      kind: 'transient',
      retryable: true,
      delayMs: computeTransientDelay(attempt),
    };
  }

  // ── 5. Unknown (fallback) ──────────────────────────────────────────────
  return { kind: 'unknown', retryable: false };
}

// ─── Internal checks ────────────────────────────────────────────────────────

function isAbortError(err: unknown, msg: string): boolean {
  return (err instanceof Error && err.name === 'AbortError') || /abort/i.test(msg);
}

function isContextOverflowCheck(lastAssistant: LastAssistantMessage | undefined, contextWindow?: number): boolean {
  if (lastAssistant) {
    // Build an AssistantMessage-shaped object for isContextOverflow.
    // When usage is absent we pass zeros — only error-message-based overflow
    // detection works in that case; silent overflow (usage > contextWindow)
    // cannot be detected without usage data.
    const assistantMsg: OverflowCheckInput = {
      stopReason: (lastAssistant.stopReason ?? 'error') as AssistantMessage['stopReason'],
      errorMessage: lastAssistant.errorMessage,
      usage: {
        input: lastAssistant.usage?.input ?? 0,
        output: lastAssistant.usage?.output ?? 0,
        cacheRead: lastAssistant.usage?.cacheRead ?? 0,
      } as AssistantMessage['usage'],
      content: (lastAssistant.content ?? []) as AssistantMessage['content'],
    };
    // Primary check: pi-ai's isContextOverflow
    if (isContextOverflow(assistantMsg as AssistantMessage, contextWindow)) {
      return true;
    }
    // Secondary check: regex fallback for patterns not yet covered by isContextOverflow
    if (lastAssistant.errorMessage && CONTEXT_OVERFLOW_FALLBACK_RE.test(lastAssistant.errorMessage)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether the error is transient based on assistant stopReason or
 * the thrown-error message.
 */
function isTransientCheck(lastAssistant: LastAssistantMessage | undefined, msg: string): boolean {
  if (lastAssistant?.stopReason === 'error') return true;
  return TRANSIENT_RE.test(msg);
}

// ─── extractLastAssistantMessage ────────────────────────────────────────────

/**
 * Given a session-like object with a `messages` array, extract the last
 * assistant message's `{ stopReason, errorMessage, content, usage }`.
 *
 * Returns `undefined` when the session is missing, has no messages, or
 * contains no assistant message.
 */
export function extractLastAssistantMessage(
  session: { messages?: unknown[] } | undefined,
): LastAssistantMessage | undefined {
  if (!session?.messages || session.messages.length === 0) return undefined;

  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (typeof msg === 'object' && msg !== null && 'role' in msg && (msg as { role?: string }).role === 'assistant') {
      const m = msg as Record<string, unknown>;

      // Extract usage defensively — coerce numbers, ignore non-numbers
      let usage: LastAssistantMessage['usage'] | undefined;
      const rawUsage = m.usage;
      if (typeof rawUsage === 'object' && rawUsage !== null) {
        const u = rawUsage as Record<string, unknown>;
        const extracted: { input?: number; output?: number; cacheRead?: number } = {};
        if (typeof u.input === 'number') extracted.input = u.input;
        if (typeof u.output === 'number') extracted.output = u.output;
        if (typeof u.cacheRead === 'number') extracted.cacheRead = u.cacheRead;
        if (extracted.input !== undefined || extracted.output !== undefined || extracted.cacheRead !== undefined) {
          usage = extracted;
        }
      }

      return {
        stopReason: typeof m.stopReason === 'string' ? m.stopReason : undefined,
        errorMessage: typeof m.errorMessage === 'string' ? m.errorMessage : undefined,
        content: Array.isArray(m.content) ? m.content : undefined,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
  }
  return undefined;
}
