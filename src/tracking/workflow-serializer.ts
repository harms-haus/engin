import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowState } from '../core/types.js';
import { isEnoentError } from '../core/utils.js';
import type { WorkflowStatusTracker } from './workflow-status.js';

/**
 * Serialize a WorkflowStatusTracker's state into a plain WorkflowState object.
 */
export function serializeWorkflowState(tracker: WorkflowStatusTracker): WorkflowState {
  return {
    taskPrompt: tracker.taskPrompt,
    currentPhase: tracker.currentPhase,
    completedPhases: tracker.completedPhases,
    tasks: tracker.taskTracker.getAllTasks(),
    workflowData: tracker.workflowData,
    stats: { ...tracker.stats },
    spawnedAgents: tracker.spawnedAgents.length > 0 ? tracker.spawnedAgents.map((a) => ({ ...a })) : [],
    sidebar: tracker.sidebar,
    worktree: tracker.worktree,
  };
}

// Monotonic counter guarantees a unique temp filename per call within a
// process, so concurrent saves (e.g. an in-flight auto-persist racing with an
// explicit saveWorkflowState) never write/rename the same temp path.
let saveSeq = 0;

/**
 * Atomically write the tracker state to disk.
 * Writes to a uniquely-named temporary file then renames it to the final path.
 * Also removes a stale legacy `.engin-state.json.tmp` left by a previous
 * (pre-unique-name) failed write.
 */
export async function saveWorkflowState(tracker: WorkflowStatusTracker, workDir: string): Promise<void> {
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
export async function loadWorkflowState(workDir: string): Promise<WorkflowState> {
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
  let parsed = JSON.parse(raw) as Record<string, unknown>;
  // Backward-compat migration: old state files have top-level SPIR fields.
  // If workflowData is absent but any old fields exist, migrate them into workflowData.
  if (!parsed.workflowData) {
    const spirFields = ['scoutingReports', 'plan', 'research', 'planReviewFeedback', 'planReviewSuggestions'] as const;
    const migrated: Record<string, unknown> = {};
    let hasAny = false;
    for (const field of spirFields) {
      if (parsed[field] !== undefined) {
        migrated[field] = parsed[field];
        hasAny = true;
      }
    }
    if (hasAny) {
      const {
        scoutingReports: _sr,
        plan: _p,
        research: _r,
        planReviewFeedback: _pf,
        planReviewSuggestions: _ps,
        ...rest
      } = parsed;
      parsed = { ...rest, workflowData: migrated };
    }
  }
  return parsed as unknown as WorkflowState;
}
