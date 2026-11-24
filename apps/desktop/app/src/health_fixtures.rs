//! Screenshot inputs for the post-setup surfaces. No fix runs on fixture data.

use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Context, IntoElement, ParentElement, Styled, Window, div, prelude::*, px,
};
use hack_desktop_core::{
    doctor::DoctorRun,
    execution::ExecutionContext,
    fixtures::Fixture,
    models::{DoctorCheck, DoctorCheckFix, DoctorReport},
    setup::{Card, Remedy, Report, SafeAction, Status},
    terminal::{CommandAvailability, CommandControl, CommandControlSize, CommandSpec},
    upgrade::ReleaseUpdate,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, primary_button},
    icons::Glyph,
    tokens::{radius, space, text},
};

use crate::{
    doctor_view::{Mark, Pane},
    follow_up_view::{self, Action, Notice},
    health_model::{FollowUpKind as Kind, Repair, RepairQueue, machine_repair, setup_card},
    view::HackApp,
};

const INSTALL_GUIDE: &str = hack_desktop_core::setup::SHARED_HOME_DOC;
const DOCKER_GUIDE: &str = "https://docs.docker.com/desktop/";

pub fn is_health_frame(frame: Fixture) -> bool {
    matches!(
        frame,
        Fixture::BannerDns
            | Fixture::BannersSheet
            | Fixture::DoctorHealth
            | Fixture::DoctorFixAll
            | Fixture::ErrorsSheet
    )
}

pub fn window_options(frame: Option<Fixture>) -> gpui_kit::WindowOptions {
    let mut options = crate::window_options();
    if frame.is_some_and(is_health_frame)
        && let Some(gpui_kit::WindowBounds::Windowed(bounds)) = &mut options.window_bounds
    {
        bounds.size = gpui_kit::size(px(1280.), px(800.));
    }
    options
}

pub struct HealthFixture {
    pub(crate) banner: Option<Notice>,
}

pub fn open(app: &mut HackApp, frame: Fixture, window: &mut Window, cx: &mut Context<HackApp>) {
    if !is_health_frame(frame) {
        return;
    }
    let mut report = report();
    let running = frame == Fixture::DoctorFixAll;
    let checked_at = Instant::now()
        .checked_sub(Duration::from_secs(120))
        .unwrap_or_else(Instant::now);
    app.health.fixture = Some(HealthFixture { banner: None });
    let generation = app.setup.begin();
    app.setup.finish(generation, report.clone());
    app.setup.skipped.insert("login".into());
    app.health.signals.update = Some(ReleaseUpdate {
        latest: "5.1.0".into(),
        upgrade_command: Some(vec![
            "brew".into(),
            "upgrade".into(),
            "hack-dance/tap/hack".into(),
        ]),
    });
    app.health.observed_setup = Some((checked_at, report.clone()));
    match frame {
        Fixture::BannerDns => {
            app.health.fixture.as_mut().unwrap().banner = Some(dns_notice(&report));
            #[cfg(hack_terminal)]
            {
                app.ensure_panel(window, cx);
                app.toggle_panel(cx);
            }
        }
        Fixture::BannersSheet => app.pane = Pane::BannersSheet,
        Fixture::ErrorsSheet => app.pane = Pane::ErrorsSheet,
        Fixture::DoctorHealth | Fixture::DoctorFixAll => {
            app.pane = Pane::Doctor;
            let targets = app.doctor_target_keys();
            let runs = doctor_runs();
            let generation = app.doctor.begin(targets.as_deref());
            app.doctor
                .finish(generation, &runs, targets.as_deref(), checked_at);
            app.health.runs = runs;
            if running {
                let mut queue = RepairQueue::new(crate::doctor_view::repairs(app), true)
                    .expect("fixture repairs");
                let fixed = queue.current().target.clone();
                queue.index = 1;
                app.health.confirmed.push(fixed);
                if let Some(dns) = report.cards.iter_mut().find(|card| card.id == "routing") {
                    dns.status = Status::Passed;
                    dns.detail = "All 8 DNS pieces are set up".into();
                }
                app.health.observed_setup = Some((Instant::now(), report));
                crate::health_commands::show_fixture(app, queue.command(), window, cx);
                app.health.queue = Some(queue);
            }
        }
        _ => {}
    }
}

