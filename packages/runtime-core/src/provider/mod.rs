//! Experimental WU02 provider boundary; live qualification is reported separately.
pub mod admission;
mod agent;
mod artifact;
mod bridge;
mod config_audit;
mod dependency_socket;
pub use bridge::BridgeIntent;
pub use dependency_socket::{
    DependencySocketIntent, DependencySocketObservation, DependencySocketPath,
    dependency_socket_paths,
};
mod disk_audit;
mod engine;
pub mod environment;
#[cfg(test)]
mod environment_probe_test;
pub mod environment_recovery;
pub mod graph;
pub use engine::{EngineInfo, info as engine_info};
#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
mod gateway_probe_test;
pub mod guest_storage;
pub mod host_endpoint;
pub mod hostname_authority;
pub mod http_probe;
mod identity;
pub mod image_ensure;
mod image_load;
pub mod managed_environment;
pub mod private_deadline;
pub mod private_input;
pub mod registry_image;
pub mod relay_auth;
pub mod relay_client;
pub mod relay_frame;
pub mod relay_integrity;
#[cfg(target_os = "macos")]
pub mod relay_loop;
#[cfg(target_os = "macos")]
pub mod relay_owner;
pub mod resources;
pub mod storage_usage;
pub use image_load::load as load_image;
mod lifecycle;
mod network_intent;
mod project_share;
pub use project_share::ProjectShareIntent;
mod network_tools;

/// Prepare the pinned guest networking inputs without starting a runtime.
pub fn prepare_network_tools(
    candidate: &Candidate,
    directory: &Path,
) -> Result<impl Serialize, CandidateError> {
    network_tools::prepare(candidate, directory)
}

pub use network_intent::NetworkIntent;
mod process;
mod profile;
pub use profile::Profile;
pub mod publication;
mod publication_stage;
pub mod publisher;
#[cfg(test)]
mod source_failure_test;
mod source_job;
#[cfg(test)]
mod source_job_test;
#[cfg(test)]
mod source_output_test;
mod source_probe;
mod source_sync;
mod source_transfer;
#[cfg(test)]
mod source_watch_test;
#[cfg(test)]
mod supervisor_loss_test;
pub use source_job::{SourceJob, SourceJobEvent, reconcile_source_job, run_source_job};
pub use source_probe::{ProbeReceipt, verify as verify_source};
pub use source_sync::{SyncReceipt, SyncSession, sync_status};
mod state;
pub use lifecycle::{
    down, recover, status, up, up_with_bridge, up_with_capabilities, up_with_network_sockets,
    up_with_profile, up_with_project_share, up_with_sockets,
};
pub use source_transfer::{
    TransferReceipt, publish as publish_source, reconcile as reconcile_source_publication,
};

use crate::{Candidate, CandidateError};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct Status {
    pub checkpoint: &'static str,
    pub lifecycle_qualified: bool,
    pub artifact_prepared: bool,
    pub engine_prepared: bool,
    pub memory_admission: admission::Admission,
    pub runtime_effects: [&'static str; 0],
}

pub fn probe(candidate: &Candidate) -> Result<Status, CandidateError> {
    let prepared = candidate
        .state_root
        .join("providers/smolvm.json")
        .try_exists()
        .map_err(state::io)?;
    if prepared {
        artifact::verify(candidate)?;
    }
    let engine_prepared = candidate
        .state_root
        .join("providers/docker.json")
        .try_exists()
        .map_err(state::io)?;
    if engine_prepared {
        artifact::verify_engine(candidate)?;
    }
    Ok(Status {
        checkpoint: "WU02-provider-preflight",
        lifecycle_qualified: false,
        artifact_prepared: prepared,
        engine_prepared,
        memory_admission: admission::probe(&candidate.checkout)?,
        runtime_effects: [],
    })
}

pub fn prepare(candidate: &Candidate, archive: &Path) -> Result<impl Serialize, CandidateError> {
    artifact::prepare(candidate, archive)
}

pub fn prepare_engine(
    candidate: &Candidate,
    archive: &Path,
) -> Result<impl Serialize, CandidateError> {
    artifact::prepare_engine(candidate, archive)
}

#[cfg(test)]
mod graph_probe_test;
