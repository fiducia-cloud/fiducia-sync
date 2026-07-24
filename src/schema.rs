//! Runtime validation for the canonical sync envelopes, driven by the SAME
//! JSON Schema document in every language.
//!
//! `fiducia-interfaces/schema/sync.schema.json` is the source of truth for the
//! wire envelopes; this repo vendors a byte-identical copy at
//! `schema/sync.schema.json` (a soft drift test in the SDK compares the two
//! when the sibling checkout is present, mirroring fiducia-interfaces' own
//! pg-defs drift guard). The validator here, `sdk/src/validate.mjs`, and
//! `dart/lib/src/schema.dart` implement the same JSON Schema subset and are
//! pinned to shared fixtures (`schema/fixtures/sync-envelopes.json`), so a
//! payload accepted on one runtime is accepted on all of them.
//!
//! The engine is deliberately a *subset* interpreter that **fails closed**: a
//! schema using a keyword outside the supported set is rejected at load time
//! rather than silently under-validated. The supported subset covers every
//! keyword the fiducia-interfaces schemas use (type/enum/const, object
//! required+properties+additionalProperties, string and numeric bounds, array
//! items/bounds, `$ref` into `#/$defs/…`, and anyOf/oneOf/allOf/not).

use serde_json::{Map, Value};

/// The vendored canonical sync envelope schema (see module docs).
pub const SYNC_SCHEMA_JSON: &str = include_str!("../schema/sync.schema.json");

/// `$ref` recursion limit — far above any real schema, low enough to make a
/// cyclic reference an error instead of a stack overflow.
const MAX_DEPTH: usize = 64;

/// Keywords the subset engine enforces or deliberately ignores. Anything else
/// fails the schema at load time (fail closed, never under-validate).
const ENFORCED: &[&str] = &[
    "$ref",
    "type",
    "enum",
    "const",
    "required",
    "properties",
    "additionalProperties",
    "items",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
];
const METADATA: &[&str] = &[
    "$schema",
    "$id",
    "$defs",
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];

/// The schema document itself is invalid or uses an unsupported keyword.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError(pub String);

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid schema: {}", self.0)
    }
}

impl std::error::Error for SchemaError {}

/// One reason a value failed validation, anchored to a JSON path like
/// `$.changes[2].version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaViolation {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for SchemaViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

/// A loaded schema document whose `$defs` can validate values.
#[derive(Debug, Clone)]
pub struct SchemaValidator {
    root: Value,
}

impl SchemaValidator {
    /// Load the vendored canonical sync envelope schema.
    pub fn sync() -> Result<SchemaValidator, SchemaError> {
        SchemaValidator::from_json(SYNC_SCHEMA_JSON)
    }

    /// Load any schema document that keeps to the supported subset. Unsupported
    /// keywords are rejected here, not silently skipped during validation.
    pub fn from_json(text: &str) -> Result<SchemaValidator, SchemaError> {
        let root: Value =
            serde_json::from_str(text).map_err(|e| SchemaError(format!("not JSON: {e}")))?;
        if !root.is_object() {
            return Err(SchemaError("schema root must be an object".into()));
        }
        check_supported(&root, "#")?;
        Ok(SchemaValidator { root })
    }

    fn defs(&self) -> Option<&Map<String, Value>> {
        self.root.get("$defs").and_then(Value::as_object)
    }

    /// The `$defs` names this document can validate, in stable order.
    pub fn definitions(&self) -> Vec<&str> {
        self.defs()
            .map(|defs| defs.keys().map(String::as_str).collect())
            .unwrap_or_default()
    }

    /// Validate `value` against `#/$defs/<definition>`. `Ok(())` means valid;
    /// `Err` carries every violation found (not only the first).
    pub fn validate(&self, definition: &str, value: &Value) -> Result<(), Vec<SchemaViolation>> {
        let schema = self
            .defs()
            .and_then(|defs| defs.get(definition))
            .ok_or_else(|| {
                vec![SchemaViolation {
                    path: "$".into(),
                    message: format!("unknown schema definition {definition:?}"),
                }]
            })?;
        let mut violations = Vec::new();
        self.check(schema, value, "$", 0, &mut violations);
        if violations.is_empty() {
            Ok(())
        } else {
            Err(violations)
        }
    }

