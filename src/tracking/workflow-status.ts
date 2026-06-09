import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowPhase, WorkflowState } from '../core/types.js';
import { AuditLog } from './audit-log.js';
import { TaskTracker } from './task-status.js';

export const PHASE_ORDER: WorkflowPhase[] = [
  'scouting',
  'scouting_review',
  'planning',
  'plan_review',
  'implementing',
  'final_review',
  'done',
];

export class WorkflowStatusTracker {
  private _taskPrompt = '';
  private _currentPhase: WorkflowPhase = 'scouting';
  private _completedPhases: WorkflowPhase[] = [];
  private _scoutingReports: unknown[] = [];
  private _plan: unknown = undefined;
  private _research?: string;
  private _stats: { totalTokens: number; totalCost: number; agentCount: number } = {
    totalTokens: 0,
    totalCost: 0,
    agentCount: 0,
  };
  private _taskTracker: TaskTracker;
  private _auditLog: AuditLog;
  private readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    this._taskTracker = new TaskTracker();
    this._auditLog = new AuditLog(path.join(workDir, 'audit'));
  }

  // ── Getters ────────────────────────────────────────────────────────

  get taskPrompt(): string {
    return this._taskPrompt;
  }

  get currentPhase(): WorkflowPhase {
    return this._currentPhase;
  }

  get completedPhases(): WorkflowPhase[] {
    return [...this._completedPhases];
  }

  get scoutingReports(): unknown[] {
    return this._scoutingReports;
  }

  get plan(): unknown {
    return this._plan;
  }

  get research(): string | undefined {
    return this._research;
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

  // ── Mutators ───────────────────────────────────────────────────────

  setTaskPrompt(prompt: string): void {
    this._taskPrompt = prompt;
  }

  advancePhase(): void {
    const idx = PHASE_ORDER.indexOf(this._currentPhase);
    if (idx < 0 || idx >= PHASE_ORDER.length - 1) {
      throw new Error(`Cannot advance from phase "${this._currentPhase}": already at the final phase`);
    }

    this._completedPhases.push(this._currentPhase);
    this._currentPhase = PHASE_ORDER[idx + 1];
  }

  setPhase(phase: WorkflowPhase): void {
    const allowed = PHASE_ORDER.indexOf(phase) >= 0;
    if (!allowed) {
      throw new Error(`Invalid phase "${phase}"`);
    }

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

  addTokensToStats(tokens: { input: number; output: number }): void {
    this._stats.totalTokens += tokens.input + tokens.output;
  }

  incrementAgentCount(): void {
    this._stats.agentCount += 1;
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON(): WorkflowState {
    return {
      taskPrompt: this._taskPrompt,
      currentPhase: this._currentPhase,
      completedPhases: this._completedPhases,
      tasks: this._taskTracker.getAllTasks(),
      scoutingReports: this._scoutingReports,
      plan: this._plan,
      research: this._research,
      stats: { ...this._stats },
    };
  }

  async save(): Promise<void> {
    await fs.mkdir(this.workDir, { recursive: true });
    const filePath = path.join(this.workDir, '.engin-state.json');
    await fs.writeFile(filePath, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
  }

  static async load(workDir: string): Promise<WorkflowStatusTracker> {
    const filePath = path.join(workDir, '.engin-state.json');
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        throw new Error(`Workflow state file not found at "${filePath}"`, { cause: err });
      }
      throw new Error('Failed to load workflow state', { cause: err });
    }

    const data = JSON.parse(raw) as WorkflowState;

    const tracker = new WorkflowStatusTracker(workDir);
    tracker._taskPrompt = data.taskPrompt;
    tracker._currentPhase = data.currentPhase;
    tracker._completedPhases = [...data.completedPhases];
    tracker._scoutingReports = data.scoutingReports;
    tracker._plan = data.plan;
    tracker._research = data.research;
    tracker._stats = { ...data.stats };

    // Rebuild TaskTracker from saved tasks
    if (data.tasks && data.tasks.length > 0) {
      tracker._taskTracker = TaskTracker.fromJSON({ tasks: data.tasks });
    }

    return tracker;
  }
}
