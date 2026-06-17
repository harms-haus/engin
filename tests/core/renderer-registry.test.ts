// ─── RendererRegistry contract tests ──────────────────────────────────────
//
// These tests pin the behaviour of the RendererRegistry class and the
// RenderFunction type alias defined in
// packages/engine/src/core/renderer-registry.ts and re-exported from
// packages/engine/src/index.ts.
//
// The contract under test:
//
//   export type RenderFunction = (data: unknown) => string;
//
//   class RendererRegistry {
//     private renderers = new Map<string, RenderFunction>();
//     register(profileName: string, fn: RenderFunction): void;
//     get(profileName: string): RenderFunction | undefined;
//     render(profileName: string, data: unknown): string | undefined;
//   }
//
// Both compile-time structural checks (type equality) and runtime behaviour
// are exercised. The suite follows the conventions used in tests/core/types.test.ts
// and tests/core/utils.test.ts.

import { describe, expect, it, mock } from 'bun:test';
import type { RenderFunction } from '../../packages/engine/src/core/renderer-registry.js';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';

// ─── Type-level exact equality utility ─────────────────────────────────────
// Same trick used in tests/core/types.test.ts: Resolves to `true` iff X and Y
// are structurally identical.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// ─── Compile-time structural equality assertions ───────────────────────────
//
// RenderFunction must be exactly `(data: unknown) => string`. Defining an
// independent expected copy guarantees this is a genuine structural
// comparison rather than identity.

type ExpectedRenderFunction = (data: unknown) => string;

assertEqual<Equal<RenderFunction, ExpectedRenderFunction>>('RenderFunction is exactly (data: unknown) => string');

// A function that returns a non-string must NOT be assignable to RenderFunction.
// (This is a negative compile-time check: if RenderFunction's return type ever
// widens to `unknown`, the line below would still compile; the positive
// assertion above combined with the runtime tests below guards the return type.)
const stringReturningFn: RenderFunction = (_data: unknown) => 'ok';
void stringReturningFn;

// ─── RenderFunction type alias ─────────────────────────────────────────────

describe('RenderFunction type', () => {
  it('is assignable to a function taking unknown and returning string', () => {
    const fn: RenderFunction = () => 'static';
    expect(typeof fn).toBe('function');
    expect(fn(undefined)).toBe('static');
  });

  it('accepts any data shape as the unknown parameter at runtime', () => {
    const fn: RenderFunction = (data) => JSON.stringify(data);
    expect(fn({ a: 1 })).toBe('{"a":1}');
    expect(fn([1, 2, 3])).toBe('[1,2,3]');
    expect(fn('text')).toBe('"text"');
    expect(fn(null)).toBe('null');
    expect(fn(42)).toBe('42');
  });
});

// ─── Constructor ────────────────────────────────────────────────────────────

describe('RendererRegistry constructor', () => {
  it('can be instantiated with no arguments', () => {
    const registry = new RendererRegistry();
    expect(registry).toBeInstanceOf(RendererRegistry);
  });

  it('starts empty (get returns undefined before any register)', () => {
    const registry = new RendererRegistry();
    expect(registry.get('anything')).toBeUndefined();
  });
});

// ─── register ───────────────────────────────────────────────────────────────

describe('RendererRegistry.register', () => {
  it('returns void', () => {
    const registry = new RendererRegistry();
    const result = registry.register('profile-a', () => 'rendered');
    expect(result).toBeUndefined();
  });

  it('stores a function that get can subsequently retrieve', () => {
    const registry = new RendererRegistry();
    const fn: RenderFunction = () => 'rendered';
    registry.register('profile-a', fn);
    expect(registry.get('profile-a')).toBe(fn);
  });

  it('overwrites a previously registered function for the same profile name', () => {
    const registry = new RendererRegistry();
    const original: RenderFunction = () => 'v1';
    const replacement: RenderFunction = () => 'v2';

    registry.register('profile-a', original);
    expect(registry.get('profile-a')).toBe(original);

    registry.register('profile-a', replacement);
    expect(registry.get('profile-a')).toBe(replacement);
    expect(registry.get('profile-a')).not.toBe(original);
  });

  it('stores multiple distinct profile names independently', () => {
    const registry = new RendererRegistry();
    const fnA: RenderFunction = () => 'A';
    const fnB: RenderFunction = () => 'B';
    const fnC: RenderFunction = () => 'C';

    registry.register('profile-a', fnA);
    registry.register('profile-b', fnB);
    registry.register('profile-c', fnC);

    expect(registry.get('profile-a')).toBe(fnA);
    expect(registry.get('profile-b')).toBe(fnB);
    expect(registry.get('profile-c')).toBe(fnC);
  });

  it('keeps each registry instance isolated (no shared state)', () => {
    const registry1 = new RendererRegistry();
    const registry2 = new RendererRegistry();
    const fn: RenderFunction = () => 'only-in-1';

    registry1.register('profile-a', fn);
    expect(registry1.get('profile-a')).toBe(fn);
    // registry2 must not see registrations made on registry1
    expect(registry2.get('profile-a')).toBeUndefined();
  });
});

