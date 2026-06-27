// ─── Tests for invokeRenderer (core/renderer-invocation.ts) ─────────────────
//
// These are test-first specs for the helper extracted from the renderer
// invocation blocks inlined in BOTH:
//   - packages/engine/src/core/renderer-invocation.ts (shared helper)
//   - packages/engine/src/pool/session.ts (runSession)
//
// Extracting this into one function eliminates the renderer duplication.
//
// The contract under test:
//
//   export function invokeRenderer(
//     rendererRegistry: RendererRegistry | undefined,
//     profileId: string,
//     rawText: string | undefined,
//     agentId: string,
//     taskId: string,
//     onAgentRender?: (info: {
//       agentId: string;
//       profile: string;
//       taskId: string;
//       rendered: string;
//     }) => void,
//   ): void
//
// Behaviour (mirrors the inline block it replaces):
//   - No-op when `rendererRegistry` is undefined.
//   - No-op when the registry has no renderer for `profileId`.
//   - No-op when `rawText` is falsy (undefined / empty string).
//   - Extracts JSON from `rawText` (extractJsonFromText); if found and
//     parseable, the parsed object is passed to the renderer, otherwise the
//     raw text is passed.
//   - Calls the renderer with the data.
//   - Fires `onAgentRender({ agentId, profile: profileId, taskId, rendered })`
//     only when the renderer returns a truthy string.
//   - A renderer returning `''` or `undefined` suppresses the callback.

import { describe, expect, it, mock } from 'bun:test';
import { invokeRenderer } from '../../packages/engine/src/core/renderer-invocation.js';
import type { RenderFunction } from '../../packages/engine/src/core/renderer-registry.js';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

type RenderInfo = { agentId: string; profile: string; taskId: string; rendered: string };

function registryWith(profile: string, fn: RenderFunction): RendererRegistry {
  const registry = new RendererRegistry();
  registry.register(profile, fn);
  return registry;
}

// ─── No-op guards ───────────────────────────────────────────────────────────

