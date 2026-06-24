// ─── Structured Output ──────────────────────────────────────────────────────
import { parseJsonWithRepair } from '@earendil-works/pi-ai';
import type { ZodType } from 'zod';
import { describeSchema } from './schema-describe.js';
import type { StructuredOutputOptions } from './types.js';

// ─── extractJsonFromText ────────────────────────────────────────────────────

/**
 * Attempt to extract a JSON string from an arbitrary text block.
 *
 * Strategy:
 * 1. Look for ```json ... ``` fenced code blocks.
 * 2. Otherwise, find the first `{` or `[` and use bracket counting to find the
 *    matching close bracket.
 * 3. Return `null` if no JSON is found.
 */
export function extractJsonFromText(text: string): string | null {
  // 1. Try fenced code block
  const fenceMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // 2. Try bracket counting from every { or [ candidate
  const candidates: { start: number; open: string; close: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      candidates.push({ start: i, open: '{', close: '}' });
    } else if (text[i] === '[') {
      candidates.push({ start: i, open: '[', close: ']' });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  for (const { start, open: openChar, close: closeChar } of candidates) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        if (inString) {
          escape = true;
        }
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          const extracted = text.slice(start, i + 1);
          try {
            JSON.parse(extracted);
            return extracted;
          } catch {
            // Not valid JSON — try next candidate
            break;
          }
        }
      }
    }
  }

  // No valid JSON found from any candidate
  return null;
}

// ─── promptForStructured ────────────────────────────────────────────────────

/** Minimal harness interface — just enough to call prompt(). */
export interface PromptableHarness {
  prompt: (text: string) => Promise<void>;
  getLastAssistantText: () => string | undefined;
  /** Abort an in-flight prompt (e.g. to cancel an LLM call on timeout). */
  abort?: () => Promise<void>;
}

/**
 * Internal sentinel error thrown by the per-prompt timeout. Distinguishes
 * timeout-driven retries from genuine prompt failures (connection resets,
 * auth errors, provider 5xx) in the catch block.
 */
class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Step timed out after ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Prompt the harness and parse the response into a Zod-validated structure.
 *
 * Retries up to `maxRetries` times (default 3), appending error feedback to
 * the prompt on each failure.
 *
 * @returns Promise<{result: T; attempts: number}> containing the Zod-validated
 *   data and the number of attempts made (1-based).
 */
export async function promptForStructured<T>(
  harness: PromptableHarness,
  prompt: string,
  schema: ZodType<T>,
  options?: StructuredOutputOptions,
): Promise<{ result: T; attempts: number }> {
  const maxRetries = options?.maxRetries ?? 3;
  const stepTimeoutMs = options?.stepTimeoutMs;
  const hasTimeout = stepTimeoutMs != null && Number.isFinite(stepTimeoutMs) && stepTimeoutMs > 0;
  const originalPrompt = prompt;
  const schemaDesc = schemaToString(schema);
  let currentPrompt = `${prompt}\n\n${buildSchemaInstruction(schemaDesc)}`;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Per-prompt timeout: only when stepTimeoutMs is a positive finite number.
    // Raced via Promise.race so a hung prompt is rejected. Timeout errors are
    // caught and treated as retryable (like "no JSON found") so the loop can
    // retry with a fresh prompt. On normal completion the timer is cleared in
    // the finally block. When unset/0/NaN/negative: identical to today.
    if (hasTimeout) {
      const timeoutMs = stepTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // When the timeout wins the race, abort() may cause the in-flight
      // prompt to reject later. Attach a no-op handler so that orphaned
      // rejection does not crash the process as an unhandled rejection.
      // Applied ONLY in the timeout-wins path so genuine prompt errors
      // (connection reset, auth failure) still propagate when the prompt
      // rejects BEFORE the timeout.
      const promptPromise = harness.prompt(currentPrompt);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          // Best-effort: abort the in-flight prompt on timeout. Ignore failures
          // since the harness may not support abort or the call may race with
          // the prompt settling on its own.
          await harness.abort?.().catch(() => {
            /* best-effort */
          });
          reject(new StepTimeoutError(timeoutMs));
        }, timeoutMs);
      });
      try {
        await Promise.race([promptPromise, timeoutPromise]);
      } catch (err) {
        if (err instanceof StepTimeoutError) {
          // Timeout: abort was already dispatched; suppress the prompt's
          // eventual rejection (abort-triggered) and retry with a fresh prompt.
          promptPromise.catch(() => {
            /* swallow abort-triggered rejection */
          });
          lastError = err.message;
          currentPrompt = buildRetryPrompt(originalPrompt, schemaDesc, lastError, 'timeout');
          continue;
        }
        // Genuine prompt error (connection reset, auth failure, provider 5xx):
        // propagate immediately — matches the non-timeout path where errors
        // flow straight to the caller.
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      await harness.prompt(currentPrompt);
    }
    const text = harness.getLastAssistantText() ?? '';

    const jsonStr = extractJsonFromText(text);
    if (jsonStr === null) {
      // An empty/whitespace-only reply almost always means the model ended its
      // turn on a thinking block or a `tool_use` (or hit max output tokens) —
      // `getLastAssistantText()` returns only `text` blocks, so there is nothing
      // to extract. Surface that distinctly so the retry can target it.
      const empty = text.trim().length === 0;
      lastError = empty
        ? 'No JSON found in response (empty reply — no text block was produced)'
        : 'No JSON found in response';
      currentPrompt = buildRetryPrompt(originalPrompt, schemaDesc, lastError, empty ? 'empty' : 'no-json');
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonWithRepair(jsonStr);
    } catch (err) {
      lastError = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
      currentPrompt = buildRetryPrompt(originalPrompt, schemaDesc, lastError, 'parse');
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { result: result.data, attempts: attempt + 1 };
    }

    lastError = `Schema validation error: ${result.error.message}`;
    currentPrompt = buildRetryPrompt(originalPrompt, schemaDesc, lastError, 'validation');
  }

  throw new Error(`Failed to produce structured output after ${maxRetries} attempts: ${lastError}`);
}

