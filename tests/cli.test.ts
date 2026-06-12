import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliOptions } from '../src/cli.ts';
import { main, parseArgs } from '../src/cli.ts';
import { useEnvSandbox } from './helpers/env-sandbox.js';
import { useTempDir } from './helpers/use-temp-dir.js';

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses run command with workflowName and taskPrompt', () => {
    const result = parseArgs(['develop', 'build a feature', '--cwd', '/c']);
    expect(result).toEqual({
      command: 'run',
      workflowName: 'develop',
      taskPrompt: 'build a feature',
      cwd: '/c',
      workDir: undefined,
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    });
  });

  it('parses run with all options', () => {
    const result = parseArgs([
      'develop',
      'build a feature',
      '--cwd',
      '/c',
      '--work-dir',
      '/w',
      '--max-concurrent',
      '5',
      '--verbose',
      '--api-key',
      'anthropic=sk-xxx',
      '--api-key',
      'openai=pk-yyy',
    ]);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBe('develop');
    expect(result.taskPrompt).toBe('build a feature');
    expect(result.cwd).toBe('/c');
    expect(result.workDir).toBe('/w');
    expect(result.maxConcurrent).toBe(5);
    expect(result.verbose).toBe(true);
    expect(result.apiKeys).toEqual({
      anthropic: 'sk-xxx',
      openai: 'pk-yyy',
    });
  });

  it('parses init command', () => {
    const result = parseArgs(['init']);
    expect(result.command).toBe('init');
  });

  it('returns interactive mode when no command is given (empty args)', () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      command: 'run',
      cwd: process.cwd(),
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    });
    expect(result.workflowName).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
  });

  it('returns interactive mode with flags parsed when only flags are given', () => {
    const result = parseArgs(['--verbose', '--worktree', '--cwd', '/custom']);
    expect(result).toEqual({
      command: 'run',
      cwd: '/custom',
      maxConcurrent: 5,
      verbose: true,
      worktree: true,
      apiKeys: {},
      warnings: [],
    });
    expect(result.workflowName).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
  });

  it('returns interactive mode with --max-concurrent flag', () => {
    const result = parseArgs(['--max-concurrent', '3']);
    expect(result).toEqual({
      command: 'run',
      cwd: process.cwd(),
      maxConcurrent: 3,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    });
  });

  it('returns interactive mode with --api-key warning', () => {
    const result = parseArgs(['--api-key', 'anthropic=sk-test']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBeUndefined();
    expect(result.apiKeys).toEqual({ anthropic: 'sk-test' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('--api-key');
  });

  it('throws on missing task prompt for run', () => {
    expect(() => parseArgs(['develop'])).toThrow(/Missing required <task-prompt>/);
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['develop', 'task', '--bogus'])).toThrow(/Unknown flag/);
  });

  it('throws on init with extra positional', () => {
    expect(() => parseArgs(['init', 'extra'])).toThrow(/Unexpected argument/);
  });

  it('throws on invalid --api-key format', () => {
    expect(() => parseArgs(['develop', 'task', '--api-key', 'noequals'])).toThrow(/Invalid --api-key format/);
  });

  it('--cwd defaults to process.cwd()', () => {
    const result = parseArgs(['init']);
    expect(result.cwd).toBe(process.cwd());
    expect(result.command).toBe('init');
  });

  it('--max-concurrent defaults to 5', () => {
    const result = parseArgs(['develop', 'task']);
    expect(result.maxConcurrent).toBe(5);
  });

  it('--verbose defaults to false', () => {
    const result = parseArgs(['init']);
    expect(result.verbose).toBe(false);
    expect(result.command).toBe('init');
  });

  it('parses --api-key repeatable', () => {
    const result = parseArgs(['develop', 'task', '--api-key', 'anthropic=sk-xxx', '--api-key', 'openai=pk-yyy']);
    expect(result.apiKeys).toEqual({
      anthropic: 'sk-xxx',
      openai: 'pk-yyy',
    });
  });

  describe('--max-concurrent validation', () => {
    it('accepts valid positive integer', () => {
      const result = parseArgs(['develop', 'task', '--max-concurrent', '5']);
      expect(result.maxConcurrent).toBe(5);
    });

    it('rejects zero', () => {
      expect(() => parseArgs(['develop', 'task', '--max-concurrent', '0'])).toThrow(/positive integer/);
    });

    it('rejects negative number', () => {
      expect(() => parseArgs(['develop', 'task', '--max-concurrent', '-1'])).toThrow(/positive integer/);
    });

    it('rejects float', () => {
      expect(() => parseArgs(['develop', 'task', '--max-concurrent', '1.5'])).toThrow(/positive integer/);
    });

    it('rejects non-numeric string', () => {
      expect(() => parseArgs(['develop', 'task', '--max-concurrent', 'abc'])).toThrow(/positive integer/);
    });

    it('rejects empty string', () => {
      expect(() => parseArgs(['develop', 'task', '--max-concurrent', ''])).toThrow(/positive integer/);
    });
  });

  describe('--help and --version', () => {
    it("--help returns { command: 'help' }", () => {
      const result = parseArgs(['--help']);
      expect(result).toEqual({
        command: 'help',
        cwd: process.cwd(),
        maxConcurrent: 5,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      });
    });

    it("-h returns { command: 'help' }", () => {
      const result = parseArgs(['-h']);
      expect(result.command).toBe('help');
    });

    it("--version returns { command: 'version' }", () => {
      const result = parseArgs(['--version']);
      expect(result).toEqual({
        command: 'version',
        cwd: process.cwd(),
        maxConcurrent: 5,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      });
    });

    it("-v returns { command: 'version' }", () => {
      const result = parseArgs(['-v']);
      expect(result.command).toBe('version');
    });

    it('--help works when mixed with other args', () => {
      const result = parseArgs(['develop', 'task', '--help']);
      expect(result.command).toBe('help');
    });
  });

  describe('main() handles help and version', () => {
    let exitSpy: ReturnType<typeof spyOn>;
    let stdoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it('main() calls process.exit(0) for --help', async () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'cli.ts', '--help'];
      try {
        await expect(main()).rejects.toThrow('process.exit(0)');
      } finally {
        process.argv = originalArgv;
      }
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('Usage:');
    });

    it('main() calls process.exit(0) for --version', async () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'cli.ts', '--version'];
      try {
        await expect(main()).rejects.toThrow('process.exit(0)');
      } finally {
        process.argv = originalArgv;
      }
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('engin v');
    });
  });

  it('treats non-keyword first positional as workflow name (implicit run)', () => {
    const result = parseArgs(['my-workflow', 'do something', '--cwd', '/c']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBe('my-workflow');
    expect(result.taskPrompt).toBe('do something');
  });

  describe('web command', () => {
    it('parses web command with defaults', () => {
      const result = parseArgs(['web']);
      expect(result.command).toBe('web');
      expect(result.host).toBeUndefined();
      expect(result.port).toBeUndefined();
      expect(result.cwd).toBe(process.cwd());
      expect(result.verbose).toBe(false);
      expect(result.maxConcurrent).toBe(5);
      expect(result.apiKeys).toEqual({});
      expect(result.warnings).toEqual([]);
    });

    it('parses web command with --host and --port', () => {
      const result = parseArgs(['web', '--host', '0.0.0.0', '--port', '3619']);
      expect(result.command).toBe('web');
      expect(result.host).toBe('0.0.0.0');
      expect(result.port).toBe(3619);
    });

    it('parses web with --cwd', () => {
      const result = parseArgs(['web', '--cwd', '/some/path']);
      expect(result.command).toBe('web');
      expect(result.cwd).toBe('/some/path');
    });

    it('parses web with --verbose', () => {
      const result = parseArgs(['web', '--verbose']);
      expect(result.command).toBe('web');
      expect(result.verbose).toBe(true);
    });

    it('parses web with --api-key', () => {
      const result = parseArgs(['web', '--api-key', 'anthropic=sk-xxx']);
      expect(result.command).toBe('web');
      expect(result.apiKeys).toEqual({ anthropic: 'sk-xxx' });
    });

    it('throws on --port with non-numeric string', () => {
      expect(() => parseArgs(['web', '--port', 'abc'])).toThrow(/--port must be an integer/);
    });

    it('throws on --port with zero', () => {
      expect(() => parseArgs(['web', '--port', '0'])).toThrow(/--port must be an integer between 1 and 65535/);
    });

    it('throws on --port with value > 65535', () => {
      expect(() => parseArgs(['web', '--port', '65536'])).toThrow(/--port must be an integer between 1 and 65535/);
    });

    it('throws on --port with negative value', () => {
      expect(() => parseArgs(['web', '--port', '-1'])).toThrow(/--port must be an integer between 1 and 65535/);
    });

    it('throws on --port with float value', () => {
      expect(() => parseArgs(['web', '--port', '3619.5'])).toThrow(/--port must be an integer/);
    });

    it('throws on --host without value', () => {
      expect(() => parseArgs(['web', '--host'])).toThrow(/Missing value/);
    });

    it('throws on --port without value', () => {
      expect(() => parseArgs(['web', '--port'])).toThrow(/Missing value/);
    });

    it('throws on extra positional argument after web', () => {
      expect(() => parseArgs(['web', 'extra'])).toThrow(/Unexpected argument/);
    });

    it('throws on multiple extra positional arguments after web', () => {
      expect(() => parseArgs(['web', 'extra1', 'extra2'])).toThrow(/Unexpected argument/);
    });

    it('--host can be a valid hostname like 127.0.0.1', () => {
      const result = parseArgs(['web', '--host', '127.0.0.1']);
      expect(result.host).toBe('127.0.0.1');
    });

    it('--host can be a hostname like localhost', () => {
      const result = parseArgs(['web', '--host', 'localhost']);
      expect(result.host).toBe('localhost');
    });

    it('--port accepts valid port 1', () => {
      const result = parseArgs(['web', '--port', '1']);
      expect(result.port).toBe(1);
    });

    it('--port accepts valid port 65535', () => {
      const result = parseArgs(['web', '--port', '65535']);
      expect(result.port).toBe(65535);
    });
  });

  describe('--worktree flag', () => {
    it('defaults to false for run command', () => {
      const result = parseArgs(['develop', 'task']);
      expect(result.command).toBe('run');
      expect(result.worktree).toBe(false);
    });

    it('sets worktree to true when --worktree is passed for run', () => {
      const result = parseArgs(['develop', 'task', '--worktree']);
      expect(result.command).toBe('run');
      expect(result.worktree).toBe(true);
    });

    it('sets worktree to true when --worktree is passed with other flags for run', () => {
      const result = parseArgs(['develop', 'task', '--worktree', '--verbose', '--cwd', '/tmp']);
      expect(result.command).toBe('run');
      expect(result.worktree).toBe(true);
      expect(result.verbose).toBe(true);
      expect(result.cwd).toBe('/tmp');
    });

    it('defaults to false for help command', () => {
      const result = parseArgs(['--help']);
      expect(result.command).toBe('help');
      expect(result.worktree).toBe(false);
    });

    it('defaults to false for version command', () => {
      const result = parseArgs(['--version']);
      expect(result.command).toBe('version');
      expect(result.worktree).toBe(false);
    });

    it('defaults to false for init command', () => {
      const result = parseArgs(['init']);
      expect(result.command).toBe('init');
      expect(result.worktree).toBe(false);
    });

    it('defaults to false for web command', () => {
      const result = parseArgs(['web']);
      expect(result.command).toBe('web');
      expect(result.worktree).toBe(false);
    });

    it('defaults to false for web command even with other flags', () => {
      const result = parseArgs(['web', '--verbose', '--host', '0.0.0.0']);
      expect(result.command).toBe('web');
      expect(result.worktree).toBe(false);
    });

    it('sets worktree to true for resume command', () => {
      const result = parseArgs(['resume', 'my-session', '--worktree']);
      expect(result.command).toBe('resume');
      expect(result.sessionName).toBe('my-session');
      expect(result.worktree).toBe(true);
    });

    it('defaults to false for resume command without flag', () => {
      const result = parseArgs(['resume', 'my-session']);
      expect(result.command).toBe('resume');
      expect(result.worktree).toBe(false);
    });

    it('is recognized as a valid flag (not rejected as unknown)', () => {
      expect(() => parseArgs(['develop', 'task', '--worktree'])).not.toThrow();
    });
  });

  describe('USAGE string', () => {
    it('includes --worktree in the help text', async () => {
      const originalArgv = process.argv;
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

      process.argv = ['node', 'cli.ts', '--help'];
      try {
        await expect(main()).rejects.toThrow('process.exit(0)');
      } finally {
        process.argv = originalArgv;
      }

      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('--worktree');
      expect(output).toMatch(/--worktree\s+Run workflow in a git worktree/);
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    });
  });

  it('CliOptions type includes worktree: boolean', () => {
    // Compile-time check: if CliOptions doesn't have worktree, this won't compile.
    // Runtime check: create a value and verify the property exists.
    const opts: CliOptions = {
      command: 'run',
      workflowName: 'develop',
      taskPrompt: 'task',
      cwd: process.cwd(),
      maxConcurrent: 5,
      verbose: false,
      worktree: true,
      apiKeys: {},
      warnings: [],
    };
    expect(opts.worktree).toBe(true);
    expect(typeof opts.worktree).toBe('boolean');
  });
});

