import { join } from 'node:path';
import type { PersistedAgentRecord, WorkflowState, WorktreeInfo } from '../core/types.js';
import { AuditLog } from './audit-log.js';
import { TaskTracker } from './task-status.js';
import { loadWorkflowState, saveWorkflowState, serializeWorkflowState } from './workflow-serializer.js';

export class WorkflowStatusTracker {
  private _taskPrompt = '';
  private _currentPhaseId = '';
  private _completedPhaseIds: string[] = [];
  private _phases: { id: string; label: string; icon: string }[] = [];
  private _workflowData: Record<string, unknown> = {};
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
  private _onTaskClaimed: (() => void) | undefined;
  private _pendingSave = false;
  private _queuedSave = false;
  private _saveLock: Promise<void> = Promise.resolve();
  private _worktree?: WorktreeInfo;
  private _spawnedAgents: PersistedAgentRecord[] = [];

  constructor(workDir: string, signal?: AbortSignal) {
    this.workDir = workDir;
    this._taskTracker = new TaskTracker();
    this._auditLog = new AuditLog(join(workDir, 'audit'));
    this.attachAutoPersist();
    if (signal) {
      this._signal = signal;
      signal.addEventListener(
        'abort',
        () => {
          // Cancel any outstanding active tasks before disposal
          for (const t of this._taskTracker.getAllTasks()) {
            if (t.status === 'active') {
              try {
                this._taskTracker.cancelTask(t.id);
              } catch {
                // ignore errors from double-cancel or already settled
              }
            }
          }
          this.dispose();
        },
        { once: true },
      );
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
    this._onTaskClaimed = () => {
      this.persistState();
    };
    this._taskTracker.on(TaskTracker.Events.TaskSettled, this._onTaskSettled);
    this._taskTracker.on(TaskTracker.Events.TaskReady, this._onTaskReady);
    this._taskTracker.on(TaskTracker.Events.TaskClaimed, this._onTaskClaimed);
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
    if (this._onTaskClaimed) {
      this._taskTracker.removeListener(TaskTracker.Events.TaskClaimed, this._onTaskClaimed);
      this._onTaskClaimed = undefined;
    }
    this._pendingSave = false;
    this._queuedSave = false;
    this._signal = null;
  }

  // ── Getters ────────────────────────────────────────────────────────

  get taskPrompt(): string {
    return this._taskPrompt;
  }

  get currentPhaseId(): string {
    return this._currentPhaseId;
  }

  get completedPhaseIds(): string[] {
    return [...this._completedPhaseIds];
  }

  get phases(): { id: string; label: string; icon: string }[] {
    return this._phases.map((p) => ({ ...p }));
  }

  get workflowData(): Record<string, unknown> {
    return structuredClone(this._workflowData);
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
   * Transition to a new phase. Pushes the current phase into completedPhaseIds
   * and sets the new phase as current.
   */
  setPhase(phaseId: string): void {
    if (this._currentPhaseId) {
      this._completedPhaseIds.push(this._currentPhaseId);
    }
    this._currentPhaseId = phaseId;
  }

  /**
   * Set the current phase without pushing the previous one to completedPhaseIds.
   * Used to initialise a fresh tracker or restore from saved state.
   */
  setCurrentPhase(phaseId: string): void {
    this._currentPhaseId = phaseId;
  }

  /**
   * Register a phase definition (id, label, icon) for display purposes.
   */
  registerPhase(info: { id: string; label: string; icon: string }): void {
    this._phases.push({ ...info });
    this.persistState();
  }

  /**
   * Register a task with the task tracker.
   */
  registerTask(info: { taskId: string; phaseId: string; title: string; dependencies: string[] }): void {
    this._taskTracker.addTask({
      id: info.taskId,
      phaseId: info.phaseId,
      title: info.title,
      dependencies: info.dependencies,
      prompt: '',
      profile: '',
      files: [],
    });
    this.persistState();
  }

  setWorkflowData(updates: Record<string, unknown>): void {
    this._workflowData = { ...this._workflowData, ...updates };
    this.persistState();
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

  recordAgentSpawn(agentId: string, profile: string, phaseId: string, taskId?: string, stepIndex?: number): void;
  recordAgentSpawn(info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    stepIndex?: number;
  }): void;
  recordAgentSpawn(
    agentIdOrInfo: string | { agentId: string; profile: string; phaseId: string; taskId?: string; stepIndex?: number },
    profile?: string,
    phaseId?: string,
    taskId?: string,
    stepIndex?: number,
  ): void {
    let record: PersistedAgentRecord;
    if (typeof agentIdOrInfo === 'string') {
      record = { agentId: agentIdOrInfo, profile: profile as string, phaseId: phaseId as string, taskId, stepIndex };
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
    tracker._currentPhaseId = data.currentPhaseId ?? '';
    tracker._completedPhaseIds = [...(data.completedPhaseIds ?? [])];
    tracker._workflowData = data.workflowData ?? {};
    tracker._stats = { ...data.stats };
    tracker._spawnedAgents = data.spawnedAgents ? data.spawnedAgents.map((a) => ({ ...a })) : [];
    tracker._worktree = data.worktree ? { ...data.worktree } : undefined;

    // Rebuild TaskTracker from saved tasks
    if (data.tasks && data.tasks.length > 0) {
      // preserveState skips fromJSON's default resetForRetry (which would also
      // re-arm failed tasks). On resume we only want to re-arm tasks that were
      // in-flight (active) when the run was interrupted — completed and failed
      // tasks keep their settled status so they are NOT re-run.
      tracker._taskTracker = TaskTracker.fromJSON({ tasks: data.tasks }, { preserveState: true });
      tracker._taskTracker.resetStuckTasks();
      tracker.attachAutoPersist();
    }

    return tracker;
  }
}
