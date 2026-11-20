//! Which method a pool's last disk-handle scan used.
//!
//! A scan normally runs in this process and falls back to an `lsof` child when it cannot
//! trust itself (see the parent module). Which one ran is otherwise invisible, and a host
//! that silently fell back is slower at every stop. Each scan therefore records its method,
//! and the reason for a fallback, in `disk-handle-scan.json` beside the owner record.
//!
//! This is a report only. Recording never fails or changes a stop or a release check: every
//! write error is ignored, and a missing or malformed record reads as none. The record is
//! written when a scan starts, so it also names the method of a scan that then refused or
//! timed out, and it is rewritten only when the method changes.
use super::{Fallback, Method};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "disk-handle-scan.json";
const VERSION: u32 = 1;

/// The record as stored: `{"version": 1, "method": "in-process"}`, or
/// `{"version": 1, "method": "lsof", "reason": "self_test_failed"}` with the reason one of
/// `query_unanswered`, `self_test_failed` and `self_test_unavailable`.
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

/// What `runtime status` says of the last scan: `{"method": "in-process"}`, or
/// `{"method": "lsof", "reason": "self_test_failed"}` with the record's reasons.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Report {
    method: Name,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Fallback>,
}

/// The last scan of the pool at `pool` as `runtime status` reports it; none without a
/// readable record.
pub(in crate::provider::lifecycle) fn report(pool: &Path) -> Option<Report> {
    let Record { method, reason, .. } = Record::of(read(pool)?);
    Some(Report { method, reason })
}

fn path(pool: &Path) -> PathBuf {
    pool.join(FILE)
}

/// The method the last scan of the pool at `pool` used, if a readable record says so.
pub(in crate::provider::lifecycle) fn read(pool: &Path) -> Option<Method> {
    let bytes = fs::read(path(pool)).ok()?;
    serde_json::from_slice::<Record>(&bytes).ok()?.method()
}

/// Record that a scan of the pool at `pool` uses `method`. Best-effort: see the module
/// contract. The caller holds the pool's VM lock, so scans of one pool do not interleave.
pub(super) fn record(pool: &Path, method: Method) {
    if read(pool) != Some(method) {
        let _ = replace(pool, &Record::of(method));
    }
}

/// Write through a temporary file only this call creates and names, then rename it over the
/// record. A failed write removes only that temporary file. Not synchronized to disk: the
/// record is a report, and a synchronized write would cost a stop more than the scan saves.
fn replace(pool: &Path, record: &Record) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let bytes = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    let temporary = pool.join(format!(
        "{FILE}.{}.{}.new",
        std::process::id(),
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .and_then(|mut file| file.write_all(&bytes))
        .and_then(|()| fs::rename(&temporary, path(pool)));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::super::tests::Scratch;
    use super::*;

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
        ];
        for (method, name, reason) in methods {
            record(pool.path(), method);
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
        record(pool.path(), Method::InProcess);
        assert_eq!(
            serde_json::to_string(&report(pool.path())).unwrap(),
            r#"{"method":"in-process"}"#
        );
        record(pool.path(), Method::Lsof(Fallback::QueryUnanswered));
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
        record(pool.path(), Method::InProcess);
        let first = fs::metadata(path(pool.path())).unwrap().ino();
        record(pool.path(), Method::InProcess);
        assert_eq!(fs::metadata(path(pool.path())).unwrap().ino(), first);
        record(pool.path(), Method::Lsof(Fallback::SelfTestFailed));
        assert_ne!(fs::metadata(path(pool.path())).unwrap().ino(), first);
    }

    /// A malformed, foreign or inconsistent record reads as none and is replaced; a pool
    /// that cannot be written to is ignored.
    #[test]
    fn a_bad_record_reads_as_none_and_recording_never_fails() {
        let pool = Scratch::new();
        for bad in [
            "",
            "{",
            r#"{"version": 2, "method": "in-process"}"#,
            r#"{"version": 1, "method": "lsof"}"#,
            r#"{"version": 1, "method": "in-process", "reason": "self_test_failed"}"#,
            r#"{"version": 1, "method": "in-process", "extra": true}"#,
            r#"{"version": 1, "method": "dtrace"}"#,
        ] {
            fs::write(path(pool.path()), bad).unwrap();
            assert_eq!(read(pool.path()), None, "{bad}");
        }
        record(pool.path(), Method::InProcess);
        assert_eq!(read(pool.path()), Some(Method::InProcess));
        let missing = pool.path().join("missing");
        record(&missing, Method::InProcess);
        assert_eq!(read(&missing), None);
    }
}
