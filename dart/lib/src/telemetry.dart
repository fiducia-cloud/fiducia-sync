import 'models.dart';

final class SyncTelemetryContext {
  const SyncTelemetryContext({
    required this.table,
    required this.operation,
    required this.strategy,
    this.storage = 'sqlite',
  });

  final String table;
  final ChangeOperation operation;
  final SyncWriteStrategy strategy;
  final String storage;

  Map<String, Object> get attributes => {
    'db.system.name': storage,
    'db.collection.name': table,
    'db.operation.name': operation.name,
    'fiducia.sync.strategy': strategy.wireName,
  };
}

enum SyncTelemetryPhase {
  localQueued('local_queued'),
  sendStarted('send_started'),
  acknowledged('acknowledged'),
  retryScheduled('retry_scheduled'),
  failed('failed'),
  conflictResolved('conflict_resolved');

  const SyncTelemetryPhase(this.wireName);
  final String wireName;
}

final class SyncTelemetryEvent {
  const SyncTelemetryEvent({
    required this.phase,
    required this.strategy,
    required this.table,
    required this.operation,
    required this.atMs,
    this.attempts,
    this.errorType,
  });

  final SyncTelemetryPhase phase;
  final SyncWriteStrategy strategy;
  final String table;
  final ChangeOperation operation;
  final int atMs;
  final int? attempts;
  final String? errorType;
}

abstract interface class SyncTelemetrySpan {
  void event(
    SyncTelemetryPhase phase, [
    Map<String, Object> attributes = const {},
  ]);
  void error(String errorType);
  void end();
}

abstract interface class SyncTelemetry {
  SyncTelemetrySpan? startWrite(SyncTelemetryContext context);
  void emit(SyncTelemetryEvent event, SyncTelemetryContext context);
}

typedef StartOpenTelemetrySpan =
    SyncTelemetrySpan? Function(String name, Map<String, Object> attributes);
typedef EmitOpenTelemetryLog =
    void Function(
      String body,
      Map<String, Object> attributes, {
      required bool error,
    });

/// Dependency-free bridge to the application's configured OpenTelemetry SDK.
///
/// The callbacks receive semantic-convention-compatible, low-cardinality
/// attributes. Row ids, payloads, write keys, and error messages are excluded.
final class OpenTelemetrySyncTelemetry implements SyncTelemetry {
  const OpenTelemetrySyncTelemetry({this.startSpan, this.emitLog});

  final StartOpenTelemetrySpan? startSpan;
  final EmitOpenTelemetryLog? emitLog;

  @override
  SyncTelemetrySpan? startWrite(SyncTelemetryContext context) =>
      startSpan?.call('fiducia.sync.write', context.attributes);

  @override
  void emit(SyncTelemetryEvent event, SyncTelemetryContext context) {
    emitLog?.call(
      'fiducia.sync.${event.phase.wireName}',
      {
        ...context.attributes,
        'fiducia.sync.phase': event.phase.wireName,
        'fiducia.sync.attempts': event.attempts ?? 0,
        if (event.errorType != null) 'error.type': event.errorType!,
      },
      error: event.phase == SyncTelemetryPhase.failed,
    );
  }
}
