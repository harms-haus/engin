// ─── Codex SDK Adapter ─────────────────────────────────────────────────────
//
// Implements the neutral `AgentPlugin` contract on top of the
// `@openai/codex-sdk` package. Translates the native `ThreadEvent` stream
// emitted by a streamed Codex turn into the provider-agnostic
// `AgentRuntimeEvent` union consumed by the engine.
//
// The adapter self-registers with the plugin registry under the id `codex`
// at module load time so that simply importing this module (or the engine
// barrel that re-exports it) makes the Codex backend available to workflows.

import type {
  CommandExecutionItem,
  Input,
  McpToolCallItem,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from '@openai/codex-sdk';
import { Codex } from '@openai/codex-sdk';

import { createAgentEventForwarder, hasStatusHandlers } from '../../core/agent-event-forwarder.js';
import type { AgentPlugin, AgentRuntime, AgentRuntimeEvent, AgentSessionOptions } from '../../core/agent-plugin.js';
import { registerAgentPlugin } from '../../core/agent-registry.js';
import type { LastAssistantMessage } from '../../core/error-classifier.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the API key to hand to the Codex SDK. Prefers an explicit `codex`
 * key, then `openai`, then the `OPENAI_API_KEY` environment variable.
 */
function resolveApiKey(opts: AgentSessionOptions): string | undefined {
  return opts.apiKeys?.['codex'] ?? opts.apiKeys?.['openai'] ?? process.env['OPENAI_API_KEY'];
}

/**
 * Build the Codex `ThreadOptions` from the neutral session options.
 *
 * Sandbox policy:
 *   - When `allowedWriteDirs` is provided, restrict writes to those
 *     directories via `workspace-write` + `additionalDirectories`.
 *   - Otherwise default to workspace confinement (`workspace-write` with an
 *     empty `additionalDirectories`); the SDK confines writes to the
 *     `workingDirectory`. `danger-full-access` is never selected
 *     automatically — it requires an explicit opt-in by the caller.
 */
function buildThreadOptions(opts: AgentSessionOptions): ThreadOptions {
  const threadOptions: ThreadOptions = {
    model: opts.profile.model,
    workingDirectory: opts.cwd,
  };

  if (opts.allowedWriteDirs && opts.allowedWriteDirs.length > 0) {
    threadOptions.sandboxMode = 'workspace-write';
    threadOptions.additionalDirectories = [...opts.allowedWriteDirs];
  } else {
    threadOptions.sandboxMode = 'workspace-write';
    threadOptions.additionalDirectories = [];
  }

  return threadOptions;
}

// ─── CodexAgentRuntime ─────────────────────────────────────────────────────

/**
 * {@link AgentRuntime} implementation backed by a Codex SDK {@link Thread}.
 *
 * Each `prompt()` call drives a single streamed turn (`thread.runStreamed`)
 * and translates the emitted native events into {@link AgentRuntimeEvent}s.
 */
class CodexAgentRuntime implements AgentRuntime {
  /** The underlying Codex SDK thread. */
  private readonly thread: Thread;
  /** The thread id (populated from the `thread.started` event or resume id). */
  private _sessionId: string;
  /** Registered event subscribers. */
  private readonly subscribers = new Set<(e: AgentRuntimeEvent) => void>();
  /** Buffered plain-text of the last `agent_message` item. */
  private lastAssistantText: string | undefined;
  /** Structured metadata of the last assistant turn. */
  private lastAssistantMessage: LastAssistantMessage | undefined;
  /** AbortController for the currently in-flight turn (if any). */
  private currentAbort: AbortController | undefined;
  /** Whether `dispose()` has been called. */
  private disposed = false;

  constructor(thread: Thread, sessionId: string) {
    this.thread = thread;
    this._sessionId = sessionId;
  }

  // ── AgentRuntime surface ───────────────────────────────────────────────

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionFile(): string | undefined {
    return undefined;
  }

  get contextWindow(): number | undefined {
    return undefined;
  }

  subscribe(cb: (e: AgentRuntimeEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Cannot prompt a disposed Codex session.');
    }

    const controller = new AbortController();
    this.currentAbort = controller;

    const input: Input = text;
    const streamed = await this.thread.runStreamed(input, { signal: controller.signal });

    for await (const event of streamed.events) {
      this.handleNativeEvent(event);
    }
    // NOTE: `currentAbort` is intentionally left in place after the turn
    // completes so that a late `abort()` call still flips the forwarded
    // signal. A subsequent `prompt()` overwrites it with a fresh controller.
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getLastAssistantMessage(): LastAssistantMessage | undefined {
    return this.lastAssistantMessage;
  }

  async abort(): Promise<void> {
    const controller = this.currentAbort;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.currentAbort = undefined;
  }

  // ── Native event translation ──────────────────────────────────────────

  /**
   * Translate a single native {@link ThreadEvent} into zero or more
   * {@link AgentRuntimeEvent}s and update internal buffers.
   */
  private handleNativeEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'thread.started': {
        this._sessionId = event.thread_id;
        break;
      }
      case 'turn.started': {
        this.emit({ type: 'turn_start' });
        break;
      }
      case 'turn.completed': {
        const usage = event.usage;
        const translatedUsage =
          usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? { input: usage.input_tokens, output: usage.output_tokens }
            : undefined;

        // Build the structured last-assistant-message record for this turn.
        const content =
          this.lastAssistantText !== undefined ? [{ type: 'text', text: this.lastAssistantText }] : undefined;
        const message: LastAssistantMessage = {
          ...(content !== undefined ? { content } : {}),
          ...(translatedUsage !== undefined ? { usage: translatedUsage } : {}),
        };
        this.lastAssistantMessage = message;

        this.emit({
          type: 'turn_end',
          message: {
            role: 'assistant',
            ...(content !== undefined ? { content } : {}),
            ...(translatedUsage !== undefined ? { usage: translatedUsage } : {}),
          },
        });
        break;
      }
      case 'turn.failed': {
        const errorMessage = event.error?.message;
        // Record the failure on the last assistant message buffer.
        this.lastAssistantMessage = {
          stopReason: 'error',
          ...(errorMessage !== undefined ? { errorMessage } : {}),
        };
        // Reject the in-flight prompt by throwing synchronously from the
        // generator iteration loop. We do this by emitting nothing further
        // and throwing from here.
        throw new Error(errorMessage ?? 'Codex turn failed');
      }
      case 'item.started': {
        this.translateItemEvent(event.item, /* isStart */ true);
        break;
      }
      case 'item.updated': {
        // Updates are not translated into runtime events.
        break;
      }
      case 'item.completed': {
        this.translateItemEvent(event.item, /* isStart */ false);
        break;
      }
      case 'error': {
        throw new Error(event.message ?? 'Codex thread error');
      }
      default: {
        // Unknown event — ignore.
        break;
      }
    }
  }

  /**
   * Translate `item.started` / `item.completed` events for tool-like items
   * (command_execution, mcp_tool_call) and buffer agent_message text.
   */
  private translateItemEvent(item: ThreadItem, isStart: boolean): void {
    switch (item.type) {
      case 'agent_message': {
        // Buffer the latest agent_message text for getLastAssistantText().
        if (!isStart) {
          this.lastAssistantText = item.text;
        }
        break;
      }
      case 'command_execution': {
        const ce: CommandExecutionItem = item;
        const toolName = 'command_execution';
        const toolCallId = ce.id;
        if (isStart) {
          this.emit({
            type: 'tool_execution_start',
            toolName,
            toolCallId,
            ...(ce.command !== undefined ? { args: { command: ce.command } } : {}),
          });
        } else {
          this.emit({
            type: 'tool_execution_end',
            toolName,
            toolCallId,
            isError: ce.status === 'failed',
          });
        }
        break;
      }
      case 'mcp_tool_call': {
        const mc: McpToolCallItem = item;
        const toolName = mc.tool;
        const toolCallId = mc.id;
        if (isStart) {
          this.emit({
            type: 'tool_execution_start',
            toolName,
            toolCallId,
            ...(mc.arguments !== undefined && typeof mc.arguments === 'object' && mc.arguments !== null
              ? { args: mc.arguments as Record<string, unknown> }
              : {}),
          });
        } else {
          this.emit({
            type: 'tool_execution_end',
            toolName,
            toolCallId,
            isError: mc.status === 'failed',
          });
        }
        break;
      }
      default: {
        // Other item types (reasoning, file_change, web_search, todo_list,
        // error) are not translated into runtime events.
        break;
      }
    }
  }

  /** Broadcast a translated event to all subscribers. */
  private emit(event: AgentRuntimeEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // Subscriber errors must not disrupt the turn.
      }
    }
  }
}

