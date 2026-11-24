//! Display evidence and authored repair recipes for Doctor and follow-up banners.

use std::path::PathBuf;
use std::time::Instant;

use hack_desktop_core::{
    doctor::{DoctorRun, ProjectRef},
    setup::{self, Remedy, SafeAction, Status},
    source::DaemonRecovery,
    terminal::{CommandAvailability, CommandControl, CommandControlSize},
    upgrade::ReleaseUpdate,
};

#[cfg(any(test, hack_terminal))]
use hack_desktop_core::terminal::CommandExit;

const SCOPED_FIX: [&str; 6] = [
    "doctor",
    "--fix",
    "--only",
    "hack gitignore",
    "--yes",
    "--json",
];

pub const CLI_UPDATE_GUIDE: &str =
    "https://github.com/hack-dance/hack/blob/next/docs/reference/update-check.md";

pub const MACHINE_ROWS: [(&str, &str); 5] = [
    ("routing", "Routing and DNS"),
    ("daemon", "hackd"),
    ("docker", "Docker"),
    ("trust", "HTTPS certificates"),
    ("login", "Start at login"),
];

pub fn setup_card<'a>(report: &'a setup::Report, id: &str) -> Option<&'a setup::Card> {
    report.cards.iter().find(|card| card.id == id)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepairTarget {
    Setup(String),
    Project(ProjectRef),
}

