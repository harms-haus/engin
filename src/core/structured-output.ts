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
  const originalPrompt = prompt;
  const schemaDesc = schemaToString(schema);
  let currentPrompt = `${prompt}\n\nRespond with valid JSON matching this schema:\n${schemaDesc}`;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await harness.prompt(currentPrompt);
    const text = harness.getLastAssistantText() ?? '';

    const jsonStr = extractJsonFromText(text);
    if (jsonStr === null) {
      lastError = 'No JSON found in response';
      currentPrompt = buildRetryPrompt(originalPrompt, lastError, schemaDesc);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonWithRepair(jsonStr);
    } catch (err) {
      lastError = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
      currentPrompt = buildRetryPrompt(originalPrompt, lastError, schemaDesc);
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { result: result.data, attempts: attempt + 1 };
    }

    lastError = `Schema validation error: ${result.error.message}`;
    currentPrompt = buildRetryPrompt(originalPrompt, lastError, schemaDesc);
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

function buildRetryPrompt(originalPrompt: string, error: string, schemaDesc: string): string {
  return [
    originalPrompt,
    '',
    `--- Previous attempt failed ---`,
    `Error: ${error}`,
    `Expected schema: ${schemaDesc}`,
    `Please respond with valid JSON matching the schema above.`,
  ].join('\n');
}