// ─── Plugin ────────────────────────────────────────────────────────────────

/**
 * The Codex {@link AgentPlugin}. Creates a Codex SDK thread (new or resumed)
 * and wraps it in a {@link CodexAgentRuntime}.
 */
export const codexAdapter: AgentPlugin = {
  id: 'codex',

  async createSession(opts: AgentSessionOptions): Promise<AgentRuntime> {
    // 1. Resolve API key and construct the Codex client.
    const apiKey = resolveApiKey(opts);
    const codexOptions: { apiKey?: string } = {};
    if (apiKey !== undefined) {
      codexOptions.apiKey = apiKey;
    }
    const codex = new Codex(codexOptions);

    // 2. Build thread options.
    const threadOptions = buildThreadOptions(opts);

    // 3. Start or resume a thread.
    let thread: Thread;
    let initialSessionId: string;
    if (opts.resumeSessionPath) {
      thread = codex.resumeThread(opts.resumeSessionPath, threadOptions);
      initialSessionId = opts.resumeSessionPath;
    } else {
      thread = codex.startThread(threadOptions);
      // The thread id is only known once a `thread.started` event arrives;
      // use a placeholder until then. The runtime updates sessionId from
      // the event stream.
      initialSessionId = thread.id ?? '';
    }

    // 4. Wrap in the runtime.
    const runtime = new CodexAgentRuntime(thread, initialSessionId);

    // 5. Wire onAgentStatus forwarding when handlers are present.
    if (opts.onAgentStatus && hasStatusHandlers(opts.onAgentStatus)) {
      const effectiveAgentId = opts.agentId ?? runtime.sessionId;
      const forwarder = createAgentEventForwarder(opts.onAgentStatus, effectiveAgentId);
      runtime.subscribe(forwarder);
    }

    return runtime;
  },
};

// ─── Self-registration ─────────────────────────────────────────────────────

registerAgentPlugin(codexAdapter);
