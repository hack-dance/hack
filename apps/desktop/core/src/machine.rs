//! The Machine pane's hackd card and read-only always-on summary
//! (DESIGN.md sections 5 and 6, HACK-2288 item 6). Pure: the inputs are what
//! the CLI and hackd already report, the output is what the window shows.
//!
//! hackd: `hack daemon status --json` (state, PID, staleness, the login
//! service) and `GET /v1/status` (the version hackd runs). Each state has at
//! most one action, and only Start or Restart hackd, which the window runs
//! through the shared machine gate and the checked CLI. A login service that
//! needs installing or repairing points at Setup, whose install is guarded.
//!
//! Always-on: the `autostart` object of each project and the payload's
//! `autostart_global` (docs/always-on-projects.md, "JSON contract"). The app
//! runs no `hack autostart` command; this is a summary only. A field the
//! payload does not carry is unknown, never off.

use crate::models::{Autostart, AutostartGlobal, DaemonApiStatus, DaemonStatus, ProjectsPayload};
use crate::source::UpdateSide;

/// How a card or line reads at a glance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Ok,
    Attention,
    Problem,
    Unknown,
}

/// The one action the hackd card offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardAction {
    /// `hack daemon start` (also cleans stale process files).
    Start,
    /// `hack daemon restart`: only when hackd is older than the CLI.
    Restart,
    /// Install or repair the login service: in Setup, which checks first.
    OpenSetup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HackdCard {
    pub tone: Tone,
    pub title: String,
    /// Facts under the title (version, PID, why), in order.
    pub details: Vec<String>,
    pub action: Option<CardAction>,
    /// The login service, as its own line.
    pub login_service: (Tone, String),
}

/// Whether the CLI's report says hackd runs: `running`, or an answering API
/// without a tracked PID (`status: "running"` with `api_ok` or
/// `api_reachable`), as Setup reads it.
#[must_use]
pub fn hackd_running(s: &DaemonStatus) -> bool {
    s.running || (s.status == "running" && (s.api_ok || s.api_reachable == Some(true)))
}

/// The hackd card. `status`: `hack daemon status --json`, `None` when it
/// could not be read. `api`: `/v1/status`, `None` when hackd did not answer.
#[must_use]
pub fn hackd_card(
    status: Option<&DaemonStatus>,
    api: Option<&DaemonApiStatus>,
    cli_version: Option<&str>,
) -> HackdCard {
    let Some(s) = status else {
        return HackdCard {
            tone: Tone::Unknown,
            title: "hackd status was not read".into(),
            details: vec!["Check again, or run hack daemon status in a terminal.".into()],
            action: None,
            login_service: (Tone::Unknown, "Login service: unknown".into()),
        };
    };
    let login_service = login_service_line(s);
    let mut details = Vec::new();
    // `/v1/status` may be from an earlier read: its version describes hackd
    // only while the CLI says hackd runs.
    let version = api
        .map(|a| a.version.as_str())
        .filter(|v| !v.is_empty() && hackd_running(s));
    if let Some(v) = version {
        details.push(match s.pid {
            Some(pid) => format!("hackd {v} · pid {pid}"),
            None => format!("hackd {v}"),
        });
    }
    if let Some(issue) = s.issue.as_deref().filter(|i| !i.is_empty()) {
        details.push(issue.to_owned());
    }
    let (tone, title, action) = if hackd_running(s) {
        match (version, cli_version) {
            (Some(v), Some(c)) if v != c && s.api_compatible != Some(true) => {
                match UpdateSide::for_versions(v, c) {
                    UpdateSide::Daemon => (
                        Tone::Attention,
                        format!("hackd {v} is older than this CLI ({c}): restart hackd"),
                        Some(CardAction::Restart),
                    ),
                    // Restarting from an older CLI would downgrade hackd.
                    UpdateSide::Cli => (
                        Tone::Attention,
                        format!(
                            "hackd {v} is newer than this CLI ({c}): update the CLI with hack update"
                        ),
                        None,
                    ),
                }
            }
            _ if s.status == "starting" => (Tone::Unknown, "hackd is starting".into(), None),
            _ if s.status == "incompatible" => (
                Tone::Attention,
                "hackd is running but this CLI cannot use it".into(),
                Some(CardAction::Restart),
            ),
            _ => (Tone::Ok, "hackd running".into(), None),
        }
    } else if s.stale {
        if let Some(why) = s.stale_reason.as_deref() {
            details.push(format!("stale process files ({why})"));
        }
        (
            Tone::Problem,
            "hackd stopped unexpectedly".into(),
            Some(CardAction::Start),
        )
    } else if s.service.as_ref().is_some_and(|v| v.installed) {
        (
            Tone::Problem,
            "hackd stopped (login service installed)".into(),
            Some(CardAction::Start),
        )
    } else {
        (Tone::Problem, "hackd off".into(), Some(CardAction::Start))
    };
    // A login service that needs repair is the one thing to do once hackd
    // itself is fine.
    let action = match (action, &login_service.0) {
        (None, Tone::Attention) => Some(CardAction::OpenSetup),
        (a, _) => a,
    };
    HackdCard {
        tone,
        title,
        details,
        action,
        login_service,
    }
}

