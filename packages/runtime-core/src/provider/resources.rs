//! Native live-process accounting. Snapshots are not lifetime or unique-page accounting.
pub use super::identity::ProcessIdentity;
use crate::CandidateError;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ProcessUsage {
    pub identity: ProcessIdentity,
    pub resident_bytes: u64,
    pub physical_footprint_bytes: u64,
    pub user_cpu_nanoseconds: u64,
    pub system_cpu_nanoseconds: u64,
    pub disk_read_bytes: u64,
    pub disk_written_bytes: u64,
    pub idle_wakeups: u64,
}

#[derive(Debug, Serialize)]
pub struct ResourceTree {
    pub scope: &'static str,
    pub observation_microseconds: u64,
    pub processes: Vec<ProcessUsage>,
}

/// Bind an explicitly selected, same-user process to its native identity before sampling.
/// This grants no lifecycle authority over the selected process.
pub fn bind(pid: i32, executable: &std::path::Path) -> Result<ProcessIdentity, CandidateError> {
    let observed = super::identity::observe(pid)?;
    super::identity::verify(&observed, &observed, executable, unsafe { libc::geteuid() })?;
    Ok(observed)
}

#[cfg(target_os = "macos")]
fn cpu_nanoseconds(ticks: u64) -> Result<u64, CandidateError> {
    // Stable two-u32 SDK ABI; libc deprecates its Mach bindings in favor of another crate.
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    let mut base = Timebase { numer: 0, denom: 0 };
    // proc_pid_rusage CPU counters are Mach absolute time, including on Apple Silicon.
    if unsafe { mach_timebase_info(&mut base) } != 0 || base.numer == 0 || base.denom == 0 {
        return Err(CandidateError::new(
            "resource_observation_unavailable",
            "Native CPU timebase is unavailable.",
        ));
    }
    u64::try_from(u128::from(ticks) * u128::from(base.numer) / u128::from(base.denom)).map_err(
        |_| {
            CandidateError::new(
                "resource_observation_unavailable",
                "Native CPU counter overflow.",
            )
        },
    )
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::provider::identity;
    use std::collections::BTreeMap;

    const LIMIT: usize = 64;
    fn unavailable() -> CandidateError {
        CandidateError::new(
            "resource_observation_unavailable",
            "Native resource tree changed, exceeded 64 processes, or could not be observed; no partial total is reported.",
        )
    }

    fn children(pid: i32) -> Result<Vec<i32>, CandidateError> {
        let mut pids = [0i32; LIMIT + 1];
        // libproc returns a PID count here (unlike proc_listpids, which returns bytes).
        // Clear errno because its wrapper maps a syscall failure to zero children.
        unsafe { *libc::__error() = 0 };
        let count = unsafe {
            libc::proc_listchildpids(
                pid,
                pids.as_mut_ptr().cast(),
                std::mem::size_of_val(&pids) as i32,
            )
        };
        if count < 0 || count as usize > LIMIT || unsafe { *libc::__error() } != 0 {
            return Err(unavailable());
        }
        let mut result = pids[..count as usize].to_vec();
        if result.iter().any(|p| *p <= 1) {
            return Err(unavailable());
        }
        result.sort_unstable();
        result.dedup();
        Ok(result)
    }

    fn inventory(root: &ProcessIdentity) -> Result<BTreeMap<i32, ProcessIdentity>, CandidateError> {
        identity::verify(
            root,
            &identity::observe(root.pid)?,
            &root.executable,
            unsafe { libc::geteuid() },
        )?;
        let mut found = BTreeMap::new();
        let mut pending = vec![root.clone()];
        while let Some(current) = pending.pop() {
            if found.len() >= LIMIT || found.contains_key(&current.pid) || current.uid != root.uid {
                return Err(unavailable());
            }
            identity::verify(
                &current,
                &identity::observe(current.pid)?,
                &current.executable,
                root.uid,
            )?;
            for pid in children(current.pid)? {
                pending.push(identity::observe(pid)?);
            }
            found.insert(current.pid, current);
        }
        Ok(found)
    }

    pub(super) fn observe(root: &ProcessIdentity) -> Result<ResourceTree, CandidateError> {
        let start = std::time::Instant::now();
        let before = inventory(root)?;
        let mut processes = Vec::new();
        for id in before.values() {
            let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
            // SAFETY: correctly sized writable native V2 resource record.
            if unsafe {
                libc::proc_pid_rusage(id.pid, libc::RUSAGE_INFO_V2, usage.as_mut_ptr().cast())
            } != 0
            {
                return Err(unavailable());
            }
            let usage = unsafe { usage.assume_init() };
            identity::verify(id, &identity::observe(id.pid)?, &id.executable, root.uid)?;
            processes.push(ProcessUsage {
                identity: id.clone(),
                resident_bytes: usage.ri_resident_size,
                physical_footprint_bytes: usage.ri_phys_footprint,
                user_cpu_nanoseconds: cpu_nanoseconds(usage.ri_user_time)?,
                system_cpu_nanoseconds: cpu_nanoseconds(usage.ri_system_time)?,
                disk_read_bytes: usage.ri_diskio_bytesread,
                disk_written_bytes: usage.ri_diskio_byteswritten,
                idle_wakeups: usage.ri_pkg_idle_wkups,
            });
        }
        if before != inventory(root)? {
            return Err(unavailable());
        }
        Ok(ResourceTree {
            scope: "selected-root-and-current-descendants; excludes exited/reparented helpers and observer; memory sums may share pages; compare CPU deltas only across identical identities",
            observation_microseconds: start.elapsed().as_micros().min(u64::MAX as u128) as u64,
            processes,
        })
    }
}

