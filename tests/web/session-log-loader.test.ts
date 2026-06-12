import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessionLogs } from '../../src/web/session-log-loader.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary work directory. Caller is responsible for cleanup. */
function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'engin-session-test-'));
}

/** Build a JSONL line from an event object. */
function jsonlLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

/** Build a message event with assistant role. */
function assistantMessage(
  id: string,
  timestamp: string,
  contentBlocks: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'assistant',
      content: contentBlocks,
    },
  };
}

/** Text content block. */
function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

/** Thinking content block. */
function thinkingBlock(thinking: string, redacted = false): Record<string, unknown> {
  return { type: 'thinking', thinking, redacted };
}

/** Tool call content block. */
function toolCallBlock(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: 'toolCall', name, arguments: args };
}

/** User message event (should be filtered out). */
function userMessage(id: string, content: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    timestamp: '2024-01-01T00:00:00Z',
    message: { role: 'user', content },
  };
}

/** Non-message event (should be filtered out). */
function systemEvent(eventType: string): Record<string, unknown> {
  return { type: eventType, data: 'something' };
}

/** Write a JSONL file with the given lines. */
function writeJsonlFile(filePath: string, lines: string[]): void {
  writeFileSync(filePath, lines.join('\n'));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadSessionLogs', () => {
  let tmpWorkDir: string;

  afterEach(() => {
    if (tmpWorkDir) {
      try {
        rmSync(tmpWorkDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ─── Empty / missing directory ──────────────────────────────────────────

  it('returns empty array when sessions directory does not exist', async () => {
    tmpWorkDir = createTmpDir();
    const logs = await loadSessionLogs(tmpWorkDir, 'nonexistent-task');
    expect(logs).toEqual([]);
  });

  it('returns empty array when taskId subdirectory does not exist', async () => {
    tmpWorkDir = createTmpDir();
    mkdirSync(join(tmpWorkDir, 'sessions'));
    const logs = await loadSessionLogs(tmpWorkDir, 'nonexistent-task');
    expect(logs).toEqual([]);
  });

  it('returns empty array when step directory is empty', async () => {
    tmpWorkDir = createTmpDir();
    const taskDir = join(tmpWorkDir, 'sessions', 'task-1', 'step-0');
    mkdirSync(taskDir, { recursive: true });
    const logs = await loadSessionLogs(tmpWorkDir, 'task-1');
    expect(logs).toEqual([]);
  });

  it('returns empty array when JSONL files contain no valid message events', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-1', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(systemEvent('init')),
      jsonlLine(userMessage('msg-1', 'Hello')),
      jsonlLine(systemEvent('tool_result')),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-1');
    expect(logs).toEqual([]);
  });

  // ─── Text content blocks ───────────────────────────────────────────────

  it('extracts text blocks from assistant messages', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-1', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-1', '2024-01-01T00:01:00Z', [textBlock('Hello world')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-1');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: 'msg-1-text-0',
      timestamp: '2024-01-01T00:01:00Z',
      type: 'text',
      content: 'Hello world',
    });
  });

  it('extracts multiple text blocks from a single message', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-2', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-2', '2024-01-01T00:02:00Z', [
          textBlock('First paragraph'),
          textBlock('Second paragraph'),
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-2');

    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      id: 'msg-2-text-0',
      timestamp: '2024-01-01T00:02:00Z',
      type: 'text',
      content: 'First paragraph',
    });
    expect(logs[1]).toEqual({
      id: 'msg-2-text-1',
      timestamp: '2024-01-01T00:02:00Z',
      type: 'text',
      content: 'Second paragraph',
    });
  });

  // ─── Thinking content blocks ────────────────────────────────────────────

  it('extracts thinking blocks from assistant messages', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-3', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-3', '2024-01-01T00:03:00Z', [thinkingBlock('I need to think about this...')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-3');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: 'msg-3-think-0',
      timestamp: '2024-01-01T00:03:00Z',
      type: 'thinking',
      content: 'I need to think about this...',
    });
  });

  it('shows [redacted] for redacted thinking blocks', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-redacted', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-r', '2024-01-01T00:04:00Z', [thinkingBlock('secret thinking', true)])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-redacted');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: 'msg-r-think-0',
      timestamp: '2024-01-01T00:04:00Z',
      type: 'thinking',
      content: '[redacted]',
    });
  });

  // ─── Tool call content blocks ──────────────────────────────────────────

  it('extracts tool_call blocks from assistant messages', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-4', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    const args = { path: '/src/index.ts', content: 'console.log("hello")' };
    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-4', '2024-01-01T00:05:00Z', [toolCallBlock('write_file', args)])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-4');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: 'msg-4-tool-0',
      timestamp: '2024-01-01T00:05:00Z',
      type: 'tool_call',
      content: 'write_file',
      metadata: { arguments: args },
    });
  });

  // ─── Mixed content blocks ───────────────────────────────────────────────

  it('extracts mixed content blocks from a single message', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-5', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-5', '2024-01-01T00:06:00Z', [
          thinkingBlock('Let me analyze this...'),
          textBlock('Here is my response:'),
          toolCallBlock('read_file', { path: '/src/main.ts' }),
          textBlock('The file has been read.'),
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-5');

    expect(logs).toHaveLength(4);
    expect(logs[0].type).toBe('thinking');
    expect(logs[0].id).toBe('msg-5-think-0');
    expect(logs[1].type).toBe('text');
    expect(logs[1].id).toBe('msg-5-text-1');
    expect(logs[2].type).toBe('tool_call');
    expect(logs[2].id).toBe('msg-5-tool-2');
    expect(logs[3].type).toBe('text');
    expect(logs[3].id).toBe('msg-5-text-3');
  });

  // ─── Filtering: non-assistant and non-message events ───────────────────

  it('skips user messages (only assistant messages are extracted)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-6', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(userMessage('user-1', 'Please help')),
      jsonlLine(assistantMessage('asst-1', '2024-01-01T00:07:00Z', [textBlock('Sure!')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-6');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('Sure!');
  });

  it('skips non-message events (init, tool_result, etc.)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-7', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(systemEvent('init')),
      jsonlLine(systemEvent('tool_result')),
      jsonlLine(assistantMessage('asst-2', '2024-01-01T00:08:00Z', [textBlock('Response')])),
      jsonlLine(systemEvent('summary')),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-7');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('Response');
  });

  // ─── Multiple messages across files ─────────────────────────────────────

  it('reads messages from multiple JSONL files in the same step directory', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-8', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'a-session.jsonl'), [
      jsonlLine(assistantMessage('msg-a', '2024-01-01T00:10:00Z', [textBlock('From file A')])),
    ]);
    writeJsonlFile(join(stepDir, 'b-session.jsonl'), [
      jsonlLine(assistantMessage('msg-b', '2024-01-01T00:11:00Z', [textBlock('From file B')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-8');

    expect(logs).toHaveLength(2);
    // Files are sorted alphabetically: a-session.jsonl then b-session.jsonl
    expect(logs[0].content).toBe('From file A');
    expect(logs[1].content).toBe('From file B');
  });

  it('reads messages from multiple step directories in sorted order', async () => {
    tmpWorkDir = createTmpDir();
    const sessionsDir = join(tmpWorkDir, 'sessions', 'task-9');

    // Create step directories out of order
    const step2Dir = join(sessionsDir, 'step-2');
    mkdirSync(step2Dir, { recursive: true });
    const step0Dir = join(sessionsDir, 'step-0');
    mkdirSync(step0Dir, { recursive: true });
    const step1Dir = join(sessionsDir, 'step-1');
    mkdirSync(step1Dir, { recursive: true });

    writeJsonlFile(join(step2Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-s2', '2024-01-01T00:20:00Z', [textBlock('Step 2')])),
    ]);
    writeJsonlFile(join(step0Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-s0', '2024-01-01T00:00:00Z', [textBlock('Step 0')])),
    ]);
    writeJsonlFile(join(step1Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-s1', '2024-01-01T00:10:00Z', [textBlock('Step 1')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-9');

    expect(logs).toHaveLength(3);
    // Step directories sorted: step-0, step-1, step-2
    expect(logs[0].content).toBe('Step 0');
    expect(logs[1].content).toBe('Step 1');
    expect(logs[2].content).toBe('Step 2');
  });

  // ─── Error resilience ───────────────────────────────────────────────────

  it('skips lines that are not valid JSON', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-10', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      'not valid json',
      jsonlLine(assistantMessage('msg-ok', '2024-01-01T00:12:00Z', [textBlock('Valid message')])),
      '{ broken json',
      '',
      '   ',
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-10');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('Valid message');
  });

  it('skips empty lines and whitespace-only lines', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-11', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      '',
      '   ',
      '\t',
      jsonlLine(assistantMessage('msg-x', '2024-01-01T00:13:00Z', [textBlock('Only message')])),
      '',
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-11');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('Only message');
  });

  it('skips non-JSONL files in step directory', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-12', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-j', '2024-01-01T00:14:00Z', [textBlock('From JSONL')])),
    ]);
    writeFileSync(join(stepDir, 'metadata.json'), JSON.stringify({ count: 42 }));
    writeFileSync(join(stepDir, 'notes.txt'), 'Some notes');

    const logs = await loadSessionLogs(tmpWorkDir, 'task-12');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('From JSONL');
  });

  it('skips unreadable step directories gracefully', async () => {
    tmpWorkDir = createTmpDir();
    const sessionsDir = join(tmpWorkDir, 'sessions', 'task-13');

    // Create a step dir that's actually a file (not a directory) — readdir will succeed but
    // trying to readdir on it as a directory will throw
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'step-0'), 'I am a file, not a directory');

    // Also create a valid step dir with a message
    const validStepDir = join(sessionsDir, 'step-1');
    mkdirSync(validStepDir, { recursive: true });
    writeJsonlFile(join(validStepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-v', '2024-01-01T00:15:00Z', [textBlock('From valid step')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-13');

    // Should skip the file-that-looks-like-a-step-dir and only return the valid step
    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('From valid step');
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  it('handles message with empty content array', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-14', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-empty', '2024-01-01T00:16:00Z', [])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-14');

    expect(logs).toEqual([]);
  });

  it('handles message with missing content field', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-15', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    const eventWithoutContent = {
      type: 'message',
      id: 'msg-noc',
      timestamp: '2024-01-01T00:17:00Z',
      message: { role: 'assistant' },
    };

    writeJsonlFile(join(stepDir, 'session.jsonl'), [JSON.stringify(eventWithoutContent)]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-15');

    // message.content is undefined, which becomes [] via ?? []
    expect(logs).toEqual([]);
  });

  it('handles event without id or timestamp fields', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-16', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    const eventNoMeta = {
      type: 'message',
      message: {
        role: 'assistant',
        content: [textBlock('No metadata')],
      },
    };

    writeJsonlFile(join(stepDir, 'session.jsonl'), [JSON.stringify(eventNoMeta)]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-16');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: '-text-0',
      timestamp: '',
      type: 'text',
      content: 'No metadata',
    });
  });

  it('handles message with missing message field (malformed event)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-17', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      JSON.stringify({ type: 'message', id: 'msg-no-msg', timestamp: '2024-01-01T00:18:00Z' }),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-17');

    expect(logs).toEqual([]);
  });

  it('handles message with non-assistant role gracefully', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-18', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    // A message with role 'system' (not 'assistant')
    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      JSON.stringify({
        type: 'message',
        id: 'msg-sys',
        timestamp: '2024-01-01T00:19:00Z',
        message: { role: 'system', content: [textBlock('System message')] },
      }),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-18');

    expect(logs).toEqual([]);
  });

  it('handles unknown content block types by skipping them', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-19', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-unk', '2024-01-01T00:20:00Z', [
          { type: 'image', url: 'http://example.com/img.png' },
          textBlock('Known type'),
          { type: 'audio', data: 'base64...' },
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-19');

    // Only the text block should be extracted; image and audio are skipped
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('text');
    expect(logs[0].content).toBe('Known type');
  });

  // ─── Sorting ────────────────────────────────────────────────────────────

  it('sorts step directories alphabetically (step-0, step-1, step-10)', async () => {
    tmpWorkDir = createTmpDir();
    const sessionsDir = join(tmpWorkDir, 'sessions', 'task-sort');

    const step0Dir = join(sessionsDir, 'step-0');
    mkdirSync(step0Dir, { recursive: true });
    const step10Dir = join(sessionsDir, 'step-10');
    mkdirSync(step10Dir, { recursive: true });
    const step1Dir = join(sessionsDir, 'step-1');
    mkdirSync(step1Dir, { recursive: true });

    writeJsonlFile(join(step10Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-10', 'T3', [textBlock('Step 10')])),
    ]);
    writeJsonlFile(join(step0Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-0', 'T1', [textBlock('Step 0')])),
    ]);
    writeJsonlFile(join(step1Dir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-1', 'T2', [textBlock('Step 1')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-sort');

    // Default string sort: step-0, step-1, step-10
    expect(logs).toHaveLength(3);
    expect(logs[0].content).toBe('Step 0');
    expect(logs[1].content).toBe('Step 1');
    expect(logs[2].content).toBe('Step 10');
  });

  it('sorts JSONL files alphabetically within a step directory', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-sort2', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'z-session.jsonl'), [
      jsonlLine(assistantMessage('msg-z', 'T3', [textBlock('File Z')])),
    ]);
    writeJsonlFile(join(stepDir, 'a-session.jsonl'), [
      jsonlLine(assistantMessage('msg-a', 'T1', [textBlock('File A')])),
    ]);
    writeJsonlFile(join(stepDir, 'm-session.jsonl'), [
      jsonlLine(assistantMessage('msg-m', 'T2', [textBlock('File M')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-sort2');

    expect(logs).toHaveLength(3);
    expect(logs[0].content).toBe('File A');
    expect(logs[1].content).toBe('File M');
    expect(logs[2].content).toBe('File Z');
  });

  // ─── Complex realistic scenario ─────────────────────────────────────────

  it('handles a realistic multi-step session with mixed events', async () => {
    tmpWorkDir = createTmpDir();
    const sessionsDir = join(tmpWorkDir, 'sessions', 'real-task');

    // Step 0: Scouting
    const step0Dir = join(sessionsDir, 'step-0');
    mkdirSync(step0Dir, { recursive: true });
    writeJsonlFile(join(step0Dir, 'session.jsonl'), [
      jsonlLine(systemEvent('init')),
      jsonlLine(userMessage('user-1', 'Find all TODOs')),
      jsonlLine(
        assistantMessage('asst-1', '2024-06-01T10:00:00Z', [
          thinkingBlock('I need to search for TODO comments...'),
          textBlock('I found 3 TODOs in the codebase.'),
          toolCallBlock('search', { query: 'TODO', path: '/src' }),
        ]),
      ),
      jsonlLine(systemEvent('tool_result')),
    ]);

    // Step 1: Implementing
    const step1Dir = join(sessionsDir, 'step-1');
    mkdirSync(step1Dir, { recursive: true });
    writeJsonlFile(join(step1Dir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('asst-2', '2024-06-01T10:05:00Z', [
          thinkingBlock('Let me fix the first TODO...'),
          toolCallBlock('write_file', { path: '/src/utils.ts', content: '// fixed' }),
          textBlock('Fixed TODO #1.'),
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'real-task');

    expect(logs).toHaveLength(6);

    // Step 0 logs
    expect(logs[0]).toEqual({
      id: 'asst-1-think-0',
      timestamp: '2024-06-01T10:00:00Z',
      type: 'thinking',
      content: 'I need to search for TODO comments...',
    });
    expect(logs[1]).toEqual({
      id: 'asst-1-text-1',
      timestamp: '2024-06-01T10:00:00Z',
      type: 'text',
      content: 'I found 3 TODOs in the codebase.',
    });
    expect(logs[2]).toEqual({
      id: 'asst-1-tool-2',
      timestamp: '2024-06-01T10:00:00Z',
      type: 'tool_call',
      content: 'search',
      metadata: { arguments: { query: 'TODO', path: '/src' } },
    });

    // Step 1 logs
    expect(logs[3]).toEqual({
      id: 'asst-2-think-0',
      timestamp: '2024-06-01T10:05:00Z',
      type: 'thinking',
      content: 'Let me fix the first TODO...',
    });
    expect(logs[4]).toEqual({
      id: 'asst-2-tool-1',
      timestamp: '2024-06-01T10:05:00Z',
      type: 'tool_call',
      content: 'write_file',
      metadata: { arguments: { path: '/src/utils.ts', content: '// fixed' } },
    });
    expect(logs[5]).toEqual({
      id: 'asst-2-text-2',
      timestamp: '2024-06-01T10:05:00Z',
      type: 'text',
      content: 'Fixed TODO #1.',
    });
  });

  // ─── Type verification ──────────────────────────────────────────────────

  it('returns LogEntry objects with correct shape', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-shape', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-shape', '2024-01-01T00:00:00Z', [
          textBlock('text content'),
          thinkingBlock('thinking content'),
          toolCallBlock('tool_name', { arg1: 'val1' }),
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-shape');

    expect(logs).toHaveLength(3);

    // All entries should have required fields
    for (const log of logs) {
      expect(log).toHaveProperty('id');
      expect(log).toHaveProperty('timestamp');
      expect(log).toHaveProperty('type');
      expect(log).toHaveProperty('content');
      expect(typeof log.id).toBe('string');
      expect(typeof log.timestamp).toBe('string');
      expect(typeof log.type).toBe('string');
      expect(typeof log.content).toBe('string');
    }

    // tool_call should have metadata
    expect(logs[2].metadata).toBeDefined();
    expect(typeof logs[2].metadata).toBe('object');
  });

  // ─── Missing text/thinking fields ───────────────────────────────────────

  it('handles text block with missing text field (defaults to empty string)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-missing-text', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-mt', '2024-01-01T00:00:00Z', [
          { type: 'text' }, // no text field
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-missing-text');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('');
  });

  it('handles thinking block with missing thinking field (defaults to empty string)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-missing-think', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-mk', '2024-01-01T00:00:00Z', [
          { type: 'thinking' }, // no thinking field
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-missing-think');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('');
  });

  it('handles toolCall block with missing name field (defaults to empty string)', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-missing-name', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(
        assistantMessage('msg-mn', '2024-01-01T00:00:00Z', [
          { type: 'toolCall' }, // no name field
        ]),
      ),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-missing-name');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('');
    expect(logs[0].metadata).toEqual({ arguments: undefined });
  });

  // ─── File with only non-JSONL extension ─────────────────────────────────

  it('ignores files that do not end with .jsonl extension', async () => {
    tmpWorkDir = createTmpDir();
    const stepDir = join(tmpWorkDir, 'sessions', 'task-ext', 'step-0');
    mkdirSync(stepDir, { recursive: true });

    // Write a .json file (should be ignored)
    writeFileSync(
      join(stepDir, 'session.json'),
      JSON.stringify(assistantMessage('msg-json', '2024-01-01T00:00:00Z', [textBlock('From JSON')])),
    );

    // Write a .jsonl file (should be read)
    writeJsonlFile(join(stepDir, 'session.jsonl'), [
      jsonlLine(assistantMessage('msg-jsonl', '2024-01-01T00:01:00Z', [textBlock('From JSONL')])),
    ]);

    const logs = await loadSessionLogs(tmpWorkDir, 'task-ext');

    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe('From JSONL');
  });
});
