// ─── Tests for core/profile.ts — parseProfile agent frontmatter field ──────
//
// Validates that `parseProfile` correctly extracts the optional `agent`
// frontmatter field from a markdown profile, defaulting to
// 'pi-coding-agent' when omitted.
//
// Module under test: ./profile.js

import { describe, expect, it } from 'bun:test';

import { parseProfile } from './profile.js';

const BASE_FRONTMATTER = `
---
provider: openai
model: gpt-4o
---
You are a helpful assistant.
`.trim();

function withFrontmatter(fields: string): string {
  return `---\n${fields}\n---\nYou are a helpful assistant.`;
}

describe('parseProfile — agent frontmatter field', () => {
  it('defaults to "pi-coding-agent" when agent field is omitted', () => {
    const profile = parseProfile(BASE_FRONTMATTER, 'default.md');
    expect(profile.agent).toBe('pi-coding-agent');
  });

  it('returns "codex" when agent: codex', () => {
    const content = withFrontmatter(`provider: openai\nmodel: gpt-4o\nagent: codex`);
    const profile = parseProfile(content, 'codex.md');
    expect(profile.agent).toBe('codex');
  });

  it('returns "cursor" when agent: cursor', () => {
    const content = withFrontmatter(`provider: openai\nmodel: gpt-4o\nagent: cursor`);
    const profile = parseProfile(content, 'cursor.md');
    expect(profile.agent).toBe('cursor');
  });

  it('still parses other required fields correctly with agent set', () => {
    const content = withFrontmatter(`provider: anthropic\nmodel: claude-3\nagent: cursor`);
    const profile = parseProfile(content, 'claude-cursor.md');
    expect(profile.provider).toBe('anthropic');
    expect(profile.model).toBe('claude-3');
    expect(profile.agent).toBe('cursor');
    expect(profile.id).toBe('claude-cursor');
  });
});
