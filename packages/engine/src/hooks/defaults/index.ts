/** Barrel for default hook implementations. Each defaults-*.ts file adds its export here. */
export { createDefaultAuditor } from './auditor.js';
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
