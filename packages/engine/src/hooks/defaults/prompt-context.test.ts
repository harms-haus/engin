// ─── Tests for hooks/defaults/prompt-context.ts ────────────────────────────
//
// `defaultCollectContext` and `defaultBeforeStepPrompt` are the DEFAULT
// implementations of the `collectContext` (all-run) and `beforeSessionPrompt`
// (pipeline) hooks. They reproduce — EXACTLY — the file-inlining + prompt
// assembly behavior currently in `pool/prompt-builder.ts::buildPrompt`, so
// existing workflows are unchanged when the engine switches to invoking the
// hooks (task-10).
//
// Two-cwd world (post-worktrees): files resolve against the per-task WORKTREE
// cwd (`args.worktreeCwd ?? args.cwd`), NOT the run cwd. This is the single
// behavioral difference from the legacy `buildPrompt(task, step, cwd)`
// single-cwd signature, and it is covered explicitly below.
//
// Required scenarios (from the task):
//   (a) files resolve against worktreeCwd when present
//   (b) binary files are skipped
//   (c) files >10KB are truncated
//   (d) empty task.files produces no context blocks
//   (e) language detection matches prompt-builder.ts behavior
// Plus: absolute paths, multi-file concatenation, missing-file tolerance, and
// full `defaultBeforeStepPrompt` parity with `buildPrompt`.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Task } from '../../core/types.js';
import { buildPrompt } from '../../pool/prompt-builder.js';
import type { StepDefinition } from '../../pool/types.js';
import { createHookRegistry } from '../registry.js';
import type { BeforeSessionPromptArgs, CollectContextArgs, HookContext } from '../types.js';
import { defaultBeforeStepPrompt, defaultCollectContext } from './prompt-context.js';

// ── Constants mirrored from prompt-builder.ts ──────────────────────────────
//
// MAX_FILE_BYTES is the truncation cap; LANG_CASES is a representative slice
// of LANG_MAP; BINARY_EXTS samples BINARY_EXTENSIONS. They are duplicated here
// ONLY so the tests can assert the default reproduces buildPrompt — if the
// shared source of truth drifts, these tests flag it.

const MAX_FILE_BYTES = 10_000;

const LANG_CASES: Array<[ext: string, lang: string]> = [
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.py', 'python'],
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.md', 'markdown'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.sql', 'sql'],
  ['.toml', 'toml'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
];

const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.woff2', '.exe'];

// ── Fixture helpers ─────────────────────────────────────────────────────────

const fixtureDirs: string[] = [];

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

/**
 * Minimal HookContext. The defaults read from `args`, not `ctx`, but a valid
 * context is threaded through (defaultBeforeStepPrompt forwards it to
 * defaultCollectContext). Uses a real registry instance, mirroring
 * compose.test.ts's makeCtx.
 */
function makeCtx(): HookContext {
  return { registry: createHookRegistry(), cwd: '/repo', workDir: '/repo/.engin/work/run-1' };
}

function collectArgs(
  opts: {
    task?: Partial<Task>;
    step?: Partial<StepDefinition>;
    cwd?: string;
    worktreeCwd?: string;
  } = {},
): CollectContextArgs {
  const args: CollectContextArgs = {
    task: makeTask(opts.task),
    step: makeStep(opts.step),
    cwd: opts.cwd ?? '/repo',
  };
  if (opts.worktreeCwd !== undefined) args.worktreeCwd = opts.worktreeCwd;
  return args;
}

function beforeArgs(
  opts: {
    task?: Partial<Task>;
    step?: Partial<StepDefinition>;
    cwd?: string;
    worktreeCwd?: string;
    prompt?: string;
  } = {},
): BeforeSessionPromptArgs {
  const task = makeTask(opts.task);
  const args: BeforeSessionPromptArgs = {
    task,
    step: makeStep(opts.step),
    cwd: opts.cwd ?? '/repo',
    prompt: opts.prompt ?? task.prompt,
  };
  if (opts.worktreeCwd !== undefined) args.worktreeCwd = opts.worktreeCwd;
  return args;
}

/** Create a fresh temp dir and register it for afterEach cleanup. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-context-test-'));
  fixtureDirs.push(dir);
  return dir;
}

/** Write a file under `dir` at the relative path, creating parent dirs. */
function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

afterEach(() => {
  while (fixtureDirs.length) rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
});

// ── defaultCollectContext ───────────────────────────────────────────────────

