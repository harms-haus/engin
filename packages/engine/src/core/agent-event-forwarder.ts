// ─── Agent Event Forwarder ─────────────────────────────────────────────────
//
// Pure event-mapping core that maps AgentRuntimeEvents to AgentStatusCallbacks.
//
// `createAgentEventForwarder` maps neutral `AgentRuntimeEvent`s to the
// corresponding `AgentStatusCallbacks` methods. It is provider-agnostic —
// the pi adapter subscribes a cast version of this forwarder to pi's
// `session.subscribe()` (whose events are structurally identical to
// `AgentRuntimeEvent`).

import type { AgentRuntimeEvent, AgentSessionOptions } from './agent-plugin.js';
import { redactSecrets } from './redact.js';
import type { AgentStatusCallbacks, TurnContentBlock } from './types.js';

/**
 * Returns `true` when at least one handler is defined on the
 * `AgentStatusCallbacks` sink (i.e. the optional `onAgentStatus` on
 * {@link AgentSessionOptions} carries at least one callback).
 *
 * Shared by every adapter so the multi-condition check over the six
 * handlers is implemented in exactly one place.
 */
export function hasStatusHandlers(onAgentStatus: AgentSessionOptions['onAgentStatus']): boolean {
  return Boolean(
    onAgentStatus &&
    (onAgentStatus.onTurnStart ||
      onAgentStatus.onTurnEnd ||
      onAgentStatus.onToolCallStart ||
      onAgentStatus.onToolCallEnd ||
      onAgentStatus.onAutoRetryStart ||
      onAgentStatus.onAutoRetryCompleted),
  );
}

/**
 * Map an {@link AgentRuntimeEvent} to the corresponding
 * {@link AgentStatusCallbacks} call. Exported so it can be unit-tested
 * without mocking npm-package dependencies (the SDK client, AuthStorage, etc.).
 *
 * @returns a subscriber function suitable for `session.subscribe()`.
 */
export function createAgentEventForwarder(
  onAgentStatus: AgentStatusCallbacks,
  effectiveAgentId: string,
): (event: AgentRuntimeEvent) => void {
  let turnCount = 0;
  return (event: AgentRuntimeEvent) => {
    const e = event;
    if (e.type === 'turn_start') {
      onAgentStatus.onTurnStart?.({
        agentId: effectiveAgentId,
        turn: ++turnCount,
      });
    } else if (e.type === 'turn_end') {
      const isAssistant = e.message?.role === 'assistant';
      const usage = isAssistant ? e.message?.usage : undefined;
      let contentBlocks: TurnContentBlock[] | undefined;
      if (isAssistant && e.message.content) {
        contentBlocks = [];
        // Map only the block types supported by TurnContentBlock.
        // Unrecognized types (e.g., future upstream additions) are intentionally skipped.
        for (const block of e.message.content) {
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            contentBlocks.push({ type: 'thinking', thinking: block.thinking, redacted: block.redacted });
          } else if (block.type === 'toolCall') {
            contentBlocks.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments });
          }
        }
      }
      onAgentStatus.onTurnEnd?.({
        agentId: effectiveAgentId,
        turn: turnCount,
        tokens: usage ? { input: usage.input, output: usage.output } : undefined,
        contentBlocks,
      });
    } else if (e.type === 'tool_execution_start') {
      onAgentStatus.onToolCallStart?.({
        agentId: effectiveAgentId,
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        arguments: e.args ?? {},
      });
    } else if (e.type === 'tool_execution_end') {
      onAgentStatus.onToolCallEnd?.({
        agentId: effectiveAgentId,
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        isError: e.isError ?? false,
      });
    } else if (e.type === 'auto_retry_start') {
      onAgentStatus.onAutoRetryStart?.({
        agentId: effectiveAgentId,
        attempt: Number(e.attempt) || 1,
        maxAttempts: Number(e.maxAttempts) || 1,
        delayMs: Number(e.delayMs) || 0,
        errorMessage: redactSecrets(e.errorMessage),
      });
    } else if (e.type === 'auto_retry_end') {
      onAgentStatus.onAutoRetryCompleted?.({
        agentId: effectiveAgentId,
        success: e.success === true,
        attempt: Number(e.attempt) || 1,
        finalError: e.finalError != null ? redactSecrets(e.finalError) : undefined,
      });
    }
  };
}
