// types.ts and registry.ts BOTH export `HookRegistry` (types.ts as an interface,
// registry.ts as a class). To avoid the TS2308 ambiguity error we re-export
// with explicit names from each.
export * from './compose.js';
export { HOOK_DECLARATIONS, getHookDeclaration } from './declarations.js';
export type { HookDeclaration } from './declarations.js';
export * from './defaults/index.js';
export * from './reducers.js';
export { HookRegistry, createHookRegistry } from './registry.js';
export type {
  AfterPhaseArgs,
  AfterTaskWorktreeArgs,
  // ── Hook mechanism shapes ──
  AllRunHook,
  // ── Phase-level argument / result types ──
  BeforePhaseArgs,
  BeforePhaseResult,
  BeforePhaseTransitionArgs,
  BeforeRunMergeArgs,
  // ── Step-level argument / result types ──
  BeforeSessionPromptArgs,
  // ── Task-level argument / result types ──
  BeforeTaskArgs,
  BeforeTaskResult,
  // ── Worktree-lifecycle argument / result types ──
  BeforeTaskWorktreeArgs,
  BeforeTaskWorktreeResult,
  CollectContextArgs,
  CommitFailureResolution,
  CompositionRule,
  ConflictResolution,
  ContextBlock,
  FirstWinsHook,
  HookContext,
  HookDefinition,
  HookProvider,
  ObserveHook,
  OnCommitFailureArgs,
  OnDecisionArgs,
  OnMergeConflictArgs,
  OnPersistArgs,
  OnPhaseSettledArgs,
  OnRestoreArgs,
  OnRunMergeConflictArgs,
  // ── Observe hook argument types ──
  OnStructuredOutputArgs,
  OnTaskMergeArgs,
  OnWorkflowAbortArgs,
  // ── Workflow-level argument / result types ──
  OnWorkflowResumeArgs,
  PhaseTransition,
  PipelineHook,
  PopulateWorktreeArgs,
  RunMergeDecision,
  ShouldRetryPhaseArgs,
  TaskMergeDecision,
  WorkflowHooks,
} from './types.js';
