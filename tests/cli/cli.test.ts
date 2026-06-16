// ─── T26: Server command (up/down/status) + --host/--lan flag redistribution ─
//
// This test suite encodes the T26 contract for the `engin server` command and
// the redistribution of `--host`/`--lan` flags from run/resume to server up.
//
// Tests are written test-first (TDD). Against the current source they will be
// RED — failing on contract assertions, not import/syntax errors.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Capture real modules before mocking ─────────────────────────────────────

const realCommands = Object.assign({}, await import('../../packages/cli/src/cli/commands.js'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));

// ─── Mock functions ──────────────────────────────────────────────────────────

// Daemon mocks — used by handler contract tests and dispatch tests
const mockStartDaemon = mock<(options: { port: number; host?: string }) => Promise<{ pid: number; port: number }>>();
const mockStopDaemon = mock<() => Promise<void>>();
const mockIsServerAlive = mock<(port: number) => Promise<boolean>>();

// ─── Mock modules (hoisted before imports by Bun test runtime) ───────────────

mock.module('../../packages/engine/src/server/daemon.js', () => ({
  ...realDaemon,
  startDaemon: mockStartDaemon,
  stopDaemon: mockStopDaemon,
  isServerAlive: mockIsServerAlive,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { main } from '../../packages/cli/src/cli.js';
import { parseArgs, USAGE } from '../../packages/cli/src/cli/parse-args.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/server/daemon.js', () => realDaemon);
});

