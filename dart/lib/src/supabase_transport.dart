import 'dart:async';

import 'package:supabase_flutter/supabase_flutter.dart';

import 'models.dart';

typedef SupabaseStatusCallback =
    void Function(RealtimeSubscribeStatus status, Object? error);
typedef WriteParameterBuilder =
    Map<String, Object?> Function(QueuedWrite write);

final class SupabaseSyncTransport {
  SupabaseSyncTransport({
    required this.client,
    required this.tables,
    required this.tenantId,
    this.schema = 'public',
    this.channelName = 'fiducia-sync',
    this.filters = const {},
    this.writeRpc,
    this.writeParameters,
  });

  final SupabaseClient client;
  final List<String> tables;
  final String tenantId;
  final String schema;
  final String channelName;
  final Map<String, PostgresChangeFilter> filters;
  final String? writeRpc;
  final WriteParameterBuilder? writeParameters;

  RealtimeChannel? _channel;

  void start({
    required FutureOr<void> Function(SyncChange change) onChange,
    SupabaseStatusCallback? onStatus,
  }) {
    if (_channel != null) {
      throw StateError('Supabase sync transport is already started');
    }
    var channel = client.channel(channelName);
    for (final table in tables) {
      channel = channel.onPostgresChanges(
        event: PostgresChangeEvent.all,
        schema: schema,
        table: table,
        filter: filters[table],
        callback: (payload) {
          final change = decodeSupabasePayload(table, payload);
          if (change == null) return;
          unawaited(
            Future<void>.sync(() => onChange(change)).catchError((
              Object error,
              StackTrace _,
            ) {
              onStatus?.call(RealtimeSubscribeStatus.channelError, error);
            }),
          );
        },
      );
    }
    _channel = channel.subscribe(onStatus);
  }

  /// Pull a cursor page through the public `fiducia_sync_pull` PostgREST RPC.
  Future<PullPage> pull(int cursor, int limit) async {
    if (cursor < 0) throw ArgumentError.value(cursor, 'cursor');
    if (limit < 1 || limit > 1000) {
      throw RangeError.range(limit, 1, 1000, 'limit');
    }
    final Object? response = await client.rpc(
      'fiducia_sync_pull',
      params: {'p_tenant_id': tenantId, 'p_after': cursor, 'p_limit': limit},
    );
    if (response is! List) {
      throw const FormatException('Supabase pull RPC must return a list');
    }
    final changes = <SyncChange>[];
    var nextCursor = cursor;
    for (final value in response) {
      if (value is! Map) {
        throw const FormatException('Supabase pull row must be an object');
      }
      final row = Map<String, Object?>.from(value);
      final sequence = row['sync_sequence'];
      if (sequence is! int || sequence <= nextCursor) {
        throw const FormatException(
          'Supabase pull sequence must advance monotonically',
        );
      }
      changes.add(SyncChange.fromJson(row));
      nextCursor = sequence;
    }
    return PullPage(
      changes: changes,
      nextCursor: nextCursor,
      hasMore: response.length == limit,
    );
  }

  /// Send through an application-owned, authorization-aware Supabase RPC.
  ///
  /// The migration deliberately does not provide generic arbitrary-table
  /// writes. Callers name their domain RPC and can override the parameter map.
  Future<WriteAcknowledgement> send(QueuedWrite write) async {
    final rpc = writeRpc;
    if (rpc == null || rpc.isEmpty) {
      throw StateError('writeRpc is required for Supabase writes');
    }
    final parameters =
        writeParameters?.call(write) ??
        {
          'p_table': write.table,
          'p_id': write.id,
          'p_operation': write.operation.name,
          'p_payload': write.payload,
          'p_base_version': write.baseVersion,
          'p_write_key': write.key,
        };
    final Object? response = await client.rpc(rpc, params: parameters);
    if (response is Map) {
      return WriteAcknowledgement.fromJson(Map<String, Object?>.from(response));
    }
    if (response is List && response.length == 1 && response.single is Map) {
      return WriteAcknowledgement.fromJson(
        Map<String, Object?>.from(response.single as Map),
      );
    }
    throw const FormatException(
      'Supabase write RPC must return one acknowledgement object',
    );
  }

  Future<void> stop() async {
    final channel = _channel;
    _channel = null;
    if (channel != null) await client.removeChannel(channel);
  }
}

SyncChange? decodeSupabasePayload(String table, PostgresChangePayload payload) {
  final isDelete = payload.eventType == PostgresChangeEvent.delete;
  final record = isDelete ? payload.oldRecord : payload.newRecord;
  final id = record['id'];
  final version = record['version'];
  if (id == null || version is! int) return null;
  return SyncChange(
    table: table,
    operation: isDelete ? ChangeOperation.delete : ChangeOperation.upsert,
    id: id.toString(),
    version: version,
    row: Map<String, Object?>.from(record),
    atMs: payload.commitTimestamp.millisecondsSinceEpoch,
  );
}
