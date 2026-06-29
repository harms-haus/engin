// ─── Tests for cli/commands/resume.ts — resume command extraction ───────────
//
// Drives the extraction of `resumeCommand` into its own focused module.
// `resumeCommand` immediately constructs a `RunSessionClient` and connects to
// the daemon, so a full behavioral test would require a live server. Instead
// these tests pin the structural export and (via the barrel file) that the
// extracted binding is the one re-exported for backward compatibility.
//
// Module under test: ./resume.js

import { describe, expect, it } from 'bun:test';

import { resumeCommand as resumeFromBarrel } from '../commands.js';
import { resumeCommand } from './resume.js';

describe('resumeCommand — structural contract', () => {
  it('is an exported async function', () => {
    expect(typeof resumeCommand).toBe('function');
  });

  it('is the exact same binding re-exported by the commands.ts barrel', () => {
    // Backward compatibility: `import { resumeCommand } from '../commands.js'`
    // must yield the identical function extracted into ./resume.js.
    expect(resumeCommand).toBe(resumeFromBarrel);
  });
});
