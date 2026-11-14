use crate::{Result, refused};
use std::fs;
use std::{
    io,
    os::fd::AsRawFd,
    sync::atomic::{AtomicBool, Ordering},
};

pub static CHILD_CHANGED: AtomicBool = AtomicBool::new(false);

extern "C" fn child_signal(_: i32) {
    CHILD_CHANGED.store(true, Ordering::Relaxed);
}

pub static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}

pub fn signals() -> Result<()> {
    // SAFETY: sigaction is initialized, handler has C ABI and only stores an
    // atomic flag; the kernel copies the action and retains no Rust pointer.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = child_signal as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
        // A caller's blocked signal mask survives exec. Supervision must still
        // receive stop requests and must be able to reap its direct children.
        if libc::sigprocmask(libc::SIG_SETMASK, &action.sa_mask, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
        action.sa_sigaction = stop_signal as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

pub fn session() -> Result<()> {
    // SAFETY: setsid has no pointer preconditions; this process is the caller's
    // freshly spawned child, never an interactive terminal owner.
    if unsafe { libc::setsid() } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub pid: i32,
    pub group: i32,
    pub session: i32,
    pub start: u64,
    pub uid: u32,
    pub zombie: bool,
}

#[cfg(target_os = "linux")]
pub fn inspect(pid: i32) -> Result<Option<Identity>> {
    let path = format!("/proc/{pid}/stat");
    let bytes = match fs::read(&path) {
        Ok(value) => value,
        Err(error) if absent_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let tail = proc_stat_tail(&bytes)?;
    let fields: Vec<_> = tail.split_whitespace().collect();
    let group = fields
        .get(2)
        .and_then(|v| v.parse().ok())
        .ok_or_else(refused)?;
    let start = fields
        .get(19)
        .and_then(|v| v.parse().ok())
        .ok_or_else(refused)?;
    let session = fields
        .get(3)
        .and_then(|v| v.parse().ok())
        .ok_or_else(refused)?;
    let uid = match linux_uid(pid)? {
        Some(uid) => uid,
        None => return Ok(None),
    };
    Ok(Some(Identity {
        pid,
        group,
        session,
        start,
        uid,
        zombie: fields.first() == Some(&"Z") || fields.first() == Some(&"X"),
    }))
}

#[cfg(target_os = "linux")]
fn linux_uid(pid: i32) -> Result<Option<u32>> {
    let status = match fs::read(format!("/proc/{pid}/status")) {
        Ok(status) => status,
        Err(error) if absent_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let line = status
        .split(|byte| *byte == b'\n')
        .find_map(|line| line.strip_prefix(b"Uid:"))
        .ok_or_else(refused)?;
    let uid = std::str::from_utf8(line)
        .map_err(|_| refused())?
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|uid| uid.parse().ok())
        .ok_or_else(refused)?;
    Ok(Some(uid))
}

#[cfg(target_os = "linux")]
fn proc_stat_tail(bytes: &[u8]) -> Result<&str> {
    // comm is arbitrary bytes and may itself contain parentheses. Only the
    // fields following its final delimiter have an ASCII/UTF-8 contract.
    let end = bytes
        .windows(2)
        .rposition(|v| v == b") ")
        .ok_or_else(refused)?;
    std::str::from_utf8(&bytes[end + 2..]).map_err(|_| refused())
}

#[cfg(target_os = "linux")]
pub fn census() -> Result<Vec<Identity>> {
    let mut result = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if let Some(pid) = entry.file_name().to_str().and_then(|v| v.parse().ok()) {
            match inspect(pid) {
                Ok(Some(identity)) => result.push(identity),
                Ok(None) => (),
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) =>
                {
                    match linux_uid(pid)? {
                        // SAFETY: geteuid is an observation with no preconditions.
                        Some(uid) if uid != unsafe { libc::geteuid() } => (),
                        None => (),
                        _ => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }
    readable_self(&result)?;
    Ok(result)
}

#[cfg(target_os = "linux")]
pub fn boot() -> Result<String> {
    Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .into())
}

#[cfg(target_os = "macos")]
pub fn inspect(pid: i32) -> Result<Option<Identity>> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: buffer is writable for its exact size, and no pointer is retained.
    let size = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if size as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        let error = io::Error::last_os_error();
        if size == 0 && error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        if size == 0 && error.raw_os_error() == Some(libc::EPERM) {
            return Err(error);
        }
        return Err(refused());
    }
    // SAFETY: the kernel initialized exactly the expected struct size above.
    let info = unsafe { info.assume_init() };
    // SAFETY: getsid only observes the named PID. ESRCH is an exit race.
    let mut session = unsafe { libc::getsid(pid) };
    if session < 0 && info.pbi_status == libc::SZOMB && info.pbi_pgid as i32 == pid {
        // Darwin may hide getsid for zombies. A matching recorded leader's
        // immutable PID/birth/UID still proves it has not been reused.
        session = pid;
    }
    if session < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(Some(Identity {
        pid,
        group: info.pbi_pgid as i32,
        session,
        start: info
            .pbi_start_tvsec
            .checked_mul(1_000_000)
            .and_then(|v| v.checked_add(info.pbi_start_tvusec))
            .ok_or_else(refused)?,
        uid: info.pbi_uid,
        zombie: info.pbi_status == libc::SZOMB,
    }))
}

#[cfg(target_os = "macos")]
pub fn census() -> Result<Vec<Identity>> {
    const PROC_ALL_PIDS: u32 = 1;
    // SAFETY: querying required bytes uses a null pointer and zero buffer size.
    let size = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if size <= 0 {
        return Err(refused());
    }
    let mut pids = vec![0i32; size as usize / 4 + 1024];
    // SAFETY: vector is initialized and live for the byte size supplied.
    let written = unsafe {
        libc::proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr().cast(),
            (pids.len() * 4) as i32,
        )
    };
    if written <= 0 || written as usize >= pids.len() * 4 {
        return Err(refused());
    }
    let mut result = Vec::new();
    for pid in pids
        .into_iter()
        .take(written as usize / 4)
        .filter(|pid| *pid > 0)
    {
        match inspect(pid) {
            Ok(Some(identity)) => result.push(identity),
            Ok(None) => (),
            // Unrelated protected processes cannot belong to this user's
            // authored session. Exact guard reads remain strict in inspect.
            Err(error) if error.raw_os_error() == Some(libc::EPERM) && foreign_uid(pid)? => (),
            Err(error) => return Err(error),
        }
    }
    readable_self(&result)?;
    Ok(result)
}

#[cfg(target_os = "macos")]
fn foreign_uid(pid: i32) -> Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
    // SAFETY: bounded writable struct buffer, retained only for this call.
    let size = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdshortinfo>() as i32,
        )
    };
    if size as usize != std::mem::size_of::<libc::proc_bsdshortinfo>() {
        let error = io::Error::last_os_error();
        if absent_error(&error) {
            return Ok(true);
        }
        return Err(refused());
    }
    // SAFETY: exact struct size was initialized; geteuid only observes identity.
    Ok(unsafe { info.assume_init().pbsi_uid != libc::geteuid() })
}

