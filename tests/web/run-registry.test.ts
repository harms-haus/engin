import { describe, expect, it } from 'bun:test';
import { RunRegistry } from '../../src/web/run-registry.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return a fresh registry pre-populated with one run. */
function registryWithOneRun(): { registry: RunRegistry; runId: string } {
  const registry = new RunRegistry();
  const runId = registry.createRun('Test Workflow');
  return { registry, runId };
}

// ─── createRun ──────────────────────────────────────────────────────────────

describe('createRun', () => {
  it('returns a string ID', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('My Workflow');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns a UUID-like string', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('uuid-check');
    // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('stores the entry so getRun returns it', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Stored Run');
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(id);
    expect(entry!.workflowName).toBe('Stored Run');
    expect(entry!.status).toBe('running');
  });

  it('sets sidebar title to workflow name and indicator to "..."', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Sidebar Check');
    const entry = registry.getRun(id);
    expect(entry!.sidebar.title).toBe('Sidebar Check');
    expect(entry!.sidebar.indicator).toBe('...');
  });

  it('sets startedAt to an ISO string', () => {
    const registry = new RunRegistry();
    const before = Date.now();
    const id = registry.createRun('Time Check');
    const after = Date.now();
    const entry = registry.getRun(id);
    const started = new Date(entry!.startedAt).getTime();
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
  });

  it('initialises currentPhase to empty string', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = registry.getRun(runId);
    expect(entry!.currentPhase).toBe('');
  });

  it('initialises completedPhases to empty array', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = registry.getRun(runId);
    expect(entry!.completedPhases).toEqual([]);
  });

  it('initialises agents to empty Map', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = registry.getRun(runId);
    expect(entry!.agents.size).toBe(0);
  });

  it('creates an AbortController', () => {
    const { registry, runId } = registryWithOneRun();
    const ctrl = registry.getAbortController(runId);
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(ctrl!.signal.aborted).toBe(false);
  });

  it('generates unique IDs for successive runs', () => {
    const registry = new RunRegistry();
    const id1 = registry.createRun('Run 1');
    const id2 = registry.createRun('Run 2');
    expect(id1).not.toBe(id2);
  });

  it('uses the provided id when options.id is given', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Custom ID Run', { id: 'my-custom-id' });
    expect(id).toBe('my-custom-id');
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('my-custom-id');
  });

  it('uses the provided startedAt when options.startedAt is given', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Timestamp Run', {
      startedAt: '2024-01-01T00:00:00Z',
    });
    const entry = registry.getRun(id);
    expect(entry!.startedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('combines both options.id and options.startedAt', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Combined Options', {
      id: 'combined-run-1',
      startedAt: '2023-06-15T12:30:00Z',
    });
    expect(id).toBe('combined-run-1');
    const entry = registry.getRun(id);
    expect(entry!.id).toBe('combined-run-1');
    expect(entry!.startedAt).toBe('2023-06-15T12:30:00Z');
  });

  it('falls back to UUID when options.id is omitted', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('No ID Option', { startedAt: '2024-01-01T00:00:00Z' });
    // Should be a UUID, not the startedAt string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('falls back to current timestamp when options.startedAt is omitted', () => {
    const registry = new RunRegistry();
    const before = Date.now();
    const id = registry.createRun('No Timestamp Option', { id: 'custom-id' });
    const after = Date.now();
    const entry = registry.getRun(id);
    const started = new Date(entry!.startedAt).getTime();
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
  });
});

// ─── completeRun ────────────────────────────────────────────────────────────

describe('completeRun', () => {
  it('sets status to completed', () => {
    const { registry, runId } = registryWithOneRun();
    registry.completeRun(runId);
    const entry = registry.getRun(runId);
    expect(entry!.status).toBe('completed');
  });

  it('sets completedAt to an ISO timestamp', () => {
    const { registry, runId } = registryWithOneRun();
    const before = Date.now();
    registry.completeRun(runId);
    const after = Date.now();
    const entry = registry.getRun(runId);
    expect(entry!.completedAt).toBeDefined();
    const completed = new Date(entry!.completedAt!).getTime();
    expect(completed).toBeGreaterThanOrEqual(before);
    expect(completed).toBeLessThanOrEqual(after);
  });

  it('returns a WorkflowSummary with status completed', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.completeRun(runId);
    expect(summary.id).toBe(runId);
    expect(summary.status).toBe('completed');
    expect(summary.completedAt).toBeDefined();
  });

  it('returns errorMessage as undefined for a completed run', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.completeRun(runId);
    expect(summary.errorMessage).toBeUndefined();
  });

  it('returns a summary with the correct workflowName', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.completeRun(runId);
    expect(summary.workflowName).toBe('Test Workflow');
  });

  it('returns a summary with the sidebar unchanged (aside from status)', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.completeRun(runId);
    expect(summary.sidebar.title).toBe('Test Workflow');
    expect(summary.sidebar.indicator).toBe('...');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.completeRun('nonexistent-id')).toThrow('nonexistent-id not found');
  });
});