impl RepairTarget {
    pub fn confirmed(&self, report: &setup::Report, runs: &[DoctorRun]) -> bool {
        match self {
            Self::Setup(id) => setup_card(report, id).is_some_and(|c| c.status == Status::Passed),
            Self::Project(project) => {
                project_check(project, runs).is_some_and(|c| c.status == "ok")
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Repair {
    pub target: RepairTarget,
    pub control: CommandControl,
}

impl Repair {
    pub fn runnable(&self) -> bool {
        matches!(self.control.availability, CommandAvailability::Ready(_))
    }
}

pub fn daemon_repair(action: DaemonRecovery, report: &setup::Report) -> Repair {
    let (verb, label) = match action {
        DaemonRecovery::Start => ("start", "hack daemon start"),
        DaemonRecovery::Restart => ("restart", "hack daemon restart"),
    };
    Repair {
        target: RepairTarget::Setup("daemon".into()),
        control: control(
            "repair-daemon".into(),
            label,
            report,
            vec!["daemon".into(), verb.into()],
            None,
            false,
        ),
    }
}

pub fn cli_update_repair(report: &setup::Report) -> Option<Repair> {
    let spec = report.command(vec!["update".into()]).ok()?;
    Some(Repair {
        target: RepairTarget::Setup("daemon".into()),
        control: CommandControl {
            id: "update-cli-for-hackd".into(),
            label: "hack update".into(),
            title: "Terminal".into(),
            availability: CommandAvailability::Ready(spec),
            size: CommandControlSize::Compact,
            cwd: None,
            expects_password: false,
        },
    })
}

pub fn machine_repair(card: &setup::Card, report: &setup::Report) -> Option<Repair> {
    // Only an observed failure can authorize a command. Older setup reports
    // may carry a fallback action even when their read did not succeed.
    if card.status != Status::NeedsAttention {
        return None;
    }
    let (label, argv, password) = match (card.id.as_str(), &card.remedy) {
        ("routing", Remedy::Admin(args)) if args == &["global", "install"] => {
            ("hack global install", args.clone(), true)
        }
        ("trust", Remedy::Admin(args)) if args == &["global", "trust"] => {
            ("hack global trust", args.clone(), true)
        }
        ("daemon", Remedy::Run(SafeAction::StartDaemon)) => (
            "hack daemon start",
            vec!["daemon".into(), "start".into()],
            false,
        ),
        ("daemon", Remedy::Copy(command))
            if matches_authored_copy(report, command, &["daemon", "restart"]) =>
        {
            (
                "hack daemon restart",
                vec!["daemon".into(), "restart".into()],
                false,
            )
        }
        ("login", Remedy::Run(SafeAction::InstallDaemon)) => (
            "hack daemon install",
            vec!["daemon".into(), "install".into()],
            false,
        ),
        _ => return None,
    };
    Some(Repair {
        target: RepairTarget::Setup(card.id.clone()),
        control: control(
            format!("repair-{}", card.id),
            label,
            report,
            argv,
            None,
            password,
        ),
    })
}

/// Older setup reports contain the quoted command. Compare it to known argv
/// rather than treating that display string as something to run.
pub fn matches_authored_copy(report: &setup::Report, copy: &str, argv: &[&str]) -> bool {
    let short = format!("hack {}", argv.join(" "));
    copy == short
        || report
            .command(argv.iter().map(|arg| (*arg).to_owned()).collect())
            .and_then(|spec| spec.display())
            .is_ok_and(|command| command == copy)
}

fn project_check<'a>(
    project: &ProjectRef,
    runs: &'a [DoctorRun],
) -> Option<&'a hack_desktop_core::models::DoctorCheck> {
    let mut matching = runs.iter().filter(|run| {
        run.project.as_deref() == Some(project.name.as_str())
            && run.root == project.root
            && run.native == project.native
    });
    let run = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    run.checked_project_finding("hack gitignore")
}

pub fn project_repair(
    project: &ProjectRef,
    report: &setup::Report,
    runs: &[DoctorRun],
) -> Option<Repair> {
    if project.native {
        return None;
    }
    let root = project.root.as_ref()?.clone();
    let check = project_check(project, runs)?;
    let fix = check.fix.as_ref()?;
    // Use the CLI's scoped repair contract and pass only the app's known argv.
    // A free-form string from Doctor is never an executable recipe.
    if !matches!(check.status.as_str(), "warn" | "error")
        || fix.kind != "safe"
        || fix.args != SCOPED_FIX
        || !gitignore_needs_repair(&check.detail)
        || !root.is_absolute()
    {
        return None;
    }
    let mut argv = SCOPED_FIX.map(str::to_owned).to_vec();
    argv.extend(["--path".into(), root.to_str()?.into()]);
    let mut checked = report.clone();
    checked.context = report.context.as_ref()?.with_backend("compose").ok();
    Some(Repair {
        target: RepairTarget::Project(project.clone()),
        control: control(
            format!("repair-gitignore-{}-{}", project.name, root.display()),
            "hack doctor --fix --only 'hack gitignore'",
            &checked,
            argv,
            Some(root),
            false,
        ),
    })
}

/// The CLI currently advertises the same fix metadata for every Git-ignore
/// finding, including permission and symlink refusals. Only the two repairable
/// observations admit the fixed scoped argv above.
fn gitignore_needs_repair(detail: &str) -> bool {
    [".hack", ".dev"].into_iter().any(|dir| {
        let Some(detail) = detail
            .strip_prefix(dir)
            .and_then(|detail| detail.strip_prefix("/.gitignore "))
        else {
            return false;
        };
        detail.starts_with("is missing.")
            || detail.starts_with("lacks Hack's current managed block.")
    })
}

fn control(
    id: String,
    label: &str,
    report: &setup::Report,
    argv: Vec<String>,
    cwd: Option<PathBuf>,
    password: bool,
) -> CommandControl {
    let availability = match report.command(argv) {
        Ok(spec) => CommandAvailability::Ready(spec),
        Err(why) => CommandAvailability::Blocked(why),
    };
    CommandControl {
        id,
        label: label.into(),
        title: "Terminal".into(),
        availability,
        size: CommandControlSize::Compact,
        cwd,
        expects_password: password,
    }
}

#[derive(Default)]
pub struct Health {
    pub(crate) observed_setup: Option<(Instant, setup::Report)>,
    pub(crate) runs: Vec<DoctorRun>,
    pub(crate) queue: Option<RepairQueue>,
    pub(crate) confirmed: Vec<RepairTarget>,
    pub(crate) recent_failure: Option<String>,
    pub(crate) passed_open: bool,
    pub(crate) details_open: Option<String>,
    pub(crate) follow_ups: FollowUps,
    pub(crate) signals: HealthSignals,
    pub(crate) fixture: Option<crate::health_fixtures::HealthFixture>,
    pub(crate) update_started: Option<Instant>,
    pub(crate) update_checking: bool,
}

#[derive(Default)]
pub struct HealthSignals {
    pub(crate) wrong_cli: Option<WrongCli>,
    pub(crate) update: Option<ReleaseUpdate>,
    pub(crate) offline: bool,
    pub(crate) routing_permission_denied: bool,
}

#[derive(Clone)]
pub struct WrongCli {
    pub(crate) current: String,
    pub(crate) replacement: String,
    pub(crate) path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct RepairQueue {
    pub(crate) repairs: Vec<Repair>,
    pub(crate) index: usize,
    pub(crate) stopping: bool,
    pub(crate) checking: bool,
    pub(crate) all: bool,
}

impl RepairQueue {
    pub fn new(repairs: Vec<Repair>, all: bool) -> Option<Self> {
        let repairs: Vec<_> = repairs.into_iter().filter(Repair::runnable).collect();
        (!repairs.is_empty()).then_some(Self {
            repairs,
            index: 0,
            stopping: false,
            checking: false,
            all,
        })
    }

    pub fn current(&self) -> &Repair {
        &self.repairs[self.index]
    }

    pub fn command(&self) -> CommandControl {
        let mut command = self.current().control.clone();
        if self.all {
            command.title = format!("Fix all · {} of {}", self.index + 1, self.repairs.len());
        }
        command
    }

    /// Only a zero exit followed by positive evidence can advance the queue.
    #[cfg(any(test, hack_terminal))]
    pub fn advance(&mut self, exit: &CommandExit, confirmed: bool) -> bool {
        if self.stopping
            || *exit != CommandExit::Code(0)
            || !confirmed
            || self.index + 1 == self.repairs.len()
        {
            return false;
        }
        self.index += 1;
        self.checking = false;
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FollowUpKind {
    DaemonDown,
    WrongCli,
    DaemonMismatch,
    Permission,
    Routing,
    Docker,
    Setup,
    Update,
    CouldNotCheck,
    Offline,
}

#[derive(Default)]
pub struct FollowUps {
    dismissed: std::collections::BTreeSet<(FollowUpKind, String)>,
}

impl FollowUps {
    pub fn has_dismissals(&self) -> bool {
        !self.dismissed.is_empty()
    }

    /// Keep a dismissal only while the exact evidence is still present. A
    /// healthy observation removes it even when the same problem later recurs.
    pub fn retain(&mut self, present: &[(FollowUpKind, String)]) {
        self.dismissed.retain(|entry| present.contains(entry));
    }

    pub fn dismiss(&mut self, kind: FollowUpKind, evidence: String) {
        self.dismissed.insert((kind, evidence));
    }

    pub fn visible(&self, kind: FollowUpKind, evidence: &str) -> bool {
        !self
            .dismissed
            .iter()
            .any(|(seen_kind, seen)| *seen_kind == kind && seen == evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hack_desktop_core::{
        execution::ExecutionContext,
        models::{DoctorCheck, DoctorCheckFix, DoctorReport},
        terminal::CommandSpec,
    };

    fn report() -> setup::Report {
        setup::Report {
            cards: vec![setup::Card {
                id: "cli".into(),
                title: "Hack 5".into(),
                status: Status::Passed,
                detail: "Hack 5.0.0".into(),
                remedy: Remedy::Doc(String::new()),
            }],
            cli_program: Some("/usr/bin/hack".into()),
            context: ExecutionContext::from_values(&[("HOME".into(), "/home/test-user".into())])
                .ok(),
            force_cli_gate: false,
        }
    }

    fn repair(id: &str, allowed: bool) -> Repair {
        let mut report = report();
        if !allowed {
            report.cli_program = None;
        }
        Repair {
            target: RepairTarget::Setup(id.into()),
            control: control(
                id.into(),
                "sample",
                &report,
                vec!["--help".into()],
                None,
                false,
            ),
        }
    }

    #[test]
    fn fix_all_keeps_only_runnable_commands_in_order_and_requires_fresh_confirmation() {
        let mut queue = RepairQueue::new(
            vec![
                repair("routing", true),
                repair("docker", false),
                repair("trust", true),
            ],
            true,
        )
        .unwrap();
        assert_eq!(queue.command().title, "Fix all · 1 of 2");
        assert!(!queue.advance(&CommandExit::Code(1), true));
        assert!(!queue.advance(&CommandExit::Code(0), false));
        assert!(!queue.advance(&CommandExit::Signal(2), true));
        assert!(queue.advance(&CommandExit::Code(0), true));
        assert_eq!(queue.current().target, RepairTarget::Setup("trust".into()));
        assert_eq!(queue.command().title, "Fix all · 2 of 2");
        assert!(!queue.advance(&CommandExit::Code(0), true));
    }

    #[test]
    fn stop_during_recheck_cannot_admit_the_next_command() {
        let mut queue =
            RepairQueue::new(vec![repair("routing", true), repair("trust", true)], true).unwrap();
        queue.checking = true;
        queue.stopping = true;
        assert!(!queue.advance(&CommandExit::Code(0), true));
        assert_eq!(queue.index, 0);
    }

    #[test]
    fn unreadable_daemon_report_never_enrolls_legacy_restart_fallback() {
        let card = setup::Card {
            id: "daemon".into(),
            title: "hackd".into(),
            status: Status::Unknown,
            detail: "Couldn’t check".into(),
            remedy: Remedy::Copy("hack daemon restart".into()),
        };
        assert!(machine_repair(&card, &report()).is_none());
    }

    #[test]
    fn dismissals_expire_if_the_evidence_changes_or_the_problem_clears() {
        let mut notices = FollowUps::default();
        notices.dismiss(FollowUpKind::Routing, "one DNS piece".into());
        assert!(!notices.visible(FollowUpKind::Routing, "one DNS piece"));
        assert!(notices.visible(FollowUpKind::Routing, "two DNS pieces"));
        assert!(notices.visible(FollowUpKind::DaemonDown, "one DNS piece"));
        notices.retain(&[]);
        assert!(notices.visible(FollowUpKind::Routing, "one DNS piece"));
    }

    #[test]
    fn notices_of_the_same_kind_keep_independent_dismissals() {
        let kind = FollowUpKind::CouldNotCheck;
        let mut notices = FollowUps::default();
        notices.dismiss(kind, "project read timed out".into());
        notices.dismiss(kind, "recovery failed".into());
        assert!(!notices.visible(kind, "project read timed out"));
        assert!(!notices.visible(kind, "recovery failed"));
        notices.retain(&[(kind, "recovery failed".into())]);
        assert!(notices.visible(kind, "project read timed out"));
        assert!(!notices.visible(kind, "recovery failed"));
    }

    #[test]
    fn a_project_repair_needs_exact_scope_and_the_cli_safe_contract() {
        let root = "/work/storefront checkout";
        let project = ProjectRef {
            name: "storefront".into(),
            root: Some(root.into()),
            native: false,
        };
        let scoped = DoctorCheck {
            native_pool: None,
            id: "hack gitignore".into(),
            status: "warn".into(),
            detail: ".hack/.gitignore is missing. Run 'hack doctor --fix' to create it.".into(),
            fix: Some(DoctorCheckFix {
                kind: "safe".into(),
                args: SCOPED_FIX.map(str::to_owned).to_vec(),
            }),
        };
        let project_check = DoctorCheck {
            native_pool: None,
            fix: None,
            id: "project".into(),
            status: "ok".into(),
            detail: format!("Found .hack/ (or legacy .dev/) at {root}/.hack"),
            ..DoctorCheck::default()
        };
        let run = |checks| {
            DoctorRun::project(
                "storefront",
                root,
                Ok(DoctorReport {
                    checks,
                    summary: vec![],
                }),
            )
        };
        let proposed = [run(vec![project_check.clone(), scoped.clone()])];
        let repair = project_repair(&project, &report(), &proposed).unwrap();
        let CommandAvailability::Ready(CommandSpec { args, .. }) = repair.control.availability
        else {
            panic!("expected checked command");
        };
        assert_eq!(&args[args.len() - 2..], &["--path", root]);
        assert!(!repair.target.confirmed(&report(), &proposed));
        assert!(project_repair(&project, &report(), &[run(vec![scoped.clone()])]).is_none());
        let duplicate = [run(vec![
            project_check.clone(),
            scoped.clone(),
            scoped.clone(),
        ])];
        assert!(project_repair(&project, &report(), &duplicate).is_none());
        let manual = DoctorCheck {
            fix: None,
            ..scoped.clone()
        };
        assert!(
            project_repair(
                &project,
                &report(),
                &[run(vec![project_check.clone(), manual])]
            )
            .is_none()
        );
        let passed = DoctorCheck {
            status: "ok".into(),
            ..scoped
        };
        assert!(
            repair
                .target
                .confirmed(&report(), &[run(vec![project_check, passed])])
        );
    }
}
