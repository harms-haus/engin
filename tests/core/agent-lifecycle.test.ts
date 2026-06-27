// ─── Tests for spawnAgent (agent-lifecycle helper) ───────────────────────────
//
// `spawnAgent` extracts the duplicated agent lifecycle previously inlined in
// `pool/session.ts:runSession` and the legacy task execution modules:
//   - profile lookup + read-only adjustment (strip write/edit)
//   - harness creation via createHarness
//   - activeSessions tracking (before any status callback — TOCTOU safety)
//   - onSessionStart firing (with sessionId + sessionPath)
//   - onStepStart firing
//   - returns a handle exposing session/dispose/sessionId/sessionPath + a
//     `complete()` method that fires onSessionComplete and removes the session
//     from activeSessions.
//
// Renderer invocation is intentionally NOT part of spawnAgent — it stays in the
// callers (runStep / runStepTask), which have different rendering needs.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentLifecycleOptions } from '../../packages/engine/src/core/agent-lifecycle.js';
import { spawnAgent } from '../../packages/engine/src/core/agent-lifecycle.js';
import type { AgentPlugin, AgentRuntime, AgentSessionOptions } from '../../packages/engine/src/core/agent-plugin.js';
import { clearAgentPluginRegistry, registerAgentPlugin } from '../../packages/engine/src/core/agent-registry.js';
import type { AgentProfile, StatusCallbacks } from '../../packages/engine/src/core/types.js';

// ─── Fake agent plugin (real-registry-backed, no global module mock) ───────
//
// Previously this file used `mock.module('../../packages/engine/src/core/
// agent-registry.js', ...)` to replace `requireAgentPlugin` with a stub.
// bun's `mock.module` is PROCESS-GLOBAL and leaks across test files under the
// full suite's parallel scheduling, breaking agent-registry.test.ts /
// sessions/index.test.ts / engine-index.test.ts which rely on the real registry.
//
// Instead we register a FAKE plugin into the REAL (module-level) registry and
// have every test profile reference this plugin's id. Registry mutations are
// naturally scoped (per-test beforeEach/afterEach) and cannot leak the way a
// persistent module mock does. The fake id (`__test-agent-lifecycle__`) is
// unique to this file so it never collides with ids checked by sibling suites.

const FAKE_PLUGIN_ID = '__test-agent-lifecycle__';

// ─── Mock Dependencies ─────────────────────────────────────────────────────
//
// `mockCreateHarness` is the per-test hook controlling what the fake plugin's
// `createSession` returns. `setupHarness()` wires it to resolve a wrapper
// `{ session, sessionId, dispose }`; the fake plugin unwraps that onto the
// inner session object IN-PLACE (matching the real createSession contract:
// it returns the inner AgentRuntime, whose sessionId/dispose the caller reads).

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

const fakePlugin: AgentPlugin = {
  id: FAKE_PLUGIN_ID,
  createSession: async (opts: AgentSessionOptions): Promise<AgentRuntime> => {
    const w = (await mockCreateHarness(opts)) as {
      session: Record<string, unknown>;
      sessionId?: string;
      dispose?: () => void;
      contextWindow?: number;
    };
    // Propagate wrapper-level fields onto the inner session IN-PLACE so the
    // same object reference is tracked in activeSessions AND spawnAgent's
    // session.dispose() / session.sessionId observe the wrapper's mock.
    if (w.dispose) (w.session as { dispose: () => void }).dispose = w.dispose;
    if (w.sessionId) (w.session as { sessionId: string }).sessionId = w.sessionId;
    if (w.contextWindow !== undefined) (w.session as { contextWindow: number }).contextWindow = w.contextWindow;
    return w.session as unknown as AgentRuntime;
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const defaultProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  agent: FAKE_PLUGIN_ID,
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

/** A mock agent session with the methods spawnAgent + callers touch. */
interface MockSession {
  prompt: ReturnType<typeof mock>;
  getLastAssistantText: ReturnType<typeof mock>;
  sessionId: string;
  sessionFile?: string;
  subscribe: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  abort: ReturnType<typeof mock>;
}

function makeMockSession(overrides?: Partial<MockSession>): MockSession {
  return {
    prompt: mock(async () => {}),
    getLastAssistantText: mock(() => 'ok'),
    sessionId: 'test-session',
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
    ...overrides,
  };
}

/** Builds a profiles map from a list of profiles. */
function profilesMap(...profiles: AgentProfile[]): Map<string, AgentProfile> {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) map.set(p.id, p);
  return map;
}

/** Minimal base options covering all required AgentLifecycleOptions fields. */
function makeBaseOptions(overrides?: Partial<AgentLifecycleOptions>): AgentLifecycleOptions {
  return {
    profileId: 'coder',
    agentId: 'agent-1',
    cwd: '/tmp/project',
    phaseId: 'implementing',
    taskId: 'task-1',
    ...overrides,
  };
}

/**
 * Wires mockCreateHarness to return a harness wrapping the given session and
 * returns that session so the test can assert on it. Captures the dispose fn
 * so disposal can be asserted separately.
 */
function setupHarness(session?: MockSession): { session: MockSession; dispose: ReturnType<typeof mock> } {
  const sess = session ?? makeMockSession();
  const dispose = mock(() => {});
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: sess.sessionId,
    dispose,
  });
  return { session: sess, dispose };
}

