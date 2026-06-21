// ─── Type-contract tests: scheduler / execution-level hooks ────────────────
//
// These tests pin the FIVE scheduler / execution-level hooks added to
// `WorkflowHooks` via declaration merging in
// `packages/engine/src/hooks/types.ts` (hooks.prompt.md §7 scheduler level,
// §8 LanePool decomposition):
//
//   1. `Task` is ALREADY imported TYPE-ONLY from `../core/types.js` by the
//      earlier step-level / lane-isolation tasks — no new import is needed.
//      We still assert it remains a type-only import (no runtime circular dep).
//
//   2. Five new exported argument-bag types:
//        export type ClaimPolicyArgs = {
//          tracker: unknown;    // typed unknown; cast at the call site
//          laneId: string;
//          maxClaim: number;
//        };
//        export type ConcurrencyKeyArgs = { task: Task };
//        export type WakeStrategyArgs = {
//          laneId: string;
//          reason: 'task-ready' | 'task-settled' | 'timeout' | 'abort';
//        };
//        export type OnLaneIdleArgs = {
//          laneId: string;
//          consecutiveTimeouts: number;
//        };
//        export type OnLaneStallArgs = {
//          laneId: string;
//          consecutiveTimeouts: number;
//          threshold: number;
//        };
//
//   3. Five new OPTIONAL fields on `WorkflowHooks` (declaration merge — the
//      interface is EXTENDED, not redefined; the field names are unique so
//      there are no duplicate-identifier TS2717 errors):
//        export interface WorkflowHooks {
//          // ── Scheduler / execution level ──
//          claimPolicy?:
//            | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>
//            | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>[];
//          concurrencyKey?:
//            | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>
//            | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>[];
//          wakeStrategy?:
//            | ObserveHook<WakeStrategyArgs>
//            | ObserveHook<WakeStrategyArgs>[];
//          onLaneIdle?:
//            | ObserveHook<OnLaneIdleArgs>
//            | ObserveHook<OnLaneIdleArgs>[];
//          onLaneStall?:
//            | ObserveHook<OnLaneStallArgs>
//            | ObserveHook<OnLaneStallArgs>[];
//        }
//
// CONTRACT under test:
//   - `claimPolicy` is a FIRST-WINS hook returning `Task[] | undefined`:
//     `undefined` abstains (use the default claim order); a `Task[]` — EVEN AN
//     EMPTY ONE — is a real winning value (claim exactly these tasks, possibly
//     zero). Typed via `FirstWinsHook<Task[] | undefined, …>`.
//   - `concurrencyKey` is a FIRST-WINS hook returning `string | undefined`:
//     `undefined` abstains (default concurrency); a string — EVEN `''` — is a
//     real winning value (group tasks under this key for per-dimension limits).
//     Typed via `FirstWinsHook<string | undefined, …>`.
//   - `wakeStrategy` / `onLaneIdle` / `onLaneStall` are OBSERVE hooks
//     (composition rule `'observe'`): one-way fan-out; return value discarded.
//     Typed via `ObserveHook<…>`.
//   - Each field accepts EITHER a single hook function OR an array of them
//     (mirrors `HookRegistry.register`, which collects multiple subscribers
//     per field).
//   - All five fields are OPTIONAL.
//   - `ClaimPolicyArgs.tracker` is typed `unknown` (the real tracker object is
//     cast at the call site, so types.ts stays free of a LanePool dependency).
//
// IMPORTANT §7 constraint pinned here: a `concurrencyKey` hook must NOT
// parallelize task-branch merges into the shared main-wt branch — only task
// EXECUTION is concurrent; merges stay serialized via `mergeChain`. The
// `concurrencyKey` JSDoc must document this (verified below).
//
// This suite is written TEST-FIRST. The compile-time `assertEqual<…>` checks
// are RED until the spec lands in types.ts (they reference types / fields
// that do not yet exist); they go GREEN once the five hooks are added. The
// runtime checks additionally exercise the handler call shapes (first-wins
// `[]` / `''` ≠ abstain; observe returns void / Promise<void>).
//
// NOTE: this file pins the NEW scheduler shape only and does not redefine the
// mechanism contract (tests/hooks/types.test.ts) or the lane-isolation shape
// (tests/hooks/types-lane-isolation.test.ts).

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../../packages/engine/src/core/types.js';
import type {
  // ── NEW (RED until the spec lands) ──
  ClaimPolicyArgs,
  ConcurrencyKeyArgs,
  FirstWinsHook,
  HookContext,
  HookRegistry,
  ObserveHook,
  OnLaneIdleArgs,
  OnLaneStallArgs,
  WakeStrategyArgs,
  WorkflowHooks,
} from '../../packages/engine/src/hooks/types.js';

