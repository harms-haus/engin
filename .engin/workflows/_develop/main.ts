import type { WorkflowModule, WorkflowRunOptions } from '@harms-haus/engin';
import { createHarness, loadProfilesFromDirs, resolveProfilesDirs } from '@harms-haus/engin';

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

    // ── Phase: initialization ──────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'initialization', round: 1 });

    // Generate a concise title using the pi agent
    let title: string;
    try {
      const profilesDirs = resolveProfilesDirs(options.cwd, 'develop');
      const profiles = await loadProfilesFromDirs(profilesDirs);
      const profile = profiles.values().next().value;

      if (profile) {
        const harness = createHarness({
          profile,
          cwd: options.cwd,
          apiKeys: options.apiKeys,
          onAgentStatus: {
            onTurnStart: (info) => onStatus?.onTurnStart?.(info),
            onTurnEnd: (info) => onStatus?.onTurnEnd?.(info),
            onToolCallStart: (info) => onStatus?.onToolCallStart?.(info),
            onToolCallEnd: (info) => onStatus?.onToolCallEnd?.(info),
          },
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
    } catch {
      title = taskPrompt.slice(0, 50) + '...';
    }

    // Update sidebar with generated title and initialization indicator
    onStatus?.onSidebarUpdate?.({ title, indicator: '🔧' });
    onStatus?.onPhaseComplete?.({ phase: 'initialization', durationMs: 0 });

    // ── Remaining phases (stubs for future work) ──────────────────────────
    const remainingPhases = DEVELOP_PHASES.filter((p) => p.id !== 'initialization' && p.id !== 'done');

    for (const phase of remainingPhases) {
      onStatus?.onPhaseStart?.({ phase: phase.id, round: 1 });
      onStatus?.onSidebarUpdate?.({ indicator: phase.icon });

      // Simulate minimal processing delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      onStatus?.onPhaseComplete?.({ phase: phase.id, durationMs: 0 });
    }

    // ── Phase: done ────────────────────────────────────────────────────────
    onStatus?.onPhaseStart?.({ phase: 'done', round: 1 });
    onStatus?.onSidebarUpdate?.({ indicator: '🎉' });
    onStatus?.onPhaseComplete?.({ phase: 'done', durationMs: 0 });

    // ── Signal workflow complete ───────────────────────────────────────────
    onStatus?.onWorkflowComplete?.({ totalDurationMs: 0, agentCount: 1 });
  },
} satisfies WorkflowModule;