#[cfg(target_os = "macos")]
pub fn boot() -> Result<String> {
    let mut bytes = [0u8; 64];
    let mut length = bytes.len();
    // SAFETY: read-only sysctl with writable bounded buffer, no retained pointer.
    if unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(refused());
    }
    if length == 0 || length > bytes.len() {
        return Err(refused());
    }
    Ok(std::str::from_utf8(&bytes[..length])
        .map_err(|_| refused())?
        .trim_end_matches('\0')
        .to_ascii_lowercase())
}

pub fn same(state: &crate::storage::State, identity: &Identity) -> Result<()> {
    if state.guard_pid != identity.pid
        || state.process_group_id != identity.group
        || state.guard_pid != identity.session
        || state.guard_start_time != identity.start
        || state.uid != identity.uid
        || state.boot_id != boot()?
        || identity.zombie
    {
        return Err(refused());
    }
    Ok(())
}

pub fn live_group(group: i32, excluding: Option<i32>) -> Result<bool> {
    Ok(census()?
        .iter()
        .any(|p| p.session == group && !p.zombie && Some(p.pid) != excluding))
}

pub fn absent_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT))
}

fn incarnation_matches(expected: &Identity, current: &Identity) -> bool {
    expected.pid == current.pid
        && expected.start == current.start
        && expected.uid == current.uid
        && expected.session == current.session
}

