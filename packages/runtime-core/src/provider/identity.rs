//! Strict native process and disk identities; no PID-only or argv-substring adoption.
use super::state::io;
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub start_micros: u64,
    pub uid: u32,
    pub executable: PathBuf,
}

#[cfg(target_os = "macos")]
pub fn observe(pid: i32) -> Result<ProcessIdentity, CandidateError> {
    if pid <= 1 {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Invalid provider PID.",
        ));
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: libproc receives a correctly sized writable proc_bsdinfo buffer.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if read as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Cannot establish native provider process identity.",
        ));
    }
    let info = unsafe { info.assume_init() };
    let start = info
        .pbi_start_tvsec
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(info.pbi_start_tvusec))
        .filter(|v| *v > 0)
        .ok_or_else(|| {
            CandidateError::new(
                "process_identity_unavailable",
                "Native process start time is unavailable.",
            )
        })?;
    let mut bytes = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buffer is writable for its full declared size.
    let count = unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if count <= 0 {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Native executable path is unavailable.",
        ));
    }
    let path =
        std::str::from_utf8(bytes.split(|b| *b == 0).next().unwrap_or_default()).map_err(|_| {
            CandidateError::new("process_identity_unavailable", "Invalid executable path.")
        })?;
    Ok(ProcessIdentity {
        pid,
        start_micros: start,
        uid: info.pbi_uid,
        executable: PathBuf::from(path),
    })
}
#[cfg(not(target_os = "macos"))]
pub fn observe(_pid: i32) -> Result<ProcessIdentity, CandidateError> {
    Err(CandidateError::new(
        "unsupported_host",
        "SmolVM process inspection requires macOS.",
    ))
}

/// Capture a retained supervisor, never an adopted or PID-only parent. Both
/// identities and the parent relationship are rechecked around observation.
#[cfg(target_os = "macos")]
pub fn parent(recorded: &ProcessIdentity) -> Result<ProcessIdentity, CandidateError> {
    fn parent_pid(child: &ProcessIdentity) -> Result<i32, CandidateError> {
        verify(child, &observe(child.pid)?, &child.executable, unsafe {
            libc::geteuid()
        })?;
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: libproc receives correctly sized writable output storage.
        let count = unsafe {
            libc::proc_pidinfo(
                child.pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        if count as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
            return Err(parent_refused());
        }
        // SAFETY: libproc filled the complete output record above.
        let info = unsafe { info.assume_init() };
        let start = info
            .pbi_start_tvsec
            .checked_mul(1_000_000)
            .and_then(|value| value.checked_add(info.pbi_start_tvusec));
        let pid = i32::try_from(info.pbi_ppid).map_err(|_| parent_refused())?;
        if pid <= 1 || info.pbi_uid != child.uid || start != Some(child.start_micros) {
            return Err(parent_refused());
        }
        verify(child, &observe(child.pid)?, &child.executable, child.uid)?;
        Ok(pid)
    }
    let pid = parent_pid(recorded)?;
    let supervisor = observe(pid)?;
    verify(
        &supervisor,
        &observe(pid)?,
        &supervisor.executable,
        recorded.uid,
    )?;
    if parent_pid(recorded)? != pid {
        return Err(parent_refused());
    }
    verify(
        &supervisor,
        &observe(pid)?,
        &supervisor.executable,
        recorded.uid,
    )?;
    Ok(supervisor)
}

/// Capture exactly the selected number of same-user ancestors, nearest first.
/// Both complete native snapshots must agree; no common-ancestor search, adopted
/// process, cycle, or partial chain can authorize a supervisor. This runs only
/// at explicit review/admission boundaries, never as an idle ancestry poll.
#[cfg(target_os = "macos")]
pub fn lineage(
    recorded: &ProcessIdentity,
    depth: u8,
) -> Result<Vec<ProcessIdentity>, CandidateError> {
    if !(1..=8).contains(&depth) {
        return Err(parent_refused());
    }
    let snapshot = || {
        let mut ancestors = Vec::with_capacity(usize::from(depth));
        let mut child = recorded.clone();
        let mut seen = std::collections::BTreeSet::from([child.pid]);
        for _ in 0..depth {
            let ancestor = parent(&child)?;
            if ancestor.uid != recorded.uid || !seen.insert(ancestor.pid) {
                return Err(parent_refused());
            }
            child = ancestor.clone();
            ancestors.push(ancestor);
        }
        Ok(ancestors)
    };
    let first = snapshot()?;
    if first != snapshot()? {
        return Err(parent_refused());
    }
    Ok(first)
}

#[cfg(target_os = "macos")]
fn parent_refused() -> CandidateError {
    CandidateError::new(
        "process_parent_identity",
        "An unchanged, same-user native supervisor is required; adopted or uncertain processes were refused.",
    )
}

pub fn verify(
    recorded: &ProcessIdentity,
    observed: &ProcessIdentity,
    binary: &Path,
    uid: u32,
) -> Result<(), CandidateError> {
    if recorded != observed
        || recorded.start_micros == 0
        || recorded.pid <= 1
        || recorded.uid != uid
        || recorded.executable != binary
    {
        return Err(CandidateError::new(
            "process_identity_mismatch",
            "Provider PID, native start time, UID and exact executable must all match. No signal sent.",
        ));
    }
    Ok(())
}

pub fn alive(pid: i32) -> Result<bool, CandidateError> {
    if pid <= 1 {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Invalid provider PID.",
        ));
    }
    // SAFETY: signal zero observes existence without signalling the process.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(CandidateError::new(
            "process_identity_unavailable",
            "Process existence cannot be established.",
        ))
    }
}

