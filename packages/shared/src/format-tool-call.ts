/**
 * Produces compact formatted display strings for tool calls in the agent log widget.
 * All output is plain text (no ANSI codes).
 */

const MAX_COMMAND_DISPLAY = 60;
const MAX_ARGS_DISPLAY = 50;

export function formatToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    // ── File tools ───────────────────────────────────────────────────────────

    case 'read': {
      const path = String(args.path ?? '?');
      const offset = args.offset != null ? Number(args.offset) : undefined;
      const limit = args.limit != null ? Number(args.limit) : undefined;
      if (offset != null && limit != null) {
        return `📖 read → ${path}:${offset}+${limit}`;
      }
      if (offset != null) {
        return `📖 read → ${path}:${offset}`;
      }
      return `📖 read → ${path}`;
    }

    case 'write': {
      const path = String(args.path ?? '?');
      const content = String(args.content ?? '');
      const lineCount = content.split('\n').length;
      return `📝 write → ${path} +${lineCount}`;
    }

    case 'edit': {
      const path = String(args.path ?? '?');
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `✏️ edit → ${path} (${edits} edits)`;
    }

    // ── Shell / search ──────────────────────────────────────────────────────

    case 'bash': {
      const command = String(args.command ?? '');
      return `💻 bash → ${truncateWithEllipsis(command, MAX_COMMAND_DISPLAY)}`;
    }

    case 'grep': {
      const pattern = String(args.pattern ?? '');
      const path = args.path ?? args.glob;
      if (path != null) {
        return `🔍 grep → ${pattern} → ${path}`;
      }
      return `🔍 grep → ${pattern}`;
    }

    case 'find': {
      const pattern = String(args.pattern ?? '');
      const path = String(args.path ?? '.');
      return `🔍 find → ${pattern} in ${path}`;
    }

    case 'ls': {
      const path = String(args.path ?? '.');
      return `📂 ls → ${path}`;
    }

    // ── Delegation / subagents ──────────────────────────────────────────────

    case 'delegate_to_subagents': {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const names = tasks
        .map((t: unknown) => (typeof t === 'object' && t !== null ? (t as Record<string, unknown>).name : String(t)))
        .join(', ');
      return `🤝 delegate → ${tasks.length} tasks [${names}]`;
    }

    case 'get_subagent_output': {
      const sessionId = String(args.sessionId ?? '');
      return `📋 output → ${truncateWithEllipsis(sessionId, 8)}`;
    }

    case 'get_subagent_session': {
      const sessionId = String(args.sessionId ?? '');
      return `📋 session → ${truncateWithEllipsis(sessionId, 8)}`;
    }

    case 'list_subagent_profiles': {
      return `👥 profiles`;
    }

    // ── Todos / kanban ──────────────────────────────────────────────────────

    case 'write_todos': {
      const todos = Array.isArray(args.todos) ? args.todos.length : 0;
      return `✅ write_todos → ${todos} todos`;
    }

    case 'edit_todos': {
      const action = String(args.action ?? '');
      return `✅ edit_todos → ${action}`;
    }

    case 'list_todos':
    case 'list_kanban':
    case 'claim_tasks':
    case 'advance_tasks':
    case 'reject_tasks': {
      return `✅ ${toolName}`;
    }

    // ── Web ─────────────────────────────────────────────────────────────────

    case 'fetch_content': {
      const url = String(args.url ?? '');
      return `🌐 fetch → ${url}`;
    }

    case 'web_search': {
      const query = String(args.query ?? '');
      return `🔍 search → "${query}"`;
    }

    // ── Workflow ────────────────────────────────────────────────────────────

    case 'workflow_step': {
      const action = String(args.action ?? '');
      return `▶️ workflow → ${action}`;
    }

    // ── User interaction ────────────────────────────────────────────────────

    case 'ask_user_question': {
      const questions = Array.isArray(args.questions) ? args.questions.length : 0;
      return `❓ ask → ${questions} questions`;
    }

    // ── Processes ───────────────────────────────────────────────────────────

    case 'start_process':
    case 'list_processes':
    case 'kill_process':
    case 'restart_process':
    case 'process_logs': {
      return `⚙️ ${toolName}`;
    }

    // ── Generic fallback ────────────────────────────────────────────────────

    default: {
      const keys = Object.keys(args);
      if (keys.length === 0) {
        return `🔧 ${toolName}`;
      }
      const serialized = JSON.stringify(args);
      return `🔧 ${toolName} → ${truncateWithEllipsis(serialized, MAX_ARGS_DISPLAY)}`;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateWithEllipsis(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}
