//! Canned data for every state in `apps/desktop/DESIGN.md`, so each view can
//! be shown and tested without a daemon, Docker or a Hack home.
//!
//! Project and host names are placeholders.

use std::collections::BTreeMap;

use crate::models::{
    Autostart, AutostartFailures, Container, DaemonApiStatus, DoctorCheck, DoctorReport,
    InputDiagnostic, LogEntry, ProjectRow, ProjectRuntime, ProjectsPayload, RuntimeService,
};
use crate::source::{Snapshot, SourceError};
use crate::state::{Action, LocalContext};

/// Every designed state that can be shown with `--fixtures <name>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fixture {
    DaemonNotInstalled,
    DaemonStopped,
    DaemonStarting,
    DaemonIncompatible,
    DaemonStale,
    DaemonStaleUnit,
    DaemonUnknown,
    AlwaysOff,
    AlwaysOn,
    AlwaysPaused,
    AlwaysAttention,
    AlwaysGlobalPaused,
    AlwaysLogin,
    AlwaysNoLogin,
    AlwaysCommandFailed,
    // List states.
    Loading,
    Empty,
    DaemonDown,
    DaemonMismatch,
    EngineDown,
    Error,
    CliMissing,
    /// More projects than fit in the sidebar, and more services than fit
    /// in the detail pane (both scroll).
    ManyProjects,
    // Detail states (selected project).
    Stopped,
    Starting,
    Running,
    Degraded,
    Stopping,
    FailedStart,
    NeedsAttention,
    // Doctor pane.
    /// Findings across areas, machine and project scoped, one failed run.
    Doctor,
    /// Every check passed.
    DoctorClean,
    /// A project whose header links to its doctor findings.
    DoctorLink,
    /// No projects registered: the Doctor pane still shows machine checks.
    DoctorEmpty,
}

impl Fixture {
    pub const ALL: [Self; 34] = [
        Self::DaemonNotInstalled,
        Self::DaemonStopped,
        Self::DaemonStarting,
        Self::DaemonIncompatible,
        Self::DaemonStale,
        Self::DaemonStaleUnit,
        Self::DaemonUnknown,
        Self::AlwaysOff,
        Self::AlwaysOn,
        Self::AlwaysPaused,
        Self::AlwaysAttention,
        Self::AlwaysGlobalPaused,
        Self::AlwaysLogin,
        Self::AlwaysNoLogin,
        Self::AlwaysCommandFailed,
        Self::Loading,
        Self::Empty,
        Self::DaemonDown,
        Self::DaemonMismatch,
        Self::EngineDown,
        Self::Error,
        Self::CliMissing,
        Self::ManyProjects,
        Self::Stopped,
        Self::Starting,
        Self::Running,
        Self::Degraded,
        Self::Stopping,
        Self::FailedStart,
        Self::NeedsAttention,
        Self::Doctor,
        Self::DoctorClean,
        Self::DoctorLink,
        Self::DoctorEmpty,
    ];

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::DaemonNotInstalled => "daemon-not-installed",
            Self::DaemonStopped => "daemon-stopped",
            Self::DaemonStarting => "daemon-starting",
            Self::DaemonIncompatible => "daemon-incompatible",
            Self::DaemonStale => "daemon-stale",
            Self::DaemonStaleUnit => "daemon-stale-unit",
            Self::DaemonUnknown => "daemon-unknown",
            Self::AlwaysOff => "always-off",
            Self::AlwaysOn => "always-on",
            Self::AlwaysPaused => "always-paused",
            Self::AlwaysAttention => "always-attention",
            Self::AlwaysGlobalPaused => "always-global-paused",
            Self::AlwaysLogin => "always-login",
            Self::AlwaysNoLogin => "always-no-login",
            Self::AlwaysCommandFailed => "always-command-failed",
            Self::Loading => "loading",
            Self::Empty => "empty",
            Self::DaemonDown => "daemon-down",
            Self::DaemonMismatch => "daemon-mismatch",
            Self::EngineDown => "engine-down",
            Self::Error => "error",
            Self::CliMissing => "cli-missing",
            Self::ManyProjects => "many-projects",
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Degraded => "degraded",
            Self::Stopping => "stopping",
            Self::FailedStart => "failed-start",
            Self::NeedsAttention => "needs-attention",
            Self::Doctor => "doctor",
            Self::DoctorClean => "doctor-clean",
            Self::DoctorLink => "doctor-link",
            Self::DoctorEmpty => "doctor-empty",
        }
    }

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.name() == name)
    }
}

