//! Which method a recently finished disk-handle scan of a pool used.
//!
//! A scan runs in this process where one is built and it can trust itself, and through an
//! `lsof` child otherwise (see the parent module). Which one ran is otherwise invisible,
//! and a host that silently fell back is slower at every stop. A scan therefore records
//! the method that actually ran, and the reason for a fallback, in `disk-handle-scan.json`
//! beside the owner record.
//!
//! The record is a report only, and its contract is narrow: it is the method of a recently
//! finished scan of this pool.
//!
//! * It never decides a stop or a release check. The scan's answer is handed to its caller
//!   first; the caller then waits at most 100 ms for the record and returns either way.
//! * Nothing is written into the pool's directory once the scan's caller has returned. The
//!   scan's thread looks whether the caller is gone before it creates its temporary file
//!   and again before it renames it over the record, and removes the temporary file
//!   instead when the caller has gone. What remains is the instant between such a look and
//!   the file operation after it, and only when the write took longer than the caller's
//!   wait. A caller may therefore remove or set aside the directory right after a scan.
//! * A record can be missing or old after a scan: when the scan was cancelled or timed out,
//!   when the write failed, and when it took longer than the caller waited.
//! * Within one process an earlier scan never overwrites a later one ([`Turn`]). Across
//!   processes the pool's VM lock orders the writes, because a stop holds it while it waits
//!   for its scan and for the record; the exception is the instant above.
//! * Every write error is ignored, and a missing, malformed, foreign, oversized or special
//!   file reads as none without being waited on.
//! * It is rewritten only when the method changes.
use super::{Fallback, Method};
use crate::provider::state;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

const FILE: &str = "disk-handle-scan.json";
const VERSION: u32 = 1;
/// Far more than a record holds; a larger file is not one.
const MAX_BYTES: u64 = 4096;

/// The record as stored: `{"version": 1, "method": "in-process"}`, or
/// `{"version": 1, "method": "lsof", "reason": "self_test_failed"}` with the reason one of
/// `not_built_for_this_platform`, `query_unanswered`, `self_test_failed`,
/// `self_test_unavailable` and `scan_incomplete`.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    method: Name,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<Fallback>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Name {
    InProcess,
    Lsof,
}

impl Record {
    fn of(method: Method) -> Self {
        let (method, reason) = match method {
            Method::InProcess => (Name::InProcess, None),
            Method::Lsof(reason) => (Name::Lsof, Some(reason)),
        };
        Self {
            version: VERSION,
            method,
            reason,
        }
    }

    /// The method a well-formed record names; an `lsof` record must give its reason and an
    /// in-process one must not.
    fn method(&self) -> Option<Method> {
        match (self.version, self.method, self.reason) {
            (VERSION, Name::InProcess, None) => Some(Method::InProcess),
            (VERSION, Name::Lsof, Some(reason)) => Some(Method::Lsof(reason)),
            _ => None,
        }
    }
}

/// What `runtime status` says of a recently finished scan (see the module contract):
/// `{"method": "in-process"}`, or `{"method": "lsof", "reason": "self_test_failed"}` with
/// the record's reasons.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Report {
    method: Name,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Fallback>,
}

/// What the record of the pool at `pool` says, as `runtime status` reports it; none
/// without a readable record.
pub(in crate::provider::lifecycle) fn report(pool: &Path) -> Option<Report> {
    let Record { method, reason, .. } = Record::of(read(pool)?);
    Some(Report { method, reason })
}

fn path(pool: &Path) -> PathBuf {
    pool.join(FILE)
}

/// The method a recently finished scan of the pool at `pool` used, if a readable record
/// says so.
///
/// Read as the provider's receipts are (`state::read_bounded`): only a small regular file
/// of this user's, private and singly linked, opened without blocking. So a FIFO or a huge
/// file at the record's path neither stalls a stop or a status nor exhausts memory; it
/// reads as none.
pub(in crate::provider::lifecycle) fn read(pool: &Path) -> Option<Method> {
    state::read_bounded::<Record>(&path(pool), MAX_BYTES)
        .ok()?
        .method()
}