describe('defaultCollectContext', () => {
  // ── (d) empty / absent task.files ────────────────────────────────────────
  describe('(d) empty / all-skipped task.files produce no context', () => {
    it('returns nothing (undefined) when task.files is []', async () => {
      const result = await defaultCollectContext(collectArgs({ task: { files: [] } }), makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns nothing when every listed file is binary (all skipped)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'a.png', 'fake-png-bytes');
      writeFile(cwd, 'b.zip', 'fake-zip-bytes');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['a.png', 'b.zip'] }, cwd }), makeCtx());
      expect(result).toBeUndefined();
    });
  });

  // ── return shape (single file) ───────────────────────────────────────────
  describe('return shape — single file', () => {
    it('returns a ContextBlock whose label is the filepath', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['src/api.ts'] }, cwd }), makeCtx());
      expect(result).toBeDefined();
      expect(result!.label).toBe('src/api.ts');
    });

    it('places the file content inside a fenced code block', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['src/api.ts'] }, cwd }), makeCtx());
      expect(result!.content).toContain('```typescript\nexport const API = "v1";\n```');
    });
  });

  // ── (a) files resolve against worktreeCwd when present ───────────────────
  describe('(a) files resolve against worktreeCwd when present', () => {
    it('reads file contents from worktreeCwd, NOT cwd', async () => {
      const runCwd = tempDir();
      const worktreeCwd = tempDir();
      writeFile(runCwd, 'src/api.ts', 'FROM_RUN_CWD');
      writeFile(worktreeCwd, 'src/api.ts', 'FROM_WORKTREE_CWD');

      const result = await defaultCollectContext(
        collectArgs({ task: { files: ['src/api.ts'] }, cwd: runCwd, worktreeCwd }),
        makeCtx(),
      );
      expect(result!.content).toContain('FROM_WORKTREE_CWD');
      expect(result!.content).not.toContain('FROM_RUN_CWD');
    });

    it('falls back to cwd when worktreeCwd is absent (legacy single-cwd behavior)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'FROM_CWD');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['src/api.ts'] }, cwd }), makeCtx());
      expect(result!.content).toContain('FROM_CWD');
    });

    it('resolves nested relative paths against worktreeCwd', async () => {
      const runCwd = tempDir();
      const worktreeCwd = tempDir();
      writeFile(worktreeCwd, 'deep/nested/mod.ts', 'NESTED_WORKTREE');
      const result = await defaultCollectContext(
        collectArgs({ task: { files: ['deep/nested/mod.ts'] }, cwd: runCwd, worktreeCwd }),
        makeCtx(),
      );
      expect(result!.content).toContain('NESTED_WORKTREE');
    });
  });

  // ── absolute paths ───────────────────────────────────────────────────────
  describe('absolute file paths', () => {
    it('does not join an absolute path with cwd/worktreeCwd', async () => {
      const cwd = tempDir();
      const worktreeCwd = tempDir();
      const elsewhere = tempDir();
      writeFile(elsewhere, 'abs.ts', 'ABSOLUTE_CONTENT');
      const absPath = join(elsewhere, 'abs.ts');

      const result = await defaultCollectContext(
        collectArgs({ task: { files: [absPath] }, cwd, worktreeCwd }),
        makeCtx(),
      );
      expect(result!.content).toContain('ABSOLUTE_CONTENT');
      // The absolute path is used verbatim as the label.
      expect(result!.label).toBe(absPath);
    });
  });

  // ── (b) binary files are skipped ─────────────────────────────────────────
  describe('(b) binary files are skipped', () => {
    it.each(BINARY_EXTS)('skips a %s file but keeps a sibling .ts file', async (ext) => {
      const cwd = tempDir();
      writeFile(cwd, `asset${ext}`, `fake-${ext}-bytes`);
      writeFile(cwd, 'code.ts', 'export const X = 1;');
      const result = await defaultCollectContext(
        collectArgs({ task: { files: [`asset${ext}`, 'code.ts'] }, cwd }),
        makeCtx(),
      );
      expect(result).toBeDefined();
      expect(result!.content).toContain('export const X = 1;');
      // The binary file's (text) bytes are NOT inlined.
      expect(result!.content).not.toContain(`fake-${ext}-bytes`);
    });
  });

  // ── (e) language detection matches prompt-builder.ts ─────────────────────
  describe('(e) language detection matches prompt-builder.ts', () => {
    it.each(LANG_CASES)('detects %s → %s', async (ext, lang) => {
      const cwd = tempDir();
      writeFile(cwd, `file${ext}`, 'BODY');
      const result = await defaultCollectContext(collectArgs({ task: { files: [`file${ext}`] }, cwd }), makeCtx());
      // Opening fence carries the lang tag immediately followed by the body.
      expect(result!.content).toContain('```' + lang + '\nBODY\n```');
    });

    it('uses the bare extension for an unknown extension (.foo → foo)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'weird.foo', 'BODY');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['weird.foo'] }, cwd }), makeCtx());
      expect(result!.content).toContain('```foo\nBODY\n```');
    });

    it('uses an empty language tag for a file with no extension', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'README', 'BODY');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['README'] }, cwd }), makeCtx());
      // No lang → bare triple-backtick fence.
      expect(result!.content).toContain('```\nBODY\n```');
    });

    it('produces the SAME fenced block as buildPrompt (parity)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
      const task = makeTask({ files: ['src/api.ts'] });
      const step = makeStep();
      const block = await defaultCollectContext(collectArgs({ task, step, cwd }), makeCtx());
      const prompt = await buildPrompt(task, step, cwd);
      // buildPrompt emits "### src/api.ts\n```typescript\n...\n```"; the default's
      // block must contain the identical fenced-code region.
      const fence = '```typescript\nexport const API = "v1";\n```';
      expect(block!.content).toContain(fence);
      expect(prompt).toContain(fence);
    });
  });

  // ── (c) files >10KB are truncated ────────────────────────────────────────
  describe('(c) files >10KB are truncated', () => {
    it('truncates a file larger than 10KB and appends the truncation marker', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'big.ts', 'a'.repeat(MAX_FILE_BYTES + 5_000));
      const result = await defaultCollectContext(collectArgs({ task: { files: ['big.ts'] }, cwd }), makeCtx());
      expect(result!.content).toContain('a'.repeat(MAX_FILE_BYTES));
      expect(result!.content).toContain('\n... (truncated)');
      // Bytes beyond the cap are NOT present (no run longer than MAX_FILE_BYTES).
      expect(result!.content).not.toContain('a'.repeat(MAX_FILE_BYTES + 1));
    });

    it('does NOT truncate a file that is exactly 10KB (boundary)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'exact.ts', 'a'.repeat(MAX_FILE_BYTES));
      const result = await defaultCollectContext(collectArgs({ task: { files: ['exact.ts'] }, cwd }), makeCtx());
      expect(result!.content).not.toContain('... (truncated)');
      expect(result!.content).toContain('a'.repeat(MAX_FILE_BYTES));
    });

    it('truncates at the SAME 10KB boundary as buildPrompt (parity)', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'big.ts', 'a'.repeat(MAX_FILE_BYTES * 2));
      const task = makeTask({ files: ['big.ts'] });
      const step = makeStep();
      const block = await defaultCollectContext(collectArgs({ task, step, cwd }), makeCtx());
      const prompt = await buildPrompt(task, step, cwd);
      const truncated = 'a'.repeat(MAX_FILE_BYTES) + '\n... (truncated)';
      expect(block!.content).toContain(truncated);
      expect(prompt).toContain(truncated);
    });
  });

  // ── multiple files & error tolerance ─────────────────────────────────────
  describe('multiple files & missing-file tolerance', () => {
    it('concatenates every inlined file in listed order', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'a.ts', 'AAA_BODY');
      writeFile(cwd, 'b.py', 'BBB_BODY');
      const result = await defaultCollectContext(collectArgs({ task: { files: ['a.ts', 'b.py'] }, cwd }), makeCtx());
      expect(result).toBeDefined();
      const aIdx = result!.content.indexOf('AAA_BODY');
      const bIdx = result!.content.indexOf('BBB_BODY');
      expect(aIdx).toBeGreaterThanOrEqual(0);
      expect(bIdx).toBeGreaterThan(aIdx); // a.ts listed before b.py
      expect(result!.content).toContain('```typescript\nAAA_BODY\n```');
      expect(result!.content).toContain('```python\nBBB_BODY\n```');
    });

    it('skips a missing file without throwing and still inlines the rest', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'there.ts', 'PRESENT');
      const result = await defaultCollectContext(
        collectArgs({ task: { files: ['missing.ts', 'there.ts'] }, cwd }),
        makeCtx(),
      );
      expect(result).toBeDefined();
      expect(result!.content).toContain('PRESENT');
    });
  });
});

