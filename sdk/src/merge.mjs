// deepMerge — the JSONB-aware merge used to fold a PARTIAL optimistic write into
// the row already held locally, so a patch that touches one field (or one key of
// a nested `jsonb` object like `params`/`meta`/`preferences`) never clobbers its
// siblings. The queued PAYLOAD stays the partial patch (the server COALESCEs it);
// only the local optimistic row is merged, and the server's echo remains the
// authoritative whole-row truth on reconcile — so an imperfect merge self-heals.
//
// Semantics, chosen deliberately for row/JSONB data (not a generic deep-merge):
//   - plain objects RECURSE key-by-key;
//   - arrays REPLACE wholesale (a `scopes` list is set, not concatenated — union
//     would silently re-add a removed scope);
//   - scalars / class instances / mismatched types REPLACE;
//   - `undefined` in the patch is SKIPPED (a patch never erases by omission);
//   - `null` in the patch REPLACES (the explicit way to clear a field).
// Pure: neither argument is mutated; a new value is returned.

// Keys that, if merged, could poison an object's prototype chain. Skipped
// unconditionally — this is the class of bug behind the lodash prototype-pollution
// CVE (CVE-2019-10744): a hostile `{"__proto__": {...}}` or
// `{"constructor": {"prototype": {...}}}` (both arrive as OWN enumerable keys from
// JSON.parse) must never be walked into the target's prototype.
const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Legitimate row / jsonb data is shallow; only corrupt or hostile input reaches
// deep nesting. Cap the recursion so a pathologically deep object can't overflow
// the stack (a DoS) — beyond the cap the patch value simply replaces wholesale.
const MAX_DEPTH = 64;

// A "plain object" is a mergeable JSON object: not null, not an array, and with a
// bare Object/`null` prototype. Dates, Maps, class instances, etc. are opaque and
// REPLACE rather than merge (matching how they'd round-trip through jsonb anyway).
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merge `patch` into `base`, returning a NEW value (inputs untouched).
 *
 * Semantics (see the file header): plain objects recurse; arrays / scalars /
 * mismatched types / non-plain objects REPLACE; `undefined` in the patch is
 * skipped; `null` in the patch REPLACES (sets the field to null). This last point
 * is a DELIBERATE divergence from RFC 7386 JSON Merge Patch, where `null` DELETES
 * the key — we operate over DB rows/columns where "set this column/field to null"
 * is a real, needed operation, and deletion is expressed by a delete write, not a
 * merge. Arrays-replace matches RFC 7386.
 *
 * @param {unknown} base   the value already held (e.g. the stored row)
 * @param {unknown} patch  the incoming (possibly partial) value
 * @returns {unknown} base with patch deeply applied
 */
export function deepMerge(base, patch) {
  return mergeInto(base, patch, 0);
}

function mergeInto(base, patch, depth) {
  // Only two plain objects merge; anything else means the patch wins outright
  // (except `undefined`, which leaves the base untouched). Past the depth cap we
  // also stop recursing and let the patch replace, so nesting can't overflow.
  if (!isPlainObject(base) || !isPlainObject(patch) || depth >= MAX_DEPTH) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (POLLUTING_KEYS.has(key)) continue; // never merge prototype-polluting keys
    const next = patch[key];
    if (next === undefined) continue; // never overwrite with undefined
    out[key] =
      isPlainObject(next) && isPlainObject(out[key])
        ? mergeInto(out[key], next, depth + 1)
        : next;
  }
  return out;
}

export { isPlainObject };
