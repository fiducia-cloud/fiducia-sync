import 'dart:convert';
import 'dart:io';

import 'package:fiducia_sync/fiducia_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// The Dart HLC + schema validator must reproduce the SAME results as the Rust
/// core (tests/shared_fixtures.rs) and JS SDK over the shared fixture files.
void main() {
  setUpAll(sqfliteFfiInit);

  Map<String, Object?> loadFixture(String name) {
    final file = File('../schema/fixtures/$name');
    expect(
      file.existsSync(),
      isTrue,
      reason: 'shared fixture $name must ship with the repo',
    );
    return Map<String, Object?>.from(
      jsonDecode(file.readAsStringSync()) as Map,
    );
  }

  test('shared HLC vectors replay identically', () {
    final cases = loadFixture('hlc-vectors.json')['cases']! as List;
    expect(cases, isNotEmpty);
    for (final rawCase in cases.cast<Map>()) {
      final name = rawCase['name'];
      final start = Map<String, Object?>.from(rawCase['start'] as Map);
      var currentNow = 0;
      final clock = Hlc(
        state: HlcStamp(
          wallMs: start['wall_ms']! as int,
          counter: start['counter']! as int,
        ),
        nowMs: () => currentNow,
      );
      final steps = (rawCase['steps'] as List).cast<Map>();
      for (var i = 0; i < steps.length; i += 1) {
        final step = steps[i];
        currentNow = step['now_ms']! as int;
        final stamp = step['op'] == 'tick'
            ? clock.tick()
            : clock.observe(step['remote_ms']! as int);
        expect(stamp.encoded, step['expect'], reason: '$name step $i');
      }
    }
  });

  test('stamps stay strictly monotonic under a regressing clock', () {
    var currentNow = 1000;
    final clock = Hlc(nowMs: () => currentNow);
    var previous = clock.tick();
    for (final next in [1000, 999, 0, -50, 1000, 1001, 500]) {
      currentNow = next;
      final stamp = clock.tick();
      expect(stamp.compareTo(previous), greaterThan(0));
      expect(stamp.encoded.compareTo(previous.encoded), greaterThan(0));
      previous = stamp;
    }
  });

  test('encode/decode round-trips and rejects malformed stamps', () {
    const stamp = HlcStamp(wallMs: 1720000000000, counter: 3);
    expect(HlcStamp.decode(stamp.encoded), stamp);
    for (final bad in ['', '0197F3B2C4D1-0003', '0197f3b2c4d1_0003', 'zz']) {
      expect(HlcStamp.decode(bad), isNull, reason: bad);
    }
  });

  test('shared envelope fixtures all agree with the embedded schema', () {
    final validator = SchemaValidator.sync();
    expect(
      validator.definitions,
      containsAll(<String>[
        'SyncChangeEvent',
        'SyncQueuedWrite',
        'SyncWriteAcknowledgement',
        'SyncPullPage',
      ]),
    );
    final cases = loadFixture('sync-envelopes.json')['cases']! as List;
    expect(cases.length, greaterThanOrEqualTo(20));
    for (final rawCase in cases.cast<Map>()) {
      final name = rawCase['name'];
      final violations = validator.validate(
        rawCase['definition']! as String,
        rawCase['value'],
      );
      expect(
        violations.isEmpty,
        rawCase['valid'],
        reason: '$name → $violations',
      );
    }
  });

  test(
    'validator fails closed on unsupported keywords and bad definitions',
    () {
      expect(
        () => SchemaValidator({
          r'$defs': {
            'X': {'type': 'string', 'pattern': '^a'},
          },
        }),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('pattern'),
          ),
        ),
      );
      final validator = SchemaValidator.sync();
      expect(validator.validate('NoSuchThing', const {}), isNotEmpty);
      expect(
        () => validator.check('SyncWriteAcknowledgement', const {'id': 'k1'}),
        throwsA(isA<SchemaValidationException>()),
      );
    },
  );

  test('violations carry precise JSON paths', () {
    final validator = SchemaValidator.sync();
    final violations = validator.validate('SyncPullPage', {
      'changes': [
        {
          'table': 't',
          'op': 'upsert',
          'id': 'a',
          'version': 1,
          'row': {},
          'at_ms': 0,
        },
        {
          'table': 't',
          'op': 'upsert',
          'id': 'b',
          'version': -2,
          'row': {},
          'at_ms': 0,
        },
      ],
      'next_cursor': 2,
      'has_more': false,
    });
    expect(violations.map((v) => v.path), contains(r'$.changes[1].version'));
  });

  test(
    'queued writes carry HLC stamps that sort after observed server time',
    () async {
      final store = await SqliteSyncStore.open(
        inMemoryDatabasePath,
        factory: databaseFactoryFfi,
        nowMs: () => 5000,
      );
      final client = FiduciaSyncClient(store: store, nowMs: () => 5000);

      await client.applyChange(
        const SyncChange(
          table: 'items',
          operation: ChangeOperation.upsert,
          id: 'other',
          version: 1,
          row: {'id': 'other'},
          atMs: 9000,
        ),
      );
      await client.optimisticWrite(
        table: 'items',
        id: 'one',
        row: const {'id': 'one'},
        send: (_) async => throw StateError('offline'),
      );

      final queued = (await store.queuedWrites()).single;
      final stamp = HlcStamp.decode(queued.hlc!);
      expect(stamp, isNotNull);
      expect(stamp!.wallMs, greaterThanOrEqualTo(9000));
      expect(await store.getHlcState(), stamp);

      // A new client over the same store resumes from durable state.
      final client2 = FiduciaSyncClient(store: store, nowMs: () => 5000);
      await client2.optimisticWrite(
        table: 'items',
        id: 'two',
        row: const {'id': 'two'},
        send: (_) async => throw StateError('offline'),
      );
      final later = (await store.queuedWrites()).firstWhere(
        (w) => w.id == 'two',
      );
      expect(later.hlc!.compareTo(queued.hlc!), greaterThan(0));
      await client.close();
    },
  );
}
