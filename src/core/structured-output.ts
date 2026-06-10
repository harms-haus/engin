// ─── Structured Output ──────────────────────────────────────────────────────
import { parseJsonWithRepair } from '@earendil-works/pi-ai';
import type { ZodType } from 'zod';
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
 */
export async function promptForStructured<T>(
  harness: PromptableHarness,
  prompt: string,
  schema: ZodType<T>,
  options?: StructuredOutputOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const originalPrompt = prompt;
  let currentPrompt = prompt;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await harness.prompt(currentPrompt);
    const text = harness.getLastAssistantText() ?? '';

    const jsonStr = extractJsonFromText(text);
    if (jsonStr === null) {
      lastError = 'No JSON found in response';
      currentPrompt = buildRetryPrompt(originalPrompt, lastError, schema);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonWithRepair(jsonStr);
    } catch (err) {
      lastError = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
      currentPrompt = buildRetryPrompt(originalPrompt, lastError, schema);
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }

    lastError = `Schema validation error: ${result.error.format()}`;
    currentPrompt = buildRetryPrompt(originalPrompt, lastError, schema);
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

function buildRetryPrompt<T>(originalPrompt: string, error: string, schema: ZodType<T>): string {
  const schemaDesc = schemaToString(schema);
  return [
    originalPrompt,
    '',
    `--- Previous attempt failed ---`,
    `Error: ${error}`,
    `Expected schema: ${schemaDesc}`,
    `Please respond with valid JSON matching the schema above.`,
  ].join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeSchema(def: any): string {
  if (!def) return 'unknown';

  // Extract description if present
  const desc: string | undefined = def.description;

  const typeName: string = def.typeName;

  switch (typeName) {
    case 'ZodObject': {
      // Zod v3.25 stores shape as a function
      const shapeFn = def.shape;
      if (typeof shapeFn !== 'function') return desc ?? '{}';
      const shape = shapeFn();
      if (!shape) return desc ?? '{}';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fields = Object.entries(shape).map(([key, field]: [string, any]) => {
        const fieldDef = field._def ?? field;
        const fieldDesc = describeSchema(fieldDef);
        return `${key}: ${fieldDesc}`;
      });
      const objStr = `{ ${fields.join(', ')} }`;
      return desc ? `${objStr} /* ${desc} */` : objStr;
    }

    case 'ZodString':
      return desc ?? 'string';

    case 'ZodNumber':
      return desc ?? 'number';

    case 'ZodBoolean':
      return desc ?? 'boolean';

    case 'ZodArray': {
      const itemType = def.type?._def ? describeSchema(def.type._def) : 'unknown';
      return desc ? `Array<${itemType}> /* ${desc} */` : `Array<${itemType}>`;
    }

    case 'ZodEnum': {
      const values: string[] = def.values ?? [];
      return desc
        ? `${values.map((v) => `"${v}"`).join(' | ')} /* ${desc} */`
        : values.map((v) => `"${v}"`).join(' | ');
    }

    case 'ZodOptional': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `${inner} | undefined`;
    }

    case 'ZodNullable': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `${inner} | null`;
    }

    case 'ZodDefault': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      const defaultVal = def.defaultValue();
      return `${inner} (default: ${JSON.stringify(defaultVal)})`;
    }

    case 'ZodLiteral': {
      return JSON.stringify(def.value);
    }

    case 'ZodAny':
      return 'any';

    case 'ZodUnknown':
      return 'unknown';

    case 'ZodVoid':
    case 'ZodUndefined':
      return 'undefined';

    case 'ZodNull':
      return 'null';

    case 'ZodUnion': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (def.options ?? []).map((opt: any) => describeSchema(opt._def));
      return options.join(' | ');
    }

    default:
      return desc ?? typeName ?? 'unknown';
  }
}
