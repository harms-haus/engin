import { Editor, ProcessTerminal, setKeybindings, TUI } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { SlashCommandResult } from '../../src/cli/slash-command-parser.js';

// ─── Mock listWorkflows ────────────────────────────────────────────────────

const mockWorkflows = [
  { name: 'develop', source: 'local' as const, path: '/test/.workflows/develop/main.ts' },
  { name: 'review', source: 'global' as const, path: '/global/workflows/review/main.ts' },
];

const mockListWorkflows = mock(() => Promise.resolve([...mockWorkflows]));

mock.module('../../src/core/workflow-loader.js', () => ({
  listWorkflows: mockListWorkflows,
}));

// Import after mock.module (auto-hoisted by Bun)
import { runComposer } from '../../src/tui/composer.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runComposer', () => {
  // Captured instances from spies
  let editorInstance: Editor;
  let tuiInstance: TUI;
  let inputListenerCb: (data: string) => any;
  let addedChildren: any[];

  // Named spies for targeted assertions
  let addChildSpy: ReturnType<typeof spyOn>;
  let setFocusSpy: ReturnType<typeof spyOn>;
  let addInputListenerSpy: ReturnType<typeof spyOn>;
  let requestRenderSpy: ReturnType<typeof spyOn>;
  let tuiStopSpy: ReturnType<typeof spyOn>;
  let setAutocompleteSpy: ReturnType<typeof spyOn>;
  let _setKeybindingsSpy: ReturnType<typeof spyOn>;

  let allSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    editorInstance = null as any;
    tuiInstance = null as any;
    inputListenerCb = null as any;
    addedChildren = [];
    allSpies = [];

    // Prevent real terminal I/O
    allSpies.push(spyOn(ProcessTerminal.prototype, 'stop').mockImplementation(() => {}));

    // TUI prototype spies
    allSpies.push(
      spyOn(TUI.prototype, 'start').mockImplementation(function (this: TUI) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        if (!tuiInstance) tuiInstance = this;
      }),
    );

    tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});
    allSpies.push(tuiStopSpy);

    addChildSpy = spyOn(TUI.prototype, 'addChild').mockImplementation(function (this: TUI, component: any) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      if (!tuiInstance) tuiInstance = this;
      addedChildren.push(component);
    });
    allSpies.push(addChildSpy);

    setFocusSpy = spyOn(TUI.prototype, 'setFocus').mockImplementation(() => {});
    allSpies.push(setFocusSpy);

    addInputListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (this: TUI, cb: any) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      if (!tuiInstance) tuiInstance = this;
      inputListenerCb = cb;
      return () => {};
    });
    allSpies.push(addInputListenerSpy);

    requestRenderSpy = spyOn(TUI.prototype, 'requestRender').mockImplementation(() => {});
    allSpies.push(requestRenderSpy);

    // Editor: capture instance when setAutocompleteProvider is called
    setAutocompleteSpy = spyOn(Editor.prototype, 'setAutocompleteProvider').mockImplementation(function (this: Editor) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      editorInstance = this;
    });
    allSpies.push(setAutocompleteSpy);

    // Spy on setKeybindings via module namespace
    _setKeybindingsSpy = spyOn({ setKeybindings }, 'setKeybindings');
    // Note: this spy only works if composer re-imports setKeybindings through
    // the same binding. We also test its effect indirectly.

    // Reset listWorkflows mock
    mockListWorkflows.mockImplementation(() => Promise.resolve([...mockWorkflows]));
  });

  afterEach(() => {
    allSpies.forEach((s) => s.mockRestore());
  });

  /**
   * Start the composer and wait for internal setup to complete.
   * Returns the pending promise from runComposer, wrapped to prevent await adoption.
   */
  async function startComposer(cwd = '/test'): Promise<{ promise: Promise<SlashCommandResult | null> }> {
    const promise = runComposer(cwd);
    // Yield to allow listWorkflows to resolve and all synchronous setup to complete
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { promise };
  }

  /** Cancel a pending composer to prevent unhandled rejections */
  async function cancelComposer(promise: Promise<any>): Promise<void> {
    if (inputListenerCb) {
      inputListenerCb('\x03'); // Ctrl+C
    }
    try {
      await promise;
    } catch {
      // Swallow any errors from abort
    }
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────

  describe('setup', () => {
    it('calls listWorkflows with the provided cwd', async () => {
      const { promise: pending } = await startComposer('/my/project');
      expect(mockListWorkflows).toHaveBeenCalledWith('/my/project');
      await cancelComposer(pending);
    });

    it('creates editor and sets autocomplete provider', async () => {
      const { promise: pending } = await startComposer();
      expect(setAutocompleteSpy).toHaveBeenCalledTimes(1);
      expect(editorInstance).toBeDefined();
      await cancelComposer(pending);
    });

    it('adds two children to TUI (banner then editor)', async () => {
      const { promise: pending } = await startComposer();
      expect(addChildSpy).toHaveBeenCalledTimes(2);
      expect(addedChildren).toHaveLength(2);
      await cancelComposer(pending);
    });

    it('sets focus to the editor', async () => {
      const { promise: pending } = await startComposer();
      expect(setFocusSpy).toHaveBeenCalledTimes(1);
      await cancelComposer(pending);
    });

    it('registers an input listener on TUI', async () => {
      const { promise: pending } = await startComposer();
      expect(addInputListenerSpy).toHaveBeenCalledTimes(1);
      expect(inputListenerCb).toBeDefined();
      expect(typeof inputListenerCb).toBe('function');
      await cancelComposer(pending);
    });

    it('sets onSubmit handler on editor', async () => {
      const { promise: pending } = await startComposer();
      expect(editorInstance.onSubmit).toBeDefined();
      expect(typeof editorInstance.onSubmit).toBe('function');
      await cancelComposer(pending);
    });

    it('sets onChange handler on editor', async () => {
      const { promise: pending } = await startComposer();
      expect(editorInstance.onChange).toBeDefined();
      expect(typeof editorInstance.onChange).toBe('function');
      await cancelComposer(pending);
    });
  });

  // ─── Banner Component ──────────────────────────────────────────────────────

  describe('banner component', () => {
    it('renders help text when no error is present', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0]; // First child is banner
      const lines = banner.render(80);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('engin>');
      expect(lines[0]).toContain('Ctrl+Enter');
      expect(lines[0]).toContain('Enter = submit');
      expect(lines[0]).toContain('Ctrl+C = cancel');
      await cancelComposer(pending);
    });

    it('renders error message when errorMessage is set', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      // Trigger invalid submission to set error
      editorInstance.onSubmit!('invalid');

      const lines = banner.render(80);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Error:');
      await cancelComposer(pending);
    });

    it('invalidate() is a no-op and does not throw', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];
      expect(() => banner.invalidate()).not.toThrow();
      await cancelComposer(pending);
    });

    it('banner is the first child, editor is the second', async () => {
      const { promise: pending } = await startComposer();
      // Banner should have a render method returning string[]
      const banner = addedChildren[0];
      expect(typeof banner.render).toBe('function');
      expect(typeof banner.invalidate).toBe('function');

      // Second child should be the editor instance
      const editor = addedChildren[1];
      expect(editor).toBe(editorInstance);
      await cancelComposer(pending);
    });
  });

  // ─── Valid Submission ──────────────────────────────────────────────────────

  describe('valid submission', () => {
    it('resolves with parsed result for a valid slash command', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/develop build the auth module');

      const result = await pending;
      expect(result).toEqual({
        ok: true,
        workflowName: 'develop',
        taskPrompt: 'build the auth module',
        verbose: false,
        worktree: false,
        maxConcurrent: 5,
      });
    });

    it('resolves with flags parsed correctly', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/develop --verbose --worktree refactor everything');

      const result = await pending;
      expect(result).toEqual({
        ok: true,
        workflowName: 'develop',
        taskPrompt: 'refactor everything',
        verbose: true,
        worktree: true,
        maxConcurrent: 5,
      });
    });

    it('resolves with --max-concurrent flag', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/develop --max-concurrent 10 do the thing');

      const result = await pending;
      expect(result).toEqual({
        ok: true,
        workflowName: 'develop',
        taskPrompt: 'do the thing',
        verbose: false,
        worktree: false,
        maxConcurrent: 10,
      });
    });

    it('calls tui.stop() after successful submission', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/develop do something');
      await pending;

      expect(tuiStopSpy).toHaveBeenCalled();
    });
  });

  // ─── Invalid Submission ────────────────────────────────────────────────────

  describe('invalid submission', () => {
    it('does not resolve the promise on invalid input', async () => {
      const { promise: pending } = await startComposer();

      let resolved = false;
      pending.then(() => {
        resolved = true;
      });

      // Submit invalid text (doesn't start with /)
      editorInstance.onSubmit!('invalid text');

      // Give microtasks a chance to run
      await new Promise((r) => setTimeout(r, 0));

      expect(resolved).toBe(false);

      // Cleanup
      await cancelComposer(pending);
    });

    it('calls requestRender when invalid input is submitted', async () => {
      const { promise: pending } = await startComposer();

      requestRenderSpy.mockClear();
      editorInstance.onSubmit!('invalid text');

      expect(requestRenderSpy).toHaveBeenCalled();
      await cancelComposer(pending);
    });

    it('shows specific error for missing slash prefix', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      editorInstance.onSubmit!('develop build it');

      const lines = banner.render(80);
      expect(lines[0]).toContain('must start with /');
      await cancelComposer(pending);
    });

    it('shows specific error for empty input', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      editorInstance.onSubmit!('');

      const lines = banner.render(80);
      expect(lines[0]).toContain('enter a command');
      await cancelComposer(pending);
    });

    it('shows specific error for missing task prompt', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      editorInstance.onSubmit!('/develop');

      const lines = banner.render(80);
      expect(lines[0]).toContain('Missing task prompt');
      await cancelComposer(pending);
    });

    it('allows retry after invalid submission', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      // First: invalid
      editorInstance.onSubmit!('bad input');
      expect(banner.render(80)[0]).toContain('Error:');

      // Clear error via onChange
      editorInstance.onChange!();
      expect(banner.render(80)[0]).not.toContain('Error:');

      // Second: valid
      editorInstance.onSubmit!('/develop do the thing');

      const result = await pending;
      expect(result).toEqual({
        ok: true,
        workflowName: 'develop',
        taskPrompt: 'do the thing',
        verbose: false,
        worktree: false,
        maxConcurrent: 5,
      });
    });
  });

  // ─── onChange ──────────────────────────────────────────────────────────────

  describe('onChange handler', () => {
    it('clears error message and requests re-render', async () => {
      const { promise: pending } = await startComposer();
      const banner = addedChildren[0];

      // Set error first
      editorInstance.onSubmit!('bad');
      expect(banner.render(80)[0]).toContain('Error:');

      // Clear via onChange
      requestRenderSpy.mockClear();
      editorInstance.onChange!();

      expect(requestRenderSpy).toHaveBeenCalled();
      // Banner should now show help text (no error)
      expect(banner.render(80)[0]).not.toContain('Error:');
      expect(banner.render(80)[0]).toContain('engin>');
      await cancelComposer(pending);
    });
  });

  // ─── Cancellation ──────────────────────────────────────────────────────────

  describe('cancellation via Ctrl+C', () => {
    it('resolves with null when Ctrl+C is pressed', async () => {
      const { promise: pending } = await startComposer();

      const result = inputListenerCb('\x03'); // Ctrl+C raw byte

      expect(result).toEqual({ consume: true });

      const resolved = await pending;
      expect(resolved).toBeNull();
    });

    it('calls tui.stop() after cancellation', async () => {
      const { promise: pending } = await startComposer();

      inputListenerCb('\x03');
      await pending;

      expect(tuiStopSpy).toHaveBeenCalled();
    });
  });

  describe('cancellation via Escape', () => {
    it('resolves with null when Escape is pressed', async () => {
      const { promise: pending } = await startComposer();

      const result = inputListenerCb('\x1b'); // Escape raw byte

      expect(result).toEqual({ consume: true });

      const resolved = await pending;
      expect(resolved).toBeNull();
    });

    it('calls tui.stop() after Escape cancellation', async () => {
      const { promise: pending } = await startComposer();

      inputListenerCb('\x1b');
      await pending;

      expect(tuiStopSpy).toHaveBeenCalled();
    });
  });

  // ─── Idempotency ───────────────────────────────────────────────────────────

  describe('idempotency (settled flag)', () => {
    it('ignores duplicate Ctrl+C after already cancelled', async () => {
      const { promise: pending } = await startComposer();

      // First Ctrl+C cancels
      inputListenerCb('\x03');

      // Second Ctrl+C should still return consume: true but not change outcome
      const result = inputListenerCb('\x03');
      expect(result).toEqual({ consume: true });

      const resolved = await pending;
      expect(resolved).toBeNull();
    });

    it('ignores submit after cancellation', async () => {
      const { promise: pending } = await startComposer();

      // Cancel first
      inputListenerCb('\x03');

      // Try to submit after cancel — should be ignored (settled = true)
      editorInstance.onSubmit!('/develop build stuff');

      const resolved = await pending;
      expect(resolved).toBeNull();
    });

    it('ignores cancellation after valid submission', async () => {
      const { promise: pending } = await startComposer();

      // Submit valid command
      editorInstance.onSubmit!('/develop build stuff');

      // Try to cancel — should be ignored
      inputListenerCb('\x03');

      const resolved = await pending;
      expect(resolved).not.toBeNull();
      if (resolved && resolved.ok) {
        expect(resolved.workflowName).toBe('develop');
        expect(resolved.taskPrompt).toBe('build stuff');
      }
    });

    it('ignores Escape after valid submission', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/review check the code');
      inputListenerCb('\x1b'); // Escape — ignored

      const resolved = await pending;
      expect(resolved).not.toBeNull();
      if (resolved && resolved.ok) {
        expect(resolved.workflowName).toBe('review');
      }
    });
  });

  // ─── Input Listener Routing ────────────────────────────────────────────────

  describe('input listener routing', () => {
    it('returns undefined for non-cancel keys (passes through)', async () => {
      const { promise: pending } = await startComposer();

      const result = inputListenerCb('a'); // Regular character
      expect(result).toBeUndefined();

      await cancelComposer(pending);
    });

    it('returns undefined for Enter key (not consumed)', async () => {
      const { promise: pending } = await startComposer();

      // Enter / carriage return
      const result = inputListenerCb('\r');
      expect(result).toBeUndefined();

      await cancelComposer(pending);
    });

    it('returns { consume: true } for Ctrl+C', async () => {
      const { promise: pending } = await startComposer();

      const result = inputListenerCb('\x03');
      expect(result).toEqual({ consume: true });

      await pending;
    });

    it('returns { consume: true } for Escape', async () => {
      const { promise: pending } = await startComposer();

      const result = inputListenerCb('\x1b');
      expect(result).toEqual({ consume: true });

      await pending;
    });
  });

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('tui.stop() is called even on cancellation (finally block)', async () => {
      const { promise: pending } = await startComposer();

      inputListenerCb('\x03');
      await pending;

      // The finally block should call tui.stop()
      // It may be called more than once (once in normal flow, once in finally)
      expect(tuiStopSpy).toHaveBeenCalled();
    });

    it('tui.stop() is called after successful submission (finally block)', async () => {
      const { promise: pending } = await startComposer();

      editorInstance.onSubmit!('/develop build feature');
      await pending;

      expect(tuiStopSpy).toHaveBeenCalled();
    });
  });
});
