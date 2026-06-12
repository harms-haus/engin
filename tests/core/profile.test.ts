import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clearProfileCache,
  loadProfile,
  loadProfiles,
  loadProfilesFromDirs,
  parseProfile,
} from '../../src/core/profile.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Helper to create a temp directory for each test ────────────────────────
const { getDir } = useTempDir();

afterEach(() => {
  clearProfileCache();
});

// ─── parseProfile ───────────────────────────────────────────────────────────

describe('parseProfile', () => {
  it('parses a profile with full frontmatter', () => {
    const content = [
      '---',
      'name: Scout Agent',
      'provider: openai',
      'model: gpt-4o',
      'thinkingLevel: high',
      'excludeTools: ["web_search"]',
      'includeTools: ["code_lens", "git"]',
      '---',
      'You are a scout agent.',
    ].join('\n');

    const profile = parseProfile(content, 'scout.md');

    expect(profile).toEqual({
      id: 'scout',
      name: 'Scout Agent',
      provider: 'openai',
      model: 'gpt-4o',
      thinkingLevel: 'high',
      systemPrompt: 'You are a scout agent.',
      excludeTools: ['web_search'],
      includeTools: ['code_lens', 'git'],
    });
  });

  it('applies defaults when only required fields are present', () => {
    const content = [
      '---',
      'provider: anthropic',
      'model: claude-sonnet-4-20250514',
      '---',
      'System instructions here.',
    ].join('\n');

    const profile = parseProfile(content, 'default.md');

    expect(profile.id).toBe('default');
    expect(profile.name).toBe('default');
    expect(profile.provider).toBe('anthropic');
    expect(profile.model).toBe('claude-sonnet-4-20250514');
    expect(profile.thinkingLevel).toBe('medium');
    expect(profile.systemPrompt).toBe('System instructions here.');
    expect(profile.excludeTools).toEqual([]);
    expect(profile.includeTools).toEqual([]);
  });

  it('uses frontmatter name over filename when provided', () => {
    const content = ['---', 'name: My Custom Name', 'provider: openai', 'model: gpt-4o-mini', '---', 'Body.'].join(
      '\n',
    );

    const profile = parseProfile(content, 'file.md');
    expect(profile.name).toBe('My Custom Name');
    expect(profile.id).toBe('file');
  });

  it('throws on missing provider', () => {
    const content = ['---', 'model: gpt-4o', '---', 'Body.'].join('\n');

    expect(() => parseProfile(content, 'no-provider.md')).toThrow(/missing required frontmatter field "provider"/);
  });

  it('throws on missing model', () => {
    const content = ['---', 'provider: openai', '---', 'Body.'].join('\n');

    expect(() => parseProfile(content, 'no-model.md')).toThrow(/missing required frontmatter field "model"/);
  });

  it('extracts multiline systemPrompt body correctly', () => {
    const content = [
      '---',
      'provider: openai',
      'model: gpt-4o',
      '---',
      'Line 1 of the prompt.',
      'Line 2 of the prompt.',
      '',
      'Line 4 after blank line.',
    ].join('\n');

    const profile = parseProfile(content, 'multi.md');

    expect(profile.systemPrompt).toBe('Line 1 of the prompt.\nLine 2 of the prompt.\n\nLine 4 after blank line.');
  });

  it('trims leading/trailing whitespace from systemPrompt', () => {
    const content = ['---', 'provider: openai', 'model: gpt-4o', '---', '', '  Trimmed prompt content  ', ''].join(
      '\n',
    );

    const profile = parseProfile(content, 'trim.md');
    expect(profile.systemPrompt).toBe('Trimmed prompt content');
  });

  it('handles excludeTools and includeTools arrays', () => {
    const content = [
      '---',
      'provider: openai',
      'model: gpt-4o',
      'excludeTools: ["tool_a", "tool_b"]',
      'includeTools: ["tool_c"]',
      '---',
      'Body.',
    ].join('\n');

    const profile = parseProfile(content, 'tools.md');
    expect(profile.excludeTools).toEqual(['tool_a', 'tool_b']);
    expect(profile.includeTools).toEqual(['tool_c']);
  });

  it('defaults excludeTools and includeTools to empty arrays', () => {
    const content = ['---', 'provider: openai', 'model: gpt-4o', '---', 'Body.'].join('\n');

    const profile = parseProfile(content, 'no-tools.md');
    expect(profile.excludeTools).toEqual([]);
    expect(profile.includeTools).toEqual([]);
  });

  it('validates thinkingLevel against allowed values', () => {
    const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

    for (const level of valid) {
      const content = ['---', 'provider: openai', 'model: gpt-4o', `thinkingLevel: ${level}`, '---', 'Body.'].join(
        '\n',
      );

      const profile = parseProfile(content, 'valid.md');
      expect(profile.thinkingLevel).toBe(level);
    }
  });

  it('throws on invalid thinkingLevel', () => {
    const content = ['---', 'provider: openai', 'model: gpt-4o', 'thinkingLevel: extreme', '---', 'Body.'].join('\n');

    expect(() => parseProfile(content, 'bad-level.md')).toThrow(/invalid thinkingLevel "extreme"/);
  });

  it('applies all defaults when only required fields are present', () => {
    const content = ['---', 'provider: openai', 'model: gpt-4o', '---', ''].join('\n');

    const profile = parseProfile(content, 'minimal.md');

    expect(profile.id).toBe('minimal');
    expect(profile.name).toBe('minimal'); // defaults to id when name not provided
    expect(profile.thinkingLevel).toBe('medium');
    expect(profile.systemPrompt).toBe('');
    expect(profile.excludeTools).toEqual([]);
    expect(profile.includeTools).toEqual([]);
  });
});

