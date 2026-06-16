import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { describeSchema } from '../../packages/engine/src/core/schema-describe.ts';

// ─── describeSchema – basic types ───────────────────────────────────────────

describe('describeSchema – basic types', () => {
  it('describes ZodString as "string"', () => {
    expect(describeSchema(z.string()._def)).toBe('string');
  });

  it('describes ZodNumber as "number"', () => {
    expect(describeSchema(z.number()._def)).toBe('number');
  });

  it('describes ZodBoolean as "boolean"', () => {
    expect(describeSchema(z.boolean()._def)).toBe('boolean');
  });

  it('describes ZodAny as "any"', () => {
    expect(describeSchema(z.any()._def)).toBe('any');
  });

  it('describes ZodUnknown as "unknown"', () => {
    expect(describeSchema(z.unknown()._def)).toBe('unknown');
  });

  it('describes ZodVoid as "undefined"', () => {
    expect(describeSchema(z.void()._def)).toBe('undefined');
  });

  it('describes ZodUndefined as "undefined"', () => {
    expect(describeSchema(z.undefined()._def)).toBe('undefined');
  });

  it('describes ZodNull as "null"', () => {
    expect(describeSchema(z.null()._def)).toBe('null');
  });

  it('describes ZodDate as "Date"', () => {
    expect(describeSchema(z.date()._def)).toBe('Date');
  });
});

// ─── describeSchema – ZodObject ─────────────────────────────────────────────

describe('describeSchema – ZodObject', () => {
  it('describes an empty object as "{}"', () => {
    const s = z.object({});
    expect(describeSchema(s._def)).toBe('{}');
  });

  it('describes a simple object with fields', () => {
    const s = z.object({ name: z.string(), age: z.number() });
    const result = describeSchema(s._def);
    expect(result).toContain('name: string');
    expect(result).toContain('age: number');
  });

  it('describes nested objects', () => {
    const s = z.object({ outer: z.object({ inner: z.string() }) });
    const result = describeSchema(s._def);
    expect(result).toContain('outer');
    expect(result).toContain('inner: string');
  });

  it('includes description comment when present', () => {
    const s = z.object({ x: z.number() }).describe('a point');
    const result = describeSchema(s._def);
    expect(result).toContain('/* a point */');
  });
});

// ─── describeSchema – ZodArray ──────────────────────────────────────────────

describe('describeSchema – ZodArray', () => {
  it('describes array of strings', () => {
    const s = z.array(z.string());
    expect(describeSchema(s._def)).toBe('Array<string>');
  });

  it('describes array of numbers', () => {
    const s = z.array(z.number());
    expect(describeSchema(s._def)).toBe('Array<number>');
  });

  it('describes array with description', () => {
    const s = z.array(z.string()).describe('list of names');
    const result = describeSchema(s._def);
    expect(result).toContain('Array<string>');
    expect(result).toContain('/* list of names */');
  });
});

// ─── describeSchema – ZodEnum ───────────────────────────────────────────────

describe('describeSchema – ZodEnum', () => {
  it('describes enum with quoted values', () => {
    const s = z.enum(['a', 'b', 'c']);
    const result = describeSchema(s._def);
    expect(result).toBe('"a" | "b" | "c"');
  });

  it('describes single-value enum', () => {
    const s = z.enum(['only']);
    expect(describeSchema(s._def)).toBe('"only"');
  });

  it('describes enum with description', () => {
    const s = z.enum(['x', 'y']).describe('choices');
    const result = describeSchema(s._def);
    expect(result).toContain('"x" | "y"');
    expect(result).toContain('/* choices */');
  });
});

// ─── describeSchema – ZodOptional / ZodNullable ─────────────────────────────

describe('describeSchema – ZodOptional and ZodNullable', () => {
  it('describes optional string', () => {
    const s = z.optional(z.string());
    expect(describeSchema(s._def)).toBe('string | undefined');
  });

  it('describes nullable string', () => {
    const s = z.nullable(z.string());
    expect(describeSchema(s._def)).toBe('string | null');
  });
});

