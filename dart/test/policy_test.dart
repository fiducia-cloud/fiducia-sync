import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  Future<(FiduciaSyncClient, List<SyncTelemetryEvent>)> openClient({
    WritePolicy policy = WritePolicy.localFirst,
    SyncErrorMode errorMode = SyncErrorMode.returnResult,
  }) async {
    final store = await SqliteSyncStore.open(
      inMemoryDatabasePath,
      factory: databaseFactoryFfi,
      nowMs: () => 7000,
    );
    final events = <SyncTelemetryEvent>[];
    final client = FiduciaSyncClient(
      store: store,
      telemetry: events.add,
      nowMs: () => 7000,
      writePolicy: policy,
      errorMode: errorMode,
    );
    return (client, events);
  }

  Future<WriteAcknowledgement> Function(QueuedWrite) ok(int version) =>
      (write) async =>
          WriteAcknowledgement(id: write.id, committedVersion: version);
  Future<WriteAcknowledgement> offline(QueuedWrite _) async =>
      throw StateError('offline');

  test('the vocabulary is enums with canonical wire names', () {
    expect(WritePolicy.values.map((p) => p.wireName), [
      'local-only',
      'local-first',
      'server-first',
      'server-only',
    ]);
    expect(SyncErrorMode.values.map((m) => m.wireName), [
      'return',
      'throw',
      'emit',
    ]);
    expect(WritePolicy.fromWire('server-first'), WritePolicy.serverFirst);
    expect(() => WritePolicy.fromWire('yolo'), throwsArgumentError);
    expect(SyncErrorMode.fromWire('emit'), SyncErrorMode.emitOnly);
    expect(() => SyncErrorMode.fromWire('panic'), throwsArgumentError);

    // The semantics matrix matches src/policy.rs exactly.
    expect(WritePolicy.localOnly.mutatesLocalBeforeSend, isTrue);
    expect(WritePolicy.localOnly.sendsImmediately, isFalse);
    expect(WritePolicy.localFirst.adoptsAckLocally, isTrue);
    expect(WritePolicy.serverFirst.enqueuesDurably, isFalse);
    expect(WritePolicy.serverFirst.adoptsAckLocally, isTrue);
    expect(WritePolicy.serverOnly.adoptsAckLocally, isFalse);
  });

  test(
    'localOnly mutates + enqueues without sending; flush sends later',
    () async {
      final (client, events) = await openClient();
      var sends = 0;
      final result = await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one', 'name': 'draft'},
        policy: WritePolicy.localOnly,
      );
      expect(result.status, WriteStatus.queued);
      expect(result.attempts, 0);
      final stored = await client.store.read('items', 'one');
      expect(stored?.metadata.dirty, isTrue);
      expect((await client.store.queuedWrites()).length, 1);

      final flushed = await client.flushQueue((write) async {
        sends += 1;
        return WriteAcknowledgement(id: write.id, committedVersion: 1);
      });
      expect(flushed, 1);
      expect(sends, 1);
      final write = events.firstWhere((e) => e.name == 'fiducia.sync.write');
      expect(write.attributes['sync.policy'], 'local-only');
      await client.close();
    },
  );

  test('localFirst + throwError rejects typed and stays queued', () async {
    final (client, _) = await openClient();
    await expectLater(
      client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one'},
        send: offline,
        errorMode: SyncErrorMode.throwError,
      ),
      throwsA(
        isA<SyncWriteException>()
            .having((e) => e.queued, 'queued', isTrue)
            .having((e) => e.attempts, 'attempts', 1)
            .having((e) => e.policy, 'policy', WritePolicy.localFirst),
      ),
    );
    expect((await client.store.queuedWrites()).length, 1);
    await client.close();
  });

  test(
    'localFirst + emitOnly resolves quietly; telemetry still sees it',
    () async {
      final (client, events) = await openClient(
        errorMode: SyncErrorMode.emitOnly,
      );
      final result = await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one'},
        send: offline,
      );
      expect(result.status, WriteStatus.queued);
      expect(result.error, isNull);
      final write = events.firstWhere((e) => e.name == 'fiducia.sync.write');
      expect(write.attributes['sync.outcome'], 'queued');
      await client.close();
    },
  );

  test('serverFirst adopts the ack locally with no queue entry', () async {
    final (client, _) = await openClient();
    final result = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one', 'name': 'safe'},
      send: ok(4),
      policy: WritePolicy.serverFirst,
    );
    expect(result.status, WriteStatus.acked);
    expect(result.version, 4);
    final stored = await client.store.read('items', 'one');
    expect(stored?.metadata.version, 4);
    expect(stored?.metadata.dirty, isFalse);
    expect(stored?.metadata.syncedAtMs, 7000);
    expect(await client.store.queuedWrites(), isEmpty);
    await client.close();
  });

  test('serverFirst failure leaves local state untouched', () async {
    final (client, _) = await openClient();
    await client.store.put('items', 'one', const {
      'id': 'one',
      'name': 'committed',
    }, const LocalRowMetadata(version: 2, dirty: false));
    final result = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one', 'name': 'nope'},
      send: offline,
      policy: WritePolicy.serverFirst,
    );
    expect(result.status, WriteStatus.failed);
    expect(result.error, isA<StateError>());
    final stored = await client.store.read('items', 'one');
    expect(stored?.row['name'], 'committed');
    expect(await client.store.queuedWrites(), isEmpty);
    await client.close();
  });

  test('serverFirst never downgrades a newer local version', () async {
    final (client, _) = await openClient();
    await client.store.put('items', 'one', const {
      'id': 'one',
      'name': 'newer',
    }, const LocalRowMetadata(version: 9, dirty: false));
    final result = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one', 'name': 'old'},
      send: ok(4),
      policy: WritePolicy.serverFirst,
    );
    expect(result.status, WriteStatus.acked);
    final stored = await client.store.read('items', 'one');
    expect(stored?.metadata.version, 9);
    expect(stored?.row['name'], 'newer');
    await client.close();
  });

  test('serverOnly touches nothing locally; the echo lands the row', () async {
    final (client, _) = await openClient(policy: WritePolicy.serverOnly);
    final result = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one', 'name': 'pure'},
      send: ok(1),
    );
    expect(result.status, WriteStatus.acked);
    expect(await client.store.read('items', 'one'), isNull);
    expect(await client.store.queuedWrites(), isEmpty);

    await client.applyChange(
      const SyncChange(
        table: 'items',
        operation: ChangeOperation.upsert,
        id: 'one',
        version: 1,
        row: {'id': 'one', 'name': 'pure'},
        atMs: 5,
      ),
    );
    expect((await client.store.read('items', 'one'))?.row['name'], 'pure');
    await client.close();
  });

  test('sendsImmediately policies require a send function', () async {
    final (client, _) = await openClient();
    await expectLater(
      client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one'},
        policy: WritePolicy.serverOnly,
      ),
      throwsArgumentError,
    );
    await client.close();
  });

  test(
    'flushQueue emitOnly resolves despite failures; default throws',
    () async {
      final (client, events) = await openClient();
      await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one'},
        send: offline,
      );
      await expectLater(
        client.flushQueue(offline),
        throwsA(isA<QueueFlushException>()),
      );
      final flushed = await client.flushQueue(
        offline,
        errorMode: SyncErrorMode.emitOnly,
      );
      expect(flushed, 0);
      final flush = events.lastWhere((e) => e.name == 'fiducia.sync.flush');
      expect(flush.isError, isTrue);
      expect(flush.attributes['sync.failures'], 1);
      await client.close();
    },
  );

  test('a throwing telemetry sink cannot break sync', () async {
    final store = await SqliteSyncStore.open(
      inMemoryDatabasePath,
      factory: databaseFactoryFfi,
    );
    final client = FiduciaSyncClient(
      store: store,
      telemetry: (_) => throw StateError('sink exploded'),
    );
    final result = await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one'},
      send: ok(1),
    );
    expect(result.status, WriteStatus.acked);
    await client.close();
  });

  test('conflicts emit a dedicated server-wins event', () async {
    final (client, events) = await openClient();
    await client.optimisticWrite(
      table: 'items',
      id: 'one',
      row: const {'id': 'one', 'name': 'mine'},
      send: offline,
    );
    final outcome = await client.applyChange(
      const SyncChange(
        table: 'items',
        operation: ChangeOperation.upsert,
        id: 'one',
        version: 5,
        row: {'id': 'one', 'name': 'theirs'},
        atMs: 11,
      ),
    );
    expect(outcome, 'conflict-resolved');
    final conflict = events.firstWhere(
      (e) => e.name == 'fiducia.sync.conflict',
    );
    expect(conflict.attributes['sync.resolution'], 'server-wins');
    await client.close();
  });
}