/// One scan's place in the order in which this process started its scans.
#[derive(Clone, Copy, Debug)]
pub(super) struct Turn(u64);

impl Turn {
    /// The turn of a scan starting now: later than every turn taken before.
    pub(super) fn next() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

/// Record that the scan with `turn` of the pool at `pool` ran `method`, unless a later scan
/// of that pool in this process already recorded, or `gone` says the scan's caller has
/// returned. Best-effort: see the module contract.
pub(super) fn record(pool: &Path, turn: Turn, method: Method, gone: &AtomicBool) {
    /// The latest turn that recorded, for each pool. Held across the write, so two scans'
    /// writes cannot interleave either.
    static RECORDED: Mutex<BTreeMap<PathBuf, u64>> = Mutex::new(BTreeMap::new());
    let mut recorded = RECORDED.lock().unwrap_or_else(PoisonError::into_inner);
    let latest = recorded.entry(pool.to_owned()).or_insert(0);
    if turn.0 <= *latest || gone.load(Ordering::Relaxed) {
        return;
    }
    *latest = turn.0;
    if read(pool) != Some(method) {
        let _ = replace(pool, &Record::of(method), gone);
    }
}

/// Write through a temporary file only this call creates and names, then rename it over the
/// record. Not synchronized to disk: the record is a report, and a synchronized write would
/// cost a stop more than the scan saves.
fn replace(pool: &Path, record: &Record, gone: &AtomicBool) -> std::io::Result<()> {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let temporary = pool.join(format!(
        "{FILE}.{}.{}.new",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    replace_through(pool, record, &temporary, gone)
}

/// [`replace`] through `temporary`. A file already at that name is not this call's: the
/// exclusive create fails and the call returns without touching it. Only a file this call
/// created is removed when a later step fails, or when `gone` says the scan's caller
/// returned while it was written: the record is then left as it was.
fn replace_through(
    pool: &Path,
    record: &Record,
    temporary: &Path,
    gone: &AtomicBool,
) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let bytes = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    if gone.load(Ordering::Relaxed) {
        return Err(std::io::Error::other("the scan's caller has returned"));
    }
    let mut created = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(temporary)?;
    let published = created.write_all(&bytes).and_then(|()| {
        if gone.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("the scan's caller has returned"));
        }
        fs::rename(temporary, path(pool))
    });
    if published.is_err() {
        let _ = fs::remove_file(temporary);
    }
    published
}

#[cfg(test)]
mod tests {
    use super::super::tests::Scratch;
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// The scan's caller is still there.
    static HERE: AtomicBool = AtomicBool::new(false);
    /// The scan's caller has returned.
    static GONE: AtomicBool = AtomicBool::new(true);

