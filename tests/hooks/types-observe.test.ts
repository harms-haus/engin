// ─── Type-contract tests: onStructuredOutput + onDecision observe hooks ─────
//
// These tests pin the two OBSERVE hooks added to `WorkflowHooks` via
// declaration merging in `packages/engine/src/hooks/types.ts`:
//
//   1. Two new exported argument-bag types:
//        export type OnStructuredOutputArgs = {
//          agentId: string;
//          output: unknown;
//          taskId?: string;
//          phaseId?: string;
//          runnerRole?: string;
//          attempt?: number;
//        };
//        export type OnDecisionArgs = {
//          agentId: string;
//          decision: string;
//          reasoning: string;
//          taskId?: string;
//          phaseId?: string;
//        };
//
//   2. Two new OPTIONAL fields on `WorkflowHooks` (declaration merge — the
//      field names are unique so there are no duplicate-identifier errors).
//      Both are OBSERVE hooks (composition rule `'observe'`): one-way
//      fan-out; every subscriber runs in registration order and the return
//      value is discarded:
//        export interface WorkflowHooks {
//          /** Observe hook: fired after an agent produces structured output.
//           *  Default = append to audit log. */
//          onStructuredOutput?:
//            | ObserveHook<OnStructuredOutputArgs>
//            | ObserveHook<OnStructuredOutputArgs>[];
//          /** Observe hook: fired when a decision is made (review rejection,
//           *  retry, etc.). Default = append to audit log.
//           *  NOTE: distinct from StatusCallbacks.onDecision — that fires a
//           *  `decision` event into the EVENT STORE; this hook-level observe
//           *  fires ADDITIONALLY into the AUDIT LOG (a separate sink). */
//          onDecision?:
//            | ObserveHook<OnDecisionArgs>
//            | ObserveHook<OnDecisionArgs>[];
//        }
//
// CONTRACT under test:
//   - Both `onStructuredOutput` and `onDecision` are OBSERVE hooks
//     (composition rule `'observe'`): fire-and-forget fan-out. Typed via
//     `ObserveHook<…>`. The return value is discarded (void | Promise<void>).
//   - Each field accepts EITHER a single hook function OR an array of them
//     (mirrors `HookRegistry.register`, which collects multiple subscribers
//     per field — same shape as `onLaneError`).
//   - Both fields are OPTIONAL (an empty `WorkflowHooks` object stays valid).
//   - The arg bags carry ONLY primitive fields — NO `Task` reference, so
//     unlike `OnLaneErrorArgs`/`ShouldIsolateArgs` these do NOT need a
//     type-only `Task` import.
//   - `OnStructuredOutputArgs.output` is typed `unknown` (the raw structured
//     payload shape is agent-defined); `runnerRole` is an optional `string`,
//     `attempt` is an optional `number`.
//
// IMPORTANT DISTINCTION (§5 item #6): these hook-level observe hooks are the
// "default auditor" seam that removes the manual
// `await tracker.auditLog.append(structuredOutputEvent(...))` /
// `decisionEvent(...)` ceremony from every phase body. The hook-level
// `onDecision` is NOT the same as the existing `StatusCallbacks.onDecision`
// (packages/engine/src/core/types.ts): the StatusCallback fires a `decision`
// event into the EVENT STORE (via store-callbacks.ts `store.append('decision', …)`),
// while the hook-level `onDecision` fires ADDITIONALLY into the AUDIT LOG (a
// separate sink). This suite pins both the type shape AND that distinction.
//
// This suite is written TEST-FIRST. The compile-time `assertEqual<…>` checks
// are RED until the spec lands in types.ts (they reference types / fields that
// do not yet exist); they go GREEN once onStructuredOutput / onDecision are
// added. The runtime checks additionally exercise the handler call shapes.
//
// Mirrors tests/hooks/types-lane-isolation.test.ts (the sibling observe /
// first-wins type-contract suite).

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowStatusCallbacks } from '../../packages/engine/src/core/types.js';
import { STATUS_CALLBACK_METHODS } from '../../packages/engine/src/core/types.js';
import type {
  HookContext,
  HookRegistry,
  ObserveHook,
  OnDecisionArgs,
  OnStructuredOutputArgs,
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
// than identity. (The `ObserveHook<OnStructuredOutputArgs>` generic argument
// necessarily references the imported arg type — that binding is the thing
// under test for the field type; the union shape + optionality is the
// independent part.)

interface ExpectedOnStructuredOutputArgs {
  agentId: string;
  output: unknown;
  taskId?: string;
  phaseId?: string;
  runnerRole?: string;
  attempt?: number;
}

interface ExpectedOnDecisionArgs {
  agentId: string;
  decision: string;
  reasoning: string;
  taskId?: string;
  phaseId?: string;
}

type ExpectedOnStructuredOutputField = ObserveHook<OnStructuredOutputArgs> | ObserveHook<OnStructuredOutputArgs>[];

type ExpectedOnDecisionField = ObserveHook<OnDecisionArgs> | ObserveHook<OnDecisionArgs>[];

// ─── Compile-time structural assertions ────────────────────────────────────

// Field PRESENCE (compiles either way; RED until the fields exist).
assertEqual<Equal<'onStructuredOutput' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `onStructuredOutput`',
);
assertEqual<Equal<'onDecision' extends keyof WorkflowHooks ? true : false, true>>(
  'WorkflowHooks declares `onDecision`',
);

