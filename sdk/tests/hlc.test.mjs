// Hybrid Logical Clock: the JS mirror must replay the SAME shared vectors as
// the Rust core (tests/shared_fixtures.rs) and the Dart package, and its state
// must persist durably through the store so stamps survive reloads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeHlc, encodeHlc, decodeHlc, HLC_MAX_COUNTER } from "../src/hlc.mjs";

const vectors = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/hlc-vectors.json", import.meta.url), "utf8"),
);

test("shared cross-language vectors replay identically", () => {
  for (const { name, start, steps } of vectors.cases) {
    let currentNow = 0;
    const clock = makeHlc({
      state: { wallMs: start.wall_ms, counter: start.counter },
      now: () => currentNow,
    });
    steps.forEach((step, index) => {
      currentNow = step.now_ms;
      const stamp = step.op === "tick" ? clock.tick() : clock.observe(step.remote_ms);
      assert.equal(stamp.encoded, step.expect, `${name} step ${index}`);
    });
  }
});

test("stamps are strictly monotonic under a regressing wall clock", () => {
  let currentNow = 1_000;
  const clock = makeHlc({ now: () => currentNow });
  let previous = clock.tick().encoded;
  for (const nextNow of [1_000, 999, 0, -50, 1_000, 1_001, 500]) {
    currentNow = nextNow;
    const stamp = clock.tick().encoded;
    assert.ok(stamp > previous, `${stamp} must sort after ${previous}`);
    previous = stamp;
  }
});

test("encode/decode round-trip; lexicographic order equals causal order", () => {
  const stamps = [
    { wallMs: 0, counter: 0 },
    { wallMs: 0, counter: 1 },
    { wallMs: 1, counter: 0 },
    { wallMs: 1_720_000_000_000, counter: 3 },
  ];
  const encoded = stamps.map(encodeHlc);
  assert.deepEqual([...encoded].sort(), encoded);
  for (const stamp of stamps) {
    assert.deepEqual(decodeHlc(encodeHlc(stamp)), stamp);
  }
  for (const bad of ["", "0197F3B2C4D1-0003", "0197f3b2c4d1_0003", "zz", null, 42]) {
    assert.equal(decodeHlc(bad), null);
  }
});

test("counter overflow rolls the wall forward one millisecond", () => {
  const clock = makeHlc({ state: { wallMs: 2_000, counter: HLC_MAX_COUNTER }, now: () => 1_500 });
  assert.deepEqual(clock.tick(), { wallMs: 2_001, counter: 0, encoded: encodeHlc({ wallMs: 2_001, counter: 0 }) });
});
