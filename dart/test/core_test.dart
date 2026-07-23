import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';

SyncChange change({
  ChangeOperation operation = ChangeOperation.upsert,
  int version = 1,
  String? writeKey,
}) {
  return SyncChange(
    table: 'items',
    operation: operation,
    id: 'one',
    version: version,
    row: const {'id': 'one'},
    writeKey: writeKey,
  );
}

void main() {
  test('Dart reconciliation mirrors the Rust and browser ordering rules', () {
    expect(reconcile(null, change()).kind, ReconcileKind.apply);
    expect(
      reconcile(null, change(operation: ChangeOperation.delete)).ignoreReason,
      IgnoreReason.alreadyApplied,
    );
    expect(
      reconcile(
        const LocalRowMetadata(version: 5, dirty: false),
        change(version: 4),
      ).ignoreReason,
      IgnoreReason.stale,
    );
    expect(
      reconcile(
        const LocalRowMetadata(version: 5, dirty: true),
        change(version: 6),
      ).kind,
      ReconcileKind.conflict,
    );
  });

  test('keyed echoes require the exact durable write identity', () {
    const queued = QueuedWrite(
      id: 'one',
      table: 'items',
      operation: ChangeOperation.upsert,
      payload: {'id': 'one'},
      baseVersion: 5,
      key: 'write-a',
    );
    expect(isOwnEcho(queued, change(version: 9, writeKey: 'write-a')), isTrue);
    expect(isOwnEcho(queued, change(version: 6)), isFalse);
    expect(isOwnEcho(queued, change(version: 6, writeKey: 'write-b')), isFalse);
  });

  test('wire envelopes accept Postgres journal aliases', () {
    final decoded = SyncChange.fromJson(const {
      'table_name': 'items',
      'operation': 'delete',
      'row_id': 'one',
      'version': 3,
      'row_data': null,
      'at_ms': 42,
    });
    expect(decoded.operation, ChangeOperation.delete);
    expect(decoded.toJson(), {
      'table': 'items',
      'op': 'delete',
      'id': 'one',
      'version': 3,
      'row': null,
      'at_ms': 42,
    });
  });

  test('deep merge keeps nested siblings and does not mutate inputs', () {
    const base = {
      'name': 'one',
      'settings': {'a': 1, 'b': 2},
    };
    const patch = {
      'settings': {'b': 3},
    };
    expect(deepMerge(base, patch), {
      'name': 'one',
      'settings': {'a': 1, 'b': 3},
    });
    expect(base['settings'], {'a': 1, 'b': 2});
  });
}
