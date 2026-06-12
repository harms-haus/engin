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
      phase: 'scouting',
      active: true,
      log: [],
    };
    registry.addAgent(runId, agent);
    const entry = registry.getRun(runId);
    expect(entry!.agents.get('agent-1')).toEqual(agent);
    expect(entry!.agents.get('agent-1')!.phase).toBe('scouting');
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

  it('stores agent with phase field', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'agent-phase',
      profile: 'planner',
      phase: 'planning',
      active: true,
      log: [],
    });
    const entry = registry.getRun(runId);
    const agent = entry!.agents.get('agent-phase');
    expect(agent).toBeDefined();
    expect(agent!.phase).toBe('planning');
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

// ─── createRun with agent lifecycle callbacks ────────────────────────────

describe('createRun – agent lifecycle callbacks', () => {
  it('accepts onAgentSpawned callback in options', () => {
    const registry = new RunRegistry();
    const onAgentSpawned = () => {};
    const id = registry.createRun('CB Workflow', { onAgentSpawned });
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
    // Entry should be created without error
  });

  it('accepts onAgentCompleted callback in options', () => {
    const registry = new RunRegistry();
    const onAgentCompleted = () => {};
    const id = registry.createRun('CB Workflow', { onAgentCompleted });
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
  });

  it('accepts both onAgentSpawned and onAgentCompleted callbacks', () => {
    const registry = new RunRegistry();
    const onAgentSpawned = () => {};
    const onAgentCompleted = () => {};
    const id = registry.createRun('CB Both', { onAgentSpawned, onAgentCompleted });
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
  });

  it('still works without any callback options (backward compatible)', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('No CB');
    expect(id).toBeDefined();
    const entry = registry.getRun(id);
    expect(entry).toBeDefined();
  });

  it('onAgentSpawned is called when addAgent is invoked with taskId', () => {
    const calls: { agentId: string; profile: string; phase: string; taskId?: string }[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Spawn CB', {
      onAgentSpawned: (info) => calls.push(info),
    });

    registry.addAgent(id, {
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'scouting',
      taskId: 'task-1',
      active: true,
      log: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('agent-1');
    expect(calls[0].profile).toBe('coder');
    expect(calls[0].phase).toBe('scouting');
    expect(calls[0].taskId).toBe('task-1');
  });

  it('onAgentSpawned is called with empty phase when agent has no phase', () => {
    const calls: { agentId: string; profile: string; phase: string; taskId?: string }[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Spawn No Phase', {
      onAgentSpawned: (info) => calls.push(info),
    });

    registry.addAgent(id, {
      agentId: 'agent-np',
      profile: 'reviewer',
      active: true,
      log: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].phase).toBe('');
    expect(calls[0].taskId).toBeUndefined();
  });

  it('onAgentSpawned is called with taskId from the agent state', () => {
    const calls: { agentId: string; profile: string; phase: string; taskId?: string }[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Spawn With TaskId', {
      onAgentSpawned: (info) => calls.push(info),
    });

    registry.addAgent(id, {
      agentId: 'agent-t',
      profile: 'coder',
      taskId: 'task-99',
      active: true,
      log: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe('task-99');
  });

  it('onAgentCompleted is called when completeAgent is invoked', () => {
    const calls: string[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Complete CB', {
      onAgentCompleted: (agentId) => calls.push(agentId),
    });

    registry.addAgent(id, {
      agentId: 'agent-c',
      profile: 'tester',
      active: true,
      log: [],
    });
    registry.completeAgent(id, 'agent-c');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('agent-c');
  });

  it('onAgentCompleted is called after agent is set to inactive', () => {
    const order: string[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Order CB', {
      onAgentCompleted: (agentId) => {
        // At the point the callback fires, the agent should already be inactive
        order.push(`callback:${agentId}`);
      },
    });

    registry.addAgent(id, {
      agentId: 'agent-order',
      profile: 'x',
      active: true,
      log: [],
    });
    registry.completeAgent(id, 'agent-order');

    expect(order).toEqual(['callback:agent-order']);
    // Verify agent is actually inactive
    const entry = registry.getRun(id)!;
    expect(entry.agents.get('agent-order')!.active).toBe(false);
  });

  it('onAgentCompleted receives correct agentId for multiple agents', () => {
    const calls: string[] = [];
    const registry = new RunRegistry();
    const id = registry.createRun('Multi Complete', {
      onAgentCompleted: (agentId) => calls.push(agentId),
    });

    registry.addAgent(id, { agentId: 'a1', profile: 'p', active: true, log: [] });
    registry.addAgent(id, { agentId: 'a2', profile: 'q', active: true, log: [] });
    registry.completeAgent(id, 'a2');
    registry.completeAgent(id, 'a1');

    expect(calls).toEqual(['a2', 'a1']);
  });

  it('does not call onAgentSpawned when no callback is provided', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('No Spawn CB');

    // Should not throw
    registry.addAgent(id, {
      agentId: 'agent-nocb',
      profile: 'p',
      active: true,
      log: [],
    });
  });

  it('does not call onAgentCompleted when no callback is provided', () => {
    const registry = new RunRegistry();
    const id = registry.createRun('No Complete CB');

    registry.addAgent(id, {
      agentId: 'agent-nocb',
      profile: 'p',
      active: true,
      log: [],
    });
    // Should not throw
    registry.completeAgent(id, 'agent-nocb');
  });
});

