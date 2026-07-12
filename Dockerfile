# CI/reproducible container that builds and runs the native `cargo test` suite
# for fiducia-sync-core (no wasm/browser toolchain).
FROM rust:1.85-bookworm
WORKDIR /workspace
COPY Cargo.toml ./
COPY src ./src
RUN cargo test
CMD ["cargo", "test"]
