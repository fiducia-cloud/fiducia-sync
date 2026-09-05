import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  Future<SqliteSyncStore> openStore() {
    return SqliteSyncStore.open(
      inMemoryDatabasePath,
      factory: databaseFactoryFfi,
    );
  }

  test('optimistic row and retry intent commit atomically', () async {
    final store = await openStore();
    const write = QueuedWrite(
      id: 'one',
      table: 'items',
      operation: ChangeOperation.upsert,
      payload: {'id': 'one', 'name': 'local'},
      baseVersion: 0,
      key: 'write-one',
    );
    final sequence = await store.enqueueOptimistic(write, write.payload);

    final row = await store.read('items', 'one');
    expect(row?.row['name'], 'local');
    expect(row?.metadata.dirty, isTrue);
    expect((await store.queuedWrites()).single.sequence, sequence);

    final settlement = await store.settleAcknowledgement(
      'items',
      'one',
      sequence,
      1,
    );
    expect(settlement.kind, AckSettlementKind.adopted);
    expect((await store.read('items', 'one'))?.metadata.version, 1);
    expect((await store.read('items', 'one'))?.metadata.dirty, isFalse);
    expect(await store.queuedWrites(), isEmpty);
    await store.close();
  });

  test(
    'replica timestamps preserve creation and advance synchronization',
    () async {
      final store = await openStore();
      await store.put('items', 'one', const {
        'id': 'one',
        'name': 'server',
      }, const LocalRowMetadata(version: 2, dirty: false));
      final initial = (await store.read('items', 'one'))!.metadata;
      expect(initial.createdAtMs, isNotNull);
      expect(initial.updatedAtMs, isNotNull);
      expect(initial.syncedAtMs, isNotNull);

      const write = QueuedWrite(
        id: 'one',
        table: 'items',
        operation: ChangeOperation.upsert,
        payload: {'id': 'one', 'name': 'local'},
        baseVersion: 2,
      );
      final sequence = await store.enqueueOptimistic(write, write.payload);
      final dirty = (await store.read('items', 'one'))!.metadata;
      expect(dirty.createdAtMs, initial.createdAtMs);
      expect(dirty.syncedAtMs, initial.syncedAtMs);
      expect(dirty.dirty, isTrue);

      await store.settleAcknowledgement('items', 'one', sequence, 3);
      final synced = (await store.read('items', 'one'))!.metadata;
      expect(synced.version, 3);
      expect(synced.dirty, isFalse);
      expect(synced.syncedAtMs! >= initial.syncedAtMs!, isTrue);
      await store.close();
    },
  );

  test(
    'an exact realtime echo adopts server data and retires its write',
    () async {
      final store = await openStore();
      const write = QueuedWrite(
        id: 'one',
        table: 'items',
        operation: ChangeOperation.upsert,
        payload: {'id': 'one', 'name': 'local'},
        baseVersion: 1,
        key: 'write-one',
      );
      final sequence = await store.enqueueOptimistic(write, write.payload);
      final adopted = await store.adoptEcho(
        const SyncChange(
          table: 'items',
          operation: ChangeOperation.upsert,
          id: 'one',
          version: 2,
          row: {'id': 'one', 'name': 'normalized'},
          writeKey: 'write-one',
        ),
        sequence,
      );

      expect(adopted, isTrue);
      expect((await store.read('items', 'one'))?.row['name'], 'normalized');
      expect((await store.read('items', 'one'))?.metadata.dirty, isFalse);
      expect(await store.queuedWrites(), isEmpty);
      await store.close();
    },
  );

  test(
    'server-wins conflict and stale queue removal share a transaction',
    () async {
      final store = await openStore();
      const write = QueuedWrite(
        id: 'one',
        table: 'items',
        operation: ChangeOperation.upsert,
        payload: {'id': 'one', 'name': 'local'},
        baseVersion: 2,
        key: 'write-one',
      );
      final sequence = await store.enqueueOptimistic(write, write.payload);
      await store.resolveConflict(
        const SyncChange(
          table: 'items',
          operation: ChangeOperation.upsert,
          id: 'one',
          version: 4,
          row: {'id': 'one', 'name': 'server'},
        ),
        [sequence],
      );

      final row = await store.read('items', 'one');
      expect(row?.row['name'], 'server');
      expect(row?.metadata.version, 4);
      expect(row?.metadata.dirty, isFalse);
      expect(await store.queuedWrites(), isEmpty);
      await store.close();
    },
  );

  test('durable cursors are scoped and monotonic', () async {
    final store = await openStore();
    expect(await store.getCursor('tenant-a'), 0);
    await store.setCursor(9, 'tenant-a');
    expect(await store.getCursor('tenant-a'), 9);
    expect(await store.getCursor('tenant-b'), 0);
    await expectLater(
      store.setCursor(8, 'tenant-a'),
      throwsA(isA<StateError>()),
    );
    await store.close();
  });
}
