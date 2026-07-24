// Runtime validation for the canonical sync envelopes — the JS mirror of the
// Rust subset validator (src/schema.rs), driven by the SAME JSON Schema and
// pinned to the same shared fixtures (schema/fixtures/sync-envelopes.json).
//
// Two consumption styles, both dependency-free:
//
//   import { makeValidator, assertSyncEnvelope } from "@fiducia/sync/validate";
//   assertSyncEnvelope("SyncChangeEvent", event);        // throws with paths
//
//   import { z } from "zod";                              // the APP's zod
//   import { zodSchemas } from "@fiducia/sync/validate";
//   const S = zodSchemas(z);                              // z.* per $def
//   S.SyncQueuedWrite.parse(write);
//
// The engine is a deliberate SUBSET interpreter that fails closed: a schema
// using a keyword outside the supported set is rejected at load time rather
// than silently under-validated. Works for any schema kept to the subset —
// apps can validate their own row/ORM shapes with makeValidator(theirSchema).

import { SYNC_SCHEMA } from "./sync-schema.mjs";

const ENFORCED = new Set([
  "$ref", "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems",
  "anyOf", "oneOf", "allOf", "not",
]);
const METADATA = new Set([
  "$schema", "$id", "$defs", "$comment", "title", "description", "default",
  "examples", "deprecated", "readOnly", "writeOnly",
]);
const MAX_DEPTH = 64;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const typeName = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};

const matchesType = (name, v) => {
  switch (name) {
    case "object": return isPlainObject(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    default: return false;
  }
};

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a && b && typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
};

/** Reject schemas outside the enforced subset (fail closed, grammar-aware). */
function checkSupported(node, path) {
  if (typeof node === "boolean") return;
  if (!isPlainObject(node)) {
    throw new TypeError(`schema node at ${path} must be an object or boolean`);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "properties" || key === "$defs") {
      if (!isPlainObject(child)) throw new TypeError(`${path}/${key} must be an object of schemas`);
      for (const [name, sub] of Object.entries(child)) checkSupported(sub, `${path}/${key}/${name}`);
    } else if (key === "items" || key === "additionalProperties" || key === "not") {
      checkSupported(child, `${path}/${key}`);
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (!Array.isArray(child)) throw new TypeError(`${path}/${key} must be an array of schemas`);
      child.forEach((branch, i) => checkSupported(branch, `${path}/${key}[${i}]`));
    } else if (!ENFORCED.has(key) && !METADATA.has(key)) {
      throw new TypeError(
        `unsupported keyword ${JSON.stringify(key)} at ${path} — the fiducia-sync subset validator fails closed rather than under-validating`,
      );
    }
  }
}

/** Thrown by assert()/parse-style helpers; carries every violation found. */
export class SchemaValidationError extends Error {
  constructor(definition, violations) {
    const shown = violations.slice(0, 3).map((v) => `${v.path}: ${v.message}`).join("; ");
    super(`${definition} failed schema validation — ${shown}${violations.length > 3 ? "; …" : ""}`);
    this.name = "SchemaValidationError";
    this.definition = definition;
    this.violations = violations;
  }
}

/**
 * Load a schema document (default: the embedded canonical sync schema) and get
 * `{ definitions(), validate(def, value) -> violations[], assert(def, value) }`.
 */
