// ─── Shared file-context helpers ───────────────────────────────────────────
//
// Single source of truth for the file-inlining behavior used by BOTH
// `pool/prompt-builder.ts::buildPrompt` (the legacy single-cwd prompt
// assembler) and `hooks/defaults/prompt-context.ts::defaultCollectContext`
// (the default `collectContext` hook). Extracting these constants + helpers
// here guarantees the two paths produce byte-identical file sections — the
// firmest constraint pinned by prompt-context.test.ts ("reproduces buildPrompt
// EXACTLY").
//
// Nothing in this module is hook-aware: it knows only about filepaths, cwds,
// and producing a fenced-code-block section string per file. The two-cwd
// resolution (`worktreeCwd ?? cwd`) is the CALLER's responsibility — this
// module receives the already-chosen cwd and resolves relative paths against
// it (absolute paths are passed through untouched).

import { open } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

/** Truncation cap (in bytes) for inlined file contents. */
export const MAX_FILE_BYTES = 10_000;

/** Maps a file extension to the language tag emitted on the opening fence. */
export const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.css': 'css',
  '.html': 'html',
  '.sh': 'bash',
  '.bash': 'bash',
  '.sql': 'sql',
  '.toml': 'toml',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
};

/** File extensions whose contents are never inlined (treated as binary). */
export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.bmp',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.gz',
  '.tar',
  '.rar',
  '.7z',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.ogg',
  '.flac',
  '.pdf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
]);

/** Map a file extension to a language tag for fenced code blocks. */
export function langFromExt(filePath: string): string {
  const ext = extname(filePath);
  if (!ext) return '';
  return LANG_MAP[ext] ?? ext.slice(1);
}

/** Return true for known binary file extensions. */
export function isBinaryExt(filePath: string): boolean {
  const ext = extname(filePath);
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Resolve a filepath against `cwd`: absolute paths are returned untouched,
 * relative paths are joined with `cwd`. This is the single resolution rule
 * shared by `buildPrompt` and `defaultCollectContext`; the CALLER picks the
 * cwd (the worktree cwd when present, else the run cwd).
 */
export function resolveFilePath(fp: string, cwd: string): string {
  return isAbsolute(fp) ? fp : join(cwd, fp);
}

/**
 * Read a file's text content, truncating at {@link MAX_FILE_BYTES} if larger.
 *
 * Truncation walks backward past any trailing UTF-8 continuation bytes (and a
 * leading byte whose multi-byte sequence would extend beyond the buffer) so the
 * cut never splits a multi-byte character. When truncated, the marker
 * `'\n... (truncated)'` is appended.
 *
 * Throws if the file cannot be opened or read — the caller is responsible for
 * tolerance (it logs and skips).
 */
export async function readFileContent(absPath: string): Promise<string> {
  let content: string;
  const fh = await open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    if (size > MAX_FILE_BYTES) {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      await fh.read(buf, 0, MAX_FILE_BYTES, 0);
      let end = MAX_FILE_BYTES;
      // Walk backward past continuation bytes to avoid splitting a multi-byte character
      while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
      // If the byte before the continuation bytes is a leading byte whose multi-byte
      // sequence extends beyond the buffer, skip it too
      if (end > 0) {
        const lead = buf[end - 1];
        let expectedLen = 1;
        if ((lead & 0xe0) === 0xc0) expectedLen = 2;
        else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
        else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
        const continuationBytes = MAX_FILE_BYTES - end;
        if (continuationBytes < expectedLen - 1) end--;
      }
      content = buf.subarray(0, end).toString('utf-8') + '\n... (truncated)';
    } else {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      content = buf.toString('utf-8');
    }
  } finally {
    await fh.close();
  }
  return content;
}

/**
 * Read a single file and format it as a fenced code-block section, exactly as
 * `buildPrompt` emits per file:
 *
 *   ```
 *   ### <fp>
 *   ```<lang>
 *   <content>
 *   ```
 *   ```
 *
 * Behavior:
 *  - Binary extensions (per {@link isBinaryExt}) are skipped → returns `null`.
 *  - The filepath is resolved against `cwd` via {@link resolveFilePath}
 *    (absolute paths pass through untouched).
 *  - Read errors are swallowed and logged via `console.debug` (matching
 *    buildPrompt's tolerance) → returns `null`.
 *
 * This is the ONE function both `buildPrompt` and `defaultCollectContext` call
 * to turn a `task.files` entry into a prompt section, guaranteeing identical
 * output.
 */
export async function collectFileSection(fp: string, cwd: string): Promise<string | null> {
  if (isBinaryExt(fp)) return null;
  const absPath = resolveFilePath(fp, cwd);
  try {
    const content = await readFileContent(absPath);
    const lang = langFromExt(fp);
    return `### ${fp}\n\`\`\`${lang}\n${content}\n\`\`\``;
  } catch (err) {
    console.debug(`[prompt-builder] Skipping file ${fp}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