pub const CLI_VERSION: &str = "5.0.0";

fn container(state: &str, status: &str) -> Container {
    Container {
        id: None,
        name: None,
        state: state.into(),
        status: status.into(),
    }
}

fn svc(name: &str, c: Container) -> RuntimeService {
    RuntimeService {
        service: name.into(),
        containers: vec![c],
    }
}

fn storefront(services: Vec<RuntimeService>, status: &str) -> ProjectRow {
    let mut hosts = BTreeMap::new();
    hosts.insert("api".into(), vec!["api.storefront.hack".into()]);
    hosts.insert("web".into(), vec!["storefront.hack".into()]);
    ProjectRow {
        project_id: Some("p-storefront".into()),
        name: "storefront".into(),
        dev_host: Some("storefront.hack".into()),
        repo_root: Some("/work/storefront".into()),
        status: status.into(),
        runtime_status: Some(status.into()),
        kind: Some("registered".into()),
        defined_services: vec!["api".into(), "db".into(), "web".into(), "worker".into()],
        service_hosts: hosts,
        runtime: Some(ProjectRuntime {
            project: Some("storefront".into()),
            services,
        }),
        backend: Some("compose".into()),
        ..ProjectRow::default()
    }
}

fn all_up() -> Vec<RuntimeService> {
    vec![
        svc("api", container("running", "Up 2 hours (healthy)")),
        svc("db", container("running", "Up 2 hours")),
        svc("web", container("running", "Up 2 hours")),
        svc("worker", container("running", "Up 2 hours")),
    ]
}

fn simple(name: &str, status: &str, backend: &str, always_on: bool) -> ProjectRow {
    let up = status == "running";
    ProjectRow {
        project_id: Some(format!("p-{name}")),
        name: name.into(),
        dev_host: Some(format!("{name}.hack")),
        repo_root: Some(format!("/work/{name}")),
        status: if backend == "native" {
            "unavailable".into()
        } else {
            status.into()
        },
        // Native rows carry no Compose data; services come from native ps.
        defined_services: if backend == "native" {
            vec![]
        } else {
            vec!["app".into()]
        },
        runtime: (backend != "native").then(|| ProjectRuntime {
            project: Some(name.into()),
            services: if up {
                vec![svc("app", container("running", "Up 3 days"))]
            } else {
                vec![]
            },
        }),
        backend: (backend != "native").then(|| backend.into()),
        // Legacy project views refuse native projects with this diagnostic;
        // the source then reads native `hack ps`.
        input_diagnostic: (backend == "native").then(|| InputDiagnostic {
            code: crate::models::NATIVE_PROJECT_CODE.into(),
            message: "Native hack.project.json marks this project.".into(),
        }),
        native: (backend == "native").then(|| crate::models::NativePs {
            status: if up { "observed" } else { "not_started" }.into(),
            items: if up {
                vec![crate::models::NativePsItem {
                    service: "app".into(),
                    state: "running".into(),
                    ..Default::default()
                }]
            } else {
                vec![]
            },
        }),
        autostart: always_on.then(|| Autostart {
            enabled: Some(true),
            state: "on".into(),
            ..Autostart::default()
        }),
        ..ProjectRow::default()
    }
}

fn others() -> Vec<ProjectRow> {
    vec![
        simple("docs-site", "running", "native", true),
        simple("billing-api", "stopped", "compose", false),
        simple("notes", "stopped", "compose", false),
    ]
}