/// Whether any live process other than this one executes exactly `binary`.
///
/// Used where no PID record names the provider, so absence must hold for every process that
/// could act on this pool. Processes proven to belong to other users are skipped (they cannot
/// open this user's private provider state), as are zombies. A same-user process whose executable path cannot be
/// read, and whose exec-time name (truncated by the kernel) could be `binary`'s, makes absence
/// uncertain rather than assumed.
///
/// An exited process no longer reports its path but still answers the signal check until its
/// parent reaps it, so zombies are identified through BSD process info. A process observed in any
/// other unprovable state is observed again for a short bounded interval; it is skipped only once
/// proven gone, a zombie, another user's or running something else, and absence is refused
/// otherwise, naming the process and each failed observation.
#[cfg(target_os = "macos")]
pub fn executable_running(binary: &Path) -> Result<bool, CandidateError> {
    const ATTEMPTS: u32 = 40;
    let uncertain = || {
        CandidateError::new(
            "stop_uncertain",
            "Cannot establish provider process absence.",
        )
    };
    let canonical = std::fs::canonicalize(binary).ok();
    // SAFETY: a null buffer asks libproc only for the current process count.
    let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let capacity = usize::try_from(estimate).map_err(|_| uncertain())? + 64;
    let mut pids = vec![0_i32; capacity];
    let bytes = i32::try_from(capacity * std::mem::size_of::<i32>()).map_err(|_| uncertain())?;
    // SAFETY: the buffer is writable for `bytes` bytes of pid_t values.
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    let count = usize::try_from(count).map_err(|_| uncertain())?;
    // A full buffer may have truncated the list.
    if count == 0 || count >= capacity {
        return Err(uncertain());
    }
    let this = i32::try_from(std::process::id()).map_err(|_| uncertain())?;
    for &pid in &pids[..count] {
        if pid <= 0 || pid == this {
            continue;
        }
        let mut last = Observation::default();
        // SAFETY: geteuid has no preconditions and cannot fail.
        let user = unsafe { libc::geteuid() };
        let observe = || {
            last = observe_process(pid);
            classify(&last, binary, canonical.as_deref(), user)
        };
        match settle(observe, ATTEMPTS, |_| std::time::Duration::from_millis(5)) {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => {
                return Err(CandidateError::new(
                    error.code,
                    format!("{} Process {pid}: {}.", error.message, last.describe()),
                ));
            }
        }
    }
    Ok(false)
}

/// Whether one process executes the provider binary, from a single observation.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Executes {
    Yes,
    /// Proven: gone, a zombie, another user's, or running a different executable.
    No,
    /// Not provable from this observation.
    Unknown,
}

