/**
 * Layout constants for the TUI — viewport-height contract.
 *
 * Central reference for how many terminal rows each panel reserves.
 * Used by Dashboard, App (height estimation), and TaskList (viewport cap).
 */

/** Maximum task rows visible in the task-list viewport. */
export const TASK_LIST_MAX_VISIBLE = 20;

/** AgentLog row count when collapsed (default state). */
export const AGENT_LOG_COLLAPSED_LINES = 20;

/** AgentLog row count when expanded. */
export const AGENT_LOG_EXPANDED_LINES = 40;
