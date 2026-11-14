//! `Command` cannot request Apple's CLOEXEC_DEFAULT spawn attribute. Use
//! posix_spawn with explicit stdio actions; a runner-only mutex would not
//! protect pipes/files opened by GPUI or other libraries on other threads.

use std::collections::BTreeMap;
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitStatus};

fn check(code: libc::c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

fn cstring(value: &std::ffi::OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in process argument"))
}

struct Actions(libc::posix_spawn_file_actions_t);
impl Drop for Actions {
    fn drop(&mut self) {
        // SAFETY: initialized by posix_spawn_file_actions_init, owned once.
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut self.0);
        }
    }
}
struct Attributes(libc::posix_spawnattr_t);
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: initialized by posix_spawnattr_init, owned once.
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.0);
        }
    }
}

fn pipe() -> io::Result<(File, File)> {
    let mut fds = [-1; 2];
    // SAFETY: fds holds two writable descriptors; successful pipe transfers
    // ownership. CLOEXEC_DEFAULT prevents inheritance during the setup window.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: each successful pipe descriptor is uniquely owned here.
    let original = unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
    let duplicate = |file: &File| {
        // Keep action sources above stdio even when the parent has closed 0–2.
        // SAFETY: file is live; returned descriptor has independent ownership.
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: fcntl returned a new owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    };
    Ok((duplicate(&original.0)?, duplicate(&original.1)?))
}