// ─── failRun ────────────────────────────────────────────────────────────────

describe('failRun', () => {
  it('sets status to failed', () => {
    const { registry, runId } = registryWithOneRun();
    registry.failRun(runId, 'Something went wrong');
    const entry = registry.getRun(runId);
    expect(entry!.status).toBe('failed');
  });

  it('sets completedAt to an ISO timestamp', () => {
    const { registry, runId } = registryWithOneRun();
    const before = Date.now();
    registry.failRun(runId, 'err');
    const after = Date.now();
    const entry = registry.getRun(runId);
    expect(entry!.completedAt).toBeDefined();
    const completed = new Date(entry!.completedAt!).getTime();
    expect(completed).toBeGreaterThanOrEqual(before);
    expect(completed).toBeLessThanOrEqual(after);
  });

  it('returns a WorkflowSummary with status failed', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.failRun(runId, 'fail message');
    expect(summary.id).toBe(runId);
    expect(summary.status).toBe('failed');
    expect(summary.completedAt).toBeDefined();
  });

  it('stores the error message on the entry', () => {
    const { registry, runId } = registryWithOneRun();
    registry.failRun(runId, 'Something went wrong');
    const entry = registry.getRun(runId);
    expect(entry!.errorMessage).toBe('Something went wrong');
  });

  it('returns a summary with the errorMessage', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.failRun(runId, 'fail message');
    expect(summary.errorMessage).toBe('fail message');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.failRun('bad-id', 'error')).toThrow('bad-id not found');
  });
});

// ─── updateSidebar ──────────────────────────────────────────────────────────

describe('updateSidebar', () => {
  it('updates the title', () => {
    const { registry, runId } = registryWithOneRun();
    registry.updateSidebar(runId, { title: 'New Title' });
    const entry = registry.getRun(runId);
    expect(entry!.sidebar.title).toBe('New Title');
  });

  it('updates the indicator', () => {
    const { registry, runId } = registryWithOneRun();
    registry.updateSidebar(runId, { indicator: 'green' });
    const entry = registry.getRun(runId);
    expect(entry!.sidebar.indicator).toBe('green');
  });

  it('updates the phases', () => {
    const { registry, runId } = registryWithOneRun();
    const phases = [
      { id: 'plan', label: 'Plan', icon: '📋' },
      { id: 'exec', label: 'Execute', icon: '⚡' },
    ];
    registry.updateSidebar(runId, { phases });
    const entry = registry.getRun(runId);
    expect(entry!.sidebar.phases).toEqual(phases);
  });

  it('merges only provided fields', () => {
    const { registry, runId } = registryWithOneRun();
    registry.updateSidebar(runId, { title: 'Updated Only' });
    const entry = registry.getRun(runId);
    expect(entry!.sidebar.title).toBe('Updated Only');
    // indicator remains unchanged
    expect(entry!.sidebar.indicator).toBe('...');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.updateSidebar('missing', { title: 'nope' })).toThrow('missing not found');
  });
});

// ─── setPhase ───────────────────────────────────────────────────────────────