fn login_service_line(s: &DaemonStatus) -> (Tone, String) {
    let Some(svc) = &s.service else {
        return (Tone::Unknown, "Login service: unknown".into());
    };
    let manager = svc.manager.as_deref().unwrap_or("service manager");
    if svc.installed {
        match svc.next_step.as_deref().filter(|n| !n.is_empty()) {
            // The CLI names a next step when the unit is wrong (a stale or
            // missing binary, say).
            Some(next) => (
                Tone::Attention,
                format!("Login service is out of date: {next}"),
            ),
            None => (Tone::Ok, format!("Login service installed ({manager})")),
        }
    } else if svc.available {
        (
            Tone::Unknown,
            "Login service not installed: hackd and always-on projects do not start at login"
                .into(),
        )
    } else {
        (
            Tone::Unknown,
            format!("Login service unavailable ({manager} not available)"),
        )
    }
}

/// One project's always-on line under its header, `None` when it is not
/// always on. Read-only: it never offers an `autostart` command.
#[must_use]
pub fn always_on_note(a: &Autostart, global: Option<&AutostartGlobal>) -> Option<(Tone, String)> {
    // Not marked: no line, whatever the state says (an invalid marker still
    // reports `needs_attention`, which is shown).
    if !a.enabled && a.state != "needs_attention" {
        return None;
    }
    // A recorded attempt that did not start the project (skipped, failed,
    // or a status this version does not know).
    let attempt = a
        .last_result
        .as_ref()
        .filter(|r| !matches!(r.status.as_str(), "started" | "already_running"));
    let note = match a.state.as_str() {
        "on" => match attempt {
            Some(r) => (
                Tone::Attention,
                format!(
                    "Always on · last automatic start {}",
                    reason_text(&r.status, r.reason.as_deref())
                ),
            ),
            None => (Tone::Ok, "Always on".into()),
        },
        "paused" if a.paused_reason.as_deref() == Some("manual_stop") => (
            Tone::Unknown,
            "Always on · paused until you start it".into(),
        ),
        "paused" if global.is_some_and(|g| g.paused) => {
            (Tone::Unknown, "Always on · paused for all projects".into())
        }
        "paused" => (Tone::Unknown, "Always on · paused".into()),
        "starting" => (Tone::Unknown, "Always on · starting at login".into()),
        "needs_attention" => (Tone::Problem, needs_attention_text(a)),
        other => (
            Tone::Unknown,
            format!("Always on · state the app does not know ({other})"),
        ),
    };
    Some(note)
}

fn needs_attention_text(a: &Autostart) -> String {
    let reason = a.last_result.as_ref().and_then(|r| r.reason.as_deref());
    if reason == Some("invalid_marker") {
        return "Always-on marker is invalid: remove it and add it again with the CLI".into();
    }
    let f = &a.failures;
    if f.count > 0 {
        let mut text = format!(
            "Always-on stopped trying after {} failure{}",
            f.count,
            if f.count == 1 { "" } else { "s" }
        );
        if !f.failed_services.is_empty() {
            text.push_str(&format!(" · failed: {}", f.failed_services.join(", ")));
        }
        return text;
    }
    match reason {
        Some(code) => format!("Always on needs attention ({code})"),
        None => "Always on needs attention".into(),
    }
}

