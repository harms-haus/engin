import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepDefinition, Task } from '../core/types.js';
import { buildPrompt } from './prompt-builder.js';

// ── Fixture cleanup ────────────────────────────────────────────────────────

const fixtureDirs: string[] = [];

// ── Minimal fixture helpers ─────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Implement auth',
    prompt: 'Add OAuth2 login support',
    profile: 'default',
    files: [],
    dependencies: [],
    worktree: 'none',
    status: 'active',
    phaseId: 'code',
    ...overrides,
  };
}

function makeStep(overrides?: Partial<StepDefinition>): StepDefinition {
  return {
    name: 'write-code',
    profileId: 'default',
    isReadOnly: false,
    ...overrides,
  };
}

/** Create a temp dir with a src/api.ts file inside. Returns the cwd. */
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-builder-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'api.ts'), 'export const API = "v1";');
  fixtureDirs.push(dir);
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  afterEach(() => {
    for (const dir of fixtureDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    fixtureDirs.length = 0;
  });
  it('injects task.files contents on fresh call (no opts)', async () => {
    const cwd = fixtureDir();
    const task = makeTask({ files: ['src/api.ts'] });
    const step = makeStep();

    const result = await buildPrompt(task, step, cwd);

    expect(result).toContain('```typescript');
    expect(result).toContain('### src/api.ts');
    expect(result).toContain('export const API = "v1";');
  });

  it('skips task.files contents when skipFiles is true', async () => {
    const cwd = fixtureDir();
    const task = makeTask({ files: ['src/api.ts'] });
    const step = makeStep();

    const result = await buildPrompt(task, step, cwd, { skipFiles: true });

    expect(result).not.toContain('```typescript');
    expect(result).not.toContain('### src/api.ts');
    expect(result).not.toContain('export const API = "v1";');
    expect(result).toContain('Implement auth'); // task.title
    expect(result).toContain('Add OAuth2 login support'); // task.prompt
  });

  it('still appends reviewFeedback when skipFiles is true', async () => {
    const cwd = fixtureDir();
    const task = makeTask({
      files: ['src/api.ts'],
      reviewFeedback: ['Fix the types', 'Add tests'],
    });
    const step = makeStep();

    const result = await buildPrompt(task, step, cwd, { skipFiles: true });

    expect(result).toContain('Review Feedback History');
    expect(result).toContain('Attempt 1: Fix the types');
    expect(result).toContain('Attempt 2: Add tests');
  });

  it('omits file section entirely when task.files is empty', async () => {
    const cwd = fixtureDir();
    const task = makeTask({ files: [] });
    const step = makeStep();

    const result = await buildPrompt(task, step, cwd);

    expect(result).not.toContain('```');
    expect(result).not.toContain('### ');
  });
});
