# CI/reproducible container that builds and runs the native `cargo test` suite
# for fiducia-sync-core (no wasm/browser toolchain).
FROM rust:1.95.0-bookworm
ENV HOME=/tmp \
    CARGO_HOME=/tmp/cargo
WORKDIR /workspace
RUN install -d -o 65532 -g 65532 /tmp/cargo \
    && chown 65532:65532 /workspace
COPY --chown=65532:65532 Cargo.toml Cargo.lock ./
COPY --chown=65532:65532 src ./src
USER 65532:65532
RUN cargo test --locked
CMD ["cargo", "test", "--locked"]
