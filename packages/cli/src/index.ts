// ─── CLI public API ────────────────────────────────────────────────────────
//
// The CLI package exports ONLY its own surface: the entrypoint, command
// handlers, argument parsing, and version/usage constants, plus the CLI
// options type. It deliberately does NOT re-export @harms-haus/engin-engine
// or @harms-haus/engin-tui — consumers that need engine or TUI types should
// depend on those packages directly.

export {
  USAGE,
  VERSION,
  initCommand,
  main,
  parseArgs,
  resumeCommand,
  runCommand,
  serverDownCommand,
  serverStatusCommand,
  serverUpCommand,
} from './cli.js';

export type { CliOptions } from './cli.js';
