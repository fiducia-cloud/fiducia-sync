// Backend transport: the Rust customer/admin server's own WebSocket (with SSE
// fallback) for reads, and its HTTP endpoint for the write path. Thin glue over
// the pure decoder in decode.mjs — the browser owns the sockets.

import { decodeBackendMessage } from "./decode.mjs";

/**
 * Subscribe to the backend sync stream. Prefers WS (`/app/ws`), falls back to
 * SSE (`/app/events`). Calls `onChanges(ChangeEvent[])` for each sync frame.
 */
export function connectBackend({ baseUrl, wsPath = "/app/ws", ssePath = "/app/events", onChanges }) {
  let socket = null;
  let source = null;

  const startSse = () => {
    if (source || typeof EventSource === "undefined") return;
    source = new EventSource(new URL(ssePath, baseUrl).toString());
    source.addEventListener("fiducia-sync", (e) => {
      const changes = decodeBackendMessage(e.data);
      if (changes.length) onChanges(changes);
    });
  };

  try {
    const wsUrl = new URL(wsPath, baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(wsUrl.toString());
    socket.addEventListener("message", (e) => {
      const changes = decodeBackendMessage(e.data);
      if (changes.length) onChanges(changes);
    });
    socket.addEventListener("error", startSse);
    socket.addEventListener("close", startSse);
  } catch {
    startSse();
  }

  return {
    stop() {
      socket?.close?.();
      source?.close?.();
    },
  };
}

/**
 * The write path: POST a queued optimistic write to the backend, which persists
 * it via SQLx and returns the committed row version.
 * @returns {Promise<{id:string, committed_version:number}>}
 */
export async function backendSend(baseUrl, write) {
  const res = await fetch(new URL(`/api/customer/sync/${write.table}`, baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(write),
  });
  if (!res.ok) throw new Error(`sync write failed: ${res.status}`);
  return res.json();
}
