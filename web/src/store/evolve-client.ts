// Re-exported from the engine to eliminate duplication.
// The evolve function is pure (only imports types, no runtime deps) so it works in the browser.
export { MAX_AGENT_LOG, evolve as evolveClient } from '@engin/tracking/evolve';
