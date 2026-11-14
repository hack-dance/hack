//! Doctor view model (DESIGN.md section 3).
//!
//! Turns several `hack doctor --json` runs (one outside any project, one per
//! registered project) into cards grouped by area:
//! - Machine-wide findings are shown once, whichever runs reported them.
//! - Project findings carry the names of the projects they affect.
//! - `ok` checks collapse into a "N checks passed" count.
//! - Each card has exactly one action. Until the CLI reports a fix kind
//!   (design request R7a), that action is "Copy command" for a known
//!   command or "Open doc"; the app never offers "Run".
//!
//! Pure: no I/O. Reading the reports lives in [`crate::source`].

use std::collections::BTreeMap;

use crate::models::{DoctorCheck, DoctorReport};

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

/// Area and scope for a check `id`. Unknown ids go to `Other`, scoped to the
/// run that reported them (machine when outside a project).
#[must_use]
pub fn classify(id: &str) -> Option<(Area, Scope)> {
    use Area::*;
    use Scope::*;
    let exact = match id {
        "docker" | "docker compose" | "docker daemon" | "bun" | "mutagen" => (Engine, Machine),
        "proxy ports" | "proxy network" | "dnsmasq:53" | "coredns forwarding"
        | "linux dns route" | "caddy hosts" | "global files" | "grafana" | "caddy" => {
            (RoutingDns, Machine)
        }
        "DEV_HOST" => (RoutingDns, Project),
        "caddy local ca" | "host tls trust" | "superseded caddy roots" => (Certificates, Machine),
        "daemon" | "daemon service" | "gateway config" | "gateway tokens" => (Daemon, Machine),
        "env key"
        | "env mode"
        | "env materialization"
        | "env overlay warnings"
        | "worktree keys"
        | "secret store" => (EnvSecrets, Project),
        "project" | "runtime hygiene" | "lifecycle hygiene" | "compose networks"
        | "generated files" | "hack gitignore" | "worktree instances" | "sessions mux" => {
            (ProjectFiles, Project)
        }
        "native host dns" | "native hack.local route" | "native hack.local repair" => {
            (Native, Machine)
        }
        "native root trust" | "native ca repair" | "native https owner" | "native https route" => {
            (Native, Machine)
        }
        "native settings" | "native source size" => (Native, Project),
        _ => {
            return prefixed(id);
        }
    };
    Some(exact)
}

