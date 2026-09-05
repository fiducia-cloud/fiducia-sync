import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const context = SyncTelemetryContext(
    table: 'infra_operations',
    operation: ChangeOperation.upsert,
    strategy: SyncWriteStrategy.optimistic,
  );

  test('OpenTelemetry bridge records bounded metrics and severity', () {
    final metrics = <Map<String, Object>>[];
    final severities = <SyncTelemetrySeverity>[];
    final telemetry = OpenTelemetrySyncTelemetry(
      recordMetric: (name, value, attributes) {
        metrics.add({'name': name, 'value': value, 'attributes': attributes});
      },
      emitLogRecord: (body, attributes, {required severity}) {
        severities.add(severity);
      },
    );

    for (final phase in [
      SyncTelemetryPhase.acknowledged,
      SyncTelemetryPhase.retryScheduled,
      SyncTelemetryPhase.conflictResolved,
      SyncTelemetryPhase.failed,
    ]) {
      telemetry.emit(
        SyncTelemetryEvent(
          phase: phase,
          strategy: SyncWriteStrategy.optimistic,
          table: 'infra_operations',
          operation: ChangeOperation.upsert,
          atMs: 1,
          attempts: 2,
          errorType: phase == SyncTelemetryPhase.failed ? 'StateError' : null,
        ),
        context,
      );
    }

    expect(metrics, hasLength(4));
    expect(
      metrics.map((metric) => metric['name']),
      everyElement('fiducia.sync.write.events'),
    );
    expect(severities, [
      SyncTelemetrySeverity.info,
      SyncTelemetrySeverity.warning,
      SyncTelemetrySeverity.warning,
      SyncTelemetrySeverity.error,
    ]);
    final rendered = {'metrics': metrics}.toString();
    expect(rendered, isNot(contains('row-id')));
    expect(rendered, isNot(contains('payload')));
    expect(rendered, isNot(contains('error message')));
  });

  test('broken metric exporter cannot suppress structured logs', () {
    final logs = <String>[];
    final telemetry = OpenTelemetrySyncTelemetry(
      recordMetric: (_, _, _) => throw StateError('metrics down'),
      emitLogRecord: (body, _, {required severity}) {
        logs.add('$body:${severity.name}');
      },
    );
    expect(
      () => telemetry.emit(
        const SyncTelemetryEvent(
          phase: SyncTelemetryPhase.failed,
          strategy: SyncWriteStrategy.optimistic,
          table: 'infra_operations',
          operation: ChangeOperation.upsert,
          atMs: 1,
          attempts: 1,
          errorType: 'StateError',
        ),
        context,
      ),
      returnsNormally,
    );
    expect(logs, ['fiducia.sync.failed:error']);
  });

  test('legacy boolean log callback remains compatible', () {
    final errors = <bool>[];
    final telemetry = OpenTelemetrySyncTelemetry(
      emitLog: (_, _, {required error}) => errors.add(error),
    );
    telemetry.emit(
      const SyncTelemetryEvent(
        phase: SyncTelemetryPhase.retryScheduled,
        strategy: SyncWriteStrategy.optimistic,
        table: 'infra_operations',
        operation: ChangeOperation.upsert,
        atMs: 1,
      ),
      context,
    );
    telemetry.emit(
      const SyncTelemetryEvent(
        phase: SyncTelemetryPhase.failed,
        strategy: SyncWriteStrategy.optimistic,
        table: 'infra_operations',
        operation: ChangeOperation.upsert,
        atMs: 2,
      ),
      context,
    );
    expect(errors, [false, true]);
  });
}
