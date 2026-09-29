//! Explicit pool-level socket capacity. This does not authorize a graph destination.
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeIntent {
    pub slots: u8,
}
impl BridgeIntent {
    pub fn new(slots: u8) -> Result<Self, CandidateError> {
        if !(1..=32).contains(&slots) {
            return Err(CandidateError::new(
                "bridge_capacity",
                "Bridge capacity must be between 1 and 32 sockets.",
            ));
        }
        Ok(Self { slots })
    }
    pub(super) fn guest_paths(self) -> Vec<String> {
        (0..self.slots)
            .map(|slot| format!("/run/hack-local/bridge-{slot:02}.sock"))
            .collect()
    }
    pub(super) fn mappings(intent: Option<Self>) -> Value {
        json!(
            intent
                .map(|intent| intent.guest_paths())
                .unwrap_or_default()
                .into_iter()
                .map(|path| json!({"direction":"expose", "guest_path":path}))
                .collect::<Vec<_>>()
        )
    }
}

pub(super) fn check_request(
    existing: Option<BridgeIntent>,
    requested: Option<BridgeIntent>,
) -> Result<(), CandidateError> {
    if requested.is_some() && requested != existing {
        return Err(CandidateError::new(
            "bridge_conflict",
            "Existing pool has different bridge capacity. No update or replacement was attempted.",
        ));
    }
    Ok(())
}

/// Startup requirements never resize an existing pool. Exact selection remains
/// the configuration contract; minimum selection admits existing spare capacity.
#[derive(Clone, Copy)]
pub(super) enum Request {
    Exact(Option<BridgeIntent>),
    Minimum(BridgeIntent),
}

impl From<Option<BridgeIntent>> for Request {
    fn from(intent: Option<BridgeIntent>) -> Self {
        Self::Exact(intent)
    }
}

impl Request {
    pub(super) fn initial(self) -> Option<BridgeIntent> {
        match self {
            Self::Exact(intent) => intent,
            Self::Minimum(intent) => Some(intent),
        }
    }

    pub(super) fn check(self, existing: Option<BridgeIntent>) -> Result<(), CandidateError> {
        match self {
            Self::Exact(intent) => check_request(existing, intent),
            Self::Minimum(required) => {
                if existing.is_some_and(|intent| intent.slots >= required.slots) {
                    Ok(())
                } else {
                    Err(CandidateError::new(
                        "bridge_conflict",
                        "Existing pool has insufficient bridge capacity. No resize or replacement was attempted.",
                    ))
                }
            }
        }
    }
}

pub(super) fn verify_sockets(
    directory: &std::path::Path,
    intent: BridgeIntent,
) -> Result<(), CandidateError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    for path in intent.guest_paths() {
        let path = directory.join(
            std::path::Path::new(&path)
                .file_name()
                .expect("fixed socket name"),
        );
        let metadata = std::fs::symlink_metadata(path).map_err(|_| {
            CandidateError::new(
                "bridge_socket_identity",
                "Expected a private owned bridge socket.",
            )
        })?;
        if !metadata.file_type().is_socket()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(CandidateError::new(
                "bridge_socket_identity",
                "Expected a private owned bridge socket.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimum_admission_reuses_capacity_without_changing_exact_selection() {
        let one = BridgeIntent::new(1).unwrap();
        let four = BridgeIntent::new(4).unwrap();
        let minimum = Request::Minimum(one);
        assert_eq!(minimum.initial(), Some(one));
        minimum.check(Some(one)).unwrap();
        minimum.check(Some(four)).unwrap();
        assert_eq!(minimum.check(None).unwrap_err().code, "bridge_conflict");
        assert_eq!(
            Request::Minimum(four).check(Some(one)).unwrap_err().code,
            "bridge_conflict"
        );
        assert_eq!(
            Request::Exact(Some(one))
                .check(Some(four))
                .unwrap_err()
                .code,
            "bridge_conflict"
        );
        Request::Exact(None).check(Some(four)).unwrap();
        Request::Exact(None).check(None).unwrap();
    }

    #[test]
    fn published_sockets_require_private_socket_files() {
        use std::{
            fs,
            os::unix::{
                fs::{PermissionsExt, symlink},
                net::UnixListener,
            },
        };
        let root = std::env::temp_dir().join(format!("hack-bridge-sockets-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("bridge-00.sock");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let intent = BridgeIntent::new(1).unwrap();
        verify_sockets(&root, intent).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(verify_sockets(&root, intent).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"foreign").unwrap();
        assert!(verify_sockets(&root, intent).is_err());
        fs::remove_file(&path).unwrap();
        symlink(root.join("other"), &path).unwrap();
        assert!(verify_sockets(&root, intent).is_err());
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn capacity_is_bounded_and_never_reconfigures_an_existing_pool() {
        assert!(BridgeIntent::new(0).is_err());
        assert!(BridgeIntent::new(33).is_err());
        let one = Some(BridgeIntent::new(1).unwrap());
        check_request(one, None).unwrap();
        check_request(one, one).unwrap();
        assert!(check_request(None, one).is_err());
        assert!(check_request(one, Some(BridgeIntent::new(2).unwrap())).is_err());
        assert_eq!(BridgeIntent::mappings(None), json!([]));
        let max = BridgeIntent::new(32).unwrap();
        assert_eq!(max.guest_paths().len(), 32);
        assert_eq!(max.guest_paths()[31], "/run/hack-local/bridge-31.sock");
    }
}
