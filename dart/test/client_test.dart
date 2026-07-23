import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

final class _TestSpan implements SyncTelemetrySpan {
  final phases = <SyncTelemetryPhase>[];
  String? recordedErrorType;
  var ended = false;

  @override
  void end() => ended = true;

  @override
  void error(String errorType) => recordedErrorType = errorType;

  @override
  void event(
    SyncTelemetryPhase phase, [
    Map<String, Object> attributes = const {},
  ]) {
    phases.add(phase);
  }
}

final class _TestTelemetry implements SyncTelemetry {
  final contexts = <SyncTelemetryContext>[];
  final events = <SyncTelemetryEvent>[];
  final spans = <_TestSpan>[];

  @override
  void emit(SyncTelemetryEvent event, SyncTelemetryContext context) {
    events.add(event);
  }

  @override
  SyncTelemetrySpan? startWrite(SyncTelemetryContext context) {
    contexts.add(context);
    final span = _TestSpan();
    spans.add(span);
    return span;
  }
}

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
    'local queue and pessimistic strategies control visibility explicitly',
    () async {
      final client = await openClient();
      final local = await client.write(
        table: 'items',
        id: 'local',
        row: const {'id': 'local', 'name': 'offline'},
        policy: const SyncWritePolicy(
          strategy: SyncWriteStrategy.localQueue,
          telemetry: SyncTelemetryLevel.off,
        ),
      );
      expect(local.acknowledged, isFalse);
      expect(local.attempts, 0);
      expect(
        (await client.store.read('items', 'local'))?.metadata.dirty,
        isTrue,
      );

      await client.store.put('items', 'server', const {
        'id': 'server',
        'name': 'before',
      }, const LocalRowMetadata(version: 3, dirty: false));
      final pessimistic = await client.write(
        table: 'items',
        id: 'server',
        row: const {'id': 'server', 'name': 'after'},
        policy: const SyncWritePolicy(
          strategy: SyncWriteStrategy.pessimistic,
          telemetry: SyncTelemetryLevel.off,
        ),
        send: (write) async {
          expect(
            (await client.store.read('items', 'server'))?.row['name'],
            'before',
          );
          return const WriteAcknowledgement(id: 'server', committedVersion: 4);
        },
      );
      expect(pessimistic.acknowledged, isTrue);
      expect(
        (await client.store.read('items', 'server'))?.row['name'],
        'after',
      );
      await client.close();
    },
  );

  test(
    'throw and emit-only failure modes retain the same durable retry',
    () async {
      final client = await openClient();
      Future<WriteAcknowledgement> offline(QueuedWrite _) async =>
          throw StateError('offline');

      await expectLater(
        client.write(
          table: 'items',
          id: 'throw',
          row: const {'id': 'throw'},
          send: offline,
          policy: const SyncWritePolicy(
            failureMode: SyncFailureMode.throwError,
            telemetry: SyncTelemetryLevel.off,
          ),
        ),
        throwsA(
          isA<SyncWriteException>().having(
            (error) => error.result.attempts,
            'attempts',
            1,
          ),
        ),
      );
      final emitted = await client.write(
        table: 'items',
        id: 'emit',
        row: const {'id': 'emit'},
        send: offline,
        policy: const SyncWritePolicy(
          failureMode: SyncFailureMode.emitOnly,
          telemetry: SyncTelemetryLevel.off,
        ),
      );
      expect(emitted.attempts, 1);
      expect(emitted.error, isNull);
      expect(await client.store.queuedWrites(), hasLength(2));
      await client.close();
    },
  );

  test(
    'telemetry remains low-cardinality and omits row identity and payload',
    () async {
      final telemetry = _TestTelemetry();
      final store = await SqliteSyncStore.open(
        inMemoryDatabasePath,
        factory: databaseFactoryFfi,
      );
      final client = FiduciaSyncClient(
        store: store,
        telemetry: telemetry,
        writePolicy: const SyncWritePolicy(
          telemetry: SyncTelemetryLevel.lifecycle,
        ),
      );
      await client.write(
        table: 'items',
        id: 'secret-row-id',
        row: const {'token': 'secret-payload'},
        send: (write) async =>
            WriteAcknowledgement(id: write.id, committedVersion: 1),
      );

      expect(telemetry.events.map((event) => event.phase), [
        SyncTelemetryPhase.localQueued,
        SyncTelemetryPhase.sendStarted,
        SyncTelemetryPhase.acknowledged,
      ]);
      final rendered = [
        ...telemetry.contexts.map((context) => context.attributes.toString()),
        ...telemetry.events.map((event) => event.phase.wireName),
      ].join();
      expect(rendered, isNot(contains('secret-row-id')));
      expect(rendered, isNot(contains('secret-payload')));
      expect(telemetry.spans.single.ended, isTrue);
      await client.close();
    },
  );

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
