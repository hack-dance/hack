//! Private state ownership and nonblocking operation serialization.
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_RECEIPT_BYTES: u64 = 1024 * 1024;

pub fn io(error: std::io::Error) -> CandidateError {
    CandidateError::new("provider_state", error.to_string())
}

fn missing_alias() -> CandidateError {
    CandidateError::new(
        "provider_home_missing",
        "Temporary provider HOME alias is absent. Use runtime recover to verify the stopped pool before restoring it.",
    )
}

fn replaced_alias() -> CandidateError {
    CandidateError::new("foreign_state", "Short provider HOME alias was replaced.")
}

fn alias_creation_error(error: std::io::Error, message: &'static str) -> CandidateError {
    if error.kind() == std::io::ErrorKind::TimedOut {
        CandidateError::new(
            "temp_alias_sweep_busy",
            "Timed out waiting for the temporary HOME alias sweep to release its lease.",
        )
    } else {
        CandidateError::new("socket_alias_collision", message)
    }
}

pub fn private_directory(path: &Path) -> Result<(), CandidateError> {
    reject_aliased_state(path)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(io)?;
    check_private_directory(path)
}

pub fn check_private_directory(path: &Path) -> Result<(), CandidateError> {
    reject_aliased_state(path)?;
    let metadata = fs::metadata(path).map_err(io)?;
    // SAFETY: geteuid has no preconditions.
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(CandidateError::new(
            "foreign_state",
            "Provider directory must be owned by this user and mode 0700.",
        ));
    }
    Ok(())
}

pub struct Lock(File, bool);
impl Lock {
    /// Advisory diagnostics on provider and image cache locks. Never
    /// interpreted as ownership or recovery authority; crashes may leave it stale.
    fn describe_holder(mut self, root: &Path) -> Result<Self, CandidateError> {
        if labelled_lock(root) {
            // A diagnostic must never turn an acquired stop/start lease into a
            // refusal. Partial or stale bytes are ignored by the closed reader.
            let label = operation_label();
            self.1 = self
                .0
                .set_len(0)
                .and_then(|()| {
                    self.0
                        .write_all(format!("v1 {} {label}\n", std::process::id()).as_bytes())
                })
                .is_ok();
        }
        Ok(self)
    }

    /// Verify that the retained cooperative lock still names this exact private inode.
    /// Holding an unlinked predecessor cannot serialize a replacement pathname.
    pub(crate) fn verify_path(&self, root: &Path) -> Result<(), CandidateError> {
        check_private_directory(root)?;
        let descriptor = self.0.metadata().map_err(io)?;
        let current = fs::symlink_metadata(root.join("operation.lock")).map_err(io)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        for metadata in [&descriptor, &current] {
            if !metadata.is_file()
                || metadata.nlink() != 1
                || metadata.uid() != uid
                || metadata.mode() & 0o7777 != 0o600
            {
                return Err(CandidateError::new(
                    "foreign_state",
                    "Provider mutation lock changed.",
                ));
            }
        }
        if (descriptor.dev(), descriptor.ino()) != (current.dev(), current.ino()) {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider mutation lock changed.",
            ));
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn file(&self) -> &File {
        &self.0
    }
    /// Identity of the retained descriptor, for callers fencing pathname replacement.
    pub(crate) fn identity(&self) -> Result<(u64, u64), CandidateError> {
        let metadata = self.0.metadata().map_err(io)?;
        Ok((metadata.dev(), metadata.ino()))
    }

    pub fn acquire(root: &Path) -> Result<Self, CandidateError> {
        private_directory(root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("operation.lock"))
            .map_err(io)?;
        Self::from_file(file)?.describe_holder(root)
    }

    /// Observe existing state without initializing a directory or lock file.
    pub fn acquire_existing(root: &Path) -> Result<Self, CandidateError> {
        check_private_directory(root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(labelled_lock(root))
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("operation.lock"))
            .map_err(io)?;
        Self::from_file(file)?.describe_holder(root)
    }

    /// Wait only to acquire the lock, then let callers verify state and perform
    /// effects once under the held lease.
    pub fn acquire_until(root: &Path, deadline: Instant) -> Result<Self, CandidateError> {
        wait_for_acquisition(
            deadline,
            || Ok(()),
            || Self::acquire(root),
            acquisition_expired,
        )
    }

    /// Retry acquisition without creating the lock file.
    #[cfg(target_os = "macos")]
    pub fn acquire_existing_waiting(root: &Path, wait: Duration) -> Result<Self, CandidateError> {
        wait_for_acquisition(
            Instant::now() + wait,
            || Ok(()),
            || Self::acquire_existing(root),
            acquisition_expired,
        )
    }

    /// Adopt an exclusively created private lock file before publishing its
    /// pathname. The caller must fence the final pathname against this FD.
    pub(crate) fn from_file(file: File) -> Result<Self, CandidateError> {
        let m = file.metadata().map_err(io)?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o077 != 0
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Unsafe operation lock.",
            ));
        }
        if let Err(error) = flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                CandidateError::new("provider_busy", holder_message(&file))
            } else {
                io(error)
            });
        }
        Ok(Self(file, false))
    }
}

pub(super) fn acquisition_expired() -> CandidateError {
    CandidateError::new(
        "provider_busy",
        "Provider lease acquisition deadline expired; no operation was admitted.",
    )
}

/// Retry confirmed contention with a monotonic deadline and capped backoff.
/// Each attempt opens and validates the current lock. The caller supplies only
/// acquisition; an admitted effect, or any other refusal, returns immediately.
pub(super) fn wait_for_acquisition<T>(
    deadline: Instant,
    mut before_attempt: impl FnMut() -> Result<(), CandidateError>,
    mut acquire: impl FnMut() -> Result<T, CandidateError>,
    expired: impl FnOnce() -> CandidateError,
) -> Result<T, CandidateError> {
    let mut delay = Duration::from_millis(5);
    let mut busy = None;
    loop {
        before_attempt()?;
        if Instant::now() >= deadline {
            return Err(busy.unwrap_or_else(expired));
        }
        match acquire() {
            Err(error) if error.code == "provider_busy" => {
                busy = Some(error);
                std::thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
                delay = (delay * 2).min(Duration::from_millis(50));
            }
            Ok(lock) if Instant::now() >= deadline => {
                drop(lock);
                return Err(busy.unwrap_or_else(expired));
            }
            result => return result,
        }
    }
}