// ─── describeSchema – ZodDefault ────────────────────────────────────────────

describe('describeSchema – ZodDefault', () => {
  it('describes default value', () => {
    const s = z.string().default('hello');
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('default:');
    expect(result).toContain('"hello"');
  });
});

// ─── describeSchema – ZodLiteral ────────────────────────────────────────────

describe('describeSchema – ZodLiteral', () => {
  it('describes string literal', () => {
    const s = z.literal('hello');
    expect(describeSchema(s._def)).toBe('"hello"');
  });

  it('describes number literal', () => {
    const s = z.literal(42);
    expect(describeSchema(s._def)).toBe('42');
  });
});

// ─── describeSchema – ZodUnion ──────────────────────────────────────────────

describe('describeSchema – ZodUnion', () => {
  it('describes union of types', () => {
    const s = z.union([z.string(), z.number()]);
    const result = describeSchema(s._def);
    expect(result).toBe('string | number');
  });

  it('describes union of multiple types', () => {
    const s = z.union([z.string(), z.number(), z.boolean()]);
    const result = describeSchema(s._def);
    expect(result).toBe('string | number | boolean');
  });
});

// ─── describeSchema – ZodEffects ────────────────────────────────────────────

describe('describeSchema – ZodEffects', () => {
  it('describes transform with inner type', () => {
    const s = z.string().transform((v) => v.toUpperCase());
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('with effects');
  });

  it('describes refine with inner type', () => {
    const s = z.string().refine((v) => v.length > 0);
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('with effects');
  });

  it('includes description when present', () => {
    const s = z
      .string()
      .transform((v) => v)
      .describe('custom desc');
    const result = describeSchema(s._def);
    expect(result).toContain('/* custom desc */');
  });
});

// ─── describeSchema – ZodBranded ────────────────────────────────────────────

describe('describeSchema – ZodBranded', () => {
  it('describes branded type with inner type', () => {
    const s = z.string().brand('UserId');
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('branded');
  });

  it('includes description when present', () => {
    const s = z.string().brand('UserId').describe('user identifier');
    const result = describeSchema(s._def);
    expect(result).toContain('/* user identifier */');
  });
});

// ─── describeSchema – ZodNativeEnum ─────────────────────────────────────────

describe('describeSchema – ZodNativeEnum', () => {
  it('describes native enum with values', () => {
    const s = z.nativeEnum({ A: 'a', B: 'b' });
    const result = describeSchema(s._def);
    expect(result).toContain('"a"');
    expect(result).toContain('"b"');
  });

  it('includes description when present', () => {
    const s = z.nativeEnum({ X: 'x' }).describe('letters');
    const result = describeSchema(s._def);
    expect(result).toContain('/* letters */');
  });
});

// ─── describeSchema – ZodRecord ─────────────────────────────────────────────

describe('describeSchema – ZodRecord', () => {
  it('describes record with key and value types', () => {
    const s = z.record(z.string(), z.number());
    const result = describeSchema(s._def);
    expect(result).toContain('Record<string, number>');
  });

  it('includes description when present', () => {
    const s = z.record(z.string(), z.number()).describe('score map');
    const result = describeSchema(s._def);
    expect(result).toContain('/* score map */');
  });
});

// ─── describeSchema – ZodTuple ──────────────────────────────────────────────

describe('describeSchema – ZodTuple', () => {
  it('describes tuple with element types', () => {
    const s = z.tuple([z.string(), z.number()]);
    const result = describeSchema(s._def);
    expect(result).toBe('[string, number]');
  });

  it('describes empty tuple', () => {
    const s = z.tuple([]);
    const result = describeSchema(s._def);
    expect(result).toBe('[]');
  });

  it('includes description when present', () => {
    const s = z.tuple([z.string(), z.number()]).describe('pair');
    const result = describeSchema(s._def);
    expect(result).toContain('/* pair */');
  });
});

// ─── describeSchema – ZodMap ────────────────────────────────────────────────