// ── defaultBeforeStepPrompt ─────────────────────────────────────────────────

describe('defaultBeforeStepPrompt', () => {
  it('prepends file context BEFORE the prompt body (value)', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
    const task = makeTask({ files: ['src/api.ts'] });
    const args = beforeArgs({ task, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    const ctxIdx = result.indexOf('export const API = "v1";');
    const bodyIdx = result.indexOf(task.prompt);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(ctxIdx);
  });

  it('includes the task title + step name headers', async () => {
    const cwd = tempDir();
    const task = makeTask({ title: 'Do the thing', files: [] });
    const args = beforeArgs({
      task,
      step: { name: 'review-it', profileId: 'r', isReadOnly: true },
      cwd,
      prompt: task.prompt,
    });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    expect(result).toContain('## Task: Do the thing');
    expect(result).toContain('## Step: review-it');
  });

  it('appends the review feedback history when present', async () => {
    const cwd = tempDir();
    const task = makeTask({ files: [], reviewFeedback: ['Fix the types', 'Add tests'] });
    const args = beforeArgs({ task, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    expect(result).toContain('## Review Feedback History (please address all items)');
    expect(result).toContain('Attempt 1: Fix the types');
    expect(result).toContain('Attempt 2: Add tests');
  });

  it('reproduces buildPrompt EXACTLY (files + review feedback, worktreeCwd absent)', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
    const task = makeTask({
      files: ['src/api.ts'],
      reviewFeedback: ['Fix the types', 'Add tests'],
    });
    const step = makeStep();
    const args = beforeArgs({ task, step, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    const expected = await buildPrompt(task, step, cwd);
    expect(result).toBe(expected);
  });

  it('reproduces buildPrompt EXACTLY when there are no files', async () => {
    const cwd = tempDir();
    const task = makeTask({ files: [] });
    const step = makeStep();
    const args = beforeArgs({ task, step, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    const expected = await buildPrompt(task, step, cwd);
    expect(result).toBe(expected);
  });

  it('uses the incoming `value` (NOT task.prompt) as the prompt body — pipeline contract', async () => {
    // buildPrompt always uses task.prompt as the body. The pipeline hook must
    // instead honor the incoming `value`: when value differs from task.prompt,
    // the value is what appears and task.prompt does NOT. This pins the pipeline
    // semantics (a prior subscriber's transform flows through) and guards
    // against an impl that silently hardcodes task.prompt.
    const cwd = tempDir();
    const task = makeTask({ files: [] });
    const args = beforeArgs({ task, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt('A CUSTOM PIPELINE VALUE', args, makeCtx());
    expect(result).toContain('A CUSTOM PIPELINE VALUE');
    expect(result).not.toContain(task.prompt);
  });

  // ── worktreeCwd propagation through the pipeline hook ───────────────────
  describe('worktreeCwd propagation (two-cwd through the pipeline)', () => {
    it('reads file contents from worktreeCwd, NOT cwd, in the final prompt', async () => {
      const runCwd = tempDir();
      const worktreeCwd = tempDir();
      writeFile(runCwd, 'src/api.ts', 'FROM_RUN_CWD');
      writeFile(worktreeCwd, 'src/api.ts', 'FROM_WORKTREE_CWD');
      const task = makeTask({ files: ['src/api.ts'] });
      const args = beforeArgs({ task, cwd: runCwd, worktreeCwd, prompt: task.prompt });
      const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
      expect(result).toContain('FROM_WORKTREE_CWD');
      expect(result).not.toContain('FROM_RUN_CWD');
    });

    it('falls back to cwd in the final prompt when worktreeCwd is absent', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'FROM_CWD');
      const task = makeTask({ files: ['src/api.ts'] });
      const args = beforeArgs({ task, cwd, prompt: task.prompt });
      const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
      expect(result).toContain('FROM_CWD');
    });
  });

  // ── section assembly order & review-feedback omission ───────────────────
  describe('section assembly', () => {
    it('emits sections in buildPrompt order: Task header, Step header, files, prompt, review', async () => {
      const cwd = tempDir();
      writeFile(cwd, 'src/api.ts', 'FILE_BODY');
      const task = makeTask({ files: ['src/api.ts'], reviewFeedback: ['FB1'] });
      const args = beforeArgs({ task, cwd, prompt: task.prompt });
      const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
      const taskHdr = result.indexOf('## Task:');
      const stepHdr = result.indexOf('## Step:');
      const fileBody = result.indexOf('FILE_BODY');
      const promptBody = result.indexOf(task.prompt);
      const reviewHdr = result.indexOf('## Review Feedback History');
      expect(taskHdr).toBeGreaterThanOrEqual(0);
      expect(stepHdr).toBeGreaterThan(taskHdr);
      expect(fileBody).toBeGreaterThan(stepHdr);
      expect(promptBody).toBeGreaterThan(fileBody);
      expect(reviewHdr).toBeGreaterThan(promptBody);
    });

    it('omits the review feedback section entirely when reviewFeedback is absent', async () => {
      const cwd = tempDir();
      const task = makeTask({ files: [] });
      const args = beforeArgs({ task, cwd, prompt: task.prompt });
      const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
      expect(result).not.toContain('Review Feedback History');
      expect(result).not.toContain('Attempt ');
    });

    it('omits the review feedback section when reviewFeedback is an empty array', async () => {
      const cwd = tempDir();
      const task = makeTask({ files: [], reviewFeedback: [] });
      const args = beforeArgs({ task, cwd, prompt: task.prompt });
      const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
      expect(result).not.toContain('Review Feedback History');
    });
  });

  // ── comprehensive multi-file parity ─────────────────────────────────────
  it('reproduces buildPrompt EXACTLY across multiple files (mixed lang, binary skip, truncation)', async () => {
    const cwd = tempDir();
    writeFile(cwd, 'a.ts', 'AAA');
    writeFile(cwd, 'b.png', 'fake-bytes');
    writeFile(cwd, 'c.md', 'CCC');
    writeFile(cwd, 'big.py', 'z'.repeat(MAX_FILE_BYTES + 1000));
    const task = makeTask({
      files: ['a.ts', 'b.png', 'c.md', 'big.py'],
      reviewFeedback: ['FB1', 'FB2'],
    });
    const step = makeStep();
    const args = beforeArgs({ task, step, cwd, prompt: task.prompt });
    const result = await defaultBeforeStepPrompt(task.prompt, args, makeCtx());
    const expected = await buildPrompt(task, step, cwd);
    expect(result).toBe(expected);
    // Sanity: the binary file's text bytes are absent and truncation is present.
    expect(result).not.toContain('fake-bytes');
    expect(result).toContain('... (truncated)');
  });
});

// ── beforeSessionPrompt pipeline composition (via registry.invokePipeline) ─────
//
// `beforeSessionPrompt` is a PIPELINE hook: the engine declares it with
// `defineHook('beforeSessionPrompt', 'pipeline')` and invokes it via
// `registry.invokePipeline('beforeSessionPrompt', seed, args, ctx)`. Each
// subscriber receives the output of the previous one (or the seed for the
// first) and returns the next — so a workflow's user hooks CHAIN with the
// default file-inlining subscriber instead of replacing it.
//
// These tests exercise the registry-level pipeline contract for the concrete
// `beforeSessionPrompt` hook name (now declared on `WorkflowHooks`, so the
// literal needs no cast): registration order === execution order, the output
// of subscriber N is the input of subscriber N+1, and the default subscriber
// is "just another stage" a user hook can wrap.

describe('beforeSessionPrompt pipeline composition (registry.invokePipeline)', () => {
  /**
   * A registry with `beforeSessionPrompt` declared as a pipeline, mirroring the
   * engine's setup (`defineHook` before any `register`). Returns the registry
   * so the test can register subscribers and invoke the pipeline.
   */
  function pipelineRegistry(): ReturnType<typeof createHookRegistry> {
    const registry = createHookRegistry();
    registry.defineHook('beforeSessionPrompt', 'pipeline');
    return registry;
  }

  // ── (1) pipeline chains: later subscriber sees earlier output ──────────
  it('(1) chains two prepending subscribers so the final prompt is `[B][A]original`', async () => {
    // Subscriber A prepends "[A]"; subscriber B prepends "[B]". Registered in
    // order [A, B], the pipeline runs A first → "[A]original", then B →
    // "[B][A]original". The later subscriber (B) sees A's output, NOT the seed.
    const registry = pipelineRegistry();
    registry.register({
      beforeSessionPrompt: [(value: string) => `[A]${value}`, (value: string) => `[B]${value}`],
    });

    const result = (await registry.invokePipeline(
      'beforeSessionPrompt',
      'original',
      beforeArgs(),
      makeCtx(),
    )) as string;

    expect(result).toBe('[B][A]original');
  });

  it('runs subscribers strictly in registration order', async () => {
    const registry = pipelineRegistry();
    const order: string[] = [];
    registry.register({
      beforeSessionPrompt: [
        (v: string) => {
          order.push('A');
          return v;
        },
        (v: string) => {
          order.push('B');
          return v;
        },
        async (v: string) => {
          order.push('C');
          return v;
        },
      ],
    });

    await registry.invokePipeline('beforeSessionPrompt', 'seed', beforeArgs(), makeCtx());

    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('reversing registration order flips the output to `[A][B]original`', async () => {
    // Same two subscribers as (1) but registered [B, A]: proves the result is
    // determined by registration order, not by the labels themselves.
    const registry = pipelineRegistry();
    registry.register({
      beforeSessionPrompt: [(value: string) => `[B]${value}`, (value: string) => `[A]${value}`],
    });

    const result = (await registry.invokePipeline(
      'beforeSessionPrompt',
      'original',
      beforeArgs(),
      makeCtx(),
    )) as string;

    expect(result).toBe('[A][B]original');
  });

  it('passes the pipeline `value` (NOT the seed) to each subsequent subscriber', async () => {
    // If the impl used Promise.all-style fan-out, every subscriber would see
    // the SAME seed. With true sequencing each must observe the prior output.
    const registry = pipelineRegistry();
    const seen: string[] = [];
    registry.register({
      beforeSessionPrompt: [
        (v: string) => {
          seen.push(v);
          return v + '1';
        },
        (v: string) => {
          seen.push(v);
          return v + '2';
        },
        (v: string) => {
          seen.push(v);
          return v + '3';
        },
      ],
    });

    const result = (await registry.invokePipeline('beforeSessionPrompt', 's', beforeArgs(), makeCtx())) as string;

    expect(seen).toEqual(['s', 's1', 's12']);
    expect(result).toBe('s123');
  });

  it('returns the seed unchanged when there are no subscribers', async () => {
    // No user hooks → the engine's pipeline invocation must be a no-op so the
    // default file-inlining (applied elsewhere, or as a default subscriber)
    // is what actually runs. This pins the "no subscribers" branch.
    const registry = pipelineRegistry();
    const result = await registry.invokePipeline('beforeSessionPrompt', 'untouched-seed', beforeArgs(), makeCtx());
    expect(result).toBe('untouched-seed');
  });

  it('a custom user hook WRAPS the default subscriber (default is just another stage)', async () => {
    // Real-world shape: the engine registers `defaultBeforeStepPrompt` as the
    // FIRST subscriber (so file-inlining + headers land in the prompt), then a
    // user's workflow hook runs AFTER and wraps that output. The user hook
    // sees the fully-assembled default prompt (headers + files + body),
    // proving the default composes as an ordinary pipeline stage.
    const cwd = tempDir();
    writeFile(cwd, 'src/api.ts', 'export const API = "v1";');
    const task = makeTask({ files: ['src/api.ts'] });
    const args = beforeArgs({ task, cwd, prompt: task.prompt });

    const registry = pipelineRegistry();
    registry.register({
      beforeSessionPrompt: [
        // Stage 1: the default (headers + inlined file + body).
        (value: string, a: BeforeSessionPromptArgs, ctx: HookContext) => defaultBeforeStepPrompt(value, a, ctx),
        // Stage 2: a user hook that prepends a custom preamble.
        (value: string) => `<!-- user preamble -->\n${value}`,
      ],
    });

    const result = (await registry.invokePipeline('beforeSessionPrompt', task.prompt, args, makeCtx())) as string;

    // The user preamble is at the very front ...
    expect(result.startsWith('<!-- user preamble -->\n')).toBe(true);
    // ... and the default's output (headers + inlined file) is intact inside.
    expect(result).toContain('## Task: Implement auth');
    expect(result).toContain('## Step: write-code');
    expect(result).toContain('export const API = "v1";');
    expect(result).toContain(task.prompt);
    // Order: preamble before task header before file body.
    expect(result.indexOf('<!-- user preamble -->')).toBeLessThan(result.indexOf('## Task:'));
    expect(result.indexOf('## Step:')).toBeLessThan(result.indexOf('export const API'));
  });
});
