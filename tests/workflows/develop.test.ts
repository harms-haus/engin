import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';
import { clearWorkflowCache, loadWorkflow } from '../../src/core/workflow-loader.js';
import { makeMockSession } from '../helpers/make-session.js';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
//
// The develop workflow (at .engin/workflows/develop/main.ts) imports
// createHarness, loadProfilesFromDirs, and resolveProfilesDirs from
// @harms-haus/engin.  We mock those here so tests never make real AI calls.
//
// Capture real modules first so they can be restored in afterAll.
const realEngin = Object.assign({}, await import('@harms-haus/engin'));

const mockCreateHarness = mock();
const mockLoadProfilesFromDirs = mock();
const mockResolveProfilesDirs = mock();
const mockLanePoolRun = mock(() => Promise.resolve({ completedTasks: 0, failedTasks: 0 }));

mock.module('@harms-haus/engin', () => ({
  ...realEngin,
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
  resolveProfilesDirs: (...args: unknown[]) => mockResolveProfilesDirs(...args),
  LanePool: class MockLanePool {
    run = mockLanePoolRun;
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the project root as the cwd so that resolveWorkflowsDirs
 * points at .engin/workflows which contains the develop workflow.
 */
function projectCwd(): string {
  return join(import.meta.dirname, '..', '..');
}

/** A minimal AgentProfile stub sufficient for the workflow. */
const stubProfile = {
  id: 'test-writer',
  name: 'Test Writer',
  provider: 'openai',
  model: 'gpt-4o',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a test writer.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

beforeEach(() => {
  clearWorkflowCache();
  mockCreateHarness.mockClear();
  mockLoadProfilesFromDirs.mockClear();
  mockResolveProfilesDirs.mockClear();
  mockLanePoolRun.mockClear();
  mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
});

afterAll(() => {
  // Restore real module so mocks don't leak to other test files
  mock.module('@harms-haus/engin', () => realEngin);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('develop workflow', () => {
  it('loads via loadWorkflow and returns a WorkflowModule', async () => {
    const cwd = projectCwd();

    const mod = await loadWorkflow('develop', cwd);

    expect(mod).toBeDefined();
    expect(typeof mod.run).toBe('function');
  });

  it('default export has name and description', async () => {
    const mod = await import(join(import.meta.dirname, '..', '..', '.engin', 'workflows', 'develop', 'main.ts'));
    const workflow = mod.default;

    expect(workflow).toBeDefined();
    expect(workflow.name).toBe('develop');
    expect(workflow.description).toBe('Multi-agent development workflow');
    expect(typeof workflow.run).toBe('function');
  });

  it('run() calls lifecycle callbacks in order', async () => {
    // Arrange: provide a profile so the initialization phase runs its agent
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'A Mock Title');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const callOrder: string[] = [];
    const onStatus = {
      onWorkflowStart: mock((info: { taskPrompt: string }) => {
        callOrder.push('onWorkflowStart');
        expect(info.taskPrompt).toBe('test prompt');
        expect(info.resumed).toBe(false);
        expect(info.workDir).toBe('/tmp/work');
      }),
      onPhaseStart: mock((info: { phase: string }) => {
        callOrder.push(`onPhaseStart:${info.phase}`);
      }),
      onPhaseComplete: mock((info: { phase: string }) => {
        callOrder.push(`onPhaseComplete:${info.phase}`);
      }),
      onSidebarUpdate: mock((info: { title?: string; indicator?: string; phases?: unknown }) => {
        if (info.phases) {
          callOrder.push('onSidebarUpdate:phases');
        }
        if (info.title || info.indicator) {
          callOrder.push(`onSidebarUpdate:${info.indicator ?? 'title'}`);
        }
      }),
      onAgentSpawn: mock(() => {
        callOrder.push('onAgentSpawn');
      }),
      onAgentComplete: mock(() => {
        callOrder.push('onAgentComplete');
      }),
      onWorkflowComplete: mock((info: { totalDurationMs: number; agentCount: number }) => {
        callOrder.push('onWorkflowComplete');
        expect(info.agentCount).toBe(1);
      }),
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
      onToolCallStart: mock(() => {}),
      onToolCallEnd: mock(() => {}),
    };

    await mod.run('test prompt', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    // Verify the expected lifecycle order
    expect(callOrder).toContain('onSidebarUpdate:phases');
    expect(callOrder).toContain('onWorkflowStart');
    expect(callOrder).toContain('onPhaseStart:initialization');
    expect(callOrder).toContain('onAgentSpawn');
    expect(callOrder).toContain('onAgentComplete');
    expect(callOrder).toContain('onSidebarUpdate:🔧');
    expect(callOrder).toContain('onPhaseComplete:initialization');
    expect(callOrder).toContain('onPhaseStart:scouting');
    expect(callOrder).toContain('onPhaseComplete:scouting');
    expect(callOrder).toContain('onPhaseStart:scouting_review');
    expect(callOrder).toContain('onPhaseComplete:scouting_review');
    expect(callOrder).toContain('onPhaseStart:planning');
    expect(callOrder).toContain('onPhaseComplete:planning');
    expect(callOrder).toContain('onPhaseStart:plan_review');
    expect(callOrder).toContain('onPhaseComplete:plan_review');
    expect(callOrder).toContain('onPhaseStart:implementing');
    expect(callOrder).toContain('onPhaseComplete:implementing');
    expect(callOrder).toContain('onPhaseStart:final_review');
    expect(callOrder).toContain('onPhaseComplete:final_review');
    expect(callOrder).toContain('onPhaseStart:done');
    expect(callOrder).toContain('onPhaseComplete:done');
    expect(callOrder).toContain('onWorkflowComplete');

    expect(onStatus.onWorkflowComplete).toHaveBeenCalledTimes(1);
  });

  it('generates a title using the agent when a profile is available', async () => {
    // Arrange
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'REST API User Management');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedTitle: string | undefined;
    const onStatus = {
      onSidebarUpdate: mock((info: { title?: string }) => {
        if (info.title) capturedTitle = info.title;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onAgentSpawn: mock(() => {}),
      onAgentComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
      onToolCallStart: mock(() => {}),
      onToolCallEnd: mock(() => {}),
    };

    await mod.run('Write a REST API for user management with authentication', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedTitle).toBe('REST API User Management');
    expect(capturedTitle).not.toBe('Write a REST API for user management with...');
  });

  it('uses fallback title when no profile is available', async () => {
    // Arrange: return empty profiles map -> no profile found
    mockResolveProfilesDirs.mockReturnValue(['/tmp/empty-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedTitle: string | undefined;
    const onStatus = {
      onSidebarUpdate: mock((info: { title?: string }) => {
        if (info.title) capturedTitle = info.title;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    const testPrompt =
      'This is a very long prompt that should be truncated to fifty characters plus ellipsis for the fallback title';
    await mod.run(testPrompt, {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedTitle).toBe(testPrompt.slice(0, 50) + '...');

    // Phase start/complete are still called for initialization, but no
    // agent should be spawned since there was no profile.
    expect(onStatus.onPhaseStart).toHaveBeenCalledWith(expect.objectContaining({ phase: 'initialization' }));
    expect(onStatus.onPhaseComplete).toHaveBeenCalledWith(expect.objectContaining({ phase: 'initialization' }));

    // Verify createHarness was never called (no profile to build from)
    expect(mockCreateHarness).not.toHaveBeenCalled();
    expect(mockLoadProfilesFromDirs).toHaveBeenCalled();
  });

  it('uses fallback title when loadProfilesFromDirs throws an unexpected error', async () => {
    // Arrange: simulate a non-ENOENT error from loadProfilesFromDirs
    mockResolveProfilesDirs.mockReturnValue(['/tmp/bad-profiles']);
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('Unexpected disk error'));

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedTitle: string | undefined;
    const onStatus = {
      onSidebarUpdate: mock((info: { title?: string }) => {
        if (info.title) capturedTitle = info.title;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    const testPrompt = 'Build something cool';
    await mod.run(testPrompt, {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedTitle).toBe(testPrompt.slice(0, 50) + '...');
  });

  it('uses fallback title when createHarness rejects', async () => {
    // Arrange: profile exists but harness creation fails
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    mockCreateHarness.mockRejectedValue(new Error('API unavailable'));

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedTitle: string | undefined;
    const onStatus = {
      onSidebarUpdate: mock((info: { title?: string }) => {
        if (info.title) capturedTitle = info.title;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onAgentSpawn: mock(() => {}),
      onAgentComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    const testPrompt = 'Write some code';
    await mod.run(testPrompt, {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedTitle).toBe(testPrompt.slice(0, 50) + '...');
  });

  it('uses fallback title when session.prompt rejects', async () => {
    // Arrange: harness created but prompt fails
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const badSession = {
      prompt: mock(() => Promise.reject(new Error('LLM timeout'))),
      getLastAssistantText: mock(() => undefined),
      sessionId: 's1',
      subscribe: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    mockCreateHarness.mockResolvedValue({ session: badSession, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedTitle: string | undefined;
    const onStatus = {
      onSidebarUpdate: mock((info: { title?: string }) => {
        if (info.title) capturedTitle = info.title;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onAgentSpawn: mock(() => {}),
      onAgentComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    const testPrompt = 'Fix the bug';
    await mod.run(testPrompt, {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedTitle).toBe(testPrompt.slice(0, 50) + '...');
  });

  it('handles missing onStatus gracefully (no callbacks)', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    // Should not throw when onStatus is entirely absent
    await expect(
      mod.run('test prompt', {
        cwd,
        workDir: '/tmp/work',
      }),
    ).resolves.toBeUndefined();
  });

  it('handles partial onStatus with some callbacks missing', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const calls: string[] = [];
    await mod.run('test prompt', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => calls.push('start')),
        onWorkflowComplete: mock(() => calls.push('complete')),
      },
    });

    expect(calls).toEqual(['start', 'complete']);
  });

  it('passes DEVELOP_PHASES to onSidebarUpdate', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let capturedPhases: unknown;
    const onStatus = {
      onSidebarUpdate: mock((info: { phases?: unknown }) => {
        if (info.phases) capturedPhases = info.phases;
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    await mod.run('test prompt', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(capturedPhases).toBeDefined();
    expect(Array.isArray(capturedPhases)).toBe(true);
    const phases = capturedPhases as { id: string; label: string; icon: string }[];
    expect(phases).toHaveLength(8);
    expect(phases[0].id).toBe('initialization');
    expect(phases[0].label).toBe('Initialization');
    expect(phases[0].icon).toBe('🔧');
    expect(phases[7].id).toBe('done');
    expect(phases[7].label).toBe('Done');
    expect(phases[7].icon).toBe('🎉');
  });

  it('invokes agent spawn/complete callbacks during initialization', async () => {
    // Arrange
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'CLI Tool Title');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    let agentSpawnCalled = false;
    let agentCompleteCalled = false;
    let capturedAgentId: string | undefined;
    let capturedProfile: string | undefined;

    const onStatus = {
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onAgentSpawn: mock((info: { agentId: string; profile: string }) => {
        agentSpawnCalled = true;
        capturedAgentId = info.agentId;
        capturedProfile = info.profile;
      }),
      onAgentComplete: mock((info: { agentId: string; profile: string }) => {
        agentCompleteCalled = true;
        expect(info.agentId).toBe(capturedAgentId);
        expect(info.profile).toBe(capturedProfile);
      }),
      onSidebarUpdate: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
      onToolCallStart: mock(() => {}),
      onToolCallEnd: mock(() => {}),
    };

    await mod.run('Build a CLI tool', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    expect(agentSpawnCalled).toBe(true);
    expect(agentCompleteCalled).toBe(true);
    expect(capturedAgentId).toBe('title-generator');
    expect(capturedProfile).toBe('test-writer');
  });

  it('calls resolveProfilesDirs with correct arguments', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
      },
    });

    expect(mockResolveProfilesDirs).toHaveBeenCalledTimes(1);
    expect(mockResolveProfilesDirs.mock.calls[0][0]).toBe(cwd);
    expect(mockResolveProfilesDirs.mock.calls[0][1]).toBe('develop');
  });

  it('calls loadProfilesFromDirs with the result of resolveProfilesDirs', async () => {
    const fakeDirs = ['/tmp/profiles-a', '/tmp/profiles-b'];
    mockResolveProfilesDirs.mockReturnValue(fakeDirs);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
      },
    });

    expect(mockLoadProfilesFromDirs).toHaveBeenCalledTimes(1);
    expect(mockLoadProfilesFromDirs.mock.calls[0][0]).toEqual(fakeDirs);
  });

  it('passes apiKeys from options to createHarness', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'API Keys Test');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const apiKeys = { openai: 'sk-test-123', anthropic: 'sk-ant-test' };

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      apiKeys,
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
        onAgentSpawn: mock(() => {}),
        onAgentComplete: mock(() => {}),
      },
    });

    expect(mockCreateHarness).toHaveBeenCalledTimes(1);
    const harnessOptions = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(harnessOptions.apiKeys).toEqual(apiKeys);
    expect(harnessOptions.profile).toEqual(stubProfile);
    expect(harnessOptions.cwd).toBe(cwd);
  });

  it('includes agent status callbacks in createHarness options', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'Callbacks Test');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const turnStart = mock();
    const turnEnd = mock();
    const toolCallStart = mock();
    const toolCallEnd = mock();

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
        onAgentSpawn: mock(() => {}),
        onAgentComplete: mock(() => {}),
        onTurnStart: turnStart,
        onTurnEnd: turnEnd,
        onToolCallStart: toolCallStart,
        onToolCallEnd: toolCallEnd,
      },
    });

    expect(mockCreateHarness).toHaveBeenCalledTimes(1);
    const harnessOptions = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(harnessOptions.onAgentStatus).toBeDefined();
    expect(typeof (harnessOptions.onAgentStatus as Record<string, unknown>).onTurnStart).toBe('function');
    expect(typeof (harnessOptions.onAgentStatus as Record<string, unknown>).onTurnEnd).toBe('function');
    expect(typeof (harnessOptions.onAgentStatus as Record<string, unknown>).onToolCallStart).toBe('function');
    expect(typeof (harnessOptions.onAgentStatus as Record<string, unknown>).onToolCallEnd).toBe('function');
  });

  it('does not call createHarness when no profile is found', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/empty-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
      },
    });

    expect(mockCreateHarness).not.toHaveBeenCalled();
  });

  it('disposes the harness after use', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const dispose = mock(() => {});
    const { session } = makeMockSession(() => 'Dispose Test');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus: {
        onWorkflowStart: mock(() => {}),
        onPhaseStart: mock(() => {}),
        onPhaseComplete: mock(() => {}),
        onWorkflowComplete: mock(() => {}),
        onSidebarUpdate: mock(() => {}),
        onAgentSpawn: mock(() => {}),
        onAgentComplete: mock(() => {}),
      },
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('updates sidebar indicator per phase', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const indicators: (string | undefined)[] = [];
    const onStatus = {
      onSidebarUpdate: mock((info: { indicator?: string }) => {
        if (info.indicator) indicators.push(info.indicator);
      }),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock(() => {}),
      onWorkflowComplete: mock(() => {}),
    };

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    // Expected: 🔧 (initialization) → 🔍 → 📋 → 📝 → 👀 → 🔨 → ✅ → 🎉
    expect(indicators).toEqual(['🔧', '🔍', '📋', '📝', '👀', '🔨', '✅', '🎉']);
  });

  it('manages phase complete durationMs for all phases', async () => {
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    mockLoadProfilesFromDirs.mockResolvedValue(new Map());

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const phaseDurations: { phase: string; durationMs: number }[] = [];
    const onStatus = {
      onSidebarUpdate: mock(() => {}),
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock(() => {}),
      onPhaseComplete: mock((info: { phase: string; durationMs: number }) => {
        phaseDurations.push({ phase: info.phase, durationMs: info.durationMs });
      }),
      onWorkflowComplete: mock(() => {}),
    };

    await mod.run('test', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    // All 8 phases should report completion
    expect(phaseDurations).toHaveLength(8);
    const phaseIds = phaseDurations.map((p) => p.phase);
    expect(phaseIds).toEqual([
      'initialization',
      'scouting',
      'scouting_review',
      'planning',
      'plan_review',
      'implementing',
      'final_review',
      'done',
    ]);
    // All durations are reported as 0 (stubs)
    for (const p of phaseDurations) {
      expect(p.durationMs).toBe(0);
    }
  });

  // ── Implementing-phase failure tests ────────────────────────────────────────

  it('halts after implementing phase when failedTasks > 0', async () => {
    // Arrange: provide a profile so the initialization phase runs its agent
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'Halt Test Title');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    // Simulate the LanePool returning failed tasks during the implementing phase.
    // The workflow (once the feature is implemented) will check this result and
    // decide whether to advance to final_review.
    mockLanePoolRun.mockResolvedValue({ completedTasks: 3, failedTasks: 2 });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const phasesStarted: string[] = [];
    const onWorkflowFailed = mock(() => {});
    const onWorkflowComplete = mock(() => {});
    const onStatus = {
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock((info: { phase: string }) => {
        phasesStarted.push(info.phase);
      }),
      onPhaseComplete: mock(() => {}),
      onWorkflowComplete,
      onWorkflowFailed,
      onSidebarUpdate: mock(() => {}),
      onAgentSpawn: mock(() => {}),
      onAgentComplete: mock(() => {}),
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
      onToolCallStart: mock(() => {}),
      onToolCallEnd: mock(() => {}),
    };

    await mod.run('test prompt', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    // ── Assertions ────────────────────────────────────────────────────────

    // Implementing should have started (the phase that produced failures)
    expect(phasesStarted).toContain('implementing');

    // final_review and done should NOT have started — workflow halts
    expect(phasesStarted).not.toContain('final_review');
    expect(phasesStarted).not.toContain('done');

    // onWorkflowFailed should be called with an error mentioning failed tasks
    expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
    expect(onWorkflowFailed).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: expect.stringContaining('failed'),
      }),
      phase: 'implementing',
    });

    // onWorkflowComplete should NOT be called when there are failures
    expect(onWorkflowComplete).not.toHaveBeenCalled();
  });

  it('completes all phases when failedTasks === 0', async () => {
    // Arrange: provide a profile so the initialization phase runs its agent
    mockResolveProfilesDirs.mockReturnValue(['/tmp/mock-profiles']);
    const profiles = new Map([['test-writer', stubProfile]]);
    mockLoadProfilesFromDirs.mockResolvedValue(profiles);
    const { session } = makeMockSession(() => 'Success Test Title');
    mockCreateHarness.mockResolvedValue({ session, sessionId: 's1', dispose: () => {} });

    // Simulate the LanePool returning zero failures
    mockLanePoolRun.mockResolvedValue({ completedTasks: 5, failedTasks: 0 });

    const cwd = projectCwd();
    const mod = await loadWorkflow('develop', cwd);

    const phasesStarted: string[] = [];
    const phasesCompleted: string[] = [];
    const onWorkflowComplete = mock(() => {});
    const onWorkflowFailed = mock(() => {});
    const onStatus = {
      onWorkflowStart: mock(() => {}),
      onPhaseStart: mock((info: { phase: string }) => {
        phasesStarted.push(info.phase);
      }),
      onPhaseComplete: mock((info: { phase: string }) => {
        phasesCompleted.push(info.phase);
      }),
      onWorkflowComplete,
      onWorkflowFailed,
      onSidebarUpdate: mock(() => {}),
      onAgentSpawn: mock(() => {}),
      onAgentComplete: mock(() => {}),
      onTurnStart: mock(() => {}),
      onTurnEnd: mock(() => {}),
      onToolCallStart: mock(() => {}),
      onToolCallEnd: mock(() => {}),
    };

    await mod.run('test prompt', {
      cwd,
      workDir: '/tmp/work',
      onStatus,
    });

    // ── Assertions ────────────────────────────────────────────────────────

    // All phases should have started in order: implementing → final_review → done
    expect(phasesStarted).toContain('implementing');
    expect(phasesStarted).toContain('final_review');
    expect(phasesStarted).toContain('done');

    // All phases should have completed
    expect(phasesCompleted).toContain('implementing');
    expect(phasesCompleted).toContain('final_review');
    expect(phasesCompleted).toContain('done');

    // onWorkflowComplete should be called
    expect(onWorkflowComplete).toHaveBeenCalledTimes(1);

    // onWorkflowFailed should NOT be called when there are no failures
    expect(onWorkflowFailed).not.toHaveBeenCalled();
  });
});