// ─── loadProfiles ───────────────────────────────────────────────────────────

describe('loadProfiles', () => {
  it('loads all .md files from a directory', async () => {
    await writeFile(
      join(getDir(), 'alpha.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Alpha prompt.'].join('\n'),
    );

    await writeFile(
      join(getDir(), 'beta.md'),
      ['---', 'provider: anthropic', 'model: claude-sonnet-4-20250514', '---', 'Beta prompt.'].join('\n'),
    );

    // Non-.md files should be ignored
    await writeFile(join(getDir(), 'notes.txt'), 'not a profile');
    await writeFile(join(getDir(), 'config.json'), JSON.stringify({ key: 'value' }));

    const profiles = await loadProfiles(getDir());

    expect(profiles.size).toBe(2);
    expect(profiles.has('alpha')).toBe(true);
    expect(profiles.has('beta')).toBe(true);
    expect(profiles.get('alpha')!.provider).toBe('openai');
    expect(profiles.get('beta')!.provider).toBe('anthropic');
  });

  it('returns an empty map for a directory with no .md files', async () => {
    await writeFile(join(getDir(), 'readme.txt'), 'nothing here');

    const profiles = await loadProfiles(getDir());
    expect(profiles.size).toBe(0);
  });

  it('throws on nonexistent directory', async () => {
    await expect(loadProfiles('/nonexistent/path/abc123')).rejects.toThrow(/Directory does not exist/);
  });

  it('throws when path is a file, not a directory', async () => {
    const filePath = join(getDir(), 'file.txt');
    await writeFile(filePath, 'content');

    await expect(loadProfiles(filePath)).rejects.toThrow(/Path is not a directory/);
  });
});

// ─── clearProfileCache ────────────────────────────────────────────────────────

describe('clearProfileCache', () => {
  it('causes subsequent loadProfiles to re-read from disk', async () => {
    await writeFile(
      join(getDir(), 'cached.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Original prompt.'].join('\n'),
    );

    // First load populates the cache
    const profiles1 = await loadProfiles(getDir());
    expect(profiles1.get('cached')!.systemPrompt).toBe('Original prompt.');

    // Overwrite the file on disk
    await writeFile(
      join(getDir(), 'cached.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Updated prompt.'].join('\n'),
    );

    // Without clearing cache, still returns stale data
    const profiles2 = await loadProfiles(getDir());
    expect(profiles2.get('cached')!.systemPrompt).toBe('Original prompt.');

    // Clear the cache
    clearProfileCache();

    // Now loadProfiles should re-read from disk
    const profiles3 = await loadProfiles(getDir());
    expect(profiles3.get('cached')!.systemPrompt).toBe('Updated prompt.');
  });
});

// ─── profileCache size-based eviction ───────────────────────────────────────

