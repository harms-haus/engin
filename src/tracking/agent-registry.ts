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
   */
  complete(uid: string): void {
    const record = this._agents.find((a) => a.uid === uid);
    if (!record) return;
    record.status = 'completed';
    record.completedAt = new Date().toISOString();
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
