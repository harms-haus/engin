// ─── Tests for threading hookRegistry through runStepTask / runMultiStepTask ─
//
// Verifies the `beforeStepPrompt` pipeline hook integration:
//   - When `hookRegistry` is provided AND has subscribers for
//     `beforeStepPrompt`, `invokePipeline` is called with the step's prompt
//     (initial value), a `{ task, step, prompt, cwd, worktreeCwd }` args
//     object, and a context; the pipeline's RETURN value replaces the prompt
//     sent to the agent.
//   - When `hookRegistry` is absent, or has no subscribers for
//     `beforeStepPrompt`, the prompt is sent unchanged (zero behavior change).
//   - The hook args carry the worktree-resolved cwd (`effectiveCwd`) when a
//     worktree is in use.
//
// NOTE: These tests are written TDD-style against the planned `hookRegistry`
// option. To keep them compiling before the interface is updated, `hookRegistry`
// is attached to the options via a plain object (extra properties on a non-literal
// are assignable). At runtime the property is present, so the tests exercise the
// real path once the implementation reads `opts.hookRegistry`.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ZodType } from 'zod';
import { z } from 'zod';

import { createHookRegistry } from '../hooks/registry.js';
import type { HookRegistry } from '../hooks/types.js';
import type { AgentProfile } from './types.js';
import type { WorktreeManager } from './worktree-manager.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realProfile = Object.assign({}, await import('./profile.js'));
const realAgentRegistry = Object.assign({}, await import('./agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('./structured-output.js'));

// ─── Mock dependencies ───────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockRequireAgentPlugin = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// ─── Import after mocks ──────────────────────────────────────────────────

import { runMultiStepTask, runStepTask } from './phase-tasks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const coderProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

const plannerProfile: AgentProfile = { ...coderProfile, id: 'planner', name: 'Planner' };
const reviewerProfile: AgentProfile = { ...coderProfile, id: 'reviewer', name: 'Reviewer' };

function setupProfiles(profiles: AgentProfile[]) {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) map.set(p.id, p);
  mockLoadProfilesFromDirs.mockResolvedValue(map);
}

/**
 * Build a bare `AgentRuntime` stub whose `prompt(text)` pushes the received
 * text into `capture`. `spawnAgent` unwraps `sessionId`, `sessionFile`,
 * `dispose`, and `contextWindow` directly from the runtime returned by
 * `plugin.createSession`, so the stub carries `contextWindow`.
 */
function makeCapturingSession(profileId: string, capture: string[], lastText = 'assistant-output') {
  return {
    prompt: mock(async (text: string) => {
      capture.push(text);
    }),
    getLastAssistantText: mock(() => lastText),
    getLastAssistantMessage: mock(() => undefined),
    sessionId: `${profileId}-session`,
    sessionFile: undefined as string | undefined,
    contextWindow: 8000,
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
  };
}

/**
 * Build a mock HookRegistry that records `invokePipeline` / `hasSubscribers`
 * calls. `transformedPrompt` is what `invokePipeline` resolves to; `hasSubs`
 * controls whether the implementation takes the hook path.
 */
function makeMockRegistry(opts: { hasSubs?: boolean; transformedPrompt?: string } = {}) {
  const hasSubs = opts.hasSubs ?? true;
  const transformedPrompt = opts.transformedPrompt ?? 'HOOKED-PROMPT';
  // Parameters are declared so bun's Mock<T> types `.mock.calls` with the
  // real argument tuple (name, initialValue, args, ctx), letting the tests
  // index into call arguments.
  const invokePipeline = mock(
    async (_name: unknown, _initialValue: unknown, _args: unknown, _ctx: unknown) => transformedPrompt,
  );
  const hasSubscribers = mock((_name: string) => hasSubs);
  const registry = {
    register: mock(() => {}),
    invokeObserve: mock(async () => {}),
    invokePipeline,
    invokeFirstWins: mock(async () => undefined),
    invokeAllRun: mock(async () => undefined),
    hasSubscribers,
  } as unknown as HookRegistry;
  return { registry, invokePipeline, hasSubscribers };
}

/** Build a fresh registry with `beforeStepPrompt` declared as a pipeline hook. */
function makeRealRegistry() {
  const reg = createHookRegistry();
  reg.defineHook('beforeStepPrompt', 'pipeline');
  return reg;
}

/** The mock plugin whose `createSession` is wired per-test. */
let mockPlugin: { id: string; createSession: ReturnType<typeof mock> };

beforeEach(() => {
  mockLoadProfilesFromDirs.mockReset();
  mockRequireAgentPlugin.mockReset();
  mockPromptForStructured.mockReset();
  mockPlugin = { id: 'pi-coding-agent', createSession: mock() };
  mockRequireAgentPlugin.mockReturnValue(mockPlugin);
});

// ─── runStepTask ─────────────────────────────────────────────────────────

describe('runStepTask — beforeStepPrompt hook', () => {
  it('transforms the prompt via a registered beforeStepPrompt subscriber', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const reg = makeRealRegistry();
    // Subscriber prepends a marker to the incoming prompt value.
    reg.register({
      beforeStepPrompt: (value: string) => `[HOOKED] ${value}`,
    });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'scout-phase',
      taskId: 'task-1',
      title: 'Scout Task',
      stepName: 'scout',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'explore the codebase',
      hookRegistry: reg,
    };

    const result = await runStepTask<string>(opts);

    // The pipeline result replaces the prompt sent to the agent.
    expect(prompts).toEqual(['[HOOKED] explore the codebase']);
    // Result still flows from getLastAssistantText.
    expect(result).toBe('assistant-output');
  });

  it('sends the prompt unchanged when hookRegistry is omitted (zero behavior change)', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'scout-phase',
      taskId: 'task-1',
      title: 'Scout Task',
      stepName: 'scout',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'explore the codebase',
      // No hookRegistry at all.
    };

    await runStepTask(opts);

    expect(prompts).toEqual(['explore the codebase']);
  });

  it('sends the prompt unchanged when hookRegistry has no beforeStepPrompt subscribers', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const reg = makeRealRegistry();
    // Register a DIFFERENT hook, not beforeStepPrompt → hasSubscribers is false.
    reg.defineHook('collectContext', 'all-run');
    reg.register({ collectContext: () => ({ label: 'x', content: 'y' }) });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'scout-phase',
      taskId: 'task-1',
      title: 'Scout Task',
      stepName: 'scout',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'explore the codebase',
      hookRegistry: reg,
    };

    await runStepTask(opts);

    expect(prompts).toEqual(['explore the codebase']);
  });

  it('invokes invokePipeline with the documented args shape (name, initialValue, args, ctx)', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const { registry, invokePipeline, hasSubscribers } = makeMockRegistry({
      transformedPrompt: 'FINAL-PROMPT',
    });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'planner-phase',
      taskId: 'task-7',
      title: 'Plan Task',
      stepName: 'plan',
      profileId: 'coder',
      cwd: '/tmp/project',
      isReadOnly: false,
      prompt: 'write a plan',
      hookRegistry: registry,
    };

    await runStepTask(opts);

    // hasSubscribers checked for the step-prompt hook.
    expect(hasSubscribers).toHaveBeenCalledTimes(1);
    expect(hasSubscribers.mock.calls[0][0]).toBe('beforeStepPrompt');

    // invokePipeline called exactly once.
    expect(invokePipeline).toHaveBeenCalledTimes(1);
    const pipelineCall = invokePipeline.mock.calls[0];
    const name = pipelineCall[0];
    const initialValue = pipelineCall[1];
    const args = pipelineCall[2] as Record<string, unknown>;
    const ctx = pipelineCall[3];

    expect(name).toBe('beforeStepPrompt');
    // Initial value seeded with the original prompt.
    expect(initialValue).toBe('write a plan');

    // Args object: minimal Task + StepDefinition + prompt + cwd + worktreeCwd.
    expect(args).toEqual(
      expect.objectContaining({
        prompt: 'write a plan',
        cwd: '/tmp/project',
        worktreeCwd: '/tmp/project',
      }),
    );
    const task = args.task as Record<string, unknown>;
    expect(task).toEqual(
      expect.objectContaining({
        id: 'task-7',
        title: 'Plan Task',
        prompt: 'write a plan',
        profile: 'coder',
        phaseId: 'planner-phase',
        files: [],
      }),
    );
    const step = args.step as Record<string, unknown>;
    expect(step).toEqual(
      expect.objectContaining({
        name: 'plan',
        profileId: 'coder',
        isReadOnly: false,
      }),
    );

    // A context object is forwarded as the 4th argument.
    expect(ctx).toBeTypeOf('object');
    expect(ctx).not.toBeNull();

    // The pipeline return value is what reaches the agent.
    expect(prompts).toEqual(['FINAL-PROMPT']);
  });

  it('forwards the worktree-resolved cwd (effectiveCwd) in the hook args', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const worktreePath = '/tmp/run-1/task-worktrees/task-7';
    const mockWorktreeManager = {
      createTaskWorktree: mock(async () => worktreePath),
      mergeTaskBranch: mock(async () => ({ success: true, conflictsResolved: false })),
      cullTaskWorktree: mock(async () => {}),
    } as unknown as WorktreeManager;

    const { registry, invokePipeline } = makeMockRegistry({ transformedPrompt: 'WT-PROMPT' });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'planner-phase',
      taskId: 'task-7',
      title: 'Plan Task',
      stepName: 'plan',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'write a plan',
      hookRegistry: registry,
      worktreeManager: mockWorktreeManager,
    };

    await runStepTask(opts);

    expect(invokePipeline).toHaveBeenCalledTimes(1);
    const args = invokePipeline.mock.calls[0][2] as Record<string, unknown>;
    // cwd + worktreeCwd both resolve to the worktree path, not the original cwd.
    expect(args.cwd).toBe(worktreePath);
    expect(args.worktreeCwd).toBe(worktreePath);
    // The agent itself also runs in the worktree.
    expect(prompts).toEqual(['WT-PROMPT']);
  });

  it('does NOT call invokePipeline when there are no subscribers', async () => {
    setupProfiles([coderProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const { registry, invokePipeline } = makeMockRegistry({ hasSubs: false });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'scout-phase',
      taskId: 'task-1',
      title: 'Scout Task',
      stepName: 'scout',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'explore the codebase',
      hookRegistry: registry,
    };

    await runStepTask(opts);

    // Short-circuited: pipeline never invoked, original prompt used.
    expect(invokePipeline).not.toHaveBeenCalled();
    expect(prompts).toEqual(['explore the codebase']);
  });

  it('applies the hook on the structured-output path too', async () => {
    setupProfiles([reviewerProfile]);

    const structuredPrompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, [], 'review-json'),
    );
    mockPromptForStructured.mockImplementation(async (_session: unknown, prompt: string) => {
      structuredPrompts.push(prompt);
      return { result: { approved: true }, attempts: 1 };
    });

    const reg = makeRealRegistry();
    reg.register({ beforeStepPrompt: (value: string) => `[R] ${value}` });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'review-phase',
      taskId: 'task-9',
      title: 'Review Task',
      stepName: 'review',
      profileId: 'reviewer',
      cwd: '/tmp/project',
      prompt: 'review the plan',
      schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
      hookRegistry: reg,
    };

    await runStepTask(opts);

    // promptForStructured received the transformed prompt.
    expect(structuredPrompts).toEqual(['[R] review the plan']);
  });
});

