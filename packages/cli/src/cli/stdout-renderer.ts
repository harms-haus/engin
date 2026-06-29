// ─── stdout-renderer ───────────────────────────────────────────────────────
// Non-TTY event renderer for the CLI. Subscribes to a `ClientStore`, tracks
// deltas in `workflowEventLog`, per-agent log entries, per-agent token counts,
// and `runLog`, and prints formatted lines to stdout via `console.log`.
//
// This replaces the old callback-based `createStatusCallbacks(verbose)` pattern
// for the non-TTY path. Lifecycle lines come pre-formatted from
// `formatWorkflowEventLine` (stored in `workflowEventLog`); verbose agent-log
// formatting (💬/🧠/🔧/✅/❌/🤝/📊) is ported here from console-status.ts.
//
// Design:
//   - On construction, snapshot current state so pre-existing entries are never
//     re-printed.
//   - On each store notification, compute deltas and print only new entries,
//     then advance the watermarks.
//   - Watermarks are id/seq based (not length based): shared/client-store caps
//     session logs at MAX_SESSION_LOG (500) and workflowEventLog at 1000. Once
//     capped, `.length` stays constant while content shifts, so a length-based
//     watermark would silently drop all subsequent entries.

import type { ClientStore, ClientStoreState } from '@engin/shared/client-store';
import type { LogEntry } from '@engin/shared/event-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StdoutRendererDeps {
  clientStore: ClientStore;
  verbose: boolean;
  formatTime: (date?: Date) => string;
}

export interface StdoutRenderer {
  /** Unsubscribe from the store. No further output is produced after disposal. */
  dispose: () => void;
}

interface SessionSnapshot {
  /** id of the last LogEntry already rendered (null = nothing seen yet). */
  lastSeenLogId: string | null;
  inputTokens: number;
  outputTokens: number;
}

// ─── Verbose Agent-Log Formatting ───────────────────────────────────────────
// Ports the verbose turn/tool_call formatting from console-status.ts into a
// delta-based renderer. Each new agent log entry is mapped to an emoji line
// (without the timestamp prefix — the caller prepends `formatTime()`).

function formatVerboseSessionLogLine(entry: LogEntry, agentId: string): string | null {
  switch (entry.type) {
    case 'text':
      return `💬 ${entry.content}`;
    case 'thinking':
      return `🧠 ${entry.content}`;
    case 'tool_call_start': {
      const toolName = String(entry.metadata?.toolName ?? entry.content);
      const args = entry.metadata?.arguments ?? {};
      return `🔧 ${toolName}(${JSON.stringify(args)}) (agent: ${agentId})`;
    }
    case 'tool_call_end': {
      const toolName = String(entry.metadata?.toolName ?? entry.content);
      const isError = entry.metadata?.isError === true;
      const icon = isError ? '❌' : '✅';
      const label = isError ? 'Tool error' : 'Tool result';
      return `${icon} ${label}: ${toolName} (agent: ${agentId})`;
    }
    case 'decision':
      return `🤝 Decision by ${agentId}: ${entry.content}`;
    // 'error' agent-log entries are surfaced via the workflowEventLog
    // lifecycle path (formatWorkflowEventLine) — skip here to avoid
    // double-printing.
    default:
      return null;
  }
}

// ─── Renderer Factory ───────────────────────────────────────────────────────

