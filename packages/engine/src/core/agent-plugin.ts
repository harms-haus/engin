// ─── Neutral Agent Plugin Contract ──────────────────────────────────────────
//
// This module defines the provider-neutral contract for agent plugins.
// An agent plugin is an adapter that creates `AgentRuntime` sessions —
// the runtime is the thin abstraction through which the engine drives an
// LLM coding agent (prompt, subscribe to events, abort, dispose).
//
// The contract is intentionally minimal so that multiple backends
// (pi-coding-agent, future adapters) can implement it.

import type { AgentProfile, AgentStatusCallbacks } from './types.js';

// ─── Re-exports ─────────────────────────────────────────────────────────────

/**
 * Re-exported from {@link ./error-classifier.js} so consumers of the agent
 * plugin contract have a single import surface. Carries the last assistant
 * message's `stopReason`, `errorMessage`, `content`, and `usage` metadata.
 */
export type { LastAssistantMessage } from './error-classifier.js';

// Imported into local scope so `AgentRuntime.getLastAssistantMessage()`
// can reference it without exposing a second import surface.
import type { LastAssistantMessage } from './error-classifier.js';

// ─── AgentRuntimeEvent ──────────────────────────────────────────────────────

/**
 * Discriminated union of runtime events emitted by an {@link AgentRuntime}
 * session. Each variant corresponds to a lifecycle milestone in the agent
 * turn / tool / retry cycle.
 *
 * This is the canonical definition of `AgentRuntimeEvent`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AgentRuntimeEvent =
  /** A new turn has started. */
  | { type: 'turn_start' }
  /** A turn has completed; carries the assistant message summary. */
  | {
      type: 'turn_end';
      message: { role: string; content?: any[]; usage?: { input: number; output: number } };
    }
  /** A tool execution is about to begin. */
  | { type: 'tool_execution_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
  /** A tool execution has finished (successfully or with an error). */
  | { type: 'tool_execution_end'; toolName: string; toolCallId: string; isError: boolean }
  /** An automatic retry is about to start after a recoverable error. */
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  /** An automatic retry has concluded. */
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string };
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── PromptOptions ──────────────────────────────────────────────────────────

/**
 * Options passed to {@link AgentRuntime.prompt}.
 */
export interface PromptOptions {
  /** Cooperative cancellation signal. When aborted, the runtime should stop generation. */
  signal?: AbortSignal;
}

// ─── AgentRuntime ───────────────────────────────────────────────────────────

/**
 * The neutral session interface returned by an {@link AgentPlugin.createSession}.
 *
 * A runtime encapsulates a single agent conversation thread. The engine
 * interacts with it exclusively through this interface — no provider-specific
 * types leak out.
 */
export interface AgentRuntime {
  /** Unique identifier for this session. */
  readonly sessionId: string;
  /** Path to the session file on disk (if persisted). */
  readonly sessionFile?: string;
  /** Resolved context window for the underlying model (token count). */
  readonly contextWindow?: number;

  /**
   * Send a prompt to the agent. Resolves when the agent has finished
   * responding to this turn.
   *
   * @param text   The user prompt text.
   * @param opts   Optional {@link PromptOptions} (e.g. AbortSignal).
   */
  prompt(text: string, opts?: PromptOptions): Promise<void>;

  /** Extracted plain-text of the last assistant response, or `undefined`. */
  getLastAssistantText(): string | undefined;

  /** Structured metadata of the last assistant message, or `undefined`. */
  getLastAssistantMessage(): LastAssistantMessage | undefined;

  /** Abort any in-flight prompt and wait for the runtime to settle. */
  abort(): Promise<void>;

  /** Release all resources held by this session. Safe to call once. */
  dispose(): void;

  /**
   * Subscribe to {@link AgentRuntimeEvent}s for this session.
   *
   * @returns An unsubscribe function — call it to stop receiving events.
   */
  subscribe(cb: (e: AgentRuntimeEvent) => void): () => void;
}

// ─── AgentSessionOptions ────────────────────────────────────────────────────

/**
 * Options passed to {@link AgentPlugin.createSession}.
 *
 * Mirrors the existing `HarnessCreationOptions` shape from `types.ts` so
 * the current harness factory can implement the plugin without translation.
 */
export interface AgentSessionOptions {
  /** The agent profile (model, provider, system prompt, tool config). */
  profile: AgentProfile;
  /** Working directory for the agent session. */
  cwd: string;
  /** Provider API keys keyed by provider name. */
  apiKeys?: Record<string, string>;
  /** Status callback sink for turn / tool / retry lifecycle events. */
  onAgentStatus?: AgentStatusCallbacks;
  /** Directory where session files are stored. */
  sessionDir?: string;
  /** Path to an existing session file to resume. */
  resumeSessionPath?: string;
  /** Override agent ID used in status callbacks (defaults to sessionId). */
  agentId?: string;
  /** Restrict file writes to these directories (write sandbox). */
  allowedWriteDirs?: string[];
}

// ─── AgentPlugin ────────────────────────────────────────────────────────────

/**
 * The adapter contract. Each backend implements this interface to bridge
 * its native session type into the neutral {@link AgentRuntime}.
 *
 * Register an instance with the engine to make a provider available
 * to workflows.
 */
export interface AgentPlugin {
  /** Unique plugin identifier (e.g. `"pi-coding-agent"`). */
  readonly id: string;
  /**
   * Create and return a new {@link AgentRuntime} session configured from
   * the given {@link AgentSessionOptions}.
   */
  createSession(opts: AgentSessionOptions): Promise<AgentRuntime>;
}
