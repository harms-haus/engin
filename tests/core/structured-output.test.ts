import { describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import {
  extractJsonFromText,
  promptForStructured,
  schemaToString,
  type PromptableHarness,
} from '../../src/core/structured-output.ts';

// ─── extractJsonFromText ────────────────────────────────────────────────────

describe('extractJsonFromText', () => {
  it('extracts a pure JSON object', () => {
    const input = '{"name": "Alice", "age": 30}';
    expect(extractJsonFromText(input)).toBe('{"name": "Alice", "age": 30}');
  });

  it('extracts a pure JSON array', () => {
    const input = '[1, 2, 3]';
    expect(extractJsonFromText(input)).toBe('[1, 2, 3]');
  });

  it('extracts JSON from a fenced code block', () => {
    const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    expect(extractJsonFromText(input)).toBe('{"key": "value"}');
  });

  it('extracts JSON with commentary before and after', () => {
    const input = 'The answer is {"x": 10} as shown above. Hope that helps!';
    expect(extractJsonFromText(input)).toBe('{"x": 10}');
  });

  it('handles nested JSON with inner braces', () => {
    const input = 'result: {"outer": {"inner": {"deep": true}}} end';
    expect(extractJsonFromText(input)).toBe('{"outer": {"inner": {"deep": true}}}');
  });

  it('returns null when no JSON is present', () => {
    expect(extractJsonFromText('no json here at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonFromText('')).toBeNull();
  });
});

// ─── extractJsonFromText edge cases ─────────────────────────────────────────

describe('extractJsonFromText edge cases', () => {
  it('skips { in prose before valid JSON', () => {
    const input = 'use {x} to get {"a": 1}';
    expect(extractJsonFromText(input)).toBe('{"a": 1}');
  });

  it('extracts first valid JSON array including short arrays like [1]', () => {
    // [1] is valid JSON, so it is extracted first
    const input = 'see [1] for ["a","b"]';
    expect(extractJsonFromText(input)).toBe('[1]');
  });

  it('finds valid JSON after invalid JSON', () => {
    const input = 'broken { bad } real {"ok":true}';
    expect(extractJsonFromText(input)).toBe('{"ok":true}');
  });

  it('extracts deeply nested JSON', () => {
    const input = '{"a":{"b":{"c":{"d":1}}}}';
    expect(extractJsonFromText(input)).toBe('{"a":{"b":{"c":{"d":1}}}}');
  });

  it('extracts JSON array with nested objects', () => {
    const input = '[{"x":1},{"y":2}]';
    expect(extractJsonFromText(input)).toBe('[{"x":1},{"y":2}]');
  });

  it('extracts empty object', () => {
    expect(extractJsonFromText('{}')).toBe('{}');
  });

  it('extracts empty array', () => {
    expect(extractJsonFromText('[]')).toBe('[]');
  });

  it('returns null for unmatched opening bracket', () => {
    expect(extractJsonFromText('just a [ with no close')).toBeNull();
  });

  it('extracts first valid JSON when multiple are present', () => {
    const input = 'first: {"a":1} second: {"b":2}';
    expect(extractJsonFromText(input)).toBe('{"a":1}');
  });
});

// ─── promptForStructured ────────────────────────────────────────────────────

describe('promptForStructured', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  function makeHarness(responses: string[]): PromptableHarness {
    let callIndex = 0;
    let lastText: string | undefined;
    return {
      prompt: mock(async (_text: string) => {
        lastText = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
      }),
      getLastAssistantText: () => lastText,
    };
  }

  it('returns parsed result on first valid try', async () => {
    const harness = makeHarness(['{"name": "Alice", "age": 30}']);
    const { result, attempts } = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Alice', age: 30 });
    expect(attempts).toBe(1);
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  it('succeeds on retry after invalid JSON first', async () => {
    const harness = makeHarness(['this is not json at all', '{"name": "Bob", "age": 25}']);
    const { result, attempts } = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Bob', age: 25 });
    expect(attempts).toBe(2);
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  it('succeeds on retry after valid JSON with wrong schema first', async () => {
    const harness = makeHarness(['{"name": "Charlie", "age": "not-a-number"}', '{"name": "Diana", "age": 42}']);
    const { result, attempts } = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Diana', age: 42 });
    expect(attempts).toBe(2);
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting maxRetries', async () => {
    const harness = makeHarness(['no json', 'still no json', 'still no json']);
    await expect(
      promptForStructured(harness, 'give me a person', schema, {
        maxRetries: 3,
      }),
    ).rejects.toThrow(/Failed to produce structured output after 3 attempts/);
    expect(harness.prompt).toHaveBeenCalledTimes(3);
  });

  it('retry prompts include schema info and error message', async () => {
    const harness = makeHarness(['not json', '{"name": "Eve", "age": 28}']);
    await promptForStructured(harness, 'original prompt', schema, {
      maxRetries: 3,
    });

    // Second call should contain retry info
    const secondCall = (harness.prompt as ReturnType<typeof mock>).mock.calls[1][0] as string;
    expect(secondCall).toContain('original prompt');
    expect(secondCall).toContain('Previous attempt failed');
    expect(secondCall).toContain('No JSON found in response');
    expect(secondCall).toContain('schema');
  });

  it('respects custom maxRetries', async () => {
    const harness = makeHarness(['bad', 'bad', 'bad', 'bad']);
    await expect(promptForStructured(harness, 'test', schema, { maxRetries: 2 })).rejects.toThrow(/after 2 attempts/);
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  // ─── Error message readability & schema in initial prompt ─────────────────

  it('error message is readable (not [object Object]) when validation fails', async () => {
    const harness = makeHarness(['{"name": "X", "age": "not-a-number"}']);
    let caughtError: Error | undefined;
    try {
      await promptForStructured(harness, 'give me a person', schema, { maxRetries: 1 });
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).not.toContain('[object Object]');
    // The error should contain a readable description from the Zod validation
    expect(caughtError!.message).toMatch(/number|Expected|received|Schema validation/i);
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  it('initial prompt includes schema description', async () => {
    const harness = makeHarness(['{"name": "Alice", "age": 30}']);
    await promptForStructured(harness, 'give me a person', schema);

    const firstPrompt = (harness.prompt as ReturnType<typeof mock>).mock.calls[0][0] as string;
    // Schema info should be embedded in the very first prompt
    expect(firstPrompt).toContain('name');
    expect(firstPrompt).toContain('string');
    expect(firstPrompt).toContain('age');
    expect(firstPrompt).toContain('number');
    expect(firstPrompt).toContain('schema');
  });

  it('retry prompt has readable validation error (not [object Object])', async () => {
    const harness = makeHarness(['{"name": "Charlie", "age": "not-a-number"}', '{"name": "Diana", "age": 42}']);
    const { result, attempts } = await promptForStructured(harness, 'give me a person', schema, {
      maxRetries: 3,
    });
    expect(result).toEqual({ name: 'Diana', age: 42 });
    expect(attempts).toBe(2);
    expect(harness.prompt).toHaveBeenCalledTimes(2);

    const retryPrompt = (harness.prompt as ReturnType<typeof mock>).mock.calls[1][0] as string;
    // Retry prompt must not contain [object Object] — a sign of unreadable errors
    expect(retryPrompt).not.toContain('[object Object]');
    // Must contain a readable validation error message
    expect(retryPrompt).toContain('Schema validation error');
    expect(retryPrompt).toContain('Previous attempt failed');
  });
});

// ─── schemaToString ─────────────────────────────────────────────────────────

describe('schemaToString', () => {
  it('returns a non-empty string for a Zod object schema', () => {
    const s = z.object({ name: z.string(), age: z.number() });
    const result = schemaToString(s);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('name');
    expect(result).toContain('age');
  });

  it('handles basic types correctly', () => {
    expect(schemaToString(z.string())).toBe('string');
    expect(schemaToString(z.number())).toBe('number');
    expect(schemaToString(z.boolean())).toBe('boolean');
  });
});

// ─── schemaToString – additional Zod types ──────────────────────────────────

describe('schemaToString – additional Zod types', () => {
  it('describes ZodEffects (transform) as inner type, not raw typeName', () => {
    const s = z.string().transform((v) => v.toUpperCase());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodEffects');
    expect(result).toContain('with effects');
  });

  it('describes ZodEffects (refine) as inner type', () => {
    const s = z.string().refine((v) => v.length > 0);
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodEffects');
    expect(result).toContain('with effects');
  });

  it('describes ZodBranded as inner type, not raw typeName', () => {
    const s = z.string().brand('UserId');
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodBranded');
    expect(result).toContain('branded');
  });

  it('describes ZodNativeEnum with its values', () => {
    const s = z.nativeEnum({ A: 'a', B: 'b' });
    const result = schemaToString(s);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).not.toContain('ZodNativeEnum');
  });

  it('describes ZodRecord with key and value types', () => {
    const s = z.record(z.string(), z.number());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('number');
    expect(result).not.toContain('ZodRecord');
  });

  it('describes ZodTuple with element types', () => {
    const s = z.tuple([z.string(), z.number()]);
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('number');
    expect(result).not.toContain('ZodTuple');
  });

  it('describes ZodSet with element type', () => {
    const s = z.set(z.string());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodSet');
  });

  it('describes ZodMap with key and value types', () => {
    const s = z.map(z.string(), z.number());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('number');
    expect(result).not.toContain('ZodMap');
  });

  it('describes ZodLazy by resolving the inner type', () => {
    const s = z.lazy(() => z.object({ x: z.number() }));
    const result = schemaToString(s);
    expect(result).toContain('x');
    expect(result).toContain('number');
    expect(result).not.toContain('ZodLazy');
  });

  it('describes ZodPromise with inner type', () => {
    const s = z.promise(z.string());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodPromise');
  });

  it('respects description field on ZodEffects', () => {
    const s = z
      .string()
      .transform((v) => v)
      .describe('uppercased name');
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('uppercased name');
  });

  it('respects description field on ZodBranded', () => {
    const s = z.string().brand('UserId').describe('user identifier');
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('user identifier');
  });

  it('respects description field on ZodRecord', () => {
    const s = z.record(z.string(), z.number()).describe('score map');
    const result = schemaToString(s);
    expect(result).toContain('score map');
  });

  it('respects description field on ZodSet', () => {
    const s = z.set(z.string()).describe('unique tags');
    const result = schemaToString(s);
    expect(result).toContain('unique tags');
  });

  it('respects description field on ZodMap', () => {
    const s = z.map(z.string(), z.number()).describe('lookup table');
    const result = schemaToString(s);
    expect(result).toContain('lookup table');
  });

  it('respects description field on ZodTuple', () => {
    const s = z.tuple([z.string(), z.number()]).describe('pair');
    const result = schemaToString(s);
    expect(result).toContain('pair');
  });
});

// ─── schemaToString – priority Zod type cases ───────────────────────────────

describe('schemaToString – priority Zod type cases', () => {
  it('describes ZodIntersection with left and right sub-schemas', () => {
    const s = z.intersection(z.string(), z.literal('hello'));
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).toContain('"hello"');
    expect(result).not.toContain('ZodIntersection');
  });

  it('describes ZodDate as "Date"', () => {
    const s = z.date();
    const result = schemaToString(s);
    expect(result).toBe('Date');
    expect(result).not.toContain('ZodDate');
  });

  it('describes ZodReadonly wrapping inner type', () => {
    const s = z.string().readonly();
    const result = schemaToString(s);
    expect(result).toBe('Readonly<string>');
    expect(result).not.toContain('ZodReadonly');
  });

  it('describes ZodPipeline with inner schema', () => {
    const s = z.pipeline(z.string(), z.string());
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodPipeline');
  });

  it('describes ZodCatch with inner type', () => {
    const s = z.string().catch('fallback');
    const result = schemaToString(s);
    expect(result).toContain('string');
    expect(result).not.toContain('ZodCatch');
  });
});