/// Report a contended image lock after two seconds, then clear its progress line.
pub(super) fn wait_for_image_lock<T>(
    wait: Duration,
    subject: &str,
    acquire: impl FnMut() -> Result<T, CandidateError>,
) -> Result<T, CandidateError> {
    let started = Instant::now();
    let mut reported = false;
    let result = wait_for_acquisition(
        started + wait,
        || {
            if !reported
                && started.elapsed() >= Duration::from_secs(2)
                && matches!(
                    std::env::var("HACK_INTERNAL_REPORT_IMAGE_WAIT").as_deref(),
                    Ok("1" | "batch")
                )
            {
                eprintln!("hack.image-wait:begin {subject}");
                reported = true;
            }
            Ok(())
        },
        acquire,
        acquisition_expired,
    );
    if reported {
        eprintln!("hack.image-wait:end {subject}");
    }
    result
}

/// Apply a flock operation to a borrowed descriptor. Closing it releases the lock.
pub(crate) fn flock(file: &File, operation: libc::c_int) -> std::io::Result<()> {
    // SAFETY: file is a live owned descriptor; flock does not retain pointers.
    if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if self.1 {
            let _ = self.0.set_len(0);
        }
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn labelled_lock(root: &Path) -> bool {
    root.ends_with("run/smolvm") || root.ends_with("artifacts/images")
}

fn operation_label() -> &'static str {
    // Only closed command words enter diagnostics, never user arguments or paths.
    for argument in std::env::args_os().skip(1) {
        match argument.to_str() {
            Some("cleanup" | "down" | "stop") => return "cleanup",
            Some("recover" | "recover-live-owner" | "recover-cleanup") => return "recovery",
            Some("up" | "run" | "serve" | "start" | "restore" | "restart") => return "start",
            Some("inspect" | "status") => return "inspection",
            Some("retained-preflight") => return "retained_startup",
            Some("ensure-image") => return "image_acquisition",
            Some("project-share") => return "project_share_update",
            _ => {}
        }
    }
    "operation"
}

fn holder_message(file: &File) -> &'static str {
    let mut bytes = [0; 64];
    let kind = file.read_at(&mut bytes, 0).ok().and_then(|count| {
        let text = std::str::from_utf8(&bytes[..count]).ok()?;
        let mut fields = text.split_whitespace();
        if fields.next()? != "v1" {
            return None;
        }
        fields.next()?.parse::<u32>().ok().filter(|pid| *pid > 0)?;
        let kind = fields.next()?;
        if fields.next().is_some() {
            return None;
        }
        Some(kind)
    });
    // Closed literal messages survive the frontend's value-free diagnostic
    // boundary. The record is advisory; no process identity is inferred from it.
    match kind {
        Some("cleanup") => {
            "Provider lease acquisition refused; recorded holder: cleanup; no operation was admitted."
        }
        Some("recovery") => {
            "Provider lease acquisition refused; recorded holder: recovery; no operation was admitted."
        }
        Some("start") => {
            "Provider lease acquisition refused; recorded holder: start; no operation was admitted."
        }
        Some("inspection") => {
            "Provider lease acquisition refused; recorded holder: inspection; no operation was admitted."
        }
        Some("retained_startup") => {
            "Provider lease acquisition refused; recorded holder: retained startup check; no operation was admitted."
        }
        Some("image_acquisition") => {
            "Provider lease acquisition refused; recorded holder: image acquisition; no operation was admitted."
        }
        Some("project_share_update") => {
            "Provider lease acquisition refused; recorded holder: project share update; no operation was admitted."
        }
        Some("operation") => {
            "Provider lease acquisition refused; recorded holder: native operation; no operation was admitted."
        }
        _ => {
            "Another candidate operation holds the provider lock; holder identity is unavailable; no operation was admitted."
        }
    }
}

pub fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, CandidateError> {
    read_bounded(path, MAX_RECEIPT_BYTES)
}

pub fn read_bounded<T: serde::de::DeserializeOwned>(
    path: &Path,
    limit: u64,
) -> Result<T, CandidateError> {
    read_receipt(open_receipt(path).map_err(io)?, limit, false)
}

/// Read an immutable receipt published by rename. The opened inode remains a
/// complete snapshot if a subsequent rename removes its last directory link.
/// Only read-only observers of these receipts may accept an unlinked inode.
pub(super) fn read_committed<T: serde::de::DeserializeOwned>(
    path: &Path,
    limit: u64,
) -> Result<Option<T>, CandidateError> {
    match open_receipt(path) {
        Ok(file) => read_receipt(file, limit, true).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(error)),
    }
}

