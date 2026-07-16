# JSONB merge semantics — audit, hardening, and comparison

How `@fiducia/sync` handles **partial updates to rows and their nested `jsonb`
columns** (`params`, `meta`, `scopes`, `customer_preferences`), why it behaves the
way it does, how it compares to established solutions, and what is deliberately out
of scope.

## The problem

A partial optimistic write — e.g. the htmx form path, which builds a row from only
its changed fields (`{ id, ...formFields }`) — must not clobber the fields it does
not mention, and especially not a *sibling key* of a nested `jsonb` object. Naive
whole-row replacement drops them.

## What we do

`client.optimisticPatch(table, id, patch, send)`:

1. **Local**: `deepMerge(existingRow, patch)` (see `sdk/src/merge.mjs`) and store the
   result, dirty — so the UI updates instantly with siblings intact.
2. **Wire**: send the **merged whole value** (not the bare patch). The backends
   `COALESCE` a column wholesale, so a bare partial `jsonb` would clobber siblings
   *server-side* and its authoritative echo would then overwrite the local merge.
   Sending the merged value keeps client and server consistent.
3. **Reconcile**: the server's committed row (whole) is authoritative and replaces
   the optimistic row on echo — so any imperfect local merge self-heals.

`optimisticWrite` still does whole-row replace; merge is opt-in via `optimisticPatch`
(the htmx extension uses it).

### `deepMerge` semantics (deliberate)

| Case | Behavior | Rationale / standard |
|---|---|---|
| plain object ⊕ plain object | recurse key-by-key | field-level preservation |
| array | **replace** | matches RFC 7386 (a list is *set*, not concatenated — union would silently re-add a removed scope) |
| scalar / mismatched types / Date/Map/class | **replace** | opaque to a JSON merge; would round-trip through `jsonb` as a scalar anyway |
| `undefined` in patch | **skip** (keep base) | a patch never erases by omission |
| `null` in patch | **set to null** | **divergence from RFC 7386**, which *deletes* the key. We operate over DB rows/columns where "set this column/field to `null`" is a needed operation; deletion is a delete write, not a merge. |
| pure | new value returned; inputs never mutated | safe to reuse the stored row |

## Hardening (this audit)

- **Prototype pollution (was present, now fixed).** `__proto__`, `constructor`, and
  `prototype` patch keys — which arrive as *own enumerable* keys from `JSON.parse`
  — are skipped unconditionally. This is the exact class of bug behind
  **lodash CVE-2019-10744** (`merge`/`defaultsDeep` walking `{__proto__:…}` /
  `{constructor:{prototype:…}}` into `Object.prototype`). Verified: a hostile patch
  neither pollutes the global prototype nor the merged object.
- **Recursion depth / DoS (was present, now fixed).** Naive recursion overflowed
  the stack at ~20k nesting. Capped at depth 64 (legit `jsonb` is shallow; beyond
  the cap the patch replaces), so a pathological/hostile document can't crash the
  merge.
- **Opaque objects.** Non-plain objects (Date, Map, class instances) replace rather
  than being half-merged into a corrupt shape.

Covered by `sdk/tests/jsonb.test.mjs` (10) + `sdk/tests/jsonb-hardening.test.mjs` (9).

## Comparison with public solutions

| Approach | Partial update | Nested merge | Concurrency model | Notes |
|---|---|---|---|---|
| **RFC 7386 JSON Merge Patch** | patch mirrors doc | recurse; arrays replace | none (it's a format) | `null` **deletes**; can't set a key to null. We follow it except on `null`. |
| **RFC 6902 JSON Patch** | op list (`replace`/`test`/…) | path-addressed | `test` op → optimistic concurrency | more precise (array-index ops); heavier wire format. |
| **Postgres `jsonb ||`** | in-DB | **shallow only** — nested keys clobber | ACID under row lock | needs a recursive function for deep merge (Hootsuite/lobocv gists). |
| **Firestore** | per-field | field paths | **per-field LWW** — different fields don't conflict | the gold standard we don't fully reach. |
| **Automerge / Yjs (CRDT)** | op-based | automatic | conflict-free, field/char-level | strongest merge; heaviest runtime + model. |
| **Replicache / RxDB** | mutators / conflict handler | app-defined | server-authoritative; client conflict handler | rebase / reject-stale patterns. |
| **`@fiducia/sync` (this)** | `optimisticPatch` | `deepMerge` (recursive, arrays replace) | **row-level (document) LWW** by `version` | correct single-client; see limitation below. |

## Known limitation — concurrency (F4, not yet fixed)

Our conflict model is **row-level last-writer-wins** by the monotonic `version`.
Because `optimisticPatch` sends the *whole merged value* and the backend
`COALESCE`-replaces the column, **two clients editing different keys of the same
row's `jsonb` concurrently can lose one edit** (the later writer's merge was
computed from a stale view). This is document-LWW, not the per-field LWW that
Firestore gives.

**Recommended fix** (a coordinated backend change, deliberately not done in this
client-only pass): move the merge server-side and send the *partial patch* —

- apply it under the row lock as a **recursive `jsonb` deep-merge** (a `||`-style
  shallow merge is not enough for nested objects), so concurrent partial patches
  each merge into the current committed value (ACID → no lost update); and/or
- add **optimistic-concurrency**: reject a write whose `base_version` ≠ the current
  row version (compare-and-swap), so a stale writer re-hydrates and retries instead
  of silently overwriting (the RxDB master-state-rejection pattern).

Until then, `optimisticPatch` is correct for the common single-editor case and for
disjoint rows; concurrent same-row `jsonb`-key edits are the caveat.

## Sources

- lodash CVE-2019-10744 — https://github.com/advisories/GHSA-jf85-cpcp-j695
- RFC 7386 JSON Merge Patch — https://datatracker.ietf.org/doc/html/rfc7386
- RFC 6902 JSON Patch — https://datatracker.ietf.org/doc/html/rfc6902
- Recursively merging JSONB in PostgreSQL — https://blog.lobocv.com/posts/recursive_jsonb_merge/
- RxDB conflict handling — https://rxdb.info/transactions-conflicts-revisions.html
- Replicache how-it-works — https://doc.replicache.dev/concepts/how-it-works
