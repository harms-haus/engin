import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearProfileCache, loadProfiles } from '../../src/core/profile.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const { getDir } = useTempDir();

afterEach(() => {
  clearProfileCache();
});

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

/**
 * Overwrite the profile file in a directory with new content.
 */
async function modifyProfilePrompt(dir: string, prompt: string): Promise<void> {
  await writeFile(join(dir, 'agent.md'), ['---', 'provider: openai', 'model: gpt-4o', '---', prompt].join('\n'));
}

// ─── Oldest-entry eviction tests ────────────────────────────────────────────

describe('profileCache oldest-entry eviction', () => {
  it('evicts only the oldest entry when threshold is exceeded, preserving newer entries', async () => {
    // Create and load 22 unique directories to trigger one eviction
    const dirs: string[] = [];
    for (let i = 0; i < 22; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Trace of cache state after loading all 22:
    //   Loads 0–19: cache grows 0 → 20 (no eviction, size never > 20 at check time)
    //   Load 20:     cache was 20, not > 20 → grows to 21
    //   Load 21:     cache is 21 > 20 → evict dir-0 → cache = 20 → add dir-21 → cache = 21
    // Final cache: {dir-1, dir-2, …, dir-21}  (21 entries; dir-0 evicted)

    // Prove dir-0 was evicted: modify its file on disk, load, expect fresh content.
    await modifyProfilePrompt(dirs[0], 'Modified dir-0');
    const p0 = await loadProfiles(dirs[0]);
    // Loading dir-0: cache 21 > 20 → evict dir-1 (new oldest) → lookup dir-0: not found → read disk
    expect(p0.get('agent')!.systemPrompt).toBe('Modified dir-0');

    // Prove a mid-range entry is still cached: modify dir-10 on disk, load, expect stale.
    await modifyProfilePrompt(dirs[10], 'Modified dir-10');
    // Current cache after loading dir-0: {dir-2, …, dir-21, dir-0} (21 entries)
    // Load dir-10: cache 21 > 20 → evict dir-2 (oldest) → lookup dir-10: found → stale
    const p10 = await loadProfiles(dirs[10]);
    expect(p10.get('agent')!.systemPrompt).toBe('Prompt 10');
  });

  it('each new unique directory evicts exactly one oldest entry (not all)', async () => {
    // Create and load 25 unique directories → 5 evictions past the threshold
    const dirs: string[] = [];
    for (let i = 0; i < 25; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Trace:
    //   Loads 0–19: cache = 20
    //   Load 20:    cache = 21
    //   Load 21:    evict dir-0 → cache = 21
    //   Load 22:    evict dir-1 → cache = 21
    //   Load 23:    evict dir-2 → cache = 21
    //   Load 24:    evict dir-3 → cache = 21
    // Final cache: {dir-4, …, dir-24} (21 entries)
    // Evicted: dir-0, dir-1, dir-2, dir-3

    // dir-4 is the current oldest. dir-10 should be safely in the middle.

    // Verify dir-10 is still cached (stale read)
    await modifyProfilePrompt(dirs[10], 'Modified dir-10');
    // Load dir-10: evict dir-4 (oldest) → lookup dir-10: found → stale
    const p10 = await loadProfiles(dirs[10]);
    expect(p10.get('agent')!.systemPrompt).toBe('Prompt 10');

    // Verify dir-3 (evicted long ago) is NOT cached (fresh read)
    await modifyProfilePrompt(dirs[3], 'Modified dir-3');
    // Current cache after dir-10 load: {dir-5, …, dir-24, dir-10} → wait, dir-10 was a cache hit, no re-insert.
    // Cache = {dir-5, …, dir-24} (20 entries after evicting dir-4)
    // Load dir-3: 20 > 20? No → lookup: not found → read disk → fresh
    const p3 = await loadProfiles(dirs[3]);
    expect(p3.get('agent')!.systemPrompt).toBe('Modified dir-3');
  });

  it('previously evicted entry is re-read from disk and re-cached', async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 22; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }
    // dir-0 was evicted when dir-21 was loaded.

    // Modify dir-0 on disk
    await modifyProfilePrompt(dirs[0], 'Re-loaded dir-0');

    // Load dir-0 → triggers eviction of dir-1, then reads from disk (fresh)
    const p0first = await loadProfiles(dirs[0]);
    expect(p0first.get('agent')!.systemPrompt).toBe('Re-loaded dir-0');

    // Modify dir-0 again on disk
    await modifyProfilePrompt(dirs[0], 'Changed again');

    // Load dir-0 again → triggers eviction of dir-2, then checks cache → found (stale)
    const p0second = await loadProfiles(dirs[0]);
    expect(p0second.get('agent')!.systemPrompt).toBe('Re-loaded dir-0');
  });

  it('cache does not grow unbounded across many unique loads', async () => {
    // Load 40 unique directories — well past the threshold of 20
    const dirs: string[] = [];
    for (let i = 0; i < 40; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Trace of evictions:
    //   Loads 0–19: cache = 20
    //   Load 20:    cache = 21
    //   Loads 21–39 (19 loads): each evicts one oldest → 19 evictions total
    // Evicted: dir-0 through dir-18 (19 entries)
    // Final cache: {dir-19, dir-20, …, dir-39} (21 entries)

    // Early entries should be evicted: verify dir-5 is gone
    await modifyProfilePrompt(dirs[5], 'Modified dir-5');
    // Current cache: {dir-19,…,dir-39} (21 entries)
    // Load dir-5: 21 > 20 → evict dir-19 → lookup dir-5: not found → fresh read
    const p5 = await loadProfiles(dirs[5]);
    expect(p5.get('agent')!.systemPrompt).toBe('Modified dir-5');

    // Late entries should be cached: verify dir-35 is stale
    await modifyProfilePrompt(dirs[35], 'Modified dir-35');
    // After loading dir-5: cache = {dir-20,…,dir-39, dir-5} (21)
    // Load dir-35: 21 > 20 → evict dir-20 → lookup dir-35: found → stale
    const p35 = await loadProfiles(dirs[35]);
    expect(p35.get('agent')!.systemPrompt).toBe('Prompt 35');
  });

  it('does not evict when cache size equals threshold', async () => {
    // Populate cache with exactly 20 entries
    const dirs: string[] = [];
    for (let i = 0; i < 20; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Cache size is exactly 20 — no eviction should happen.
    // Modify dir-0 on disk; loading it should return stale data (cached).
    await modifyProfilePrompt(dirs[0], 'Modified dir-0');
    const p0 = await loadProfiles(dirs[0]);
    // Check: 20 > 20? No → lookup dir-0: found → stale
    expect(p0.get('agent')!.systemPrompt).toBe('Prompt 0');
  });

  it('does not evict when cache size is below threshold', async () => {
    // Populate cache with 19 entries
    const dirs: string[] = [];
    for (let i = 0; i < 19; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Cache size is 19 — no eviction should happen.
    await modifyProfilePrompt(dirs[0], 'Modified dir-0');
    const p0 = await loadProfiles(dirs[0]);
    expect(p0.get('agent')!.systemPrompt).toBe('Prompt 0');
  });

  it('evicts in FIFO order — first inserted is first evicted', async () => {
    // Load 22 entries to evict dir-0, then load 23rd to evict dir-1
    const dirs: string[] = [];
    for (let i = 0; i < 23; i++) {
      dirs.push(await makeProfileDir(getDir(), `dir-${i}`, `Prompt ${i}`));
    }
    for (const dir of dirs) {
      await loadProfiles(dir);
    }

    // Trace:
    //   Loads 0–19: cache = 20
    //   Load 20:    cache = 21
    //   Load 21:    evict dir-0
    //   Load 22:    evict dir-1
    // Final cache: {dir-2, …, dir-22}

    // Verify dir-0 and dir-1 are evicted (fresh reads)
    await modifyProfilePrompt(dirs[0], 'Modified dir-0');
    await modifyProfilePrompt(dirs[1], 'Modified dir-1');

    // Load dir-0: cache 21 > 20 → evict dir-2 → lookup dir-0: not found → fresh
    const p0 = await loadProfiles(dirs[0]);
    expect(p0.get('agent')!.systemPrompt).toBe('Modified dir-0');

    // Load dir-1: cache now 21 (dir-0 was added) > 20 → evict dir-3 → lookup dir-1: not found → fresh
    const p1 = await loadProfiles(dirs[1]);
    expect(p1.get('agent')!.systemPrompt).toBe('Modified dir-1');

    // Verify dir-2 was also evicted (it was evicted when loading dir-0 above)
    await modifyProfilePrompt(dirs[2], 'Modified dir-2');
    // Load dir-2: cache 21 > 20 → evict dir-4 → lookup dir-2: not found → fresh
    const p2 = await loadProfiles(dirs[2]);
    expect(p2.get('agent')!.systemPrompt).toBe('Modified dir-2');

    // But dir-10 should still be cached (stale)
    await modifyProfilePrompt(dirs[10], 'Modified dir-10');
    // Current cache: {dir-5, …, dir-22, dir-0, dir-1, dir-2} (21 entries)
    // Load dir-10: evict dir-5 → lookup dir-10: found → stale
    const p10 = await loadProfiles(dirs[10]);
    expect(p10.get('agent')!.systemPrompt).toBe('Prompt 10');
  });
});