    fn resolve<'a>(&'a self, reference: &str) -> Option<&'a Value> {
        let name = reference.strip_prefix("#/$defs/")?;
        self.defs()?.get(name)
    }

    fn check(
        &self,
        schema: &Value,
        value: &Value,
        path: &str,
        depth: usize,
        out: &mut Vec<SchemaViolation>,
    ) {
        let fail = |out: &mut Vec<SchemaViolation>, message: String| {
            out.push(SchemaViolation {
                path: path.to_string(),
                message,
            });
        };
        if depth > MAX_DEPTH {
            fail(out, "schema nesting/$ref depth exceeded".into());
            return;
        }
        let Some(schema) = schema.as_object() else {
            // `true`/`false` schemas: `true` accepts anything, `false` nothing.
            match schema {
                Value::Bool(true) => {}
                Value::Bool(false) => fail(out, "schema forbids any value".into()),
                _ => fail(out, "schema node must be an object or boolean".into()),
            }
            return;
        };

        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            match self.resolve(reference) {
                Some(target) => self.check(target, value, path, depth + 1, out),
                None => fail(out, format!("unresolvable $ref {reference:?}")),
            }
        }

        if let Some(expected) = schema.get("type") {
            if !type_matches(expected, value) {
                fail(
                    out,
                    format!("expected type {expected}, got {}", type_name(value)),
                );
                return; // The remaining keyword checks presume the right type.
            }
        }

        if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
            if !allowed.iter().any(|candidate| candidate == value) {
                fail(out, "value is not one of the allowed enum values".into());
            }
        }
        if let Some(constant) = schema.get("const") {
            if constant != value {
                fail(out, "value does not equal the required const".into());
            }
        }

        self.check_string(schema, value, path, out);
        self.check_number(schema, value, path, out);
        self.check_object(schema, value, path, depth, out);
        self.check_array(schema, value, path, depth, out);
        self.check_composition(schema, value, path, depth, out);
    }

    fn check_string(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        out: &mut Vec<SchemaViolation>,
    ) {
        let Some(text) = value.as_str() else { return };
        // JSON Schema string lengths count Unicode code points, not UTF-8 bytes.
        let length = text.chars().count() as u64;
        if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
            if length < min {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("string is shorter than minLength {min}"),
                });
            }
        }
        if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
            if length > max {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("string is longer than maxLength {max}"),
                });
            }
        }
    }

    fn check_number(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        out: &mut Vec<SchemaViolation>,
    ) {
        let Some(number) = value.as_f64() else { return };
        if value.as_i64().is_none() && value.as_u64().is_none() && !number.is_finite() {
            return;
        }
        let mut bound = |keyword: &str, ok: bool| {
            if !ok {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("number violates {keyword}"),
                });
            }
        };
        if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
            bound("minimum", number >= min);
        }
        if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
            bound("maximum", number <= max);
        }
        if let Some(min) = schema.get("exclusiveMinimum").and_then(Value::as_f64) {
            bound("exclusiveMinimum", number > min);
        }
        if let Some(max) = schema.get("exclusiveMaximum").and_then(Value::as_f64) {
            bound("exclusiveMaximum", number < max);
        }
    }

    fn check_object(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        depth: usize,
        out: &mut Vec<SchemaViolation>,
    ) {
        let Some(object) = value.as_object() else {
            return;
        };
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    out.push(SchemaViolation {
                        path: path.into(),
                        message: format!("missing required property {name:?}"),
                    });
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(properties) = properties {
            for (name, subschema) in properties {
                if let Some(child) = object.get(name) {
                    self.check(subschema, child, &format!("{path}.{name}"), depth + 1, out);
                }
            }
        }
        match schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                for name in object.keys() {
                    let declared = properties.map(|p| p.contains_key(name)).unwrap_or(false);
                    if !declared {
                        out.push(SchemaViolation {
                            path: path.into(),
                            message: format!("unexpected additional property {name:?}"),
                        });
                    }
                }
            }
            Some(Value::Bool(true)) | None => {}
            Some(subschema) => {
                for (name, child) in object {
                    let declared = properties.map(|p| p.contains_key(name)).unwrap_or(false);
                    if !declared {
                        self.check(subschema, child, &format!("{path}.{name}"), depth + 1, out);
                    }
                }
            }
        }
    }

    fn check_array(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        depth: usize,
        out: &mut Vec<SchemaViolation>,
    ) {
        let Some(items) = value.as_array() else {
            return;
        };
        if let Some(subschema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                self.check(subschema, item, &format!("{path}[{index}]"), depth + 1, out);
            }
        }
        let count = items.len() as u64;
        if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
            if count < min {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("array has fewer than minItems {min}"),
                });
            }
        }
        if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
            if count > max {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("array has more than maxItems {max}"),
                });
            }
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (index, item) in items.iter().enumerate() {
                if items[..index].contains(item) {
                    out.push(SchemaViolation {
                        path: format!("{path}[{index}]"),
                        message: "array items are not unique".into(),
                    });
                    break;
                }
            }
        }
    }

    fn check_composition(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        depth: usize,
        out: &mut Vec<SchemaViolation>,
    ) {
        let passes = |subschema: &Value| {
            let mut probe = Vec::new();
            self.check(subschema, value, path, depth + 1, &mut probe);
            probe.is_empty()
        };
        if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
            if !branches.iter().any(passes) {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: "value matches no anyOf branch".into(),
                });
            }
        }
        if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
            let matches = branches.iter().filter(|branch| passes(branch)).count();
            if matches != 1 {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: format!("value matches {matches} oneOf branches, expected exactly 1"),
                });
            }
        }
        if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
            for branch in branches {
                self.check(branch, value, path, depth + 1, out);
            }
        }
        if let Some(negated) = schema.get("not") {
            if passes(negated) {
                out.push(SchemaViolation {
                    path: path.into(),
                    message: "value matches the forbidden `not` schema".into(),
                });
            }
        }
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) => {
            if is_integer(number) {
                "integer"
            } else {
                "number"
            }
        }
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_integer(number: &serde_json::Number) -> bool {
    if number.is_i64() || number.is_u64() {
        return true;
    }
    // JSON Schema: a float with a zero fractional part is an integer.
    number
        .as_f64()
        .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
}

