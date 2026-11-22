//! The build-context digest bound into the build key.
//!
//! [`digest`] covers every entry the build can read from the context: the effective
//! ignore rules (see [`ignore`]) decide inclusion exactly as BuildKit does, or exclude
//! nothing when they use syntax that module does not reproduce. Per included entry, in
//! sorted relative-path order, it hashes the relative path, the kind (directory, file,
//! symlink), the permission bits, a file's content SHA-256 and a symlink's target
//! bytes. The context root itself counts as a directory entry, and so does an excluded
//! directory that holds a re-included entry. The walk never follows a symlink and
//! never reads outside the context: the context path is opened one component at a time
//! from `/` without following a symlink, and everything beneath it is reached only
//! through held directory descriptors ([`fsat`]), so an entry renamed or replaced by a
//! symlink while the walk runs is either still read through its descriptor or refused
//! `native_build_context_changed`. Owners, timestamps, extended attributes and the
//! contents of excluded entries are not covered.
//!
//! It refuses, with a closed code and no paths in the message, an unreadable entry, a
//! socket, FIFO or device inside the included set, and more than [`Bounds::DEFAULT`]
//! entries or content bytes.
//!
//! ## Stat cache
//!
//! Hashing a large context on every `up` would cost a full read, so a private cache file
//! (`run/image-builds/<namespace>/<context-id>.context-cache`, mode 0600, published by
//! rename) remembers each regular file's `(dev, inode, size, mtime, ctime, mode)` and
//! content hash. A later walk reuses the hash of a file whose stat tuple is identical
//! and whose mtime and ctime are both strictly older than the cache's write time minus
//! two seconds; any other file is read again (git's racy-file rule: a file modified
//! within the timestamp granularity of the previous walk is never trusted). The cache
//! is only an accelerator: a missing, unreadable, foreign-owned, corrupt or
//! other-version cache is ignored and rewritten, and it never authorizes reuse of an
//! image by itself.
//!
//! What the cache can miss: a content change that leaves device, inode, size, mtime and
//! ctime all identical. That needs a deliberate timestamp manipulation: mtime can be set
//! back by the file's owner, but ctime changes on every write and cannot be set by an
//! unprivileged user without changing the system clock. Such a miss can make a
//! reuse decision stale, never a build wrong: a build copies and re-hashes every file
//! ([`snapshot`]), refuses on a mismatch and then drops the cache.
use super::{Flock, refusal, state};
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::Path,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

mod fsat;
pub(super) mod ignore;
pub(super) mod snapshot;
#[cfg(test)]
mod tests;

const CACHE_VERSION: u32 = 1;
/// A cache for the largest admitted context (about 150 bytes per entry).
const MAX_CACHE_BYTES: u64 = 96 * 1024 * 1024;
/// Entries modified this close to (or after) the cache's write time are re-read.
const RACY_WINDOW_NANOS: i128 = 2_000_000_000;
const READ_BUFFER: usize = 64 * 1024;

/// Walk limits. Exceeding one refuses the build instead of hashing an unbounded tree.
#[derive(Clone, Copy, Debug)]
pub(super) struct Bounds {
    /// Included entries, directories and symlinks too.
    pub entries: usize,
    /// Total size of the included regular files, cached or read.
    pub bytes: u64,
    /// Every listed entry, excluded ones too: an ignored directory that a `!`
    /// pattern could re-include from is still walked, and this bounds that walk.
    pub visited: usize,
}
impl Bounds {
    pub(super) const DEFAULT: Self = Self {
        entries: 200_000,
        bytes: 4 * super::GIB,
        visited: 1_000_000,
    };
}

/// The result of one walk. Only `digest` enters the build key; the counts are
/// observations for tests and measurements.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "walk counts are read only by tests")
)]
pub(super) struct ContextDigest {
    pub digest: String,
    /// Every included entry in sorted path order: what a build snapshot must copy.
    pub recorded: Vec<Entry>,
    /// Included entries, the root included.
    pub entries: usize,
    /// Regular files whose contents were read (the rest reused a cached hash).
    pub files_read: usize,
    /// True when the ignore rules were not reproducible and excluded nothing.
    pub fallback: bool,
}

