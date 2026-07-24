/// Write-policy + error-mode vocabulary for optimistic writes — the Dart
/// mirror of the canonical Rust definitions (`src/policy.rs`) and the JS SDK
/// (`sdk/src/policy.mjs`), with the same kebab-case wire names and semantics:
///
/// | policy         | local mutate first | durable queue | sends now | ack adopts locally |
/// |----------------|--------------------|---------------|-----------|--------------------|
/// | `local-only`   | yes                | yes           | no        | — (flush later)    |
/// | `local-first`  | yes                | yes           | yes       | via queue          |
/// | `server-first` | no                 | no            | yes       | direct, guarded    |
/// | `server-only`  | no                 | no            | yes       | no (echo lands it) |
///
/// Both are enums, not booleans: optimism is a spectrum, and error surfacing
/// is a channel choice. Telemetry always observes every failure; the mode only
/// selects what the CALLER experiences.
library;

import 'models.dart';

/// How optimistic a single write is about local state vs the backend.
enum WritePolicy {
  localOnly('local-only'),
  localFirst('local-first'),
  serverFirst('server-first'),
  serverOnly('server-only');

  const WritePolicy(this.wireName);

  /// The canonical kebab-case name shared by every runtime.
  final String wireName;

  static WritePolicy fromWire(String value) {
    return values.firstWhere(
      (policy) => policy.wireName == value,
      orElse: () =>
          throw ArgumentError.value(value, 'policy', 'unknown write policy'),
    );
  }

  /// Does this policy mutate the local store (dirty row) before network IO?
  bool get mutatesLocalBeforeSend => this == localOnly || this == localFirst;

  /// Does this policy append a durable retry record to the write queue?
  bool get enqueuesDurably => mutatesLocalBeforeSend;

  /// Does this policy perform network IO as part of the write call itself?
  bool get sendsImmediately => this != localOnly;

  /// Does a successful ack mutate the local store (directly or via the queue)?
  bool get adoptsAckLocally => this == localFirst || this == serverFirst;
}

/// How a failed send surfaces to the CALLER (wire names: return/throw/emit).
enum SyncErrorMode {
  /// Resolve normally with the failure encoded in the result (default).
  returnResult('return'),

  /// Throw a typed [SyncWriteException] (local-* writes stay queued).
  throwError('throw'),

  /// Resolve quietly; the failure goes only to telemetry/status hooks.
  emitOnly('emit');

  const SyncErrorMode(this.wireName);

  final String wireName;

  static SyncErrorMode fromWire(String value) {
    return values.firstWhere(
      (mode) => mode.wireName == value,
      orElse: () =>
          throw ArgumentError.value(value, 'errorMode', 'unknown error mode'),
    );
  }
}

/// Typed failure for [SyncErrorMode.throwError] (and for durability failures,
/// which always throw). `queued` says whether the write survives durably.
final class SyncWriteException implements Exception {
  const SyncWriteException(
    this.message, {
    this.write,
    this.policy,
    this.attempts,
    this.queued = false,
    this.cause,
  });

  final String message;
  final QueuedWrite? write;
  final WritePolicy? policy;
  final int? attempts;
  final bool queued;
  final Object? cause;

  @override
  String toString() =>
      'SyncWriteException($message; policy=${policy?.wireName}, '
      'queued=$queued, attempts=$attempts, cause=$cause)';
}
