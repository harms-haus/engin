#!/usr/bin/env bun

import { loadEnvFiles } from '@harms-haus/engin-engine';
import { pathToFileURL } from 'node:url';
import {
  initCommand,
  resumeCommand,
  runCommand,
  serverDownCommand,
  serverStatusCommand,
  serverUpCommand,
} from './cli/commands.js';
import { formatTime } from './cli/console-status.js';
import type { CliOptions } from './cli/parse-args.js';
import { parseArgs, USAGE, VERSION } from './cli/parse-args.js';

// ─── Re-export for backward compatibility ───────────────────────────────────

export { initCommand, parseArgs, resumeCommand, runCommand, serverDownCommand, serverStatusCommand, serverUpCommand };
export type { CliOptions };

// ─── Main Entry Point ───────────────────────────────────────────────────────

let cliOptions: CliOptions | undefined;

export async function main(): Promise<void> {
  cliOptions = parseArgs(process.argv.slice(2));
  const options = cliOptions;

  // Print any warnings from argument parsing
  for (const warning of options.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }

  // Load .env files for commands that need them (skip for help/version)
  if (options.command !== 'help' && options.command !== 'version') {
    const envResult = loadEnvFiles(options.cwd);
    if (options.verbose && envResult.loadedFiles.length > 0) {
      for (const file of envResult.loadedFiles) {
        console.log(`${formatTime()} 📄 Loaded .env: ${file}`);
      }
    }
  }

  if (options.command === 'help') {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (options.command === 'version') {
    process.stdout.write(`engin v${VERSION}\n`);
    process.exit(0);
  }
  if (options.command === 'init') {
    await initCommand(options);
    return;
  }
  if (options.command === 'resume') {
    await resumeCommand(options);
    return;
  }
  if (options.command === 'server') {
    if (options.serverAction === 'up') {
      await serverUpCommand(options);
    } else if (options.serverAction === 'down') {
      await serverDownCommand(options);
    } else if (options.serverAction === 'status') {
      await serverStatusCommand(options);
    } else {
      throw new Error('Unknown server action: ' + options.serverAction);
    }
    return;
  }
  if (options.command === 'run' && !options.workflowName) {
    throw new Error('Workflow name and task prompt are required. Usage: engin run workflow-name task-prompt');
  }
  await runCommand(options);
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    const msg = err instanceof Error ? (cliOptions?.verbose ? err.stack : err.message) : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  });
}