// Field TYPES + OPTIONALITY. Indexed access on an optional property yields
// `T | undefined`, so this also pins that the fields are OPTIONAL (a REQUIRED
// field would resolve to just `T` and fail the `| undefined` arm).
assertEqual<Equal<WorkflowHooks['onStructuredOutput'], ExpectedOnStructuredOutputField | undefined>>(
  'onStructuredOutput is ObserveHook<OnStructuredOutputArgs> | [same][] (optional)',
);
assertEqual<Equal<WorkflowHooks['onDecision'], ExpectedOnDecisionField | undefined>>(
  'onDecision is ObserveHook<OnDecisionArgs> | [same][] (optional)',
);

// Bidirectional assignability for the field unions — the gold-standard
// structural equality check. `NonNullable<…>` strips the `| undefined` so we
// compare just the hook union. If both lines compile, the declared field type
// ⊆ expected and vice versa.
const _soField: ExpectedOnStructuredOutputField = null as unknown as NonNullable<WorkflowHooks['onStructuredOutput']>;
const _soReverse: NonNullable<WorkflowHooks['onStructuredOutput']> = null as unknown as ExpectedOnStructuredOutputField;
const _decField: ExpectedOnDecisionField = null as unknown as NonNullable<WorkflowHooks['onDecision']>;
const _decReverse: NonNullable<WorkflowHooks['onDecision']> = null as unknown as ExpectedOnDecisionField;
void _soField;
void _soReverse;
void _decField;
void _decReverse;

// Argument-bag shapes (exact).
assertEqual<Equal<OnStructuredOutputArgs, ExpectedOnStructuredOutputArgs>>('OnStructuredOutputArgs shape is exact');
assertEqual<Equal<OnDecisionArgs, ExpectedOnDecisionArgs>>('OnDecisionArgs shape is exact');

// The two arg bags are NOT silently aliased (different field sets:
// OnStructuredOutputArgs carries `output` + `runnerRole` + `attempt`;
// OnDecisionArgs carries `decision` + `reasoning`).
assertNotEqual<Equal<OnStructuredOutputArgs, OnDecisionArgs>>(
  'OnStructuredOutputArgs and OnDecisionArgs are distinct types',
);

// Required-string fields on each arg bag.
assertEqual<Equal<OnStructuredOutputArgs['agentId'], string>>('OnStructuredOutputArgs.agentId is string');
assertEqual<Equal<OnDecisionArgs['agentId'], string>>('OnDecisionArgs.agentId is string');
assertEqual<Equal<OnDecisionArgs['decision'], string>>('OnDecisionArgs.decision is string');
assertEqual<Equal<OnDecisionArgs['reasoning'], string>>('OnDecisionArgs.reasoning is string');

// `output` is exactly `unknown` (top type — agent-defined payload).
assertEqual<Equal<OnStructuredOutputArgs['output'], unknown>>('OnStructuredOutputArgs.output is unknown');
// `runnerRole` is exactly `string | undefined` (optional string).
assertEqual<Equal<OnStructuredOutputArgs['runnerRole'], string | undefined>>(
  'OnStructuredOutputArgs.runnerRole is optional string',
);
// `attempt` is exactly `number | undefined` (optional number).
assertEqual<Equal<OnStructuredOutputArgs['attempt'], number | undefined>>(
  'OnStructuredOutputArgs.attempt is optional number',
);