// ─── main() loads .env files ────────────────────────────────────────────────

describe('main() loads .env files', () => {
  useEnvSandbox();
  const { getDir } = useTempDir();

  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('loads .env from .engin/.env for init command', async () => {
    // Create .engin/.env in temp dir
    const harnessDir = join(getDir(), '.engin');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, '.env'), 'TEST_CLI_ENV_VAR=from_cli_test\n');

    // Point global config to temp so initDefaultConfig() writes there
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(getDir(), 'global');

    const originalArgv = process.argv;
    process.argv = ['node', 'cli.ts', 'init', '--cwd', getDir()];
    try {
      await main();
    } finally {
      process.argv = originalArgv;
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
    }

    expect(process.env.TEST_CLI_ENV_VAR).toBe('from_cli_test');
  });

  it('does not load .env files for help command', async () => {
    const harnessDir = join(getDir(), '.engin');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, '.env'), 'TEST_CLI_ENV_VAR_HELP=should_not_appear\n');

    const originalArgv = process.argv;
    process.argv = ['node', 'cli.ts', '--help', '--cwd', getDir()];
    try {
      await expect(main()).rejects.toThrow('process.exit(0)');
    } finally {
      process.argv = originalArgv;
    }

    expect(process.env.TEST_CLI_ENV_VAR_HELP).toBeUndefined();
  });

  it('does not load .env files for version command', async () => {
    const harnessDir = join(getDir(), '.engin');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, '.env'), 'TEST_CLI_ENV_VAR_VERSION=should_not_appear\n');

    const originalArgv = process.argv;
    process.argv = ['node', 'cli.ts', '--version', '--cwd', getDir()];
    try {
      await expect(main()).rejects.toThrow('process.exit(0)');
    } finally {
      process.argv = originalArgv;
    }

    expect(process.env.TEST_CLI_ENV_VAR_VERSION).toBeUndefined();
  });
});

