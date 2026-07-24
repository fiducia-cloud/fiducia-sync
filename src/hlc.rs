//! A Hybrid Logical Clock (HLC) — the CockroachDB-style timestamp discipline,
//! adapted for local-first clients.
//!
//! Wall clocks on phones and laptops jump: NTP steps, timezone fixes, users
//! editing the clock, suspended tabs. A raw `Date.now()` therefore cannot order
//! a device's own offline edits reliably. An HLC can: it emits stamps that are
//! **strictly monotonic per device** and never behind any *observed* remote
//! time, while staying within one tick of real time whenever the wall clock is
//! sane (Kulkarni et al., the scheme CockroachDB uses for transaction time).
//!
//! In fiducia-sync the authoritative ordering keys are unchanged — the per-row
//! `version` and the plane-wide `sync_sequence`. The HLC is the *client-side*
//! companion: it stamps queued optimistic writes (`local-*` policies) so their
//! creation order survives clock skew, and it feeds `observe()` with every
//! incoming `ChangeEvent.at_ms` so local stamps always sort after the last
//! synced server commit. Stamps are advisory metadata; they are never sent in
//! the strict wire envelopes and never participate in reconciliation.
//!
//! The canonical encoding is a fixed-width sortable string — 12 lowercase hex
//! digits of Unix-milliseconds, a dash, and 4 hex digits of the logical
//! counter (e.g. `"0197f3b2c4d1-0003"`) — chosen so
//! that lexicographic order equals causal order in every language, including
//! ones whose native integers cannot hold `wall_ms << 16`.

use serde::{Deserialize, Serialize};

/// Highest representable wall-clock value: 2^48 - 1 ms (~year 10889). Inputs
/// beyond it saturate rather than panic — the clock stays total over hostile
/// input, like the reconcile core.
pub const HLC_MAX_WALL_MS: i64 = (1 << 48) - 1;

/// Highest logical counter within one millisecond; overflow rolls the wall
/// forward one ms, preserving strict monotonicity.
pub const HLC_MAX_COUNTER: u32 = 0xFFFF;

fn clamp_wall(ms: i64) -> i64 {
    ms.clamp(0, HLC_MAX_WALL_MS)
}

/// One issued HLC timestamp. Ordering is `(wall_ms, counter)` and matches the
/// lexicographic order of [`HlcStamp::encode`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct HlcStamp {
    pub wall_ms: i64,
    pub counter: u32,
}

impl HlcStamp {
    /// Fixed-width sortable form: 12 hex digits of ms + `-` + 4 hex of counter.
    pub fn encode(self) -> String {
        format!(
            "{:012x}-{:04x}",
            clamp_wall(self.wall_ms),
            self.counter & HLC_MAX_COUNTER
        )
    }

    /// Parse the canonical encoding; `None` for anything malformed.
    pub fn decode(text: &str) -> Option<HlcStamp> {
        let bytes = text.as_bytes();
        if bytes.len() != 17 || bytes[12] != b'-' {
            return None;
        }
        let lower_hex = |s: &str| {
            s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let (wall_hex, counter_hex) = (&text[..12], &text[13..]);
        if !lower_hex(wall_hex) || !lower_hex(counter_hex) {
            return None;
        }
        let wall_ms = i64::from_str_radix(wall_hex, 16).ok()?;
        let counter = u32::from_str_radix(counter_hex, 16).ok()?;
        Some(HlcStamp { wall_ms, counter })
    }
}

/// The mutable clock. Persist [`Hlc::state`] durably alongside the sync cursor
/// and restore it on startup so stamps stay monotonic across restarts.
/// `default()` is the epoch clock (`wall_ms: 0, counter: 0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Hlc {
    wall_ms: i64,
    counter: u32,
}

impl Hlc {
    pub fn new() -> Hlc {
        Hlc::default()
    }

    /// Restore a persisted clock. Out-of-range values are clamped, never rejected.
    pub fn from_state(wall_ms: i64, counter: u32) -> Hlc {
        Hlc {
            wall_ms: clamp_wall(wall_ms),
            counter: counter.min(HLC_MAX_COUNTER),
        }
    }

    /// The state to persist: `(wall_ms, counter)` of the last issued stamp.
    pub fn state(&self) -> (i64, u32) {
        (self.wall_ms, self.counter)
    }

    fn advance(&mut self, wall_ms: i64, counter: u32) -> HlcStamp {
        if counter > HLC_MAX_COUNTER {
            // Counter exhausted within one ms: roll the wall forward instead.
            self.wall_ms = clamp_wall(wall_ms.saturating_add(1));
            self.counter = if self.wall_ms > wall_ms {
                0
            } else {
                HLC_MAX_COUNTER
            };
        } else {
            self.wall_ms = wall_ms;
            self.counter = counter;
        }
        HlcStamp {
            wall_ms: self.wall_ms,
            counter: self.counter,
        }
    }