// ─── schemaToString ─────────────────────────────────────────────────────────

/**
 * Convert a Zod schema into a human-readable description string.
 * Falls back to JSON.stringify for unrecognized shapes.
 */
export function schemaToString(schema: ZodType): string {
  try {
    return describeSchema(schema._def);
  } catch {
    return JSON.stringify(schema);
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Build the JSON-format instruction appended to the initial (and retry) prompt.
 *
 * Emphasizes that the ENTIRE reply must be the JSON object — no prose, no
 * markdown fences, and crucially NO tool calls. This matters for
 * structured-output steps running on models with extended thinking or retained
 * read tools: without an explicit "emit the JSON as text, do not call tools"
 * instruction, such a model can end its turn on a thinking block or a
 * `tool_use` with no text block, yielding an empty `getLastAssistantText()`
 * → "No JSON found in response".
 */
function buildSchemaInstruction(schemaDesc: string): string {
  return [
    '## Response Format (required)',
    'Respond with ONLY a single valid JSON object matching the schema below.',
    '- No prose, explanations, or commentary before or after the JSON.',
    '- No markdown code fences (```), no headings — output the raw JSON object.',
    '- Do NOT call any tools and do NOT end your turn on a thinking block. Emit the JSON object directly as text.',
    '',
    'JSON schema:',
    schemaDesc,
  ].join('\n');
}

/**
 * Build a retry prompt that re-asserts the format contract and adds a
 * reason-specific hint so the model knows exactly how the previous reply fell
 * short (empty / no-json / unparseable / schema-violating).
 */
function buildRetryPrompt(
  originalPrompt: string,
  schemaDesc: string,
  error: string,
  reason: 'timeout' | 'empty' | 'no-json' | 'parse' | 'validation',
): string {
  const hint =
    reason === 'timeout'
      ? 'The previous prompt call timed out before any response was received. Please respond promptly with ONLY the JSON object.'
      : reason === 'empty'
        ? 'Your previous reply contained NO text at all — it ended on a thinking block or a tool call, or was truncated. You MUST reply with the JSON object as text now: do not call any tools, and do not finish without emitting the JSON.'
        : reason === 'no-json'
          ? 'Your previous reply contained no parseable JSON. Reply with ONLY the raw JSON object — no surrounding prose and no code fences.'
          : reason === 'parse'
            ? 'Your previous reply looked like JSON but failed to parse. Reply with ONLY a corrected, valid JSON object.'
            : 'Your previous reply was valid JSON but did not match the schema. Reply with ONLY a JSON object that conforms to the schema.';

  return [
    originalPrompt,
    '',
    buildSchemaInstruction(schemaDesc),
    '',
    '--- Previous attempt failed ---',
    `Error: ${error}`,
    hint,
  ].join('\n');
}
