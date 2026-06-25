// ─── pi-coding-agent Adapter ────────────────────────────────────────────────
//
// AgentPlugin implementation that bridges `@earendil-works/pi-coding-agent`
// native sessions into the neutral `AgentRuntime` contract.
//
// On module import the plugin self-registers with the engine's agent plugin
// registry under the id `'pi-coding-agent'` (the default plugin id).

import { getModel } from '@earendil-works/pi-ai';
import {
  type AgentSessionEvent,
  type PromptOptions as PiPromptOptions,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { createAgentEventForwarder, hasStatusHandlers } from '../../core/agent-event-forwarder.js';
import type {
  AgentPlugin,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionOptions,
  PromptOptions,
} from '../../core/agent-plugin.js';
import { registerAgentPlugin } from '../../core/agent-registry.js';
import { extractLastAssistantMessage } from '../../core/error-classifier.js';
import { DEFAULT_TOOLS } from '../../core/utils.js';
import { createWriteSandboxExtension } from './write-sandbox.js';

// ─── Adapter ────────────────────────────────────────────────────────────────

/**
 * The pi-coding-agent {@link AgentPlugin}.
 *
 * `createSession` encapsulates every step needed to wire a pi-coding-agent
 * session into the neutral {@link AgentRuntime} contract:
 *
 * 1. Model resolution via {@link getModel} (throws on unknown provider/model).
 * 2. AuthStorage creation with runtime API-key overrides.
 * 3. Tool allowlist/denylist built from {@link DEFAULT_TOOLS}.
 * 4. Optional write-sandbox extension factory.
 * 5. {@link DefaultResourceLoader} configured with the profile's system prompt.
 * 6. SessionManager selection (resume / create / in-memory).
 * 7. {@link createAgentSession} wiring.
 * 8. Optional agent-status callback subscription.
 *
 * The returned {@link AgentRuntime} thin-wraps the native `AgentSession`.
 */
export const piCodingAgentAdapter: AgentPlugin = {
  id: 'pi-coding-agent',

  async createSession(opts: AgentSessionOptions): Promise<AgentRuntime> {
    const { profile, cwd, apiKeys, onAgentStatus, allowedWriteDirs } = opts;

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
    if (opts.resumeSessionPath) {
      sessionManager = SessionManager.open(opts.resumeSessionPath, undefined, cwd);
    } else if (opts.sessionDir) {
      sessionManager = SessionManager.create(cwd, opts.sessionDir);
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
    if (onAgentStatus && hasStatusHandlers(onAgentStatus)) {
      const effectiveAgentId = opts.agentId ?? sessionId;
      unsubscribe = session.subscribe(
        createAgentEventForwarder(onAgentStatus, effectiveAgentId) as (event: AgentSessionEvent) => void,
      );
    }

    // 7. Build the neutral AgentRuntime wrapper around the pi AgentSession.
    const runtime: AgentRuntime = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      contextWindow: model.contextWindow,

      prompt(text: string, promptOpts?: PromptOptions): Promise<void> {
        return session.prompt(text, promptOpts as unknown as PiPromptOptions);
      },

      getLastAssistantText(): string | undefined {
        return session.getLastAssistantText();
      },

      getLastAssistantMessage() {
        return extractLastAssistantMessage(session);
      },

      abort(): Promise<void> {
        return session.abort();
      },

      dispose(): void {
        unsubscribe?.();
        session.dispose();
      },

      subscribe(cb: (e: AgentRuntimeEvent) => void): () => void {
        return session.subscribe((e) => cb(e as unknown as AgentRuntimeEvent));
      },
    };

    return runtime;
  },
};

// ─── Self-registration ──────────────────────────────────────────────────────
//
// Importing this module registers the pi-coding-agent plugin so it can be
// resolved via `requireAgentPlugin('pi-coding-agent')` (or the default lookup).

registerAgentPlugin(piCodingAgentAdapter);
