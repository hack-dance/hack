//! VM effects, private to the lifecycle owner that admits and records each attempt.
pub(super) mod smolvm_cli;

use crate::CandidateError;
use crate::provider::{NetworkIntent, ProjectShareIntent};
use std::path::PathBuf;

/// Creation inputs shared by ordinary pools and disposable prepared-base verifiers.
/// The backend is bound to one machine identity. A successful create acknowledges its
/// definition only; the lifecycle owner still proves disks and process identity after boot.
pub(super) struct MachineSpec {
    pub cpus: u32,
    pub memory_mib: u32,
    pub storage_gib: u32,
    pub overlay_gib: u32,
    pub engine_share: Option<PathBuf>,
    pub amd64_translation: bool,
    pub project_shares: Vec<ProjectShareIntent>,
    pub network: NetworkIntent,
    pub exposed_sockets: Vec<String>,
    pub mounted_sockets: Vec<(PathBuf, String)>,
}

/// Synchronous effects on one machine. Callers retain admission, leases, durable intent,
/// identity checks and recovery decisions. Acknowledgments never prove a process present
/// or absent. Errors preserve the existing codes and diagnostics, including uncertainty.
/// In particular, a failed start must be inspected before another start is admitted.
pub(super) trait VmBackend {
    fn create(&self, spec: &MachineSpec) -> Result<(), CandidateError>;
    fn start(&self) -> Result<(), CandidateError>;
    /// Ask the backend to stop. The caller must still observe the retained process exit.
    fn stop(&self) -> Result<(), CandidateError>;
    /// Caller must establish the existing recovery/teardown authority before deletion.
    fn delete_forced(&self) -> Result<(), CandidateError>;
    fn enable_translation(&self) -> Result<(), CandidateError>;
}
