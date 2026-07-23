import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  Future<FiduciaSyncClient> openClient([String Function()? keys]) async {
    final store = await SqliteSyncStore.open(
      inMemoryDatabasePath,
      factory: databaseFactoryFfi,
    );
    return FiduciaSyncClient(store: store, writeKeyFactory: keys);
  }

  test(
    'mobile optimistic writes adopt acknowledgements transactionally',
    () async {
      final client = await openClient(() => 'write-one');
      final result = await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one', 'name': 'local'},
        send: (write) async {
          expect(write.key, 'write-one');
          expect(write.payload?['name'], 'local');
          return const WriteAcknowledgement(id: 'one', committedVersion: 1);
        },
      );

      expect(result.acknowledged, isTrue);
      final row = await client.store.read('items', 'one');
      expect(row?.metadata.version, 1);
      expect(row?.metadata.dirty, isFalse);
      expect(await client.store.queuedWrites(), isEmpty);
      await client.close();
    },
  );

  test('offline writes survive and flush with the same key', () async {
    final client = await openClient(() => 'stable-key');
    final queued = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one'},
      send: (_) async => throw StateError('offline'),
    );
    expect(queued.acknowledged, isFalse);
    expect(queued.attempts, 1);
    expect((await client.store.queuedWrites()).single.key, 'stable-key');

    final flushed = await client.flushQueue((write) async {
      expect(write.key, 'stable-key');
      return const WriteAcknowledgement(id: 'one', committedVersion: 1);
    });
    expect(flushed, 1);
    expect(await client.store.queuedWrites(), isEmpty);
    await client.close();
  });

  test(
    'third-party base-plus-one changes cannot impersonate keyed echoes',
    () async {
      final client = await openClient(() => 'mine');
      await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one', 'name': 'mine'},
        send: (_) async => throw StateError('offline'),
      );

      final outcome = await client.applyChange(
        const SyncChange(
          table: 'items',
          operation: ChangeOperation.upsert,
          id: 'one',
          version: 1,
          row: {'id': 'one', 'name': 'theirs'},
        ),
      );
      expect(outcome, 'conflict-resolved');
      expect((await client.store.read('items', 'one'))?.row['name'], 'theirs');
      expect(await client.store.queuedWrites(), isEmpty);
      await client.close();
    },
  );

  test('cursor pull applies pages before advancing durable progress', () async {
    final client = await openClient();
    final seen = <int>[];
    final count = await client.pull((cursor, limit) async {
      seen.add(cursor);
      if (cursor == 0) {
        return const PullPage(
          changes: [
            SyncChange(
              table: 'items',
              operation: ChangeOperation.upsert,
              id: 'one',
              version: 1,
              row: {'id': 'one', 'version': 1},
            ),
          ],
          nextCursor: 1,
          hasMore: true,
        );
      }
      return const PullPage(
        changes: [
          SyncChange(
            table: 'items',
            operation: ChangeOperation.upsert,
            id: 'one',
            version: 2,
            row: {'id': 'one', 'version': 2},
          ),
        ],
        nextCursor: 2,
        hasMore: false,
      );
    });

    expect(count, 2);
    expect(seen, [0, 1]);
    expect(await client.store.getCursor(), 2);
    expect((await client.store.read('items', 'one'))?.metadata.version, 2);
    await client.close();
  });
}
