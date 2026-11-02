//! Hold one backend ownership lease across exec, without a resident launcher.
#[path = "mcp_artifact/mod.rs"]
mod artifact;
#[path = "mcp_owner/recovery.rs"]
mod recovery;
#[path = "mcp_owner/supervision.rs"]
mod supervision;

use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

fn error(message: &'static str) -> io::Error {
    io::Error::other(message)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("hack MCP owner: {error}");
        let busy_detached = error.kind() == io::ErrorKind::WouldBlock
            && std::env::args_os()
                .nth(1)
                .is_some_and(|arg| arg == "--detach");
        std::process::exit(if busy_detached { 75 } else { 1 });
    }
}

fn run() -> io::Result<()> {
    let all_args: Vec<_> = std::env::args_os().skip(1).collect();
    if artifact::describe(&all_args, "owner") {
        return Ok(());
    }
    let detach = all_args.first().is_some_and(|arg| arg == "--detach");
    let offset = usize::from(detach);
    let supervise = all_args.get(offset).is_some_and(|arg| arg == "--supervise");
    let args = &all_args[offset + usize::from(supervise)..];
    if args.len() < 4 || args[0] != "--directory" || args[2] != "--" {
        return Err(error(
            "usage: [--detach] [--supervise] --directory PRIVATE_DIRECTORY -- ABSOLUTE_COMMAND [ARGS]",
        ));
    }
    let directory = Path::new(&args[1]);
    let executable = Path::new(&args[3]);
    if !directory.is_absolute() || !executable.is_absolute() {
        return Err(error("directory and command must be absolute"));
    }
    let directory = fs::canonicalize(directory)?;
    // Reject aliases rather than handing an inherited descriptor to another root.
    if directory != Path::new(&args[1]) {
        return Err(error("directory must be canonical"));
    }
    let parent = fs::symlink_metadata(&directory)?;
    // SAFETY: geteuid takes no pointers and has no caller preconditions.
    let uid = unsafe { libc::geteuid() };
    if !parent.is_dir() || parent.uid() != uid || parent.mode() & 0o077 != 0 {
        return Err(error(
            "ownership directory must be private and owned by this user",
        ));
    }
    let path = directory.join(".mcp-lease");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.len() != 0
    {
        return Err(error("unsafe backend lease file"));
    }
    let fd = file.as_raw_fd();
    // SAFETY: file owns the live descriptor; flock retains no pointer. Never wait
    // or unlink the stable inode: a loser must not replace another owner's lock.
    if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let failure = io::Error::last_os_error();
        return Err(io::Error::new(
            failure.kind(),
            "backend ownership is busy or unavailable",
        ));
    }
    let current = fs::symlink_metadata(&path)?;
    let current_parent = fs::symlink_metadata(&directory)?;
    if current.dev() != metadata.dev()
        || current.ino() != metadata.ino()
        || current_parent.dev() != parent.dev()
        || current_parent.ino() != parent.ino()
    {
        return Err(error("backend ownership path changed"));
    }
    recovery::recover(&directory, &parent, &metadata, uid)?;
    // SAFETY: fcntl operates on the owned fd. Clear CLOEXEC only for the lease so
    // the backend, not a launcher parent or polling helper, retains the kernel lock.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
        return Err(error("cannot transfer backend ownership"));
    }
    let mut command = Command::new(executable);
    if supervise {
        // The separator shifts the absolute directory into the old entrypoint's
        // numeric timeout position, forcing refusal before it can publish. New
        // entrypoints explicitly parse this versioned supervision prefix. V2
        // requires inherited blocking-I/O deadlines for early channel watchers.
        command.arg("--startup-supervised-v2").arg("--");
    }
    command
        .args(&args[4..])
        .env("HACK_MCP_LEASE_FD", fd.to_string())
        .env("HACK_MCP_LEASE_DIRECTORY", &directory);
    if detach || supervise {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    if detach && !detach_backend()? {
        // Closing this reference must not explicitly unlock the shared open
        // file description: the detached descendant now owns the lease.
        return Ok(());
    }
    if supervise {
        let result = supervision::run(&mut command);
        if result.is_err() {
            // Supervision reaps an ungranted child before returning. Recovery
            // remains witnessed and under our lease; ambiguous state is preserved.
            recovery::recover(&directory, &parent, &metadata, uid)?;
        }
        return result;
    }
    let result = command.exec();
    // On exec failure the owned File closes here, releasing the lock.
    // The stable lease file remains available for the next explicit start.
    drop(file);
    Err(result)
}

/// Return only in the original parent (false) or detached backend (true).
/// This binary is single-threaded before fork. Prepare Command and its arguments
/// first; no multi-threaded runtime or user callbacks may precede this boundary.
fn detach_backend() -> io::Result<bool> {
    // SAFETY: fork has no pointer arguments. No other threads hold Rust/runtime
    // locks; the child retains the lease's open file description across both forks.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(error("cannot detach backend"));
    }
    if child > 0 {
        let mut status = 0;
        loop {
            // SAFETY: child is our unreaped direct child and status is writable.
            if unsafe { libc::waitpid(child, &mut status, 0) } >= 0 {
                break;
            }
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(error("cannot reap backend launcher"));
            }
        }
        if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
            return Err(error("backend detach failed"));
        }
        return Ok(false);
    }
    // SAFETY: this fork child is not a process-group leader. A second fork makes
    // the backend independent of the adapter and unable to acquire a controlling
    // terminal. The intermediary uses _exit, avoiding inherited cleanup handlers.
    unsafe {
        if libc::setsid() < 0 {
            libc::_exit(1);
        }
        let backend = libc::fork();
        if backend < 0 {
            libc::_exit(1);
        }
        if backend > 0 {
            libc::_exit(0);
        }
    }
    Ok(true)
}