    /// Each method is stored under its documented name and read back as itself.
    #[test]
    fn a_recorded_method_is_read_back() {
        let pool = Scratch::new();
        assert_eq!(read(pool.path()), None);
        let methods = [
            (Method::InProcess, r#""method": "in-process""#, None),
            (
                Method::Lsof(Fallback::QueryUnanswered),
                r#""method": "lsof""#,
                Some(r#""reason": "query_unanswered""#),
            ),
            (
                Method::Lsof(Fallback::SelfTestFailed),
                r#""method": "lsof""#,
                Some(r#""reason": "self_test_failed""#),
            ),
            (
                Method::Lsof(Fallback::SelfTestUnavailable),
                r#""method": "lsof""#,
                Some(r#""reason": "self_test_unavailable""#),
            ),
            (
                Method::Lsof(Fallback::ScanIncomplete),
                r#""method": "lsof""#,
                Some(r#""reason": "scan_incomplete""#),
            ),
            (
                Method::Lsof(Fallback::NotBuiltForThisPlatform),
                r#""method": "lsof""#,
                Some(r#""reason": "not_built_for_this_platform""#),
            ),
        ];
        for (method, name, reason) in methods {
            record(pool.path(), Turn::next(), method, &HERE);
            assert_eq!(read(pool.path()), Some(method));
            let stored = fs::read_to_string(path(pool.path())).unwrap();
            assert!(stored.contains(r#""version": 1"#), "{stored}");
            assert!(stored.contains(name), "{stored}");
            assert_eq!(stored.contains("reason"), reason.is_some(), "{stored}");
            assert!(
                reason.is_none_or(|reason| stored.contains(reason)),
                "{stored}"
            );
        }
        // Only the record remains: every temporary file was renamed over it.
        let left: Vec<_> = fs::read_dir(pool.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, [FILE]);
    }

    /// `runtime status` reports the recorded method without the record's version, and
    /// nothing for a pool no scan has recorded.
    #[test]
    fn the_status_report_names_the_recorded_method() {
        let pool = Scratch::new();
        assert_eq!(report(pool.path()), None);
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        assert_eq!(
            serde_json::to_string(&report(pool.path())).unwrap(),
            r#"{"method":"in-process"}"#
        );
        record(
            pool.path(),
            Turn::next(),
            Method::Lsof(Fallback::QueryUnanswered),
            &HERE,
        );
        assert_eq!(
            serde_json::to_string(&report(pool.path())).unwrap(),
            r#"{"method":"lsof","reason":"query_unanswered"}"#
        );
    }

    /// The record is rewritten only when the method changes.
    #[test]
    fn an_unchanged_method_is_not_rewritten() {
        use std::os::unix::fs::MetadataExt;
        let pool = Scratch::new();
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        let first = fs::metadata(path(pool.path())).unwrap().ino();
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        assert_eq!(fs::metadata(path(pool.path())).unwrap().ino(), first);
        record(
            pool.path(),
            Turn::next(),
            Method::Lsof(Fallback::SelfTestFailed),
            &HERE,
        );
        assert_ne!(fs::metadata(path(pool.path())).unwrap().ino(), first);
    }

    /// A malformed, foreign or inconsistent record reads as none and is replaced; a pool
    /// that cannot be written to is ignored.
    #[test]
    fn a_bad_record_reads_as_none_and_recording_never_fails() {
        let pool = Scratch::new();
        let good = r#"{"version": 1, "method": "in-process"}"#;
        let oversized = format!("{good}{}", " ".repeat(MAX_BYTES as usize));
        for bad in [
            "",
            "{",
            r#"{"version": 2, "method": "in-process"}"#,
            r#"{"version": 1, "method": "lsof"}"#,
            r#"{"version": 1, "method": "in-process", "reason": "self_test_failed"}"#,
            r#"{"version": 1, "method": "in-process", "extra": true}"#,
            r#"{"version": 1, "method": "dtrace"}"#,
            oversized.as_str(),
        ] {
            private(&path(pool.path()), bad);
            assert_eq!(read(pool.path()), None, "{bad}");
        }
        private(&path(pool.path()), good);
        assert_eq!(read(pool.path()), Some(Method::InProcess));
        // The same record readable by others is not this pool's private record.
        fs::set_permissions(path(pool.path()), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read(pool.path()), None);
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        assert_eq!(read(pool.path()), Some(Method::InProcess));
        let missing = pool.path().join("missing");
        record(&missing, Turn::next(), Method::InProcess, &HERE);
        assert_eq!(read(&missing), None);
    }

    /// Write `text` as a private file, as a record is stored.
    fn private(file: &Path, text: &str) {
        let _ = fs::remove_file(file);
        fs::write(file, text).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// A FIFO at the record's path is not waited on: it reads as none at once, and
    /// recording replaces it. Opening it as a plain file would block until a writer came.
    #[test]
    fn a_fifo_at_the_record_reads_as_none_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let pool = Scratch::new();
        let fifo = path(pool.path());
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path in this test's own directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(read(pool.path()), None);
        assert_eq!(report(pool.path()), None);
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        assert_eq!(read(pool.path()), Some(Method::InProcess));
    }

    /// A file already at the temporary name is somebody else's: the write fails and
    /// leaves it alone. A temporary file this call created is removed when the rename
    /// fails.
    #[test]
    fn a_failed_write_removes_only_the_file_it_created() {
        let pool = Scratch::new();
        let record = Record::of(Method::InProcess);
        let existing = pool.path().join("existing.new");
        fs::write(&existing, "not this call's").unwrap();
        assert!(replace_through(pool.path(), &record, &existing, &HERE).is_err());
        assert_eq!(fs::read_to_string(&existing).unwrap(), "not this call's");
        assert_eq!(read(pool.path()), None);

        // A directory at the record's path makes the rename fail after the create.
        fs::create_dir(path(pool.path())).unwrap();
        fs::write(path(pool.path()).join("kept"), "").unwrap();
        let created = pool.path().join("created.new");
        assert!(replace_through(pool.path(), &record, &created, &HERE).is_err());
        assert!(!created.exists());
    }

    /// A scan that started earlier does not overwrite what a later scan of the same pool
    /// recorded, whenever its thread gets to it. Another pool's scans are not affected.
    #[test]
    fn an_earlier_scan_does_not_overwrite_a_later_record() {
        let pool = Scratch::new();
        let other = Scratch::new();
        let (earlier, later) = (Turn::next(), Turn::next());
        record(pool.path(), later, Method::InProcess, &HERE);
        record(
            pool.path(),
            earlier,
            Method::Lsof(Fallback::ScanIncomplete),
            &HERE,
        );
        assert_eq!(read(pool.path()), Some(Method::InProcess));
        // The same earlier turn is the first, and so the latest, for another pool.
        record(
            other.path(),
            earlier,
            Method::Lsof(Fallback::ScanIncomplete),
            &HERE,
        );
        assert_eq!(
            read(other.path()),
            Some(Method::Lsof(Fallback::ScanIncomplete))
        );
        record(
            pool.path(),
            Turn::next(),
            Method::Lsof(Fallback::SelfTestFailed),
            &HERE,
        );
        assert_eq!(
            read(pool.path()),
            Some(Method::Lsof(Fallback::SelfTestFailed))
        );
    }

    /// Nothing is written for a caller that has returned: not the record, and not a
    /// temporary file left behind, whether the caller left before the write began or
    /// while the temporary file was being written. The record already there stays.
    #[test]
    fn nothing_is_written_once_the_caller_has_returned() {
        let pool = Scratch::new();
        let entries = || fs::read_dir(pool.path()).unwrap().count();
        record(pool.path(), Turn::next(), Method::InProcess, &GONE);
        assert_eq!(entries(), 0);
        // Gone when the rename is due: the temporary file is created, then removed.
        let unpublished = Record::of(Method::InProcess);
        let temporary = pool.path().join("created.new");
        // `replace_through` looks twice; a flag set between the looks is what a caller
        // returning mid-write looks like. Set it from another thread once the file exists.
        let gone = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let started = std::time::Instant::now();
                while !temporary.exists() && started.elapsed().as_secs() < 5 {
                    std::thread::yield_now();
                }
                gone.store(true, Ordering::Relaxed);
            });
            // Whether the flag lands before the second look or after the rename, no
            // temporary file may be left; when it lands before, no record either.
            let published = replace_through(pool.path(), &unpublished, &temporary, &gone);
            assert_eq!(published.is_ok(), read(pool.path()).is_some());
        });
        assert!(!temporary.exists());
        let _ = fs::remove_file(path(pool.path()));

        // The plain case, without the race: gone before the write starts.
        assert!(replace_through(pool.path(), &unpublished, &temporary, &GONE).is_err());
        assert_eq!(entries(), 0);

        // A record in place is not touched for a caller that has returned.
        record(pool.path(), Turn::next(), Method::InProcess, &HERE);
        record(
            pool.path(),
            Turn::next(),
            Method::Lsof(Fallback::ScanIncomplete),
            &GONE,
        );
        assert_eq!(read(pool.path()), Some(Method::InProcess));
        assert_eq!(entries(), 1);
    }
}
