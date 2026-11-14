use crate::{Result, refused};
#[cfg(target_os = "linux")]
use std::fs;
use std::{
    io,
    os::fd::AsRawFd,
    sync::atomic::{AtomicBool, Ordering},
};

pub static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}

pub fn signals() -> Result<()> {
    // SAFETY: sigaction is initialized, handler has C ABI and only stores an
    // atomic flag; the kernel copies the action and retains no Rust pointer.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
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
    use std::os::unix::fs::MetadataExt;
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
    let metadata = match fs::metadata(&path) {
        Ok(value) => value,
        Err(error) if absent_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(Identity {
        pid,
        group,
        session,
        start,
        uid: metadata.uid(),
        zombie: fields.first() == Some(&"Z") || fields.first() == Some(&"X"),
    }))
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
                // Authored commands retain this user's UID. Linux hidepid and
                // unrelated protected processes must not abort their census.
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) => {}
                Err(error) => return Err(error),
            }
        }
    }
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
    let session = unsafe { libc::getsid(pid) };
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
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => (),
            Err(error) => return Err(error),
        }
    }
    Ok(result)
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

/// A boot change or a reused leader PID proves the old session is gone. A
/// missing leader does not: descendants retain its SID and require a census.
pub fn recorded_live(state: &crate::storage::State, excluding_guard: bool) -> Result<bool> {
    if state.boot_id != boot()? {
        return Ok(false);
    }
    if let Some(identity) = inspect(state.guard_pid)?
        && (identity.start != state.guard_start_time
            || identity.uid != state.uid
            || identity.session != state.guard_pid)
    {
        return Ok(false);
    }
    live_group(state.guard_pid, excluding_guard.then_some(state.guard_pid))
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
        if state.boot_id != boot()? {
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
    let mut first_error = None;
    for member in members.iter().filter(|p| p.group == session) {
        if let Err(error) = signal_member(member, signal) {
            first_error.get_or_insert(error);
        }
    }
    for group in groups {
        if let Err(error) = group_signal(group, signal) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
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
        if current.start != expected.start
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
        if current.start != expected.start
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
    // Portable fallback is bounded by the process's descriptor limit and does
    // not allocate or retain descriptor references while closing them.
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    // SAFETY: getrlimit initializes one live rlimit value.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if limit.rlim_cur > 1_048_576 {
        return Err(refused());
    }
    for fd in 3..limit.rlim_cur as i32 {
        // SAFETY: startup owns no fd >=3; failed closes are harmless gaps.
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
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
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
