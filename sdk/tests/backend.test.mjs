// Backend transport tests — WebSocket, SSE fallback, reconnect, and the write
// path (path/auth/idempotency) are all exercised with injected impls so no real
// browser or server is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectBackend, backendSend, makeBackendSend } from "../src/transports/backend.mjs";

class MockWS {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    MockWS.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  close() {
    this.closed = true;
  }
}

const syncFrame = (changes) => JSON.stringify({ event: "fiducia:sync", changes });

test("connectBackend decodes WS sync frames into onChanges", () => {
  MockWS.instances = [];
  const seen = [];
  connectBackend({
    baseUrl: "http://localhost",
    onChanges: (c) => seen.push(...c),
    WebSocketImpl: MockWS,
    setTimeoutImpl: () => 0,
  });
  const ws = MockWS.instances[0];
  assert.match(ws.url, /^ws:\/\/localhost\/app\/ws/);
  ws.emit("open", {});
  ws.emit("message", { data: syncFrame([{ table: "api_keys", op: "upsert", id: "k1", version: 2, row: {} }]) });
  ws.emit("message", { data: "not-a-sync-frame" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "k1");
});

test("connectBackend reconnects with backoff after a close", () => {
  MockWS.instances = [];
  const scheduled = [];
  connectBackend({
    baseUrl: "https://host",
    onChanges: () => {},
    WebSocketImpl: MockWS,
    setTimeoutImpl: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
  });
  assert.equal(MockWS.instances.length, 1);
  assert.match(MockWS.instances[0].url, /^wss:\/\/host\/app\/ws/); // https -> wss
  MockWS.instances[0].emit("close", {});
  assert.equal(scheduled.length, 1); // reconnect scheduled
  scheduled[0].fn(); // fire the timer
  assert.equal(MockWS.instances.length, 2); // a fresh socket was opened
});

test("connectBackend falls back to SSE when no WebSocket is available", () => {
  const created = [];
  class MockES {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = {};
      created.push(this);
    }
    addEventListener(t, fn) {
      (this.listeners[t] ||= []).push(fn);
    }
    close() {}
  }
  const seen = [];
  connectBackend({
    baseUrl: "http://localhost",
    onChanges: (c) => seen.push(...c),
    WebSocketImpl: null, // explicitly force "no WS" (node 22 has a global WebSocket)
    EventSourceImpl: MockES,
    setTimeoutImpl: () => 0,
  });
  assert.equal(created.length, 1);
  assert.match(created[0].url, /\/app\/events$/);
  assert.equal(created[0].options.withCredentials, true);
  assert.doesNotMatch(created[0].url, /access_token/);
  for (const fn of created[0].listeners["fiducia-sync"]) {
    fn({ data: syncFrame([{ table: "api_keys", op: "delete", id: "k9", version: 3 }]) });
  }
  assert.equal(seen[0].id, "k9");
});

test("connectBackend reports when no browser stream transport exists", () => {
  const statuses = [];
  connectBackend({
    baseUrl: "http://localhost",
    onChanges: () => {},
    onStatus: (status, error) => statuses.push({ status, error }),
    WebSocketImpl: null,
    EventSourceImpl: null,
  });
  assert.equal(statuses[0].status, "transport-error");
  assert.match(statuses[0].error.message, /neither WebSocket nor EventSource/);
  assert.equal(statuses[1].status, "closed");
});

test("stream bearer tokens fail closed unless URL exposure is explicitly opted in", async () => {
  MockWS.instances = [];
  assert.throws(
    () =>
      connectBackend({
        baseUrl: "https://host",
        getToken: () => "secret",
        onChanges: () => {},
        WebSocketImpl: MockWS,
      }),
    /choose streamAuth/,
  );
  assert.equal(MockWS.instances.length, 0);

  connectBackend({
    baseUrl: "https://host",
    getToken: () => "secret value",
    streamAuth: "query-token",
    onChanges: () => {},
    WebSocketImpl: MockWS,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(MockWS.instances.length, 1);
  const url = new URL(MockWS.instances[0].url);
  assert.equal(url.searchParams.get("access_token"), "secret value");
});

test("cookie stream auth never calls or exposes the HTTP bearer provider", () => {
  MockWS.instances = [];
  let tokenCalls = 0;
  connectBackend({
    baseUrl: "https://host",
    getToken: () => {
      tokenCalls += 1;
      return "secret";
    },
    streamAuth: "cookie",
    onChanges: () => {},
    WebSocketImpl: MockWS,
  });
  assert.equal(tokenCalls, 0);
  assert.equal(MockWS.instances.length, 1);
  assert.doesNotMatch(MockWS.instances[0].url, /secret|access_token/);
});

test("query-token mode reports auth failure and opens no unauthenticated socket", async () => {
  MockWS.instances = [];
  const statuses = [];
  connectBackend({
    baseUrl: "https://host",
    getToken: async () => null,
    streamAuth: "query-token",
    onChanges: () => {},
    onStatus: (status, error) => statuses.push({ status, error }),
    WebSocketImpl: MockWS,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(MockWS.instances.length, 0);
  assert.equal(statuses[0].status, "auth-error");
  assert.match(statuses[0].error.message, /no token/);
});

test("backendSend targets the plane path, sets a stable Idempotency-Key + bearer auth", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ id: "k1", committed_version: 7 }) };
  };
  const ack = await backendSend(
    "http://localhost",
    { id: "k1", table: "api_keys", op: "upsert", base_version: 3 },
    { pathPrefix: "/api/admin/sync", getToken: () => "tok", fetchImpl },
  );
  assert.equal(captured.url, "http://localhost/api/admin/sync/api_keys");
  assert.equal(captured.init.headers["idempotency-key"], "api_keys:k1:upsert:3");
  assert.equal(captured.init.headers["authorization"], "Bearer tok");
  assert.deepEqual(ack, { id: "k1", committed_version: 7 });
});

test("backendSend throws on a non-2xx response; makeBackendSend binds config", async () => {
  const fetchFail = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(
    () => backendSend("http://x", { id: "k1", table: "t", base_version: 0 }, { fetchImpl: fetchFail }),
    /sync write failed: 500/,
  );

  let seenUrl;
  const fetchOk = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ id: "a", committed_version: 1 }) };
  };
  const send = makeBackendSend("http://x", { pathPrefix: "/api/customer/sync", fetchImpl: fetchOk });
  await send({ id: "a", table: "api_keys", op: "upsert", base_version: 0 });
  assert.equal(seenUrl, "http://x/api/customer/sync/api_keys");

  await assert.rejects(
    () =>
      backendSend(
        "http://x",
        { id: "a", table: "api_keys", op: "upsert", base_version: 0 },
        { getToken: async () => null, fetchImpl: fetchOk },
      ),
    /token provider returned no token/,
  );
});

test("backendSend prefers the write's durable per-write key over the legacy derivation", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ id: "k1", committed_version: 7 }) };
  };
  await backendSend(
    "http://localhost",
    { id: "k1", table: "api_keys", op: "upsert", base_version: 3, key: "w-unique-1" },
    { fetchImpl },
  );
  assert.equal(captured.init.headers["idempotency-key"], "w-unique-1");

  // An explicit override still wins over both.
  await backendSend(
    "http://localhost",
    { id: "k1", table: "api_keys", op: "upsert", base_version: 3, key: "w-unique-1" },
    { fetchImpl, idempotencyKey: "explicit" },
  );
  assert.equal(captured.init.headers["idempotency-key"], "explicit");
});
