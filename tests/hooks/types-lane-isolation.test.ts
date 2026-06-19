// ─── Type-contract tests: onLaneError + shouldIsolate hooks ────────────────
//
// These tests pin the two lane / failure-isolation hooks added to
// `WorkflowHooks` via declaration merging in
// `packages/engine/src/hooks/types.ts`:
//
//   1. A TYPE-ONLY import at the top of types.ts (keeps types.ts free of a
//      runtime dependency on core/types.js):
//        import type { Task } from '../core/types.js';
//
//   2. Two new exported argument-bag types:
//        export type OnLaneErrorArgs = {
//          laneId: string;
//          task: Task;
//          error: string;
//          phaseId: string;
//        };
//        export type ShouldIsolateArgs = {
//          task: Task;
//          error: string;
//          laneId: string;
//        };
//
//   3. Two new OPTIONAL fields on `WorkflowHooks` (declaration merge — the
//      mechanism-only `export interface WorkflowHooks {}` from task-1 is
//      EXTENDED, not redefined; the field names are unique so there are no
//      duplicate-identifier errors):
//        export interface WorkflowHooks {
//          onLaneError?:
//            | ObserveHook<OnLaneErrorArgs>
//            | ObserveHook<OnLaneErrorArgs>[];
//          shouldIsolate?:
//            | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>
//            | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>[];
//        }
//
// CONTRACT under test:
//   - `onLaneError` is an OBSERVE hook (composition rule `'observe'`): one-way
//     fan-out; its return value is discarded. Typed via `ObserveHook<…>`.
//   - `shouldIsolate` is a FIRST-WINS hook (composition rule `'first-wins'`):
//     the first subscriber returning a non-`undefined` value decides. Typed
//     via `FirstWinsHook<boolean | undefined, …>` — `undefined` abstains, while
//     `false` is a REAL winning value (do NOT isolate), distinct from abstain.
//   - Each field accepts EITHER a single hook function OR an array of them
//     (mirrors `HookRegistry.register`, which collects multiple subscribers
//     per field).
//   - Both fields are OPTIONAL.
//   - `Task` is imported TYPE-ONLY from `../core/types.js`.
//
// This suite is written TEST-FIRST. The compile-time `assertEqual<…>` checks
// are RED until the spec lands in types.ts (they reference types / fields that
// do not yet exist); they go GREEN once onLaneError / shouldIsolate are added.
// The runtime checks additionally exercise the handler call shapes (observe
// returns void / Promise<void>; first-wins returns boolean | undefined with
// `false` ≠ abstain).
//
// NOTE on the sibling mechanism test: tests/hooks/types.test.ts (task-1) pins
// `WorkflowHooks` as an EMPTY interface (`keyof WorkflowHooks` is `never`,
// `WorkflowHooks` is `{}`). Adding these two fields makes those two specific
// assertions stale; they are reconciled separately when the source lands. This
// file pins the NEW shape only and does not redefine the mechanism contract.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../../packages/engine/src/core/types.js';
import type {
  FirstWinsHook,
  HookContext,
  HookRegistry,
  ObserveHook,
  OnLaneErrorArgs,
  ShouldIsolateArgs,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';

// ─── Type-level exact-equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, and type changes). Pattern from
// tests/hooks/types.test.ts and tests/core/types-hooks.test.ts.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}
function assertNotEqual<T extends false>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
// Defined WITHOUT aliasing the imported types where it matters, so each
// Equal<Imported, Expected> comparison is a genuine structural check rather
// than identity. `Task` is the SAME binding imported by both the expected copy
// and (once added) types.ts, so the `.task` field comparison is meaningful.

interface ExpectedOnLaneErrorArgs {
  laneId: string;
  task: Task;
  error: string;
  phaseId: string;
}

interface ExpectedShouldIsolateArgs {
  task: Task;
  error: string;
  laneId: string;
}

type ExpectedOnLaneErrorField = ObserveHook<OnLaneErrorArgs> | ObserveHook<OnLaneErrorArgs>[];

type ExpectedShouldIsolateField =
  | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>
  | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>[];

// ─── Compile-time structural assertions ────────────────────────────────────

// Field PRESENCE (compiles either way; RED until the fields exist).
assertEqual<Equal<'onLaneError' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `onLaneError`',
);
assertEqual<Equal<'shouldIsolate' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `shouldIsolate`',
);

