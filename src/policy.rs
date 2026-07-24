//! Write-policy and error-mode options for optimistic client writes.
//!
//! Both are deliberately enums, not booleans: optimism is a spectrum, and every
//! SDK (TS, Dart, Rust) exposes the SAME canonical wire names so app code and
//! telemetry attributes agree across runtimes. The core only *defines* the
//! vocabulary and its semantics matrix — the IO shims (`sdk/src/client.mjs`,
//! `dart/lib/src/client.dart`) implement the behavior and are tested against
//! the same matrix.

use serde::{Deserialize, Serialize};

/// How optimistic a single write is about local state vs the backend.
///
/// | policy | local mutate before send | durable queue entry | sends now | local adopt on ack |
/// |---|---|---|---|---|
/// | `local-only`   | yes | yes | no  | — (flushed later) |
/// | `local-first`  | yes | yes | yes | via queue settlement |
/// | `server-first` | no  | no  | yes | direct, guarded by version |
/// | `server-only`  | no  | no  | yes | no (realtime echo / pull lands it) |
///
/// `local-first` is the default everywhere and matches the SDK's historical
/// behavior. `local-only` is maximum optimism (compose offline, flush later);
/// `server-only` is maximum pessimism (the local store stays a pure replica of
/// committed state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WritePolicy {
    /// Mutate the local store and durably enqueue, but do not send now.
    LocalOnly,
    /// Mutate the local store, enqueue durably, and send in the background.
    LocalFirst,
    /// Send first; apply the committed result locally only after the ack.
    ServerFirst,
    /// Send only; never touch the local store (echo/catch-up lands the row).
    ServerOnly,
}

impl WritePolicy {
    /// Every policy, in optimism order (most optimistic first).
    pub const ALL: [WritePolicy; 4] = [
        WritePolicy::LocalOnly,
        WritePolicy::LocalFirst,
        WritePolicy::ServerFirst,
        WritePolicy::ServerOnly,
    ];

    /// The default policy (`local-first`) — the SDK's historical behavior.
    pub const DEFAULT: WritePolicy = WritePolicy::LocalFirst;

    /// The canonical kebab-case wire name (also the TS/Dart enum value).
    pub fn as_str(self) -> &'static str {
        match self {
            WritePolicy::LocalOnly => "local-only",
            WritePolicy::LocalFirst => "local-first",
            WritePolicy::ServerFirst => "server-first",
            WritePolicy::ServerOnly => "server-only",
        }
    }

    /// Parse a canonical wire name.
    pub fn parse(value: &str) -> Option<WritePolicy> {
        WritePolicy::ALL.into_iter().find(|p| p.as_str() == value)
    }

    /// Does this policy mutate the local store (dirty row) before any network IO?
    pub fn mutates_local_before_send(self) -> bool {
        matches!(self, WritePolicy::LocalOnly | WritePolicy::LocalFirst)
    }

    /// Does this policy append a durable retry record to the write queue?
    pub fn enqueues_durably(self) -> bool {
        matches!(self, WritePolicy::LocalOnly | WritePolicy::LocalFirst)
    }

    /// Does this policy perform network IO as part of the write call itself?
    pub fn sends_immediately(self) -> bool {
        !matches!(self, WritePolicy::LocalOnly)
    }

    /// Does a successful ack mutate the local store (directly or via the queue)?
    pub fn adopts_ack_locally(self) -> bool {
        matches!(self, WritePolicy::LocalFirst | WritePolicy::ServerFirst)
    }
}

/// How a failed send surfaces to the CALLER. Telemetry always observes every
/// failure regardless of mode — this only selects the caller-facing channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorMode {
    /// Resolve normally with the failure encoded in the result (default; the
    /// SDK's historical `{status:"queued", error}` shape).
    Return,
    /// Reject/throw a typed error (the write still stays durably queued under a
    /// `local-*` policy).
    Throw,
    /// Resolve quietly; the failure is reported only through telemetry and
    /// status callbacks.
    Emit,
}

impl ErrorMode {
    pub const ALL: [ErrorMode; 3] = [ErrorMode::Return, ErrorMode::Throw, ErrorMode::Emit];

    /// The default mode (`return`) — the SDK's historical behavior.
    pub const DEFAULT: ErrorMode = ErrorMode::Return;

    /// The canonical kebab-case wire name (also the TS/Dart enum value).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorMode::Return => "return",
            ErrorMode::Throw => "throw",
            ErrorMode::Emit => "emit",
        }
    }

    /// Parse a canonical wire name.
    pub fn parse(value: &str) -> Option<ErrorMode> {
        ErrorMode::ALL.into_iter().find(|m| m.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_round_trip_through_serde_and_parse() {
        for policy in WritePolicy::ALL {
            let wire = serde_json::to_string(&policy).unwrap();
            assert_eq!(wire, format!("\"{}\"", policy.as_str()));
            let back: WritePolicy = serde_json::from_str(&wire).unwrap();
            assert_eq!(back, policy);
            assert_eq!(WritePolicy::parse(policy.as_str()), Some(policy));
        }
        for mode in ErrorMode::ALL {
            let wire = serde_json::to_string(&mode).unwrap();
            assert_eq!(wire, format!("\"{}\"", mode.as_str()));
            let back: ErrorMode = serde_json::from_str(&wire).unwrap();
            assert_eq!(back, mode);
            assert_eq!(ErrorMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(WritePolicy::parse("optimistic"), None);
        assert_eq!(ErrorMode::parse("panic"), None);
    }

    #[test]
    fn semantics_matrix_is_exactly_the_documented_table() {
        use WritePolicy::*;
        let matrix = [
            // (policy, mutates_local, enqueues, sends, adopts_ack)
            (LocalOnly, true, true, false, false),
            (LocalFirst, true, true, true, true),
            (ServerFirst, false, false, true, true),
            (ServerOnly, false, false, true, false),
        ];
        for (policy, mutates, enqueues, sends, adopts) in matrix {
            assert_eq!(policy.mutates_local_before_send(), mutates, "{policy:?}");
            assert_eq!(policy.enqueues_durably(), enqueues, "{policy:?}");
            assert_eq!(policy.sends_immediately(), sends, "{policy:?}");
            assert_eq!(policy.adopts_ack_locally(), adopts, "{policy:?}");
        }
    }

    #[test]
    fn defaults_match_the_historical_sdk_behavior() {
        assert_eq!(WritePolicy::DEFAULT, WritePolicy::LocalFirst);
        assert_eq!(ErrorMode::DEFAULT, ErrorMode::Return);
    }
}