describe('setPhase', () => {
  it('sets currentPhase to the given phase', () => {
    const { registry, runId } = registryWithOneRun();
    registry.setPhase(runId, 'scouting');
    const entry = registry.getRun(runId);
    expect(entry!.currentPhase).toBe('scouting');
  });

  it('pushes previous currentPhase onto completedPhases', () => {
    const { registry, runId } = registryWithOneRun();
    registry.setPhase(runId, 'planning');
    registry.setPhase(runId, 'execution');
    const entry = registry.getRun(runId);
    expect(entry!.completedPhases).toEqual(['planning']);
    expect(entry!.currentPhase).toBe('execution');
  });

  it('accumulates multiple completed phases', () => {
    const { registry, runId } = registryWithOneRun();
    registry.setPhase(runId, 'a');
    registry.setPhase(runId, 'b');
    registry.setPhase(runId, 'c');
    const entry = registry.getRun(runId);
    expect(entry!.completedPhases).toEqual(['a', 'b']);
    expect(entry!.currentPhase).toBe('c');
  });

  it('does not push when currentPhase is empty', () => {
    const { registry, runId } = registryWithOneRun();
    registry.setPhase(runId, 'first');
    const entry = registry.getRun(runId);
    expect(entry!.completedPhases).toEqual([]);
    expect(entry!.currentPhase).toBe('first');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.setPhase('ghost', 'phase-x')).toThrow('ghost not found');
  });
});

// ─── addAgent / completeAgent / addAgentLogEntry ────────────────────────────

describe('addAgent', () => {
  it('stores an agent window state', () => {
    const { registry, runId } = registryWithOneRun();
    const agent = {
      agentId: 'agent-1',
      profile: 'coder',
      active: true,
      log: [],
    };
    registry.addAgent(runId, agent);
    const entry = registry.getRun(runId);
    expect(entry!.agents.get('agent-1')).toEqual(agent);
  });

  it('replaces an existing agent with the same ID', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'old',
      active: true,
      log: [],
    });
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'new',
      active: false,
      log: [],
    });
    const agent = registry.getRun(runId)!.agents.get('a1');
    expect(agent!.profile).toBe('new');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    const agent = {
      agentId: 'a1',
      profile: 's',
      active: true,
      log: [],
    };
    expect(() => registry.addAgent('bad-id', agent)).toThrow('bad-id not found');
  });
});

describe('completeAgent', () => {
  it('sets the agent as inactive', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'agent-x',
      profile: 'tester',
      active: true,
      log: [],
    });
    registry.completeAgent(runId, 'agent-x');
    const agent = registry.getRun(runId)!.agents.get('agent-x');
    expect(agent!.active).toBe(false);
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.completeAgent('bad', 'a1')).toThrow('bad not found');
  });

  it('throws if agent does not exist within the run', () => {
    const { registry, runId } = registryWithOneRun();
    expect(() => registry.completeAgent(runId, 'no-such-agent')).toThrow(
      `Agent no-such-agent not found in run ${runId}`,
    );
  });
});

describe('addAgentLogEntry', () => {
  it('appends a log entry to an existing agent', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'logger',
      active: true,
      log: [],
    });
    const entry = {
      id: 'log-1',
      timestamp: '2026-06-10T12:00:00Z',
      type: 'text' as const,
      content: 'hello',
    };
    registry.addAgentLogEntry(runId, 'a1', entry);
    const agent = registry.getRun(runId)!.agents.get('a1');
    expect(agent!.log).toHaveLength(1);
    expect(agent!.log[0]).toEqual(entry);
  });

  it('auto-creates an agent when it does not exist', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = {
      id: 'log-42',
      timestamp: '2026-06-10T13:00:00Z',
      type: 'thinking' as const,
      content: 'thinking...',
    };
    registry.addAgentLogEntry(runId, 'new-agent', entry);
    const agent = registry.getRun(runId)!.agents.get('new-agent');
    expect(agent).toBeDefined();
    expect(agent!.agentId).toBe('new-agent');
    expect(agent!.profile).toBe('');
    expect(agent!.active).toBe(true);
    expect(agent!.log).toEqual([entry]);
  });

  it('accumulates multiple log entries', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgentLogEntry(runId, 'a2', {
      id: 'l1',
      timestamp: '2026-06-10T12:00:00Z',
      type: 'text',
      content: 'first',
    });
    registry.addAgentLogEntry(runId, 'a2', {
      id: 'l2',
      timestamp: '2026-06-10T12:01:00Z',
      type: 'decision',
      content: 'go ahead',
    });
    const agent = registry.getRun(runId)!.agents.get('a2');
    expect(agent!.log).toHaveLength(2);
    expect(agent!.log[0].content).toBe('first');
    expect(agent!.log[1].content).toBe('go ahead');
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    const entry = {
      id: 'l1',
      timestamp: '2026-06-10T12:00:00Z',
      type: 'text' as const,
      content: 'nope',
    };
    expect(() => registry.addAgentLogEntry('missing', 'a1', entry)).toThrow('missing not found');
  });
});