fn open_receipt(path: &Path) -> std::io::Result<File> {
    // Non-blocking open, so a FIFO (or other special file) at a receipt path is refused by
    // the regular-file check below instead of waiting for a writer. It has no effect on reads
    // of a regular file.
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

fn read_receipt<T: serde::de::DeserializeOwned>(
    mut file: File,
    limit: u64,
    allow_unlinked: bool,
) -> Result<T, CandidateError> {
    let m = file.metadata().map_err(io)?;
    if !m.is_file()
        || m.len() > limit
        || !(m.nlink() == 1 || (allow_unlinked && m.nlink() == 0))
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err(CandidateError::new(
            "foreign_state",
            "Unsafe or oversized provider receipt.",
        ));
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > limit {
        return Err(CandidateError::new(
            "foreign_state",
            "Provider receipt grew beyond its limit.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        CandidateError::new(
            "invalid_receipt",
            "Invalid provider receipt; refusing adoption.",
        )
    })
}

pub fn write(path: &Path, value: &impl Serialize) -> Result<(), CandidateError> {
    write_before_rename(path, value, &|| Ok(()))
}

/// Recheck an effect fence after syncing the pending bytes, before publication.
/// A refused fence deliberately retains the synchronized pending journal.
pub(crate) fn write_before_rename(
    path: &Path,
    value: &impl Serialize,
    before_rename: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    write_with_pending(path, &path.with_extension("pending"), value, before_rename)
}

/// Atomically publish state using a caller-owned pending sibling. Use a separate
/// name only when the caller has a distinct recovery rule for interrupted bytes.
pub(crate) fn write_with_pending(
    path: &Path,
    temporary: &Path,
    value: &impl Serialize,
    before_rename: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| CandidateError::new("invalid_receipt", e.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temporary)
        .map_err(io)?;
    file.write_all(&bytes).map_err(io)?;
    file.sync_all().map_err(io)?;
    before_rename()?;
    fs::rename(temporary, path).map_err(io)?;
    File::open(path.parent().expect("receipt parent"))
        .map_err(io)?
        .sync_all()
        .map_err(io)?;
    Ok(())
}

/// Minutes of VMM CPU idleness before SmolVM pulses the balloon to return an idle guest's
/// page cache to the host (`SMOLVM_IDLE_RECLAIM`). Passed explicitly on every provider
/// invocation, so a pin bump never changes it silently. 2 matches the provider default
/// since SmolVM 1.34.1 (upstream PR 2094, which measured idle footprint falling below
/// 2 GB within 80-100 s); the pulse re-arms only after renewed activity, so a pool that
/// stays idle is pulsed once. The provider qualification script measures idle footprint
/// at 0, 3 and 10 minutes to confirm the value on this runtime.
pub const IDLE_RECLAIM_MINUTES: u64 = 2;

/// Memory reclamation for one boot. Recorded in the receipt and re-derived at every boot.
/// `idle_minutes: None` disables the idle pulse (`SMOLVM_IDLE_RECLAIM=0`); it never means
/// "provider default".
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReclamationPolicy {
    pub enabled: bool,
    pub idle_minutes: Option<u64>,
}
impl Default for ReclamationPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_minutes: Some(IDLE_RECLAIM_MINUTES),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    #[serde(default, skip_serializing_if = "super::PoolLayout::is_legacy")]
    pub(super) socket_layout: super::PoolLayout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_share: Option<super::ProjectShareIntent>,
    /// Further project roots shared into the same development pool, in admission order.
    /// Added or removed only by the journaled stopped-pool share update; empty for
    /// single-root pools, whose receipt bytes are unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_project_shares: Vec<super::ProjectShareIntent>,
    #[serde(default)]
    pub network: super::NetworkIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_bridge: Option<super::BridgeIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_sockets: Option<super::DependencySocketIntent>,
    /// Rosetta 2 x86_64 translation for this pool's VM, so opted-in `linux/amd64` services
    /// can run. Recorded before the provider effect that enables it (`machine create
    /// --rosetta`, or `machine update --rosetta` on a stopped pool) and never cleared
    /// implicitly; every boot audits the provider record, running config and guest
    /// registration against it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub amd64_emulation: bool,
    pub version: u32,
    pub checkout: PathBuf,
    pub token: String,
    pub machine: String,
    pub short_home: PathBuf,
    pub created: bool,
    pub phase: String,
    pub process: Option<super::identity::ProcessIdentity>,
    pub storage: Option<super::identity::DiskIdentity>,
    pub overlay: Option<super::identity::DiskIdentity>,
    pub guest_boot_id: Option<String>,
    #[serde(default)]
    pub previous_guest_boot_id: Option<String>,
    pub daemon_pid: Option<u32>,
    pub daemon_start: Option<u64>,
    pub rootfs_digest: Option<String>,
    #[serde(default)]
    pub profile: super::Profile,
    #[serde(default)]
    pub reclamation: Option<ReclamationPolicy>,
    /// The boot a `down` stopped cleanly. Recorded only by `down`, in the same receipt write
    /// as its `stopped` phase, after the guest acknowledged flush and shutdown and the
    /// provider's absence was proven. Any other phase write and every new boot clear it, so
    /// a later rewrite of the phase to `stopped` never relabels an unclean stop as clean.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_stop: Option<CleanStop>,
    /// This boot's choice for the provider's host-to-guest change notifications when it is
    /// not the plain default (`hot_reload`): off, or forced on over a large share. Re-derived
    /// at every boot, and applied to every provider invocation while it stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hot_reload: Option<super::hot_reload::Choice>,
}

/// The engine identity of the boot whose `down` completed cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanStop {
    pub guest_boot_id: String,
    pub daemon_pid: u32,
    pub daemon_start: u64,
}

impl CleanStop {
    /// The marker for `owner`'s current boot, when its engine identity is complete.
    pub fn of(owner: &Owner) -> Option<Self> {
        Some(Self {
            guest_boot_id: owner.guest_boot_id.clone()?,
            daemon_pid: owner.daemon_pid?,
            daemon_start: owner.daemon_start?,
        })
    }

    /// Whether this marker names exactly this boot and engine.
    pub fn names(&self, guest_boot_id: &str, daemon_pid: u32, daemon_start: u64) -> bool {
        self.guest_boot_id == guest_boot_id
            && self.daemon_pid == daemon_pid
            && self.daemon_start == daemon_start
    }
}

/// What occupies a receipt's temporary HOME alias path, observed with `lstat` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Alias {
    /// This user's symlink to this pool's private provider home.
    Owned,
    Missing,
    /// Anything else: another user's entry, a file, a directory or another link. It is
    /// never followed, adopted, replaced or removed.
    Foreign,
}

