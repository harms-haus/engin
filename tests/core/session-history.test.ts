import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it, mock } from 'bun:test';
import {
  SessionHistory,
  createResumableSession,
  resumeSession,
  type SessionWithMessages,
} from '../../src/core/session-history.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAssistantMessage(
  overrides: Partial<{ input: number; output: number; costTotal: number }> = {},
): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'response' }],
    api: 'openai-completions',
    provider: { id: 'openai', name: 'OpenAI' },
    model: 'gpt-4',
    usage: {
      input: overrides.input ?? 100,
      output: overrides.output ?? 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: overrides.costTotal ?? 0.001,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeUserMessage(content: string): AgentMessage {
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function mockSession(messages: AgentMessage[]): SessionWithMessages {
  return { messages };
}

function mockTarget(): SessionWithMessages & {
  appendMessage: (msg: AgentMessage) => Promise<void>;
  messages: AgentMessage[];
} {
  const messages: AgentMessage[] = [];
  return {
    messages,
    appendMessage: mock(async (msg: AgentMessage) => {
      messages.push(msg);
    }),
  };
}

// ─── SessionHistory ─────────────────────────────────────────────────────────

describe('SessionHistory', () => {
  describe('getMessageCount', () => {
    it('returns 0 for an empty session', () => {
      const session = mockSession([]);
      const history = new SessionHistory(session);
      expect(history.getMessageCount()).toBe(0);
    });

    it('counts all messages', () => {
      const messages: AgentMessage[] = [makeUserMessage('hello'), makeAssistantMessage(), makeUserMessage('world')];
      const session = mockSession(messages);
      const history = new SessionHistory(session);
      expect(history.getMessageCount()).toBe(3);
    });
  });

  describe('getStats', () => {
    it('returns zeros for an empty session', () => {
      const session = mockSession([]);
      const history = new SessionHistory(session);
      const stats = history.getStats();
      expect(stats).toEqual({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        messageCount: 0,
      });
    });

    it('sums usage from assistant messages only', () => {
      const messages: AgentMessage[] = [
        makeUserMessage('q1'),
        makeAssistantMessage({ input: 100, output: 50, costTotal: 0.01 }),
        makeUserMessage('q2'),
        makeAssistantMessage({ input: 200, output: 80, costTotal: 0.02 }),
      ];
      const session = mockSession(messages);
      const history = new SessionHistory(session);
      const stats = history.getStats();

      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(130);
      expect(stats.totalCost).toBeCloseTo(0.03);
      expect(stats.messageCount).toBe(4);
    });

    it('handles user and toolResult messages without usage', () => {
      const toolResultMsg = {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'output' }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage;

      const messages: AgentMessage[] = [
        makeUserMessage('question'),
        toolResultMsg,
        makeAssistantMessage({ input: 50, output: 25, costTotal: 0.005 }),
      ];
      const session = mockSession(messages);
      const history = new SessionHistory(session);
      const stats = history.getStats();

      expect(stats.totalInputTokens).toBe(50);
      expect(stats.totalOutputTokens).toBe(25);
      expect(stats.totalCost).toBeCloseTo(0.005);
      expect(stats.messageCount).toBe(3);
    });

    it('handles assistant messages with zero usage', () => {
      const messages: AgentMessage[] = [makeAssistantMessage({ input: 0, output: 0, costTotal: 0 })];
      const session = mockSession(messages);
      const history = new SessionHistory(session);
      const stats = history.getStats();

      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
      expect(stats.messageCount).toBe(1);
    });
  });
});

// ─── resumeSession ──────────────────────────────────────────────────────────

describe('resumeSession', () => {
  it('copies all messages from source to target via appendMessage', async () => {
    const msg1 = makeUserMessage('hello');
    const msg2 = makeAssistantMessage({ input: 10, output: 5, costTotal: 0.001 });
    const source = mockSession([msg1, msg2]);
    const target = mockTarget();

    await resumeSession(source, target);

    expect(target.appendMessage).toHaveBeenCalledTimes(2);
    expect(target.messages[0]).toEqual(msg1);
    expect(target.messages[1]).toEqual(msg2);
  });

  it('does nothing when source has no messages', async () => {
    const source = mockSession([]);
    const target = mockTarget();

    await resumeSession(source, target);

    expect(target.appendMessage).not.toHaveBeenCalled();
    expect(target.messages).toHaveLength(0);
  });

  it('preserves message ordering from source', async () => {
    const msgs: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
      i % 2 === 0
        ? makeUserMessage(`q-${i}`)
        : makeAssistantMessage({
            input: i * 10,
            output: i * 5,
            costTotal: i * 0.001,
          }),
    );
    const source = mockSession(msgs);
    const target = mockTarget();

    await resumeSession(source, target);

    expect(target.messages).toHaveLength(5);
    for (let i = 0; i < msgs.length; i++) {
      expect(target.messages[i]).toEqual(msgs[i]);
    }
  });

  it('copies directly into messages array when appendMessage is not available', async () => {
    const msg1 = makeUserMessage('hello');
    const msg2 = makeAssistantMessage({ input: 10, output: 5, costTotal: 0.001 });
    const source = mockSession([msg1, msg2]);
    const target: SessionWithMessages & { messages: AgentMessage[] } = {
      messages: [],
    };

    await resumeSession(source, target);

    expect(target.messages).toHaveLength(2);
    expect(target.messages[0]).toEqual(msg1);
    expect(target.messages[1]).toEqual(msg2);
  });
});

// ─── createResumableSession ─────────────────────────────────────────────────

describe('createResumableSession', () => {
  it('creates an in-memory session with a valid sessionId', () => {
    const { sessionManager, sessionId } = createResumableSession();

    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    expect(sessionManager.getSessionId()).toBe(sessionId);
  });

  it('returns a SessionManager instance', () => {
    const { sessionManager } = createResumableSession();

    // Should be able to read entries (starts empty)
    const entries = sessionManager.getEntries();
    expect(entries).toEqual([]);
  });

  it('creates unique sessionIds for successive calls', () => {
    const result1 = createResumableSession();
    const result2 = createResumableSession();

    expect(result1.sessionId).not.toBe(result2.sessionId);
  });

  it('accepts a cwd parameter', () => {
    const { sessionManager, sessionId } = createResumableSession('/tmp/test');

    expect(sessionId).toBeTruthy();
    expect(sessionManager.getCwd()).toBe('/tmp/test');
  });
});

// ─── resumeSession edge cases ───────────────────────────────────────────────

describe('resumeSession edge cases', () => {
  it('deep clones messages so target is not affected by mutations to source', async () => {
    const nested = { deep: { value: 'original' } };
    const msg: AgentMessage = {
      role: 'user',
      content: JSON.stringify(nested),
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const source = mockSession([msg]);
    const target = mockTarget();

    await resumeSession(source, target);

    expect(target.messages).toHaveLength(1);
    // Mutating the source message should not affect the target
    (source.messages[0] as Record<string, unknown>).content = 'mutated';
    expect(target.messages[0]).not.toEqual(source.messages[0]);
  });
});

// ─── SessionHistory.getStats edge cases ──────────────────────────────────────

describe('SessionHistory.getStats edge cases', () => {
  it('handles messages missing usage field without crashing', () => {
    const msg: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      // no usage field
    } as unknown as AgentMessage;

    const session = mockSession([msg]);
    const history = new SessionHistory(session);
    const stats = history.getStats();

    expect(stats).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      messageCount: 1,
    });
  });
});
