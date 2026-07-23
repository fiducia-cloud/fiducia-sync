import 'dart:async';
import 'dart:math';

import 'core.dart';
import 'models.dart';
import 'store.dart';

typedef SendWrite = Future<WriteAcknowledgement> Function(QueuedWrite write);
typedef PullChanges = Future<PullPage> Function(int cursor, int limit);

final class FiduciaSyncClient {
  FiduciaSyncClient({required this.store, String Function()? writeKeyFactory})
    : _writeKeyFactory = writeKeyFactory ?? _secureWriteKey;

  final SyncStore store;
  final String Function() _writeKeyFactory;
  Future<void> _mutationTail = Future<void>.value();

  Future<T> _mutate<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    final previous = _mutationTail;
    _mutationTail = () async {
      try {
        await previous;
      } on Object {
        // A failed prior operation must not poison later local mutations.
      }
      try {
        result.complete(await operation());
      } on Object catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    }();
    return result.future;
  }

  Future<String> applyChange(SyncChange event) {
    return _mutate(() => _applyChange(event));
  }

  Future<String> _applyChange(SyncChange event) async {
    final local = await store.read(event.table, event.id);
    final rowWrites = (await store.queuedWrites())
        .where((write) => write.table == event.table && write.id == event.id)
        .toList(growable: false);
    QueuedWrite? echo;
    for (final write in rowWrites) {
      if (isOwnEcho(write, event)) {
        echo = write;
        break;
      }
    }
    final echoSequence = echo?.sequence;
    if (echoSequence != null && await store.adoptEcho(event, echoSequence)) {
      return 'echo-adopted';
    }

    final LocalRowMetadata? reconcileLocal;
    if (rowWrites.isEmpty) {
      reconcileLocal = local?.metadata;
    } else {
      reconcileLocal = LocalRowMetadata(
        version:
            local?.metadata.version ??
            rowWrites.map((write) => write.baseVersion).reduce(max),
        dirty: true,
      );
    }
    final decision = reconcile(reconcileLocal, event);
    switch (decision.kind) {
      case ReconcileKind.apply:
        await _applyServer(event);
        return 'applied';
      case ReconcileKind.conflict:
        await store.resolveConflict(
          event,
          rowWrites
              .map((write) => write.sequence)
              .whereType<int>()
              .toList(growable: false),
        );
        return 'conflict-resolved';
      case ReconcileKind.ignore:
        if (decision.ignoreReason == IgnoreReason.alreadyApplied &&
            rowWrites.isEmpty &&
            (local == null || !local.metadata.dirty)) {
          await _applyServer(event);
          return 'refreshed';
        }
        return 'ignored';
    }
  }

  Future<void> _applyServer(SyncChange event) async {
    if (event.operation == ChangeOperation.delete) {
      await store.delete(event.table, event.id);
    } else {
      final row = event.row;
      if (row == null) {
        throw const FormatException('upsert change must carry a row');
      }
      await store.put(
        event.table,
        event.id,
        row,
        LocalRowMetadata(version: event.version, dirty: false),
      );
    }
  }

  Future<OptimisticWriteResult> optimisticWrite({
    required String table,
    required String id,
    required JsonMap? row,
    required SendWrite send,
    ChangeOperation operation = ChangeOperation.upsert,
    bool merge = false,
  }) async {
    final queued = await _mutate(() async {
      final local = await store.read(table, id);
      final payload = switch (operation) {
        ChangeOperation.delete => null,
        ChangeOperation.upsert when merge => deepMerge(
          local?.row ?? const <String, Object?>{},
          row ?? const {},
        ),
        ChangeOperation.upsert =>
          row ??
              (throw const FormatException(
                'optimistic upsert must carry a row',
              )),
      };
      final write = QueuedWrite(
        id: id,
        table: table,
        operation: operation,
        payload: payload,
        baseVersion: local?.metadata.version ?? 0,
        key: _writeKeyFactory(),
      );
      final sequence = await store.enqueueOptimistic(write, payload);
      return write.copyWith(sequence: sequence);
    });

    try {
      final acknowledgement = await send(queued);
      _validateAcknowledgement(queued, acknowledgement);
      final settlement = await _mutate(
        () => store.settleAcknowledgement(
          table,
          id,
          queued.sequence!,
          acknowledgement.committedVersion,
        ),
      );
      return OptimisticWriteResult.acknowledged(settlement.version);
    } on Object catch (error) {
      final attempts = await _mutate(
        () => store.bumpAttempts(queued.sequence!),
      );
      return attempts == 0
          ? OptimisticWriteResult.acknowledged()
          : OptimisticWriteResult.queued(attempts: attempts, error: error);
    }
  }

  Future<OptimisticWriteResult> optimisticDelete({
    required String table,
    required String id,
    required SendWrite send,
  }) {
    return optimisticWrite(
      table: table,
      id: id,
      row: null,
      send: send,
      operation: ChangeOperation.delete,
    );
  }

  Future<OptimisticWriteResult> optimisticPatch({
    required String table,
    required String id,
    required JsonMap patch,
    required SendWrite send,
  }) {
    return optimisticWrite(
      table: table,
      id: id,
      row: patch,
      send: send,
      merge: true,
    );
  }

  Future<int> flushQueue(SendWrite send) async {
    var flushed = 0;
    final failures = <Object>[];
    final writes = await _mutate(store.queuedWrites);
    for (final write in writes) {
      final sequence = write.sequence;
      if (sequence == null) continue;
      try {
        final acknowledgement = await send(write);
        _validateAcknowledgement(write, acknowledgement);
        await _mutate(
          () => store.settleAcknowledgement(
            write.table,
            write.id,
            sequence,
            acknowledgement.committedVersion,
          ),
        );
        flushed += 1;
      } on Object catch (error) {
        final attempts = await _mutate(() => store.bumpAttempts(sequence));
        if (attempts == 0) {
          flushed += 1;
        } else {
          failures.add(error);
        }
      }
    }
    if (failures.isNotEmpty) {
      throw QueueFlushException(flushed: flushed, failures: failures);
    }
    return flushed;
  }

  Future<int> pull(
    PullChanges fetch, {
    String cursorScope = 'global',
    int pageSize = 500,
  }) async {
    if (pageSize < 1 || pageSize > 1000) {
      throw RangeError.range(pageSize, 1, 1000, 'pageSize');
    }
    var cursor = await _mutate(() => store.getCursor(cursorScope));
    var applied = 0;
    for (var pageNumber = 0; pageNumber < 10000; pageNumber += 1) {
      final page = await fetch(cursor, pageSize);
      if (page.nextCursor < cursor ||
          ((page.hasMore || page.changes.isNotEmpty) &&
              page.nextCursor == cursor)) {
        throw StateError('incremental sync cursor made no progress');
      }
      for (final change in page.changes) {
        await applyChange(change);
        applied += 1;
      }
      await _mutate(() => store.setCursor(page.nextCursor, cursorScope));
      cursor = page.nextCursor;
      if (!page.hasMore) return applied;
    }
    throw StateError('incremental sync exceeded the catch-up page limit');
  }

  Future<void> close() async {
    try {
      await _mutationTail;
    } on Object {
      // The caller still owns closing durable storage after a failed mutation.
    }
    await store.close();
  }
}

