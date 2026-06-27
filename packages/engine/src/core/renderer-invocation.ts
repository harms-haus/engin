// ─── Renderer Invocation ─────────────────────────────────────────────────────
//
// Shared helper that looks up a per-profile renderer and, when the agent
// produced output, fires the `onAgentRender` status callback. Extracted from
// the legacy inline blocks in the old task execution modules.

import type { RendererRegistry } from './renderer-registry.js';
import { extractJsonFromText } from './structured-output.js';

/** Callback shape for delivering a rendered agent output. */
export type AgentRenderHandler = (info: { agentId: string; profile: string; taskId: string; rendered: string }) => void;

/**
 * Invoke the renderer registered for `profileId` (if any) against the agent's
 * raw assistant text, firing `onAgentRender` when a non-empty rendering is
 * produced.
 *
 * Data coercion mirrors the original inline blocks: if the raw text contains a
 * parseable JSON document (per {@link extractJsonFromText}), the parsed value
 * is passed to the renderer; otherwise the raw text is passed verbatim.
 *
 * No-ops (returns without firing) when:
 * - no `rendererRegistry` is provided,
 * - no renderer is registered for `profileId`,
 * - `rawText` is empty/undefined, or
 * - the renderer returns an empty/falsy value.
 */
export function invokeRenderer(
  rendererRegistry: RendererRegistry | undefined,
  profileId: string,
  rawText: string | undefined,
  agentId: string,
  taskId: string,
  onAgentRender?: AgentRenderHandler,
): void {
  if (!rendererRegistry) return;
  const renderer = rendererRegistry.get(profileId);
  if (!renderer) return;
  if (!rawText) return;

  const jsonStr = extractJsonFromText(rawText);
  let data: unknown = rawText;
  if (jsonStr) {
    try {
      data = JSON.parse(jsonStr);
    } catch {
      data = rawText;
    }
  }

  const rendered = renderer(data);
  if (rendered) {
    onAgentRender?.({ agentId, profile: profileId, taskId, rendered });
  }
}
