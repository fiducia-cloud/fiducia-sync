# workflows

GitHub Actions CI for fiducia-sync.

`ci.yml` runs on pushes to `main`, PRs, and manual dispatch. It has two jobs that
mirror the repo's two build targets from the one Rust crate:

- **core** — native `cargo test --locked` of the transport-agnostic
  `fiducia-sync-core`, plus Clippy and an exact cargo-audit tool.
- **sdk** — builds the node-target wasm with an exact wasm-pack version and a
  locked Cargo graph, then installs SDK dependencies from `package-lock.json`
  and runs the JS suite against it.
