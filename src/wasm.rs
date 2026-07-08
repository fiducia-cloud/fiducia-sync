//! Browser bindings for `@fiducia/sync` (compiled only with `--features wasm`).
//!
//! The boundary is deliberately simple: JSON string in, JSON string out. The TS
//! shim owns IndexedDB + the transports and calls these pure decision functions.
//! Keeping the ABI as JSON avoids fragile wasm-bindgen type mapping and means the
//! wire shapes are exactly the generated `@fiducia/interfaces` row/envelope types.

use wasm_bindgen::prelude::*;

use crate::{
    on_ack as core_on_ack, reconcile as core_reconcile, ChangeEvent, LocalRow, QueuedWrite, WriteAck,
};

fn err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// Decide how an incoming change reconciles against the local row.
/// `local_json` is `null`/omitted when there is no local copy. Returns a JSON
/// `Reconcile` (`"Apply"`, `{"Ignore":"Stale"|"AlreadyApplied"}`, `"Conflict"`).
#[wasm_bindgen]
pub fn reconcile(local_json: Option<String>, incoming_json: String) -> Result<String, JsError> {
    let local = match local_json {
        Some(s) => Some(serde_json::from_str::<LocalRow>(&s).map_err(err)?),
        None => None,
    };
    let incoming: ChangeEvent = serde_json::from_str(&incoming_json).map_err(err)?;
    serde_json::to_string(&core_reconcile(local, &incoming)).map_err(err)
}

/// Reconcile a server ack for one of our optimistic writes. Returns a JSON
/// `AckOutcome` (`{"Adopt":<version>}` or `"Superseded"`).
#[wasm_bindgen]
pub fn on_ack(local_json: String, ack_json: String) -> Result<String, JsError> {
    let local: LocalRow = serde_json::from_str(&local_json).map_err(err)?;
    let ack: WriteAck = serde_json::from_str(&ack_json).map_err(err)?;
    serde_json::to_string(&core_on_ack(local, &ack)).map_err(err)
}

/// True if `incoming` is the realtime echo of our own queued write (so the TS
/// shim can adopt it instead of raising a false conflict).
#[wasm_bindgen]
pub fn is_own_echo(queued_json: String, incoming_json: String) -> Result<bool, JsError> {
    let queued: QueuedWrite = serde_json::from_str(&queued_json).map_err(err)?;
    let incoming: ChangeEvent = serde_json::from_str(&incoming_json).map_err(err)?;
    Ok(queued.is_echo_of(&incoming))
}
