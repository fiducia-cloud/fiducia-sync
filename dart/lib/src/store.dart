import 'hlc.dart';
import 'models.dart';

final class StoredRow {
  const StoredRow({required this.row, required this.metadata});

  final JsonMap row;
  final LocalRowMetadata metadata;
}

enum AckSettlementKind { adopted, superseded, missing }

final class AckSettlement {
  const AckSettlement._(this.kind, [this.version]);

  factory AckSettlement.adopted(int version) =>
      AckSettlement._(AckSettlementKind.adopted, version);

  static const superseded = AckSettlement._(AckSettlementKind.superseded);
  static const missing = AckSettlement._(AckSettlementKind.missing);

  final AckSettlementKind kind;
  final int? version;
}

/// Plane-level sync freshness (see [SyncStore.syncInfo]).
final class SyncFreshness {
  const SyncFreshness({required this.cursor, this.lastSyncedAtMs});

  final int cursor;

  /// Last completed catch-up on this device (null before the first).
  final int? lastSyncedAtMs;
}

abstract interface class SyncStore {
  Future<StoredRow?> read(String table, String id);

  Future<List<StoredRow>> all(String table);

  Future<void> put(
    String table,
    String id,
    JsonMap row,
    LocalRowMetadata metadata,
  );

  Future<void> delete(String table, String id);

  /// `hlcState` (when given) persists the write's Hybrid Logical Clock state
  /// in the SAME transaction as the mutation + queue append.
  Future<int> enqueueOptimistic(
    QueuedWrite write,
    JsonMap? row, {
    HlcStamp? hlcState,
  });

  Future<List<QueuedWrite>> queuedWrites();

  Future<AckSettlement> settleAcknowledgement(
    String table,
    String id,
    int sequence,
    int committedVersion,
  );

  Future<bool> adoptEcho(SyncChange event, int sequence);

  Future<void> resolveConflict(SyncChange event, List<int> staleSequences);

  Future<int> bumpAttempts(int sequence);

  Future<int> getCursor([String scope = 'global']);

  Future<void> setCursor(int cursor, [String scope = 'global']);

  /// Record "this plane finished a successful catch-up now"; returns the stamp.
  Future<int> markSynced([String scope = 'global']);

  /// The durable cursor plus the last completed catch-up moment for `scope`.
  Future<SyncFreshness> syncInfo([String scope = 'global']);

  /// Persisted Hybrid Logical Clock state (null before the first stamp).
  Future<HlcStamp?> getHlcState();

  Future<void> setHlcState(HlcStamp state);

  Future<void> close();
}
