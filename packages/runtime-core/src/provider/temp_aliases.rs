//! Bounded inspection of obsolete provider HOME links in the host temp directory.
use serde::Serialize;

#[derive(Default, Serialize)]
pub struct Report {
    pub dangling: Vec<String>,
    pub removed: Vec<String>,
    pub incomplete: bool,
}

/// Inspect the current user's old, dangling aliases. Maintenance must never fail setup or up.
pub fn sweep(fix: bool) -> Report {
    #[cfg(target_os = "macos")]
    {
        // A target can live on an unavailable mount. Limit how long the
        // foreground command waits even if a filesystem call is stalled.
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let _ = std::thread::Builder::new()
            .name("home-alias-sweep".to_owned())
            .spawn(move || {
                let _ = send.send(unix::scan(std::path::Path::new("/private/tmp"), fix));
            });
        receive
            .recv_timeout(std::time::Duration::from_millis(250))
            .unwrap_or_else(|_| Report {
                incomplete: true,
                ..Report::default()
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = fix;
        Report::default()
    }
}

#[cfg(any(target_os = "macos", test))]
mod unix {
    use super::Report;
    use std::{
        ffi::{CString, OsStr},
        fs::{self, File, Metadata, OpenOptions},
        io,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Component, Path, PathBuf},
        time::{Duration, Instant, SystemTime},
    };

    const MIN_AGE: Duration = Duration::from_secs(300);
    const BUDGET: Duration = Duration::from_millis(200);
    const MAX_ENTRIES: usize = 8192;
    const MAX_CANDIDATES: usize = 128;

    pub(super) fn scan(root: &Path, fix: bool) -> Report {
        scan_at(root, fix, SystemTime::now())
    }

    fn scan_at(root: &Path, fix: bool, now: SystemTime) -> Report {
        let mut report = Report::default();
        let started = Instant::now();
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let run = || -> io::Result<Report> {
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(root)?;
            let parent = directory.metadata()?;
            let _lock = lock(&directory, uid)?;
            let mut report = Report::default();
            for (index, entry) in fs::read_dir(root)?.enumerate() {
                if index == MAX_ENTRIES
                    || started.elapsed() >= BUDGET
                    || report.dangling.len() == MAX_CANDIDATES
                {
                    report.incomplete = true;
                    break;
                }
                let Ok(entry) = entry else {
                    report.incomplete = true;
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str().filter(|name| alias_name(name)) else {
                    continue;
                };
                let path = root.join(name);
                let (link, target) = match orphan(&path, uid, now) {
                    Ok(Some(candidate)) => candidate,
                    Ok(None) => continue,
                    Err(_) => {
                        report.incomplete = true;
                        continue;
                    }
                };
                report.dangling.push(name.to_owned());
                if !fix {
                    continue;
                }
                if same_parent(root, &parent)
                    && matches!(orphan(&path, uid, now), Ok(Some((current, current_target)))
                        if current == link && current_target == target)
                    && started.elapsed() < BUDGET
                    && unlink(&directory, name).is_ok()
                {
                    report.removed.push(name.to_owned());
                } else {
                    report.incomplete = true;
                }
            }
            Ok(report)
        };
        match run() {
            Ok(result) => result,
            Err(_) => {
                report.incomplete = true;
                report
            }
        }
    }

    fn alias_name(name: &str) -> bool {
        name.strip_prefix("hkl-").is_some_and(|suffix| {
            suffix.len() == 12
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }

    fn same_parent(path: &Path, expected: &Metadata) -> bool {
        fs::symlink_metadata(path).is_ok_and(|current| {
            current.is_dir() && current.dev() == expected.dev() && current.ino() == expected.ino()
        })
    }

    fn lock(directory: &File, uid: u32) -> io::Result<File> {
        let name =
            CString::new(format!(".hack-home-alias-sweep-{uid}.lock")).map_err(io::Error::other)?;
        // SAFETY: directory owns the descriptor and name is NUL-terminated.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_CREAT
                    | libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let info = file.metadata()?;
        if !info.is_file() || info.nlink() != 1 || info.uid() != uid || info.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid alias sweep lock",
            ));
        }
        // SAFETY: file owns and keeps the descriptor alive during flock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(file)
    }

    fn unlink(directory: &File, name: &str) -> io::Result<()> {
        let name = CString::new(name).map_err(io::Error::other)?;
        // SAFETY: name is a single NUL-terminated component, and directory owns the fd.
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    type Alias = ((u64, u64), PathBuf);

    fn orphan(path: &Path, uid: u32, now: SystemTime) -> io::Result<Option<Alias>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !metadata.is_symlink() || metadata.uid() != uid || metadata.nlink() != 1 {
            return Ok(None);
        }
        let changed = u64::try_from(metadata.ctime()).map_err(io::Error::other)?;
        let modified = metadata.modified()?;
        if now
            .duration_since(modified.max(SystemTime::UNIX_EPOCH + Duration::from_secs(changed)))
            .map_or(true, |age| age < MIN_AGE)
        {
            return Ok(None);
        }
        let target = match fs::read_link(path) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !target.ends_with(".hack-local/run/smolvm/home")
            || !home_absent(&target, |part| {
                fs::symlink_metadata(part).map(|entry| entry.is_dir())
            })?
        {
            return Ok(None);
        }
        Ok(Some(((metadata.dev(), metadata.ino()), target)))
    }

    /// Require the owner home itself to be missing. Walk the entire path without
    /// treating a symlink, non-directory or inaccessible component as absence.
    fn home_absent(
        target: &Path,
        mut directory: impl FnMut(&Path) -> io::Result<bool>,
    ) -> io::Result<bool> {
        let Some(home) = target.ancestors().nth(4) else {
            return Ok(false);
        };
        if !home.is_absolute() || home == Path::new("/") {
            return Ok(false);
        }
        let mut path = PathBuf::new();
        let mut missing_home = false;
        for component in target.components() {
            match component {
                Component::RootDir => path.push(OsStr::new("/")),
                Component::Normal(name) => path.push(name),
                _ => return Ok(false),
            }
            match directory(&path) {
                Ok(true) if !missing_home => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    missing_home |= home.starts_with(&path);
                }
                Err(error) => return Err(error),
                Ok(_) => return Ok(false),
            }
        }
        Ok(missing_home)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;

        fn with_root(test: impl FnOnce(&Path)) {
            struct Scratch(PathBuf);
            impl Drop for Scratch {
                fn drop(&mut self) {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }
            let base = std::env::temp_dir().canonicalize().unwrap();
            let root = Scratch(crate::private_test_root(&base, "alias-sweep"));
            test(&root.0);
        }

        #[test]
        fn removes_only_old_links_to_missing_homes() {
            with_root(|root| {
                let old = "hkl-000000000001";
                let live = "hkl-000000000002";
                let regular = "hkl-000000000003";
                let missing_provider = "hkl-000000000004";
                let invalid_target = "hkl-000000000005";
                let live_target = root.join("live/.hack-local/run/smolvm/home");
                fs::create_dir_all(&live_target).unwrap();
                fs::write(
                    live_target.parent().unwrap().join("owner.pending"),
                    b"journal",
                )
                .unwrap();
                fs::create_dir(root.join("retained")).unwrap();
                symlink(
                    root.join("deleted/.hack-local/run/smolvm/home"),
                    root.join(old),
                )
                .unwrap();
                symlink(live_target, root.join(live)).unwrap();
                fs::write(root.join(regular), b"foreign").unwrap();
                symlink(
                    root.join("retained/.hack-local/run/smolvm/home"),
                    root.join(missing_provider),
                )
                .unwrap();
                symlink(root.join("deleted/arbitrary"), root.join(invalid_target)).unwrap();

                assert!(scan(root, true).dangling.is_empty());
                let later = SystemTime::now() + MIN_AGE + Duration::from_secs(1);
                let preview = scan_at(root, false, later);
                assert_eq!(preview.dangling, [old]);
                assert!(preview.removed.is_empty());
                assert!(root.join(old).is_symlink());

                let fixed = scan_at(root, true, later);
                assert_eq!(fixed.removed, [old]);
                assert!(!root.join(old).is_symlink());
                assert!(root.join(live).is_symlink());
                assert!(root.join(missing_provider).is_symlink());
                assert!(root.join(invalid_target).is_symlink());
                assert_eq!(fs::read(root.join(regular)).unwrap(), b"foreign");
            });
        }

        #[test]
        fn access_errors_are_not_absence() {
            let target = Path::new("/fixture/deleted/.hack-local/run/smolvm/home");
            let error = home_absent(target, |part| {
                if part.starts_with("/fixture/deleted") {
                    Err(io::Error::from(io::ErrorKind::PermissionDenied))
                } else {
                    Ok(true)
                }
            })
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        }

        #[test]
        fn a_second_sweep_skips_a_lock_held_by_the_first() {
            with_root(|root| {
                let directory = File::open(root).unwrap();
                // SAFETY: geteuid has no preconditions.
                let held = lock(&directory, unsafe { libc::geteuid() }).unwrap();
                assert!(
                    std::thread::scope(|scope| scope.spawn(|| scan(root, true)).join().unwrap())
                        .incomplete
                );
                drop(held);
                assert!(!scan(root, true).incomplete);
            });
        }
    }
}
