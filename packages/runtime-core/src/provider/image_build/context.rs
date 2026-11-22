//! The build-context digest bound into the build key.
//!
//! [`digest`] covers every entry the build can read from the context: the effective
//! ignore rules (see [`ignore`]) decide inclusion exactly as BuildKit does, or exclude
//! nothing when they use syntax that module does not reproduce. Per included entry, in
//! sorted relative-path order, it hashes the relative path, the kind (directory, file,
//! symlink), the permission bits, a file's content SHA-256 and a symlink's target
//! bytes. The context root itself counts as a directory entry, and so does an excluded
//! directory that holds a re-included entry. The walk never follows a symlink and
//! never reads outside the context. Owners, timestamps, extended attributes and the
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
//! unprivileged user without changing the system clock. Racing a directory swap during
//! the walk is not defended either: the digest detects edits, it is not a security
//! boundary (BuildKit reads the context itself).
use super::{Flock, refusal, state};
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) mod ignore;
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
    fn of(metadata: &fs::Metadata) -> Self {
        Self(
            metadata.dev(),
            metadata.ino(),
            metadata.size(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.mode(),
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

enum Kind {
    Directory,
    File([u8; 32]),
    Symlink(Vec<u8>),
}
struct Entry {
    path: Vec<u8>,
    mode: u32,
    kind: Kind,
}

fn unreadable() -> CandidateError {
    refusal(
        "native_build_context_unreadable",
        "An entry of the build context cannot be read; fix its permissions or exclude it in the ignore file.",
    )
}
fn changed() -> CandidateError {
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
        path: &Path,
        relative: &[u8],
        metadata: &fs::Metadata,
    ) -> Result<[u8; 32], CandidateError> {
        self.bytes = self.bytes.saturating_add(metadata.size());
        if self.bytes > self.bounds.bytes {
            return Err(refusal(
                "native_build_context_bounds",
                "The build context has more than 4 GiB of file content the ignore file does not exclude; exclude large or generated files.",
            ));
        }
        let stat = Stat::of(metadata);
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
        let hash = hash_file(path, metadata)?;
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

/// Read one regular file without following a symlink, checking it is the entry that
/// was listed.
fn hash_file(path: &Path, listed: &fs::Metadata) -> Result<[u8; 32], CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| unreadable())?;
    let opened = file.metadata().map_err(|_| unreadable())?;
    if !opened.is_file() || (opened.dev(), opened.ino()) != (listed.dev(), listed.ino()) {
        return Err(changed());
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; READ_BUFFER];
    loop {
        let read = file.read(&mut buffer).map_err(|_| unreadable())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(digest.finalize().as_slice());
    Ok(out)
}

/// The directory entries of `path`, after checking it is still the listed directory.
fn list(path: &Path, listed: &fs::Metadata) -> Result<Vec<std::ffi::OsString>, CandidateError> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
        .map_err(|_| unreadable())?;
    let opened = directory.metadata().map_err(|_| unreadable())?;
    if (opened.dev(), opened.ino()) != (listed.dev(), listed.ino()) {
        return Err(changed());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| unreadable())? {
        names.push(entry.map_err(|_| unreadable())?.file_name());
    }
    Ok(names)
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

/// A directory still to list: its path, relative path, listed metadata and the
/// ignore match record its children inherit (`None` beneath a non-UTF-8 name, where
/// everything is included).
type Pending = (PathBuf, Vec<u8>, fs::Metadata, Option<Vec<bool>>);

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
    let root = fs::symlink_metadata(context).map_err(|_| unreadable())?;
    if !root.is_dir() {
        return Err(unreadable());
    }
    walk.include(Entry {
        path: Vec::new(),
        mode: root.mode() & 0o7777,
        kind: Kind::Directory,
    })?;
    // Excluded directories walked because a `!` pattern may re-include beneath them.
    let mut excluded_directories: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    let mut visited = 0usize;
    let mut stack: Vec<Pending> = vec![(
        context.to_owned(),
        Vec::new(),
        root,
        Some(vec![false; rules.len()]),
    )];
    while let Some((directory, relative, listed, record)) = stack.pop() {
        for name in list(&directory, &listed)? {
            visited += 1;
            if visited > walk.bounds.visited {
                return Err(refusal(
                    "native_build_context_bounds",
                    "The build context has more than 1000000 entries to examine; exclude generated or dependency directories without re-including files under them.",
                ));
            }
            let mut child = relative.clone();
            if !child.is_empty() {
                child.push(b'/');
            }
            child.extend_from_slice(name.as_bytes());
            let path = directory.join(&name);
            let metadata = fs::symlink_metadata(&path).map_err(|_| unreadable())?;
            let text = std::str::from_utf8(&child).ok();
            let (excluded, child_record) = match (&record, text) {
                (Some(record), Some(text)) => {
                    let (excluded, child_record) = walk.rules.decide(text, record);
                    (excluded, Some(child_record))
                }
                _ => (false, None),
            };
            let mode = metadata.mode() & 0o7777;
            let kind = metadata.file_type();
            if kind.is_dir() {
                let entry = Entry {
                    path: child.clone(),
                    mode,
                    kind: Kind::Directory,
                };
                if excluded {
                    if text.is_some_and(|text| walk.rules.may_include_below(text)) {
                        excluded_directories.insert(child.clone(), entry);
                        stack.push((path, child, metadata, child_record));
                    }
                } else {
                    walk.include(entry)?;
                    stack.push((path, child, metadata, child_record));
                }
            } else if excluded {
                continue;
            } else if kind.is_file() {
                let hash = walk.file(&path, &child, &metadata)?;
                walk.include(Entry {
                    path: child,
                    mode,
                    kind: Kind::File(hash),
                })?;
            } else if kind.is_symlink() {
                let target = fs::read_link(&path).map_err(|_| unreadable())?;
                walk.include(Entry {
                    path: child,
                    mode,
                    kind: Kind::Symlink(target.as_os_str().as_bytes().to_vec()),
                })?;
            } else {
                return Err(refusal(
                    "native_build_context_special",
                    "The build context contains a socket, FIFO or device file the ignore file does not exclude; exclude it.",
                ));
            }
        }
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
            Kind::File(hash) => {
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
        files_read: walk.files_read,
        fallback: rules.fallback,
    })
}
