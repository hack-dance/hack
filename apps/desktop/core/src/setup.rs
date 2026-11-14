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
        let context = self
            .context
            .as_ref()
            .ok_or("Execution context has not been checked")?;
        let compose = if args.first().is_some_and(|s| s == "global")
            && args.get(1).is_some_and(|s| s == "install" || s == "trust")
        {
            Some(context.with_backend("compose")?)
        } else {
            None
        };
        compose
            .as_ref()
            .unwrap_or(context)
            .bind(&crate::terminal::CommandSpec {
                program: self
                    .cli_program
                    .clone()
                    .ok_or("CLI executable has not been checked")?,
                args,
            })
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
    pub checked_at: Option<std::time::Instant>,
}
impl Pane {
    pub fn begin(&mut self) -> u64 {
        self.generation += 1;
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
            self.checked_at = Some(std::time::Instant::now());
        }
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
pub(crate) fn card(id: &str, title: &str, evidence: (Status, String), remedy: Remedy) -> Card {
    Card {
        id: id.into(),
        title: title.into(),
        status: evidence.0,
        detail: evidence.1,
        remedy,
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
            boolean(
                projects.and_then(|p| p.runtime_ok),
                "Docker reachable",
                "Docker not reachable; Compose projects only",
            ),
            Remedy::Doc("https://docs.docker.com/engine/install/".into()),
        ));
    }
    if projects.is_none()
        && let Some(docker) = cards.iter_mut().find(|c| c.id == "docker")
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
    let running = daemon
        .and_then(|d| d.get("running"))
        .and_then(serde_json::Value::as_bool);
    let inconsistent = daemon.is_some_and(|d| {
        ["api_ok", "api_reachable", "api_compatible"]
            .iter()
            .any(|key| d.get(key).and_then(serde_json::Value::as_bool) == Some(false))
            || d.get("stale").and_then(serde_json::Value::as_bool) == Some(true)
            || d.get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s != "running")
    });
    let daemon_evidence = match (running, cli, socket_version) {
        (Some(true), _, _) if inconsistent => (
            Status::Unknown,
            "Daemon reports starting, stale or incompatible; check again".into(),
        ),
        (Some(true), Ok(c), Some(v)) if !v.is_empty() && c == v => {
            (Status::Passed, format!("hackd {v}"))
        }
        (Some(true), Ok(c), Some(v)) => (
            Status::NeedsAttention,
            format!("hackd {v}, CLI {c}; restart from your terminal"),
        ),
        (Some(false), _, _) => (
            Status::NeedsAttention,
            "hackd off; status refreshes slowly".into(),
        ),
        _ => (
            Status::Unknown,
            "Could not confirm hackd and socket version".into(),
        ),
    };
    cards.push(card(
        "daemon",
        "hackd",
        daemon_evidence,
        if running == Some(false) {
            Remedy::Run(SafeAction::StartDaemon)
        } else {
            Remedy::Copy("hack daemon restart".into())
        },
    ));
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
    let results: Vec<_> = ids.iter().map(|id| (id, check(runs, None, id))).collect();
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