fn prefixed(id: &str) -> Option<(Area, Scope)> {
    if id.starts_with("resolver:") || id.starts_with("dnsmasq.conf:") || id.starts_with("dns:") {
        return Some((Area::RoutingDns, Scope::Machine));
    }
    if id.starts_with("network:") {
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

/// The single action a card offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardAction {
    /// Copy this command; the user runs it (in a terminal for admin steps).
    Copy(String),
    /// Open this documentation page.
    OpenDoc(String),
}

const DOCS: &str = "https://github.com/hack-dance/hack/blob/next/docs/";

fn doc_for(area: Area) -> String {
    let page = match area {
        Area::Engine => "guides/getting-started.md",
        Area::RoutingDns => {
            if cfg!(target_os = "linux") {
                "guides/linux-setup.md"
            } else {
                "guides/getting-started.md"
            }
        }
        Area::Certificates => {
            if cfg!(target_os = "linux") {
                "guides/linux-certificate-trust.md"
            } else {
                "guides/macos-certificate-trust.md"
            }
        }
        Area::Daemon => "architecture.md#daemon-hackd",
        Area::EnvSecrets => "env.md",
        Area::ProjectFiles => "guides/init-project.md",
        Area::Native => "native",
        Area::Other => "cli.md",
    };
    format!("{DOCS}{page}")
}

/// Known command for a check, or `None` when only documentation applies.
/// Native checks never get `hack global …`: those commands refuse native.
fn command_for(id: &str, area: Area) -> Option<&'static str> {
    Some(match id {
        "daemon" => "hack daemon start",
        "daemon service" => "hack daemon install",
        "caddy local ca" | "host tls trust" => "hack global trust",
        "generated files" | "hack gitignore" | "runtime hygiene" | "lifecycle hygiene" => {
            "hack doctor --fix"
        }
        _ if area == Area::RoutingDns && id != "DEV_HOST" => "hack global install",
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Affected {
    Machine,
    Projects(Vec<String>),
}

impl Affected {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Machine => "Affected: machine".into(),
            Self::Projects(p) => format!("Affected: {}", p.join(", ")),
        }
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
    pub result: Result<DoctorReport, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorView {
    /// Areas in display order, each with its cards (errors first).
    pub groups: Vec<(Area, Vec<Card>)>,
    /// Distinct checks that passed and were not also failing elsewhere.
    pub passed: usize,
    /// Runs that produced no report: (project or machine, reason).
    pub failed_runs: Vec<(String, String)>,
}

impl DoctorView {
    /// Cards needing attention; the sidebar badge.
    #[must_use]
    pub fn attention_count(&self) -> usize {
        self.groups.iter().map(|(_, c)| c.len()).sum()
    }

    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.groups
            .iter()
            .flat_map(|(_, c)| c)
            .any(|c| c.severity == Severity::Error)
    }
}

fn severity(status: &str) -> Option<Severity> {
    match status {
        "error" => Some(Severity::Error),
        "warn" => Some(Severity::Warn),
        _ => None,
    }
}

/// Aggregate runs into the Doctor view.
#[must_use]
pub fn aggregate(runs: &[DoctorRun]) -> DoctorView {
    // Machine findings: by id. Project findings: by (id, severity, detail).
    let mut machine: BTreeMap<String, (Area, Severity, String)> = BTreeMap::new();
    let mut project: BTreeMap<(String, Severity, String), (Area, Vec<String>)> = BTreeMap::new();
    let mut ok: BTreeMap<(String, Option<String>), ()> = BTreeMap::new();
    let mut failing: BTreeMap<(String, Option<String>), ()> = BTreeMap::new();
    let mut failed_runs = Vec::new();

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
        for DoctorCheck { id, status, detail } in &report.checks {
            let (area, scope) = classify(id).unwrap_or((
                Area::Other,
                if run.project.is_some() {
                    Scope::Project
                } else {
                    Scope::Machine
                },
            ));
            // A project check outside any project has no project to name.
            let owner = match (scope, &run.project) {
                (Scope::Machine, _) => None,
                (Scope::Project, Some(p)) => Some(p.clone()),
                (Scope::Project, None) => continue,
            };
            let key = (id.clone(), owner.clone());
            let Some(sev) = severity(status) else {
                ok.insert(key, ());
                continue;
            };
            failing.insert(key, ());
            match owner {
                None => {
                    let entry = machine
                        .entry(id.clone())
                        .or_insert((area, sev, detail.clone()));
                    // Keep the worst severity and its detail.
                    if sev < entry.1 {
                        *entry = (area, sev, detail.clone());
                    }
                }
                Some(p) => {
                    let entry = project
                        .entry((id.clone(), sev, detail.clone()))
                        .or_insert((area, Vec::new()));
                    if !entry.1.contains(&p) {
                        entry.1.push(p);
                    }
                }
            }
        }
    }

    let card = |id: &str, area: Area, severity: Severity, detail: String, affected: Affected| {
        let action = match command_for(id, area) {
            Some(c) => CardAction::Copy(c.into()),
            None => CardAction::OpenDoc(doc_for(area)),
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
    }
}

/// Doctor pane state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DoctorState {
    /// Doctor has not run in this session.
    #[default]
    NeverRun,
    Loading,
    Loaded(DoctorView),
    /// No run produced a report.
    Error(String),
}

impl DoctorState {
    /// Result of a refresh: a view when any run produced a report.
    #[must_use]
    pub fn from_runs(runs: &[DoctorRun]) -> Self {
        if !runs.is_empty() && runs.iter().all(|r| r.result.is_err()) {
            let why = runs
                .iter()
                .filter_map(|r| r.result.as_ref().err())
                .next()
                .cloned()
                .unwrap_or_default();
            return Self::Error(why);
        }
        Self::Loaded(aggregate(runs))
    }
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

    fn run(project: Option<&str>, checks: Vec<DoctorCheck>) -> DoctorRun {
        DoctorRun {
            project: project.map(str::to_owned),
            result: Ok(DoctorReport {
                checks,
                summary: vec![],
            }),
        }
    }

    #[test]
    fn machine_findings_appear_once() {
        let runs = vec![
            run(None, vec![check("caddy local ca", "warn", "not trusted")]),
            run(
                Some("alpha"),
                vec![check("caddy local ca", "warn", "not trusted")],
            ),
            run(
                Some("beta"),
                vec![check("caddy local ca", "error", "missing")],
            ),
        ];
        let v = aggregate(&runs);
        assert_eq!(v.attention_count(), 1);
        let c = &v.groups[0].1[0];
        assert_eq!(c.area, Area::Certificates);
        assert_eq!(c.affected, Affected::Machine);
        assert_eq!(c.severity, Severity::Error, "worst severity wins");
        assert_eq!(c.detail, "missing");
        assert_eq!(c.action, CardAction::Copy("hack global trust".into()));
    }

    #[test]
    fn project_findings_name_their_projects() {
        let runs = vec![
            run(Some("beta"), vec![check("env key", "error", "key missing")]),
            run(
                Some("alpha"),
                vec![check("env key", "error", "key missing")],
            ),
            run(
                Some("gamma"),
                vec![check("env key", "warn", "key readable by group")],
            ),
        ];
        let v = aggregate(&runs);
        let cards = &v.groups[0].1;
        assert_eq!(v.groups[0].0, Area::EnvSecrets);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].severity, Severity::Error);
        assert_eq!(
            cards[0].affected,
            Affected::Projects(vec!["alpha".into(), "beta".into()])
        );
        assert_eq!(cards[1].affected, Affected::Projects(vec!["gamma".into()]));
        assert!(matches!(cards[0].action, CardAction::OpenDoc(_)));
    }

    #[test]
    fn project_checks_outside_a_project_are_dropped() {
        let v = aggregate(&[run(
            None,
            vec![check("project", "error", "not in a project")],
        )]);
        assert_eq!(v.attention_count(), 0);
    }

    #[test]
    fn grouping_order_and_unknown_ids() {
        let runs = vec![run(
            None,
            vec![
                check("brand new check", "warn", "?"),
                check("daemon", "warn", "stopped"),
                check("docker daemon", "error", "down"),
                check("resolver:hack", "error", "missing"),
                check("bun", "ok", ""),
                check("docker", "ok", ""),
            ],
        )];
        let v = aggregate(&runs);
        let areas: Vec<Area> = v.groups.iter().map(|(a, _)| *a).collect();
        assert_eq!(
            areas,
            vec![Area::Engine, Area::RoutingDns, Area::Daemon, Area::Other]
        );
        assert_eq!(v.passed, 2);
        let other = &v.groups[3].1[0];
        assert_eq!(other.id, "brand new check");
        assert!(matches!(other.action, CardAction::OpenDoc(_)));
        let dns = &v.groups[1].1[0];
        assert_eq!(dns.action, CardAction::Copy("hack global install".into()));
        assert!(v.has_errors());
    }

    #[test]
    fn errors_sort_before_warnings_within_an_area() {
        let runs = vec![run(
            None,
            vec![
                check("dnsmasq:53", "warn", "slow"),
                check("resolver:hack", "error", "missing"),
            ],
        )];
        let v = aggregate(&runs);
        assert_eq!(v.groups[0].1[0].id, "resolver:hack");
    }

    #[test]
    fn native_checks_never_offer_global_commands() {
        let v = aggregate(&[run(None, vec![check("native root trust", "error", "x")])]);
        assert!(matches!(v.groups[0].1[0].action, CardAction::OpenDoc(_)));
    }

    #[test]
    fn passed_excludes_checks_failing_elsewhere() {
        let runs = vec![
            run(Some("alpha"), vec![check("caddy local ca", "ok", "")]),
            run(Some("beta"), vec![check("caddy local ca", "warn", "x")]),
        ];
        assert_eq!(aggregate(&runs).passed, 0);
    }

    #[test]
    fn failed_runs_are_reported_and_all_failed_is_an_error() {
        let runs = vec![
            DoctorRun {
                project: Some("alpha".into()),
                result: Err("timed out".into()),
            },
            run(None, vec![check("docker", "ok", "")]),
        ];
        match DoctorState::from_runs(&runs) {
            DoctorState::Loaded(v) => {
                assert_eq!(v.failed_runs, vec![("alpha".into(), "timed out".into())]);
            }
            other => panic!("{other:?}"),
        }
        let all_bad = vec![DoctorRun {
            project: None,
            result: Err("hack not found".into()),
        }];
        assert_eq!(
            DoctorState::from_runs(&all_bad),
            DoctorState::Error("hack not found".into())
        );
    }

    #[test]
    fn every_card_has_one_action_and_needs_r7a() {
        let runs = vec![run(
            None,
            vec![
                check("daemon service", "warn", ""),
                check("generated files", "warn", ""),
            ],
        )];
        let v = aggregate(&runs);
        for c in v.groups.iter().flat_map(|(_, c)| c) {
            assert_eq!(c.needs, "R7a");
        }
    }
}
