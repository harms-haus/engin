import { describe, expect, it } from 'bun:test';
import { formatTime, shouldUseTui } from '../../packages/cli/src/cli/console-status.js';

// ─── formatTime ─────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('returns bracketed time format', () => {
    const result = formatTime();
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
  });
});

// ─── shouldUseTui ────────────────────────────────────────────────────────────

describe('shouldUseTui', () => {
  it('returns true when verbose=false and isTty=true', () => {
    expect(shouldUseTui({ verbose: false, isTty: true })).toBe(true);
  });

  it('returns false when verbose=true regardless of isTty', () => {
    expect(shouldUseTui({ verbose: true, isTty: true })).toBe(false);
  });

  it('returns false when isTty=false', () => {
    expect(shouldUseTui({ verbose: false, isTty: false })).toBe(false);
  });

  it('returns false when verbose=true and isTty=false', () => {
    expect(shouldUseTui({ verbose: true, isTty: false })).toBe(false);
  });
});
