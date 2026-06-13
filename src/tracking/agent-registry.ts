// ─── AgentLogEntry ───────────────────────────────────────────────────────────
/** A single log entry for an agent session (text, thinking, tool calls, errors, decisions). */
export interface AgentLogEntry {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'decision';
  content: string;
}

// ─── AgentRecord ──────────────────────────────────────────────────────────────
/** Represents a single agent spawn with a unique UID. */
export interface AgentRecord {
  /** Unique per-spawn identifier (e.g. agent-1, agent-2). */
  uid: string;
  /** The raw agent ID from the workflow (e.g. lane-0, scout-topic). */
  agentId: string;
  /** The profile used for this agent (e.g. coder, scout). */
  profile: string;
  /** The phase in which this agent was spawned. */
  phase: string;
  /** Optional task identifier associated with this agent. */
  taskId?: string;
  /** Optional session identifier for history lookup. */
  sessionId?: string;
  /** Optional session path for history lookup. */
  sessionPath?: string;
  /** Log entries for this agent session. */
  entries: AgentLogEntry[];
  /** Cumulative number of tool calls made by this agent. */
  toolCallCount: number;
  /** Cumulative input tokens consumed. */
  inputTokens: number;
  /** Cumulative output tokens produced. */
  outputTokens: number;
  /** Task title associated with this agent. */
  taskTitle: string;
  /** Current status: active or completed. */
  status: 'active' | 'completed';
  /** ISO timestamp of when the agent completed, if applicable. */
  completedAt?: string;
}

// ─── AgentRegistry ───────────────────────────────────────────────────────────
/**
 * Unified agent tracking registry acting as the single source of truth for
 * agent identity.
 *
 * Lane IDs like lane-0 are reused across phases (scouting phase lane-0 vs
 * implementing phase lane-0). The registry assigns a unique UID to each agent
 * spawn, solving this collision. It also links sessionIds for history lookup.
 *
 * The registry accumulates agents across all phases. The `clear()` method
 * exists ONLY for a full workflow restart, NOT for phase transitions.
 */
export class AgentRegistry {
  private _agents: AgentRecord[] = [];
  private _activeByAgentId = new Map<string, string>();
  private _byTaskId = new Map<string, string>();
  private _counter = 0;

  /**
   * Register a new agent spawn.
   *
   * @returns The newly assigned unique UID string (e.g. "agent-3").
   */
  register(info: {
    agentId: string;
    profile: string;
    phase: string;
    taskId?: string;
    sessionId?: string;
    sessionPath?: string;
  }): string {
    this._counter += 1;
    const uid = `agent-${this._counter}`;

    const record: AgentRecord = {
      uid,
      agentId: info.agentId,
      profile: info.profile,
      phase: info.phase,
      taskId: info.taskId,
      sessionId: info.sessionId,
      sessionPath: info.sessionPath,
      entries: [],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
      status: 'active',
    };

    this._agents.push(record);
    this._activeByAgentId.set(info.agentId, uid);

    if (info.taskId) {
      this._byTaskId.set(info.taskId, uid);
    }

    return uid;
  }

  /**
   * Mark an agent as completed by its unique UID.
   * No-op if the UID is not found.
   * Also cleans up the active-by-agentId mapping so getActiveUid returns undefined
   * for this agentId after completion.
   */
  complete(uid: string): void {
    const record = this._agents.find((a) => a.uid === uid);
    if (!record) return;
    record.status = 'completed';
    record.completedAt = new Date().toISOString();
    // Clean up the active mapping so getActiveUid no longer returns this UID
    if (this._activeByAgentId.get(record.agentId) === uid) {
      this._activeByAgentId.delete(record.agentId);
    }
  }

  /**
   * Look up the active UID for a raw agentId and mark that agent as completed.
   * No-op if no active agent is found for the given agentId.
   */
  completeByAgentId(agentId: string): void {
    const uid = this._activeByAgentId.get(agentId);
    if (!uid) return;
    this.complete(uid);
  }

  /**
   * Return the active UID for a raw agentId, or undefined if none is active.
   */
  getActiveUid(agentId: string): string | undefined {
    return this._activeByAgentId.get(agentId);
  }

  /**
   * Return the UID mapped to the given taskId, or undefined.
   */
  getUidByTaskId(taskId: string): string | undefined {
    return this._byTaskId.get(taskId);
  }

  /**
   * Return a shallow copy of all registered agent records.
   */
  getAgents(): AgentRecord[] {
    return [...this._agents];
  }

  /**
   * Return all agent records for a given phase.
   */
  getAgentsByPhase(phase: string): AgentRecord[] {
    return this._agents.filter((a) => a.phase === phase);
  }

  /**
   * Return a single agent record by its unique UID, or undefined.
   */
  getAgent(uid: string): AgentRecord | undefined {
    return this._agents.find((a) => a.uid === uid);
  }

  /**
   * Append a log entry to the agent's entries array.
   * If the agent is not found, this is a no-op.
   * Entries are capped at 200; the oldest entry is evicted via FIFO when exceeded.
   */
  addEntry(uid: string, entry: AgentLogEntry): void {
    const record = this._agents.find((a) => a.uid === uid);
    if (!record) return;
    record.entries.push(entry);
    if (record.entries.length > 200) {
      record.entries.shift();
    }
  }

  /**
   * Update stats for an agent identified by uid.
   * No-op if the UID is not found.
   *
   * Numeric fields (toolCallCount, inputTokens, outputTokens) are ACCUMULATED
   * via +=, allowing incremental updates. String fields (taskTitle, profile) are
   * SET (overwritten).
   */
  updateStats(
    uid: string,
    partial: {
      toolCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      taskTitle?: string;
      profile?: string;
    },
  ): void {
    const record = this._agents.find((a) => a.uid === uid);
    if (!record) return;

    if (partial.toolCallCount !== undefined) {
      record.toolCallCount += partial.toolCallCount;
    }
    if (partial.inputTokens !== undefined) {
      record.inputTokens += partial.inputTokens;
    }
    if (partial.outputTokens !== undefined) {
      record.outputTokens += partial.outputTokens;
    }
    if (partial.taskTitle !== undefined) {
      record.taskTitle = partial.taskTitle;
    }
    if (partial.profile !== undefined) {
      record.profile = partial.profile;
    }
  }

  /**
   * Reset all internal state.
   *
   * IMPORTANT: This method exists ONLY for a full workflow restart, NOT for
   * phase transitions. The registry accumulates agents across all phases.
   */
  clear(): void {
    this._agents = [];
    this._activeByAgentId.clear();
    this._byTaskId.clear();
    this._counter = 0;
  }

  /**
   * Return the total number of registered agents.
   */
  get size(): number {
    return this._agents.length;
  }
}
