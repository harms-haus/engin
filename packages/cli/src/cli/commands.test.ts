// ─── Tests for cli/commands.ts — backward-compatible barrel re-export ───────
//
// After the monolithic `commands.ts` is split into focused modules
// (commands/init.ts, commands/run.ts, commands/resume.ts, commands/server.ts)
// and prompt.ts, `commands.ts` must remain a barrel that RE-EXPORTS every
// command so existing `import { ... } from './commands.js'` sites keep working.
//
// These tests pin backward compatibility AND verify the split structure: the
// barrel binding must be IDENTICAL (===) to the binding exported by each
// focused sub-module. Identity (not mere "is a function") proves the barrel
// is a pure re-export with no wrapper/duplicate.
//
// Modules under test: ./commands.js (barrel), ./commands/{init,run,resume,server}.js

import { describe, expect, it } from 'bun:test';

// Barrel imports (the backward-compatible public surface).
import {
  initCommand,
  resumeCommand,
  runCommand,
  serverDownCommand,
  serverStatusCommand,
  serverUpCommand,
} from './commands.js';

// Focused-module imports (the new internal structure).
import { initCommand as initFromModule } from './commands/init.js';
import { resumeCommand as resumeFromModule } from './commands/resume.js';
import { runCommand as runFromModule } from './commands/run.js';
import {
  serverDownCommand as serverDownFromModule,
  serverStatusCommand as serverStatusFromModule,
  serverUpCommand as serverUpFromModule,
} from './commands/server.js';

describe('commands.ts barrel — re-exports the extracted command bindings', () => {
  it('re-exports initCommand (=== commands/init.js)', () => {
    expect(initCommand).toBe(initFromModule);
    expect(typeof initCommand).toBe('function');
  });

  it('re-exports runCommand (=== commands/run.js)', () => {
    expect(runCommand).toBe(runFromModule);
    expect(typeof runCommand).toBe('function');
  });

  it('re-exports resumeCommand (=== commands/resume.js)', () => {
    expect(resumeCommand).toBe(resumeFromModule);
    expect(typeof resumeCommand).toBe('function');
  });

  it('re-exports serverUpCommand (=== commands/server.js)', () => {
    expect(serverUpCommand).toBe(serverUpFromModule);
    expect(typeof serverUpCommand).toBe('function');
  });

  it('re-exports serverDownCommand (=== commands/server.js)', () => {
    expect(serverDownCommand).toBe(serverDownFromModule);
    expect(typeof serverDownCommand).toBe('function');
  });

  it('re-exports serverStatusCommand (=== commands/server.js)', () => {
    expect(serverStatusCommand).toBe(serverStatusFromModule);
    expect(typeof serverStatusCommand).toBe('function');
  });
});

describe('commands.ts barrel — all six commands are distinct functions', () => {
  it('exposes six distinct command bindings', () => {
    const commands = [initCommand, runCommand, resumeCommand, serverUpCommand, serverDownCommand, serverStatusCommand];
    // Every command is its own function (no accidental aliasing).
    for (let i = 0; i < commands.length; i++) {
      for (let j = i + 1; j < commands.length; j++) {
        expect(commands[i]).not.toBe(commands[j]);
      }
    }
  });
});
