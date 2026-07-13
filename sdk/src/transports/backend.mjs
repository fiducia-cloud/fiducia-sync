// Backend transport: the Rust customer/admin server's own WebSocket (with SSE
// fallback) for reads, and its HTTP endpoint for the write path. Thin glue over
// the pure decoder in decode.mjs — the browser owns the sockets.
//
// Hardening (per audit):
//   - configurable plane paths (customer uses /app/ws + /api/customer/sync,
//     admin uses /admin/ws + /api/admin/sync) — nothing customer-specific is
//     baked in anymore;
//   - bearer auth uses Authorization on fetch. Browser WS/EventSource cannot set
//     that header, so streams default to cookie auth and URL tokens require the
//     explicit, compatibility-only `streamAuth: "query-token"` opt-in;
//   - a stable Idempotency-Key on every write so retried/queued POSTs never
//     double-apply (matches the fiducia-clients idempotency contract);
//   - WebSocket auto-reconnect with capped exponential backoff, SSE only as a
//     fallback when WS is unavailable. Duplicate delivery across transports is
//     harmless: reconcile is idempotent (a re-seen version is Ignored).
// Socket/timer impls are injectable so the whole thing is unit-testable in node.

import { decodeBackendMessage } from "./decode.mjs";

const trimSlash = (s) => String(s).replace(/\/+$/, "");

/** Append the explicitly opted-in compatibility token to a stream URL. */
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
 * @param {"cookie"|"query-token"} [o.streamAuth] stream authentication mode
 * @param {(status:"open"|"reconnecting"|"sse"|"closed"|"auth-error"|"transport-error", err?:Error)=>void} [o.onStatus]
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
  streamAuth,
  onStatus,
  reconnect = true,
  baseBackoffMs = 500,
  maxBackoffMs = 30000,
  WebSocketImpl,
  EventSourceImpl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const authMode = streamAuth ?? (getToken ? null : "cookie");
  if (authMode === null) {
    throw new Error(
      "getToken cannot be placed in a browser WS/SSE header; choose streamAuth \"cookie\" (recommended) or explicitly opt in to \"query-token\"",
    );
  }
  if (authMode !== "cookie" && authMode !== "query-token") {
    throw new Error(`unsupported backend streamAuth mode: ${authMode}`);
  }
  if (authMode === "query-token" && !getToken) {
    throw new Error('streamAuth "query-token" requires getToken');
  }

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

  const status = (s, error) => {
    if (onStatus) onStatus(s, error);
    else if (error) {
      console.error(
        `[fiducia-sync] backend:${s}: ${error.message ?? String(error)}`,
      );
    }
  };
  const deliver = (data) => {
    const changes = decodeBackendMessage(data);
    if (changes.length) onChanges(changes);
  };

  async function tokenForUrl() {
    try {
      const token = await getToken();
      if (typeof token !== "string" || token.trim() === "") {
        throw new Error("stream token provider returned no token");
      }
      return token;
    } catch (error) {
      status(
        "auth-error",
        error instanceof Error ? error : new Error(String(error)),
      );
      return null;
    }
  }

  // Cookie-authenticated streams stay synchronous. The compatibility query
  // mode resolves a token first and fails closed if it cannot obtain one.
  const withStreamAuth = (fn) => {
    if (authMode === "query-token") {
      Promise.resolve(tokenForUrl())
        .then((token) => {
          if (token) fn(token);
        })
        .catch((error) => status("transport-error", error));
    } else {
      fn(null);
    }
  };

  const streamUrl = (path) => {
    const url = new URL(path, baseUrl);
    if (url.username || url.password) {
      throw new Error("backend stream URL must not contain credentials");
    }
    if (url.searchParams.has("access_token") && authMode !== "query-token") {
      throw new Error(
        'backend stream URL contains access_token without streamAuth "query-token"',
      );
    }
    return url;
  };

  const startSse = () => {
    if (source || stopped) return;
    if (!ES) {
      status(
        "transport-error",
        new Error("neither WebSocket nor EventSource is available"),
      );
      status("closed");
      return;
    }
    withStreamAuth((token) => {
      if (source || stopped) return;
      let url;
      try {
        url = streamUrl(ssePath).toString();
      } catch (error) {
        status("auth-error", error);
        return;
      }
      source = new ES(withToken(url, token), {
        withCredentials: authMode === "cookie",
      });
      status("sse");
      source.addEventListener("fiducia-sync", (e) => deliver(e.data));
      source.addEventListener("error", (event) => {
        status(
          "transport-error",
          event?.error instanceof Error
            ? event.error
            : new Error("backend SSE stream failed"),
        );
      });
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
      wsUrl = streamUrl(wsPath);
      if (wsUrl.protocol === "https:") wsUrl.protocol = "wss:";
      else if (wsUrl.protocol === "http:") wsUrl.protocol = "ws:";
      else if (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") {
        throw new Error(`unsupported backend WebSocket protocol: ${wsUrl.protocol}`);
      }
    } catch (error) {
      status("auth-error", error);
      return;
    }
    withStreamAuth((token) => {
      if (stopped) return;
      try {
        socket = new WS(withToken(wsUrl.toString(), token));
      } catch (error) {
        status(
          "transport-error",
          error instanceof Error ? error : new Error(String(error)),
        );
        startSse();
        return;
      }
      socket.addEventListener("open", () => {
        attempts = 0;
        status("open");
      });
      socket.addEventListener("message", (e) => deliver(e.data));
      socket.addEventListener("error", (event) => {
        status(
          "transport-error",
          event?.error instanceof Error
            ? event.error
            : new Error("backend WebSocket failed"),
        );
      });
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
 * Precedence: an explicit `opts.idempotencyKey`, else the write's own durable
 * `key` (minted per queued write by the sync client, so two successive edits to
 * the same row never collide), else — for writes from older queues that carry
 * no key — the legacy `(table,id,op,base_version)` derivation.
 *
 * @param {string} baseUrl
 * @param {object} write   { id, table, op, payload, base_version, key? }
 * @param {object} [opts]
 * @param {string} [opts.pathPrefix="/api/customer/sync"]
 * @param {()=>(string|Promise<string|null>)} [opts.getToken]
 * @param {string} [opts.idempotencyKey]  override the key
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
    write.key ??
    `${write.table}:${write.id}:${write.op ?? "upsert"}:${write.base_version}`;
  const headers = { "content-type": "application/json", "idempotency-key": key };
  if (getToken) {
    const token = await getToken();
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("sync write token provider returned no token");
    }
    headers["authorization"] = `Bearer ${token}`;
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