// ─── getAgentRecords ──────────────────────────────────────────────────────

describe('getAgentRecords', () => {
  it('returns empty array when no agents exist', () => {
    const { registry, runId } = registryWithOneRun();
    const records = registry.getAgentRecords(runId);
    expect(records).toEqual([]);
  });

  it('returns PersistedAgentRecord array for stored agents', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'scouting',
      taskId: 'task-1',
      active: true,
      log: [],
    });

    const records = registry.getAgentRecords(runId);
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe('agent-1');
    expect(records[0].profile).toBe('coder');
    expect(records[0].phase).toBe('scouting');
    expect(records[0].taskId).toBe('task-1');
  });

  it('returns multiple records for multiple agents', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'coder',
      phase: 'scouting',
      active: true,
      log: [],
    });
    registry.addAgent(runId, {
      agentId: 'a2',
      profile: 'reviewer',
      phase: 'planning',
      taskId: 't1',
      active: true,
      log: [],
    });

    const records = registry.getAgentRecords(runId);
    expect(records).toHaveLength(2);
    expect(records[0].agentId).toBe('a1');
    expect(records[1].agentId).toBe('a2');
  });

  it('returns a copy of the internal records array', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'p',
      active: true,
      log: [],
    });

    const records = registry.getAgentRecords(runId);
    records.push({ agentId: 'fake', profile: 'x', phase: '' });
    expect(registry.getAgentRecords(runId)).toHaveLength(1);
  });

  it('throws if run does not exist', () => {
    const registry = new RunRegistry();
    expect(() => registry.getAgentRecords('nonexistent')).toThrow('nonexistent not found');
  });

  it('excludes log entries from persisted records', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'p',
      active: true,
      log: [{ id: 'l1', timestamp: '2026-01-01', type: 'text', content: 'hi' }],
    });

    const records = registry.getAgentRecords(runId);
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe('a1');
    // PersistedAgentRecord should not contain log
    expect((records[0] as Record<string, unknown>).log).toBeUndefined();
  });

  it('reflects active status correctly', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'a1',
      profile: 'p',
      active: true,
      log: [],
    });

    // Before completing, there's no completedAt equivalent on PersistedAgentRecord
    const before = registry.getAgentRecords(runId);
    expect(before).toHaveLength(1);

    registry.completeAgent(runId, 'a1');

    const after = registry.getAgentRecords(runId);
    expect(after).toHaveLength(1);
    // The agent still appears in records
    expect(after[0].agentId).toBe('a1');
  });
});

// ─── pruneCompletedRuns ────────────────────────────────────────────────────