/// The projects payload for a fixture.
#[must_use]
pub fn project(f: Fixture) -> ProjectsPayload {
    let main = match f {
        Fixture::Stopped | Fixture::Starting => storefront(vec![], "stopped"),
        Fixture::Degraded => {
            let mut s = all_up();
            s[3] = svc("worker", container("exited", "Exited (1) 4 minutes ago"));
            storefront(s, "running")
        }
        Fixture::FailedStart => storefront(
            vec![
                svc("api", container("exited", "Exited (1) 20 seconds ago")),
                svc("db", container("exited", "Exited (0) 20 seconds ago")),
                svc("worker", container("exited", "Exited (2) 20 seconds ago")),
            ],
            "stopped",
        ),
        Fixture::NeedsAttention => {
            let mut r = storefront(vec![], "stopped");
            r.autostart = Some(Autostart {
                enabled: Some(true),
                state: "needs_attention".into(),
                max_failures: Some(3),
                paused_reason: None,
                failures: AutostartFailures {
                    count: Some(3),
                    last_at: Some("2026-01-01T09:00:00Z".into()),
                    failed_services: Some(vec!["api".into()]),
                    last_error_code: Some("E_STARTUP_INCOMPLETE".into()),
                },
            });
            r
        }
        Fixture::EngineDown => {
            let mut r = storefront(vec![], "unknown");
            r.runtime = None;
            r
        }
        _ => storefront(all_up(), "running"),
    };
    let mut main = main;
    if f.name().starts_with("always-") {
        main.autostart = Some(Autostart {
            enabled: Some(f != Fixture::AlwaysOff),
            state: match f {
                Fixture::AlwaysOff => "off",
                Fixture::AlwaysPaused => "paused",
                Fixture::AlwaysAttention => "needs_attention",
                Fixture::AlwaysLogin => "starting",
                _ => "on",
            }
            .into(),
            paused_reason: (f == Fixture::AlwaysPaused).then(|| "manual_stop".into()),
            max_failures: Some(3),
            failures: AutostartFailures {
                count: Some(if f == Fixture::AlwaysAttention { 3 } else { 0 }),
                failed_services: Some(if f == Fixture::AlwaysAttention {
                    vec!["api".into(), "worker".into()]
                } else {
                    vec![]
                }),
                ..Default::default()
            },
        });
    }
    let mut projects = vec![main];
    projects.extend(others());
    if f == Fixture::NeedsAttention {
        // Unrelated: a second way to need attention.
        projects[3].input_diagnostic = Some(InputDiagnostic {
            code: "E_CONFIG_INVALID".into(),
            message: "hack.config.json is not valid JSON".into(),
        });
    }
    if f == Fixture::EngineDown {
        for p in &mut projects {
            p.status = "unknown".into();
            p.runtime = None;
            if p.native.is_some() {
                p.native = Some(crate::models::NativePs {
                    status: "runtime_not_running".into(),
                    items: vec![],
                });
            }
        }
    }
    ProjectsPayload {
        generated_at: Some("2026-01-01T09:00:00Z".into()),
        detail_level: None,
        runtime_ok: Some(f != Fixture::EngineDown),
        runtime_error: (f == Fixture::EngineDown)
            .then(|| "Cannot connect to the Docker daemon".into()),
        projects,
        autostart_global: f
            .name()
            .starts_with("always-")
            .then(|| crate::models::AutostartGlobal {
                paused: Some(f == Fixture::AlwaysGlobalPaused),
                service_ready: Some(f != Fixture::AlwaysNoLogin),
                login_run: Some(crate::models::LoginRun {
                    in_progress: Some(f == Fixture::AlwaysLogin),
                    pending: Some(vec!["storefront".into(), "notes".into()]),
                    started: Some(vec!["docs-site".into(), "billing-api".into()]),
                    failed: Some(vec![]),
                    ..Default::default()
                }),
            }),
    }
}

