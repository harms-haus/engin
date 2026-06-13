import { join } from 'node:path';
import type { PersistedAgentRecord, WorkflowState, WorktreeInfo } from '../core/types.js';
import { AuditLog } from './audit-log.js';
import { TaskTracker } from './task-status.js';
import { loadWorkflowState, saveWorkflowState, serializeWorkflowState } from './workflow-serializer.js';

export class WorkflowStatusTracker {
  private _taskPrompt = '';
  private _currentPhase = '';
  private _completedPhases: string[] = [];
  private _scoutingReports: unknown[] = [];
  private _plan: unknown = undefined;
  private _research?: string;
  private _planReviewFeedback?: string;
  private _planReviewSuggestions?: string[];
  private _stats: { totalTokens: number; totalCost: number; agentCount: number } = {
    totalTokens: 0,
    totalCost: 0,
    agentCount: 0,
  };
  private _taskTracker: TaskTracker;
  private _auditLog: AuditLog;
  private readonly workDir: string;
  private _signal: AbortSignal | null = null;
  private _onTaskSettled: (() => void) | undefined;
  private _onTaskReady: (() => void) | undefined;
  private _pendingSave = false;
  private _queuedSave = false;
  private _saveLock: Promise<void> = Promise.resolve();
  private _sidebar?: { title?: string; indicator?: string; phases?: { id: string; label: string; icon: string }[] };
  private _worktree?: WorktreeInfo;
  private _spawnedAgents: PersistedAgentRecord[] = [];

  constructor(workDir: string, signal?: AbortSignal) {
    this.workDir = workDir;
    this._taskTracker = new TaskTracker();
    this._auditLog = new AuditLog(join(workDir, 'audit'));
    this.attachAutoPersist();
    if (signal) {
      this._signal = signal;
      signal.addEventListener('abort', () => this.dispose(), { once: true });
    }
  }

  private persistState(): void {
    if (!this._pendingSave) {
      this._pendingSave = true;
      void this._doPersist();
    } else {
      this._queuedSave = true;
    }
  }

  private async _doPersist(): Promise<void> {
    this._pendingSave = true;
    try {
      await this.save();
    } catch (err) {
      console.warn('[WorkflowStatusTracker] Auto-persist save failed:', (err as Error).message);
    } finally {
      this._pendingSave = false;
      if (this._queuedSave) {
        this._queuedSave = false;
        void this._doPersist();
      }
    }
  }

  private attachAutoPersist(): void {
    this._onTaskSettled = () => {
      this.persistState();
    };
    this._onTaskReady = () => {
      this.persistState();
    };
    this._taskTracker.on(TaskTracker.Events.TaskSettled, this._onTaskSettled);
    this._taskTracker.on(TaskTracker.Events.TaskReady, this._onTaskReady);
  }

  dispose(): void {
    if (this._onTaskSettled) {
      this._taskTracker.removeListener(TaskTracker.Events.TaskSettled, this._onTaskSettled);
      this._onTaskSettled = undefined;
    }
    if (this._onTaskReady) {
      this._taskTracker.removeListener(TaskTracker.Events.TaskReady, this._onTaskReady);
      this._onTaskReady = undefined;
    }
    this._pendingSave = false;
    this._queuedSave = false;
    this._signal = null;
  }

  // ── Getters ────────────────────────────────────────────────────────

  get taskPrompt(): string {
    return this._taskPrompt;
  }

  get currentPhase(): string {
    return this._currentPhase;
  }

  get completedPhases(): string[] {
    return [...this._completedPhases];
  }

  get scoutingReports(): unknown[] {
    return [...this._scoutingReports];
  }

  get plan(): unknown {
    if (typeof this._plan === 'object' && this._plan !== null) {
      return structuredClone(this._plan);
    }
    return this._plan;
  }

  get research(): string | undefined {
    return this._research;
  }

  get planReviewFeedback(): string | undefined {
    return this._planReviewFeedback;
  }

  get planReviewSuggestions(): string[] | undefined {
    if (this._planReviewSuggestions) {
      return [...this._planReviewSuggestions];
    }
    return undefined;
  }

  get stats(): { totalTokens: number; totalCost: number; agentCount: number } {
    return { ...this._stats };
  }

  get taskTracker(): TaskTracker {
    return this._taskTracker;
  }

  get auditLog(): AuditLog {
    return this._auditLog;
  }

  get sidebar():
    | { title?: string; indicator?: string; phases?: { id: string; label: string; icon: string }[] }
    | undefined {
    return this._sidebar
      ? { ...this._sidebar, phases: this._sidebar.phases ? [...this._sidebar.phases] : undefined }
      : undefined;
  }

  get worktree(): WorktreeInfo | undefined {
    return this._worktree ? { ...this._worktree } : undefined;
  }

  get spawnedAgents(): PersistedAgentRecord[] {
    return this._spawnedAgents.map((a) => ({ ...a }));
  }

