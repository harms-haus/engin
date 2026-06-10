import { describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProfileSingle } from '../../src/core/profile.js';
import { useTempDir } from '../helpers/use-temp-dir';

// ─── Temp directory helper ──────────────────────────────────────────────────

const { getDir } = useTempDir();

// ─── loadProfileSingle ──────────────────────────────────────────────────────

describe('loadProfileSingle', () => {
  it('returns correct AgentProfile from a valid .md file', async () => {
    const filePath = join(getDir(), 'scout.md');
    await writeFile(
      filePath,
      [
        '---',
        'name: Scout Agent',
        'provider: openai',
        'model: gpt-4o',
        'thinkingLevel: high',
        '---',
        'You are a scout agent.',
      ].join('\n'),
    );

    const profile = await loadProfileSingle(filePath);

    expect(profile).toEqual({
      id: 'scout',
      name: 'Scout Agent',
      provider: 'openai',
      model: 'gpt-4o',
      thinkingLevel: 'high',
      systemPrompt: 'You are a scout agent.',
      excludeTools: [],
      includeTools: [],
    });
  });

  it('throws with descriptive error when provider is missing', async () => {
    const filePath = join(getDir(), 'no-provider.md');
    await writeFile(filePath, ['---', 'model: gpt-4o', '---', 'Body.'].join('\n'));

    await expect(loadProfileSingle(filePath)).rejects.toThrow(/missing required frontmatter field "provider"/);
  });

  it('throws with descriptive error when model is missing', async () => {
    const filePath = join(getDir(), 'no-model.md');
    await writeFile(filePath, ['---', 'provider: openai', '---', 'Body.'].join('\n'));

    await expect(loadProfileSingle(filePath)).rejects.toThrow(/missing required frontmatter field "model"/);
  });

  it('throws when file does not exist', async () => {
    const filePath = join(getDir(), 'nonexistent.md');

    await expect(loadProfileSingle(filePath)).rejects.toThrow(/Profile file does not exist/);
  });

  it('returns empty string systemPrompt when file body is empty', async () => {
    const filePath = join(getDir(), 'empty-body.md');
    await writeFile(filePath, ['---', 'provider: openai', 'model: gpt-4o', '---', ''].join('\n'));

    const profile = await loadProfileSingle(filePath);

    expect(profile.systemPrompt).toBe('');
    expect(profile.id).toBe('empty-body');
    expect(profile.provider).toBe('openai');
    expect(profile.model).toBe('gpt-4o');
  });
});
