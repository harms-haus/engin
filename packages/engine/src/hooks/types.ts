// ─── Hook mechanism types ──────────────────────────────────────────────────
//
// This module defines ONLY the hook MECHANISM — composition rules, the four
// generic hook-function shapes, the `HookRegistry` interface, and the empty
// `WorkflowHooks` interface. NO specific hook signatures (beforeSessionPrompt,
// onPhaseSettled, …) live here yet; each is added incrementally by later
// tasks via declaration merging on `WorkflowHooks`.
//
// Everything exported here is a type-level construct (interface / type alias).
// There are no runtime value exports — the registry implementation ships in a
// later task — so importing this module produces an empty namespace at
// runtime and stays free of circular runtime dependencies.

import type { Task, WorkflowState, WorktreeInfo } from '../core/types.js';
import type { Runner } from '../pool/runners/types.js';
import type { StepDefinition } from '../pool/types.js';

/**
 * How multiple subscribers to the same hook name are combined when the registry
 * invokes them.
 *
 *  - `'observe'`     — one-way fan-out: every subscriber runs, no return value
 *                      is collected. Cheap, many consumers. Mirrors today's
 *                      `StatusCallbacks` model.
 *  - `'pipeline'`    — ordered value transform: each subscriber receives the
 *                      value produced by the previous one (or the initial value
 *                      for the first subscriber) and returns the next.
 *  - `'first-wins'`  — the first subscriber returning a non-`undefined` value
 *                      decides; later subscribers are short-circuited.
 *                      Returning `undefined` abstains.
 *  - `'all-run'`     — every subscriber contributes; contributions are merged
 *                      by the hook's reducer.
 */
export type CompositionRule = 'observe' | 'pipeline' | 'first-wins' | 'all-run';

/**
 * Base context object passed to every influence hook invocation.
 *
 * `registry` is a forward (type-only) reference to the `HookRegistry` interface
 * declared below — the implementation (a class) ships in a later task. The
 * type-only reference keeps this module free of runtime dependencies.
 */
export interface HookContext {
  registry: HookRegistry;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
}

/**
 * Observe hook (composition rule: `'observe'`): one-way fan-out. Every
 * subscriber runs in registration order; the return value is discarded.
 */
export type ObserveHook<Args> = (args: Args, ctx: HookContext) => void | Promise<void>;

/**
 * Pipeline hook (composition rule: `'pipeline'`): ordered value transform.
 * Each subscriber receives the value produced by the previous one (or the
 * initial value for the first subscriber) and returns the next value.
 */
export type PipelineHook<Value, Args> = (value: Value, args: Args, ctx: HookContext) => Value | Promise<Value>;

/**
 * First-wins hook (composition rule: `'first-wins'`): the first subscriber to
 * return a non-`undefined` value decides; later subscribers are short-circuited.
 * Returning `undefined` abstains from the decision.
 */
export type FirstWinsHook<Result, Args> = (
  args: Args,
  ctx: HookContext,
) => Result | undefined | Promise<Result | undefined>;

/**
 * All-run hook (composition rule: `'all-run'`): every subscriber contributes a
 * value (or a Promise of one); the registry merges contributions via the
 * hook's reducer.
 */
export type AllRunHook<Contribution, Args> = (args: Args, ctx: HookContext) => Contribution | Promise<Contribution>;

/**
 * Internal metadata describing a declared hook. The reducer is required for
 * `'all-run'` hooks — it folds per-subscriber contributions into a single
 * aggregated value.
 */
export interface HookDefinition {
  name: string;
  rule: CompositionRule;
  reducer?: (acc: unknown, next: unknown) => unknown;
}

/**
 * Hook registry — the engine's typed entry point for invoking workflow-provided
 * hooks. This is the INTERFACE only; the concrete implementation ships in a
 * later task.
 *
 * Each `invoke*` method is generic over `keyof WorkflowHooks` so callers are
 * restricted to declared hook names once concrete hooks are added via
 * declaration merging.
 */
