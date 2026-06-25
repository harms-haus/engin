// ─── Cursor SDK Adapter ─────────────────────────────────────────────────────
//
// Implements `AgentPlugin` for the Cursor Agent SDK (`@cursor/sdk`).
//
// The Cursor SDK exposes a flat `Run` stream of `SDKMessage` variants
// (system, user, assistant, tool_call, thinking, status, request, task).
// There are no discrete turn boundaries, token usage events, or
// auto-retry events — the adapter therefore **does not fabricate** any
// turn_start / turn_end / usage / auto_retry events. The TUI / engine
// must tolerate these gaps.

import type { AgentOptions, ModelSelection, Run, SDKAgent, SDKMessage, TextBlock, ToolUseBlock } from '@cursor/sdk';
import { Agent } from '@cursor/sdk';

import { createAgentEventForwarder } from '../../core/agent-event-forwarder.js';
import type { AgentPlugin, AgentRuntime, AgentRuntimeEvent, AgentSessionOptions } from '../../core/agent-plugin.js';
import { registerAgentPlugin } from '../../core/agent-registry.js';
import type { LastAssistantMessage } from '../../core/error-classifier.js';

// ─── Sandbox caveat ─────────────────────────────────────────────────────────
//
// Cursor's `LocalAgentOptions.sandboxOptions` is `{ enabled: boolean }` — a
// binary on/off switch. It **cannot** express a granular writable-root
// allowlist like the pi adapter's `allowedWriteDirs`. When the caller passes
// `allowedWriteDirs`, we enable the sandbox (full workspace confinement); when
// it is absent or empty, we disable the sandbox entirely. There is no middle
// ground on the Cursor side today.

// ─── CursorAgentRuntime ─────────────────────────────────────────────────────

/**
 * `AgentRuntime` backed by a Cursor SDK agent / run.
 *
 * For each `prompt(text)` call, the adapter:
 *   1. Calls `agent.send(text)` → `Run`.
 *   2. Iterates `run.stream()` (`AsyncGenerator<SDKMessage>`).
 *   3. Translates each `SDKMessage` into neutral `AgentRuntimeEvent`s.
 *   4. Buffers assistant text blocks for `getLastAssistantText()` /
 *      `getLastAssistantMessage()`.
 *
 * When resuming (`resumeSessionPath` set), the adapter skips agent creation
 * and instead reconnects via `Agent.getRun(runId)`. The first `prompt()` then
 * streams the existing run's messages.
 */
class CursorAgentRuntime implements AgentRuntime {
  /** The SDK agent (undefined when resuming from a bare Run). */
  private agent: SDKAgent | undefined;
  /** A pre-existing run to stream on the first prompt (resume path). */
  private pendingRun: Run | undefined;
  /** The active run during a prompt; undefined when idle. */
  private currentRun: Run | undefined;
  /** Set by `abort()` so that a run obtained after the abort call is still cancelled. */
  private abortRequested = false;
  /** The first run id encountered — surfaces as `sessionId`. */
  private firstRunId: string | undefined;
  /** Buffered assistant content blocks from the most recent assistant message. */
  private lastAssistantBlocks: (TextBlock | ToolUseBlock)[] | undefined;
  /** Buffered assistant text (concatenation of TextBlock.text). */
  private lastAssistantText: string | undefined;
  /** Registered event subscribers. */
  private subscribers = new Set<(e: AgentRuntimeEvent) => void>();
  /** Event forwarder to `onAgentStatus` callbacks (if provided). */
  private forwarder: ((event: AgentRuntimeEvent) => void) | undefined;
  private disposed = false;

  constructor(
    agent: SDKAgent | undefined,
    pendingRun: Run | undefined,
    onAgentStatus: AgentSessionOptions['onAgentStatus'],
    agentId: string | undefined,
  ) {
    this.agent = agent;
    this.pendingRun = pendingRun;
    if (onAgentStatus && agentId) {
      this.forwarder = createAgentEventForwarder(onAgentStatus, agentId);
    }
  }

  // ── AgentRuntime surface ──────────────────────────────────────────────────

  get sessionId(): string {
    return this.firstRunId ?? 'cursor-session';
  }

  readonly sessionFile: string | undefined = undefined;
  readonly contextWindow: number | undefined = undefined;

