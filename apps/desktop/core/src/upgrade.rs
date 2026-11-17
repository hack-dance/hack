//! The upgrade review flow (HACK-2289): what `hack upgrade check | review |
//! snapshot | rollback --json` report, read by the Upgrade pane.
//!
//! The CLI wraps each in `{ok, data}` and reports refusals and a not-ready
//! check as `ok: true` with a nonzero exit, so the envelope on stdout is read
//! whatever the exit code; a nonzero exit with no envelope is a failure.
//!
//! What the app does with them:
//! - **Check** and **Review** are read-only.
//! - **Snapshot** keeps a private copy of the files an upgrade changes; it
//!   writes only under the CLI's own home (`upgrade/snapshots/<id>/`).
//! - **Restore** puts back one snapshot's files, chosen from the CLI's own
//!   listing, never with `--overwrite`: a file changed since the snapshot is
//!   left as it is, and whatever a restore replaces is kept by the CLI.
//!
//! The app never runs `hack upgrade apply` or a plan step's command: those
//! are shown for copying.

use serde::Deserialize;
use std::path::Path;

/// The check report version this reader understands.
pub const CHECK_REPORT_VERSION: u32 = 2;

/// Read `{ok, data}` from a command's stdout, whatever its exit code.
///
/// # Errors
/// No envelope, `ok: false` (its code and message), or `data` that does not
/// have the expected shape.
pub fn envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "the CLI printed no JSON report".to_owned())?;
    match v.get("ok").and_then(serde_json::Value::as_bool) {
        Some(true) => {
            let data = v.get("data").cloned().ok_or("the report has no data")?;
            serde_json::from_value(data).map_err(|e| format!("unexpected report: {e}"))
        }
        Some(false) => {
            let e = v.get("error");
            let field = |k: &str| {
                e.and_then(|e| e.get(k))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            Err(format!("{}: {}", field("code"), field("message")))
        }
        None => Err("the CLI printed no JSON report".into()),
    }
}

/// One finding: on the machine or in a checkout.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Finding {
    pub id: String,
    /// `ok | info | warn | incomplete | blocker`.
    pub status: String,
    pub summary: String,
    /// `safe | admin | manual`.
    pub kind: Option<String>,
    /// The command that fixes it, for copying.
    pub command: Option<String>,
}

/// A blocker or an incomplete check, with where it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ScopedFinding {
    /// `machine` or a project name.
    pub scope: String,
    pub id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CheckCli {
    pub version: String,
    pub channel: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CheckProject {
    pub name: String,
    pub root: Option<String>,
    /// `live | unreadable`.
    pub state: String,
    pub reason: Option<String>,
    pub findings: Vec<Finding>,
}

/// One checkout a grouped plan step covers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PlanTarget {
    pub project: Option<String>,
    pub root: Option<String>,
    pub status: String,
    pub command: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PlanStep {
    pub order: u32,
    pub id: String,
    /// `safe | admin | manual`; anything else is treated as manual.
    pub kind: String,
    /// `machine`, a checkout name, or `projects`.
    pub scope: String,
    pub status: String,
    pub count: u32,
    pub targets: Vec<PlanTarget>,
    pub command: Option<String>,
    pub why: String,
    pub blocker: bool,
    /// `hack upgrade apply` runs it (the app does not).
    pub applies: bool,
}

impl PlanStep {
    /// How the step is done, in words: the app runs none of them.
    #[must_use]
    pub fn how(&self) -> &'static str {
        match self.kind.as_str() {
            "safe" if self.id == "snapshot" => "Save snapshot below",
            "safe" if self.applies => "hack upgrade apply runs it",
            "safe" => "safe to run",
            "admin" => "needs an admin terminal",
            _ => "do by hand",
        }
    }
}

/// `hack upgrade check --json` (report version 2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CheckReport {
    pub report_version: u32,
    pub generated_at: Option<String>,
    pub cli: CheckCli,
    /// `enabled | disabled`.
    pub host_probes: String,
    pub machine: Vec<Finding>,
    pub projects: Vec<CheckProject>,
    pub blockers: Vec<ScopedFinding>,
    pub incomplete: Vec<ScopedFinding>,
    pub plan: Vec<PlanStep>,
    pub next_command: Option<String>,
    pub ready: bool,
}

impl CheckReport {
    /// Parse a check's stdout.
    ///
    /// # Errors
    /// As [`envelope`], or a report version this reader does not know.
    pub fn parse(stdout: &str) -> Result<Self, String> {
        let r: Self = envelope(stdout)?;
        if r.report_version != CHECK_REPORT_VERSION {
            return Err(format!(
                "upgrade check report version {} is not one this app reads ({CHECK_REPORT_VERSION})",
                r.report_version
            ));
        }
        Ok(r)
    }

