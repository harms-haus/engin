/**
 * App — Root Ink component for the engin TUI.
 *
 * Layout (plan review M1): EventLog on TOP, separator, Dashboard on BOTTOM.
 *
 * Contains the internal {@link WorkflowInput} component that handles keyboard
 * input and dispatches to the store.
 */

import { OverlayHost, useInputCaptureState } from '@harms-haus/ink-overlay';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';
import { Dashboard } from './components/dashboard.js';
import { DetachKillPrompt, type DetachKillAction } from './components/detach-kill-prompt.js';
import { EventLog } from './components/event-log.js';
import { QrOverlay } from './components/qr-overlay.js';
import { useTuiStore } from './hooks/use-tui-store.js';
import { AGENT_LOG_COLLAPSED_LINES, AGENT_LOG_EXPANDED_LINES, TASK_LIST_MAX_VISIBLE } from './layout-constants.js';
import type { TuiStore } from './tui-store.js';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface AppProps {
  store: TuiStore;
}

// ─── Separator line ─────────────────────────────────────────────────────────

const SEPARATOR = '─';

// ─── WorkflowInput ──────────────────────────────────────────────────────────
//
// Internal component rendered inside OverlayHost so useInputCaptureState works.
// Has TWO useInput hooks:
//
//   Handler 1 (isActive: true ALWAYS):
//     Ctrl+D → store.invokeDetach() — works even when overlay captures.
//
//   Handler 2 (isActive: !isCaptured):
//     Ctrl+C → resolvePause or showPrompt
//     Ctrl+Q → toggleQr
//     ←/→   → phase navigation (wrap)
//     ↑/↓   → task navigation (when collapsed), AgentLog handles expanded
//     Tab   → cycle sessions
//     Space → toggle expand

function WorkflowInput({ store }: { store: TuiStore }) {
  const isCaptured = useInputCaptureState();

  // Handler 1: ALWAYS active — Ctrl+D detach.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'd') {
        store.invokeDetach();
      }
    },
    { isActive: true },
  );

  // Handler 2: gated by isCaptured.
  useInput(
    (input, key) => {
      // ── Ctrl+C: inspect-vs-prompt split ────────────────────────
      if (key.ctrl && input === 'c') {
        if (store.inspecting) {
          store.resolvePause?.();
        } else {
          store.showPrompt();
        }
        return;
      }

      // ── Ctrl+Q: toggle QR overlay ──────────────────────────────
      if (key.ctrl && input === 'q') {
        store.toggleQr();
        return;
      }

      // ── Left / Right: phase navigation (wrap) ──────────────────
      if (key.leftArrow || key.rightArrow) {
        const state = store.getClientStoreState();
        const phaseIds = state.phases.map((p) => p.id);
        if (phaseIds.length === 0) return;

        const currentId = state.selectedPhaseId ?? state.currentPhaseId;
        const currentIdx = phaseIds.indexOf(currentId);
        let newIdx: number;
        if (key.leftArrow) {
          newIdx = currentIdx <= 0 ? phaseIds.length - 1 : currentIdx - 1;
        } else {
          newIdx = currentIdx < 0 || currentIdx >= phaseIds.length - 1 ? 0 : currentIdx + 1;
        }
        store.selectPhase(phaseIds[newIdx]);
        return;
      }

      // ── Up / Down: task navigation (when collapsed) ────────────
      if (key.upArrow || key.downArrow) {
        // AgentLog handles its own scroll via useInput when expanded.
        if (store.isLogExpanded) return;

        const state = store.getClientStoreState();
        const effectivePhaseId = state.selectedPhaseId ?? state.currentPhaseId;
        const phaseTasks = Object.values(state.tasks).filter((t) => t.phaseId === effectivePhaseId);
        if (phaseTasks.length === 0) return;

        const currentIdx = phaseTasks.findIndex((t) => t.id === state.selectedTaskId);
        let newIdx: number;
        if (key.upArrow) {
          newIdx = currentIdx <= 0 ? phaseTasks.length - 1 : currentIdx - 1;
        } else {
          newIdx = currentIdx < 0 || currentIdx >= phaseTasks.length - 1 ? 0 : currentIdx + 1;
        }
        store.selectTask(phaseTasks[newIdx].id);
        return;
      }

      // ── Tab / Shift+Tab: cycle sessions ────────────────────────
      if (key.tab) {
        store.selectNextSession(key.shift ? -1 : 1);
        return;
      }

      // ── Space: toggle expand/collapse ──────────────────────────
      if (input === ' ') {
        store.toggleExpand();
        return;
      }
    },
    { isActive: !isCaptured },
  );

  return null;
}

// ─── App Component ──────────────────────────────────────────────────────────

export function App({ store }: AppProps) {
  // Subscribe to store changes.
  useTuiStore(store);

  // Terminal dimensions for dynamic layout.
  const { rows, columns } = useWindowSize();

  const state = store.getClientStoreState();
  const isLogExpanded = store.isLogExpanded;

  // Compute effective phase and count its tasks for dashboard height
  // estimation (avoids allocating the filtered array).
  const effectivePhaseId = state.selectedPhaseId ?? state.currentPhaseId;
  const phaseTaskCount = useMemo(() => {
    let count = 0;
    for (const task of Object.values(state.tasks)) {
      if (task.phaseId === effectivePhaseId) count++;
    }
    return count;
  }, [state.tasks, effectivePhaseId]);

  // Estimate dashboard height in terminal rows:
  //   1 (phase bar) + 1 (separator) + min(20, phaseTaskCount) (task list)
  //   + 1 (separator) + (expanded ? 40 : 20) (agent log) + 2 (border top+bottom)
  const taskListLines = Math.min(TASK_LIST_MAX_VISIBLE, phaseTaskCount);
  const agentLogLines = isLogExpanded ? AGENT_LOG_EXPANDED_LINES : AGENT_LOG_COLLAPSED_LINES;
  const dashboardHeight = 1 + 1 + taskListLines + 1 + agentLogLines + 2;

  // Event log maxLines: fill remaining terminal rows.
  const eventLogMaxLines = Math.max(3, rows - dashboardHeight - 1);

  return (
    <OverlayHost>
      <Box flexDirection="column" height={rows}>
        {/* ── EventLog on TOP ─────────────────────────────────── */}
        <EventLog lines={store.eventLogLines} maxLines={eventLogMaxLines} />

        {/* ── Separator ───────────────────────────────────────── */}
        <Text dimColor>{SEPARATOR.repeat(Math.max(0, columns ?? 80))}</Text>

        {/* ── Dashboard on BOTTOM ─────────────────────────────── */}
        <Dashboard store={store} />

        {/* ── Overlays ────────────────────────────────────────── */}
        <DetachKillPrompt
          open={store.promptVisible}
          runId={store.runId}
          onConfirm={(action: DetachKillAction) => {
            if (action === 'detach') {
              store.invokeDetach();
            } else {
              store.invokeKill();
            }
            store.dismissPrompt();
          }}
          onDismiss={() => {
            store.dismissPrompt();
          }}
        />

        <QrOverlay open={store.qrVisible} qrString={store.qrString} />

        {/* ── Input handler (renders nothing) ─────────────────── */}
        <WorkflowInput store={store} />
      </Box>
    </OverlayHost>
  );
}
