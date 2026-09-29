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

/// What the kernel reports about a process whose executable path is unreadable.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    zombie: bool,
    /// Exec-time name, truncated by the kernel to MAXCOMLEN bytes.
    name: Vec<u8>,
    /// `(effective, real)` user.
    users: (u32, u32),
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
    /// The process's record, from short BSD process info or else the process table.
    record: Option<Record>,
    /// The errno of the failed short BSD process info read.
    record_error: i32,
}

#[cfg(target_os = "macos")]
impl Observation {
    fn describe(&self) -> String {
        if self.path.is_some() {
            return "path read".to_owned();
        }
        let mut stages = vec![format!("path unreadable (errno {})", self.path_error)];
        stages.push(match self.signal_error {
            None => "signal check succeeded".to_owned(),
            Some(errno) => format!("signal check failed (errno {errno})"),
        });
        if self.signal_error != Some(libc::ESRCH) {
            stages.push(match &self.record {
                Some(record) => format!(
                    "zombie {}, users {}/{}, exec name {:?}",
                    record.zombie,
                    record.users.0,
                    record.users.1,
                    String::from_utf8_lossy(&record.name)
                ),
                None => format!(
                    "process record unreadable (errno {}; process table too)",
                    self.record_error
                ),
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
    // SAFETY: signal zero only observes existence and permission.
    let signal_error = (unsafe { libc::kill(pid, 0) } != 0).then(errno);
    if signal_error == Some(libc::ESRCH) {
        return Observation {
            path_error,
            signal_error,
            ..Observation::default()
        };
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
    // SAFETY: libproc receives a correctly sized writable proc_bsdshortinfo buffer. A nonzero
    // `arg` also finds zombies, which otherwise fail with ESRCH while still answering the signal
    // check. Short info remains readable for other users' processes where full info is refused.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            1,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdshortinfo>() as i32,
        )
    };
    let (record, record_error) = if read as usize == std::mem::size_of::<libc::proc_bsdshortinfo>()
    {
        // SAFETY: the buffer was zero-initialized, and a full-size read filled it.
        let info = unsafe { info.assume_init() };
        let record = Record {
            zombie: info.pbsi_status == libc::SZOMB,
            name: comm_bytes(&info.pbsi_comm),
            users: (info.pbsi_uid, info.pbsi_ruid),
        };
        (Some(record), 0)
    } else {
        // The process table (`ps`, via sysctl) reports every process.
        (process_table(pid), errno())
    };
    Observation {
        path: None,
        path_error,
        signal_error,
        record,
        record_error,
    }
}

#[cfg(target_os = "macos")]
fn comm_bytes(comm: &[libc::c_char]) -> Vec<u8> {
    comm.iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect()
}

/// `pid`'s record from the process table (`ps`, via sysctl), which reports every process,
/// including ones this user may not signal or inspect. `None` unless the table reports exactly
/// one parsable row.
#[cfg(target_os = "macos")]
fn process_table(pid: i32) -> Option<Record> {
    let output = super::process::capture(
        super::process::clean_command(Path::new("/bin/ps"))
            .args(["-o", "uid=,ruid=,stat=,ucomm=", "-p"])
            .arg(pid.to_string()),
        std::time::Duration::from_secs(5),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_process_row(&output.stdout)
}

/// Parse `<uid> <ruid> <stat> <ucomm>`; the name may contain spaces and is padded by `ps`.
#[cfg(target_os = "macos")]
fn parse_process_row(output: &[u8]) -> Option<Record> {
    let text = std::str::from_utf8(output).ok()?.strip_suffix('\n')?;
    if text.contains('\n') {
        return None;
    }
    let mut rest = text;
    let mut field = || -> Option<&str> {
        let (value, tail) = rest
            .trim_start()
            .split_once(|c: char| c.is_ascii_whitespace())?;
        rest = tail;
        Some(value)
    };
    let effective = field()?.parse().ok()?;
    let real = field()?.parse().ok()?;
    let state = field()?;
    let name = rest.trim();
    if name.is_empty() || !state.chars().next()?.is_ascii_uppercase() {
        return None;
    }
    Some(Record {
        zombie: state.starts_with('Z'),
        name: name.as_bytes().to_vec(),
        users: (effective, real),
    })
}

/// Whether an exec-time name (truncated by the kernel to MAXCOMLEN bytes) could be `binary`'s.
#[cfg(target_os = "macos")]
fn exec_name_matches(name: &[u8], binary: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let expected = binary
        .file_name()
        .map(OsStrExt::as_bytes)
        .unwrap_or_default();
    name == &expected[..expected.len().min(libc::MAXCOMLEN)]
}

#[cfg(target_os = "macos")]
fn classify(
    observation: &Observation,
    binary: &Path,
    canonical: Option<&Path>,
    user: u32,
) -> Executes {
    if let Some(path) = &observation.path {
        return if path == binary || canonical == Some(path.as_path()) {
            Executes::Yes
        } else {
            Executes::No
        };
    }
    match observation.signal_error {
        Some(libc::ESRCH) => return Executes::No,
        // Permission is also refused by sandboxing, so the record decides, not the errno.
        None | Some(libc::EPERM) => {}
        Some(_) => return Executes::Unknown,
    }
    let Some(record) = &observation.record else {
        return Executes::Unknown;
    };
    if record.zombie
        // Another user's process cannot open this user's private provider state.
        || (record.users.0 != user && record.users.1 != user)
        // The path is unreadable when the executable was removed or replaced, or while the
        // process exits; the provider always runs under its own exec-time name.
        || !exec_name_matches(&record.name, binary)
    {
        Executes::No
    } else {
        Executes::Unknown
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
        let record = |signal_error, zombie, users, name: &[u8]| Observation {
            signal_error,
            record: Some(Record {
                zombie,
                name: name.to_vec(),
                users,
            }),
            ..Observation::default()
        };
        let ok = None;
        let refused = Some(libc::EPERM);
        let cases = [
            (path("/private/pool/providers/smolvm-bin"), Executes::Yes),
            (path("/private/real/smolvm-bin"), Executes::Yes),
            (path("/usr/bin/true"), Executes::No),
            // Confirmed gone.
            (signal(libc::ESRCH), Executes::No),
            (signal(libc::EINVAL), Executes::Unknown),
            // No record from either source: never assumed absent.
            (Observation::default(), Executes::Unknown),
            (signal(libc::EPERM), Executes::Unknown),
            // Zombies execute nothing, whoever owns them (e.g. another user's defunct process).
            (record(ok, true, (0, 0), b"sshd"), Executes::No),
            (record(ok, true, (USER, USER), b"smolvm-bin"), Executes::No),
            // Another user's process, however the signal check went.
            (record(refused, false, (0, 0), b"smolvm-bin"), Executes::No),
            (
                record(refused, false, (501, 0), b"smolvm-bin"),
                Executes::No,
            ),
            (record(ok, false, (0, 0), b"smolvm-bin"), Executes::No),
            // This user's process under another exec-time name (removed, replaced or exiting).
            (record(ok, false, (USER, USER), b"true"), Executes::No),
            (
                record(refused, false, (USER, USER), b"sandboxd"),
                Executes::No,
            ),
            // Only one of the users is this user, under the provider's name: not provable.
            (
                record(refused, false, (USER, 0), b"smolvm-bin"),
                Executes::Unknown,
            ),
            (
                record(refused, false, (0, USER), b"smolvm-bin"),
                Executes::Unknown,
            ),
            (
                record(ok, false, (USER, USER), b"smolvm-bin"),
                Executes::Unknown,
            ),
        ];
        for (index, (observation, expected)) in cases.iter().enumerate() {
            assert_eq!(
                classify(observation, binary, canonical, USER),
                *expected,
                "case {index}: {}",
                observation.describe()
            );
        }
        // The kernel truncates exec-time names to MAXCOMLEN bytes.
        let long = b"provider-binary-with-a-long-name";
        assert_eq!(
            classify(
                &record(ok, false, (USER, USER), &long[..libc::MAXCOMLEN]),
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
    fn the_process_table_reports_users_and_names_and_malformed_output_is_unknown() {
        // SAFETY: getuid and geteuid have no preconditions and cannot fail.
        let (effective, real) = unsafe { (libc::geteuid(), libc::getuid()) };
        let own = process_table(std::process::id() as i32).unwrap();
        assert_eq!((own.users, own.zombie), ((effective, real), false));
        assert_eq!(
            process_table(1),
            Some(Record {
                zombie: false,
                name: b"launchd".to_vec(),
                users: (0, 0),
            })
        );
        assert_eq!(process_table(99_999), None);
        assert_eq!(
            parse_process_row(b"  502   501 S+   Google Chrome He \n"),
            Some(Record {
                zombie: false,
                name: b"Google Chrome He".to_vec(),
                users: (502, 501),
            })
        );
        assert_eq!(
            parse_process_row(b"    0     0 Z    sshd             \n").map(|row| row.zombie),
            Some(true)
        );
        for malformed in [
            &b""[..],
            b"502 501 S\n",
            b"502 501 S   \n",
            b"502 501 name\n",
            b"x 501 S name\n",
            b"-1 501 S name\n",
            b"502 501 S a\n502 501 S b\n",
            b"502 501 S name",
        ] {
            assert_eq!(parse_process_row(malformed), None, "{malformed:?}");
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn an_unreaped_child_is_observed_as_a_zombie_not_an_unknown_process() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id() as i32;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let user = unsafe { libc::geteuid() };
        let provider = Path::new("/usr/bin/true");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        // While exiting, a process has no readable path but is still running (status 2), which
        // classifies as unknown under its own name; only then does it become an unreaped zombie
        // that keeps its PID and answers the signal check.
        let observation = loop {
            let observation = observe_process(pid);
            let zombie = observation
                .record
                .as_ref()
                .is_some_and(|record| record.zombie);
            if zombie || std::time::Instant::now() > deadline {
                break observation;
            }
            if observation.path.is_none() {
                assert_eq!(
                    classify(&observation, provider, None, user),
                    Executes::Unknown,
                    "{}",
                    observation.describe()
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        };
        assert_eq!(observation.signal_error, None, "{}", observation.describe());
        assert_eq!(
            observation.record,
            Some(Record {
                zombie: true,
                name: b"true".to_vec(),
                // SAFETY: getuid has no preconditions and cannot fail.
                users: (user, unsafe { libc::getuid() }),
            }),
            "{}",
            observation.describe()
        );
        assert_eq!(classify(&observation, provider, None, user), Executes::No);
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
