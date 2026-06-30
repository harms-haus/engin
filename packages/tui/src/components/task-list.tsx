import type { TaskEntity, TaskStatus } from '@engin/shared';
import { formatElapsed } from '@engin/shared/text-utils';
import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TASK_LIST_MAX_VISIBLE } from '../layout-constants.js';
import { statusColorMap, statusIconMap } from '../theme.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Buffer appended to `colWidths.title` to accommodate the elapsed segment
 * (" - 5s", " - 1m 23s", etc.) on the same line. `formatElapsed` produces at
 * most ~9 characters (e.g. "59m 59s", "1h 23m"); add 3 for " - " prefix → 12.
 * Using a constant instead of dynamic per-task width keeps colWidths stable
 * across 1-second ticks (the <TaskElapsed> component handles its own re-render).
 */
const ELAPSED_BUFFER = 12;

// ─── Props ──────────────────────────────────────────────────────────────────

export interface TaskListProps {
  tasks: TaskEntity[];
  selectedTaskId: string | null;
  sessionCounts: Record<string, number>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Builds a map of task id → compact display label (e.g. `t-01`),
 * assigned in creation/registration order.
 */
function computeIdLabels(tasks: TaskEntity[]): Map<string, string> {
  const width = Math.max(2, String(tasks.length).length);
  const map = new Map<string, string>();
  tasks.forEach((task, i) => {
    map.set(task.id, 't-' + String(i + 1).padStart(width, '0'));
  });
  return map;
}

/**
 * Computes how many task rows fit in the current viewport given
 * `scrollOffset`. Reserves one slot for a top indicator when scrolled
 * down, and one for a bottom indicator when more tasks remain below.
 */
function getViewportTaskCount(taskCount: number, scrollOffset: number, maxVisibleLines: number): number {
  const hasAbove = scrollOffset > 0;
  let slots = maxVisibleLines - (hasAbove ? 1 : 0);
  const remaining = taskCount - scrollOffset;
  const hasBelow = remaining > slots;
  if (hasBelow) slots -= 1;
  return Math.min(slots, remaining);
}

/**
 * Difference-array algorithm: finds the scrollOffset that MAXIMIZES
 * visible active+parked tasks. See old widget _autoScrollToActive for
 * full docstring.
 */
function autoScrollToActive(tasks: TaskEntity[], currentOffset: number, maxVisibleLines: number): number {
  if (tasks.length === 0) return 0;

  const W = maxVisibleLines;
  const activeIndices: number[] = [];
  tasks.forEach((task, i) => {
    if (task.status === 'active' || task.status === 'parked') activeIndices.push(i);
  });
  if (activeIndices.length === 0) return currentOffset;

  const maxOffset = tasks.length - 1;

  const count = new Array<number>(maxOffset + 2).fill(0);
  for (const i of activeIndices) {
    count[Math.max(0, i - W + 1)] += 1;
    count[Math.min(maxOffset + 1, i + 1)] -= 1;
  }
  for (let s = 1; s <= maxOffset; s++) {
    count[s] += count[s - 1];
  }

  let bestCount = -1;
  let bestOffset = 0;
  for (let s = 0; s <= maxOffset; s++) {
    if (count[s] > bestCount) {
      bestCount = count[s];
      bestOffset = s;
    }
  }

  const current = Math.max(0, Math.min(currentOffset, maxOffset));
  let chosen: number;
  if (count[current] === bestCount) {
    chosen = current;
  } else {
    chosen = bestOffset;
  }
  return Math.max(0, Math.min(chosen, maxOffset));
}

/**
 * Adjusts `scrollOffset` so the task at `index` is within the viewport.
 */
function ensureVisible(index: number, scrollOffset: number, taskCount: number, maxVisibleLines: number): number {
  if (index < scrollOffset) return index;
  let offset = scrollOffset;
  while (offset + getViewportTaskCount(taskCount, offset, maxVisibleLines) <= index && offset < taskCount - 1) {
    offset++;
  }
  return offset;
}

// ─── TaskElapsed Component ────────────────────────────────────────────
//
// Renders just the elapsed-time segment (" - 5s") for a task row.
// Manages its own internal `now` state via setInterval so the parent
// TaskList does not re-render on every tick. Only active tasks with
// `activeStartedAt` trigger the interval; all other statuses render
// a static (frozen) elapsed value.

function TaskElapsed({ task }: { task: TaskEntity }): ReactNode {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (task.status !== 'active' || task.activeStartedAt === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [task.status, task.activeStartedAt]);

  if (
    task.startedAt === undefined ||
    (task.status !== 'active' &&
      task.status !== 'parked' &&
      task.status !== 'complete' &&
      task.status !== 'failed' &&
      task.status !== 'cancelled')
  ) {
    return null;
  }

  const elapsedMs =
    task.status === 'active' && task.activeStartedAt !== undefined
      ? (task.elapsedMs ?? 0) + (now - task.activeStartedAt)
      : (task.elapsedMs ?? 0);

  return <Text dimColor> - {formatElapsed(elapsedMs)}</Text>;
}

// ─── TaskList Component ─────────────────────────────────────────────────────

export const TaskList: React.FC<TaskListProps> = ({ tasks, selectedTaskId, sessionCounts }) => {
  const [scrollOffset, setScrollOffset] = useState(0);

  // ── Refs for change detection ──────────────────────────────────────────
  const prevTaskIdsStrRef = useRef<string | null>(null);
  const prevStatusesRef = useRef<Map<string, TaskStatus>>(new Map());

  // Current task IDs as a string for simple comparison
  const currentIdsStr = useMemo(() => tasks.map((t) => t.id).join(','), [tasks]);

  // ── ID labels (memoised) ───────────────────────────────────────────────
  const idLabels = useMemo(() => computeIdLabels(tasks), [tasks]);

  // ── Task map for dep lookups ───────────────────────────────────────────
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // ── Reset scrollOffset when task set changes ──────────────────────────
  useEffect(() => {
    if (prevTaskIdsStrRef.current !== null && prevTaskIdsStrRef.current !== currentIdsStr) {
      setScrollOffset(0);
    }
    prevTaskIdsStrRef.current = currentIdsStr;
  }, [currentIdsStr]);

  // ── Auto-scroll when a task transitions to active/parked ──────────────
  useEffect(() => {
    const prevStatuses = prevStatusesRef.current;
    const newlyActive = tasks.some(
      (t) =>
        (t.status === 'active' || t.status === 'parked') &&
        prevStatuses.has(t.id) &&
        prevStatuses.get(t.id) !== 'active' &&
        prevStatuses.get(t.id) !== 'parked',
    );
    if (newlyActive) {
      setScrollOffset((current) => autoScrollToActive(tasks, current, TASK_LIST_MAX_VISIBLE));
    }
    const newPrevStatuses = new Map<string, TaskStatus>();
    for (const t of tasks) {
      newPrevStatuses.set(t.id, t.status);
    }
    prevStatusesRef.current = newPrevStatuses;
  }, [tasks]);

  // ── Ensure selected task is visible ───────────────────────────────────
  useEffect(() => {
    if (selectedTaskId !== null) {
      const idx = tasks.findIndex((t) => t.id === selectedTaskId);
      if (idx >= 0) {
        setScrollOffset((current) => ensureVisible(idx, current, tasks.length, TASK_LIST_MAX_VISIBLE));
      }
    }
  }, [selectedTaskId, tasks]);

  // ── Viewport computation ──────────────────────────────────────────────

  const clampedOffset = useMemo(() => {
    if (tasks.length <= TASK_LIST_MAX_VISIBLE) return 0;
    return Math.max(0, Math.min(scrollOffset, tasks.length - 1));
  }, [scrollOffset, tasks.length]);

  const viewportStart = clampedOffset;
  const viewportEnd = useMemo(() => {
    if (tasks.length <= TASK_LIST_MAX_VISIBLE) return tasks.length;
    return viewportStart + getViewportTaskCount(tasks.length, viewportStart, TASK_LIST_MAX_VISIBLE);
  }, [viewportStart, tasks.length]);

  const visibleTasks = useMemo(() => tasks.slice(viewportStart, viewportEnd), [tasks, viewportStart, viewportEnd]);

  const hasAbove = viewportStart > 0;
  const hasBelow = viewportStart + visibleTasks.length < tasks.length;
  const hiddenBelow = tasks.length - (viewportStart + visibleTasks.length);

  // ── Compute column widths from visible tasks ─────────────────────────
  //
  // The title-column width includes a fixed ELAPSED_BUFFER so the inline
  // <TaskElapsed> segment (" - 5s") never wraps to a new line. The buffer
  // is constant, so colWidths stays stable across 1-second ticks even
  // though the elapsed value changes (the isolated <TaskElapsed> component
  // manages its own re-render).

  const colWidths = useMemo(() => {
    let icon = 0;
    let id = 0;
    let title = 0;
    let step = 0;
    let deps = 0;

    for (const task of visibleTasks) {
      // Icon width
      const iconLen = statusIconMap[task.status].length;
      if (iconLen > icon) icon = iconLen;

      // ID label width
      const idLabel = idLabels.get(task.id) ?? task.id;
      if (idLabel.length > id) id = idLabel.length;

      // Title width: reserve space for title + elapsed segment so the
      // inline <TaskElapsed> content fits on one line. The constant buffer
      // keeps colWidths stable across 1-second ticks.
      const effectiveTitleLen = task.title.length + ELAPSED_BUFFER;
      if (effectiveTitleLen > title) title = effectiveTitleLen;

      // Step/session column width
      let stepStr = '';
      const sessionCount = sessionCounts[task.id] ?? 0;
      if (task.status === 'active' || task.status === 'parked') {
        if (task.sessionPlan && task.sessionPlan.length > 0) {
          const total = task.sessionPlan.length;
          const done = Math.min(sessionCount, total);
          stepStr = `●${done}/${total}`;
        } else if (sessionCount > 0) {
          stepStr = `${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
        }
      }
      if (stepStr.length > step) step = stepStr.length;

      // Dependencies column width
      if (task.dependencies.length > 0) {
        const depsParts = task.dependencies.map((depId) => {
          const label = idLabels.get(depId) ?? depId;
          return label;
        });
        const depsStr = depsParts.join(', ');
        if (depsStr.length > deps) deps = depsStr.length;
      }
    }

    return { icon, id, title, step, deps };
  }, [visibleTasks, idLabels, sessionCounts]);

  // ── Build row content ─────────────────────────────────────────────────

  const GAP = '  ';

  const buildRow = (task: TaskEntity): ReactNode => {
    const selected = task.id === selectedTaskId;
    const color = statusColorMap[task.status];

    // Icon cell
    const icon = statusIconMap[task.status];

    // ID cell
    const idLabel = idLabels.get(task.id) ?? task.id;

    // Title + elapsed cell (elapsed is rendered by the isolated
    // TaskElapsed component so only that sub-tree re-renders on tick).
    const titleContent = (
      <>
        {task.title}
        <TaskElapsed task={task} />
      </>
    );

    // Step/session cell
    let stepStr = '';
    const sessionCount = sessionCounts[task.id] ?? 0;
    if (task.status === 'active' || task.status === 'parked') {
      if (task.sessionPlan && task.sessionPlan.length > 0) {
        const total = task.sessionPlan.length;
        const done = Math.min(sessionCount, total);
        stepStr = `●${done}/${total}`;
      } else if (sessionCount > 0) {
        stepStr = `${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
      }
    }

    // Dependencies cell
    const hasDeps = task.dependencies.length > 0;

    return (
      <Box key={task.id} flexDirection="row">
        {/* Icon */}
        <Box width={colWidths.icon}>
          <Text bold={selected}>{icon}</Text>
        </Box>
        <Text>{GAP}</Text>
        {/* ID */}
        <Box width={colWidths.id}>
          <Text dimColor bold={selected}>
            {idLabel}
          </Text>
        </Box>
        <Text>{GAP}</Text>
        {/* Title + elapsed */}
        <Box width={colWidths.title}>
          <Text color={color} bold={selected}>
            {titleContent}
          </Text>
        </Box>
        {/* Step column */}
        {colWidths.step > 0 && (
          <>
            <Text>{GAP}</Text>
            <Box width={colWidths.step}>
              <Text dimColor bold={selected}>
                {stepStr}
              </Text>
            </Box>
          </>
        )}
        {/* Deps column */}
        {colWidths.deps > 0 && (
          <>
            <Text>{GAP}</Text>
            <Box width={colWidths.deps}>
              <Text bold={selected}>
                {hasDeps ? (
                  <>
                    {task.dependencies.map((depId, i) => {
                      const depTask = taskMap.get(depId);
                      const depLabel = idLabels.get(depId) ?? depId;
                      const isDepComplete = depTask !== undefined && depTask.status === 'complete';
                      return (
                        <React.Fragment key={depId}>
                          {i > 0 && <Text>, </Text>}
                          <Text dimColor={isDepComplete}>{depLabel}</Text>
                        </React.Fragment>
                      );
                    })}
                  </>
                ) : (
                  <Text>{' '.repeat(colWidths.deps)}</Text>
                )}
              </Text>
            </Box>
          </>
        )}
      </Box>
    );
  };

  // ── Assemble rows ─────────────────────────────────────────────────────

  const rows: ReactNode[] = [];

  if (hasAbove) {
    rows.push(
      <Box key="top-indicator" height={1}>
        <Text dimColor>↑ {viewportStart} more above (↑/↓)</Text>
      </Box>,
    );
  }

  for (const task of visibleTasks) {
    rows.push(buildRow(task));
  }

  if (hasBelow) {
    rows.push(
      <Box key="bottom-indicator" height={1}>
        <Text dimColor>↓ {hiddenBelow} more below (↑/↓)</Text>
      </Box>,
    );
  }

  // Pad to target height for consistent layout computation
  const showViewport = tasks.length > TASK_LIST_MAX_VISIBLE;
  const targetHeight = Math.min(TASK_LIST_MAX_VISIBLE, tasks.length);
  const paddingCount = showViewport ? Math.max(0, targetHeight - rows.length) : 0;
  for (let i = 0; i < paddingCount; i++) {
    rows.push(
      <Box key={`pad-${i}`} height={1}>
        <Text> </Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {rows}
    </Box>
  );
};
