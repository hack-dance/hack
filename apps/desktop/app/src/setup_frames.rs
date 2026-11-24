//! Mock observations for capturing setup screens with the native renderer.

use std::time::Instant;

use hack_desktop_core::cli_choice::{Channel, Install};
use hack_desktop_core::execution::ExecutionContext;
use hack_desktop_core::setup::{Report, Status};
use hack_desktop_core::setup_fixtures;
use hack_desktop_core::terminal::CommandExit;

use crate::setup_flow::{RunOutcome, Screen, Step, StepState};
use crate::view::HackApp;

#[derive(Default)]
pub(crate) struct Overlay {
    pub alternate_cli: Option<(Install, &'static str)>,
    pub state: Option<StepState>,
    pub copy: Option<(&'static str, Option<&'static str>)>,
    pub dns: Option<usize>,
    pub meta: Option<&'static str>,
}

pub(crate) const NAMES: [&str; 19] = [
    "h01-welcome",
    "h02-cli-wrong-version",
    "h03-step-checking",
    "h04-hackd-needs-action",
    "h05-hackd-running",
    "h06-hackd-passed",
    "h07-docker-missing",
    "h08-dns-needs-action",
    "h09-dns-details",
    "h10-dns-password",
    "h11-dns-failed",
    "h12-dns-succeeded",
    "h13-drawer-closed-last-run",
    "h14-https-skipped",
    "h15-login-optional",
    "h16-all-done",
    "h21-no-permission",
    "h23-check-unknown",
    "h24-not-connected",
];

pub(crate) fn load(app: &mut HackApp, name: &str) {
    let mut report = setup_fixtures::load("ready").expect("ready fixture");
    let partial = setup_fixtures::load("partial").expect("partial fixture");
    let target = match &name[..3] {
        "h01" => {
            app.show_setup_now(report);
            return;
        }
        "h02" => Step::Cli,
        "h03" | "h04" | "h05" | "h06" | "h23" => Step::Daemon,
        "h07" => Step::Docker,
        "h08" | "h09" | "h10" | "h11" | "h12" | "h13" | "h21" => Step::Domains,
        "h14" => Step::Https,
        "h15" | "h16" => Step::Login,
        "h24" => return,
        _ => unreachable!("unsupported setup frame"),
    };
    let mut overlay = Overlay::default();
    match &name[..3] {
        "h02" => {
            let cli = card(&mut report, Step::Cli);
            cli.status = Status::VersionMismatch;
            cli.detail = "Hack 4.3.1 is installed. This app needs Hack 5.".into();
            report.force_cli_gate = true;
            overlay.alternate_cli = Some((
                Install {
                    name: "hack-next".into(),
                    channel: Channel::Prerelease,
                    path: "/work/user/.hack-next/bin/hack-next".into(),
                },
                "5.0.0-next.24",
            ));
            overlay.copy = Some((
                "Hack 4.3.1 is installed. This app needs Hack 5.",
                Some("Found hack-next 5.0.0-next.24. It runs beside 4.3.1 and keeps its own home."),
            ));
        }
        "h04" | "h05" => report = partial,
        "h07" => {
            card(&mut report, Step::Docker).status = Status::NeedsAttention;
            overlay.state = Some(StepState::Failed);
            overlay.meta = Some("Not installed");
            overlay.copy = Some((
                "Docker isn’t installed on this Mac.",
                Some(
                    "Install Docker Desktop, open it once, then come back. Hack checks again when you do.",
                ),
            ));
        }
        "h08" | "h09" | "h10" | "h11" | "h13" | "h21" => {
            card(&mut report, Step::Domains).status = Status::NeedsAttention;
            overlay.dns = Some(5);
            overlay.copy = match &name[..3] {
                "h08" | "h09" => Some((
                    "5 of 8 DNS pieces are set up.",
                    Some("*.hack.gy and *.hack.local don’t open yet."),
                )),
                "h21" => Some((
                    "This Mac account can’t make admin changes.",
                    Some("Ask an admin to run this command, or sign in as one."),
                )),
                _ => None,
            };
        }
        "h12" => {
            overlay.dns = Some(8);
            overlay.copy = Some(("All 8 DNS pieces are set up.", None));
        }
        "h14" | "h15" => {
            card(&mut report, Step::Https).status = Status::NeedsAttention;
            app.setup.skipped.insert(Step::Https.id().into());
            if name.starts_with("h15") {
                *card(&mut report, Step::Login) = Step::Login.card(&partial).unwrap().clone();
            }
        }
        "h16" => {
            card(&mut report, Step::Login).status = Status::NeedsAttention;
            app.setup.skipped.insert(Step::Login.id().into());
        }
        "h23" => {
            let daemon = card(&mut report, Step::Daemon);
            daemon.status = Status::Unknown;
            daemon.detail =
                "hack daemon status --json\nTimed out after 5 s\nSocket did not answer".into();
            overlay.copy = Some((
                "Couldn’t check the Hack service.",
                Some("The check timed out after 5 seconds."),
            ));
        }
        _ => {}
    }
    if matches!(&name[..3], "h04" | "h08" | "h09" | "h14") {
        // Exercise the live Run control against a harmless checked executable.
        // The source itself still supplies only synthetic setup observations.
        report.cli_program = Some("/usr/bin/true".into());
        report.context = Some(
            ExecutionContext::from_values(&[("HOME".into(), "/".into())])
                .expect("fixture execution context"),
        );
        app.live = true;
    }
    app.show_setup_now(report);
    for step in Step::ALL.into_iter().take(target.index() + 1) {
        app.setup_flow.enter(Screen::Step(step));
    }
    match &name[..3] {
        "h03" => {
            app.setup.begin();
        }
        "h05" => app.setup.action_busy = true,
        "h06" | "h12" => app.setup_flow.advance_at = Some(Instant::now()),
        "h09" | "h21" | "h23" => app.setup_flow.details_open = true,
        "h10" => overlay.state = Some(StepState::Password),
        "h16" => app.setup_flow.enter(Screen::Done),
        _ => {}
    }
    if name.starts_with("h21") {
        overlay.meta = Some("Needs admin");
        app.setup.result = Some(
            "sudo refused administrator access.\nhack global install exited with code 1.".into(),
        );
    }
    if matches!(&name[..3], "h11" | "h13" | "h21") {
        app.setup_flow.outcome = Some(RunOutcome {
            step: target,
            exit: CommandExit::Code(1),
            diagnosis: Some("Another app is using port 53. Stop it, then try again.".into()),
        });
    }
    app.setup_flow.fixture = Some(overlay);
}

fn card(report: &mut Report, step: Step) -> &mut hack_desktop_core::setup::Card {
    report
        .cards
        .iter_mut()
        .find(|card| card.id == step.id())
        .expect("fixture step")
}

pub(crate) fn dns_pieces() -> impl Iterator<Item = (&'static str, &'static str)> {
    [
        ("Local DNS server answers", "dnsmasq:53"),
        ("Containers can find project names", "coredns forwarding"),
        ("Mac sends *.hack to Hack", "resolver:hack"),
        ("Hack answers for *.hack", "dnsmasq.conf:hack"),
        ("Mac sends *.hack.gy to Hack", "resolver:hack.gy"),
        ("Hack answers for *.hack.gy", "dnsmasq.conf:hack.gy"),
        ("Mac sends *.hack.local to Hack", "resolver:hack.local"),
        ("Hack answers for *.hack.local", "dnsmasq.conf:hack.local"),
    ]
    .into_iter()
}
