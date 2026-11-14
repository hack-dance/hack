//! Doctor view model (DESIGN.md section 3).
//!
//! Turns several `hack doctor --json` runs (one outside any project, one per
//! registered project) into cards grouped by area:
//! - Machine-wide findings are shown once, whichever runs reported them.
//! - Project findings carry the projects they affect (name and checkout).
//! - Only an explicit `ok` counts as passed; a missing or unfamiliar status
//!   is a "Could not check" card, never a pass.
//! - Each card has exactly one action: copy one exact command (with
//!   `--path '<root>'` for project repairs) or open a doc. A one-click "Run"
//!   waits for the CLI to report fix kinds (design request R7a).
//! - A run that failed or was not started keeps the view from ever looking
//!   clean.
//!
//! Pure: no I/O. Reading the reports lives in [`crate::source`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::models::{DoctorCheck, DoctorReport};
use crate::state::Tone;

/// Where a check belongs in the Doctor view, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Area {
    Engine,
    RoutingDns,
    Certificates,
    Daemon,
    EnvSecrets,
    ProjectFiles,
    Native,
    Other,
}

impl Area {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Engine => "Engine",
            Self::RoutingDns => "Routing and DNS",
            Self::Certificates => "Certificates",
            Self::Daemon => "Daemon",
            Self::EnvSecrets => "Env and secrets",
            Self::ProjectFiles => "Project files",
            Self::Native => "Native",
            Self::Other => "Other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Machine,
    Project,
}

/// Area and scope for a check `id` as `src/commands/doctor.ts` names it.
/// `None` for ids this table does not know (shown under "Other").
#[must_use]
pub fn classify(id: &str) -> Option<(Area, Scope)> {
    use Area::*;
    use Scope::*;
    let exact = match id {
        "docker" | "docker compose" | "docker daemon" | "bun" | "mutagen" => (Engine, Machine),
        "compose backend features" => (Engine, Project),
        "proxy ports"
        | "proxy network"
        | "dnsmasq:53"
        | "coredns forwarding"
        | "linux dns route"
        | "global files"
        | "grafana"
        | "browser local network" => (RoutingDns, Machine),
        // Each project's internal host mapping (doctor.ts checkCaddyHostMapping).
        "caddy hosts" | "DEV_HOST" => (RoutingDns, Project),
        "caddy local ca" | "host tls trust" | "superseded caddy roots" => (Certificates, Machine),
        "daemon" | "daemon service" | "gateway config" | "gateway tokens" => (Daemon, Machine),
        "env key"
        | "env mode"
        | "env materialization"
        | "env overlay warnings"
        | "worktree keys"
        | "secret store"
        | "secret integrity"
        | "secrets hygiene"
        | "compose env at rest" => (EnvSecrets, Project),
        "project" | "runtime hygiene" | "lifecycle hygiene" | "compose networks"
        | "generated files" | "hack gitignore" | "worktree instances" | "sessions mux" => {
            (ProjectFiles, Project)
        }
        "native host dns"
        | "native hack.local route"
        | "native hack.local repair"
        | "native root trust"
        | "native ca repair"
        | "native https owner"
        | "native https route" => (Native, Machine),
        "native settings" | "native source size" | "amd64 emulation" => (Native, Project),
        _ => return prefixed(id),
    };
    Some(exact)
}

fn prefixed(id: &str) -> Option<(Area, Scope)> {
    if id.starts_with("resolver:")
        || id.starts_with("dnsmasq.conf:")
        || id.starts_with("dns:")
        || id.starts_with("network:")
    {
        return Some((Area::RoutingDns, Scope::Machine));
    }
    if id.starts_with("native ") {
        return Some((Area::Native, Scope::Project));
    }
    if id.ends_with("(optional)") || id.ends_with("(sessions)") {
        return Some((Area::Engine, Scope::Machine));
    }
    None
}

/// Checks the CLI runs both outside a project (auditing the global Hack
/// home) and inside one: their scope follows the run that reported them.
const RUN_SCOPED_IDS: &[&str] = &["secrets hygiene"];

/// The single action a card offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardAction {
    /// Copy this exact command; the user runs it (in a terminal for admin steps).
    Copy(String),
    /// Open this documentation page.
    OpenDoc(String),
}

const DOCS: &str = "https://github.com/hack-dance/hack/blob/next/docs/";

fn doc_for(id: &str, area: Area) -> String {
    let page = match (id, area) {
        ("browser local network", _) => "guides/macos-browser-network.md",
        (_, Area::Engine) => "guides/getting-started.md",
        (_, Area::RoutingDns) if cfg!(target_os = "linux") => "guides/linux-setup.md",
        (_, Area::RoutingDns) => "guides/getting-started.md",
        (_, Area::Certificates) if cfg!(target_os = "linux") => "guides/linux-certificate-trust.md",
        (_, Area::Certificates) => "guides/macos-certificate-trust.md",
        (_, Area::Daemon) => "architecture.md#daemon-hackd",
        (_, Area::EnvSecrets) => "env.md",
        (_, Area::ProjectFiles) => "guides/init-project.md",
        (_, Area::Native) => "native",
        (_, Area::Other) => "cli.md",
    };
    format!("{DOCS}{page}")
}

