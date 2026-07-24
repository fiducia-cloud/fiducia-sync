import 'dart:convert';
import 'dart:math' as math;

import 'package:sqflite/sqflite.dart';

import 'hlc.dart';
import 'models.dart';
import 'store.dart';

const _rowsTable = '_fiducia_rows';
const _queueTable = '_fiducia_queue';
const _metadataTable = '_fiducia_metadata';
const _schemaVersion = 2;

final class SqliteSyncStore implements SyncStore {
  SqliteSyncStore._(this._database, this._nowMs);

  final Database _database;
  final int Function() _nowMs;

  /// `nowMs` is the wall clock used for synced_at stamps (injectable in tests).
  static Future<SqliteSyncStore> open(
    String path, {
    DatabaseFactory? factory,
    int Function()? nowMs,
  }) async {
    final resolvedFactory = factory ?? databaseFactory;
    final database = await resolvedFactory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: _schemaVersion,
        onConfigure: (database) => database.execute('pragma foreign_keys = on'),
        onCreate: _createSchema,
        onUpgrade: _upgradeSchema,
      ),
    );
    return SqliteSyncStore._(
      database,
      nowMs ?? (() => DateTime.now().millisecondsSinceEpoch),
    );
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
          hlc text
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

  /// v1 → v2 preserves every row and queued write: it only ADDS the
  /// `synced_at_ms` and `hlc` columns (both nullable, so legacy records read
  /// back as "never synced"/"no stamp").
  static Future<void> _upgradeSchema(
    Database database,
    int oldVersion,
    int newVersion,
  ) async {
    await _createSchema(database, newVersion);
    if (oldVersion < 2) {
      await _addColumnIfMissing(
        database,
        _rowsTable,
        'synced_at_ms',
        'integer',
      );
      await _addColumnIfMissing(database, _queueTable, 'hlc', 'text');
    }
  }

  static Future<void> _addColumnIfMissing(
    Database database,
    String table,
    String column,
    String type,
  ) async {
    final columns = await database.rawQuery('pragma table_info($table)');
    final present = columns.any((info) => info['name'] == column);
    if (!present) {
      await database.execute('alter table $table add column $column $type');
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
    // An explicit stamp wins; otherwise a clean put marks "server state landed
    // here now" while a dirty put preserves the row's previous stamp.
    await _database.transaction((transaction) async {
      final synced =
          metadata.syncedAtMs ??
          (metadata.dirty
              ? (await _read(transaction, table, id))?.metadata.syncedAtMs
              : _nowMs());
      await _put(transaction, table, id, row, metadata, syncedAtMs: synced);
    });
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
  Future<int> enqueueOptimistic(
    QueuedWrite write,
    JsonMap? row, {
    HlcStamp? hlcState,
  }) {
    return _database.transaction((transaction) async {
      if (write.operation == ChangeOperation.delete) {
        await transaction.delete(
          _rowsTable,
          where: 'table_name = ? and row_id = ?',
          whereArgs: [write.table, write.id],
        );
      } else {
        // A dirty write keeps the row's previous synced_at_ms — editing on
        // top of synced state does not un-sync it.
        final existing = await _read(transaction, write.table, write.id);
        await _put(
          transaction,
          write.table,
          write.id,
          row ?? _requiredPayload(write),
          LocalRowMetadata(version: write.baseVersion, dirty: true),
          syncedAtMs: existing?.metadata.syncedAtMs,
        );
      }
      if (hlcState != null) {
        await _putHlcState(transaction, hlcState);
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
        final adopted = stored.metadata.version <= committedVersion;
        if (adopted) outcome = AckSettlement.adopted(committedVersion);
        await _put(
          transaction,
          table,
          id,
          stored.row,
          LocalRowMetadata(
            version: adopted ? committedVersion : stored.metadata.version,
            dirty: rowWrites.any((candidate) => candidate.sequence != sequence),
          ),
          // The server confirmed this state now; a superseded ack keeps the stamp.
          syncedAtMs: adopted ? _nowMs() : stored.metadata.syncedAtMs,
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
            ),
            syncedAtMs: stored.metadata.syncedAtMs,
          );
        }
      } else if (!hasNewerWrite) {
        if (stored == null || event.version >= stored.metadata.version) {
          await _applyServer(
            transaction,
            event,
            dirty: remaining.isNotEmpty,
            syncedAtMs: _nowMs(),
          );
        } else {
          await _put(
            transaction,
            event.table,
            event.id,
            stored.row,
            LocalRowMetadata(
              version: stored.metadata.version,
              dirty: remaining.isNotEmpty,
            ),
            syncedAtMs: stored.metadata.syncedAtMs,
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
          ),
          syncedAtMs: stored.metadata.syncedAtMs,
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
        await _applyServer(
          transaction,
          event,
          dirty: false,
          syncedAtMs: _nowMs(),
        );
      } else if (stored != null) {
        await _put(
          transaction,
          event.table,
          event.id,
          stored.row,
          LocalRowMetadata(
            version: math.max(stored.metadata.version, event.version),
            dirty: true,
          ),
          syncedAtMs: stored.metadata.syncedAtMs,
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
      // Every cursor advance is a completed catch-up step.
      await transaction.insert(_metadataTable, {
        'key': 'synced:$scope',
        'value': _nowMs(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    });
  }

  @override
  Future<int> markSynced([String scope = 'global']) async {
    final at = _nowMs();
    await _database.insert(_metadataTable, {
      'key': 'synced:$scope',
      'value': at,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    return at;
  }

  @override
  Future<SyncFreshness> syncInfo([String scope = 'global']) async {
    final cursor = await getCursor(scope);
    final synced = await _metadataValue('synced:$scope');
    return SyncFreshness(cursor: cursor, lastSyncedAtMs: synced);
  }

  @override
  Future<HlcStamp?> getHlcState() async {
    final wall = await _metadataValue('hlc:wall');
    if (wall == null) return null;
    final counter = await _metadataValue('hlc:counter') ?? 0;
    return HlcStamp(wallMs: wall, counter: counter);
  }

  @override
  Future<void> setHlcState(HlcStamp state) {
    return _database.transaction(
      (transaction) => _putHlcState(transaction, state),
    );
  }

  Future<int?> _metadataValue(String key) async {
    final rows = await _database.query(
      _metadataTable,
      where: 'key = ?',
      whereArgs: [key],
      limit: 1,
    );
    return rows.isEmpty ? null : _integer(rows.single['value'], key);
  }

  @override
  Future<void> close() => _database.close();
}

Future<void> _putHlcState(DatabaseExecutor database, HlcStamp state) async {
  await database.insert(_metadataTable, {
    'key': 'hlc:wall',
    'value': state.wallMs,
  }, conflictAlgorithm: ConflictAlgorithm.replace);
  await database.insert(_metadataTable, {
    'key': 'hlc:counter',
    'value': state.counter,
  }, conflictAlgorithm: ConflictAlgorithm.replace);
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
  LocalRowMetadata metadata, {
  required int? syncedAtMs,
}) async {
  await database.insert(_rowsTable, {
    'table_name': table,
    'row_id': id,
    'row_json': jsonEncode(row),
    'version': metadata.version,
    'dirty': metadata.dirty ? 1 : 0,
    'synced_at_ms': syncedAtMs,
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<void> _applyServer(
  DatabaseExecutor database,
  SyncChange event, {
  required bool dirty,
  required int? syncedAtMs,
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
      LocalRowMetadata(version: event.version, dirty: dirty),
      syncedAtMs: syncedAtMs,
    );
  }
}

StoredRow _storedRow(Map<String, Object?> record) {
  final synced = record['synced_at_ms'];
  return StoredRow(
    row: _decodeMap(record['row_json'], 'row_json'),
    metadata: LocalRowMetadata(
      version: _integer(record['version'], 'version'),
      dirty: _integer(record['dirty'], 'dirty') == 1,
      syncedAtMs: synced == null ? null : _integer(synced, 'synced_at_ms'),
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
    hlc: record['hlc'] as String?,
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
  'hlc': write.hlc,
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

String _string(Object? value, String field) {
  if (value is! String) throw FormatException('$field must be a string');
  return value;
}
