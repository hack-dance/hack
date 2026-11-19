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
    if socket_states(directory, intent)?.ready() {
        Ok(())
    } else {
        Err(socket_identity())
    }
}

fn socket_identity() -> CandidateError {
    CandidateError::new(
        "bridge_socket_identity",
        "Expected a private owned bridge socket.",
    )
}

fn socket_directory() -> CandidateError {
    CandidateError::new(
        "bridge_socket_directory",
        "The provider socket directory must be an owned directory with no group or other access.",
    )
}

/// The provider's per-VM socket directory, opened without following a final symlink and
/// checked through that descriptor: a directory, ours, with no group or other access.
/// Only this user can then add, replace or rename an entry in it, which is what makes a
/// socket's own mode bits safe to repair below.
fn private_directory(directory: &std::path::Path) -> Result<std::fs::File, CandidateError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory)
        .map_err(|_| socket_directory())?;
    let metadata = file.metadata().map_err(|_| socket_directory())?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(socket_directory());
    }
    Ok(file)
}

/// One entry of the verified directory, never following a symlink. `None` when absent.
fn entry(
    directory: &std::fs::File,
    name: &std::ffi::CStr,
) -> Result<Option<libc::stat>, CandidateError> {
    use std::os::fd::AsRawFd;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: a live directory descriptor, a NUL-terminated name and a correctly sized buffer.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        // SAFETY: fstatat succeeded, so the buffer is initialized.
        return Ok(Some(unsafe { stat.assume_init() }));
    }
    match std::io::Error::last_os_error().kind() {
        std::io::ErrorKind::NotFound => Ok(None),
        _ => Err(socket_identity()),
    }
}

/// Whether one socket of the verified directory is ours and private, repairing its mode when
/// only its group or other bits are wrong (HACK-2375).
///
/// The pinned provider binds every exposed socket with the VM process's umask at that
/// moment. Hack starts it with umask 077, but the provider's file-sharing device clears the
/// umask for the whole process early in each boot, so on a busy host the sockets bound after
/// that are 0777 for the life of the VM; no wait makes them private. Identity still refuses:
/// a non-socket, another owner or an extra link is never repaired. Within an owned 0700
/// directory only this user can have created the entry, so dropping its group and other bits
/// (keeping the owner's) and reading it back as the same inode, still a private socket of
/// ours, changes nothing but the mode. `Ok(false)` only when the mode cannot be set.
// `st_mode` is u16 on macOS and u32 on Linux, so the conversions are needed on the target.
#[allow(clippy::useless_conversion)]
fn private_socket(
    directory: &std::fs::File,
    name: &std::ffi::CStr,
    stat: libc::stat,
) -> Result<bool, CandidateError> {
    use std::os::fd::AsRawFd;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let identity = |stat: &libc::stat| {
        stat.st_mode & libc::S_IFMT == libc::S_IFSOCK && stat.st_uid == uid && stat.st_nlink == 1
    };
    if !identity(&stat) {
        return Err(socket_identity());
    }
    let mode = u32::from(stat.st_mode) & 0o7777;
    if mode & 0o077 == 0 {
        return Ok(true);
    }
    // Darwin honors AT_SYMLINK_NOFOLLOW here; elsewhere (tests) the entry was just read as
    // a socket in a directory only this user can change.
    #[cfg(target_os = "macos")]
    let flags = libc::AT_SYMLINK_NOFOLLOW;
    #[cfg(not(target_os = "macos"))]
    let flags = 0;
    // SAFETY: a live directory descriptor and a NUL-terminated name.
    let changed = unsafe {
        libc::fchmodat(
            directory.as_raw_fd(),
            name.as_ptr(),
            (mode & 0o700) as libc::mode_t,
            flags,
        )
    } == 0;
    if !changed {
        return Ok(false);
    }
    match entry(directory, name)? {
        Some(after)
            if identity(&after)
                && after.st_dev == stat.st_dev
                && after.st_ino == stat.st_ino
                && u32::from(after.st_mode) & 0o077 == 0 =>
        {
            Ok(true)
        }
        _ => Err(socket_identity()),
    }
}

/// How many of the pool's sockets are still pending in each way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SocketStates {
    missing: u8,
    not_private: u8,
}
impl SocketStates {
    fn ready(self) -> bool {
        self.missing == 0 && self.not_private == 0
    }
}

/// Missing nodes may converge during boot; an owned socket with group or other bits is
/// repaired (see [`private_socket`]). A different type, owner, link count, unreadable
/// identity or a socket directory that is not private and owned is never pending.
fn socket_states(
    directory: &std::path::Path,
    intent: BridgeIntent,
) -> Result<SocketStates, CandidateError> {
    let directory = private_directory(directory)?;
    let mut states = SocketStates::default();
    for path in intent.guest_paths() {
        let name = std::path::Path::new(&path)
            .file_name()
            .expect("fixed socket name");
        let name = std::ffi::CString::new(name.as_encoded_bytes()).expect("fixed socket name");
        let Some(stat) = entry(&directory, &name)? else {
            states.missing += 1;
            continue;
        };
        if !private_socket(&directory, &name, stat)? {
            states.not_private += 1;
        }
    }
    Ok(states)
}