// ─── runMultiStepTask ────────────────────────────────────────────────────

describe('runMultiStepTask — beforeStepPrompt hook', () => {
  it('transforms each step prompt through beforeStepPrompt', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const reg = makeRealRegistry();
    reg.register({ beforeStepPrompt: (value: string) => `[S] ${value}` });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'impl-phase',
      taskId: 'task-2',
      title: 'Two Step Task',
      cwd: '/tmp/project',
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'write the plan' },
        { stepName: 'execute', profileId: 'reviewer', prompt: 'execute the plan' },
      ],
      hookRegistry: reg,
    };

    const res = await runMultiStepTask(opts);

    expect(res.approved).toBe(true);
    // Each step's prompt was individually transformed, in order.
    expect(prompts).toEqual(['[S] write the plan', '[S] execute the plan']);
  });

  it('sends prompts unchanged when hookRegistry is omitted', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'impl-phase',
      taskId: 'task-2',
      title: 'Two Step Task',
      cwd: '/tmp/project',
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'write the plan' },
        { stepName: 'execute', profileId: 'reviewer', prompt: 'execute the plan' },
      ],
      // No hookRegistry.
    };

    const res = await runMultiStepTask(opts);

    expect(res.approved).toBe(true);
    expect(prompts).toEqual(['write the plan', 'execute the plan']);
  });

  it('invokes invokePipeline once per step with the step prompt and args', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    const prompts: string[] = [];
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeCapturingSession(o.profile.id, prompts),
    );

    const { registry, invokePipeline, hasSubscribers } = makeMockRegistry({
      transformedPrompt: 'STEP-XFORM',
    });

    const opts = {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'impl-phase',
      taskId: 'task-2',
      title: 'Two Step Task',
      cwd: '/tmp/project',
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'plan prompt', isReadOnly: true },
        { stepName: 'execute', profileId: 'reviewer', prompt: 'exec prompt' },
      ],
      hookRegistry: registry,
    };

    await runMultiStepTask(opts);

    // One pipeline invocation per step.
    expect(invokePipeline).toHaveBeenCalledTimes(2);
    expect(hasSubscribers).toHaveBeenCalledTimes(2);
    expect(hasSubscribers.mock.calls[0][0]).toBe('beforeStepPrompt');

    // Step 0 args.
    const args0 = invokePipeline.mock.calls[0][2] as Record<string, unknown>;
    expect(args0.prompt).toBe('plan prompt');
    expect(args0.cwd).toBe('/tmp/project');
    expect((args0.step as Record<string, unknown>).name).toBe('plan');
    expect((args0.step as Record<string, unknown>).profileId).toBe('planner');
    expect((args0.task as Record<string, unknown>).id).toBe('task-2');

    // Step 1 args.
    const args1 = invokePipeline.mock.calls[1][2] as Record<string, unknown>;
    expect(args1.prompt).toBe('exec prompt');
    expect((args1.step as Record<string, unknown>).name).toBe('execute');

    // Both steps received the transformed prompt.
    expect(prompts).toEqual(['STEP-XFORM', 'STEP-XFORM']);
  });
});

// ─── Restore real modules ───────────────────────────────────────────────

afterAll(() => {
  mock.module('./profile.js', () => realProfile);
  mock.module('./agent-registry.js', () => realAgentRegistry);
  mock.module('./structured-output.js', () => realStructuredOutput);
});