// Field TYPES + OPTIONALITY. Indexed access on an optional property yields
// `T | undefined`, so this also pins that the fields are OPTIONAL (a REQUIRED
// field would resolve to just `T` and fail the `| undefined` arm).
assertEqual<Equal<WorkflowHooks['onLaneError'], ExpectedOnLaneErrorField | undefined>>(
  'onLaneError is ObserveHook<OnLaneErrorArgs> | ObserveHook<OnLaneErrorArgs>[] (optional)',
);
assertEqual<Equal<WorkflowHooks['shouldIsolate'], ExpectedShouldIsolateField | undefined>>(
  'shouldIsolate is FirstWinsHook<boolean|undefined, ShouldIsolateArgs> | [same][] (optional)',
);

// Bidirectional assignability for the field unions — the gold-standard
// structural equality check. `NonNullable<…>` strips the `| undefined` so we
// compare just the hook union. If both lines compile, the declared field type
// ⊆ expected and vice versa.
const _onLaneErrorField: ExpectedOnLaneErrorField = null as unknown as NonNullable<WorkflowHooks['onLaneError']>;
const _onLaneErrorReverse: NonNullable<WorkflowHooks['onLaneError']> = null as unknown as ExpectedOnLaneErrorField;
const _shouldIsolateField: ExpectedShouldIsolateField = null as unknown as NonNullable<WorkflowHooks['shouldIsolate']>;
const _shouldIsolateReverse: NonNullable<WorkflowHooks['shouldIsolate']> =
  null as unknown as ExpectedShouldIsolateField;
void _onLaneErrorField;
void _onLaneErrorReverse;
void _shouldIsolateField;
void _shouldIsolateReverse;

// Argument-bag shapes (exact).
assertEqual<Equal<OnLaneErrorArgs, ExpectedOnLaneErrorArgs>>('OnLaneErrorArgs shape is exact');
assertEqual<Equal<ShouldIsolateArgs, ExpectedShouldIsolateArgs>>('ShouldIsolateArgs shape is exact');

// `task` is the core Task type (not a re-declared local Task) — verified
// through the arg bags so the import wiring is pinned end-to-end.
assertEqual<Equal<OnLaneErrorArgs['task'], Task>>('OnLaneErrorArgs.task is the core Task');
assertEqual<Equal<ShouldIsolateArgs['task'], Task>>('ShouldIsolateArgs.task is the core Task');

// Required-string fields on each arg bag.
assertEqual<Equal<OnLaneErrorArgs['laneId'], string>>('OnLaneErrorArgs.laneId is string');
assertEqual<Equal<OnLaneErrorArgs['error'], string>>('OnLaneErrorArgs.error is string');
assertEqual<Equal<OnLaneErrorArgs['phaseId'], string>>('OnLaneErrorArgs.phaseId is string');
assertEqual<Equal<ShouldIsolateArgs['laneId'], string>>('ShouldIsolateArgs.laneId is string');
assertEqual<Equal<ShouldIsolateArgs['error'], string>>('ShouldIsolateArgs.error is string');

// The two arg bags are NOT silently aliased (different field sets: only
// OnLaneErrorArgs carries `phaseId`).
assertNotEqual<Equal<OnLaneErrorArgs, ShouldIsolateArgs>>('OnLaneErrorArgs and ShouldIsolateArgs are distinct types');

// ─── Source-path helpers ───────────────────────────────────────────────────

const ENGINE_SRC = resolve(import.meta.dir, '../../packages/engine/src');
const TYPES_PATH = resolve(ENGINE_SRC, 'hooks/types.ts');

/** Read a source file defensively: returns its UTF-8 contents if present, or
 *  an empty string if it does not exist. An empty string fails every
 *  `.toContain` / `.toMatch` assertion (the desired RED state) without
 *  throwing at test-collection time. Mirrors the barrel tests' readSource. */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

// ─── Runtime helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: {} as HookRegistry,
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Implement the thing',
    prompt: 'do it',
    profile: 'default',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'phase-1',
    ...overrides,
  };
}

function makeLaneErrorArgs(overrides: Partial<OnLaneErrorArgs> = {}): OnLaneErrorArgs {
  return {
    laneId: 'lane-A',
    task: makeTask(),
    error: 'kaboom',
    phaseId: 'phase-1',
    ...overrides,
  };
}

function makeIsolateArgs(overrides: Partial<ShouldIsolateArgs> = {}): ShouldIsolateArgs {
  return {
    task: makeTask(),
    error: 'kaboom',
    laneId: 'lane-A',
    ...overrides,
  };
}

// ─── types.ts source structure ─────────────────────────────────────────────