fn type_matches(expected: &Value, value: &Value) -> bool {
    let matches_one = |name: &str| match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.as_number().is_some_and(is_integer),
        _ => false,
    };
    match expected {
        Value::String(name) => matches_one(name),
        Value::Array(names) => names.iter().filter_map(Value::as_str).any(matches_one),
        _ => false,
    }
}

/// Reject schemas that use keywords outside the enforced subset (fail closed).
/// Walks the schema grammar itself, so property names that shadow keywords
/// (a column called `items`, say) are never mistaken for schema keywords.
fn check_supported(node: &Value, path: &str) -> Result<(), SchemaError> {
    let object = match node {
        Value::Bool(_) => return Ok(()),
        Value::Object(object) => object,
        _ => {
            return Err(SchemaError(format!(
                "schema node at {path} must be an object or boolean"
            )))
        }
    };
    for (key, child) in object {
        match key.as_str() {
            "properties" | "$defs" => {
                let named = child.as_object().ok_or_else(|| {
                    SchemaError(format!("{path}/{key} must be an object of schemas"))
                })?;
                for (name, subschema) in named {
                    check_supported(subschema, &format!("{path}/{key}/{name}"))?;
                }
            }
            "items" | "additionalProperties" | "not" => {
                check_supported(child, &format!("{path}/{key}"))?;
            }
            "anyOf" | "oneOf" | "allOf" => {
                let branches = child.as_array().ok_or_else(|| {
                    SchemaError(format!("{path}/{key} must be an array of schemas"))
                })?;
                for (index, branch) in branches.iter().enumerate() {
                    check_supported(branch, &format!("{path}/{key}[{index}]"))?;
                }
            }
            key_name if ENFORCED.contains(&key_name) || METADATA.contains(&key_name) => {
                // Data-valued keywords (type/enum/const/required/bounds/metadata):
                // nothing beneath them is a schema.
            }
            unsupported => {
                return Err(SchemaError(format!(
                    "unsupported keyword {unsupported:?} at {path} — the fiducia-sync subset \
                     validator fails closed rather than under-validating"
                )));
            }
        }
    }
    Ok(())
}

