//! Pins the cross-language contract: the Rust core must reproduce the SAME
//! results as the JS SDK (`sdk/tests/validate.test.mjs`, `hlc.test.mjs`) and
//! the Dart package (`dart/test/*`) over the shared fixture files under
//! `schema/fixtures/`. If one runtime changes behavior, its fixture run — not
//! a human — catches the drift.

use fiducia_sync_core::{Hlc, SchemaValidator};
use serde_json::Value;

const ENVELOPES: &str = include_str!("../schema/fixtures/sync-envelopes.json");
const HLC_VECTORS: &str = include_str!("../schema/fixtures/hlc-vectors.json");

#[test]
fn envelope_fixtures_validate_identically_via_the_public_api() {
    let validator = SchemaValidator::sync().expect("embedded schema loads");
    let fixtures: Value = serde_json::from_str(ENVELOPES).expect("fixtures parse");
    let cases = fixtures["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 20, "fixture file looks truncated");
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let definition = case["definition"].as_str().expect("definition");
        let expected = case["valid"].as_bool().expect("valid flag");
        let outcome = validator.validate(definition, &case["value"]);
        assert_eq!(
            outcome.is_ok(),
            expected,
            "fixture {name:?}: expected valid={expected}, got {outcome:?}"
        );
    }
}

#[test]
fn hlc_vectors_replay_identically_via_the_public_api() {
    let fixtures: Value = serde_json::from_str(HLC_VECTORS).expect("vectors parse");
    let cases = fixtures["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let start = &case["start"];
        let mut clock = Hlc::from_state(
            start["wall_ms"].as_i64().expect("start wall_ms"),
            start["counter"].as_u64().expect("start counter") as u32,
        );
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let stamp = match step["op"].as_str().expect("op") {
                "tick" => clock.tick(step["now_ms"].as_i64().expect("now_ms")),
                "observe" => clock.observe(
                    step["remote_ms"].as_i64().expect("remote_ms"),
                    step["now_ms"].as_i64().expect("now_ms"),
                ),
                other => panic!("unknown vector op {other:?}"),
            };
            let expected = step["expect"].as_str().expect("expect");
            assert_eq!(
                stamp.encode(),
                expected,
                "case {name:?} step {index} produced the wrong stamp"
            );
        }
    }
}
