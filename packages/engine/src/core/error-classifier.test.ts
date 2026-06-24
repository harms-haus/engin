// ─── Tests for core/error-classifier.ts — error classification & extraction ──
//
// Validates the `classify` function that categorises unknown errors + assistant
// metadata into `{ kind, retryable, delayMs? }`, and the `extractLastAssistantMessage`
// helper that pulls structured data from a session's message array.
//
// Classification precedence: abort > empty > permanent > transient > unknown.
//
// Module under test: ./error-classifier.js

import { describe, expect, it } from 'bun:test';

import type { LastAssistantMessage } from './error-classifier.js';
import { classify, extractLastAssistantMessage } from './error-classifier.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Assistant message with a stopReason, optional errorMessage, and text content. */
function assistantWithError(stopReason: string, errorMsg: string): LastAssistantMessage {
  return {
    stopReason,
    errorMessage: errorMsg,
    content: [{ type: 'text', text: 'some text' }],
  };
}

// ─── Abort ──────────────────────────────────────────────────────────────────

describe('classify — abort', () => {
  it('classifies an Error with name === AbortError as abort', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = classify(err);
    expect(result.kind).toBe('abort');
    expect(result.retryable).toBe(false);
  });

  it('classifies an error whose message matches /abort/i as abort', () => {
    const result = classify(new Error('User abort signal received'));
    expect(result.kind).toBe('abort');
    expect(result.retryable).toBe(false);
  });

  it('classifies "Abort" (case-insensitive) as abort', () => {
    const result = classify(new Error('ABORT'));
    expect(result.kind).toBe('abort');
    expect(result.retryable).toBe(false);
  });
});

// ─── Empty ──────────────────────────────────────────────────────────────────

describe('classify — empty', () => {
  it('empty content array → empty', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: { content: [] },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });

  it('content with only a thinking block (no text) → empty', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: {
        content: [{ type: 'thinking', thinking: 'deep thoughts' }],
      },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });

  it('content with only a toolCall block (no text) → empty', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: {
        content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }],
      },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });

  it('content undefined → empty (hasTextContent returns false)', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: { content: undefined },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });

  it('lastAssistantMessage present but no content field at all → empty', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: { stopReason: 'stop' },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });

  it('content with thinking + toolCall but no text → empty', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'toolCall', id: 'tc-2', name: 'read', arguments: {} },
        ],
      },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });
});

// ─── Permanent — provider limits / billing ──────────────────────────────────

describe('classify — permanent (provider limit / billing)', () => {
  const limitPatterns = [
    { label: 'GoUsageLimitError', msg: 'GoUsageLimitError: quota exceeded for this org' },
    { label: 'FreeUsageLimitError', msg: 'FreeUsageLimitError: you have used all free credits' },
    { label: 'Monthly usage limit reached', msg: 'Monthly usage limit reached for this account' },
    { label: 'available balance', msg: 'Your available balance has been exhausted' },
    { label: 'insufficient_quota', msg: 'insufficient_quota: not enough credits remaining' },
    { label: 'out of budget', msg: 'Request failed: out of budget' },
    { label: 'quota exceeded', msg: 'quota exceeded for model gpt-4' },
    { label: 'billing', msg: 'billing error: payment method required' },
  ];

  for (const { label, msg } of limitPatterns) {
    it(`provider-limit message "${label}" → permanent, retryable=false`, () => {
      const result = classify(new Error('something'), {
        lastAssistantMessage: assistantWithError('error', msg),
      });
      expect(result.kind).toBe('permanent');
      expect(result.retryable).toBe(false);
      expect(result.delayMs).toBeUndefined();
    });
  }
});

// ─── Permanent — model not found / unknown model ────────────────────────────

