// ─── Tests for core/redact.ts — secret redaction ─────────────────────────────
//
// Validates that `redactSecrets` scrubs common API-key and secret patterns
// from free-text strings, and is a no-op on clean text.

import { describe, expect, it } from 'bun:test';

import { redactSecrets } from './redact.js';

// ─── Bearer tokens ──────────────────────────────────────────────────────────

describe('redactSecrets — Bearer tokens', () => {
  it('redacts a standard Bearer JWT token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature';
    // Bearer pattern replaces the token, then the authorization key-value
    // pattern re-matches the remaining 'Bearer' label — still secure.
    expect(redactSecrets(input)).toContain('[REDACTED]');
    expect(redactSecrets(input)).not.toContain('eyJ');
  });

  it('redacts Bearer with mixed case', () => {
    expect(redactSecrets('bearer abc123')).toBe('Bearer [REDACTED]');
  });

  it('redacts Bearer with url-safe base64 chars', () => {
    const input = 'Bearer abc123-_.~+/=XYZ';
    expect(redactSecrets(input)).toBe('Bearer [REDACTED]');
  });
});

// ─── Anthropic keys ─────────────────────────────────────────────────────────

describe('redactSecrets — Anthropic sk-ant- keys', () => {
  it('redacts a full Anthropic key', () => {
    const input = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    expect(redactSecrets(input)).toBe('sk-ant-[REDACTED]');
  });

  it('redacts sk-ant- embedded in a larger string', () => {
    const input = 'Key: sk-ant-abcdef1234567890abc';
    expect(redactSecrets(input)).toBe('Key: sk-ant-[REDACTED]');
  });
});

// ─── Generic sk- keys ───────────────────────────────────────────────────────

describe('redactSecrets — generic sk- keys (10+ chars)', () => {
  it('redacts a long sk- key', () => {
    const input = 'sk-abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(input)).toBe('sk-[REDACTED]');
  });

  it('does NOT redact short sk- strings (< 10 chars)', () => {
    const input = 'sk-abcd';
    expect(redactSecrets(input)).toBe('sk-abcd');
  });

  it('redacts sk- with exactly 10 alphanumeric chars', () => {
    const input = 'sk-abcdefghij';
    expect(redactSecrets(input)).toBe('sk-[REDACTED]');
  });
});

// ─── Key-value secret assignments ───────────────────────────────────────────

describe('redactSecrets — key-value secret assignments', () => {
  it('redacts api_key=value', () => {
    expect(redactSecrets('api_key=supersecret123')).toBe('api_key=[REDACTED]');
  });

  it('redacts api-key: value', () => {
    expect(redactSecrets('api-key: mykeyvalue')).toBe('api-key: [REDACTED]');
  });

  it('redacts apikey "value"', () => {
    // The quote is consumed as part of the separator, value is the inner word.
    expect(redactSecrets('apikey "abcdef"')).toBe('apikey "[REDACTED]"');
  });

  it('redacts token= value', () => {
    expect(redactSecrets('token=abc123def')).toBe('token=[REDACTED]');
  });

  it('redacts secret: value', () => {
    expect(redactSecrets('secret: mysecret')).toBe('secret: [REDACTED]');
  });

  it('redacts password="value"', () => {
    // The quote is consumed as part of the separator, trailing quote remains.
    expect(redactSecrets('password="hunter2"')).toBe('password="[REDACTED]"');
  });

  it('redacts authorization=value', () => {
    // Bearer catches 'Bearer xyz' first, then key-value catches 'authorization=Bearer'.
    // The result has double-[REDACTED] but the token is fully removed.
    const result = redactSecrets('authorization=Bearer xyz');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('xyz');
  });

  it('preserves the key name but redacts the value', () => {
    const input = 'api_key=sk-ant-abcdef1234567890abc';
    const result = redactSecrets(input);
    expect(result).toContain('api_key=');
    expect(result).toContain('[REDACTED]');
  });
});

// ─── Clean text no-op ───────────────────────────────────────────────────────

describe('redactSecrets — clean text is unchanged', () => {
  it('returns plain text unchanged', () => {
    expect(redactSecrets('Hello, world!')).toBe('Hello, world!');
  });

  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns a normal error message unchanged', () => {
    expect(redactSecrets('Connection refused on port 8080')).toBe('Connection refused on port 8080');
  });

  it('returns text with numbers but no secrets unchanged', () => {
    expect(redactSecrets('Attempt 3 of 5 failed')).toBe('Attempt 3 of 5 failed');
  });
});

// ─── Combined / edge cases ──────────────────────────────────────────────────

describe('redactSecrets — combined patterns', () => {
  it('redacts multiple secrets in one string', () => {
    const input = 'key=sk-abc123456789 and Bearer eyJ.hello and token=xyz123';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abc123456789');
    expect(result).not.toContain('eyJ.hello');
    expect(result).not.toContain('token=xyz123');
    expect(result).toContain('sk-[REDACTED]');
    expect(result).toContain('Bearer [REDACTED]');
    expect(result).toContain('token=[REDACTED]');
  });

  it('handles string with no escape characters (fast path)', () => {
    expect(redactSecrets('no secrets here')).toBe('no secrets here');
  });
});
