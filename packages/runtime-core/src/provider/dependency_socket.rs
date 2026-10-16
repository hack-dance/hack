//! Explicit guest-to-host transport capacity, never application authorization.
use super::state;
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencySocketIntent {
    pub slots: u8,
}
impl DependencySocketIntent {
    /// Reserve fixed transport paths. No listener, grant or guest client is created.
    pub fn new(slots: u8) -> Result<Self, CandidateError> {
        if !(1..=32).contains(&slots) {
            return Err(refused(
                "Dependency socket capacity must be between 1 and 32.",
            ));
        }
        Ok(Self { slots })
    }
    pub(super) fn mappings(self, home: &Path) -> Value {
        json!(
            self.paths(home)
                .into_iter()
                .map(|path| json!({
                    "direction":"mount", "host_path":path.host_path, "guest_path":path.guest_path
                }))
                .collect::<Vec<_>>()
        )
    }
    pub(super) fn paths(self, home: &Path) -> Vec<DependencySocketPath> {
        (0..self.slots)
            .map(|slot| DependencySocketPath {
                slot,
                host_path: home.join(format!("dependency-{slot:02}.sock")),
                guest_path: format!("/run/hack-dependencies/dependency-{slot:02}.sock"),
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DependencySocketPath {
    pub slot: u8,
    pub host_path: PathBuf,
    pub guest_path: String,
}

/// Metadata observation only. A socket inode does not prove a bound listener,
/// live owner, authenticated relay or application readiness.
#[derive(Debug, Serialize)]
pub struct DependencySocketObservation {
    #[serde(flatten)]
    pub path: DependencySocketPath,
    pub socket_identity: Option<(u64, u64)>,
    pub metadata_status: &'static str,
    pub application_ready: bool,
}

fn refused(message: &str) -> CandidateError {
    CandidateError::new("dependency_socket", message)
}

pub(super) fn check_capacity(
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<DependencySocketIntent>,
) -> Result<(), CandidateError> {
    if let Some(intent) = dependencies {
        DependencySocketIntent::new(intent.slots)?;
    }
    if let Some(intent) = bridge {
        super::BridgeIntent::new(intent.slots)?;
    }
    if u16::from(bridge.map_or(0, |v| v.slots)) + u16::from(dependencies.map_or(0, |v| v.slots))
        > 32
    {
        return Err(refused(
            "Combined application and dependency socket capacity exceeds 32.",
        ));
    }
    Ok(())
}

pub(super) fn check_request(
    existing: Option<DependencySocketIntent>,
    requested: Option<DependencySocketIntent>,
) -> Result<(), CandidateError> {
    if requested.is_some() && requested != existing {
        return Err(CandidateError::new(
            "dependency_socket_conflict",
            "Existing pool has different dependency socket capacity; no replacement was attempted.",
        ));
    }
    Ok(())
}

/// Paths are derived from the existing receipt-bound short HOME, never user paths.
/// Missing sockets are valid staged transport and remain explicitly unready.
pub fn dependency_socket_paths(
    candidate: &Candidate,
) -> Result<Vec<DependencySocketPath>, CandidateError> {
    let guest = super::lifecycle::OwnedGuest::connect_cleanup(candidate)?;
    let owner = state::Owner::load(candidate)?;
    guest.verify()?;
    Ok(owner
        .dependency_sockets
        .map(|intent| intent.paths(&owner.short_home))
        .unwrap_or_default())
}

pub(super) fn observe(
    candidate: &Candidate,
    owner: &state::Owner,
) -> Result<Vec<DependencySocketObservation>, CandidateError> {
    let Some(intent) = owner.dependency_sockets else {
        return Ok(Vec::new());
    };
    DependencySocketIntent::new(intent.slots)?;
    let home = candidate.state_root.join("run/smolvm/home");
    observe_paths(&home, intent.paths(&owner.short_home))
}

fn observe_paths(
    home: &Path,
    paths: Vec<DependencySocketPath>,
) -> Result<Vec<DependencySocketObservation>, CandidateError> {
    state::check_private_directory(home)?;
    paths
        .into_iter()
        .map(|path| {
            let actual = home.join(format!("dependency-{:02}.sock", path.slot));
            let (socket_identity, metadata_status) = match fs::symlink_metadata(actual) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, "missing"),
                Err(_) => (None, "unreadable"),
                Ok(m)
                    if m.file_type().is_socket()
                        && m.uid() == unsafe { libc::geteuid() }
                        && m.mode() & 0o077 == 0
                        && m.nlink() == 1 =>
                {
                    (Some((m.dev(), m.ino())), "private_socket")
                }
                Ok(_) => (None, "unsafe"),
            };
            Ok(DependencySocketObservation {
                path,
                socket_identity,
                metadata_status,
                application_ready: false,
            })
        })
        .collect()
}

/// Boot/admission audit rejects uncertain paths. Status still reports them so an
/// owned VM can be stopped without deleting or adopting the foreign socket.
pub(super) fn verify(candidate: &Candidate, owner: &state::Owner) -> Result<(), CandidateError> {
    for socket in observe(candidate, owner)? {
        if !matches!(socket.metadata_status, "missing" | "private_socket") {
            return Err(refused(
                "Dependency socket path is unsafe or unreadable; no listener was adopted.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    };
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = Path::new("/tmp").canonicalize().unwrap().join(format!(
                "hkd-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn capacity_and_existing_intent_are_explicit() {
        assert!(DependencySocketIntent::new(0).is_err());
        assert!(DependencySocketIntent::new(33).is_err());
        let intent = DependencySocketIntent::new(1).unwrap();
        let one = Some(intent);
        assert!(check_request(one, None).is_ok());
        assert!(check_request(one, one).is_ok());
        assert!(check_request(None, one).is_err());
        assert!(check_request(one, Some(DependencySocketIntent::new(2).unwrap())).is_err());
        assert!(check_capacity(Some(super::super::BridgeIntent::new(31).unwrap()), one).is_ok());
        assert!(check_capacity(Some(super::super::BridgeIntent::new(32).unwrap()), one).is_err());
        assert_eq!(
            intent.mappings(Path::new("/private/owned")),
            json!([
                {"direction":"mount","host_path":"/private/owned/dependency-00.sock","guest_path":"/run/hack-dependencies/dependency-00.sock"}
            ])
        );
    }
    #[test]
    fn socket_metadata_never_claims_listener_or_application_readiness() {
        let fixture = Fixture::new();
        let intent = DependencySocketIntent::new(1).unwrap();
        let observe = || observe_paths(&fixture.0, intent.paths(&fixture.0));
        let absent = observe().unwrap();
        assert!(absent[0].socket_identity.is_none());
        assert!(!absent[0].application_ready);
        let path = fixture.0.join("dependency-00.sock");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let bound = observe().unwrap();
        assert!(bound[0].socket_identity.is_some());
        assert!(!bound[0].application_ready);
        drop(listener);
        let closed = observe().unwrap();
        assert_eq!(closed[0].socket_identity, bound[0].socket_identity);
        assert!(!closed[0].application_ready);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(observe().unwrap()[0].metadata_status, "unsafe");
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"foreign").unwrap();
        assert_eq!(observe().unwrap()[0].metadata_status, "unsafe");
        assert_eq!(fs::read(&path).unwrap(), b"foreign");
        fs::remove_file(&path).unwrap();
        symlink(fixture.0.join("missing"), &path).unwrap();
        assert_eq!(observe().unwrap()[0].metadata_status, "unsafe");
        assert!(path.is_symlink());
    }
}
