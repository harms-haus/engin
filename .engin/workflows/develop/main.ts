import type { WorkflowModule, WorkflowRunOptions } from '@harms-haus/engin';
import {
  createHarness,
  forwardAgentStatus,
  LanePool,
  loadProfilesFromDirs,
  resolveProfilesDirs,
  TaskTracker,
} from '@harms-haus/engin';

// ─── Phases ─────────────────────────────────────────────────────────────────

const DEVELOP_PHASES = [
  { id: 'initialization', label: 'Initialization', icon: '🔧' },
  { id: 'scouting', label: 'Scouting', icon: '🔍' },
  { id: 'scouting_review', label: 'Scouting Review', icon: '📋' },
  { id: 'planning', label: 'Planning', icon: '📝' },
  { id: 'plan_review', label: 'Plan Review', icon: '👀' },
  { id: 'implementing', label: 'Implementing', icon: '🔨' },
  { id: 'final_review', label: 'Final Review', icon: '✅' },
  { id: 'done', label: 'Done', icon: '🎉' },
];

// ─── Workflow Module ────────────────────────────────────────────────────────

export default {
  name: 'develop',
  description: 'Multi-agent development workflow',

  async run(taskPrompt: string, options: WorkflowRunOptions): Promise<void> {
    const { onStatus } = options;

    // 1. Declare phases to frontend
    onStatus?.onSidebarUpdate?.({ phases: DEVELOP_PHASES });

    // 2. Signal workflow start
    onStatus?.onWorkflowStart?.({
      taskPrompt,
      resumed: false,
      workDir: options.workDir,
    });

    // Resolve profiles dirs once for the entire workflow
    const profilesDirs = resolveProfilesDirs(options.cwd, 'develop');

    // ── Phase: initialization ──────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'initialization', round: 1 });

    // Generate a concise title using the pi agent
    let title: string;
    try {
      const profiles = await loadProfilesFromDirs(profilesDirs);
      const profile = profiles.values().next().value;

      if (profile) {
        const harness = createHarness({
          profile,
          cwd: options.cwd,
          apiKeys: options.apiKeys,
          onAgentStatus: forwardAgentStatus(onStatus),
        });

        onStatus?.onAgentSpawn?.({
          agentId: 'title-generator',
          profile: profile.id,
          phase: 'initialization',
        });

        const { session, dispose } = await harness;

        await session.prompt(
          'Generate a concise title (3-6 words) summarizing this task. Return ONLY the title:\n\n' + taskPrompt,
        );

        const responseText = session.getLastAssistantText() ?? '';
        title = responseText.trim();

        dispose();

        onStatus?.onAgentComplete?.({
          agentId: 'title-generator',
          profile: profile.id,
          phase: 'initialization',
        });
      } else {
        title = taskPrompt.slice(0, 50) + '...';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus?.onError?.({ agentId: 'title-generator', error: msg, phase: 'initialization' });
      title = taskPrompt.slice(0, 50) + '...';
    }

    // Update sidebar with generated title and initialization indicator
    onStatus?.onSidebarUpdate?.({ title, indicator: '🔧' });
    onStatus?.onPhaseComplete?.({ phase: 'initialization', durationMs: 0 });

    // ── Pre-implementation phases (stubs for future work) ──────────────────
    const preImplPhases = DEVELOP_PHASES.filter(
      (p) => p.id !== 'initialization' && p.id !== 'implementing' && p.id !== 'final_review' && p.id !== 'done',
    );

    for (const phase of preImplPhases) {
      onStatus?.onPhaseStart?.({ phase: phase.id, round: 1 });
      onStatus?.onSidebarUpdate?.({ indicator: phase.icon });

      // Simulate minimal processing delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      onStatus?.onPhaseComplete?.({ phase: phase.id, durationMs: 0 });
    }

    // ── Phase: implementing ────────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'implementing', round: 1 });
    onStatus?.onSidebarUpdate?.({ indicator: '🔨' });

    // Run the LanePool for concurrent task processing
    const taskTracker = new TaskTracker();
    const pool = new LanePool({
      maxConcurrentLanes: 1,
      profilesDirs,
      sessionBaseDir: options.workDir,
      cwd: options.cwd,
      apiKeys: options.apiKeys,
      onStatus,
      taskTracker,
      getStepsForTask: () => [],
    });
    const poolResult = await pool.run();

    onStatus?.onPhaseComplete?.({ phase: 'implementing', durationMs: 0 });

    // ── Failed-task gate: halt if there are failures ───────────────────────
    if (poolResult.failedTasks > 0) {
      onStatus?.onWorkflowFailed?.({
        error: new Error(`${poolResult.failedTasks} task(s) failed during implementation`),
        phase: 'implementing',
      });
      return;
    }

    // ── Phase: final_review ────────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'final_review', round: 1 });
    onStatus?.onSidebarUpdate?.({ indicator: '✅' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    onStatus?.onPhaseComplete?.({ phase: 'final_review', durationMs: 0 });

    // ── Phase: done ────────────────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'done', round: 1 });
    onStatus?.onSidebarUpdate?.({ indicator: '🎉' });
    onStatus?.onPhaseComplete?.({ phase: 'done', durationMs: 0 });

    // ── Signal workflow complete ───────────────────────────────────────────
    onStatus?.onWorkflowComplete?.({ totalDurationMs: 0, agentCount: 1 });
  },
} satisfies WorkflowModule;