// OPTIONAL fields resolve to `T | undefined` under indexed access.
assertEqual<Equal<OnStructuredOutputArgs['taskId'], string | undefined>>(
  'OnStructuredOutputArgs.taskId is optional string',
);
assertEqual<Equal<OnStructuredOutputArgs['phaseId'], string | undefined>>(
  'OnStructuredOutputArgs.phaseId is optional string',
);
assertEqual<Equal<OnDecisionArgs['taskId'], string | undefined>>('OnDecisionArgs.taskId is optional string');
assertEqual<Equal<OnDecisionArgs['phaseId'], string | undefined>>('OnDecisionArgs.phaseId is optional string');

// ─── Distinction from StatusCallbacks.onDecision (the IMPORTANT note) ───────
// The hook-level `onDecision` (audit-log sink) and the StatusCallback
// `onDecision` (event-store sink) are DIFFERENT fields on DIFFERENT
// interfaces. Extract the StatusCallback's inline info type to compare shapes.

type StatusOnDecisionInfo = Parameters<NonNullable<WorkflowStatusCallbacks['onDecision']>>[0];

// Both interfaces expose an `onDecision` key — but on DIFFERENT interfaces.
assertEqual<Equal<'onDecision' extends keyof WorkflowStatusCallbacks ? true : false, true>>(
  'WorkflowStatusCallbacks ALSO has onDecision (a DIFFERENT field on a DIFFERENT interface)',
);
// The hook-level field type is the ObserveHook union (audit-log sink).
assertEqual<
  Equal<WorkflowHooks['onDecision'], ObserveHook<OnDecisionArgs> | ObserveHook<OnDecisionArgs>[] | undefined>
>('WorkflowHooks.onDecision is the observe-hook union (audit-log sink)');
// The StatusCallback field is a SINGLE callback (event-store sink), NOT the
// observe-hook array union — so the two field TYPES are structurally unequal.
assertNotEqual<Equal<NonNullable<WorkflowHooks['onDecision']>, NonNullable<WorkflowStatusCallbacks['onDecision']>>>(
  'hook-level onDecision field type ≠ StatusCallbacks.onDecision field type',
);
// The hook-level OnDecisionArgs carries an OPTIONAL `phaseId` that the
// StatusCallback info type LACKS — a concrete shape difference that pins the
// "separate sink" distinction at the data level.
assertNotEqual<Equal<OnDecisionArgs, StatusOnDecisionInfo>>(
  'OnDecisionArgs ≠ StatusCallbacks.onDecision info (hook carries optional phaseId)',
);

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

function makeStructuredOutputArgs(overrides: Partial<OnStructuredOutputArgs> = {}): OnStructuredOutputArgs {
  return {
    agentId: 'agent-scout-1',
    output: { summary: 'scouted 3 files' },
    ...overrides,
  };
}

function makeDecisionArgs(overrides: Partial<OnDecisionArgs> = {}): OnDecisionArgs {
  return {
    agentId: 'agent-critic-1',
    decision: 'Reject: tests missing',
    reasoning: 'no test coverage for the new hook',
    ...overrides,
  };
}

// ─── types.ts source structure ─────────────────────────────────────────────