// ─── Type-level exact-equality utility ─────────────────────────────────────
// Resolves to `true` iff X and Y are structurally identical (catches extra /
// missing fields, optionality, and type changes). Pattern from
// tests/hooks/types.test.ts and tests/hooks/types-lane-isolation.test.ts.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}
function assertNotEqual<T extends false>(_desc?: string): void {}

// ─── Independent "expected" copies ─────────────────────────────────────────
// Defined WITHOUT aliasing the imported types where it matters, so each
// Equal<Imported, Expected> comparison is a genuine structural check rather
// than identity. `Task` is the SAME binding imported by both the expected copy
// and types.ts, so the `.task` field comparison is meaningful.

interface ExpectedClaimPolicyArgs {
  tracker: unknown;
  laneId: string;
  maxClaim: number;
}

interface ExpectedConcurrencyKeyArgs {
  task: Task;
}

interface ExpectedWakeStrategyArgs {
  laneId: string;
  reason: 'task-ready' | 'task-settled' | 'timeout' | 'abort';
}

interface ExpectedOnLaneIdleArgs {
  laneId: string;
  consecutiveTimeouts: number;
}

interface ExpectedOnLaneStallArgs {
  laneId: string;
  consecutiveTimeouts: number;
  threshold: number;
}

type ExpectedClaimPolicyField =
  | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>
  | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>[];

type ExpectedConcurrencyKeyField =
  | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>
  | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>[];

type ExpectedWakeStrategyField = ObserveHook<WakeStrategyArgs> | ObserveHook<WakeStrategyArgs>[];
type ExpectedOnLaneIdleField = ObserveHook<OnLaneIdleArgs> | ObserveHook<OnLaneIdleArgs>[];
type ExpectedOnLaneStallField = ObserveHook<OnLaneStallArgs> | ObserveHook<OnLaneStallArgs>[];

// ─── Compile-time field-presence assertions ────────────────────────────────
// Compiles either way; RED until the fields exist (`keyof WorkflowHooks` does
// not yet include them).

assertEqual<Equal<'claimPolicy' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `claimPolicy`',
);
assertEqual<Equal<'concurrencyKey' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `concurrencyKey`',
);
assertEqual<Equal<'wakeStrategy' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `wakeStrategy`',
);
assertEqual<Equal<'onLaneIdle' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `onLaneIdle`',
);
assertEqual<Equal<'onLaneStall' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `onLaneStall`',
);

// ─── Compile-time field TYPE + OPTIONALITY assertions ──────────────────────
// Indexed access on an optional property yields `T | undefined`, so this also
// pins that the fields are OPTIONAL (a REQUIRED field would resolve to just
// `T` and fail the `| undefined` arm).

assertEqual<Equal<WorkflowHooks['claimPolicy'], ExpectedClaimPolicyField | undefined>>(
  'claimPolicy is FirstWinsHook<Task[]|undefined, ClaimPolicyArgs> | [same][] (optional)',
);
assertEqual<Equal<WorkflowHooks['concurrencyKey'], ExpectedConcurrencyKeyField | undefined>>(
  'concurrencyKey is FirstWinsHook<string|undefined, ConcurrencyKeyArgs> | [same][] (optional)',
);
assertEqual<Equal<WorkflowHooks['wakeStrategy'], ExpectedWakeStrategyField | undefined>>(
  'wakeStrategy is ObserveHook<WakeStrategyArgs> | [same][] (optional)',
);
assertEqual<Equal<WorkflowHooks['onLaneIdle'], ExpectedOnLaneIdleField | undefined>>(
  'onLaneIdle is ObserveHook<OnLaneIdleArgs> | [same][] (optional)',
);
assertEqual<Equal<WorkflowHooks['onLaneStall'], ExpectedOnLaneStallField | undefined>>(
  'onLaneStall is ObserveHook<OnLaneStallArgs> | [same][] (optional)',
);

// Bidirectional assignability for the field unions — the gold-standard
// structural equality check. `NonNullable<…>` strips the `| undefined` so we
// compare just the hook union. If both lines compile, the declared field type
// ⊆ expected and vice versa.

const _claimPolicyField: ExpectedClaimPolicyField = null as unknown as NonNullable<WorkflowHooks['claimPolicy']>;
const _claimPolicyReverse: NonNullable<WorkflowHooks['claimPolicy']> = null as unknown as ExpectedClaimPolicyField;
const _concurrencyKeyField: ExpectedConcurrencyKeyField = null as unknown as NonNullable<
  WorkflowHooks['concurrencyKey']
>;
const _concurrencyKeyReverse: NonNullable<WorkflowHooks['concurrencyKey']> =
  null as unknown as ExpectedConcurrencyKeyField;
