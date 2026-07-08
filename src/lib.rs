//! `fiducia-sync-core` — the transport-agnostic heart of the local-first sync
//! engine behind the `@fiducia/sync` SDK.
//!
//! This crate owns only the *correctness-critical logic* — version-based
//! reconciliation, conflict policy, and the optimistic write-queue ack rules —
//! with zero IO. It compiles:
//!   - **native** for `cargo test` and server-side reuse (the Rust backends can
//!     depend on it so client and server agree on the sync protocol), and
//!   - **wasm** (feature `wasm`) for the browser, wrapped by a thin TS shim that
//!     owns IndexedDB, the Supabase-realtime + backend-WS transports, and the
//!     HTMX-optimistic extension.
//!
//! Ordering key: every synced Postgres row carries a monotonic `version`
//! (bumped by the `bump_row_version` trigger in fiducia-interfaces). Reconcile
//! decisions use `version` alone, so the two transports can deliver the same
//! change in any order and converge.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// Browser bindings (JSON string in/out) — only compiled for the wasm build so
// native `cargo test` stays free of wasm-bindgen. See src/wasm.rs.
#[cfg(feature = "wasm")]
mod wasm;

/// Whether a change puts the row or removes it. Insert/Update collapse into
/// `Upsert` — the monotonic `version` disambiguates ordering, so callers never
/// distinguish first-write from later-write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOp {
    Upsert,
    Delete,
}

/// One committed change, decoded from EITHER transport (Supabase realtime or the
/// backend WS/SSE). `version` is the row's monotonic counter from Postgres and is
/// the sole ordering key. This is the shared envelope the server emits and the TS
/// row types mirror.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub table: String,
    pub op: ChangeOp,
    pub id: String,
    pub version: i64,
    #[serde(default)]
    pub row: Value,
    #[serde(default)]
    pub at_ms: i64,
}

/// The sync-relevant metadata a caller holds for a row in IndexedDB. `dirty` is
/// true when the local copy has an un-acked optimistic write on top of `version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalRow {
    pub version: i64,
    pub dirty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IgnoreReason {
    /// Incoming is older than what we hold.
    Stale,
    /// Incoming is exactly what we already hold.
    AlreadyApplied,
}

/// What to do with an incoming change given the local row (if any).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Reconcile {
    /// Write the incoming change to the local store and mark the row clean.
    Apply,
    /// Do nothing — we already hold this version or a newer one.
    Ignore(IgnoreReason),
    /// Local has an un-acked optimistic edit AND the server advanced past it.
    /// Resolve via [`resolve_conflict`] (default: server wins). NB: an echo of
    /// our OWN in-flight write is not a real conflict — callers should match it
    /// against the write-queue via [`QueuedWrite::expected_version`] first.
    Conflict,
}

/// Decide how an incoming change reconciles against the local row (if any).
pub fn reconcile(local: Option<LocalRow>, incoming: &ChangeEvent) -> Reconcile {
    match local {
        None => match incoming.op {
            // Nothing local: adopt an upsert; a delete is a no-op.
            ChangeOp::Upsert => Reconcile::Apply,
            ChangeOp::Delete => Reconcile::Ignore(IgnoreReason::AlreadyApplied),
        },
        Some(l) => {
            if incoming.version < l.version {
                Reconcile::Ignore(IgnoreReason::Stale)
            } else if incoming.version == l.version {
                Reconcile::Ignore(IgnoreReason::AlreadyApplied)
            } else if l.dirty {
                Reconcile::Conflict
            } else {
                Reconcile::Apply
            }
        }
    }
}

/// Conflict resolution policy. `ServerWins` (last-writer-wins by version) is the
/// default; `ClientWins` keeps the local optimistic edit to be re-sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    ServerWins,
    ClientWins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// Drop the local optimistic edit; apply the server change and clear dirty.
    ApplyServer,
    /// Keep the local edit (still dirty); it will be re-sent.
    KeepLocal,
}

pub fn resolve_conflict(policy: ConflictPolicy) -> Resolution {
    match policy {
        ConflictPolicy::ServerWins => Resolution::ApplyServer,
        ConflictPolicy::ClientWins => Resolution::KeepLocal,
    }
}

/// An optimistic write queued locally until the server acks it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedWrite {
    pub id: String,
    pub table: String,
    pub op: ChangeOp,
    #[serde(default)]
    pub payload: Value,
    /// The row version this write was made on top of (for conflict + echo detection).
    pub base_version: i64,
}