describe('invokeRenderer — no-op guards', () => {
  it('is a no-op when rendererRegistry is undefined', () => {
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(undefined, 'coder', '{"x":1}', 'agent-1', 'task-1', onAgentRender);

    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('is a no-op when the registry has no renderer for the profileId', () => {
    const registry = new RendererRegistry(); // empty
    const onAgentRender = mock((_info: RenderInfo) => {});
    const renderSpy = mock((_data: unknown) => 'should-not-run');
    registry.register('other-profile', renderSpy as unknown as RenderFunction);

    invokeRenderer(registry, 'coder', '{"x":1}', 'agent-1', 'task-1', onAgentRender);

    expect(renderSpy).not.toHaveBeenCalled();
    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('is a no-op when rawText is undefined', () => {
    const renderSpy = mock((_data: unknown) => 'rendered');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', undefined, 'agent-1', 'task-1', onAgentRender);

    expect(renderSpy).not.toHaveBeenCalled();
    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('is a no-op when rawText is an empty string', () => {
    const renderSpy = mock((_data: unknown) => 'rendered');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', '', 'agent-1', 'task-1', onAgentRender);

    // The inline block guards on `if (rawText)` — empty string is falsy.
    expect(renderSpy).not.toHaveBeenCalled();
    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('does not throw when onAgentRender is undefined', () => {
    const registry = registryWith('coder', () => 'rendered');

    expect(() => invokeRenderer(registry, 'coder', '{"x":1}', 'agent-1', 'task-1', undefined)).not.toThrow();
  });

  it('does not throw when both rendererRegistry and onAgentRender are undefined', () => {
    expect(() => invokeRenderer(undefined, 'coder', '{"x":1}', 'agent-1', 'task-1', undefined)).not.toThrow();
  });
});

// ─── JSON extraction / data parsing ─────────────────────────────────────────

describe('invokeRenderer — data parsing', () => {
  it('parses a JSON object from rawText and passes it to the renderer', () => {
    const renderSpy = mock((_data: unknown) => 'rendered');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);

    invokeRenderer(registry, 'coder', '{"approved":true,"count":3}', 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledWith({ approved: true, count: 3 });
  });

  it('extracts JSON embedded in fenced code blocks', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const raw = 'Here:\n```json\n{"summary":"done"}\n```\nDone.';

    invokeRenderer(registry, 'coder', raw, 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledWith({ summary: 'done' });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);

    invokeRenderer(registry, 'coder', 'The answer is {"x": 10} as shown.', 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledWith({ x: 10 });
  });

  it('parses a JSON array and passes it to the renderer', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);

    invokeRenderer(registry, 'coder', '[1, 2, 3]', 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('passes the raw text when rawText contains no JSON', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const raw = 'The implementation looks correct but could use more comments.';

    invokeRenderer(registry, 'coder', raw, 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledWith(raw);
  });

  it('falls back to raw text when rawText looks like JSON but is invalid', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    // Brace-containing but unparseable: extractJsonFromText returns null (its
    // only candidate fails JSON.parse), so the renderer receives raw text.
    const raw = '{ broken json }';

    invokeRenderer(registry, 'coder', raw, 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    // No parseable JSON found → data falls back to the raw text.
    expect(renderSpy).toHaveBeenCalledWith(raw);
  });

  it('passes through nested JSON objects untouched', () => {
    const renderSpy = mock((_data: unknown) => 'r');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const data = { outer: { inner: { deep: true } } };

    invokeRenderer(registry, 'coder', JSON.stringify(data), 'a', 't', () => undefined);

    expect(renderSpy).toHaveBeenCalledWith(data);
  });
});

// ─── onAgentRender firing ───────────────────────────────────────────────────

describe('invokeRenderer — onAgentRender callback', () => {
  it('fires onAgentRender with the rendered string when the renderer returns truthy', () => {
    const registry = registryWith('coder', (data) => {
      const d = data as { summary?: string };
      return `## ${d.summary ?? 'unknown'}`;
    });
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', '{"summary":"done"}', 'task-1', 'task-1', onAgentRender);

    expect(onAgentRender).toHaveBeenCalledTimes(1);
    expect(onAgentRender).toHaveBeenCalledWith({
      agentId: 'task-1',
      profile: 'coder',
      taskId: 'task-1',
      rendered: '## done',
    });
  });

  it('forwards the exact string returned by the renderer', () => {
    const rendered = 'RENDERED OUTPUT';
    const registry = registryWith('coder', () => rendered);
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', 'raw text', 'a', 't', onAgentRender);

    expect(onAgentRender).toHaveBeenCalledWith(expect.objectContaining({ rendered }));
  });

  it('does not fire onAgentRender when the renderer returns an empty string', () => {
    const renderSpy = mock((_data: unknown) => '');
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', '{"x":1}', 'a', 't', onAgentRender);

    // The renderer IS still invoked...
    expect(renderSpy).toHaveBeenCalledTimes(1);
    // ...but an empty result suppresses the render event.
    expect(onAgentRender).not.toHaveBeenCalled();
  });

  it('does not fire onAgentRender when the renderer returns undefined', () => {
    const renderSpy = mock((_data: unknown) => undefined as unknown as string);
    const registry = registryWith('coder', renderSpy as unknown as RenderFunction);
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', '{"x":1}', 'a', 't', onAgentRender);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(onAgentRender).not.toHaveBeenCalled();
  });
});

// ─── agentId / taskId / profileId propagation ───────────────────────────────

describe('invokeRenderer — field propagation', () => {
  it('passes agentId distinct from taskId (session-style)', () => {
    const registry = registryWith('coder', () => 'rendered output');
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', 'done', 'lane-3', 'my-task-99', onAgentRender);

    expect(onAgentRender).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'lane-3',
        profile: 'coder',
        taskId: 'my-task-99',
      }),
    );
  });

  it('uses the same value for agentId and taskId when passed the same (runStepTask style)', () => {
    const registry = registryWith('coder', () => 'rendered');
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'coder', '{"x":1}', 'task-1', 'task-1', onAgentRender);

    const call = onAgentRender.mock.calls[0][0] as RenderInfo;
    expect(call.agentId).toBe('task-1');
    expect(call.taskId).toBe('task-1');
    expect(call.agentId).toBe(call.taskId);
  });

  it('propagates the profileId as the profile field', () => {
    const registry = registryWith('reviewer', () => 'r');
    const onAgentRender = mock((_info: RenderInfo) => {});

    invokeRenderer(registry, 'reviewer', 'text', 'a', 't', onAgentRender);

    expect(onAgentRender).toHaveBeenCalledWith(expect.objectContaining({ profile: 'reviewer' }));
  });
});

// ─── Return value ───────────────────────────────────────────────────────────

describe('invokeRenderer — return value', () => {
  it('returns void', () => {
    const registry = registryWith('coder', () => 'rendered');
    const result = invokeRenderer(registry, 'coder', '{"x":1}', 'a', 't', () => undefined);
    expect(result).toBeUndefined();
  });

  it('returns void even in the no-op path', () => {
    const result = invokeRenderer(undefined, 'coder', 'text', 'a', 't', () => undefined);
    expect(result).toBeUndefined();
  });
});
