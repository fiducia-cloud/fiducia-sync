import 'dart:async';
import 'dart:math';

import 'core.dart';
import 'hlc.dart';
import 'models.dart';
import 'policy.dart';
import 'store.dart';
import 'telemetry.dart';

typedef SendWrite = Future<WriteAcknowledgement> Function(QueuedWrite write);
typedef PullChanges = Future<PullPage> Function(int cursor, int limit);

/// The mobile sync client: serialized reconcile decisions over a durable
/// [SyncStore], with per-write [WritePolicy] (optimism enum, default
/// local-first), [SyncErrorMode] (caller-facing failure channel), OpenTelemetry-
/// adaptable [SyncTelemetry], and a device Hybrid Logical Clock that stamps
/// queued writes and observes every incoming commit time.
final class FiduciaSyncClient {
  FiduciaSyncClient({
    required this.store,
    String Function()? writeKeyFactory,
    SyncTelemetry? telemetry,
    int Function()? nowMs,
    this.writePolicy = WritePolicy.localFirst,
    this.errorMode = SyncErrorMode.returnResult,
  }) : _writeKeyFactory = writeKeyFactory ?? _secureWriteKey,
       _telemetry = safeTelemetry(telemetry),
       _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final SyncStore store;

  /// Client-wide default write policy; per-write `policy:` overrides it.
  final WritePolicy writePolicy;

  /// Client-wide default error mode; per-write `errorMode:` overrides it.
  final SyncErrorMode errorMode;

  final String Function() _writeKeyFactory;
  final SyncTelemetry _telemetry;
  final int Function() _nowMs;
  Future<void> _mutationTail = Future<void>.value();
  Hlc? _clock;

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

  /// The device HLC, restored lazily from durable store state.
  Future<Hlc> _hlc() async {
    if (_clock case final clock?) return clock;
    HlcStamp? state;
    try {
      state = await store.getHlcState();
    } on Object {
      state = null;
    }
    return _clock ??= Hlc(state: state, nowMs: _nowMs);
  }

  void _emit(
    String name, {
    required int startedAtMs,
    Map<String, Object?> attributes = const {},
    Object? error,
  }) {
    _telemetry(
      SyncTelemetryEvent(
        name: name,
        atMs: startedAtMs,
        durationMs: max(0, _nowMs() - startedAtMs),
        attributes: attributes,
        error: error,
      ),
    );
  }

