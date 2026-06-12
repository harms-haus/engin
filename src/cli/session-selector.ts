import * as readline from 'node:readline';
import type { PastRunEntry } from '../core/config.js';
import { scanPastRuns } from '../core/config.js';

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

/**
 * Present an interactive list of past runs and let the user pick one.
 * Returns the selected PastRunEntry, or undefined if the user cancels.
 */
export async function interactiveSelectRun(cwd: string): Promise<PastRunEntry | undefined> {
  const runs = await scanPastRuns(cwd);

  if (runs.length === 0) {
    console.log('No past workflow runs found.');
    return undefined;
  }

  console.log('\nPast workflow runs (newest first):\n');
  const displayLimit = Math.min(runs.length, 20);
  for (let i = 0; i < displayLimit; i++) {
    const run = runs[i];
    const relTime = formatRelativeTime(run.timestamp);
    const stateIndicator = run.hasStateFile ? '💾' : '  ';
    console.log(`  ${String(i + 1).padStart(2)}  ${stateIndicator}  ${run.dirName}  (${relTime})`);
  }
  if (runs.length > displayLimit) {
    console.log(`     ... and ${runs.length - displayLimit} more`);
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
      return runs[num - 1];
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
