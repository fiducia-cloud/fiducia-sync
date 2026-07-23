import 'models.dart';

enum IgnoreReason { stale, alreadyApplied }

enum ReconcileKind { apply, ignore, conflict }

final class ReconcileDecision {
  const ReconcileDecision._(this.kind, [this.ignoreReason]);

  static const apply = ReconcileDecision._(ReconcileKind.apply);
  static const conflict = ReconcileDecision._(ReconcileKind.conflict);

  factory ReconcileDecision.ignore(IgnoreReason reason) =>
      ReconcileDecision._(ReconcileKind.ignore, reason);

  final ReconcileKind kind;
  final IgnoreReason? ignoreReason;
}

ReconcileDecision reconcile(LocalRowMetadata? local, SyncChange incoming) {
  if (local == null) {
    return incoming.operation == ChangeOperation.upsert
        ? ReconcileDecision.apply
        : ReconcileDecision.ignore(IgnoreReason.alreadyApplied);
  }
  if (incoming.version < local.version) {
    return ReconcileDecision.ignore(IgnoreReason.stale);
  }
  if (incoming.version == local.version) {
    return ReconcileDecision.ignore(IgnoreReason.alreadyApplied);
  }
  return local.dirty ? ReconcileDecision.conflict : ReconcileDecision.apply;
}

bool isOwnEcho(QueuedWrite queued, SyncChange incoming) {
  if (incoming.table != queued.table ||
      incoming.id != queued.id ||
      incoming.operation != queued.operation) {
    return false;
  }
  final key = queued.key;
  if (key != null) return incoming.writeKey == key;
  return queued.baseVersion < 0x7fffffffffffffff &&
      incoming.version == queued.baseVersion + 1;
}

enum AckOutcomeKind { adopt, superseded }

final class AckOutcome {
  const AckOutcome._(this.kind, [this.version]);

  factory AckOutcome.adopt(int version) =>
      AckOutcome._(AckOutcomeKind.adopt, version);

  static const superseded = AckOutcome._(AckOutcomeKind.superseded);

  final AckOutcomeKind kind;
  final int? version;
}

AckOutcome reconcileAcknowledgement(
  LocalRowMetadata local,
  WriteAcknowledgement acknowledgement,
) {
  return local.version <= acknowledgement.committedVersion
      ? AckOutcome.adopt(acknowledgement.committedVersion)
      : AckOutcome.superseded;
}
