use fiducia_sync_core::{
    on_ack, reconcile, AckOutcome, ChangeEvent, ChangeOp, Hlc, LocalRow, QueuedWrite,
    ReconcileAction, StaleReason, WriteAck,
};

const EXTREMES: [i64; 7] = [i64::MIN, -1, 0, 1, i64::MAX - 1, i64::MAX, 42];

fn ev(op: ChangeOp, version: i64) -> ChangeEvent {
    ChangeEvent {
        table: "api_keys".into(),
        op,
        id: "k1".into(),
        version,
    }
}

#[test]
fn clean_rows_follow_remote_truth_at_version_extremes() {
    for &local_version in &EXTREMES {
        for &remote_version in &EXTREMES {
            let local = LocalRow {
                version: local_version,
                dirty: false,
            };
            let got = reconcile(Some(local), &ev(ChangeOp::Upsert, remote_version));
            let expected = if remote_version > local_version {
                ReconcileAction::Apply
            } else if remote_version == local_version {
                ReconcileAction::Ignore(StaleReason::Echo)
            } else {
                ReconcileAction::Ignore(StaleReason::Stale)
            };
            assert_eq!(got, expected, "local={local_version} remote={remote_version}");
        }
    }
}

#[test]
fn dirty_rows_report_newer_remote_changes_as_conflicts() {
    for &local_version in &EXTREMES {
        for &remote_version in &EXTREMES {
            let local = LocalRow {
                version: local_version,
                dirty: true,
            };
            let got = reconcile(Some(local), &ev(ChangeOp::Delete, remote_version));
            let expected = if remote_version > local_version {
                ReconcileAction::Conflict
            } else if remote_version == local_version {
                ReconcileAction::Ignore(StaleReason::Echo)
            } else {
                ReconcileAction::Ignore(StaleReason::Stale)
            };
            assert_eq!(got, expected, "local={local_version} remote={remote_version}");
        }
    }
}

#[test]
fn absent_rows_apply_every_remote_version() {
    for &remote_version in &EXTREMES {
        assert_eq!(
            reconcile(None, &ev(ChangeOp::Delete, remote_version)),
            ReconcileAction::Apply
        );
    }
}

#[test]
fn hlc_round_trip_preserves_negative_and_extreme_components() {
    let logical_values = [0_u32, 1, u32::MAX];
    let node_ids = ["node", "node:with:colons", "", "こんにちは"];
    for &physical_ms in &EXTREMES {
        for &logical in &logical_values {
            for node_id in node_ids {
                let hlc = Hlc {
                    physical_ms,
                    logical,
                    node_id: node_id.into(),
                };
                let encoded = hlc.encode();
                assert_eq!(
                    Hlc::decode(&encoded),
                    Some(hlc),
                    "failed HLC round-trip for {encoded}"
                );
            }
        }
    }
}

#[test]
fn hlc_decode_rejects_malformed_or_out_of_range_values() {
    for malformed in [
        "",
        ":",
        "1:2",
        "not-a-number:2:n",
        "1:not-a-number:n",
        "1:4294967296:n",
        "1:-1:n",
    ] {
        assert_eq!(Hlc::decode(malformed), None, "accepted malformed HLC {malformed:?}");
    }
}

#[test]
fn hlc_ordering_is_lexicographic_without_overflow() {
    let points = [
        Hlc {
            physical_ms: i64::MIN,
            logical: u32::MAX,
            node_id: "z".into(),
        },
        Hlc {
            physical_ms: -1,
            logical: 0,
            node_id: "a".into(),
        },
        Hlc {
            physical_ms: 0,
            logical: 0,
            node_id: "a".into(),
        },
        Hlc {
            physical_ms: i64::MAX,
            logical: u32::MAX,
            node_id: "z".into(),
        },
    ];
    for window in points.windows(2) {
        assert!(window[0] < window[1]);
    }
}

#[test]
fn queued_write_echo_detection_does_not_overflow_at_i64_max() {
    let queued = QueuedWrite {
        table: "api_keys".into(),
        id: "k1".into(),
        base_version: i64::MAX,
        payload: "{}".into(),
    };
    // checked_add returns None: no event can be an echo past i64::MAX.
    for &version in &EXTREMES {
        assert!(!queued.is_echo_of(&ev(ChangeOp::Upsert, version)));
    }
}

