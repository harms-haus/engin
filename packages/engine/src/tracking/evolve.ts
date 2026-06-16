// Backward-compat shim. The canonical home for `evolve` is now
// packages/shared/src/evolve.ts, consumed via the bare specifier
// `@engin/shared/evolve`. This file re-exports the two public exports so that
// all existing consumers (src/index.ts barrel, web/src/store/evolve-client.ts,
// tests/tracking/evolve.test.ts) keep working unchanged.
export { MAX_AGENT_LOG, evolve } from '@engin/shared/evolve';
