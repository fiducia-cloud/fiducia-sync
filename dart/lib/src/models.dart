typedef JsonMap = Map<String, Object?>;

enum ChangeOperation {
  upsert,
  delete;

  static ChangeOperation fromWire(Object? value) {
    return switch (value) {
      'upsert' => ChangeOperation.upsert,
      'delete' => ChangeOperation.delete,
      _ => throw FormatException('unsupported sync operation: $value'),
    };
  }
}

final class SyncChange {
  const SyncChange({
    required this.table,
    required this.operation,
    required this.id,
    required this.version,
    this.row,
    this.atMs = 0,
    this.writeKey,
    this.syncSequence,
  });

  final String table;
  final ChangeOperation operation;
  final String id;
  final int version;
  final JsonMap? row;
  final int atMs;
  final String? writeKey;
  final int? syncSequence;

  factory SyncChange.fromJson(Map<String, Object?> json) {
    final table = json['table'] ?? json['table_name'];
    final operation = json['op'] ?? json['operation'];
    final id = json['id'] ?? json['row_id'];
    final row = json['row'] ?? json['row_data'];
    if (table is! String || table.isEmpty) {
      throw const FormatException(
        'sync change table must be a non-empty string',
      );
    }
    if (id is! String || id.isEmpty) {
      throw const FormatException('sync change id must be a non-empty string');
    }
    if (row != null && row is! Map) {
      throw const FormatException('sync change row must be an object or null');
    }
    return SyncChange(
      table: table,
      operation: ChangeOperation.fromWire(operation),
      id: id,
      version: _requiredInt(json['version'], 'version'),
      row: row == null
          ? null
          : Map<String, Object?>.from(row as Map<Object?, Object?>),
      atMs: _optionalInt(json['at_ms'], 'at_ms') ?? 0,
      writeKey: switch (json['write_key']) {
        null => null,
        final String value => value,
        _ => throw const FormatException('write_key must be a string or null'),
      },
      syncSequence: _optionalInt(json['sync_sequence'], 'sync_sequence'),
    );
  }

  JsonMap toJson() => {
    'table': table,
    'op': operation.name,
    'id': id,
    'version': version,
    'row': row,
    'at_ms': atMs,
    if (writeKey != null) 'write_key': writeKey,
    if (syncSequence != null) 'sync_sequence': syncSequence,
  };
}

final class LocalRowMetadata {
  const LocalRowMetadata({required this.version, required this.dirty});

  final int version;
  final bool dirty;
}

final class QueuedWrite {
  const QueuedWrite({
    required this.id,
    required this.table,
    required this.operation,
    required this.baseVersion,
    this.key,
    this.payload,
    this.sequence,
    this.attempts = 0,
    this.supersededVersion,
  });

  final int? sequence;
  final String id;
  final String table;
  final ChangeOperation operation;
  final JsonMap? payload;
  final int baseVersion;
  final String? key;
  final int attempts;
  final int? supersededVersion;

  QueuedWrite copyWith({int? sequence, int? attempts, int? supersededVersion}) {
    return QueuedWrite(
      sequence: sequence ?? this.sequence,
      id: id,
      table: table,
      operation: operation,
      payload: payload,
      baseVersion: baseVersion,
      key: key,
      attempts: attempts ?? this.attempts,
      supersededVersion: supersededVersion ?? this.supersededVersion,
    );
  }

  JsonMap toJson() => {
    if (sequence != null) 'seq': sequence,
    'id': id,
    'table': table,
    'op': operation.name,
    'payload': payload,
    'base_version': baseVersion,
    if (key != null) 'key': key,
    'attempts': attempts,
    if (supersededVersion != null) 'superseded_version': supersededVersion,
  };

  /// Strict `fiducia-interfaces` wire envelope without local queue metadata.
  JsonMap toWireJson() => {
    'id': id,
    'table': table,
    'op': operation.name,
    'payload': payload,
    'base_version': baseVersion,
    'key': key?.trim().isNotEmpty == true
        ? key
        : '$table:$id:${operation.name}:$baseVersion',
  };
}

final class WriteAcknowledgement {
  const WriteAcknowledgement({
    required this.id,
    required this.committedVersion,
  });

  final String id;
  final int committedVersion;

  factory WriteAcknowledgement.fromJson(Map<String, Object?> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) {
      throw const FormatException(
        'acknowledgement id must be a non-empty string',
      );
    }
    return WriteAcknowledgement(
      id: id,
      committedVersion: _requiredInt(
        json['committed_version'],
        'committed_version',
      ),
    );
  }
}

final class PullPage {
  const PullPage({
    required this.changes,
    required this.nextCursor,
    required this.hasMore,
  });

  final List<SyncChange> changes;
  final int nextCursor;
  final bool hasMore;

  factory PullPage.fromJson(Map<String, Object?> json) {
    final rawChanges = json['changes'];
    final hasMore = json['has_more'];
    if (rawChanges is! List) {
      throw const FormatException('pull page changes must be a list');
    }
    if (hasMore is! bool) {
      throw const FormatException('pull page has_more must be a boolean');
    }
    return PullPage(
      changes: rawChanges
          .map(
            (value) => value is Map
                ? SyncChange.fromJson(Map<String, Object?>.from(value))
                : throw const FormatException(
                    'pull page change must be an object',
                  ),
          )
          .toList(growable: false),
      nextCursor: _requiredInt(json['next_cursor'], 'next_cursor'),
      hasMore: hasMore,
    );
  }
}

final class OptimisticWriteResult {
  const OptimisticWriteResult._({
    required this.acknowledged,
    this.version,
    this.attempts,
    this.error,
  });

  factory OptimisticWriteResult.acknowledged([int? version]) =>
      OptimisticWriteResult._(acknowledged: true, version: version);

  factory OptimisticWriteResult.queued({
    required int attempts,
    required Object error,
  }) => OptimisticWriteResult._(
    acknowledged: false,
    attempts: attempts,
    error: error,
  );

  final bool acknowledged;
  final int? version;
  final int? attempts;
  final Object? error;
}

int _requiredInt(Object? value, String field) {
  if (value is! int) {
    throw FormatException('$field must be an integer');
  }
  return value;
}

int? _optionalInt(Object? value, String field) {
  if (value == null) return null;
  return _requiredInt(value, field);
}