  async prompt(text: string): Promise<void> {
    this.abortRequested = false;

    // Obtain the Run to stream.
    let run: Run;
    if (this.pendingRun) {
      // Resume path: stream the pre-existing run on the first prompt.
      run = this.pendingRun;
      this.pendingRun = undefined;
    } else if (this.agent) {
      run = await this.agent.send(text);
    } else {
      throw new Error('CursorAgentRuntime: no agent or pending run available for prompt()');
    }

    this.currentRun = run;
    if (this.firstRunId === undefined) {
      this.firstRunId = run.id;
    }

    // If abort() was called while we were awaiting send(), cancel now.
    if (this.abortRequested) {
      await run.cancel();
      this.currentRun = undefined;
      return;
    }

    try {
      for await (const message of run.stream()) {
        this.handleSdkMessage(message);
      }
    } finally {
      this.currentRun = undefined;
    }
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getLastAssistantMessage(): LastAssistantMessage | undefined {
    if (!this.lastAssistantBlocks) return undefined;
    // Cursor exposes no token usage — do NOT fabricate.
    return {
      content: [...this.lastAssistantBlocks],
      usage: undefined,
    };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    const run = this.currentRun;
    if (run) {
      await run.cancel();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.agent?.close();
    this.agent = undefined;
    this.currentRun = undefined;
    this.pendingRun = undefined;
  }

  subscribe(cb: (e: AgentRuntimeEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Translate a single `SDKMessage` into neutral events + buffer assistant
   * content. Unhandled message types (system, user, thinking, status,
   * request, task) are intentionally ignored — they have no neutral event
   * equivalent and we do not fabricate data.
   */
  private handleSdkMessage(message: SDKMessage): void {
    if (message.type === 'assistant') {
      const blocks = message.message.content;
      // Buffer for getLastAssistantText / getLastAssistantMessage.
      this.lastAssistantBlocks = blocks;
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        }
      }
      this.lastAssistantText = textParts.length > 0 ? textParts.join('') : undefined;
      // No turn_end event — Cursor has no discrete turn boundaries.
    } else if (message.type === 'tool_call') {
      // Cursor emits a single tool_call event (not discrete start/end),
      // so we synthesize the pair.
      const toolCallId = message.call_id;
      const toolName = message.name;
      const isError = message.status === 'error';
      const args = (message.args as Record<string, unknown> | undefined) ?? undefined;
      this.emit({ type: 'tool_execution_start', toolName, toolCallId, args });
      this.emit({ type: 'tool_execution_end', toolName, toolCallId, isError });
    }
    // system / user / thinking / status / request / task → no neutral event.
  }

  /** Dispatch an event to all subscribers and the status forwarder. */
  private emit(event: AgentRuntimeEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
    this.forwarder?.(event);
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * Resolve the API key, preferring the `cursor` provider key, then falling back
 * to `anthropic`, then to the `CURSOR_API_KEY` environment variable.
 */
function resolveApiKey(opts: AgentSessionOptions): string | undefined {
  return opts.apiKeys?.['cursor'] ?? opts.apiKeys?.['anthropic'] ?? process.env['CURSOR_API_KEY'];
}

/**
 * Build the `AgentOptions` for `Agent.create`.
 *
 * The `provider` field on the profile is meaningless for Cursor (the SDK
 * routes by model id), so only `profile.model` is forwarded as
 * `model.id`.
 */
function buildAgentOptions(opts: AgentSessionOptions): AgentOptions {
  const model: ModelSelection = { id: opts.profile.model };

  // Cursor's sandbox is binary — granular allowedWriteDirs cannot be expressed.
  const sandboxEnabled = !!(opts.allowedWriteDirs && opts.allowedWriteDirs.length > 0);

  const options: AgentOptions = {
    model,
    local: {
      cwd: opts.cwd,
      // When allowedWriteDirs is set, enable the sandbox (full workspace
      // confinement); when absent, disable it. See sandbox caveat above.
      sandboxOptions: { enabled: sandboxEnabled },
    },
  };

  const apiKey = resolveApiKey(opts);
  if (apiKey) {
    options.apiKey = apiKey;
  }

  return options;
}

/**
 * The Cursor adapter plugin.
 */
export const cursorAdapter: AgentPlugin = {
  id: 'cursor',

  async createSession(opts: AgentSessionOptions): Promise<AgentRuntime> {
    // Resume path: reconnect to an existing run by id.
    if (opts.resumeSessionPath) {
      const run = await Agent.getRun(opts.resumeSessionPath);
      const runtime = new CursorAgentRuntime(
        /* agent */ undefined,
        /* pendingRun */ run,
        opts.onAgentStatus,
        opts.agentId,
      );
      return runtime;
    }

    // Normal path: create a new agent.
    const agentOptions = buildAgentOptions(opts);
    const agent = await Agent.create(agentOptions);
    const runtime = new CursorAgentRuntime(agent, /* pendingRun */ undefined, opts.onAgentStatus, opts.agentId);
    return runtime;
  },
};

// ─── Self-register ──────────────────────────────────────────────────────────

registerAgentPlugin(cursorAdapter);
