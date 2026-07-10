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
    constructor(url) {
      this.url = url;
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
    WebSocketImpl: undefined, // force "no WS"
    EventSourceImpl: MockES,
    setTimeoutImpl: () => 0,
  });
  assert.equal(created.length, 1);
  assert.match(created[0].url, /\/app\/events$/);
  for (const fn of created[0].listeners["fiducia-sync"]) {
    fn({ data: syncFrame([{ table: "api_keys", op: "delete", id: "k9", version: 3 }]) });
  }
  assert.equal(seen[0].id, "k9");
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
});
