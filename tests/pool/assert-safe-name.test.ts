import { describe, expect, it } from 'bun:test';
import { assertSafeName } from '../../src/pool/lane-pool.js';

describe('assertSafeName', () => {
  // ─── Valid names do not throw ─────────────────────────────────────────

  it('accepts "task-1" as a valid name', () => {
    expect(() => assertSafeName('task-1', 'name')).not.toThrow();
  });

  it('accepts "my_task" as a valid name', () => {
    expect(() => assertSafeName('my_task', 'name')).not.toThrow();
  });

  it('accepts "simple" as a valid name', () => {
    expect(() => assertSafeName('simple', 'name')).not.toThrow();
  });

  it('accepts "ABC123" as a valid name', () => {
    expect(() => assertSafeName('ABC123', 'name')).not.toThrow();
  });

  it('accepts single character "a" as a valid name', () => {
    expect(() => assertSafeName('a', 'name')).not.toThrow();
  });

  // ─── Path traversal attempts throw ────────────────────────────────────

  it('rejects "../etc/passwd" as path traversal', () => {
    expect(() => assertSafeName('../etc/passwd', 'name')).toThrow();
  });

  it('rejects "..\\windows" as path traversal', () => {
    expect(() => assertSafeName('..\\windows', 'name')).toThrow();
  });

  it('rejects "foo/bar" with forward slash', () => {
    expect(() => assertSafeName('foo/bar', 'name')).toThrow();
  });

  it('rejects "foo\\bar" with backslash', () => {
    expect(() => assertSafeName('foo\\bar', 'name')).toThrow();
  });

  // ─── Empty string throws ─────────────────────────────────────────────

  it('rejects empty string', () => {
    expect(() => assertSafeName('', 'name')).toThrow();
  });

  // ─── Names with spaces throw ─────────────────────────────────────────

  it('rejects "my task" with space', () => {
    expect(() => assertSafeName('my task', 'name')).toThrow();
  });

  // ─── Names with special characters throw ──────────────────────────────

  it('rejects "task@1" with @ symbol', () => {
    expect(() => assertSafeName('task@1', 'name')).toThrow();
  });

  it('rejects "task!" with exclamation mark', () => {
    expect(() => assertSafeName('task!', 'name')).toThrow();
  });

  it('rejects "task#1" with hash symbol', () => {
    expect(() => assertSafeName('task#1', 'name')).toThrow();
  });

  // ─── Error message includes the label ────────────────────────────────

  it('includes the label in the error message', () => {
    expect(() => assertSafeName('../etc', 'task id')).toThrow(/task id/);
  });

  // ─── Error message includes the invalid value ────────────────────────

  it('includes the invalid value in the error message', () => {
    expect(() => assertSafeName('../etc', 'step name')).toThrow(/\.\.\/etc/);
  });

  // ─── Names with only underscores and hyphens are valid ────────────────

  it('accepts "_private" (leading underscore)', () => {
    expect(() => assertSafeName('_private', 'name')).not.toThrow();
  });

  it('accepts "-dash" (leading hyphen)', () => {
    expect(() => assertSafeName('-dash', 'name')).not.toThrow();
  });

  it('accepts "a-b_c" (mixed hyphens and underscores)', () => {
    expect(() => assertSafeName('a-b_c', 'name')).not.toThrow();
  });
});
