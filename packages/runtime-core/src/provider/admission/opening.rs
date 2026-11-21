//! A record of one earlier host sample that passed admission, so that the next Development
//! start need not wait out the admission window again.
//!
//! A Development pool start qualifies on two host samples at least
//! [`DEVELOPMENT_WINDOW`](super::DEVELOPMENT_WINDOW) apart that show one swapout count: its
//! first sample, and one under the startup lease. A start whose own checks are quicker than
//! the window sleeps the rest of it. This record lets such a start skip that sleep: a sample
//! that passed every predicate on its own, taken earlier by a start or a stop of this home,
//! stands in for "the host passed at least a window ago".
//!
//! The record holds three things and nothing else: the OS boot session, a time on a clock
//! that keeps counting while the machine sleeps, and the sample's swapout count. It is one
//! file beside the pool's owner record, written atomically under the provider lease and
//! readable and writable by this user only.
//!
//! The record replaces the wait and nothing else. The start still takes both of its own
//! samples, each must pass every predicate, and `admission.json` records both. The wait is
//! skipped only when all of these hold under the startup lease:
//!
//! - the record is from this OS boot;
//! - its age is at least the window and at most the bound ([`Reuse`], 60 seconds unless
//!   set);
//! - the sample under the lease shows the record's swapout count, and the start's own first
//!   sample's.
//!
//! Anything else is a miss, and a miss is the start without a record: it sleeps the rest
//! of the window measured from its own first sample and then takes its sample under the
//! lease, chained to that first sample. The record never refuses a start and never stands
//! in for a sample. A sample taken early for a reuse that then misses is discarded.
//!
//! What reuse gives up, stated plainly: without a record the start's two samples are at
//! least a window apart. With one, they can be milliseconds apart, and the evidence that
//! the host held for a window is a sample up to the bound old. A host that failed and
//! recovered between that sample and this start is not seen, unless it swapped out, which
//! the count catches.
//!
//! Research keeps its frozen three-sample window before the lease. It never reads this
//! record, and neither a Research start nor the stop of a Research pool writes it.
use super::{Admission, DEVELOPMENT_WINDOW, Earlier, Recorded, check};
use crate::CandidateError;
use crate::provider::{Profile, state};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The environment setting: the oldest record, in whole seconds, that may replace the wait.
pub const SETTING: &str = "HACK_NATIVE_ADMISSION_REUSE_SECONDS";

/// The bound when [`SETTING`] is unset.
const DEFAULT_BOUND: Duration = Duration::from_secs(60);

/// The largest bound [`SETTING`] may select, in seconds. Between the recorded sample and the
/// sample under the lease only the swapout count is known, so the gap stays short.
const MAX_BOUND_SECONDS: u64 = 600;

/// The record, beside the pool's owner record under the provider root.
const FILE: &str = "admission-opening.json";

/// Far above the size of any record this module writes.
const LIMIT: u64 = 1024;

/// How old a recorded sample may be and still replace the admission wait. Zero turns reuse
/// off: no record is read. Records are still written, so turning it on needs no warm-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reuse(Duration);

impl Reuse {
    /// `None` and the empty string select the default. Anything else must be decimal digits
    /// naming a whole number of seconds from 0 to [`MAX_BOUND_SECONDS`]. A mistyped value
    /// never silently selects a bound, and a value above the maximum is refused, not
    /// reduced to it.
    pub fn parse(value: Option<&str>) -> Result<Self, CandidateError> {
        let refused = || {
            CandidateError::new(
                "admission_reuse_setting",
                "HACK_NATIVE_ADMISSION_REUSE_SECONDS must be a whole number of seconds from 0 to 600; 0 turns reuse off. A larger value is refused, not reduced to 600.",
            )
        };
        match value {
            None | Some("") => Ok(Self(DEFAULT_BOUND)),
            // Six digits bound the parse; the range check below decides.
            Some(text) if text.len() <= 6 && text.bytes().all(|byte| byte.is_ascii_digit()) => {
                let seconds: u64 = text.parse().map_err(|_| refused())?;
                if seconds > MAX_BOUND_SECONDS {
                    return Err(refused());
                }
                Ok(Self(Duration::from_secs(seconds)))
            }
            Some(_) => Err(refused()),
        }
    }

    /// Reads [`SETTING`] from this process's environment.
    pub fn from_environment() -> Result<Self, CandidateError> {
        match std::env::var(SETTING) {
            Ok(value) => Self::parse(Some(&value)),
            Err(std::env::VarError::NotPresent) => Self::parse(None),
            Err(std::env::VarError::NotUnicode(_)) => Self::parse(Some("\u{fffd}")),
        }
    }
}