describe('types.ts source structure (Task import + new exports)', () => {
  const src = tryReadSource(TYPES_PATH);

  it('imports Task TYPE-ONLY from ../core/types.js', () => {
    // Tolerates any whitespace form (`import type { Task }`, `import type{Task}`,
    // co-imported names, single/double quotes). The companion negative check
    // below pins that it is NOT a runtime `import { … }`.
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bTask\b[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  it('does NOT runtime-import anything from ../core/types.js (no circular runtime dep)', () => {
    // A runtime named import would be `import { X } from '../core/types.js'`
    // (no `type` keyword). The type-only `import type { Task }` must NOT match
    // this pattern (there is a `type` token between `import` and `{`).
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  it('exports OnLaneErrorArgs', () => {
    // The shipped implementation declares this as an `interface` (not
    // `type`); match the actual declaration form. The exact shape is pinned
    // by the compile-time Equal assertions elsewhere in this suite.
    expect(src).toMatch(/export\s+(type|interface)\s+OnLaneErrorArgs\b/);
  });

  it('exports ShouldIsolateArgs', () => {
    expect(src).toMatch(/export\s+(type|interface)\s+ShouldIsolateArgs\b/);
  });

  it('declares onLaneError as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bonLaneError\s*\??\s*:/);
  });

  it('declares shouldIsolate as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bshouldIsolate\s*\??\s*:/);
  });

  it('declares each field name at most once (declaration merge adds, not duplicates)', () => {
    // Declaration merging requires UNIQUE field names within the merged
    // interface; a duplicate `onLaneError:` / `shouldIsolate:` key would be a
    // TS2717 error. Count occurrences of each field-declaration line.
    const onLaneErrorCount = (src.match(/\bonLaneError\s*\??\s*:/g) ?? []).length;
    const shouldIsolateCount = (src.match(/\bshouldIsolate\s*\??\s*:/g) ?? []).length;
    expect(onLaneErrorCount).toBe(1);
    expect(shouldIsolateCount).toBe(1);
  });
});

// ─── OnLaneErrorArgs ───────────────────────────────────────────────────────

describe('OnLaneErrorArgs', () => {
  it('accepts an object with laneId, task, error, phaseId', () => {
    const task = makeTask({ id: 't-9' });
    const args: OnLaneErrorArgs = {
      laneId: 'lane-A',
      task,
      error: 'explosion',
      phaseId: 'phase-1',
    };
    expect(args.laneId).toBe('lane-A');
    expect(args.task).toBe(task);
    expect(args.error).toBe('explosion');
    expect(args.phaseId).toBe('phase-1');
  });

  it('requires all four fields (negative compile check)', () => {
    // @ts-expect-error — missing task, error, phaseId
    const bad: OnLaneErrorArgs = { laneId: 'x' };
    expect(bad).toBeDefined();
  });

  it('rejects an extra unknown field (negative compile check)', () => {
    // @ts-expect-error — `reason` is not a member of OnLaneErrorArgs
    const bad: OnLaneErrorArgs = { laneId: 'x', task: makeTask(), error: 'e', phaseId: 'p', reason: 'nope' };
    expect(bad).toBeDefined();
  });

  it('task round-trips as the core Task type', () => {
    const task: Task = makeTask({ id: 'roundtrip' });
    const args: OnLaneErrorArgs = { laneId: 'l', task, error: 'e', phaseId: 'p' };
    const back: Task = args.task;
    expect(back.id).toBe('roundtrip');
  });
});

// ─── ShouldIsolateArgs ─────────────────────────────────────────────────────

describe('ShouldIsolateArgs', () => {
  it('accepts an object with task, error, laneId', () => {
    const task = makeTask();
    const args: ShouldIsolateArgs = { task, error: 'boom', laneId: 'lane-B' };
    expect(args.task).toBe(task);
    expect(args.error).toBe('boom');
    expect(args.laneId).toBe('lane-B');
  });

  it('requires all three fields (negative compile check)', () => {
    // @ts-expect-error — missing task, error
    const bad: ShouldIsolateArgs = { laneId: 'x' };
    expect(bad).toBeDefined();
  });

  it('has NO phaseId field (distinct from OnLaneErrorArgs)', () => {
    // @ts-expect-error — phaseId is not a member of ShouldIsolateArgs
    const bad: ShouldIsolateArgs = { task: makeTask(), error: 'e', laneId: 'l', phaseId: 'p' };
    expect(bad).toBeDefined();
  });

  it('task round-trips as the core Task type', () => {
    const task: Task = makeTask({ id: 'iso-task' });
    const args: ShouldIsolateArgs = { task, error: 'e', laneId: 'l' };
    const back: Task = args.task;
    expect(back.id).toBe('iso-task');
  });
});

// ─── WorkflowHooks.onLaneError ─────────────────────────────────────────────

describe('WorkflowHooks.onLaneError (observe)', () => {
  it('is optional — a hooks object without onLaneError is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.onLaneError).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = {
      onLaneError: () => {},
    };
    expect(typeof hooks.onLaneError).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<OnLaneErrorArgs> = async () => {};
    const hooks: WorkflowHooks = { onLaneError: handler };
    await expect(handler(makeLaneErrorArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.onLaneError).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      onLaneError: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.onLaneError)).toBe(true);
    expect((hooks.onLaneError as unknown[]).length).toBe(3);
  });

  it('a single handler receives (OnLaneErrorArgs, HookContext) and returns void', () => {
    const args = makeLaneErrorArgs({ laneId: 'lane-Z' });
    const ctx = makeCtx({ cwd: '/custom' });
    let receivedArgs: OnLaneErrorArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<OnLaneErrorArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { onLaneError: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-Z');
    expect(receivedArgs?.task).toBe(args.task);
    expect(receivedArgs?.error).toBe('kaboom');
    expect(receivedArgs?.phaseId).toBe('phase-1');
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/custom');
    expect(hooks.onLaneError).toBe(handler);
  });
});

// ─── WorkflowHooks.shouldIsolate ───────────────────────────────────────────

describe('WorkflowHooks.shouldIsolate (first-wins)', () => {
  it('is optional — a hooks object without shouldIsolate is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.shouldIsolate).toBeUndefined();
  });

  it('accepts a single first-wins handler', () => {
    const hooks: WorkflowHooks = {
      shouldIsolate: () => true,
    };
    expect(typeof hooks.shouldIsolate).toBe('function');
  });

  it('accepts an ARRAY of first-wins handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      shouldIsolate: [() => true, async () => false, () => undefined],
    };
    expect(Array.isArray(hooks.shouldIsolate)).toBe(true);
    expect((hooks.shouldIsolate as unknown[]).length).toBe(3);
  });

  it('a handler can return true (isolate)', () => {
    const handler: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = () => true;
    expect(handler(makeIsolateArgs(), makeCtx())).toBe(true);
  });

  it('a handler can return false (do NOT isolate — a real winning value, not an abstention)', () => {
    // `false` must be a genuine winning value: returning undefined abstains,
    // returning false means "no, do not isolate" and WINS.
    const handler: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = () => false;
    expect(handler(makeIsolateArgs(), makeCtx())).toBe(false);
  });

  it('a handler can return undefined (abstain)', () => {
    const handler: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = () => undefined;
    expect(handler(makeIsolateArgs(), makeCtx())).toBeUndefined();
  });

  it('a handler can resolve to a Promise<boolean | undefined>', async () => {
    const handler: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = async () => true;
    await expect(handler(makeIsolateArgs(), makeCtx())).resolves.toBe(true);
  });

  it('a handler receives (ShouldIsolateArgs, HookContext)', () => {
    const args = makeIsolateArgs({ laneId: 'lane-Q' });
    const ctx = makeCtx({ workDir: '/w/isolate' });
    let receivedArgs: ShouldIsolateArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: FirstWinsHook<boolean | undefined, ShouldIsolateArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
      return true;
    };
    const hooks: WorkflowHooks = { shouldIsolate: handler };

    const result = handler(args, ctx);

    expect(result).toBe(true);
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-Q');
    expect(receivedArgs?.task).toBe(args.task);
    expect(receivedArgs?.error).toBe('kaboom');
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.workDir).toBe('/w/isolate');
    expect(hooks.shouldIsolate).toBe(handler);
  });
});