/// The only accepted alias shape: `/private/tmp/hkl-` and 12 lowercase hex digits. Pool
/// creation derives the name from the token; a squatted name is replaced by a fresh one.
fn valid_short_home(path: &Path) -> bool {
    path.parent() == Some(Path::new("/private/tmp"))
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("hkl-"))
            .is_some_and(|suffix| {
                suffix.len() == 12
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}

/// A fresh random alias path. Creating it is still exclusive; a collision tries another.
fn fresh_short_home() -> Result<PathBuf, CandidateError> {
    let mut bytes = [0_u8; 6];
    File::open("/dev/urandom")
        .map_err(io)?
        .read_exact(&mut bytes)
        .map_err(io)?;
    let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(Path::new("/private/tmp").join(format!("hkl-{suffix}")))
}

/// Attempts at a fresh alias name before a squatted restore gives up.
const FRESH_ALIAS_ATTEMPTS: usize = 4;

impl Owner {
    pub fn load(candidate: &Candidate) -> Result<Self, CandidateError> {
        Self::load_with_short_home(candidate, false, false, read)
    }

    /// A hostname lookup compares the owner token across committed snapshots.
    /// A sibling's owner-receipt rewrite can unlink an already open snapshot.
    pub(super) fn load_for_hostname_lookup(candidate: &Candidate) -> Result<Self, CandidateError> {
        Self::load_with_short_home(candidate, false, false, |path| {
            read_committed(path, MAX_RECEIPT_BYTES)?
                .ok_or_else(|| io(std::io::ErrorKind::NotFound.into()))
        })
    }

    /// Explicit recovery may inspect a missing temporary alias, never a replaced one.
    /// Loading here is read-only; the lifecycle boundary still proves provider absence.
    pub(super) fn load_for_short_home_recovery(
        candidate: &Candidate,
    ) -> Result<Self, CandidateError> {
        Self::load_with_short_home(candidate, true, false, read)
    }

    /// Only for [`Owner::restore_released_short_home`] under the pool lock: a clean stop
    /// whose alias path another entry holds loads, so it can move to a fresh alias. The
    /// returned receipt's alias must not be used until that restore succeeds.
    pub(super) fn load_for_alias_restore(candidate: &Candidate) -> Result<Self, CandidateError> {
        Self::load_with_short_home(candidate, false, true, read)
    }

    fn load_with_short_home(
        candidate: &Candidate,
        allow_missing: bool,
        allow_squatted: bool,
        read_owner: impl FnOnce(&Path) -> Result<Self, CandidateError>,
    ) -> Result<Self, CandidateError> {
        let root = candidate.state_root.join("run/smolvm");
        reject_aliased_state(&root)?;
        let no_pending_update = matches!(
            fs::symlink_metadata(root.join("owner.pending")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        );
        if allow_missing && !no_pending_update {
            return Err(CandidateError::new(
                "recovery_required",
                "Provider owner update is pending or unobservable; HOME alias was not restored.",
            ));
        }
        let owner = read_owner(&root.join("owner.json"))?;
        owner.network.validate()?;
        super::project_share::validate_layout(
            owner.socket_layout,
            owner.project_share.as_ref(),
            &owner.additional_project_shares,
        )?;
        if owner.created
            && matches!(&owner.network, super::NetworkIntent::ApprovedHosts { cidrs, .. } if cidrs.is_empty())
        {
            return Err(CandidateError::new(
                "unaudited_provider_config",
                "Created pool is missing its pinned egress addresses.",
            ));
        }
        if owner
            .application_bridge
            .is_some_and(|bridge| super::BridgeIntent::new(bridge.slots).is_err())
            || owner
                .dependency_sockets
                .is_some_and(|intent| super::DependencySocketIntent::new(intent.slots).is_err())
            || super::dependency_socket::check_capacity(
                owner.application_bridge,
                owner.dependency_sockets,
            )
            .is_err()
            || owner.version != 1
            || owner.checkout != candidate.checkout
            || owner.token.len() != 32
            || !owner.token.bytes().all(|b| b.is_ascii_hexdigit())
            || owner.machine != format!("hack-{}", &owner.token[..12])
            || !valid_short_home(&owner.short_home)
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider owner identity does not match this checkout.",
            ));
        }
        // A clean stop's alias may be absent, after host cleanup of `/private/tmp`; the next
        // mutating operation restores it under the pool lock before using it.
        let released = owner.short_home_releasable() && no_pending_update;
        match owner.alias(candidate)? {
            Alias::Owned => {}
            Alias::Missing if allow_missing || released => {}
            Alias::Missing => return Err(missing_alias()),
            Alias::Foreign if released && allow_squatted => {}
            Alias::Foreign if released => {
                return Err(CandidateError::new(
                    "foreign_state",
                    "Temporary provider HOME alias path is held by another entry, which is never used. Run runtime up or runtime recover to restore the stopped pool under a new alias.",
                ));
            }
            Alias::Foreign => return Err(replaced_alias()),
        }
        check_private_directory(&root.join("home"))?;
        Ok(owner)
    }

    /// Whether this receipt is a clean stop: the `stopped` phase with the clean-stop marker,
    /// which only `down` writes, after proving provider and socket absence, in one receipt
    /// write. Only such a receipt may exist without its temporary HOME alias, or move to a
    /// fresh alias. Any other phase write clears the marker, so every later phase needs
    /// the alias again.
    pub(super) fn short_home_releasable(&self) -> bool {
        self.phase == "stopped" && self.clean_stop.is_some()
    }

    /// Restore the HOME alias of a clean stop before a mutating operation uses it. Called
    /// under the pool lock. A clean `down` keeps its alias, so this acts only after host
    /// cleanup removed it, or when another entry took its path:
    ///
    /// - the exact owned alias is kept as it is;
    /// - an absent alias is created exclusively after the durable receipt is rechecked;
    /// - an alias path held by anything else (another user's entry, a file, a directory,
    ///   another link) is never followed, replaced or removed. The receipt records a fresh
    ///   random alias first, and then that alias is created exclusively.
    ///
    /// A pool with dependency sockets refuses a fresh alias: its provider record pins
    /// those socket paths under the original alias.
    pub(super) fn restore_released_short_home(
        &mut self,
        candidate: &Candidate,
    ) -> Result<(), CandidateError> {
        let alias = self.alias(candidate)?;
        if alias == Alias::Owned {
            return Ok(());
        }
        if !self.short_home_releasable() || Self::load_for_alias_restore(candidate)? != *self {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider owner changed before HOME alias restoration; no alias was restored.",
            ));
        }
        if alias == Alias::Missing {
            match super::temp_aliases::create_link(&self.home(candidate), &self.short_home) {
                Ok(()) => return self.check_short_home(candidate, false),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Another entry took the path between the check and the creation.
                    if self.alias(candidate)? == Alias::Owned {
                        return Ok(());
                    }
                }
                Err(error) => {
                    return Err(alias_creation_error(
                        error,
                        "Cannot exclusively restore provider HOME alias; no existing path was replaced.",
                    ));
                }
            }
        }
        self.move_to_fresh_short_home(candidate)
    }

    /// Record a fresh alias, then create it exclusively. A crash in between leaves a clean
    /// stop whose recorded alias is absent, which the next restore creates.
    fn move_to_fresh_short_home(&mut self, candidate: &Candidate) -> Result<(), CandidateError> {
        if self.dependency_sockets.is_some() {
            return Err(CandidateError::new(
                "socket_alias_collision",
                "Provider HOME alias path is held by another entry, and this pool's provider record pins its dependency socket paths there. Nothing was followed or replaced; remove that entry, then retry.",
            ));
        }
        for _ in 0..FRESH_ALIAS_ATTEMPTS {
            let mut next = self.clone();
            next.short_home = fresh_short_home()?;
            if next.short_home == self.short_home {
                continue;
            }
            next.save(candidate)?;
            *self = next;
            match super::temp_aliases::create_link(&self.home(candidate), &self.short_home) {
                Ok(()) => return self.check_short_home(candidate, false),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(alias_creation_error(
                        error,
                        "Cannot exclusively create a fresh provider HOME alias; receipt retained.",
                    ));
                }
            }
        }
        Err(CandidateError::new(
            "socket_alias_collision",
            "Cannot exclusively create a fresh provider HOME alias; no existing path was replaced.",
        ))
    }

    fn home(&self, candidate: &Candidate) -> PathBuf {
        candidate.state_root.join("run/smolvm/home")
    }

    /// Classify the alias path with `lstat`. A link is read, never followed.
    fn alias(&self, candidate: &Candidate) -> Result<Alias, CandidateError> {
        let alias = match fs::symlink_metadata(&self.short_home) {
            Ok(alias) => alias,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Alias::Missing);
            }
            Err(error) => return Err(io(error)),
        };
        // SAFETY: geteuid has no preconditions.
        if !alias.file_type().is_symlink() || alias.uid() != unsafe { libc::geteuid() } {
            return Ok(Alias::Foreign);
        }
        match fs::read_link(&self.short_home) {
            Ok(target) if target == self.home(candidate) => Ok(Alias::Owned),
            Ok(_) => Ok(Alias::Foreign),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Alias::Missing),
            Err(error) => Err(io(error)),
        }
    }

    /// The only permitted alias is the exact receipt-bound HOME for Unix sockets.
    fn check_short_home(
        &self,
        candidate: &Candidate,
        allow_missing: bool,
    ) -> Result<(), CandidateError> {
        match self.alias(candidate)? {
            Alias::Owned => Ok(()),
            Alias::Missing if allow_missing => Ok(()),
            Alias::Missing => Err(missing_alias()),
            Alias::Foreign => Err(replaced_alias()),
        }
    }

    /// Called only while the lifecycle owns the pool and VM locks and has audited absence.
    /// Recheck the durable selection, then create exclusively; a concurrent alias is retained.
    pub(super) fn restore_missing_short_home(
        &self,
        candidate: &Candidate,
    ) -> Result<(), CandidateError> {
        let observed = Self::load_for_short_home_recovery(candidate)?;
        if observed != *self {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider owner changed during HOME recovery; no alias was restored.",
            ));
        }
        super::temp_aliases::create_link(&self.home(candidate), &self.short_home).map_err(|error| alias_creation_error(
            error,
            "Cannot exclusively restore provider HOME alias; no existing path was replaced.",
        ))?;
        self.check_short_home(candidate, false)
    }

    #[cfg(all(test, target_os = "macos"))]
    pub fn create(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
    ) -> Result<Self, CandidateError> {
        Self::create_with_dependencies(candidate, profile, application_bridge, network, None)
    }
    #[cfg(all(test, target_os = "macos"))]
    pub fn create_with_dependencies(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
        dependency_sockets: Option<super::DependencySocketIntent>,
    ) -> Result<Self, CandidateError> {
        Self::create_with_project_share(
            candidate,
            profile,
            application_bridge,
            network,
            dependency_sockets,
            None,
        )
    }
    pub fn create_with_project_share(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
        dependency_sockets: Option<super::DependencySocketIntent>,
        project_share: Option<super::ProjectShareIntent>,
    ) -> Result<Self, CandidateError> {
        super::dependency_socket::check_capacity(application_bridge, dependency_sockets)?;
        let root = candidate.state_root.join("run/smolvm");
        let owner_path = root.join("owner.json");
        if owner_path.try_exists().map_err(io)? {
            // Reuse never live-checks the recorded primary root: callers compare the loaded
            // share set with the one they read, the requested share is checked live by
            // `check_request`, and boot checks every share live. A moved or deleted primary
            // root must not block another project's share on a running pool.
            return Self::load(candidate);
        }
        if let Some(share) = &project_share {
            share.validate()?;
        }
        for name in ["home", "tmp", "docker-config"] {
            private_directory(&root.join(name))?;
        }
        if fs::read_dir(root.join("home"))
            .map_err(io)?
            .next()
            .is_some()
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Unclaimed provider home is not empty.",
            ));
        }
        let mut bytes = [0_u8; 16];
        File::open("/dev/urandom")
            .map_err(io)?
            .read_exact(&mut bytes)
            .map_err(io)?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let socket_layout = super::PoolLayout::CompactV1;
        let owner = Self {
            socket_layout,
            project_share: project_share
                .map(|share| share.with_layout(socket_layout))
                .transpose()?,
            additional_project_shares: Vec::new(),
            network,
            profile,
            application_bridge,
            dependency_sockets,
            amd64_emulation: false,
            version: 1,
            checkout: candidate.checkout.clone(),
            machine: format!("hack-{}", &token[..12]),
            short_home: Path::new("/private/tmp").join(format!("hkl-{}", &token[..12])),
            token,
            created: false,
            phase: "initializing".into(),
            process: None,
            storage: None,
            overlay: None,
            guest_boot_id: None,
            previous_guest_boot_id: None,
            reclamation: None,
            clean_stop: None,
            hot_reload: None,
            daemon_pid: None,
            daemon_start: None,
            rootfs_digest: None,
        };
        // Persist the intended alias before its first external effect. Collisions are never adopted.
        owner.save(candidate)?;
        super::temp_aliases::create_link(&root.join("home"), &owner.short_home).map_err(|error| alias_creation_error(
            error,
            "Cannot exclusively create short provider alias; receipt retained for inspection.",
        ))?;
        if owner
            .data_dir()
            .join("agent.sock")
            .as_os_str()
            .as_encoded_bytes()
            .len()
            >= 104
        {
            return Err(CandidateError::new(
                "socket_path_too_long",
                "Provider socket exceeds macOS path budget.",
            ));
        }
        Ok(owner)
    }
    /// The pool's whole share set: the primary share first, then additional roots.
    pub fn project_shares(&self) -> Vec<&super::ProjectShareIntent> {
        self.project_share
            .iter()
            .chain(&self.additional_project_shares)
            .collect()
    }
    /// The exact share approved for one project root, if this pool shares it.
    pub fn project_share_for(&self, project: &Path) -> Option<&super::ProjectShareIntent> {
        self.project_shares()
            .into_iter()
            .find(|share| share.project == project)
    }
    pub fn real_data_dir(&self, candidate: &Candidate) -> Result<PathBuf, CandidateError> {
        let relative = self
            .data_dir()
            .strip_prefix(&self.short_home)
            .expect("provider descendant")
            .to_owned();
        let path = candidate.state_root.join("run/smolvm/home").join(relative);
        reject_aliased_state(&path)?;
        Ok(path)
    }
    pub fn save(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        write(&candidate.state_root.join("run/smolvm/owner.json"), self)
    }
    pub fn begin_boot(&mut self) -> Option<String> {
        // A new boot supersedes any clean stop of the previous one.
        self.clean_stop = None;
        self.previous_guest_boot_id = self
            .guest_boot_id
            .take()
            .or(self.previous_guest_boot_id.take());
        self.daemon_pid = None;
        self.daemon_start = None;
        self.previous_guest_boot_id.clone()
    }
    pub fn data_dir(&self) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", crate::Hex(Sha256::digest(self.machine.as_bytes())));
        self.short_home
            .join("Library/Caches/smolvm/vms")
            .join(&hash[..16])
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn omitted_pool_layout_round_trips_as_absent() {
        let owner: Owner = serde_json::from_value(serde_json::json!({
            "version": 1, "checkout": "/fixture", "token": "a".repeat(32),
            "machine": "fixture", "short_home": "/fixture", "created": false,
            "phase": "initializing", "process": null, "storage": null, "overlay": null,
            "guest_boot_id": null, "daemon_pid": null, "daemon_start": null,
            "rootfs_digest": null, "profile": "development", "network": "isolated",
        }))
        .unwrap();
        assert_eq!(owner.socket_layout, super::super::PoolLayout::Legacy);
        let saved = serde_json::to_value(&owner).unwrap();
        assert!(saved.get("socket_layout").is_none());
        let reloaded: Owner = serde_json::from_value(saved).unwrap();
        assert_eq!(reloaded.socket_layout, owner.socket_layout);
        let mut compact = reloaded;
        compact.socket_layout = super::super::PoolLayout::CompactV1;
        assert_eq!(
            serde_json::to_value(compact).unwrap()["socket_layout"],
            "compact-v1"
        );
    }

    #[test]
    fn a_start_waiter_reacquires_after_release_or_gives_up_with_the_holder() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let fixture = fixture();
        let root = fixture.join("run/smolvm");
        let first = super::Lock::acquire(&root).unwrap();
        let mut attempts = 0;
        let refused = super::wait_for_acquisition(
            Instant::now() + Duration::from_millis(50),
            || {
                attempts += 1;
                assert!(attempts < 12, "acquisition continued beyond its deadline");
                Ok(())
            },
            || super::Lock::acquire(&root),
            super::acquisition_expired,
        );
        assert!(
            matches!(refused, Err(error) if error.code == "provider_busy" && error.message.contains("recorded holder:"))
        );
        let (observed, busy) = mpsc::sync_channel(1);
        std::thread::scope(|scope| {
            let second = scope.spawn(|| {
                super::wait_for_acquisition(
                    Instant::now() + Duration::from_secs(2),
                    || Ok(()),
                    || {
                        let result = super::Lock::acquire(&root);
                        if matches!(&result, Err(error) if error.code == "provider_busy") {
                            let _ = observed.try_send(());
                        }
                        result
                    },
                    super::acquisition_expired,
                )
            });
            busy.recv_timeout(Duration::from_secs(1)).unwrap();
            drop(first);
            drop(second.join().unwrap().unwrap());
        });
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn a_start_waiter_cancels_after_confirmed_contention() {
        use std::cell::Cell;
        use std::time::{Duration, Instant};
        let fixture = fixture();
        let root = fixture.join("run/smolvm");
        let holder = super::Lock::acquire(&root).unwrap();
        let contended = Cell::new(false);
        let refused = super::wait_for_acquisition(
            Instant::now() + Duration::from_secs(2),
            || {
                if contended.get() {
                    return Err(crate::CandidateError::new(
                        "provider_acquisition_cancelled",
                        "cancelled",
                    ));
                }
                Ok(())
            },
            || {
                let result = super::Lock::acquire(&root);
                assert!(matches!(&result, Err(error) if error.code == "provider_busy"));
                contended.set(true);
                result
            },
            super::acquisition_expired,
        );
        assert!(contended.get());
        assert!(matches!(refused, Err(error) if error.code == "provider_acquisition_cancelled"));
        drop(holder);
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn acquisition_after_the_deadline_releases_the_lock() {
        use std::time::{Duration, Instant};
        let fixture = fixture();
        let root = fixture.join("run/smolvm");
        let deadline = Instant::now() + Duration::from_millis(50);
        let mut acquired = false;
        let refused = super::wait_for_acquisition(
            deadline,
            || Ok(()),
            || {
                std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
                let lease = super::Lock::acquire(&root)?;
                acquired = true;
                Ok(lease)
            },
            super::acquisition_expired,
        );
        assert!(acquired);
        assert!(matches!(refused, Err(error) if error.code == "provider_busy"));
        drop(super::Lock::acquire(&root).unwrap());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn advisory_write_failure_does_not_refuse_the_acquired_provider_lease() {
        let fixture = fixture();
        let root = fixture.join("run/smolvm");
        super::private_directory(&root).unwrap();
        let path = root.join("operation.lock");
        std::fs::write(&path, b"diagnostic-canary").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        // An actual read-only descriptor injects EBADF in the advisory write,
        // while flock itself can still acquire exclusive ownership.
        let lock = super::Lock::from_file(std::fs::File::open(&path).unwrap())
            .unwrap()
            .describe_holder(&root)
            .unwrap();
        assert!(matches!(super::Lock::acquire(&root), Err(error) if error.code == "provider_busy"));
        drop(lock);
        assert_eq!(std::fs::read(&path).unwrap(), b"diagnostic-canary");
        drop(super::Lock::acquire(&root).unwrap());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A FIFO at the operation lock or at a receipt is refused at once: both opens are
    /// non-blocking, so neither waits for a writer. Each runs on a thread with a bound.
    #[test]
    fn a_fifo_at_the_lock_or_a_receipt_is_refused_without_blocking() {
        let directory = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-state-fifo",
        );
        private_directory(&directory).unwrap();
        for name in ["operation.lock", "receipt.json"] {
            let path = std::ffi::CString::new(directory.join(name).as_os_str().as_encoded_bytes())
                .unwrap();
            // SAFETY: a NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let root = directory.clone();
        std::thread::spawn(move || {
            let lock = Lock::acquire_existing(&root).map(|_| ()).unwrap_err().code;
            let receipt = read::<serde_json::Value>(&root.join("receipt.json"))
                .unwrap_err()
                .code;
            let _ = sender.send((lock, receipt));
        });
        let (lock, receipt) = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("a FIFO must not block the open");
        assert_eq!((lock, receipt), ("foreign_state", "foreign_state"));
        let _ = fs::remove_dir_all(&directory);
    }
    #[test]
    fn interrupted_restart_retains_previous_boot_without_reusing_daemon_identity() {
        let mut owner: Owner = serde_json::from_value(serde_json::json!({
            "version":1, "checkout":"/fixture", "token":"fixture", "machine":"fixture",
            "short_home":"/fixture", "created":true, "phase":"stopped", "process":null,
            "storage":null, "overlay":null, "guest_boot_id":"previous-boot",
            "daemon_pid":42, "daemon_start":99, "rootfs_digest":null
        }))
        .unwrap();
        assert!(owner.reclamation.is_none());
        assert!(owner.dependency_sockets.is_none());
        assert!(
            serde_json::to_value(&owner)
                .unwrap()
                .get("dependency_sockets")
                .is_none()
        );
        owner.reclamation = Some(ReclamationPolicy::default());
        assert_eq!(owner.begin_boot().as_deref(), Some("previous-boot"));
        assert!(owner.guest_boot_id.is_none());
        assert!(owner.daemon_pid.is_none());
        assert!(owner.daemon_start.is_none());
        let mut restored: Owner =
            serde_json::from_slice(&serde_json::to_vec(&owner).unwrap()).unwrap();
        assert_eq!(restored.reclamation, Some(ReclamationPolicy::default()));
        assert_eq!(restored.begin_boot().as_deref(), Some("previous-boot"));
        // A later successful boot becomes the predecessor on the next restart.
        restored.guest_boot_id = Some("next-boot".into());
        assert_eq!(restored.begin_boot().as_deref(), Some("next-boot"));
    }
    fn fixture() -> PathBuf {
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-provider-test-{name}"));
        private_directory(&path).unwrap();
        path
    }
    #[test]
    fn concurrent_operations_are_rejected_and_dropping_the_holder_releases_lock() {
        let root = fixture();
        let first = Lock::acquire(&root).unwrap();
        assert!(matches!(Lock::acquire(&root),Err(e) if e.code == "provider_busy"));
        drop(first);
        assert!(Lock::acquire(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn waiting_existing_acquisition_outlasts_a_brief_holder_and_refuses_a_lasting_one() {
        let root = fixture();
        drop(Lock::acquire(&root).unwrap());
        // A brief holder, such as the inspection behind `hack ps`, is waited out.
        let held = Lock::acquire_existing(&root).unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(held);
        });
        let started = std::time::Instant::now();
        let lock =
            Lock::acquire_existing_waiting(&root, std::time::Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(100));
        // Still exclusive while held.
        assert!(matches!(Lock::acquire_existing(&root), Err(e) if e.code == "provider_busy"));
        drop(lock);
        // A holder that outlasts the wait is refused as before.
        let _held = Lock::acquire_existing(&root).unwrap();
        assert!(matches!(
            Lock::acquire_existing_waiting(&root, std::time::Duration::from_millis(100)),
            Err(e) if e.code == "provider_busy"
        ));
        drop(_held);
        // Waiting never creates an absent lock.
        fs::remove_file(root.join("operation.lock")).unwrap();
        assert!(
            Lock::acquire_existing_waiting(&root, std::time::Duration::from_millis(100)).is_err()
        );
        assert!(!root.join("operation.lock").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_and_hardlink_receipts_are_not_read() {
        let root = fixture();
        let foreign = root.join("foreign.json");
        write(&foreign, &serde_json::json!({"owner":"foreign"})).unwrap();
        let link = root.join("owner.json");
        std::os::unix::fs::symlink(&foreign, &link).unwrap();
        assert!(read::<serde_json::Value>(&link).is_err());
        assert!(read_committed::<serde_json::Value>(&link, 1024).is_err());
        fs::remove_file(&link).unwrap();
        fs::hard_link(&foreign, &link).unwrap();
        assert!(matches!(read::<serde_json::Value>(&link),Err(e) if e.code == "foreign_state"));
        assert!(read_committed::<serde_json::Value>(&link, 1024).is_err());
        assert_eq!(
            fs::read_to_string(&foreign).unwrap(),
            "{\n  \"owner\": \"foreign\"\n}"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn committed_receipt_keeps_the_open_snapshot_across_atomic_replacement() {
        let root = fixture();
        let path = root.join("receipt.json");
        let before = serde_json::json!({"revision": 1});
        let after = serde_json::json!({"revision": 2});
        assert_eq!(
            read_committed::<serde_json::Value>(&path, 1024).unwrap(),
            None
        );
        write(&path, &before).unwrap();
        let opened = open_receipt(&path).unwrap();
        write(&path, &after).unwrap();
        assert_eq!(opened.metadata().unwrap().nlink(), 0);
        let legacy = read_receipt::<serde_json::Value>(opened.try_clone().unwrap(), 1024, false);
        assert_eq!(legacy.unwrap_err().code, "foreign_state");
        assert_eq!(
            read_receipt::<serde_json::Value>(opened, 1024, true).unwrap(),
            before
        );
        assert_eq!(read_committed(&path, 1024).unwrap(), Some(after));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_receipt_is_preserved_and_prevents_another_write() {
        let root = fixture();
        let path = root.join("owner.json");
        write(&path, &serde_json::json!({"phase":"running"})).unwrap();
        fs::write(path.with_extension("pending"), b"partial").unwrap();
        assert!(write(&path, &serde_json::json!({"phase":"stopped"})).is_err());
        assert_eq!(
            read::<serde_json::Value>(&path).unwrap()["phase"],
            "running"
        );
        assert_eq!(
            fs::read(path.with_extension("pending")).unwrap(),
            b"partial"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permissive_provider_directory_is_rejected_without_chmod() {
        let root = fixture();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            check_private_directory(&root).unwrap_err().code,
            "foreign_state"
        );
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o755);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn profile_changes_refuse_before_admission_and_legacy_owners_remain_research() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        let receipt = directory.join("owner.json");
        let mut legacy: serde_json::Value = read(&receipt).unwrap();
        legacy.as_object_mut().unwrap().remove("profile");
        write(&receipt, &legacy).unwrap();
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().profile,
            super::super::Profile::Research
        );
        assert_eq!(
            super::super::up_with_profile(&candidate, super::super::Profile::Development)
                .unwrap_err()
                .code,
            "profile_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn network_intent_is_durable_and_legacy_conflicts_do_not_write_state() {
        use super::super::{NetworkIntent, Profile};
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let owner = Owner::create(
            &candidate,
            Profile::Research,
            None,
            NetworkIntent::HostGateway,
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().network,
            NetworkIntent::HostGateway
        );
        let receipt = directory.join("owner.json");
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            super::super::up_with_capabilities(
                &candidate,
                Profile::Research,
                None,
                Some(NetworkIntent::Isolated)
            )
            .unwrap_err()
            .code,
            "network_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        let mut legacy: serde_json::Value = read(&receipt).unwrap();
        legacy.as_object_mut().unwrap().remove("network");
        write(&receipt, &legacy).unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().network,
            NetworkIntent::Isolated
        );
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            super::super::up_with_capabilities(
                &candidate,
                Profile::Research,
                None,
                Some(NetworkIntent::HostGateway)
            )
            .unwrap_err()
            .code,
            "network_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bridge_intent_is_durable_and_conflicts_do_not_write_state() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let intent = super::super::BridgeIntent::new(2).unwrap();
        let mut owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            Some(intent),
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().application_bridge,
            Some(intent)
        );
        let before = fs::read(directory.join("owner.json")).unwrap();
        assert_eq!(
            super::super::up_with_bridge(
                &candidate,
                super::super::Profile::Research,
                Some(super::super::BridgeIntent::new(1).unwrap())
            )
            .unwrap_err()
            .code,
            "bridge_conflict"
        );
        assert_eq!(fs::read(directory.join("owner.json")).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        owner.application_bridge = Some(super::super::BridgeIntent { slots: 0 });
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dependency_intent_conflicts_refuse_before_admission_and_preserve_state() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let intent = super::super::DependencySocketIntent::new(2).unwrap();
        let mut owner = Owner::create_with_dependencies(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
            Some(intent),
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().dependency_sockets,
            Some(intent)
        );
        let before = fs::read(directory.join("owner.json")).unwrap();
        assert_eq!(
            super::super::up_with_sockets(
                &candidate,
                super::super::Profile::Research,
                None,
                Some(super::super::DependencySocketIntent::new(1).unwrap())
            )
            .unwrap_err()
            .code,
            "dependency_socket_conflict"
        );
        assert_eq!(
            super::super::up_with_sockets(
                &candidate,
                super::super::Profile::Research,
                Some(super::super::BridgeIntent::new(32).unwrap()),
                Some(intent)
            )
            .unwrap_err()
            .code,
            "dependency_socket"
        );
        assert_eq!(fs::read(directory.join("owner.json")).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        owner.dependency_sockets = Some(super::super::DependencySocketIntent { slots: 0 });
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaced_short_alias_cannot_be_adopted() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let _lock = Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        let owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        assert!(Owner::load(&candidate).is_ok());
        fs::remove_file(&owner.short_home).unwrap();
        let foreign = root.join("foreign");
        private_directory(&foreign).unwrap();
        std::os::unix::fs::symlink(&foreign, &owner.short_home).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
        fs::remove_file(&owner.short_home).unwrap();
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn foreign_checkout_cannot_adopt_an_owner_record() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let _lock = Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        let mut owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        owner.checkout = root.join("other");
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }
}
