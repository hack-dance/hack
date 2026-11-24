//! Fresh setup evidence. Skips only affect this view; they never satisfy a check.
use crate::{
    doctor::DoctorRun,
    models::{DoctorCheck, ProjectsPayload},
    source::Snapshot,
};
use serde::Serialize;

pub const NATIVE_DOC: &str =
    "https://github.com/hack-dance/hack/blob/next/docs/guides/native-candidate.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Status {
    Passed,
    NeedsAttention,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SafeAction {
    StartDaemon,
    InstallDaemon,
}
impl SafeAction {
    pub fn args(self) -> &'static [&'static str] {
        match self {
            Self::StartDaemon => &["daemon", "start"],
            Self::InstallDaemon => &["daemon", "install"],
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Remedy {
    Copy(String),
    Admin(Vec<String>),
    Run(SafeAction),
    Doc(String),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Card {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub detail: String,
    pub remedy: Remedy,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    pub cards: Vec<Card>,
    pub cli_program: Option<String>,
    pub context: Option<crate::execution::ExecutionContext>,
    pub force_cli_gate: bool,
}
impl Report {
    pub fn needed(&self) -> bool {
        self.cards.is_empty() || self.cards.iter().any(|c| c.status != Status::Passed)
    }
    /// Bind authored argv to the executable and non-secret context actually checked.
    pub fn command(&self, args: Vec<String>) -> Result<crate::terminal::CommandSpec, String> {
        if !self.cli_ready() {
            return Err("The CLI has not been checked".into());
        }
        // A bound command runs later in a terminal or from the clipboard, so
        // its PATH keeps only directories no other user can change.
        let context = &self
            .context
            .as_ref()
            .ok_or("Execution context has not been checked")?
            .with_controlled_path()?;
        let compose = if args.first().is_some_and(|s| s == "global")
            && args.get(1).is_some_and(|s| s == "install" || s == "trust")
        {
            Some(context.with_backend("compose")?)
        } else {
            None
        };
        let program = self
            .cli_program
            .clone()
            .ok_or("CLI executable has not been checked")?;
        let mut spec = compose
            .as_ref()
            .unwrap_or(context)
            .bind(&crate::terminal::CommandSpec {
                program: program.clone(),
                args,
            })?;
        // The CLI restarts or starts the daemon by invoking itself and would
        // otherwise prefer whatever `hack` is first on PATH: pin the checked one.
        let at = spec
            .args
            .iter()
            .position(|a| *a == program)
            .ok_or("Bound command lost its executable")?;
        spec.args.insert(at, format!("HACK_MCP_COMMAND={program}"));
        Ok(spec)
    }
    pub fn cli_ready(&self) -> bool {
        self.cards
            .first()
            .is_some_and(|c| c.id == "cli" && c.status == Status::Passed)
    }
}
#[derive(Debug, Clone, Default)]
pub struct Pane {
    pub report: Report,
    pub loading: bool,
    pub action_busy: bool,
    pub refresh_again: bool,
    pub pending_fix: bool,
    pub result: Option<String>,
    pub skipped: std::collections::BTreeSet<String>,
    generation: u64,
    started_at: Option<std::time::Instant>,
    /// Start time of the accepted report, used to order it against Doctor.
    pub observed_at: Option<std::time::Instant>,
    pub checked_at: Option<std::time::Instant>,
    /// Bumped when the app switches CLI: an action started under the
    /// previous one compares it on completion and is dropped.
    source_epoch: u64,
}
impl Pane {
    pub fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.started_at = Some(std::time::Instant::now());
        self.loading = true;
        if !self.pending_fix {
            self.result = None;
        }
        self.generation
    }
    pub fn finish(&mut self, generation: u64, report: Report) {
        if generation == self.generation {
            self.report = report;
            self.loading = false;
            self.observed_at = self.started_at;
            self.checked_at = Some(std::time::Instant::now());
        }
    }
    /// The app switched CLI: the report, its bound commands and anything
    /// in flight belong to the previous install. A check still running is
    /// dropped by the generation; an action by [`Self::source_epoch`].
    pub fn source_changed(&mut self) {
        let generation = self.generation + 1;
        let source_epoch = self.source_epoch + 1;
        *self = Self {
            generation,
            source_epoch,
            ..Self::default()
        };
    }

    /// Whether `generation` is the check now expected (not one a later
    /// check or a CLI switch replaced).
    #[must_use]
    pub fn is_current(&self, generation: u64) -> bool {
        generation == self.generation
    }

    #[must_use]
    pub fn source_epoch(&self) -> u64 {
        self.source_epoch
    }

    pub fn skip(&mut self, id: &str) {
        if id != "cli" && self.report.cards.iter().any(|c| c.id == id) {
            self.skipped.insert(id.into());
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub enum Platform {
    Mac,
    Linux,
    Other,
}
impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

fn evidence(check: Option<&DoctorCheck>) -> (Status, String) {
    match check {
        Some(c) => (
            match c.status.as_str() {
                "ok" => Status::Passed,
                "warn" | "error" => Status::NeedsAttention,
                _ => Status::Unknown,
            },
            c.detail.chars().take(2048).collect(),
        ),
        None => (Status::Unknown, "Check missing; could not confirm".into()),
    }
}
fn check(runs: &[DoctorRun], project: Option<&str>, id: &str) -> (Status, String) {
    // Never borrow another project's evidence. Duplicate conflicting reports fail closed.
    let found: Vec<_> = runs
        .iter()
        .filter(|r| r.project.as_deref() == project)
        .filter_map(|r| r.result.as_ref().ok())
        .flat_map(|r| &r.checks)
        .filter(|c| c.id == id)
        .collect();
    if found.len() == 1 {
        evidence(found.first().copied())
    } else {
        (Status::Unknown, format!("{id}: missing or ambiguous check"))
    }
}
/// Where a shared-home hackd card points: how to give each install its own
/// home.
pub const SHARED_HOME_DOC: &str =
    "https://github.com/hack-dance/hack/blob/next/docs/versions/v5/install.md";

/// Another install's CLI (`other`) shares this home and its hackd, which
/// runs another version than the app's CLI: the hackd card names it and
/// offers no restart, which would replace that install's daemon.
pub fn mark_shared_home(report: &mut Report, hackd: &str, cli: &str, other: &str) {
    if let Some(card) = report.cards.iter_mut().find(|c| c.id == "daemon") {
        card.status = Status::NeedsAttention;
        card.detail = format!(
            "hackd {hackd} here belongs to {other}, which shares this home with the app's CLI ({cli}). The app does not restart it: use {other} in the app, or give each install its own home."
        );
        card.remedy = Remedy::Doc(SHARED_HOME_DOC.into());
    }
}

pub(crate) fn card(id: &str, title: &str, evidence: (Status, String), remedy: Remedy) -> Card {
    Card {
        id: id.into(),
        title: title.into(),
        status: evidence.0,
        detail: evidence.1,
        remedy,
    }
}
/// Docker readiness for the engine Setup itself checks: the machine Doctor
/// run's `docker daemon` check, which runs with the app's checked Docker
/// selectors. A running hackd's `runtime_ok` is not used: it describes the
/// engine selected by the daemon's own environment, which may differ.
fn docker_evidence(runs: &[DoctorRun]) -> (Status, String) {
    match check(runs, None, "docker daemon") {
        (Status::Passed, _) => (Status::Passed, "Docker reachable".into()),
        (Status::NeedsAttention, detail) => (
            Status::NeedsAttention,
            format!("Docker not reachable; Compose projects only. {detail}"),
        ),
        (_, _) => (
            Status::Unknown,
            "Could not confirm Docker for the selected engine".into(),
        ),
    }
}
pub(crate) fn boolean(value: Option<bool>, yes: &str, no: &str) -> (Status, String) {
    match value {
        Some(true) => (Status::Passed, yes.into()),
        Some(false) => (Status::NeedsAttention, no.into()),
        None => (Status::Unknown, "Could not confirm".into()),
    }
}

/// Derive setup from fresh observations; exit codes alone never enter this decision.
/// `daemon` is the bare `daemon status --json`, `socket_version` is `/v1/status`.
pub fn derive(
    cli: Result<&str, &str>,
    projects: Option<&ProjectsPayload>,
    socket_version: Option<&str>,
    daemon: Option<&serde_json::Value>,
    runs: &[DoctorRun],
    platform: Platform,
) -> Report {
    let cli_evidence = match cli {
        Ok(v) if supported_cli(v) => (Status::Passed, format!("Hack {v}")),
        Err(why) => (
            Status::Unknown,
            format!("{why}. Check again to confirm the required Hack CLI (5.x)"),
        ),
        Ok(version) => (
            Status::Unknown,
            format!("Unsupported CLI {version}; this preview requires 5.x"),
        ),
    };
    let mut cards = vec![card(
        "cli",
        "Hack CLI · required",
        cli_evidence,
        Remedy::Doc(
            "https://github.com/hack-dance/hack/blob/next/docs/versions/v5/install.md".into(),
        ),
    )];
    let native: Vec<_> = projects
        .into_iter()
        .flat_map(|p| &p.projects)
        .filter(|p| p.is_native())
        .collect();
    // Empty registry still needs the Compose machine setup. A confirmed native-only
    // registry must never offer global install/trust, which refuse native projects.
    let compose =
        projects.is_none_or(|p| p.projects.is_empty() || p.projects.iter().any(|p| !p.is_native()));
    if compose {
        cards.push(card(
            "docker",
            "Docker · Compose",
            docker_evidence(runs),
            Remedy::Doc("https://docs.docker.com/engine/install/".into()),
        ));
    }
    if projects.is_none()
        && let Some(docker) = cards
            .iter_mut()
            .find(|c| c.id == "docker" && c.status == Status::Unknown)
    {
        docker.detail = "Could not read project or Docker status. Start a matching version of hackd, then check again.".into();
    }
    for p in &native {
        let state = p
            .native
            .as_ref()
            .filter(|_| p.status != "missing" && p.repo_root.is_some())
            .map(|n| n.status.as_str())
            .unwrap_or("unreadable or missing project");
        cards.push(card(
            &format!("native:{}", p.name),
            &format!("Native runtime · {}", p.name),
            (
                if state == "observed" {
                    Status::Passed
                } else {
                    Status::Unknown
                },
                format!("{state}; native setup documentation"),
            ),
            Remedy::Doc(NATIVE_DOC.into()),
        ));
    }
    let running = daemon.and_then(daemon_running);
    // The CLI's own answer for differing versions (`api_compatible`), as the
    // window uses it: compatible versions need nothing.
    let compatible = daemon
        .and_then(|d| d.get("api_compatible"))
        .and_then(serde_json::Value::as_bool);
    let inconsistent = daemon.is_some_and(|d| {
        ["api_ok", "api_reachable"]
            .iter()
            .any(|key| d.get(key).and_then(serde_json::Value::as_bool) == Some(false))
            || d.get("stale").and_then(serde_json::Value::as_bool) == Some(true)
            || d.get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s != "running")
    });
    let restart = || Remedy::Copy("hack daemon restart".into());
    let (status, detail, remedy) = match (running, cli, socket_version) {
        // Differing versions first: the CLI reports an incompatible daemon
        // as `status: "incompatible"`, `api_ok: false`, so the remedy must
        // come from which side is older, never a blind restart.
        (Some(true), Ok(c), Some(v)) if !v.is_empty() && c != v => {
            if compatible == Some(true) && !inconsistent {
                (
                    Status::Passed,
                    format!("hackd {v}, CLI {c}: compatible"),
                    restart(),
                )
            } else {
                match crate::source::UpdateSide::for_versions(v, c) {
                    // Never restart hackd from an older CLI: that downgrades it.
                    crate::source::UpdateSide::Cli => (
                        Status::NeedsAttention,
                        format!("hackd {v} is newer than CLI {c}; update the CLI"),
                        Remedy::Copy("hack update".into()),
                    ),
                    crate::source::UpdateSide::Daemon => (
                        Status::NeedsAttention,
                        format!("hackd {v} is older than CLI {c}; restart it from your terminal"),
                        restart(),
                    ),
                }
            }
        }
        (Some(true), _, _) if inconsistent || compatible == Some(false) => (
            Status::Unknown,
            "Daemon reports starting, stale or incompatible; check again".into(),
            restart(),
        ),
        (Some(true), Ok(_), Some(v)) if !v.is_empty() => {
            (Status::Passed, format!("hackd {v}"), restart())
        }
        (Some(false), _, _) => (
            Status::NeedsAttention,
            "hackd off; status refreshes slowly".into(),
            Remedy::Run(SafeAction::StartDaemon),
        ),
        _ => (
            Status::Unknown,
            "Could not confirm hackd and socket version".into(),
            restart(),
        ),
    };
    cards.push(card("daemon", "hackd", (status, detail), remedy));
    if compose {
        cards.push(card(
            "routing",
            "Routing and DNS · Compose",
            routing(runs, projects, platform),
            Remedy::Admin(vec!["global".into(), "install".into()]),
        ));
    }
    for p in &native {
        cards.push(card(
            &format!("dns:{}", p.name),
            &format!("Routing and DNS · {}", p.name),
            check(runs, Some(&p.name), "native host dns"),
            Remedy::Doc(NATIVE_DOC.into()),
        ));
    }
    if compose {
        let mut trust = check(runs, None, "local ca trust");
        if trust.0 != Status::Passed {
            trust.1 = format!(
                "{}; browser may warn. An exported CA alone does not prove browser trust. Older CLIs may not be able to check trust.",
                trust.1
            );
        }
        cards.push(card(
            "trust",
            "Certificate trust · Compose",
            trust,
            Remedy::Admin(vec!["global".into(), "trust".into()]),
        ));
    }
    for p in &native {
        cards.push(card(
            &format!("trust:{}", p.name),
            &format!("Certificate trust · {}", p.name),
            check(runs, Some(&p.name), "native root trust"),
            Remedy::Doc(NATIVE_DOC.into()),
        ));
    }
    cards.push(crate::setup_login::login_card(daemon, None));
    Report {
        cards,
        cli_program: cli
            .ok()
            .filter(|v| supported_cli(v))
            .map(|_| "/usr/local/bin/hack".into()),
        context: None,
        force_cli_gate: cli.is_ok_and(|v| !supported_cli(v)),
    }
}
fn routing(
    runs: &[DoctorRun],
    projects: Option<&ProjectsPayload>,
    platform: Platform,
) -> (Status, String) {
    // Project host suffixes Doctor reported nothing for: it checks only the
    // default domain's resolver today (DESIGN.md R23), so their routing
    // cannot be confirmed and global install would not change that.
    let mut unobserved: std::collections::BTreeMap<String, String> = Default::default();
    let mut ids: Vec<String> = match platform {
        Platform::Linux => vec!["linux dns route".into()],
        Platform::Other => return (Status::Unknown, "Unsupported platform".into()),
        Platform::Mac => {
            let mut domains = std::collections::BTreeSet::from([
                "hack".to_owned(),
                "hack.local".into(),
                "hack.gy".into(),
            ]);
            // Include custom domains reported by doctor, never accept just one of
            // a resolver/dnsmasq pair. Project host suffixes add missing checks.
            for r in runs.iter().filter(|r| r.project.is_none()) {
                if let Ok(report) = &r.result {
                    for c in &report.checks {
                        if let Some(d) =
                            c.id.strip_prefix("resolver:")
                                .or_else(|| c.id.strip_prefix("dnsmasq.conf:"))
                        {
                            domains.insert(d.into());
                        }
                    }
                }
            }
            for p in projects
                .into_iter()
                .flat_map(|p| &p.projects)
                .filter(|p| !p.is_native())
            {
                if let Some(h) = &p.dev_host
                    && !domains.iter().any(|d| h.ends_with(&format!(".{d}")))
                    && let Some((_, suffix)) = h.split_once('.')
                {
                    domains.insert(suffix.into());
                    unobserved
                        .entry(suffix.to_owned())
                        .or_insert_with(|| h.clone());
                }
            }
            let mut v = vec!["dnsmasq:53".into(), "coredns forwarding".into()];
            for d in domains {
                v.push(format!("resolver:{d}"));
                v.push(format!("dnsmasq.conf:{d}"));
            }
            v
        }
    };
    ids.sort();
    let results: Vec<_> = ids
        .iter()
        .map(|id| {
            let mut result = check(runs, None, id);
            let domain = id
                .strip_prefix("resolver:")
                .or_else(|| id.strip_prefix("dnsmasq.conf:"));
            if result.0 == Status::Unknown
                && let Some(host) = domain.and_then(|d| unobserved.get(d))
            {
                result.1 = format!(
                    "Doctor does not check this project domain yet (DESIGN.md R23), so routing for {host} is unconfirmed"
                );
            }
            (id, result)
        })
        .collect();
    if results.iter().all(|(_, (s, _))| *s == Status::Passed) {
        return (Status::Passed, "All required DNS checks passed".into());
    }
    let status = if results.iter().any(|(_, (s, _))| *s == Status::Unknown) {
        Status::Unknown
    } else {
        Status::NeedsAttention
    };
    (
        status,
        results
            .into_iter()
            .filter(|(_, (s, _))| *s != Status::Passed)
            .map(|(id, (_, d))| format!("{id}: {d}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// Default fixture adapter; no machine reads or actions.
pub fn fixture(
    snapshot: Result<Snapshot, crate::source::SourceError>,
    runs: &[DoctorRun],
) -> Report {
    let daemon = serde_json::json!({"running":false,"service":{"installed":false}});
    derive(
        snapshot
            .as_ref()
            .map(|s| s.cli_version.as_str())
            .map_err(|_| "unreadable"),
        snapshot.as_ref().ok().map(|s| &s.projects),
        snapshot
            .as_ref()
            .ok()
            .and_then(|s| s.daemon.as_ref())
            .map(|d| d.version.as_str()),
        Some(&daemon),
        runs,
        Platform::Linux,
    )
}

/// Explicit preview compatibility range: semver 5.x (including prereleases).
fn supported_cli(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts[0] == "5"
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// How old a shown Setup pane's checks may get before they run again.
pub const RECHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(600);

/// A Setup pane on screen in a visible window checks again once its result
/// is [`RECHECK_EVERY`] old (or it never finished), so a window left open
/// does not keep showing a state that has changed. Never while a check or
/// an action runs.
pub fn should_recheck_periodically(
    setup_shown: bool,
    window_visible: bool,
    pane: &Pane,
    now: std::time::Instant,
) -> bool {
    setup_shown
        && window_visible
        && !pane.loading
        && !pane.action_busy
        && pane
            .checked_at
            .is_none_or(|t| now.saturating_duration_since(t) >= RECHECK_EVERY)
}

/// Focus checks are scoped to visible setup or an outstanding explicit fix.
pub fn should_recheck_on_focus(
    setup_shown: bool,
    pending_fix: bool,
    loading: bool,
    busy: bool,
) -> bool {
    (setup_shown || pending_fix) && !loading && !busy
}

pub use crate::setup_login::{installation_refusal, qualify_login};

/// Whether `hack daemon status --json` says hackd runs. `running` is the
/// CLI's tracked-PID view; a hackd whose API answers (`status: "running"`
/// with `api_ok` or `api_reachable`) runs even without a tracked PID (one
/// started outside the CLI's PID file, for example). `None` when the report
/// says neither.
fn daemon_running(d: &serde_json::Value) -> Option<bool> {
    let flag = |key: &str| d.get(key).and_then(serde_json::Value::as_bool);
    let api_answers = matches!(
        d.get("status").and_then(serde_json::Value::as_str),
        Some("running" | "incompatible")
    ) && (flag("api_ok") == Some(true) || flag("api_reachable") == Some(true));
    match flag("running") {
        Some(true) => Some(true),
        _ if api_answers => Some(true),
        other => other,
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    use crate::models::{DoctorCheck, DoctorReport, ProjectRow, ProjectsPayload};

    #[test]
    fn a_project_suffix_doctor_does_not_check_is_unknown_and_says_why() {
        let ok = |id: &str| DoctorCheck {
            native_pool: None,
            id: id.into(),
            status: "ok".into(),
            detail: String::new(),
            fix: None,
        };
        let mut checks = vec![ok("dnsmasq:53"), ok("coredns forwarding")];
        for d in ["hack", "hack.local", "hack.gy"] {
            checks.push(ok(&format!("resolver:{d}")));
            checks.push(ok(&format!("dnsmasq.conf:{d}")));
        }
        let runs = [DoctorRun::machine(Ok(DoctorReport {
            checks,
            summary: vec![],
        }))];
        let projects = ProjectsPayload {
            projects: vec![ProjectRow {
                name: "shop".into(),
                dev_host: Some("shop.example.test".into()),
                ..ProjectRow::default()
            }],
            ..ProjectsPayload::default()
        };
        let (status, detail) = routing(&runs, Some(&projects), Platform::Mac);
        assert_eq!(status, Status::Unknown, "never green without evidence");
        assert!(detail.contains("R23"), "{detail}");
        assert!(detail.contains("shop.example.test"), "{detail}");
        // Without that project every check Doctor ran passes.
        assert_eq!(routing(&runs, None, Platform::Mac).0, Status::Passed);
    }
}

#[cfg(test)]
mod pane_tests {
    use super::*;

    #[test]
    fn a_shown_setup_pane_checks_again_after_ten_minutes() {
        let now = std::time::Instant::now();
        let mut pane = Pane::default();
        assert!(
            should_recheck_periodically(true, true, &pane, now),
            "never finished"
        );
        let generation = pane.begin();
        assert!(
            !should_recheck_periodically(true, true, &pane, now),
            "a check runs"
        );
        pane.finish(generation, Report::default());
        let at = pane.checked_at.expect("finished");
        let later = at + RECHECK_EVERY;
        assert!(!should_recheck_periodically(
            true,
            true,
            &pane,
            at + RECHECK_EVERY - std::time::Duration::from_secs(1)
        ));
        assert!(should_recheck_periodically(true, true, &pane, later));
        assert!(
            !should_recheck_periodically(false, true, &pane, later),
            "another pane"
        );
        assert!(
            !should_recheck_periodically(true, false, &pane, later),
            "hidden window"
        );
        pane.action_busy = true;
        assert!(
            !should_recheck_periodically(true, true, &pane, later),
            "an action runs"
        );
    }

    #[test]
    fn a_cli_switch_drops_the_report_and_anything_in_flight() {
        let mut pane = Pane::default();
        let generation = pane.begin();
        pane.action_busy = true;
        pane.pending_fix = true;
        let epoch = pane.source_epoch();
        pane.source_changed();
        assert!(!pane.loading && !pane.action_busy && !pane.pending_fix);
        assert_ne!(
            pane.source_epoch(),
            epoch,
            "an action started before is dropped"
        );
        // A check started under the previous CLI does not land.
        let old = Report {
            cards: vec![card(
                "cli",
                "Hack CLI",
                (Status::Passed, String::new()),
                Remedy::Doc(String::new()),
            )],
            ..Report::default()
        };
        pane.finish(generation, old);
        assert!(pane.report.cards.is_empty());
        // A new check does.
        let next = pane.begin();
        assert_ne!(next, generation);
    }
}

#[cfg(test)]
mod shared_home_tests {
    use super::*;

    #[test]
    fn a_shared_hackd_is_named_and_never_offered_a_restart() {
        let mut report = Report {
            cards: vec![card(
                "daemon",
                "hackd",
                (
                    Status::NeedsAttention,
                    "hackd 4.2.1 is older than CLI 5.0.0".into(),
                ),
                Remedy::Copy("hack daemon restart".into()),
            )],
            ..Report::default()
        };
        mark_shared_home(&mut report, "4.2.1", "5.0.0", "hack 4.2.1 (stable)");
        let card = &report.cards[0];
        assert!(card.detail.contains("hack 4.2.1 (stable)") && card.detail.contains("5.0.0"));
        assert!(!matches!(
            card.remedy,
            Remedy::Copy(_) | Remedy::Run(_) | Remedy::Admin(_)
        ));
    }
}