describe('classify — permanent (model not found / unknown model)', () => {
  it('"Unknown model X for provider Y" → permanent', () => {
    const result = classify(new Error('Unknown model "foo" for provider "bar"'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('"model not found" → permanent', () => {
    const result = classify(new Error('model not found: gpt-99'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });
});

// ─── Permanent — no API key / auth ──────────────────────────────────────────

describe('classify — permanent (no API key / authentication)', () => {
  it('"No API key for foo" → permanent', () => {
    const result = classify(new Error('No API key for openai'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('"Authentication failed for X" → permanent', () => {
    const result = classify(new Error('Authentication failed for provider anthropic'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('"invalid_api_key" → permanent', () => {
    const result = classify(new Error('invalid_api_key'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('HTTP 401 → permanent', () => {
    const result = classify(new Error('Request failed with status 401'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('HTTP 403 → permanent', () => {
    const result = classify(new Error('Request returned 403 Forbidden'));
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });
});

// ─── Permanent — context overflow ───────────────────────────────────────────

describe('classify — permanent (context overflow)', () => {
  it('via isContextOverflow: stopReason=error + errorMessage matching overflow pattern', () => {
    // isContextOverflow checks for patterns like "exceeds the context window"
    const result = classify(new Error('provider error'), {
      lastAssistantMessage: assistantWithError('error', 'Your input exceeds the context window of this model'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('via isContextOverflow: "prompt is too long" (Anthropic pattern)', () => {
    const result = classify(new Error('provider error'), {
      lastAssistantMessage: assistantWithError('error', 'prompt is too long: 213462 tokens > 200000 maximum'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('via regex fallback: "context window exceeded" in errorMessage', () => {
    // This exercises the CONTEXT_OVERFLOW_FALLBACK_RE path — pi-ai does
    // not match bare "context window exceeded" (requires "exceeds the")
    const result = classify(new Error('provider error'), {
      lastAssistantMessage: assistantWithError('error', 'Request failed: context window exceeded for model'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('via pi-ai isContextOverflow: "too many tokens" in errorMessage', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: assistantWithError('error', 'too many tokens in conversation'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });

  it('via pi-ai isContextOverflow: "maximum context length" in errorMessage', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: assistantWithError('error', 'maximum context length exceeded'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBeUndefined();
  });
});

// ─── Transient ──────────────────────────────────────────────────────────────

describe('classify — transient', () => {
  const transientPatterns = [
    { label: '429', msg: 'HTTP 429 Too Many Requests' },
    { label: '500', msg: 'Internal Server Error 500' },
    { label: '502', msg: 'Bad Gateway 502' },
    { label: '503', msg: 'Service Unavailable 503' },
    { label: '504', msg: 'Gateway Timeout 504' },
    { label: 'overloaded', msg: 'The provider is currently overloaded' },
    { label: 'rate limit', msg: 'Rate limit exceeded, please retry' },
    { label: 'too many requests', msg: 'too many requests in this time window' },
    { label: 'connection refused', msg: 'ECONNREFUSED connection refused' },
    { label: 'socket hang up', msg: 'socket hang up' },
    { label: 'fetch failed', msg: 'fetch failed' },
    { label: 'websocket closed', msg: 'websocket closed unexpectedly' },
    { label: 'ECONNRESET', msg: 'read ECONNRESET' },
    { label: 'timeout', msg: 'timeout' },
    { label: 'timed out', msg: 'Request timed out after 30s' },
    { label: 'terminated', msg: 'Connection terminated' },
    { label: 'retry delay', msg: 'retry delay exceeded' },
    { label: 'service unavailable', msg: 'service unavailable at this time' },
    { label: 'server error', msg: 'server error: unexpected failure' },
    { label: 'internal error', msg: 'internal error in provider backend' },
    { label: 'network error', msg: 'network error occurred' },
    { label: 'connection error', msg: 'connection error: reset by peer' },
    { label: 'connection lost', msg: 'connection lost to upstream' },
    { label: 'websocket error', msg: 'websocket error during handshake' },
    { label: 'other side closed', msg: 'other side closed the connection' },
    { label: 'upstream connect', msg: 'upstream connect error' },
    { label: 'reset before headers', msg: 'reset before headers received' },
    { label: 'ended without', msg: 'stream ended without message_stop' },
    { label: 'stream ended before message_stop', msg: 'stream ended before message_stop' },
    { label: 'http2 request did not get a response', msg: 'http2 request did not get a response' },
    { label: 'provider returned error', msg: 'provider returned error 500' },
  ];

  for (const { label, msg } of transientPatterns) {
    it(`"${label}" → transient, retryable=true, positive delayMs`, () => {
      const result = classify(new Error(msg), { attempt: 1 });
      expect(result.kind).toBe('transient');
      expect(result.retryable).toBe(true);
      expect(result.delayMs).toBeGreaterThan(0);
    });
  }

  it('stopReason === "error" (no message match needed) → transient', () => {
    const result = classify(new Error('something unrelated'), {
      lastAssistantMessage: assistantWithError('error', 'some provider-specific error text'),
    });
    // The stopReason === 'error' makes it transient regardless of the message
    expect(result.kind).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.delayMs).toBeGreaterThan(0);
  });
});

// ─── Unknown fallback ───────────────────────────────────────────────────────

describe('classify — unknown', () => {
  it('a message that matches nothing → unknown, retryable=false', () => {
    const result = classify(new Error('xyzzy foobarbaz'));
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('a non-Error thrown value → unknown', () => {
    const result = classify('string error value');
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('an object thrown value → unknown', () => {
    const result = classify({ code: 'WEIRD', detail: 'something odd' });
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('null → unknown', () => {
    const result = classify(null);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('undefined → unknown', () => {
    const result = classify(undefined);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });
});

// ─── Precedence ─────────────────────────────────────────────────────────────

describe('classify — precedence', () => {
  it('AbortError whose lastAssistantMessage is empty → abort (abort beats empty)', () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    const result = classify(err, {
      lastAssistantMessage: { content: [] },
    });
    expect(result.kind).toBe('abort');
    expect(result.retryable).toBe(false);
  });

  it('abort message whose lastAssistantMessage is empty → abort', () => {
    const result = classify(new Error('User abort'), {
      lastAssistantMessage: { content: [] },
    });
    expect(result.kind).toBe('abort');
  });

  it('transient-looking err message but provider-limit errorMessage → permanent (permanent beats transient)', () => {
    // err message looks transient ("500 internal error") but assistant
    // errorMessage indicates a billing/quota issue
    const result = classify(new Error('500 internal error'), {
      lastAssistantMessage: assistantWithError('error', 'GoUsageLimitError: quota reached'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('stopReason==="error" with provider-limit errorMessage → permanent (permanent beats transient)', () => {
    // stopReason "error" would make it transient, but the errorMessage matches
    // a billing pattern so it should be classified as permanent
    const result = classify(new Error('something'), {
      lastAssistantMessage: assistantWithError('error', 'quota exceeded for this organization'),
    });
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('permanent config error beats transient stopReason', () => {
    const result = classify(new Error('unknown model xyz'), {
      lastAssistantMessage: assistantWithError('error', 'generic error'),
    });
    // "unknown model" matches CONFIG_ERROR_RE → permanent
    expect(result.kind).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('empty content beats permanent config error (empty > permanent)', () => {
    // The error message matches CONFIG_ERROR_RE ("unknown model"), but the
    // assistant content is empty — empty takes precedence over permanent.
    const result = classify(new Error('Unknown model xyz'), {
      lastAssistantMessage: {
        stopReason: 'error',
        errorMessage: 'generic error',
        content: [],
      },
    });
    expect(result.kind).toBe('empty');
    expect(result.retryable).toBe(true);
  });
});

// ─── delayMs bounds ─────────────────────────────────────────────────────────

describe('classify — delayMs bounds', () => {
  it('transient: delayMs > 0 and never exceeds 30000', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = classify(new Error('rate limit exceeded'), { attempt });
      expect(result.kind).toBe('transient');
      expect(result.delayMs!).toBeGreaterThan(0);
      expect(result.delayMs!).toBeLessThanOrEqual(30000);
    }
  });

  it('transient: delayMs increases roughly monotonically across attempts 1–4', () => {
    // Capture multiple samples per attempt to account for jitter.
    // For each attempt, the minimum possible value is 2000 * 2^(attempt-1)
    // (jitter >= 0) and the maximum is min(2000 * 2^(attempt-1) + 500, 30000).
    // We verify that the BASE (without jitter) is strictly increasing.
    const minBases = [1, 2, 3, 4].map((a) => 2000 * Math.pow(2, a - 1));
    // minBases = [2000, 4000, 8000, 16000]
    for (let i = 1; i < minBases.length; i++) {
      expect(minBases[i]).toBeGreaterThan(minBases[i - 1]);
    }

    // Now verify actual classify results: the delayMs should be at least the
    // base (no jitter would give exactly the base). Run several trials and
    // verify that the average trend is upward.
    const trials = 20;
    const averages: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      let sum = 0;
      for (let t = 0; t < trials; t++) {
        const result = classify(new Error('overloaded'), { attempt });
        sum += result.delayMs!;
      }
      averages.push(sum / trials);
    }
    // Each average should be at least the base for that attempt
    for (let i = 0; i < averages.length; i++) {
      expect(averages[i]).toBeGreaterThanOrEqual(2000 * Math.pow(2, i));
    }
    // Averages should trend upward (each > previous)
    for (let i = 1; i < averages.length; i++) {
      expect(averages[i]).toBeGreaterThan(averages[i - 1]);
    }
  });

  it('permanent: delayMs is undefined', () => {
    const result = classify(new Error('unknown model foo'));
    expect(result.kind).toBe('permanent');
    expect(result.delayMs).toBeUndefined();
  });

  it('abort: delayMs is undefined', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = classify(err);
    expect(result.kind).toBe('abort');
    expect(result.delayMs).toBeUndefined();
  });

  it('unknown: delayMs is undefined', () => {
    const result = classify(new Error('xyzzy'));
    expect(result.kind).toBe('unknown');
    expect(result.delayMs).toBeUndefined();
  });

  it('empty: delayMs is undefined', () => {
    const result = classify(new Error('something'), {
      lastAssistantMessage: { content: [] },
    });
    expect(result.kind).toBe('empty');
    expect(result.delayMs).toBeUndefined();
  });
});

// ─── extractLastAssistantMessage ────────────────────────────────────────────

describe('extractLastAssistantMessage', () => {
  it('returns the last assistant message with stopReason, errorMessage, content', () => {
    const session = {
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'rate limit',
          content: [{ type: 'text', text: 'oops' }],
        },
        { role: 'user', content: 'retry' },
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'done' }],
        },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result).toStrictEqual({
      stopReason: 'stop',
      errorMessage: undefined,
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('returns undefined when messages is undefined', () => {
    expect(extractLastAssistantMessage(undefined)).toBeUndefined();
  });

  it('returns undefined when messages is empty', () => {
    expect(extractLastAssistantMessage({ messages: [] })).toBeUndefined();
  });

  it('returns undefined when no assistant message exists', () => {
    const session = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'result' },
      ],
    };
    expect(extractLastAssistantMessage(session)).toBeUndefined();
  });

  it('returns undefined when session has no messages property', () => {
    expect(extractLastAssistantMessage({})).toBeUndefined();
  });

  it('returns undefined when session is undefined messages', () => {
    expect(extractLastAssistantMessage({ messages: undefined })).toBeUndefined();
  });

  it('handles assistant message with no optional fields', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result).toStrictEqual({
      stopReason: undefined,
      errorMessage: undefined,
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('is defensive against malformed shapes: non-object messages', () => {
    const session = {
      messages: ['string', 42, null, undefined, true],
    };
    expect(extractLastAssistantMessage(session)).toBeUndefined();
  });

  it('is defensive against malformed shapes: missing content field', () => {
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    };
    const result = extractLastAssistantMessage(session);
    expect(result).toStrictEqual({
      stopReason: 'stop',
      errorMessage: undefined,
      content: undefined,
    });
  });

  it('is defensive against malformed shapes: non-array content', () => {
    const session = {
      messages: [{ role: 'assistant', content: 'not an array' }],
    };
    const result = extractLastAssistantMessage(session);
    expect(result).toStrictEqual({
      stopReason: undefined,
      errorMessage: undefined,
      content: undefined,
    });
  });

  it('is defensive against malformed shapes: non-string stopReason/errorMessage', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          stopReason: 123,
          errorMessage: { nested: true },
          content: [],
        },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result).toStrictEqual({
      stopReason: undefined,
      errorMessage: undefined,
      content: [],
    });
  });

  it('extracts usage when present with valid numeric fields', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input: 1234,
            output: 567,
            cacheRead: 89,
            cacheWrite: 10,
            totalTokens: 1900,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result?.usage).toStrictEqual({ input: 1234, output: 567, cacheRead: 89 });
  });

  it('omits usage when assistant message has no usage field', () => {
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
    };
    const result = extractLastAssistantMessage(session);
    expect(result?.usage).toBeUndefined();
  });

  it('defensively extracts only numeric usage fields, ignoring non-numbers', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [],
          usage: { input: 'not-a-number', output: 42, cacheRead: null, cacheWrite: 99 },
        },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result?.usage).toStrictEqual({ output: 42 });
  });

  it('picks the LAST assistant message even when others precede it', () => {
    const session = {
      messages: [
        { role: 'assistant', stopReason: 'error', errorMessage: 'first err', content: [] },
        { role: 'user', content: 'try again' },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'success' }] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'extra' }] },
      ],
    };
    const result = extractLastAssistantMessage(session);
    expect(result?.stopReason).toBe('stop');
    expect(result?.content).toStrictEqual([{ type: 'text', text: 'extra' }]);
  });
});