/// The two host facts a record is bound to. Behind a trait so tests supply them.
pub(in crate::provider) trait Host {
    /// This OS boot, as a canonical lowercase UUID, or `None` when it cannot be read.
    fn boot_session(&self) -> Option<String>;
    /// Time since a point fixed for this OS boot, on a clock that keeps counting while the
    /// machine sleeps, or `None` when it cannot be read.
    fn now(&self) -> Option<Duration>;
}

/// The running host: `kern.bootsessionuuid` and `CLOCK_MONOTONIC` on macOS, the kernel's
/// `boot_id` and `CLOCK_BOOTTIME` on Linux. Both are read in this process. The boot session
/// follows the other readers of that sysctl in this crate (one fixed 37-byte read); the
/// clock has no command to ask.
pub(in crate::provider) struct System;

impl Host for System {
    fn boot_session(&self) -> Option<String> {
        system_boot_session().filter(|session| canonical_session(session))
    }

    fn now(&self) -> Option<Duration> {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes exactly one live timespec and retains no pointer.
        if unsafe { libc::clock_gettime(sleep_counting_clock()?, &mut time) } != 0 {
            return None;
        }
        Some(Duration::new(
            u64::try_from(time.tv_sec).ok()?,
            u32::try_from(time.tv_nsec).ok()?,
        ))
    }
}

/// macOS: `CLOCK_MONOTONIC` keeps counting while the system is asleep. `CLOCK_UPTIME_RAW`,
/// which the rest of this crate uses for intervals, does not.
#[cfg(target_os = "macos")]
fn sleep_counting_clock() -> Option<libc::clockid_t> {
    Some(libc::CLOCK_MONOTONIC)
}

/// Linux: `CLOCK_MONOTONIC` stops while suspended; `CLOCK_BOOTTIME` does not.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn sleep_counting_clock() -> Option<libc::clockid_t> {
    Some(libc::CLOCK_BOOTTIME)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn sleep_counting_clock() -> Option<libc::clockid_t> {
    None
}

#[cfg(target_os = "macos")]
fn system_boot_session() -> Option<String> {
    let mut buffer = [0_u8; 37];
    let mut length = buffer.len();
    // SAFETY: the read-only sysctl writes at most this fixed initialized buffer; its size
    // pointer is live, the new value is null, and no pointer is retained.
    if unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || length != buffer.len()
        || buffer[36] != 0
    {
        return None;
    }
    // XNU publishes uppercase UUID text with its terminating NUL.
    std::str::from_utf8(&buffer[..36])
        .ok()
        .map(str::to_ascii_lowercase)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn system_boot_session() -> Option<String> {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|text| text.trim_end().to_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn system_boot_session() -> Option<String> {
    None
}

/// A lowercase UUID that is not all zeros: the only boot session a record may carry.
fn canonical_session(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
        && bytes
            .iter()
            .any(|byte| matches!(byte, b'1'..=b'9' | b'a'..=b'f'))
}

/// One sample that passed every Development predicate on its own. These three fields are
/// the whole record: a decoder that meets any other field refuses the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    /// [`Host::boot_session`] when the sample was taken.
    boot_session: String,
    /// [`Host::now`] when the sample was taken, in nanoseconds.
    monotonic_nanos: u64,
    /// The sample's swapout count.
    swapouts: u64,
}

/// Why a record does not replace the wait. Every one of these is the start without a
/// record; none is reported, and none refuses anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Miss {
    /// Reuse is turned off; the file is not read.
    Off,
    Absent,
    /// Not a private regular file of this user: a link, a directory, another owner, more
    /// than one name, group or world access, too large, or unreadable.
    Unsafe,
    /// Not exactly the three fields, or a boot session that is not a canonical UUID.
    Unparsable,
    BootSessionUnreadable,
    OtherBoot,
    ClockUnreadable,
    /// Younger than the window, or stamped later than now.
    TooYoung,
    /// Older than the bound.
    TooOld,
}

fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

fn effective_user() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// The record at `path` when it is a private regular file of `user` holding exactly the
/// three fields. A link is not followed, and a special file is not waited on.
fn read(path: &Path, user: u32) -> Result<Record, Miss> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(Miss::Absent),
        Err(_) => return Err(Miss::Unsafe),
    };
    let metadata = file.metadata().map_err(|_| Miss::Unsafe)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != user
        || metadata.mode() & 0o077 != 0
        || metadata.len() > LIMIT
    {
        return Err(Miss::Unsafe);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Miss::Unsafe)?;
    if bytes.len() as u64 > LIMIT {
        return Err(Miss::Unsafe);
    }
    // The derived decoder also accepts a positional array of the three values. Only an
    // object with the three named fields is a record.
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(Miss::Unparsable);
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| Miss::Unparsable)?;
    if !canonical_session(&record.boot_session) {
        return Err(Miss::Unparsable);
    }
    Ok(record)
}