/// Return one census with session identity proved across that census. A matching
/// leader (including zombie) or exact recorded command birth is the witness.
/// No ordering comparison uses Darwin's adjustable wall-clock start timestamps.
fn recorded_members(state: &crate::storage::State) -> Result<Vec<Identity>> {
    for _ in 0..2 {
        if matches!(state.phase.as_str(), "exited" | "killed" | "failed-start")
            || state.boot_id != boot()?
        {
            return Ok(Vec::new());
        }
        let leader = inspect(state.guard_pid)?;
        if let Some(p) = &leader
            && (p.start != state.guard_start_time
                || p.uid != state.uid
                || p.session != state.guard_pid)
        {
            return Ok(Vec::new());
        }
        let members: Vec<_> = census()?
            .into_iter()
            .filter(|p| p.session == state.guard_pid && !p.zombie)
            .collect();
        if members.is_empty() {
            return Ok(members);
        }
        let witness = leader
            .as_ref()
            .or_else(|| {
                members.iter().find(|p| {
                    Some(p.pid) == state.command_pid
                        && Some(p.start) == state.command_start_time
                        && p.uid == state.uid
                })
            })
            .ok_or_else(refused)?;
        // Recheck after enumeration: the witness held the SID throughout the census.
        if !inspect(witness.pid)?
            .as_ref()
            .is_some_and(|p| incarnation_matches(witness, p))
        {
            continue;
        }
        return Ok(members);
    }
    Err(refused())
}

pub fn recorded_live(state: &crate::storage::State, excluding_guard: bool) -> Result<bool> {
    Ok(recorded_members(state)?
        .iter()
        .any(|p| !excluding_guard || p.pid != state.guard_pid))
}

pub enum Observation {
    Absent,
    Live,
    Unknown,
}

/// Health observation is stricter than a persisted running phase. A lost guard
/// with remaining session members is unknown, never healthy or absent.
pub fn observe_state(state: &crate::storage::State) -> Observation {
    let observed = (|| -> Result<Observation> {
        if !recorded_live(state, true)? {
            return Ok(Observation::Absent);
        }
        let leader = inspect(state.guard_pid)?;
        if let Some(identity) = &leader
            && (identity.start != state.guard_start_time
                || identity.uid != state.uid
                || identity.session != state.guard_pid)
        {
            return Ok(Observation::Absent);
        }
        if !live_group(state.guard_pid, Some(state.guard_pid))? {
            return Ok(Observation::Absent);
        }
        Ok(
            if leader.is_some_and(|p| !p.zombie && p.group == state.guard_pid) {
                Observation::Live
            } else {
                Observation::Unknown
            },
        )
    })();
    observed.unwrap_or(Observation::Unknown)
}

/// The guard is never a member of an authored process group. It retains the
/// command lock while KILL is confirmed, including uninterruptible processes.
pub fn session_signal(session: i32, signal: i32) -> Result<()> {
    let members: Vec<_> = census()?
        .into_iter()
        .filter(|p| p.session == session && p.pid != session && !p.zombie)
        .collect();
    let groups: std::collections::BTreeSet<_> = members
        .iter()
        .filter(|p| p.group != session)
        .map(|p| p.group)
        .collect();
    for member in members.iter().filter(|p| p.group == session) {
        signal_member(member, signal)?;
    }
    for group in groups {
        group_signal(group, signal)?;
    }
    Ok(())
}

