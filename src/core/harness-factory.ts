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

import { resolveApiKeyOrThrow } from './auth.js';
import { loadProfile } from './profile.js';
import type { HarnessCreationOptions } from './types.js';

// ─── Agent Event Types ──────────────────────────────────────────────────────

type AgentLevelEvent =
  | { type: 'turn_start' }
  | { type: 'turn_end'; message?: { usage?: { input: number; output: number } } }
  | { type: 'tool_execution_start'; toolName: string; toolCallId: string }
  | { type: 'tool_execution_end'; toolName: string; toolCallId: string; isError?: boolean };

// ─── createHarness ──────────────────────────────────────────────────────────

/**
 * Create an {@link AgentSession} wired to an in-memory session.
 *
 * Resolution steps:
 * 1. Resolve the model via {@link getModel}; throw if the provider/model
 *    combination is unknown.
 * 2. Resolve the API key via {@link resolveApiKeyOrThrow} and register it
 *    with an in-memory {@link AuthStorage}.
 * 3. Build the tool allowlist/denylist from the profile configuration.
 * 4. Create a {@link DefaultResourceLoader} with the profile's system prompt.
 * 5. Construct the session via {@link createAgentSession}.
 * 6. Optionally subscribe to agent status callbacks.
 */
export async function createHarness(
  options: HarnessCreationOptions,
): Promise<{ session: AgentSession; sessionId: string; dispose: () => void }> {
  const { profile, cwd, apiKeys, onAgentStatus } = options;

  // 1. Model
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(profile.provider as any, profile.model as any);
  if (!model) {
    throw new Error(
      `Unknown model "${profile.model}" for provider "${profile.provider}". ` +
        `Check the provider and model identifiers.`,
    );
  }

  // 2. API key
  const apiKey = resolveApiKeyOrThrow(profile.provider, apiKeys);
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(profile.provider, apiKey);

  // 3. Tools
  const defaultTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  let builtTools: string[];
  if (profile.includeTools && profile.includeTools.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    builtTools = defaultTools.filter((name) => profile.includeTools!.includes(name));
  } else {
    builtTools = [...defaultTools];
  }
  if (profile.excludeTools && profile.excludeTools.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    builtTools = builtTools.filter((name) => !profile.excludeTools!.includes(name));
  }

  // 4. Resource loader
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    systemPromptOverride: () => profile.systemPrompt,
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
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      const e = event as AgentLevelEvent;
      if (e.type === 'turn_start') {
        onAgentStatus.onTurnStart?.({
          agentId: sessionId,
          turn: ++turnCount,
        });
      } else if (e.type === 'turn_end') {
        const usage = e.message?.usage;
        onAgentStatus.onTurnEnd?.({
          agentId: sessionId,
          turn: turnCount,
          tokens: usage ? { input: usage.input, output: usage.output } : undefined,
        });
      } else if (e.type === 'tool_execution_start') {
        onAgentStatus.onToolCallStart?.({
          agentId: sessionId,
          toolName: e.toolName,
          toolCallId: e.toolCallId,
        });
      } else if (e.type === 'tool_execution_end') {
        onAgentStatus.onToolCallEnd?.({
          agentId: sessionId,
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

// ─── createHarnessFromProfile ───────────────────────────────────────────────

/**
 * Convenience wrapper that loads an {@link AgentProfile} from a directory
 * and delegates to {@link createHarness}.
 */
export async function createHarnessFromProfile(
  dirPath: string,
  profileId: string,
  options: Omit<HarnessCreationOptions, 'profile'>,
): Promise<{ session: AgentSession; sessionId: string; dispose: () => void }> {
  const profile = await loadProfile(dirPath, profileId);
  return createHarness({ ...options, profile });
}
