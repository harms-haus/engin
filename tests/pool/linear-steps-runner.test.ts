import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import { linearStepsRunner } from '../../packages/engine/src/pool/linear-steps-runner.js';
import type { TaskRunnerContext } from '../../packages/engine/src/pool/types.js';
import {
  clearPoolMocks,
  createRunnerContext,
  makeSession,
  mockCreateHarness,
  mockPromptForStructured,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

// ── Shared step fixtures ───────────────────────────────────────────────────
//
// A non-structured "implement" step (always approved) and a structured
// "review" step whose approved/feedback/severity fields are driven by the
// mocked promptForStructured responses. These mirror the inline literals used
// above but cut down on repetition in the refactor-preservation tests below.

const implementStep = { name: 'implement', profileId: 'coder', isReadOnly: false };

const reviewStep = {
  name: 'review',
  profileId: 'reviewer',
  isReadOnly: true,
  schema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
    severity: z.string().optional(),
  }),
};

beforeEach(() => {
  clearPoolMocks();
});

describe('linearStepsRunner', () => {
  describe('single-step success', () => {
    it('completes a single non-structured step', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });

    it('passes the final step output to completeTask so it lands on task.result', async () => {
      setupProfileMocks();
      setupHarnessMocks(makeSession(() => 'scout report: found auth module'));
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([{ name: 'scouting', profileId: 'coder', isReadOnly: true }]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledWith('scout report: found auth module');
    });
  });

  describe('multi-step success', () => {
    it('executes two steps in sequence', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(mockCreateHarness).toHaveBeenCalledTimes(2);
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('step rejection then retry then success', () => {
    it('backs up on rejection and retries, eventually completing', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // First call to promptForStructured rejects, second approves
      let structuredCall = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCall++;
        if (structuredCall === 1) {
          return Promise.resolve({
            result: { approved: false, feedback: 'Needs more tests', severity: 'medium' },
            attempts: 1,
          });
        }
        return Promise.resolve({
          result: { approved: true, feedback: undefined },
          attempts: 1,
        });
      });

      const onStepStart = mock(() => {});
      const ctx = createRunnerContext({
        maxStepRetries: 5,
        onStatus: { onStepStart },
      });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // 4 onStepStart calls: step0, step1(rejected), step0(retry), step1(approved)
      expect(onStepStart).toHaveBeenCalledTimes(4);
      expect(onStepStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
      expect(onStepStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
      expect(onStepStart).toHaveBeenNthCalledWith(3, expect.objectContaining({ stepIndex: 0, stepName: 'implement' }));
      expect(onStepStart).toHaveBeenNthCalledWith(4, expect.objectContaining({ stepIndex: 1, stepName: 'review' }));
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('max retries with critical severity', () => {
    it('returns failed with feedback when severity is critical', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Security vulnerability', severity: 'critical' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('feedback', 'Security vulnerability');
      expect(ctx.failTask).toHaveBeenCalledWith(
        expect.objectContaining({ feedback: 'Security vulnerability', severity: 'critical' }),
      );
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('max retries with medium severity', () => {
    it('returns completed when severity is medium', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Minor style issues', severity: 'medium' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });
  });

  describe('no steps', () => {
    it('returns failed when steps array is empty', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const ctx = createRunnerContext();
      const runner = linearStepsRunner([]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'No steps defined for task');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'No steps defined for task' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('unexpected error handling', () => {
    it('catches error from createHarness, returns failed, does NOT re-throw', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValue(new Error('Harness exploded'));

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      let threw = false;
      try {
        const outcome = await runner(ctx);
        expect(outcome.status).toBe('failed');
        expect(outcome).toHaveProperty('error', 'Harness exploded');
        expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Harness exploded' }));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  describe('event ordering: onAgentSpawn before onStepStart', () => {
    it('fires onAgentSpawn before onStepStart for each step', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const callOrder: string[] = [];
      const onAgentSpawn = mock((_info: unknown) => {
        callOrder.push('onAgentSpawn');
      });
      const onStepStart = mock((_info: unknown) => {
        callOrder.push('onStepStart');
      });

      const ctx = createRunnerContext({
        onStatus: { onAgentSpawn, onStepStart } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      await runner(ctx);

      // For a single step, we expect: onAgentSpawn, onStepStart (in that order)
      expect(callOrder).toEqual(['onAgentSpawn', 'onStepStart']);
    });

    it('fires onAgentSpawn before onStepStart for each of two steps in sequence', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const callOrder: string[] = [];
      const onAgentSpawn = mock((_info: unknown) => {
        callOrder.push('onAgentSpawn');
      });
      const onStepStart = mock((_info: unknown) => {
        callOrder.push('onStepStart');
      });

      const ctx = createRunnerContext({
        onStatus: { onAgentSpawn, onStepStart } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ]);

      await runner(ctx);

      // For two steps: step0 onAgentSpawn, step0 onStepStart, step1 onAgentSpawn, step1 onStepStart
      expect(callOrder).toEqual(['onAgentSpawn', 'onStepStart', 'onAgentSpawn', 'onStepStart']);
    });

    it('maintains ordering across retry (back-up) scenario', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // First call to promptForStructured rejects, second approves
      let structuredCall = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCall++;
        if (structuredCall === 1) {
          return Promise.resolve({
            result: { approved: false, feedback: 'Needs more tests', severity: 'medium' },
            attempts: 1,
          });
        }
        return Promise.resolve({
          result: { approved: true, feedback: undefined },
          attempts: 1,
        });
      });

      const callOrder: string[] = [];
      const onAgentSpawn = mock((_info: unknown) => {
        callOrder.push('onAgentSpawn');
      });
      const onStepStart = mock((_info: unknown) => {
        callOrder.push('onStepStart');
      });

      const ctx = createRunnerContext({
        maxStepRetries: 5,
        onStatus: { onAgentSpawn, onStepStart } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      ]);

      await runner(ctx);

      // Expect: step0 spawn, step0 start, step1 spawn, step1 start, step0 retry spawn, step0 retry start, step1 spawn, step1 start
      expect(callOrder).toEqual([
        'onAgentSpawn',
        'onStepStart',
        'onAgentSpawn',
        'onStepStart',
        'onAgentSpawn',
        'onStepStart',
        'onAgentSpawn',
        'onStepStart',
      ]);
    });
  });

  describe('session disposal', () => {
    it('disposes all sessions on successful completion', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        const dispose = mock(() => {});
        disposes.push(dispose);
        return {
          session: makeSession(() => 'done'),
          sessionId: `s-${harnessCall}`,
          dispose,
        };
      });

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ]);

      await runner(ctx);

      expect(disposes).toHaveLength(2);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes all sessions on failure', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        const dispose = mock(() => {});
        disposes.push(dispose);
        return {
          session: makeSession(() => 'done'),
          sessionId: `s-${harnessCall}`,
          dispose,
        };
      });

      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Fatal error', severity: 'critical' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({
            approved: z.boolean(),
            feedback: z.string().optional(),
            severity: z.string().optional(),
          }),
        },
      ]);

      await runner(ctx);

      // At least the harnesses that were created should be disposed
      expect(disposes.length).toBeGreaterThan(0);
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Refactor-preservation tests
  //
  // linear-steps-runner is being refactored to delegate boilerplate to the
  // shared runner-utils helpers: createSessionMap (step-indexed session
  // tracking), buildExecCtx (StepExecutionContext builder), handleRunnerError
  // (error envelope), and settleResult (where it fits). The tests below pin
  // down behaviors that the refactor MUST preserve — particularly the
  // severity-based / completeTask-branching settle logic that intentionally
  // stays custom and must NOT be replaced by settleResult (which never
  // branches on completeTask's boolean).
  // ═══════════════════════════════════════════════════════════════════════

  describe('rendererRegistry threading (buildExecCtx must forward rendererRegistry)', () => {
    it('fires onAgentRender with the rendered output when a renderer is registered for the step profile', async () => {
      setupProfileMocks();
      setupHarnessMocks(makeSession(() => '{"summary":"hello"}'));
      const registry = new RendererRegistry();
      registry.register('coder', (data) => `rendered:${JSON.stringify(data)}`);

      const onAgentRender = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        rendererRegistry: registry,
        onStatus: { onAgentRender } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep]);

      await runner(ctx);

      expect(onAgentRender).toHaveBeenCalledTimes(1);
      expect(onAgentRender).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: ctx.agentId,
          profile: 'coder',
          taskId: ctx.task.id,
          rendered: 'rendered:{"summary":"hello"}',
        }),
      );
    });

    it('does not fire onAgentRender when no rendererRegistry is provided', async () => {
      setupProfileMocks();
      setupHarnessMocks(makeSession(() => 'plain text'));

      const onAgentRender = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        onStatus: { onAgentRender } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep]);

      await runner(ctx);

      expect(onAgentRender).not.toHaveBeenCalled();
    });

    it('threads the same registry instance to every step in a multi-step run', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const registry = new RendererRegistry();
      registry.register('coder', (data) => `rendered:${JSON.stringify(data)}`);
      registry.register('reviewer', () => 'review-rendered');

      const onAgentRender = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        rendererRegistry: registry,
        onStatus: { onAgentRender } as Record<string, unknown>,
      });
      // Reviewer step has a schema; default to approving so it completes.
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true, feedback: 'ok', severity: 'low' },
        attempts: 1,
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // One render per step — confirms the registry reaches runStep for BOTH
      // steps, i.e. buildExecCtx did not drop rendererRegistry mid-loop.
      expect(onAgentRender).toHaveBeenCalledTimes(2);
    });
  });

  describe('onDecision fires on each rejection', () => {
    it('fires onDecision with the step name, attempt count, and feedback', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Needs more tests', severity: 'critical' },
        attempts: 1,
      });

      const onDecision = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        onStatus: { onDecision } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // With maxStepRetries=1 the single rejection fires onDecision once.
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: ctx.agentId,
          taskId: ctx.task.id,
          reasoning: 'Needs more tests',
          decision: 'Step "review" rejected (attempt 1/1), retrying',
        }),
      );
    });

    it('fires onDecision once per rejection across retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let call = 0;
      mockPromptForStructured.mockImplementation(() => {
        call++;
        return Promise.resolve({
          result: call < 3 ? { approved: false, feedback: `feedback-${call}`, severity: 'medium' } : { approved: true },
          attempts: 1,
        });
      });

      const onDecision = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        maxStepRetries: 5,
        onStatus: { onDecision } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      expect(onDecision).toHaveBeenCalledTimes(2);
    });

    it('does not fire onDecision when no step is rejected', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onDecision = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        onStatus: { onDecision } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep]);

      await runner(ctx);

      expect(onDecision).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // onDecision observe-hook (hookRegistry) firing
  //
  // The runner fires the `onDecision` OBSERVE hook (audit-log sink) ALONGSIDE
  // the `onStatus.onDecision` callback (event-store sink). These tests pin
  // down the hook-firing behavior so the extraction of fireOnDecisionHook()
  // is provably behavior-preserving. Both sinks fire independently; the
  // hook is a no-op when no hookRegistry or no subscribers.
  // ═════════════════════════════════════════════════════════════════

  describe('onDecision observe hook (hookRegistry) fires alongside onStatus', () => {
    /** Minimal fake HookRegistry for seam tests. `hasSubscribers` returns
     *  true ONLY for 'onDecision' so other seams (onStructuredOutput,
     *  beforeStepPrompt) stay dormant and don't add extra invokeObserve calls. */
    function makeFakeRegistry(hasSubs: boolean) {
      return {
        register: mock(() => {}),
        invokeObserve: mock(async () => {}),
        invokePipeline: mock(async () => undefined),
        invokeFirstWins: mock(async () => undefined),
        invokeAllRun: mock(async () => undefined),
        hasSubscribers: mock((name: string) => hasSubs && name === 'onDecision'),
      };
    }

    it('invokes the onDecision observe hook when a rejection occurs and subscribers exist', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Needs more tests', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(true);
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      expect(registry.invokeObserve).toHaveBeenCalledTimes(1);
      expect(registry.invokeObserve).toHaveBeenCalledWith(
        'onDecision',
        expect.objectContaining({
          agentId: ctx.agentId,
          taskId: ctx.task.id,
          phaseId: ctx.phaseId,
          decision: 'Step "review" rejected (attempt 1/1), retrying',
          reasoning: 'Needs more tests',
        }),
        expect.anything(),
      );
    });

    it('fires both onStatus.onDecision AND the observe hook (two separate sinks)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(true);
      const onStatusDecision = mock((_info: unknown) => {});
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
        onStatus: { onDecision: onStatusDecision } as Record<string, unknown>,
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // Both sinks receive the decision independently.
      expect(onStatusDecision).toHaveBeenCalledTimes(1);
      expect(registry.invokeObserve).toHaveBeenCalledTimes(1);
    });

    it('does NOT invoke the observe hook when hookRegistry has no subscribers', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(false);
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      expect(registry.invokeObserve).not.toHaveBeenCalled();
    });

    it('does NOT invoke the observe hook when no hookRegistry is provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      // No hookRegistry on the context at all.
      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // Smoke test — completes without error, no hook to assert on.
      expect(ctx.failTask).toHaveBeenCalled();
    });

    it('does NOT invoke the observe hook when no step is rejected', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const registry = makeFakeRegistry(true);
      const ctx = createRunnerContext({
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      });
      const runner = linearStepsRunner([implementStep]);

      await runner(ctx);

      expect(registry.invokeObserve).not.toHaveBeenCalled();
    });

    it('passes the correct hook context: cwd = worktreeCwd ?? ctx.cwd, workDir = ctx.cwd', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(true);
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
        cwd: '/tmp/project',
        worktreeCwd: '/wt/task-1',
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      const hookCtx = (registry.invokeObserve.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      expect(hookCtx.registry).toBe(registry);
      // worktreeCwd takes precedence over cwd.
      expect(hookCtx.cwd).toBe('/wt/task-1');
      // workDir is always the original ctx.cwd.
      expect(hookCtx.workDir).toBe('/tmp/project');
    });

    it('falls back to ctx.cwd when worktreeCwd is absent', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(true);
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
        cwd: '/tmp/project',
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      const hookCtx = (registry.invokeObserve.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      expect(hookCtx.cwd).toBe('/tmp/project');
      expect(hookCtx.workDir).toBe('/tmp/project');
    });

    it('includes the phaseId in the observe-hook args', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'fix it', severity: 'critical' },
        attempts: 1,
      });

      const registry = makeFakeRegistry(true);
      const ctx = createRunnerContext({
        maxStepRetries: 1,
        phaseId: 'review-phase',
        hookRegistry: registry as unknown as TaskRunnerContext['hookRegistry'],
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      const passedArgs = (registry.invokeObserve.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(passedArgs.phaseId).toBe('review-phase');
    });
  });

  describe('reviewFeedback is appended on rejection', () => {
    it('records each rejection feedback on task.reviewFeedback', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let call = 0;
      mockPromptForStructured.mockImplementation(() => {
        call++;
        return Promise.resolve({
          result:
            call === 1
              ? { approved: false, feedback: 'first round', severity: 'medium' }
              : { approved: false, feedback: 'second round', severity: 'critical' },
          attempts: 1,
        });
      });

      const ctx = createRunnerContext({ maxStepRetries: 2 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      expect(ctx.task.reviewFeedback).toEqual(['first round', 'second round']);
    });

    it('does not add reviewFeedback when no step is rejected', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([implementStep]);

      await runner(ctx);

      expect(ctx.task.reviewFeedback).toBeUndefined();
    });
  });

  // ── Custom settle logic (must NOT be replaced by settleResult) ───────────
  //
  // settleResult unconditionally returns 'completed' for approved results and
  // never branches on completeTask's boolean. The linear runner intentionally
  // keeps branching: if completeTask returns false the task is failed. These
  // tests lock that behavior in so the refactor cannot silently swap in
  // settleResult for these paths.

  describe('custom settle: completeTask returns false after all steps approved', () => {
    it('fails with "Failed to submit completed task" rather than reporting completed', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const ctx = createRunnerContext({
        completeTask: mock(() => false) as () => boolean,
      });
      const runner = linearStepsRunner([implementStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit completed task');
      expect(ctx.failTask).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Failed to submit completed task for review' }),
      );
    });
  });

  describe('custom settle: completeTask returns false on medium-severity exhaustion', () => {
    it('fails with "Failed to submit" rather than accepting as completed', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'minor issues', severity: 'medium' },
        attempts: 1,
      });

      const ctx = createRunnerContext({
        maxStepRetries: 1,
        completeTask: mock(() => false) as () => boolean,
      });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'Failed to submit');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to submit' }));
    });
  });

  describe('severity-based settle', () => {
    it('returns failed when severity is high', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Major issue', severity: 'high' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('feedback', 'Major issue');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Major issue', severity: 'high' }));
      expect(ctx.completeTask).not.toHaveBeenCalled();
    });

    it('returns completed when the rejected output has no severity field (defaults to medium)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'meh' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      // Review step without a severity field in its schema.
      const runner = linearStepsRunner([
        implementStep,
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
      ]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    });

    it('returns completed when severity is low', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Trivial nitpick', severity: 'low' },
        attempts: 1,
      });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      expect(ctx.completeTask).toHaveBeenCalledTimes(1);
      expect(ctx.failTask).not.toHaveBeenCalled();
    });

    it('passes the rejected step output to completeTask when accepting with caveats (medium)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const rejectedOutput = { approved: false, feedback: 'minor', severity: 'medium' };
      mockPromptForStructured.mockResolvedValue({ result: rejectedOutput, attempts: 1 });

      const ctx = createRunnerContext({ maxStepRetries: 1 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('completed');
      // The severity-settle accept path forwards the raw output to completeTask
      // so the caveats-laden result lands on task.result.
      expect(ctx.completeTask).toHaveBeenCalledWith(rejectedOutput);
    });

    it('still fails with feedback on high severity even if completeTask would succeed (severity checked first)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Major', severity: 'high' },
        attempts: 1,
      });

      // Even a completeTask stub that returns true must NOT be called when
      // severity is high — the failing-severity branch short-circuits before
      // the accept/completeTask branch.
      const completeTask = mock(() => true) as () => boolean;
      const ctx = createRunnerContext({ maxStepRetries: 1, completeTask });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('feedback', 'Major');
      expect(ctx.completeTask).not.toHaveBeenCalled();
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Major', severity: 'high' }));
    });
  });

  describe('error envelope: non-Error thrown values are coerced (handleRunnerError)', () => {
    it('coerces a thrown string into the failure error message via safeErrorMessage', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValue('a plain string failure');

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([implementStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', 'a plain string failure');
      expect(ctx.failTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'a plain string failure' }));
    });

    it('coerces a thrown number into the failure error message', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValue(404);

      const ctx = createRunnerContext();
      const runner = linearStepsRunner([implementStep]);

      const outcome = await runner(ctx);

      expect(outcome.status).toBe('failed');
      expect(outcome).toHaveProperty('error', '404');
    });
  });

  describe('error disposal ordering (handleRunnerError: dispose before failTask)', () => {
    it('disposes all tracked sessions before calling failTask', async () => {
      setupProfileMocks();
      const sequence: string[] = [];
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        // Capture the call number in a const so the dispose closure logs the
        // number that was current when this harness was created (not the
        // latest value of harnessCall at disposal time).
        const callNum = harnessCall;
        const dispose = mock(() => {
          sequence.push(`dispose-${callNum}`);
        });
        disposes.push(dispose);
        // First step succeeds and its session is tracked; second step throws.
        if (harnessCall === 1) {
          return { session: makeSession(() => 'done'), sessionId: 's-1', dispose };
        }
        throw new Error('second step boom');
      });

      const failTask = mock((_result?: unknown) => {
        sequence.push('failTask');
      });
      const ctx = createRunnerContext({ failTask });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // The first step's tracked session must be disposed on the error path,
      // and that disposal must happen BEFORE failTask runs.
      expect(disposes[0]).toHaveBeenCalledTimes(1);
      const firstDisposeIdx = sequence.indexOf('dispose-1');
      const failTaskIdx = sequence.indexOf('failTask');
      expect(firstDisposeIdx).toBeGreaterThanOrEqual(0);
      expect(failTaskIdx).toBeGreaterThan(firstDisposeIdx);
    });
  });

  describe('session replacement on back-up retry (createSessionMap.set disposes old)', () => {
    it('disposes the previous session for a step when it re-runs after a back-up', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCall = 0;
      mockCreateHarness.mockImplementation(() => {
        harnessCall++;
        const dispose = mock(() => {});
        disposes.push(dispose);
        return { session: makeSession(() => 'done'), sessionId: `s-${harnessCall}`, dispose };
      });

      let structuredCall = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCall++;
        return Promise.resolve({
          result:
            structuredCall === 1
              ? { approved: false, feedback: 'retry please', severity: 'medium' }
              : { approved: true },
          attempts: 1,
        });
      });

      const ctx = createRunnerContext({ maxStepRetries: 3 });
      const runner = linearStepsRunner([implementStep, reviewStep]);

      await runner(ctx);

      // Execution: implement(1), review(2, reject), implement(3, retry), review(4, approve)
      expect(disposes).toHaveLength(4);
      // Each session disposed exactly once: old sessions disposed on overwrite,
      // final sessions disposed on disposeAll(). No leaks, no double-dispose.
      for (const d of disposes) {
        expect(d).toHaveBeenCalledTimes(1);
      }
    });
  });
});
