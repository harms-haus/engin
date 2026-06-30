/**
 * Dashboard — Ink-based composite dashboard component.
 *
 * Renders the three-panel layout: PhaseBar → TaskList → AgentLog,
 * reading all state from a {@link TuiStore}.
 *
 * Props: { store: TuiStore }
 *
 * The Dashboard is PURELY PRESENTATIONAL — it does NOT handle input.
 * Input (keyboard navigation) is handled by {@link WorkflowTUI} / {@link App}
 * via store methods (selectPhase, selectTask, selectNextSession, toggleExpand).
 */

import { Box, Text, useWindowSize } from 'ink';
import React, { useMemo } from 'react';
import { useTuiStore } from '../hooks/use-tui-store.js';
import { AGENT_LOG_COLLAPSED_LINES, AGENT_LOG_EXPANDED_LINES } from '../layout-constants.js';
import type { TuiStore } from '../tui-store.js';
import { AgentLog } from './agent-log.js';
import { PhaseBar } from './phase-bar.js';
import { TaskList } from './task-list.js';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface DashboardProps {
  store: TuiStore;
}

// ─── Dashboard Component ─────────────────────────────────────────────────────

export const Dashboard: React.FC<DashboardProps> = ({ store }) => {
  // Subscribe to store changes (re-renders on every notify()).
  useTuiStore(store);

  // Read current projection state from the ClientStore.
  const state = store.getClientStoreState();

  const {
    phases,
    currentPhaseId,
    completedPhaseIds,
    tasks,
    sessions,
    selectedPhaseId,
    selectedTaskId,
    selectedSessionId,
    sidebar,
  } = state;

  const isLogExpanded = store.isLogExpanded;

  // Effective phase: selectedPhaseId if set, otherwise currentPhaseId.
  const effectivePhaseId = selectedPhaseId ?? currentPhaseId;

  // Frame & separator widths. The bordered dashboard renders at
  // `columns - 1` (NOT the full terminal width) to avoid the classic
  // "phantom last column" clip: a glyph written to the terminal's FINAL
  // cell is eaten because the cursor enters a pending-wrap state, so every
  // line would lose its rightmost character (the right `│` / `┐` / `┘`
  // border). Rendering one column short keeps the right border in a safe
  // cell. `innerWidth` is the frame width minus the 2 border walls, used for
  // the full-width section separators (a bare `<Box borderTop/>` renders
  // nothing in Ink without a `borderStyle`, and a bare `<Text>` rule collapses
  // the phase bar, so dividers are explicit `<Text>` horizontal rules).
  const { columns } = useWindowSize();
  const frameWidth = Math.max(1, (columns ?? 80) - 1);
  const innerWidth = Math.max(0, frameWidth - 2);
  // Wrap the rule in a `<Box flexShrink={0}>` so the long unbroken string
  // cannot distort the column flex layout (a bare `<Text>` flex item would
  // collapse siblings such as the phase bar).
  const separator = (
    <Box flexShrink={0}>
      <Text color="gray">{'─'.repeat(innerWidth)}</Text>
    </Box>
  );

  // Filter tasks by the effective phase.
  const phaseTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.phaseId === effectivePhaseId),
    [tasks, effectivePhaseId],
  );

  // Filter sessions by BOTH selected task AND effective phase (plan review).
  const taskSessions = useMemo(
    () => Object.values(sessions).filter((s) => s.taskId === selectedTaskId && s.phaseId === effectivePhaseId),
    [sessions, selectedTaskId, effectivePhaseId],
  );

  // Per-task session counts, filtering by effective phase (plan review H3).
  const sessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of Object.values(sessions)) {
      if (session.phaseId === effectivePhaseId && session.taskId !== undefined) {
        counts[session.taskId] = (counts[session.taskId] ?? 0) + 1;
      }
    }
    return counts;
  }, [sessions, effectivePhaseId]);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" width={frameWidth} flexShrink={0}>
      {/* ── Phase bar ─────────────────────────────────────────── */}
      <PhaseBar
        phases={phases}
        currentPhaseId={currentPhaseId}
        completedPhaseIds={completedPhaseIds}
        selectedPhaseId={selectedPhaseId ?? ''}
        indicator={sidebar?.indicator}
      />

      {/* ── Separator (phase bar / task list) ─────────────────── */}
      {separator}

      {/* ── Task list ─────────────────────────────────────────── */}
      <TaskList tasks={phaseTasks} selectedTaskId={selectedTaskId} sessionCounts={sessionCounts} />

      {/* ── Separator (task list / agent log) ─────────────────── */}
      {separator}

      {/* ── Agent log ─────────────────────────────────────────── */}
      <AgentLog
        sessions={taskSessions}
        selectedSessionId={selectedSessionId}
        expanded={isLogExpanded}
        collapsedLines={AGENT_LOG_COLLAPSED_LINES}
        expandedLines={AGENT_LOG_EXPANDED_LINES}
      />
    </Box>
  );
};
