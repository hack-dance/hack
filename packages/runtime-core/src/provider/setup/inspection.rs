//! Installation observation takes no leases and does not hash provider trees. Startup
//! still verifies content before execution; this is first-use guidance, not attestation.
use super::{FilePin, pins};
use crate::{
    Candidate, CandidateError,
    provider::{artifact, network_tools, state},
};
use serde::Serialize;
use std::{
    fs,
    io::ErrorKind,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Component, Path},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationState {
    NotSetUp,
    PartialResumable,
    Ready,
    InvalidPreserved,
    PinMismatch,
    UnsafeHome,
    Unavailable,
    UnsupportedHost,
}

impl InstallationState {
    fn code(self) -> &'static str {
        match self {
            Self::NotSetUp | Self::PartialResumable => "E_NATIVE_SETUP_REQUIRED",
            Self::Ready => "native_setup_ready",
            Self::InvalidPreserved => "native_setup_invalid",
            Self::PinMismatch => "native_setup_pin_mismatch",
            Self::UnsafeHome => "native_setup_unsafe_home",
            Self::Unavailable => "native_setup_unavailable",
            Self::UnsupportedHost => "unsupported_host",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Inspection {
    pub protocol_version: u32,
    pub state: InstallationState,
    pub installation_state: InstallationState,
    pub supported_host: bool,
    pub code: &'static str,
    pub pins: Vec<FilePin>,
    /// Narrow manager upgrade predicate, independent of installation readiness.
    pub setup_only: bool,
}

/// Validate a possibly absent selected home without creating or resolving it.
pub fn validate_home_path(home: &Path) -> Result<(), CandidateError> {
    if !home.is_absolute() || home.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(CandidateError::new(
            "invalid_candidate_home",
            "Native home must be absolute without parent traversal.",
        ));
    }
    crate::reject_aliased_state(home)
}

/// Called only after consent and host admission. Existing directories are never
/// chmodded or adopted as private homes. Each newly created component is 0700.
pub fn create_home(home: &Path) -> Result<Candidate, CandidateError> {
    validate_home_path(home)?;
    let mut current = std::path::PathBuf::new();
    for component in home.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(CandidateError::new(
                    "unsafe_candidate_home",
                    "Native home must not follow aliases.",
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&current)
                    .map_err(state::io)?;
                crate::reject_aliased_state(&current)?;
            }
            Err(error) => return Err(state::io(error)),
        }
    }
    Candidate::discover_installed(home)
}

/// Read-only and lock-free, including absent homes. Publication is atomic; a
/// concurrent setup may be reported resumable and can safely be retried later.
pub fn inspect_home(home: &Path) -> Result<Inspection, CandidateError> {
    let supported = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    inspect(home, supported)
}

/// Manager-only quiescence proof. Unlike ordinary inspection, this may contend
/// with setup/startup. Existing-only leases create nothing and fail closed.
pub fn inspect_home_quiescence(home: &Path) -> Result<Inspection, CandidateError> {
    let mut inspection = inspect_home(home)?;
    inspection.setup_only = Candidate::discover_installed(home)
        .and_then(|candidate| quiescent_setup_only(&candidate))
        .unwrap_or(false);
    Ok(inspection)
}

/// Checkout-local binaries retain their existing checkout admission. Their root
/// is a source directory rather than an installed private home.
pub fn inspect_candidate(candidate: &Candidate) -> Result<Inspection, CandidateError> {
    let installation_state = match classify_candidate(candidate) {
        Ok(value) => value,
        Err(error) => failure_state(&error),
    };
    result(
        installation_state,
        false,
        cfg!(all(target_os = "macos", target_arch = "aarch64")),
    )
}

fn inspect(home: &Path, supported_host: bool) -> Result<Inspection, CandidateError> {
    let (installation_state, setup_only) = classify(home);
    result(installation_state, setup_only, supported_host)
}