pub fn observe(root: &ProcessIdentity) -> Result<ResourceTree, CandidateError> {
    #[cfg(target_os = "macos")]
    {
        native::observe(root)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        Err(CandidateError::new(
            "unsupported_host",
            "Native provider resource accounting requires macOS.",
        ))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::provider::identity;
    #[test]
    fn explicit_root_binding_requires_exact_executable() {
        let pid = std::process::id() as i32;
        let path = std::env::current_exe().unwrap();
        let root = bind(pid, &path).unwrap();
        assert_eq!(root, identity::observe(pid).unwrap());
        assert!(bind(pid, std::path::Path::new("/wrong/executable")).is_err());
        assert!(bind(1, &path).is_err());
    }

    #[test]
    fn owned_tree_includes_live_child_and_refuses_stale_root() {
        let mut child = std::process::Command::new("/bin/bash")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .unwrap();
        let root = identity::observe(child.id() as i32).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let result = loop {
            if let Ok(tree) = observe(&root) {
                if tree.processes.len() == 2 {
                    break tree;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{:#?} root={root:?} current={:?}",
                observe(&root),
                identity::observe(root.pid)
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(
            result
                .processes
                .iter()
                .all(|p| p.resident_bytes > 0 && p.physical_footprint_bytes > 0)
        );
        let stale = ProcessIdentity {
            start_micros: root.start_micros + 1,
            ..root.clone()
        };
        assert!(observe(&stale).is_err());
        for process in &result.processes {
            if process.identity.pid != root.pid {
                identity::terminate(&process.identity, &process.identity.executable).unwrap();
            }
        }
        // The shell exits after reaping its terminated child.
        child.wait().unwrap();
    }

    #[test]
    fn cpu_counter_advances_in_nanoseconds_under_work() {
        let root = identity::observe(std::process::id() as i32).unwrap();
        // Observe only this process's counter so unrelated parallel test children do not matter.
        let read = || {
            let mut value = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
            assert_eq!(
                unsafe {
                    libc::proc_pid_rusage(root.pid, libc::RUSAGE_INFO_V2, value.as_mut_ptr().cast())
                },
                0
            );
            let value = unsafe { value.assume_init() };
            cpu_nanoseconds(value.ri_user_time + value.ri_system_time).unwrap()
        };
        let cpu_clock = || {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
            assert_eq!(
                unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
                0
            );
            let usage = unsafe { usage.assume_init() };
            ((usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as u64) * 1_000_000_000
                + ((usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as u64) * 1000
        };
        let before = read();
        let clock_before = cpu_clock();
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(40) {
            std::hint::black_box(123u64.wrapping_mul(456));
        }
        let native_delta = read() - before;
        let clock_delta = cpu_clock() - clock_before;
        assert!(native_delta > 1_000_000);
        assert!(
            native_delta > clock_delta / 2 && native_delta < clock_delta * 2,
            "native={native_delta}, clock={clock_delta}"
        );
    }
}
