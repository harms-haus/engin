import type { ClientMessage, ServerMessage } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClientMessageHandlers {
  onStartWorkflow: (msg: Extract<ClientMessage, { type: 'start_workflow' }>) => void;
  onSelectWorkflow: (
    msg: Extract<ClientMessage, { type: 'select_workflow' }>,
    ws: Bun.ServerWebSocket,
  ) => Promise<void>;
  onCancelWorkflow: (msg: Extract<ClientMessage, { type: 'cancel_workflow' }>) => void;
}

// ─── WebSocketManager ───────────────────────────────────────────────────────

export class WebSocketManager {
  private clients = new Set<Bun.ServerWebSocket>();

  /**
   * Register a new client and send it the provided init message.
   */
  addClient(ws: Bun.ServerWebSocket, initMessage: ServerMessage): void {
    this.clients.add(ws);
    try {
      ws.send(JSON.stringify(initMessage));
    } catch (err) {
      console.warn('WebSocket send failed, removing client:', err);
      this.clients.delete(ws);
    }
  }

  /**
   * Remove a client. Safe to call if the client was never added or was
   * already removed.
   */
  removeClient(ws: Bun.ServerWebSocket): void {
    this.clients.delete(ws);
  }

  /**
   * Broadcast a message to all currently connected clients.
   * If a client's `send()` throws, the client is logged and removed so it
   * is not included in future broadcasts.
   */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        ws.send(data);
      } catch (err) {
        console.warn('WebSocket send failed, removing client:', err);
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Parse an incoming client message and dispatch it to the appropriate
   * handler.  Invalid or unrecognised messages are silently ignored.
   */
  handleMessage(raw: string | Buffer, handlers: ClientMessageHandlers, ws: Bun.ServerWebSocket): void {
    let parsed: unknown;
    try {
      const str = typeof raw === 'string' ? raw : raw.toString();
      parsed = JSON.parse(str);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return;
    }

    const msg = parsed as ClientMessage;

    switch (msg.type) {
      case 'start_workflow':
        handlers.onStartWorkflow(msg);
        break;
      case 'select_workflow':
        handlers.onSelectWorkflow(msg, ws).catch((err: unknown) => {
          console.error('Error in onSelectWorkflow handler:', err);
        });
        break;
      case 'cancel_workflow':
        handlers.onCancelWorkflow(msg);
        break;
    }
  }
}