fn result(
    installation_state: InstallationState,
    setup_only: bool,
    supported_host: bool,
) -> Result<Inspection, CandidateError> {
    let state = if !supported_host
        && !matches!(
            installation_state,
            InstallationState::UnsafeHome | InstallationState::Unavailable
        ) {
        InstallationState::UnsupportedHost
    } else {
        installation_state
    };
    let code = state.code();
    Ok(Inspection {
        protocol_version: 1,
        state,
        installation_state,
        supported_host,
        code,
        pins: pins()?,
        setup_only,
    })
}

fn classify(home: &Path) -> (InstallationState, bool) {
    use InstallationState::*;
    if let Err(error) = validate_home_path(home) {
        return (
            if error.code == "state_unavailable" {
                Unavailable
            } else {
                UnsafeHome
            },
            false,
        );
    }
    match fs::symlink_metadata(home) {
        Err(error) if error.kind() == ErrorKind::NotFound => return (NotSetUp, false),
        Err(_) => return (Unavailable, false),
        Ok(_) => {}
    }
    let candidate = match Candidate::discover_installed(home) {
        Ok(candidate) => candidate,
        Err(_) => return (UnsafeHome, false),
    };
    // Only the explicit quiescence form may grant the manager predicate.
    let only_setup = false;
    match classify_candidate(&candidate) {
        Ok(value) => (value, only_setup),
        Err(error) => (failure_state(&error), only_setup),
    }
}

fn failure_state(error: &CandidateError) -> InstallationState {
    match error.code {
        "provider_pin_changed" => InstallationState::PinMismatch,
        "provider_state" | "state_unavailable" => InstallationState::Unavailable,
        _ => InstallationState::InvalidPreserved,
    }
}

fn installed_metadata(path: &Path) -> Result<fs::Metadata, CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            CandidateError::new("artifact_invalid", "Prepared runtime file is absent.")
        } else {
            state::io(error)
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CandidateError::new(
            "artifact_invalid",
            "Prepared runtime files must not be aliases.",
        ));
    }
    Ok(metadata)
}

fn classify_candidate(candidate: &Candidate) -> Result<InstallationState, CandidateError> {
    let root = &candidate.state_root;
    if !root.try_exists().map_err(state::io)? {
        return Ok(InstallationState::NotSetUp);
    }
    state::check_private_directory(root)?;
    let providers = root.join("providers");
    crate::reject_aliased_state(&providers)?;
    if !providers.try_exists().map_err(state::io)? {
        return Ok(InstallationState::PartialResumable);
    }
    state::check_private_directory(&providers)?;
    for pin in [&artifact::SMOLVM, &artifact::ENGINE] {
        installed_metadata(&providers.join(pin.record_name()))?;
        let record = artifact::verify_record(candidate, pin)?;
        if record.tree_sha256.len() != 64
            || !record.tree_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(CandidateError::new(
                "artifact_invalid",
                "Invalid prepared tree record.",
            ));
        }
        let tree = artifact::tree_root(candidate, pin);
        if !installed_metadata(&tree)?.is_dir() {
            return Err(CandidateError::new(
                "artifact_invalid",
                "Prepared tree is absent.",
            ));
        }
    }
    let packages = providers.join("network-tools");
    installed_metadata(&packages)?;
    state::check_private_directory(&packages)?;
    for (name, _) in network_tools::PACKAGES {
        let info = installed_metadata(&packages.join(name))?;
        // SAFETY: geteuid has no preconditions.
        if !info.is_file()
            || info.nlink() != 1
            || info.uid() != unsafe { libc::geteuid() }
            || info.mode() & 0o077 != 0
            || info.len() == 0
            || info.len() > 2 * 1024 * 1024
        {
            return Err(CandidateError::new(
                "network_tools",
                "Unsafe networking archive.",
            ));
        }
    }
    Ok(InstallationState::Ready)
}