const _wakeStrategyField: ExpectedWakeStrategyField = null as unknown as NonNullable<WorkflowHooks['wakeStrategy']>;
const _wakeStrategyReverse: NonNullable<WorkflowHooks['wakeStrategy']> = null as unknown as ExpectedWakeStrategyField;
const _onLaneIdleField: ExpectedOnLaneIdleField = null as unknown as NonNullable<WorkflowHooks['onLaneIdle']>;
const _onLaneIdleReverse: NonNullable<WorkflowHooks['onLaneIdle']> = null as unknown as ExpectedOnLaneIdleField;
const _onLaneStallField: ExpectedOnLaneStallField = null as unknown as NonNullable<WorkflowHooks['onLaneStall']>;
const _onLaneStallReverse: NonNullable<WorkflowHooks['onLaneStall']> = null as unknown as ExpectedOnLaneStallField;
void _claimPolicyField;
void _claimPolicyReverse;
void _concurrencyKeyField;
void _concurrencyKeyReverse;
void _wakeStrategyField;
void _wakeStrategyReverse;
void _onLaneIdleField;
void _onLaneIdleReverse;
void _onLaneStallField;
void _onLaneStallReverse;

// ─── Compile-time arg-bag shape assertions ─────────────────────────────────

assertEqual<Equal<ClaimPolicyArgs, ExpectedClaimPolicyArgs>>('ClaimPolicyArgs shape is exact');
assertEqual<Equal<ConcurrencyKeyArgs, ExpectedConcurrencyKeyArgs>>('ConcurrencyKeyArgs shape is exact');
assertEqual<Equal<WakeStrategyArgs, ExpectedWakeStrategyArgs>>('WakeStrategyArgs shape is exact');
assertEqual<Equal<OnLaneIdleArgs, ExpectedOnLaneIdleArgs>>('OnLaneIdleArgs shape is exact');
assertEqual<Equal<OnLaneStallArgs, ExpectedOnLaneStallArgs>>('OnLaneStallArgs shape is exact');

// `tracker` is intentionally `unknown` (cast at the call site so types.ts has
// no LanePool dependency).
assertEqual<Equal<ClaimPolicyArgs['tracker'], unknown>>('ClaimPolicyArgs.tracker is unknown');
assertEqual<Equal<ClaimPolicyArgs['laneId'], string>>('ClaimPolicyArgs.laneId is string');
assertEqual<Equal<ClaimPolicyArgs['maxClaim'], number>>('ClaimPolicyArgs.maxClaim is number');

assertEqual<Equal<ConcurrencyKeyArgs['task'], Task>>('ConcurrencyKeyArgs.task is the core Task');

assertEqual<Equal<WakeStrategyArgs['laneId'], string>>('WakeStrategyArgs.laneId is string');
assertEqual<Equal<WakeStrategyArgs['reason'], 'task-ready' | 'task-settled' | 'timeout' | 'abort'>>(
  'WakeStrategyArgs.reason is the four-value union',
);

assertEqual<Equal<OnLaneIdleArgs['laneId'], string>>('OnLaneIdleArgs.laneId is string');
assertEqual<Equal<OnLaneIdleArgs['consecutiveTimeouts'], number>>('OnLaneIdleArgs.consecutiveTimeouts is number');

assertEqual<Equal<OnLaneStallArgs['laneId'], string>>('OnLaneStallArgs.laneId is string');
assertEqual<Equal<OnLaneStallArgs['consecutiveTimeouts'], number>>('OnLaneStallArgs.consecutiveTimeouts is number');
assertEqual<Equal<OnLaneStallArgs['threshold'], number>>('OnLaneStallArgs.threshold is number');

// The arg bags are NOT silently aliased (distinct field sets).
assertNotEqual<Equal<OnLaneIdleArgs, OnLaneStallArgs>>(
  'OnLaneIdleArgs and OnLaneStallArgs are distinct (only OnLaneStallArgs has threshold)',
);
assertNotEqual<Equal<ClaimPolicyArgs, ConcurrencyKeyArgs>>('ClaimPolicyArgs and ConcurrencyKeyArgs are distinct');

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

function makeClaimPolicyArgs(overrides: Partial<ClaimPolicyArgs> = {}): ClaimPolicyArgs {
  return {
    // `tracker` is typed `unknown`; any object satisfies it (the real
    // LanePool tracker is cast at the call site).
    tracker: { kind: 'lane-pool', ready: ['task-1'] },
    laneId: 'lane-A',
    maxClaim: 4,
    ...overrides,
  };
}

function makeConcurrencyKeyArgs(overrides: Partial<ConcurrencyKeyArgs> = {}): ConcurrencyKeyArgs {
  return {
    task: makeTask(),
    ...overrides,
  };
}

function makeWakeStrategyArgs(overrides: Partial<WakeStrategyArgs> = {}): WakeStrategyArgs {
  return {
    laneId: 'lane-A',
    reason: 'task-ready',
    ...overrides,
  };
}