pub(crate) struct Child {
    pid: libc::pid_t,
    status: Option<ExitStatus>,
    pub(crate) stdout: Option<File>,
    pub(crate) stderr: Option<File>,
}
impl Child {
    pub(crate) fn id(&self) -> u32 {
        self.pid as u32
    }
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_with(libc::WNOHANG)
    }
    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait_with(0)?
            .ok_or_else(|| io::Error::other("waitpid returned no status"))
    }
    fn wait_with(&mut self, options: libc::c_int) -> io::Result<Option<ExitStatus>> {
        if self.status.is_some() {
            return Ok(self.status);
        }
        loop {
            let mut status = 0;
            // SAFETY: pid is our unreaped child and status is writable.
            let result = unsafe { libc::waitpid(self.pid, &mut status, options) };
            if result == self.pid {
                self.status = Some(ExitStatus::from_raw(status));
                return Ok(self.status);
            }
            if result == 0 {
                return Ok(None);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    pub(crate) fn kill(&mut self) -> io::Result<()> {
        if self.status.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "child already reaped",
            ));
        }
        // SAFETY: pid is the child this object owns, not an arbitrary input.
        if unsafe { libc::kill(self.pid, libc::SIGKILL) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// The runner always supplies null stdin, piped outputs, and its own process
/// group. Environment overrides/removals and cwd come from the authored Command.
/// This boundary currently inherits the parent environment like CliRunner.
pub(crate) fn spawn(command: &mut Command) -> io::Result<Child> {
    let program = cstring(command.get_program())?;
    let args: Vec<CString> = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(cstring)
        .collect::<io::Result<_>>()?;
    let mut environment: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            environment.insert(key.into(), value.into());
        } else {
            environment.remove(key);
        }
    }
    let environment: Vec<CString> = environment
        .into_iter()
        .map(|(key, value)| {
            let mut assignment = key;
            assignment.push("=");
            assignment.push(value);
            cstring(&assignment)
        })
        .collect::<io::Result<_>>()?;
    let cwd = command
        .get_current_dir()
        .map(|p| cstring(p.as_os_str()))
        .transpose()?;
    let mut argv: Vec<*mut libc::c_char> = args.iter().map(|s| s.as_ptr().cast_mut()).collect();
    argv.push(std::ptr::null_mut());
    let mut envp: Vec<*mut libc::c_char> =
        environment.iter().map(|s| s.as_ptr().cast_mut()).collect();
    envp.push(std::ptr::null_mut());
    let (out, out_write) = pipe()?;
    let (err, err_write) = pipe()?;
    let null = CString::new("/dev/null").expect("fixed path");
    // SAFETY: the init calls initialize the opaque values before use. The
    // RAII wrappers destroy them on all later errors. All pointer buffers
    // and descriptor sources live through the synchronous spawn call.
    unsafe {
        let mut actions = MaybeUninit::uninit();
        check(libc::posix_spawn_file_actions_init(actions.as_mut_ptr()))?;
        let mut actions = Actions(actions.assume_init());
        let mut attributes = MaybeUninit::uninit();
        check(libc::posix_spawnattr_init(attributes.as_mut_ptr()))?;
        let mut attributes = Attributes(attributes.assume_init());
        check(libc::posix_spawn_file_actions_addopen(
            &mut actions.0,
            0,
            null.as_ptr(),
            libc::O_RDONLY,
            0,
        ))?;
        for (fd, target) in [(out_write.as_raw_fd(), 1), (err_write.as_raw_fd(), 2)] {
            check(libc::posix_spawn_file_actions_adddup2(
                &mut actions.0,
                fd,
                target,
            ))?;
            check(libc::posix_spawn_file_actions_addclose(&mut actions.0, fd))?;
        }
        if let Some(cwd) = &cwd {
            check(libc::posix_spawn_file_actions_addchdir_np(
                &mut actions.0,
                cwd.as_ptr(),
            ))?;
        }
        let mut defaults = MaybeUninit::<libc::sigset_t>::uninit();
        if libc::sigemptyset(defaults.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut defaults = defaults.assume_init();
        if libc::sigaddset(&mut defaults, libc::SIGPIPE) != 0 {
            return Err(io::Error::last_os_error());
        }
        check(libc::posix_spawnattr_setsigdefault(
            &mut attributes.0,
            &defaults,
        ))?;
        check(libc::posix_spawnattr_setflags(
            &mut attributes.0,
            (libc::POSIX_SPAWN_CLOEXEC_DEFAULT
                | libc::POSIX_SPAWN_SETPGROUP
                | libc::POSIX_SPAWN_SETSIGDEF) as _,
        ))?;
        check(libc::posix_spawnattr_setpgroup(&mut attributes.0, 0))?;
        let mut pid = 0;
        check(libc::posix_spawnp(
            &mut pid,
            program.as_ptr(),
            &actions.0,
            &attributes.0,
            argv.as_ptr(),
            envp.as_ptr(),
        ))?;
        Ok(Child {
            pid,
            status: None,
            stdout: Some(out),
            stderr: Some(err),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn unrelated_inheritable_descriptor_is_closed_in_child() {
        let file = File::open("/dev/null").unwrap();
        // Intentionally model another thread between opening an fd and
        // setting CLOEXEC. A high fd avoids incidental stdio reuse.
        // SAFETY: file is live; F_DUPFD returns an independently owned fd.
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 200) };
        assert!(fd >= 200);
        // SAFETY: fd is a new owned descriptor, retained through spawn.
        let inherited = unsafe { File::from_raw_fd(fd) };
        // SAFETY: the descriptor remains live and fcntl only inspects it.
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            &format!("if [ -e /dev/fd/{fd} ]; then printf inherited; else printf closed; fi"),
        ]);
        let control = command.output().unwrap();
        assert!(control.status.success());
        assert_eq!(
            control.stdout, b"inherited",
            "probe detects the old boundary"
        );
        let mut child = spawn(&mut command).unwrap();
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(output, "closed");
        assert!(
            inherited.metadata().is_ok(),
            "parent still owns the descriptor"
        );
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::DirBuilderExt;

    #[test]
    fn stdio_arguments_environment_cwd_and_process_group_are_preserved() {
        let dir = std::env::temp_dir().join(format!(
            "desktop-spawn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let canonical = dir.canonicalize().unwrap();
        let mut command = Command::new("/bin/sh");
        command.current_dir(&canonical).env("HACK_DESKTOP_PROCESS_TEST", "checked value").args([
            "-c", "printf '%s\\n' \"$1\" \"$HACK_DESKTOP_PROCESS_TEST\" \"$PWD\"; if read -r unused; then printf unexpected; else printf 'eof\\n'; fi; /bin/ps -o pgid= -p $$; printf diagnostic >&2",
            "fixture", "space and ' quote",
        ]);
        let mut child = spawn(&mut command).unwrap();
        let mut stdout = String::new();
        let mut stderr = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(child.wait().unwrap().success());
        let lines: Vec<_> = stdout.lines().collect();
        assert_eq!(
            lines[..4],
            [
                "space and ' quote",
                "checked value",
                canonical.to_str().unwrap(),
                "eof"
            ]
        );
        assert_eq!(lines[4].trim().parse::<u32>().unwrap(), child.id());
        assert_eq!(stderr, "diagnostic");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
