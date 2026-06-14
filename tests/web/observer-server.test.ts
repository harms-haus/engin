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
// Each test gets a unique port (monotonic counter) so multiple servers that
// remain listening until afterAll never collide with EADDRINUSE. The
// randomized base avoids cross-run TIME_WAIT collisions on re-runs.
let nextPort = 20000 + Math.floor(Math.random() * 8000);
function randomPort(): number {
  return nextPort++;
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
      type: 'snapshot' as const,
      seq: 1,
      state: {
        seq: 1,
        taskPrompt: 'Build it',
        phases: [],
        currentPhaseId: 'scouting',
        completedPhaseIds: ['setup'],
        tasks: {
          t1: { id: 't1', title: 'Task 1', phaseId: 'p1', status: 'done', steps: [], dependencies: [] },
        },
        agents: {
          a1: {
            uid: 'uid-1',
            agentId: 'a1',
            profile: 'scout',
            phaseId: 'scouting',
            active: false,
            log: [],
            toolCallCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            taskTitle: 'Task 1',
          },
        },
        sidebar: { title: 'Test', indicator: '🟢' },
        status: 'running',
        stats: { totalTokens: 0, agentCount: 1 },
      },
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
      expect(msg.type).toBe('snapshot');
      expect(msg.state.currentPhaseId).toBe('scouting');
      expect(msg.state.completedPhaseIds).toEqual(['setup']);
      expect(Object.keys(msg.state.tasks)).toHaveLength(1);
      expect(msg.state.tasks.t1.id).toBe('t1');
      expect(Object.keys(msg.state.agents)).toHaveLength(1);
      expect(msg.state.sidebar.title).toBe('Test');
    } finally {
      ws.close();
    }
  });

  it('broadcast sends message to all connected clients', async () => {
    const port = randomPort();

    // Provide a snapshot so clients receive a snapshot message on connect
    // (makes it easier to sequence the test).
    const getSnapshot = mock(() => ({
      type: 'snapshot' as const,
      seq: 0,
      state: {
        seq: 0,
        taskPrompt: '',
        phases: [],
        currentPhaseId: '',
        completedPhaseIds: [] as string[],
        tasks: {},
        agents: {},
        sidebar: { title: '', indicator: '' },
        status: 'running',
        stats: { totalTokens: 0, agentCount: 0 },
      },
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
    expect((snapshot1 as any).type).toBe('snapshot');

    // Connect client 2 and wait for its snapshot
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws2);
    const snapshot2 = await waitForMessage(ws2);
    expect((snapshot2 as any).type).toBe('snapshot');

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

  // ─── Origin validation tests ───────────────────────────────────────────

  describe('origin validation', () => {
    /**
     * Helper: send a plain HTTP GET to /ws and return the response status.
     * Because the request lacks WebSocket upgrade headers, the server will
     * return 400 when origin validation passes (upgrade fails) or 403 when
     * origin validation rejects the request.
     */
    async function hitWs(serverUrl: string, origin?: string): Promise<Response> {
      const headers: Record<string, string> = {};
      if (origin !== undefined) {
        headers['Origin'] = origin;
      }
      return await fetch(`${serverUrl}/ws`, { headers });
    }

    // ── Non-localhost (0.0.0.0) ───────────────────────────────────────────

    it('rejects mismatched Origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`, 'https://evil.com');
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Forbidden');
    });

    it('allows missing Origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`); // no Origin header
      expect(res.status).not.toBe(403);
    });

    it('allows matching Origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`, `http://0.0.0.0:${port}`);
      expect(res.status).not.toBe(403);
    });

    // ── Localhost (127.0.0.1 / localhost) ──────────────────────────────────

    it('allows mismatched Origin when connecting via 127.0.0.1', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port });

      const res = await hitWs(`http://127.0.0.1:${port}`, 'https://evil.com');
      expect(res.status).not.toBe(403);
    });

    it('allows mismatched Origin when connecting via localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port });

      const res = await hitWs(`http://localhost:${port}`, 'https://evil.com');
      expect(res.status).not.toBe(403);
    });

    it('allows missing Origin on localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '127.0.0.1', port });

      const res = await hitWs(`http://127.0.0.1:${port}`);
      expect(res.status).not.toBe(403);
    });

    // ── Non-HTTP scheme Origins (Bug 1) ──────────────────────────────────

    it('allows capacitor://localhost origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`, 'capacitor://localhost');
      expect(res.status).not.toBe(403);
    });

    it('allows file:// origin on non-localhost', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`, 'file://');
      expect(res.status).not.toBe(403);
    });

    // ── Port omission (Bug 2) ──────────────────────────────────────────────

    it('allows Origin with omitted port (default scheme port)', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      // Origin without explicit port, host header includes the port
      const res = await hitWs(`http://0.0.0.0:${port}`, `http://0.0.0.0`);
      expect(res.status).not.toBe(403);
    });

    // ── Hostname mismatch ───────────────────────────────────────────────────

    it('rejects genuinely mismatched hostname', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const res = await hitWs(`http://0.0.0.0:${port}`, 'http://evil.com');
      expect(res.status).toBe(403);
    });

    // ── Case-insensitive hostname (Bug 3) ───────────────────────────────────

    it('uses case-insensitive hostname comparison', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      // The URL constructor lowercases hostnames in the origin,
      // but the Host header (or X-Forwarded-Host) may retain
      // uppercase.  We use X-Forwarded-Host with an uppercase
      // hostname to verify case-insensitive comparison.
      const headers: Record<string, string> = {
        Origin: `http://example.com:${port}`,
        'X-Forwarded-Host': `EXAMPLE.COM:${port}`,
      };
      const res = await fetch(`http://0.0.0.0:${port}/ws`, { headers });
      expect(res.status).not.toBe(403);
    });

    // ── X-Forwarded-Host ────────────────────────────────────────────────────

    it('honors x-forwarded-host header over host header', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      // The actual Host header will be 0.0.0.0:${port} (from fetch),
      // but we set X-Forwarded-Host to a different address. The origin
      // matches the X-Forwarded-Host value.
      const headers: Record<string, string> = {
        Origin: `http://1.2.3.4:${port}`,
        'X-Forwarded-Host': `1.2.3.4:${port}`,
      };
      const res = await fetch(`http://0.0.0.0:${port}/ws`, { headers });
      expect(res.status).not.toBe(403);
    });

    it('rejects when x-forwarded-host origin does not match', async () => {
      const port = randomPort();
      server = await startObserverServer({ host: '0.0.0.0', port });

      const headers: Record<string, string> = {
        Origin: `http://1.2.3.4:${port}`,
        'X-Forwarded-Host': `5.6.7.8:${port}`,
      };
      const res = await fetch(`http://0.0.0.0:${port}/ws`, { headers });
      expect(res.status).toBe(403);
    });

    it('still allows real WebSocket connections from browser on localhost', async () => {
      const getSnapshot = mock(() => ({
        type: 'snapshot' as const,
        seq: 0,
        state: {
          seq: 0,
          taskPrompt: '',
          phases: [],
          currentPhaseId: '',
          completedPhaseIds: [] as string[],
          tasks: {},
          agents: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
        },
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
        expect(msg.type).toBe('snapshot');
      } finally {
        ws.close();
      }
    });
  });

  // ─── displayHost tests ─────────────────────────────────────────────────

  it('uses server.hostname in URL when displayHost is not provided (backward compat)', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: 0,
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.stop();
    server = undefined;
  });

  it('uses displayHost in URL when provided, replacing server.hostname', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: '192.168.1.50',
    });
    expect(server.url).toMatch(/^http:\/\/192\.168\.1\.50:\d+$/);
    expect(server.url).not.toContain('0.0.0.0');
    await server.stop();
    server = undefined;
  });

  it('displayHost works with localhost host', async () => {
    server = await startObserverServer({
      host: '127.0.0.1',
      port: 0,
      displayHost: 'myhost.local',
    });
    expect(server.url).toMatch(/^http:\/\/myhost\.local:\d+$/);
    await server.stop();
    server = undefined;
  });

  it('displayHost preserves port in URL', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: 'example.com',
    });
    expect(server.url).toBe(`http://example.com:${server.server.port}`);
    await server.stop();
    server = undefined;
  });

  it('startObserverServer with host 0.0.0.0, port 0, and displayHost 192.168.1.50 returns a URL containing 192.168.1.50 not 0.0.0.0', async () => {
    server = await startObserverServer({
      host: '0.0.0.0',
      port: 0,
      displayHost: '192.168.1.50',
    });
    expect(server.url).toContain('192.168.1.50');
    expect(server.url).not.toContain('0.0.0.0');
    expect(server.url).toMatch(/^http:\/\/192\.168\.1\.50:\d+$/);
    await server.stop();
    server = undefined;
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

  // ─── WS scheme detection tests ───────────────────────────────────────────

  describe('WS scheme detection', () => {
    it('uses ws:// scheme when serving over plain HTTP (no x-forwarded-proto)', async () => {
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
      });

      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`ws://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`wss://127.0.0.1:${port}/ws`);
    });

    it('uses wss:// scheme when x-forwarded-proto is https', async () => {
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
      });

      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`wss://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`ws://127.0.0.1:${port}/ws`);
    });

    it('uses wss:// scheme for SPA fallback path when x-forwarded-proto is https', async () => {
      const port = randomPort();
      server = await startObserverServer({
        host: '127.0.0.1',
        port,
      });

      const response = await fetch(`http://127.0.0.1:${port}/some/random/path`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`wss://127.0.0.1:${port}/ws`);
      expect(html).not.toContain(`ws://127.0.0.1:${port}/ws`);
    });
  });
});