  Future<String> applyChange(SyncChange event) async {
    (await _hlc()).observe(event.atMs);
    final startedAt = _nowMs();
    final attributes = <String, Object?>{
      'sync.table': event.table,
      'sync.row_id': event.id,
      'sync.op': event.operation.name,
    };
    try {
      final outcome = await _mutate(() => _applyChange(event));
      _emit(
        'fiducia.sync.apply',
        startedAtMs: startedAt,
        attributes: {...attributes, 'sync.outcome': outcome},
      );
      if (outcome == 'conflict-resolved') {
        _emit(
          'fiducia.sync.conflict',
          startedAtMs: startedAt,
          attributes: {...attributes, 'sync.resolution': 'server-wins'},
        );
      }
      return outcome;
    } on Object catch (error) {
      _emit(
        'fiducia.sync.apply',
        startedAtMs: startedAt,
        attributes: attributes,
        error: error,
      );
      rethrow;
    }
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

  /// Perform one write under a [WritePolicy] (default: the client's):
  ///
  ///   localOnly    mutate + enqueue durably; no network now (flushQueue later)
  ///   localFirst   mutate + enqueue durably, then send; failures stay queued
  ///   serverFirst  send first; adopt the committed state locally on ack
  ///   serverOnly   send only; the local store waits for the echo/catch-up
  ///
  /// The [SyncErrorMode] picks the caller-facing channel for SEND failures:
  /// `returnResult` resolves a queued/failed result, `throwError` throws a
  /// typed [SyncWriteException], `emitOnly` resolves quietly (telemetry still
  /// sees everything). Durability failures always throw. `send` may be null
  /// only for [WritePolicy.localOnly].
  Future<OptimisticWriteResult> optimisticWrite({
    required String table,
    required String id,
    required JsonMap? row,
    SendWrite? send,
    ChangeOperation operation = ChangeOperation.upsert,
    bool merge = false,
    WritePolicy? policy,
    SyncErrorMode? errorMode,
  }) async {
    final resolvedPolicy = policy ?? writePolicy;
    final mode = errorMode ?? this.errorMode;
    if (resolvedPolicy.sendsImmediately && send == null) {
      throw ArgumentError.value(
        send,
        'send',
        'write policy ${resolvedPolicy.wireName} requires a send function',
      );
    }
    final startedAt = _nowMs();
    final attributes = <String, Object?>{
      'sync.table': table,
      'sync.row_id': id,
      'sync.op': operation.name,
      'sync.policy': resolvedPolicy.wireName,
      'sync.error_mode': mode.wireName,
    };
    OptimisticWriteResult finish(OptimisticWriteResult result) {
      _emit(
        'fiducia.sync.write',
        startedAtMs: startedAt,
        attributes: {
          ...attributes,
          'sync.outcome': result.status.name,
          if (result.attempts != null) 'sync.attempts': result.attempts,
        },
        error: result.error,
      );
      return result;
    }

    Never fail(SyncWriteException error) {
      _emit(
        'fiducia.sync.write',
        startedAtMs: startedAt,
        attributes: {...attributes, 'sync.outcome': 'threw'},
        error: error,
      );
      throw error;
    }

    final clock = await _hlc();

    if (resolvedPolicy.enqueuesDurably) {
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
        final stamp = clock.tick();
        final write = QueuedWrite(
          id: id,
          table: table,
          operation: operation,
          payload: payload,
          baseVersion: local?.metadata.version ?? 0,
          key: _writeKeyFactory(),
          hlc: stamp.encoded,
        );
        final sequence = await store.enqueueOptimistic(
          write,
          payload,
          hlcState: clock.state,
        );
        return write.copyWith(sequence: sequence);
      });

      if (resolvedPolicy == WritePolicy.localOnly) {
        return finish(OptimisticWriteResult.queued(attempts: 0));
      }

      try {
        final acknowledgement = await send!(queued);
        _validateAcknowledgement(queued, acknowledgement);
        final settlement = await _mutate(
          () => store.settleAcknowledgement(
            table,
            id,
            queued.sequence!,
            acknowledgement.committedVersion,
          ),
        );
        return finish(OptimisticWriteResult.acknowledged(settlement.version));
      } on Object catch (error) {
        final int attempts;
        try {
          attempts = await _mutate(() => store.bumpAttempts(queued.sequence!));
        } on Object catch (storageError) {
          fail(
            SyncWriteException(
              'sync write failed and retry state was not durable',
              write: queued,
              policy: resolvedPolicy,
              queued: false,
              cause: storageError,
            ),
          );
        }
        if (attempts == 0) return finish(OptimisticWriteResult.acknowledged());
        switch (mode) {
          case SyncErrorMode.throwError:
            fail(
              SyncWriteException(
                'sync write failed and stays queued for retry',
                write: queued,
                policy: resolvedPolicy,
                attempts: attempts,
                queued: true,
                cause: error,
              ),
            );
          case SyncErrorMode.emitOnly:
            return finish(OptimisticWriteResult.queued(attempts: attempts));
          case SyncErrorMode.returnResult:
            return finish(
              OptimisticWriteResult.queued(attempts: attempts, error: error),
            );
        }
      }
    }

    // Pessimistic policies: no local mutation, no durable queue entry.
    final write = await _mutate(() async {
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
      return QueuedWrite(
        id: id,
        table: table,
        operation: operation,
        payload: payload,
        baseVersion: local?.metadata.version ?? 0,
        key: _writeKeyFactory(),
        hlc: clock.tick().encoded,
      );
    });
    // Best-effort HLC persistence (no queue transaction to ride along with).
    unawaited(
      Future.sync(() => store.setHlcState(clock.state)).catchError((_) {}),
    );

