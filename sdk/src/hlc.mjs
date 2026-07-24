// Hybrid Logical Clock — the JS mirror of the canonical Rust implementation in
// src/hlc.rs, pinned to the same shared vectors (schema/fixtures/hlc-vectors.json).
//
// Browser wall clocks jump (NTP steps, users editing the clock, suspended
// tabs), so `Date.now()` alone cannot order a device's own offline edits. The
// HLC emits stamps that are strictly monotonic per device and never behind any
// OBSERVED server commit time, while tracking real time whenever the wall
// clock is sane — the CockroachDB timestamp discipline, client-side.
//
// The per-row `version` and plane-wide `sync_sequence` remain the authoritative
// ordering keys; HLC stamps are advisory metadata on locally queued writes and
// are stripped from the strict wire envelopes.
//
// Canonical encoding: 12 lowercase hex digits of Unix-ms + "-" + 4 hex digits
// of the logical counter ("0197f3b2c4d1-0003"). Fixed width makes lexicographic
// order equal causal order — and keeps us clear of 2^53: wall_ms << 16 does NOT
// fit a JS safe integer, which is exactly why the encoding is a string.

export const HLC_MAX_WALL_MS = 2 ** 48 - 1;
export const HLC_MAX_COUNTER = 0xffff;

const clampWall = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), HLC_MAX_WALL_MS);
};

/** Encode a stamp `{wallMs, counter}` into the canonical sortable string. */
export function encodeHlc({ wallMs, counter }) {
  const wall = clampWall(wallMs).toString(16).padStart(12, "0");
  const count = (Math.min(Math.max(counter | 0, 0), HLC_MAX_COUNTER))
    .toString(16)
    .padStart(4, "0");
  return `${wall}-${count}`;
}

/** Decode the canonical encoding; returns null for anything malformed. */
export function decodeHlc(text) {
  if (typeof text !== "string" || !/^[0-9a-f]{12}-[0-9a-f]{4}$/.test(text)) return null;
  return {
    wallMs: Number.parseInt(text.slice(0, 12), 16),
    counter: Number.parseInt(text.slice(13), 16),
  };
}

/**
 * Create a clock. `state` restores a persisted `{wallMs, counter}` (see
 * `store.getHlcState()`); `now` is injectable for tests.
 *
 * `tick()` stamps a local event; `observe(remoteMs)` folds in a server commit
 * time (`ChangeEvent.at_ms`) so later local stamps sort after it. Both return
 * `{wallMs, counter, encoded}`.
 */
export function makeHlc({ state, now = () => Date.now() } = {}) {
  let wallMs = clampWall(state?.wallMs ?? 0);
  let counter = Math.min(Math.max((state?.counter ?? 0) | 0, 0), HLC_MAX_COUNTER);

  const advance = (nextWall, nextCounter) => {
    if (nextCounter > HLC_MAX_COUNTER) {
      // Counter exhausted within one ms: roll the wall forward instead.
      const rolled = clampWall(nextWall + 1);
      wallMs = rolled;
      counter = rolled > nextWall ? 0 : HLC_MAX_COUNTER;
    } else {
      wallMs = nextWall;
      counter = nextCounter;
    }
    return { wallMs, counter, encoded: encodeHlc({ wallMs, counter }) };
  };

  return {
    tick() {
      const wall = clampWall(now());
      return wall > wallMs ? advance(wall, 0) : advance(wallMs, counter + 1);
    },
    observe(remoteMs) {
      const remote = clampWall(remoteMs);
      const wall = Math.max(wallMs, remote, clampWall(now()));
      if (wall === wallMs) return advance(wall, counter + 1);
      // A remote stamp carries no counter on the wire; step strictly past it.
      if (wall === remote) return advance(wall, 1);
      return advance(wall, 0);
    },
    /** The state to persist so stamps stay monotonic across reloads. */
    state() {
      return { wallMs, counter };
    },
  };
}
