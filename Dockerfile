# CI/reproducible container that builds and runs the native `cargo test` suite
# for fiducia-sync-core (no wasm/browser toolchain).
FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073
ENV HOME=/tmp \
    CARGO_HOME=/tmp/cargo
WORKDIR /workspace
RUN install -d -o 65532 -g 65532 /tmp/cargo \
    && chown 65532:65532 /workspace
COPY --chown=65532:65532 Cargo.toml Cargo.lock ./
COPY --chown=65532:65532 src ./src
# The canonical schema + shared fixtures are compiled into the crate
# (include_str!) and consumed by the integration tests.
COPY --chown=65532:65532 schema ./schema
COPY --chown=65532:65532 tests ./tests
# Workspace member: the SeaORM adapter (its live-Postgres integration test
# self-skips without TEST_DATABASE_URL).
COPY --chown=65532:65532 crates ./crates
USER 65532:65532
RUN cargo test --workspace --locked
CMD ["cargo", "test", "--workspace", "--locked"]
