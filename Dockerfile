FROM rust:1.85-bookworm
WORKDIR /workspace
COPY Cargo.toml ./
COPY src ./src
RUN cargo test
CMD ["cargo", "test"]
