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
    Ok(Observed::Present(ProcessIdentity {
        pid,
        uid: info.pbi_uid,
        process_group: info.pbi_pgid as i32,
        // XNU snapshots p_start from calendar time once, at fork, and never rewrites
        // it: a later clock step leaves a live process's start unchanged, and only a
        // new process (a reused PID) gets a new value.
        start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        boot: boot_session()?,
    }))
}

/// This boot's incarnation: `kern.bootsessionuuid`, the Darwin peer of Linux `boot_id`.
///
/// `kern.boottime` is calendar time, and XNU moves it whenever the wall clock is
/// stepped (`timed` calls `settimeofday` routinely), so it never names a boot. An
/// unavailable or malformed session is an error; there is no calendar fallback.
#[cfg(target_os = "macos")]
fn boot_session() -> Result<String> {
    let mut buffer = [0u8; 37];
    let length = host::sysctl(c"kern.bootsessionuuid", &mut buffer)
        .map_err(|_| error("Host boot identity unavailable."))?;
    // XNU publishes uppercase UUID text with its terminating NUL.
    match &buffer[..length] {
        [text @ .., 0] => std::str::from_utf8(text).ok(),
        _ => None,
    }
    .map(str::to_ascii_lowercase)
    .filter(|text| canonical_boot(text))
    .ok_or_else(|| error("Host boot identity unavailable."))
}

/// Native host reads behind one seam, so tests can simulate host changes (a clock
/// step, a new boot session, a refused sysctl) without touching the host.
#[cfg(target_os = "macos")]
mod host {
    /// Reads one sysctl into `buffer` and returns the byte length written.
    pub(super) fn sysctl(name: &std::ffi::CStr, buffer: &mut [u8]) -> std::io::Result<usize> {
        #[cfg(test)]
        if let Some(value) = test::value(name) {
            let value = value.ok_or_else(|| std::io::Error::from_raw_os_error(libc::ENOENT))?;
            if value.len() > buffer.len() {
                return Err(std::io::Error::from_raw_os_error(libc::ENOMEM));
            }
            buffer[..value.len()].copy_from_slice(&value);
            return Ok(value.len());
        }
        let mut length = buffer.len();
        // SAFETY: the read-only sysctl writes at most this live buffer's length; its
        // size pointer is live, newp is null, and no pointer is retained.
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(length)
    }

    #[cfg(test)]
    pub(super) mod test {
        use std::{cell::RefCell, collections::BTreeMap};
        type Values = BTreeMap<String, Option<Vec<u8>>>;
        thread_local! {
            static VALUES: RefCell<Option<Values>> = const { RefCell::new(None) };
        }
        pub(in super::super) fn value(name: &std::ffi::CStr) -> Option<Option<Vec<u8>>> {
            VALUES.with(|cell| cell.borrow().as_ref()?.get(name.to_str().ok()?).cloned())
        }
        /// This thread's sysctl overrides; names never set still read the real host.
        pub(in super::super) struct Host(Option<Values>);
        impl Host {
            pub(in super::super) fn new() -> Self {
                Self(VALUES.with(|cell| cell.replace(Some(Values::new()))))
            }
            /// `None` makes the sysctl fail as if the host refused it.
            pub(in super::super) fn set(&self, name: &str, value: Option<&[u8]>) {
                VALUES.with(|cell| {
                    cell.borrow_mut()
                        .as_mut()
                        .expect("override active")
                        .insert(name.into(), value.map(<[u8]>::to_vec))
                });
            }
        }
        impl Drop for Host {
            fn drop(&mut self) {
                VALUES.with(|cell| cell.replace(self.0.take()));
            }
        }
    }
}

