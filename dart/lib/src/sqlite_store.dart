import 'dart:convert';
import 'dart:math' as math;

import 'package:sqflite/sqflite.dart';

import 'models.dart';
import 'store.dart';

const _rowsTable = '_fiducia_rows';
const _queueTable = '_fiducia_queue';
const _metadataTable = '_fiducia_metadata';

final class SqliteSyncStore implements SyncStore {
  SqliteSyncStore._(this._database);

  final Database _database;

  static Future<SqliteSyncStore> open(
    String path, {
    DatabaseFactory? factory,
  }) async {
    final resolvedFactory = factory ?? databaseFactory;
    final database = await resolvedFactory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 2,
        onConfigure: (database) => database.execute('pragma foreign_keys = on'),
        onCreate: _createSchema,
        onUpgrade: _upgradeSchema,
      ),
    );
    return SqliteSyncStore._(database);
  }

  static Future<void> _createSchema(Database database, int _) async {
    final batch = database.batch()
      ..execute('''
        create table if not exists $_rowsTable (
          table_name text not null,
          row_id text not null,
          row_json text not null,
          version integer not null,
          dirty integer not null check (dirty in (0, 1)),
          created_at_ms integer not null,
          updated_at_ms integer not null,
          synced_at_ms integer,
          primary key (table_name, row_id)
        )
      ''')
      ..execute('''
        create table if not exists $_queueTable (
          seq integer primary key autoincrement,
          table_name text not null,
          row_id text not null,
          operation text not null check (operation in ('upsert', 'delete')),
          payload_json text,
          base_version integer not null,
          write_key text,
          attempts integer not null default 0,
          superseded_version integer,
          write_strategy text not null default 'optimistic',
          failure_mode text not null default 'return_result',
          telemetry_level text not null default 'errors'
        )
      ''')
      ..execute('''
        create index if not exists fiducia_queue_row
        on $_queueTable (table_name, row_id, seq)
      ''')
      ..execute('''
        create unique index if not exists fiducia_queue_write_key
        on $_queueTable (write_key)
        where write_key is not null
      ''')
      ..execute('''
        create table if not exists $_metadataTable (
          key text primary key,
          value integer not null
        )
      ''');
    await batch.commit(noResult: true);
  }

  static Future<void> _upgradeSchema(
    Database database,
    int oldVersion,
    int newVersion,
  ) async {
    await _createSchema(database, newVersion);
    if (oldVersion < 2) {
      final batch = database.batch()
        ..execute(
          'alter table $_rowsTable add column created_at_ms integer not null default 0',
        )
        ..execute(
          'alter table $_rowsTable add column updated_at_ms integer not null default 0',
        )
        ..execute('alter table $_rowsTable add column synced_at_ms integer')
        ..execute(
          "alter table $_queueTable add column write_strategy text not null default 'optimistic'",
        )
        ..execute(
          "alter table $_queueTable add column failure_mode text not null default 'return_result'",
        )
        ..execute(
          "alter table $_queueTable add column telemetry_level text not null default 'errors'",
        )
        ..execute('''
          update $_rowsTable
          set created_at_ms = cast(strftime('%s', 'now') as integer) * 1000,
              updated_at_ms = cast(strftime('%s', 'now') as integer) * 1000,
              synced_at_ms = case
                when dirty = 0 then cast(strftime('%s', 'now') as integer) * 1000
                else null
              end
          where created_at_ms = 0
        ''');
      await batch.commit(noResult: true);
    }
  }

  @override
  Future<StoredRow?> read(String table, String id) async {
    final rows = await _database.query(
      _rowsTable,
      where: 'table_name = ? and row_id = ?',
      whereArgs: [table, id],
      limit: 1,
    );
    return rows.isEmpty ? null : _storedRow(rows.single);
  }

  @override
  Future<List<StoredRow>> all(String table) async {
    final rows = await _database.query(
      _rowsTable,
      where: 'table_name = ?',
      whereArgs: [table],
      orderBy: 'row_id asc',
    );
    return rows.map(_storedRow).toList(growable: false);
  }

  @override
  Future<void> put(
    String table,
    String id,
    JsonMap row,
    LocalRowMetadata metadata,
  ) async {
    await _put(_database, table, id, row, metadata);
  }

  @override
  Future<void> delete(String table, String id) async {
    await _database.delete(
      _rowsTable,
      where: 'table_name = ? and row_id = ?',
      whereArgs: [table, id],
    );
  }

  @override
  Future<int> enqueue(QueuedWrite write) =>
      _database.insert(_queueTable, _writeRecord(write));

  @override
  Future<int> enqueueOptimistic(QueuedWrite write, JsonMap? row) {
    return _database.transaction((transaction) async {
      if (write.operation == ChangeOperation.delete) {
        await transaction.delete(
          _rowsTable,
          where: 'table_name = ? and row_id = ?',
          whereArgs: [write.table, write.id],
        );
      } else {
        await _put(
          transaction,
          write.table,
          write.id,
          row ?? _requiredPayload(write),
          LocalRowMetadata(version: write.baseVersion, dirty: true),
        );
      }
      return transaction.insert(_queueTable, _writeRecord(write));
    });
  }

  @override
  Future<List<QueuedWrite>> queuedWrites() async {
    final rows = await _database.query(_queueTable, orderBy: 'seq asc');
    return rows.map(_queuedWrite).toList(growable: false);
  }

  @override
  Future<AckSettlement> settleAcknowledgement(
    String table,
    String id,
    int sequence,
    int committedVersion,
  ) {
    return _database.transaction((transaction) async {
      final selected = await transaction.query(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
        limit: 1,
      );
      if (selected.isEmpty) return AckSettlement.missing;
      final acknowledged = _queuedWrite(selected.single);
      if (acknowledged.table != table || acknowledged.id != id) {
        throw StateError(
          'queued write identity changed before acknowledgement',
        );
      }

      final rowWrites = (await transaction.query(
        _queueTable,
        where: 'table_name = ? and row_id = ?',
        whereArgs: [table, id],
      )).map(_queuedWrite).toList(growable: false);
      for (final candidate in rowWrites) {
        final candidateSequence = candidate.sequence;
        if (candidateSequence != null && candidateSequence < sequence) {
          await transaction.update(
            _queueTable,
            {
              'superseded_version': math.max(
                candidate.supersededVersion ?? -0x8000000000000000,
                committedVersion,
              ),
            },
            where: 'seq = ?',
            whereArgs: [candidateSequence],
          );
        }
      }

      final stored = await _read(transaction, table, id);
      var outcome = AckSettlement.superseded;
      if (stored != null) {
        final adoptedVersion = stored.metadata.version <= committedVersion
            ? committedVersion
            : stored.metadata.version;
        if (stored.metadata.version <= committedVersion) {
          outcome = AckSettlement.adopted(committedVersion);
        }
        await _put(
          transaction,
          table,
          id,
          stored.row,
          LocalRowMetadata(
            version: adoptedVersion,
            dirty: rowWrites.any((candidate) => candidate.sequence != sequence),
            syncedAtMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
      }
      await transaction.delete(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
      );
      return outcome;
    });
  }

  @override
  Future<AckSettlement> settlePessimistic(
    String table,
    String id,
    int sequence,
    int committedVersion,
  ) {
    return _database.transaction((transaction) async {
      final selected = await transaction.query(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
        limit: 1,
      );
      if (selected.isEmpty) return AckSettlement.missing;
      final acknowledged = _queuedWrite(selected.single);
      if (acknowledged.table != table || acknowledged.id != id) {
        throw StateError(
          'queued write identity changed before acknowledgement',
        );
      }

      final otherWrites = (await transaction.query(
        _queueTable,
        where: 'table_name = ? and row_id = ? and seq <> ?',
        whereArgs: [table, id, sequence],
      )).map(_queuedWrite).toList(growable: false);
      for (final candidate in otherWrites) {
        final candidateSequence = candidate.sequence;
        if (candidateSequence != null && candidateSequence < sequence) {
          await transaction.update(
            _queueTable,
            {
              'superseded_version': math.max(
                candidate.supersededVersion ?? -0x8000000000000000,
                committedVersion,
              ),
            },
            where: 'seq = ?',
            whereArgs: [candidateSequence],
          );
        }
      }

      final stored = await _read(transaction, table, id);
      final hasNewerOptimisticValue =
          stored?.metadata.dirty == true &&
          otherWrites.any(
            (candidate) =>
                (candidate.sequence ?? -1) > sequence &&
                candidate.writePolicy.strategy != SyncWriteStrategy.pessimistic,
          );
      AckSettlement outcome;
      if (hasNewerOptimisticValue && stored != null) {
        await _put(
          transaction,
          table,
          id,
          stored.row,
          LocalRowMetadata(
            version: math.max(stored.metadata.version, committedVersion),
            dirty: true,
            syncedAtMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
        outcome = AckSettlement.superseded;
      } else if (acknowledged.operation == ChangeOperation.delete) {
        await transaction.delete(
          _rowsTable,
          where: 'table_name = ? and row_id = ?',
          whereArgs: [table, id],
        );
        outcome = AckSettlement.adopted(committedVersion);
      } else {
        await _put(
          transaction,
          table,
          id,
          _requiredPayload(acknowledged),
          LocalRowMetadata(
            version: committedVersion,
            dirty: otherWrites.isNotEmpty,
            syncedAtMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
        outcome = AckSettlement.adopted(committedVersion);
      }
      await transaction.delete(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
      );
      return outcome;
    });
  }

  @override
  Future<bool> adoptEcho(SyncChange event, int sequence) {
    return _database.transaction((transaction) async {
      final selected = await transaction.query(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
        limit: 1,
      );
      if (selected.isEmpty) return false;
      final echo = _queuedWrite(selected.single);
      if (echo.table != event.table || echo.id != event.id) {
        throw StateError('queued echo identity changed before reconciliation');
      }

      final remaining = (await transaction.query(
        _queueTable,
        where: 'table_name = ? and row_id = ? and seq <> ?',
        whereArgs: [event.table, event.id, sequence],
        orderBy: 'seq asc',
      )).map(_queuedWrite).toList(growable: false);
      final hasNewerWrite = remaining.any(
        (candidate) => (candidate.sequence ?? -1) > sequence,
      );
      final echoWasSuperseded =
          echo.supersededVersion != null &&
          echo.supersededVersion! >= event.version;
      final stored = await _read(transaction, event.table, event.id);

      if (echoWasSuperseded) {
        if (stored != null) {
          await _put(
            transaction,
            event.table,
            event.id,
            stored.row,
            LocalRowMetadata(
              version: stored.metadata.version,
              dirty: remaining.isNotEmpty,
              syncedAtMs: DateTime.now().millisecondsSinceEpoch,
            ),
          );
        }
      } else if (!hasNewerWrite) {
        if (stored == null || event.version >= stored.metadata.version) {
          await _applyServer(transaction, event, dirty: remaining.isNotEmpty);
        } else {
          await _put(
            transaction,
            event.table,
            event.id,
            stored.row,
            LocalRowMetadata(
              version: stored.metadata.version,
              dirty: remaining.isNotEmpty,
              syncedAtMs: DateTime.now().millisecondsSinceEpoch,
            ),
          );
        }
      } else if (stored != null) {
        await _put(
          transaction,
          event.table,
          event.id,
          stored.row,
          LocalRowMetadata(
            version: math.max(stored.metadata.version, event.version),
            dirty: true,
            syncedAtMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
      }

      for (final candidate in remaining) {
        final candidateSequence = candidate.sequence;
        if (candidateSequence != null && candidateSequence < sequence) {
          await transaction.update(
            _queueTable,
            {
              'superseded_version': math.max(
                candidate.supersededVersion ?? -0x8000000000000000,
                event.version,
              ),
            },
            where: 'seq = ?',
            whereArgs: [candidateSequence],
          );
        }
      }
      await transaction.delete(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
      );
      return true;
    });
  }

  @override
  Future<void> resolveConflict(SyncChange event, List<int> staleSequences) {
    return _database.transaction((transaction) async {
      final stale = staleSequences.toSet();
      final remaining = (await transaction.query(
        _queueTable,
        where: 'table_name = ? and row_id = ?',
        whereArgs: [event.table, event.id],
      )).map(_queuedWrite).where((write) => !stale.contains(write.sequence));
      final stored = await _read(transaction, event.table, event.id);
      if (remaining.isEmpty) {
        await _applyServer(transaction, event, dirty: false);
      } else if (stored != null) {
        await _put(
          transaction,
          event.table,
          event.id,
          stored.row,
          LocalRowMetadata(
            version: math.max(stored.metadata.version, event.version),
            dirty: true,
            syncedAtMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
      }
      for (final sequence in staleSequences) {
        await transaction.delete(
          _queueTable,
          where: 'seq = ?',
          whereArgs: [sequence],
        );
      }
    });
  }

  @override
  Future<int> bumpAttempts(int sequence) {
    return _database.transaction((transaction) async {
      final selected = await transaction.query(
        _queueTable,
        where: 'seq = ?',
        whereArgs: [sequence],
        limit: 1,
      );
      if (selected.isEmpty) return 0;
      final attempts = _integer(selected.single['attempts'], 'attempts') + 1;
      await transaction.update(
        _queueTable,
        {'attempts': attempts},
        where: 'seq = ?',
        whereArgs: [sequence],
      );
      return attempts;
    });
  }

  @override
  Future<int> getCursor([String scope = 'global']) async {
    final rows = await _database.query(
      _metadataTable,
      where: 'key = ?',
      whereArgs: ['cursor:$scope'],
      limit: 1,
    );
    return rows.isEmpty ? 0 : _integer(rows.single['value'], 'cursor');
  }

  @override
  Future<void> setCursor(int cursor, [String scope = 'global']) {
    if (cursor < 0) throw ArgumentError.value(cursor, 'cursor');
    return _database.transaction((transaction) async {
      final rows = await transaction.query(
        _metadataTable,
        where: 'key = ?',
        whereArgs: ['cursor:$scope'],
        limit: 1,
      );
      if (rows.isNotEmpty &&
          cursor < _integer(rows.single['value'], 'cursor')) {
        throw StateError('sync cursor cannot move backwards');
      }
      await transaction.insert(_metadataTable, {
        'key': 'cursor:$scope',
        'value': cursor,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    });
  }

  @override
  Future<void> close() => _database.close();
}

Future<StoredRow?> _read(
  DatabaseExecutor database,
  String table,
  String id,
) async {
  final rows = await database.query(
    _rowsTable,
    where: 'table_name = ? and row_id = ?',
    whereArgs: [table, id],
    limit: 1,
  );
  return rows.isEmpty ? null : _storedRow(rows.single);
}

Future<void> _put(
  DatabaseExecutor database,
  String table,
  String id,
  JsonMap row,
  LocalRowMetadata metadata,
) async {
  final existing = await database.query(
    _rowsTable,
    columns: ['created_at_ms', 'synced_at_ms'],
    where: 'table_name = ? and row_id = ?',
    whereArgs: [table, id],
    limit: 1,
  );
  final now = DateTime.now().millisecondsSinceEpoch;
  final existingCreated = existing.isEmpty
      ? null
      : existing.single['created_at_ms'] as int?;
  final existingSynced = existing.isEmpty
      ? null
      : existing.single['synced_at_ms'] as int?;
  await database.insert(_rowsTable, {
    'table_name': table,
    'row_id': id,
    'row_json': jsonEncode(row),
    'version': metadata.version,
    'dirty': metadata.dirty ? 1 : 0,
    'created_at_ms': metadata.createdAtMs ?? existingCreated ?? now,
    'updated_at_ms': metadata.updatedAtMs ?? now,
    'synced_at_ms':
        metadata.syncedAtMs ?? (metadata.dirty ? existingSynced : now),
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<void> _applyServer(
  DatabaseExecutor database,
  SyncChange event, {
  required bool dirty,
}) async {
  if (event.operation == ChangeOperation.delete) {
    await database.delete(
      _rowsTable,
      where: 'table_name = ? and row_id = ?',
      whereArgs: [event.table, event.id],
    );
  } else {
    await _put(
      database,
      event.table,
      event.id,
      event.row ??
          (throw const FormatException('upsert change must carry a row')),
      LocalRowMetadata(
        version: event.version,
        dirty: dirty,
        syncedAtMs: DateTime.now().millisecondsSinceEpoch,
      ),
    );
  }
}

StoredRow _storedRow(Map<String, Object?> record) {
  return StoredRow(
    row: _decodeMap(record['row_json'], 'row_json'),
    metadata: LocalRowMetadata(
      version: _integer(record['version'], 'version'),
      dirty: _integer(record['dirty'], 'dirty') == 1,
      createdAtMs: _nullableInteger(record['created_at_ms'], 'created_at_ms'),
      updatedAtMs: _nullableInteger(record['updated_at_ms'], 'updated_at_ms'),
      syncedAtMs: _nullableInteger(record['synced_at_ms'], 'synced_at_ms'),
    ),
  );
}

QueuedWrite _queuedWrite(Map<String, Object?> record) {
  final operation = record['operation'];
  return QueuedWrite(
    sequence: _integer(record['seq'], 'seq'),
    id: _string(record['row_id'], 'row_id'),
    table: _string(record['table_name'], 'table_name'),
    operation: ChangeOperation.fromWire(operation),
    payload: record['payload_json'] == null
        ? null
        : _decodeMap(record['payload_json'], 'payload_json'),
    baseVersion: _integer(record['base_version'], 'base_version'),
    key: record['write_key'] as String?,
    attempts: _integer(record['attempts'], 'attempts'),
    supersededVersion: record['superseded_version'] == null
        ? null
        : _integer(record['superseded_version'], 'superseded_version'),
    writePolicy: SyncWritePolicy(
      strategy: SyncWriteStrategy.fromWire(
        record['write_strategy'] ?? 'optimistic',
      ),
      failureMode: SyncFailureMode.fromWire(
        record['failure_mode'] ?? 'return_result',
      ),
      telemetry: SyncTelemetryLevel.fromWire(
        record['telemetry_level'] ?? 'errors',
      ),
    ),
  );
}

Map<String, Object?> _writeRecord(QueuedWrite write) => {
  'table_name': write.table,
  'row_id': write.id,
  'operation': write.operation.name,
  'payload_json': write.payload == null ? null : jsonEncode(write.payload),
  'base_version': write.baseVersion,
  'write_key': write.key,
  'attempts': write.attempts,
  'superseded_version': write.supersededVersion,
  'write_strategy': write.writePolicy.strategy.wireName,
  'failure_mode': write.writePolicy.failureMode.wireName,
  'telemetry_level': write.writePolicy.telemetry.name,
};

JsonMap _requiredPayload(QueuedWrite write) {
  return write.payload ??
      (throw const FormatException('upsert write must carry a payload'));
}

JsonMap _decodeMap(Object? value, String field) {
  if (value is! String) throw FormatException('$field must be text');
  final decoded = jsonDecode(value);
  if (decoded is! Map) throw FormatException('$field must contain an object');
  return Map<String, Object?>.from(decoded as Map<Object?, Object?>);
}

int _integer(Object? value, String field) {
  if (value is! int) throw FormatException('$field must be an integer');
  return value;
}

int? _nullableInteger(Object? value, String field) =>
    value == null ? null : _integer(value, field);

String _string(Object? value, String field) {
  if (value is! String) throw FormatException('$field must be a string');
  return value;
}
