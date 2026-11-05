// Real TCP client -> backend sync tests. No fetch stubs or cloud credentials.
// Run: node --test langs/typescript/tests/backend-http-e2e.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { backendSend, makeBackendSend } from "../src/transports/backend.mjs";

async function serve(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ fixtureError: e.message }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve, reject) =>
      server.close((e) => e ? reject(e) : resolve())),
  };
}
async function receive(req) {
  let text = "";
  for await (const chunk of req) text += chunk.toString("utf8");
  return JSON.parse(text);
}
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function write(id, key, version = 0) {
  return { table: "tenant_documents", id, op: "upsert",
    base_version: version, payload: { title: "updated" }, key };
}

test("twelve concurrent TCP clients replay one durable key without twelve effects", async (t) => {
  const id = randomUUID();
  const key = "e2e-write-" + randomUUID();
  const receipts = [];
  const dedup = new Map();
  let effects = 0;
  const backend = await serve(async (req, res) => {
    const payload = await receive(req);
    receipts.push({ method: req.method, path: req.url,
      key: req.headers["idempotency-key"],
      bearer: req.headers.authorization, payload });
    assert.equal(req.url, "/api/customer/sync/tenant_documents");
    assert.equal(payload.key, req.headers["idempotency-key"],
      "wire body and HTTP idempotency authority must be identical");
    if (!dedup.has(payload.key)) {
      effects++;
      dedup.set(payload.key, { id: payload.id, committed_version: 1 });
    }
    reply(res, 200, dedup.get(payload.key));
  });
  t.after(backend.close);
  const send = makeBackendSend(backend.base, {
    pathPrefix: "/api/customer/sync", getToken: async () => "local-e2e-bearer",
    csrfToken: "same-origin-csrf",
  });
  const acks = await Promise.all(Array.from({ length: 12 },
    () => send(write(id, key))));
  assert.equal(acks.length, 12);
  assert.ok(acks.every((ack) => ack.id === id && ack.committed_version === 1));
  assert.equal(effects, 1, "backend must apply one business effect per durable key");
  assert.equal(receipts.length, 12);
  for (const request of receipts) {
    assert.equal(request.method, "POST");
    assert.equal(request.key, key);
    assert.equal(request.bearer, "Bearer local-e2e-bearer");
    assert.equal(request.payload.base_version, 0);
  }
});

test("lost acknowledgement after server commit can be retried with the same key", async (t) => {
  const id = randomUUID();
  const durableKey = "write-" + randomUUID();
  let effects = 0;
  let first = true;
  const ledger = new Map();
  const backend = await serve(async (req, res) => {
    const body = await receive(req);
    assert.equal(req.headers["idempotency-key"], body.key);
    if (!ledger.has(body.key)) {
      effects++;
      ledger.set(body.key, { id: body.id, committed_version: 41 });
    }
    if (first) {
      first = false;
      // The mutation was committed; the TCP response was lost before the
      // SDK observed it. A retry must reuse the SAME durable queued-write key.
      req.socket.destroy();
      return;
    }
    reply(res, 200, ledger.get(body.key));
  });
  t.after(backend.close);
  const record = write(id, durableKey);
  await assert.rejects(() => backendSend(backend.base, record));
  assert.deepEqual(await backendSend(backend.base, record),
    { id, committed_version: 41 });
  assert.equal(effects, 1);
});

test("server conflict and forged acknowledgement never settle a queued write", async (t) => {
  const id = randomUUID();
  const attempts = [];
  const backend = await serve(async (req, res) => {
    const body = await receive(req);
    attempts.push(body);
    if (body.base_version === 0) {
      reply(res, 409, { error: "version_conflict" });
    } else if (body.base_version === 1) {
      reply(res, 200, { id: "wrong-row", committed_version: 2 });
    } else {
      reply(res, 200, { id, committed_version: 3 });
    }
  });
  t.after(backend.close);
  await assert.rejects(() => backendSend(backend.base, write(id, "cas-1", 0)),
    /sync write failed: 409/);
  await assert.rejects(() => backendSend(backend.base, write(id, "cas-2", 1)),
    /acknowledgement id does not match/);
  assert.deepEqual(await backendSend(backend.base, write(id, "cas-3", 2)),
    { id, committed_version: 3 });
  assert.deepEqual(attempts.map((x) => x.key), ["cas-1", "cas-2", "cas-3"]);
});

test("missing bearer and conflicting write/header identity fail before HTTP", async (t) => {
  let hits = 0;
  const backend = await serve(async (_req, res) => {
    hits++;
    reply(res, 200, { id: "x", committed_version: 2 });
  });
  t.after(backend.close);
  await assert.rejects(() => backendSend(backend.base, write("x", "fixed"),
    { getToken: async () => null }), /token provider returned no token/);
  await assert.rejects(() => backendSend(backend.base, write("x", "fixed"),
    { idempotencyKey: "other" }), /does not match/);
  assert.equal(hits, 0, "no unauthenticated or conflicting request sent");
});