#[test]
fn queued_write_identity_and_operation_must_match_for_echo() {
    let queued = QueuedWrite {
        table: "api_keys".into(),
        id: "k1".into(),
        base_version: 5,
        payload: "{}".into(),
    };
    let mut event = ev(ChangeOp::Upsert, 6);
    event.table = "other".into();
    assert!(!queued.is_echo_of(&event));
    event.table = "api_keys".into();
    event.id = "other".into();
    assert!(!queued.is_echo_of(&event));
    event.id = "k1".into();
    event.op = ChangeOp::Delete;
    assert!(!queued.is_echo_of(&event));
}

#[test]
fn queued_write_is_total_at_all_version_extremes() {
    let queued = QueuedWrite {
        table: "api_keys".into(),
        id: "k1".into(),
        base_version: i64::MIN,
        payload: "{}".into(),
    };
    // is_echo_of over the extremes never panics.
    for &iv in &EXTREMES {
        let _ = queued.is_echo_of(&ev(ChangeOp::Upsert, iv));
    }
    // A normal base still detects its echo precisely.
    let q2 = QueuedWrite {
        base_version: 5,
        ..queued
    };
    assert!(q2.is_echo_of(&ev(ChangeOp::Upsert, 6)));
    assert!(!q2.is_echo_of(&ev(ChangeOp::Upsert, 7)));
}

#[test]
fn on_ack_is_total_at_extremes() {
    for &lv in &EXTREMES {
        for &cv in &EXTREMES {
            let outcome = on_ack(
                LocalRow {
                    version: lv,
                    dirty: true,
                },
                &WriteAck {
                    id: "k1".into(),
                    committed_version: cv,
                },
            );
            if lv <= cv {
                assert_eq!(outcome, AckOutcome::Adopt(cv));
            } else {
                assert_eq!(outcome, AckOutcome::Superseded);
            }
        }
    }
}

#[test]
fn json_wire_shapes_match_the_ts_shim_contract() -> Result<(), serde_json::Error> {
    // langs/typescript/src/core.mjs parses these exact shapes. If an enum's serde repr drifts,
    // the browser silently mis-reconciles — pin it here.
    let apply = serde_json::to_string(&reconcile(None, &ev(ChangeOp::Upsert, 1)))?;
    assert_eq!(apply, "\"Apply\"");

    let stale = serde_json::to_string(&reconcile(
        Some(LocalRow {
            version: 5,
            dirty: false,
        }),
        &ev(ChangeOp::Upsert, 4),
    ))?;
    assert_eq!(stale, "{\"Ignore\":\"Stale\"}");

    let conflict = serde_json::to_string(&reconcile(
        Some(LocalRow {
            version: 5,
            dirty: true,
        }),
        &ev(ChangeOp::Upsert, 6),
    ))?;
    assert_eq!(conflict, "\"Conflict\"");

    let adopt = serde_json::to_string(&on_ack(
        LocalRow {
            version: 5,
            dirty: true,
        },
        &WriteAck {
            id: "k1".into(),
            committed_version: 6,
        },
    ))?;
    assert_eq!(adopt, "{\"Adopt\":6}");

    let superseded = serde_json::to_string(&on_ack(
        LocalRow {
            version: 9,
            dirty: false,
        },
        &WriteAck {
            id: "k1".into(),
            committed_version: 6,
        },
    ))?;
    assert_eq!(superseded, "\"Superseded\"");

    // The ChangeEvent envelope round-trips (lowercase op) at an extreme version.
    let wire = r#"{"table":"api_keys","op":"delete","id":"k1","version":9223372036854775807}"#;
    let decoded: ChangeEvent = serde_json::from_str(wire)?;
    assert_eq!(decoded.op, ChangeOp::Delete);
    assert_eq!(decoded.version, i64::MAX);
    let reencoded = serde_json::to_string(&decoded)?;
    assert!(reencoded.contains("\"op\":\"delete\""));
    Ok(())
}
