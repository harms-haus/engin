// ─── Session History ────────────────────────────────────────────────────────
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// ─── SessionStats ───────────────────────────────────────────────────────────

export interface SessionStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  messageCount: number;
}

// ─── SessionWithMessages ────────────────────────────────────────────────────

/**
 * Minimal interface for an object that exposes a messages array.
 * Compatible with AgentSession from @earendil-works/pi-coding-agent.
 */
export interface SessionWithMessages {
  readonly messages: AgentMessage[];
}

// ─── SessionHistory ─────────────────────────────────────────────────────────

export class SessionHistory {
  constructor(private session: SessionWithMessages) {}

  /**
   * Count the number of messages in the session.
   */
  getMessageCount(): number {
    return this.session.messages.length;
  }

  /**
   * Sum usage from assistant messages.
   */
  getStats(): SessionStats {
    const messages = this.session.messages;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'role' in msg && msg.role === 'assistant') {
        const usage = (
          msg as {
            usage?: {
              input: number;
              output: number;
              cost?: { total: number };
            };
          }
        ).usage;
        if (usage) {
          totalInputTokens += usage.input ?? 0;
          totalOutputTokens += usage.output ?? 0;
          totalCost += usage.cost?.total ?? 0;
        }
      }
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      messageCount: messages.length,
    };
  }
}

/**
 * Resume a session by copying all messages from `source` into `target`.
 *
 * Since AgentSession manages its own messages internally, this pushes each
 * message from the source into the target via the `appendMessage` method when
 * available, or copies directly into a writable messages array.
 */
export async function resumeSession(
  source: SessionWithMessages & {
    messages: AgentMessage[];
  },
  target: SessionWithMessages & {
    appendMessage?: (msg: AgentMessage) => Promise<void>;
    messages: AgentMessage[];
  },
): Promise<void> {
  function safeClone<T>(obj: T): T {
    try {
      return structuredClone(obj);
    } catch {
      console.warn('[session-history] structuredClone failed, falling back to shallow copy');
      return { ...obj } as T;
    }
  }

  for (const msg of source.messages) {
    if (target.appendMessage) {
      await target.appendMessage(safeClone(msg));
    } else {
      target.messages.push(safeClone(msg));
    }
  }
}

/**
 * Create a resumable session backed by in-memory storage.
 * Always uses SessionManager.inMemory().
 */
export function createResumableSession(cwd?: string): { sessionManager: SessionManager; sessionId: string } {
  const sessionManager = SessionManager.inMemory(cwd);
  const sessionId = sessionManager.getSessionId();
  return { sessionManager, sessionId };
}