/// The project a fixture selects in the detail pane.
#[must_use]
pub fn selected(_f: Fixture) -> &'static str {
    "storefront"
}

/// The app-side context (in-flight action, last failure) for a fixture.
#[must_use]
pub fn local(f: Fixture) -> LocalContext {
    match f {
        Fixture::Starting => LocalContext {
            in_flight: Some(Action::Start),
            last_failed: vec![],
        },
        Fixture::Stopping => LocalContext {
            in_flight: Some(Action::Stop),
            last_failed: vec![],
        },
        _ => LocalContext::default(),
    }
}

fn doctor(f: Fixture) -> DoctorReport {
    let mut checks = vec![
        DoctorCheck {
            id: "docker daemon".into(),
            status: if f == Fixture::EngineDown {
                "error"
            } else {
                "ok"
            }
            .into(),
            detail: String::new(),
        },
        DoctorCheck {
            id: "caddy local ca".into(),
            status: "warn".into(),
            detail: "Local CA is not trusted by the system".into(),
        },
    ];
    if f == Fixture::NeedsAttention {
        checks.push(DoctorCheck {
            id: "project config".into(),
            status: "error".into(),
            detail: "notes: hack.config.json is not valid JSON".into(),
        });
    }
    DoctorReport {
        checks,
        summary: vec![],
    }
}

/// A complete snapshot for a fixture, as the live source would produce it.
///
/// # Errors
/// Returns the error a live source would report for `Error` and `CliMissing`.
pub fn snapshot(f: Fixture) -> Result<Snapshot, SourceError> {
    match f {
        Fixture::Loading => return Err(SourceError::Pending),
        Fixture::CliMissing => return Err(SourceError::CliMissing),
        Fixture::Error => {
            return Err(SourceError::Cli {
                code: "E_UNEXPECTED".into(),
                message: "projects registry could not be read".into(),
                failed: vec![],
            });
        }
        _ => {}
    }
    let mut projects = project(f);
    if matches!(f, Fixture::Empty | Fixture::DoctorEmpty) {
        projects.projects.clear();
    }
    if f == Fixture::ManyProjects {
        // The selected project also has more services than fit (scrolling).
        if let Some(main) = projects.projects.first_mut() {
            for i in 1..=24 {
                let name = format!("job-{i:02}");
                main.defined_services.push(name.clone());
                if let Some(rt) = main.runtime.as_mut() {
                    rt.services
                        .push(svc(&name, container("running", "Up 2 hours")));
                }
            }
        }
        for i in 1..=40 {
            let status = if i % 3 == 0 { "running" } else { "stopped" };
            projects
                .projects
                .push(simple(&format!("project-{i:02}"), status, "compose", false));
        }
    }
    let daemon = match f {
        Fixture::DaemonDown => None,
        Fixture::DaemonMismatch => Some(DaemonApiStatus {
            status: "ok".into(),
            version: "4.3.0".into(),
            ..DaemonApiStatus::default()
        }),
        _ => Some(DaemonApiStatus {
            status: "ok".into(),
            version: CLI_VERSION.into(),
            ..DaemonApiStatus::default()
        }),
    };
    Ok(Snapshot {
        cli_version: CLI_VERSION.into(),
        projects,
        daemon,
        doctor: Some(doctor(f)),
    })
}

/// A short log tail for the selected project.
#[must_use]
pub fn log_tail(f: Fixture) -> Vec<LogEntry> {
    let line = |service: &str, level: &str, message: &str| LogEntry {
        service: Some(service.into()),
        message: message.into(),
        stream: Some("stdout".into()),
        timestamp: Some("09:00:01".into()),
        level: Some(level.into()),
        truncated: None,
    };
    match f {
        Fixture::Stopped
        | Fixture::Loading
        | Fixture::Empty
        | Fixture::CliMissing
        | Fixture::EngineDown => vec![],
        Fixture::FailedStart => vec![
            line(
                "db",
                "info",
                "database system is ready to accept connections",
            ),
            line("api", "error", "Error: connect ECONNREFUSED 127.0.0.1:6379"),
            line("worker", "error", "fatal: missing required env QUEUE_URL"),
        ],
        Fixture::Degraded => vec![
            line("api", "info", "GET /health 200 2ms"),
            line("worker", "error", "panic: queue connection lost"),
            line("web", "info", "ready on :3000"),
        ],
        _ => vec![
            line("db", "info", "checkpoint complete"),
            line("api", "info", "GET /health 200 2ms"),
            line("web", "info", "ready on :3000"),
            line("worker", "info", "processed 12 jobs"),
        ],
    }
}

