#!/usr/bin/env node

import { run } from "./workflows/develop.js";
import type { StatusCallbacks } from "./core/types.js";

// ─── CLI Options ────────────────────────────────────────────────────────────

export interface CliOptions {
  taskPrompt: string;
  profilesDir: string;
  cwd: string;
  workDir: string;
  maxConcurrent: number;
  verbose: boolean;
  apiKeys: Record<string, string>;
}

// ─── Argument Parsing ───────────────────────────────────────────────────────

const USAGE = `Usage: workflow-harness <task-prompt> --profiles-dir <path> --cwd <path> --work-dir <path> [--max-concurrent <n>] [--verbose] [--api-key <provider=key>]`;

export function parseArgs(argv: string[]): CliOptions {
  let taskPrompt: string | undefined;
  let profilesDir: string | undefined;
  let cwd: string | undefined;
  let workDir: string | undefined;
  let maxConcurrent = 3;
  let verbose = false;
  const apiKeys: Record<string, string> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--profiles-dir") {
      profilesDir = argv[++i];
    } else if (arg === "--cwd") {
      cwd = argv[++i];
    } else if (arg === "--work-dir") {
      workDir = argv[++i];
    } else if (arg === "--max-concurrent") {
      maxConcurrent = Number(argv[++i]);
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--api-key") {
      const pair = argv[++i];
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 0) {
        throw new Error(`Invalid --api-key format: expected provider=key, got "${pair}"\n${USAGE}`);
      }
      const provider = pair.slice(0, eqIdx);
      const key = pair.slice(eqIdx + 1);
      apiKeys[provider] = key;
    } else if (!arg.startsWith("--")) {
      if (taskPrompt === undefined) {
        taskPrompt = arg;
      } else {
        throw new Error(`Unexpected argument: "${arg}"\n${USAGE}`);
      }
    } else {
      throw new Error(`Unknown flag: "${arg}"\n${USAGE}`);
    }

    i++;
  }

  if (taskPrompt === undefined) {
    throw new Error(`Missing required <task-prompt>\n${USAGE}`);
  }
  if (!profilesDir) {
    throw new Error(`Missing required --profiles-dir\n${USAGE}`);
  }
  if (!cwd) {
    throw new Error(`Missing required --cwd\n${USAGE}`);
  }
  if (!workDir) {
    throw new Error(`Missing required --work-dir\n${USAGE}`);
  }

  return { taskPrompt, profilesDir, cwd, workDir, maxConcurrent, verbose, apiKeys };
}

// ─── Time Formatting ────────────────────────────────────────────────────────

export function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

// ─── Status Callbacks ───────────────────────────────────────────────────────

export function createStatusCallbacks(verbose: boolean): StatusCallbacks {
  const callbacks: StatusCallbacks = {
    onWorkflowStart: (info) => {
      console.log(`${formatTime()} 🚀 Workflow started: "${info.taskPrompt}" (resumed: ${info.resumed})`);
    },
    onWorkflowComplete: (info) => {
      console.log(`${formatTime()} 🎉 Workflow complete in ${info.totalDurationMs / 1000}s (${info.agentCount} agents)`);
    },
    onWorkflowFailed: (info) => {
      console.log(`${formatTime()} 💥 Workflow failed at phase ${info.phase}: ${info.error.message}`);
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
      console.log(`${formatTime()} ⚠️ Error in ${info.agentId}: ${info.error} (phase: ${info.phase})`);
    },
  };

  if (verbose) {
    callbacks.onTurnStart = (info) => {
      console.log(`${formatTime()} 🔄 Turn ${info.turn} started (agent: ${info.agentId})`);
    };
    callbacks.onTurnEnd = (info) => {
      const tokensPart = info.tokens ? `, tokens: ${info.tokens.input} in / ${info.tokens.output} out` : "";
      console.log(`${formatTime()} 🔄 Turn ${info.turn} ended (agent: ${info.agentId}${tokensPart})`);
    };
    callbacks.onToolCallStart = (info) => {
      console.log(`${formatTime()} 🔧 Tool call: ${info.toolName} (agent: ${info.agentId})`);
    };
    callbacks.onToolCallEnd = (info) => {
      const icon = info.isError ? "❌" : "✅";
      const label = info.isError ? "Tool error" : "Tool result";
      console.log(`${formatTime()} ${icon} ${label}: ${info.toolName} (agent: ${info.agentId})`);
    };
  }

  return callbacks;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const callbacks = createStatusCallbacks(options.verbose);

  await run(options.taskPrompt, {
    profilesDir: options.profilesDir,
    cwd: options.cwd,
    workDir: options.workDir,
    maxConcurrentTasks: options.maxConcurrent,
    apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
    onStatus: callbacks,
  });

  process.exit(0);
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
