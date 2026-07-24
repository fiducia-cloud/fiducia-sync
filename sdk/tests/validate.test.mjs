// Schema validation: the JS subset validator must agree with the Rust core
// (src/schema.rs) over the SAME shared fixtures, fail closed on unsupported
// keywords, and the zodSchemas factory must produce real working Zod schemas
// from the same document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import {
  makeValidator,
  validateSyncEnvelope,
  assertSyncEnvelope,
  zodSchemas,
  SchemaValidationError,
} from "../src/validate.mjs";
import { SYNC_SCHEMA } from "../src/sync-schema.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/sync-envelopes.json", import.meta.url), "utf8"),
);

test("shared fixture cases all agree with the canonical schema", () => {
  const validator = makeValidator();
  assert.ok(fixtures.cases.length >= 20, "fixture file looks truncated");
  for (const { name, definition, valid, value } of fixtures.cases) {
    const violations = validator.validate(definition, value);
    assert.equal(
      violations.length === 0,
      valid,
      `case ${JSON.stringify(name)} expected valid=${valid}, got ${JSON.stringify(violations)}`,
    );
  }
});

test("zod schemas built from the SAME document agree with every fixture case", () => {
  const schemas = zodSchemas(z);
  // The canonical document also carries policy/replica/telemetry defs; the four
  // wire envelopes must always be among them.
  for (const required of [
    "SyncChangeEvent",
    "SyncPullPage",
    "SyncQueuedWrite",
    "SyncWriteAcknowledgement",
  ]) {
    assert.ok(schemas[required], `missing zod schema for ${required}`);
  }
  for (const { name, definition, valid, value } of fixtures.cases) {
    const outcome = schemas[definition].safeParse(value);
    assert.equal(
      outcome.success,
      valid,
      `zod case ${JSON.stringify(name)} expected valid=${valid}${
        outcome.success ? "" : ` (${outcome.error?.issues?.[0]?.message})`
      }`,
    );
  }
});

test("violations carry precise JSON paths for nested failures", () => {
  const violations = validateSyncEnvelope("SyncPullPage", {
    changes: [
      { table: "t", op: "upsert", id: "a", version: 1, row: {}, at_ms: 0 },
      { table: "t", op: "upsert", id: "b", version: -2, row: {}, at_ms: 0 },
    ],
    next_cursor: 2,
    has_more: false,
  });
  assert.ok(violations.some((v) => v.path === "$.changes[1].version"), JSON.stringify(violations));
});

test("assertSyncEnvelope returns the value or throws a typed error", () => {
  const ack = { id: "k1", committed_version: 3 };
  assert.equal(assertSyncEnvelope("SyncWriteAcknowledgement", ack), ack);
  assert.throws(
    () => assertSyncEnvelope("SyncWriteAcknowledgement", { id: "k1" }),
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.definition, "SyncWriteAcknowledgement");
      assert.ok(error.violations.length > 0);
      return true;
    },
  );
});

test("unsupported keywords fail closed at load time (validator AND zod factory)", () => {
  const withPattern = { $defs: { X: { type: "string", pattern: "^a" } } };
  assert.throws(() => makeValidator(withPattern), /unsupported keyword "pattern"/);
  assert.throws(() => zodSchemas(z, withPattern), /unsupported keyword "pattern"/);
  assert.throws(() => makeValidator({ $defs: { X: { type: "string", format: "uuid" } } }), /"format"/);
});

test("unknown definitions and cyclic refs are errors, not hangs", () => {
  const validator = makeValidator();
  assert.deepEqual(validator.validate("NoSuchThing", {})[0].path, "$");
  const cyclic = makeValidator({ $defs: { Loop: { $ref: "#/$defs/Loop" } } });
  assert.match(cyclic.validate("Loop", 1)[0].message, /depth/);
});

test("apps can validate their OWN row schemas with the same engine", () => {
  const rowSchema = {
    $defs: {
      ApiKeyRow: {
        type: "object",
        additionalProperties: false,
        required: ["id", "org_id", "version"],
        properties: {
          id: { type: "string", minLength: 1 },
          org_id: { type: "string", minLength: 1 },
          name: { type: ["string", "null"], maxLength: 128 },
          version: { type: "integer", minimum: 0 },
          scopes: { type: "array", items: { type: "string" }, uniqueItems: true },
        },
      },
    },
  };
  const validator = makeValidator(rowSchema);
  assert.deepEqual(
    validator.validate("ApiKeyRow", {
      id: "k1",
      org_id: "o1",
      name: null,
      version: 3,
      scopes: ["read", "write"],
    }),
    [],
  );
  assert.ok(validator.validate("ApiKeyRow", { id: "k1", org_id: "o1", version: 3, scopes: ["a", "a"] }).length > 0);

  const zodRow = zodSchemas(z, rowSchema).ApiKeyRow;
  assert.ok(zodRow.safeParse({ id: "k1", org_id: "o1", version: 0 }).success);
  assert.ok(!zodRow.safeParse({ id: "k1", org_id: "o1", version: -1 }).success);
});

test("the embedded schema document is the canonical one", () => {
  assert.equal(SYNC_SCHEMA.$id, "https://fiducia.cloud/schemas/sync.schema.json");
  const defs = Object.keys(SYNC_SCHEMA.$defs);
  for (const required of [
    "SyncChangeEvent",
    "SyncPullPage",
    "SyncQueuedWrite",
    "SyncWriteAcknowledgement",
  ]) {
    assert.ok(defs.includes(required), `missing canonical def ${required}`);
  }
});
