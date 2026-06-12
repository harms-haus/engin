import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { useEnvSandbox } from './helpers/env-sandbox.js';
import { useTempDir } from './helpers/use-temp-dir.js';

// ─── main() interactive mode integration ─────────────────────────────────────
//
// This file isolates mock.module calls for ../src/tui/composer.js so they
// cannot leak into other test files. Bun hoists mock.module calls to module
// scope regardless of where they appear in the source, so any file that
// calls mock.module must be its own test file.

describe('main() interactive mode integration', () => {
  useEnvSandbox();
  const { getDir: _getDir } = useTempDir();
  void _getDir;

  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let runComposerMock: ReturnType<typeof mock>;

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
  });

  it('process.exit(0) when runComposer returns null (user cancelled)', async () => {
    runComposerMock = mock(() => Promise.resolve(null));
    mock.module('../src/tui/composer.js', () => ({
      runComposer: runComposerMock,
    }));

    // Re-import main to pick up the mock
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