/// A canonical lowercase, nonzero UUID: the only boot form either platform records.
fn canonical_boot(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, byte)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
        && bytes
            .iter()
            .any(|byte| matches!(byte, b'1'..=b'9' | b'a'..=b'f'))
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
    if !canonical_boot(&boot) {
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

/// Exact match of a launch identity against a fresh observation of the same PID.
///
/// A recorded boot that is not a canonical boot UUID is refused first. Builds before
/// HACK-1429 recorded Darwin boots as `kern.boottime` text (`seconds:micros`), which
/// names no stable boot, so such an identity never authorizes a signal, not even
/// against an observation in the same retired format. Receipts keep that value only
/// as diagnostic history; nothing migrates it.
pub fn verify(recorded: &ProcessIdentity, observed: &ProcessIdentity) -> Result<()> {
    if !canonical_boot(&recorded.boot) {
        return Err(error(
            "Owned child identity uses a retired boot format; no signal sent.",
        ));
    }
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
            boot: "0f1e2d3c-4b5a-4968-8776-655443322110".into(),
        };
        verify(&identity, &identity).unwrap();
        for changed in [
            ProcessIdentity {
                boot: "0f1e2d3c-4b5a-4968-8776-655443322111".into(),
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

    /// An owned, unreaped group leader: its PID cannot be reused while the test runs.
    struct Leader(std::process::Child);
    impl Leader {
        fn spawn() -> Self {
            Self(
                std::process::Command::new("/bin/sh")
                    .args(["-c", "read line"])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            )
        }
        fn pid(&self) -> i32 {
            self.0.id() as i32
        }
    }
    impl Drop for Leader {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_wall_clock_step_keeps_the_owned_identity_and_a_new_boot_session_refuses() {
        let child = Leader::spawn();
        let host = host::test::Host::new();
        // Darwin's timeval: 64-bit seconds, 32-bit microseconds, 4 padding bytes.
        let calendar_boot = |micros: i64| {
            let mut bytes = (micros / 1_000_000).to_ne_bytes().to_vec();
            bytes.extend(((micros % 1_000_000) as i32).to_ne_bytes());
            bytes.extend([0; 4]);
            bytes
        };
        let booted = 1_700_000_000_250_000;
        host.set("kern.boottime", Some(&calendar_boot(booted)[..]));
        host.set(
            "kern.bootsessionuuid",
            Some(&b"4F1C2B3A-5D6E-4F70-8192-A3B4C5D6E7F3\0"[..]),
        );
        let spawned = observe(child.pid()).unwrap();
        assert_eq!(spawned.boot, "4f1c2b3a-5d6e-4f70-8192-a3b4c5d6e7f3");
        verify(&spawned, &spawned).unwrap();
        // `timed` steps the wall clock with settimeofday (HACK-1429: -73 ms, 15 ms
        // after spawn), and XNU moves kern.boottime by the same step either way.
        for step in [-73_000, 234_785, -5_000_000] {
            host.set("kern.boottime", Some(&calendar_boot(booted + step)[..]));
            let stepped = observe(child.pid()).unwrap();
            assert_eq!(stepped, spawned);
            verify(&spawned, &stepped).unwrap();
        }
        // A different boot session is a different incarnation: refused.
        host.set(
            "kern.bootsessionuuid",
            Some(&b"4F1C2B3A-5D6E-4F70-8192-A3B4C5D6E7F4\0"[..]),
        );
        assert_eq!(
            verify(&spawned, &observe(child.pid()).unwrap())
                .unwrap_err()
                .message,
            "Owned child boot/start/UID/group identity mismatch; no signal sent."
        );
        // An unavailable or malformed session fails closed; calendar time is never a
        // fallback, even though kern.boottime still reads.
        for session in [
            None,
            Some(&b""[..]),
            Some(&b"4F1C2B3A-5D6E-4F70-8192-A3B4C5D6E7F3"[..]),
            Some(&b"00000000-0000-0000-0000-000000000000\0"[..]),
            Some(&b"4F1C2B3A_5D6E-4F70-8192-A3B4C5D6E7F3\0"[..]),
            Some(&b"4F1C2B3A-5D6E-4F70-8192-A3B4C5D6E7FG\0"[..]),
        ] {
            host.set("kern.bootsessionuuid", session);
            assert_eq!(
                inspect(child.pid()).unwrap_err().message,
                "Host boot identity unavailable."
            );
        }
        drop(host);
        // The real host's session is canonical and stable, and start is the kernel's
        // own fork-time snapshot, independent of every simulated host value.
        let real = observe(child.pid()).unwrap();
        assert!(canonical_boot(&real.boot), "{real:?}");
        assert_eq!(real.start, spawned.start);
        assert_eq!(real, observe(child.pid()).unwrap());
    }

    #[test]
    fn an_identity_recorded_in_the_retired_calendar_boot_format_never_authorizes_a_signal() {
        let child = Leader::spawn();
        let live = observe(child.pid()).unwrap();
        verify(&live, &live).unwrap();
        // A pre-upgrade Darwin receipt (boot = kern.boottime "seconds:micros") still
        // deserializes, so journals holding in-flight or historical jobs stay readable.
        let legacy: ProcessIdentity = serde_json::from_value(serde_json::json!({
            "pid": live.pid,
            "uid": live.uid,
            "process_group": live.process_group,
            "start": live.start,
            "boot": "1700000000:250000",
        }))
        .unwrap();
        // It names no stable boot, so it refuses against this same live child and
        // against an observer that still reports the retired format.
        for observed in [&live, &legacy] {
            assert_eq!(
                verify(&legacy, observed).unwrap_err().message,
                "Owned child identity uses a retired boot format; no signal sent."
            );
        }
    }
}
