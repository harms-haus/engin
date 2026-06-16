// Re-exported from the engine to eliminate duplication.
// The evolve function is pure (only imports types, no runtime deps) so it works in the browser.
export { MAX_RUN_LOG } from '@engin/shared/event-types';
export { MAX_AGENT_LOG, evolve as evolveClient } from '@engin/shared/evolve';
