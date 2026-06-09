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
    const result = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Alice', age: 30 });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  it('succeeds on retry after invalid JSON first', async () => {
    const harness = makeHarness(['this is not json at all', '{"name": "Bob", "age": 25}']);
    const result = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Bob', age: 25 });
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  it('succeeds on retry after valid JSON with wrong schema first', async () => {
    const harness = makeHarness(['{"name": "Charlie", "age": "not-a-number"}', '{"name": "Diana", "age": 42}']);
    const result = await promptForStructured(harness, 'give me a person', schema);
    expect(result).toEqual({ name: 'Diana', age: 42 });
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
