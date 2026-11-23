//! The setup itinerary and its presentation state. Machine evidence stays in Report.

use std::time::{Duration, Instant};

use hack_desktop_core::setup::{Card, Pane, Remedy, Report, Status};
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

    pub(crate) fn remedy(self, report: &Report) -> Option<&Remedy> {
        self.cards(report)
            .find(|card| card.status != Status::Passed && card.status != Status::Blocked)
            .map(|card| &card.remedy)
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
        if pane.skipped.contains(step.id()) {
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

    pub fn next_screen(step: Step) -> Screen {
        step.next().map_or(Screen::Done, Screen::Step)
    }

    pub fn skip(&mut self, step: Step, pane: &mut Pane) {
        if self.can_skip(step, pane) {
            pane.skipped.insert(step.id().into());
            for card in step.cards(&pane.report) {
                if card.status != Status::Passed {
                    pane.skipped.insert(card.id.clone());
                }
            }
            self.enter(Self::next_screen(step));
        }
    }

    pub fn can_open(&self, step: Step, pane: &Pane) -> bool {
        matches!(
            self.state(step, pane),
            StepState::Passed | StepState::Skipped
        )
    }

    /// Do not leave later steps or completion on screen if a fresh read
    /// loses the required CLI.
    pub fn reconcile(&mut self, pane: &Pane) {
        if !pane.report.cli_ready()
            && !matches!(self.screen, Screen::Welcome | Screen::Step(Step::Cli))
        {
            self.enter(Screen::Step(Step::Cli));
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
        assert_eq!(Flow::next_screen(Step::Cli), Screen::Step(Step::Daemon));
        assert_eq!(Flow::next_screen(Step::Daemon), Screen::Step(Step::Docker));
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
