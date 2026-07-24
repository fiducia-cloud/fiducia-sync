/// Runtime validation for the canonical sync envelopes — the Dart mirror of
/// the Rust subset validator (`src/schema.rs`) and the JS SDK
/// (`sdk/src/validate.mjs`), driven by the SAME embedded JSON Schema
/// (`sync_schema.dart`, generated from the vendored
/// `schema/sync.schema.json`) and pinned to the same shared fixtures.
///
/// The engine is a deliberate SUBSET interpreter that FAILS CLOSED: a schema
/// using a keyword outside the supported set is rejected at load time rather
/// than silently under-validated. Apps can validate their own row/ORM shapes
/// with `SchemaValidator(theirSchemaDocument)`.
library;

import 'dart:convert';

import 'sync_schema.dart';

const Set<String> _enforced = {
  r'$ref',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
};
const Set<String> _metadata = {
  r'$schema',
  r'$id',
  r'$defs',
  r'$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
};
const int _maxDepth = 64;

/// One reason a value failed validation, anchored to a JSON path.
final class SchemaViolation {
  const SchemaViolation(this.path, this.message);

  final String path;
  final String message;

  @override
  String toString() => '$path: $message';
}

/// Thrown by [SchemaValidator.check]; carries every violation found.
final class SchemaValidationException implements Exception {
  const SchemaValidationException(this.definition, this.violations);

  final String definition;
  final List<SchemaViolation> violations;

  @override
  String toString() =>
      '$definition failed schema validation — ${violations.take(3).join('; ')}'
      '${violations.length > 3 ? '; …' : ''}';
}

/// A loaded schema document whose `$defs` can validate values.
final class SchemaValidator {
  /// Load a schema document; rejects unsupported keywords (fail closed).
  SchemaValidator(this._root) {
    _checkSupported(_root, '#');
  }

  /// The embedded canonical sync envelope schema.
  factory SchemaValidator.sync() => _sync ??= SchemaValidator(
    Map<String, Object?>.from(jsonDecode(syncSchemaJson) as Map),
  );

  static SchemaValidator? _sync;

  final Map<String, Object?> _root;

  Map<String, Object?> get _defs => switch (_root[r'$defs']) {
    final Map defs => Map<String, Object?>.from(defs),
    _ => const {},
  };

  /// The `$defs` names this document can validate.
  List<String> get definitions => _defs.keys.toList(growable: false);

  /// Every violation of `value` against `#/$defs/<definition>` (empty = valid).
  List<SchemaViolation> validate(String definition, Object? value) {
    final schema = _defs[definition];
    if (schema == null) {
      return [SchemaViolation(r'$', 'unknown schema definition "$definition"')];
    }
    final out = <SchemaViolation>[];
    _check(schema, value, r'$', 0, out);
    return out;
  }

  /// Return `value` when valid; throw [SchemaValidationException] otherwise.
  T check<T>(String definition, T value) {
    final violations = validate(definition, value);
    if (violations.isNotEmpty) {
      throw SchemaValidationException(definition, violations);
    }
    return value;
  }

