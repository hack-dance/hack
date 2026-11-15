//! Finding and signalling the processes of one session.
//!
//! A session started with `setsid()` has `sid == pgid == leader pid`. An
//! interactive shell moves each job into its own process group inside that
//! session, so signalling only the leader's group would miss them. These
//! helpers list live (non-zombie) session members from the OS process table:
//! `/proc` on Linux; on macOS, `proc_listallpids` filtered by `getsid` with
//! `proc_pidinfo` to skip zombies.

/// Live processes whose session id is `leader`, excluding zombies.
pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
    imp::members(leader)
}

/// Send `sig` to the leader's process group and to every live session member.
pub fn signal_session(leader: libc::pid_t, sig: libc::c_int) {
    // SAFETY: kill with a negative pid signals a process group; errors
    // (ESRCH when the group is empty) are expected and ignored.
    unsafe {
        libc::kill(-leader, sig);
    }
    for pid in members(leader) {
        // SAFETY: plain kill; a pid that exited meanwhile gives ESRCH.
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

/// Whether `pid` is a live (non-zombie) process.
pub fn is_alive(pid: libc::pid_t) -> bool {
    imp::is_alive(pid)
}

#[cfg(target_os = "linux")]
mod imp {
    /// (state, session) from `/proc/<pid>/stat`.
    fn stat(pid: libc::pid_t) -> Option<(char, libc::pid_t)> {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm may contain spaces and parentheses; fields resume after the last ')'.
        let rest = &text[text.rfind(')')? + 1..];
        let mut fields = rest.split_ascii_whitespace();
        let state = fields.next()?.chars().next()?;
        let _ppid = fields.next()?;
        let _pgrp = fields.next()?;
        let session = fields.next()?.parse().ok()?;
        Some((state, session))
    }

    pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<libc::pid_t>().ok())
            .filter(
                |&pid| matches!(stat(pid), Some((s, sid)) if sid == leader && s != 'Z' && s != 'X'),
            )
            .collect()
    }

    pub fn is_alive(pid: libc::pid_t) -> bool {
        matches!(stat(pid), Some((s, _)) if s != 'Z' && s != 'X')
    }
}

#[cfg(target_os = "macos")]
mod imp {
    /// `SZOMB` from `<sys/proc.h>`.
    const SZOMB: u32 = 5;

    fn bsd_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
        // SAFETY: proc_bsdinfo is plain old data.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
        // SAFETY: the buffer is one proc_bsdinfo of `size` bytes.
        let n = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        (n == size).then_some(info)
    }

    fn all_pids() -> Vec<libc::pid_t> {
        for _ in 0..4 {
            // SAFETY: a null buffer asks for the current count.
            let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            let Ok(n) = usize::try_from(n) else {
                return Vec::new();
            };
            let mut buf: Vec<libc::pid_t> = vec![0; n + 64];
            let Ok(bytes) = libc::c_int::try_from(buf.len() * std::mem::size_of::<libc::pid_t>())
            else {
                return Vec::new();
            };
            // SAFETY: the buffer holds `bytes` bytes; the result is a pid count.
            let got = unsafe { libc::proc_listallpids(buf.as_mut_ptr().cast(), bytes) };
            let Ok(got) = usize::try_from(got) else {
                return Vec::new();
            };
            if got < buf.len() {
                buf.truncate(got);
                return buf;
            }
        }
        Vec::new()
    }

    pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
        all_pids()
            .into_iter()
            .filter(|&pid| pid > 0)
            // SAFETY: getsid only reads the process table.
            .filter(|&pid| unsafe { libc::getsid(pid) } == leader)
            .filter(|&pid| is_alive(pid))
            .collect()
    }

    pub fn is_alive(pid: libc::pid_t) -> bool {
        bsd_info(pid).is_some_and(|i| i.pbi_status != SZOMB)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    pub fn members(_leader: libc::pid_t) -> Vec<libc::pid_t> {
        Vec::new()
    }

    pub fn is_alive(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }
}
