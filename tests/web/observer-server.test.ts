import { afterAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startObserverServer, type ObserverServer } from '../../src/web/observer-server.ts';
import type { ServerMessage } from '../../src/web/protocol-types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wait for the WebSocket connection to open.
 */
function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for open')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error during open'));
    });
  });
}

/**
 * Wait for a single JSON message from a WebSocket.
 */
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    ws.addEventListener('message', (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(event.data as string));
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error'));
    });
  });
}

/**
 * Create a WebSocket, wait for open, then return the ws and a promise for its
 * first JSON message.
 *
 * NOTE: because the snapshot is sent synchronously in the server's `open`
 * handler, we register the message listener *before* waiting for open.  This
 * avoids the race between open and the snapshot arrival.
 */
function connectAndGetFirstMessage(url: string, timeoutMs = 3000): { ws: WebSocket; firstMessage: Promise<unknown> } {
  const ws = new WebSocket(url);

  const firstMessage = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for first message')), timeoutMs);
    // Register message listener immediately – the snapshot may arrive
    // before or after the open event, so we listen from the start.
    ws.addEventListener('message', function handler(event) {
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      resolve(JSON.parse(event.data as string));
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error'));
    });
  });

  return { ws, firstMessage };
}

/**
 * Pick a random high port for testing.
 */
function randomPort(): number {
  return 18000 + Math.floor(Math.random() * 2000);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('observer-server', () => {
  let server: ObserverServer | undefined;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('starts and can be stopped', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: randomPort(),
    });
    expect(server.server).toBeDefined();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof server.broadcast).toBe('function');
    expect(typeof server.stop).toBe('function');

    await server.stop();
    server = undefined;
  });

  it('sends snapshot on WebSocket connection', async () => {
    const getSnapshot = mock(() => ({
      type: 'init' as const,
      currentPhase: 'scouting',
      completedPhases: ['setup'],
      tasks: [{ id: 't1', title: 'Task 1', status: 'done' }],
      agents: [{ agentId: 'a1', profile: 'scout', active: false, log: [] }],
      sidebar: { title: 'Test', indicator: '🟢' },
    }));

    const port = randomPort();
    server = await startObserverServer({
      host: '127.0.0.1',
      port,
      getSnapshot,
    });

    const { ws, firstMessage } = connectAndGetFirstMessage(`ws://127.0.0.1:${port}/ws`);
    try {
      const msg = (await firstMessage) as any;
      expect(msg.type).toBe('init');
      expect(msg.currentPhase).toBe('scouting');
      expect(msg.completedPhases).toEqual(['setup']);
      expect(msg.tasks).toHaveLength(1);
      expect(msg.tasks[0].id).toBe('t1');
      expect(msg.agents).toHaveLength(1);
      expect(msg.sidebar.title).toBe('Test');
    } finally {
      ws.close();
    }
  });

  it('broadcast sends message to all connected clients', async () => {
    const port = randomPort();

    // Provide a snapshot so clients receive an init message on connect
    // (makes it easier to sequence the test).
    const getSnapshot = mock(() => ({
      type: 'init' as const,
      currentPhase: '',
      completedPhases: [] as string[],
      tasks: [] as any[],
      agents: [] as any[],
      sidebar: { title: '', indicator: '' },
    }));

    server = await startObserverServer({
      host: '127.0.0.1',
      port,
      getSnapshot,
    });

    // Connect client 1 and wait for its snapshot
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws1);
    const snapshot1 = await waitForMessage(ws1);
    expect((snapshot1 as any).type).toBe('init');

    // Connect client 2 and wait for its snapshot
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws2);
    const snapshot2 = await waitForMessage(ws2);
    expect((snapshot2 as any).type).toBe('init');

    // Broadcast a test message — both clients should receive it
    const msgPromise1 = waitForMessage(ws1);
    const msgPromise2 = waitForMessage(ws2);

    const testMsg: ServerMessage = { type: 'workflow_complete' };
    server.broadcast(testMsg);

    const [received1, received2] = await Promise.all([msgPromise1, msgPromise2]);
    expect(received1).toEqual(testMsg);
    expect(received2).toEqual(testMsg);

    ws1.close();
    ws2.close();
  });

  it('terminate_server message calls onTerminate callback', async () => {
    const onTerminateMock = mock(() => {});
    const port = randomPort();
    server = await startObserverServer({
      host: '127.0.0.1',
      port,
      onTerminate: onTerminateMock,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    // Send terminate command
    ws.send(JSON.stringify({ type: 'terminate_server' }));

    // Give a brief moment for the message to be processed
    await Bun.sleep(100);

    expect(onTerminateMock).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('serves index.html with WS_ENDPOINT replaced', async () => {
    const port = randomPort();
    server = await startObserverServer({
      host: '127.0.0.1',
      port,
    });

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // Should contain a title (built frontend or fallback)
    expect(html).toContain('<title>engin');
    // WS_ENDPOINT should be replaced with real WebSocket URL
    expect(html).not.toContain('{{WS_ENDPOINT}}');
    expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
  });

  it('serves static assets from dist when available', async () => {
    // Skip if no built frontend (e.g. on CI without web/dist)
    const distDir = join(import.meta.dir, '../../web/dist');
    if (!existsSync(distDir)) return;

    const port = randomPort();
    server = await startObserverServer({
      host: '127.0.0.1',
      port,
    });

    // Find the first JS asset in dist
    const assetsDir = join(distDir, 'assets');
    const files = readdirSync(assetsDir);
    const jsFile = files.find((f) => f.endsWith('.js'));
    if (!jsFile) return;

    const response = await fetch(`http://127.0.0.1:${port}/assets/${jsFile}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
  });

  it('SPA fallback serves index.html for unknown paths', async () => {
    const port = randomPort();
    server = await startObserverServer({
      host: '127.0.0.1',
      port,
    });

    const response = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>engin');
    expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
  });
});
