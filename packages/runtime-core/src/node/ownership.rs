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

#[cfg(target_os = "macos")]
pub fn observe(pid: i32) -> Result<ProcessIdentity> {
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
    Ok(ProcessIdentity {
        pid,
        uid: info.pbi_uid,
        process_group: info.pbi_pgid as i32,
        start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        boot: format!("{}:{}", boot.tv_sec, boot.tv_usec),
    })
}
#[cfg(target_os = "linux")]
pub fn observe(pid: i32) -> Result<ProcessIdentity> {
    use std::os::unix::fs::MetadataExt;
    let path = format!("/proc/{pid}");
    let uid = std::fs::metadata(&path).map_err(error)?.uid();
    let stat = std::fs::read_to_string(format!("{path}/stat")).map_err(error)?;
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
    Ok(ProcessIdentity {
        pid,
        uid,
        process_group,
        start,
        boot,
    })
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