    /// Stamp a local event (an optimistic write). `now_ms` is the wall clock;
    /// a regressed or hostile value can slow the clock but never move it back.
    pub fn tick(&mut self, now_ms: i64) -> HlcStamp {
        let now = clamp_wall(now_ms);
        if now > self.wall_ms {
            self.advance(now, 0)
        } else {
            let (wall, counter) = (self.wall_ms, self.counter + 1);
            self.advance(wall, counter)
        }
    }

    /// Fold in a remote wall-clock observation (`ChangeEvent.at_ms`). The next
    /// stamp is strictly after both the last local stamp and the observation,
    /// even when the local wall clock lags the server's.
    pub fn observe(&mut self, remote_ms: i64, now_ms: i64) -> HlcStamp {
        let remote = clamp_wall(remote_ms);
        let now = clamp_wall(now_ms);
        let wall = self.wall_ms.max(remote).max(now);
        if wall == self.wall_ms {
            let counter = self.counter + 1;
            self.advance(wall, counter)
        } else if wall == remote {
            // The remote stamp carries no counter on the wire; step past it.
            self.advance(wall, 1)
        } else {
            self.advance(wall, 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_strictly_monotonic_even_when_the_wall_clock_regresses() {
        let mut clock = Hlc::new();
        let mut previous = clock.tick(1_000);
        for now in [1_000, 999, 0, -50, 1_000, 1_001, 500] {
            let stamp = clock.tick(now);
            assert!(stamp > previous, "{stamp:?} must exceed {previous:?}");
            previous = stamp;
        }
    }

    #[test]
    fn observing_a_future_remote_time_jumps_strictly_past_it() {
        let mut clock = Hlc::new();
        clock.tick(1_000);
        let stamp = clock.observe(5_000, 1_001);
        assert_eq!(
            stamp,
            HlcStamp {
                wall_ms: 5_000,
                counter: 1
            }
        );
        // The next local stamp stays after the observation despite the old wall.
        let next = clock.tick(1_002);
        assert_eq!(
            next,
            HlcStamp {
                wall_ms: 5_000,
                counter: 2
            }
        );
    }

    #[test]
    fn observing_the_past_still_moves_forward() {
        let mut clock = Hlc::from_state(9_000, 4);
        let stamp = clock.observe(1_000, 1_000);
        assert_eq!(
            stamp,
            HlcStamp {
                wall_ms: 9_000,
                counter: 5
            }
        );
        let ahead = clock.observe(1_000, 10_000);
        assert_eq!(
            ahead,
            HlcStamp {
                wall_ms: 10_000,
                counter: 0
            }
        );
    }

    #[test]
    fn counter_overflow_rolls_the_wall_forward() {
        let mut clock = Hlc::from_state(2_000, HLC_MAX_COUNTER);
        let stamp = clock.tick(1_500);
        assert_eq!(
            stamp,
            HlcStamp {
                wall_ms: 2_001,
                counter: 0
            }
        );
    }

    #[test]
    fn hostile_extremes_saturate_and_stay_total() {
        let mut clock = Hlc::new();
        let top = clock.tick(i64::MAX);
        assert_eq!(top.wall_ms, HLC_MAX_WALL_MS);
        // Fully saturated: issuing more stamps cannot panic or move backwards.
        let mut previous = top;
        for _ in 0..70_000 {
            let stamp = clock.tick(i64::MAX);
            assert!(stamp >= previous);
            previous = stamp;
        }
        let mut negative = Hlc::new();
        assert_eq!(
            negative.tick(i64::MIN),
            HlcStamp {
                wall_ms: 0,
                counter: 1
            }
        );
    }

    #[test]
    fn encoding_is_fixed_width_sortable_and_round_trips() {
        let stamps = [
            HlcStamp {
                wall_ms: 0,
                counter: 0,
            },
            HlcStamp {
                wall_ms: 0,
                counter: 1,
            },
            HlcStamp {
                wall_ms: 1,
                counter: 0,
            },
            HlcStamp {
                wall_ms: 1_720_000_000_000,
                counter: 3,
            },
            HlcStamp {
                wall_ms: HLC_MAX_WALL_MS,
                counter: HLC_MAX_COUNTER,
            },
        ];
        let mut encoded: Vec<String> = stamps.iter().map(|s| s.encode()).collect();
        let mut sorted = encoded.clone();
        sorted.sort();
        assert_eq!(
            encoded, sorted,
            "lexicographic order must equal causal order"
        );
        encoded.dedup();
        assert_eq!(encoded.len(), stamps.len());
        for stamp in stamps {
            assert_eq!(HlcStamp::decode(&stamp.encode()), Some(stamp));
        }
        for bad in [
            "",
            "0197f3b2c4d1_0003",
            "0197F3B2C4D1-0003",
            "xyz",
            "0197f3b2c4d1-003",
        ] {
            assert_eq!(HlcStamp::decode(bad), None, "{bad:?}");
        }
    }
}