/// What a Development start reads under its startup lease: this home's record, judged
/// against `host` and the bound.
pub(in crate::provider) struct Opening<'a, H> {
    root: &'a Path,
    host: &'a H,
    reuse: Reuse,
    user: u32,
}

impl<'a, H: Host> Opening<'a, H> {
    pub(in crate::provider) fn new(root: &'a Path, host: &'a H, reuse: Reuse) -> Self {
        Self {
            root,
            host,
            reuse,
            user: effective_user(),
        }
    }

    /// Whether a sample taken at `taken` is at least one window and at most the bound old
    /// at `now`. A record from after `now` (a clock that went back) is too young.
    fn age(&self, taken: Duration, now: Duration) -> Result<(), Miss> {
        let age = now.checked_sub(taken).ok_or(Miss::TooYoung)?;
        if age < DEVELOPMENT_WINDOW {
            return Err(Miss::TooYoung);
        }
        if age > self.reuse.0 {
            return Err(Miss::TooOld);
        }
        Ok(())
    }

    /// The record when it may replace the wait now.
    fn judge(&self) -> Result<Recorded, Miss> {
        let bound = self.reuse.0;
        if bound.is_zero() {
            return Err(Miss::Off);
        }
        let record = read(&path(self.root), self.user)?;
        let session = self
            .host
            .boot_session()
            .ok_or(Miss::BootSessionUnreadable)?;
        if session != record.boot_session {
            return Err(Miss::OtherBoot);
        }
        let now = self.host.now().ok_or(Miss::ClockUnreadable)?;
        let taken = Duration::from_nanos(record.monotonic_nanos);
        self.age(taken, now)?;
        Ok(Recorded {
            swapouts: record.swapouts,
            taken,
        })
    }
}

impl<H: Host> Earlier for Opening<'_, H> {
    fn usable(&self) -> Option<Recorded> {
        self.judge().ok()
    }

    fn now(&self) -> Option<Duration> {
        self.host.now()
    }

    fn in_age(&self, recorded: &Recorded, at: Duration) -> bool {
        !self.reuse.0.is_zero() && self.age(recorded.taken, at).is_ok()
    }
}

/// Remove the pending file of a record write that never reached its rename. The caller
/// holds the provider lease, so no other writer of this record exists. Only a private
/// regular file of this user with one name is removed; anything else is left, and the
/// write that follows fails.
fn discard_pending(record: &Path, user: u32) {
    let pending = record.with_extension("pending");
    let ours = fs::symlink_metadata(&pending).is_ok_and(|metadata| {
        metadata.file_type().is_file()
            && metadata.nlink() == 1
            && metadata.uid() == user
            && metadata.mode() & 0o077 == 0
    });
    if ours {
        let _ = fs::remove_file(&pending);
    }
}

/// Record `sample`, taken at `at` on `host`'s clock, as this home's earlier passing sample.
/// The caller holds the provider lease on `root`.
///
/// Only a sample that passes every Development predicate on its own is recorded, which is
/// what lets a reader trust a record without re-reading the predicates. Returns whether a
/// record was written. Nothing here fails its caller: a sample that does not pass, a time
/// or boot session that cannot be read, or a write that fails leaves the previous record,
/// or none, and the next start takes the path without one.
pub(in crate::provider) fn record(
    root: &Path,
    _lease: &state::Lock,
    host: &impl Host,
    sample: &Admission,
    at: Option<Duration>,
) -> bool {
    let Ok(swapouts) = check(Profile::Development, sample, None) else {
        return false;
    };
    let (Some(at), Some(boot_session)) = (at, host.boot_session()) else {
        return false;
    };
    let Ok(monotonic_nanos) = u64::try_from(at.as_nanos()) else {
        return false;
    };
    if !canonical_session(&boot_session) {
        return false;
    }
    let path = path(root);
    discard_pending(&path, effective_user());
    state::write(
        &path,
        &Record {
            boot_session,
            monotonic_nanos,
            swapouts,
        },
    )
    .is_ok()
}

/// `runtime down`'s writer: one sample taken at the start of the stop, under its lease,
/// recorded when it passes every Development predicate on its own.
///
/// A start that follows the stop within the bound then finds a sample at least a window
/// old. The sample is the only cost this adds to a stop. A sample that fails, cannot be
/// taken or cannot be recorded writes nothing and changes nothing about the stop. A
/// Research pool takes no sample here: Research never reuses a record.
pub(in crate::provider) fn record_at_stop(
    root: &Path,
    lease: &state::Lock,
    host: &impl Host,
    profile: Profile,
    observe: impl FnOnce() -> Result<Admission, CandidateError>,
) -> bool {
    if profile != Profile::Development {
        return false;
    }
    let Ok(sample) = observe() else {
        return false;
    };
    record(root, lease, host, &sample, host.now())
}

#[cfg(test)]
mod tests;
