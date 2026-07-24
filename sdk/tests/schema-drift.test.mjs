// Drift guards for the vendored schema, mirroring fiducia-interfaces' own
// pg-defs pattern: (1) the generated embeds must match what the generator
// produces from schema/sync.schema.json; (2) the vendored copy must stay
// byte-identical to the canonical fiducia-interfaces file when that sibling
// checkout is present (soft-skips otherwise, e.g. in CI without siblings).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../scripts/embed-sync-schema.mjs";

test("generated embeds (sync-schema.mjs, sync_schema.dart) match the generator", () => {
  for (const { path, content } of generate()) {
    assert.equal(
      readFileSync(path, "utf8"),
      content,
      `${path} drifted — run: node sdk/scripts/embed-sync-schema.mjs`,
    );
  }
});

test("vendored schema matches the canonical fiducia-interfaces copy (soft)", (t) => {
  const vendored = fileURLToPath(new URL("../../schema/sync.schema.json", import.meta.url));
  const canonical = fileURLToPath(
    new URL("../../../fiducia-interfaces/schema/sync.schema.json", import.meta.url),
  );
  if (!existsSync(canonical)) {
    t.skip("fiducia-interfaces sibling checkout not present");
    return;
  }
  assert.equal(
    readFileSync(vendored, "utf8"),
    readFileSync(canonical, "utf8"),
    "schema/sync.schema.json drifted from fiducia-interfaces/schema/sync.schema.json — re-copy the canonical file and regenerate the embeds",
  );
});