  // ── Mutators ───────────────────────────────────────────────────────

  setTaskPrompt(prompt: string): void {
    this._taskPrompt = prompt;
  }

  /**
   * Transition to a new phase. Pushes the current phase into completedPhases
   * and sets the new phase as current.
   */
  setPhase(phase: string): void {
    if (this._currentPhase) {
      this._completedPhases.push(this._currentPhase);
    }
    this._currentPhase = phase;
  }

  /**
   * Set the current phase without pushing the previous one to completedPhases.
   * Used to initialise a fresh tracker or restore from saved state.
   */
  setCurrentPhase(phase: string): void {
    this._currentPhase = phase;
  }

  setScoutingReports(reports: unknown[]): void {
    this._scoutingReports = reports;
  }

  setPlan(plan: unknown): void {
    this._plan = plan;
  }

  setResearch(research: string): void {
    this._research = research;
  }

  setPlanReviewFeedback(feedback: string, suggestions: string[]): void {
    this._planReviewFeedback = feedback;
    this._planReviewSuggestions = suggestions;
  }

  clearPlanReviewFeedback(): void {
    this._planReviewFeedback = undefined;
    this._planReviewSuggestions = undefined;
  }

  addTokensToStats(tokens: { input: number; output: number }): void {
    this._stats.totalTokens += tokens.input + tokens.output;
  }

  incrementAgentCount(): void {
    this._stats.agentCount += 1;
  }

  setWorktree(info: WorktreeInfo): void {
    this._worktree = { ...info };
  }

  setSidebar(info: {
    title?: string;
    indicator?: string;
    phases?: { id: string; label: string; icon: string }[];
  }): void {
    if (!this._sidebar) {
      this._sidebar = {};
    }
    if (info.title !== undefined) {
      this._sidebar.title = info.title;
    }
    if (info.indicator !== undefined) {
      this._sidebar.indicator = info.indicator;
    }
    if (info.phases !== undefined) {
      this._sidebar.phases = info.phases;
    }
    this.persistState();
  }

  recordAgentSpawn(agentId: string, profile: string, phase: string, taskId?: string): void;
  recordAgentSpawn(info: { agentId: string; profile: string; phase: string; taskId?: string }): void;
  recordAgentSpawn(
    agentIdOrInfo: string | { agentId: string; profile: string; phase: string; taskId?: string },
    profile?: string,
    phase?: string,
    taskId?: string,
  ): void {
    let record: PersistedAgentRecord;
    if (typeof agentIdOrInfo === 'string') {
      record = { agentId: agentIdOrInfo, profile: profile as string, phase: phase as string, taskId };
    } else {
      record = { ...agentIdOrInfo };
    }
    this._spawnedAgents.push(record);
    const MAX_SPAWNED_AGENTS = 500;
    if (this._spawnedAgents.length > MAX_SPAWNED_AGENTS) {
      const completedIdx = this._spawnedAgents.findIndex((a) => a.completedAt);
      if (completedIdx >= 0) {
        this._spawnedAgents.splice(completedIdx, 1);
      } else {
        this._spawnedAgents.shift();
      }
    }
    this.persistState();
  }

  recordAgentComplete(agentId: string): void {
    const agent = this._spawnedAgents.find((a) => a.agentId === agentId);
    if (agent) {
      agent.completedAt = new Date().toISOString();
    }
    this.persistState();
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON(): WorkflowState {
    return serializeWorkflowState(this);
  }

  async save(): Promise<void> {
    // Serialize concurrent save() calls so they don't race on the same temp file.
    const prev = this._saveLock;
    let resolve!: () => void;
    this._saveLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      await saveWorkflowState(this, this.workDir);
    } finally {
      resolve();
    }
  }

  static async load(workDir: string): Promise<WorkflowStatusTracker> {
    const data = await loadWorkflowState(workDir);

    const tracker = new WorkflowStatusTracker(workDir);
    tracker._taskPrompt = data.taskPrompt;
    tracker._currentPhase = data.currentPhase;
    tracker._completedPhases = [...data.completedPhases];
    tracker._scoutingReports = data.scoutingReports;
    tracker._plan = data.plan;
    tracker._research = data.research;
    tracker._planReviewFeedback = data.planReviewFeedback;
    tracker._planReviewSuggestions = data.planReviewSuggestions ? [...data.planReviewSuggestions] : undefined;
    tracker._stats = { ...data.stats };
    tracker._spawnedAgents = data.spawnedAgents ? data.spawnedAgents.map((a) => ({ ...a })) : [];
    tracker._sidebar = data.sidebar ? { ...data.sidebar } : undefined;
    tracker._worktree = data.worktree ? { ...data.worktree } : undefined;

    // Rebuild TaskTracker from saved tasks
    if (data.tasks && data.tasks.length > 0) {
      tracker._taskTracker = TaskTracker.fromJSON({ tasks: data.tasks });
      tracker.attachAutoPersist();
    }

    return tracker;
  }
}
