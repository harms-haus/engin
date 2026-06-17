// ─── Tests for runMultiStepTask — attempt context + session resume ─────────
//
// Verifies two implemented features:
//   (a) Per-step execution-count context `{ attempt }` passed to lazy prompt
//       functions as their second argument (0-indexed, per-step).
//   (b) Session resume: when a step is re-executed after a rejection, the
//       harness is created with `resumeSessionPath` (from a persisted session)
//       instead of `sessionDir`.  When `sessionBaseDir` is absent, the
//       harness is created without persistence options (in-memory fallback).

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AgentProfile } from './types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realProfile = Object.assign({}, await import('./profile.js'));
const realHarnessFactory = Object.assign({}, await import('./harness-factory.js'));
const realStructuredOutput = Object.assign({}, await import('./structured-output.js'));

// ─── Mock dependencies ───────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./harness-factory.js', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// ─── Import after mocks ──────────────────────────────────────────────────

import { runMultiStepTask } from './phase-tasks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const defaultProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

const plannerProfile: AgentProfile = { ...defaultProfile, id: 'planner', name: 'Planner' };
const reviewerProfile: AgentProfile = { ...defaultProfile, id: 'reviewer', name: 'Reviewer' };
const publisherProfile: AgentProfile = { ...defaultProfile, id: 'publisher', name: 'Publisher' };

/** Temporary directory for session files. */
const sessionBaseDir = join(tmpdir(), 'engin-phase-tasks-test', process.pid.toString());

function setupProfiles(profiles: AgentProfile[]) {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) map.set(p.id, p);
  mockLoadProfilesFromDirs.mockResolvedValue(map);
}

function makeMockHarness(profileId: string, textFn?: (text: string) => string | undefined) {
  let lastText: string | undefined;
  const session = {
    prompt: mock(async (text: string) => {
      lastText = textFn?.(text);
    }),
    getLastAssistantText: mock(() => lastText),
    sessionId: `${profileId}-session`,
    sessionFile: join(tmpdir(), `${profileId}-session.jsonl`),
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
  };
  return {
    session,
    sessionId: `${profileId}-session`,
    dispose: mock(() => {}),
  };
}