// ─── getSummary ─────────────────────────────────────────────────────────────

describe('getSummary', () => {
  it('returns a WorkflowSummary for an existing run', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.getSummary(runId);
    expect(summary.id).toBe(runId);
    expect(summary.workflowName).toBe('Test Workflow');
    expect(summary.status).toBe('running');
    expect(summary.startedAt).toBeDefined();
  });

  it('reflects completed status after completeRun', () => {
    const { registry, runId } = registryWithOneRun();
    registry.completeRun(runId);
    const summary = registry.getSummary(runId);
    expect(summary.status).toBe('completed');
    expect(summary.completedAt).toBeDefined();
  });

  it('returns errorMessage as undefined for a running run', () => {
    const { registry, runId } = registryWithOneRun();
    const summary = registry.getSummary(runId);
    expect(summary.errorMessage).toBeUndefined();
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.getSummary('bogus')).toThrow('bogus not found');
  });
});

// ─── getAllSummaries ────────────────────────────────────────────────────────

describe('getAllSummaries', () => {
  it('returns an empty array when no runs exist', () => {
    const registry = new RunRegistry();
    expect(registry.getAllSummaries()).toEqual([]);
  });

  it('returns summaries in insertion order', () => {
    const registry = new RunRegistry();
    const id1 = registry.createRun('First');
    const id2 = registry.createRun('Second');
    const id3 = registry.createRun('Third');
    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(3);
    expect(summaries[0].id).toBe(id1);
    expect(summaries[1].id).toBe(id2);
    expect(summaries[2].id).toBe(id3);
  });

  it('includes completed runs', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Done Run');
    registry.completeRun(id);
    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('completed');
  });

  it('includes failed runs', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('Fail Run');
    registry.failRun(id, 'error');
    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('failed');
  });

  it('returns mixed-status runs in order', () => {
    const registry = new RunRegistry();
    const id1 = registry.createRun('Running');
    const id2 = registry.createRun('Will Complete');
    registry.completeRun(id2);
    const id3 = registry.createRun('Will Fail');
    registry.failRun(id3, 'oops');
    const summaries = registry.getAllSummaries();
    expect(summaries.map((s) => s.id)).toEqual([id1, id2, id3]);
    expect(summaries.map((s) => s.status)).toEqual(['running', 'completed', 'failed']);
  });

  it('each summary has correct workflowName', () => {
    const registry = new RunRegistry();
    registry.createRun('Alpha');
    registry.createRun('Beta');
    const names = registry.getAllSummaries().map((s) => s.workflowName);
    expect(names).toEqual(['Alpha', 'Beta']);
  });
});

// ─── getRun ─────────────────────────────────────────────────────────────────

describe('getRun', () => {
  it('returns the raw entry for an existing ID', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = registry.getRun(runId);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(runId);
  });

  it('returns undefined for a non-existent ID', () => {
    const registry = new RunRegistry();
    expect(registry.getRun('nowhere')).toBeUndefined();
  });

  it('exposes internal fields like agents and abortController', () => {
    const { registry, runId } = registryWithOneRun();
    const entry = registry.getRun(runId);
    expect(entry!.agents).toBeInstanceOf(Map);
    expect(entry!.abortController).toBeInstanceOf(AbortController);
  });
});

// ─── getAbortController ─────────────────────────────────────────────────────

describe('getAbortController', () => {
  it('returns the AbortController for an existing run', () => {
    const { registry, runId } = registryWithOneRun();
    const ctrl = registry.getAbortController(runId);
    expect(ctrl).toBeInstanceOf(AbortController);
  });

  it('returns undefined for a non-existent run', () => {
    const registry = new RunRegistry();
    expect(registry.getAbortController('nope')).toBeUndefined();
  });

  it('the controller can abort and is reflected', () => {
    const { registry, runId } = registryWithOneRun();
    const ctrl = registry.getAbortController(runId)!;
    expect(ctrl.signal.aborted).toBe(false);
    ctrl.abort();
    expect(ctrl.signal.aborted).toBe(true);
    // Re-fetch to confirm it's the same object
    const ctrl2 = registry.getAbortController(runId);
    expect(ctrl2!.signal.aborted).toBe(true);
  });
});