fn signal_member(expected: &Identity, signal: i32) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{FromRawFd, OwnedFd};
        // SAFETY: pidfd_open returns a newly owned CLOEXEC descriptor.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, expected.pid, 0u32) };
        if raw < 0 {
            let error = io::Error::last_os_error();
            if absent_error(&error) {
                return Ok(());
            }
            return Err(error);
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        let Some(current) = inspect(expected.pid)? else {
            return Ok(());
        };
        if current.zombie
            || current.start != expected.start
            || current.session != expected.session
            || current.uid != expected.uid
        {
            return Ok(());
        }
        // SAFETY: the pidfd pins the verified process; null siginfo is ordinary delivery.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0u32,
            )
        } < 0
        {
            let error = io::Error::last_os_error();
            if !absent_error(&error) {
                return Err(error);
            }
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let Some(current) = inspect(expected.pid)? else {
            return Ok(());
        };
        if current.zombie
            || current.start != expected.start
            || current.session != expected.session
            || current.uid != expected.uid
        {
            return Ok(());
        }
        // SAFETY: exact incarnation and session were rechecked immediately above.
        if unsafe { libc::kill(expected.pid, signal) } != 0 {
            let error = io::Error::last_os_error();
            if !absent_error(&error) {
                return Err(error);
            }
        }
        Ok(())
    }
}

/// Authored commands start a separate group and restore inherited ignored
/// dispositions, which exec itself is not required to reset.
pub fn command_setup() -> Result<()> {
    // SAFETY: async-signal-safe calls in the post-fork, single-threaded child.
    unsafe {
        if libc::setpgid(0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        libc::sigemptyset(&mut action.sa_mask);
        #[cfg(target_os = "linux")]
        let highest = libc::SIGRTMAX();
        #[cfg(target_os = "macos")]
        let highest = 31;
        for signal in 1..=highest {
            if signal != libc::SIGKILL
                && signal != libc::SIGSTOP
                && libc::sigaction(signal, &action, std::ptr::null_mut()) != 0
            {
                #[cfg(target_os = "linux")]
                if (signal == 32 || signal == 33)
                    && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL)
                {
                    continue;
                }
                return Err(io::Error::last_os_error());
            }
        }
        let mut mask = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        if libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn subreaper() -> Result<()> {
    #[cfg(target_os = "linux")]
    // SAFETY: process-local prctl enabling orphan adoption, integer options only.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn reap() -> Result<Vec<(i32, std::process::ExitStatus)>> {
    use std::os::unix::process::ExitStatusExt;
    let mut reaped = Vec::new();
    loop {
        let mut status = 0;
        // SAFETY: waitpid writes one live integer; WNOHANG never blocks.
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid == 0 {
            return Ok(reaped);
        }
        if pid < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                return Ok(reaped);
            }
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        reaped.push((pid, std::process::ExitStatus::from_raw(status)));
    }
}

pub fn close_inherited() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: called before opening application descriptors. Only inherited
        // descriptors >=3 are closed; the three protocol/std descriptors remain.
        if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } == 0 {
            return Ok(());
        }
    }
    // Collect first, so the directory iterator's descriptor is closed before
    // the sweep. Work is proportional to open descriptors, not RLIMIT_NOFILE.
    #[cfg(target_os = "linux")]
    let directory = "/proc/self/fd";
    #[cfg(target_os = "macos")]
    let directory = "/dev/fd";
    let descriptors: Vec<i32> = fs::read_dir(directory)?
        .map(|entry| {
            entry?
                .file_name()
                .to_str()
                .and_then(|v| v.parse().ok())
                .ok_or_else(refused)
        })
        .collect::<Result<_>>()?;
    for fd in descriptors.into_iter().filter(|fd| *fd >= 3) {
        // SAFETY: startup owns no application descriptors >=3. The iterator's
        // former descriptor may already be closed; that gap is harmless.
        unsafe {
            libc::close(fd);
        }
    }
    Ok(())
}

