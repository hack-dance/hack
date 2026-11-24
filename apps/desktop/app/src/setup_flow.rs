//! The setup itinerary and its presentation state. Machine evidence stays in Report.

use std::time::{Duration, Instant};

use hack_desktop_core::setup::{Card, CheckScope, Pane, Remedy, Report, Status};
use hack_desktop_core::terminal::CommandExit;

pub(crate) const ADVANCE_DELAY: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Cli,
    Daemon,
    Docker,
    Domains,
    Https,
    Login,
}

impl Step {
    pub(crate) const ALL: [Self; 6] = [
        Self::Cli,
        Self::Daemon,
        Self::Docker,
        Self::Domains,
        Self::Https,
        Self::Login,
    ];

    pub(crate) fn index(self) -> usize {
        self as usize
    }

    pub(crate) fn id(self) -> &'static str {
        ["cli", "daemon", "docker", "routing", "trust", "login"][self.index()]
    }

    pub(crate) fn name(self) -> &'static str {
        [
            "Hack CLI",
            "Hack service",
            "Docker",
            "Local domains",
            "HTTPS",
            "Start at login",
        ][self.index()]
    }

    pub(crate) fn title(self) -> &'static str {
        [
            "Install Hack 5",
            "Start the Hack service",
            "Connect Docker",
            "Set up local domains",
            "Trust Hack’s certificates",
            "Start Hack at login",
        ][self.index()]
    }

    pub(crate) fn why(self) -> &'static str {
        [
            "The app runs the hack command for everything it shows, so it needs Hack 5.",
            "hackd runs in the background and keeps your projects, logs and URLs up to date.",
            "Compose projects run in Docker containers. Native projects don’t need it.",
            "So your local project URLs open in the browser.",
            "So HTTPS project URLs open without browser warnings.",
            "So hackd and your always-on projects come back after a restart.",
        ][self.index()]
    }

    pub(crate) fn check_scope(self) -> CheckScope {
        [
            CheckScope::Cli,
            CheckScope::Daemon,
            CheckScope::Docker,
            CheckScope::Network,
            CheckScope::Network,
            CheckScope::Login,
        ][self.index()]
    }

    pub(crate) fn next(self) -> Option<Self> {
        Self::ALL.get(self.index() + 1).copied()
    }

    pub(crate) fn card(self, report: &Report) -> Option<&Card> {
        report.cards.iter().find(|card| card.id == self.id())
    }

    pub(crate) fn related(self, card: &Card) -> bool {
        self.id() == card.id
            || match self {
                Self::Docker => card.id.starts_with("native:"),
                Self::Domains => card.id.starts_with("dns:"),
                Self::Https => card.id.starts_with("trust:"),
                _ => false,
            }
    }

    pub(crate) fn cards(self, report: &Report) -> impl Iterator<Item = &Card> {
        report.cards.iter().filter(move |card| self.related(card))
    }

    pub(crate) fn remedy_card(self, report: &Report) -> Option<&Card> {
        self.cards(report).find(|card| match card.status {
            Status::NeedsAttention => true,
            Status::Unknown | Status::VersionMismatch => {
                matches!(card.remedy, Remedy::Doc(_))
                    || (self == Self::Daemon && matches!(card.remedy, Remedy::Copy(_)))
            }
            Status::Passed | Status::Blocked => false,
        })
    }

    fn evidence(self, report: &Report) -> StepState {
        let mut cards = self.cards(report).peekable();
        if cards.peek().is_none() {
            return StepState::Unchecked;
        }
        // Retain project-specific evidence when a Compose check and a native
        // check share a screen. Every applicable card must pass.
        let mut state = StepState::Passed;
        for card in cards {
            match card.status {
                Status::Blocked => return StepState::Blocked,
                Status::VersionMismatch => return StepState::VersionMismatch,
                Status::Unknown => state = StepState::Unchecked,
                Status::NeedsAttention if state != StepState::Unchecked => {
                    state = StepState::NeedsAction
                }
                _ => {}
            }
        }
        state
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Screen {
    #[default]
    Welcome,
    Step(Step),
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepState {
    Todo,
    Checking,
    Running,
    Password,
    Passed,
    NeedsAction,
    Failed,
    Skipped,
    Blocked,
    Unchecked,
    VersionMismatch,
}

#[derive(Clone, Debug)]
pub(crate) struct RunOutcome {
    pub step: Step,
    pub exit: CommandExit,
    pub diagnosis: Option<String>,
}

#[derive(Default)]
pub(crate) struct Flow {
    pub screen: Screen,
    /// Only visited steps surface results from the aggregate setup report.
    visited: [bool; Step::ALL.len()],
    pub details_open: bool,
    pub advance_at: Option<Instant>,
    pub stay: bool,
    pub outcome: Option<RunOutcome>,
    pub checking_scope: Option<CheckScope>,
    pub terminal_notice: Option<String>,
    #[cfg(feature = "screenshots")]
    pub fixture: Option<crate::setup_frames::Overlay>,
}

impl Flow {
    pub fn step(&self) -> Option<Step> {
        match self.screen {
            Screen::Step(step) => Some(step),
            _ => None,
        }
    }

    pub fn enter(&mut self, screen: Screen) {
        self.screen = screen;
        self.details_open = false;
        self.advance_at = None;
        self.stay = false;
        self.terminal_notice = None;
        if let Screen::Step(step) = screen {
            self.visited[step.index()] = true;
        }
    }

    pub fn evidence(&self, step: Step, pane: &Pane) -> StepState {
        if step != Step::Cli && !pane.report.cli_ready() && !pane.report.cards.is_empty() {
            return StepState::Blocked;
        }
        step.evidence(&pane.report)
    }

    pub fn state(&self, step: Step, pane: &Pane) -> StepState {
        #[cfg(feature = "screenshots")]
        if self.step() == Some(step)
            && let Some(state) = self.fixture.as_ref().and_then(|fixture| fixture.state)
        {
            return state;
        }
        let evidence = self.evidence(step, pane);
        if self.screen == Screen::Welcome {
            return StepState::Todo;
        }
        if evidence == StepState::Blocked {
            return evidence;
        }
        if self.step() == Some(step) {
            if pane.action_busy {
                return StepState::Running;
            }
            if pane.loading {
                return StepState::Checking;
            }
        }
        if self
            .outcome
            .as_ref()
            .is_some_and(|run| run.step == step && run.exit != CommandExit::Code(0))
        {
            return StepState::Failed;
        }
        if evidence == StepState::Passed && self.visited[step.index()] {
            return evidence;
        }
        if Self::explicitly_skipped(step, pane) {
            return StepState::Skipped;
        }
        if !self.visited[step.index()] {
            return StepState::Todo;
        }
        evidence
    }

    pub fn can_advance(&self, pane: &Pane) -> bool {
        self.step()
            .is_some_and(|step| self.state(step, pane) == StepState::Passed)
    }

    pub fn can_skip(&self, step: Step, pane: &Pane) -> bool {
        self.step() == Some(step)
            && matches!(
                self.state(step, pane),
                StepState::NeedsAction
                    | StepState::Failed
                    | StepState::Unchecked
                    | StepState::Skipped
            )
            && step != Step::Cli
            && pane.report.cli_ready()
    }

    pub fn first_unresolved(&self, pane: &Pane) -> Option<Step> {
        Step::ALL.into_iter().find(|&step| {
            self.evidence(step, pane) != StepState::Passed && !Self::explicitly_skipped(step, pane)
        })
    }

    fn explicitly_skipped(step: Step, pane: &Pane) -> bool {
        step != Step::Cli
            && pane.skipped.contains(step.id())
            && (step != Step::Docker
                || step.cards(&pane.report).all(|card| {
                    card.id == step.id()
                        || card.status == Status::Passed
                        || pane.skipped.contains(&card.id)
                }))
    }

    pub fn skip_label(&self, step: Step, pane: &Pane) -> &'static str {
        if self.state(step, pane) == StepState::Skipped {
            return "Keep skipped";
        }
        match step {
            Step::Docker
                if step.card(&pane.report).is_some()
                    && step
                        .cards(&pane.report)
                        .all(|card| card.id == step.id() || card.status == Status::Passed) =>
            {
                "I only use native"
            }
            Step::Login => "Not now",
            _ => "Skip for now",
        }
    }

    pub fn next_screen(&self, step: Step, pane: &Pane) -> Screen {
        step.next()
            .or_else(|| self.first_unresolved(pane))
            .map_or(Screen::Done, Screen::Step)
    }

    pub fn skip(&mut self, step: Step, pane: &mut Pane) {
        if self.can_skip(step, pane) {
            if self.outcome.as_ref().is_some_and(|run| run.step == step) {
                self.outcome = None;
            }
            pane.skipped.insert(step.id().into());
            for card in step.cards(&pane.report) {
                if card.status != Status::Passed {
                    pane.skipped.insert(card.id.clone());
                }
            }
            self.enter(self.next_screen(step, pane));
        }
    }

    pub fn can_open(&self, step: Step, pane: &Pane) -> bool {
        matches!(
            self.state(step, pane),
            StepState::Passed | StepState::Skipped
        )
    }

    /// Completion is valid while every unskipped check still passes.
    pub fn reconcile(&mut self, pane: &Pane) {
        match self.screen {
            Screen::Done => {
                if let Some(step) = self.first_unresolved(pane) {
                    self.enter(Screen::Step(step));
                }
            }
            Screen::Step(step) if step != Step::Cli && !pane.report.cli_ready() => {
                self.enter(Screen::Step(Step::Cli));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Pane {
        let mut pane = Pane::default();
        pane.report = hack_desktop_core::setup_fixtures::load("ready").unwrap();
        pane
    }

    #[test]
    fn the_cli_is_required_and_service_precedes_docker() {
        let mut flow = Flow::default();
        let mut pane = ready();
        pane.report.cards[0].status = Status::VersionMismatch;
        assert_eq!(flow.state(Step::Cli, &pane), StepState::Todo);

        flow.enter(Screen::Step(Step::Cli));
        assert_eq!(flow.state(Step::Cli, &pane), StepState::VersionMismatch);
        assert!(!flow.can_advance(&pane));
        assert!(!flow.can_skip(Step::Cli, &pane));
        for step in Step::ALL.into_iter().skip(1) {
            assert_eq!(flow.state(step, &pane), StepState::Blocked);
        }

        pane.report.cards[0].status = Status::Passed;
        assert!(flow.can_advance(&pane));
        assert_eq!(
            flow.next_screen(Step::Cli, &pane),
            Screen::Step(Step::Daemon)
        );
        assert_eq!(
            flow.next_screen(Step::Daemon, &pane),
            Screen::Step(Step::Docker)
        );
        assert_eq!(flow.state(Step::Docker, &pane), StepState::Todo);
    }

    #[test]
    fn a_skip_advances_without_making_the_check_pass_and_can_be_reopened() {
        let mut flow = Flow::default();
        let mut pane = ready();
        pane.report
            .cards
            .iter_mut()
            .find(|card| card.id == "trust")
            .unwrap()
            .status = Status::NeedsAttention;
        flow.enter(Screen::Step(Step::Https));
        flow.skip(Step::Https, &mut pane);
        assert_eq!(flow.screen, Screen::Step(Step::Login));
        assert_eq!(flow.state(Step::Https, &pane), StepState::Skipped);
        assert_eq!(flow.evidence(Step::Https, &pane), StepState::NeedsAction);
        assert!(flow.can_open(Step::Https, &pane));
    }

    #[test]
    fn skipping_a_failed_command_keeps_the_step_reopenable() {
        let mut flow = Flow::default();
        let mut pane = ready();
        let step = Step::Https;
        pane.report
            .cards
            .iter_mut()
            .find(|card| card.id == step.id())
            .unwrap()
            .status = Status::NeedsAttention;
        flow.enter(Screen::Step(step));
        let failed = || RunOutcome {
            step,
            exit: CommandExit::Code(1),
            diagnosis: None,
        };
        flow.outcome = Some(failed());
        assert_eq!(flow.state(step, &pane), StepState::Failed);

        flow.skip(step, &mut pane);
        assert_eq!(flow.screen, Screen::Step(Step::Login));
        assert_eq!(flow.state(step, &pane), StepState::Skipped);
        assert!(flow.can_open(step, &pane));

        flow.enter(Screen::Step(step));
        flow.outcome = Some(failed());
        assert_eq!(flow.state(step, &pane), StepState::Failed);
    }

    #[test]
    fn native_dns_and_https_are_part_of_the_same_six_steps() {
        let mut flow = Flow::default();
        let mut pane = ready();
        pane.report = hack_desktop_core::setup_fixtures::load("native-unknown").unwrap();
        flow.enter(Screen::Step(Step::Domains));
        assert_eq!(flow.state(Step::Domains, &pane), StepState::Unchecked);
        assert!(
            Step::Domains
                .cards(&pane.report)
                .any(|card| card.id == "dns:sample")
        );
        assert!(
            Step::Https
                .cards(&pane.report)
                .any(|card| card.id == "trust:sample")
        );
        assert_eq!(Step::ALL.len(), 6);
    }

    #[test]
    fn completion_returns_to_the_first_regressed_check_until_the_user_skips_it() {
        let mut flow = Flow::default();
        let mut pane = ready();
        let mut login_refresh = pane.report.clone();
        login_refresh
            .cards
            .retain(|card| CheckScope::Login.includes(&card.id));
        login_refresh
            .cards
            .iter_mut()
            .find(|card| card.id == Step::Daemon.id())
            .unwrap()
            .status = Status::NeedsAttention;
        pane.report = login_refresh.with_prior(&pane.report, CheckScope::Login);

        assert_eq!(
            flow.next_screen(Step::Login, &pane),
            Screen::Step(Step::Daemon)
        );
        flow.enter(Screen::Done);
        flow.reconcile(&pane);
        assert_eq!(flow.screen, Screen::Step(Step::Daemon));

        pane.skipped.insert(Step::Daemon.id().into());
        assert_eq!(flow.next_screen(Step::Login, &pane), Screen::Done);
    }

    #[test]
    fn a_fresh_https_check_keeps_dns_failure_evidence_for_completion() {
        let mut flow = Flow::default();
        let mut pane = ready();
        let scope = Step::Https.check_scope();
        let mut https_report = pane.report.clone();
        https_report
            .cards
            .iter_mut()
            .find(|card| card.id == Step::Domains.id())
            .unwrap()
            .status = Status::NeedsAttention;
        https_report.cards.retain(|card| scope.includes(&card.id));
        pane.report = https_report.with_prior(&pane.report, scope);
        flow.enter(Screen::Step(Step::Https));
        assert!(flow.can_advance(&pane), "HTTPS passed");
        assert_eq!(
            flow.next_screen(Step::Https, &pane),
            Screen::Step(Step::Login)
        );

        let scope = Step::Login.check_scope();
        let mut login_report = pane.report.clone();
        login_report.cards.retain(|card| scope.includes(&card.id));
        pane.report = login_report.with_prior(&pane.report, scope);
        flow.enter(Screen::Step(Step::Login));
        assert!(flow.can_advance(&pane), "login passed");
        assert_eq!(
            flow.next_screen(Step::Login, &pane),
            Screen::Step(Step::Domains)
        );
    }

    #[test]
    fn a_registry_timeout_keeps_a_known_native_https_failure_unresolved_through_login() {
        let mut flow = Flow::default();
        let mut pane = ready();
        let native = hack_desktop_core::setup_fixtures::load("native-unknown").unwrap();
        let mut trust = native
            .cards
            .into_iter()
            .find(|card| card.id.starts_with("trust:"))
            .unwrap();
        trust.status = Status::NeedsAttention;
        let trust_id = trust.id.clone();
        pane.report.cards.push(trust);

        let scope = Step::Https.check_scope();
        let mut timed_out = ready().report;
        timed_out.cards.retain(|card| scope.includes(&card.id));
        timed_out.project_registry_read = false;
        pane.report = timed_out.clone().with_prior(&pane.report, scope);
        flow.enter(Screen::Step(Step::Https));
        assert_eq!(flow.state(Step::Https, &pane), StepState::Unchecked);
        assert_eq!(
            pane.report
                .cards
                .iter()
                .find(|card| card.id == trust_id)
                .unwrap()
                .status,
            Status::Unknown
        );

        let scope = Step::Login.check_scope();
        let mut login = ready().report;
        login.cards.retain(|card| scope.includes(&card.id));
        pane.report = login.with_prior(&pane.report, scope);
        flow.enter(Screen::Step(Step::Login));
        assert!(flow.can_advance(&pane));
        assert_eq!(
            flow.next_screen(Step::Login, &pane),
            Screen::Step(Step::Https)
        );

        // The same empty registry result can retire the card only once the
        // registry has answered successfully.
        timed_out.project_registry_read = true;
        pane.report = timed_out.with_prior(&pane.report, Step::Https.check_scope());
        assert_eq!(flow.next_screen(Step::Login, &pane), Screen::Done);
    }

    #[test]
    fn a_skip_that_includes_native_runtime_does_not_say_docker_only() {
        let mut flow = Flow::default();
        let mut pane = ready();
        pane.report
            .cards
            .iter_mut()
            .find(|card| card.id == Step::Docker.id())
            .unwrap()
            .status = Status::NeedsAttention;
        flow.enter(Screen::Step(Step::Docker));
        assert_eq!(flow.skip_label(Step::Docker, &pane), "I only use native");

        let native_only = hack_desktop_core::setup_fixtures::load("native-unknown").unwrap();
        pane.report.cards.extend(
            native_only
                .cards
                .iter()
                .filter(|card| card.id.starts_with("native:"))
                .cloned(),
        );
        assert_eq!(flow.skip_label(Step::Docker, &pane), "Skip for now");

        let native_card = pane
            .report
            .cards
            .iter_mut()
            .find(|card| card.id.starts_with("native:"))
            .unwrap();
        native_card.status = Status::Passed;
        assert_eq!(flow.skip_label(Step::Docker, &pane), "I only use native");
        flow.skip(Step::Docker, &mut pane);
        assert_eq!(flow.state(Step::Docker, &pane), StepState::Skipped);

        let native_card = pane
            .report
            .cards
            .iter_mut()
            .find(|card| card.id.starts_with("native:"))
            .unwrap();
        native_card.status = Status::Unknown;
        assert_eq!(flow.first_unresolved(&pane), Some(Step::Docker));
        flow.enter(Screen::Step(Step::Docker));

        pane.report = native_only;
        assert_eq!(flow.skip_label(Step::Docker, &pane), "Skip for now");
    }

    #[test]
    fn a_new_cli_version_discards_previous_steps_outside_the_scope() {
        let mut pane = ready();
        let mut cli_refresh = pane.report.clone();
        cli_refresh.cards.truncate(1);
        cli_refresh.cards[0].detail = "Hack 5.1.0".into();
        pane.report = cli_refresh.with_prior(&pane.report, CheckScope::Cli);
        assert!(pane.report.cli_ready());
        assert!(Step::Daemon.card(&pane.report).is_none());
    }

    #[test]
    fn unknown_dns_evidence_does_not_offer_a_fix() {
        let mut pane = ready();
        let card = pane
            .report
            .cards
            .iter_mut()
            .find(|card| card.id == Step::Domains.id())
            .unwrap();
        card.status = Status::Unknown;
        assert!(matches!(card.remedy, Remedy::Admin(_)));
        assert!(Step::Domains.remedy_card(&pane.report).is_none());
    }

    #[test]
    fn a_lost_cli_returns_to_the_first_screen_even_from_completion() {
        let mut flow = Flow::default();
        let mut pane = ready();
        flow.enter(Screen::Done);
        pane.report.cards[0].status = Status::Unknown;
        flow.reconcile(&pane);
        assert_eq!(flow.screen, Screen::Step(Step::Cli));
        assert!(!flow.can_advance(&pane));
    }
}
