// ─── Harness Factory ────────────────────────────────────────────────────────
import {
    AgentHarness,
    InMemorySessionRepo,
    JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getModel } from "@earendil-works/pi-ai";

import type { AgentTool, HarnessCreationOptions, AgentProfile } from "./types";
import { resolveApiKeyOrThrow } from "./auth";
import { createDefaultToolRegistry } from "./tool-registry";
import { loadProfile } from "./profile";

// ─── createHarness ──────────────────────────────────────────────────────────

/**
 * Create an {@link AgentHarness} wired to a real filesystem and session.
 *
 * Resolution steps:
 * 1. Create a {@link NodeExecutionEnv} with the given `cwd`.
 * 2. Create a session — {@link InMemorySessionRepo} when `sessionId` is
 *    omitted, or {@link JsonlSessionRepo} when one is provided.
 * 3. Resolve the model via {@link getModel}; throw if the provider/model
 *    combination is unknown.
 * 4. Build the tool list from the default registry, filtered by the profile's
 *    `includeTools` / `excludeTools`, then augmented with any
 *    `additionalTools`.
 * 5. Resolve the API key via {@link resolveApiKeyOrThrow}.
 * 6. Construct and return the harness together with the session id.
 */
export async function createHarness(
    options: HarnessCreationOptions,
): Promise<{ harness: AgentHarness; sessionId: string }> {
    const { profile, cwd, sessionId, additionalTools, apiKeys } = options;

    // 1. Execution environment
    const env = new NodeExecutionEnv({ cwd });

    // 2. Session
    let session;
    let resolvedSessionId: string;

    if (sessionId) {
        // Persistent JSONL-backed session
        const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
        const sess = await repo.create({ cwd });
        session = sess;
        resolvedSessionId = sessionId;
    } else {
        // In-memory session
        const repo = new InMemorySessionRepo();
        const sess = await repo.create();
        session = sess;
        const meta = await sess.getMetadata();
        resolvedSessionId = meta.id;
    }

    // 3. Model
    const model = getModel(profile.provider as any, profile.model as any);
    if (!model) {
        throw new Error(
            `Unknown model "${profile.model}" for provider "${profile.provider}". ` +
                `Check the provider and model identifiers.`,
        );
    }

    // 4. Tools
    const toolRegistry = createDefaultToolRegistry(env);
    const resolvedTools: AgentTool[] = toolRegistry.resolveTools(
        profile.includeTools,
        profile.excludeTools,
    );
    if (additionalTools && additionalTools.length > 0) {
        resolvedTools.push(...additionalTools);
    }

    // 5. API key
    const apiKey = resolveApiKeyOrThrow(profile.provider, apiKeys);

    // 6. Harness
    const harness = new AgentHarness({
        env,
        session,
        model,
        thinkingLevel: profile.thinkingLevel,
        systemPrompt: profile.systemPrompt,
        tools: resolvedTools,
        getApiKeyAndHeaders: async () => ({ apiKey }),
    });

    return { harness, sessionId: resolvedSessionId };
}

// ─── createHarnessFromProfile ───────────────────────────────────────────────

/**
 * Convenience wrapper that loads an {@link AgentProfile} from a directory
 * and delegates to {@link createHarness}.
 */
export async function createHarnessFromProfile(
    dirPath: string,
    profileId: string,
    options: Omit<HarnessCreationOptions, "profile">,
): Promise<{ harness: AgentHarness; sessionId: string }> {
    const profile = await loadProfile(dirPath, profileId);
    return createHarness({ ...options, profile });
}