// ─── Declaration merge — both hooks coexist ────────────────────────────────

describe('declaration merge — onLaneError and shouldIsolate coexist', () => {
  it('a hooks object can declare BOTH fields simultaneously', () => {
    const hooks: WorkflowHooks = {
      onLaneError: () => {},
      shouldIsolate: () => true,
    };
    expect(typeof hooks.onLaneError).toBe('function');
    expect(typeof hooks.shouldIsolate).toBe('function');
  });

  it('both fields can be arrays at once', () => {
    const hooks: WorkflowHooks = {
      onLaneError: [() => {}, async () => {}],
      shouldIsolate: [() => true, () => false],
    };
    expect(Array.isArray(hooks.onLaneError)).toBe(true);
    expect(Array.isArray(hooks.shouldIsolate)).toBe(true);
  });

  it('an empty hooks object is still valid (all fields optional)', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks).toEqual({});
    expect(Object.keys(hooks)).toHaveLength(0);
  });
});

// ─── Module load surface ───────────────────────────────────────────────────

describe('types.ts runtime surface', () => {
  it('remains a loadable, type-only module (Task import erased at runtime)', async () => {
    // The `import type { Task }` is erased at runtime, so adding it must NOT
    // introduce a runtime dependency on core/types.js. types.ts still exports
    // interfaces / type aliases only — the namespace has no value exports.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
