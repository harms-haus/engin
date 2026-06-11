import type { AgentWindowState, LogEntry, PhaseDescriptor, SidebarInfo, WorkflowSummary } from './types.js';

// ─── Internal RunEntry ──────────────────────────────────────────────────────

interface RunEntry {
  id: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed';
  sidebar: SidebarInfo;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  currentPhase: string;
  completedPhases: string[];
  agents: Map<string, AgentWindowState>;
  abortController: AbortController;
}

// ─── RunRegistry ────────────────────────────────────────────────────────────

/**
 * Tracks active and past workflow runs in memory.
 *
 * All run records are kept in insertion order so that clients can display a
 * stable, chronological list.  The registry exposes a high-level API that the
 * WebSocket server calls as workflow lifecycle events fire.
 */
export class RunRegistry {
  private runs = new Map<string, RunEntry>();
  private order: string[] = [];

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Create a new workflow run and return its unique ID.
   *
   * @param workflowName - Human-readable name for the workflow.
   * @param options - Optional overrides for id and startedAt. When omitted,
   *                  a random UUID and the current timestamp are used.
   */
  createRun(workflowName: string, options?: { id?: string; startedAt?: string }): string {
    const id = options?.id ?? crypto.randomUUID();
    const entry: RunEntry = {
      id,
      workflowName,
      status: 'running',
      sidebar: { title: workflowName, indicator: '...' },
      startedAt: options?.startedAt ?? new Date().toISOString(),
      currentPhase: '',
      completedPhases: [],
      agents: new Map(),
      abortController: new AbortController(),
    };
    this.runs.set(id, entry);
    this.order.push(id);
    return id;
  }

  /**
   * Mark a run as completed.  Returns the finished summary.
   * Throws if the run ID does not exist.
   */
  completeRun(runId: string): WorkflowSummary {
    const entry = this.getEntryOrThrow(runId);
    entry.status = 'completed';
    entry.completedAt = new Date().toISOString();
    return this.toSummary(entry);
  }

  /**
   * Mark a run as failed.  Returns the finished summary.
   * Throws if the run ID does not exist.
   */
  failRun(runId: string, errorMsg: string): WorkflowSummary {
    const entry = this.getEntryOrThrow(runId);
    entry.status = 'failed';
    entry.completedAt = new Date().toISOString();
    entry.errorMessage = errorMsg;
    return this.toSummary(entry);
  }

  // ─── Sidebar / Phase ───────────────────────────────────────────────────

  /**
   * Merge partial sidebar information into the run's sidebar.
   * Throws if the run ID does not exist.
   */
  updateSidebar(runId: string, info: { title?: string; indicator?: string; phases?: PhaseDescriptor[] }): void {
    const entry = this.getEntryOrThrow(runId);
    if (info.title !== undefined) {
      entry.sidebar.title = info.title;
    }
    if (info.indicator !== undefined) {
      entry.sidebar.indicator = info.indicator;
    }
    if (info.phases !== undefined) {
      entry.sidebar.phases = info.phases;
    }
  }

  /**
   * Advance the run to a new phase.  If a phase was already active it is
   * first pushed onto the completed list.
   * Throws if the run ID does not exist.
   */
  setPhase(runId: string, phase: string): void {
    const entry = this.getEntryOrThrow(runId);
    if (entry.currentPhase) {
      entry.completedPhases.push(entry.currentPhase);
    }
    entry.currentPhase = phase;
  }

  // ─── Agents ────────────────────────────────────────────────────────────

  /**
   * Register (or replace) an agent window for the given run.
   * Throws if the run ID does not exist.
   */
  addAgent(runId: string, agent: AgentWindowState): void {
    const entry = this.getEntryOrThrow(runId);
    entry.agents.set(agent.agentId, agent);
  }

  /**
   * Mark an agent as inactive (completed) within a run.
   * Throws if either the run ID or the agent ID does not exist.
   */
  completeAgent(runId: string, agentId: string): void {
    const entry = this.getEntryOrThrow(runId);
    const agent = entry.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in run ${runId}`);
    }
    agent.active = false;
  }

  /**
   * Append a log entry to an agent's log.  If the agent does not yet exist
   * it is auto-created with an empty profile and active=true.
   * Throws only if the run ID does not exist.
   */
  addAgentLogEntry(runId: string, agentId: string, logEntry: LogEntry): void {
    const entry = this.getEntryOrThrow(runId);
    let agent = entry.agents.get(agentId);
    if (!agent) {
      agent = { agentId, profile: '', active: true, log: [logEntry] };
      entry.agents.set(agentId, agent);
    } else {
      agent.log.push(logEntry);
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * Return a summary of a single run.
   * Throws if the run ID does not exist.
   */
  getSummary(runId: string): WorkflowSummary {
    const entry = this.getEntryOrThrow(runId);
    return this.toSummary(entry);
  }

  /**
   * Return summaries of all runs in insertion order.
   */
  getAllSummaries(): WorkflowSummary[] {
    return this.order.map((id) => {
      const entry = this.runs.get(id);
      if (!entry) throw new Error(`Run ${id} not found`);
      return this.toSummary(entry);
    });
  }

  /**
   * Return the raw entry (or undefined) for advanced internal use.
   */
  getRun(runId: string): RunEntry | undefined {
    return this.runs.get(runId);
  }

  /**
   * Return the AbortController for a run, or undefined if it doesn't exist.
   */
  getAbortController(runId: string): AbortController | undefined {
    return this.runs.get(runId)?.abortController;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private getEntryOrThrow(runId: string): RunEntry {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error(`Run ${runId} not found`);
    return entry;
  }

  private toSummary(entry: RunEntry): WorkflowSummary {
    return {
      id: entry.id,
      workflowName: entry.workflowName,
      status: entry.status,
      sidebar: entry.sidebar,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      errorMessage: entry.errorMessage,
    };
  }
}