/// Convenience: the definitions the canonical sync schema is expected to hold.
pub const SYNC_DEFINITIONS: [&str; 4] = [
    "SyncChangeEvent",
    "SyncQueuedWrite",
    "SyncWriteAcknowledgement",
    "SyncPullPage",
];

/// One-call validation of a value against a canonical sync envelope definition.
/// Loads the embedded schema each call; hold a [`SchemaValidator`] to amortize.
pub fn validate_sync_envelope(definition: &str, value: &Value) -> Result<(), Vec<SchemaViolation>> {
    let validator = SchemaValidator::sync().map_err(|e| {
        vec![SchemaViolation {
            path: "$".into(),
            message: e.to_string(),
        }]
    })?;
    validator.validate(definition, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    const FIXTURES: &str = include_str!("../schema/fixtures/sync-envelopes.json");

    #[test]
    fn the_embedded_canonical_schema_loads_and_exposes_all_envelopes() {
        let validator = SchemaValidator::sync().unwrap();
        let names: BTreeSet<&str> = validator.definitions().into_iter().collect();
        for expected in SYNC_DEFINITIONS {
            assert!(names.contains(expected), "{expected} missing from schema");
        }
    }

    #[test]
    fn shared_fixture_cases_all_agree() {
        let validator = SchemaValidator::sync().unwrap();
        let fixtures: Value = serde_json::from_str(FIXTURES).unwrap();
        let cases = fixtures["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "fixture file looks truncated");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let definition = case["definition"].as_str().unwrap();
            let expected_valid = case["valid"].as_bool().unwrap();
            let result = validator.validate(definition, &case["value"]);
            assert_eq!(
                result.is_ok(),
                expected_valid,
                "case {name:?} expected valid={expected_valid}, got {result:?}"
            );
        }
    }

    #[test]
    fn violations_carry_precise_paths() {
        let validator = SchemaValidator::sync().unwrap();
        let page = json!({
            "changes": [
                { "table": "t", "op": "upsert", "id": "a", "version": 1, "row": {}, "at_ms": 0 },
                { "table": "t", "op": "upsert", "id": "b", "version": -2, "row": {}, "at_ms": 0 }
            ],
            "next_cursor": 2,
            "has_more": false
        });
        let violations = validator.validate("SyncPullPage", &page).unwrap_err();
        assert!(
            violations.iter().any(|v| v.path == "$.changes[1].version"),
            "expected a violation at $.changes[1].version, got {violations:?}"
        );
    }

    #[test]
    fn unknown_definition_and_unsupported_keywords_fail_closed() {
        let validator = SchemaValidator::sync().unwrap();
        assert!(validator.validate("NoSuchThing", &json!({})).is_err());

        let with_pattern = r#"{
            "$defs": { "X": { "type": "string", "pattern": "^a" } }
        }"#;
        let error = SchemaValidator::from_json(with_pattern).unwrap_err();
        assert!(error.0.contains("pattern"), "{error}");
    }

    #[test]
    fn cyclic_refs_error_instead_of_overflowing() {
        let cyclic = r##"{
            "$defs": { "Loop": { "$ref": "#/$defs/Loop" } }
        }"##;
        let validator = SchemaValidator::from_json(cyclic).unwrap();
        let violations = validator.validate("Loop", &json!(1)).unwrap_err();
        assert!(violations[0].message.contains("depth"));
    }

    #[test]
    fn one_call_helper_matches_the_validator() {
        let ack = json!({ "id": "k1", "committed_version": 3 });
        assert!(validate_sync_envelope("SyncWriteAcknowledgement", &ack).is_ok());
        assert!(validate_sync_envelope("SyncWriteAcknowledgement", &json!({})).is_err());
    }
}
