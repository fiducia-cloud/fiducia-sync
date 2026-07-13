//! Adversarial / totality tests for the reconcile core's PUBLIC API (the same
//! surface the wasm ABI and the server-side reuse call). These pin two claims the
//! README makes: reconcile is *total over any i64 version* (a hostile/stale change
//! can never panic or wedge the engine), and the JSON the core emits is exactly
//! the shape the TS shim (`sdk/src/core.mjs`) parses.

use fiducia_sync_core::{
    on_ack, reconcile, AckOutcome, ChangeEvent, ChangeOp, IgnoreReason, LocalRow, QueuedWrite,
    Reconcile, WriteAck,
};

fn ev(op: ChangeOp, version: i64) -> ChangeEvent {
    ChangeEvent {
        table: "api_keys".into(),
        op,
        id: "k1".into(),
        version,
        row: serde_json::Value::Null,
        at_ms: 0,
    }
}

const EXTREMES: [i64; 6] = [i64::MIN, -1, 0, 1, 100, i64::MAX];

#[test]
fn reconcile_is_total_and_monotone_over_i64_extremes() {
    // No combination of (local, incoming, dirty, op) may panic, and the decision
    // must always agree with the version ordering — the ordering key is the sole
    // arbiter, so a hostile version at either extreme can't wedge the engine.
    for &lv in &EXTREMES {
        for &iv in &EXTREMES {
            for dirty in [false, true] {
                for op in [ChangeOp::Upsert, ChangeOp::Delete] {
                    let local = LocalRow { version: lv, dirty };
                    let decision = reconcile(Some(local), &ev(op, iv));
                    if iv < lv {
                        assert_eq!(decision, Reconcile::Ignore(IgnoreReason::Stale), "iv<lv stale");
                    } else if iv == lv {
                        assert_eq!(
                            decision,
                            Reconcile::Ignore(IgnoreReason::AlreadyApplied),
                            "iv==lv already-applied"
                        );
                    } else if dirty {
                        assert_eq!(decision, Reconcile::Conflict, "newer over dirty = conflict");
                    } else {
                        assert_eq!(decision, Reconcile::Apply, "newer over clean = apply");
                    }
                }
            }
        }
    }
}

#[test]
fn no_local_row_adopts_upsert_ignores_delete_at_any_version() {
    for &iv in &EXTREMES {
        assert_eq!(reconcile(None, &ev(ChangeOp::Upsert, iv)), Reconcile::Apply);
        assert_eq!(
            reconcile(None, &ev(ChangeOp::Delete, iv)),
            Reconcile::Ignore(IgnoreReason::AlreadyApplied)
        );
    }
}

#[test]
fn echo_detection_saturates_and_never_overflows_at_i64_max() {
    // expected_version() = base_version + 1 must NOT overflow-panic at i64::MAX
    // (the crate uses saturating_add). A hostile ChangeEvent claiming version
    // i64::MAX must be classifiable without wedging.
    let queued = QueuedWrite {
        id: "k1".into(),
        table: "api_keys".into(),
        op: ChangeOp::Upsert,
        payload: serde_json::Value::Null,
        base_version: i64::MAX,
    };
    assert_eq!(queued.expected_version(), i64::MAX, "saturates, no overflow panic");
    // is_echo_of over the extremes never panics.
    for &iv in &EXTREMES {
        let _ = queued.is_echo_of(&ev(ChangeOp::Upsert, iv));
    }
    // A normal base still detects its echo precisely.
    let q2 = QueuedWrite { base_version: 5, ..queued };
    assert!(q2.is_echo_of(&ev(ChangeOp::Upsert, 6)));
    assert!(!q2.is_echo_of(&ev(ChangeOp::Upsert, 7)));
}

#[test]
fn on_ack_is_total_at_extremes() {
    for &lv in &EXTREMES {
        for &cv in &EXTREMES {
            let outcome = on_ack(LocalRow { version: lv, dirty: true }, &WriteAck { id: "k1".into(), committed_version: cv });
            if lv <= cv {
                assert_eq!(outcome, AckOutcome::Adopt(cv));
            } else {
                assert_eq!(outcome, AckOutcome::Superseded);
            }
        }
    }
}

#[test]
fn json_wire_shapes_match_the_ts_shim_contract() {
    // sdk/src/core.mjs parses these exact shapes. If an enum's serde repr drifts,
    // the browser silently mis-reconciles — pin it here.
    let apply = serde_json::to_string(&reconcile(None, &ev(ChangeOp::Upsert, 1))).unwrap();
    assert_eq!(apply, "\"Apply\"");

    let stale = serde_json::to_string(&reconcile(
        Some(LocalRow { version: 5, dirty: false }),
        &ev(ChangeOp::Upsert, 4),
    ))
    .unwrap();
    assert_eq!(stale, "{\"Ignore\":\"Stale\"}");

    let conflict = serde_json::to_string(&reconcile(
        Some(LocalRow { version: 5, dirty: true }),
        &ev(ChangeOp::Upsert, 6),
    ))
    .unwrap();
    assert_eq!(conflict, "\"Conflict\"");

    let adopt = serde_json::to_string(&on_ack(
        LocalRow { version: 5, dirty: true },
        &WriteAck { id: "k1".into(), committed_version: 6 },
    ))
    .unwrap();
    assert_eq!(adopt, "{\"Adopt\":6}");

    let superseded = serde_json::to_string(&on_ack(
        LocalRow { version: 9, dirty: false },
        &WriteAck { id: "k1".into(), committed_version: 6 },
    ))
    .unwrap();
    assert_eq!(superseded, "\"Superseded\"");

    // The ChangeEvent envelope round-trips (lowercase op) at an extreme version.
    let wire = r#"{"table":"api_keys","op":"delete","id":"k1","version":9223372036854775807}"#;
    let decoded: ChangeEvent = serde_json::from_str(wire).unwrap();
    assert_eq!(decoded.op, ChangeOp::Delete);
    assert_eq!(decoded.version, i64::MAX);
    assert!(serde_json::to_string(&decoded).unwrap().contains("\"op\":\"delete\""));
}
