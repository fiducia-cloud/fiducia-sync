//! Pins the cross-language contract: the Rust core must reproduce the SAME
//! results as the JS SDK (`langs/typescript/tests/validate.test.mjs`, `hlc.test.mjs`) and
//! the Dart package (`langs/dart/test/*`) over the shared fixture files under
//! `schema/fixtures/`. If one runtime changes behavior, its fixture run — not
//! a human — catches the drift.

use fiducia_sync_core::{Hlc, SchemaValidator};
use serde_json::Value;

const ENVELOPES: &str = include_str!("../schema/fixtures/sync-envelopes.json");
const HLC_VECTORS: &str = include_str!("../schema/fixtures/hlc-vectors.json");

fn field<'a>(value: &'a Value, name: &str, context: &str) -> Result<&'a Value, String> {
    value
        .get(name)
        .ok_or_else(|| format!("{context} is missing field {name:?}"))
}

fn array_field<'a>(value: &'a Value, name: &str, context: &str) -> Result<&'a [Value], String> {
    field(value, name, context)?
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{context}.{name} must be an array"))
}

fn string_field<'a>(value: &'a Value, name: &str, context: &str) -> Result<&'a str, String> {
    field(value, name, context)?
        .as_str()
        .ok_or_else(|| format!("{context}.{name} must be a string"))
}

fn i64_field(value: &Value, name: &str, context: &str) -> Result<i64, String> {
    field(value, name, context)?
        .as_i64()
        .ok_or_else(|| format!("{context}.{name} must be an i64"))
}

fn u32_field(value: &Value, name: &str, context: &str) -> Result<u32, String> {
    let raw = field(value, name, context)?
        .as_u64()
        .ok_or_else(|| format!("{context}.{name} must be an unsigned integer"))?;
    u32::try_from(raw).map_err(|_| format!("{context}.{name} must fit in u32"))
}

#[test]
fn envelope_fixtures_validate_identically_via_the_public_api() -> Result<(), String> {
    let validator = SchemaValidator::sync().map_err(|error| error.to_string())?;
    let fixtures: Value = serde_json::from_str(ENVELOPES)
        .map_err(|error| format!("could not parse envelope fixtures: {error}"))?;
    let cases = array_field(&fixtures, "cases", "envelope fixtures")?;
    assert!(cases.len() >= 20, "fixture file looks truncated");

    for (index, case) in cases.iter().enumerate() {
        let context = format!("envelope fixture {index}");
        let name = string_field(case, "name", &context)?;
        let definition = string_field(case, "definition", &context)?;
        let expected = field(case, "valid", &context)?
            .as_bool()
            .ok_or_else(|| format!("{context}.valid must be a boolean"))?;
        let value = field(case, "value", &context)?;
        let outcome = validator.validate(definition, value);
        assert_eq!(
            outcome.is_ok(),
            expected,
            "fixture {name:?}: expected valid={expected}, got {outcome:?}"
        );
    }
    Ok(())
}

#[test]
fn hlc_vectors_replay_identically_via_the_public_api() -> Result<(), String> {
    let fixtures: Value = serde_json::from_str(HLC_VECTORS)
        .map_err(|error| format!("could not parse HLC vectors: {error}"))?;
    let cases = array_field(&fixtures, "cases", "HLC fixtures")?;
    assert!(!cases.is_empty());

    for (case_index, case) in cases.iter().enumerate() {
        let context = format!("HLC fixture {case_index}");
        let name = string_field(case, "name", &context)?;
        let start = field(case, "start", &context)?;
        let mut clock = Hlc::from_state(
            i64_field(start, "wall_ms", &format!("{context}.start"))?,
            u32_field(start, "counter", &format!("{context}.start"))?,
        );

        for (step_index, step) in array_field(case, "steps", &context)?.iter().enumerate() {
            let step_context = format!("{context}.steps[{step_index}]");
            let stamp = match string_field(step, "op", &step_context)? {
                "tick" => clock.tick(i64_field(step, "now_ms", &step_context)?),
                "observe" => clock.observe(
                    i64_field(step, "remote_ms", &step_context)?,
                    i64_field(step, "now_ms", &step_context)?,
                ),
                other => return Err(format!("{step_context}.op has unknown value {other:?}")),
            };
            let expected = string_field(step, "expect", &step_context)?;
            assert_eq!(
                stamp.encode(),
                expected,
                "case {name:?} step {step_index} produced the wrong stamp"
            );
        }
    }
    Ok(())
}
