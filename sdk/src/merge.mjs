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

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} base   the value already held (e.g. the stored row)
 * @param {unknown} patch  the incoming (possibly partial) value
 * @returns {unknown} base with patch deeply applied
 */
export function deepMerge(base, patch) {
  // Only two plain objects merge; anything else means the patch wins outright
  // (except `undefined`, which leaves the base untouched).
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (next === undefined) continue; // never overwrite with undefined
    out[key] =
      isPlainObject(next) && isPlainObject(out[key]) ? deepMerge(out[key], next) : next;
  }
  return out;
}

export { isPlainObject };