/// The cache file name for one context in its namespace directory.
pub(super) fn cache_name(context: &Path) -> String {
    format!("{}.context-cache", &context_id(context)[..32])
}

fn context_id(context: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(b"hack-build-context-cache-v1\0");
    digest.update(context.as_os_str().as_bytes());
    format!("{:x}", crate::Hex(digest.finalize()))
}

/// The stat tuple a cached hash is keyed by.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct Stat(u64, u64, u64, i64, i64, i64, i64, u32);
impl Stat {
    fn of(status: &fsat::Status) -> Self {
        Self(
            status.dev,
            status.ino,
            status.size,
            status.mtime.0,
            status.mtime.1,
            status.ctime.0,
            status.ctime.1,
            status.mode,
        )
    }
    fn nanos(seconds: i64, nanos: i64) -> i128 {
        i128::from(seconds) * 1_000_000_000 + i128::from(nanos)
    }
    /// Strictly older than the racy window before `written`, by both timestamps.
    fn settled_before(&self, written: i128) -> bool {
        let limit = written - RACY_WINDOW_NANOS;
        Self::nanos(self.3, self.4) < limit && Self::nanos(self.5, self.6) < limit
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CacheFile {
    version: u32,
    context: String,
    /// When the walk that wrote this cache started: `(seconds, nanoseconds)`.
    written_at: (i64, u32),
    entries: BTreeMap<String, (Stat, String)>,
}

fn load_cache(path: &Path, context: &str) -> Option<CacheFile> {
    let cache: CacheFile = state::read_bounded(path, MAX_CACHE_BYTES).ok()?;
    (cache.version == CACHE_VERSION
        && cache.context == context
        && cache.written_at.1 < 1_000_000_000
        && cache.entries.values().all(|(_, hash)| super::hex64(hash)))
    .then_some(cache)
}

/// Publish the cache by rename under a non-blocking lock; any failure leaves the old
/// cache (or none), which only costs a re-read next time.
fn store_cache(path: &Path, cache: &CacheFile) {
    let Some(parent) = path.parent() else { return };
    if state::private_directory(parent).is_err() {
        return;
    }
    let Ok(file) = Flock::open(&path.with_extension("context-lock")) else {
        return;
    };
    let Ok(Some(_lock)) = Flock::try_lock(file, libc::LOCK_EX) else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(cache) else {
        return;
    };
    let pending = path.with_extension("context-pending");
    let _ = fs::remove_file(&pending);
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&pending)
        .and_then(|mut file| file.write_all(&bytes));
    if written.is_err() || fs::rename(&pending, path).is_err() {
        let _ = fs::remove_file(&pending);
    }
}

/// What one included entry is, as hashed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Kind {
    Directory,
    /// Content SHA-256 and the size it was hashed at.
    File([u8; 32], u64),
    /// The link target bytes.
    Symlink(Vec<u8>),
}
/// One included entry, as the key walk recorded it.
#[derive(Clone, Debug)]
pub(super) struct Entry {
    /// Relative to the context root; empty for the root itself.
    pub path: Vec<u8>,
    /// Permission bits (`mode & 0o7777`).
    pub mode: u32,
    pub kind: Kind,
    /// Modification time `(seconds, nanoseconds)`; carried into the snapshot so image
    /// layers keep the project's times. Not hashed.
    pub mtime: (i64, i64),
}

pub(super) fn unreadable() -> CandidateError {
    refusal(
        "native_build_context_unreadable",
        "An entry of the build context cannot be read; fix its permissions or exclude it in the ignore file.",
    )
}
pub(super) fn changed() -> CandidateError {
    refusal(
        "native_build_context_changed",
        "A build context file changed while it was hashed; run the build again.",
    )
}

