import type { EngineClient } from '@engin/shared/engine-client.js';
import type { RunSummary } from '@engin/shared/protocol-types.js';
import type { PastRunEntry } from '@harms-haus/engin-engine';
import { scanPastRuns } from '@harms-haus/engin-engine';
import * as readline from 'node:readline';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Discriminated union returned by {@link interactiveSelectRun}. */
export type PickerSelection =
  | { type: 'active'; runSummary: RunSummary }
  | { type: 'historical'; pastRun: PastRunEntry };

// ─── Active Run Query ───────────────────────────────────────────────────────

/**
 * Query the server for active runs via the EngineClient.
 * Returns an empty array when the client is null, not connected, or on error.
 */
export async function queryActiveRuns(client: EngineClient | null | undefined): Promise<RunSummary[]> {
  if (!client) return [];
  try {
    return await client.requestRuns();
  } catch {
    return [];
  }
}

// ─── Interactive Session Selector ───────────────────────────────────────────

/**
 * Format a timestamp (ms since epoch) into a human-readable relative time.
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

/**
 * Read a single line from stdin (for interactive selection).
 * Uses Node's readline module for TTY to handle terminal mode
 * restoration and CR/LF translation correctly.
 * Falls back to manual stream reading for non-TTY (piped input).
 * Returns the trimmed input, or undefined on EOF.
 */
export async function readLineFromStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    // Use readline for real terminals — it properly handles
    // setRawMode restoration and CR/LF translation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim() || undefined);
      });
    });
  }

  // Non-TTY fallback (piped input, tests)
  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.setEncoding('utf-8');
    stdin.resume();

    let data = '';
    const onData = (chunk: string) => {
      data += chunk;
      const newlineIdx = data.search(/[\r\n]/);
      if (newlineIdx >= 0) {
        const line = data.slice(0, newlineIdx);
        stdin.removeListener('data', onData);
        stdin.pause();
        resolve(line.trim() || undefined);
      }
    };
    const onEnd = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.pause();
      resolve(data.trim() || undefined);
    };
    stdin.once('end', onEnd);
    stdin.on('data', onData);
  });
}

// ─── Two-Source Picker ──────────────────────────────────────────────────────

/** Display label for an active run's status. */
function statusLabel(status: RunSummary['status']): string {
  switch (status) {
    case 'running':
      return 'RUNNING';
    case 'complete':
      return 'COMPLETE';
    case 'failed':
      return 'FAILED';
    default:
      return status.toUpperCase();
  }
}

/** Internal tagged union used to build the merged display list. */
type DisplayItem = { kind: 'active'; run: RunSummary } | { kind: 'historical'; run: PastRunEntry };

/**
 * Present an interactive list of active (server) and historical (disk) runs
 * and let the user pick one.
 *
 * Active runs are displayed first (🟢 marker), followed by historical runs
 * (💾 indicator for resumable state). Disk runs that are also active on the
 * server are deduped (shown only in the active section).
 *
 * Returns a {@link PickerSelection} discriminated union, or `undefined` if the
 * user cancels.
 */
export async function interactiveSelectRun(
  cwd: string,
  client?: EngineClient | null,
): Promise<PickerSelection | undefined> {
  // Query active runs from the server
  const activeRuns = await queryActiveRuns(client ?? null);

  // Scan historical runs from disk
  const allDiskRuns = await scanPastRuns(cwd);

  // Build deduped list: exclude disk runs whose dirName matches an active run's runId
  const activeDirNames = new Set(activeRuns.map((r) => r.runId));
  const historicalRuns = allDiskRuns.filter((r) => !activeDirNames.has(r.dirName));

  // Combined display list: active first, then historical
  const items: DisplayItem[] = [
    ...activeRuns.map((r): DisplayItem => ({ kind: 'active', run: r })),
    ...historicalRuns.map((r): DisplayItem => ({ kind: 'historical', run: r })),
  ];

  if (items.length === 0) {
    console.log('No past workflow runs found.');
    return undefined;
  }

  console.log('\nPast workflow runs (newest first):\n');
  const displayLimit = Math.min(items.length, 20);
  for (let i = 0; i < displayLimit; i++) {
    const item = items[i];
    const num = String(i + 1).padStart(2);

    if (item.kind === 'active') {
      const relTime = formatRelativeTime(new Date(item.run.startedAt).getTime());
      const label = statusLabel(item.run.status);
      console.log(`  ${num}  🟢  ${item.run.workflowName}  (${item.run.runId})  ${label}  (${relTime})`);
    } else {
      const relTime = formatRelativeTime(item.run.timestamp);
      const stateIndicator = item.run.hasStateFile ? '💾' : '  ';
      console.log(`  ${num}  ${stateIndicator}  ${item.run.dirName}  (${relTime})`);
    }
  }
  if (items.length > displayLimit) {
    console.log(`     ... and ${items.length - displayLimit} more`);
  }
  console.log();
  console.log('  💾 = has resumable state');
  console.log();

  while (true) {
    process.stdout.write('Select a run (1-' + displayLimit + ') or press Enter to cancel: ');
    const input = await readLineFromStdin();

    if (input === undefined || input === '') {
      console.log('Cancelled.');
      return undefined;
    }

    const num = Number(input);
    if (Number.isFinite(num) && Number.isInteger(num) && num >= 1 && num <= displayLimit) {
      const selected = items[num - 1];
      if (selected.kind === 'active') {
        return { type: 'active', runSummary: selected.run };
      }
      return { type: 'historical', pastRun: selected.run };
    }

    console.log(`Invalid selection: "${input}". Enter a number between 1 and ${displayLimit}.`);
  }
}

/**
 * Resolve a partial or full session name to a PastRunEntry.
 * Matches by directory name, supporting partial prefix matching.
 */
export async function resolveSessionName(sessionName: string, cwd: string): Promise<PastRunEntry> {
  const runs = await scanPastRuns(cwd);

  // Try exact match first
  const exact = runs.find((r) => r.dirName === sessionName);
  if (exact) return exact;

  // Try prefix match (e.g. just the timestamp portion)
  const prefixMatches = runs.filter((r) => r.dirName.startsWith(sessionName));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    const names = prefixMatches.map((r) => r.dirName).join(', ');
    throw new Error(`Ambiguous session name "${sessionName}" matches multiple runs: ${names}. Be more specific.`);
  }

  throw new Error(
    `No past run found matching "${sessionName}". Use 'engin resume' without arguments to see available runs.`,
  );
}
