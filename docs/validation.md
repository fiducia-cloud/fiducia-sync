# One schema, every runtime: cross-language validation

The wire contract for sync — `SyncChangeEvent`, `SyncQueuedWrite`,
`SyncWriteAcknowledgement`, `SyncPullPage` — is defined ONCE, as JSON Schema,
in `fiducia-interfaces/schema/sync.schema.json`. This repo vendors a
byte-identical copy at `schema/sync.schema.json` and derives every runtime
artifact from it, so TypeScript, Rust, and Dart all validate with the same
rules and cannot drift from each other:

```
fiducia-interfaces/schema/sync.schema.json     (canonical, upstream)
   │  vendored byte-identical (soft drift test vs the sibling checkout)
   ▼
schema/sync.schema.json
   ├── include_str! → src/schema.rs            Rust:  SchemaValidator::sync()
   ├── generated    → langs/typescript/src/sync-schema.mjs  TS/JS: makeValidator(), zodSchemas(z)
   └── generated    → langs/dart/lib/src/sync_schema.dart  Dart: SchemaValidator.sync()
schema/fixtures/sync-envelopes.json            shared valid/invalid cases —
                                               all three test suites run them
schema/fixtures/hlc-vectors.json               shared HLC replay vectors
```

Regenerate the embeds after updating the vendored schema:

```sh
node langs/typescript/scripts/embed-sync-schema.mjs          # write
node langs/typescript/scripts/embed-sync-schema.mjs --check  # drift gate (also run by npm test)
```

## The subset engine (fails closed)

All three validators interpret the same JSON Schema subset: `type` (including
`["T","null"]`), `enum`/`const`, object `required`/`properties`/
`additionalProperties`, string/number bounds, array `items`/bounds/
`uniqueItems`, `$ref` into `#/$defs/…`, and `anyOf`/`oneOf`/`allOf`/`not`.
A schema using anything else (say `pattern` or `format`) is **rejected at load
time** — the engine fails closed instead of silently under-validating. The
subset covers every keyword the fiducia-interfaces schemas use today.

Violations carry JSON paths (`$.changes[1].version: number violates minimum`),
and all three implementations are pinned to `schema/fixtures/` so a payload
accepted on one runtime is accepted on all of them.

## Per-language use

**TypeScript/JS** (`@fiducia/sync/validate`, zero runtime deps):

```js
import { assertSyncEnvelope, makeValidator } from "@fiducia/sync/validate";
assertSyncEnvelope("SyncChangeEvent", event);       // throws with paths

// Zod, using YOUR zod instance (the SDK adds no dependency):
import { z } from "zod";
import { zodSchemas } from "@fiducia/sync/validate";
const S = zodSchemas(z);
S.SyncQueuedWrite.parse(write);                     // real z.* schemas
```

**Rust** (`fiducia-sync-core`):

```rust
use fiducia_sync_core::SchemaValidator;
let validator = SchemaValidator::sync()?;
validator.validate("SyncPullPage", &value)?;        // Err(Vec<SchemaViolation>)
```

**Dart/Flutter** (`fiducia_sync`):

```dart
final validator = SchemaValidator.sync();
validator.check('SyncWriteAcknowledgement', json);  // throws with paths
```

## Validating your own row/ORM shapes

The engine is generic: hand `makeValidator(yourSchemaDocument)` (JS),
`SchemaValidator::from_json(...)` (Rust), or `SchemaValidator(yourDocument)`
(Dart) any document that keeps to the subset — e.g. a JSON Schema for a
database row type — and validate ORM objects and I/O blobs with the same
engine and the same failure shape. `zodSchemas(z, yourDocument)` does the same
for Zod. The generated row interfaces stay in `fiducia-interfaces`
(`generated/typescript/db/…`, `fiducia-interfaces-db`); when you want runtime
checks for one of those shapes, write its JSON Schema next to your app (or
upstream it into `fiducia-interfaces/schema/`) and feed it to these engines
unchanged.

## Why not ajv / jsonschema-rs / a Dart validator package?

The repo rule is zero runtime dependencies in the SDKs (a security and
supply-chain stance: this code runs in every browser session and mobile app).
The subset interpreter is ~250 lines per language, fully pinned by shared
fixtures, and fails closed — while full-draft libraries differ subtly across
languages in exactly the corners (unicode lengths, integer semantics,
`additionalProperties` interplay) that cause cross-runtime drift.