/// Pure fixture observation: no process or socket access.
#[must_use]
pub fn daemon_observation(f: Fixture) -> crate::daemon_state::Observation {
    use crate::daemon_state::Observation;
    use serde_json::json;
    if f == Fixture::CliMissing {
        return Observation {
            cli_missing: true,
            ..Default::default()
        };
    }
    if f == Fixture::DaemonUnknown {
        return Observation {
            cli_version: Some(CLI_VERSION.into()),
            error: Some("Could not read daemon status".into()),
            ..Default::default()
        };
    }
    let status = match f {
        Fixture::DaemonDown | Fixture::DaemonNotInstalled | Fixture::AlwaysNoLogin => {
            json!({"status":"stopped","running":false,"service":{"installed":false}})
        }
        Fixture::DaemonStopped => {
            json!({"status":"stopped","running":false,"service":{"installed":true}})
        }
        Fixture::DaemonStarting => {
            json!({"status":"starting","running":false,"issue":"Waiting for status socket"})
        }
        Fixture::DaemonIncompatible => {
            json!({"status":"incompatible","running":true,"issue":"API incompatible; restart with current CLI"})
        }
        Fixture::DaemonStale => {
            json!({"status":"stale","running":false,"stale":true,"stale_reason":"pid_not_running"})
        }
        Fixture::DaemonStaleUnit => {
            json!({"status":"running","running":true,"service":{"installed":true,"unit_stale":true,"unit_stale_reason":"binary_missing","next_step":"hack daemon install"}})
        }
        _ => json!({"status":"running","running":true,"service":{"installed":true}}),
    };
    Observation {
        cli_version: Some(CLI_VERSION.into()),
        status: Some(crate::models::DaemonStatus::from_value(status).expect("fixture status")),
        socket_version: Some(
            if f == Fixture::DaemonMismatch {
                "4.3.0"
            } else {
                CLI_VERSION
            }
            .into(),
        ),
        ..Default::default()
    }
}

/// Fixtures that open the Doctor pane instead of a project.
#[must_use]
pub fn opens_doctor(f: Fixture) -> bool {
    matches!(
        f,
        Fixture::Doctor | Fixture::DoctorClean | Fixture::DoctorEmpty
    )
}

/// Fixtures that load doctor results (and may still show a project).
#[must_use]
pub fn loads_doctor(f: Fixture) -> bool {
    opens_doctor(f) || f == Fixture::DoctorLink
}

