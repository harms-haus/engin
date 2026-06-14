import type { StatusCallbacks } from '../core/types.js';

// ─── Time Formatting ────────────────────────────────────────────────────────

export function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}]`;
}

// ─── Status Callbacks ───────────────────────────────────────────────────────

export function createStatusCallbacks(verbose: boolean): StatusCallbacks {
  const callbacks: StatusCallbacks = {
    onWorkflowStart: (info) => {
      console.log(`${formatTime()} 🚀 Workflow started: "${info.taskPrompt}" (resumed: ${info.resumed})`);
    },
    onWorkflowComplete: (info) => {
      console.log(
        `${formatTime()} 🎉 Workflow complete in ${info.totalDurationMs / 1000}s (${info.agentCount} agents)`,
      );
    },
    onWorkflowFailed: (info) => {
      console.log(`${formatTime()} 💥 Workflow failed at phase ${info.phaseId}: ${info.error.message}`);
    },
    onPhaseStart: (info) => {
      console.log(`${formatTime()} 📦 Phase started: ${info.phase} (round ${info.round})`);
    },
    onPhaseComplete: (info) => {
      console.log(`${formatTime()} ✅ Phase completed: ${info.phase} (${info.durationMs / 1000}s)`);
    },
    onAgentSpawn: (info) => {
      console.log(`${formatTime()} ⏳ Agent spawned: ${info.agentId} (profile: ${info.profile})`);
    },
    onAgentComplete: (info) => {
      console.log(`${formatTime()} ✅ Agent complete: ${info.agentId}`);
    },
    onTaskStart: (info) => {
      console.log(`${formatTime()} 📋 Task started: ${info.taskId} - "${info.title}"`);
    },
    onTaskComplete: (info) => {
      console.log(`${formatTime()} ✅ Task complete: ${info.taskId}`);
    },
    onTaskRejected: (info) => {
      console.log(`${formatTime()} ❌ Task rejected: ${info.taskId} - ${info.reason}`);
    },
    onDecision: (info) => {
      console.log(`${formatTime()} 🤝 Decision by ${info.agentId}: ${info.decision}`);
    },
    onError: (info) => {
      console.log(`${formatTime()} ⚠️ Error in ${info.agentId}: ${info.error} (phase: ${info.phaseId})`);
    },
  };

  if (verbose) {
    callbacks.onTurnStart = (info) => {
      console.log(`${formatTime()} 🔄 Turn ${info.turn} started (agent: ${info.agentId})`);
    };
    callbacks.onTurnEnd = (info) => {
      if (info.contentBlocks && info.contentBlocks.length > 0) {
        for (const block of info.contentBlocks) {
          if (block.type === 'text') {
            console.log(`${formatTime()} 💬 ${block.text}`);
          } else if (block.type === 'thinking') {
            if (block.redacted) {
              console.log(`${formatTime()} 🧠 [redacted thinking]`);
            } else {
              console.log(`${formatTime()} 🧠 ${block.thinking}`);
            }
          }
        }
      }
      if (info.tokens) {
        console.log(`${formatTime()} 📊 Tokens: ${info.tokens.input} in / ${info.tokens.output} out`);
      }
    };
    callbacks.onToolCallStart = (info) => {
      console.log(`${formatTime()} 🔧 ${info.toolName}(${JSON.stringify(info.arguments)}) (agent: ${info.agentId})`);
    };
    callbacks.onToolCallEnd = (info) => {
      const icon = info.isError ? '❌' : '✅';
      const label = info.isError ? 'Tool error' : 'Tool result';
      console.log(`${formatTime()} ${icon} ${label}: ${info.toolName} (agent: ${info.agentId})`);
    };
  }

  return callbacks;
}

// ─── TUI Detection ─────────────────────────────────────────────────────────

/**
 * Determine whether to use the TUI dashboard instead of plain console output.
 * TUI is used when stdout is a TTY and verbose mode is not enabled.
 */
export function shouldUseTui(options: { verbose: boolean; isTty: boolean }): boolean {
  return !options.verbose && options.isTty;
}
