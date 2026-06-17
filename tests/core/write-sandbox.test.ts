// ─── Write Sandbox tests ────────────────────────────────────────────────────
//
// Covers the path-resolution/containment helpers and the `tool_call` extension
// factory: writes inside the sandbox are allowed (handler returns void), writes
// outside are blocked (handler returns `{ block: true, reason }`), and non-write
// tools are ignored.

import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWriteSandboxExtension,
  findAllowedDir,
  isPathWithin,
  resolveAllowedDirs,
  resolveToolPath,
} from '../../packages/engine/src/core/write-sandbox.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Capture the handler registered for `tool_call` by an ExtensionFactory. */
function captureToolCallHandler(factory: (pi: ExtensionAPI) => void): (e: ToolCallEvent) => unknown {
  let captured: ((e: ToolCallEvent) => unknown) | undefined;
  const fakePi = {
    on(event: string, handler: (e: ToolCallEvent) => unknown) {
      if (event === 'tool_call') captured = handler;
    },
  } as unknown as ExtensionAPI;
  factory(fakePi);
  if (!captured) throw new Error('factory did not register a tool_call handler');
  return captured;
}

const writeEvent = (path: string): ToolCallEvent =>
  ({ type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path, content: 'x' } }) as ToolCallEvent;

const editEvent = (path: string): ToolCallEvent =>
  ({
    type: 'tool_call',
    toolName: 'edit',
    toolCallId: 'c1',
    input: { path, edits: [{ oldText: 'a', newText: 'b' }] },
  }) as ToolCallEvent;

const bashEvent = (command: string): ToolCallEvent =>
  ({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command } }) as ToolCallEvent;

// ─── resolveToolPath ────────────────────────────────────────────────────────

describe('resolveToolPath', () => {
  it('resolves a relative path against cwd', () => {
    expect(resolveToolPath('artifacts/plan.json', '/proj/.engin/work/r1')).toBe(
      join('/proj/.engin/work/r1', 'artifacts', 'plan.json'),
    );
  });

  it('resolves an absolute path regardless of cwd', () => {
    const abs = join('/proj/.engin/work/r1', 'artifacts', 'plan.json');
    expect(resolveToolPath(abs, '/other')).toBe(abs);
  });

  it('expands ~ to the home directory', () => {
    expect(resolveToolPath('~/secret.txt', '/proj').startsWith('/')).toBe(true);
    expect(resolveToolPath('~/secret.txt', '/proj')).not.toContain('~');
  });

  it('strips a single leading @ before resolving', () => {
    // Stripping @ from '@/artifacts/plan.json' yields the absolute path
    // '/artifacts/plan.json' — identical to resolving it without the @.
    expect(resolveToolPath('@/artifacts/plan.json', '/proj')).toBe(resolveToolPath('/artifacts/plan.json', '/proj'));
    // A relative @-prefixed path still resolves against cwd.
    expect(resolveToolPath('@artifacts/plan.json', '/proj')).toBe(resolveToolPath('artifacts/plan.json', '/proj'));
  });

  it('normalizes parent traversal in the target', () => {
    // artifacts/../escape resolves outside the work dir lexically
    const resolved = resolveToolPath('artifacts/../escape.txt', '/proj/work');
    expect(resolved).toBe(join('/proj/work', 'escape.txt'));
  });
});

// ─── isPathWithin / findAllowedDir ──────────────────────────────────────────

describe('isPathWithin', () => {
  const dir = join('/proj', '.engin', 'work', 'r1', 'artifacts');

  it('accepts a file directly inside the dir', () => {
    expect(isPathWithin(join(dir, 'plan.json'), dir)).toBe(true);
  });

  it('accepts a file in a nested subdir', () => {
    expect(isPathWithin(join(dir, 'nested', 'deep', 'x.json'), dir)).toBe(true);
  });

  it('accepts the dir itself', () => {
    expect(isPathWithin(dir, dir)).toBe(true);
  });

  it('rejects a sibling directory', () => {
    expect(isPathWithin(join('/proj', '.engin', 'work', 'r1', 'sessions'), dir)).toBe(false);
  });

  it('rejects parent traversal escaping the dir', () => {
    expect(isPathWithin(join(dir, '..', 'escape.txt'), dir)).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathWithin('/etc/passwd', dir)).toBe(false);
  });
});

describe('findAllowedDir', () => {
  it('returns the matching allowed dir when within any', () => {
    const a = join('/proj', 'a');
    const b = join('/proj', 'b');
    const resolved = resolveAllowedDirs([a, b], '/proj');
    expect(findAllowedDir(join(b, 'plan.json'), resolved)).toBe(b);
  });

  it('returns null when the target is outside all allowed dirs', () => {
    const resolved = resolveAllowedDirs([join('/proj', 'a')], '/proj');
    expect(findAllowedDir('/etc/passwd', resolved)).toBeNull();
  });
});

// ─── createWriteSandboxExtension ────────────────────────────────────────────

describe('createWriteSandboxExtension', () => {
  // Use a real temp dir so path resolution/containment is exercised on the host FS layout.
  const cwd = mkdtempSync(join(tmpdir(), 'wsb-'));
  const artifacts = join(cwd, 'artifacts');
  const handler = captureToolCallHandler(createWriteSandboxExtension({ allowedDirs: [artifacts], cwd }));

  it('allows a write inside the sandbox', () => {
    expect(handler(writeEvent(join('artifacts', 'plan.json')))).toBeUndefined();
  });

  it('allows an edit inside the sandbox', () => {
    expect(handler(editEvent(join('artifacts', 'plan.json')))).toBeUndefined();
  });

  it('allows an absolute write path inside the sandbox', () => {
    expect(handler(writeEvent(join(artifacts, 'sub', 'x.json')))).toBeUndefined();
  });

  it('blocks a write outside the sandbox', () => {
    const result = handler(writeEvent('/etc/passwd'));
    expect(result).toEqual({ block: true, reason: expect.stringContaining('outside the allowed write sandbox') });
  });

  it('blocks parent-traversal escapes', () => {
    const result = handler(writeEvent(join('artifacts', '..', 'escape.txt')));
    expect(result).toEqual({ block: true, reason: expect.any(String) });
    // The resolved path should escape the artifacts dir
    expect((result as { reason: string }).reason).toContain(cwd);
  });

  it('does not inspect non-write tools (bash is not sandboxed here)', () => {
    expect(handler(bashEvent('rm -rf /'))).toBeUndefined();
  });

  it('does not block when the path argument is absent (lets the tool validate)', () => {
    const noPath = { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: {} } as ToolCallEvent;
    expect(handler(noPath)).toBeUndefined();
  });

  it('lists the resolved allowed dir(s) in the block reason', () => {
    const result = handler(writeEvent('/etc/shadow')) as { reason: string };
    expect(result.reason).toContain(artifacts);
  });
});
