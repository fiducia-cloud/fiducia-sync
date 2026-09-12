use fiducia_sync_core::{on_ack, AckOutcome, ChangeEvent, ChangeOp, LocalRow, QueuedWrite, WriteAck};
use serde_json::{json, Value};

fn event(version: i64, write_key: Option<&str>) -> ChangeEvent {
    ChangeEvent {
        table: "api_keys".into(),
        op: ChangeOp::Upsert,
        id: "key-1".into(),
        version,
        row: json!({"name": "production"}),
        at_ms: 123,
        write_key: write_key.map(str::to_owned),
    }
}

#[test]
fn change_event_defaults_optional_fields_and_ignores_forward_fields() {
    let decoded: ChangeEvent = serde_json::from_value(json!({
        "table": "api_keys",
        "op": "delete",
        "id": "key-1",
        "version": 7,
        "future_transport_hint": {"partition": 3}
    }))
    .expect("forward-compatible event");

    assert_eq!(decoded.row, Value::Null);
    assert_eq!(decoded.at_ms, 0);
    assert_eq!(decoded.write_key, None);

    let encoded = serde_json::to_value(decoded).expect("serialize event");
    assert_eq!(encoded["row"], Value::Null);
    assert_eq!(encoded["at_ms"], 0);
    assert!(encoded.get("write_key").is_none());
    assert!(encoded.get("future_transport_hint").is_none());
}

#[test]
fn change_event_rejects_invalid_operation_missing_identity_and_string_version() {
    for invalid in [
        json!({"table": "api_keys", "op": "patch", "id": "key-1", "version": 1}),
        json!({"table": "api_keys", "op": "upsert", "version": 1}),
        json!({"table": "api_keys", "op": "upsert", "id": "key-1", "version": "1"}),
    ] {
        assert!(
            serde_json::from_value::<ChangeEvent>(invalid.clone()).is_err(),
            "invalid envelope unexpectedly decoded: {invalid}"
        );
    }
}

#[test]
fn queued_write_round_trip_preserves_payload_and_authoritative_key() {
    let queued = QueuedWrite {
        id: "key-1".into(),
        table: "api_keys".into(),
        op: ChangeOp::Upsert,
        payload: json!({"roles": ["reader", "writer"], "enabled": true}),
        base_version: 41,
        key: Some("write-123".into()),
    };

    let wire = serde_json::to_string(&queued).expect("serialize queued write");
    let decoded: QueuedWrite = serde_json::from_str(&wire).expect("decode queued write");

    assert_eq!(decoded, queued);
    assert_eq!(decoded.expected_version(), 42);
}

#[test]
fn keyed_echo_requires_table_id_operation_and_exact_key_even_at_extreme_versions() {
    let queued = QueuedWrite {
        id: "key-1".into(),
        table: "api_keys".into(),
        op: ChangeOp::Upsert,
        payload: Value::Null,
        base_version: 5,
        key: Some("write-123".into()),
    };

    for version in [i64::MIN, -1, 0, 6, i64::MAX] {
        assert!(queued.is_echo_of(&event(version, Some("write-123"))));
    }

    let wrong_table = ChangeEvent {
        table: "customer_preferences".into(),
        ..event(6, Some("write-123"))
    };
    let wrong_id = ChangeEvent {
        id: "key-2".into(),
        ..event(6, Some("write-123"))
    };
    let wrong_operation = ChangeEvent {
        op: ChangeOp::Delete,
        ..event(6, Some("write-123"))
    };

    assert!(!queued.is_echo_of(&wrong_table));
    assert!(!queued.is_echo_of(&wrong_id));
    assert!(!queued.is_echo_of(&wrong_operation));
    assert!(!queued.is_echo_of(&event(6, Some("write-other"))));
    assert!(!queued.is_echo_of(&event(6, None)));
}

#[test]
fn legacy_echo_detection_never_wraps_from_i64_max_to_i64_min() {
    let queued = QueuedWrite {
        id: "key-1".into(),
        table: "api_keys".into(),
        op: ChangeOp::Upsert,
        payload: Value::Null,
        base_version: i64::MAX,
        key: None,
    };

    assert_eq!(queued.expected_version(), i64::MAX);
    assert!(!queued.is_echo_of(&event(i64::MIN, None)));
    assert!(!queued.is_echo_of(&event(i64::MAX, None)));
}

#[test]
fn write_ack_wire_round_trip_preserves_extreme_versions_and_outcomes() {
    for committed_version in [i64::MIN, -1, 0, 1, i64::MAX] {
        let ack = WriteAck {
            id: "key-1".into(),
            committed_version,
        };
        let wire = serde_json::to_string(&ack).expect("serialize ack");
        let decoded: WriteAck = serde_json::from_str(&wire).expect("decode ack");
        assert_eq!(decoded, ack);

        let local = LocalRow {
            version: committed_version,
            dirty: true,
        };
        assert_eq!(on_ack(local, &decoded), AckOutcome::Adopt(committed_version));
    }
}
