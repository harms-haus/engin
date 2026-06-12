import type { Terminal } from '@earendil-works/pi-tui';
import {
  CombinedAutocompleteProvider,
  Editor,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  setKeybindings,
  TUI,
  TUI_KEYBINDINGS,
  type Component,
  type EditorTheme,
  type SlashCommand,
} from '@earendil-works/pi-tui';
import { parseSlashCommand, type SlashCommandResult } from '../cli/slash-command-parser.js';
import { listWorkflows } from '../core/workflow-loader.js';
import { bold, cyan, red } from './theme.js';

export async function runComposer(cwd: string): Promise<SlashCommandResult | null> {
  // Step 1 - Keybindings: remap newline from shift+enter to ctrl+enter so Enter submits
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.input.newLine': 'ctrl+enter' });
  setKeybindings(keybindings);

  // Step 2 - Terminal and TUI
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal as unknown as Terminal);

  try {
    // Step 3 - Editor
    const theme: EditorTheme = {
      borderColor: cyan,
      selectList: {
        selectedPrefix: (text: string) => `\x1b[44m\x1b[37m${text}\x1b[0m`,
        selectedText: (text: string) => `\x1b[44m\x1b[37m${text}\x1b[0m`,
        description: (text: string) => `\x1b[90m${text}\x1b[0m`,
        scrollInfo: (text: string) => `\x1b[90m${text}\x1b[0m`,
        noMatch: (text: string) => `\x1b[90m${text}\x1b[0m`,
      },
    };
    const editor = new Editor(tui, theme, { paddingX: 2 });

    // Step 4 - Autocomplete
    const workflows = await listWorkflows(cwd);
    const commands: SlashCommand[] = workflows.map((w) => ({
      name: w.name,
      description: w.source + ' workflow',
    }));
    const provider = new CombinedAutocompleteProvider(commands, cwd);
    editor.setAutocompleteProvider(provider);

    // Step 5 - Mutable banner component
    let errorMessage = '';
    const banner: Component = {
      render(_width: number): string[] {
        if (errorMessage) return [red('Error: ' + errorMessage)];
        return [
          bold('engin> ') + 'Type /workflow-name <task>  (Ctrl+Enter = new line, Enter = submit, Ctrl+C = cancel)',
        ];
      },
      invalidate(): void {
        /* no-op */
      },
    };
    editor.onChange = () => {
      errorMessage = '';
      tui.requestRender();
    };

    // Step 6 - Layout
    tui.addChild(banner);
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();

    // Step 7 - Submission and cancellation via settled flag
    let settled = false;

    const result = await new Promise<SlashCommandResult | null>((resolve) => {
      // Submit handler
      editor.onSubmit = (text: string) => {
        if (settled) return;
        const parsed = parseSlashCommand(text);
        if (!parsed.ok) {
          errorMessage = parsed.error;
          tui.requestRender();
          return;
        }
        settled = true;
        resolve(parsed);
      };

      // Cancel handler - addInputListener fires BEFORE the focused component
      tui.addInputListener((data: string) => {
        if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'escape')) {
          if (settled) return { consume: true };
          settled = true;
          resolve(null);
          return { consume: true };
        }
        return undefined;
      });
    });

    // Step 8 - Cleanup
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === 'cancelled') return null;
    throw err;
  } finally {
    try {
      tui.stop();
    } catch {
      // ignore cleanup errors during TUI teardown
    }
  }
}