struct Walk<'a> {
    bounds: Bounds,
    previous: Option<CacheFile>,
    next: BTreeMap<String, (Stat, String)>,
    included: Vec<Entry>,
    bytes: u64,
    files_read: usize,
    rules: &'a ignore::Rules,
}

impl Walk<'_> {
    fn include(&mut self, entry: Entry) -> Result<(), CandidateError> {
        if self.included.len() >= self.bounds.entries {
            return Err(refusal(
                "native_build_context_bounds",
                "The build context has more than 200000 entries the ignore file does not exclude; exclude generated or dependency directories.",
            ));
        }
        self.included.push(entry);
        Ok(())
    }

    fn file(
        &mut self,
        directory: &fsat::Dir,
        name: &[u8],
        relative: &[u8],
        listed: &fsat::Status,
    ) -> Result<[u8; 32], CandidateError> {
        self.bytes = self.bytes.saturating_add(listed.size);
        if self.bytes > self.bounds.bytes {
            return Err(refusal(
                "native_build_context_bounds",
                "The build context has more than 4 GiB of file content the ignore file does not exclude; exclude large or generated files.",
            ));
        }
        let stat = Stat::of(listed);
        let key = std::str::from_utf8(relative).ok();
        if let (Some(key), Some(previous)) = (key, &self.previous) {
            let written = Stat::nanos(previous.written_at.0, i64::from(previous.written_at.1));
            if let Some((cached, hash)) = previous.entries.get(key)
                && *cached == stat
                && stat.settled_before(written)
                && let Some(bytes) = decode_hash(hash)
            {
                self.next.insert(key.to_owned(), (stat, hash.clone()));
                return Ok(bytes);
            }
        }
        let hash = hash_file(directory, name, relative, listed)?;
        self.files_read += 1;
        if let Some(key) = key {
            self.next
                .insert(key.to_owned(), (stat, format!("{:x}", crate::Hex(hash))));
        }
        Ok(hash)
    }
}

fn decode_hash(hex: &str) -> Option<[u8; 32]> {
    let mut out = [0_u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Test seam type: a hook run on each file after it is opened and before it is read.
#[cfg(test)]
pub(super) type AfterOpen = std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>>;
#[cfg(test)]
thread_local! {
    pub(super) static AFTER_OPEN: AfterOpen = const { std::cell::RefCell::new(None) };
}

/// Test seam: runs before the walk or a snapshot enters a directory (by its relative
/// path), so a test can swap it for a symlink in between.
#[cfg(test)]
type BeforeDescend = std::cell::RefCell<Option<Box<dyn FnMut(&[u8])>>>;
#[cfg(test)]
thread_local! {
    pub(super) static BEFORE_DESCEND: BeforeDescend = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn before_descend(relative: &[u8]) {
    BEFORE_DESCEND.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(relative);
        }
    });
}

/// An entry that was listed but is now gone, a symlink or not a directory changed
/// under the walk; any other failure is unreadable.
fn moved(error: &std::io::Error) -> CandidateError {
    match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR | libc::ENOENT) => changed(),
        _ => unreadable(),
    }
}

/// Open `path` (absolute, canonical) one component at a time from `/`, never through a
/// symlink, so no component of it can be redirected.
fn open_path(path: &Path) -> Result<fsat::Dir, CandidateError> {
    use std::path::Component;
    let mut directory = fsat::Dir::open(Path::new("/")).map_err(|_| unreadable())?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = directory.dir(name.as_bytes()).map_err(|e| moved(&e))?;
            }
            _ => return Err(unreadable()),
        }
    }
    Ok(directory)
}