describe('pruneCompletedRuns', () => {
  /** Helper: create and immediately complete a run, returning the ID. */
  function createCompletedRun(registry: RunRegistry, name: string): string {
    const id = registry.createRun(name);
    registry.completeRun(id);
    return id;
  }

  /** Helper: create and immediately fail a run, returning the ID. */
  function createFailedRun(registry: RunRegistry, name: string): string {
    const id = registry.createRun(name);
    registry.failRun(id, 'error');
    return id;
  }

  it('returns 0 when there are no runs', () => {
    const registry = new RunRegistry();
    const pruned = registry.pruneCompletedRuns();
    expect(pruned).toBe(0);
  });

  it('returns 0 when non-running count is at most maxKeep', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(0);
    // All 20 should still be present
    expect(registry.getAllSummaries()).toHaveLength(20);
  });

  it('returns 0 when non-running count is less than maxKeep', () => {
    const registry = new RunRegistry();
    for (let i = 0; i < 10; i++) {
      createCompletedRun(registry, `Run ${i}`);
    }
    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(0);
    expect(registry.getAllSummaries()).toHaveLength(10);
  });

  it('prunes oldest completed runs to keep exactly maxKeep non-running entries', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    expect(registry.getAllSummaries()).toHaveLength(30);

    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(10);
    expect(registry.getAllSummaries()).toHaveLength(20);
  });

  it('removes the oldest entries and keeps the newest ones', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    registry.pruneCompletedRuns(20);

    const remaining = registry.getAllSummaries();
    expect(remaining).toHaveLength(20);
    // The newest 20 should remain (indices 10..29)
    const remainingNames = remaining.map((s) => s.workflowName);
    for (let i = 10; i < 30; i++) {
      expect(remainingNames).toContain(`Run ${i}`);
    }
    // The oldest 10 should be gone (indices 0..9)
    for (let i = 0; i < 10; i++) {
      expect(remainingNames).not.toContain(`Run ${i}`);
    }
  });

  it('deletes pruned entries from the runs map', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    registry.pruneCompletedRuns(20);

    // Oldest 10 should be gone from the map
    for (let i = 0; i < 10; i++) {
      expect(registry.getRun(ids[i])).toBeUndefined();
      expect(() => registry.getSummary(ids[i])).toThrow();
    }
    // Newest 20 should still be accessible
    for (let i = 10; i < 30; i++) {
      expect(registry.getRun(ids[i])).toBeDefined();
    }
  });

  it('defaults maxKeep to 20 when no argument is provided', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    // Call without argument – should behave like pruneCompletedRuns(20)
    const pruned = registry.pruneCompletedRuns();
    expect(pruned).toBe(10);
    expect(registry.getAllSummaries()).toHaveLength(20);
  });

  it('never prunes a running run', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];

    // Create 10 completed runs
    for (let i = 0; i < 10; i++) {
      ids.push(createCompletedRun(registry, `Completed ${i}`));
    }

    // Create a running run (leave it as running, don't complete it)
    const runningId = registry.createRun('Running Run');

    // Create 10 more completed runs
    for (let i = 10; i < 20; i++) {
      ids.push(createCompletedRun(registry, `Completed ${i}`));
    }

    // 20 completed + 1 running = 21 total, prune to maxKeep=10 non-running
    const pruned = registry.pruneCompletedRuns(10);
    expect(pruned).toBe(10);

    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(11); // 10 remaining completed + 1 running

    // The running run must survive
    expect(registry.getRun(runningId)).toBeDefined();
    expect(registry.getRun(runningId)!.status).toBe('running');
    const runningSummary = summaries.find((s) => s.id === runningId);
    expect(runningSummary).toBeDefined();
    expect(runningSummary!.status).toBe('running');
    expect(runningSummary!.workflowName).toBe('Running Run');
  });

  it('running run at the beginning is not pruned', () => {
    const registry = new RunRegistry();

    // Running run first (oldest)
    const runningId = registry.createRun('Oldest Running');

    // Then 30 completed runs
    for (let i = 0; i < 30; i++) {
      createCompletedRun(registry, `Completed ${i}`);
    }

    // 30 non-running, prune to 20
    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(10);

    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(21); // 20 completed + 1 running

    // The running run at the beginning survives
    expect(registry.getRun(runningId)).toBeDefined();
    expect(registry.getRun(runningId)!.status).toBe('running');
  });

  it('running run at the end is not pruned', () => {
    const registry = new RunRegistry();

    // 30 completed runs first
    for (let i = 0; i < 30; i++) {
      createCompletedRun(registry, `Completed ${i}`);
    }

    // Running run last (newest)
    const runningId = registry.createRun('Newest Running');

    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(10);

    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(21); // 20 completed + 1 running

    // The running run at the end survives
    expect(registry.getRun(runningId)).toBeDefined();
    expect(registry.getRun(runningId)!.status).toBe('running');
  });

  it('multiple running runs are all preserved', () => {
    const registry = new RunRegistry();
    const runningIds: string[] = [];

    for (let i = 0; i < 5; i++) {
      runningIds.push(registry.createRun(`Running ${i}`));
      // Add some completed runs between running ones
      for (let j = 0; j < 5; j++) {
        createCompletedRun(registry, `Completed ${i}-${j}`);
      }
    }

    // 25 completed + 5 running = 30 total, prune to maxKeep=10 non-running
    const pruned = registry.pruneCompletedRuns(10);
    expect(pruned).toBe(15); // 25 - 10 = 15 pruned

    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(15); // 10 completed + 5 running

    // All running runs survive
    for (const rid of runningIds) {
      expect(registry.getRun(rid)).toBeDefined();
      expect(registry.getRun(rid)!.status).toBe('running');
    }
  });

  it('preserves insertion order after pruning', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(createCompletedRun(registry, `Run ${i}`));
    }
    registry.pruneCompletedRuns(20);

    const summaries = registry.getAllSummaries();
    // The remaining IDs should be in the same relative order
    const remainingIds = summaries.map((s) => s.id);
    expect(remainingIds).toEqual(ids.slice(10));
  });

  it('handles failed runs the same as completed runs (both are non-running)', () => {
    const registry = new RunRegistry();
    const ids: string[] = [];

    // Mix of completed and failed runs
    for (let i = 0; i < 15; i++) {
      ids.push(createCompletedRun(registry, `Completed ${i}`));
    }
    for (let i = 0; i < 15; i++) {
      ids.push(createFailedRun(registry, `Failed ${i}`));
    }

    // 30 non-running, prune to 20
    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(10);
    expect(registry.getAllSummaries()).toHaveLength(20);

    // Oldest 10 should be gone
    for (let i = 0; i < 10; i++) {
      expect(registry.getRun(ids[i])).toBeUndefined();
    }
    // Newest 20 should remain
    for (let i = 10; i < 30; i++) {
      expect(registry.getRun(ids[i])).toBeDefined();
    }
  });

  it('works with maxKeep=0, pruning all non-running entries', () => {
    const registry = new RunRegistry();
    const completedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      completedIds.push(createCompletedRun(registry, `Completed ${i}`));
    }
    const runningId = registry.createRun('Still Running');

    const pruned = registry.pruneCompletedRuns(0);
    expect(pruned).toBe(5);

    const summaries = registry.getAllSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(runningId);
    expect(summaries[0].status).toBe('running');
  });

  it('works with maxKeep=0 when all runs are running (nothing to prune)', () => {
    const registry = new RunRegistry();
    for (let i = 0; i < 5; i++) {
      registry.createRun(`Running ${i}`);
    }
    const pruned = registry.pruneCompletedRuns(0);
    expect(pruned).toBe(0);
    expect(registry.getAllSummaries()).toHaveLength(5);
  });

  it('can be called multiple times idempotently', () => {
    const registry = new RunRegistry();
    for (let i = 0; i < 30; i++) {
      createCompletedRun(registry, `Run ${i}`);
    }

    const pruned1 = registry.pruneCompletedRuns(20);
    expect(pruned1).toBe(10);
    expect(registry.getAllSummaries()).toHaveLength(20);

    const pruned2 = registry.pruneCompletedRuns(20);
    expect(pruned2).toBe(0);
    expect(registry.getAllSummaries()).toHaveLength(20);
  });

  it('prunes correctly after new runs are added post-prune', () => {
    const registry = new RunRegistry();
    for (let i = 0; i < 25; i++) {
      createCompletedRun(registry, `Run ${i}`);
    }
    registry.pruneCompletedRuns(20);
    expect(registry.getAllSummaries()).toHaveLength(20);

    // Add 10 more completed runs
    for (let i = 25; i < 35; i++) {
      createCompletedRun(registry, `Run ${i}`);
    }
    expect(registry.getAllSummaries()).toHaveLength(30);

    const pruned = registry.pruneCompletedRuns(20);
    expect(pruned).toBe(10);
    expect(registry.getAllSummaries()).toHaveLength(20);

    // The remaining should be the newest 20 (Run 15..34)
    const names = registry.getAllSummaries().map((s) => s.workflowName);
    for (let i = 15; i < 35; i++) {
      expect(names).toContain(`Run ${i}`);
    }
  });
});

