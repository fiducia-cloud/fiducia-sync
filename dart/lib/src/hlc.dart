/// Hybrid Logical Clock — the Dart mirror of the canonical Rust implementation
/// (`src/hlc.rs`) and the JS SDK (`sdk/src/hlc.mjs`), pinned to the same
/// shared vectors (`schema/fixtures/hlc-vectors.json`).
///
/// Phone clocks jump (NTP steps, timezone fixes, users editing the clock), so
/// `DateTime.now()` alone cannot order a device's own offline edits. The HLC
/// emits stamps that are strictly monotonic per device and never behind any
/// OBSERVED server commit time (`SyncChange.atMs`) — the CockroachDB timestamp
/// discipline, client-side. The per-row `version` and plane-wide
/// `sync_sequence` remain the authoritative ordering keys; HLC stamps are
/// advisory metadata on locally queued writes, stripped from wire envelopes.
///
/// Canonical encoding: 12 lowercase hex digits of Unix-ms + `-` + 4 hex digits
/// of the logical counter (`"0197f3b2c4d1-0003"`); lexicographic order equals
/// causal order.
library;

/// Highest representable wall clock: 2^48 - 1 ms (~year 10889); saturates.
const int hlcMaxWallMs = (1 << 48) - 1;

/// Highest counter within one millisecond; overflow rolls the wall forward.
const int hlcMaxCounter = 0xffff;

int _clampWall(int ms) => ms < 0 ? 0 : (ms > hlcMaxWallMs ? hlcMaxWallMs : ms);

/// One issued stamp; ordering is (wallMs, counter) == encoded string order.
final class HlcStamp implements Comparable<HlcStamp> {
  const HlcStamp({required this.wallMs, required this.counter});

  final int wallMs;
  final int counter;

  /// Fixed-width sortable form: 12 hex digits of ms + `-` + 4 hex of counter.
  String get encoded =>
      '${_clampWall(wallMs).toRadixString(16).padLeft(12, '0')}-'
      '${(counter & hlcMaxCounter).toRadixString(16).padLeft(4, '0')}';

  /// Parse the canonical encoding; null for anything malformed.
  static HlcStamp? decode(String text) {
    if (!RegExp(r'^[0-9a-f]{12}-[0-9a-f]{4}$').hasMatch(text)) return null;
    return HlcStamp(
      wallMs: int.parse(text.substring(0, 12), radix: 16),
      counter: int.parse(text.substring(13), radix: 16),
    );
  }

  @override
  int compareTo(HlcStamp other) {
    final byWall = wallMs.compareTo(other.wallMs);
    return byWall != 0 ? byWall : counter.compareTo(other.counter);
  }

  @override
  bool operator ==(Object other) =>
      other is HlcStamp && other.wallMs == wallMs && other.counter == counter;

  @override
  int get hashCode => Object.hash(wallMs, counter);

  @override
  String toString() => 'HlcStamp($encoded)';
}

/// The mutable clock. Persist [state] durably (the SQLite store does this in
/// the optimistic-write transaction) and restore it on startup so stamps stay
/// monotonic across app restarts.
final class Hlc {
  Hlc({HlcStamp? state, int Function()? nowMs})
    : _wallMs = _clampWall(state?.wallMs ?? 0),
      _counter = (state?.counter ?? 0).clamp(0, hlcMaxCounter),
      _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  int _wallMs;
  int _counter;
  final int Function() _nowMs;

  /// The state to persist: the last issued stamp.
  HlcStamp get state => HlcStamp(wallMs: _wallMs, counter: _counter);

  HlcStamp _advance(int wallMs, int counter) {
    if (counter > hlcMaxCounter) {
      // Counter exhausted within one ms: roll the wall forward instead.
      final rolled = _clampWall(wallMs + 1);
      _wallMs = rolled;
      _counter = rolled > wallMs ? 0 : hlcMaxCounter;
    } else {
      _wallMs = wallMs;
      _counter = counter;
    }
    return state;
  }

  /// Stamp a local event (an optimistic write). A regressed wall clock can
  /// slow the clock but never move it backwards.
  HlcStamp tick() {
    final now = _clampWall(_nowMs());
    return now > _wallMs ? _advance(now, 0) : _advance(_wallMs, _counter + 1);
  }

  /// Fold in a remote wall-clock observation (`SyncChange.atMs`); the next
  /// stamp is strictly after both the last local stamp and the observation.
  HlcStamp observe(int remoteMs) {
    final remote = _clampWall(remoteMs);
    final now = _clampWall(_nowMs());
    final wall = [_wallMs, remote, now].reduce((a, b) => a > b ? a : b);
    if (wall == _wallMs) return _advance(wall, _counter + 1);
    // A remote stamp carries no counter on the wire; step strictly past it.
    if (wall == remote) return _advance(wall, 1);
    return _advance(wall, 0);
  }
}
