# Fiducia Sync Zed package contract

This repository is a polyglot source tree. The root `.zpkg.toml` defines one
coordinated Zed release set and separate artifacts for the Rust core, Postgres
adapter, TypeScript SDK, Flutter/Dart client, SQL migrations, and protocol
schema.

This document covers package validation only. A merged manifest is not evidence
that any registry publication, tag, release, or downstream frozen installation
has occurred.

## Canonical source and version

```text
package:    fiducia/fiducia-sync
version:    0.2.0
repository: https://github.com/fiducia-cloud/fiducia-sync
VCS tag:    v0.2.0
```

The Zed targets are:

| Target | Directory | Zed package |
|---|---|---|
| `rust` | `.` | `fiducia/fiducia-sync-core` |
| `rust-postgres` | `crates/postgres` | `fiducia/fiducia-sync-postgres` |
| `nodejs` | `sdk` | `fiducia/fiducia-sync-sdk` |
| `dart` | `dart` | `fiducia/fiducia-sync-flutter` |
| `sql` | `sql` | `fiducia/fiducia-sync-sql` |
| `schema` | `schema` | `fiducia/fiducia-sync-schema` |

The canonical parser used by CI is `zed-cli` at exact commit:

```text
9b8e5f3d3b98845436899b9a8645f3ce19689f85
```

CI installs that revision with Cargo and runs `zed release plan --json` twice.
The two plans must be byte-identical.

## Native release routes

The release plan validates these isolated native manifests against the root
release-set version:

| Zed target | Registry | Native package | Required version |
|---|---|---|---|
| `nodejs` | npm | `@fiducia/sync` | `0.2.0` |
| `dart` | pub.dev | `fiducia_sync` | `0.2.0` |

The Zed artifact is named `fiducia/fiducia-sync-sdk`; its native npm identity is
`@fiducia/sync`, as declared by `sdk/package.json`. Those are separate package
names serving separate registries and must not be conflated.

The npm route also declares a GitHub Packages mirror of `@fiducia/sync`. This is
plan metadata only; CI does not publish or authenticate to any registry.

### Root Rust native publication is deferred

The Rust core remains a valid Zed target at repository root:

```text
fiducia/fiducia-sync-core@0.2.0  ->  .
```

It deliberately has no `[targets.rust.native]` route. In a polyglot manifest,
a target whose directory is `.` represents the whole source repository rather
than an isolated native package root. The canonical Zed manifest contract
rejects assigning that target to crates.io; root `[publish.native]` is reserved
for single-language packages with no target fan-out.

Before enabling a crates.io route for `fiducia-sync-core`:

1. isolate the core crate beneath its own package directory, or approve a
   separate release architecture that preserves honest artifact boundaries;
2. update workspace paths, include rules, SDK/WASM build paths, and tests;
3. validate the full Rust, Postgres, SDK/WASM, and Zed release-plan suites;
4. add the native route only after the isolated Cargo manifest is authoritative;
5. publish only through the approved coordinated release workflow.

This PR does not move the crate merely to satisfy metadata. Preserving the
working repository layout is safer than claiming that the whole repository is a
single crates.io package.

### Postgres native publication is deferred

`crates/postgres/Cargo.toml` currently declares:

```text
fiducia-sync-postgres 0.1.0
```

The Postgres source is included as the Zed target
`fiducia/fiducia-sync-postgres@0.2.0`, but `.zpkg.toml` deliberately omits a
`[targets.rust-postgres.native]` route. Claiming a crates.io `0.2.0` release while
the native manifest remains `0.1.0` would be false.

Before enabling the native route:

1. decide whether the Postgres crate is ready for `0.2.0`;
2. update its Cargo manifest and `Cargo.lock` through a reviewed PR;
3. run the complete Rust/Postgres test suite;
4. add the native route;
5. verify the canonical release plan contains the matching crates.io artifact;
6. publish only through the approved coordinated release workflow.

## Lockfile invariant

The authored Zed manifest currently has no `[dependencies]` or
`[build-dependencies]`. Therefore `.zpkg.lock` intentionally contains only:

```toml
version = 1
```

This is not a placeholder dependency lock. The repository contract test requires
all of the following at once:

- no Zed dependency tables in `.zpkg.toml`;
- lock format version `1`;
- no `[[package]]` entries;
- no source, checksum, or Git dependency records.

If a Zed dependency is added, the same PR must regenerate and review the lock
with the canonical resolver. Handwritten package entries and an empty lock beside
a nonempty dependency table both fail CI.

Native Cargo, npm, and Dart dependency locks remain owned by their native
toolchains and are separate from `.zpkg.lock`.

## Cargo audit reachability boundary

The workspace lock currently records optional `rust_decimal -> rkyv 0.7.46`
metadata from SeaORM. RustSec flags that `rkyv` release, but Fiducia Sync does
not enable SeaORM's decimal feature. CI therefore generates Cargo metadata for
all workspace features and fails if the vulnerable package appears in the
active resolved graph. Only after that machine-checked non-reachability proof
does the audit command apply the narrowly scoped advisory exception.

If any workspace change activates the affected package, the reachability check
fails before `cargo audit`; the exception cannot silently convert reachable
vulnerable code into a green build. The preferred long-term removal is an
upstream SeaORM/rust_decimal dependency line whose lock metadata no longer
contains the affected `rkyv` release.

## SDK regression fixed with the package work

The existing SDK test for `failure_mode = "emit_only"` supplied
`telemetry = "off"`, which correctly failed the production policy validator:
an emit-only caller with telemetry disabled has no observable failure path.

The test now explicitly uses `telemetry = "errors"`. The production validator
was not weakened. The full SDK/WASM lane must pass before this package contract
can merge.

## Validation

Local static checks:

```sh
node --test tools/zpkg-contract.test.mjs
```

Canonical release-plan validation:

```sh
cargo install \
  --git https://github.com/zed-pkg/zed-cli \
  --rev 9b8e5f3d3b98845436899b9a8645f3ce19689f85 \
  --locked \
  --root /tmp/fiducia-zed-cli

/tmp/fiducia-zed-cli/bin/zed release plan --json
```

The checked plan must contain six Zed artifacts, two native routes, and the
single `@fiducia/sync` GitHub Packages mirror. It must not contain a native route
for either Rust target until each one has an isolated, version-aligned native
package root.

## Publication boundary

This PR and its workflow never run:

- `zed publish`;
- `cargo publish`;
- `npm publish`;
- `dart pub publish`;
- registry login/token commands;
- VCS tag or release mutation.

Publication requires a separate release decision, clean exact revision, native
registry credentials from approved secret delivery, successful dry runs, and
post-publication install verification.

## Downstream adoption boundary

The Zed package manifest is independent of the currently blocked Opto-Sync
release adoption in `fiducia-sync#17` and `fiducia-e2e#16`. Those drafts still
require verified published dependencies and byte-identical frozen locks. This
package PR must not be used to bypass that release gate or to hand-author their
locks.