/// One raw observation of a process, gathered only as far as needed.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct Observation {
    /// The executable path, when the kernel reports one.
    path: Option<PathBuf>,
    /// The errno of the failed path lookup.
    path_error: i32,
    /// The errno of `kill(pid, 0)`; `None` when the signal check succeeded.
    signal_error: Option<i32>,
    /// `(zombie, exec-time name)` from BSD process info, when readable.
    info: Option<(bool, Vec<u8>)>,
    /// The errno of the failed BSD process info read.
    info_error: i32,
    /// `(effective, real)` user of a process the signal check was not permitted to reach.
    users: Option<(u32, u32)>,
}

#[cfg(target_os = "macos")]
impl Observation {
    fn describe(&self) -> String {
        let mut stages = vec![match &self.path {
            Some(_) => "path read".to_owned(),
            None => format!("path unreadable (errno {})", self.path_error),
        }];
        if self.path.is_none() {
            stages.push(match self.signal_error {
                None => "signal check succeeded".to_owned(),
                Some(errno) => format!("signal check failed (errno {errno})"),
            });
            if self.signal_error == Some(libc::EPERM) {
                stages.push(match self.users {
                    Some((effective, real)) => format!("users {effective}/{real}"),
                    None => format!("users unreadable (errno {})", self.info_error),
                });
            }
        }
        if self.path.is_none() && self.signal_error.is_none() {
            stages.push(match &self.info {
                Some((zombie, _)) => format!("process info read (zombie: {zombie})"),
                None => format!("process info unreadable (errno {})", self.info_error),
            });
        }
        stages.join(", ")
    }
}

#[cfg(target_os = "macos")]
fn observe_process(pid: i32) -> Observation {
    use std::os::unix::ffi::OsStrExt;
    let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buffer is writable for its full declared size.
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if let Ok(length @ 1..) = usize::try_from(length) {
        return Observation {
            path: Some(PathBuf::from(std::ffi::OsStr::from_bytes(&path[..length]))),
            ..Observation::default()
        };
    }
    let errno = || std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let path_error = errno();
    let bsd_info = || {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: libproc receives a correctly sized writable proc_bsdinfo buffer. A nonzero
        // `arg` also finds a zombie; with zero, an unreaped process fails with ESRCH like a
        // missing one while the signal check still succeeds.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                1,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        // SAFETY: the buffer was zero-initialized, and a full-size read filled it.
        (read as usize == std::mem::size_of::<libc::proc_bsdinfo>())
            .then(|| unsafe { info.assume_init() })
            .ok_or_else(errno)
    };
    // SAFETY: signal zero only observes existence and permission.
    if unsafe { libc::kill(pid, 0) } != 0 {
        let signal_error = errno();
        // Permission is also refused by sandboxing, so the owner decides, not the errno.
        let (users, info_error) = if signal_error == libc::EPERM {
            match bsd_info() {
                Ok(info) => (Some((info.pbi_uid, info.pbi_ruid)), 0),
                Err(error) => (None, error),
            }
        } else {
            (None, 0)
        };
        return Observation {
            path_error,
            signal_error: Some(signal_error),
            info_error,
            users,
            ..Observation::default()
        };
    }
    let info = match bsd_info() {
        Ok(info) => info,
        Err(info_error) => {
            return Observation {
                path_error,
                info_error,
                ..Observation::default()
            };
        }
    };
    let comm = info
        .pbi_comm
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    Observation {
        path_error,
        info: Some((info.pbi_status == libc::SZOMB, comm)),
        ..Observation::default()
    }
}

