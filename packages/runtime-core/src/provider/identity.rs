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
