import { open } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { Task } from '../core/types.js';
import type { StepDefinition } from './types.js';

const MAX_FILE_BYTES = 10_000;

const LANG_MAP: Record<string, string> = {
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

const BINARY_EXTENSIONS = new Set([
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
function langFromExt(filePath: string): string {
  const ext = extname(filePath);
  if (!ext) return '';
  return LANG_MAP[ext] ?? ext.slice(1);
}

/** Return true for known binary file extensions. */
function isBinaryExt(filePath: string): boolean {
  const ext = extname(filePath);
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Build the prompt text for a step. On retry, appends review feedback.
 * File contents from `task.files` are pre-loaded and injected as code blocks.
 */
export async function buildPrompt(task: Task, step: StepDefinition, cwd: string): Promise<string> {
  const parts: string[] = [];

  parts.push(`## Task: ${task.title}`);
  parts.push(`## Step: ${step.name}`);
  parts.push('');

  // ─── File contents section ─────────────────────────────────────────────
  if (task.files?.length) {
    for (const fp of task.files) {
      if (isBinaryExt(fp)) continue;
      const absPath = isAbsolute(fp) ? fp : join(cwd, fp);
      try {
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
        const lang = langFromExt(fp);
        parts.push(`### ${fp}`);
        parts.push('```' + lang);
        parts.push(content);
        parts.push('```');
      } catch (err) {
        console.debug(`[prompt-builder] Skipping file ${fp}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  parts.push(task.prompt);

  if (task.reviewFeedback && task.reviewFeedback.length > 0) {
    parts.push('');
    parts.push('## Review Feedback History (please address all items)');
    task.reviewFeedback.forEach((fb, i) => {
      parts.push(`Attempt ${i + 1}: ${fb}`);
    });
  }

  return parts.join('\n');
}
