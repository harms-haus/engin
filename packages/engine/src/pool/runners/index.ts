// ─── Runners Barrel ────────────────────────────────────────────────────────

// SessionPlan contract types (supersede the old runner types, now removed).
export type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

// Runner factories — each returns a SessionPlanFactory.
export { branchRunner } from './branch-runner.js';
export type { BranchCondition, BranchRunnerOptions } from './branch-runner.js';
export { coalescingRunner } from './coalescing-runner.js';
export type { CoalescingRunnerOptions } from './coalescing-runner.js';
export { coordinatorRunner } from './coordinator-runner.js';
export type { CoordinatorRunnerOptions } from './coordinator-runner.js';
export { councilRunner } from './council-runner.js';
export { linearRunner } from './linear-runner.js';
export { mapRunner } from './map-runner.js';
export type { MapRunnerOptions } from './map-runner.js';
export { parallelRunner } from './parallel-runner.js';
export { reviewRunner } from './review-runner.js';
export { singleSession } from './single-session.js';

// SessionPlan execute primitive + scheduler delegate.
export { runScheduledSession } from '../run-scheduled-session.js';
export { defaultExecute } from './runner-utils.js';
