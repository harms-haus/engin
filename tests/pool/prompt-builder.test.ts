import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../packages/engine/src/core/types.js';
import { buildPrompt } from '../../packages/engine/src/pool/prompt-builder.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';

describe('buildPrompt (prompt-builder module)', () => {
  let tempDir: string;

  const baseStep: StepDefinition = {
    name: 'implement',
    profileId: 'coder',
    isReadOnly: false,
  };

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'prompt-builder-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'login.ts'), '// login module\nexport function login() {}');
    writeFileSync(join(tempDir, 'src', 'auth.ts'), '// auth module\nexport function auth() {}');
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'b.ts'), 'const b = 2;');
    writeFileSync(join(tempDir, 'config.json'), '{"key":"value"}');
    writeFileSync(join(tempDir, 'style.css'), 'body { color: red; }');
    writeFileSync(join(tempDir, 'unknown.xyz'), 'some content');
    writeFileSync(join(tempDir, 'noext'), 'no extension file');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const baseTask: Task = {
    id: 'task-1',
    title: 'Build feature X',
    prompt: 'Create a login page',
    profile: 'coder',
    files: ['src/login.ts', 'src/auth.ts'],
    dependencies: [],
    status: 'ready',
  };

  it('includes task title in the prompt', async () => {
    const result = await buildPrompt(baseTask, baseStep, tempDir);
    expect(result).toContain('## Task: Build feature X');
  });

  it('includes step name in the prompt', async () => {
    const result = await buildPrompt(baseTask, baseStep, tempDir);
    expect(result).toContain('## Step: implement');
  });

  it('includes task prompt in the output', async () => {
    const result = await buildPrompt(baseTask, baseStep, tempDir);
    expect(result).toContain('Create a login page');
  });

  it('includes file contents as code blocks when files exist', async () => {
    const result = await buildPrompt(baseTask, baseStep, tempDir);
    expect(result).toContain('### src/login.ts');
    expect(result).toContain('// login module');
    expect(result).toContain('export function login() {}');
    expect(result).toContain('### src/auth.ts');
    expect(result).toContain('// auth module');
    expect(result).toContain('export function auth() {}');
  });

  it('does not include file content section when files array is empty', async () => {
    const task: Task = { ...baseTask, files: [] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### src/login.ts');
  });

  it('does not include file content section when files is undefined', async () => {
    const task: Task = { ...baseTask, files: undefined as unknown as string[] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### src/login.ts');
  });

  it('does not include review feedback when reviewFeedback is empty', async () => {
    const task: Task = { ...baseTask, reviewFeedback: [] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('## Review Feedback History');
  });

  it('does not include review feedback when reviewFeedback is undefined', async () => {
    const task: Task = { ...baseTask, reviewFeedback: undefined };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('## Review Feedback History');
  });

  it('includes review feedback history when present', async () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Fix the null check', 'Add error handling'],
    };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('## Review Feedback History (please address all items)');
    expect(result).toContain('Attempt 1: Fix the null check');
    expect(result).toContain('Attempt 2: Add error handling');
  });

  it('includes single review feedback entry', async () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Fix the null check'],
    };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('Review Feedback History');
    expect(result).toContain('Attempt 1: Fix the null check');
  });

  it('accumulates feedback from multiple rejections', async () => {
    const task: Task = {
      ...baseTask,
      reviewFeedback: ['Missing error handling', 'Needs input validation', 'Add logging'],
    };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('Attempt 1: Missing error handling');
    expect(result).toContain('Attempt 2: Needs input validation');
    expect(result).toContain('Attempt 3: Add logging');
  });

  it('returns a string', async () => {
    const result = await buildPrompt(baseTask, baseStep, tempDir);
    expect(typeof result).toBe('string');
  });

  it('uses correct review step name', async () => {
    const reviewStep: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
    };
    const result = await buildPrompt(baseTask, reviewStep, tempDir);
    expect(result).toContain('## Step: review');
  });

  it('handles task with minimal fields', async () => {
    const minimalTask: Task = {
      id: 't1',
      title: 'Do stuff',
      prompt: 'Just do it',
      profile: 'coder',
      files: [],
      dependencies: [],
      status: 'ready',
    };
    const result = await buildPrompt(minimalTask, baseStep, tempDir);
    expect(result).toContain('## Task: Do stuff');
    expect(result).toContain('## Step: implement');
    expect(result).toContain('Just do it');
    expect(result).not.toContain('## Review Feedback');
  });

  it('handles task with all sections populated', async () => {
    const fullTask: Task = {
      id: 't1',
      title: 'Full task',
      prompt: 'Do everything',
      profile: 'coder',
      files: ['a.ts', 'b.ts'],
      dependencies: [],
      status: 'ready',
      reviewFeedback: ['First issue', 'Second issue'],
    };
    const result = await buildPrompt(fullTask, baseStep, tempDir);
    expect(result).toContain('## Task: Full task');
    expect(result).toContain('## Step: implement');
    expect(result).toContain('Do everything');
    expect(result).toContain('### a.ts');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('### b.ts');
    expect(result).toContain('const b = 2;');
    expect(result).toContain('## Review Feedback History');
    expect(result).toContain('Attempt 1: First issue');
    expect(result).toContain('Attempt 2: Second issue');
  });

  // ─── File pre-loading tests ────────────────────────────────────────────

  it('places file contents BEFORE the task prompt', async () => {
    const task: Task = {
      ...baseTask,
      files: ['a.ts'],
    };
    const result = await buildPrompt(task, baseStep, tempDir);
    const fileIdx = result.indexOf('### a.ts');
    const promptIdx = result.indexOf('Create a login page');
    expect(fileIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(fileIdx).toBeLessThan(promptIdx);
  });

  it('places step header BEFORE file contents', async () => {
    const task: Task = {
      ...baseTask,
      files: ['a.ts'],
    };
    const result = await buildPrompt(task, baseStep, tempDir);
    const stepIdx = result.indexOf('## Step: implement');
    const fileIdx = result.indexOf('### a.ts');
    expect(stepIdx).toBeLessThan(fileIdx);
  });

  it('uses typescript language tag for .ts files', async () => {
    const task: Task = { ...baseTask, files: ['a.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```typescript');
  });

  it('uses javascript language tag for .js files', async () => {
    writeFileSync(join(tempDir, 'mod.js'), 'module.exports = {};');
    const task: Task = { ...baseTask, files: ['mod.js'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```javascript');
  });

  it('uses python language tag for .py files', async () => {
    writeFileSync(join(tempDir, 'app.py'), 'print("hello")');
    const task: Task = { ...baseTask, files: ['app.py'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```python');
  });

  it('uses json language tag for .json files', async () => {
    const task: Task = { ...baseTask, files: ['config.json'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```json');
    expect(result).toContain('"key":"value"');
  });

  it('uses css language tag for .css files', async () => {
    const task: Task = { ...baseTask, files: ['style.css'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```css');
  });

  it('uses yaml language tag for .yaml files', async () => {
    writeFileSync(join(tempDir, 'cfg.yaml'), 'foo: bar');
    const task: Task = { ...baseTask, files: ['cfg.yaml'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```yaml');
  });

  it('uses markdown language tag for .md files', async () => {
    writeFileSync(join(tempDir, 'readme.md'), '# Hello');
    const task: Task = { ...baseTask, files: ['readme.md'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```markdown');
  });

  it('uses html language tag for .html files', async () => {
    writeFileSync(join(tempDir, 'index.html'), '<div></div>');
    const task: Task = { ...baseTask, files: ['index.html'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```html');
  });

  it('uses empty language tag for unknown extensions', async () => {
    const task: Task = { ...baseTask, files: ['unknown.xyz'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```xyz\n');
  });

  it('uses empty language tag for files with no extension', async () => {
    const task: Task = { ...baseTask, files: ['noext'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```\nno extension file');
  });

  it('skips binary files (images)', async () => {
    writeFileSync(join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const task: Task = { ...baseTask, files: ['image.png'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### image.png');
  });

  it('skips binary files (zip)', async () => {
    writeFileSync(join(tempDir, 'archive.zip'), Buffer.from([0x50, 0x4b]));
    const task: Task = { ...baseTask, files: ['archive.zip'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### archive.zip');
  });

  it('skips binary files (pdf)', async () => {
    writeFileSync(join(tempDir, 'doc.pdf'), '%PDF-1.4 fake');
    const task: Task = { ...baseTask, files: ['doc.pdf'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### doc.pdf');
  });

  it('skips missing files gracefully', async () => {
    const task: Task = { ...baseTask, files: ['does-not-exist.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### does-not-exist.ts');
  });

  it('omits file section entirely when all files are binary or missing', async () => {
    writeFileSync(join(tempDir, 'img.gif'), Buffer.from([0x47, 0x49, 0x46]));
    const task: Task = { ...baseTask, files: ['img.gif', 'missing.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).not.toContain('### img.gif');
    expect(result).not.toContain('### missing.ts');
    // Prompt should still be present
    expect(result).toContain('Create a login page');
  });

  it('truncates files larger than 10KB', async () => {
    const bigContent = 'x'.repeat(12_000);
    writeFileSync(join(tempDir, 'big.ts'), bigContent);
    const task: Task = { ...baseTask, files: ['big.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('### big.ts');
    expect(result).toContain('... (truncated)');
    // The full 12K content should NOT be there
    expect(result).not.toContain(bigContent);
  });

  it('does not truncate files under 10KB', async () => {
    const smallContent = 'y'.repeat(9_999);
    writeFileSync(join(tempDir, 'small.ts'), smallContent);
    const task: Task = { ...baseTask, files: ['small.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('### small.ts');
    expect(result).not.toContain('... (truncated)');
  });

  it('resolves absolute file paths', async () => {
    const absPath = join(tempDir, 'a.ts');
    const task: Task = { ...baseTask, files: [absPath] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain(`### ${absPath}`);
    expect(result).toContain('const a = 1;');
  });

  it('resolves relative file paths against cwd', async () => {
    const task: Task = { ...baseTask, files: ['a.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('### a.ts');
    expect(result).toContain('const a = 1;');
  });

  it('wraps file contents in fenced code blocks', async () => {
    const task: Task = { ...baseTask, files: ['a.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('```typescript\nconst a = 1;\n```');
  });

  it('shows prompt text after all file blocks', async () => {
    const task: Task = { ...baseTask, files: ['a.ts', 'b.ts'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    const lastFileIdx = result.indexOf('### b.ts');
    const promptIdx = result.indexOf('Create a login page');
    expect(lastFileIdx).toBeLessThan(promptIdx);
  });

  it('does not split multi-byte UTF-8 characters at truncation boundary', async () => {
    // '€' is U+20AC = 0xE2 0x82 0xAC (3 bytes in UTF-8)
    // Build content so the 10KB boundary falls in the middle of a '€' character
    const euro = '€'; // 3 bytes
    const header = 'x'.repeat(10_000 - 1); // 9,999 bytes
    const bigContent = header + euro + euro + euro; // boundary splits a euro
    writeFileSync(join(tempDir, 'multibyte.txt'), bigContent);
    const task: Task = { ...baseTask, files: ['multibyte.txt'] };
    const result = await buildPrompt(task, baseStep, tempDir);
    expect(result).toContain('### multibyte.txt');
    expect(result).toContain('... (truncated)');
    // The truncated content should NOT contain a garbled partial character
    expect(result).not.toContain('\uFFFD'); // Unicode replacement character
  });
});
