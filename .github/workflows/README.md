# workflows

GitHub Actions CI for fiducia-sync.

`ci.yml` runs on pushes to `main`, PRs, and manual dispatch. It has two jobs that
mirror the repo's two build targets from the one Rust crate:

- **core** — native `cargo test` of the transport-agnostic `fiducia-sync-core`.
- **sdk** — builds the node-target wasm (`wasm-pack build --target nodejs`) from
  the same crate, then runs the JS SDK's `node --test` suite against it, so the
  browser SDK and the Rust core stay in sync.
