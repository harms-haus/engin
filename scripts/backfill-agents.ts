#!/usr/bin/env bun
/**
 * Backfill script: reconstructs `spawnedAgents` in `.engin-state.json` files
 * from audit logs (`audit/audit.jsonl`).
 *
 * Older workflow runs have empty `spawnedAgents` arrays because the dual-tracker
 * bug prevented agent data from being persisted. However, the audit logs contain
 * `agent_start` / `agent_end` events with rich agent information.
 *
 * Usage:
 *   bun run scripts/backfill-agents.ts [--cwd <dir>] [--dry-run] [--force]
 *
 * Flags:
 *   --cwd <dir>   Project root containing `.engin/work/` (default: current directory)
 *   --dry-run     Print what would change without writing files
 *   --force       Re-backfill even if spawnedAgents is already non-empty
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PersistedAgentRecord {
  agentId: string;
  profile: string;
  phase: string;
  taskId?: string;
  completedAt?: string;
}

interface AuditStartEvent {
  type: 'agent_start';
  agentId: string;
  profile: { id: string; name?: string } | string;
  taskId?: string;
  phase?: string;
  stepIndex?: number;
  timestamp: string;
}

interface AuditEndEvent {
  type: 'agent_end';
  agentId: string;
  taskId?: string;
  stepIndex?: number;
  timestamp: string;
}

type AuditEvent = AuditStartEvent | AuditEndEvent | Record<string, unknown>;

interface WorkflowState {
  taskPrompt: string;
  currentPhase: string;
  completedPhases: string[];
  tasks: unknown[];
  scoutingReports: unknown[];
  plan: unknown;
  stats: { totalTokens: number; totalCost: number; agentCount: number };
  spawnedAgents?: PersistedAgentRecord[];
}

interface RunSummary {
  dirName: string;
  fullPath: string;
  hasStateFile: boolean;
  hasAuditLog: boolean;
  existingAgentCount: number;
  reconstructedAgentCount: number;
  skipped: boolean;
  reason?: string;
}

// ─── Composite key helper ──────────────────────────────────────────────────
// Note: The agentKey helper was previously defined in web/src/utils/agent-key.ts
// and src/web/run-registry.ts (both removed). This script is standalone and
// cannot import from either, so the logic
// is duplicated here to avoid a cross-package dependency.

function agentKey(agentId: string, taskId?: string, stepIndex?: number): string {
  if (!taskId) return agentId;
  if (stepIndex !== undefined) return `${agentId}::${taskId}::${stepIndex}`;
  return `${agentId}::${taskId}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractProfileId(profile: { id: string; name?: string } | string | undefined): string {
  if (!profile) return '';
  if (typeof profile === 'string') return profile;
  return profile.id ?? '';
}

function parseJsonl(content: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed) as AuditEvent);
    } catch {
      // Skip malformed lines (matches AuditLog behavior)
    }
  }
  return events;
}

// ─── Core logic ─────────────────────────────────────────────────────────────

// Agent ID → phase mapping for non-implementing agents
const AGENT_PHASE_MAP: Record<string, string> = {
  'scout-coordinator': 'scouting',
  'scouting-reviewer': 'scouting_review',
  planner: 'planning',
  'plan-reviewer': 'plan_review',
  'final-reviewer': 'final_review',
  'title-generator': 'initialization',
};

// For scout-N agents (parallel scouts)
function isInferredScoutAgent(agentId: string): boolean {
  return /^scout-\d+$/.test(agentId);
}

export function reconstructAgents(auditEvents: AuditEvent[]): PersistedAgentRecord[] {
  const records = new Map<string, PersistedAgentRecord>();

  // First pass: create records from agent_start events
  for (const event of auditEvents) {
    if (event.type !== 'agent_start') continue;
    const startEvent = event as AuditStartEvent;

    // Skip duplicates (same agentId + taskId combo can appear in implementing phase)
    const key = agentKey(startEvent.agentId, startEvent.taskId, startEvent.stepIndex);

    if (!records.has(key)) {
      records.set(key, {
        agentId: startEvent.agentId,
        profile: extractProfileId(startEvent.profile),
        phase: startEvent.phase ?? 'implementing',
        taskId: startEvent.taskId,
      });
    }
  }

  // Second pass: infer non-implementing agents from structured_output / decision events
  for (const event of auditEvents) {
    if (event.type !== 'structured_output' && event.type !== 'decision') continue;
    const ev = event as Record<string, unknown>;
    const agentId = ev.agentId as string | undefined;
    if (!agentId) continue;

    // Only infer for known agent IDs (skip unknown ones like lane-N)
    const inferredPhase = AGENT_PHASE_MAP[agentId] ?? (isInferredScoutAgent(agentId) ? 'scouting' : undefined);
    if (inferredPhase === undefined) continue;

    // Check if any existing record already has this agentId
    // (first pass may have stored under agentId::taskId composite key)
    const hasExistingRecord = Array.from(records.values()).some((r) => r.agentId === agentId);
    if (!hasExistingRecord) {
      records.set(agentId, {
        agentId,
        profile: '',
        phase: inferredPhase,
      });
    }
  }

  // Third pass: add completedAt from agent_end events
  for (const event of auditEvents) {
    if (event.type !== 'agent_end') continue;
    const endEvent = event as AuditEndEvent;

    // Find matching record
    const key = agentKey(endEvent.agentId, endEvent.taskId, endEvent.stepIndex);

    const record = records.get(key);
    if (record) {
      record.completedAt = endEvent.timestamp;
    } else {
      // Agent ended but never started in the log — create a minimal record
      records.set(key, {
        agentId: endEvent.agentId,
        profile: '',
        phase: 'implementing',
        taskId: endEvent.taskId,
        completedAt: endEvent.timestamp,
      });
    }
  }

  return Array.from(records.values());
}

async function findWorkDirs(workRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+-/.test(entry.name)) continue;
    dirs.push(join(workRoot, entry.name));
  }

  return dirs.sort();
}

async function processRun(runDir: string, options: { dryRun: boolean; force: boolean }): Promise<RunSummary> {
  const dirName = runDir.split('/').pop() ?? runDir;
  const statePath = join(runDir, '.engin-state.json');
  const auditPath = join(runDir, 'audit', 'audit.jsonl');

  const summary: RunSummary = {
    dirName,
    fullPath: runDir,
    hasStateFile: false,
    hasAuditLog: false,
    existingAgentCount: 0,
    reconstructedAgentCount: 0,
    skipped: false,
  };

  // Check for state file
  try {
    await stat(statePath);
    summary.hasStateFile = true;
  } catch {
    summary.skipped = true;
    summary.reason = 'no .engin-state.json';
    return summary;
  }

  // Check for audit log
  try {
    await stat(auditPath);
    summary.hasAuditLog = true;
  } catch {
    summary.skipped = true;
    summary.reason = 'no audit/audit.jsonl';
    return summary;
  }

  // Read state file
  let state: WorkflowState;
  try {
    const raw = await readFile(statePath, 'utf-8');
    state = JSON.parse(raw) as WorkflowState;
  } catch (err) {
    summary.skipped = true;
    summary.reason = `failed to parse .engin-state.json: ${(err as Error).message}`;
    return summary;
  }

  summary.existingAgentCount = state.spawnedAgents?.length ?? 0;

  // Skip if already populated (unless --force)
  if (summary.existingAgentCount > 0 && !options.force) {
    summary.skipped = true;
    summary.reason = `already has ${summary.existingAgentCount} agents (use --force to overwrite)`;
    return summary;
  }

  // Read and parse audit log
  let auditContent: string;
  try {
    auditContent = await readFile(auditPath, 'utf-8');
  } catch (err) {
    summary.skipped = true;
    summary.reason = `failed to read audit log: ${(err as Error).message}`;
    return summary;
  }

  const auditEvents = parseJsonl(auditContent);
  const reconstructed = reconstructAgents(auditEvents);
  summary.reconstructedAgentCount = reconstructed.length;

  if (reconstructed.length === 0) {
    summary.skipped = true;
    summary.reason = 'no reconstructible agent events found in audit log';
    return summary;
  }

  // Update state
  if (!options.dryRun) {
    state.spawnedAgents = reconstructed;
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  }

  return summary;
}

// ─── CLI entry point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let cwd = process.cwd();
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && i + 1 < args.length) {
      cwd = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  const workRoot = join(cwd, '.engin', 'work');
  console.log(`Scanning: ${workRoot}`);
  if (dryRun) console.log('(dry-run mode — no files will be modified)');
  console.log();

  const runDirs = await findWorkDirs(workRoot);

  if (runDirs.length === 0) {
    console.log('No workflow run directories found.');
    return;
  }

  console.log(`Found ${runDirs.length} run directories.\n`);

  const results: RunSummary[] = [];

  for (const runDir of runDirs) {
    const result = await processRun(runDir, { dryRun, force });
    results.push(result);

    const dirName = result.dirName;
    if (result.skipped) {
      console.log(`  SKIP  ${dirName} — ${result.reason}`);
    } else if (dryRun) {
      console.log(
        `  WOULD ${dirName} — ${result.reconstructedAgentCount} agents (existing: ${result.existingAgentCount})`,
      );
    } else {
      console.log(
        `  OK    ${dirName} — backfilled ${result.reconstructedAgentCount} agents (was: ${result.existingAgentCount})`,
      );
    }
  }

  // Summary
  const processed = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const totalAgents = processed.reduce((sum, r) => sum + r.reconstructedAgentCount, 0);

  console.log();
  console.log('── Summary ──');
  console.log(`  Total runs:      ${results.length}`);
  console.log(`  Processed:       ${processed.length}`);
  console.log(`  Skipped:         ${skipped.length}`);
  console.log(`  Agents recovered: ${totalAgents}`);

  if (dryRun && processed.length > 0) {
    console.log();
    console.log('Run without --dry-run to apply changes.');
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