    /// The verdict, in words. `ready` is the CLI's own (no blockers, nothing
    /// incomplete); the app does not recompute it.
    #[must_use]
    pub fn verdict(&self) -> String {
        if self.ready {
            "Ready to upgrade".into()
        } else {
            let mut parts = Vec::new();
            if !self.blockers.is_empty() {
                parts.push(plural(self.blockers.len(), "blocker"));
            }
            if !self.incomplete.is_empty() {
                parts.push(plural(self.incomplete.len(), "check that could not run"));
            }
            format!("Not ready: {}", parts.join(", "))
        }
    }
}

fn plural(n: usize, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else if let Some(rest) = what.strip_prefix("check that") {
        format!("{n} checks that{rest}")
    } else {
        format!("{n} {what}s")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ReviewCheckout {
    pub scope: String,
    pub project: Option<String>,
    pub root: Option<String>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ReviewReason {
    pub id: String,
    pub reason: String,
}

/// `hack upgrade review --json`: read-only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Review {
    /// `review | refused`.
    pub status: String,
    pub message: Option<String>,
    pub checkouts: Vec<ReviewCheckout>,
    pub reasons: Vec<ReviewReason>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SnapshotFile {
    pub path: String,
    pub label: String,
    /// For a skipped file: `symlink | not-a-file | unreadable`.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Gap {
    pub name: String,
    pub reason: String,
}

/// `hack upgrade snapshot --json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    /// `created | refused`.
    pub status: String,
    pub message: Option<String>,
    pub id: Option<String>,
    pub manifest_path: Option<String>,
    pub files: Vec<SnapshotFile>,
    pub skipped: Vec<SnapshotFile>,
    pub complete: bool,
    pub gaps: Vec<Gap>,
}

impl Snapshot {
    /// The result in words.
    #[must_use]
    pub fn summary(&self) -> String {
        if self.status != "created" {
            return format!(
                "Snapshot refused: {}",
                self.message.as_deref().unwrap_or("no reason given")
            );
        }
        let mut s = format!(
            "Snapshot {} kept {}",
            self.id.as_deref().unwrap_or(""),
            plural(self.files.len(), "file")
        );
        if !self.complete || !self.gaps.is_empty() || !self.skipped.is_empty() {
            s.push_str(&format!(
                "; incomplete: {} not covered",
                self.gaps.len() + self.skipped.len()
            ));
        }
        s
    }
}

/// One snapshot in the CLI's listing (`rollback --json` without a manifest).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SnapshotEntry {
    pub id: String,
    pub created_at: Option<String>,
    pub purpose: Option<String>,
    pub files: u32,
    pub manifest_path: String,
}

impl SnapshotEntry {
    /// The manifest is one the CLI keeps: absolute, `…/upgrade/snapshots/<id>/manifest.json`
    /// for this entry's id. Restore passes only such a path.
    #[must_use]
    pub fn manifest(&self) -> Option<&Path> {
        let p = Path::new(&self.manifest_path);
        let id = p.parent()?;
        let snapshots = id.parent()?;
        let upgrade = snapshots.parent()?;
        (p.is_absolute()
            && !self.id.is_empty()
            && p.file_name()? == "manifest.json"
            && id.file_name()? == self.id.as_str()
            && snapshots.file_name()? == "snapshots"
            && upgrade.file_name()? == "upgrade"
            && !self.manifest_path.contains("/../"))
        .then_some(p)
    }
}

/// `hack upgrade rollback --json` without `--rollback-manifest`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SnapshotList {
    /// `choose`.
    pub status: String,
    pub snapshots: Vec<SnapshotEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RestoredFile {
    pub path: String,
    pub label: String,
    /// `restored | moved-aside | already-restored | conflict | not-a-file |
    /// backup-damaged | error`.
    pub status: String,
    /// Where the CLI kept what the restore replaced.
    pub kept_as: Option<String>,
    pub message: Option<String>,
}

/// `hack upgrade rollback --rollback-manifest <m> --json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Rollback {
    /// `restored | incomplete | invalid-manifest | busy`.
    pub status: String,
    pub message: Option<String>,
    pub results: Vec<RestoredFile>,
}

