/// <reference types="vite/client" />

/**
 * Injected by the engine server when it serves the built web bundle: the
 * placeholder `{{WS_ENDPOINT}}` is replaced with the real ws/wss URL at serve
 * time. Declared here so consumers (useWebSocket) can read it without `any`.
 */
declare global {
  interface Window {
    __WS_ENDPOINT__?: string;
  }
}

export {};