// ─── Composite Map key for agent deduplication ───────────────────────────

describe('composite key – same agentId different taskIds', () => {
  it('stores agents with same agentId but different taskIds separately', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T1',
      active: true,
      log: [],
    });
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T2',
      active: true,
      log: [],
    });

    const entry = registry.getRun(runId)!;
    // Should have two distinct agent entries, not one overwritten
    expect(entry.agents.size).toBe(2);
  });

  it('completeAgent with taskId only completes the matching agent', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T1',
      active: true,
      log: [],
    });
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T2',
      active: true,
      log: [],
    });

    // Complete only the T1 agent using the new taskId parameter
    registry.completeAgent(runId, 'lane-0', 'T1');

    const entry = registry.getRun(runId)!;
    // Both entries should still exist
    expect(entry.agents.size).toBe(2);

    // Find the agents by iterating (we can't use .get with composite key yet)
    const agents = Array.from(entry.agents.values());
    const t1Agent = agents.find((a) => a.taskId === 'T1');
    const t2Agent = agents.find((a) => a.taskId === 'T2');
    expect(t1Agent).toBeDefined();
    expect(t2Agent).toBeDefined();

    // T1 should be inactive, T2 should still be active
    expect(t1Agent!.active).toBe(false);
    expect(t2Agent!.active).toBe(true);
  });

  it('addAgentLogEntry with taskId routes logs to correct agent', () => {
    const { registry, runId } = registryWithOneRun();
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T1',
      active: true,
      log: [],
    });
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T2',
      active: true,
      log: [],
    });

    // Add logs to each agent using the new taskId parameter
    registry.addAgentLogEntry(
      runId,
      'lane-0',
      { id: 'log-t1', timestamp: '2026-06-11T00:00:00Z', type: 'text', content: 'log for T1' },
      'T1',
    );
    registry.addAgentLogEntry(
      runId,
      'lane-0',
      { id: 'log-t2', timestamp: '2026-06-11T00:00:01Z', type: 'text', content: 'log for T2' },
      'T2',
    );

    const entry = registry.getRun(runId)!;
    const agents = Array.from(entry.agents.values());
    const t1Agent = agents.find((a) => a.taskId === 'T1');
    const t2Agent = agents.find((a) => a.taskId === 'T2');

    expect(t1Agent).toBeDefined();
    expect(t2Agent).toBeDefined();

    // Each agent should only have its own log entry
    expect(t1Agent!.log).toHaveLength(1);
    expect(t1Agent!.log[0].content).toBe('log for T1');
    expect(t2Agent!.log).toHaveLength(1);
    expect(t2Agent!.log[0].content).toBe('log for T2');
  });

  it('agent without taskId does not collide with agent with taskId', () => {
    const { registry, runId } = registryWithOneRun();
    // Agent without taskId
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'reviewer',
      phase: 'review',
      active: true,
      log: [{ id: 'l1', timestamp: '2026-06-11T00:00:00Z', type: 'text', content: 'no-task' }],
    });
    // Agent with taskId
    registry.addAgent(runId, {
      agentId: 'lane-0',
      profile: 'coder',
      phase: 'implementing',
      taskId: 'T1',
      active: true,
      log: [{ id: 'l2', timestamp: '2026-06-11T00:00:00Z', type: 'text', content: 'has-task' }],
    });

    const entry = registry.getRun(runId)!;
    // Both should exist as separate entries
    expect(entry.agents.size).toBe(2);

    const agents = Array.from(entry.agents.values());
    const withoutTask = agents.find((a) => a.taskId === undefined);
    const withTask = agents.find((a) => a.taskId === 'T1');
    expect(withoutTask).toBeDefined();
    expect(withTask).toBeDefined();
    expect(withoutTask!.log[0].content).toBe('no-task');
    expect(withTask!.log[0].content).toBe('has-task');
  });
});