// ─── main() interactive mode ─────────────────────────────────────────────────

describe('main() interactive mode', () => {
  it('parseArgs([]) returns command run with undefined workflowName for interactive mode', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
  });

  it('parseArgs with only flags returns run command with undefined workflowName', () => {
    const result = parseArgs(['--verbose', '--worktree', '--cwd', '/tmp']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
    expect(result.verbose).toBe(true);
    expect(result.worktree).toBe(true);
    expect(result.cwd).toBe('/tmp');
  });

  it('parseArgs with --max-concurrent returns interactive mode with correct value', () => {
    const result = parseArgs(['--max-concurrent', '10']);
    expect(result.command).toBe('run');
    expect(result.maxConcurrent).toBe(10);
    expect(result.workflowName).toBeUndefined();
  });

  it('parseArgs with --api-key returns interactive mode with key parsed', () => {
    const result = parseArgs(['--api-key', 'openai=sk-123']);
    expect(result.command).toBe('run');
    expect(result.apiKeys).toEqual({ openai: 'sk-123' });
    expect(result.warnings).toHaveLength(1);
  });

  it('parseArgs with --work-dir still returns interactive mode', () => {
    const result = parseArgs(['--work-dir', '/wd']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBeUndefined();
    // workDir should be parsed even in interactive mode
    // (note: workDir is not on the returned object for the no-positionals case,
    //  but flags should not cause errors)
  });

  it('parseArgs empty does NOT have workDir in returned interactive result', () => {
    // The interactive return path doesn't include workDir in the object
    const result = parseArgs([]);
    expect(result).not.toHaveProperty('workDir');
    expect(result).toEqual({
      command: 'run',
      cwd: process.cwd(),
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
    });
  });

  it('normal run command still works with workflowName and taskPrompt', () => {
    const result = parseArgs(['develop', 'do something']);
    expect(result.command).toBe('run');
    expect(result.workflowName).toBe('develop');
    expect(result.taskPrompt).toBe('do something');
  });

  it('init command is not affected by interactive mode changes', () => {
    const result = parseArgs(['init']);
    expect(result.command).toBe('init');
  });

  it('web command is not affected by interactive mode changes', () => {
    const result = parseArgs(['web', '--port', '4000']);
    expect(result.command).toBe('web');
    expect(result.port).toBe(4000);
  });

  it('resume command is not affected by interactive mode changes', () => {
    const result = parseArgs(['resume', 'my-session']);
    expect(result.command).toBe('resume');
    expect(result.sessionName).toBe('my-session');
  });

  it('--help still works (checked before positional parsing)', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('--version still works (checked before positional parsing)', () => {
    const result = parseArgs(['--version']);
    expect(result.command).toBe('version');
  });
});