describe('describeSchema – ZodMap', () => {
  it('describes map with key and value types', () => {
    const s = z.map(z.string(), z.number());
    const result = describeSchema(s._def);
    expect(result).toContain('Map<string, number>');
  });

  it('includes description when present', () => {
    const s = z.map(z.string(), z.number()).describe('lookup');
    const result = describeSchema(s._def);
    expect(result).toContain('/* lookup */');
  });
});

// ─── describeSchema – ZodSet ────────────────────────────────────────────────

describe('describeSchema – ZodSet', () => {
  it('describes set with element type', () => {
    const s = z.set(z.string());
    const result = describeSchema(s._def);
    expect(result).toContain('Set<string>');
  });

  it('includes description when present', () => {
    const s = z.set(z.string()).describe('unique tags');
    const result = describeSchema(s._def);
    expect(result).toContain('/* unique tags */');
  });
});

// ─── describeSchema – ZodPromise ────────────────────────────────────────────

describe('describeSchema – ZodPromise', () => {
  it('describes promise with inner type', () => {
    const s = z.promise(z.string());
    const result = describeSchema(s._def);
    expect(result).toContain('Promise<string>');
  });

  it('includes description when present', () => {
    const s = z.promise(z.string()).describe('async result');
    const result = describeSchema(s._def);
    expect(result).toContain('/* async result */');
  });
});

// ─── describeSchema – ZodLazy ───────────────────────────────────────────────

describe('describeSchema – ZodLazy', () => {
  it('resolves lazy schema and describes inner type', () => {
    const s = z.lazy(() => z.object({ x: z.number() }));
    const result = describeSchema(s._def);
    expect(result).toContain('x');
    expect(result).toContain('number');
  });

  it('returns "lazy" when getter throws', () => {
    const s = z.lazy(() => {
      throw new Error('boom');
    });
    const result = describeSchema(s._def);
    expect(result).toBe('lazy');
  });
});

// ─── describeSchema – ZodIntersection ───────────────────────────────────────

describe('describeSchema – ZodIntersection', () => {
  it('describes intersection with left and right types', () => {
    const s = z.intersection(z.string(), z.literal('hello'));
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('"hello"');
    expect(result).toContain('&');
  });
});

// ─── describeSchema – ZodReadonly ───────────────────────────────────────────

describe('describeSchema – ZodReadonly', () => {
  it('describes readonly wrapping inner type', () => {
    const s = z.string().readonly();
    expect(describeSchema(s._def)).toBe('Readonly<string>');
  });
});

// ─── describeSchema – ZodPipeline ───────────────────────────────────────────

describe('describeSchema – ZodPipeline', () => {
  it('describes pipeline with inner schema', () => {
    const s = z.pipeline(z.string(), z.string());
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('pipeline');
  });
});

// ─── describeSchema – ZodCatch ──────────────────────────────────────────────

describe('describeSchema – ZodCatch', () => {
  it('describes catch with inner type', () => {
    const s = z.string().catch('fallback');
    const result = describeSchema(s._def);
    expect(result).toContain('string');
    expect(result).toContain('with catch');
  });
});

// ─── describeSchema – edge cases ────────────────────────────────────────────

describe('describeSchema – edge cases', () => {
  it('returns "unknown" for null/undefined def', () => {
    expect(describeSchema(null)).toBe('unknown');
    expect(describeSchema(undefined)).toBe('unknown');
  });

  it('returns "unknown" for empty/falsy def', () => {
    expect(describeSchema(false as any)).toBe('unknown');
    expect(describeSchema(0 as any)).toBe('unknown');
    expect(describeSchema('' as any)).toBe('unknown');
  });

  it('handles complex nested schemas', () => {
    const s = z.object({
      users: z.array(
        z.object({
          name: z.string(),
          age: z.number().optional(),
          tags: z.array(z.string()),
        }),
      ),
      metadata: z.record(z.string(), z.unknown()).optional(),
    });
    const result = describeSchema(s._def);
    expect(result).toContain('users');
    expect(result).toContain('name: string');
    expect(result).toContain('age');
    expect(result).toContain('tags');
    expect(result).toContain('metadata');
  });
});