fn report() -> Report {
    let card = |id: &str, status, detail: &str, remedy| Card {
        id: id.into(),
        title: id.into(),
        status,
        detail: detail.into(),
        remedy,
    };
    let doc = |url: &str| Remedy::Doc(url.into());
    Report {
        cards: vec![
            card("cli", Status::Passed, "Hack 5.0.0", doc(INSTALL_GUIDE)),
            card(
                "routing",
                Status::NeedsAttention,
                "5 of 8 DNS pieces set up · *.hack.local doesn’t open",
                Remedy::Admin(vec!["global".into(), "install".into()]),
            ),
            card(
                "daemon",
                Status::Passed,
                "hackd 5.0.0 is running",
                Remedy::Run(SafeAction::StartDaemon),
            ),
            card(
                "docker",
                Status::Passed,
                "Docker is running",
                doc(DOCKER_GUIDE),
            ),
            card(
                "trust",
                Status::NeedsAttention,
                "Browsers may warn on HTTPS project URLs",
                Remedy::Admin(vec!["global".into(), "trust".into()]),
            ),
            card(
                "login",
                Status::NeedsAttention,
                "Skipped during setup",
                Remedy::Run(SafeAction::InstallDaemon),
            ),
        ],
        cli_program: Some("/usr/bin/hack".into()),
        context: ExecutionContext::from_values(&[("HOME".into(), "/home/test-user".into())]).ok(),
        force_cli_gate: false,
    }
}

fn doctor_runs() -> Vec<DoctorRun> {
    let passed = |id: &str| DoctorCheck {
        id: id.into(),
        status: "ok".into(),
        ..DoctorCheck::default()
    };
    vec![
        DoctorRun::machine(Ok(DoctorReport {
            checks: [
                "bun",
                "docker",
                "docker compose",
                "docker daemon",
                "daemon",
                "caddy",
                "resolver:hack",
                "dnsmasq:53",
                "coredns forwarding",
                "proxy ports",
                "proxy network",
                "global files",
                "mkcert",
            ]
            .map(passed)
            .to_vec(),
            summary: vec![],
        })),
        DoctorRun::project(
            "storefront",
            "/work/storefront",
            Ok(DoctorReport {
                checks: vec![
                    DoctorCheck {
                        detail: "Found .hack/ (or legacy .dev/) at /work/storefront/.hack".into(),
                        ..passed("project")
                    },
                    DoctorCheck {
                        id: "hack gitignore".into(),
                        status: "warn".into(),
                        detail:
                            ".hack/.gitignore is missing. Run 'hack doctor --fix' to create it."
                                .into(),
                        fix: Some(DoctorCheckFix {
                            kind: "safe".into(),
                            args: [
                                "doctor",
                                "--fix",
                                "--only",
                                "hack gitignore",
                                "--yes",
                                "--json",
                            ]
                            .map(str::to_owned)
                            .to_vec(),
                        }),
                    },
                ],
                summary: vec![],
            }),
        ),
    ]
}

fn fixture_command(id: &str, label: &str, args: &[&str]) -> CommandControl {
    let spec = report()
        .command(args.iter().map(|arg| (*arg).into()).collect())
        .expect("fixture argv");
    CommandControl {
        id: id.into(),
        label: label.into(),
        title: "Terminal".into(),
        availability: CommandAvailability::Ready(spec),
        size: CommandControlSize::Compact,
        cwd: None,
        expects_password: false,
    }
}

fn dns_notice(report: &Report) -> Notice {
    let repair = setup_card(report, "routing")
        .and_then(|c| machine_repair(c, report))
        .expect("fixture repair");
    Notice::new(
        Kind::Routing,
        Mark::Warning,
        "Local domains partly working",
        "*.hack.local doesn’t open.",
        Action::Run(repair),
    )
}

