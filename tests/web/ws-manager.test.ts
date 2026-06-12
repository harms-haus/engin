import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ClientMessage, ServerMessage } from '../../src/web/types.js';
import type { ClientMessageHandlers } from '../../src/web/ws-manager.js';
import { WebSocketManager } from '../../src/web/ws-manager.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a mock Bun.ServerWebSocket with a trackable send() method.
 *
 * Bun.ServerWebSocket is not constructable from user code, so we create
 * a minimal mock that satisfies the `send(data: string)` contract used
 * by WebSocketManager.
 */
function createMockWs(sendImpl?: (data: string) => void) {
  const sent: string[] = [];
  const ws = {
    send: sendImpl ?? ((data: string) => sent.push(data)),
  } as unknown as Bun.ServerWebSocket & { _sent: string[] };
  // Attach _sent for test assertions via a non-enumerable approach
  Object.defineProperty(ws, '_sent', { value: sent, writable: false, configurable: true });
  return ws;
}

/** Create a minimal init ServerMessage for testing addClient. */
function makeInitMsg(): ServerMessage {
  return { type: 'init', workflows: [] };
}

/** Helper to create a start_workflow ClientMessage JSON string. */
function startWorkflowJson(opts: { workflowName?: string; taskPrompt?: string; maxConcurrent?: number } = {}) {
  return JSON.stringify({
    type: 'start_workflow',
    workflowName: opts.workflowName ?? 'test-workflow',
    taskPrompt: opts.taskPrompt ?? 'do something',
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
  });
}

/** Helper to create a select_workflow ClientMessage JSON string. */
function selectWorkflowJson(workflowId = 'run-123') {
  return JSON.stringify({ type: 'select_workflow', workflowId });
}

/** Helper to create a cancel_workflow ClientMessage JSON string. */
function cancelWorkflowJson(workflowId = 'run-456') {
  return JSON.stringify({ type: 'cancel_workflow', workflowId });
}

/**
 * Build a default ClientMessageHandlers with trackable mock functions.
 *
 * The onSelectWorkflow handler receives (msg, ws) per the adjusted interface
 * where ws is forwarded from handleMessage's third parameter.
 */
function createMockHandlers() {
  const onStartWorkflow = mock<(msg: Extract<ClientMessage, { type: 'start_workflow' }>) => void>();
  const onSelectWorkflow =
    mock<
      (msg: Extract<ClientMessage, { type: 'select_workflow' }>, ws: Bun.ServerWebSocket) => Promise<void>
    >().mockResolvedValue(undefined);
  const onCancelWorkflow = mock<(msg: Extract<ClientMessage, { type: 'cancel_workflow' }>) => void>();

  return {
    onStartWorkflow,
    onSelectWorkflow,
    onCancelWorkflow,
  } satisfies ClientMessageHandlers;
}

