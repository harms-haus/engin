import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedAgentRecord, WorkflowState, WorktreeInfo } from '../core/types.js';
import { isEnoentError } from '../core/utils.js';
import { AuditLog } from './audit-log.js';
import { TaskTracker } from './task-status.js';

const MAX_SPAWNED_AGENTS = 500;

// ── Private serialization helpers for .engin-state.json ────────────────────
//
// Private module-level helpers for the .engin-state.json persistence path
// used by WorkflowStatusTracker. The EventStore (snapshot + events.jsonl) is
// the canonical persistence layer going forward.

/**
 * Serialize a WorkflowStatusTracker's state into a plain WorkflowState object.
 */
function serializeWorkflowState(tracker: WorkflowStatusTracker): WorkflowState {
  return {
    taskPrompt: tracker.taskPrompt,
    currentPhaseId: tracker.currentPhaseId,
    completedPhaseIds: tracker.completedPhaseIds,
    tasks: tracker.taskTracker.getAllTasks(),
    workflowData: tracker.workflowData,
    stats: { ...tracker.stats },
    spawnedAgents: tracker.spawnedAgents.length > 0 ? tracker.spawnedAgents.map((a) => ({ ...a })) : [],
    worktree: tracker.worktree,
  };
}

// Monotonic counter guarantees a unique temp filename per call within a
// process, so concurrent saves (e.g. an in-flight auto-persist racing with an
// explicit save) never write/rename the same temp path.
let saveSeq = 0;

/**
 * Atomically write the tracker state to disk.
 * Writes to a uniquely-named temporary file then renames it to the final path.
 * Also removes a stale legacy `.engin-state.json.tmp` left by a previous
 * (pre-unique-name) failed write.
 */
async function saveWorkflowState(tracker: WorkflowStatusTracker, workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  const filePath = join(workDir, '.engin-state.json');
  // Clean up a stale legacy temp file from a previous failed write.
  await rm(join(workDir, '.engin-state.json.tmp'), { force: true });
  const tmpPath = join(workDir, `.engin-state.json.tmp.${process.pid}.${saveSeq++}`);
  await writeFile(tmpPath, JSON.stringify(serializeWorkflowState(tracker), null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Read and parse the workflow state file from disk.
 * Throws if the file does not exist or cannot be parsed.
 */
async function loadWorkflowState(workDir: string): Promise<WorkflowState> {
  const filePath = join(workDir, '.engin-state.json');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      throw new Error(`Workflow state file not found at "${filePath}"`, { cause: err });
    }
    throw new Error('Failed to load workflow state', { cause: err });
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // NOTE: This is a clean break — old run state files (pre hierarchy refactor)
  // are NOT migrated. Callers that find a state file with an unexpected shape
  // should reset to a pristine state rather than resume. See
  // WorkflowStatusTracker.load for the reject/reset handling.
  return parsed as unknown as WorkflowState;
}

export class WorkflowStatusTracker {
  /**
   * Best-effort safety net for trackers whose caller forgot to call
   * {@link dispose}. When a tracker becomes unreachable the registry callback
   * calls dispose — *if* the object is still alive at finalization time.
   *
   * The held value is a `WeakRef` (not `this` directly) and the callback does
   * not close over any instance, so the registry never strongly pins the
   * tracker — the classic FinalizationRegistry leak. Callbacks are
   * non-deterministic and may fire late or never, so this is a backstop, not
   * the primary cleanup path (explicit `dispose()` / abort signal remain so).
   */
  private static readonly finalizationRegistry = new FinalizationRegistry((held: WeakRef<WorkflowStatusTracker>) => {
    const tracker = held.deref();
    if (tracker) {
      tracker.dispose();
    }
  });

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
  private _pendingSave = false;
  private _queuedSave = false;
  private _saveLock: Promise<void> = Promise.resolve();
  private _worktree?: WorktreeInfo;
  private _spawnedAgents: PersistedAgentRecord[] = [];
  private _disposed = false;

  constructor(workDir: string, signal?: AbortSignal) {
    this.workDir = workDir;
    this._taskTracker = new TaskTracker();
    this._auditLog = new AuditLog(join(workDir, 'audit'));
    if (signal) {
      this._signal = signal;
      signal.addEventListener(
        'abort',
        () => {
          // Cancel any outstanding active tasks before disposal.
          for (const t of this._taskTracker.getAllTasks()) {
            if (t.status === 'active') {
              t.status = 'cancelled';
            }
          }
          this.dispose();
        },
        { once: true },
      );
    } else {
      // No caller-supplied signal: register a GC safety net so that a forgotten
      // dispose() still has a chance to clean up. The held value is a WeakRef
      // so the registry never strongly pins this tracker (the classic
      // FinalizationRegistry leak). The callback is non-deterministic and may
      // fire late or never — this is a backstop, not the primary cleanup path.
      WorkflowStatusTracker.finalizationRegistry.register(this, new WeakRef(this));
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

  dispose(): void {
    // Idempotent: safe to invoke from any context (manual call, abort handler,
    // or the FinalizationRegistry backstop) which may fire zero, one, or many
    // times and possibly late. Once disposed, subsequent calls are no-ops.
    if (this._disposed) return;
    this._disposed = true;
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
      worktree: 'none',
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

  recordAgentSpawn(info: {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
    runnerRole?: string;
    attempt?: number;
  }): void {
    const record: PersistedAgentRecord = { ...info };
    this._spawnedAgents.push(record);
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
      // preserveState: true instructs fromJSON to restore tasks as-is without
      // any transformation. On resume we only want to re-arm tasks that were
      // in-flight (active) when the run was interrupted — completed and failed
      // tasks keep their settled status so they are NOT re-run.
      tracker._taskTracker = TaskTracker.fromJSON({ tasks: data.tasks }, { preserveState: true });
      // Reset any tasks that were in-flight (active) when the run was
      // interrupted so they can be re-run on resume.
      for (const t of tracker._taskTracker.getAllTasks()) {
        if (t.status === 'active') {
          t.status = 'ready';
          t.assignedAgent = undefined;
          t.result = undefined;
          t.reviewFeedback = undefined;
        }
      }
    }

    return tracker;
  }
}