  void _check(
    Object? schema,
    Object? value,
    String path,
    int depth,
    List<SchemaViolation> out,
  ) {
    if (depth > _maxDepth) {
      out.add(SchemaViolation(path, r'schema nesting/$ref depth exceeded'));
      return;
    }
    if (schema == true) return;
    if (schema == false) {
      out.add(SchemaViolation(path, 'schema forbids any value'));
      return;
    }
    final node = schema is Map ? Map<String, Object?>.from(schema) : null;
    if (node == null) {
      out.add(
        SchemaViolation(path, 'schema node must be an object or boolean'),
      );
      return;
    }

    final reference = node[r'$ref'];
    if (reference is String) {
      final name = reference.startsWith(r'#/$defs/')
          ? reference.substring(8)
          : null;
      final target = name == null ? null : _defs[name];
      if (target == null) {
        out.add(SchemaViolation(path, 'unresolvable \$ref "$reference"'));
      } else {
        _check(target, value, path, depth + 1, out);
      }
    }

    final type = node['type'];
    if (type != null) {
      final names = type is List ? type.cast<String>() : [type as String];
      if (!names.any((name) => _matchesType(name, value))) {
        out.add(
          SchemaViolation(path, 'expected type $type, got ${_typeName(value)}'),
        );
        return; // Remaining keyword checks presume the right type.
      }
    }
    final allowed = node['enum'];
    if (allowed is List && !allowed.any((c) => _deepEqual(c, value))) {
      out.add(
        SchemaViolation(path, 'value is not one of the allowed enum values'),
      );
    }
    if (node.containsKey('const') && !_deepEqual(node['const'], value)) {
      out.add(SchemaViolation(path, 'value does not equal the required const'));
    }

    if (value is String) {
      // JSON Schema string lengths count Unicode code points.
      final length = value.runes.length;
      final minLength = node['minLength'];
      if (minLength is int && length < minLength) {
        out.add(
          SchemaViolation(path, 'string is shorter than minLength $minLength'),
        );
      }
      final maxLength = node['maxLength'];
      if (maxLength is int && length > maxLength) {
        out.add(
          SchemaViolation(path, 'string is longer than maxLength $maxLength'),
        );
      }
    }

    if (value is num && value is! bool && value.isFinite) {
      void bound(String keyword, bool ok) {
        if (!ok) out.add(SchemaViolation(path, 'number violates $keyword'));
      }

      final minimum = node['minimum'];
      if (minimum is num) bound('minimum', value >= minimum);
      final maximum = node['maximum'];
      if (maximum is num) bound('maximum', value <= maximum);
      final exclusiveMinimum = node['exclusiveMinimum'];
      if (exclusiveMinimum is num) {
        bound('exclusiveMinimum', value > exclusiveMinimum);
      }
      final exclusiveMaximum = node['exclusiveMaximum'];
      if (exclusiveMaximum is num) {
        bound('exclusiveMaximum', value < exclusiveMaximum);
      }
    }

    if (value is Map) {
      final object = Map<String, Object?>.from(value);
      final required = node['required'];
      if (required is List) {
        for (final name in required.cast<String>()) {
          if (!object.containsKey(name)) {
            out.add(SchemaViolation(path, 'missing required property "$name"'));
          }
        }
      }
      final properties = node['properties'] is Map
          ? Map<String, Object?>.from(node['properties'] as Map)
          : null;
      if (properties != null) {
        for (final entry in properties.entries) {
          if (object.containsKey(entry.key)) {
            _check(
              entry.value,
              object[entry.key],
              '$path.${entry.key}',
              depth + 1,
              out,
            );
          }
        }
      }
      final additional = node['additionalProperties'];
      if (additional == false) {
        for (final name in object.keys) {
          if (properties == null || !properties.containsKey(name)) {
            out.add(
              SchemaViolation(path, 'unexpected additional property "$name"'),
            );
          }
        }
      } else if (additional != null && additional != true) {
        for (final entry in object.entries) {
          if (properties == null || !properties.containsKey(entry.key)) {
            _check(
              additional,
              entry.value,
              '$path.${entry.key}',
              depth + 1,
              out,
            );
          }
        }
      }
    }

    if (value is List) {
      final items = node['items'];
      if (items != null) {
        for (var i = 0; i < value.length; i += 1) {
          _check(items, value[i], '$path[$i]', depth + 1, out);
        }
      }
      final minItems = node['minItems'];
      if (minItems is int && value.length < minItems) {
        out.add(
          SchemaViolation(path, 'array has fewer than minItems $minItems'),
        );
      }
      final maxItems = node['maxItems'];
      if (maxItems is int && value.length > maxItems) {
        out.add(
          SchemaViolation(path, 'array has more than maxItems $maxItems'),
        );
      }
      if (node['uniqueItems'] == true) {
        for (var i = 0; i < value.length; i += 1) {
          if (value.sublist(0, i).any((prior) => _deepEqual(prior, value[i]))) {
            out.add(SchemaViolation('$path[$i]', 'array items are not unique'));
            break;
          }
        }
      }
    }

    bool passes(Object? sub) {
      final probe = <SchemaViolation>[];
      _check(sub, value, path, depth + 1, probe);
      return probe.isEmpty;
    }

    final anyOf = node['anyOf'];
    if (anyOf is List && !anyOf.any(passes)) {
      out.add(SchemaViolation(path, 'value matches no anyOf branch'));
    }
    final oneOf = node['oneOf'];
    if (oneOf is List) {
      final matches = oneOf.where(passes).length;
      if (matches != 1) {
        out.add(
          SchemaViolation(
            path,
            'value matches $matches oneOf branches, expected exactly 1',
          ),
        );
      }
    }
    final allOf = node['allOf'];
    if (allOf is List) {
      for (final branch in allOf) {
        _check(branch, value, path, depth + 1, out);
      }
    }
    if (node.containsKey('not') && passes(node['not'])) {
      out.add(
        SchemaViolation(path, 'value matches the forbidden `not` schema'),
      );
    }
  }
}

String _typeName(Object? value) => switch (value) {
  null => 'null',
  bool _ => 'boolean',
  int _ => 'integer',
  final double d =>
    d.isFinite && d == d.truncateToDouble() ? 'integer' : 'number',
  String _ => 'string',
  List _ => 'array',
  Map _ => 'object',
  _ => value.runtimeType.toString(),
};

bool _matchesType(String name, Object? value) => switch (name) {
  'object' => value is Map,
  'array' => value is List,
  'string' => value is String,
  'boolean' => value is bool,
  'null' => value == null,
  'number' => value is num && value is! bool && value.isFinite,
  'integer' =>
    value is int ||
        (value is double &&
            value.isFinite &&
            value == value.truncateToDouble()),
  _ => false,
};

bool _deepEqual(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is num && b is num) return a == b;
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    return a.entries.every(
      (entry) =>
          b.containsKey(entry.key) && _deepEqual(entry.value, b[entry.key]),
    );
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (!_deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// Reject schemas outside the enforced subset (fail closed, grammar-aware).
void _checkSupported(Object? node, String path) {
  if (node is bool) return;
  if (node is! Map) {
    throw FormatException('schema node at $path must be an object or boolean');
  }
  for (final entry in Map<String, Object?>.from(node).entries) {
    final key = entry.key;
    final child = entry.value;
    if (key == 'properties' || key == r'$defs') {
      if (child is! Map) {
        throw FormatException('$path/$key must be an object of schemas');
      }
      for (final sub in Map<String, Object?>.from(child).entries) {
        _checkSupported(sub.value, '$path/$key/${sub.key}');
      }
    } else if (key == 'items' ||
        key == 'additionalProperties' ||
        key == 'not') {
      _checkSupported(child, '$path/$key');
    } else if (key == 'anyOf' || key == 'oneOf' || key == 'allOf') {
      if (child is! List) {
        throw FormatException('$path/$key must be an array of schemas');
      }
      for (var i = 0; i < child.length; i += 1) {
        _checkSupported(child[i], '$path/$key[$i]');
      }
    } else if (!_enforced.contains(key) && !_metadata.contains(key)) {
      throw FormatException(
        'unsupported keyword "$key" at $path — the fiducia-sync subset '
        'validator fails closed rather than under-validating',
      );
    }
  }
}