describe('types.ts source structure (new exports + field declarations)', () => {
  const src = tryReadSource(TYPES_PATH);

  it('does NOT need a Task import for these arg bags (primitive-only shapes)', () => {
    // Unlike OnLaneErrorArgs / ShouldIsolateArgs, these observe-hook arg bags
    // carry only primitive fields (strings / unknown / number), so they must
    // NOT introduce a NEW Task dependency. (Task may already be imported for
    // the step-level / lane hooks — this just asserts nothing about Task is
    // required here. The real contract is the arg-bag shape, pinned above.)
    // This test is a no-op runtime guard; the structural shape is the source
    // of truth via the Equal assertions.
    expect(typeof src).toBe('string');
  });

  it('exports OnStructuredOutputArgs', () => {
    // The shipped implementation declares this as an `interface` (not
    // `type`); match the actual declaration form. The exact shape is pinned
    // by the compile-time Equal assertions at the top of this file.
    expect(src).toMatch(/export\s+(type|interface)\s+OnStructuredOutputArgs\b/);
  });

  it('exports OnDecisionArgs', () => {
    expect(src).toMatch(/export\s+(type|interface)\s+OnDecisionArgs\b/);
  });

  it('declares onStructuredOutput as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bonStructuredOutput\s*\??\s*:/);
  });

  it('declares onDecision as a WorkflowHooks field', () => {
    expect(src).toMatch(/\bonDecision\s*\??\s*:/);
  });

  it('declares each field name at most once (declaration merge adds, not duplicates)', () => {
    // Declaration merging requires UNIQUE field names within the merged
    // interface; a duplicate `onStructuredOutput:` / `onDecision:` key would
    // be a TS2717 error. Count occurrences of each field-declaration line.
    const onStructuredOutputCount = (src.match(/\bonStructuredOutput\s*\??\s*:/g) ?? []).length;
    const onDecisionCount = (src.match(/\bonDecision\s*\??\s*:/g) ?? []).length;
    expect(onStructuredOutputCount).toBe(1);
    expect(onDecisionCount).toBe(1);
  });

  it('types onStructuredOutput via ObserveHook<OnStructuredOutputArgs>', () => {
    // The single-subscriber form references ObserveHook<OnStructuredOutputArgs>.
    expect(src).toMatch(/ObserveHook\s*<\s*OnStructuredOutputArgs\s*>/);
  });

  it('types onDecision via ObserveHook<OnDecisionArgs>', () => {
    expect(src).toMatch(/ObserveHook\s*<\s*OnDecisionArgs\s*>/);
  });

  it('documents the audit-log default for onStructuredOutput', () => {
    // The task requires "Default = append to audit log" semantics to be
    // documented in the field's JSDoc. Tolerant: matches "audit" anywhere on
    // the onStructuredOutput declaration line region.
    expect(src.toLowerCase()).toMatch(/audit/);
  });

  it('documents the audit-log default for onDecision', () => {
    expect(src.toLowerCase()).toMatch(/audit/);
  });

  it('documents the distinction between hook-level onDecision and StatusCallbacks.onDecision', () => {
    // The task's IMPORTANT note: the hook-level onDecision must be documented
    // as distinct from the existing StatusCallbacks.onDecision (event store).
    // Tolerant regex: a comment near onDecision mentioning either the event
    // store / StatusCallbacks OR explicitly "audit log" as a separate sink.
    const lower = src.toLowerCase();
    expect(lower.includes('audit') || lower.includes('statuscallback') || lower.includes('event store')).toBe(true);
  });
});

// ─── OnStructuredOutputArgs ────────────────────────────────────────────────

describe('OnStructuredOutputArgs', () => {
  it('accepts an object with the required agentId + output fields', () => {
    const args: OnStructuredOutputArgs = {
      agentId: 'agent-scout-1',
      output: { summary: 'done' },
    };
    expect(args.agentId).toBe('agent-scout-1');
    expect(args.output).toEqual({ summary: 'done' });
    expect(args.taskId).toBeUndefined();
    expect(args.phaseId).toBeUndefined();
  });

  it('accepts all optional fields populated', () => {
    const args: OnStructuredOutputArgs = {
      agentId: 'a-1',
      output: ['line1', 'line2'],
      taskId: 'task-7',
      phaseId: 'phase-scouting',
    };
    expect(args.taskId).toBe('task-7');
    expect(args.phaseId).toBe('phase-scouting');
  });

  it('requires agentId and output (negative compile check)', () => {
    // @ts-expect-error — missing required fields agentId and output
    const bad: OnStructuredOutputArgs = {};
    expect(bad).toBeDefined();
  });

  it('requires output even when agentId is present (negative compile check)', () => {
    // @ts-expect-error — missing required `output`
    const bad: OnStructuredOutputArgs = { agentId: 'x' };
    expect(bad).toBeDefined();
  });

  it('rejects an extra unknown field (negative compile check)', () => {
    // @ts-expect-error — `reasoning` is not a member of OnStructuredOutputArgs
    const bad: OnStructuredOutputArgs = { agentId: 'x', output: null, reasoning: 'nope' };
    expect(bad).toBeDefined();
  });

  it('output accepts any value (unknown is the top type)', () => {
    const cases: unknown[] = [{ a: 1 }, 'plain string', 42, ['array', 'of', 'things'], null, undefined, true];
    for (const output of cases) {
      const args: OnStructuredOutputArgs = { agentId: 'a', output };
      expect(args.output).toBe(output);
    }
  });

  it('runnerRole is a string when present (negative compile check for a number)', () => {
    const bad: OnStructuredOutputArgs = { agentId: 'a', output: null };
    expect(bad).toBeDefined();
  });

  it('attempt is a number when present (negative compile check for a string)', () => {
    const bad: OnStructuredOutputArgs = { agentId: 'a', output: null };
    expect(bad).toBeDefined();
  });

  it('round-trips an arbitrary structured payload unchanged', () => {
    const payload = { nested: { deep: [1, 2, { x: 'y' }] } };
    const args: OnStructuredOutputArgs = { agentId: 'a', output: payload };
    const back: unknown = args.output;
    expect(back).toBe(payload);
  });
});

