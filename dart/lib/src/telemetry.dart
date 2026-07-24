/// OpenTelemetry-compatible observability for the mobile sync client — with
/// zero dependencies, mirroring `sdk/src/telemetry.mjs`. The client emits
/// plain event objects through a caller-provided sink; adapt them onto your
/// app's OpenTelemetry SDK (or logger) in one small callback.
///
/// Event names: `fiducia.sync.write`, `.apply`, `.flush`, `.pull`,
/// `.conflict`, `.status`. Telemetry always observes every failure regardless
/// of the write's [SyncErrorMode]; the mode only chooses the caller-facing
/// channel. A sink must never break sync — thrown sink errors are swallowed.
library;

/// One completed sync operation (or point event).
final class SyncTelemetryEvent {
  const SyncTelemetryEvent({
    required this.name,
    required this.atMs,
    this.durationMs = 0,
    this.attributes = const {},
    this.error,
  });

  /// `fiducia.sync.*` event name (stable contract).
  final String name;

  /// Wall-clock start of the operation, Unix milliseconds.
  final int atMs;

  /// Elapsed time (0 for point events).
  final int durationMs;

  /// Flat OTel-style attribute bag (`sync.table`, `sync.policy`, ...).
  final Map<String, Object?> attributes;

  /// The failure when the operation errored; null on success.
  final Object? error;

  bool get isError => error != null;

  @override
  String toString() =>
      'SyncTelemetryEvent($name ${isError ? "error" : "ok"} '
      '+${durationMs}ms $attributes${error == null ? "" : " error=$error"})';
}

/// A telemetry sink. Example OpenTelemetry adaptation:
///
/// ```dart
/// final client = FiduciaSyncClient(
///   store: store,
///   telemetry: (event) {
///     final span = tracer.startSpan(event.name,
///         startTime: DateTime.fromMillisecondsSinceEpoch(event.atMs));
///     event.attributes.forEach((k, v) => span.setAttribute(k, v));
///     if (event.isError) span.setStatus(StatusCode.error, '${event.error}');
///     span.end();
///   },
/// );
/// ```
typedef SyncTelemetry = void Function(SyncTelemetryEvent event);

/// Wrap a nullable sink so emitting can never throw into sync logic.
SyncTelemetry safeTelemetry(SyncTelemetry? telemetry) {
  if (telemetry == null) return (_) {};
  return (event) {
    try {
      telemetry(event);
    } on Object {
      // Observability must never corrupt sync state.
    }
  };
}
