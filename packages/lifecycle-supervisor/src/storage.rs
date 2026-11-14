use crate::{Result, refused};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub version: u32,
    pub name: String,
    pub owner_token: String,
    pub guard_pid: i32,
    pub process_group_id: i32,
    pub guard_start_time: u64,
    pub boot_id: String,
    pub uid: u32,
    pub command_pid: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_start_time: Option<u64>,
    pub phase: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<i32>,
}

/// Operations use an opened O_NOFOLLOW directory and relative openat/renameat;
/// changing a pathname after admission cannot redirect state/log writes.
pub struct Root {
    directory: File,
    pub path: PathBuf,
}

impl Root {
    fn retirement_key(token: &str) -> String {
        // Stable non-authentication index. A collision can only refuse launch.
        let hash = token.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
        format!(".retired-{hash:016x}")
    }

    pub fn retire(&self, token: &str) -> Result<()> {
        self.file(&Self::retirement_key(token), libc::O_WRONLY | libc::O_CREAT)?
            .sync_all()?;
        self.directory.sync_all()
    }

    pub fn assert_not_retired(&self, token: &str) -> Result<()> {
        match self.file(&Self::retirement_key(token), libc::O_RDONLY) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(refused()),
        }
    }

    pub fn open(path: &Path) -> Result<Self> {
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let metadata = directory.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(refused());
        }
        Ok(Self {
            directory,
            path: path.into(),
        })
    }

    pub fn file(&self, name: &str, flags: i32) -> Result<File> {
        let name = std::ffi::CString::new(name).map_err(|_| refused())?;
        // SAFETY: directory descriptor is live; name is NUL-terminated; returned
        // descriptor is newly owned and immediately wrapped in RAII.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd was just returned by openat and has no other owner.
        let file = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        let metadata = file.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
            || metadata.mode() & 0o777 != 0o600
        {
            return Err(refused());
        }
        Ok(file)
    }

    pub fn lock(&self, name: &str) -> Result<File> {
        let file = self.file(name, libc::O_RDWR | libc::O_CREAT)?;
        // SAFETY: flock operates only on this live descriptor.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(refused());
        }
        Ok(file)
    }

    pub fn lock_wait(&self, name: &str) -> Result<File> {
        let file = self.file(name, libc::O_RDWR | libc::O_CREAT)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            // SAFETY: flock only borrows the live owned descriptor.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(file);
            }
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ) {
                return Err(error);
            }
            if std::time::Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Lifecycle lock wait expired",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    pub fn save(&self, state: &State) -> Result<()> {
        let final_name = format!("{}.json", state.name);
        // Refuse unsafe pre-existing targets before atomically replacing an owned
        // regular receipt. Never truncate through a link.
        match self.file(&final_name, libc::O_RDONLY) {
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut attempts = 0;
        let (temporary_name, mut temporary) = loop {
            attempts += 1;
            if attempts > 16 {
                return Err(refused());
            }
            let clock = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| refused())?
                .as_nanos();
            let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let name = format!(
                ".{}.{}.{clock}.{serial}.tmp",
                state.name,
                std::process::id()
            );
            match self.file(&name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL) {
                Ok(file) => break (name, file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        let bytes = serde_json::to_vec(state).map_err(|_| refused())?;
        temporary.write_all(&bytes)?;
        temporary.sync_all()?;
        let temporary_name = std::ffi::CString::new(temporary_name).map_err(|_| refused())?;
        let final_name = std::ffi::CString::new(final_name).map_err(|_| refused())?;
        // SAFETY: both names are NUL terminated and relative to this live root.
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                temporary_name.as_ptr(),
                self.directory.as_raw_fd(),
                final_name.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        self.directory.sync_all()
    }

    pub fn load(&self, name: &str) -> Result<Option<State>> {
        let mut file = match self.file(&format!("{name}.json"), libc::O_RDONLY) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if file.metadata()?.len() > 8192 {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file).take(8193).read_to_end(&mut bytes)?;
        let state: State = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if state.version != 1
            // Case-insensitive filesystems may return a retained receipt under
            // its previous spelling after a case-only command rename.
            || !state.name.eq_ignore_ascii_case(name)
            || state.guard_pid <= 1
            || state.process_group_id != state.guard_pid
            || state.guard_start_time == 0
        {
            return Err(refused());
        }
        Ok(Some(state))
    }

    pub fn states(&self) -> Result<Vec<State>> {
        let mut states = Vec::new();
        // Enumeration is followed by descriptor-relative checked reads. Root path
        // replacement can at most change the candidate names, never read location.
        for entry in std::fs::read_dir(&self.path)? {
            let entry = entry?;
            if let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|v| v.strip_suffix(".json"))
            {
                if !crate::protocol::valid_name(name) {
                    return Err(refused());
                }
                if let Some(state) = self.load(name)? {
                    states.push(state);
                }
            }
        }
        Ok(states)
    }
}