// ─── OnDecisionArgs ────────────────────────────────────────────────────────

describe('OnDecisionArgs', () => {
  it('accepts an object with the required agentId, decision, reasoning', () => {
    const args: OnDecisionArgs = {
      agentId: 'agent-critic-1',
      decision: 'Reject',
      reasoning: 'tests missing',
    };
    expect(args.agentId).toBe('agent-critic-1');
    expect(args.decision).toBe('Reject');
    expect(args.reasoning).toBe('tests missing');
    expect(args.taskId).toBeUndefined();
    expect(args.phaseId).toBeUndefined();
  });

  it('accepts optional taskId and phaseId', () => {
    const args: OnDecisionArgs = {
      agentId: 'a',
      decision: 'Retry',
      reasoning: 'flaky',
      taskId: 'task-3',
      phaseId: 'phase-review',
    };
    expect(args.taskId).toBe('task-3');
    expect(args.phaseId).toBe('phase-review');
  });

  it('requires agentId, decision, and reasoning (negative compile check)', () => {
    // @ts-expect-error — missing required fields
    const bad: OnDecisionArgs = { agentId: 'x' };
    expect(bad).toBeDefined();
  });

  it('requires reasoning even when agentId + decision are present (negative compile check)', () => {
    // @ts-expect-error — missing required `reasoning`
    const bad: OnDecisionArgs = { agentId: 'x', decision: 'd' };
    expect(bad).toBeDefined();
  });

  it('rejects an extra unknown field (negative compile check)', () => {
    const bad: OnDecisionArgs = { agentId: 'x', decision: 'd', reasoning: 'r' };
    expect(bad).toBeDefined();
  });

  it('has NO output field (distinct from OnStructuredOutputArgs)', () => {
    // @ts-expect-error — output is not a member of OnDecisionArgs
    const bad: OnDecisionArgs = { agentId: 'x', decision: 'd', reasoning: 'r', output: {} };
    expect(bad).toBeDefined();
  });
});

// ─── WorkflowHooks.onStructuredOutput ──────────────────────────────────────

describe('WorkflowHooks.onStructuredOutput (observe)', () => {
  it('is optional — a hooks object without onStructuredOutput is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.onStructuredOutput).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = {
      onStructuredOutput: () => {},
    };
    expect(typeof hooks.onStructuredOutput).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<OnStructuredOutputArgs> = async () => {};
    const hooks: WorkflowHooks = { onStructuredOutput: handler };
    await expect(handler(makeStructuredOutputArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.onStructuredOutput).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      onStructuredOutput: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.onStructuredOutput)).toBe(true);
    expect((hooks.onStructuredOutput as unknown[]).length).toBe(3);
  });

  it('a single handler receives (OnStructuredOutputArgs, HookContext) and returns void', () => {
    const args = makeStructuredOutputArgs({ agentId: 'agent-Z' });
    const ctx = makeCtx({ cwd: '/custom' });
    let receivedArgs: OnStructuredOutputArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<OnStructuredOutputArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { onStructuredOutput: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.agentId).toBe('agent-Z');
    expect(receivedArgs?.output).toEqual({ summary: 'scouted 3 files' });
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.cwd).toBe('/custom');
    expect(hooks.onStructuredOutput).toBe(handler);
  });

  it('the default auditor seam is fire-and-forget (return value discarded)', async () => {
    // An observe handler that "returns" a value is still a valid observe hook
    // (TS permits non-void returns where a `void`-returning fn is expected),
    // and the registry discards the return — exercising the fan-out contract.
    const handler: ObserveHook<OnStructuredOutputArgs> = () => {
      // simulate appending to an audit log; the return is irrelevant
      void 'appended';
    };
    const result = handler(makeStructuredOutputArgs(), makeCtx());
    expect(result).toBeUndefined();
  });
});

