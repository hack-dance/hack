//! Diagnostic native identity plus a live parent's unreaped-child ownership guard.
use super::{Result, error};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub uid: u32,
    pub process_group: i32,
    pub start: u64,
    pub boot: String,
}

/// One native identity read of a PID.
///
/// `Gone` means the kernel itself reported that no live process entry exists for the
/// PID (`ESRCH` on Darwin, a missing `/proc/<pid>` on Linux). It never names an
/// identity, so it can never authorize a signal. Darwin reports `Gone` for a child
/// that is exiting or is an unreaped zombie, before `waitid(WNOWAIT)` publishes its
/// exit; Linux keeps zombies in `/proc` and reports `Gone` only after a reap. Every
/// other failure (short reads, permission, malformed metadata) stays an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observed {
    Present(ProcessIdentity),
    Gone,
}

/// Strict read for callers that require a present identity: `Gone` is an error.
pub fn observe(pid: i32) -> Result<ProcessIdentity> {
    match inspect(pid)? {
        Observed::Present(identity) => Ok(identity),
        Observed::Gone => Err(error("Native job process identity unavailable.")),
    }
}

#[cfg(target_os = "macos")]
pub fn inspect(pid: i32) -> Result<Observed> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: writable proc_bsdinfo buffer with its exact size.
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
        // Capture errno before any other call can replace it.
        let failure = std::io::Error::last_os_error();
        if size == 0 && failure.raw_os_error() == Some(libc::ESRCH) {
            return Ok(Observed::Gone);
        }
        return Err(error("Native job process identity unavailable."));
    }
    let info = unsafe { info.assume_init() };
    let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&boot);
    // SAFETY: read-only sysctl fills a correctly sized timeval.
    if unsafe {
        libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            (&mut boot as *mut libc::timeval).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(error("Host boot identity unavailable."));
    }
    Ok(Observed::Present(ProcessIdentity {
        pid,
        uid: info.pbi_uid,
        process_group: info.pbi_pgid as i32,
        start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        boot: format!("{}:{}", boot.tv_sec, boot.tv_usec),
    }))
}
#[cfg(target_os = "linux")]
pub fn inspect(pid: i32) -> Result<Observed> {
    use std::os::unix::fs::MetadataExt;
    // A reap can remove /proc/<pid> between these reads; ESRCH is that race on an
    // open procfs directory. Only those kernel answers mean Gone.
    let gone = |e: &std::io::Error| {
        e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ESRCH)
    };
    let path = format!("/proc/{pid}");
    let uid = match std::fs::metadata(&path) {
        Ok(metadata) => metadata.uid(),
        Err(e) if gone(&e) => return Ok(Observed::Gone),
        Err(e) => return Err(error(e)),
    };
    let stat = match std::fs::read_to_string(format!("{path}/stat")) {
        Ok(stat) => stat,
        Err(e) if gone(&e) => return Ok(Observed::Gone),
        Err(e) => return Err(error(e)),
    };
    let (_, fields) = stat
        .rsplit_once(')')
        .ok_or_else(|| error("Malformed process identity."))?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    let start = fields
        .get(19)
        .ok_or_else(|| error("Missing process start."))?
        .parse()
        .map_err(error)?;
    let process_group = fields
        .get(2)
        .ok_or_else(|| error("Missing process group."))?
        .parse()
        .map_err(error)?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(error)?
        .trim()
        .to_owned();
    if boot.is_empty() {
        return Err(error("Host boot identity unavailable."));
    }
    Ok(Observed::Present(ProcessIdentity {
        pid,
        uid,
        process_group,
        start,
        boot,
    }))
}

pub fn verify(recorded: &ProcessIdentity, observed: &ProcessIdentity) -> Result<()> {
    if recorded != observed
        || recorded.pid <= 1
        || recorded.start == 0
        || recorded.uid != unsafe { libc::geteuid() }
        || recorded.process_group != recorded.pid
    {
        return Err(error(
            "Owned child boot/start/UID/group identity mismatch; no signal sent.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::{CommandExt, ExitStatusExt};

    #[test]
    fn killed_and_reaped_child_reads_as_gone_never_as_an_identity() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "read line"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let live = observe(pid).unwrap();
        assert_eq!(inspect(pid).unwrap(), Observed::Present(live.clone()));
        verify(&live, &live).unwrap();
        // SAFETY: this test owns the unreaped child, so its PID cannot be reused yet.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            // SAFETY: WNOWAIT observes this test's own child without reaping it.
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                },
                0
            );
            #[cfg(target_os = "macos")]
            let exited = info.si_pid != 0;
            #[cfg(target_os = "linux")]
            let exited = unsafe { info.si_pid() } != 0;
            if exited {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "child did not exit");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // Killed but unreaped: Darwin withholds the zombie's metadata as ESRCH, while
        // Linux still exposes the zombie's unchanged launch identity in /proc.
        #[cfg(target_os = "macos")]
        assert_eq!(inspect(pid).unwrap(), Observed::Gone);
        #[cfg(target_os = "linux")]
        assert_eq!(inspect(pid).unwrap(), Observed::Present(live.clone()));
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        // Killed and reaped: the kernel has no entry on either platform. Gone carries
        // no identity, and the strict reader still refuses it.
        assert_eq!(inspect(pid).unwrap(), Observed::Gone);
        assert_eq!(
            observe(pid).unwrap_err().message,
            "Native job process identity unavailable."
        );
    }
    #[test]
    fn stale_boot_start_uid_or_group_never_authorizes_a_signal() {
        let identity = ProcessIdentity {
            pid: 40000,
            uid: unsafe { libc::geteuid() },
            process_group: 40000,
            start: 100,
            boot: "boot-a".into(),
        };
        verify(&identity, &identity).unwrap();
        for changed in [
            ProcessIdentity {
                boot: "boot-b".into(),
                ..identity.clone()
            },
            ProcessIdentity {
                start: 101,
                ..identity.clone()
            },
            ProcessIdentity {
                uid: identity.uid + 1,
                ..identity.clone()
            },
            ProcessIdentity {
                process_group: 40001,
                ..identity.clone()
            },
        ] {
            assert!(verify(&identity, &changed).is_err());
        }
    }
}