/** Status-callback spy that records the call order of every fired event. */
function makeStatusSpy(): StatusCallbacks & { callOrder: string[] } {
  const callOrder: string[] = [];
  const track = (name: string) => () => {
    callOrder.push(name);
  };
  return {
    callOrder,
    onSessionStart: mock(track('onSessionStart')),
    onSessionComplete: mock(track('onSessionComplete')),
    onAgentRender: mock(track('onAgentRender')),
  } as unknown as StatusCallbacks & { callOrder: string[] };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockReset();
  registerAgentPlugin(fakePlugin);
});

afterEach(() => {
  // Prevent the fake plugin from leaking into sibling test files under the
  // full suite's parallel scheduling. Uses the real registry (naturally
  // scoped) instead of a process-global `mock.module` that would replace
  // requireAgentPlugin for every other file in the process.
  clearAgentPluginRegistry();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('spawnAgent', () => {
  // ─── Profile lookup ──────────────────────────────────────────────────

  describe('profile lookup', () => {
    it('looks up the profile from the provided map by profileId', async () => {
      setupHarness();
      const profiles = profilesMap(defaultProfile);

      await spawnAgent(makeBaseOptions(), profiles);

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const passedProfile = harnessOpts.profile as AgentProfile;
      expect(passedProfile.id).toBe('coder');
    });

    it('throws a descriptive error when the profile is not found', async () => {
      setupHarness();
      const profiles = profilesMap(); // empty

      await expect(spawnAgent(makeBaseOptions({ profileId: 'missing' }), profiles)).rejects.toThrow(
        /Profile "missing" not found/,
      );
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });

    it('does not create a harness when the profile is missing', async () => {
      setupHarness();
      await expect(spawnAgent(makeBaseOptions(), profilesMap())).rejects.toThrow();
      expect(mockCreateHarness).not.toHaveBeenCalled();
    });
  });

  // ─── Read-only profile adjustment ────────────────────────────────────

  describe('isReadOnly profile adjustment', () => {
    it('strips write and edit tools when isReadOnly is true', async () => {
      setupHarness();
      const profiles = profilesMap(defaultProfile);

      await spawnAgent(makeBaseOptions({ isReadOnly: true }), profiles);

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjusted = harnessOpts.profile as AgentProfile;
      expect(adjusted.excludeTools).toContain('write');
      expect(adjusted.excludeTools).toContain('edit');
    });

    it('does not modify excludeTools when isReadOnly is false', async () => {
      setupHarness();
      const profile: AgentProfile = { ...defaultProfile, excludeTools: ['bash'] };
      const profiles = profilesMap(profile);

      await spawnAgent(makeBaseOptions({ isReadOnly: false }), profiles);

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjusted = harnessOpts.profile as AgentProfile;
      expect(adjusted.excludeTools).toEqual(['bash']);
      expect(adjusted.excludeTools).not.toContain('write');
      expect(adjusted.excludeTools).not.toContain('edit');
    });

    it('defaults isReadOnly to false when undefined', async () => {
      setupHarness();
      const profiles = profilesMap(defaultProfile);

      await spawnAgent(makeBaseOptions({ isReadOnly: undefined }), profiles);

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjusted = harnessOpts.profile as AgentProfile;
      expect(adjusted.excludeTools).not.toContain('write');
      expect(adjusted.excludeTools).not.toContain('edit');
    });

    it('does not duplicate write/edit when already present in excludeTools', async () => {
      setupHarness();
      const profile: AgentProfile = { ...defaultProfile, excludeTools: ['write', 'bash'] };
      const profiles = profilesMap(profile);

      await spawnAgent(makeBaseOptions({ isReadOnly: true }), profiles);

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjusted = harnessOpts.profile as AgentProfile;
      const writeCount = adjusted.excludeTools.filter((t) => t === 'write').length;
      const editCount = adjusted.excludeTools.filter((t) => t === 'edit').length;
      expect(writeCount).toBe(1);
      expect(editCount).toBe(1);
    });

    it('does not mutate the original profile object', async () => {
      setupHarness();
      const profile: AgentProfile = { ...defaultProfile, excludeTools: [] };
      const profiles = profilesMap(profile);

      await spawnAgent(makeBaseOptions({ isReadOnly: true }), profiles);

      // The map's profile must be untouched; adjustment is a copy.
      expect(profile.excludeTools).toEqual([]);
    });

    it('preserves the rest of the profile fields when adjusting', async () => {
      setupHarness();
      const profiles = profilesMap(defaultProfile);

      await spawnAgent(makeBaseOptions({ isReadOnly: true }), profiles);

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjusted = harnessOpts.profile as AgentProfile;
      expect(adjusted.id).toBe('coder');
      expect(adjusted.model).toBe('gpt-4');
      expect(adjusted.systemPrompt).toBe('You are a coding agent.');
    });
  });

  // ─── Harness creation options ────────────────────────────────────────

  describe('harness creation options', () => {
    it('passes cwd from options', async () => {
      setupHarness();
      await spawnAgent(makeBaseOptions({ cwd: '/my/project' }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.cwd).toBe('/my/project');
    });

    it('passes apiKeys from options', async () => {
      setupHarness();
      const apiKeys = { openai: 'sk-123', anthropic: 'sk-abc' };
      await spawnAgent(makeBaseOptions({ apiKeys }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.apiKeys).toEqual(apiKeys);
    });

    it('passes agentId from options', async () => {
      setupHarness();
      await spawnAgent(makeBaseOptions({ agentId: 'lane-7' }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.agentId).toBe('lane-7');
    });

    it('passes allowedWriteDirs from options', async () => {
      setupHarness();
      const allowedWriteDirs = ['/tmp/a', '/tmp/b'];
      await spawnAgent(makeBaseOptions({ allowedWriteDirs }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.allowedWriteDirs).toEqual(allowedWriteDirs);
    });

    it('passes sessionDir when provided and no resumeSessionPath', async () => {
      setupHarness();
      const sessionDir = '/base/task-1/0-0-implement';
      await spawnAgent(makeBaseOptions({ sessionDir }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.sessionDir).toBe(sessionDir);
      expect(harnessOpts.resumeSessionPath).toBeUndefined();
    });

    it('passes resumeSessionPath when provided', async () => {
      setupHarness();
      const resumeSessionPath = '/base/task-1/0-0-implement/session.jsonl';
      await spawnAgent(makeBaseOptions({ resumeSessionPath }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.resumeSessionPath).toBe(resumeSessionPath);
    });

    it('forwards a non-undefined onAgentStatus when onStatus is provided', async () => {
      setupHarness();
      const onStatus = makeStatusSpy();
      await spawnAgent(makeBaseOptions({ onStatus }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.onAgentStatus).toBeDefined();
      // The forwarded object should expose the agent-level turn/tool callbacks.
      const forwarded = harnessOpts.onAgentStatus as Record<string, unknown>;
      expect(typeof forwarded.onTurnStart).toBe('function');
      expect(typeof forwarded.onTurnEnd).toBe('function');
      expect(typeof forwarded.onToolCallStart).toBe('function');
      expect(typeof forwarded.onToolCallEnd).toBe('function');
    });

    it('passes undefined onAgentStatus when onStatus is not provided', async () => {
      setupHarness();
      await spawnAgent(makeBaseOptions({ onStatus: undefined }), profilesMap(defaultProfile));

      const harnessOpts = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessOpts.onAgentStatus).toBeUndefined();
    });

    it('rethrows when createHarness throws', async () => {
      mockCreateHarness.mockRejectedValue(new Error('Harness creation failed'));

      await expect(spawnAgent(makeBaseOptions(), profilesMap(defaultProfile))).rejects.toThrow(
        'Harness creation failed',
      );
    });
  });

  // ─── activeSessions tracking (TOCTOU) ───────────────────────────────

  describe('activeSessions tracking', () => {
    it('adds the session to activeSessions', async () => {
      const { session } = setupHarness();
      const activeSessions = new Set<{ abort(): Promise<void> }>();

      await spawnAgent(makeBaseOptions({ activeSessions }), profilesMap(defaultProfile));

      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(true);
    });

    it('adds the session BEFORE firing onSessionStart (TOCTOU)', async () => {
      const { session } = setupHarness();
      const activeSessions = new Set<{ abort(): Promise<void> }>();
      let trackedAtSpawn = false;

      const onStatus = makeStatusSpy();
      (onStatus.onSessionStart as ReturnType<typeof mock>).mockImplementation(() => {
        trackedAtSpawn = activeSessions.has(session as unknown as { abort(): Promise<void> });
      });

      await spawnAgent(makeBaseOptions({ activeSessions, onStatus }), profilesMap(defaultProfile));

      expect(trackedAtSpawn).toBe(true);
    });

    it('an abort triggered from onSessionStart reaches the already-tracked session', async () => {
      const { session } = setupHarness();
      const activeSessions = new Set<{ abort(): Promise<void> }>();

      const onStatus = makeStatusSpy();
      (onStatus.onSessionStart as ReturnType<typeof mock>).mockImplementation(() => {
        // Mirror the LanePool abort listener firing in the [tracked, prompt] window.
        for (const s of activeSessions) {
          s.abort().catch(() => {
            /* swallow */
          });
        }
      });

      await spawnAgent(makeBaseOptions({ activeSessions, onStatus }), profilesMap(defaultProfile));

      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it('does not throw when activeSessions is not provided', async () => {
      setupHarness();
      await expect(
        spawnAgent(makeBaseOptions({ activeSessions: undefined }), profilesMap(defaultProfile)),
      ).resolves.toBeDefined();
    });

    it('still leaves the session tracked until complete() is called', async () => {
      const { session } = setupHarness();
      const activeSessions = new Set<{ abort(): Promise<void> }>();

      const handle = await spawnAgent(makeBaseOptions({ activeSessions }), profilesMap(defaultProfile));

      // After spawn, before complete — session remains tracked.
      expect(activeSessions.size).toBe(1);
      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(true);

      handle.complete();

      expect(activeSessions.size).toBe(0);
      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(false);
    });
  });

  // ─── sessionPath computation ────────────────────────────────────────

  describe('sessionPath computation', () => {
    it('uses session.sessionFile when available', async () => {
      const sessionFile = '/base/task-1/sessions/abc.jsonl';
      setupHarness(makeMockSession({ sessionFile }));

      const handle = await spawnAgent(makeBaseOptions({ sessionDir: '/some/dir' }), profilesMap(defaultProfile));

      expect(handle.sessionPath).toBe(sessionFile);
    });

    it('falls back to resumeSessionPath when sessionFile is absent', async () => {
      const resumeSessionPath = '/base/task-1/0-0-implement/prev.jsonl';
      setupHarness(makeMockSession({ sessionFile: undefined }));

      const handle = await spawnAgent(makeBaseOptions({ resumeSessionPath }), profilesMap(defaultProfile));

      expect(handle.sessionPath).toBe(resumeSessionPath);
    });

    it('falls back to sessionDir when neither sessionFile nor resumeSessionPath are set', async () => {
      const sessionDir = '/base/task-1/0-0-implement';
      setupHarness(makeMockSession({ sessionFile: undefined }));

      const handle = await spawnAgent(makeBaseOptions({ sessionDir }), profilesMap(defaultProfile));

      expect(handle.sessionPath).toBe(sessionDir);
    });

    it('prefers sessionFile over resumeSessionPath and sessionDir', async () => {
      const sessionFile = '/real/file.jsonl';
      setupHarness(makeMockSession({ sessionFile }));

      const handle = await spawnAgent(
        makeBaseOptions({
          resumeSessionPath: '/resume.jsonl',
          sessionDir: '/dir',
        }),
        profilesMap(defaultProfile),
      );

      expect(handle.sessionPath).toBe(sessionFile);
    });
  });

  // ─── onSessionStart firing ────────────────────────────────────────────

  describe('onSessionStart firing', () => {
    it('fires onSessionStart with the correct fields including sessionId and sessionPath', async () => {
      const sessionFile = '/base/abc.jsonl';
      setupHarness(makeMockSession({ sessionId: 'sess-99', sessionFile }));

      const onStatus = makeStatusSpy();
      await spawnAgent(
        makeBaseOptions({
          agentId: 'agent-7',
          profileId: 'coder',
          phaseId: 'implementing',
          taskId: 'task-9',
          onStatus,
        }),
        profilesMap(defaultProfile),
      );

      expect(onStatus.onSessionStart).toHaveBeenCalledTimes(1);
      const call = (onStatus.onSessionStart as ReturnType<typeof mock>).mock.calls[0]![0] as Record<string, unknown>;
      expect(call.agentId).toBe('agent-7');
      expect(call.profile).toBe('coder');
      expect(call.phaseId).toBe('implementing');
      expect(call.taskId).toBe('task-9');
      expect(call.sessionId).toBe('sess-99');
      expect(call.sessionPath).toBe(sessionFile);
    });

    it('does not throw when onStatus is undefined (no spawn fired)', async () => {
      setupHarness();
      await expect(
        spawnAgent(makeBaseOptions({ onStatus: undefined }), profilesMap(defaultProfile)),
      ).resolves.toBeDefined();
    });
  });

  // ─── Return handle ──────────────────────────────────────────────────

  describe('returned handle', () => {
    it('exposes the session from the created harness', async () => {
      const { session } = setupHarness();
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      // handle.session is the full AgentSession type; compare reference identity
      // via `unknown` since our MockSession is a lightweight stand-in.
      expect(handle.session as unknown).toBe(session as unknown);
    });

    it('exposes a dispose function backed by the created harness', async () => {
      const { dispose } = setupHarness();
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      expect(typeof handle.dispose).toBe('function');
      handle.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('exposes the sessionId from the created harness', async () => {
      setupHarness(makeMockSession({ sessionId: 'harness-id-1' }));
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      expect(handle.sessionId).toBe('harness-id-1');
    });

    it('exposes the computed sessionPath', async () => {
      const sessionFile = '/x/y.jsonl';
      setupHarness(makeMockSession({ sessionFile }));
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      expect(handle.sessionPath).toBe(sessionFile);
    });

    it('exposes a complete function', async () => {
      setupHarness();
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      expect(typeof handle.complete).toBe('function');
    });

    it('calling handle.dispose() disposes the underlying harness', async () => {
      const { dispose } = setupHarness();
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));

      handle.dispose();

      expect(dispose).toHaveBeenCalled();
    });
  });

  // ─── complete() method ──────────────────────────────────────────────

  describe('handle.complete()', () => {
    it('fires onSessionComplete with the correct fields', async () => {
      setupHarness(makeMockSession({ sessionId: 'sess-1' }));
      const onStatus = makeStatusSpy();

      const handle = await spawnAgent(
        makeBaseOptions({
          agentId: 'agent-1',
          profileId: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
          onStatus,
        }),
        profilesMap(defaultProfile),
      );

      handle.complete();

      expect(onStatus.onSessionComplete).toHaveBeenCalledTimes(1);
      const call = (onStatus.onSessionComplete as ReturnType<typeof mock>).mock.calls[0]![0] as Record<string, unknown>;
      expect(call.agentId).toBe('agent-1');
      expect(call.profile).toBe('coder');
      expect(call.phaseId).toBe('implementing');
      expect(call.taskId).toBe('task-1');
      expect(call.sessionId).toBe('sess-1');
    });

    it('removes the session from activeSessions', async () => {
      const { session } = setupHarness();
      const activeSessions = new Set<{ abort(): Promise<void> }>();

      const handle = await spawnAgent(makeBaseOptions({ activeSessions }), profilesMap(defaultProfile));
      expect(activeSessions.size).toBe(1);

      handle.complete();

      expect(activeSessions.size).toBe(0);
      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(false);
    });

    it('fires onSessionComplete after onSessionStart (full spawn→complete order)', async () => {
      setupHarness();
      const onStatus = makeStatusSpy();

      const handle = await spawnAgent(makeBaseOptions({ onStatus }), profilesMap(defaultProfile));
      handle.complete();

      const spawnIdx = onStatus.callOrder.indexOf('onSessionStart');
      const completeIdx = onStatus.callOrder.indexOf('onSessionComplete');
      expect(spawnIdx).toBe(0);
      expect(completeIdx).toBeGreaterThan(spawnIdx);
    });

    it('does NOT dispose the harness (disposal is the caller’s responsibility)', async () => {
      const { dispose } = setupHarness();

      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      handle.complete();

      // complete() fires the lifecycle callback + untracks; it must NOT dispose.
      expect(dispose).not.toHaveBeenCalled();
    });

    it('does NOT invoke renderers (renderer invocation stays in callers)', async () => {
      setupHarness();
      const onStatus = makeStatusSpy();

      const handle = await spawnAgent(makeBaseOptions({ onStatus }), profilesMap(defaultProfile));
      handle.complete();

      // spawnAgent has no rendererRegistry — onAgentRender must never fire.
      expect(onStatus.onAgentRender).not.toHaveBeenCalled();
    });

    it('does not throw when onStatus is undefined', async () => {
      setupHarness();
      const handle = await spawnAgent(makeBaseOptions({ onStatus: undefined }), profilesMap(defaultProfile));
      expect(() => handle.complete()).not.toThrow();
    });

    it('does not throw when activeSessions is undefined', async () => {
      setupHarness();
      const handle = await spawnAgent(makeBaseOptions({ activeSessions: undefined }), profilesMap(defaultProfile));
      expect(() => handle.complete()).not.toThrow();
    });
  });

  // ─── No status callbacks at all ─────────────────────────────────────

  describe('without any optional inputs', () => {
    it('spawns and completes without throwing when onStatus and activeSessions are absent', async () => {
      setupHarness();
      const handle = await spawnAgent(makeBaseOptions(), profilesMap(defaultProfile));
      expect(() => handle.complete()).not.toThrow();
      expect(handle.session).toBeDefined();
      expect(typeof handle.dispose).toBe('function');
    });
  });

  // ─── Integration-style: mirrors runStep's TOCTOU-critical ordering ──

  describe('integration: spawn→complete lifecycle ordering', () => {
    it('tracks the session before firing any callbacks, and completes after session start', async () => {
      const { session } = setupHarness();
      const events: string[] = [];
      const activeSessions = new Set<{ abort(): Promise<void> }>();

      const onStatus = {
        onSessionStart: mock(() => events.push('spawn')),
        onSessionComplete: mock(() => events.push('complete')),
      } as unknown as StatusCallbacks;

      // Observe tracking relative to the status callbacks.
      const origAdd = activeSessions.add.bind(activeSessions);
      activeSessions.add = ((s: { abort(): Promise<void> }) => {
        events.push('track');
        return origAdd(s);
      }) as typeof activeSessions.add;
      const origDelete = activeSessions.delete.bind(activeSessions);
      activeSessions.delete = ((s: { abort(): Promise<void> }) => {
        events.push('untrack');
        return origDelete(s);
      }) as typeof activeSessions.delete;

      const handle = await spawnAgent(makeBaseOptions({ activeSessions, onStatus }), profilesMap(defaultProfile));
      handle.complete();

      // Spec-mandated prefix ordering: the session is tracked BEFORE any
      // observable callback (TOCTOU safety).
      expect(events.indexOf('track')).toBe(0);
      expect(events.indexOf('spawn')).toBeGreaterThan(events.indexOf('track'));

      // Both completion effects must occur after spawn. Their relative
      // order is intentionally left unspecified (the spec only requires that
      // complete() fires onSessionComplete AND removes from activeSessions).
      expect(events).toContain('complete');
      expect(events).toContain('untrack');
      expect(events.indexOf('complete')).toBeGreaterThan(events.indexOf('spawn'));
      expect(events.indexOf('untrack')).toBeGreaterThan(events.indexOf('spawn'));

      // Net effect: session is no longer tracked after complete().
      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(false);
    });
  });
});