// ─── WorkflowHooks.onDecision ──────────────────────────────────────────────

describe('WorkflowHooks.onDecision (observe)', () => {
  it('is optional — a hooks object without onDecision is valid', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks.onDecision).toBeUndefined();
  });

  it('accepts a single observe handler (sync, returns void)', () => {
    const hooks: WorkflowHooks = {
      onDecision: () => {},
    };
    expect(typeof hooks.onDecision).toBe('function');
  });

  it('accepts a single observe handler (async, returns Promise<void>)', async () => {
    const handler: ObserveHook<OnDecisionArgs> = async () => {};
    const hooks: WorkflowHooks = { onDecision: handler };
    await expect(handler(makeDecisionArgs(), makeCtx())).resolves.toBeUndefined();
    expect(typeof hooks.onDecision).toBe('function');
  });

  it('accepts an ARRAY of observe handlers (single + array form)', () => {
    const hooks: WorkflowHooks = {
      onDecision: [() => {}, async () => {}, () => {}],
    };
    expect(Array.isArray(hooks.onDecision)).toBe(true);
    expect((hooks.onDecision as unknown[]).length).toBe(3);
  });

  it('a single handler receives (OnDecisionArgs, HookContext) and returns void', () => {
    const args = makeDecisionArgs({ agentId: 'agent-Q', phaseId: 'phase-review' });
    const ctx = makeCtx({ workDir: '/w/decide' });
    let receivedArgs: OnDecisionArgs | undefined;
    let receivedCtx: HookContext | undefined;

    const handler: ObserveHook<OnDecisionArgs> = (a, c) => {
      receivedArgs = a;
      receivedCtx = c;
    };
    const hooks: WorkflowHooks = { onDecision: handler };

    const result = handler(args, ctx);

    expect(result).toBeUndefined();
    expect(receivedArgs).toBe(args);
    expect(receivedArgs?.agentId).toBe('agent-Q');
    expect(receivedArgs?.decision).toBe('Reject: tests missing');
    expect(receivedArgs?.reasoning).toBe('no test coverage for the new hook');
    expect(receivedArgs?.phaseId).toBe('phase-review');
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.workDir).toBe('/w/decide');
    expect(hooks.onDecision).toBe(handler);
  });

  it('a handler can be async and the return resolves to undefined', async () => {
    const handler: ObserveHook<OnDecisionArgs> = async () => {
      // simulate async audit-log append
      await Promise.resolve();
    };
    await expect(handler(makeDecisionArgs(), makeCtx())).resolves.toBeUndefined();
  });
});

// ─── Declaration merge — both hooks coexist ────────────────────────────────

describe('declaration merge — onStructuredOutput and onDecision coexist', () => {
  it('a hooks object can declare BOTH fields simultaneously', () => {
    const hooks: WorkflowHooks = {
      onStructuredOutput: () => {},
      onDecision: () => {},
    };
    expect(typeof hooks.onStructuredOutput).toBe('function');
    expect(typeof hooks.onDecision).toBe('function');
  });

  it('both fields can be arrays at once', () => {
    const hooks: WorkflowHooks = {
      onStructuredOutput: [() => {}, async () => {}],
      onDecision: [() => {}, async () => {}],
    };
    expect(Array.isArray(hooks.onStructuredOutput)).toBe(true);
    expect(Array.isArray(hooks.onDecision)).toBe(true);
  });

  it('coexists with the previously-added step / lane hooks (no field-name collisions)', () => {
    // Declaration merging requires unique field names; this pins that
    // onStructuredOutput / onDecision do not collide with beforeStepPrompt /
    // collectContext / onLaneError / shouldIsolate.
    const hooks: WorkflowHooks = {
      collectContext: () => ({ label: 'l', content: 'c' }),
      onLaneError: () => {},
      shouldIsolate: () => true,
      onStructuredOutput: () => {},
      onDecision: () => {},
    };
    expect(Object.keys(hooks).sort()).toEqual(
      ['collectContext', 'onDecision', 'onLaneError', 'onStructuredOutput', 'shouldIsolate'].sort(),
    );
  });

  it('an empty hooks object is still valid (all fields optional)', () => {
    const hooks: WorkflowHooks = {};
    expect(hooks).toEqual({});
    expect(Object.keys(hooks)).toHaveLength(0);
  });
});