/// Quote one argument for a POSIX shell.
#[must_use]
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Daemon repairs depend on the state the check reports (doctor-daemon.ts).
fn daemon_command(id: &str, detail: &str) -> Option<String> {
    let d = detail.to_ascii_lowercase();
    let cmd = match id {
        "daemon" if d.contains("incompatible") => "hack daemon restart",
        "daemon" if d.contains("stale pid/socket") || d.contains("not running") => {
            "hack daemon start"
        }
        "daemon service" if d.contains("stale") || d.contains("not installed") => {
            "hack daemon install"
        }
        _ => return None,
    };
    Some(cmd.into())
}

/// Project repairs that `hack doctor --fix` applies for one checkout.
const PROJECT_FIX_IDS: &[&str] = &[
    "generated files",
    "hack gitignore",
    "runtime hygiene",
    "lifecycle hygiene",
    "secrets hygiene",
];

/// `caddy hosts` is the project's own host mapping, regenerated by a
/// restart, not by `doctor --fix` (doctor.ts checkCaddyHostMapping).
const PROJECT_RESTART_IDS: &[&str] = &["caddy hosts"];

/// Commands that act on one project and so need `--path '<root>'`.
const PROJECT_COMMANDS: &[&str] = &["hack restart", "hack down", "hack up", "hack doctor"];

/// The command a check names in its own detail ("… (run: hack restart)").
fn remedy_in_detail(detail: &str) -> Option<String> {
    let start = detail.find("run: ")? + "run: ".len();
    let rest = &detail[start..];
    let end = rest.find([')', ';', '\n']).unwrap_or(rest.len());
    let cmd = rest[..end].trim().trim_end_matches('.').trim_matches('`');
    cmd.starts_with("hack ").then(|| cmd.to_owned())
}

fn with_path(cmd: &str, root: &Path) -> String {
    format!("{cmd} --path {}", shell_quote(&root.to_string_lossy()))
}