/// Read one regular file of `directory` without following a symlink, checking it is
/// the entry that was listed. At most the listed size plus one byte is read: a file
/// that yields more, or whose final status differs from the listing, changed.
fn hash_file(
    directory: &fsat::Dir,
    name: &[u8],
    relative: &[u8],
    listed: &fsat::Status,
) -> Result<[u8; 32], CandidateError> {
    let file = directory.file(name).map_err(|e| moved(&e))?;
    let opened = fsat::status(&file).map_err(|_| unreadable())?;
    if !opened.is_file() || (opened.dev, opened.ino) != (listed.dev, listed.ino) {
        return Err(changed());
    }
    #[cfg(test)]
    AFTER_OPEN.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(Path::new(std::ffi::OsStr::from_bytes(relative)));
        }
    });
    #[cfg(not(test))]
    let _ = relative;
    let limit = listed.size;
    let mut reader = (&file).take(limit.saturating_add(1));
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; READ_BUFFER];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|_| unreadable())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > limit {
            return Err(changed());
        }
        digest.update(&buffer[..read]);
    }
    let after = fsat::status(&file).map_err(|_| unreadable())?;
    if total != limit || Stat::of(&after) != Stat::of(listed) {
        return Err(changed());
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(digest.finalize().as_slice());
    Ok(out)
}

fn too_many_visited() -> CandidateError {
    refusal(
        "native_build_context_bounds",
        "The build context has more than 1000000 entries to examine; exclude generated or dependency directories without re-including files under them.",
    )
}

fn now_parts(now: SystemTime) -> (i64, u32) {
    match now.duration_since(UNIX_EPOCH) {
        Ok(since) => (
            i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
            since.subsec_nanos(),
        ),
        // A clock before the epoch trusts nothing on the next walk.
        Err(_) => (i64::MIN / 2, 0),
    }
}

/// A directory still to enter: its parent's descriptor (shared by its siblings, so the
/// walk holds about one descriptor per level), its name there, its relative path, its
/// listed status and the ignore match record its children inherit (`None` beneath a
/// non-UTF-8 name, where everything is included).
struct Pending {
    parent: Rc<fsat::Dir>,
    name: Vec<u8>,
    relative: Vec<u8>,
    listed: fsat::Status,
    record: Option<Vec<bool>>,
}