#[cfg(target_os = "macos")]
fn classify(
    observation: &Observation,
    binary: &Path,
    canonical: Option<&Path>,
    user: u32,
) -> Executes {
    use std::os::unix::ffi::OsStrExt;
    if let Some(path) = &observation.path {
        return if path == binary || canonical == Some(path.as_path()) {
            Executes::Yes
        } else {
            Executes::No
        };
    }
    match (observation.signal_error, observation.users) {
        (Some(libc::ESRCH), _) => return Executes::No,
        // Another user's process cannot open this user's private provider state.
        (Some(libc::EPERM), Some((effective, real))) if effective != user && real != user => {
            return Executes::No;
        }
        (Some(_), _) => return Executes::Unknown,
        (None, _) => {}
    }
    match &observation.info {
        None => Executes::Unknown,
        Some((true, _)) => Executes::No,
        // The path is unreadable when the executable was since removed or replaced. Its name at
        // exec time (truncated by the kernel) still identifies a process that may be the provider.
        Some((false, comm)) => {
            let name = binary
                .file_name()
                .map(OsStrExt::as_bytes)
                .unwrap_or_default();
            if comm.as_slice() == &name[..name.len().min(libc::MAXCOMLEN)] {
                Executes::Unknown
            } else {
                Executes::No
            }
        }
    }
}

/// Observe until the answer is proven, up to `attempts` further observations, pausing
/// `pause(attempt)` before each. Persistent uncertainty refuses rather than assuming absence.
#[cfg(target_os = "macos")]
fn settle(
    mut observe: impl FnMut() -> Executes,
    attempts: u32,
    pause: impl Fn(u32) -> std::time::Duration,
) -> Result<bool, CandidateError> {
    for attempt in 0..=attempts {
        match observe() {
            Executes::Yes => return Ok(true),
            Executes::No => return Ok(false),
            Executes::Unknown if attempt < attempts => std::thread::sleep(pause(attempt)),
            Executes::Unknown => {}
        }
    }
    Err(CandidateError::new(
        "stop_uncertain",
        "Cannot establish provider process absence.",
    ))
}
#[cfg(not(target_os = "macos"))]
pub fn executable_running(_binary: &Path) -> Result<bool, CandidateError> {
    Err(CandidateError::new(
        "unsupported_host",
        "SmolVM process inspection requires macOS.",
    ))
}

#[derive(Debug, Serialize)]
pub struct MemoryUsage {
    pub resident_bytes: u64,
    pub physical_footprint_bytes: u64,
}

#[cfg(target_os = "macos")]
pub fn memory_usage(pid: i32) -> Result<MemoryUsage, CandidateError> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: proc_pid_rusage's opaque buffer points to a correctly sized V2 record.
    if unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, usage.as_mut_ptr().cast()) } != 0 {
        return Err(CandidateError::new(
            "resource_observation_unavailable",
            "Cannot measure provider memory footprint.",
        ));
    }
    let usage = unsafe { usage.assume_init() };
    Ok(MemoryUsage {
        resident_bytes: usage.ri_resident_size,
        physical_footprint_bytes: usage.ri_phys_footprint,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn memory_usage(_pid: i32) -> Result<MemoryUsage, CandidateError> {
    Err(CandidateError::new(
        "unsupported_host",
        "Provider footprint requires macOS.",
    ))
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(deny_unknown_fields)]
pub struct DiskIdentity {
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
    pub uuid: String,
}

pub fn disk(path: &Path) -> Result<DiskIdentity, CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io)?;
    let m = file.metadata().map_err(io)?;
    if !m.is_file() || m.nlink() != 1 || m.uid() != unsafe { libc::geteuid() } {
        return Err(CandidateError::new(
            "disk_identity_mismatch",
            "Expected a private, singly linked regular disk.",
        ));
    }
    let mut superblock = [0; 120];
    file.seek(SeekFrom::Start(1024)).map_err(io)?;
    file.read_exact(&mut superblock).map_err(io)?;
    if superblock[56..58] != [0x53, 0xef] {
        return Err(CandidateError::new(
            "disk_identity_mismatch",
            "Storage disk has no ext filesystem superblock.",
        ));
    }
    let bytes = &superblock[104..120];
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let uuid = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    Ok(DiskIdentity {
        device: m.dev(),
        inode: m.ino(),
        bytes: m.len(),
        uuid,
    })
}