/// A recorded attempt in words. Unknown codes are kept, as the contract asks.
fn reason_text(status: &str, reason: Option<&str>) -> String {
    let code = reason.unwrap_or("no reason given");
    match status {
        "skipped" => format!("skipped ({code})"),
        "failed" => format!("failed ({code})"),
        other => format!("failed ({other}: {code})"),
    }
}

/// The Machine pane's always-on summary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AlwaysOnSummary {
    /// Projects whose marker is enabled.
    pub marked: usize,
    pub on: usize,
    pub paused: usize,
    pub starting: usize,
    pub needs_attention: usize,
    /// `None` when the payload carries no `autostart_global`.
    pub global_paused: Option<bool>,
    /// The login run, in words, while one is under way.
    pub login_run: Option<String>,
    /// Whether a login-service file is installed, as the CLI reports it.
    pub service_ready: Option<bool>,
    /// Each always-on project: its name and line.
    pub rows: Vec<(String, Tone, String)>,
}

#[must_use]
pub fn always_on_summary(payload: &ProjectsPayload) -> AlwaysOnSummary {
    let global = payload.autostart_global.as_ref();
    let mut s = AlwaysOnSummary {
        global_paused: global.map(|g| g.paused),
        service_ready: global.map(|g| g.service_ready),
        login_run: global.and_then(login_run_text),
        ..AlwaysOnSummary::default()
    };
    for p in &payload.projects {
        let Some(a) = p.autostart.as_ref().filter(|a| a.enabled) else {
            continue;
        };
        s.marked += 1;
        match a.state.as_str() {
            "on" => s.on += 1,
            "paused" => s.paused += 1,
            "starting" => s.starting += 1,
            "needs_attention" => s.needs_attention += 1,
            _ => {}
        }
        if let Some((tone, line)) = always_on_note(a, global) {
            s.rows.push((p.name.clone(), tone, line));
        }
    }
    s
}

