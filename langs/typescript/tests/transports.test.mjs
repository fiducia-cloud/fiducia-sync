// Tests for the pure transport decoders (decode.mjs) and the htmx optimistic
// intent parser — no IO, no sockets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBackendMessage, decodeSupabaseChange } from "../src/transports/decode.mjs";
import { optimisticIntent } from "../src/htmx.mjs";

test("decodeBackendMessage extracts valid changes from a sync frame, ignores others", () => {
  const frame = JSON.stringify({
    event: "fiducia:sync",
    changes: [
      { table: "api_keys", op: "upsert", id: "k1", version: 3, row: { id: "k1" }, at_ms: 1 },
      { table: "api_keys", op: "upsert", id: "k3", version: 4, write_key: "write-3" },
      { table: "api_keys", op: "bogus", id: "k2", version: 1 }, // invalid op -> dropped
      { table: "api_keys", op: "upsert", id: "unsafe", version: Number.MAX_SAFE_INTEGER + 1 },
      { table: "api_keys", op: "upsert", id: "bad-token", version: 5, write_key: 42 },
    ],
  });
  const out = decodeBackendMessage(frame);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "k1");
  assert.equal(out[1].write_key, "write-3");

  assert.deepEqual(decodeBackendMessage("not json"), []);
  assert.deepEqual(decodeBackendMessage(JSON.stringify({ event: "fiducia:refresh" })), []);
});

test("decodeSupabaseChange maps INSERT/UPDATE/DELETE to ChangeEvents", () => {
  const upd = decodeSupabaseChange("api_keys", {
    eventType: "UPDATE",
    new: { id: "k1", version: 4, name: "x" },
    old: {},
  });
  assert.deepEqual(upd, {
    table: "api_keys",
    op: "upsert",
    id: "k1",
    version: 4,
    row: { id: "k1", version: 4, name: "x" },
    at_ms: 0,
  });

  const del = decodeSupabaseChange("api_keys", { eventType: "DELETE", old: { id: "k1", version: 5 } });
  assert.equal(del.op, "delete");
  assert.equal(del.id, "k1");
  assert.equal(del.version, 5);

  assert.equal(decodeSupabaseChange("api_keys", { eventType: "UPDATE", new: {} }), null); // no id
});

test("decodeSupabaseChange refuses to fabricate a version (deletes without REPLICA IDENTITY FULL)", () => {
  // A DELETE that carried only the primary key (no version) must NOT decode to
  // version 0 — that would reconcile as stale and drop the delete. It returns null.
  assert.equal(decodeSupabaseChange("api_keys", { eventType: "DELETE", old: { id: "k1" } }), null);
  // An UPDATE without a version is likewise unorderable -> null.
  assert.equal(decodeSupabaseChange("api_keys", { eventType: "UPDATE", new: { id: "k1", name: "x" } }), null);
  assert.equal(decodeSupabaseChange("api_keys", { eventType: "UPDATE", new: { id: "k1", version: 1.5 } }), null);
  assert.equal(decodeSupabaseChange("api_keys", { eventType: "UPDATE", new: { id: "k1", version: "9007199254740992" } }), null);
  // commit_timestamp is surfaced as at_ms when present.
  const c = decodeSupabaseChange("api_keys", {
    eventType: "INSERT",
    new: { id: "k1", version: 1 },
    commit_timestamp: "2026-07-09T00:00:00.000Z",
  });
  assert.equal(c.at_ms, Date.parse("2026-07-09T00:00:00.000Z"));
});

test("optimisticIntent reads data-fiducia-* + request values", () => {
  const el = {
    getAttribute: (k) =>
      ({ "data-fiducia-table": "api_keys", "data-fiducia-id": "k1" })[k] ?? null,
  };
  assert.deepEqual(optimisticIntent(el, { name: "prod", scope: "kv:read" }), {
    table: "api_keys",
    id: "k1",
    row: { id: "k1", name: "prod", scope: "kv:read" },
  });

  // Not opted in -> null.
  assert.equal(optimisticIntent({ getAttribute: () => null }, { name: "x" }), null);
});
