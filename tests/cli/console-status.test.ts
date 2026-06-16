import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createStatusCallbacks, formatTime, shouldUseTui } from '../../packages/cli/src/cli/console-status.js';

// ─── formatTime ─────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('returns bracketed time format', () => {
    const result = formatTime();
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
  });
});

// ─── createStatusCallbacks ─────────────────────────────────────────────────

describe('createStatusCallbacks', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('non-verbose has no agent-level callbacks', () => {
    const callbacks = createStatusCallbacks(false);
    expect(callbacks.onTurnStart).toBeUndefined();
    expect(callbacks.onTurnEnd).toBeUndefined();
    expect(callbacks.onToolCallStart).toBeUndefined();
    expect(callbacks.onToolCallEnd).toBeUndefined();
  });

  it('verbose has agent-level callbacks', () => {
    const callbacks = createStatusCallbacks(true);
    expect(typeof callbacks.onTurnStart).toBe('function');
    expect(typeof callbacks.onTurnEnd).toBe('function');
    expect(typeof callbacks.onToolCallStart).toBe('function');
    expect(typeof callbacks.onToolCallEnd).toBe('function');
  });

  it('onWorkflowStart logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowStart!({
      taskPrompt: 'build it',
      resumed: false,
      workDir: '/tmp',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow started/);
  });

  it('onPhaseStart logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onPhaseStart!({ phase: 'planning' as never, round: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Phase started/);
  });

  it('onWorkflowComplete logs duration', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowComplete!({
      totalDurationMs: 5000,
      agentCount: 3,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow complete/);
  });

  it('onWorkflowFailed logs error', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowFailed!({
      error: new Error('boom'),
      phase: 'execution',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow failed/);
  });

  it('onTurnStart logs in verbose mode', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnStart!({ agentId: 'agent-1', turn: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Turn/);
  });

  it('onToolCallStart logs tool name and arguments', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onToolCallStart!({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      arguments: { path: '/foo.ts' },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('read_file');
    expect(output).toContain('/foo.ts');
    expect(output).toContain('agent-1');
  });

  it('onTurnEnd renders text content blocks in verbose mode', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'text', text: 'Hello world' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Hello world/);
  });

  it('onTurnEnd renders thinking content', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'thinking', thinking: 'Let me think...' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/🧠/);
    expect(logSpy.mock.calls[0][0]).toMatch(/Let me think\.\.\./);
  });

  it('onTurnEnd renders redacted thinking', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'thinking', thinking: '', redacted: true }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/redacted thinking/);
  });

  it('onTurnEnd silently ignores toolCall content blocks (regression)', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/foo.ts' } }],
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('onTurnEnd renders tokens when present', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: undefined,
      tokens: { input: 100, output: 50 },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/Tokens/);
    expect(output).toMatch(/100 in \/ 50 out/);
  });

  it('onTurnEnd produces no output when no content and no tokens', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: undefined,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('onTurnEnd with multi-line text renders fully', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnEnd!({
      agentId: 'a1',
      turn: 1,
      contentBlocks: [{ type: 'text', text: 'line1\nline2\nline3' }],
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('line1');
    expect(output).toContain('line2');
    expect(output).toContain('line3');
  });

  it('onAgentSpawn logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onAgentSpawn!({ agentId: 'agent-1', profile: 'coder', phase: 'execution', taskId: 't1' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Agent spawned/);
  });

  it('onAgentComplete logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onAgentComplete!({ agentId: 'agent-1', profile: 'coder', phase: 'execution', taskId: 't1' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Agent complete/);
  });

  it('onTaskStart logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onTaskStart!({ taskId: 't1', title: 'Build feature', agentId: 'agent-1' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Task started/);
  });

  it('onTaskComplete logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onTaskComplete!({ taskId: 't1', title: 'Build feature' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Task complete/);
  });

  it('onTaskRejected logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onTaskRejected!({ taskId: 't1', title: 'Build feature', reason: 'not good enough' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Task rejected/);
  });

  it('onDecision logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onDecision!({ agentId: 'agent-1', decision: 'approve', reasoning: 'looks good' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Decision/);
  });

  it('onError logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onError!({ agentId: 'agent-1', error: 'something broke', phase: 'execution' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Error/);
  });

  it('onToolCallEnd logs success', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onToolCallEnd!({
      agentId: 'agent-1',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      isError: false,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/Tool result/);
    expect(output).toContain('read_file');
  });

  it('onToolCallEnd logs error', () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onToolCallEnd!({
      agentId: 'agent-1',
      toolName: 'write_file',
      toolCallId: 'tc-2',
      isError: true,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/Tool error/);
    expect(output).toContain('write_file');
  });

  it('onPhaseComplete logs formatted output', () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onPhaseComplete!({ phase: 'planning', durationMs: 3000 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Phase completed/);
    expect(logSpy.mock.calls[0][0]).toMatch(/3s/);
  });
});

// ─── shouldUseTui ────────────────────────────────────────────────────────────

describe('shouldUseTui', () => {
  it('returns true when verbose=false and isTty=true', () => {
    expect(shouldUseTui({ verbose: false, isTty: true })).toBe(true);
  });

  it('returns false when verbose=true regardless of isTty', () => {
    expect(shouldUseTui({ verbose: true, isTty: true })).toBe(false);
  });

  it('returns false when isTty=false', () => {
    expect(shouldUseTui({ verbose: false, isTty: false })).toBe(false);
  });

  it('returns false when verbose=true and isTty=false', () => {
    expect(shouldUseTui({ verbose: true, isTty: false })).toBe(false);
  });
});