impl QueuedWrite {
    /// The row version the server will assign when it commits this write — used
    /// to recognize the change-event echo of our own write (not a conflict).
    pub fn expected_version(&self) -> i64 {
        self.base_version + 1
    }

    /// True if `incoming` is the realtime echo of this queued write.
    pub fn is_echo_of(&self, incoming: &ChangeEvent) -> bool {
        incoming.id == self.id && incoming.version == self.expected_version()
    }
}

/// Server confirmation of a queued write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteAck {
    pub id: String,
    pub committed_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckOutcome {
    /// Adopt `committed_version` and clear dirty — our write is the latest.
    Adopt(i64),
    /// A newer change already landed locally; the ack is stale, keep what we have.
    Superseded,
}

/// Reconcile a server ack for one of our optimistic writes against local state.
pub fn on_ack(local: LocalRow, ack: &WriteAck) -> AckOutcome {
    if local.version <= ack.committed_version {
        AckOutcome::Adopt(ack.committed_version)
    } else {
        AckOutcome::Superseded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(op: ChangeOp, version: i64) -> ChangeEvent {
        ChangeEvent {
            table: "api_keys".into(),
            op,
            id: "k1".into(),
            version,
            row: json!({ "name": "prod" }),
            at_ms: 1000,
        }
    }

    #[test]
    fn no_local_upsert_applies_delete_noops() {
        assert_eq!(reconcile(None, &ev(ChangeOp::Upsert, 5)), Reconcile::Apply);
        assert_eq!(
            reconcile(None, &ev(ChangeOp::Delete, 5)),
            Reconcile::Ignore(IgnoreReason::AlreadyApplied)
        );
    }

    #[test]
    fn stale_and_duplicate_are_ignored() {
        let local = LocalRow { version: 5, dirty: false };
        assert_eq!(
            reconcile(Some(local), &ev(ChangeOp::Upsert, 4)),
            Reconcile::Ignore(IgnoreReason::Stale)
        );
        assert_eq!(
            reconcile(Some(local), &ev(ChangeOp::Upsert, 5)),
            Reconcile::Ignore(IgnoreReason::AlreadyApplied)
        );
    }

    #[test]
    fn newer_clean_applies_newer_dirty_conflicts() {
        assert_eq!(
            reconcile(Some(LocalRow { version: 5, dirty: false }), &ev(ChangeOp::Upsert, 6)),
            Reconcile::Apply
        );
        assert_eq!(
            reconcile(Some(LocalRow { version: 5, dirty: true }), &ev(ChangeOp::Upsert, 6)),
            Reconcile::Conflict
        );
    }

    #[test]
    fn conflict_policy_resolves() {
        assert_eq!(resolve_conflict(ConflictPolicy::ServerWins), Resolution::ApplyServer);
        assert_eq!(resolve_conflict(ConflictPolicy::ClientWins), Resolution::KeepLocal);
    }

    #[test]
    fn own_echo_is_recognized_not_a_conflict() {
        let queued = QueuedWrite {
            id: "k1".into(),
            table: "api_keys".into(),
            op: ChangeOp::Upsert,
            payload: json!({ "name": "prod" }),
            base_version: 5,
        };
        assert_eq!(queued.expected_version(), 6);
        assert!(queued.is_echo_of(&ev(ChangeOp::Upsert, 6))); // our own commit echoing back
        assert!(!queued.is_echo_of(&ev(ChangeOp::Upsert, 7))); // someone else's later change
    }

    #[test]
    fn ack_adopts_or_is_superseded() {
        let ack = WriteAck { id: "k1".into(), committed_version: 6 };
        assert_eq!(on_ack(LocalRow { version: 5, dirty: true }, &ack), AckOutcome::Adopt(6));
        assert_eq!(on_ack(LocalRow { version: 6, dirty: false }, &ack), AckOutcome::Adopt(6));
        assert_eq!(on_ack(LocalRow { version: 7, dirty: false }, &ack), AckOutcome::Superseded);
    }

    #[test]
    fn change_event_deserializes_from_the_wire_envelope() {
        let wire = r#"{"table":"api_keys","op":"upsert","id":"k1","version":9,"row":{"name":"x"},"at_ms":42}"#;
        let ev: ChangeEvent = serde_json::from_str(wire).unwrap();
        assert_eq!(ev.op, ChangeOp::Upsert);
        assert_eq!(ev.version, 9);
        assert_eq!(ev.row["name"], "x");
        // round-trips back to the same lowercase-op shape the TS shim expects
        assert!(serde_json::to_string(&ev).unwrap().contains("\"op\":\"upsert\""));
    }
}
