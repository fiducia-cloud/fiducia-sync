import 'dart:io';

import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// synced_at semantics (per-row + per-plane) and the v1→v2 SQLite migration.
void main() {
  setUpAll(sqfliteFfiInit);

  test(
    'server adoptions stamp; dirty writes preserve; acks re-stamp',
    () async {
      var currentNow = 100;
      final store = await SqliteSyncStore.open(
        inMemoryDatabasePath,
        factory: databaseFactoryFfi,
        nowMs: () => currentNow,
      );
      final client = FiduciaSyncClient(store: store, nowMs: () => currentNow);

      await client.applyChange(
        const SyncChange(
          table: 'items',
          operation: ChangeOperation.upsert,
          id: 'one',
          version: 1,
          row: {'id': 'one', 'name': 'server'},
          atMs: 0,
        ),
      );
      expect((await store.read('items', 'one'))?.metadata.syncedAtMs, 100);

      currentNow = 300;
      await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one', 'name': 'mine'},
        send: (_) async => throw StateError('offline'),
      );
      final dirty = (await store.read('items', 'one'))!.metadata;
      expect(dirty.dirty, isTrue);
      expect(
        dirty.syncedAtMs,
        100,
        reason: 'editing must not un-sync the base',
      );

      currentNow = 400;
      await client.flushQueue(
        (write) async =>
            WriteAcknowledgement(id: write.id, committedVersion: 2),
      );
      final settled = (await store.read('items', 'one'))!.metadata;
      expect(settled.dirty, isFalse);
      expect(settled.version, 2);
      expect(settled.syncedAtMs, 400);

      // A never-synced local draft reads back null.
      await client.optimisticWrite(
        table: 'items',
        id: 'fresh',
        row: const {'id': 'fresh'},
        send: (_) async => throw StateError('offline'),
      );
      expect((await store.read('items', 'fresh'))?.metadata.syncedAtMs, isNull);
      await client.close();
    },
  );

  test(
    'plane freshness: cursor advances stamp; markSynced stamps alone',
    () async {
      var currentNow = 500;
      final store = await SqliteSyncStore.open(
        inMemoryDatabasePath,
        factory: databaseFactoryFfi,
        nowMs: () => currentNow,
      );
      var info = await store.syncInfo();
      expect(info.cursor, 0);
      expect(info.lastSyncedAtMs, isNull);

      await store.setCursor(12);
      info = await store.syncInfo();
      expect(info.cursor, 12);
      expect(info.lastSyncedAtMs, 500);

      currentNow = 600;
      expect(await store.markSynced(), 600);
      info = await store.syncInfo();
      expect(info.cursor, 12);
      expect(info.lastSyncedAtMs, 600);

      // Scopes stay independent.
      final other = await store.syncInfo('other');
      expect(other.cursor, 0);
      expect(other.lastSyncedAtMs, isNull);
      await store.close();
    },
  );

  test(
    'v1 databases upgrade in place, preserving rows and queued writes',
    () async {
      // Build a REAL v1 database (no synced_at_ms / hlc columns) on disk.
      final path =
          '${Directory.systemTemp.createTempSync('fiducia-sync').path}/v1.db';
      final v1 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (db, _) async {
            await db.execute('''
            create table _fiducia_rows (
              table_name text not null,
              row_id text not null,
              row_json text not null,
              version integer not null,
              dirty integer not null check (dirty in (0, 1)),
              primary key (table_name, row_id)
            )
          ''');
            await db.execute('''
            create table _fiducia_queue (
              seq integer primary key autoincrement,
              table_name text not null,
              row_id text not null,
              operation text not null check (operation in ('upsert', 'delete')),
              payload_json text,
              base_version integer not null,
              write_key text,
              attempts integer not null default 0,
              superseded_version integer
            )
          ''');
            await db.execute('''
            create table _fiducia_metadata (
              key text primary key,
              value integer not null
            )
          ''');
          },
        ),
      );
      await v1.insert('_fiducia_rows', {
        'table_name': 'items',
        'row_id': 'legacy',
        'row_json': '{"id":"legacy"}',
        'version': 4,
        'dirty': 0,
      });
      await v1.insert('_fiducia_queue', {
        'table_name': 'items',
        'row_id': 'legacy',
        'operation': 'upsert',
        'payload_json': '{"id":"legacy"}',
        'base_version': 4,
        'write_key': 'w-legacy',
      });
      await v1.close();

      final upgraded = await SqliteSyncStore.open(
        path,
        factory: databaseFactoryFfi,
        nowMs: () => 999,
      );
      final row = await upgraded.read('items', 'legacy');
      expect(row?.metadata.version, 4);
      expect(
        row?.metadata.syncedAtMs,
        isNull,
        reason: 'legacy rows read as never-synced',
      );
      final queued = (await upgraded.queuedWrites()).single;
      expect(queued.key, 'w-legacy');
      expect(queued.hlc, isNull);

      // New writes on the upgraded database use the new columns.
      await upgraded.put('items', 'legacy', const {
        'id': 'legacy',
        'name': 'refreshed',
      }, const LocalRowMetadata(version: 5, dirty: false));
      expect(
        (await upgraded.read('items', 'legacy'))?.metadata.syncedAtMs,
        999,
      );
      await upgraded.close();
    },
  );
}