function makeOnLaneIdleArgs(overrides: Partial<OnLaneIdleArgs> = {}): OnLaneIdleArgs {
  return {
    laneId: 'lane-A',
    consecutiveTimeouts: 0,
    ...overrides,
  };
}

function makeOnLaneStallArgs(overrides: Partial<OnLaneStallArgs> = {}): OnLaneStallArgs {
  return {
    laneId: 'lane-A',
    consecutiveTimeouts: 5,
    threshold: 3,
    ...overrides,
  };
}

// ─── types.ts source structure ─────────────────────────────────────────────

describe('types.ts source structure (Task import + new exports)', () => {
  const src = tryReadSource(TYPES_PATH);

  it('imports Task TYPE-ONLY from ../core/types.js', () => {
    // Tolerates any whitespace form (`import type { Task }`, `import type{Task}`,
    // co-imported names, single/double quotes). `Task` is already imported by
    // the earlier tasks; this asserts it is STILL a type-only import.
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bTask\b[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  it('does NOT runtime-import anything from ../core/types.js (no circular runtime dep)', () => {
    // A runtime named import would be `import { X } from '../core/types.js'`
    // (no `type` keyword). The type-only import must NOT match this pattern.
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  // The arg-bag declarations may land as EITHER `export type X = {…}` (the `=`
  // notation in the spec) OR `export interface X {…}` (the convention used by
  // the existing arg bags in this file). Accept both so the source-structure
  // check is robust to the implementer's choice — the exact-shape contract is
  // already pinned by the Equal<…> assertions above.
  const argExport = (name: string): RegExp => new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`);

  it('exports ClaimPolicyArgs', () => {
    expect(src).toMatch(argExport('ClaimPolicyArgs'));
  });

  it('exports ConcurrencyKeyArgs', () => {
    expect(src).toMatch(argExport('ConcurrencyKeyArgs'));
  });

  it('exports WakeStrategyArgs', () => {
    expect(src).toMatch(argExport('WakeStrategyArgs'));
  });

  it('exports OnLaneIdleArgs', () => {
    expect(src).toMatch(argExport('OnLaneIdleArgs'));
  });

  it('exports OnLaneStallArgs', () => {
    expect(src).toMatch(argExport('OnLaneStallArgs'));
  });

  it('declares claimPolicy as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bclaimPolicy\s*\??\s*:/);
  });

  it('declares concurrencyKey as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bconcurrencyKey\s*\??\s*:/);
  });

  it('declares wakeStrategy as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bwakeStrategy\s*\??\s*:/);
  });

  it('declares onLaneIdle as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bonLaneIdle\s*\??\s*:/);
  });

  it('declares onLaneStall as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bonLaneStall\s*\??\s*:/);
  });

  it('declares each new field name at most once (declaration merge adds, not duplicates)', () => {
    // Declaration merging requires UNIQUE field names within the merged
    // interface; a duplicate key would be a TS2717 error. Count occurrences of
    // each field-declaration line.
    for (const field of ['claimPolicy', 'concurrencyKey', 'wakeStrategy', 'onLaneIdle', 'onLaneStall']) {
      const count = (src.match(new RegExp(`\\b${field}\\s*\\??\\s*:`, 'g')) ?? []).length;
      expect(count).toBe(1);
    }
  });
});

// ─── concurrencyKey JSDoc — §7 merge serialization constraint ─────────
//
// IMPORTANT constraint (§7): a `concurrencyKey` hook must NOT parallelize
// task-branch merges into the shared main-wt branch. Only task EXECUTION is
// concurrent; merges stay serialized via the WorktreeManager git lock
// (`withGitLock` in worktree-manager.ts). The `concurrencyKey` JSDoc must
// document this so a workflow author cannot be misled into thinking the key
// affects merge parallelism.

describe('concurrencyKey JSDoc — merge serialization constraint (§7)', () => {
  const src = tryReadSource(TYPES_PATH);

  /** Slice the source window immediately preceding the concurrencyKey field
   *  declaration (where its JSDoc lives). Returns '' if the field is absent. */
  function concurrencyKeyDocWindow(): string {
    const idx = src.search(/\bconcurrencyKey\s*\??\s*:/);
    if (idx < 0) return '';
    // 900 chars comfortably covers a multi-line JSDoc block.
    return src.slice(Math.max(0, idx - 900), idx);
  }

  it('the concurrencyKey field is declared (window is non-empty)', () => {
    expect(concurrencyKeyDocWindow().length).toBeGreaterThan(0);
  });

  it('mentions merge (task-branch merges into the shared main-wt branch)', () => {
    expect(concurrencyKeyDocWindow().toLowerCase()).toContain('merge');
  });

  it('documents that merges are serialized / not parallelized', () => {
    // Matches "serialize", "serialized", "serial", "git lock", or
    // "parallel" — any phrasing of the §7 constraint.
    expect(concurrencyKeyDocWindow()).toMatch(/(serial|git lock|parallel)/i);
  });

  it('references the git-lock serialization mechanism', () => {
    // The spec: merges stay serialized via the WorktreeManager git lock
    // (`withGitLock` in worktree-manager.ts), so the JSDoc is expected to
    // reference it by name.
    expect(concurrencyKeyDocWindow()).toMatch(/git lock/i);
  });

  it('documents that only task EXECUTION is concurrent', () => {
    // The complementary half of the §7 constraint: execution is concurrent,
    // merges are not.
    expect(concurrencyKeyDocWindow().toLowerCase()).toContain('execution');
  });
});

// ─── ClaimPolicyArgs ───────────────────────────────────────────────────────

describe('ClaimPolicyArgs', () => {
  it('accepts an object with tracker, laneId, maxClaim', () => {
    const tracker = { ready: ['a', 'b'] };
    const args: ClaimPolicyArgs = { tracker, laneId: 'lane-A', maxClaim: 4 };
    expect(args.laneId).toBe('lane-A');
    expect(args.maxClaim).toBe(4);
    expect(args.tracker).toBe(tracker);
  });

  it('tracker accepts any value (typed unknown)', () => {
    const fromNull: ClaimPolicyArgs = { tracker: null, laneId: 'l', maxClaim: 1 };
    const fromNum: ClaimPolicyArgs = { tracker: 42, laneId: 'l', maxClaim: 1 };
    const fromObj: ClaimPolicyArgs = { tracker: { x: 1 }, laneId: 'l', maxClaim: 1 };
    expect(fromNull.tracker).toBeNull();
    expect(fromNum.tracker).toBe(42);
    expect(fromObj.tracker).toEqual({ x: 1 });
  });

  it('requires all three fields (negative compile check)', () => {
    // @ts-expect-error — missing laneId, maxClaim
    const bad: ClaimPolicyArgs = { tracker: 'x' };
    expect(bad).toBeDefined();
  });

  it('rejects an extra unknown field (negative compile check)', () => {
    // @ts-expect-error — `priority` is not a member of ClaimPolicyArgs
    const bad: ClaimPolicyArgs = { tracker: 'x', laneId: 'l', maxClaim: 4, priority: 9 };
    expect(bad).toBeDefined();
  });
});

// ─── ConcurrencyKeyArgs ────────────────────────────────────────────────────

describe('ConcurrencyKeyArgs', () => {
  it('accepts an object with task', () => {
    const task = makeTask({ id: 't-9' });
    const args: ConcurrencyKeyArgs = { task };
    expect(args.task).toBe(task);
  });

  it('requires task (negative compile check)', () => {
    // @ts-expect-error — missing task
    const bad: ConcurrencyKeyArgs = {};
    expect(bad).toBeDefined();
  });

  it('rejects an extra field like laneId (negative compile check)', () => {
    // @ts-expect-error — laneId is not a member of ConcurrencyKeyArgs
    const bad: ConcurrencyKeyArgs = { task: makeTask(), laneId: 'l' };
    expect(bad).toBeDefined();
  });

  it('task round-trips as the core Task type', () => {
    const task: Task = makeTask({ id: 'ck-task' });
    const args: ConcurrencyKeyArgs = { task };
    const back: Task = args.task;
    expect(back.id).toBe('ck-task');
  });
});

// ─── WakeStrategyArgs ──────────────────────────────────────────────────────

describe('WakeStrategyArgs', () => {
  it('accepts an object with laneId and reason', () => {
    const args: WakeStrategyArgs = { laneId: 'lane-A', reason: 'task-ready' };
    expect(args.laneId).toBe('lane-A');
    expect(args.reason).toBe('task-ready');
  });

  it('accepts every documented reason value', () => {
    const reasons = ['task-ready', 'task-settled', 'timeout', 'abort'] as const;
    expect(reasons).toHaveLength(4);
    expect(new Set(reasons).size).toBe(4);
    for (const reason of reasons) {
      const args: WakeStrategyArgs = { laneId: 'l', reason };
      expect(args.reason).toBe(reason);
    }
  });

  it('rejects an unknown reason value (negative compile check)', () => {
    // @ts-expect-error — 'custom' is not a member of the reason union
    const bad: WakeStrategyArgs = { laneId: 'l', reason: 'custom' };
    expect(bad).toBeDefined();
  });

  it('requires both fields (negative compile check)', () => {
    // @ts-expect-error — missing reason
    const bad: WakeStrategyArgs = { laneId: 'l' };
    expect(bad).toBeDefined();
  });
});

// ─── OnLaneIdleArgs ────────────────────────────────────────────────────────

describe('OnLaneIdleArgs', () => {
  it('accepts an object with laneId and consecutiveTimeouts', () => {
    const args: OnLaneIdleArgs = { laneId: 'lane-A', consecutiveTimeouts: 2 };
    expect(args.laneId).toBe('lane-A');
    expect(args.consecutiveTimeouts).toBe(2);
  });

  it('has NO threshold field (distinct from OnLaneStallArgs)', () => {
    // @ts-expect-error — threshold is not a member of OnLaneIdleArgs
    const bad: OnLaneIdleArgs = { laneId: 'l', consecutiveTimeouts: 0, threshold: 3 };
    expect(bad).toBeDefined();
  });

  it('requires both fields (negative compile check)', () => {
    // @ts-expect-error — missing consecutiveTimeouts
    const bad: OnLaneIdleArgs = { laneId: 'l' };
    expect(bad).toBeDefined();
  });
});

// ─── OnLaneStallArgs ───────────────────────────────────────────────────────

describe('OnLaneStallArgs', () => {
  it('accepts an object with laneId, consecutiveTimeouts, threshold', () => {
    const args: OnLaneStallArgs = { laneId: 'lane-A', consecutiveTimeouts: 5, threshold: 3 };
    expect(args.laneId).toBe('lane-A');
    expect(args.consecutiveTimeouts).toBe(5);
    expect(args.threshold).toBe(3);
  });

  it('requires all three fields (negative compile check)', () => {
    // @ts-expect-error — missing threshold
    const bad: OnLaneStallArgs = { laneId: 'l', consecutiveTimeouts: 5 };
    expect(bad).toBeDefined();
  });

  it('rejects an extra unknown field (negative compile check)', () => {
    const bad: OnLaneStallArgs = {
      laneId: 'l',
      consecutiveTimeouts: 5,
      threshold: 3,
      // @ts-expect-error — `action` is not a member of OnLaneStallArgs
      action: 'abort',
    };
    expect(bad).toBeDefined();
  });
});

// ─── WorkflowHooks.claimPolicy (first-wins: Task[] | undefined) ────────────

describe('WorkflowHooks.claimPolicy (first-wins)', () => {
  it('is optional — a hooks object without claimPolicy is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.claimPolicy).toBeUndefined();
  });

  it('accepts a single first-wins handler', () => {
    const hooks: WorkflowHooks = { claimPolicy: () => undefined };
    expect(typeof hooks.claimPolicy).toBe('function');
  });

  it('accepts an ARRAY of first-wins handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      claimPolicy: [() => undefined, async () => [makeTask()], () => undefined],
    };
    expect(Array.isArray(hooks.claimPolicy)).toBe(true);
    expect((hooks.claimPolicy as unknown[]).length).toBe(3);
  });

  it('a handler can return a Task[] (the winner — claim exactly these tasks)', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const handler: FirstWinsHook<Task[] | undefined, ClaimPolicyArgs> = () => tasks;
    expect(handler(makeClaimPolicyArgs(), makeCtx())).toBe(tasks);
  });

  it('a handler can return undefined (abstain — use the default claim order)', () => {
    const handler: FirstWinsHook<Task[] | undefined, ClaimPolicyArgs> = () => undefined;
    expect(handler(makeClaimPolicyArgs(), makeCtx())).toBeUndefined();
  });

  it('a handler can return an EMPTY Task[] — a real winning value, NOT an abstention', () => {
    // Returning `[]` means "claim zero tasks" and WINS; only `undefined`
    // abstains. This is the critical first-wins distinction (mirrors the
    // shouldIsolate `false` ≠ abstain contract).
    const handler: FirstWinsHook<Task[] | undefined, ClaimPolicyArgs> = () => [];
    const result = handler(makeClaimPolicyArgs(), makeCtx());
    expect(result).toEqual([]);
    expect(result).not.toBeUndefined();
  });

  it('a handler can resolve to a Promise<Task[] | undefined>', async () => {
    const handler: FirstWinsHook<Task[] | undefined, ClaimPolicyArgs> = async () => [makeTask()];
    await expect(handler(makeClaimPolicyArgs(), makeCtx())).resolves.toHaveLength(1);
  });

  it('a handler receives (ClaimPolicyArgs, HookContext)', () => {
    const args = makeClaimPolicyArgs({ laneId: 'lane-Q', maxClaim: 7 });
    const ctx = makeCtx({ cwd: '/custom' });
    let receivedArgs: ClaimPolicyArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: FirstWinsHook<Task[] | undefined, ClaimPolicyArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
      return undefined;
    };
    const hooks: WorkflowHooks = { claimPolicy: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-Q');
    expect(receivedArgs?.maxClaim).toBe(7);
    expect(receivedArgs?.tracker).toBe(args.tracker);
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/custom');
    expect(hooks.claimPolicy).toBe(handler);
  });
});

// ─── WorkflowHooks.concurrencyKey (first-wins: string | undefined) ─────────

describe('WorkflowHooks.concurrencyKey (first-wins)', () => {
  it('is optional — a hooks object without concurrencyKey is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.concurrencyKey).toBeUndefined();
  });

  it('accepts a single first-wins handler', () => {
    const hooks: WorkflowHooks = { concurrencyKey: () => undefined };
    expect(typeof hooks.concurrencyKey).toBe('function');
  });

  it('accepts an ARRAY of first-wins handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      concurrencyKey: [() => undefined, async () => 'by-repo', () => undefined],
    };
    expect(Array.isArray(hooks.concurrencyKey)).toBe(true);
    expect((hooks.concurrencyKey as unknown[]).length).toBe(3);
  });

  it('a handler can return a string (the winner — group under this key)', () => {
    const handler: FirstWinsHook<string | undefined, ConcurrencyKeyArgs> = () => 'by-repo';
    expect(handler(makeConcurrencyKeyArgs(), makeCtx())).toBe('by-repo');
  });

  it('a handler can return undefined (abstain — default concurrency)', () => {
    const handler: FirstWinsHook<string | undefined, ConcurrencyKeyArgs> = () => undefined;
    expect(handler(makeConcurrencyKeyArgs(), makeCtx())).toBeUndefined();
  });

  it('a handler can return an EMPTY string — a real winning value, NOT an abstention', () => {
    // Returning `''` means "group under the empty key" and WINS; only
    // `undefined` abstains. (Mirrors the first-wins `false` / `[]` contract.)
    const handler: FirstWinsHook<string | undefined, ConcurrencyKeyArgs> = () => '';
    const result = handler(makeConcurrencyKeyArgs(), makeCtx());
    expect(result).toBe('');
    expect(result).not.toBeUndefined();
  });

  it('a handler can resolve to a Promise<string | undefined>', async () => {
    const handler: FirstWinsHook<string | undefined, ConcurrencyKeyArgs> = async () => 'async-key';
    await expect(handler(makeConcurrencyKeyArgs(), makeCtx())).resolves.toBe('async-key');
  });

  it('a handler receives (ConcurrencyKeyArgs, HookContext)', () => {
    const task = makeTask({ id: 'ck-7' });
    const args = makeConcurrencyKeyArgs({ task });
    const ctx = makeCtx({ workDir: '/w/ck' });
    let receivedArgs: ConcurrencyKeyArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: FirstWinsHook<string | undefined, ConcurrencyKeyArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
      return 'by-repo';
    };
    const hooks: WorkflowHooks = { concurrencyKey: handler };

    const result = handler(args, ctx);

    expect(result).toBe('by-repo');
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.task).toBe(task);
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.workDir).toBe('/w/ck');
    expect(hooks.concurrencyKey).toBe(handler);
  });
});

// ─── WorkflowHooks.wakeStrategy (observe) ──────────────────────────────────

describe('WorkflowHooks.wakeStrategy (observe)', () => {
  it('is optional — a hooks object without wakeStrategy is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.wakeStrategy).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = { wakeStrategy: () => {} };
    expect(typeof hooks.wakeStrategy).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<WakeStrategyArgs> = async () => {};
    const hooks: WorkflowHooks = { wakeStrategy: handler };
    await expect(handler(makeWakeStrategyArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.wakeStrategy).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      wakeStrategy: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.wakeStrategy)).toBe(true);
    expect((hooks.wakeStrategy as unknown[]).length).toBe(3);
  });

  it('a handler receives (WakeStrategyArgs, HookContext) and returns void', () => {
    const args = makeWakeStrategyArgs({ laneId: 'lane-Z', reason: 'timeout' });
    const ctx = makeCtx({ cwd: '/wake' });
    let receivedArgs: WakeStrategyArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<WakeStrategyArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { wakeStrategy: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-Z');
    expect(receivedArgs?.reason).toBe('timeout');
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/wake');
    expect(hooks.wakeStrategy).toBe(handler);
  });
});

// ─── WorkflowHooks.onLaneIdle (observe) ────────────────────────────────────

describe('WorkflowHooks.onLaneIdle (observe)', () => {
  it('is optional — a hooks object without onLaneIdle is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.onLaneIdle).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = { onLaneIdle: () => {} };
    expect(typeof hooks.onLaneIdle).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<OnLaneIdleArgs> = async () => {};
    const hooks: WorkflowHooks = { onLaneIdle: handler };
    await expect(handler(makeOnLaneIdleArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.onLaneIdle).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      onLaneIdle: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.onLaneIdle)).toBe(true);
    expect((hooks.onLaneIdle as unknown[]).length).toBe(3);
  });

  it('a handler receives (OnLaneIdleArgs, HookContext) and returns void', () => {
    const args = makeOnLaneIdleArgs({ laneId: 'lane-I', consecutiveTimeouts: 1 });
    const ctx = makeCtx({ cwd: '/idle' });
    let receivedArgs: OnLaneIdleArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<OnLaneIdleArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { onLaneIdle: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-I');
    expect(receivedArgs?.consecutiveTimeouts).toBe(1);
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/idle');
    expect(hooks.onLaneIdle).toBe(handler);
  });
});

// ─── WorkflowHooks.onLaneStall (observe) ───────────────────────────────────

describe('WorkflowHooks.onLaneStall (observe)', () => {
  it('is optional — a hooks object without onLaneStall is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.onLaneStall).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = { onLaneStall: () => {} };
    expect(typeof hooks.onLaneStall).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<OnLaneStallArgs> = async () => {};
    const hooks: WorkflowHooks = { onLaneStall: handler };
    await expect(handler(makeOnLaneStallArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.onLaneStall).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      onLaneStall: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.onLaneStall)).toBe(true);
    expect((hooks.onLaneStall as unknown[]).length).toBe(3);
  });

  it('a handler receives (OnLaneStallArgs, HookContext) and returns void', () => {
    const args = makeOnLaneStallArgs({
      laneId: 'lane-S',
      consecutiveTimeouts: 6,
      threshold: 5,
    });
    const ctx = makeCtx({ cwd: '/stall' });
    let receivedArgs: OnLaneStallArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<OnLaneStallArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { onLaneStall: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.laneId).toBe('lane-S');
    expect(receivedArgs?.consecutiveTimeouts).toBe(6);
    expect(receivedArgs?.threshold).toBe(5);
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/stall');
    expect(hooks.onLaneStall).toBe(handler);
  });
});

// ─── Declaration merge — all five scheduler hooks coexist ──────────────────

describe('declaration merge — all five scheduler hooks coexist', () => {
  it('a hooks object can declare ALL five scheduler fields simultaneously', () => {
    const hooks: WorkflowHooks = {
      claimPolicy: () => undefined,
      concurrencyKey: () => undefined,
      wakeStrategy: () => {},
      onLaneIdle: () => {},
      onLaneStall: () => {},
    };
    expect(typeof hooks.claimPolicy).toBe('function');
    expect(typeof hooks.concurrencyKey).toBe('function');
    expect(typeof hooks.wakeStrategy).toBe('function');
    expect(typeof hooks.onLaneIdle).toBe('function');
    expect(typeof hooks.onLaneStall).toBe('function');
  });

  it('all five fields can be arrays at once', () => {
    const hooks: WorkflowHooks = {
      claimPolicy: [() => undefined, () => [makeTask()]],
      concurrencyKey: [() => 'a', () => undefined],
      wakeStrategy: [() => {}, async () => {}],
      onLaneIdle: [() => {}, () => {}],
      onLaneStall: [() => {}, () => {}],
    };
    expect(Array.isArray(hooks.claimPolicy)).toBe(true);
    expect(Array.isArray(hooks.concurrencyKey)).toBe(true);
    expect(Array.isArray(hooks.wakeStrategy)).toBe(true);
    expect(Array.isArray(hooks.onLaneIdle)).toBe(true);
    expect(Array.isArray(hooks.onLaneStall)).toBe(true);
  });

  it('coexists with the lane-isolation + step-level hooks (no field collisions)', () => {
    // Declaration merging requires unique field names across the whole merged
    // interface; the five new scheduler fields must not collide with the
    // previously-added beforeStepPrompt / collectContext / onLaneError /
    // shouldIsolate fields. If this object literal type-checks, there are no
    // duplicate-identifier TS2717 errors.
    const hooks: WorkflowHooks = {
      beforeStepPrompt: () => 'prompt',
      collectContext: () => ({ label: 'l', content: 'c' }),
      onLaneError: () => {},
      shouldIsolate: () => true,
      claimPolicy: () => undefined,
      concurrencyKey: () => undefined,
      wakeStrategy: () => {},
      onLaneIdle: () => {},
      onLaneStall: () => {},
    };
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'beforeStepPrompt',
        'claimPolicy',
        'collectContext',
        'concurrencyKey',
        'onLaneError',
        'onLaneIdle',
        'onLaneStall',
        'shouldIsolate',
        'wakeStrategy',
      ].sort(),
    );
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
    // The `import type { Task }` is erased at runtime, and every new export
    // here is a type-level construct (interface / type alias), so adding the
    // five scheduler hooks must NOT introduce a runtime dependency on
    // core/types.js or a LanePool implementation. The namespace has no value
    // exports.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
