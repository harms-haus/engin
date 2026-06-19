/** Barrel for default hook implementations. Each defaults-*.ts file adds its export here. */
export { createDefaultAuditor } from './auditor.js';
// `defaultOnLaneError` and `defaultShouldIsolate` live in pool/fix-loop.ts
// (tightly coupled to the fixLoop primitive) rather than a dedicated
// defaults-*.ts file. Re-exported here so the engine's default-hook
// composition can wire them in alongside the other defaults.
export { defaultOnLaneError, defaultShouldIsolate } from '../../pool/fix-loop.js';
export {
  createDefaultAfterPhase,
  defaultBeforePhaseTransition,
  defaultOnPhaseSettled,
  defaultShouldRetryPhase,
} from './phase.js';
export { defaultBeforeStepPrompt, defaultCollectContext } from './prompt-context.js';
export {
  createDefaultOnPersist,
  createDefaultOnRestore,
  createDefaultOnRunMergeConflict,
  defaultBeforeRunMerge,
  defaultOnWorkflowAbort,
  defaultOnWorkflowResume,
} from './workflow.js';
export {
  createDefaultBeforeTaskWorktreeCreate,
  createDefaultOnCommitFailure,
  createDefaultOnMergeConflict,
  createDefaultPopulateWorktree,
  defaultAfterTaskWorktreeCreate,
  defaultOnTaskMerge,
} from './worktree.js';