    try {
      final acknowledgement = await send!(write);
      _validateAcknowledgement(write, acknowledgement);
      if (resolvedPolicy == WritePolicy.serverFirst) {
        await _mutate(() => _adoptServerAck(write, acknowledgement));
      }
      return finish(
        OptimisticWriteResult.acknowledged(acknowledgement.committedVersion),
      );
    } on Object catch (error) {
      switch (mode) {
        case SyncErrorMode.throwError:
          fail(
            SyncWriteException(
              'sync write failed and was not applied locally',
              write: write,
              policy: resolvedPolicy,
              queued: false,
              cause: error,
            ),
          );
        case SyncErrorMode.emitOnly:
          return finish(OptimisticWriteResult.failed());
        case SyncErrorMode.returnResult:
          return finish(OptimisticWriteResult.failed(error: error));
      }
    }
  }

  /// Directly adopt a server-first ack when nothing newer landed locally.
  Future<void> _adoptServerAck(
    QueuedWrite write,
    WriteAcknowledgement acknowledgement,
  ) async {
    final local = await store.read(write.table, write.id);
    if (local != null &&
        local.metadata.version > acknowledgement.committedVersion) {
      return; // superseded by newer local state
    }
    final stillDirty = (await store.queuedWrites()).any(
      (queued) => queued.table == write.table && queued.id == write.id,
    );
    if (write.operation == ChangeOperation.delete) {
      await store.delete(write.table, write.id);
    } else {
      await store.put(
        write.table,
        write.id,
        write.payload ?? const {},
        LocalRowMetadata(
          version: acknowledgement.committedVersion,
          dirty: stillDirty,
          syncedAtMs: _nowMs(),
        ),
      );
    }
  }

  Future<OptimisticWriteResult> optimisticDelete({
    required String table,
    required String id,
    required SendWrite send,
    WritePolicy? policy,
    SyncErrorMode? errorMode,
  }) {
    return optimisticWrite(
      table: table,
      id: id,
      row: null,
      send: send,
      operation: ChangeOperation.delete,
      policy: policy,
      errorMode: errorMode,
    );
  }

  Future<OptimisticWriteResult> optimisticPatch({
    required String table,
    required String id,
    required JsonMap patch,
    required SendWrite send,
    WritePolicy? policy,
    SyncErrorMode? errorMode,
  }) {
    return optimisticWrite(
      table: table,
      id: id,
      row: patch,
      send: send,
      merge: true,
      policy: policy,
      errorMode: errorMode,
    );
  }

  /// Re-send everything still queued (call on reconnect). Failures throw a
  /// [QueueFlushException] — unless `errorMode` (per-call, else the client
  /// default) is [SyncErrorMode.emitOnly], which resolves the flushed count
  /// and reports failures only through telemetry.
  Future<int> flushQueue(SendWrite send, {SyncErrorMode? errorMode}) async {
    final mode = errorMode ?? this.errorMode;
    final startedAt = _nowMs();
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
    _emit(
      'fiducia.sync.flush',
      startedAtMs: startedAt,
      attributes: {'sync.flushed': flushed, 'sync.failures': failures.length},
      error: failures.isEmpty ? null : failures.first,
    );
    if (failures.isNotEmpty && mode != SyncErrorMode.emitOnly) {
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
    final startedAt = _nowMs();
    var cursor = await _mutate(() => store.getCursor(cursorScope));
    var applied = 0;
    try {
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
        if (!page.hasMore) {
          _emit(
            'fiducia.sync.pull',
            startedAtMs: startedAt,
            attributes: {'sync.applied': applied, 'sync.scope': cursorScope},
          );
          return applied;
        }
      }
      throw StateError('incremental sync exceeded the catch-up page limit');
    } on Object catch (error) {
      _emit(
        'fiducia.sync.pull',
        startedAtMs: startedAt,
        attributes: {'sync.scope': cursorScope},
        error: error,
      );
      rethrow;
    }
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
