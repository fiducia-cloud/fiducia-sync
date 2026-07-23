import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  test('Supabase realtime payloads map to the shared change envelope', () {
    final payload = PostgresChangePayload(
      schema: 'public',
      table: 'items',
      commitTimestamp: DateTime.utc(2026, 7, 22),
      eventType: PostgresChangeEvent.update,
      newRecord: const {'id': 'one', 'version': 4, 'name': 'updated'},
      oldRecord: const {'id': 'one', 'version': 3, 'name': 'old'},
      errors: null,
    );
    final change = decodeSupabasePayload('items', payload);
    expect(change?.operation, ChangeOperation.upsert);
    expect(change?.version, 4);
    expect(change?.row?['name'], 'updated');
  });

  test('unversioned Supabase deletes are rejected instead of made stale', () {
    final payload = PostgresChangePayload(
      schema: 'public',
      table: 'items',
      commitTimestamp: DateTime.utc(2026, 7, 22),
      eventType: PostgresChangeEvent.delete,
      newRecord: const {},
      oldRecord: const {'id': 'one'},
      errors: null,
    );
    expect(decodeSupabasePayload('items', payload), isNull);
  });
}
