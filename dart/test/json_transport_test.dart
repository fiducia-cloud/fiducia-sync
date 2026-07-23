import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('adapts fiducia-client JSON write callbacks', () async {
    JsonMap? sent;
    final send = adaptJsonSender((write) async {
      sent = write;
      return {'id': write['id'], 'committed_version': 8};
    });
    final acknowledgement = await send(
      const QueuedWrite(
        id: 'operation-7',
        table: 'infra_operations',
        operation: ChangeOperation.upsert,
        payload: {'state': 'queued'},
        baseVersion: 7,
        key: 'write-operation-7-v8',
      ),
    );

    expect(sent, {
      'id': 'operation-7',
      'table': 'infra_operations',
      'op': 'upsert',
      'payload': {'state': 'queued'},
      'base_version': 7,
      'key': 'write-operation-7-v8',
    });
    expect(acknowledgement.id, 'operation-7');
    expect(acknowledgement.committedVersion, 8);
  });

  test('adapts fiducia-client JSON pull callbacks', () async {
    final pull = adaptJsonPuller((cursor, limit) async {
      expect(cursor, 40);
      expect(limit, 2);
      return {
        'changes': [
          {
            'table': 'infra_operations',
            'op': 'upsert',
            'id': 'operation-7',
            'version': 8,
            'row': {'state': 'running'},
            'at_ms': 0,
            'sync_sequence': 41,
          },
        ],
        'next_cursor': 41,
        'has_more': false,
      };
    });

    final page = await pull(40, 2);
    expect(page.nextCursor, 41);
    expect(page.changes.single.id, 'operation-7');
    expect(page.changes.single.syncSequence, 41);
  });
}
