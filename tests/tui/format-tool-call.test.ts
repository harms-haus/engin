import { formatToolCall } from '@engin/shared/format-tool-call';
import { describe, expect, it } from 'bun:test';

describe('formatToolCall', () => {
  // ── File tools ────────────────────────────────────────────────────────────

  describe('read', () => {
    it('formats basic read', () => {
      expect(formatToolCall('read', { path: 'src/index.ts' })).toBe('📖 read → src/index.ts');
    });

    it('formats read with offset and limit', () => {
      expect(formatToolCall('read', { path: 'src/index.ts', offset: 10, limit: 50 })).toBe(
        '📖 read → src/index.ts:10+50',
      );
    });

    it('formats read with only offset', () => {
      expect(formatToolCall('read', { path: 'src/index.ts', offset: 20 })).toBe('📖 read → src/index.ts:20');
    });

    it('handles missing path', () => {
      expect(formatToolCall('read', {})).toBe('📖 read → ?');
    });
  });

  describe('write', () => {
    it('formats write with line count', () => {
      expect(formatToolCall('write', { path: 'src/foo.ts', content: 'line1\nline2\nline3' })).toBe(
        '📝 write → src/foo.ts +3',
      );
    });

    it('counts single line as 1', () => {
      expect(formatToolCall('write', { path: 'a.txt', content: 'hello' })).toBe('📝 write → a.txt +1');
    });

    it('handles empty content', () => {
      expect(formatToolCall('write', { path: 'empty.ts', content: '' })).toBe('📝 write → empty.ts +1');
    });
  });

  describe('edit', () => {
    it('formats edit with edit count', () => {
      expect(
        formatToolCall('edit', {
          path: 'src/app.ts',
          edits: [{ oldText: 'a', newText: 'b' }],
        }),
      ).toBe('✏️ edit → src/app.ts (1 edits)');
    });

    it('formats edit with multiple edits', () => {
      expect(
        formatToolCall('edit', {
          path: 'src/app.ts',
          edits: [
            { oldText: 'a', newText: 'b' },
            { oldText: 'c', newText: 'd' },
            { oldText: 'e', newText: 'f' },
          ],
        }),
      ).toBe('✏️ edit → src/app.ts (3 edits)');
    });
  });

  // ── Shell / search ────────────────────────────────────────────────────────

  describe('bash', () => {
    it('formats short command', () => {
      expect(formatToolCall('bash', { command: 'npm test' })).toBe('💻 bash → npm test');
    });

    it('truncates long command to 60 chars', () => {
      const longCmd = 'a'.repeat(70);
      const result = formatToolCall('bash', { command: longCmd });
      expect(result).toBe('💻 bash → ' + 'a'.repeat(60) + '…');
      expect(result.length).toBeLessThan(70 + 10);
    });

    it('does not truncate command at exactly 60 chars', () => {
      const cmd = 'b'.repeat(60);
      expect(formatToolCall('bash', { command: cmd })).toBe('💻 bash → ' + cmd);
    });
  });

  describe('grep', () => {
    it('formats grep with pattern only', () => {
      expect(formatToolCall('grep', { pattern: 'TODO' })).toBe('🔍 grep → TODO');
    });

    it('formats grep with path', () => {
      expect(formatToolCall('grep', { pattern: 'TODO', path: 'src/' })).toBe('🔍 grep → TODO → src/');
    });

    it('formats grep with glob', () => {
      expect(formatToolCall('grep', { pattern: 'FIXME', glob: '*.ts' })).toBe('🔍 grep → FIXME → *.ts');
    });
  });

  describe('find', () => {
    it('formats find with pattern and path', () => {
      expect(formatToolCall('find', { pattern: '*.ts', path: 'src' })).toBe('🔍 find → *.ts in src');
    });

    it('defaults path to .', () => {
      expect(formatToolCall('find', { pattern: '*.ts' })).toBe('🔍 find → *.ts in .');
    });
  });

  describe('ls', () => {
    it('formats ls with path', () => {
      expect(formatToolCall('ls', { path: 'src/components' })).toBe('📂 ls → src/components');
    });

    it('defaults to .', () => {
      expect(formatToolCall('ls', {})).toBe('📂 ls → .');
    });
  });

  // ── Delegation / subagents ────────────────────────────────────────────────

  describe('delegate_to_subagents', () => {
    it('formats with task names', () => {
      expect(
        formatToolCall('delegate_to_subagents', {
          tasks: [{ name: 'task-a' }, { name: 'task-b' }],
        }),
      ).toBe('🤝 delegate → 2 tasks [task-a, task-b]');
    });

    it('handles empty tasks', () => {
      expect(formatToolCall('delegate_to_subagents', { tasks: [] })).toBe('🤝 delegate → 0 tasks []');
    });
  });

  describe('get_subagent_output', () => {
    it('formats and truncates sessionId to 8 chars', () => {
      expect(formatToolCall('get_subagent_output', { sessionId: 'abcdefgh12345678' })).toBe('📋 output → abcdefgh…');
    });

    it('does not truncate short sessionId', () => {
      expect(formatToolCall('get_subagent_output', { sessionId: 'abc' })).toBe('📋 output → abc');
    });
  });

  describe('get_subagent_session', () => {
    it('formats and truncates sessionId to 8 chars', () => {
      expect(formatToolCall('get_subagent_session', { sessionId: 'xyz987654321' })).toBe('📋 session → xyz98765…');
    });
  });

  describe('list_subagent_profiles', () => {
    it('returns fixed string', () => {
      expect(formatToolCall('list_subagent_profiles', {})).toBe('👥 profiles');
    });
  });

  // ── Todos / kanban ────────────────────────────────────────────────────────

  describe('write_todos', () => {
    it('counts todos', () => {
      expect(formatToolCall('write_todos', { todos: [{}, {}, {}] })).toBe('✅ write_todos → 3 todos');
    });
  });

  describe('edit_todos', () => {
    it('shows action', () => {
      expect(formatToolCall('edit_todos', { action: 'complete' })).toBe('✅ edit_todos → complete');
    });
  });

  describe('list_todos / list_kanban / claim_tasks / advance_tasks / reject_tasks', () => {
    it('formats list_todos', () => {
      expect(formatToolCall('list_todos', {})).toBe('✅ list_todos');
    });

    it('formats list_kanban', () => {
      expect(formatToolCall('list_kanban', {})).toBe('✅ list_kanban');
    });

    it('formats claim_tasks', () => {
      expect(formatToolCall('claim_tasks', {})).toBe('✅ claim_tasks');
    });

    it('formats advance_tasks', () => {
      expect(formatToolCall('advance_tasks', {})).toBe('✅ advance_tasks');
    });

    it('formats reject_tasks', () => {
      expect(formatToolCall('reject_tasks', {})).toBe('✅ reject_tasks');
    });
  });

  // ── Web ───────────────────────────────────────────────────────────────────

  describe('fetch_content', () => {
    it('formats url', () => {
      expect(formatToolCall('fetch_content', { url: 'https://example.com' })).toBe('🌐 fetch → https://example.com');
    });
  });

  describe('web_search', () => {
    it('formats quoted query', () => {
      expect(formatToolCall('web_search', { query: 'bun test framework' })).toBe('🔍 search → "bun test framework"');
    });
  });

  // ── Workflow ──────────────────────────────────────────────────────────────

  describe('workflow_step', () => {
    it('shows action', () => {
      expect(formatToolCall('workflow_step', { action: 'next' })).toBe('▶️ workflow → next');
    });
  });

  // ── User interaction ──────────────────────────────────────────────────────

  describe('ask_user_question', () => {
    it('counts questions', () => {
      expect(formatToolCall('ask_user_question', { questions: [{ text: 'a' }, { text: 'b' }] })).toBe(
        '❓ ask → 2 questions',
      );
    });
  });

  // ── Processes ─────────────────────────────────────────────────────────────

  describe('process tools', () => {
    it('formats start_process', () => {
      expect(formatToolCall('start_process', {})).toBe('⚙️ start_process');
    });

    it('formats list_processes', () => {
      expect(formatToolCall('list_processes', {})).toBe('⚙️ list_processes');
    });

    it('formats kill_process', () => {
      expect(formatToolCall('kill_process', {})).toBe('⚙️ kill_process');
    });

    it('formats restart_process', () => {
      expect(formatToolCall('restart_process', {})).toBe('⚙️ restart_process');
    });

    it('formats process_logs', () => {
      expect(formatToolCall('process_logs', {})).toBe('⚙️ process_logs');
    });
  });

  // ── Generic fallback ──────────────────────────────────────────────────────

  describe('unknown tools', () => {
    it('shows tool name only when no args', () => {
      expect(formatToolCall('customTool', {})).toBe('🔧 customTool');
    });

    it('serializes and truncates args', () => {
      const result = formatToolCall('myTool', { key: 'value' });
      expect(result).toContain('🔧 myTool →');
      expect(result).toContain('key');
    });

    it('truncates long serialized args to 50 chars', () => {
      const result = formatToolCall('bigTool', { data: 'x'.repeat(100) });
      // Should be truncated
      const arrow = result.indexOf('→');
      const afterArrow = result.slice(arrow + 2);
      expect(afterArrow.endsWith('…')).toBe(true);
    });
  });
});
