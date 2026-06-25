// ─── Documentation: api.md createHarness removal & agent plugin system ──────
//
// CONTRACT UNDER TEST (docs/reference/api.md):
//
// `createHarness` and `createHarnessFromProfile` were removed from the engine.
// The API reference must not document them anywhere — not in function signatures,
// not in parameter tables, not in prose descriptions. The reference must instead
// document the agent plugin system: `requireAgentPlugin`, `getAgentPlugin`,
// `hasAgentPlugin`, `registerAgentPlugin`, `DEFAULT_AGENT_PLUGIN_ID`, the
// `AgentPlugin` interface, `AgentSessionOptions`, and `AgentRuntime`.
//
// Additionally, the `resolveApiKey` section must reference agent plugin session
// creation (not `createHarness`) for auth.json/OAuth consultation.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_PATH = resolve(import.meta.dir, '../../docs/reference/api.md');

const apiDoc = readFileSync(API_PATH, 'utf-8');

/**
 * Extract a contiguous block of lines from `text`, starting at the first line
 * that contains `startMarker` and ending at the first subsequent blank line
 * (or `endMarker` if provided).
 */
function extractBlock(text: string, startMarker: string): string {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx === -1) return '';
  const block: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (i > startIdx && lines[i].trim() === '' && lines[i - 1].trim() === '') {
      break;
    }
    if (i > startIdx && lines[i].startsWith('---')) {
      break;
    }
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('docs/reference/api.md — createHarness removal', () => {
  // ── No references to the removed symbol ──────────────────────────────────

  it('does not mention createHarness anywhere in the API reference', () => {
    expect(apiDoc).not.toContain('createHarness');
  });

  it('does not mention createHarness in any casing', () => {
    expect(apiDoc.toLowerCase()).not.toContain('createharness');
  });

  it('does not mention createHarnessFromProfile', () => {
    expect(apiDoc).not.toContain('createHarnessFromProfile');
  });

  // ── Agent plugin system section exists ────────────────────────────────────

  describe('agent plugin system section', () => {
    it('has a "## Agent plugin system" section', () => {
      expect(apiDoc).toContain('## Agent plugin system');
    });

    it('does not have a "## Harness creation" section', () => {
      expect(apiDoc).not.toContain('## Harness creation');
    });

    it('documents requireAgentPlugin', () => {
      expect(apiDoc).toContain('requireAgentPlugin');
    });

    it('documents getAgentPlugin', () => {
      expect(apiDoc).toContain('getAgentPlugin');
    });

    it('documents hasAgentPlugin', () => {
      expect(apiDoc).toContain('hasAgentPlugin');
    });

    it('documents registerAgentPlugin', () => {
      expect(apiDoc).toContain('registerAgentPlugin');
    });

    it('documents DEFAULT_AGENT_PLUGIN_ID', () => {
      expect(apiDoc).toContain('DEFAULT_AGENT_PLUGIN_ID');
    });

    it('documents the AgentPlugin interface', () => {
      expect(apiDoc).toContain('### `AgentPlugin` interface');
    });

    it('documents AgentSessionOptions', () => {
      expect(apiDoc).toContain('### `AgentSessionOptions`');
    });

    it('references createSession as the session factory method', () => {
      expect(apiDoc).toContain('createSession');
    });

    it('mentions AgentRuntime as the return type', () => {
      expect(apiDoc).toContain('AgentRuntime');
    });
  });

  // ── API key resolution wording ────────────────────────────────────────────

  describe('resolveApiKey wording', () => {
    it('does not say createHarness does for auth.json/OAuth', () => {
      expect(apiDoc).not.toContain('`createHarness` does');
    });

    it('references agent plugin session creation for auth.json/OAuth', () => {
      expect(apiDoc).toContain('agent plugin session creation does');
    });
  });
});