export function createStdoutRenderer(deps: StdoutRendererDeps): StdoutRenderer {
  const { clientStore, verbose, formatTime } = deps;

  // ── Watermarks ────────────────────────────────────────────────────────
  // Track by stable id/seq rather than array length: ClientStore caps each
  // agent's log at MAX_AGENT_LOG (500) and workflowEventLog at 1000. Once
  // capped, `.length` stays constant while content shifts, so a length-based
  // watermark would skip every new entry (silent output loss). With an id
  // cursor we locate the last-seen entry and print everything after it; if it
  // was evicted by the cap we resync from the current head.
  let lastSeenEventSeq: number | null = null;
  let lastRunLogLength = 0;
  const sessionSnapshots = new Map<string, SessionSnapshot>();

  // Snapshot current state on construction so pre-existing entries are not
  // re-printed on the first notification.
  const initialState = clientStore.getState();
  const initialEventLog = initialState.workflowEventLog;
  lastSeenEventSeq = initialEventLog.length > 0 ? initialEventLog[initialEventLog.length - 1].seq : null;
  lastRunLogLength = initialState.runLog.length;
  for (const [key, session] of Object.entries(initialState.sessions)) {
    sessionSnapshots.set(key, {
      lastSeenLogId: session.log.length > 0 ? session.log[session.log.length - 1].id : null,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
    });
  }

  function onChange(state: ClientStoreState): void {
    // Isolate the renderer so a throw (e.g. formatTime, broken stdout) does
    // not disrupt other ClientStore subscribers. Failures go to stderr so they
    // are visible even when stdout is a broken pipe.
    try {
      // 1. Lifecycle event lines (all modes).
      //    workflowEventLog entries are pre-formatted by formatWorkflowEventLine.
      //    Find the index of the last-seen seq; if it is no longer present
      //    (evicted by the 1000-entry cap) resync from the current head.
      const eventLog = state.workflowEventLog;
      let eventStart = 0;
      if (lastSeenEventSeq !== null) {
        const idx = eventLog.findIndex((e) => e.seq === lastSeenEventSeq);
        eventStart = idx === -1 ? 0 : idx + 1;
      }
      for (let i = eventStart; i < eventLog.length; i++) {
        // Lifecycle lines from formatWorkflowEventLine are self-timestamped
        // (`HH:mm:ssam/pm | … -> …`), so print them as-is — do NOT prepend
        // formatTime() (that would double up the timestamp). The bracketed
        // formatTime() prefix is reserved for verbose agent-log / runLog
        // lines below, which carry no embedded time.
        console.log(eventLog[i].line);
      }
      if (eventLog.length > 0) {
        lastSeenEventSeq = eventLog[eventLog.length - 1].seq;
      }

      // 2. Session log deltas + token deltas (verbose only).
      if (verbose) {
        for (const [key, session] of Object.entries(state.sessions)) {
          const prev = sessionSnapshots.get(key);
          const tokenBase: Pick<SessionSnapshot, 'inputTokens' | 'outputTokens'> = prev ?? {
            inputTokens: 0,
            outputTokens: 0,
          };
          const lastSeenId = prev?.lastSeenLogId ?? null;

          // Locate the last-seen log entry id; if it is gone (evicted by the
          // 500-entry cap) resync from the current head.
          let logStart = 0;
          if (lastSeenId !== null) {
            const idx = session.log.findIndex((e) => e.id === lastSeenId);
            logStart = idx === -1 ? 0 : idx + 1;
          }

          for (let i = logStart; i < session.log.length; i++) {
            const line = formatVerboseSessionLogLine(session.log[i], session.agentId);
            if (line !== null) {
              console.log(`${formatTime()} ${line}`);
            }
          }

          const deltaIn = session.inputTokens - tokenBase.inputTokens;
          const deltaOut = session.outputTokens - tokenBase.outputTokens;
          if (deltaIn !== 0 || deltaOut !== 0) {
            console.log(`${formatTime()} 📊 Tokens: ${deltaIn} in / ${deltaOut} out`);
          }

          sessionSnapshots.set(key, {
            lastSeenLogId: session.log.length > 0 ? session.log[session.log.length - 1].id : lastSeenId,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          });
        }
      }

      // 3. runLog deltas (all modes): warn → ⚠️, error → ❌, info → silent.
      const runLog = state.runLog;
      const runStart = Math.min(lastRunLogLength, runLog.length);
      for (let i = runStart; i < runLog.length; i++) {
        const entry = runLog[i];
        if (entry.level === 'warn') {
          console.log(`${formatTime()} ⚠️ ${entry.message}`);
        } else if (entry.level === 'error') {
          console.log(`${formatTime()} ❌ ${entry.message}`);
        }
        // info → silent
      }
      lastRunLogLength = runLog.length;
    } catch (err) {
      try {
        process.stderr.write(`[stdout-renderer] error during render: ${String(err)}\n`);
      } catch {
        // stderr itself is broken — nothing more we can do.
      }
    }
  }

  const unsubscribe = clientStore.subscribe(onChange);

  return {
    dispose() {
      unsubscribe();
    },
  };
}