beforeEach(() => {
  mockLoadProfilesFromDirs.mockReset();
  mockCreateHarness.mockReset();
  mockPromptForStructured.mockReset();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runMultiStepTask — attempt context + session resume', () => {
  // ── Case 1: passes attempt 0 then 1 to a lazy prompt on retry ──────

  it('passes attempt 0 then 1 to a lazy prompt on retry', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    const recorded: number[] = [];

    // Planner step: lazy prompt records ctx.attempt (per-step execution count).
    mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => {
      return makeMockHarness(opts.profile.id, () => 'plan-output');
    });

    // Reviewer: reject first, approve second.
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { approved: false }, attempts: 1 })
      .mockResolvedValueOnce({ result: { approved: true }, attempts: 1 });

    const res = await runMultiStepTask({
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'test-phase',
      taskId: 'task-1',
      title: 'Test Task',
      cwd: '/tmp/project',
      steps: [
        {
          stepName: 'plan',
          profileId: 'planner',
          prompt: (_results: unknown[], ctx: { attempt: number }) => {
            recorded.push(ctx.attempt);
            return 'do work';
          },
          isReadOnly: false,
        },
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'Review the plan',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          getFeedback: () => 'Plan needs work',
        },
      ],
    });

    expect(res.approved).toBe(true);
    expect(recorded).toEqual([0, 1]);
  });

  // ── Case 2: passes resumeSessionPath to createHarness on 2nd exec ──

  it('passes resumeSessionPath to createHarness on a step 2nd execution', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    // Record every createHarness call's opts so we can inspect them.
    const harnessCalls: Array<{
      profileId: string;
      resumeSessionPath?: string;
      sessionDir?: string;
    }> = [];

    mockCreateHarness.mockImplementation(
      async (opts: { profile: AgentProfile; resumeSessionPath?: string; sessionDir?: string }) => {
        harnessCalls.push({
          profileId: opts.profile.id,
          resumeSessionPath: opts.resumeSessionPath,
          sessionDir: opts.sessionDir,
        });
        return makeMockHarness(opts.profile.id, () => 'output');
      },
    );

    // Reviewer: reject first, approve second.
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { approved: false }, attempts: 1 })
      .mockResolvedValueOnce({ result: { approved: true }, attempts: 1 });

    await runMultiStepTask({
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'test-phase',
      taskId: 'task-1',
      title: 'Test Task',
      cwd: '/tmp/project',
      sessionBaseDir,
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'Write plan' },
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'Review the plan',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          getFeedback: () => 'Plan needs work',
        },
      ],
    });

    // Expect 3 harness creations:
    //   call 0: planner step 0, 1st execution (new sessionDir)
    //   call 1: reviewer step 1, 1st execution
    //   call 2: planner step 0, 2nd execution (resumed session)
    const plannerCalls = harnessCalls.filter((c) => c.profileId === 'planner');
    expect(plannerCalls).toHaveLength(2);

    // 1st execution of planner: should have sessionDir, NOT resumeSessionPath
    expect(plannerCalls[0].sessionDir).toBeDefined();
    expect(plannerCalls[0].resumeSessionPath).toBeUndefined();

    // 2nd execution of planner: should have resumeSessionPath (non-empty string)
    expect(typeof plannerCalls[1].resumeSessionPath).toBe('string');
    expect(plannerCalls[1].resumeSessionPath!.length).toBeGreaterThan(0);
  });

  // ── Case 3: backward compat — string prompt and 1-arg function ─────

  it('backward compat: string prompt and 1-arg function still work', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => {
      return makeMockHarness(opts.profile.id, () => 'output');
    });

    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

    // A step with a static string prompt and a step with a 1-arg function
    // prompt.  Both must run without throwing.
    const res = await runMultiStepTask({
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'test-phase',
      taskId: 'task-1',
      title: 'Test Task',
      cwd: '/tmp/project',
      steps: [
        // Static string prompt
        { stepName: 'plan', profileId: 'planner', prompt: 'static string' },
        // 1-arg function prompt (second arg is ctx, but can be omitted)
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: (priorResults: unknown[]) => `from function: ${JSON.stringify(priorResults)}`,
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
        },
      ],
    });

    expect(res.approved).toBe(true);
    expect(res.results).toHaveLength(2);
  });

  // ── Case 4: execCount is per-stepIndex, not global ─────────────────

  it('execCount is per-stepIndex, not global', async () => {
    setupProfiles([plannerProfile, reviewerProfile, publisherProfile]);

    // Record (stepIndex, attempt) pairs from every lazy prompt invocation.
    const recorded: Array<{ stepIndex: number; attempt: number }> = [];

    mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => {
      const session = {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => `${opts.profile.id}-output`),
        sessionId: `${opts.profile.id}-session`,
        sessionFile: join(tmpdir(), `${opts.profile.id}-session.jsonl`),
        subscribe: mock(() => () => {}),
        dispose: mock(() => {}),
        abort: mock(async () => {}),
      };
      return { session, sessionId: `${opts.profile.id}-session`, dispose: mock(() => {}) };
    });

    // Reviewer: reject first, approve second.
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { approved: false }, attempts: 1 })
      .mockResolvedValueOnce({ result: { approved: true }, attempts: 1 });

    await runMultiStepTask({
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'test-phase',
      taskId: 'task-1',
      title: 'Three Step Task',
      cwd: '/tmp/project',
      steps: [
        // Step 0 — planner: lazy prompt that records ctx.attempt
        {
          stepName: 'plan',
          profileId: 'planner',
          prompt: (_results: unknown[], ctx: { attempt: number }) => {
            recorded.push({ stepIndex: 0, attempt: ctx.attempt });
            return 'plan-output';
          },
        },
        // Step 1 — reviewer: structured output gate that rejects once
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'Review',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          getFeedback: () => 'rejected',
        },
        // Step 2 — publisher: never retried, always gets attempt 0
        {
          stepName: 'publish',
          profileId: 'publisher',
          prompt: (_results: unknown[], ctx: { attempt: number }) => {
            recorded.push({ stepIndex: 2, attempt: ctx.attempt });
            return 'publish-output';
          },
        },
      ],
    });

    // Flow:
    //   1. step 0 exec 1 → attempt 0
    //   2. step 1 exec 1 → REJECTS
    //   3. step 0 exec 2 → attempt 1  (backed up, re-executed)
    //   4. step 1 exec 2 → APPROVES
    //   5. step 2 exec 1 → attempt 0  (never retried)
    //
    // Assert: step 2's first (and only) execution gets attempt 0 — proving the
    // counter is per-stepIndex, NOT a global counter that would be polluted by
    // step 0/step 1 retries.
    expect(recorded).toEqual([
      { stepIndex: 0, attempt: 0 }, // planner 1st exec
      { stepIndex: 0, attempt: 1 }, // planner 2nd exec (after backup)
      { stepIndex: 2, attempt: 0 }, // publisher 1st exec — still 0
    ]);
  });

  // ── Case 5: in-memory fallback when sessionBaseDir is absent ───────

  it('falls back to in-memory when sessionBaseDir is absent on a step 2nd execution', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);

    const harnessCalls: Array<{
      profileId: string;
      resumeSessionPath?: string;
      sessionDir?: string;
    }> = [];
    // Capture onAgentSpawn calls so we can pin the sessionPath contract.
    const spawnCalls: Array<{ agentId: string; sessionPath: unknown }> = [];

    mockCreateHarness.mockImplementation(
      async (opts: { profile: AgentProfile; resumeSessionPath?: string; sessionDir?: string }) => {
        harnessCalls.push({
          profileId: opts.profile.id,
          resumeSessionPath: opts.resumeSessionPath,
          sessionDir: opts.sessionDir,
        });
        // sessionFile is undefined → simulates in-memory session (no persisted file)
        const harness = makeMockHarness(opts.profile.id, () => 'output');
        harness.session.sessionFile = undefined as unknown as string;
        return harness;
      },
    );

    // Reviewer: reject first, approve second.
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { approved: false }, attempts: 1 })
      .mockResolvedValueOnce({ result: { approved: true }, attempts: 1 });

    // Omit sessionBaseDir entirely — no persistence.
    await runMultiStepTask({
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'test-phase',
      taskId: 'task-1',
      title: 'In-Memory Fallback',
      cwd: '/tmp/project',
      onStatus: {
        onAgentSpawn: (e) => spawnCalls.push({ agentId: e.agentId, sessionPath: e.sessionPath }),
      },
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'Write plan' },
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'Review the plan',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          getFeedback: () => 'Plan needs work',
        },
      ],
    });

    // 3 harness creations: planner×2 + reviewer×1.
    // Because sessionBaseDir is absent and sessionFile is undefined,
    // no resumeSessionPath is captured and no sessionDir is constructed.
    const plannerCalls = harnessCalls.filter((c) => c.profileId === 'planner');
    expect(plannerCalls).toHaveLength(2);

    // 1st execution: no persistence options
    expect(plannerCalls[0].sessionDir).toBeUndefined();
    expect(plannerCalls[0].resumeSessionPath).toBeUndefined();

    // 2nd execution (after backup): still no persistence options
    expect(plannerCalls[1].sessionDir).toBeUndefined();
    expect(plannerCalls[1].resumeSessionPath).toBeUndefined();

    // Restored contract: even on the in-memory path (sessionBaseDir absent,
    // sessionFile undefined), onAgentSpawn's sessionPath must NEVER be
    // undefined — it falls back to the harness's sessionId so consumers that
    // previously received a non-empty string still do. One spawn per harness
    // creation (4 total: planner×2 + reviewer×2, since the reviewer rejects
    // once then approves); every sessionPath is the mocked sessionId
    // ('<profileId>-session').
    expect(spawnCalls).toHaveLength(4);
    for (const spawn of spawnCalls) {
      expect(typeof spawn.sessionPath).toBe('string');
      expect((spawn.sessionPath as string).length).toBeGreaterThan(0);
    }
    // The in-memory fallback specifically yields the harness sessionId.
    expect(spawnCalls[0].sessionPath).toBe('planner-session');
  });
});

// ─── Restore real modules ───────────────────────────────────────────────

afterAll(() => {
  mock.module('./profile.js', () => realProfile);
  mock.module('./harness-factory.js', () => realHarnessFactory);
  mock.module('./structured-output.js', () => realStructuredOutput);
});