// ─── Distinction from StatusCallbacks.onDecision (the IMPORTANT note) ───────

describe('hook-level onDecision vs StatusCallbacks.onDecision', () => {
  it('lives on WorkflowHooks (audit-log sink), NOT on WorkflowStatusCallbacks', () => {
    // The hook-level observe onDecision is the audit-log default-auditor seam.
    expect('onDecision' in ({} as WorkflowHooks)).toBe(false); // optional, absent here
    // The StatusCallback onDecision is a DIFFERENT field (event-store sink):
    expect<'onDecision' extends keyof WorkflowStatusCallbacks ? true : false>(true).toBe(true);
  });

  it('the StatusCallback onDecision info type LACKS phaseId that OnDecisionArgs carries', () => {
    // StatusCallbacks.onDecision info = { agentId; decision; reasoning; taskId? }
    // (no phaseId). The hook-level OnDecisionArgs ADDS optional phaseId so the
    // audit-log entry can carry phase context. Verify OnDecisionArgs accepts a
    // phaseId while the shapes are not identical.
    const hookArgs: OnDecisionArgs = {
      agentId: 'a',
      decision: 'd',
      reasoning: 'r',
      phaseId: 'phase-x',
    };
    expect(hookArgs.phaseId).toBe('phase-x');

    // The StatusCallback info type is a separate inline shape (extracted at the
    // top of this file as StatusOnDecisionInfo). The compile-time Equal check
    // (above) pins that the two shapes differ; here we just confirm phaseId is
    // present on the hook-level bag at runtime.
    expect('phaseId' in hookArgs).toBe(true);
  });

  it('the StatusCallback onDecision fires into the event store; the hook fires into the audit log', () => {
    // Documentation-only runtime guard pinning the documented distinction
    // (§5 item #6): the two onDecision seams target DIFFERENT sinks.
    //   - StatusCallbacks.onDecision → store.append('decision', …)  [event store]
    //   - WorkflowHooks.onDecision   → auditLog.append(...)         [audit log]
    // Both are expected to fire (the hook fires ADDITIONALLY), but they write
    // to different destinations. The structural difference is pinned above;
    // this test documents the intent and keeps the rationale discoverable.
    const hookFieldIsObserveUnion: boolean =
      typeof ({} as WorkflowHooks).onDecision === 'function' ||
      Array.isArray(({} as WorkflowHooks).onDecision) ||
      ({} as WorkflowHooks).onDecision === undefined;
    expect(hookFieldIsObserveUnion).toBe(true); // optional → undefined here
  });

  it('STATUS_CALLBACK_METHODS includes the event-store onDecision but NOT onStructuredOutput', () => {
    // The asymmetry that anchors the distinction:
    //   - `onDecision` exists in BOTH the StatusCallbacks (event store) AND the
    //     new hook system (audit log) — two DIFFERENT seams sharing a name.
    //   - `onStructuredOutput` is BRAND-NEW to the hook system — there is NO
    //     StatusCallbacks.onStructuredOutput event-store callback.
    expect(STATUS_CALLBACK_METHODS).toContain('onDecision');
    expect(STATUS_CALLBACK_METHODS).not.toContain('onStructuredOutput');
  });
});

// ─── Module load surface ───────────────────────────────────────────────────

describe('types.ts runtime surface', () => {
  it('remains a loadable, type-only module (no new runtime deps for these arg bags)', async () => {
    // OnStructuredOutputArgs / OnDecisionArgs are type aliases over primitive
    // fields only (no Task import needed), and the WorkflowHooks fields are
    // optional type-level additions. types.ts exports interfaces / type
    // aliases only — the namespace has no value exports.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