/// Signal only a process whose current native identity matches the retained receipt.
pub fn terminate(recorded: &ProcessIdentity, binary: &Path) -> Result<(), CandidateError> {
    verify(recorded, &observe(recorded.pid)?, binary, unsafe {
        libc::geteuid()
    })?;
    // SAFETY: ownership was checked immediately above; SIGTERM is scoped to this PID.
    // macOS provides no pidfd-style atomic identity-and-signal primitive.
    if unsafe { libc::kill(recorded.pid, libc::SIGTERM) } != 0 {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Could not signal the verified provider.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn native_parent_rejects_a_reused_child_identity() {
        let current = observe(std::process::id() as i32).unwrap();
        let supervisor = parent(&current).unwrap();
        assert_eq!(supervisor.uid, current.uid);
        assert_ne!(supervisor.pid, current.pid);
        let mut changed = current;
        changed.start_micros += 1;
        assert!(parent(&changed).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_memory_footprint_is_observed_for_the_current_process() {
        let value = memory_usage(std::process::id() as i32).unwrap();
        assert!(value.resident_bytes > 0);
        assert!(value.physical_footprint_bytes > 0);
    }
    #[test]
    fn reused_pid_wrong_binary_uid_and_missing_start_are_rejected() {
        let good = ProcessIdentity {
            pid: 42000,
            start_micros: 123456,
            uid: 502,
            executable: PathBuf::from("/private/provider"),
        };
        assert!(verify(&good, &good, &good.executable, 502).is_ok());
        for bad in [
            ProcessIdentity {
                start_micros: 123457,
                ..good.clone()
            },
            ProcessIdentity {
                uid: 501,
                ..good.clone()
            },
            ProcessIdentity {
                executable: PathBuf::from("/private/provider-other"),
                ..good.clone()
            },
            ProcessIdentity {
                start_micros: 0,
                ..good.clone()
            },
        ] {
            assert_eq!(
                verify(&good, &bad, &good.executable, 502).unwrap_err().code,
                "process_identity_mismatch"
            );
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_identity_observes_this_process_without_signalling_it() {
        let observed = observe(std::process::id() as i32).unwrap();
        assert_eq!(
            observed.executable.canonicalize().unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        assert!(observed.start_micros > 0);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn a_running_executable_is_found_by_exact_path_until_it_exits() {
        let mut random = [0_u8; 8];
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        // Uncanonicalized temp root: the kernel reports the resolved path.
        let root = std::env::temp_dir().join(format!("hack-identity-running-{suffix}"));
        std::fs::create_dir(&root).unwrap();
        let binary = root.join("sleep");
        std::fs::copy("/bin/sleep", &binary).unwrap();
        assert!(!executable_running(&binary).unwrap());
        let mut child = std::process::Command::new(&binary)
            .arg("30")
            .spawn()
            .unwrap();
        assert!(executable_running(&binary).unwrap());
        assert!(!executable_running(&root.join("other")).unwrap());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!executable_running(&binary).unwrap());
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn classification_proves_absence_only_for_gone_zombie_foreign_or_other_processes() {
        const USER: u32 = 502;
        let binary = Path::new("/private/pool/providers/smolvm-bin");
        let canonical = Some(Path::new("/private/real/smolvm-bin"));
        let path = |p: &str| Observation {
            path: Some(PathBuf::from(p)),
            ..Observation::default()
        };
        let signal = |errno| Observation {
            signal_error: Some(errno),
            ..Observation::default()
        };
        let refused = |users| Observation {
            signal_error: Some(libc::EPERM),
            users,
            ..Observation::default()
        };
        let info = |zombie, comm: &[u8]| Observation {
            info: Some((zombie, comm.to_vec())),
            ..Observation::default()
        };
        let cases = [
            (path("/private/pool/providers/smolvm-bin"), Executes::Yes),
            (path("/private/real/smolvm-bin"), Executes::Yes),
            (path("/usr/bin/true"), Executes::No),
            // Confirmed gone.
            (signal(libc::ESRCH), Executes::No),
            // A refused signal proves another user only with both of the process's users read.
            (refused(Some((0, 0))), Executes::No),
            (refused(Some((501, 0))), Executes::No),
            (refused(Some((USER, 0))), Executes::Unknown),
            (refused(Some((0, USER))), Executes::Unknown),
            (refused(None), Executes::Unknown),
            (signal(libc::EINVAL), Executes::Unknown),
            // Live but unreadable, as when caught mid-exit.
            (Observation::default(), Executes::Unknown),
            (info(true, b"smolvm-bin"), Executes::No),
            // A live process whose replaced executable had the provider's name.
            (info(false, b"smolvm-bin"), Executes::Unknown),
            (info(false, b"true"), Executes::No),
        ];
        for (index, (observation, expected)) in cases.iter().enumerate() {
            assert_eq!(
                classify(observation, binary, canonical, USER),
                *expected,
                "case {index}"
            );
        }
        // The kernel truncates exec-time names to MAXCOMLEN bytes.
        let long = b"provider-binary-with-a-long-name";
        assert_eq!(
            classify(
                &info(false, &long[..libc::MAXCOMLEN]),
                Path::new("/p/provider-binary-with-a-long-name"),
                None,
                USER
            ),
            Executes::Unknown
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn re_observation_skips_only_proven_answers_and_refuses_persistent_uncertainty() {
        use Executes::{No, Unknown, Yes};
        let run = |sequence: &[Executes], attempts| {
            let mut calls = 0;
            let result = settle(
                || {
                    calls += 1;
                    sequence[(calls - 1).min(sequence.len() - 1)]
                },
                attempts,
                |_| std::time::Duration::ZERO,
            );
            (result.map_err(|error| error.code.to_string()), calls)
        };
        let refused = Err("stop_uncertain".to_string());
        // An exiting process is skipped once proven gone or a zombie.
        assert_eq!(run(&[Unknown, Unknown, No], 5), (Ok(false), 3));
        // One that turns out to run the provider is found.
        assert_eq!(run(&[Unknown, Yes], 5), (Ok(true), 2));
        // Still unprovable after every re-observation: refuse, never assume absence.
        assert_eq!(run(&[Unknown], 5), (refused.clone(), 6));
        assert_eq!(run(&[Unknown], 0), (refused, 1));
        assert_eq!(run(&[No], 0), (Ok(false), 1));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn an_unreaped_child_is_observed_as_a_zombie_not_an_unknown_process() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id() as i32;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        // Until reaped, the exited child keeps its PID and answers the signal check.
        let observation = loop {
            let observation = observe_process(pid);
            if observation.path.is_none() || std::time::Instant::now() > deadline {
                break observation;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert_eq!(observation.signal_error, None, "{}", observation.describe());
        assert_eq!(
            observation.info,
            Some((true, b"true".to_vec())),
            "{}",
            observation.describe()
        );
        assert_eq!(
            classify(&observation, Path::new("/usr/bin/true"), None, unsafe {
                libc::geteuid()
            }),
            Executes::No
        );
        assert!(child.wait().unwrap().success());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn processes_exiting_during_a_scan_do_not_make_absence_uncertain() {
        use std::sync::atomic::{AtomicBool, Ordering};
        // Children spawned and reaped concurrently are caught mid-exit by some scans.
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let churn: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = std::process::Command::new("/usr/bin/true").status();
                    }
                })
            })
            .collect();
        let absent = Path::new("/nonexistent/hack-provider-absence");
        let scans: Vec<_> = (0..200).map(|_| executable_running(absent)).collect();
        stop.store(true, Ordering::Relaxed);
        for thread in churn {
            thread.join().unwrap();
        }
        for scan in scans {
            assert!(!scan.unwrap());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn stale_identity_refuses_a_real_signal_and_the_sentinel_survives() {
        let mut sentinel = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let recorded = observe(sentinel.id() as i32).unwrap();
        let stale = ProcessIdentity {
            start_micros: recorded.start_micros + 1,
            ..recorded.clone()
        };
        assert_eq!(
            terminate(&stale, &recorded.executable).unwrap_err().code,
            "process_identity_mismatch"
        );
        assert!(sentinel.try_wait().unwrap().is_none());
        terminate(&recorded, &recorded.executable).unwrap();
        assert!(!sentinel.wait().unwrap().success());
    }
}