/// The provider's own sockets in the same directory: the guest agent and the exposed engine
/// socket. Bound by the same provider process, they have the same umask exposure; nothing
/// waited for them before. Each one present gets the same identity check and mode repair;
/// an absent one is left for the code that connects to it.
pub(super) const PROVIDER_SOCKETS: [&str; 2] = ["agent.sock", "docker.sock"];

pub(super) fn secure_provider_sockets(directory: &std::path::Path) -> Result<(), CandidateError> {
    let directory = private_directory(directory)?;
    for name in PROVIDER_SOCKETS {
        let name = std::ffi::CString::new(name).expect("fixed socket name");
        if let Some(stat) = entry(&directory, &name)? {
            if !private_socket(&directory, &name, stat)? {
                return Err(socket_identity());
            }
        }
    }
    Ok(())
}

/// Fresh-boot wait for the whole socket set: a fixed base plus one second per slot.
/// Each slot is bound by its own SmolVM expose thread after guest-ready, so a larger
/// pool needs longer on a slow first boot (HACK-2341: 10 slots missed a flat 10 s).
const BOOT_SOCKET_BASE: std::time::Duration = std::time::Duration::from_secs(10);
const BOOT_SOCKET_PER_SLOT: std::time::Duration = std::time::Duration::from_secs(1);
const BOOT_SOCKET_POLL: std::time::Duration = std::time::Duration::from_millis(50);

fn boot_socket_budget(intent: BridgeIntent) -> std::time::Duration {
    BOOT_SOCKET_BASE + BOOT_SOCKET_PER_SLOT * u32::from(intent.slots)
}

fn startup_socket_timeout(
    intent: BridgeIntent,
    last: Option<SocketStates>,
    budget: std::time::Duration,
) -> CandidateError {
    let failure = CandidateError::new(
        "bridge_socket_timeout",
        "Native bridge sockets did not become private and owned before the startup deadline. Run the same selected executor with the identical --candidate-root argument used for the failed start, followed by runtime recover --json before retrying.",
    );
    match last {
        Some(states) if !states.ready() => failure.with_bridge_sockets(
            intent.slots,
            states.missing,
            states.not_private,
            u16::try_from(budget.as_secs()).unwrap_or(u16::MAX),
        ),
        _ => failure,
    }
}

/// Only fresh boot waits: SmolVM's guest-ready signal does not join its expose
/// threads. Caller holds the pool lease and rechecks its retained provider on
/// both sides of each complete socket observation. The only change made is a
/// verified socket's group and other mode bits (see [`private_socket`]).
/// Socket freshness also relies on the pinned launcher's removal of old expose
/// paths before guest-ready; see the upgrade contract at `artifact::VERSION`.
pub(super) fn wait_for_sockets(
    directory: &std::path::Path,
    intent: BridgeIntent,
    verify_provider: impl FnMut() -> Result<(), CandidateError>,
    clock: &impl super::process::Clock,
) -> Result<(), CandidateError> {
    wait_for_sockets_with(
        directory,
        intent,
        verify_provider,
        clock,
        boot_socket_budget(intent),
    )
}

fn wait_for_sockets_with(
    directory: &std::path::Path,
    intent: BridgeIntent,
    mut verify_provider: impl FnMut() -> Result<(), CandidateError>,
    clock: &impl super::process::Clock,
    budget: std::time::Duration,
) -> Result<(), CandidateError> {
    let deadline = clock.now().saturating_add(budget);
    let mut last = None;
    loop {
        if clock.now() >= deadline {
            return Err(startup_socket_timeout(intent, last, budget));
        }
        verify_provider().map_err(startup_provider_failure)?;
        let states = socket_states(directory, intent).map_err(|_| {
            CandidateError::new(
                "bridge_socket_identity",
                "Bridge socket identity is unsafe; startup was refused. Run the same selected executor with the identical --candidate-root argument used for the failed start, followed by runtime recover --json before retrying.",
            )
        })?;
        verify_provider().map_err(startup_provider_failure)?;
        last = Some(states);
        let remaining = deadline.saturating_sub(clock.now());
        if remaining.is_zero() {
            return Err(startup_socket_timeout(intent, last, budget));
        }
        if states.ready() {
            return Ok(());
        }
        clock.sleep(remaining.min(BOOT_SOCKET_POLL));
    }
}

/// Keep the failed identity boundary's code, but never expose its dynamic text.
/// Recovery still independently proves the recorded provider before any stop.
fn startup_provider_failure(failure: CandidateError) -> CandidateError {
    CandidateError::new(
        failure.code,
        "The retained provider could not be verified while waiting for bridge sockets; startup was refused. Run the same selected executor with the identical --candidate-root argument used for the failed start, followed by runtime recover --json before retrying.",
    )
}

#[cfg(test)]
#[path = "bridge_startup_tests.rs"]
mod startup_tests;

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
        let root = crate::unique_test_root(&std::env::temp_dir(), "hack-bridge-sockets");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("bridge-00.sock");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let intent = BridgeIntent::new(1).unwrap();
        verify_sockets(&root, intent).unwrap();
        // An owned socket's group and other bits are repaired, not refused (HACK-2375).
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        verify_sockets(&root, intent).unwrap();
        assert_eq!(
            fs::symlink_metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
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
