//! Absence of a recorded incarnation never grants authority over its replacement.
use super::*;

/// Read birth time independently of executable lookup, including unreaped children.
#[cfg(target_os = "macos")]
pub(crate) fn birth(pid: i32) -> Result<(u64, u32), CandidateError> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: correctly sized writable output, initialized before inspection.
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            // Nonzero includes zombies: their birth still binds our direct
            // Child before try_wait reaps it. Executable lookup cannot do that.
            1,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if count as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Cannot read the recorded process incarnation. Run hack ps --json to inspect retained state.",
        ));
    }
    // SAFETY: a complete native record was returned into valid storage.
    let info = unsafe { info.assume_init() };
    let start = info
        .pbi_start_tvsec
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_add(info.pbi_start_tvusec))
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            CandidateError::new(
                "process_identity_unavailable",
                "Process birth time is unavailable. Run hack ps --json to inspect retained state.",
            )
        })?;
    Ok((start, info.pbi_uid))
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn birth(_pid: i32) -> Result<(u64, u32), CandidateError> {
    Err(CandidateError::new(
        "unsupported_host",
        "Native process birth inspection requires macOS.",
    ))
}

/// Whether `pid` is a zombie: it exited and its parent has not reaped it yet. It runs
/// nothing and holds no resources but its pid, which cannot be reused meanwhile.
#[cfg(target_os = "macos")]
fn zombie(pid: i32) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: correctly sized writable output; the nonzero argument includes zombies.
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            1,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    // SAFETY: inspected only when the complete record was returned.
    count as usize == std::mem::size_of::<libc::proc_bsdinfo>()
        && unsafe { info.assume_init() }.pbi_status == libc::SZOMB
}
#[cfg(not(target_os = "macos"))]
fn zombie(_pid: i32) -> bool {
    false
}

/// HACK-2579: whether the recorded provider is gone: its pid no longer exists, it is a
/// zombie (killed but not reaped by a parent that is still alive), or the pid now
/// belongs to another process (a different birth). An incarnation that cannot be
/// read is not gone; the caller's own identity checks then decide, as before.
pub(crate) fn provider_gone(recorded: &ProcessIdentity) -> Result<bool, CandidateError> {
    match alive(recorded.pid) {
        Ok(false) => return Ok(true),
        Ok(true) => {}
        // `kill 0` refused (EPERM): the pid belongs to a process we may not signal. A
        // readable birth under another uid or time proves the recorded provider gone.
        Err(error) => {
            return match birth(recorded.pid) {
                Ok((start, uid)) if start != recorded.start_micros || uid != recorded.uid => {
                    Ok(true)
                }
                _ => Err(error),
            };
        }
    }
    if zombie(recorded.pid) {
        return Ok(true);
    }
    Ok(birth(recorded.pid).is_ok_and(|(start, _)| start != recorded.start_micros))
}

pub(crate) fn incarnation_gone(recorded: &ProcessIdentity) -> Result<bool, CandidateError> {
    gone_with(recorded, || alive(recorded.pid), || birth(recorded.pid))
}
fn gone_with(
    recorded: &ProcessIdentity,
    alive: impl FnOnce() -> Result<bool, CandidateError>,
    birth: impl FnOnce() -> Result<(u64, u32), CandidateError>,
) -> Result<bool, CandidateError> {
    if matches!(alive(), Ok(false)) {
        return Ok(true);
    }
    // UID/executable differences cannot authorize touching a live process. A
    // readable different birth alone proves the recorded incarnation is gone.
    Ok(birth()?.0 != recorded.start_micros)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HACK-2579 (macOS): a provider killed while its parent is still alive stays a
    /// zombie until reaped. `kill 0` still succeeds on it, but it is gone; a live
    /// process is not, and neither is anything once reaped and its pid unused.
    #[cfg(target_os = "macos")]
    #[test]
    fn provider_gone_sees_a_killed_unreaped_child_as_gone() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let recorded = super::super::observe(pid).unwrap();
        assert!(
            !provider_gone(&recorded).unwrap(),
            "a live child is not gone"
        );
        // SAFETY: signalling our own child process.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !zombie(pid) {
            assert!(std::time::Instant::now() < deadline, "no zombie appeared");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(alive(pid).unwrap(), "kill 0 still answers for a zombie");
        assert!(provider_gone(&recorded).unwrap(), "a zombie is gone");
        child.wait().unwrap();
        assert!(provider_gone(&recorded).unwrap(), "a reaped child is gone");
        // Another incarnation under the recorded pid (a different birth) is gone too.
        let mut other = recorded.clone();
        other.start_micros += 1;
        let live = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut reused = super::super::observe(live.id() as i32).unwrap();
        reused.start_micros = other.start_micros;
        assert!(provider_gone(&reused).unwrap(), "a different birth is gone");
        let mut live = live;
        let _ = live.kill();
        let _ = live.wait();
    }
    #[test]
    fn replacement_birth_is_absent_but_unreadable_identity_is_not() {
        let recorded = ProcessIdentity {
            pid: 123,
            start_micros: 10,
            uid: 1,
            executable: "/unused/publisher".into(),
        };
        assert!(
            gone_with(
                &recorded,
                || Ok(false),
                || panic!("absent PID needs no identity")
            )
            .unwrap()
        );
        assert!(gone_with(&recorded, || Ok(true), || Ok((11, 2))).unwrap());
        assert!(
            gone_with(
                &recorded,
                || Err(CandidateError::new(
                    "process_identity_unavailable",
                    "permission"
                )),
                || Ok((11, 2))
            )
            .unwrap()
        );
        assert!(!gone_with(&recorded, || Ok(true), || Ok((10, 1))).unwrap());
        assert!(
            gone_with(
                &recorded,
                || Ok(true),
                || Err(CandidateError::new(
                    "process_identity_unavailable",
                    "unreadable"
                ))
            )
            .is_err()
        );
    }
}