/// No runtime owner/VM state can exist in a setup-only home. Unexpected entries
/// fail closed; this never removes anything or treats a missing owner as idle.
fn setup_only(candidate: &Candidate) -> Result<bool, CandidateError> {
    fn subset(path: &Path, allowed: &[&str]) -> Result<bool, CandidateError> {
        crate::reject_aliased_state(path)?;
        if !path.try_exists().map_err(state::io)? {
            return Ok(true);
        }
        state::check_private_directory(path)?;
        for entry in fs::read_dir(path).map_err(state::io)? {
            let entry = entry.map_err(state::io)?;
            if !allowed.iter().any(|name| entry.file_name() == *name) {
                return Ok(false);
            }
        }
        Ok(true)
    }
    let root = &candidate.state_root;
    if !subset(&candidate.checkout, &[".hack-local"])?
        || !subset(root, &["providers", "setup", "run"])?
        || !subset(&root.join("run"), &["smolvm"])?
        || !subset(&root.join("run/smolvm"), &["operation.lock"])?
    {
        return Ok(false);
    }
    if !subset(
        &root.join("setup"),
        &["operation.lock", "downloads", "staging"],
    )? {
        return Ok(false);
    }
    for name in ["providers", "setup", "setup/downloads", "setup/staging"] {
        let path = root.join(name);
        crate::reject_aliased_state(&path)?;
        if path.try_exists().map_err(state::io)? {
            state::check_private_directory(&path)?;
        }
    }
    let lock = root.join("run/smolvm/operation.lock");
    match fs::symlink_metadata(lock) {
        Ok(info) => {
            // SAFETY: geteuid has no preconditions.
            Ok(info.is_file()
                && info.nlink() == 1
                && info.uid() == unsafe { libc::geteuid() }
                && info.mode() & 0o7777 == 0o600)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(state::io(error)),
    }
}

fn quiescent_setup_only(candidate: &Candidate) -> Result<bool, CandidateError> {
    let directories = [
        candidate.state_root.join("setup"),
        candidate.state_root.join("run/smolvm"),
    ];
    let mut leases = Vec::new();
    for directory in &directories {
        crate::reject_aliased_state(directory)?;
        let lease = if directory.try_exists().map_err(state::io)? {
            Some(state::Lock::acquire_existing(directory)?)
        } else {
            None
        };
        leases.push(lease);
    }
    if !setup_only(candidate)? {
        return Ok(false);
    }
    for (directory, lease) in directories.iter().zip(&leases) {
        if let Some(lease) = lease {
            lease.verify_path(directory)?;
        } else if directory.try_exists().map_err(state::io)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(crate::private_test_root(
                &fs::canonicalize(std::env::temp_dir()).unwrap(),
                "setup-inspect",
            ))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    // Record-only readiness deliberately does not execute or attest these trees.
    pub(in crate::provider::setup) fn prepared_records(candidate: &Candidate) {
        let providers = candidate.state_root.join("providers");
        state::private_directory(&providers).unwrap();
        let pins = pins().unwrap();
        for (tree, source) in [(&artifact::SMOLVM, &pins[0]), (&artifact::ENGINE, &pins[1])] {
            state::private_directory(&artifact::tree_root(candidate, tree)).unwrap();
            let version = if tree.record_name() == "smolvm.json" {
                artifact::VERSION
            } else {
                artifact::ENGINE_VERSION
            };
            state::write(&providers.join(tree.record_name()), &serde_json::json!({"version": version, "archive_sha256": source.archive_sha256, "tree_sha256": "a".repeat(64)})).unwrap();
        }
        let directory = providers.join("network-tools");
        state::private_directory(&directory).unwrap();
        for (name, _) in network_tools::PACKAGES {
            let path = directory.join(name);
            fs::write(&path, b"fixture").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn absent_partial_ready_and_held_lease_are_read_only() {
        let fixture = Fixture::new();
        let absent = fixture.0.join("absent");
        assert_eq!(
            inspect(&absent, true).unwrap().state,
            InstallationState::NotSetUp
        );
        assert!(!absent.exists());
        let candidate = create_home(&absent).unwrap();
        assert!(inspect_home_quiescence(&absent).unwrap().setup_only);
        state::private_directory(&candidate.state_root.join("setup/downloads")).unwrap();
        fs::write(
            candidate.state_root.join("setup/downloads/file.part"),
            b"prefix",
        )
        .unwrap();
        assert_eq!(
            inspect(&absent, true).unwrap().state,
            InstallationState::PartialResumable
        );
        prepared_records(&candidate);
        let _lease = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        assert_eq!(
            inspect(&absent, true).unwrap().state,
            InstallationState::Ready
        );
        assert!(!inspect_home_quiescence(&absent).unwrap().setup_only);
        drop(_lease);
        let setup_lease = state::Lock::acquire(&candidate.state_root.join("setup")).unwrap();
        assert!(!inspect_home_quiescence(&absent).unwrap().setup_only);
        drop(setup_lease);
        assert!(inspect_home_quiescence(&absent).unwrap().setup_only);
        assert!(!inspect(&absent, true).unwrap().setup_only);
        fs::write(
            candidate.state_root.join("run/smolvm/owner.json"),
            b"unexpected",
        )
        .unwrap();
        assert!(!inspect_home_quiescence(&absent).unwrap().setup_only);
        assert_eq!(
            inspect(&absent, false).unwrap().state,
            InstallationState::UnsupportedHost
        );
    }

    #[test]
    fn mismatched_invalid_unsafe_and_foreign_state_have_different_fixes() {
        let fixture = Fixture::new();
        let candidate = Candidate::discover_installed(&fixture.0).unwrap();
        prepared_records(&candidate);
        let record = candidate.state_root.join("providers/smolvm.json");
        fs::remove_file(&record).unwrap();
        state::write(&record, &serde_json::json!({"version":"old", "archive_sha256":"b".repeat(64), "tree_sha256":"a".repeat(64)})).unwrap();
        assert_eq!(
            inspect(&fixture.0, true).unwrap().state,
            InstallationState::PinMismatch
        );
        fs::remove_file(&record).unwrap();
        assert_eq!(
            inspect(&fixture.0, true).unwrap().state,
            InstallationState::InvalidPreserved
        );
        symlink("missing", candidate.state_root.join("setup")).unwrap();
        symlink("missing", &record).unwrap();
        assert_eq!(
            inspect(&fixture.0, true).unwrap().state,
            InstallationState::InvalidPreserved
        );
        assert!(!inspect(&fixture.0, true).unwrap().setup_only);
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            inspect(&fixture.0, true).unwrap().state,
            InstallationState::UnsafeHome
        );
        assert_eq!(fs::metadata(&fixture.0).unwrap().mode() & 0o777, 0o755);
    }

    #[test]
    fn quiescence_refuses_unknown_setup_and_missing_locks_and_home_entries() {
        let fixture = Fixture::new();
        let candidate = Candidate::discover_installed(&fixture.0).unwrap();
        let setup = candidate.state_root.join("setup");
        let lease = state::Lock::acquire(&setup).unwrap();
        drop(lease);
        assert!(inspect_home_quiescence(&fixture.0).unwrap().setup_only);
        fs::write(setup.join("unexpected"), b"unknown").unwrap();
        assert!(!inspect_home_quiescence(&fixture.0).unwrap().setup_only);
        fs::remove_file(setup.join("unexpected")).unwrap();
        state::private_directory(&candidate.state_root.join("run/smolvm")).unwrap();
        assert!(!inspect_home_quiescence(&fixture.0).unwrap().setup_only);
        let lease = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        drop(lease);
        assert!(inspect_home_quiescence(&fixture.0).unwrap().setup_only);
        fs::create_dir(fixture.0.join("prepared-bases")).unwrap();
        assert!(!inspect_home_quiescence(&fixture.0).unwrap().setup_only);
        assert_eq!(
            failure_state(&CandidateError::new("provider_state", "access unavailable")),
            InstallationState::Unavailable
        );
    }
}