// ─── get ────────────────────────────────────────────────────────────────────

describe('RendererRegistry.get', () => {
  it('returns undefined for a profile that was never registered', () => {
    const registry = new RendererRegistry();
    expect(registry.get('never-registered')).toBeUndefined();
  });

  it('returns undefined for an empty-string profile name when nothing registered', () => {
    const registry = new RendererRegistry();
    expect(registry.get('')).toBeUndefined();
  });

  it('returns the exact function reference that was registered', () => {
    const registry = new RendererRegistry();
    const fn: RenderFunction = () => 'rendered';
    registry.register('profile-a', fn);
    expect(registry.get('profile-a')).toBe(fn);
  });

  it('returns undefined for a different profile name than the one registered', () => {
    const registry = new RendererRegistry();
    registry.register('profile-a', () => 'A');
    expect(registry.get('profile-b')).toBeUndefined();
  });

  it('treats profile names case-sensitively', () => {
    const registry = new RendererRegistry();
    const fn: RenderFunction = () => 'lower';
    registry.register('profile-a', fn);
    expect(registry.get('profile-a')).toBe(fn);
    expect(registry.get('Profile-A')).toBeUndefined();
    expect(registry.get('PROFILE-A')).toBeUndefined();
  });
});

// ─── render ─────────────────────────────────────────────────────────────────

describe('RendererRegistry.render', () => {
  it('returns undefined when the profile is not registered', () => {
    const registry = new RendererRegistry();
    expect(registry.render('missing', { some: 'data' })).toBeUndefined();
  });

  it('returns undefined when no profiles have been registered at all', () => {
    const registry = new RendererRegistry();
    expect(registry.render('anything', null)).toBeUndefined();
  });

  it('invokes the registered function and returns its string result', () => {
    const registry = new RendererRegistry();
    registry.register('profile-a', () => 'hello-world');
    expect(registry.render('profile-a', {})).toBe('hello-world');
  });

  it('passes the data argument through to the render function', () => {
    const registry = new RendererRegistry();
    const fn = mock((_data: unknown) => 'rendered');
    registry.register('profile-a', fn as unknown as RenderFunction);

    const data = { key: 'value', nested: { n: 1 } };
    const result = registry.render('profile-a', data);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(data);
    expect(result).toBe('rendered');
  });

  it('forwards the exact data reference to the render function', () => {
    const registry = new RendererRegistry();
    let received: unknown = 'sentinel';
    const data = { marker: 42 };
    registry.register('profile-a', (d) => {
      received = d;
      return 'done';
    });
    registry.render('profile-a', data);
    expect(received).toBe(data);
  });

  it('returns the string produced by a data-dependent render function', () => {
    const registry = new RendererRegistry();
    // A realistic render function that transforms structured data into a string.
    const renderSummary: RenderFunction = (data) => {
      const obj = (data ?? {}) as { title?: string; count?: number };
      return `${obj.title ?? 'untitled'} (${obj.count ?? 0})`;
    };
    registry.register('summary', renderSummary);

    expect(registry.render('summary', { title: 'Report', count: 3 })).toBe('Report (3)');
    expect(registry.render('summary', {})).toBe('untitled (0)');
    expect(registry.render('summary', undefined)).toBe('untitled (0)');
  });

  it('returns undefined for an unregistered profile even when data is provided', () => {
    const registry = new RendererRegistry();
    registry.register('profile-a', () => 'A');
    // 'profile-b' is not registered, so render must not call any function.
    expect(registry.render('profile-b', { data: true })).toBeUndefined();
  });

  it('uses the latest function after re-registration', () => {
    const registry = new RendererRegistry();
    registry.register('profile-a', () => 'first');
    expect(registry.render('profile-a', null)).toBe('first');

    registry.register('profile-a', () => 'second');
    expect(registry.render('profile-a', null)).toBe('second');
  });

  it('does not invoke a render function for a different profile', () => {
    const registry = new RendererRegistry();
    const fnA = mock(() => 'A');
    registry.register('profile-a', fnA as unknown as RenderFunction);

    // Rendering a missing profile must not trigger profile-a's function.
    registry.render('profile-b', {});
    expect(fnA).not.toHaveBeenCalled();
  });
});

// ─── Re-export surface integrity ────────────────────────────────────────────

describe('src/index.js re-export surface', () => {
  it('re-exports RendererRegistry from the engine barrel', async () => {
    // The dynamic import of the barrel guarantees the export line
    //   export * from './core/renderer-registry.js';
    // is present in packages/engine/src/index.ts. If the export is missing,
    // the named import below throws at module load time.
    const mod = await import('../../packages/engine/src/index.js');
    expect(mod.RendererRegistry).toBeDefined();
    expect(typeof mod.RendererRegistry).toBe('function');
    const registry = new mod.RendererRegistry();
    expect(registry).toBeInstanceOf(RendererRegistry);
  });
});