/// The one exact command for a card, or `None` when only a doc applies.
fn command_for(id: &str, area: Area, detail: &str, affected: &Affected) -> Option<String> {
    if matches!(id, "daemon" | "daemon service") {
        return daemon_command(id, detail);
    }
    match affected {
        Affected::Machine if !id.starts_with("native ") && remedy_in_detail(detail).is_some() => {
            remedy_in_detail(detail)
        }
        Affected::Machine => match id {
            "caddy local ca" | "host tls trust" => Some("hack global trust".into()),
            "browser local network" => None,
            _ if area == Area::RoutingDns => Some("hack global install".into()),
            _ => None,
        },
        // One exact command needs exactly one non-native checkout. The
        // check's own remedy wins; project commands get that checkout's path.
        Affected::Projects(ps) => match ps.as_slice() {
            [p] if !p.native => {
                let root = p.root.as_ref()?;
                if let Some(cmd) = remedy_in_detail(detail) {
                    return Some(if PROJECT_COMMANDS.iter().any(|c| cmd.starts_with(c)) {
                        with_path(&cmd, root)
                    } else {
                        cmd
                    });
                }
                if PROJECT_RESTART_IDS.contains(&id) {
                    Some(with_path("hack restart", root))
                } else if PROJECT_FIX_IDS.contains(&id) {
                    Some(with_path("hack doctor --fix", root))
                } else {
                    None
                }
            }
            _ => None,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warn,
    /// The check reported no status, or one this app does not know.
    CouldNotCheck,
}

/// A project a finding belongs to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProjectRef {
    pub name: String,
    pub root: Option<PathBuf>,
    pub native: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Affected {
    Machine,
    Projects(Vec<ProjectRef>),
}

impl Affected {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Machine => "Affected: machine".into(),
            Self::Projects(p) => format!(
                "Affected: {}",
                p.iter()
                    .map(|p| p.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }

    #[must_use]
    pub fn includes(&self, project: &str) -> bool {
        matches!(self, Self::Projects(ps) if ps.iter().any(|p| p.name == project))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub id: String,
    pub area: Area,
    pub severity: Severity,
    pub detail: String,
    pub affected: Affected,
    pub action: CardAction,
    /// A safe one-click fix needs the CLI to report a fix kind (R7a).
    pub needs: &'static str,
}

/// One `hack doctor --json` run: outside any project (`project: None`) or
/// for one registered project.
#[derive(Debug, Clone, PartialEq)]
pub struct DoctorRun {
    pub project: Option<String>,
    pub root: Option<PathBuf>,
    pub native: bool,
    pub result: Result<DoctorReport, String>,
}

impl DoctorRun {
    #[must_use]
    pub fn machine(result: Result<DoctorReport, String>) -> Self {
        Self {
            project: None,
            root: None,
            native: false,
            result,
        }
    }

    #[must_use]
    pub fn project(name: &str, root: &str, result: Result<DoctorReport, String>) -> Self {
        Self {
            project: Some(name.into()),
            root: Some(root.into()),
            native: false,
            result,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorView {
    /// Areas in display order, each with its cards (errors first).
    pub groups: Vec<(Area, Vec<Card>)>,
    /// Distinct checks that reported an explicit `ok` and no failure elsewhere.
    pub passed: usize,
    /// Runs that produced no report: (project or "machine", reason).
    pub failed_runs: Vec<(String, String)>,
    pub projects_total: usize,
    pub projects_checked: usize,
    pub machine_checked: bool,
}

impl DoctorView {
    /// Cards needing attention; the sidebar badge.
    #[must_use]
    pub fn attention_count(&self) -> usize {
        self.groups.iter().map(|(_, c)| c.len()).sum()
    }

    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.cards().any(|c| c.severity == Severity::Error)
    }

    pub fn cards(&self) -> impl Iterator<Item = &Card> {
        self.groups.iter().flat_map(|(_, c)| c)
    }

    /// Clean only when every run succeeded and nothing was found.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.failed_runs.is_empty() && self.groups.is_empty()
    }

    /// Error red; anything found or unchecked amber; green only when clean.
    #[must_use]
    pub fn tone(&self) -> Tone {
        if self.has_errors() {
            Tone::Error
        } else if self.is_clean() {
            Tone::Ok
        } else {
            Tone::Warn
        }
    }

    /// "Checked 3 of 5 projects; 2 could not be checked", when not complete.
    #[must_use]
    pub fn coverage_line(&self) -> Option<String> {
        if self.failed_runs.is_empty() {
            return None;
        }
        let missing = self.projects_total - self.projects_checked;
        let mut parts = Vec::new();
        if self.projects_total > 0 {
            parts.push(format!(
                "Checked {} of {} projects",
                self.projects_checked, self.projects_total
            ));
            if missing > 0 {
                parts.push(format!("{missing} could not be checked"));
            }
        }
        if !self.machine_checked {
            parts.push("machine checks did not run".into());
        }
        Some(parts.join("; "))
    }

    /// Findings that name `project`.
    #[must_use]
    pub fn findings_for(&self, project: &str) -> usize {
        self.cards()
            .filter(|c| c.affected.includes(project))
            .count()
    }
}

fn severity(status: &str) -> Result<Option<Severity>, ()> {
    match status {
        "ok" => Ok(None),
        "error" => Ok(Some(Severity::Error)),
        "warn" => Ok(Some(Severity::Warn)),
        _ => Err(()),
    }
}

type ProjectKey = (String, Severity, String);

/// Aggregate runs into the Doctor view.
#[must_use]
pub fn aggregate(runs: &[DoctorRun]) -> DoctorView {
    let mut machine: BTreeMap<String, (Area, Severity, String)> = BTreeMap::new();
    let mut project: BTreeMap<ProjectKey, (Area, Vec<ProjectRef>)> = BTreeMap::new();
    let mut ok: BTreeMap<(String, Option<String>), ()> = BTreeMap::new();
    let mut failing: BTreeMap<(String, Option<String>), ()> = BTreeMap::new();
    let mut failed_runs = Vec::new();
    let projects_total = runs.iter().filter(|r| r.project.is_some()).count();
    let mut projects_checked = 0;
    let mut machine_checked = false;

    for run in runs {
        let report = match &run.result {
            Ok(r) => r,
            Err(why) => {
                failed_runs.push((
                    run.project.clone().unwrap_or_else(|| "machine".into()),
                    why.clone(),
                ));
                continue;
            }
        };
        if run.project.is_some() {
            projects_checked += 1;
        } else {
            machine_checked = true;
        }
        for DoctorCheck { id, status, detail } in &report.checks {
            let (area, scope) = classify(id).unwrap_or((
                Area::Other,
                if run.project.is_some() {
                    Scope::Project
                } else {
                    Scope::Machine
                },
            ));
            let scope = if RUN_SCOPED_IDS.contains(&id.as_str()) {
                if run.project.is_some() {
                    Scope::Project
                } else {
                    Scope::Machine
                }
            } else {
                scope
            };
            // A project check outside any project has no project to name.
            let owner = match (scope, &run.project) {
                (Scope::Machine, _) => None,
                (Scope::Project, Some(p)) => Some(ProjectRef {
                    name: p.clone(),
                    root: run.root.clone(),
                    native: run.native,
                }),
                (Scope::Project, None) => continue,
            };
            let key = (id.clone(), owner.as_ref().map(|o| o.name.clone()));
            let (sev, detail) = match severity(status) {
                Ok(None) => {
                    ok.insert(key, ());
                    continue;
                }
                Ok(Some(s)) => (s, detail.clone()),
                Err(()) => (
                    Severity::CouldNotCheck,
                    if status.is_empty() {
                        "The check reported no status".into()
                    } else {
                        format!("The check reported an unknown status {status:?}")
                    },
                ),
            };
            failing.insert(key, ());
            match owner {
                None => {
                    let entry = machine
                        .entry(id.clone())
                        .or_insert((area, sev, detail.clone()));
                    if sev < entry.1 {
                        *entry = (area, sev, detail);
                    }
                }
                Some(p) => {
                    let entry = project
                        .entry((id.clone(), sev, detail))
                        .or_insert((area, Vec::new()));
                    if !entry.1.iter().any(|q| q.name == p.name) {
                        entry.1.push(p);
                    }
                }
            }
        }
    }

    let card = |id: &str, area: Area, severity: Severity, detail: String, affected: Affected| {
        let action = match (severity, command_for(id, area, &detail, &affected)) {
            (Severity::CouldNotCheck, _) | (_, None) => CardAction::OpenDoc(doc_for(id, area)),
            (_, Some(c)) => CardAction::Copy(c),
        };
        Card {
            id: id.into(),
            area,
            severity,
            detail,
            affected,
            action,
            needs: "R7a",
        }
    };
    let mut cards: Vec<Card> = machine
        .into_iter()
        .map(|(id, (area, sev, detail))| card(&id, area, sev, detail, Affected::Machine))
        .collect();
    cards.extend(
        project
            .into_iter()
            .map(|((id, sev, detail), (area, mut ps))| {
                ps.sort();
                card(&id, area, sev, detail, Affected::Projects(ps))
            }),
    );
    cards.sort_by(|a, b| {
        (a.area, a.severity, &a.id, a.affected.label()).cmp(&(
            b.area,
            b.severity,
            &b.id,
            b.affected.label(),
        ))
    });

    let mut groups: Vec<(Area, Vec<Card>)> = Vec::new();
    for c in cards {
        match groups.last_mut() {
            Some((area, list)) if *area == c.area => list.push(c),
            _ => groups.push((c.area, vec![c])),
        }
    }
    let passed = ok.keys().filter(|k| !failing.contains_key(*k)).count();
    DoctorView {
        groups,
        passed,
        failed_runs,
        projects_total,
        projects_checked,
        machine_checked,
    }
}

/// Result of the last doctor refresh.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DoctorState {
    /// Doctor has not finished a run in this session.
    #[default]
    NeverRun,
    Loaded(DoctorView),
    /// No run produced a report.
    Error(String),
}

impl DoctorState {
    #[must_use]
    pub fn from_runs(runs: &[DoctorRun]) -> Self {
        if !runs.is_empty() && runs.iter().all(|r| r.result.is_err()) {
            let why = runs
                .iter()
                .find_map(|r| r.result.as_ref().err())
                .cloned()
                .unwrap_or_default();
            return Self::Error(why);
        }
        Self::Loaded(aggregate(runs))
    }
}

/// What identifies a doctor target: name, checkout and backend.
pub type TargetKey = (String, PathBuf, bool);

/// Should the app start a doctor run on its own now? Only while the Doctor
/// pane is shown in a visible window, and only when the result is missing,
/// old or stale. ("Check again" always runs.)
#[must_use]
pub fn should_auto_refresh(
    pane_shown: bool,
    window_visible: bool,
    pane: &DoctorPane,
    now: Instant,
) -> bool {
    pane_shown && window_visible && pane.needs_refresh(now)
}

/// How often a visible Doctor pane refreshes, and when reopening re-runs.
pub const REFRESH_EVERY: Duration = Duration::from_secs(600);

/// What happened to a finished run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    /// A newer run started meanwhile: this result was dropped.
    Discarded,
    Applied,
    /// Applied, but the project set changed while it ran: shown as stale;
    /// the caller starts a new run.
    AppliedStale,
}

/// Doctor pane state: the last result plus refresh bookkeeping.
#[derive(Debug, Clone, Default)]
pub struct DoctorPane {
    pub result: DoctorState,
    generation: u64,
    in_flight: Option<(u64, Vec<TargetKey>)>,
    checked_at: Option<Instant>,
    /// The project set changed while the shown result was being made.
    pub stale: bool,
    /// Show only findings for this project (from a project header link).
    pub filter: Option<String>,
}

impl DoctorPane {
    /// Start a run for these targets; returns its generation.
    pub fn begin(&mut self, targets: &[TargetKey]) -> u64 {
        self.generation += 1;
        let mut t = targets.to_vec();
        t.sort();
        self.in_flight = Some((self.generation, t));
        self.generation
    }

    #[must_use]
    pub fn is_loading(&self) -> bool {
        self.in_flight.is_some()
    }

    /// A run finished. `current` is the registered target set now; a
    /// change of name, checkout or backend makes the result stale.
    pub fn finish(
        &mut self,
        generation: u64,
        runs: &[DoctorRun],
        current: &[TargetKey],
        now: Instant,
    ) -> Finish {
        let Some((g, targets)) = self.in_flight.take() else {
            return Finish::Discarded;
        };
        if g != generation {
            self.in_flight = Some((g, targets));
            return Finish::Discarded;
        }
        let mut now_set = current.to_vec();
        now_set.sort();
        self.result = DoctorState::from_runs(runs);
        self.checked_at = Some(now);
        self.stale = now_set != targets;
        if self.stale {
            Finish::AppliedStale
        } else {
            Finish::Applied
        }
    }

    /// Never run, stale, or the last result is at least [`REFRESH_EVERY`] old.
    #[must_use]
    pub fn needs_refresh(&self, now: Instant) -> bool {
        !self.is_loading()
            && (self.stale
                || self
                    .checked_at
                    .is_none_or(|t| now.saturating_duration_since(t) >= REFRESH_EVERY))
    }

    #[must_use]
    pub fn age_label(&self, now: Instant) -> Option<String> {
        let mins = now.saturating_duration_since(self.checked_at?).as_secs() / 60;
        Some(match mins {
            0 => "Checked just now".into(),
            1 => "Checked 1 min ago".into(),
            n => format!("Checked {n} min ago"),
        })
    }

    /// Sidebar tone: grey until a run finished or when none produced a
    /// report; never green unless every run was clean.
    #[must_use]
    pub fn tone(&self) -> Tone {
        match &self.result {
            DoctorState::Loaded(v) => v.tone(),
            DoctorState::NeverRun | DoctorState::Error(_) => Tone::Idle,
        }
    }

    #[must_use]
    pub fn findings_for(&self, project: &str) -> usize {
        match &self.result {
            DoctorState::Loaded(v) => v.findings_for(project),
            _ => 0,
        }
    }
}

/// Directories the CLI treats as a project's Hack directory
/// (`HACK_PROJECT_DIR_PRIMARY`, `HACK_PROJECT_DIR_LEGACY`).
const PROJECT_DIRS: &[&str] = &[".hack", ".dev"];
/// Files inside those directories that make a project
/// (`PROJECT_COMPOSE_FILENAME`, `PROJECT_CONFIG_FILENAME`,
/// `PROJECT_CONFIG_LEGACY_FILENAME`).
const PROJECT_FILES: &[&str] = &["docker-compose.yml", "hack.config.json", "hack.toml"];
/// The native project file at a checkout root (`NATIVE_PROJECT_FILENAME`).
const NATIVE_PROJECT_FILE: &str = "hack.project.json";

/// Does `path` exist? `NotFound` is no; any other error is an error.
fn exists(path: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Does this one directory hold a project marker?
fn has_marker(dir: &Path) -> std::io::Result<bool> {
    if exists(&dir.join(NATIVE_PROJECT_FILE))? {
        return Ok(true);
    }
    for d in PROJECT_DIRS {
        let pd = dir.join(d);
        // The primary `.hack/` is a marker on its own (conservative); the
        // legacy `.dev/` only with a project file in it, as the CLI reads it.
        if *d == ".hack" && exists(&pd)? {
            return Ok(true);
        }
        for f in PROJECT_FILES {
            if exists(&pd.join(f))? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Is `dir`, after resolving symlinks, inside a Hack project? Errors
/// (unresolvable path, unreadable ancestor) are returned, never guessed.
///
/// # Errors
/// Any I/O error other than a missing marker.
pub fn inside_project(dir: &Path) -> std::io::Result<bool> {
    let real = dir.canonicalize()?;
    for a in real.ancestors() {
        if has_marker(a)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The first candidate directory provably outside every Hack project, for
/// the machine-level doctor run. A candidate that cannot be inspected is
/// skipped; `None` when no candidate qualifies.
#[must_use]
pub fn neutral_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|d| {
        let real = d.canonicalize().ok()?;
        (real.is_dir() && matches!(inside_project(&real), Ok(false))).then_some(real)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(id: &str, status: &str, detail: &str) -> DoctorCheck {
        DoctorCheck {
            id: id.into(),
            status: status.into(),
            detail: detail.into(),
        }
    }

    fn report(checks: Vec<DoctorCheck>) -> Result<DoctorReport, String> {
        Ok(DoctorReport {
            checks,
            summary: vec![],
        })
    }

    fn key(name: &str, root: &str, native: bool) -> TargetKey {
        (name.into(), root.into(), native)
    }

    fn machine(checks: Vec<DoctorCheck>) -> DoctorRun {
        DoctorRun::machine(report(checks))
    }

    fn proj(name: &str, checks: Vec<DoctorCheck>) -> DoctorRun {
        DoctorRun::project(name, &format!("/work/{name}"), report(checks))
    }

    #[test]
    fn machine_findings_appear_once_with_worst_severity() {
        let v = aggregate(&[
            machine(vec![check("caddy local ca", "warn", "not trusted")]),
            proj(
                "alpha",
                vec![check("caddy local ca", "warn", "not trusted")],
            ),
            proj("beta", vec![check("caddy local ca", "error", "missing")]),
        ]);
        assert_eq!(v.attention_count(), 1);
        let c = v.cards().next().unwrap();
        assert_eq!(c.affected, Affected::Machine);
        assert_eq!(c.severity, Severity::Error);
        assert_eq!(c.action, CardAction::Copy("hack global trust".into()));
    }

    #[test]
    fn browser_findings_do_not_duplicate_across_scopes() {
        let v = aggregate(&[
            machine(vec![check("browser local network", "warn", "blocked")]),
            proj(
                "alpha",
                vec![check("browser local network", "warn", "blocked")],
            ),
        ]);
        assert_eq!(v.attention_count(), 1);
        let c = v.cards().next().unwrap();
        assert_eq!(c.affected, Affected::Machine);
        assert!(
            matches!(&c.action, CardAction::OpenDoc(u) if u.ends_with("macos-browser-network.md"))
        );
    }

    #[test]
    fn project_repairs_copy_one_exact_quoted_command() {
        let one = aggregate(&[DoctorRun::project(
            "alpha",
            "/work/it's here",
            report(vec![check("caddy hosts", "warn", "mapping missing")]),
        )]);
        let c = one.cards().next().unwrap();
        assert_eq!(c.area, Area::RoutingDns);
        assert_eq!(
            c.action,
            CardAction::Copy(r"hack restart --path '/work/it'\''s here'".into())
        );
        // The same finding in two checkouts has no single command: doc.
        let two = aggregate(&[
            proj("alpha", vec![check("generated files", "warn", "tracked")]),
            proj("beta", vec![check("generated files", "warn", "tracked")]),
        ]);
        let c = two.cards().next().unwrap();
        assert_eq!(c.affected.label(), "Affected: alpha, beta");
        assert!(matches!(c.action, CardAction::OpenDoc(_)));
    }

    #[test]
    fn a_checks_own_remedy_wins_over_doctor_fix() {
        let card = |id: &str, detail: &str| {
            aggregate(&[proj("alpha", vec![check(id, "warn", detail)])])
                .cards()
                .next()
                .unwrap()
                .action
                .clone()
        };
        // caddy hosts: the internal mapping is regenerated by a restart.
        assert_eq!(
            card(
                "caddy hosts",
                "Caddy has no route for this project (run: hack restart)"
            ),
            CardAction::Copy("hack restart --path '/work/alpha'".into())
        );
        // ...unless the global proxy is down, which is a machine command.
        assert_eq!(
            card("caddy hosts", "Caddy is not running (run: hack global up)"),
            CardAction::Copy("hack global up".into())
        );
        // lifecycle hygiene naming `hack down` gets the checkout path.
        assert_eq!(
            card(
                "lifecycle hygiene",
                "Orphaned processes remain (run: hack down)"
            ),
            CardAction::Copy("hack down --path '/work/alpha'".into())
        );
        // No remedy in the detail: the documented default.
        assert_eq!(
            card("generated files", "A generated file is tracked by git"),
            CardAction::Copy("hack doctor --fix --path '/work/alpha'".into())
        );
        // Machine checks copy their named remedy as is.
        let m = aggregate(&[machine(vec![check(
            "gateway tokens",
            "warn",
            "Token store untrusted (run: hack x gateway token-create)",
        )])]);
        assert_eq!(
            m.cards().next().unwrap().action,
            CardAction::Copy("hack x gateway token-create".into())
        );
    }

    #[test]
    fn daemon_commands_follow_the_reported_state() {
        let cmd = |detail: &str| {
            aggregate(&[machine(vec![check("daemon", "warn", detail)])])
                .cards()
                .next()
                .unwrap()
                .action
                .clone()
        };
        assert_eq!(
            cmd("hackd is running but incompatible (run: hack daemon restart)"),
            CardAction::Copy("hack daemon restart".into())
        );
        assert_eq!(
            cmd("hackd not running (stale pid/socket; run: hack daemon start)"),
            CardAction::Copy("hack daemon start".into())
        );
        assert_eq!(
            cmd("hackd not running (run: hack daemon start)"),
            CardAction::Copy("hack daemon start".into())
        );
        assert!(matches!(
            cmd("hackd starting (pid 1): API not responding"),
            CardAction::OpenDoc(_)
        ));
        let unit = aggregate(&[machine(vec![check(
            "daemon service",
            "warn",
            "hackd systemd user service: stale unit",
        )])]);
        assert_eq!(
            unit.cards().next().unwrap().action,
            CardAction::Copy("hack daemon install".into())
        );
    }

    #[test]
    fn unknown_or_missing_status_is_could_not_check_not_passed() {
        let v = aggregate(&[machine(vec![
            check("docker", "", ""),
            check("bun", "skipped", ""),
            check("mutagen", "ok", ""),
        ])]);
        assert_eq!(v.passed, 1);
        let sev: Vec<Severity> = v.cards().map(|c| c.severity).collect();
        assert_eq!(sev, vec![Severity::CouldNotCheck, Severity::CouldNotCheck]);
        assert!(
            v.cards()
                .all(|c| matches!(c.action, CardAction::OpenDoc(_)))
        );
        assert_eq!(v.tone(), Tone::Warn);
    }

    #[test]
    fn partial_failure_is_never_clean() {
        let v = aggregate(&[
            machine(vec![check("docker", "ok", "")]),
            proj("alpha", vec![check("project", "ok", "")]),
            DoctorRun::project("beta", "/work/beta", Err("timed out".into())),
            DoctorRun::project(
                "gamma",
                "/work/gamma",
                Err("not checked (time budget)".into()),
            ),
        ]);
        assert_eq!(v.attention_count(), 0);
        assert!(!v.is_clean());
        assert_eq!(v.tone(), Tone::Warn);
        assert_eq!(
            v.coverage_line().as_deref(),
            Some("Checked 1 of 3 projects; 2 could not be checked")
        );
        let clean = aggregate(&[machine(vec![check("docker", "ok", "")])]);
        assert!(clean.is_clean());
        assert_eq!(clean.tone(), Tone::Ok);
        assert_eq!(clean.coverage_line(), None);
    }

    #[test]
    fn grouping_order_and_unknown_ids() {
        let v = aggregate(&[machine(vec![
            check("brand new check", "warn", "?"),
            check(
                "daemon",
                "warn",
                "hackd not running (run: hack daemon start)",
            ),
            check("docker daemon", "error", "down"),
            check("resolver:hack", "error", "missing"),
            check("bun", "ok", ""),
            check("docker", "ok", ""),
        ])]);
        let areas: Vec<Area> = v.groups.iter().map(|(a, _)| *a).collect();
        assert_eq!(
            areas,
            vec![Area::Engine, Area::RoutingDns, Area::Daemon, Area::Other]
        );
        assert_eq!(v.passed, 2);
        assert_eq!(v.tone(), Tone::Error);
    }

    #[test]
    fn native_checks_never_offer_global_commands() {
        let v = aggregate(&[machine(vec![check("native root trust", "error", "x")])]);
        assert!(matches!(
            v.cards().next().unwrap().action,
            CardAction::OpenDoc(_)
        ));
    }

    #[test]
    fn all_failed_is_an_error_state_and_grey() {
        let mut pane = DoctorPane::default();
        let g = pane.begin(&[]);
        pane.finish(
            g,
            &[DoctorRun::machine(Err("hack not found".into()))],
            &[],
            Instant::now(),
        );
        assert_eq!(pane.result, DoctorState::Error("hack not found".into()));
        assert_eq!(pane.tone(), Tone::Idle);
        assert_eq!(
            DoctorPane::default().tone(),
            Tone::Idle,
            "never run is grey"
        );
    }

    #[test]
    fn stale_results_are_discarded_or_marked() {
        let t0 = Instant::now();
        let runs = [machine(vec![check("docker", "ok", "")])];
        let names = vec![key("alpha", "/work/alpha", false)];
        let mut pane = DoctorPane::default();
        let first = pane.begin(&names);
        let second = pane.begin(&names);
        assert_eq!(pane.finish(first, &runs, &names, t0), Finish::Discarded);
        assert!(pane.is_loading(), "the newer run is still in flight");
        assert_eq!(pane.finish(second, &runs, &names, t0), Finish::Applied);
        assert!(!pane.stale);
        let third = pane.begin(&names);
        let changed = vec![
            key("alpha", "/work/alpha", false),
            key("beta", "/work/beta", false),
        ];
        assert_eq!(
            pane.finish(third, &runs, &changed, t0),
            Finish::AppliedStale
        );
        assert!(pane.stale);
    }

    #[test]
    fn refresh_timing_and_age_label() {
        let t0 = Instant::now();
        let mut pane = DoctorPane::default();
        assert!(pane.needs_refresh(t0));
        let g = pane.begin(&[]);
        assert!(!pane.needs_refresh(t0), "not while loading");
        pane.finish(g, &[machine(vec![])], &[], t0);
        assert!(!pane.needs_refresh(t0 + Duration::from_secs(599)));
        assert!(pane.needs_refresh(t0 + REFRESH_EVERY));
        assert_eq!(pane.age_label(t0).as_deref(), Some("Checked just now"));
        assert_eq!(
            pane.age_label(t0 + Duration::from_secs(7 * 60 + 5))
                .as_deref(),
            Some("Checked 7 min ago")
        );
    }

    #[test]
    fn findings_for_a_project_count_its_cards() {
        let mut pane = DoctorPane::default();
        let g = pane.begin(&[key("alpha", "/work/alpha", false)]);
        pane.finish(
            g,
            &[
                machine(vec![check("daemon", "warn", "x")]),
                proj(
                    "alpha",
                    vec![
                        check("env key", "error", "missing"),
                        check("project", "warn", "y"),
                    ],
                ),
            ],
            &[key("alpha", "/work/alpha", false)],
            Instant::now(),
        );
        assert_eq!(pane.findings_for("alpha"), 2);
        assert_eq!(pane.findings_for("beta"), 0);
    }

    /// A fresh directory tree in the temp dir; removed on drop.
    struct Tree(PathBuf);

    impl Tree {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "hack-desktop-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The tree's own ancestors may already be a project (a temp dir under
    /// a checkout); only then is "outside" not provable.
    fn tree_base_is_clean(t: &Tree) -> bool {
        matches!(inside_project(&t.0), Ok(false))
    }

    #[test]
    fn neutral_dir_skips_directories_inside_a_project() {
        let t = Tree::new("neutral");
        let inside = t.0.join("checkout").join("deep");
        let outside = t.0.join("plain");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(t.0.join("checkout").join(".hack")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(inside_project(&inside).ok(), Some(true));
        assert_eq!(neutral_dir(std::slice::from_ref(&inside)), None);
        if tree_base_is_clean(&t) {
            assert_eq!(
                neutral_dir(&[inside, outside.clone()]),
                Some(outside.canonicalize().unwrap())
            );
        }
    }

    #[test]
    fn legacy_dev_compose_ancestor_is_a_project() {
        let t = Tree::new("legacy");
        let deep = t.0.join("old-checkout").join("src");
        std::fs::create_dir_all(&deep).unwrap();
        // A bare `.dev/` is not a project; one with a compose file is.
        std::fs::create_dir_all(t.0.join("old-checkout").join(".dev")).unwrap();
        if tree_base_is_clean(&t) {
            assert_eq!(inside_project(&deep).ok(), Some(false));
        }
        std::fs::write(
            t.0.join("old-checkout/.dev/docker-compose.yml"),
            "services: {}\n",
        )
        .unwrap();
        assert_eq!(inside_project(&deep).ok(), Some(true));
        assert_eq!(neutral_dir(&[deep]), None);
    }

    #[test]
    fn symlink_into_a_project_is_resolved() {
        let t = Tree::new("symlink");
        let real = t.0.join("checkout").join("tmp");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(t.0.join("checkout").join("hack.project.json"), "{}").unwrap();
        let link = t.0.join("elsewhere");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // Lexically `elsewhere` has no marker above it; resolved, it does.
        assert_eq!(inside_project(&link).ok(), Some(true));
        assert_eq!(neutral_dir(&[link]), None);
    }

    #[test]
    fn uninspectable_candidates_fail_closed() {
        assert_eq!(
            neutral_dir(&[PathBuf::from("/nonexistent/candidate")]),
            None
        );
        assert!(inside_project(Path::new("/nonexistent/candidate")).is_err());
    }

    #[test]
    fn global_secrets_hygiene_from_the_machine_run_is_kept() {
        // No registered projects: only the machine run reports it.
        let v = aggregate(&[machine(vec![check(
            "secrets hygiene",
            "error",
            "global store is readable by others",
        )])]);
        assert_eq!(v.attention_count(), 1);
        let c = v.cards().next().unwrap();
        assert_eq!(c.affected, Affected::Machine);
        assert_eq!(c.severity, Severity::Error);
        // From a project run it stays project-scoped, with the exact repair.
        let p = aggregate(&[proj("alpha", vec![check("secrets hygiene", "warn", "x")])]);
        let c = p.cards().next().unwrap();
        assert!(c.affected.includes("alpha"));
        assert_eq!(
            c.action,
            CardAction::Copy("hack doctor --fix --path '/work/alpha'".into())
        );
    }

    #[test]
    fn same_name_with_new_root_or_backend_is_stale() {
        let t0 = Instant::now();
        let runs = [machine(vec![check("docker", "ok", "")])];
        let before = vec![key("alpha", "/work/alpha", false)];
        for after in [
            vec![key("alpha", "/work/alpha-moved", false)],
            vec![key("alpha", "/work/alpha", true)],
        ] {
            let mut pane = DoctorPane::default();
            let g = pane.begin(&before);
            assert_eq!(pane.finish(g, &runs, &after, t0), Finish::AppliedStale);
            assert!(pane.stale);
            assert!(pane.needs_refresh(t0), "a stale result asks for a refresh");
        }
    }

    #[test]
    fn auto_refresh_only_when_shown_in_a_visible_window() {
        let t0 = Instant::now();
        let fresh = {
            let mut p = DoctorPane::default();
            let g = p.begin(&[]);
            p.finish(g, &[machine(vec![])], &[], t0);
            p
        };
        let never = DoctorPane::default();
        let later = t0 + REFRESH_EVERY;
        // (pane shown, window visible, pane, now) -> expected
        let cases = [
            (true, true, &never, t0, true),
            (true, false, &never, t0, false),
            (false, true, &never, t0, false),
            (true, true, &fresh, t0, false),
            (true, true, &fresh, later, true),
            (true, false, &fresh, later, false),
        ];
        for (shown, visible, pane, now, want) in cases {
            assert_eq!(
                should_auto_refresh(shown, visible, pane, now),
                want,
                "shown={shown} visible={visible}"
            );
        }
    }

    /// Every check id the CLI declares (summary groups and `*_CHECK`
    /// constants in `src/commands/doctor.ts` and `src/lib/doctor-*.ts`)
    /// maps to a known area.
    #[test]
    fn cli_check_ids_all_classify() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut sources = vec![root.join("src/commands/doctor.ts")];
        if let Ok(dir) = std::fs::read_dir(root.join("src/lib")) {
            for e in dir.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with("doctor") && n.ends_with(".ts") {
                    sources.push(e.path());
                }
            }
        }
        let mut ids = Vec::new();
        for path in &sources {
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            // `const X_CHECK = "id";`
            for line in text.lines() {
                let l = line.trim();
                if l.contains("_CHECK = \"")
                    && (l.starts_with("const ") || l.starts_with("export const "))
                    && let Some(id) = l.split('"').nth(1)
                {
                    ids.push(id.to_owned());
                }
            }
            // String literals inside DOCTOR_SUMMARY_GROUPS.
            if let Some(start) = text.find("const DOCTOR_SUMMARY_GROUPS") {
                let block = &text[start..];
                let block = &block[..block.find("] as const;").unwrap_or(block.len())];
                for (i, part) in block.split('"').enumerate() {
                    if i % 2 == 1 && !part.is_empty() && block_is_check(part) {
                        ids.push(part.to_owned());
                    }
                }
            }
        }
        assert!(ids.len() > 40, "expected the CLI's check ids, got {ids:?}");
        let unknown: Vec<&String> = ids.iter().filter(|id| classify(id).is_none()).collect();
        assert!(
            unknown.is_empty(),
            "unclassified CLI check ids: {unknown:?}"
        );
    }

    /// Titles in the summary groups are not check ids.
    fn block_is_check(s: &str) -> bool {
        ![
            "Dependencies",
            "Global runtime & agents",
            "Browser access",
            "Resolver & DNS",
            "Project & env",
            "Sessions",
        ]
        .contains(&s)
    }
}