impl Rollback {
    /// The result in words: what came back, what was left as it is.
    #[must_use]
    pub fn summary(&self) -> String {
        match self.status.as_str() {
            "restored" | "incomplete" => {
                let count = |s: &[&str]| {
                    self.results
                        .iter()
                        .filter(|r| s.contains(&r.status.as_str()))
                        .count()
                };
                let back = count(&["restored", "moved-aside", "already-restored"]);
                let left = count(&["conflict"]);
                let failed = self.results.len() - back - left;
                let mut s = format!("Restored {back} of {}", self.results.len());
                if left > 0 {
                    s.push_str(&format!(
                        " · {left} changed since the snapshot, left as it is"
                    ));
                }
                if failed > 0 {
                    s.push_str(&format!(" · {failed} could not be restored"));
                }
                s
            }
            other => format!(
                "Restore refused ({other}): {}",
                self.message.as_deref().unwrap_or("no reason given")
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECK: &str = include_str!("../tests/fixtures/upgrade/check-v2.json");

    #[test]
    fn the_current_check_report_is_read_with_its_grouped_plan() {
        let r = CheckReport::parse(CHECK).unwrap();
        assert!(r.ready);
        assert_eq!(r.verdict(), "Ready to upgrade");
        assert_eq!(
            r.plan.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["snapshot", "env-format", "ignore-rules"]
        );
        let ignore = r.plan.iter().find(|p| p.id == "ignore-rules").unwrap();
        assert_eq!((ignore.count, ignore.targets.len()), (3, 3));
        assert_eq!(ignore.how(), "hack upgrade apply runs it");
        assert_eq!(r.plan[0].how(), "Save snapshot below");
        assert_eq!(r.projects.len(), 3);
    }

    #[test]
    fn a_not_ready_report_names_blockers_and_unrun_checks() {
        let mut v: serde_json::Value = serde_json::from_str(CHECK).unwrap();
        v["data"]["ready"] = false.into();
        v["data"]["blockers"] =
            serde_json::json!([{"scope": "alpha", "id": "env-key", "summary": "key missing"}]);
        v["data"]["incomplete"] = serde_json::json!([
            {"scope": "machine", "id": "docker", "summary": "x"},
            {"scope": "beta", "id": "native-preflight", "summary": "y"}
        ]);
        let r = CheckReport::parse(&v.to_string()).unwrap();
        assert_eq!(
            r.verdict(),
            "Not ready: 1 blocker, 2 checks that could not run"
        );
    }

    #[test]
    fn the_envelope_is_read_whatever_the_exit_and_errors_keep_their_code() {
        assert_eq!(
            envelope::<SnapshotList>(r#"{"ok":true,"data":{"status":"choose","snapshots":[]}}"#)
                .unwrap()
                .status,
            "choose"
        );
        assert_eq!(
            envelope::<SnapshotList>(r#"{"ok":false,"error":{"code":"E_USAGE","message":"bad"}}"#)
                .unwrap_err(),
            "E_USAGE: bad"
        );
        assert!(envelope::<SnapshotList>("not json").is_err());
        let mut v: serde_json::Value = serde_json::from_str(CHECK).unwrap();
        v["data"]["report_version"] = 3.into();
        assert!(
            CheckReport::parse(&v.to_string())
                .unwrap_err()
                .contains("version 3")
        );
    }

    #[test]
    fn restore_takes_only_a_manifest_the_cli_keeps() {
        let entry = |id: &str, path: &str| SnapshotEntry {
            id: id.into(),
            manifest_path: path.into(),
            ..SnapshotEntry::default()
        };
        assert!(
            entry("s1", "/h/.hack/upgrade/snapshots/s1/manifest.json")
                .manifest()
                .is_some()
        );
        for (id, path) in [
            ("s1", "relative/upgrade/snapshots/s1/manifest.json"),
            ("s1", "/h/.hack/upgrade/snapshots/s2/manifest.json"),
            ("s1", "/h/.hack/upgrade/snapshots/s1/other.json"),
            ("s1", "/tmp/anywhere/s1/manifest.json"),
            (
                "s1",
                "/h/.hack/upgrade/snapshots/../snapshots/s1/manifest.json",
            ),
            ("", "/h/.hack/upgrade/snapshots//manifest.json"),
        ] {
            assert!(entry(id, path).manifest().is_none(), "{path}");
        }
    }

    #[test]
    fn snapshot_and_restore_results_read_as_designed() {
        let s: Snapshot = envelope(
            r#"{"ok":true,"data":{"status":"created","id":"s1","manifest_path":"/h/.hack/upgrade/snapshots/s1/manifest.json",
            "files":[{"path":"/a","label":"a"},{"path":"/b","label":"b"}],"skipped":[],"complete":true,"gaps":[]}}"#,
        )
        .unwrap();
        assert_eq!(s.summary(), "Snapshot s1 kept 2 files");
        let gappy = Snapshot {
            complete: false,
            gaps: vec![Gap::default()],
            ..s.clone()
        };
        assert!(gappy.summary().ends_with("incomplete: 1 not covered"));
        let refused = Snapshot {
            status: "refused".into(),
            message: Some("busy".into()),
            ..Snapshot::default()
        };
        assert_eq!(refused.summary(), "Snapshot refused: busy");
        let r: Rollback = envelope(
            r#"{"ok":true,"data":{"status":"incomplete","results":[
            {"path":"/a","label":"a","status":"restored"},
            {"path":"/b","label":"b","status":"conflict"},
            {"path":"/c","label":"c","status":"backup-damaged"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            r.summary(),
            "Restored 1 of 3 · 1 changed since the snapshot, left as it is · 1 could not be restored"
        );
        let busy = Rollback {
            status: "busy".into(),
            message: Some("another upgrade runs".into()),
            ..Rollback::default()
        };
        assert_eq!(
            busy.summary(),
            "Restore refused (busy): another upgrade runs"
        );
    }
}
