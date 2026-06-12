/**
 * Tests verifying that MultiAgentOptions.schema (typed as ZodType<unknown>)
 * correctly accepts various Zod schema types and that parallelAgents /
 * sequentialAgents compile and function properly with them.
 *
 * These tests guard against regressions when changing MultiAgentOptions.schema
 * from ZodType<any> to ZodType<unknown> (or ZodType<never>).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z, type ZodType } from 'zod';
import type { HarnessCreationOptions, WorkflowRunOptions, WorkflowState, WorktreeInfo } from '../../src/core/types.ts';
import { makeMockSession } from '../helpers/make-session.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import('../../src/core/harness-factory.ts'));
const realStructuredOutput = Object.assign({}, await import('../../src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { parallelAgents, sequentialAgents, type MultiAgentOptions } from '../../src/core/agent-loop.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<HarnessCreationOptions>): HarnessCreationOptions {
  return {
    profile: {
      id: 'test-agent',
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      thinkingLevel: 'medium',
      systemPrompt: 'You are a test agent.',
      excludeTools: [],
      includeTools: [],
    },
    cwd: '/tmp',
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── MultiAgentOptions type compatibility ───────────────────────────────────

describe('MultiAgentOptions.schema type compatibility', () => {
  it('accepts a ZodObject schema', async () => {
    const schema = z.object({ name: z.string(), value: z.number() });
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue({ name: 'test', value: 42 });

    const results = await parallelAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });

  it('accepts a ZodString schema', async () => {
    const schema = z.string();
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue('a string result');

    const results = await sequentialAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });

  it('accepts a ZodNumber schema', async () => {
    const schema = z.number();
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue(99);

    const results = await parallelAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
  });

  it('accepts a ZodArray schema', async () => {
    const schema = z.array(z.string());
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue(['a', 'b', 'c']);

    const results = await sequentialAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });

  it('accepts a ZodUnion schema', async () => {
    const schema = z.union([z.string(), z.number()]);
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue('union result');

    const results = await parallelAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
  });

  it('accepts a ZodEnum schema', async () => {
    const schema = z.enum(['red', 'green', 'blue']);
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue('green');

    const results = await sequentialAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });

  it('accepts a ZodRecord schema', async () => {
    const schema = z.record(z.string(), z.number());
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue({ a: 1, b: 2 });

    const results = await parallelAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
  });

  it('accepts a complex nested schema', async () => {
    const schema = z.object({
      users: z.array(
        z.object({
          name: z.string(),
          age: z.number(),
          tags: z.array(z.string()).optional(),
        }),
      ),
      meta: z.record(z.string(), z.unknown()),
    });
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue({
      users: [{ name: 'Alice', age: 30 }],
      meta: {},
    });

    const results = await sequentialAgents([makeConfig()], () => 'prompt', { schema });

    expect(results).toHaveLength(1);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
  });
});

// ─── parallelAgents with schema ─────────────────────────────────────────────

describe('parallelAgents with schema through MultiAgentOptions', () => {
  it('passes schema to promptForStructured for each session', async () => {
    const schema = z.object({ answer: z.boolean() });
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue({ answer: true });

    const results = await parallelAgents([makeConfig(), makeConfig(), makeConfig()], () => 'is it true?', { schema });

    expect(results).toHaveLength(3);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
  });

  it('passes schema with maxRetries to promptForStructured', async () => {
    const schema = z.string();
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue('result');

    await parallelAgents([makeConfig()], () => 'prompt', { schema, maxRetries: 7 });

    expect(mockPromptForStructured).toHaveBeenCalledWith(expect.anything(), 'prompt', schema, { maxRetries: 7 });
  });

  it('works without schema (returns plain text)', async () => {
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'plain text'));

    const results = await parallelAgents(
      [makeConfig()],
      () => 'prompt',
      {}, // no schema
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') {
      expect(results[0].value).toBe('plain text');
    }
    expect(mockPromptForStructured).not.toHaveBeenCalled();
  });
});

// ─── sequentialAgents with schema ───────────────────────────────────────────

describe('sequentialAgents with schema through MultiAgentOptions', () => {
  it('passes schema to promptForStructured for each session', async () => {
    const schema = z.object({ score: z.number() });
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValueOnce({ score: 85 }).mockResolvedValueOnce({ score: 92 });

    const results = await sequentialAgents([makeConfig(), makeConfig()], () => 'rate it', { schema });

    expect(results).toHaveLength(2);
    expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
  });

  it('passes schema with maxRetries to promptForStructured', async () => {
    const schema = z.number();
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue(42);

    await sequentialAgents([makeConfig()], () => 'prompt', { schema, maxRetries: 5 });

    expect(mockPromptForStructured).toHaveBeenCalledWith(expect.anything(), 'prompt', schema, { maxRetries: 5 });
  });

  it('works without schema (returns plain text)', async () => {
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'plain result'));

    const results = await sequentialAgents(
      [makeConfig()],
      () => 'prompt',
      {}, // no schema
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toBe('plain result');
    expect(mockPromptForStructured).not.toHaveBeenCalled();
  });
});

// ─── MultiAgentOptions object construction ──────────────────────────────────

describe('MultiAgentOptions can be constructed with various schema types', () => {
  it('constructs with ZodObject schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.object({ x: z.number() }),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodString schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.string(),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodNumber schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.number(),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodArray schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.array(z.boolean()),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodUnion schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.union([z.string(), z.number()]),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodTuple schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.tuple([z.string(), z.number()]),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodRecord schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.record(z.string(), z.number()),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodLazy schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.lazy(() => z.object({ name: z.string() })),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs with ZodEffects (refined) schema', () => {
    const opts: MultiAgentOptions = {
      schema: z.string().min(1).max(100),
    };
    expect(opts.schema).toBeDefined();
  });

  it('constructs without a schema', () => {
    const opts: MultiAgentOptions = {
      maxRetries: 3,
      agentIdPrefix: 'agent',
    };
    expect(opts.schema).toBeUndefined();
  });

  it('constructs with all fields', () => {
    const opts: MultiAgentOptions = {
      schema: z.object({ result: z.string() }),
      maxRetries: 5,
      agentIdPrefix: 'worker',
    };
    expect(opts.schema).toBeDefined();
    expect(opts.maxRetries).toBe(5);
    expect(opts.agentIdPrefix).toBe('worker');
  });

  it('constructs with a pre-typed ZodType<unknown> variable', () => {
    // This specifically tests that a variable typed as ZodType<unknown>
    // can be assigned to MultiAgentOptions.schema — the exact scenario
    // when the interface field changes from ZodType<any> to ZodType<unknown>.
    const schema: ZodType<unknown> = z.object({ value: z.number() });
    const opts: MultiAgentOptions = { schema };
    expect(opts.schema).toBeDefined();
  });
});

// ─── combined schema + agentIdPrefix ────────────────────────────────────────

describe('parallelAgents with schema and agentIdPrefix together', () => {
  it('applies both schema validation and agent ID prefix', async () => {
    const schema = z.object({ status: z.string() });
    const configs = [makeConfig(), makeConfig()];
    mockCreateHarness.mockImplementation(async (_cfg: HarnessCreationOptions) => ({
      ...makeMockSession(() => 'ok'),
      dispose: mock(() => {}),
    }));
    mockPromptForStructured.mockResolvedValue({ status: 'done' });

    await parallelAgents(configs, () => 'check status', {
      schema,
      agentIdPrefix: 'checker',
    });

    // Verify agentIdPrefix was applied
    const calls = mockCreateHarness.mock.calls;
    expect(calls[0][0]).toMatchObject({ agentId: 'checker-0' });
    expect(calls[1][0]).toMatchObject({ agentId: 'checker-1' });

    // Verify schema was used
    expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
  });
});

describe('sequentialAgents with schema and agentIdPrefix together', () => {
  it('applies both schema validation and agent ID prefix', async () => {
    const schema = z.object({ result: z.string() });
    const configs = [makeConfig(), makeConfig()];
    mockCreateHarness.mockImplementation(async () => makeMockSession(() => 'ok'));
    mockPromptForStructured.mockResolvedValue({ result: 'success' });

    await sequentialAgents(configs, () => 'get result', {
      schema,
      agentIdPrefix: 'seq',
    });

    // Verify agentIdPrefix was applied
    const calls = mockCreateHarness.mock.calls;
    expect(calls[0][0]).toMatchObject({ agentId: 'seq-0' });
    expect(calls[1][0]).toMatchObject({ agentId: 'seq-1' });

    // Verify schema was used
    expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
  });
});

// ─── WorktreeInfo type tests ────────────────────────────────────────────────

describe('WorktreeInfo', () => {
  it('can be constructed with all required fields', () => {
    const info: WorktreeInfo = {
      worktreePath: '/repo/.git-trees/abc123',
      branchName: 'feature-branch',
      originalCwd: '/home/user/project',
    };
    expect(info.worktreePath).toBe('/repo/.git-trees/abc123');
    expect(info.branchName).toBe('feature-branch');
    expect(info.originalCwd).toBe('/home/user/project');
  });

  it('has exactly three fields: worktreePath, branchName, originalCwd', () => {
    const info: WorktreeInfo = {
      worktreePath: '/path/to/worktree',
      branchName: 'main',
      originalCwd: '/path/to/original',
    };
    const keys = Object.keys(info);
    expect(keys).toHaveLength(3);
    expect(keys).toContain('worktreePath');
    expect(keys).toContain('branchName');
    expect(keys).toContain('originalCwd');
  });

  it('worktreePath is a string', () => {
    const info: WorktreeInfo = {
      worktreePath: '/some/path',
      branchName: 'branch',
      originalCwd: '/cwd',
    };
    expect(typeof info.worktreePath).toBe('string');
  });

  it('branchName is a string', () => {
    const info: WorktreeInfo = {
      worktreePath: '/some/path',
      branchName: 'branch',
      originalCwd: '/cwd',
    };
    expect(typeof info.branchName).toBe('string');
  });

  it('originalCwd is a string', () => {
    const info: WorktreeInfo = {
      worktreePath: '/some/path',
      branchName: 'branch',
      originalCwd: '/cwd',
    };
    expect(typeof info.originalCwd).toBe('string');
  });
});

// ─── WorkflowState.worktree field tests ──────────────────────────────────────

describe('WorkflowState with worktree', () => {
  it('accepts a worktree field of type WorktreeInfo', () => {
    const state: WorkflowState = {
      taskPrompt: 'do something',
      currentPhase: 'scouting',
      completedPhases: [],
      tasks: [],
      scoutingReports: [],
      plan: null,
      stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
      worktree: {
        worktreePath: '/repo/.worktrees/feature',
        branchName: 'feature-x',
        originalCwd: '/home/user/project',
      },
    };
    expect(state.worktree).toBeDefined();
    expect(state.worktree?.worktreePath).toBe('/repo/.worktrees/feature');
    expect(state.worktree?.branchName).toBe('feature-x');
    expect(state.worktree?.originalCwd).toBe('/home/user/project');
  });

  it('allows worktree to be undefined (optional)', () => {
    const state: WorkflowState = {
      taskPrompt: 'do something',
      currentPhase: 'scouting',
      completedPhases: [],
      tasks: [],
      scoutingReports: [],
      plan: null,
      stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
    };
    expect(state.worktree).toBeUndefined();
  });

  it('worktree can be set alongside other optional fields like spawnedAgents and sidebar', () => {
    const state: WorkflowState = {
      taskPrompt: 'complex task',
      currentPhase: 'implementing',
      completedPhases: ['scouting', 'planning'],
      tasks: [],
      scoutingReports: [{}],
      plan: {},
      stats: { totalTokens: 500, totalCost: 0.05, agentCount: 2 },
      spawnedAgents: [{ agentId: 'a1', profile: 'dev', phase: 'impl', taskId: 't1' }],
      sidebar: { title: 'Test', phases: [] },
      worktree: {
        worktreePath: '/worktree/path',
        branchName: 'my-branch',
        originalCwd: '/original/cwd',
      },
    };
    expect(state.worktree?.branchName).toBe('my-branch');
    expect(state.spawnedAgents).toHaveLength(1);
    expect(state.sidebar?.title).toBe('Test');
  });
});

// ─── WorkflowRunOptions.worktree field tests ────────────────────────────────

describe('WorkflowRunOptions with worktree', () => {
  it('accepts a worktree field of type WorktreeInfo', () => {
    const options: WorkflowRunOptions = {
      cwd: '/home/user/project',
      workDir: '/home/user/.engin/workdirs/run-1',
      worktree: {
        worktreePath: '/repo/.worktrees/run-1',
        branchName: 'engin-run-1',
        originalCwd: '/home/user/project',
      },
    };
    expect(options.worktree).toBeDefined();
    expect(options.worktree?.worktreePath).toBe('/repo/.worktrees/run-1');
    expect(options.worktree?.branchName).toBe('engin-run-1');
    expect(options.worktree?.originalCwd).toBe('/home/user/project');
  });

  it('allows worktree to be undefined (optional)', () => {
    const options: WorkflowRunOptions = {
      cwd: '/home/user/project',
      workDir: '/home/user/.engin/workdirs/run-1',
    };
    expect(options.worktree).toBeUndefined();
  });

  it('worktree can be set alongside other optional fields like maxConcurrentTasks and verbose', () => {
    const options: WorkflowRunOptions = {
      cwd: '/home/user/project',
      workDir: '/home/user/.engin/workdirs/run-1',
      maxConcurrentTasks: 4,
      verbose: true,
      worktree: {
        worktreePath: '/worktree',
        branchName: 'branch',
        originalCwd: '/cwd',
      },
    };
    expect(options.worktree?.branchName).toBe('branch');
    expect(options.maxConcurrentTasks).toBe(4);
    expect(options.verbose).toBe(true);
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