describe('profileCache size-based eviction', () => {
  /**
   * Create a temporary subdirectory with a single .md profile inside.
   * Returns the directory path.
   */
  async function makeProfileDir(parent: string, slug: string, prompt: string): Promise<string> {
    const dir = join(parent, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'agent.md'), ['---', 'provider: openai', 'model: gpt-4o', '---', prompt].join('\n'));
    return dir;
  }

  it('returns cached result when cache size is exactly 20', async () => {
    // Populate cache with exactly 20 entries
    const dirs: string[] = [];
    for (let i = 0; i < 20; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      dirs.push(dir);
      await loadProfiles(dir);
    }

    // Now modify the file in dir-0
    await writeFile(
      join(dirs[0], 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Updated prompt'].join('\n'),
    );

    // Since cache size is 20 (not > 20), should return stale cached result
    const profiles = await loadProfiles(dirs[0]);
    expect(profiles.get('agent')!.systemPrompt).toBe('Prompt 0');
  });

  it('evicts cache when size exceeds 20 and re-reads from disk', async () => {
    // Populate cache with 21 entries to exceed the threshold
    const dirs: string[] = [];
    for (let i = 0; i < 21; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      dirs.push(dir);
      await loadProfiles(dir);
    }

    // Now modify the file in dir-0
    await writeFile(
      join(dirs[0], 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Updated prompt'].join('\n'),
    );

    // Since cache size is 21 (> 20), cache should be cleared and re-read from disk
    const profiles = await loadProfiles(dirs[0]);
    expect(profiles.get('agent')!.systemPrompt).toBe('Updated prompt');
  });

  it('evicts cache before returning on the 21th unique directory call', async () => {
    // Populate cache with 20 entries
    const dirs: string[] = [];
    for (let i = 0; i < 20; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      dirs.push(dir);
      await loadProfiles(dir);
    }

    // Verify dir-0 is cached with original content
    const before = await loadProfiles(dirs[0]);
    expect(before.get('agent')!.systemPrompt).toBe('Prompt 0');

    // Now modify dir-0 on disk
    await writeFile(
      join(dirs[0], 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Modified prompt'].join('\n'),
    );

    // Add a 21st unique directory to push cache over the threshold
    const dir21 = await makeProfileDir(getDir(), 'dir-21', 'Prompt 21');
    await loadProfiles(dir21);

    // Now accessing dir-0 should re-read because cache was cleared
    const after = await loadProfiles(dirs[0]);
    expect(after.get('agent')!.systemPrompt).toBe('Modified prompt');
  });

  it('does not evict when cache has fewer than 20 entries', async () => {
    // Populate cache with 19 entries
    const dirs: string[] = [];
    for (let i = 0; i < 19; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      dirs.push(dir);
      await loadProfiles(dir);
    }

    // Modify dir-0 on disk
    await writeFile(
      join(dirs[0], 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'New prompt'].join('\n'),
    );

    // Cache should NOT be cleared, so stale data is returned
    const profiles = await loadProfiles(dirs[0]);
    expect(profiles.get('agent')!.systemPrompt).toBe('Prompt 0');
  });

  it('allows cache to grow again after eviction', async () => {
    // Fill cache to 21 entries to trigger eviction
    const dirs: string[] = [];
    for (let i = 0; i < 21; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      dirs.push(dir);
      await loadProfiles(dir);
    }

    // Eviction happened on the 21st call; cache should now have 1 entry (dir-21)
    // Add 5 more unique directories — should work fine
    for (let i = 22; i < 27; i++) {
      const dir = await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`);
      await loadProfiles(dir);
    }

    // Verify we can still load from dir-22 (newly cached)
    const dir22 = join(getDir(), 'dir-22');
    const profiles = await loadProfiles(dir22);
    expect(profiles.get('agent')!.systemPrompt).toBe('Prompt 22');
  });
});

// ─── loadProfile ────────────────────────────────────────────────────────────

describe('loadProfile', () => {
  it('loads a single profile by id', async () => {
    await writeFile(
      join(getDir(), 'target.md'),
      ['---', 'provider: openai', 'model: gpt-4o', 'name: Target Agent', '---', 'Target system prompt.'].join('\n'),
    );

    await writeFile(
      join(getDir(), 'other.md'),
      ['---', 'provider: openai', 'model: gpt-4o-mini', '---', 'Other.'].join('\n'),
    );

    const profile = await loadProfile(getDir(), 'target');

    expect(profile.id).toBe('target');
    expect(profile.name).toBe('Target Agent');
    expect(profile.systemPrompt).toBe('Target system prompt.');
  });

  it('throws when profile id is not found', async () => {
    await writeFile(
      join(getDir(), 'exists.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Body.'].join('\n'),
    );

    await expect(loadProfile(getDir(), 'does-not-exist')).rejects.toThrow(/Profile "does-not-exist" not found/);
  });
});

// ─── loadProfilesFromDirs ──────────────────────────────────────────────────

describe('loadProfilesFromDirs', () => {
  it('loads profiles from two directories, local overrides global when same ID', async () => {
    const globalDir = join(getDir(), `global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const localDir = join(getDir(), `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(globalDir, { recursive: true });
    await mkdir(localDir, { recursive: true });

    // Global has "shared" and "global-only" profiles
    await writeFile(
      join(globalDir, 'shared.md'),
      ['---', 'provider: openai', 'model: gpt-4o', 'name: Global Shared', '---', 'Global shared prompt.'].join('\n'),
    );
    await writeFile(
      join(globalDir, 'global-only.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Global only prompt.'].join('\n'),
    );

    // Local overrides "shared" and adds "local-only"
    await writeFile(
      join(localDir, 'shared.md'),
      [
        '---',
        'provider: anthropic',
        'model: claude-sonnet-4-20250514',
        'name: Local Shared',
        '---',
        'Local shared prompt.',
      ].join('\n'),
    );
    await writeFile(
      join(localDir, 'local-only.md'),
      ['---', 'provider: anthropic', 'model: claude-sonnet-4-20250514', '---', 'Local only prompt.'].join('\n'),
    );

    // [local, global] → local is first, global is second
    // Reverse iteration processes global first, then local overrides
    const profiles = await loadProfilesFromDirs([localDir, globalDir]);

    expect(profiles.size).toBe(3);
    expect(profiles.get('shared')!.name).toBe('Local Shared');
    expect(profiles.get('shared')!.provider).toBe('anthropic');
    expect(profiles.has('global-only')).toBe(true);
    expect(profiles.has('local-only')).toBe(true);
  });

  it("returns profiles from global-only when local dir doesn't exist", async () => {
    const globalDir = join(getDir(), `global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const localDir = join(getDir(), `local-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(globalDir, { recursive: true });
    // localDir intentionally not created

    await writeFile(
      join(globalDir, 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Agent prompt.'].join('\n'),
    );

    const profiles = await loadProfilesFromDirs([localDir, globalDir]);

    expect(profiles.size).toBe(1);
    expect(profiles.has('agent')).toBe(true);
  });

  it('returns empty map when neither dir exists', async () => {
    const fakeA = join(getDir(), `nope-a-${Date.now()}`);
    const fakeB = join(getDir(), `nope-b-${Date.now()}`);

    const profiles = await loadProfilesFromDirs([fakeA, fakeB]);

    expect(profiles.size).toBe(0);
  });

  it('skips non-directory paths silently', async () => {
    const validDir = join(getDir(), `valid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(validDir, { recursive: true });

    // Create a file (not a directory) to pass as a dir path
    const filePath = join(getDir(), `not-a-dir-${Date.now()}.txt`);
    await writeFile(filePath, 'I am a file');

    await writeFile(
      join(validDir, 'agent.md'),
      ['---', 'provider: openai', 'model: gpt-4o', '---', 'Agent prompt.'].join('\n'),
    );

    const profiles = await loadProfilesFromDirs([validDir, filePath]);

    expect(profiles.size).toBe(1);
    expect(profiles.has('agent')).toBe(true);
  });

  it('re-throws unexpected errors from loadProfiles', async () => {
    const badDir = join(getDir(), `bad-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(badDir, { recursive: true });

    // Create a .md file with missing required provider field
    await writeFile(join(badDir, 'broken.md'), ['---', 'model: gpt-4o', '---', 'Missing provider.'].join('\n'));

    await expect(loadProfilesFromDirs([badDir])).rejects.toThrow(/missing required frontmatter field "provider"/);
  });

  it('returns empty map for empty dirs array', async () => {
    const profiles = await loadProfilesFromDirs([]);
    expect(profiles.size).toBe(0);
  });
});
