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
//! The app uses structured argv for user-initiated runs in the shared drawer.

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
    /// CLI argv for the same command, when supplied by this report.
    pub args: Option<Vec<String>>,
    /// What to do by hand, when the remedy is not (only) a command.
    pub action: Option<String>,
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

/// Evidence from the read-only release check for the selected CLI.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum UpdateObservation {
    Available(ReleaseUpdate),
    NetworkUnavailable,
    #[default]
    NoNotice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseUpdate {
    pub latest: String,
    pub upgrade_command: Option<Vec<String>>,
}

impl ReleaseUpdate {
    /// Bind only the release observer's supported install commands.
    #[must_use]
    pub fn command(&self, checked: &crate::setup::Report) -> Option<crate::terminal::CommandSpec> {
        use crate::terminal::CommandSpec;
        if !checked.cli_ready() {
            return None;
        }
        let (program, args) = self.upgrade_command.as_deref()?.split_first()?;
        let context = checked.context.as_ref()?.with_controlled_path().ok()?;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        let trusted = |path: &Path| crate::source::trusted_tool_path(path, uid, false);
        let program = match args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["update"]
                if checked.cli_program.as_ref().is_some_and(|selected| {
                    selected == program
                        || std::fs::canonicalize(selected).is_ok_and(|path| {
                            std::fs::canonicalize(program).is_ok_and(|reported| reported == path)
                        })
                }) =>
            {
                return checked.command(args.to_vec()).ok();
            }
            ["upgrade", "hack-dance/tap/hack"] if program == "brew" => {
                std::env::split_paths(context.value("PATH")?)
                    .chain(["/opt/homebrew/bin".into(), "/usr/local/bin".into()])
                    .find_map(|dir| trusted(&dir.join(program)))?
            }
            ["--manager", "upgrade", "--version", version]
                if *version == self.latest
                    && Path::new(program).is_absolute()
                    && Path::new(program)
                        .file_name()
                        .is_some_and(|name| name == "hack-next") =>
            {
                trusted(Path::new(program))?
            }
            _ => return None,
        };
        context
            .bind(&CommandSpec {
                program: program.to_str()?.into(),
                args: args.to_vec(),
            })
            .ok()
    }

    /// Quote each argument for display and copying to the user's terminal.
    #[must_use]
    pub fn terminal_command(&self) -> Option<String> {
        let argv = self.upgrade_command.as_deref()?;
        argv.first()?;
        argv.iter()
            .map(|arg| crate::terminal::quote(arg))
            .collect::<Result<Vec<_>, _>>()
            .ok()
            .map(|args| args.join(" "))
    }
}

#[derive(Deserialize)]
struct UpdateReport {
    latest: Option<String>,
    available: Option<bool>,
    reason: Option<String>,
    upgrade_command: Option<Vec<String>>,
}

/// The checked CLI owns release selection and comparison. The desktop only
/// displays the observation and never executes an upgrade command from it.
#[must_use]
pub fn observe_update(checked: &crate::setup::Report) -> UpdateObservation {
    let read = || {
        let program = checked.cli_program.as_ref()?;
        let context = checked.context.as_ref()?.with_controlled_path().ok()?;
        context
            .runner(program)
            .ok()?
            .run_schema_json::<UpdateReport>(
                &["update", "--check", "--json", "--observe"],
                None,
                std::time::Duration::from_secs(20),
                "hack.update-check.v1",
            )
            .ok()
    };
    if !checked.cli_ready() {
        return UpdateObservation::NoNotice;
    }
    read().map_or(UpdateObservation::NoNotice, UpdateReport::observation)
}

impl UpdateReport {
    fn observation(self) -> UpdateObservation {
        match self {
            UpdateReport {
                available: Some(true),
                latest: Some(version),
                reason: None,
                upgrade_command,
            } if version.len() <= 64
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
                && crate::source::compare_versions(&version, &version).is_some() =>
            {
                UpdateObservation::Available(ReleaseUpdate {
                    latest: version,
                    upgrade_command,
                })
            }
            UpdateReport {
                available: None,
                latest: None,
                reason: Some(reason),
                ..
            } if reason == "network-unavailable" => UpdateObservation::NetworkUnavailable,
            _ => UpdateObservation::NoNotice,
        }
    }
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
    /// CLI argv, separate from the copy text.
    pub args: Option<Vec<String>>,
    /// What to do by hand, when the remedy is not (only) a command (for
    /// example restoring a store's key as an alternative to retiring it).
    pub action: Option<String>,
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
    #[test]
    fn release_observations_require_consistent_and_versioned_evidence() {
        for (input, expected) in [
            (
                r#"{"available":true,"latest":"5.1.0-next.2","reason":null,"upgrade_command":["/opt/Hack Next/bin/hack-next","--manager","upgrade","--version","5.1.0-next.2"]}"#,
                UpdateObservation::Available(ReleaseUpdate {
                    latest: "5.1.0-next.2".into(),
                    upgrade_command: Some(
                        [
                            "/opt/Hack Next/bin/hack-next",
                            "--manager",
                            "upgrade",
                            "--version",
                            "5.1.0-next.2",
                        ]
                        .map(String::from)
                        .to_vec(),
                    ),
                }),
            ),
            (
                r#"{"available":true,"latest":"5.1.0","reason":null,"upgrade_command":null}"#,
                UpdateObservation::Available(ReleaseUpdate {
                    latest: "5.1.0".into(),
                    upgrade_command: None,
                }),
            ),
            (
                r#"{"available":null,"latest":null,"reason":"network-unavailable"}"#,
                super::UpdateObservation::NetworkUnavailable,
            ),
            (
                r#"{"available":true,"latest":"not-a-version","reason":null}"#,
                super::UpdateObservation::NoNotice,
            ),
            (
                r#"{"available":true,"latest":"5.1.0","reason":"network-unavailable"}"#,
                super::UpdateObservation::NoNotice,
            ),
        ] {
            let report: super::UpdateReport = serde_json::from_str(input).unwrap();
            assert_eq!(report.observation(), expected);
        }
    }

    #[test]
    fn release_install_commands_quote_argv_for_copy_and_refuse_control_characters() {
        let mut release = ReleaseUpdate {
            latest: "5.1.0".into(),
            upgrade_command: Some(vec!["/opt/Hack's CLI/hack".into(), "update".into()]),
        };
        assert_eq!(
            release.terminal_command().as_deref(),
            Some(r"'/opt/Hack'\''s CLI/hack' 'update'")
        );
        release.upgrade_command = Some(vec!["hack\n".into(), "update".into()]);
        assert_eq!(release.terminal_command(), None);
        release.upgrade_command = Some(vec![]);
        assert_eq!(release.terminal_command(), None);
        release.upgrade_command = None;
        assert_eq!(release.terminal_command(), None);
    }

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
        assert_eq!(
            ignore.args.as_deref().unwrap(),
            ["upgrade", "apply", "--only", "ignore-rules"],
        );
        assert_eq!(r.plan[0].how(), "Save snapshot below");
        assert_eq!(r.projects.len(), 3);
        let mut v: serde_json::Value = serde_json::from_str(CHECK).unwrap();
        v["data"]["plan"][1]["action"] = "Restore the store's key from your backup.".into();
        let with_action = CheckReport::parse(&v.to_string()).unwrap();
        assert_eq!(
            with_action.plan[1].action.as_deref(),
            Some("Restore the store's key from your backup.")
        );
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