export function makeValidator(schemaDocument = SYNC_SCHEMA) {
  if (!isPlainObject(schemaDocument)) {
    throw new TypeError("schema document must be an object");
  }
  checkSupported(schemaDocument, "#");
  const defs = isPlainObject(schemaDocument.$defs) ? schemaDocument.$defs : {};

  function check(schema, value, path, depth, out) {
    if (depth > MAX_DEPTH) {
      out.push({ path, message: "schema nesting/$ref depth exceeded" });
      return;
    }
    if (schema === true) return;
    if (schema === false) {
      out.push({ path, message: "schema forbids any value" });
      return;
    }
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice(8) : null;
      const target = name != null ? defs[name] : undefined;
      if (target === undefined) out.push({ path, message: `unresolvable $ref ${JSON.stringify(schema.$ref)}` });
      else check(target, value, path, depth + 1, out);
    }

    if (schema.type !== undefined) {
      const names = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!names.some((n) => matchesType(n, value))) {
        out.push({ path, message: `expected type ${JSON.stringify(schema.type)}, got ${typeName(value)}` });
        return; // Remaining keyword checks presume the right type.
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((c) => deepEqual(c, value))) {
      out.push({ path, message: "value is not one of the allowed enum values" });
    }
    if (schema.const !== undefined && !deepEqual(schema.const, value)) {
      out.push({ path, message: "value does not equal the required const" });
    }

    if (typeof value === "string") {
      // JSON Schema string lengths count Unicode code points, not UTF-16 units.
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) {
        out.push({ path, message: `string is shorter than minLength ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        out.push({ path, message: `string is longer than maxLength ${schema.maxLength}` });
      }
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      if (schema.minimum !== undefined && !(value >= schema.minimum)) {
        out.push({ path, message: "number violates minimum" });
      }
      if (schema.maximum !== undefined && !(value <= schema.maximum)) {
        out.push({ path, message: "number violates maximum" });
      }
      if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) {
        out.push({ path, message: "number violates exclusiveMinimum" });
      }
      if (schema.exclusiveMaximum !== undefined && !(value < schema.exclusiveMaximum)) {
        out.push({ path, message: "number violates exclusiveMaximum" });
      }
    }

    if (isPlainObject(value)) {
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(value, name)) {
          out.push({ path, message: `missing required property ${JSON.stringify(name)}` });
        }
      }
      const properties = isPlainObject(schema.properties) ? schema.properties : null;
      if (properties) {
        for (const [name, sub] of Object.entries(properties)) {
          if (Object.hasOwn(value, name)) check(sub, value[name], `${path}.${name}`, depth + 1, out);
        }
      }
      const additional = schema.additionalProperties;
      if (additional === false) {
        for (const name of Object.keys(value)) {
          if (!properties || !Object.hasOwn(properties, name)) {
            out.push({ path, message: `unexpected additional property ${JSON.stringify(name)}` });
          }
        }
      } else if (additional !== undefined && additional !== true) {
        for (const [name, child] of Object.entries(value)) {
          if (!properties || !Object.hasOwn(properties, name)) {
            check(additional, child, `${path}.${name}`, depth + 1, out);
          }
        }
      }
    }

    if (Array.isArray(value)) {
      if (schema.items !== undefined) {
        value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, depth + 1, out));
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        out.push({ path, message: `array has fewer than minItems ${schema.minItems}` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        out.push({ path, message: `array has more than maxItems ${schema.maxItems}` });
      }
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i += 1) {
          if (value.slice(0, i).some((prior) => deepEqual(prior, value[i]))) {
            out.push({ path: `${path}[${i}]`, message: "array items are not unique" });
            break;
          }
        }
      }
    }

    const passes = (sub) => {
      const probe = [];
      check(sub, value, path, depth + 1, probe);
      return probe.length === 0;
    };
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some(passes)) {
      out.push({ path, message: "value matches no anyOf branch" });
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = schema.oneOf.filter(passes).length;
      if (matches !== 1) out.push({ path, message: `value matches ${matches} oneOf branches, expected exactly 1` });
    }
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) check(branch, value, path, depth + 1, out);
    }
    if (schema.not !== undefined && passes(schema.not)) {
      out.push({ path, message: "value matches the forbidden `not` schema" });
    }
  }

  return {
    definitions() {
      return Object.keys(defs);
    },
    /** Empty array means valid; otherwise every `{path, message}` found. */
    validate(definition, value) {
      const schema = defs[definition];
      if (schema === undefined) {
        return [{ path: "$", message: `unknown schema definition ${JSON.stringify(definition)}` }];
      }
      const out = [];
      check(schema, value, "$", 0, out);
      return out;
    },
    /** Return `value` when valid; throw SchemaValidationError otherwise. */
    assert(definition, value) {
      const violations = this.validate(definition, value);
      if (violations.length > 0) throw new SchemaValidationError(definition, violations);
      return value;
    },
  };
}

let canonical = null;
const canonicalValidator = () => (canonical ??= makeValidator(SYNC_SCHEMA));

/** Violations for `value` against a canonical envelope (empty = valid). */
export const validateSyncEnvelope = (definition, value) =>
  canonicalValidator().validate(definition, value);

/** Assert `value` against a canonical envelope; returns `value`. */
export const assertSyncEnvelope = (definition, value) =>
  canonicalValidator().assert(definition, value);

/**
 * Build Zod schemas from a JSON Schema document — one `z` type per `$def` —
 * using the CALLER's zod instance (the SDK itself stays dependency-free).
 * Supports the same subset as the validator minus allOf/not (fail closed).
 * `additionalProperties:false` maps to `catchall(z.never())`, nullable type
 * arrays to `.nullable()`, `$ref` to `z.lazy`.
 */
export function zodSchemas(z, schemaDocument = SYNC_SCHEMA) {
  if (!z || typeof z.object !== "function") {
    throw new TypeError("zodSchemas needs the caller's zod instance (import { z } from \"zod\")");
  }
  checkSupported(schemaDocument, "#");
  const defs = isPlainObject(schemaDocument.$defs) ? schemaDocument.$defs : {};
  const registry = {};

  const unsupported = (why) => {
    throw new TypeError(`zodSchemas cannot map this schema: ${why}`);
  };

  function build(schema, path) {
    if (schema === true) return z.unknown();
    if (schema === false) return z.never();
    if (!isPlainObject(schema)) unsupported(`non-object schema at ${path}`);
    if (schema.allOf || schema.not) unsupported(`allOf/not at ${path} have no faithful zod mapping here`);
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice(8) : null;
      if (name == null || defs[name] === undefined) unsupported(`unresolvable $ref at ${path}`);
      return z.lazy(() => registry[name] ?? buildDef(name));
    }
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
      const branches = (schema.anyOf ?? schema.oneOf).map((b, i) => build(b, `${path}/union[${i}]`));
      return branches.length === 1 ? branches[0] : z.union(branches);
    }
    if (schema.const !== undefined) return z.literal(schema.const);

    const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
    const nullable = types?.includes("null") ?? false;
    const core = types?.filter((t) => t !== "null") ?? null;
    if (core && core.length !== 1) unsupported(`multi-type ${JSON.stringify(schema.type)} at ${path} (only "<type>" or ["<type>","null"] map cleanly)`);

    let built;
    switch (core?.[0]) {
      case undefined:
        built = z.unknown();
        break;
      case "string": {
        if (Array.isArray(schema.enum)) {
          built = z.enum(schema.enum);
        } else {
          built = z.string();
          if (schema.minLength !== undefined) built = built.min(schema.minLength);
          if (schema.maxLength !== undefined) built = built.max(schema.maxLength);
        }
        break;
      }
      case "integer":
      case "number": {
        built = z.number();
        if (core[0] === "integer") built = built.int();
        if (schema.minimum !== undefined) built = built.gte(schema.minimum);
        if (schema.maximum !== undefined) built = built.lte(schema.maximum);
        if (schema.exclusiveMinimum !== undefined) built = built.gt(schema.exclusiveMinimum);
        if (schema.exclusiveMaximum !== undefined) built = built.lt(schema.exclusiveMaximum);
        break;
      }
      case "boolean":
        built = z.boolean();
        break;
      case "array": {
        built = z.array(schema.items !== undefined ? build(schema.items, `${path}/items`) : z.unknown());
        if (schema.minItems !== undefined) built = built.min(schema.minItems);
        if (schema.maxItems !== undefined) built = built.max(schema.maxItems);
        break;
      }
      case "object": {
        const shape = {};
        const required = new Set(schema.required ?? []);
        for (const [name, sub] of Object.entries(schema.properties ?? {})) {
          const field = build(sub, `${path}/properties/${name}`);
          shape[name] = required.has(name) ? field : field.optional();
        }
        built = z
          .object(shape)
          .catchall(schema.additionalProperties === false ? z.never() : z.unknown());
        break;
      }
      default:
        unsupported(`type ${JSON.stringify(core?.[0])} at ${path}`);
    }
    if (Array.isArray(schema.enum) && core?.[0] !== "string") {
      built = built.refine((v) => schema.enum.some((c) => deepEqual(c, v)), {
        message: "value is not one of the allowed enum values",
      });
    }
    return nullable ? built.nullable() : built;
  }

  function buildDef(name) {
    registry[name] ??= build(defs[name], `#/$defs/${name}`);
    return registry[name];
  }

  for (const name of Object.keys(defs)) buildDef(name);
  return registry;
}
