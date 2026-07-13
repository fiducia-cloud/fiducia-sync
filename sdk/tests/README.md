# tests

`node --test` suites for the JS SDK. The client/reconcile tests import the REAL
node-target wasm core (built by `wasm-pack build --target nodejs --out-dir
pkg-node`), so there is one source of truth for the sync logic across Rust and JS.
IndexedDB and sockets are faked (`fake-indexeddb`, injected WS/SSE/timer impls),
so nothing here needs a browser or a live server.

- `client.test.mjs` — reconcile client against the real wasm core, including
  token-aware own-echo suppression and observable durable flush failures.
- `store.test.mjs` — IndexedDB store, schema upgrades, durable write-queue, and
  atomic mutation/queue transitions.
- `backend.test.mjs` — backend WS/SSE transport, reconnect, credential placement,
  fail-closed auth, CSRF, and write path.
- `transports.test.mjs` — pure decoders and the htmx optimistic-intent parser.
- `adversarial.test.mjs` — convergence under duplicate/out-of-order delivery,
  keyed echo collisions, multi-write races, hydration, and schema upgrades.