pub fn banners(ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    use Action::{Copy, None, ReviewRelease, Run, Setup, Show, Switch};
    let report = report();
    let dns = dns_notice(&report);
    let mut running = Notice::new(
        Kind::Routing,
        Mark::Running,
        "Fixing local domains",
        "Running in the terminal below.",
        Show,
    );
    running.command = dns.command.clone();
    // A different kind gives both examples stable, distinct control IDs.
    running.kind = Kind::CouldNotCheck;
    let mut copy = fixture_command("sheet-sudo", "hack global install", &["global", "install"]);
    if let CommandAvailability::Ready(spec) = copy.availability {
        copy.availability = CommandAvailability::CopyOnly(spec);
    }
    let rows = [
        (
            "Hack service not running",
            Notice::new(
                Kind::DaemonDown,
                Mark::Error,
                "Hack service isn’t running",
                "Projects and URLs won’t update.",
                Run(Repair {
                    target: crate::health_model::RepairTarget::Setup("daemon".into()),
                    control: fixture_command(
                        "sheet-daemon",
                        "hack daemon start",
                        &["daemon", "start"],
                    ),
                }),
            ),
        ),
        (
            "Wrong CLI version",
            Notice::new(
                Kind::WrongCli,
                Mark::Warning,
                "Hack 4.3.1 can’t run this app",
                "hack-next 5.0.0-next.24 is installed.",
                Switch(std::option::Option::None),
            ),
        ),
        (
            "No permission",
            Notice::new(
                Kind::Permission,
                Mark::Warning,
                "Local domains need an admin",
                "This account can’t run sudo.",
                Copy(copy),
            ),
        ),
        ("Local domains degraded", dns),
        ("Local domains · fix running", running),
        (
            "Setup not finished",
            Notice::new(
                Kind::Setup,
                Mark::Unknown,
                "Setup isn’t finished",
                "HTTPS and start at login were skipped.",
                Setup,
            ),
        ),
        (
            "Update available",
            Notice::new(
                Kind::Update,
                Mark::Unknown,
                "Hack 5.1.0 is available",
                "You have 5.0.0.",
                ReviewRelease,
            ),
        ),
        (
            "Offline",
            Notice::new(
                Kind::Offline,
                Mark::Unknown,
                "You’re offline",
                "Local projects still work. Update checks wait until you’re back.",
                None,
            ),
        ),
    ];
    sheet("Follow-up banners", ui)
        .children(rows.iter().map(|(label, notice)| {
            div()
                .flex()
                .flex_col()
                .gap(space::S2)
                .child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(ui.p.text_muted)
                        .child(*label),
                )
                .child(follow_up_view::banner(notice, false, ui, cx))
        }))
        .into_any_element()
}

enum ExampleAction {
    Command(CommandControl),
    Doc(&'static str, &'static str),
    Switch,
}

struct Example {
    label: &'static str,
    title: &'static str,
    mark: Mark,
    summary: &'static str,
    note: Option<&'static str>,
    action: ExampleAction,
}

