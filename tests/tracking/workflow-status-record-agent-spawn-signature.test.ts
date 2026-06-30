import { beforeEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

/**
 * Source-inspection path for WorkflowStatusTracker#recordAgentSpawn.
 *
 * `import.meta.dir` resolves to <repo>/tests/tracking, so two `..` segments
 * land on the repo root before descending into the engine package.
 */
const SOURCE_PATH = join(import.meta.dir, '..', '..', 'packages', 'engine', 'src', 'tracking', 'workflow-status.ts');

async function readSource(): Promise<string> {
  return readFile(SOURCE_PATH, 'utf-8');
}

/**
 * These tests encode the TARGET shape of `recordAgentSpawn` after the
 * positional overload is removed:
 *
 *   - The engine package (`@harms-haus/engin-engine`) is `private: true`, so
 *     no code outside this repo can depend on it. A repo-wide search of
 *     `packages/engine/src` and `packages/cli/src` (plus tui/web) finds zero
 *     call sites — the only references to `recordAgentSpawn` in source are the
 *     declarations themselves. There is therefore no doubt about external
 *     positional callers, so the overload should be REMOVED (not deprecated).
 *   - The implementation body should accept only the options object.
 *
 * The structural assertions below FAIL against the current code (which still
 * carries the positional overload and a `string | object` dispatch) and pass
 * once the green team removes the overload. They follow the established
 * source-inspection pattern already used in
 * `workflow-status-agent-persistence.test.ts`.
 *
 * Assertions operate on booleans (rather than `expect(source).not.toMatch(...)`)
 * so failure messages stay small and focused instead of dumping the whole file.
 */
describe('recordAgentSpawn – object-form-only signature (positional overload removed)', () => {
  describe('source structure', () => {
    it('declares recordAgentSpawn exactly once (the object-form implementation)', async () => {
      const source = await readSource();
      // No call sites exist inside workflow-status.ts itself, so every line
      // that opens a `recordAgentSpawn(` is a declaration. After cleanup there
      // must be exactly ONE declaration — the object-form implementation.
      const declarations = source.match(/^\s*recordAgentSpawn\(/gm) ?? [];
      expect(declarations.length, 'expected exactly one recordAgentSpawn declaration').toBe(1);
    });

    it('has no positional overload signature', async () => {
      const source = await readSource();
      // The positional overload lists agentId/profile/phaseId as bare
      // positional parameters. It must be gone after cleanup.
      const hasPositionalOverload =
        /recordAgentSpawn\(\s*agentId:\s*string,\s*profile:\s*string,\s*phaseId:\s*string/s.test(source);
      expect(hasPositionalOverload, 'positional overload signature must be removed').toBe(false);
    });

    it('surviving declaration is the object-form signature', async () => {
      const source = await readSource();
      // The single remaining declaration must take an options object.
      const hasObjectForm = /recordAgentSpawn\(info:\s*\{/.test(source);
      expect(hasObjectForm, 'surviving declaration must be the object form').toBe(true);
    });

    it('does not use a union (string | object) first parameter', async () => {
      const source = await readSource();
      // The pre-refactor implementation parameter was a `string | { ... }`
      // union named `agentIdOrInfo`. After cleanup the sole parameter is the
      // options object, so neither the union nor that name should remain.
      const hasUnion = source.includes('agentIdOrInfo');
      expect(hasUnion, 'implementation must not carry a string|object union param').toBe(false);
    });

    it('does not branch on typeof === "string" inside the implementation', async () => {
      const source = await readSource();
      // The body should handle ONLY the object form — no string-vs-object
      // dispatch.
      const hasStringDispatch = /typeof\s+\w+\s*===\s*['"]string['"]/.test(source);
      expect(hasStringDispatch, 'implementation must not branch on typeof === "string"').toBe(false);
    });

    it('does not leave a deprecated positional overload behind', async () => {
      // The package is private and has no external positional callers, so the
      // correct action is removal — NOT deprecation. This guards against the
      // implementer keeping a `@deprecated` overload out of caution.
      const source = await readSource();
      const idx = source.indexOf('recordAgentSpawn(');
      expect(idx).toBeGreaterThan(-1);
      const preceding = source.slice(Math.max(0, idx - 400), idx);
      const isDeprecated = preceding.includes('@deprecated');
      expect(isDeprecated, 'overload should be removed, not marked @deprecated').toBe(false);
    });
  });

  describe('object-form behavior is preserved', () => {
    const { getDir } = useTempDir();
    let dir: string;
    let tracker: WorkflowStatusTracker;

    beforeEach(() => {
      dir = getDir();
      tracker = new WorkflowStatusTracker(dir);
    });

    it('records every field via the object form', () => {
      tracker.recordAgentSpawn({
        agentId: 'agent-1',
        profile: 'coder',
        phaseId: 'implementing',
        taskId: 'task-42',
        runnerRole: 'coder',
        attempt: 3,
      });

      const [record] = tracker.spawnedAgents;
      expect(record.agentId).toBe('agent-1');
      expect(record.profile).toBe('coder');
      expect(record.phaseId).toBe('implementing');
      expect(record.taskId).toBe('task-42');
      expect(record.runnerRole).toBe('coder');
      expect(record.attempt).toBe(3);
      expect(record.completedAt).toBeUndefined();
    });

    it('omits optional fields cleanly via the object form', () => {
      tracker.recordAgentSpawn({ agentId: 'agent-2', profile: 'reviewer', phaseId: 'planning' });

      const [record] = tracker.spawnedAgents;
      expect(record.taskId).toBeUndefined();
      expect(record.runnerRole).toBeUndefined();
      expect(record.attempt).toBeUndefined();
    });

    it('persists the object-form record through save/load', async () => {
      tracker.recordAgentSpawn({ agentId: 'agent-3', profile: 'coder', phaseId: 'scouting' });
      await tracker.save();

      const restored = await WorkflowStatusTracker.load(dir);
      expect(restored.spawnedAgents).toHaveLength(1);
      expect(restored.spawnedAgents[0].agentId).toBe('agent-3');
      expect(restored.spawnedAgents[0].phaseId).toBe('scouting');
    });
  });
});