final class QueueFlushException implements Exception {
  const QueueFlushException({required this.flushed, required this.failures});

  final int flushed;
  final List<Object> failures;

  @override
  String toString() =>
      'QueueFlushException(${failures.length} failed, $flushed flushed)';
}

void _validateAcknowledgement(
  QueuedWrite write,
  WriteAcknowledgement acknowledgement,
) {
  if (acknowledgement.id != write.id) {
    throw const FormatException(
      'sync acknowledgement id does not match the queued write',
    );
  }
  if (acknowledgement.committedVersion < 0) {
    throw const FormatException(
      'sync acknowledgement version must be non-negative',
    );
  }
}

String _secureWriteKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return 'w-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-$hex';
}

JsonMap deepMerge(JsonMap base, JsonMap patch, [int depth = 0]) {
  if (depth > 64) {
    throw const FormatException('sync patch is too deeply nested');
  }
  final result = <String, Object?>{...base};
  for (final entry in patch.entries) {
    final current = result[entry.key];
    final incoming = entry.value;
    if (current is Map && incoming is Map) {
      result[entry.key] = deepMerge(
        Map<String, Object?>.from(current),
        Map<String, Object?>.from(incoming),
        depth + 1,
      );
    } else {
      result[entry.key] = incoming;
    }
  }
  return result;
}
