//! Bounded inspection of obsolete provider HOME links in the host temp directory.
use serde::Serialize;

#[derive(Default, Serialize)]
pub struct Report {
    pub dangling: Vec<String>,
    pub removed: Vec<String>,
    pub uncertain_volume: Vec<String>,
    pub incomplete: bool,
}

/// Inspect the current user's old, dangling aliases. Maintenance must never fail setup or up.
pub fn sweep(fix: bool, include_unverified_volumes: bool) -> Report {
    #[cfg(target_os = "macos")]
    {
        // A target can live on an unavailable mount. Limit how long the
        // foreground command waits even if a filesystem call is stalled.
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let _ = std::thread::Builder::new()
            .name("home-alias-sweep".to_owned())
            .spawn(move || {
                let _ = send.send(unix::scan(
                    std::path::Path::new("/private/tmp"),
                    fix,
                    include_unverified_volumes,
                ));
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
        let _ = (fix, include_unverified_volumes);
        Report::default()
    }
}

/// Serialize managed alias publication with cleanup in the shared temp directory.
pub(super) fn create_link(
    target: &std::path::Path,
    alias: &std::path::Path,
) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let _lease = unix::creation_lock(alias.parent().ok_or(std::io::ErrorKind::InvalidInput)?)?;
    std::os::unix::fs::symlink(target, alias)
}

#[cfg(any(target_os = "macos", test))]
mod unix {
    use super::Report;
    use std::{
        collections::BTreeSet,
        ffi::{CStr, CString, OsStr},
        fs::{self, File, Metadata, OpenOptions},
        io::{self, Read, Seek, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Component, Path, PathBuf},
        time::{Duration, Instant, SystemTime},
    };

    const MIN_AGE: Duration = Duration::from_secs(300);
    const MAX_ENTRIES: usize = 8192;
    const MAX_CANDIDATES: usize = 128;

    /// Wall-clock limits for one scan, measured from its start.
    ///
    /// Production always uses [`LIMITS`]. A scan that reaches a limit stops,
    /// reports `incomplete` and leaves the rest for a later scan, so a loaded
    /// host can defer work but never makes a partial scan look complete.
    /// Tests that check entry or candidate counts pass wider limits so the
    /// result does not depend on how fast the host lists a directory.
    #[derive(Clone, Copy)]
    struct Limits {
        /// Time allowed for listing the directory.
        enumeration: Duration,
        /// Time allowed for the whole scan, including recovery and removal.
        total: Duration,
    }

    const LIMITS: Limits = Limits {
        enumeration: Duration::from_millis(100),
        total: Duration::from_millis(200),
    };

    pub(super) fn scan(root: &Path, fix: bool, include_unverified_volumes: bool) -> Report {
        scan_at(
            root,
            fix,
            include_unverified_volumes,
            SystemTime::now(),
            LIMITS,
        )
    }

    fn scan_at(
        root: &Path,
        fix: bool,
        include_unverified_volumes: bool,
        now: SystemTime,
        limits: Limits,
    ) -> Report {
        let mut report = Report::default();
        let started = Instant::now();
        let deadline = started + limits.total;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let run = || -> io::Result<Report> {
            let directory = open_directory(root)?;
            let parent = directory.metadata()?;
            let mut lease = lock(&directory, uid)?;
            let mut report = Report::default();
            let user_home = std::env::var_os("HOME").map(PathBuf::from);
            let system_temp = fs::canonicalize(std::env::temp_dir()).ok();
            let trusted = [Some(root), user_home.as_deref(), system_temp.as_deref()];
            let previous = if fix {
                read_cursor(&mut lease)?
            } else {
                String::new()
            };
            // A partial listing must still leave time to inspect candidates
            // and save progress under the original end-to-end deadline.
            // A consistently slow directory can hide the same suffix on each scan.
            let mut names = BTreeSet::new();
            let mut quarantines = Vec::new();
            let mut more = false;
            for entry in fs::read_dir(root)? {
                if started.elapsed() >= limits.enumeration {
                    report.incomplete = true;
                    break;
                }
                let Ok(entry) = entry else {
                    report.incomplete = true;
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if name.starts_with(".hack-alias-check-") {
                    if quarantine_name(name).is_some() && quarantines.len() < MAX_CANDIDATES {
                        quarantines.push(name.to_owned());
                    } else {
                        report.incomplete = true;
                    }
                    continue;
                }
                if !alias_name(name) || name <= previous.as_str() {
                    continue;
                }
                names.insert(name.to_owned());
                if names.len() > MAX_ENTRIES {
                    names.pop_last();
                    more = true;
                }
            }
            for name in quarantines {
                if !fix
                    || Instant::now() >= deadline
                    || recover_quarantine(
                        root,
                        &directory,
                        &name,
                        uid,
                        &trusted,
                        include_unverified_volumes,
                        deadline,
                    )
                    .is_err()
                {
                    report.incomplete = true;
                }
            }
            let mut last = previous;
            for name in names {
                if Instant::now() >= deadline
                    || report.dangling.len() + report.uncertain_volume.len() == MAX_CANDIDATES
                {
                    more = true;
                    break;
                }
                last.clone_from(&name);
                let path = root.join(&name);
                let alias = match orphan(&path, uid, now, &trusted) {
                    Ok(Some(candidate)) => candidate,
                    Ok(None) => continue,
                    Err(_) => {
                        report.incomplete = true;
                        continue;
                    }
                };
                if alias.uncertain_volume {
                    report.uncertain_volume.push(name.clone());
                } else {
                    report.dangling.push(name.clone());
                }
                if !fix || (alias.uncertain_volume && !include_unverified_volumes) {
                    continue;
                }
                if same_parent(root, &parent)
                    && matches!(orphan(&path, uid, now, &trusted), Ok(Some(current)) if current == alias)
                    && Instant::now() < deadline
                    && remove_checked(
                        root,
                        &directory,
                        &name,
                        &alias,
                        || {},
                        || {
                            volume_uncertain(&alias.target, &trusted)
                                .is_ok_and(|risk| risk == Some(alias.uncertain_volume))
                                && Instant::now() < deadline
                        },
                    )
                    .is_ok()
                {
                    report.removed.push(name);
                } else {
                    report.incomplete = true;
                }
            }
            if fix {
                more |= report.incomplete;
                if write_cursor(&mut lease, if more { &last } else { "" }).is_err() {
                    report.incomplete = true;
                }
            }
            report.incomplete |= more;
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

    fn open_directory(root: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(root)
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn creation_lock(root: &Path) -> io::Result<File> {
        let directory = open_directory(root)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let started = Instant::now();
        loop {
            match lock(&directory, uid) {
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        && started.elapsed() < Duration::from_secs(10) =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Timed out waiting for the temporary HOME alias sweep to release its lease.",
                    ));
                }
                result => return result,
            }
        }
    }

    fn read_cursor(file: &mut File) -> io::Result<String> {
        let mut bytes = String::new();
        file.take(17).read_to_string(&mut bytes)?;
        if !alias_name(&bytes) {
            bytes.clear();
        }
        Ok(bytes)
    }

    fn write_cursor(file: &mut File, name: &str) -> io::Result<()> {
        file.rewind()?;
        file.write_all(name.as_bytes())?;
        file.set_len(name.len() as u64)
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
                    | libc::O_RDWR
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

    fn rename_exclusive(from: &File, name: &CStr, to: &File, target: &CStr) -> io::Result<()> {
        // SAFETY: both descriptors and C strings remain valid for this call.
        #[cfg(target_os = "macos")]
        let rc = unsafe {
            libc::renameatx_np(
                from.as_raw_fd(),
                name.as_ptr(),
                to.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        // SAFETY: the descriptors and strings remain valid for this call.
        #[cfg(target_os = "linux")]
        let rc = unsafe {
            libc::renameat2(
                from.as_raw_fd(),
                name.as_ptr(),
                to.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn remove_checked(
        root: &Path,
        parent: &File,
        name: &str,
        alias: &Alias,
        before_move: impl FnOnce(),
        still_orphan: impl FnOnce() -> bool,
    ) -> io::Result<()> {
        use std::os::unix::{ffi::OsStrExt, fs::DirBuilderExt};
        let mut random = [0; 12];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let quarantine = root.join(quarantine_label(
            name,
            alias.identity,
            alias.modified,
            random,
        )?);
        fs::DirBuilder::new().mode(0o700).create(&quarantine)?;
        let result = (|| {
            let stage = open_directory(&quarantine)?;
            let name = CString::new(name).map_err(io::Error::other)?;
            let entry = c"entry";
            before_move();
            rename_exclusive(parent, &name, &stage, entry)?;
            // SAFETY: fstatat writes through a valid pointer and does not follow the link.
            let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
            let rc = unsafe {
                libc::fstatat(
                    stage.as_raw_fd(),
                    entry.as_ptr(),
                    info.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            let matches = if rc == 0 {
                // SAFETY: fstatat initialized the structure on success.
                let info = unsafe { info.assume_init() };
                #[allow(clippy::unnecessary_cast)]
                let identity = (info.st_dev as u64, info.st_ino as u64);
                let staged_path = quarantine.join(OsStr::from_bytes(entry.to_bytes()));
                identity == alias.identity
                    && info.st_mode & libc::S_IFMT == libc::S_IFLNK
                    && info.st_uid == alias.uid
                    && info.st_nlink == 1
                    && fs::symlink_metadata(&staged_path)
                        .and_then(|metadata| metadata.modified())
                        .is_ok_and(|modified| modified == alias.modified)
                    && fs::read_link(staged_path).is_ok_and(|target| target == alias.target)
            } else {
                false
            };
            if matches && still_orphan() {
                // SAFETY: entry is NUL-terminated and stage holds an open private directory.
                if unsafe { libc::unlinkat(stage.as_raw_fd(), entry.as_ptr(), 0) } == 0 {
                    return Ok(());
                }
            }
            // Never overwrite a new alias. If restoration cannot publish, keep
            // the entry in quarantine and report the incomplete scan.
            rename_exclusive(&stage, entry, parent, &name)?;
            Err(io::Error::other("alias identity or unlink changed"))
        })();
        let _ = fs::remove_dir(&quarantine);
        result
    }

    fn quarantine_label(
        alias: &str,
        identity: (u64, u64),
        modified: SystemTime,
        random: [u8; 12],
    ) -> io::Result<String> {
        let (device, inode) = identity;
        let age = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(io::Error::other)?;
        Ok(format!(
            ".hack-alias-check-{alias}-{device:x}-{inode:x}-{:x}-{:x}-{:x}",
            age.as_secs(),
            age.subsec_nanos(),
            crate::Hex(random)
        ))
    }

    fn quarantine_name(value: &str) -> Option<(&str, (u64, u64), SystemTime)> {
        let mut fields = value.strip_prefix(".hack-alias-check-")?.rsplitn(6, '-');
        let random = fields.next()?;
        let nanos = u32::from_str_radix(fields.next()?, 16).ok()?;
        let seconds = u64::from_str_radix(fields.next()?, 16).ok()?;
        let inode = u64::from_str_radix(fields.next()?, 16).ok()?;
        let device = u64::from_str_radix(fields.next()?, 16).ok()?;
        let alias = fields.next()?;
        if nanos >= 1_000_000_000
            || random.len() != 24
            || !random.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !alias_name(alias)
        {
            return None;
        }
        let modified = SystemTime::UNIX_EPOCH.checked_add(Duration::new(seconds, nanos))?;
        Some((alias, (device, inode), modified))
    }

    /// Resolve a rename left by an interrupted sweep, without overwriting a new alias.
    fn recover_quarantine(
        root: &Path,
        parent: &File,
        name: &str,
        uid: u32,
        trusted: &[Option<&Path>],
        include_unverified_volumes: bool,
        deadline: Instant,
    ) -> io::Result<()> {
        let (original, identity, modified) =
            quarantine_name(name).ok_or(io::ErrorKind::InvalidInput)?;
        let stage_path = root.join(name);
        let stage = open_directory(&stage_path)?;
        let metadata = stage.metadata()?;
        if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let entry = stage_path.join("entry");
        let info = match fs::symlink_metadata(&entry) {
            Ok(info) => info,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return fs::remove_dir(&stage_path);
            }
            Err(error) => return Err(error),
        };
        let remove = if info.is_symlink()
            && info.uid() == uid
            && info.nlink() == 1
            && (info.dev(), info.ino()) == identity
            && info.modified()? == modified
        {
            let target = fs::read_link(&entry)?;
            target.ends_with(".hack-local/run/smolvm/home")
                && volume_uncertain(&target, trusted).is_ok_and(|result| {
                    result.is_some_and(|uncertain| !uncertain || include_unverified_volumes)
                })
        } else {
            false
        };
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        if remove {
            let current = fs::symlink_metadata(&entry)?;
            if (current.dev(), current.ino()) != identity
                || !current.is_symlink()
                || current.uid() != uid
                || current.nlink() != 1
                || current.modified()? != modified
            {
                return Err(io::Error::other("quarantined alias changed"));
            }
            // SAFETY: the private stage is open and the entry name is fixed.
            if unsafe { libc::unlinkat(stage.as_raw_fd(), c"entry".as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
        } else {
            let original = CString::new(original).map_err(io::Error::other)?;
            rename_exclusive(&stage, c"entry", parent, &original)?;
        }
        fs::remove_dir(&stage_path)
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Alias {
        identity: (u64, u64),
        target: PathBuf,
        uid: u32,
        modified: SystemTime,
        uncertain_volume: bool,
    }

    fn orphan(
        path: &Path,
        uid: u32,
        now: SystemTime,
        trusted: &[Option<&Path>],
    ) -> io::Result<Option<Alias>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !metadata.is_symlink() || metadata.uid() != uid || metadata.nlink() != 1 {
            return Ok(None);
        }
        let changed = u64::try_from(metadata.ctime()).map_err(io::Error::other)?;
        let nanos = u32::try_from(metadata.ctime_nsec()).map_err(io::Error::other)?;
        let modified = metadata.modified()?;
        if now
            .duration_since(modified.max(SystemTime::UNIX_EPOCH + Duration::new(changed, nanos)))
            .map_or(true, |age| age < MIN_AGE)
        {
            return Ok(None);
        }
        let target = match fs::read_link(path) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !target.ends_with(".hack-local/run/smolvm/home") {
            return Ok(None);
        }
        let Some(uncertain_volume) = volume_uncertain(&target, trusted)? else {
            return Ok(None);
        };
        Ok(Some(Alias {
            identity: (metadata.dev(), metadata.ino()),
            uid,
            modified,
            uncertain_volume,
            target,
        }))
    }

    fn volume_uncertain(target: &Path, trusted: &[Option<&Path>]) -> io::Result<Option<bool>> {
        if !home_absent(target, |part| {
            fs::symlink_metadata(part).map(|entry| entry.is_dir())
        })? {
            return Ok(None);
        }
        let home = target
            .ancestors()
            .nth(4)
            .ok_or(io::ErrorKind::InvalidInput)?;
        Ok(Some(!trusted.iter().flatten().any(|root| {
            root.is_absolute() && *root != Path::new("/") && home.starts_with(root)
        })))
    }

    /// Check the entire path. A symlink, wrong type or inaccessible component
    /// cannot serve as evidence that a home has disappeared.
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

        /// Limits no test host reaches, for tests that check counts rather than
        /// timing. With [`LIMITS`], a loaded host can stop the listing early,
        /// which is correct behavior but not the behavior under test.
        const WIDE: Limits = Limits {
            enumeration: Duration::from_secs(3600),
            total: Duration::from_secs(3600),
        };

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

                assert!(scan(root, true, false).dangling.is_empty());
                let later = SystemTime::now() + MIN_AGE + Duration::from_secs(1);
                let preview = scan_at(root, false, false, later, WIDE);
                assert_eq!(preview.dangling, [old]);
                assert!(preview.removed.is_empty());
                assert!(root.join(old).is_symlink());

                let fixed = scan_at(root, true, false, later, WIDE);
                assert_eq!(fixed.removed, [old]);
                assert!(!root.join(old).is_symlink());
                assert!(root.join(live).is_symlink());
                assert!(root.join(missing_provider).is_symlink());
                assert!(root.join(invalid_target).is_symlink());
                assert_eq!(fs::read(root.join(regular)).unwrap(), b"foreign");
            });
        }

        fn witness(root: &Path, alias: &Path) -> Alias {
            let uid = fs::symlink_metadata(alias).unwrap().uid();
            orphan(alias, uid, SystemTime::now() + MIN_AGE, &[Some(root)])
                .unwrap()
                .unwrap()
        }

        #[test]
        fn changed_entry_and_returning_home_both_survive_the_final_windows() {
            with_root(|root| {
                let name = "hkl-000000000001";
                let link = root.join(name);
                let target = root.join("absent/.hack-local/run/smolvm/home");
                symlink(&target, &link).unwrap();
                let alias = witness(root, &link);
                let directory = open_directory(root).unwrap();
                let original = root.join("original");
                let result = remove_checked(
                    root,
                    &directory,
                    name,
                    &alias,
                    || {
                        fs::rename(&link, &original).unwrap();
                        fs::write(&link, "replacement").unwrap();
                    },
                    || true,
                );
                assert!(result.is_err());
                assert_eq!(fs::read_to_string(&link).unwrap(), "replacement");
                fs::remove_file(&link).unwrap();
                fs::rename(&original, &link).unwrap();

                let result = remove_checked(
                    root,
                    &directory,
                    name,
                    &alias,
                    || {},
                    || {
                        fs::create_dir_all(&target).unwrap();
                        volume_uncertain(&target, &[]).unwrap().is_some()
                    },
                );
                assert!(result.is_err());
                assert_eq!(fs::read_link(&link).unwrap(), target);
            });
        }

        #[test]
        fn next_fix_recovers_an_interrupted_move() {
            with_root(|root| {
                let target = root.join("candidate/.hack-local/run/smolvm/home");
                let name = "hkl-000000000001";
                let link = root.join(name);
                for restore in [true, false] {
                    symlink(&target, &link).unwrap();
                    let metadata = fs::symlink_metadata(&link).unwrap();
                    let staged = root.join(
                        quarantine_label(
                            name,
                            (metadata.dev(), metadata.ino()),
                            metadata.modified().unwrap(),
                            [0; 12],
                        )
                        .unwrap(),
                    );
                    std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700)
                        .create(&staged)
                        .unwrap();
                    fs::rename(&link, staged.join("entry")).unwrap();
                    if restore {
                        fs::create_dir_all(&target).unwrap();
                    }
                    assert!(scan(root, false, false).incomplete);
                    assert!(!scan_at(root, true, false, SystemTime::now(), WIDE).incomplete);
                    assert!(!staged.exists());
                    if restore {
                        assert_eq!(fs::read_link(&link).unwrap(), target);
                        fs::remove_file(&link).unwrap();
                        fs::remove_dir_all(root.join("candidate")).unwrap();
                    } else {
                        assert!(!link.is_symlink());
                    }
                }
            });
        }

        #[test]
        fn foreign_uid_cannot_authorize_an_unlink() {
            with_root(|root| {
                let link = root.join("hkl-000000000001");
                symlink(root.join("missing/.hack-local/run/smolvm/home"), &link).unwrap();
                let uid = fs::symlink_metadata(&link).unwrap().uid();
                assert!(
                    orphan(
                        &link,
                        uid.wrapping_add(1),
                        SystemTime::now() + MIN_AGE,
                        &[Some(root)]
                    )
                    .unwrap()
                    .is_none()
                );
                assert!(link.is_symlink());
            });
        }

        #[test]
        fn age_uses_the_full_change_timestamp() {
            with_root(|root| {
                let link = root.join("hkl-000000000001");
                symlink(root.join("missing/.hack-local/run/smolvm/home"), &link).unwrap();
                let metadata = fs::symlink_metadata(&link).unwrap();
                let changed = SystemTime::UNIX_EPOCH
                    + Duration::new(metadata.ctime() as u64, metadata.ctime_nsec() as u32);
                let cutoff = changed.max(metadata.modified().unwrap()) + MIN_AGE;
                let trusted = &[Some(root)];
                assert!(
                    orphan(
                        &link,
                        metadata.uid(),
                        cutoff - Duration::from_nanos(1),
                        trusted
                    )
                    .unwrap()
                    .is_none()
                );
                assert!(
                    orphan(&link, metadata.uid(), cutoff, trusted)
                        .unwrap()
                        .is_some()
                );
            });
        }

        #[test]
        fn fix_resumes_after_an_unverified_volume_page() {
            with_root(|root| {
                for index in 0..=MAX_CANDIDATES {
                    let name = format!("hkl-{index:012x}");
                    let target = PathBuf::from(format!(
                        "/Volumes/unmounted/fixture-{index}/.hack-local/run/smolvm/home"
                    ));
                    symlink(target, root.join(name)).unwrap();
                }
                let now = SystemTime::now() + MIN_AGE;
                let first = scan_at(root, true, false, now, WIDE);
                assert_eq!(first.uncertain_volume.len(), MAX_CANDIDATES);
                assert!(first.removed.is_empty());
                let second = scan_at(root, true, false, now, WIDE);
                assert_eq!(
                    second.uncertain_volume,
                    [format!("hkl-{MAX_CANDIDATES:012x}")]
                );
                assert!(second.removed.is_empty());
            });
        }

        #[test]
        fn a_home_outside_known_roots_needs_an_explicit_override() {
            with_root(|root| {
                let name = "hkl-000000000001";
                let link = root.join(name);
                symlink(
                    "/Volumes/fixture-unmounted/.hack-local/run/smolvm/home",
                    &link,
                )
                .unwrap();
                let now = SystemTime::now() + MIN_AGE;
                let automatic = scan_at(root, true, false, now, WIDE);
                assert_eq!(automatic.uncertain_volume, [name]);
                assert!(automatic.removed.is_empty());
                assert!(link.is_symlink());
                let explicit = scan_at(root, true, true, now, WIDE);
                assert_eq!(explicit.removed, [name]);
            });
        }

        #[test]
        fn unrelated_names_do_not_consume_the_entry_budget() {
            with_root(|root| {
                for index in 0..=MAX_ENTRIES {
                    fs::write(root.join(format!("unrelated-{index:05}")), b"").unwrap();
                }
                let name = "hkl-000000000001";
                symlink(
                    root.join("absent/.hack-local/run/smolvm/home"),
                    root.join(name),
                )
                .unwrap();
                let report = scan_at(root, true, false, SystemTime::now() + MIN_AGE, WIDE);
                // Counting unrelated names would exceed MAX_ENTRIES and report
                // more work, whatever order the directory lists them in.
                assert!(!report.incomplete);
                assert_eq!(report.removed, [name]);
            });
        }

        #[test]
        fn a_listing_past_its_time_limit_defers_instead_of_finishing() {
            with_root(|root| {
                let name = "hkl-000000000001";
                symlink(
                    root.join("absent/.hack-local/run/smolvm/home"),
                    root.join(name),
                )
                .unwrap();
                let now = SystemTime::now() + MIN_AGE;
                // A slow host can reach the listing limit before any entry,
                // as happened on a loaded CI runner with production limits.
                let expired = Limits {
                    enumeration: Duration::ZERO,
                    ..WIDE
                };
                let deferred = scan_at(root, true, false, now, expired);
                assert!(deferred.incomplete);
                assert!(deferred.removed.is_empty());
                assert!(root.join(name).is_symlink());
                let next = scan_at(root, true, false, now, WIDE);
                assert!(!next.incomplete);
                assert_eq!(next.removed, [name]);
            });
        }

        #[test]
        fn creation_waits_for_the_sweep_lease() {
            with_root(|root| {
                let directory = open_directory(root).unwrap();
                let lease = lock(&directory, fs::metadata(root).unwrap().uid()).unwrap();
                let path = root.join("hkl-000000000001");
                std::thread::scope(|scope| {
                    let (send, recv) = std::sync::mpsc::channel();
                    let alias_path = &path;
                    let creator = scope.spawn(move || {
                        send.send(()).unwrap();
                        let _lease = creation_lock(root).unwrap();
                        symlink(root.join("target"), alias_path).unwrap();
                        send.send(()).unwrap();
                    });
                    recv.recv().unwrap();
                    assert_eq!(
                        recv.recv_timeout(Duration::from_millis(1100)),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    );
                    assert!(!path.is_symlink());
                    drop(lease);
                    creator.join().unwrap();
                });
                assert!(path.is_symlink());
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
                    std::thread::scope(|scope| scope
                        .spawn(|| scan(root, true, false))
                        .join()
                        .unwrap())
                    .incomplete
                );
                drop(held);
                assert!(!scan_at(root, true, false, SystemTime::now(), WIDE).incomplete);
            });
        }
    }
}