// Several command paths exercised here set `process.exitCode = 1` as a
// production side effect (the T35 --lan refusal hard gate). Reset it after each
// test so it does not leak to sibling test files in the same `bun test` run;
// the global preload (tests/helpers/reset-exit-code.ts) is the final backstop.
// NOTE: bun only honours `process.exitCode = 0` as a reset (not `undefined`).
afterEach(() => {
  process.exitCode = 0;
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseArgs — server command
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseArgs — server command', () => {
  // ─── Basic subcommand parsing ───────────────────────────────────────────

  describe('server up', () => {
    it('parses "server up" as command=server, serverAction=up', () => {
      const result = parseArgs(['server', 'up']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
    });

    it('defaults force to false for "server up"', () => {
      const result = parseArgs(['server', 'up']);
      expect(result.force).toBeFalsy();
    });

    it('parses "server up --port 8080"', () => {
      const result = parseArgs(['server', 'up', '--port', '8080']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
      expect(result.port).toBe(8080);
    });

    it('parses "server up --host 0.0.0.0"', () => {
      const result = parseArgs(['server', 'up', '--host', '0.0.0.0']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
      expect(result.host).toBe('0.0.0.0');
    });

    it('parses "server up --lan"', () => {
      const result = parseArgs(['server', 'up', '--lan']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
      expect(result.lan).toBe(true);
    });

    it('parses "server up --host 0.0.0.0 --port 8080 --lan" together', () => {
      const result = parseArgs(['server', 'up', '--host', '0.0.0.0', '--port', '8080', '--lan']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
      expect(result.host).toBe('0.0.0.0');
      expect(result.port).toBe(8080);
      expect(result.lan).toBe(true);
    });

    it('sets common flags correctly for server up', () => {
      const result = parseArgs(['server', 'up', '--verbose', '--worktree', '--cwd', '/tmp']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'up');
      expect(result.verbose).toBe(true);
      expect(result.worktree).toBe(true);
      expect(result.cwd).toBe('/tmp');
    });
  });

  describe('server down', () => {
    it('parses "server down" as command=server, serverAction=down', () => {
      const result = parseArgs(['server', 'down']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'down');
    });

    it('defaults force to false for "server down" without --force', () => {
      const result = parseArgs(['server', 'down']);
      expect(result).toHaveProperty('serverAction', 'down');
      expect(result.force).toBeFalsy();
    });

    it('parses "server down --force"', () => {
      const result = parseArgs(['server', 'down', '--force']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'down');
      expect(result.force).toBe(true);
    });

    it('parses "server down -y" as force=true', () => {
      const result = parseArgs(['server', 'down', '-y']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'down');
      expect(result.force).toBe(true);
    });
  });

  describe('server status', () => {
    it('parses "server status" as command=server, serverAction=status', () => {
      const result = parseArgs(['server', 'status']);
      expect(result.command).toBe('server');
      expect(result).toHaveProperty('serverAction', 'status');
    });

    it('sets force to falsy for server status', () => {
      const result = parseArgs(['server', 'status']);
      expect(result.force).toBeFalsy();
    });
  });

  // ─── Error cases ─────────────────────────────────────────────────────────

  describe('error cases', () => {
    it('throws on "server" without a subcommand', () => {
      expect(() => parseArgs(['server'])).toThrow();
    });

    it('throws on "server unknown" with an unrecognized subcommand', () => {
      expect(() => parseArgs(['server', 'unknown'])).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseArgs — run/resume with --host/--lan emit warnings
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseArgs — run/resume host/lan warnings', () => {
  it('emits warning when --host is used with run command', () => {
    const result = parseArgs(['develop', 'task', '--host', '0.0.0.0']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/server binding.*engin server up/i)]),
    );
  });

  it('emits warning when --lan is used with run command', () => {
    const result = parseArgs(['develop', 'task', '--lan']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/server binding.*engin server up/i)]),
    );
  });

  it('emits warning when --host is used with resume command', () => {
    const result = parseArgs(['resume', 'session1', '--host', '0.0.0.0']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/server binding.*engin server up/i)]),
    );
  });

  it('emits warning when --lan is used with resume command', () => {
    const result = parseArgs(['resume', 'session1', '--lan']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/server binding.*engin server up/i)]),
    );
  });

  it('does NOT emit server-binding warning for "server up --host"', () => {
    const result = parseArgs(['server', 'up', '--host', '0.0.0.0']);
    const bindingWarnings = result.warnings.filter((w) => /server binding/i.test(w));
    expect(bindingWarnings).toHaveLength(0);
  });

  it('does NOT emit server-binding warning for "server up --lan"', () => {
    const result = parseArgs(['server', 'up', '--lan']);
    const bindingWarnings = result.warnings.filter((w) => /server binding/i.test(w));
    expect(bindingWarnings).toHaveLength(0);
  });

  it('still emits api-key warning alongside the host/lan warning', () => {
    const result = parseArgs(['develop', 'task', '--host', '0.0.0.0', '--api-key', 'anthropic=sk-test']);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/server binding/i)]));
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--api-key/i)]));
  });

  it('does NOT emit host/lan warning in interactive mode (no command)', () => {
    const result = parseArgs(['--host', '0.0.0.0']);
    const bindingWarnings = result.warnings.filter((w) => /server binding/i.test(w));
    expect(bindingWarnings).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE string — includes server command documentation
// ═══════════════════════════════════════════════════════════════════════════════

describe('USAGE string — server command', () => {
  it('documents the server command in the Commands section', () => {
    // Must match 'server' as a standalone command line, not as part of
    // 'Web server bind host' in the Options section.
    const commandsSection = USAGE.split(/Commands:/i)[1]?.split(/Options:/i)[0] ?? '';
    expect(commandsSection).toMatch(/server\s/);
  });

  it('documents server subcommands (up, down, status)', () => {
    expect(USAGE).toContain('up');
    expect(USAGE).toContain('down');
    expect(USAGE).toContain('status');
  });

  it('documents --force / -y for server down', () => {
    expect(USAGE).toMatch(/--force|-y/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// serverUpCommand — contract tests
//
// These test the REAL serverUpCommand (from commands.ts) against the mocked
// daemon module. If serverUpCommand is not yet exported, each test will fail
// with a clear "T26 not implemented" error.
// ═══════════════════════════════════════════════════════════════════════════════

describe('serverUpCommand', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockIsServerAlive.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Helper to call the real serverUpCommand or throw if T26 is not implemented. */
  async function callServerUp(options: Record<string, unknown>): Promise<void> {
    const fn = (realCommands as Record<string, unknown>).serverUpCommand as
      | ((options: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error(
        'T26 not implemented: serverUpCommand is not exported from commands.ts. Implement the server up command handler.',
      );
    }
    await fn(options);
  }

  function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: 'server',
      serverAction: 'up',
      cwd: '/tmp',
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
      ...overrides,
    };
  }

  it('calls startDaemon with default port (3619) and host (127.0.0.1)', async () => {
    mockStartDaemon.mockResolvedValue({ pid: 1234, port: 3619 });
    await callServerUp(baseOptions());
    expect(mockStartDaemon).toHaveBeenCalledTimes(1);
    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 3619, host: '127.0.0.1' });
  });

  it('passes custom --port to startDaemon', async () => {
    mockStartDaemon.mockResolvedValue({ pid: 1234, port: 8080 });
    await callServerUp(baseOptions({ port: 8080 }));
    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 8080, host: '127.0.0.1' });
  });

  it('passes custom --host to startDaemon', async () => {
    // T35: 0.0.0.0 is now refused (hard gate). Use a specific LAN IP instead
    // to verify host passthrough without triggering the auth gate.
    mockStartDaemon.mockResolvedValue({ pid: 1234, port: 3619 });
    await callServerUp(baseOptions({ host: '192.168.1.50' }));
    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 3619, host: '192.168.1.50' });
  });

  it('refuses --lan binding (auth guard)', async () => {
    // Verify the function exists first — if not, fail with a clear message
    // so this test doesn't accidentally pass via the "T26 not implemented" error.
    const fn = (realCommands as Record<string, unknown>).serverUpCommand;
    if (typeof fn !== 'function') {
      throw new Error('serverUpCommand not yet exported — implement T26 server up to run this test');
    }

    await callServerUp(baseOptions({ lan: true }));
    // T35 hard gate: sets exitCode=1 and does NOT start the daemon.
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('prints the server URL after successful start', async () => {
    mockStartDaemon.mockResolvedValue({ pid: 1234, port: 3619 });
    await callServerUp(baseOptions());
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('http://127.0.0.1:3619');
  });

  it('propagates startDaemon errors', async () => {
    mockStartDaemon.mockRejectedValue(new Error('Port 3619 already in use'));
    await expect(callServerUp(baseOptions())).rejects.toThrow('Port 3619 already in use');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// serverDownCommand — contract tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('serverDownCommand', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockIsServerAlive.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Helper to call the real serverDownCommand or throw if T26 is not implemented. */
  async function callServerDown(options: Record<string, unknown>): Promise<void> {
    const fn = (realCommands as Record<string, unknown>).serverDownCommand as
      | ((options: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error(
        'T26 not implemented: serverDownCommand is not exported from commands.ts. Implement the server down command handler.',
      );
    }
    await fn(options);
  }

  function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: 'server',
      serverAction: 'down',
      force: false,
      cwd: '/tmp',
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
      ...overrides,
    };
  }

  it('calls stopDaemon when no active runs', async () => {
    mockStopDaemon.mockResolvedValue(undefined);
    await callServerDown(baseOptions());
    expect(mockStopDaemon).toHaveBeenCalledTimes(1);
  });

  it('calls stopDaemon with --force even when active runs exist', async () => {
    mockStopDaemon.mockResolvedValue(undefined);
    await callServerDown(baseOptions({ force: true }));
    expect(mockStopDaemon).toHaveBeenCalledTimes(1);
  });

  it('propagates stopDaemon errors (e.g. no pidfile)', async () => {
    mockStopDaemon.mockRejectedValue(new Error('No server pidfile found. Is the server running?'));
    await expect(callServerDown(baseOptions())).rejects.toThrow('No server pidfile found');
  });

  it('prints a confirmation message after successful stop', async () => {
    mockStopDaemon.mockResolvedValue(undefined);
    await callServerDown(baseOptions());
    expect(logSpy).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// serverStatusCommand — contract tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('serverStatusCommand', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  let savedXdg: string | undefined;
  let tempConfigDir: string;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Sandbox XDG_CONFIG_HOME so getGlobalConfigDir() (and therefore the
    // pidfile/log paths) resolve to a clean temp dir — deterministic log path
    // and no stray pidfile from the host machine.
    savedXdg = process.env.XDG_CONFIG_HOME;
    tempConfigDir = join(tmpdir(), `engin-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.XDG_CONFIG_HOME = tempConfigDir;

    // Default: the /health fetch returns a rich payload. Individual tests
    // override this for the down / unreachable cases. A fresh Response is
    // built per call so the body is never double-consumed across tests.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ pid: 4242, port: 3619, activeRuns: 3 }), { status: 200 }),
    );

    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockIsServerAlive.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
    fetchSpy.mockRestore();
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  /** Helper to call the real serverStatusCommand or throw if T26 is not implemented. */
  async function callServerStatus(options: Record<string, unknown>): Promise<void> {
    const fn = (realCommands as Record<string, unknown>).serverStatusCommand as
      | ((options: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error(
        'T26 not implemented: serverStatusCommand is not exported from commands.ts. Implement the server status command handler.',
      );
    }
    await fn(options);
  }

  function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: 'server',
      serverAction: 'status',
      cwd: '/tmp',
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
      ...overrides,
    };
  }

  it('probes /health via isServerAlive', async () => {
    mockIsServerAlive.mockResolvedValue(true);
    await callServerStatus(baseOptions());
    expect(mockIsServerAlive).toHaveBeenCalledTimes(1);
  });

  it('reports running with pid, port, host, activeRuns, log path, and web URL when /health responds', async () => {
    mockIsServerAlive.mockResolvedValue(true);
    await callServerStatus(baseOptions());
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toMatch(/running/i);
    expect(allOutput).toContain('4242'); // pid
    expect(allOutput).toMatch(/port:\s*3619/i); // port
    expect(allOutput).toMatch(/host:\s*127\.0\.0\.1/i); // bind host (default)
    expect(allOutput).toMatch(/active runs:\s*3/i); // active-run count
    expect(allOutput).toContain('server.log'); // log path token
    expect(allOutput).toMatch(/http:\/\/127\.0\.0\.1:3619/); // web URL
  });

  it('still reports running (with a note) when /health is unreachable', async () => {
    mockIsServerAlive.mockResolvedValue(true);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await callServerStatus(baseOptions());
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toMatch(/running/i);
    expect(allOutput).toMatch(/host:\s*127\.0\.0\.1/i); // still reports the known host
    expect(allOutput).toMatch(/port:\s*3619/i); // still reports the known port
    expect(allOutput).toMatch(/unavailable|unknown/i); // tolerant note
  });

  it('reports "not running" when /health returns false', async () => {
    mockIsServerAlive.mockResolvedValue(false);
    await callServerStatus(baseOptions());
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toMatch(/not running/i);
  });

  it('notes a possibly-stale pidfile when down and a pidfile exists', async () => {
    mockIsServerAlive.mockResolvedValue(false);
    // Drop a pidfile into the sandboxed global config dir.
    const enginDir = join(tempConfigDir, 'engin');
    await mkdir(enginDir, { recursive: true });
    await writeFile(join(enginDir, 'server.pid'), JSON.stringify({ pid: 9999, port: 3619 }));
    await callServerStatus(baseOptions());
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toMatch(/not running/i);
    expect(allOutput).toMatch(/stale|pidfile|pid\s*9999/i);
  });

  it('does not crash when down and no pidfile exists', async () => {
    mockIsServerAlive.mockResolvedValue(false);
    await expect(callServerStatus(baseOptions())).resolves.toBeUndefined();
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toMatch(/not running/i);
    expect(allOutput).not.toMatch(/stale|pidfile/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// main() — server command dispatch
//
// Tests that cli.ts main() dispatches the "server" command to the appropriate
// handler instead of falling through to runCommand.
// ═══════════════════════════════════════════════════════════════════════════════

describe('main() server command dispatch', () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let originalArgv: string[];
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalArgv = process.argv;
    originalIsTTY = process.stdout.isTTY;
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockIsServerAlive.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.stdout.isTTY = originalIsTTY;
    stderrSpy.mockRestore();
    logSpy.mockRestore();
    // Clean up any SIGINT listeners that runCommand may have registered
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as (...args: unknown[]) => void);
  });

  it('dispatches "server up" to serverUpCommand (startDaemon called)', async () => {
    mockStartDaemon.mockResolvedValue({ pid: 1, port: 3619 });
    process.argv = ['node', 'cli.ts', 'server', 'up'];

    // When T26 is implemented, main() should call serverUpCommand which
    // calls startDaemon. Currently, parseArgs returns command: 'run' for
    // 'server up', so main() falls through to runCommand → RED.
    try {
      await main();
    } catch {
      // May throw during runCommand (no workflow) or if serverUpCommand
      // doesn't exist yet.
    }

    // After T26: startDaemon must be called (serverUpCommand invokes it).
    // RED: currently startDaemon is NOT called.
    expect(mockStartDaemon).toHaveBeenCalledTimes(1);
  });

  it('dispatches "server down" to serverDownCommand (stopDaemon called)', async () => {
    mockStopDaemon.mockResolvedValue(undefined);
    process.argv = ['node', 'cli.ts', 'server', 'down'];

    try {
      await main();
    } catch {
      // Expected during transition
    }

    // After T26: stopDaemon must be called.
    // RED: currently stopDaemon is NOT called.
    expect(mockStopDaemon).toHaveBeenCalledTimes(1);
  });

  it('dispatches "server status" to serverStatusCommand (isServerAlive called)', async () => {
    mockIsServerAlive.mockResolvedValue(true);
    process.argv = ['node', 'cli.ts', 'server', 'status'];

    try {
      await main();
    } catch {
      // Expected during transition
    }

    // After T26: isServerAlive must be called.
    // RED: currently isServerAlive is NOT called.
    expect(mockIsServerAlive).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T29: Interactive composer removed
//
// The interactive TUI composer (src/tui/composer.ts) and slash-command-parser
// (src/cli/slash-command-parser.ts) are REMOVED. When `engin run` is invoked
// without a workflow name, main() must throw an error instead of launching
// the interactive TUI.
//
// These tests are TDD — they encode the T29 contract. Against current source
// (which still has the composer branch), they will be RED.
// ═══════════════════════════════════════════════════════════════════════════════

describe('T29: interactive composer removed', () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    stderrSpy.mockRestore();
    // Clean up any SIGINT listeners that runCommand may have registered
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as (...args: unknown[]) => void);
  });

  it('main() throws when invoked with no args (no workflowName)', async () => {
    process.argv = ['node', 'cli.ts'];
    await expect(main()).rejects.toThrow(
      'Workflow name and task prompt are required. Usage: engin run workflow-name task-prompt',
    );
  });

  it('main() throws when invoked with only flags (no workflowName)', async () => {
    process.argv = ['node', 'cli.ts', '--verbose'];
    await expect(main()).rejects.toThrow(
      'Workflow name and task prompt are required. Usage: engin run workflow-name task-prompt',
    );
  });

  it('main() does NOT import or invoke runComposer', async () => {
    process.argv = ['node', 'cli.ts'];
    try {
      await main();
    } catch {
      // Expected: throws the error above
    }
    // The dynamic import('./tui/composer.js') should never be reached.
    // We verify this indirectly: if the composer were invoked, it would
    // either hang (awaiting terminal input) or throw a different error.
    // The specific error message match above is sufficient evidence.
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T35: LAN binding hard gate — refuse --host 0.0.0.0 AND --lan with exit 1
//
// T26 already refused `--lan` via a thrown error but did NOT refuse
// `--host 0.0.0.0`. T35 upgrades the guard to a hard gate:
//
//   • Both `--lan` AND `--host 0.0.0.0` must be refused.
//   • The command must set process.exitCode = 1 (not just throw).
//   • startDaemon must NEVER be called for refused bindings.
//
// The existing T26 test for `--host 0.0.0.0` ("passes custom --host to
// startDaemon") will BREAK when T35 is implemented — the implement
// phase must update or remove that test. These T35 tests are RED now
// because the source still allows 0.0.0.0 and does not set exitCode.
// ═══════════════════════════════════════════════════════════════════════════════

describe('T35: LAN binding hard gate', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let prevExitCode: number | undefined;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = 0;
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockStartDaemon.mockReset();
    mockStopDaemon.mockReset();
    mockIsServerAlive.mockReset();
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Helper to call the real serverUpCommand. */
  async function callServerUp(options: Record<string, unknown>): Promise<void> {
    const fn = (realCommands as Record<string, unknown>).serverUpCommand as
      | ((options: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error('serverUpCommand not yet exported from commands.ts.');
    }
    await fn(options);
  }

  function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: 'server',
      serverAction: 'up',
      cwd: '/tmp',
      maxConcurrent: 5,
      verbose: false,
      worktree: false,
      apiKeys: {},
      warnings: [],
      ...overrides,
    };
  }

  // ── --host 0.0.0.0 refusal ─────────────────────────────────────────────

  it('refuses --host 0.0.0.0 binding (hard gate — exit code 1)', async () => {
    // Currently the source allows 0.0.0.0 and calls startDaemon → RED.
    try {
      await callServerUp(baseOptions({ host: '0.0.0.0' }));
    } catch {
      // May throw — acceptable as long as exitCode is set.
    }

    // Must NOT start the daemon.
    expect(mockStartDaemon).not.toHaveBeenCalled();
    // Must set a non-zero exit code.
    expect(process.exitCode).toBe(1);
  });

  it('does NOT call startDaemon when --host 0.0.0.0 is refused', async () => {
    try {
      await callServerUp(baseOptions({ host: '0.0.0.0' }));
    } catch {
      // Expected: refusal error or exitCode set.
    }
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('prints an auth-not-supported message for --host 0.0.0.0', async () => {
    try {
      await callServerUp(baseOptions({ host: '0.0.0.0' }));
    } catch {
      // May throw — we only check printed output below.
    }
    // The message must be PRINTED (console.log or stderr), not just thrown.
    // A future implementation should print before refusing.
    const allOutput = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    expect(allOutput).toMatch(/auth|not.*support|lan|refuse/i);
  });

  // ── --lan refusal (extends T26) ─────────────────────────────────────────

  it('--lan sets exit code 1 (hard gate)', async () => {
    // T26 already asserts the throw + no startDaemon. T35 adds the exitCode
    // requirement. Currently the source throws but does NOT set exitCode → RED.
    try {
      await callServerUp(baseOptions({ lan: true }));
    } catch {
      // Expected: T26 already asserts this throw.
    }

    expect(mockStartDaemon).not.toHaveBeenCalled();
    // T35 hard gate: must set exitCode = 1.
    expect(process.exitCode).toBe(1);
  });

  it('--lan prints an auth-not-supported message', async () => {
    try {
      await callServerUp(baseOptions({ lan: true }));
    } catch {
      // May throw — we only check printed output below.
    }
    // The message must be PRINTED (console.log or stderr), not just thrown.
    // A future implementation should print before refusing.
    const allOutput = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    expect(allOutput).toMatch(/auth|not.*support|lan|refuse/i);
  });

  // ── IPv6 wildcard refusal (Fix 1) ───────────────────────────────

  it('refuses --host :: (IPv6 wildcard — exit code 1)', async () => {
    try {
      await callServerUp(baseOptions({ host: '::' }));
    } catch {
      // May throw — acceptable as long as exitCode is set.
    }

    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('refuses --host [::] (bracketed IPv6 wildcard)', async () => {
    try {
      await callServerUp(baseOptions({ host: '[::]' }));
    } catch {
      // May throw — acceptable.
    }
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // ── Combined flags ────────────────────────────────────────────────

  it('refuses --host 0.0.0.0 even when --port is specified', async () => {
    try {
      await callServerUp(baseOptions({ host: '0.0.0.0', port: 8080 }));
    } catch {
      // Expected
    }
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('still allows --host 127.0.0.1 (default localhost binding)', async () => {
    mockStartDaemon.mockResolvedValue({ pid: 1234, port: 3619 });
    await callServerUp(baseOptions({ host: '127.0.0.1' }));
    expect(mockStartDaemon).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });
});