pub fn signal_guard(state: &crate::storage::State) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{FromRawFd, OwnedFd};
        // SAFETY: pidfd_open pins this PID incarnation and returns a fresh CLOEXEC fd.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, state.guard_pid, 0u32) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        same(state, &inspect(state.guard_pid)?.ok_or_else(refused)?)?;
        // SAFETY: pidfd is live; null siginfo requests ordinary signal delivery.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0u32,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        same(state, &inspect(state.guard_pid)?.ok_or_else(refused)?)?;
        // SAFETY: guarded by the exact kernel identity check above. Darwin has no pidfd.
        if unsafe { libc::kill(state.guard_pid, libc::SIGTERM) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub fn group_signal(group: i32, signal: i32) -> Result<()> {
    if group <= 1 {
        return Err(refused());
    }
    // SAFETY: validated positive group number is negated for group delivery.
    if unsafe { libc::kill(-group, signal) } != 0 {
        let error = io::Error::last_os_error();
        group_signal_result(group, error, census)?;
    }
    Ok(())
}

/// EPERM may race the last live member becoming an unreaped zombie. Only a
/// fresh, successful group census proving no non-zombie member makes it benign.
fn group_signal_result(
    group: i32,
    error: io::Error,
    census: impl FnOnce() -> Result<Vec<Identity>>,
) -> Result<()> {
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    if error.raw_os_error() == Some(libc::EPERM)
        && !census()?.iter().any(|p| p.group == group && !p.zombie)
    {
        return Ok(());
    }
    Err(error)
}

/// Poll only pipe readiness between slow session checks. SIGCHLD and stop
/// signals interrupt poll; flags also cover signals arriving before this call.
pub fn wait_activity(fds: &[i32], timeout: std::time::Duration) -> Result<()> {
    if STOP.load(Ordering::Relaxed) || CHILD_CHANGED.swap(false, Ordering::Relaxed) {
        return Ok(());
    }
    let mut polls: Vec<_> = fds
        .iter()
        .map(|fd| libc::pollfd {
            fd: *fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    // SAFETY: initialized pollfd slice is live for its supplied length.
    if unsafe {
        libc::poll(
            polls.as_mut_ptr(),
            polls.len() as _,
            timeout.as_millis() as i32,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}

/// In-memory authority captured while a witness holds the old SID. It survives
/// witness exit but never grants authority over a later, unobserved incarnation.
/// A new stop invocation must establish its own witness again.
pub struct Recovery {
    session: i32,
    members: Vec<Identity>,
}

impl Recovery {
    pub fn capture(state: &crate::storage::State) -> Result<Self> {
        let members: Vec<_> = recorded_members(state)?
            .into_iter()
            .filter(|p| p.pid != state.guard_pid)
            .collect();
        if members.iter().any(|p| p.uid != state.uid) {
            return Err(refused());
        }
        Ok(Self {
            session: state.guard_pid,
            members,
        })
    }

    pub fn signal(&self, signal: i32) -> Result<()> {
        for member in &self.members {
            signal_member(member, signal)?;
        }
        Ok(())
    }

    pub fn live(&self) -> Result<bool> {
        for member in &self.members {
            if inspect(member.pid)?.is_some_and(|p| !p.zombie && incarnation_matches(member, &p)) {
                return Ok(true);
            }
        }
        // Unobserved descendants or an unrelated reused session cannot be
        // signalled by this snapshot, and must not be claimed as stopped.
        if live_group(self.session, Some(self.session))? {
            return Err(refused());
        }
        Ok(false)
    }
}

/// A successful census must contain our own readable identity. Known restricted
/// proc mounts are unsupported: hidden same-user members defeat absence proofs.
pub fn census_preflight() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let mounts = fs::read_to_string("/proc/self/mountinfo")?;
        if restricted_mount(&mounts) {
            return Err(refused());
        }
    }
    readable_self(&census()?)
}

#[cfg(target_os = "linux")]
fn restricted_mount(mounts: &str) -> bool {
    mounts.lines().any(|line| {
        line.split_whitespace().any(|field| {
            field
                .split(',')
                .any(|option| option.starts_with("hidepid=") && option != "hidepid=0")
        })
    })
}

fn readable_self(members: &[Identity]) -> Result<()> {
    let pid = std::process::id() as i32;
    if !members.iter().any(|p| p.pid == pid && !p.zombie) {
        return Err(refused());
    }
    Ok(())
}

pub fn flock_retry(fd: i32, operation: i32) -> Result<()> {
    retry_interrupted(|| {
        // SAFETY: caller retains ownership of the live descriptor across retries.
        if unsafe { libc::flock(fd, operation) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    })
}

fn retry_interrupted(mut operation: impl FnMut() -> Result<()>) -> Result<()> {
    loop {
        match operation() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

pub fn nonblocking(fd: &impl AsRawFd) -> Result<()> {
    // SAFETY: fcntl borrows a live descriptor and supplies integer flags only.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn timestamp() -> Result<String> {
    // SAFETY: time returns current seconds; gmtime_r writes one live tm struct,
    // strftime writes at most the supplied buffer length and retains no pointer.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::gmtime_r(&now, &mut tm).is_null() {
            return Err(refused());
        }
        let mut bytes = [0u8; 32];
        let count = libc::strftime(
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            c"%Y-%m-%dT%H:%M:%SZ".as_ptr(),
            &tm,
        );
        if count == 0 {
            return Err(refused());
        }
        Ok(std::str::from_utf8(&bytes[..count])
            .map_err(|_| refused())?
            .into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn flock_interruption_retries_but_other_errors_do_not() {
        let mut calls = 0;
        super::retry_interrupted(|| {
            calls += 1;
            if calls < 3 {
                Err(std::io::Error::from_raw_os_error(libc::EINTR))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(calls, 3);
        let error =
            super::retry_interrupted(|| Err(std::io::Error::from_raw_os_error(libc::EPERM)))
                .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EPERM));
    }

    #[test]
    fn unusable_census_refuses_before_launch() {
        assert!(super::readable_self(&[]).is_err());
        assert!(super::readable_self(&super::census().unwrap()).is_ok());
        #[cfg(target_os = "linux")]
        {
            assert!(super::restricted_mount(
                "1 2 0:1 / /proc rw - proc proc rw,hidepid=2"
            ));
            assert!(super::restricted_mount(
                "1 2 0:1 / /proc rw - proc proc rw,hidepid=invisible"
            ));
            assert!(!super::restricted_mount(
                "1 2 0:1 / /proc rw - proc proc rw,hidepid=0"
            ));
        }
    }

    #[test]
    fn eperm_requires_fresh_zombie_only_group_proof() {
        use super::*;
        let member = Identity {
            pid: 123,
            group: 123,
            session: 123,
            start: 1,
            uid: 0,
            zombie: true,
        };
        let denied = || io::Error::from_raw_os_error(libc::EPERM);
        assert!(group_signal_result(123, denied(), || Ok(vec![member.clone()])).is_ok());
        let mut live = member.clone();
        live.zombie = false;
        assert!(group_signal_result(123, denied(), || Ok(vec![member.clone(), live])).is_err());
        assert!(group_signal_result(123, denied(), || Err(refused())).is_err());
        assert!(
            group_signal_result(123, io::Error::from_raw_os_error(libc::EIO), || Ok(vec![]))
                .is_err()
        );
    }

    #[test]
    fn real_unreaped_group_is_not_live() {
        use super::*;
        // SAFETY: child uses only async-signal-safe calls and _exit, never Rust.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::setsid();
                libc::_exit(0);
            }
        }
        // Darwin getsid may return ESRCH for zombies, so inspect intentionally
        // reports absence. Observe exit without reaping through the wait API
        // instead of requiring a live-process identity for an exited child.
        let mut event = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: this is our direct child, event is a writable kernel buffer,
        // and WNOWAIT deliberately retains the child for the assertions below.
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    event.as_mut_ptr(),
                    libc::WEXITED | libc::WNOWAIT,
                )
            },
            0
        );
        assert!(!live_group(pid, None).unwrap());
        assert!(
            group_signal_result(pid, io::Error::from_raw_os_error(libc::EPERM), census).is_ok()
        );
        group_signal(pid, libc::SIGTERM).unwrap();
        let mut status = 0;
        // SAFETY: reap only our own still-unreaped child, with a valid status pointer.
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn non_utf8_process_name_does_not_invalidate_identity_fields() {
        assert_eq!(
            super::proc_stat_tail(b"42 (name\xff) nested) S 1 2 3").unwrap(),
            "S 1 2 3"
        );
        assert!(super::proc_stat_tail(b"42 (name) S \xff").is_err());
    }
    #[test]
    fn proc_exit_during_open_or_read_is_absent_not_census_failure() {
        for errno in [libc::ENOENT, libc::ESRCH] {
            assert!(super::absent_error(&std::io::Error::from_raw_os_error(
                errno
            )));
        }
        for errno in [libc::EPERM, libc::EIO] {
            assert!(!super::absent_error(&std::io::Error::from_raw_os_error(
                errno
            )));
        }
    }
}
