import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as composerModule from '../src/tui/composer.js';
import { useEnvSandbox } from './helpers/env-sandbox.js';
import { useTempDir } from './helpers/use-temp-dir.js';

// ─── main() interactive mode integration ─────────────────────────────────────
//
// Uses spyOn on the composer module namespace instead of mock.module to
// avoid global module pollution. mock.module replaces the module globally
// and persists across test files, breaking other tests that import from
// the same module.

describe('main() interactive mode integration', () => {
  useEnvSandbox();
  const { getDir: _getDir } = useTempDir();
  void _getDir;

  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let composerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    stderrSpy.mockRestore();
    composerSpy?.mockRestore();
  });

  it('process.exit(0) when runComposer returns null (user cancelled)', async () => {
    composerSpy = spyOn(composerModule, 'runComposer').mockImplementation(() => Promise.resolve(null));

    // Re-import main to pick up the mocked module
    const { main: mainFresh } = await import('../src/cli.ts');

    const originalArgv = process.argv;
    process.argv = ['node', 'cli.ts'];
    try {
      await expect(mainFresh()).rejects.toThrow('process.exit(0)');
    } finally {
      process.argv = originalArgv;
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
