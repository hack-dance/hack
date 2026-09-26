//! On-demand metadata accounting. No file contents, symlink targets or deletion policy.
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::{CStr, CString},
    fs::{File, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
    time::{Duration, Instant},
};
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 64;
#[derive(Default, Serialize)]
pub struct Usage {
    logical_file_bytes: u64,
    allocated_file_bytes: u64,
    unique_regular_files: u64,
    hardlink_entries: u64,
    directories: u64,
    symlinks: u64,
    sockets: u64,
    other_nodes: u64,
}
#[derive(Serialize)]
pub struct Report {
    scope: &'static str,
    selected_scope: &'static str,
    relative_root: &'static str,
    allocated_bytes_meaning: &'static str,
    complete: bool,
    atomic_snapshot: bool,
    entries_observed: usize,
    total_logical_file_bytes: u64,
    total_allocated_file_bytes: u64,
    max_entries: usize,
    max_depth: usize,
    elapsed_ms: u128,
    categories: BTreeMap<String, Usage>,
    omissions: BTreeMap<&'static str, u64>,
    deletion_candidates: bool,
}
struct Scanner {
    report: Report,
    seen: HashSet<(u64, u64)>,
    device: u64,
    started: Instant,
    limit: usize,
}
fn error() -> CandidateError {
    CandidateError::new(
        "storage_usage",
        "Cannot safely inspect candidate storage metadata.",
    )
}
struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe {
        *libc::__error() = 0;
    }
}
#[cfg(target_os = "linux")]
fn clear_errno() {
    unsafe {
        *libc::__errno_location() = 0;
    }
}
impl Scanner {
    fn omit(&mut self, why: &'static str) {
        self.report.complete = false;
        *self.report.omissions.entry(why).or_default() += 1;
    }
    fn expired(&mut self) -> bool {
        if self.report.entries_observed >= self.limit {
            self.omit("entry_limit");
            true
        } else if self.started.elapsed() > Duration::from_secs(10) {
            self.omit("time_limit");
            true
        } else {
            false
        }
    }
    fn directory(&mut self, file: File, category: Option<&str>, depth: usize) {
        if depth >= MAX_DEPTH {
            self.omit("depth_limit");
            return;
        }
        let before = match file.metadata() {
            Ok(m) => m,
            Err(_) => {
                self.omit("metadata_unavailable");
                return;
            }
        };
        let duplicate = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            self.omit("directory_unavailable");
            return;
        }
        let raw = unsafe { libc::fdopendir(duplicate) };
        if raw.is_null() {
            unsafe {
                libc::close(duplicate);
            }
            self.omit("directory_unavailable");
            return;
        }
        let directory = Directory(raw);
        loop {
            if self.expired() {
                break;
            }
            clear_errno();
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    self.omit("directory_read_error");
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name = match CString::new(name.to_bytes()) {
                Ok(n) => n,
                Err(_) => {
                    self.omit("invalid_name");
                    continue;
                }
            };
            self.report.entries_observed += 1;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                self.omit("entry_changed_or_unavailable");
                continue;
            }
            let stat = unsafe { stat.assume_init() };
            let kind = stat.st_mode & libc::S_IFMT;
            let key = category.map(str::to_owned).unwrap_or_else(|| {
                if kind == libc::S_IFDIR {
                    format!("directory/{}", name.to_string_lossy())
                } else {
                    "root_files".into()
                }
            });
            // dev_t is signed 32-bit on macOS and u64 on Linux.
            #[allow(clippy::unnecessary_cast)]
            let device = stat.st_dev as u64;
            if device != self.device {
                self.omit("different_filesystem");
                continue;
            }
            match kind {
                libc::S_IFDIR => {
                    self.report
                        .categories
                        .entry(key.clone())
                        .or_default()
                        .directories += 1;
                    let raw = unsafe {
                        libc::openat(
                            file.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if raw < 0 {
                        self.omit("directory_changed_or_unavailable");
                        continue;
                    }
                    let child = unsafe { File::from_raw_fd(raw) };
                    match child.metadata() {
                        Ok(m) if m.dev() == device && m.ino() == stat.st_ino => {
                            self.directory(child, Some(&key), depth + 1)
                        }
                        _ => self.omit("directory_replaced"),
                    }
                }
                libc::S_IFREG => {
                    let linked = stat.st_nlink > 1;
                    if linked {
                        self.report
                            .categories
                            .entry(key.clone())
                            .or_default()
                            .hardlink_entries += 1;
                    }
                    if !self.seen.insert((device, stat.st_ino)) {
                        continue;
                    }
                    if stat.st_size < 0 || stat.st_blocks < 0 {
                        self.omit("invalid_size");
                        continue;
                    }
                    let usage = self
                        .report
                        .categories
                        .entry(if linked {
                            "shared_hardlinks".into()
                        } else {
                            key
                        })
                        .or_default();
                    usage.unique_regular_files += 1;
                    usage.logical_file_bytes =
                        usage.logical_file_bytes.saturating_add(stat.st_size as u64);
                    usage.allocated_file_bytes = usage
                        .allocated_file_bytes
                        .saturating_add((stat.st_blocks as u64).saturating_mul(512));
                }
                libc::S_IFLNK => self.report.categories.entry(key).or_default().symlinks += 1,
                libc::S_IFSOCK => self.report.categories.entry(key).or_default().sockets += 1,
                _ => self.report.categories.entry(key).or_default().other_nodes += 1,
            }
        }
        if let Ok(after) = file.metadata() {
            if before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                self.omit("directory_changed_during_scan");
            }
        } else {
            self.omit("metadata_unavailable");
        }
    }
}
fn scan(path: &Path, limit: usize) -> Result<Report, CandidateError> {
    reject_aliased_state(path)?;
    let started = Instant::now();
    let mut scanner = Scanner {
        report: Report {
            scope: "candidate-state-metadata-only",
            selected_scope: "all",
            relative_root: ".hack-local",
            allocated_bytes_meaning: "st_blocks times 512; not exclusive physical bytes, guest free space or reclaimable bytes",
            complete: true,
            atomic_snapshot: false,
            entries_observed: 0,
            total_logical_file_bytes: 0,
            total_allocated_file_bytes: 0,
            max_entries: limit,
            max_depth: MAX_DEPTH,
            elapsed_ms: 0,
            categories: BTreeMap::new(),
            omissions: BTreeMap::new(),
            deletion_candidates: false,
        },
        seen: HashSet::new(),
        device: 0,
        started,
        limit,
    };
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => {
            scanner.device = file.metadata().map_err(|_| error())?.dev();
            scanner.directory(file, None, 0);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error()),
    }
    for usage in scanner.report.categories.values() {
        let logical = scanner
            .report
            .total_logical_file_bytes
            .checked_add(usage.logical_file_bytes);
        let allocated = scanner
            .report
            .total_allocated_file_bytes
            .checked_add(usage.allocated_file_bytes);
        if let (Some(logical), Some(allocated)) = (logical, allocated) {
            scanner.report.total_logical_file_bytes = logical;
            scanner.report.total_allocated_file_bytes = allocated;
        } else {
            return Err(error());
        }
    }
    scanner.report.elapsed_ms = started.elapsed().as_millis();
    Ok(scanner.report)
}
fn options<'a>(mut args: &'a [&'a str]) -> Result<(&'a str, usize), CandidateError> {
    let mut scope = None;
    let mut limit = None;
    let mut json = false;
    while !args.is_empty() {
        match args {
            ["--scope", value, rest @ ..] if scope.is_none() => {
                scope = Some(*value);
                args = rest;
            }
            ["--max-entries", value, rest @ ..] if limit.is_none() => {
                let parsed = value.parse::<usize>().map_err(|_| error())?;
                if !(1..=1_000_000).contains(&parsed) {
                    return Err(error());
                }
                limit = Some(parsed);
                args = rest;
            }
            ["--json", rest @ ..] if !json => {
                json = true;
                args = rest;
            }
            _ => {
                return Err(CandidateError::new(
                    "storage_usage",
                    "Use --scope and --max-entries (1..1000000) at most once.",
                ));
            }
        }
    }
    Ok((scope.unwrap_or("all"), limit.unwrap_or(MAX_ENTRIES)))
}
pub fn inspect_args(c: &Candidate, args: &[&str]) -> Result<Report, CandidateError> {
    let (scope, limit) = options(args)?;
    let (scope, child, relative) = match scope {
        "all" => ("all", "", ".hack-local"),
        "runtime" => ("runtime", "run", ".hack-local/run"),
        "build" => ("build", "target", ".hack-local/target"),
        "evidence" => ("evidence", "review", ".hack-local/review"),
        "artifacts" => ("artifacts", "artifacts", ".hack-local/artifacts"),
        _ => {
            return Err(CandidateError::new(
                "storage_usage",
                "Scope must be all, runtime, build, evidence or artifacts.",
            ));
        }
    };
    let mut report = scan(&c.state_root.join(child), limit)?;
    report.selected_scope = scope;
    report.relative_root = relative;
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::{fs::symlink, net::UnixListener},
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = Path::new("/tmp").canonicalize().unwrap().join(format!(
                "hack-storage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn sparse_hardlinked_and_foreign_nodes_are_accounted_without_following() {
        let f = Fixture::new();
        let state = f.0.join("state");
        fs::create_dir(&state).unwrap();
        fs::create_dir(state.join("run")).unwrap();
        let data = state.join("run/disk");
        let file = File::create(&data).unwrap();
        file.set_len(16 * 1024 * 1024).unwrap();
        let m = file.metadata().unwrap();
        fs::hard_link(&data, state.join("alias")).unwrap();
        fs::write(f.0.join("outside"), vec![1; 8192]).unwrap();
        symlink(&f.0, state.join("escape")).unwrap();
        let _listener = UnixListener::bind(state.join("socket")).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let fifo = CString::new(state.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let result = scan(&state, 100).unwrap();
        assert!(result.complete);
        assert_eq!(
            result.categories["shared_hardlinks"].unique_regular_files,
            1
        );
        assert_eq!(
            result.categories["shared_hardlinks"].logical_file_bytes,
            16 * 1024 * 1024
        );
        assert_eq!(
            result.categories["shared_hardlinks"].allocated_file_bytes,
            m.blocks() * 512
        );
        assert_eq!(result.categories["root_files"].symlinks, 1);
        assert_eq!(result.categories["root_files"].sockets, 1);
        assert_eq!(result.categories["root_files"].other_nodes, 1);
        assert_eq!(fs::read(f.0.join("outside")).unwrap().len(), 8192);
    }
    #[test]
    fn bounded_partial_report_and_absent_state_do_not_create_files() {
        let f = Fixture::new();
        let missing = f.0.join("missing");
        assert!(scan(&missing, 10).unwrap().complete);
        assert!(!missing.exists());
        for n in 0..4 {
            fs::write(f.0.join(n.to_string()), b"x").unwrap();
        }
        let report = scan(&f.0, 2).unwrap();
        assert!(!report.complete);
        assert_eq!(report.entries_observed, 2);
        assert!(report.omissions.contains_key("entry_limit"));
        let alias = f.0.join("alias");
        symlink(&f.0, &alias).unwrap();
        assert!(scan(&alias, 10).is_err());
    }
    #[test]
    fn deep_tree_reports_omitted_descendants() {
        let f = Fixture::new();
        let mut path = f.0.clone();
        for _ in 0..MAX_DEPTH + 1 {
            path = path.join("d");
            fs::create_dir(&path).unwrap();
        }
        fs::write(path.join("payload"), b"unseen").unwrap();
        let report = scan(&f.0, 1000).unwrap();
        assert!(!report.complete);
        assert_eq!(report.omissions["depth_limit"], 1);
        assert_eq!(report.total_logical_file_bytes, 0);
    }
    #[test]
    fn explicit_scan_budget_is_bounded_and_duplicate_options_refuse() {
        assert_eq!(options(&[]).unwrap(), ("all", 100_000));
        assert_eq!(
            options(&["--max-entries", "500000", "--scope", "build", "--json"]).unwrap(),
            ("build", 500_000)
        );
        for args in [
            vec!["--max-entries", "0"],
            vec!["--max-entries", "1000001"],
            vec!["--max-entries", "bad"],
            vec!["--max-entries", "2", "--max-entries", "3"],
            vec!["--scope", "all", "--scope", "build"],
            vec!["--json", "--json"],
        ] {
            assert!(options(&args).is_err());
        }
    }
}
