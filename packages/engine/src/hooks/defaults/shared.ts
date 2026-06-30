// ─── Shared helpers used by multiple hook-defaults modules ──────────────────
//
// Internal utilities that are reused across `hooks/defaults/worktree.ts` and
// `hooks/defaults/workflow.ts` live here so neither file depends on the other
// (both depend on this shared module instead).

import type { HookContext } from '../types.js';

/**
 * Shared core for the three agent-strategy default hooks:
 * {@link createDefaultOnMergeConflict}, {@link createDefaultOnCommitFailure},
 * and {@link createDefaultOnRunMergeConflict}. Each of those factories accepts
 * `(profilesDirs, apiKeys?)` for public-API / future-override alignment, but
 * the pure delegation marker they return does not use those parameters. This
 * helper holds the actual shared body and omits the dead parameters.
 *
 * Returns a first-wins hook that resolves the PURE DELEGATION MARKER
 * `{ strategy: 'agent' }` — signaling only the strategy. It does NOT read
 * conflict files, spawn a fix-up session, or populate `resolvedFiles`. The
 * actual resolution is composed downstream by the caller (e.g.
 * `WorktreeManager`), which consumes the marker and invokes the tooled agent.
 *
 * Pointing the (downstream) profiles / paths at non-existent locations must
 * NOT throw — this helper never touches the filesystem.
 */
export function createAgentStrategyHook(): (args: unknown, ctx: HookContext) => Promise<{ strategy: 'agent' }> {
  return async () => ({ strategy: 'agent' });
}