/** Type alias so we don't have to write Extract<...> everywhere. */
type StartWorkflowMsg = Extract<ClientMessage, { type: 'start_workflow' }>;
type SelectWorkflowMsg = Extract<ClientMessage, { type: 'select_workflow' }>;
type CancelWorkflowMsg = Extract<ClientMessage, { type: 'cancel_workflow' }>;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WebSocketManager', () => {
  let manager: WebSocketManager;

  afterEach(() => {
    // Reset to a fresh instance after each test for safety.
    // Each test creates its own manager, but this ensures cleanup
    // if a test ever forgets.
    manager = undefined as any;
  });

  // ─── addClient ──────────────────────────────────────────────────────────

  describe('addClient', () => {
    it('adds a client and immediately sends the init message via ws.send', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      const msg: ServerMessage = { type: 'init', workflows: [] };

      manager.addClient(ws, msg);

      // The ws should have received exactly one message: the init
      const sent = (ws as any)._sent as string[];
      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe('init');
      expect(parsed.workflows).toEqual([]);
    });

    it('sends the exact initMessage passed, serialized as JSON', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      const msg: ServerMessage = {
        type: 'init',
        workflows: [
          {
            id: 'run-1',
            workflowName: 'develop',
            status: 'completed',
            sidebar: { title: 'develop', indicator: 'done' },
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
      };

      manager.addClient(ws, msg);

      const sent = (ws as any)._sent as string[];
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0])).toEqual(msg);
    });

    it('adds multiple clients and each receives its own init message', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addClient(ws1, makeInitMsg());
      manager.addClient(ws2, makeInitMsg());

      expect((ws1 as any)._sent as string[]).toHaveLength(1);
      expect((ws2 as any)._sent as string[]).toHaveLength(1);
    });

    it('client added via addClient receives subsequent broadcasts', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();

      manager.addClient(ws, makeInitMsg());

      // Clear init message to isolate broadcast
      ((ws as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_started', summary: {} as any });

      expect((ws as any)._sent as string[]).toHaveLength(1);
    });

    it('does not send init message to other existing clients', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addClient(ws1, makeInitMsg());

      // Clear ws1's sent after first add
      ((ws1 as any)._sent as string[]).length = 0;

      // Add second client – ws1 should NOT get another init
      manager.addClient(ws2, makeInitMsg());

      expect((ws1 as any)._sent as string[]).toHaveLength(0);
      expect((ws2 as any)._sent as string[]).toHaveLength(1);
    });

    it('sending same ws twice still sends init each time (Set dedup on clients)', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();

      manager.addClient(ws, makeInitMsg());
      manager.addClient(ws, {
        type: 'init',
        workflows: [
          {
            id: 'r1',
            workflowName: 'w',
            status: 'completed',
            sidebar: { title: 'w', indicator: 'done' },
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      // Set deduplicates the ws, but addClient sends init each call
      const sent = (ws as any)._sent as string[];
      expect(sent).toHaveLength(2);
      expect(JSON.parse(sent[0]).type).toBe('init');
      expect(JSON.parse(sent[1]).type).toBe('init');
      // Second message should have the second init's workflows
      expect(JSON.parse(sent[1]).workflows).toHaveLength(1);
    });
  });

  // ─── removeClient ───────────────────────────────────────────────────────

  describe('removeClient', () => {
    it('removes a previously added client', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());

      expect(() => manager.removeClient(ws)).not.toThrow();
    });

    it('removed client no longer receives broadcasts', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addClient(ws1, makeInitMsg());
      manager.addClient(ws2, makeInitMsg());

      manager.removeClient(ws1);

      // Clear any prior messages
      ((ws1 as any)._sent as string[]).length = 0;
      ((ws2 as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_started', summary: {} as any });

      // ws1 was removed – should not receive
      expect((ws1 as any)._sent as string[]).toHaveLength(0);
      // ws2 is still connected – should receive
      expect((ws2 as any)._sent as string[]).toHaveLength(1);
    });

    it('does not throw when removing a client that was never added', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      expect(() => manager.removeClient(ws)).not.toThrow();
    });

    it('does not throw when removing the same client twice', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());
      manager.removeClient(ws);
      expect(() => manager.removeClient(ws)).not.toThrow();
    });

    it('removing all clients leaves an empty set for broadcast', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addClient(ws1, makeInitMsg());
      manager.addClient(ws2, makeInitMsg());

      manager.removeClient(ws1);
      manager.removeClient(ws2);

      expect(() => manager.broadcast({ type: 'workflow_started', summary: {} as any })).not.toThrow();
    });
  });

  // ─── broadcast ──────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('sends a serialized message to all connected clients', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const ws3 = createMockWs();

      manager.addClient(ws1, makeInitMsg());
      manager.addClient(ws2, makeInitMsg());
      manager.addClient(ws3, makeInitMsg());

      // Clear init messages
      for (const ws of [ws1, ws2, ws3]) {
        ((ws as any)._sent as string[]).length = 0;
      }

      const msg: ServerMessage = { type: 'workflow_complete', summary: { id: 'r1', status: 'completed' } as any };
      manager.broadcast(msg);

      for (const ws of [ws1, ws2, ws3]) {
        const sent = (ws as any)._sent as string[];
        expect(sent).toHaveLength(1);
        const parsed = JSON.parse(sent[0]);
        expect(parsed.type).toBe('workflow_complete');
      }
    });

    it('does not send to any clients when no clients are connected', () => {
      manager = new WebSocketManager();
      expect(() => manager.broadcast({ type: 'workflow_started', summary: {} as any })).not.toThrow();
    });

    it('handles a single client correctly', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());
      ((ws as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_started', summary: { id: 'abc' } as any });

      const sent = (ws as any)._sent as string[];
      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe('workflow_started');
      expect(parsed.summary.id).toBe('abc');
    });

    it('logs warning and removes client when send throws', () => {
      manager = new WebSocketManager();
      const warnSpy = mock<(...args: unknown[]) => void>();
      const originalWarn = console.warn;
      console.warn = warnSpy;

      const goodWs = createMockWs();
      const badWs = createMockWs(() => {
        throw new Error('Connection reset');
      });

      manager.addClient(goodWs, makeInitMsg());
      manager.addClient(badWs, makeInitMsg());

      // Clear init messages
      ((goodWs as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_started', summary: {} as any });

      console.warn = originalWarn;

      // Good client should still receive the broadcast
      expect((goodWs as any)._sent as string[]).toHaveLength(1);

      // Warning should have been logged for the failing send
      expect(warnSpy).toHaveBeenCalled();
    });

    it('removes failing client so subsequent broadcasts only hit healthy clients', () => {
      manager = new WebSocketManager();
      const goodWs = createMockWs();
      const badWs = createMockWs(() => {
        throw new Error('Broken pipe');
      });

      manager.addClient(goodWs, makeInitMsg());
      manager.addClient(badWs, makeInitMsg());

      // First broadcast: badWs throws and gets removed
      const originalWarn = console.warn;
      console.warn = () => {};
      manager.broadcast({ type: 'workflow_started', summary: {} as any });
      console.warn = originalWarn;

      // Second broadcast: only goodWs should receive
      ((goodWs as any)._sent as string[]).length = 0;
      manager.broadcast({ type: 'workflow_complete', summary: {} as any });
      expect((goodWs as any)._sent as string[]).toHaveLength(1);
    });

    it('handles all clients throwing on send without crashing', () => {
      manager = new WebSocketManager();
      const bad1 = createMockWs(() => {
        throw new Error('fail 1');
      });
      const bad2 = createMockWs(() => {
        throw new Error('fail 2');
      });

      manager.addClient(bad1, makeInitMsg());
      manager.addClient(bad2, makeInitMsg());

      const originalWarn = console.warn;
      console.warn = () => {};
      expect(() => manager.broadcast({ type: 'test' } as any)).not.toThrow();
      console.warn = originalWarn;

      // All clients removed – subsequent broadcast is a no-op
      expect(() => manager.broadcast({ type: 'test2' } as any)).not.toThrow();
    });

    it('serializes message with JSON.stringify before sending', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());
      ((ws as any)._sent as string[]).length = 0;

      const msg: ServerMessage = {
        type: 'workflow_failed',
        summary: { id: 'r1', status: 'failed' } as any,
        error: 'Something went wrong',
        phase: 'execution',
      };
      manager.broadcast(msg);

      const sent = (ws as any)._sent as string[];
      expect(sent[0]).toBe(JSON.stringify(msg));
    });

    it('client that fails on first broadcast is not sent to on second broadcast', () => {
      manager = new WebSocketManager();
      let callCount = 0;
      const ws = createMockWs(() => {
        callCount++;
        throw new Error('send fails');
      });

      manager.addClient(ws, makeInitMsg());

      const originalWarn = console.warn;
      console.warn = () => {};
      manager.broadcast({ type: 'msg1' } as any);
      console.warn = originalWarn;

      // ws was removed; a second broadcast should not attempt to send to ws
      callCount = 0;
      manager.broadcast({ type: 'msg2' } as any);
      expect(callCount).toBe(0);
    });

    it('handles mixed healthy and failing clients in a single broadcast', () => {
      manager = new WebSocketManager();
      const healthy1 = createMockWs();
      const failing = createMockWs(() => {
        throw new Error('socket closed');
      });
      const healthy2 = createMockWs();

      manager.addClient(healthy1, makeInitMsg());
      manager.addClient(failing, makeInitMsg());
      manager.addClient(healthy2, makeInitMsg());

      // Clear init
      for (const ws of [healthy1, failing, healthy2]) {
        ((ws as any)._sent as string[]).length = 0;
      }

      const originalWarn = console.warn;
      console.warn = () => {};
      manager.broadcast({ type: 'workflow_started', summary: { id: 'x' } as any });
      console.warn = originalWarn;

      // Both healthy clients should receive the broadcast
      expect((healthy1 as any)._sent as string[]).toHaveLength(1);
      expect((healthy2 as any)._sent as string[]).toHaveLength(1);

      // Verify the message content is correct
      const parsed1 = JSON.parse(((healthy1 as any)._sent as string[])[0]);
      expect(parsed1.type).toBe('workflow_started');
    });
  });

  // ─── handleMessage ──────────────────────────────────────────────────────

  describe('handleMessage', () => {
    it('calls onStartWorkflow handler for start_workflow message', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(startWorkflowJson({ workflowName: 'my-flow', taskPrompt: 'prompt' }), handlers, ws);

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      const msg = handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg;
      expect(msg.type).toBe('start_workflow');
      expect(msg.workflowName).toBe('my-flow');
      expect(msg.taskPrompt).toBe('prompt');
    });

    it('passes maxConcurrent to onStartWorkflow when present', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(startWorkflowJson({ maxConcurrent: 5 }), handlers, ws);

      const msg = handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg;
      expect(msg.maxConcurrent).toBe(5);
    });

    it('does not pass maxConcurrent when absent', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(startWorkflowJson(), handlers, ws);

      const msg = handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg;
      expect(msg.maxConcurrent).toBeUndefined();
    });

    it('calls onSelectWorkflow handler for select_workflow message with ws forwarded', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson('run-abc'), handlers, ws);

      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
      const msg = handlers.onSelectWorkflow.mock.calls[0][0] as SelectWorkflowMsg;
      expect(msg.type).toBe('select_workflow');
      expect(msg.workflowId).toBe('run-abc');
    });

    it('passes the ws parameter to onSelectWorkflow as the second argument', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson('run-ws-test'), handlers, ws);

      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
      // The second argument to onSelectWorkflow should be the ws object
      const receivedWs = handlers.onSelectWorkflow.mock.calls[0][1] as Bun.ServerWebSocket;
      expect(receivedWs).toBe(ws);
    });

    it('onSelectWorkflow receives the exact ws instance that was passed to handleMessage', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();

      // Create two distinct ws instances
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      // Send select_workflow with ws1
      manager.handleMessage(selectWorkflowJson('run-a'), handlers, ws1);
      // Send select_workflow with ws2
      manager.handleMessage(selectWorkflowJson('run-b'), handlers, ws2);

      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(2);

      // First call should have received ws1
      const firstWs = handlers.onSelectWorkflow.mock.calls[0][1] as Bun.ServerWebSocket;
      expect(firstWs).toBe(ws1);

      // Second call should have received ws2
      const secondWs = handlers.onSelectWorkflow.mock.calls[1][1] as Bun.ServerWebSocket;
      expect(secondWs).toBe(ws2);
    });

    it('calls onCancelWorkflow handler for cancel_workflow message', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(cancelWorkflowJson('run-789'), handlers, ws);

      expect(handlers.onCancelWorkflow).toHaveBeenCalledTimes(1);
      const msg = handlers.onCancelWorkflow.mock.calls[0][0] as CancelWorkflowMsg;
      expect(msg.type).toBe('cancel_workflow');
      expect(msg.workflowId).toBe('run-789');
    });

    it('returns silently on invalid JSON without calling any handler', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage('not valid json {{{', handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
      expect(handlers.onSelectWorkflow).not.toHaveBeenCalled();
      expect(handlers.onCancelWorkflow).not.toHaveBeenCalled();
    });

    it('returns silently on empty string', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage('', handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
    });

    it('returns silently when JSON is valid but missing type field', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(JSON.stringify({ foo: 'bar' }), handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
      expect(handlers.onSelectWorkflow).not.toHaveBeenCalled();
      expect(handlers.onCancelWorkflow).not.toHaveBeenCalled();
    });

    it('returns silently for unknown message type', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(JSON.stringify({ type: 'unknown_type' }), handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
      expect(handlers.onSelectWorkflow).not.toHaveBeenCalled();
      expect(handlers.onCancelWorkflow).not.toHaveBeenCalled();
    });

    it('handles Buffer input by converting to string', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      const buf = Buffer.from(startWorkflowJson({ workflowName: 'buf-test' }));
      manager.handleMessage(buf, handlers, ws);

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      expect((handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg).workflowName).toBe('buf-test');
    });

    it('handles Buffer input with cancel_workflow message', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      const buf = Buffer.from(cancelWorkflowJson('run-u8'));
      manager.handleMessage(buf, handlers, ws);

      expect(handlers.onCancelWorkflow).toHaveBeenCalledTimes(1);
      expect((handlers.onCancelWorkflow.mock.calls[0][0] as CancelWorkflowMsg).workflowId).toBe('run-u8');
    });

    it('catches and logs errors from async onSelectWorkflow handler', async () => {
      manager = new WebSocketManager();
      const errorSpy = mock<(...args: unknown[]) => void>();
      const originalError = console.error;
      console.error = errorSpy;

      const handlers = createMockHandlers();
      handlers.onSelectWorkflow = mock().mockRejectedValue(new Error('Past run load failed'));
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson('run-err'), handlers, ws);

      // Give the microtask queue a chance to run the async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      console.error = originalError;

      expect(errorSpy).toHaveBeenCalled();
    });

    it('catches and logs non-Error rejections from onSelectWorkflow', async () => {
      manager = new WebSocketManager();
      const errorSpy = mock<(...args: unknown[]) => void>();
      const originalError = console.error;
      console.error = errorSpy;

      const handlers = createMockHandlers();
      handlers.onSelectWorkflow = mock().mockRejectedValue('string error');
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson('run-str-err'), handlers, ws);

      await new Promise((resolve) => setTimeout(resolve, 10));

      console.error = originalError;

      expect(errorSpy).toHaveBeenCalled();
    });

    it('does not call other handlers when start_workflow is received', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(startWorkflowJson(), handlers, ws);

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      expect(handlers.onSelectWorkflow).not.toHaveBeenCalled();
      expect(handlers.onCancelWorkflow).not.toHaveBeenCalled();
    });

    it('does not call other handlers when select_workflow is received', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson(), handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
      expect(handlers.onCancelWorkflow).not.toHaveBeenCalled();
    });

    it('does not call other handlers when cancel_workflow is received', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(cancelWorkflowJson(), handlers, ws);

      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
      expect(handlers.onSelectWorkflow).not.toHaveBeenCalled();
      expect(handlers.onCancelWorkflow).toHaveBeenCalledTimes(1);
    });

    it('dispatches correctly for sequential messages', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(startWorkflowJson(), handlers, ws);
      manager.handleMessage(cancelWorkflowJson(), handlers, ws);
      manager.handleMessage(selectWorkflowJson(), handlers, ws);

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      expect(handlers.onCancelWorkflow).toHaveBeenCalledTimes(1);
      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
    });

    it('ignores extra unknown properties in a valid message', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      // Simulate a forward-compatible client sending extra fields
      manager.handleMessage(
        JSON.stringify({ type: 'start_workflow', workflowName: 'wf', taskPrompt: 'p', futureField: 'ignored' }),
        handlers,
        ws,
      );

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      const msg = handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg;
      expect(msg.workflowName).toBe('wf');
      expect(msg.taskPrompt).toBe('p');
    });

    it('onSelectWorkflow resolving normally does not log errors', async () => {
      manager = new WebSocketManager();
      const errorSpy = mock<(...args: unknown[]) => void>();
      const originalError = console.error;
      console.error = errorSpy;

      const handlers = createMockHandlers();
      // Default mock already resolves with undefined
      const ws = createMockWs();

      manager.handleMessage(selectWorkflowJson('run-ok'), handlers, ws);

      // Allow microtask queue to flush
      await new Promise((resolve) => setTimeout(resolve, 10));

      console.error = originalError;

      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Integration-style: full client lifecycle ──────────────────────────

  describe('client lifecycle integration', () => {
    it('full lifecycle: add -> broadcast -> remove -> broadcast', () => {
      manager = new WebSocketManager();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addClient(ws1, makeInitMsg());
      manager.addClient(ws2, makeInitMsg());

      // Clear init messages
      ((ws1 as any)._sent as string[]).length = 0;
      ((ws2 as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_started', summary: { id: 'r1' } as any });

      expect((ws1 as any)._sent as string[]).toHaveLength(1);
      expect((ws2 as any)._sent as string[]).toHaveLength(1);

      // Clear ws1's sent messages after first broadcast to test that second broadcast doesn't send to it
      ((ws1 as any)._sent as string[]).length = 0;

      manager.removeClient(ws1);

      ((ws2 as any)._sent as string[]).length = 0;

      manager.broadcast({ type: 'workflow_complete', summary: { id: 'r1' } as any });

      // ws1 removed – should have no new messages
      expect((ws1 as any)._sent as string[]).toHaveLength(0);
      // ws2 still connected
      expect((ws2 as any)._sent as string[]).toHaveLength(1);
    });

    it('broadcast after all clients removed is a no-op', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();

      manager.addClient(ws, makeInitMsg());
      manager.removeClient(ws);

      expect(() => manager.broadcast({ type: 'workflow_started', summary: {} as any })).not.toThrow();
    });

    it('add -> handleMessage with start_workflow -> handler fires', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());

      const handlers = createMockHandlers();
      manager.handleMessage(startWorkflowJson({ workflowName: 'lifecycle-test' }), handlers, ws);

      expect(handlers.onStartWorkflow).toHaveBeenCalledTimes(1);
      expect((handlers.onStartWorkflow.mock.calls[0][0] as StartWorkflowMsg).workflowName).toBe('lifecycle-test');
    });

    it('add -> handleMessage with select_workflow -> handler fires with ws', () => {
      manager = new WebSocketManager();
      const ws = createMockWs();
      manager.addClient(ws, makeInitMsg());

      const handlers = createMockHandlers();
      manager.handleMessage(selectWorkflowJson('lifecycle-sel'), handlers, ws);

      expect(handlers.onSelectWorkflow).toHaveBeenCalledTimes(1);
      expect((handlers.onSelectWorkflow.mock.calls[0][0] as SelectWorkflowMsg).workflowId).toBe('lifecycle-sel');
      // ws is forwarded as the second argument
      expect(handlers.onSelectWorkflow.mock.calls[0][1]).toBe(ws);
    });
  });

  // ─── Message parsing robustness ─────────────────────────────────────────

  describe('message parsing robustness', () => {
    it('handles JSON null without calling handlers', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      expect(() => manager.handleMessage('null', handlers, ws)).not.toThrow();
      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
    });

    it('handles JSON numeric value without calling handlers', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      expect(() => manager.handleMessage('42', handlers, ws)).not.toThrow();
    });

    it('handles JSON array without calling handlers', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      expect(() => manager.handleMessage('[1,2,3]', handlers, ws)).not.toThrow();
    });

    it('handles deeply nested JSON without type field', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      expect(() => manager.handleMessage('{"data":{"nested":true}}', handlers, ws)).not.toThrow();
      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
    });

    it('handles message with wrong casing on type field', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      manager.handleMessage(JSON.stringify({ type: 'Start_Workflow' }), handlers, ws);
      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
    });

    it('handles boolean JSON value', () => {
      manager = new WebSocketManager();
      const handlers = createMockHandlers();
      const ws = createMockWs();

      expect(() => manager.handleMessage('true', handlers, ws)).not.toThrow();
      expect(handlers.onStartWorkflow).not.toHaveBeenCalled();
    });
  });
});