fn login_run_text(g: &AutostartGlobal) -> Option<String> {
    let run = &g.login_run;
    if run.waiting_for_engine {
        return Some("At login: waiting for the container engine before starting projects".into());
    }
    if !run.in_progress {
        return None;
    }
    let done = run.started.len() + run.failed.len();
    let total = done + run.pending.len();
    let mut text = format!("At login: started {done} of {total}");
    if !run.failed.is_empty() {
        text.push_str(&format!(" · {} failed", run.failed.len()));
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AutostartFailures, AutostartLoginRun, AutostartResult, DaemonService};

    fn status(json: &str) -> DaemonStatus {
        serde_json::from_str(json).unwrap()
    }

    fn api(version: &str) -> DaemonApiStatus {
        DaemonApiStatus {
            status: "running".into(),
            version: version.into(),
            ..DaemonApiStatus::default()
        }
    }

    #[test]
    fn each_hackd_state_has_its_line_and_at_most_one_action() {
        let card = |s: &str, v: Option<&str>| {
            let s = status(s);
            let a = v.map(api);
            hackd_card(Some(&s), a.as_ref(), Some("5.0.0"))
        };
        let off = card(
            r#"{"status":"stopped","running":false,"service":{"available":true,"installed":false}}"#,
            None,
        );
        assert_eq!(
            (off.title.as_str(), off.action),
            ("hackd off", Some(CardAction::Start))
        );
        let stopped = card(
            r#"{"status":"stopped","running":false,"service":{"installed":true,"manager":"launchd"}}"#,
            None,
        );
        assert_eq!(stopped.title, "hackd stopped (login service installed)");
        assert_eq!(stopped.action, Some(CardAction::Start));
        // A version from an earlier /v1/status is not shown for a stopped hackd.
        let old_api = card(r#"{"status":"stopped","running":false}"#, Some("5.0.0"));
        assert!(old_api.details.is_empty(), "{:?}", old_api.details);
        let stale = card(
            r#"{"status":"stale","running":false,"stale":true,"stale_reason":"pid_not_running"}"#,
            None,
        );
        assert_eq!(
            (stale.title.as_str(), stale.action),
            ("hackd stopped unexpectedly", Some(CardAction::Start))
        );
        assert!(stale.details.iter().any(|d| d.contains("pid_not_running")));
        let ok = card(
            r#"{"status":"running","running":true,"pid":42,"service":{"installed":true,"manager":"systemd"}}"#,
            Some("5.0.0"),
        );
        assert_eq!(
            (ok.tone, ok.title.as_str(), ok.action),
            (Tone::Ok, "hackd running", None)
        );
        assert_eq!(ok.details, vec!["hackd 5.0.0 · pid 42".to_owned()]);
        assert_eq!(
            ok.login_service,
            (Tone::Ok, "Login service installed (systemd)".into())
        );
        let starting = card(r#"{"status":"starting","running":true}"#, None);
        assert_eq!(
            (starting.title.as_str(), starting.action),
            ("hackd is starting", None)
        );
    }

    #[test]
    fn an_answering_hackd_without_a_pid_is_running_not_off() {
        let s = status(r#"{"status":"running","running":false,"api_ok":true}"#);
        let card = hackd_card(Some(&s), Some(&api("5.0.0")), Some("5.0.0"));
        assert_eq!((card.title.as_str(), card.action), ("hackd running", None));
    }

    #[test]
    fn a_version_mismatch_restarts_an_older_hackd_and_never_downgrades_a_newer_one() {
        let s = status(r#"{"status":"running","running":true}"#);
        let older = hackd_card(Some(&s), Some(&api("4.3.0")), Some("5.0.0"));
        assert_eq!(older.action, Some(CardAction::Restart));
        assert!(older.title.contains("older than this CLI"));
        let newer = hackd_card(Some(&s), Some(&api("5.1.0")), Some("5.0.0"));
        assert_eq!(newer.action, None, "restarting would downgrade hackd");
        assert!(newer.title.contains("hack update"));
        // The CLI says it can use this hackd: nothing to do.
        let compatible = status(r#"{"status":"running","running":true,"api_compatible":true}"#);
        let card = hackd_card(
            Some(&compatible),
            Some(&api("5.0.0-next.20")),
            Some("5.0.0"),
        );
        assert_eq!((card.title.as_str(), card.action), ("hackd running", None));
    }

    #[test]
    fn a_stale_login_service_points_at_setup_once_hackd_is_fine() {
        let s = DaemonStatus {
            status: "running".into(),
            running: true,
            service: Some(DaemonService {
                installed: true,
                next_step: Some("hack daemon install".into()),
                ..DaemonService::default()
            }),
            ..DaemonStatus::default()
        };
        let card = hackd_card(Some(&s), Some(&api("5.0.0")), Some("5.0.0"));
        assert_eq!(card.login_service.0, Tone::Attention);
        assert!(card.login_service.1.contains("out of date"));
        assert_eq!(card.action, Some(CardAction::OpenSetup));
        // hackd off as well: Start first.
        let mut off = s.clone();
        off.running = false;
        off.status = "stopped".into();
        assert_eq!(
            hackd_card(Some(&off), None, Some("5.0.0")).action,
            Some(CardAction::Start)
        );
    }

    #[test]
    fn an_unread_status_is_unknown_with_no_action() {
        let card = hackd_card(None, None, Some("5.0.0"));
        assert_eq!((card.tone, card.action), (Tone::Unknown, None));
    }

    fn autostart(state: &str) -> Autostart {
        Autostart {
            enabled: true,
            state: state.into(),
            max_failures: Some(3),
            ..Autostart::default()
        }
    }

    #[test]
    fn each_always_on_state_reads_as_designed() {
        let note = |a: &Autostart| always_on_note(a, None).map(|(_, t)| t);
        assert_eq!(note(&Autostart::default()), None, "unmarked: no line");
        assert_eq!(note(&autostart("on")).as_deref(), Some("Always on"));
        let mut manual = autostart("paused");
        manual.paused_reason = Some("manual_stop".into());
        assert_eq!(
            note(&manual).as_deref(),
            Some("Always on · paused until you start it")
        );
        let global = AutostartGlobal {
            paused: true,
            ..AutostartGlobal::default()
        };
        assert_eq!(
            always_on_note(&autostart("paused"), Some(&global))
                .map(|(_, t)| t)
                .as_deref(),
            Some("Always on · paused for all projects")
        );
        assert_eq!(
            note(&autostart("starting")).as_deref(),
            Some("Always on · starting at login")
        );
        let mut failed = autostart("needs_attention");
        failed.failures = AutostartFailures {
            count: 3,
            failed_services: vec!["api".into(), "worker".into()],
            ..AutostartFailures::default()
        };
        assert_eq!(
            note(&failed).as_deref(),
            Some("Always-on stopped trying after 3 failures · failed: api, worker")
        );
        let mut invalid = autostart("needs_attention");
        invalid.last_result = Some(AutostartResult {
            status: "skipped".into(),
            reason: Some("invalid_marker".into()),
            at: Some("1970-01-01T00:00:00.000Z".into()),
        });
        assert!(note(&invalid).unwrap().contains("marker is invalid"));
    }

    #[test]
    fn a_skipped_or_unknown_last_start_is_shown_with_its_code() {
        let mut a = autostart("on");
        a.last_result = Some(AutostartResult {
            status: "skipped".into(),
            reason: Some("engine_timeout".into()),
            at: None,
        });
        let (tone, text) = always_on_note(&a, None).unwrap();
        assert_eq!(tone, Tone::Attention);
        assert_eq!(
            text,
            "Always on · last automatic start skipped (engine_timeout)"
        );
        // A future status the app does not know reads as a failure and keeps
        // its code.
        a.last_result = Some(AutostartResult {
            status: "deferred".into(),
            reason: Some("new_reason".into()),
            at: None,
        });
        assert!(
            always_on_note(&a, None)
                .unwrap()
                .1
                .contains("failed (deferred: new_reason)")
        );
        // A success is not news.
        a.last_result = Some(AutostartResult {
            status: "already_running".into(),
            ..AutostartResult::default()
        });
        assert_eq!(always_on_note(&a, None).unwrap().1, "Always on");
    }

    #[test]
    fn the_summary_counts_marked_projects_and_reads_the_login_run() {
        let payload: ProjectsPayload = serde_json::from_value(serde_json::json!({
            "projects": [
                {"name": "a", "autostart": {"enabled": true, "state": "on"}},
                {"name": "b", "autostart": {"enabled": true, "state": "starting"}},
                {"name": "c", "autostart": {"enabled": true, "state": "needs_attention",
                    "failures": {"count": 3, "failed_services": ["api"]}}},
                {"name": "d", "autostart": {"enabled": false, "state": "off"}},
                {"name": "e"}
            ],
            "autostart_global": {"paused": false, "service_ready": true,
                "login_run": {"in_progress": true, "pending": ["b"], "started": ["a"], "failed": ["c"]}}
        }))
        .unwrap();
        let s = always_on_summary(&payload);
        assert_eq!(
            (s.marked, s.on, s.starting, s.needs_attention, s.paused),
            (3, 1, 1, 1, 0)
        );
        assert_eq!(s.global_paused, Some(false));
        assert_eq!(s.service_ready, Some(true));
        assert_eq!(
            s.login_run.as_deref(),
            Some("At login: started 2 of 3 · 1 failed")
        );
        assert_eq!(
            s.rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn a_payload_without_the_global_object_is_unknown_not_off() {
        let payload: ProjectsPayload =
            serde_json::from_value(serde_json::json!({"projects": []})).unwrap();
        let s = always_on_summary(&payload);
        assert_eq!(
            (s.global_paused, s.service_ready, s.login_run),
            (None, None, None)
        );
        let waiting = AutostartGlobal {
            login_run: AutostartLoginRun {
                waiting_for_engine: true,
                ..AutostartLoginRun::default()
            },
            ..AutostartGlobal::default()
        };
        assert!(
            login_run_text(&waiting)
                .unwrap()
                .contains("waiting for the container engine")
        );
    }
}