/// Canned doctor runs (machine run first, then per project).
#[must_use]
pub fn doctor_runs(f: Fixture) -> Vec<crate::doctor::DoctorRun> {
    use crate::doctor::DoctorRun;
    let c = |id: &str, status: &str, detail: &str| DoctorCheck {
        id: id.into(),
        status: status.into(),
        detail: detail.into(),
    };
    let report = |checks: Vec<DoctorCheck>| {
        Ok(DoctorReport {
            checks,
            summary: vec![],
        })
    };
    let ok_machine = || {
        vec![
            c("bun", "ok", ""),
            c("docker", "ok", ""),
            c("docker compose", "ok", ""),
            c("docker daemon", "ok", ""),
            c("daemon", "ok", ""),
            c("caddy local ca", "ok", ""),
            c("resolver:hack", "ok", ""),
            c("dnsmasq:53", "ok", ""),
        ]
    };
    if f == Fixture::DoctorEmpty {
        let mut machine = ok_machine();
        machine[5] = c(
            "caddy local ca",
            "warn",
            "Local CA is not trusted by the system",
        );
        return vec![DoctorRun::machine(report(machine))];
    }
    if f == Fixture::DoctorClean {
        return vec![
            DoctorRun::machine(report(ok_machine())),
            DoctorRun::project(
                "storefront",
                "/work/storefront",
                report(vec![
                    c(
                        "project",
                        "ok",
                        "Found .hack/ (or legacy .dev/) at /work/storefront/.hack",
                    ),
                    c("env key", "ok", ""),
                ]),
            ),
        ];
    }
    let machine = vec![
        c("bun", "ok", ""),
        c("docker", "ok", ""),
        c("docker daemon", "ok", ""),
        c(
            "daemon",
            "warn",
            "hackd is running but incompatible with this CLI version",
        ),
        c(
            "caddy local ca",
            "warn",
            "Local CA is not trusted by the system",
        ),
        c(
            "resolver:hack",
            "error",
            "No resolver file routes .hack to the local DNS server",
        ),
        c("dnsmasq:53", "ok", ""),
        c(
            "brand new check",
            "warn",
            "A check this app does not know yet",
        ),
    ];
    vec![
        DoctorRun::machine(report(machine)),
        DoctorRun::project(
            "storefront",
            "/work/storefront",
            report(vec![
                c(
                    "project",
                    "ok",
                    "Found .hack/ (or legacy .dev/) at /work/storefront/.hack",
                ),
                c("env key", "error", "The env key file is missing"),
                c(
                    "caddy local ca",
                    "warn",
                    "Local CA is not trusted by the system",
                ),
                c(
                    "generated files",
                    "warn",
                    "A generated file is tracked by git",
                ),
            ]),
        ),
        DoctorRun::project(
            "billing-api",
            "/work/billing-api",
            report(vec![
                c(
                    "project",
                    "ok",
                    "Found .hack/ (or legacy .dev/) at /work/billing-api/.hack",
                ),
                c("env key", "error", "The env key file is missing"),
            ]),
        ),
        DoctorRun::project(
            "notes",
            "/work/notes",
            Err("hack did not answer within 60s".into()),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_fixtures_aggregate_as_designed() {
        let v = crate::doctor::aggregate(&doctor_runs(Fixture::Doctor));
        // daemon, caddy ca, resolver, unknown (machine); env key, generated files (project).
        assert_eq!(v.attention_count(), 6);
        assert_eq!(v.failed_runs.len(), 1);
        let clean = crate::doctor::aggregate(&doctor_runs(Fixture::DoctorClean));
        assert_eq!(clean.attention_count(), 0);
        assert!(clean.passed >= 8);
        assert!(opens_doctor(Fixture::Doctor) && !opens_doctor(Fixture::Running));
    }

    #[test]
    fn names_round_trip() {
        for f in Fixture::ALL {
            assert_eq!(Fixture::parse(f.name()), Some(f));
        }
        assert_eq!(Fixture::parse("nope"), None);
    }

    #[test]
    fn every_fixture_has_a_snapshot_or_designed_error() {
        for f in Fixture::ALL {
            match (f, snapshot(f)) {
                (Fixture::Loading, Err(SourceError::Pending))
                | (Fixture::CliMissing, Err(SourceError::CliMissing))
                | (Fixture::Error, Err(SourceError::Cli { .. })) => {}
                (_, Ok(s)) => assert_eq!(
                    s.projects.projects.is_empty(),
                    matches!(f, Fixture::Empty | Fixture::DoctorEmpty)
                ),
                (f, other) => panic!("{f:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn fixtures_hold_no_private_paths() {
        for f in Fixture::ALL {
            let json = serde_json::to_string(&project(f)).unwrap();
            assert!(!json.contains("/home/") && !json.contains("/Users/"));
        }
    }
}