/// Hash the context at `context` under the effective `ignore` bytes. `cache` names
/// the stat cache file (see the module documentation), `now` the time this walk starts.
pub(super) fn digest(
    context: &Path,
    ignore: &[u8],
    cache: Option<&Path>,
    now: SystemTime,
    bounds: Bounds,
) -> Result<ContextDigest, CandidateError> {
    let rules = ignore::Rules::parse(ignore);
    let id = context_id(context);
    let mut walk = Walk {
        bounds,
        previous: cache.and_then(|path| load_cache(path, &id)),
        next: BTreeMap::new(),
        included: Vec::new(),
        bytes: 0,
        files_read: 0,
        rules: &rules,
    };
    let root = open_path(context)?;
    let status = root.status().map_err(|_| unreadable())?;
    walk.include(Entry {
        path: Vec::new(),
        mode: status.mode & 0o7777,
        kind: Kind::Directory,
        mtime: status.mtime,
    })?;
    // Excluded directories walked because a `!` pattern may re-include beneath them.
    let mut excluded_directories: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    let mut visited = 0usize;
    let mut stack: Vec<Pending> = Vec::new();
    let mut current = (Rc::new(root), Vec::new(), Some(vec![false; rules.len()]));
    loop {
        let (directory, relative, record) = current;
        let budget = walk.bounds.visited;
        let names = directory.names(
            || {
                visited += 1;
                if visited > budget {
                    Err(too_many_visited())
                } else {
                    Ok(())
                }
            },
            |_| unreadable(),
        )?;
        for name in names {
            let mut child = relative.clone();
            if !child.is_empty() {
                child.push(b'/');
            }
            child.extend_from_slice(&name);
            let listed = directory.stat(&name).map_err(|e| moved(&e))?;
            let text = std::str::from_utf8(&child).ok();
            let (excluded, child_record) = match (&record, text) {
                (Some(record), Some(text)) => {
                    let (excluded, child_record) = walk.rules.decide(text, record);
                    (excluded, Some(child_record))
                }
                _ => (false, None),
            };
            let mode = listed.mode & 0o7777;
            let mtime = listed.mtime;
            if listed.is_dir() {
                let entry = Entry {
                    path: child.clone(),
                    mode,
                    kind: Kind::Directory,
                    mtime,
                };
                let enter = if excluded {
                    let enter = text.is_some_and(|text| walk.rules.may_include_below(text));
                    if enter {
                        excluded_directories.insert(child.clone(), entry);
                    }
                    enter
                } else {
                    walk.include(entry)?;
                    true
                };
                if enter {
                    stack.push(Pending {
                        parent: Rc::clone(&directory),
                        name,
                        relative: child,
                        listed,
                        record: child_record,
                    });
                }
            } else if excluded {
                continue;
            } else if listed.is_file() {
                let hash = walk.file(&directory, &name, &child, &listed)?;
                walk.include(Entry {
                    path: child,
                    mode,
                    kind: Kind::File(hash, listed.size),
                    mtime,
                })?;
            } else if listed.is_symlink() {
                let target = directory.read_link(&name).map_err(|e| moved(&e))?;
                walk.include(Entry {
                    path: child,
                    mode,
                    kind: Kind::Symlink(target),
                    mtime,
                })?;
            } else {
                return Err(refusal(
                    "native_build_context_special",
                    "The build context contains a socket, FIFO or device file the ignore file does not exclude; exclude it.",
                ));
            }
        }
        drop(directory);
        let Some(next) = stack.pop() else { break };
        #[cfg(test)]
        before_descend(&next.relative);
        // Entered through the parent's descriptor, never through a symlink, and only
        // if it is still the directory that was listed.
        let entered = next.parent.dir(&next.name).map_err(|e| moved(&e))?;
        let status = entered.status().map_err(|_| unreadable())?;
        if (status.dev, status.ino) != (next.listed.dev, next.listed.ino) {
            return Err(changed());
        }
        current = (Rc::new(entered), next.relative, next.record);
    }
    // An excluded directory holding an included entry is still created by the build.
    if !excluded_directories.is_empty() {
        let mut needed = Vec::new();
        for entry in &walk.included {
            for (index, byte) in entry.path.iter().enumerate() {
                if *byte == b'/'
                    && let Some(directory) = excluded_directories.remove(&entry.path[..index])
                {
                    needed.push(directory);
                }
            }
        }
        for directory in needed {
            walk.include(directory)?;
        }
    }
    let mut included = std::mem::take(&mut walk.included);
    included.sort_by(|a, b| a.path.cmp(&b.path));
    let mut digest = Sha256::new();
    digest.update(b"hack-build-context-v1\0");
    for entry in &included {
        digest.update((entry.path.len() as u64).to_le_bytes());
        digest.update(&entry.path);
        digest.update(entry.mode.to_le_bytes());
        match &entry.kind {
            Kind::Directory => digest.update(b"d"),
            Kind::File(hash, _) => {
                digest.update(b"f");
                digest.update(hash);
            }
            Kind::Symlink(target) => {
                digest.update(b"l");
                digest.update((target.len() as u64).to_le_bytes());
                digest.update(target);
            }
        }
    }
    let rewrite = walk.files_read > 0
        || walk
            .previous
            .as_ref()
            .is_none_or(|previous| previous.entries.len() != walk.next.len());
    if let Some(path) = cache
        && rewrite
    {
        store_cache(
            path,
            &CacheFile {
                version: CACHE_VERSION,
                context: id,
                written_at: now_parts(now),
                entries: std::mem::take(&mut walk.next),
            },
        );
    }
    Ok(ContextDigest {
        digest: format!("{:x}", crate::Hex(digest.finalize())),
        entries: included.len(),
        recorded: included,
        files_read: walk.files_read,
        fallback: rules.fallback,
    })
}
