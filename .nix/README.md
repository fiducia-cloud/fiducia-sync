# .nix

Nix flake defining the reproducible development environment for fiducia-sync.

`flake.nix` declares a dev shell (Rust toolchain + rust-analyzer/clippy/rustfmt,
Node/pnpm, plus git/direnv/just/bacon and pkg-config/openssl) for all common
Linux and macOS systems. `flake.lock` pins the inputs. It is entered via the
repo-root `./shell` script and auto-loaded by direnv through `.envrc`.
