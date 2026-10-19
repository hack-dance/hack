//! Guest storage flush proof required before a clean stop.
//!
//! The provider is signalled only after the guest agent's `shutdown` reply proves that the
//! storage filesystem was written back and remounted read-only. A bare `shutdown: true`
//! acknowledgement is not proof: the pinned SmolVM 1.14.3 agent (agent protocol 1) runs `sync()`,
//! only warns when the read-only remount fails, and still acknowledges. Host-side `fsync` of the
//! raw disk files cannot prove guest writeback either.
//!
//! Storage flush protocol 1 requires this reply shape:
//!
//! ```json
//! {"status":"ok","data":{"shutdown":true,
//!   "storage_flush":{"version":1,"syncfs":"ok","remount_read_only":"ok"}}}
//! ```
//!
//! Each step result is exactly `"ok"` or `"failed"`. Every other reply is refused with
//! `stop_uncertain` and a closed `cause_code`: a missing `storage_flush` block (every older guest,
//! including the current pin), an unknown version, a missing or unrecognized step result, or a
//! failed step. A refusal happens before any provider signal, so the pool keeps its `stopping`
//! phase, recorded disk identities and process authority; no clean-stop receipt is written.
//! Diagnostics never echo guest-provided values.
use super::super::agent;
use crate::CandidateError;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

/// The only storage flush protocol this host trusts.
const FLUSH_PROTOCOL: u64 = 1;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

/// Closed reasons a shutdown reply cannot prove a guest storage flush.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Refusal {
    NotAcknowledged,
    FlushUnreported,
    FlushVersionUnsupported,
    SyncfsUnreported,
    SyncfsFailed,
    RemountUnreported,
    RemountFailed,
}

impl Refusal {
    fn cause(self) -> &'static str {
        match self {
            Self::NotAcknowledged => "guest_shutdown_unacknowledged",
            Self::FlushUnreported => "guest_flush_unreported",
            Self::FlushVersionUnsupported => "guest_flush_version_unsupported",
            Self::SyncfsUnreported => "guest_syncfs_unreported",
            Self::SyncfsFailed => "guest_syncfs_failed",
            Self::RemountUnreported => "guest_remount_unreported",
            Self::RemountFailed => "guest_remount_failed",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::NotAcknowledged => "Guest did not acknowledge shutdown.",
            Self::FlushUnreported => {
                "Guest shutdown reported no storage flush results; an older guest is never trusted."
            }
            Self::FlushVersionUnsupported => "Guest storage flush protocol is not supported.",
            Self::SyncfsUnreported => "Guest shutdown did not report a storage syncfs result.",
            Self::SyncfsFailed => "Guest storage syncfs failed.",
            Self::RemountUnreported => {
                "Guest shutdown did not report a storage read-only remount result."
            }
            Self::RemountFailed => "Guest storage read-only remount failed.",
        }
    }
}

/// Request guest shutdown over the owned agent socket and require an explicit flush proof.
///
/// Transport and framing failures keep the agent's own `agent_protocol_uncertain` refusal.
pub(super) fn request(path: &Path) -> Result<(), CandidateError> {
    verify(&agent::request(
        path,
        json!({"method":"shutdown"}),
        SHUTDOWN_TIMEOUT,
    )?)
}

fn verify(response: &Value) -> Result<(), CandidateError> {
    classify(response).map_err(|refusal| {
        CandidateError::new("stop_uncertain", refusal.message())
            .with_cause_code(refusal.cause().to_owned())
    })
}

fn classify(response: &Value) -> Result<(), Refusal> {
    if response["status"] != "ok" || response["data"]["shutdown"] != true {
        return Err(Refusal::NotAcknowledged);
    }
    let flush = &response["data"]["storage_flush"];
    if !flush.is_object() {
        return Err(Refusal::FlushUnreported);
    }
    if flush["version"].as_u64() != Some(FLUSH_PROTOCOL) {
        return Err(Refusal::FlushVersionUnsupported);
    }
    step(
        &flush["syncfs"],
        Refusal::SyncfsUnreported,
        Refusal::SyncfsFailed,
    )?;
    step(
        &flush["remount_read_only"],
        Refusal::RemountUnreported,
        Refusal::RemountFailed,
    )
}

fn step(result: &Value, unreported: Refusal, failed: Refusal) -> Result<(), Refusal> {
    match result.as_str() {
        Some("ok") => Ok(()),
        Some("failed") => Err(failed),
        _ => Err(unreported),
    }
}

#[cfg(test)]
mod tests;
