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
