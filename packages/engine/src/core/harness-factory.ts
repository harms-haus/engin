// ─── Harness Factory ────────────────────────────────────────────────────────
import { getModel } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import type { HarnessCreationOptions, TurnContentBlock } from './types.js';
import { DEFAULT_TOOLS } from './utils.js';
import { createWriteSandboxExtension } from './write-sandbox.js';

// ─── Agent Event Types ──────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type AgentLevelEvent =
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: { role: string; content?: any[]; usage?: { input: number; output: number } } }
  | { type: 'tool_execution_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; toolCallId: string; isError: boolean };
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── createHarness ──────────────────────────────────────────────────────────

/**
 * Create an {@link AgentSession} wired to an in-memory session.
 *
 * Resolution steps:
 * 1. Resolve the model via {@link getModel}; throw if the provider/model
 *    combination is unknown.
 * 2. Create an {@link AuthStorage} via {@link AuthStorage.create} (loads
 *    credentials from `~/.pi/agent/auth.json`) and apply any caller-supplied
 *    `apiKeys` as runtime overrides.
 * 3. Build the tool allowlist/denylist from the profile configuration.
 * 4. Create a {@link DefaultResourceLoader} with the profile's system prompt.
 * 5. Construct the session via {@link createAgentSession}.
 * 6. Optionally subscribe to agent status callbacks.
 */
export async function createHarness(
  options: HarnessCreationOptions,
): Promise<{ session: AgentSession; sessionId: string; dispose: () => void }> {
  const { profile, cwd, apiKeys, onAgentStatus, allowedWriteDirs } = options;

  // 1. Model
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(profile.provider as any, profile.model as any);
  if (!model) {
    throw new Error(
      `Unknown model "${profile.model}" for provider "${profile.provider}". ` +
        `Check the provider and model identifiers.`,
    );
  }

  // 2. Auth storage — reads ~/.pi/agent/auth.json for stored credentials
  const authStorage = AuthStorage.create();
  if (apiKeys) {
    for (const [provider, key] of Object.entries(apiKeys)) {
      authStorage.setRuntimeApiKey(provider, key);
    }
  }

  // 3. Tools
  let builtTools: string[];
  if (profile.includeTools && profile.includeTools.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    builtTools = [...DEFAULT_TOOLS].filter((name) => profile.includeTools!.includes(name));
  } else {
    builtTools = [...DEFAULT_TOOLS];
  }
  if (profile.excludeTools && profile.excludeTools.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    builtTools = builtTools.filter((name) => !profile.excludeTools!.includes(name));
  }

  // 4. Resource loader
  //    When a write sandbox is requested, install it as an inline extension
  //    factory so its `tool_call` handler is picked up by the AgentSession.
  //    Inline factories load unconditionally (no project-trust gating) and run
  //    headlessly — the handler needs no UI/command bindings.
  const extensionFactories =
    allowedWriteDirs && allowedWriteDirs.length > 0
      ? [createWriteSandboxExtension({ allowedDirs: allowedWriteDirs, cwd })]
      : [];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    systemPromptOverride: () => profile.systemPrompt,
    extensionFactories,
  });
  await resourceLoader.reload();

  // 5. Session
  let sessionManager;
  if (options.resumeSessionPath) {
    sessionManager = SessionManager.open(options.resumeSessionPath, undefined, cwd);
  } else if (options.sessionDir) {
    sessionManager = SessionManager.create(cwd, options.sessionDir);
  } else {
    sessionManager = SessionManager.inMemory(cwd);
  }
  const { session } = await createAgentSession({
    sessionManager,
    model,
    thinkingLevel: profile.thinkingLevel,
    tools: builtTools,
    resourceLoader,
    authStorage,
  });

  const sessionId = session.sessionId;

  // 6. Subscribe to agent status callbacks (if any handlers provided)
  let unsubscribe: (() => void) | undefined;
  if (
    onAgentStatus &&
    (onAgentStatus.onTurnStart ||
      onAgentStatus.onTurnEnd ||
      onAgentStatus.onToolCallStart ||
      onAgentStatus.onToolCallEnd)
  ) {
    let turnCount = 0;
    const effectiveAgentId = options.agentId ?? sessionId;
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      const e = event as AgentLevelEvent;
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
      }
    });
  }

  const dispose = () => {
    unsubscribe?.();
    session.dispose();
  };

  return { session, sessionId, dispose };
}