pub fn errors(app: &HackApp, ui: &Ui, window: &Window, cx: &mut Context<HackApp>) -> AnyElement {
    use ExampleAction::{Command, Doc, Switch};
    let command = |id: &str, label: &str, args: &[&str]| Command(fixture_command(id, label, args));
    let dns = fixture_command("errors-dns", "hack global install", &["global", "install"]);
    let mut copy = dns.clone();
    copy.id = "errors-dns-admin".into();
    if let CommandAvailability::Ready(spec) = copy.availability {
        copy.availability = CommandAvailability::CopyOnly(spec);
    }
    let cards = [
        Example {
            label: "Daemon down",
            title: "Start the Hack service",
            mark: Mark::Warning,
            summary: "hackd isn’t running.",
            note: None,
            action: command("errors-daemon", "hack daemon start", &["daemon", "start"]),
        },
        Example {
            label: "Wrong CLI version",
            title: "Install Hack 5",
            mark: Mark::Warning,
            summary: "Hack 4.3.1 is installed. This app needs Hack 5.",
            note: None,
            action: Switch,
        },
        Example {
            label: "No CLI found",
            title: "Install Hack 5",
            mark: Mark::Error,
            summary: "No Hack CLI on this Mac.",
            note: Some("The installer is a script you review first."),
            action: Doc("Open install guide", INSTALL_GUIDE),
        },
        Example {
            label: "Docker not installed",
            title: "Connect Docker",
            mark: Mark::Error,
            summary: "Docker isn’t installed.",
            note: None,
            action: Doc("Get Docker Desktop", DOCKER_GUIDE),
        },
        Example {
            label: "Docker installed, not running",
            title: "Connect Docker",
            mark: Mark::Warning,
            summary: "Docker Desktop is installed but not running.",
            note: None,
            action: Command(CommandControl {
                id: "errors-docker".into(),
                label: "open -a Docker".into(),
                title: "Terminal".into(),
                availability: CommandAvailability::Ready(CommandSpec {
                    program: "/usr/bin/open".into(),
                    args: vec!["-a".into(), "Docker".into()],
                }),
                size: CommandControlSize::Compact,
                cwd: None,
                expects_password: false,
            }),
        },
        Example {
            label: "DNS partly broken",
            title: "Set up local domains",
            mark: Mark::Warning,
            summary: "5 of 8 DNS pieces are set up.",
            note: None,
            action: Command(dns),
        },
        Example {
            label: "No permission",
            title: "Set up local domains",
            mark: Mark::Warning,
            summary: "This account can’t make admin changes.",
            note: None,
            action: Command(copy),
        },
        Example {
            label: "hackd newer than the CLI",
            title: "Start the Hack service",
            mark: Mark::Warning,
            summary: "hackd 5.1.0 is newer than CLI 5.0.0.",
            note: Some("Update the CLI to match the service."),
            action: command("errors-update", "hack update", &["update"]),
        },
        Example {
            label: "Shared with another install",
            title: "Start the Hack service",
            mark: Mark::Unknown,
            summary: "This hackd belongs to Hack 4.3.1.",
            note: Some("Use that install or give each its own home."),
            action: Doc("Open guide", INSTALL_GUIDE),
        },
    ];
    sheet("Error and bad-setup states", ui)
        .children(cards.chunks(3).map(|row| {
            div()
                .flex()
                .gap(space::S5)
                .flex_1()
                .children(row.iter().map(|card| example(app, card, ui, window, cx)))
        }))
        .into_any_element()
}

fn sheet(title: &'static str, ui: &Ui) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(title)
        .size_full()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(space::S5)
        .p(space::S7)
        .child(
            div()
                .type_step(text::BODY_STRONG)
                .text_color(ui.p.text_primary)
                .child(title),
        )
}

fn example(
    app: &HackApp,
    card: &Example,
    ui: &Ui,
    window: &Window,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let action = match &card.action {
        ExampleAction::Command(command) => {
            let mut command = command.clone();
            command.size = CommandControlSize::Standard;
            crate::health_commands::render(app, command, None, false, ui, window, cx)
        }
        ExampleAction::Doc(label, url) => {
            let url = *url;
            let button = if card.mark == Mark::Error {
                primary_button(card.label, Glyph::ExternalLink, *label, ui)
            } else {
                action_button(card.label, Glyph::ExternalLink, *label, true, ui)
            };
            button
                .self_start()
                .on_click(cx.listener(move |_, _, _, cx| cx.open_url(url)))
                .into_any_element()
        }
        ExampleAction::Switch => primary_button(
            card.label,
            Glyph::Restart,
            "Use hack-next 5.0.0-next.24",
            ui,
        )
        .self_start()
        .on_click(cx.listener(|this, _, _, cx| this.open_setup(cx)))
        .into_any_element(),
    };
    div()
        .flex_1()
        .min_w_0()
        .min_h(px(192.))
        .rounded(radius::PANEL)
        .hairline(ui.p.border_strong)
        .p(space::S7)
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(
            div()
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(ui.p.text_muted)
                .child(card.label),
        )
        .child(div().type_step(text::HEADLINE).child(card.title))
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .type_step(text::BODY)
                .child(card.mark.icon(ui))
                .child(card.summary),
        )
        .children(card.note.map(|note| {
            div()
                .pl(space::S8)
                .type_step(text::SMALL)
                .text_color(ui.p.text_secondary)
                .child(note)
        }))
        .child(action)
        .into_any_element()
}
