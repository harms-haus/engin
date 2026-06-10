import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { getDefaultWorkDir, scanPastRuns } from '../core/config.js';
import { loadWorkflow } from '../core/workflow-loader.js';
import { RunRegistry } from './run-registry.js';
import { createStatusBridge } from './status-bridge.js';
import type { ClientMessage, ServerMessage, WebServerDependencies, WebServerOptions } from './types.js';

export async function startWebServer(
  options: WebServerOptions,
  deps: Partial<WebServerDependencies> = {},
): Promise<Bun.Server<undefined>> {
  const resolveWorkflow = deps.loadWorkflow ?? loadWorkflow;
  const resolveWorkDir = deps.getDefaultWorkDir ?? getDefaultWorkDir;
  const resolvePastRuns = deps.scanPastRuns ?? scanPastRuns;

  const registry = new RunRegistry();

  try {
    const pastRuns = await resolvePastRuns(options.cwd);
    for (const run of pastRuns) {
      const runId = registry.createRun(run.workflowName);
      registry.completeRun(runId);
    }
  } catch (err) {
    console.error('Failed to load past runs:', err);
  }

  const clients = new Set<Bun.ServerWebSocket>();
  const WEB_DIST_DIR = join(import.meta.dir, '..', '..', 'web', 'dist');

  const broadcast = (msg: ServerMessage) => {
    const d = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(d);
    }
  };

  const MIME_MAP: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  async function startWorkflow(workflowName: string, taskPrompt: string, maxConcurrent?: number): Promise<string> {
    const runId = registry.createRun(workflowName);
    broadcast({ type: 'workflow_started', summary: registry.getSummary(runId) });

    let workflow;
    try {
      workflow = await resolveWorkflow(workflowName, options.cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const summary = registry.failRun(runId, msg);
      broadcast({
        type: 'workflow_failed',
        summary,
        error: msg,
        phase: registry.getRun(runId)?.currentPhase ?? 'unknown',
      });
      return runId;
    }

    const bridge = createStatusBridge(runId, registry, broadcast);
    const workDir = resolveWorkDir(options.cwd, workflowName);

    // Fire-and-forget the workflow run
    workflow
      .run(taskPrompt, {
        cwd: options.cwd,
        workDir,
        maxConcurrentTasks: maxConcurrent,
        onStatus: bridge,
        signal: registry.getAbortController(runId)?.signal,
      })
      .then(() => {
        const summary = registry.completeRun(runId);
        broadcast({ type: 'workflow_complete', summary });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const summary = registry.failRun(runId, msg);
        broadcast({
          type: 'workflow_failed',
          summary,
          error: msg,
          phase: registry.getRun(runId)?.currentPhase ?? 'unknown',
        });
      });

    return runId;
  }

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,

    async fetch(req, server) {
      // ─── WebSocket upgrade ────────────────────────────────────────────
      if (new URL(req.url).pathname === '/ws') {
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return undefined;
      }
      const url = new URL(req.url);

      // ─── API routes ────────────────────────────────────────────────────
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && url.pathname === '/api/runs') {
          return (async () => {
            try {
              const body = (await req.json()) as { workflowName?: string; taskPrompt?: string; maxConcurrent?: number };
              if (!body.workflowName || !body.taskPrompt) {
                return new Response(JSON.stringify({ error: 'workflowName and taskPrompt are required' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              const runId = await startWorkflow(body.workflowName, body.taskPrompt, body.maxConcurrent);
              return Response.json({ runId });
            } catch {
              return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          })();
        }

        if (req.method === 'GET' && url.pathname === '/api/runs') {
          return Response.json(registry.getAllSummaries());
        }

        return new Response('Not Found', { status: 404 });
      }

      // ─── Static file serving ───────────────────────────────────────────
      const filePath = url.pathname === '/' ? '/index.html' : url.pathname;

      // Try to serve the requested file
      const fullPath = join(WEB_DIST_DIR, filePath);
      const ext = extname(filePath);

      try {
        const content = await readFile(fullPath);
        const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';

        // Special handling for index.html – replace WS endpoint
        if (filePath === '/index.html') {
          const text = content.toString('utf-8');
          const wsEndpoint = `ws://${url.host}/ws`;
          const modified = text.replace('{{WS_ENDPOINT}}', wsEndpoint);
          return new Response(modified, {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        return new Response(content, {
          headers: { 'Content-Type': mimeType },
        });
      } catch {
        // File not found – try index.html (SPA fallback) or placeholder
        try {
          const indexPath = join(WEB_DIST_DIR, 'index.html');
          const indexContent = await readFile(indexPath);
          const text = indexContent.toString('utf-8');
          const wsEndpoint = `ws://${url.host}/ws`;
          const modified = text.replace('{{WS_ENDPOINT}}', wsEndpoint);
          return new Response(modified, {
            headers: { 'Content-Type': 'text/html' },
          });
        } catch {
          // No index.html at all – placeholder
          return new Response(
            `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>engin</title></head>
<body>
  <h1>engin</h1>
  <p>Frontend not built. Run <code>cd web && npm run build</code>.</p>
  <script>window.__WS_ENDPOINT__ = "ws://${url.host}/ws";</script>
</body>
</html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            },
          );
        }
      }
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'init', workflows: registry.getAllSummaries() }));
      },
      message(ws, msg) {
        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString()) as ClientMessage;
        } catch {
          return; // Ignore invalid messages
        }

        switch (parsed.type) {
          case 'start_workflow': {
            // Fire and forget – don't await
            startWorkflow(parsed.workflowName, parsed.taskPrompt, parsed.maxConcurrent).catch((_err: unknown) => {
              /* noop */
            });
            break;
          }
          case 'cancel_workflow': {
            const ctrl = registry.getAbortController(parsed.workflowId);
            if (ctrl) {
              ctrl.abort();
            }
            break;
          }
          case 'select_workflow': {
            // Currently no server-side action needed for selection
            break;
          }
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  console.log(`Web server listening on http://${options.host}:${options.port}`);
  return server;
}
