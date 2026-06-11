import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStatusCallbacks, formatTime, main, parseArgs, shouldUseTui } from '../src/cli.ts';
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
      maxConcurrent: 3,
      verbose: false,
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

  it('throws on missing command', () => {
    expect(() => parseArgs([])).toThrow(/Missing command/);
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

  it('--max-concurrent defaults to 3', () => {
    const result = parseArgs(['develop', 'task']);
    expect(result.maxConcurrent).toBe(3);
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
        maxConcurrent: 3,
        verbose: false,
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
        maxConcurrent: 3,
        verbose: false,
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
      expect(result.maxConcurrent).toBe(3);
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
});

// ─── formatTime ─────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('returns bracketed time format', () => {
    const result = formatTime();
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
  });
});

// ─── createStatusCallbacks ─────────────────────────────────────────────────

describe('createStatusCallbacks', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('non-verbose has no agent-level callbacks', () => {
    const callbacks = createStatusCallbacks(false);
    expect(callbacks.onTurnStart).toBeUndefined();
    expect(callbacks.onTurnEnd).toBeUndefined();
    expect(callbacks.onToolCallStart).toBeUndefined();
    expect(callbacks.onToolCallEnd).toBeUndefined();
  });

  it('verbose has agent-level callbacks', () => {
    const callbacks = createStatusCallbacks(true);
    expect(typeof callbacks.onTurnStart).toBe('function');
    expect(typeof callbacks.onTurnEnd).toBe('function');
    expect(typeof callbacks.onToolCallStart).toBe('function');
    expect(typeof callbacks.onToolCallEnd).toBe('function');
  });

  it('onWorkflowStart logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowStart!({
      taskPrompt: 'build it',
      resumed: false,
      workDir: '/tmp',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow started/);
  });

  it('onPhaseStart logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onPhaseStart!({ phase: 'planning' as never, round: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Phase started/);
  });

  it('onWorkflowComplete logs duration', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowComplete!({
      totalDurationMs: 5000,
      agentCount: 3,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow complete/);
  });

  it('onWorkflowFailed logs error', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowFailed!({
      error: new Error('boom'),
      phase: 'execution',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow failed/);
  });

  it('onTurnStart logs in verbose mode', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnStart!({ agentId: 'agent-1', turn: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Turn/);
  });

  it('onToolCallStart logs tool name and arguments', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onToolCallStart!({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      arguments: { path: '/foo.ts' },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('read_file');
    expect(output).toContain('/foo.ts');
    expect(output).toContain('agent-1');
  });

  it('onTurnEnd renders text content blocks in verbose mode', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'text', text: 'Hello world' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Hello world/);
    expect(logSpy.mock.calls[0][0]).not.toMatch(/Turn .* ended/);
  });

  it('onTurnEnd renders thinking content', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'thinking', thinking: 'Let me think...' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/🧠/);
    expect(logSpy.mock.calls[0][0]).toMatch(/Let me think\.\.\./);
  });

  it('onTurnEnd renders redacted thinking', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'thinking', thinking: '', redacted: true }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/redacted thinking/);
  });

  it('onTurnEnd silently ignores toolCall content blocks (regression)', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/foo.ts' } }],
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('onTurnEnd renders tokens when present', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: undefined,
      tokens: { input: 100, output: 50 },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/Tokens/);
    expect(output).toMatch(/100 in \/ 50 out/);
  });

  it('onTurnEnd produces no output when no content and no tokens', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: undefined,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('onTurnEnd with multi-line text renders fully', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'text', text: 'line1\nline2\nline3' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('line1');
    expect(output).toContain('line2');
    expect(output).toContain('line3');
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

// ─── shouldUseTui ────────────────────────────────────────────────────────────

describe('shouldUseTui', () => {
  const baseOptions = {
    command: 'run' as const,
    cwd: '/tmp',
    maxConcurrent: 3,
    verbose: false,
    apiKeys: {},
    warnings: [],
  };

  it('returns true when verbose=false and stdout.isTTY=true', () => {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      expect(shouldUseTui(baseOptions)).toBe(true);
    } finally {
      if (original === undefined) {
        Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      } else {
        Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
      }
    }
  });

  it('returns false when verbose=true regardless of TTY', () => {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      expect(shouldUseTui({ ...baseOptions, verbose: true })).toBe(false);
    } finally {
      if (original === undefined) {
        Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      } else {
        Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
      }
    }
  });

  it('returns false when stdout.isTTY is false', () => {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      expect(shouldUseTui(baseOptions)).toBe(false);
    } finally {
      if (original === undefined) {
        Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      } else {
        Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
      }
    }
  });

  it('returns false when stdout.isTTY is undefined', () => {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    try {
      expect(shouldUseTui(baseOptions)).toBe(false);
    } finally {
      if (original === undefined) {
        Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      } else {
        Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
      }
    }
  });
});
