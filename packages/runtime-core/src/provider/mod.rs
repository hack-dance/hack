//! Experimental WU02 provider boundary; live qualification is reported separately.
pub mod admission;
mod agent;
mod artifact;
mod engine;
pub mod graph;
pub use engine::{EngineInfo, info as engine_info};
mod identity;
mod image_load;
mod resources;
pub use image_load::load as load_image;
mod lifecycle;
mod network_tools;
mod process;
mod profile;
pub use profile::Profile;
mod publication_stage;
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
pub use lifecycle::{down, recover, status, up, up_with_profile};
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
