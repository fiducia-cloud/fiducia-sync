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

  Future<int> enqueue(QueuedWrite write);

  Future<int> enqueueOptimistic(QueuedWrite write, JsonMap? row);

  Future<List<QueuedWrite>> queuedWrites();

  Future<AckSettlement> settleAcknowledgement(
    String table,
    String id,
    int sequence,
    int committedVersion,
  );

  Future<AckSettlement> settlePessimistic(
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

  Future<void> close();
}