export interface HookRegistry {
  register(hooks: WorkflowHooks): void;
  invokeObserve<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<void>;
  invokePipeline<K extends keyof WorkflowHooks>(
    name: K,
    initialValue: unknown,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown>;
  invokeFirstWins<K extends keyof WorkflowHooks>(
    name: K,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown | undefined>;
  invokeAllRun<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<unknown>;
  hasSubscribers(name: string): boolean;
  /** Return a NEW registry that shares NO mutable state with this instance. The clone inherits a shallow copy of the internal hooks map (each hook entry gets its own subscriber array; subscriber function refs are shared). */
  clone(): HookRegistry;
}

/** Registry of workflow-provided hooks. Grows incrementally — each hook-adding task extends this via declaration merging. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional declaration-merged base; fields are added in subsequent `export interface WorkflowHooks` blocks below.
export interface WorkflowHooks {}

// ── Step-level argument types ──────────────────────────────────────────────

export interface BeforeSessionPromptArgs {
  task: Task;
  step: StepDefinition;
  prompt: string;
  cwd: string;
  worktreeCwd?: string;
}

export interface CollectContextArgs {
  task: Task;
  step: StepDefinition;
  cwd: string;
  worktreeCwd?: string;
}

/** A labeled block of context text to prepend/append to the prompt. */
export interface ContextBlock {
  label: string;
  content: string;
}

// ── Lane / failure isolation argument types ────────────────────────────────

export interface OnLaneErrorArgs {
  laneId: string;
  task: Task;
  error: string;
  phaseId: string;
}

export interface ShouldIsolateArgs {
  task: Task;
  error: string;
  laneId: string;
}

// ── Workflow-level argument types ──────────────────────────────────────────

export interface OnWorkflowResumeArgs {
  workDir: string;
  /** Tracker instance — typed as unknown to avoid circular imports; the workflow casts. */
  tracker: unknown;
}

export interface OnWorkflowAbortArgs {
  reason: string;
  workDir: string;
}

export interface OnPersistArgs {
  workDir: string;
}

export interface OnRestoreArgs {
  workDir: string;
}

export interface BeforeRunMergeArgs {
  worktree?: WorktreeInfo;
  repoRoot: string;
  mainBranch: string;
}

export interface RunMergeDecision {
  proceed: boolean;
  strategy?: 'squash' | 'merge' | 'rebase';
}

export interface OnRunMergeConflictArgs {
  conflicts: string[];
  worktreePath: string;
  repoRoot: string;
}

export interface ConflictResolution {
  strategy: 'agent' | 'manual' | 'abort';
  resolvedFiles?: string[];
}

// ── Observe hook argument types ────────────────────────────────────────────

/**
 * Arguments passed to the `onStructuredOutput` observe hook.
 *
 * Fired after an agent produces structured output (e.g. parsed JSON result).
 * The default implementation appends an entry to the AuditLog.
 *
 * This is an OBSERVE hook (fire-and-forget fan-out). It is independent of
 * the `StatusCallbacks.onDecision` event-store event — both fire separately
 * into different sinks (audit log vs. event store).
 *
 * @field runnerRole — Identifies the runner/profile that produced the output
 *   (e.g. 'coder', 'reviewer', 'planner'). Matches the session model's role
 *   concept.
 * @field attempt — Which attempt number this output was produced on
 *   (0-indexed). Matches the session model's attempt counter.
 */
export interface OnStructuredOutputArgs {
  agentId: string;
  output: unknown;
  taskId?: string;
  phaseId?: string;
  runnerRole?: string;
  attempt?: number;
}

/**
 * Arguments passed to the `onDecision` observe hook.
 *
 * Fired when a decision is made (e.g. review rejection, retry, escalation).
 * The default implementation appends an entry to the AuditLog.
 *
 * This is an OBSERVE hook (fire-and-forget fan-out). It is independent of
 * the `StatusCallbacks.onDecision` event-store event — both fire separately
 * into different sinks (audit log vs. event store). The
 * `StatusCallbacks.onDecision` callback fires a `decision` event into the
 * event store for downstream consumers; the hook-level `onDecision` fires
 * into the audit log (a separate persistence sink). This distinction avoids
 * conflating event-sourcing with audit logging.
 */
export interface OnDecisionArgs {
  agentId: string;
  decision: string;
  reasoning: string;
  taskId?: string;
  phaseId?: string;
}

// ── Phase / task level argument types ──────────────────────────────────────

export interface BeforePhaseArgs {
  phaseId: string;
  state: Record<string, unknown>;
}

export interface BeforePhaseResult {
  skip?: boolean;
  statePatch?: Record<string, unknown>;
}

export interface AfterPhaseArgs {
  phaseId: string;
  result: unknown;
  durationMs: number;
}

export interface BeforePhaseTransitionArgs {
  from: string;
  to: string;
  state: Record<string, unknown>;
}

export interface PhaseTransition {
  type: 'advance' | 'loop' | 'jump';
  target?: string;
}

export interface ShouldRetryPhaseArgs {
  phaseId: string;
  result: unknown;
  round: number;
  state: Record<string, unknown>;
}

export interface OnPhaseSettledArgs {
  phaseId: string;
  tasks: Task[];
  state: Record<string, unknown>;
}

export interface BeforeTaskArgs {
  task: Task;
  steps: StepDefinition[];
}

export interface BeforeTaskResult {
  skip?: boolean;
  runner?: Runner;
  steps?: StepDefinition[];
  files?: string[];
  reason?: string;
}

// ── Step level (pipeline + all-run) ────────────────────────────────────────

export interface WorkflowHooks {
  /** Pipeline hook: transforms the step prompt before it is sent to the agent. Each subscriber receives the current prompt string and returns a transformed one. Default = collectContext (file inlining). */
  beforeSessionPrompt?: PipelineHook<string, BeforeSessionPromptArgs> | PipelineHook<string, BeforeSessionPromptArgs>[];
  /** All-run hook: collects context blocks (file contents, diffs) for a step. Results are concatenated by CONTEXT_BLOCK_REDUCER. Default = read task.files and inline their contents. */
  collectContext?: AllRunHook<ContextBlock, CollectContextArgs> | AllRunHook<ContextBlock, CollectContextArgs>[];
}

// ── Lane / failure isolation hooks ─────────────────────────────────────────

export interface WorkflowHooks {
  onLaneError?: ObserveHook<OnLaneErrorArgs> | ObserveHook<OnLaneErrorArgs>[];
  shouldIsolate?:
    | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>
    | FirstWinsHook<boolean | undefined, ShouldIsolateArgs>[];
}

// ── Workflow level (observe + pipeline + first-wins) ───────────────────────

export interface WorkflowHooks {
  /** Observe hook: fired when a persisted workflow is being resumed. */
  onWorkflowResume?: ObserveHook<OnWorkflowResumeArgs> | ObserveHook<OnWorkflowResumeArgs>[];
  /** Observe hook: fired when a workflow is aborted (hard stop). */
  onWorkflowAbort?: ObserveHook<OnWorkflowAbortArgs> | ObserveHook<OnWorkflowAbortArgs>[];
  /** Pipeline hook: transforms the workflow state before it is persisted. Default = tracker.save(). */
  onPersist?: PipelineHook<WorkflowState, OnPersistArgs> | PipelineHook<WorkflowState, OnPersistArgs>[];
  /** Pipeline hook: transforms the restored workflow state before it is used. Default = WorkflowStatusTracker.load(). */
  onRestore?: PipelineHook<WorkflowState, OnRestoreArgs> | PipelineHook<WorkflowState, OnRestoreArgs>[];
  /** First-wins hook: decides whether/how to merge before a run. Default = { proceed: true, strategy: 'squash' }. */
  beforeRunMerge?:
    | FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>
    | FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs>[];
  /** First-wins hook: decides how to resolve a merge conflict. Default = { strategy: 'agent' }. */
  onRunMergeConflict?:
    | FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>
    | FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs>[];
}

// ── Observe hooks (fire-and-forget fan-out) ────────────────────────────────

export interface WorkflowHooks {
  /**
   * Observe hook: fired after an agent produces structured output.
   * Default = append to audit log.
   *
   * This is an OBSERVE hook (fire-and-forget fan-out) — not an influence hook.
   * It fires into the audit log, which is a separate sink from the event-store
   * `decision` event emitted by `StatusCallbacks.onDecision`.
   */
  onStructuredOutput?: ObserveHook<OnStructuredOutputArgs> | ObserveHook<OnStructuredOutputArgs>[];

  /**
   * Observe hook: fired when a decision is made (review rejection, retry,
   * escalation, etc.). Default = append to audit log.
   *
   * This is an OBSERVE hook (fire-and-forget fan-out) — not an influence hook.
   * It fires into the audit log, which is a separate sink from the event-store
   * `decision` event emitted by `StatusCallbacks.onDecision`. Both fire
   * independently: `StatusCallbacks.onDecision` writes to the event store for
   * downstream consumers, while the hook-level `onDecision` writes to the
   * audit log (a separate persistence sink). Do NOT conflate the two — they
   * serve different purposes and have different consumers.
   */
  onDecision?: ObserveHook<OnDecisionArgs> | ObserveHook<OnDecisionArgs>[];
}

// ── Phase level (influence) hooks ──────────────────────────────────────────

export interface WorkflowHooks {
  /** First-wins hook: decides whether to skip the phase and/or patch the shared workflow state. Returning `undefined` abstains (the phase runs normally). */
  beforePhase?:
    | FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs>
    | FirstWinsHook<BeforePhaseResult | undefined, BeforePhaseArgs>[];
  /** Observe hook: fired after a phase completes (phaseId, result, durationMs). One-way fan-out — no return value is collected. */
  afterPhase?: ObserveHook<AfterPhaseArgs> | ObserveHook<AfterPhaseArgs>[];
  /** First-wins hook: decides the phase transition (advance / loop / jump). Returning `undefined` abstains (the default transition proceeds). */
  beforePhaseTransition?:
    | FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs>
    | FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs>[];
  /** First-wins hook: decides whether to retry the phase (bounded by `PhaseRunnerOptions.maxRounds`, default 3). Returning `undefined` abstains. */
  shouldRetryPhase?:
    | FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs>
    | FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs>[];
  /** All-run hook: fired once a phase's tasks have settled (every task reached a terminal state). Every subscriber contributes. */
  onPhaseSettled?: AllRunHook<unknown, OnPhaseSettledArgs> | AllRunHook<unknown, OnPhaseSettledArgs>[];
}

// ── Task level (influence) hooks ───────────────────────────────────────────

export interface WorkflowHooks {
  /** First-wins hook: decides whether to skip a task and/or override its steps / files. Returning `undefined` abstains (the task runs normally). */
  beforeTask?:
    | FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs>
    | FirstWinsHook<BeforeTaskResult | undefined, BeforeTaskArgs>[];
}

// ── Scheduler / execution level argument types ─────────────────────────────

export interface ClaimPolicyArgs {
  tracker: unknown;
  laneId: string;
  maxClaim: number;
}

export interface ConcurrencyKeyArgs {
  task: Task;
}

export interface WakeStrategyArgs {
  laneId: string;
  reason: 'task-ready' | 'task-settled' | 'timeout' | 'abort';
}

export interface OnLaneIdleArgs {
  laneId: string;
  consecutiveTimeouts: number;
}

export interface OnLaneStallArgs {
  laneId: string;
  consecutiveTimeouts: number;
  threshold: number;
}

// ── Scheduler / execution level hooks ──────────────────────────────────────

export interface WorkflowHooks {
  /**
   * First-wins hook: decides how many / which tasks to claim from the queue.
   * Returning a non-empty `Task[]` selects tasks to claim; returning `undefined`
   * (or an empty array) abstains and lets the default scheduler decide. NOTE:
   * exactly ONE task is claimed per invocation (the first array element);
   * `maxClaim` is advisory and batch claiming is not yet supported (extras are
   * ignored with a warning). Enables priority queueing and affinity scheduling.
   */
  claimPolicy?:
    | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>
    | FirstWinsHook<Task[] | undefined, ClaimPolicyArgs>[];

  /**
   * First-wins hook: returns a concurrency key string for a task. Tasks
   * sharing the same key run serially (one at a time per lane). Returning
   * `undefined` means "no concurrency limit" (default). Use this to
   * rate-limit work on a per-resource or per-dimension basis.
   *
   * IMPORTANT: This hook controls only task EXECUTION concurrency. It must
   * NOT parallelize task-branch merges into the shared main worktree branch.
   * Merges remain serialized via the WorktreeManager git lock to maintain a
   * linear history.
   */
  concurrencyKey?:
    | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>
    | FirstWinsHook<string | undefined, ConcurrencyKeyArgs>[];

  /**
   * Observe hook: fired when the scheduler decides to wake a lane (i.e.,
   * begin processing tasks). The `reason` indicates what triggered the wake.
   * Useful for telemetry and adaptive scheduling strategies.
   */
  wakeStrategy?: ObserveHook<WakeStrategyArgs> | ObserveHook<WakeStrategyArgs>[];

  /**
   * Observe hook: fired when a lane enters an idle state (no tasks to claim
   * and the consecutive timeout count exceeds a threshold). Useful for
   * scaling down lane resources or triggering diagnostics.
   */
  onLaneIdle?: ObserveHook<OnLaneIdleArgs> | ObserveHook<OnLaneIdleArgs>[];

  /**
   * Observe hook: fired when a lane is considered stalled (consecutive
   * timeouts exceed the given threshold). Useful for crash recovery and
   * escalation logic.
   */
  onLaneStall?: ObserveHook<OnLaneStallArgs> | ObserveHook<OnLaneStallArgs>[];
}

// ── Worktree lifecycle argument types ─────────────────────────────────────

export interface BeforeTaskWorktreeArgs {
  task: Task;
  /** WorktreeManager instance — typed as unknown to avoid circular imports; the workflow casts. */
  worktreeManager: unknown;
}

export interface BeforeTaskWorktreeResult {
  skip?: boolean;
  baseBranch?: string;
  extraFiles?: string[];
}

export interface AfterTaskWorktreeArgs {
  task: Task;
  worktreePath: string;
  branch: string;
}

export interface PopulateWorktreeArgs {
  worktreePath: string;
  sourceCwd: string;
  task?: Task;
}

export interface OnTaskMergeArgs {
  task: Task;
  worktreePath: string;
  branch: string;
}

export interface TaskMergeDecision {
  proceed: boolean;
  strategy?: 'squash' | 'merge';
}

export interface OnMergeConflictArgs {
  task: Task;
  conflicts: string[];
  worktreePath: string;
  mainBranch: string;
}

export interface OnCommitFailureArgs {
  task: Task;
  errors: string[];
  worktreePath: string;
}

export interface CommitFailureResolution {
  strategy: 'agent' | 'skip' | 'fail';
  resolvedFiles?: string[];
}

// ── Worktree lifecycle hooks ───────────────────────────────────────────────

export interface WorkflowHooks {
  /** First-wins hook: decides whether to skip worktree creation and/or override the base branch / extra files. Returning `undefined` abstains (the worktree is created normally). */
  beforeTaskWorktreeCreate?:
    | FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>
    | FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>[];

  /** Observe hook: fired after a task worktree is created. One-way fan-out — no return value is collected. */
  afterTaskWorktreeCreate?: ObserveHook<AfterTaskWorktreeArgs> | ObserveHook<AfterTaskWorktreeArgs>[];

  /** Pipeline hook: populates the worktree (e.g. copying files, checking out branches). Each subscriber receives `void` and can perform side effects. */
  populateWorktree?: PipelineHook<void, PopulateWorktreeArgs> | PipelineHook<void, PopulateWorktreeArgs>[];

  /** First-wins hook: decides whether/how to merge a task branch. Returning `undefined` abstains (default = { proceed: true, strategy: 'squash' }). */
  onTaskMerge?:
    | FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>
    | FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>[];

  /** First-wins hook: decides how to resolve a merge conflict in a task worktree. Returning `undefined` abstains (default = { strategy: 'agent' }). */
  onMergeConflict?:
    | FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>
    | FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>[];

  /** First-wins hook: decides how to handle a commit failure (e.g. lint errors, hook rejection). Returning `undefined` abstains (default = { strategy: 'fail' }). */
  onCommitFailure?:
    | FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>
    | FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>[];
}

/**
 * What `WorkflowModule.hooks` accepts: either a single hooks object or a list
 * of them (registered in array order).
 */
export type HookProvider = WorkflowHooks | WorkflowHooks[];
