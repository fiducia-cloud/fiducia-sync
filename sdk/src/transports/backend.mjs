// Backend transport: the Rust customer/admin server's own WebSocket (with SSE
// fallback) for reads, and its HTTP endpoint for the write path. Thin glue over
// the pure decoder in decode.mjs — the browser owns the sockets.
//
// Hardening (per audit):
//   - configurable plane paths (customer uses /app/ws + /api/customer/sync,
//     admin uses /admin/ws + /api/admin/sync) — nothing customer-specific is
//     baked in anymore;
//   - optional bearer auth (WS/SSE via ?access_token= since browsers can't set
//     socket headers; fetch via Authorization header);
//   - a stable Idempotency-Key on every write so retried/queued POSTs never
//     double-apply (matches the fiducia-clients idempotency contract);
//   - WebSocket auto-reconnect with capped exponential backoff, SSE only as a
//     fallback when WS is unavailable. Duplicate delivery across transports is
//     harmless: reconcile is idempotent (a re-seen version is Ignored).
// Socket/timer impls are injectable so the whole thing is unit-testable in node.

import { decodeBackendMessage } from "./decode.mjs";

const trimSlash = (s) => String(s).replace(/\/+$/, "");

/** Append `?access_token=<token>` to a URL (WS/SSE can't carry auth headers). */
function withToken(url, token) {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("access_token", token);
  return u.toString();
}

/**
 * Subscribe to the backend sync stream. Prefers WS (`wsPath`), reconnecting with
 * capped exponential backoff; falls back to SSE (`ssePath`) only when WS can't be
 * constructed. Calls `onChanges(ChangeEvent[])` for each sync frame.
 *
 * @param {object} o
 * @param {string} o.baseUrl                 e.g. location.origin
 * @param {string} [o.wsPath="/app/ws"]      plane WS path (admin: "/admin/ws")
 * @param {string} [o.ssePath="/app/events"] plane SSE path
 * @param {(changes:object[])=>void} o.onChanges
 * @param {()=>(string|Promise<string|null>)} [o.getToken] bearer token provider
 * @param {(status:"open"|"reconnecting"|"sse"|"closed")=>void} [o.onStatus]
 * @param {boolean} [o.reconnect=true]
 * @param {number}  [o.baseBackoffMs=500]
 * @param {number}  [o.maxBackoffMs=30000]
 * @param {Function} [o.WebSocketImpl] / [o.EventSourceImpl] test injection
 * @param {Function} [o.setTimeoutImpl] / [o.clearTimeoutImpl] test injection
 */
export function connectBackend({
  baseUrl,
  wsPath = "/app/ws",
  ssePath = "/app/events",
  onChanges,
  getToken,
  onStatus,
  reconnect = true,
  baseBackoffMs = 500,
  maxBackoffMs = 30000,
  WebSocketImpl,
  EventSourceImpl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  // `undefined` (key absent) => use the platform global; an explicit null/false
  // => this transport is disabled (used to force the SSE fallback, and in tests).
  const WS =
    WebSocketImpl === undefined
      ? typeof WebSocket !== "undefined" ? WebSocket : undefined
      : WebSocketImpl || undefined;
  const ES =
    EventSourceImpl === undefined
      ? typeof EventSource !== "undefined" ? EventSource : undefined
      : EventSourceImpl || undefined;

  let socket = null;
  let source = null;
  let timer = null;
  let attempts = 0;
  let stopped = false;

  const status = (s) => onStatus?.(s);
  const deliver = (data) => {
    const changes = decodeBackendMessage(data);
    if (changes.length) onChanges(changes);
  };

  async function tokenOrNull() {
    try {
      return getToken ? (await getToken()) ?? null : null;
    } catch {
      return null;
    }
  }

  // Resolve the token only when a provider is configured; otherwise stay fully
  // synchronous (construct the socket now) so callers/tests see it immediately.
  const withMaybeToken = (fn) => {
    if (getToken) Promise.resolve(tokenOrNull()).then((t) => fn(t));
    else fn(null);
  };

  const startSse = () => {
    if (source || stopped || !ES) return;
    status("sse");
    withMaybeToken((token) => {
      if (source || stopped) return;
      source = new ES(withToken(new URL(ssePath, baseUrl).toString(), token));
      source.addEventListener("fiducia-sync", (e) => deliver(e.data));
    });
  };

  const scheduleReconnect = () => {
    if (stopped || !reconnect) {
      status("closed");
      return;
    }
    status("reconnecting");
    const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempts);
    const jitter = backoff * 0.2 * Math.random();
    attempts += 1;
    timer = setTimeoutImpl(connectWs, backoff + jitter);
  };

  function connectWs() {
    if (stopped) return;
    if (!WS) {
      // No WebSocket in this environment — fall back to SSE for reads.
      startSse();
      return;
    }
    let wsUrl;
    try {
      wsUrl = new URL(wsPath, baseUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    } catch {
      startSse();
      return;
    }
    withMaybeToken((token) => {
      if (stopped) return;
      try {
        socket = new WS(withToken(wsUrl.toString(), token));
      } catch {
        startSse();
        return;
      }
      socket.addEventListener("open", () => {
        attempts = 0;
        status("open");
      });
      socket.addEventListener("message", (e) => deliver(e.data));
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", () => {
        socket = null;
        scheduleReconnect();
      });
    });
  }

  connectWs();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeoutImpl(timer);
      socket?.close?.();
      source?.close?.();
      status("closed");
    },
  };
}

/**
 * The write path: POST a queued optimistic write to the backend, which persists
 * it via SQLx and returns the committed row version. Plane-agnostic — pass the
 * plane's `pathPrefix` (customer: "/api/customer/sync", admin: "/api/admin/sync").
 * A stable Idempotency-Key makes retries safe (the server dedupes by it).
 *
 * @param {string} baseUrl
 * @param {object} write   { id, table, op, payload, base_version }
 * @param {object} [opts]
 * @param {string} [opts.pathPrefix="/api/customer/sync"]
 * @param {()=>(string|Promise<string|null>)} [opts.getToken]
 * @param {string} [opts.idempotencyKey]  override the derived key
 * @param {Function} [opts.fetchImpl=fetch]
 * @returns {Promise<{id:string, committed_version:number}>}
 */
export async function backendSend(baseUrl, write, opts = {}) {
  const {
    pathPrefix = "/api/customer/sync",
    getToken,
    idempotencyKey,
    fetchImpl = fetch,
  } = opts;

  const url = new URL(
    `${trimSlash(pathPrefix)}/${encodeURIComponent(write.table)}`,
    baseUrl,
  ).toString();

  const key =
    idempotencyKey ??
    `${write.table}:${write.id}:${write.op ?? "upsert"}:${write.base_version}`;
  const headers = { "content-type": "application/json", "idempotency-key": key };
  if (getToken) {
    const token = await getToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(write),
  });
  if (!res.ok) throw new Error(`sync write failed: ${res.status}`);
  return res.json();
}

/**
 * Bind `backendSend` to a plane's config, returning the `send(write)` closure the
 * sync client's optimisticWrite/flushQueue expect.
 */
export function makeBackendSend(baseUrl, opts = {}) {
  return (write) => backendSend(baseUrl, write, opts);
}
