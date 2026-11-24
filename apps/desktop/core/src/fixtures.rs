//! Canned data for every state in `apps/desktop/DESIGN.md`, so each view can
//! be shown and tested without a daemon, Docker or a Hack home.
//!
//! Project and host names are placeholders.

use std::collections::BTreeMap;

use crate::models::{
    Autostart, AutostartFailures, BranchRuntime, Container, DaemonApiStatus, DoctorCheck,
    DoctorReport, InputDiagnostic, LogEntry, ProjectRow, ProjectRuntime, ProjectsPayload,
    RuntimeService,
};
use crate::source::{Snapshot, SourceError};
use crate::state::{Action, LocalContext};

/// Every designed state that can be shown with `--fixtures <name>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fixture {
    EnvLoading,
    EnvError,
    EnvNormal,
    EnvMissing,
    EnvLocked,
    EnvEmpty,
    EnvOverlays,
    EnvRunning,
    EnvLong,
    EnvEdit,
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
    Remotes,
    Files,
    Degraded,
    Stopping,
    FailedStart,
    NeedsAttention,
    /// The selected project's base instance is stopped while two branch
    /// instances (`hack up --branch <name>`) run.
    Branches,
    CopiesEmpty,
    CopiesError,
    CopiesLoading,
    CopiesPartial,
    CopiesReady,
    // Doctor pane.
    /// Findings across areas, machine and project scoped, one failed run.
    Doctor,
    /// Every check passed.
    DoctorClean,
    /// A project whose header links to its doctor findings.
    DoctorLink,
    /// No projects registered: the Doctor pane still shows machine checks.
    DoctorEmpty,
    BannerDns,
    BannersSheet,
    DoctorHealth,
    DoctorFixAll,
    ErrorsSheet,
    // hackd pane (HACK-2288 item 6).
    /// hackd running, a login run under way, always-on projects in every
    /// state the summary shows.
    Hackd,
    /// hackd stopped with a login service that is out of date.
    HackdOff,
    // Upgrade pane (HACK-2289).
    /// A ready upgrade check, with a snapshot to restore.
    Upgrade,
    /// A check with a blocker and a check that could not run.
    UpgradeBlocked,
    /// Running, with CPU and memory per service and one emulated service.
    Usage,
}

impl Fixture {
    pub const ALL: [Self; 47] = [
        Self::EnvLoading,
        Self::EnvError,
        Self::EnvNormal,
        Self::EnvMissing,
        Self::EnvLocked,
        Self::EnvEmpty,
        Self::EnvOverlays,
        Self::EnvRunning,
        Self::EnvLong,
        Self::EnvEdit,
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
        Self::Remotes,
        Self::Files,
        Self::Degraded,
        Self::Stopping,
        Self::FailedStart,
        Self::NeedsAttention,
        Self::Branches,
        Self::CopiesEmpty,
        Self::CopiesError,
        Self::CopiesLoading,
        Self::CopiesPartial,
        Self::CopiesReady,
        Self::Doctor,
        Self::DoctorClean,
        Self::DoctorLink,
        Self::DoctorEmpty,
        Self::BannerDns,
        Self::BannersSheet,
        Self::DoctorHealth,
        Self::DoctorFixAll,
        Self::ErrorsSheet,
        Self::Hackd,
        Self::HackdOff,
        Self::Upgrade,
        Self::UpgradeBlocked,
        Self::Usage,
    ];

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::EnvLoading => "env-loading",
            Self::EnvError => "env-error",
            Self::EnvNormal => "env-normal",
            Self::EnvMissing => "env-missing",
            Self::EnvLocked => "env-locked",
            Self::EnvEmpty => "env-empty",
            Self::EnvOverlays => "env-overlays",
            Self::EnvRunning => "env-running",
            Self::EnvLong => "env-long",
            Self::EnvEdit => "env-edit",
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
            Self::Remotes => "remotes",
            Self::Files => "files",
            Self::Degraded => "degraded",
            Self::Stopping => "stopping",
            Self::FailedStart => "failed-start",
            Self::NeedsAttention => "needs-attention",
            Self::Branches => "branches",
            Self::CopiesEmpty => "copies-empty",
            Self::CopiesError => "copies-error",
            Self::CopiesLoading => "copies-loading",
            Self::CopiesPartial => "copies-partial",
            Self::CopiesReady => "copies-ready",
            Self::Doctor => "doctor",
            Self::DoctorClean => "doctor-clean",
            Self::DoctorLink => "doctor-link",
            Self::DoctorEmpty => "doctor-empty",
            Self::BannerDns => "h17-app-banner-dns",
            Self::BannersSheet => "h18-banners-sheet",
            Self::DoctorHealth => "h19-doctor",
            Self::DoctorFixAll => "h20-doctor-fix-all",
            Self::ErrorsSheet => "h25-errors-sheet",
            Self::Hackd => "hackd",
            Self::HackdOff => "hackd-off",
            Self::Upgrade => "upgrade",
            Self::UpgradeBlocked => "upgrade-blocked",
            Self::Usage => "usage",
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
        labels: BTreeMap::new(),
        ..Container::default()
    }
}

/// A branch-instance container routed at `caddy` (comma-separated hosts).
fn routed(state: &str, status: &str, caddy: &str) -> Container {
    let mut c = container(state, status);
    c.labels.insert("caddy".into(), caddy.into());
    c
}

/// The registered linked worktree of storefront (placeholder path).
const STOREFRONT_WORKTREE: &str = "/work/storefront-wt/fix-login";

/// Compose's working directory for a branch instance: `fix-login` was
/// started from the registered linked worktree, others from the checkout.
fn checkout_dir(branch: &str) -> String {
    if branch == "fix-login" {
        format!("{STOREFRONT_WORKTREE}/.hack")
    } else {
        "/work/storefront/.hack".into()
    }
}

/// A running branch instance of storefront with web and api routes.
fn running_branch(branch: &str) -> BranchRuntime {
    let mut api = routed(
        "running",
        "Up 2 hours (healthy)",
        &format!("api.{branch}.storefront.hack"),
    );
    api.name = Some(format!("storefront--{branch}-api-1"));
    api.image = Some("storefront-api:dev".into());
    api.labels
        .insert("caddy.reverse_proxy".into(), "{{upstreams 3000}}".into());
    api.labels.insert(
        "com.docker.compose.project".into(),
        format!("storefront--{branch}"),
    );
    api.mounts.push(crate::models::ContainerMount {
        source: checkout_dir(branch).trim_end_matches("/.hack").into(),
        destination: "/app".into(),
        kind: "bind".into(),
        name: None,
    });
    BranchRuntime {
        owner: None,
        branch: branch.into(),
        runtime: ProjectRuntime {
            project: Some(format!("storefront--{branch}")),
            working_dir: Some(checkout_dir(branch)),
            services: vec![
                svc("api", api),
                svc("db", container("running", "Up 20 minutes")),
                svc(
                    "web",
                    routed(
                        "running",
                        "Up 20 minutes",
                        &format!("{branch}.storefront.hack"),
                    ),
                ),
            ],
        },
    }
}

/// A branch instance whose api exited non-zero.
fn failed_branch(branch: &str) -> BranchRuntime {
    BranchRuntime {
        owner: None,
        branch: branch.into(),
        runtime: ProjectRuntime {
            project: Some(format!("storefront--{branch}")),
            working_dir: Some(checkout_dir(branch)),
            services: vec![
                svc(
                    "api",
                    routed(
                        "exited",
                        "Exited (1) 5 minutes ago",
                        &format!("api.{branch}.storefront.hack"),
                    ),
                ),
                svc("db", container("exited", "Exited (0) 5 minutes ago")),
            ],
        },
    }
}

/// A running branch instance whose routes are all service subdomains
/// (nothing is routed on the bare instance host).
fn subdomain_branch(branch: &str) -> BranchRuntime {
    let routed_at = |service: &str| {
        svc(
            service,
            routed(
                "running",
                "Up 1 hour",
                &format!("{service}.{branch}.storefront.hack"),
            ),
        )
    };
    BranchRuntime {
        owner: None,
        branch: branch.into(),
        runtime: ProjectRuntime {
            project: Some(format!("storefront--{branch}")),
            working_dir: Some(checkout_dir(branch)),
            services: vec![
                routed_at("core"),
                routed_at("search"),
                routed_at("temporal-server"),
            ],
        },
    }
}

/// Every container of each runtime carries its runtime's working directory,
/// as Compose reports it.
fn owned(mut branches: Vec<BranchRuntime>) -> Vec<BranchRuntime> {
    for b in &mut branches {
        let dir = b.runtime.working_dir.clone();
        for c in b
            .runtime
            .services
            .iter_mut()
            .flat_map(|s| &mut s.containers)
        {
            c.working_dir.clone_from(&dir);
        }
    }
    branches
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
            working_dir: None,
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
            working_dir: None,
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
            enabled: true,
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
                enabled: true,
                state: "needs_attention".into(),
                paused_reason: None,
                failures: AutostartFailures {
                    count: 3,
                    last_at: Some("2026-01-01T09:00:00Z".into()),
                    failed_services: vec!["api".into()],
                    last_error_code: Some("E_STARTUP_INCOMPLETE".into()),
                },
                max_failures: Some(3),
                ..Autostart::default()
            });
            r
        }
        Fixture::EngineDown => {
            let mut r = storefront(vec![], "unknown");
            r.runtime = None;
            r
        }
        Fixture::Running | Fixture::Files => {
            let mut r = storefront(all_up(), "running");
            r.branch_runtime = owned(vec![
                running_branch("feature-search"),
                failed_branch("fix-login"),
            ]);
            r.worktrees = vec![crate::models::Worktree {
                path: Some(STOREFRONT_WORKTREE.into()),
                branch: Some("fix-login".into()),
            }];
            r
        }
        Fixture::Remotes => {
            let mut row = storefront(all_up(), "running");
            row.remotes = serde_json::from_str(r#"[
              {"service":"redis","target":"local","state":"declared","probe":"not checked",
               "address":{"kind":"service","service":"cache","port":6379}},
              {"service":"database","target":"staging","state":"declared","probe":"not checked",
               "address":{"kind":"env_ref","name":"STAGING_DB_HOST","port":5432}},
              {"service":"search","target":"preview","state":"tunnel not started by this version",
               "probe":"not checked","address":{"kind":"hostname","hostname":"search.example.invalid","port":443}}
            ]"#).expect("remote descriptors fixture");
            row
        }
        Fixture::Branches => {
            let mut r = storefront(vec![], "stopped");
            r.branch_runtime = owned(vec![
                running_branch("feature-search"),
                running_branch("fix-login"),
                subdomain_branch("release-2"),
            ]);
            r.worktrees = vec![crate::models::Worktree {
                path: Some(STOREFRONT_WORKTREE.into()),
                branch: Some("fix-login".into()),
            }];
            r
        }
        _ => storefront(all_up(), "running"),
    };
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
        autostart_global: None,
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
            fix: None,
        },
        DoctorCheck {
            id: "caddy local ca".into(),
            status: "warn".into(),
            detail: "Local CA is not trusted by the system".into(),
            fix: None,
        },
    ];
    if f == Fixture::NeedsAttention {
        checks.push(DoctorCheck {
            id: "project config".into(),
            status: "error".into(),
            detail: "notes: hack.config.json is not valid JSON".into(),
            fix: None,
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
    if matches!(f, Fixture::Hackd | Fixture::HackdOff) {
        always_on_fixture(&mut projects);
    }
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
        daemon_compatible: daemon.as_ref().map(|d| d.version == CLI_VERSION),
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

/// Fixtures that open the Doctor pane instead of a project.
#[must_use]
pub fn opens_doctor(f: Fixture) -> bool {
    matches!(
        f,
        Fixture::Doctor | Fixture::DoctorClean | Fixture::DoctorEmpty
    )
}

/// Fixtures that load per-service usage.
#[must_use]
pub fn loads_usage(f: Fixture) -> bool {
    f == Fixture::Usage
}

/// `hack usage --json --by-service` as a fixture reports it: the
/// storefront's services (no value for `worker` from one sample) and one
/// branch instance.
///
/// # Errors
/// Never for a fixture; the signature matches the live source.
pub fn service_usage(_f: Fixture) -> Result<crate::usage::UsageReport, String> {
    const MIB: u64 = 1024 * 1024;
    crate::usage::UsageReport::from_value(serde_json::json!({
        "schema": crate::usage::USAGE_SCHEMA, "project": "storefront", "backend": "compose",
        "services": [
            {"composeProject": "storefront", "service": "api", "containers": 1, "cpuPercent": 3.2, "memUsedBytes": 212 * MIB, "memLimitBytes": 2048 * MIB},
            {"composeProject": "storefront", "service": "db", "containers": 1, "cpuPercent": 1.4, "memUsedBytes": 388 * MIB, "memLimitBytes": null},
            {"composeProject": "storefront", "service": "web", "containers": 1, "cpuPercent": 0.6, "memUsedBytes": 96 * MIB, "memLimitBytes": null},
            {"composeProject": "storefront", "service": "worker", "containers": 1, "cpuPercent": 87.5, "memUsedBytes": 640 * MIB, "memLimitBytes": null},
            {"composeProject": "storefront--feature-search", "service": "api", "containers": 1, "cpuPercent": 2.0, "memUsedBytes": 180 * MIB, "memLimitBytes": null}
        ]
    }))
}

/// The services `hack ps --json` marks emulated in a fixture.
#[must_use]
pub fn emulated_services(f: Fixture) -> std::collections::BTreeSet<String> {
    if f == Fixture::Usage {
        std::collections::BTreeSet::from(["worker".to_owned()])
    } else {
        std::collections::BTreeSet::new()
    }
}

/// Fixtures that open the Upgrade pane.
#[must_use]
pub fn opens_upgrade(f: Fixture) -> bool {
    matches!(f, Fixture::Upgrade | Fixture::UpgradeBlocked)
}

const UPGRADE_CHECK: &str = include_str!("../tests/fixtures/upgrade/check-v2.json");
const FIXTURE_SNAPSHOT: &str = "20260101T090000Z-fixture";

/// `hack upgrade check --json` as a fixture reports it.
///
/// # Errors
/// Never for a fixture; the signature matches the live source.
pub fn upgrade_check(f: Fixture) -> Result<crate::upgrade::CheckReport, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(UPGRADE_CHECK).map_err(|e| e.to_string())?;
    if f == Fixture::UpgradeBlocked {
        v["data"]["ready"] = false.into();
        v["data"]["blockers"] = serde_json::json!([
            {"scope": "alpha", "id": "env-key", "summary": "The env key for alpha is missing; values cannot be read."}
        ]);
        v["data"]["incomplete"] = serde_json::json!([
            {"scope": "machine", "id": "docker", "summary": "Docker did not answer; the engine checks could not run."}
        ]);
    }
    crate::upgrade::CheckReport::parse(&v.to_string())
}

/// `hack upgrade review --json` as a fixture reports it.
#[must_use]
pub fn upgrade_review() -> crate::upgrade::Review {
    serde_json::from_value(serde_json::json!({
        "status": "review",
        "checkouts": [{"scope": "alpha", "project": "alpha", "root": "/work/alpha", "findings": [
            {"id": "env-format", "status": "warn", "summary": "Legacy .env layers; hack env migrate converts them.", "kind": "manual", "command": "hack env migrate", "action": "Check the converted layers before committing them."}
        ]}],
        "reasons": [{"id": "env-format", "reason": "Converting env layers rewrites files the team commits; review the change first."}]
    }))
    .unwrap_or_default()
}

/// `hack upgrade snapshot --json` as a fixture reports it.
#[must_use]
pub fn upgrade_snapshot() -> crate::upgrade::Snapshot {
    crate::upgrade::Snapshot {
        status: "created".into(),
        id: Some(FIXTURE_SNAPSHOT.into()),
        manifest_path: Some(format!(
            "/work/.hack/upgrade/snapshots/{FIXTURE_SNAPSHOT}/manifest.json"
        )),
        files: vec![
            crate::upgrade::SnapshotFile {
                path: "/work/.hack/hack.config.json".into(),
                label: "global: hack.config.json".into(),
                reason: None,
            },
            crate::upgrade::SnapshotFile {
                path: "/work/.hack/projects.json".into(),
                label: "global: projects.json".into(),
                reason: None,
            },
        ],
        complete: true,
        ..crate::upgrade::Snapshot::default()
    }
}

/// The snapshot listing as a fixture reports it.
#[must_use]
pub fn upgrade_snapshots() -> crate::upgrade::SnapshotList {
    crate::upgrade::SnapshotList {
        status: "choose".into(),
        snapshots: vec![crate::upgrade::SnapshotEntry {
            id: FIXTURE_SNAPSHOT.into(),
            created_at: Some("2026-01-01T09:00:00.000Z".into()),
            purpose: Some("hack upgrade snapshot".into()),
            files: 2,
            manifest_path: format!(
                "/work/.hack/upgrade/snapshots/{FIXTURE_SNAPSHOT}/manifest.json"
            ),
        }],
    }
}

/// A restore as a fixture reports it: one file back, one left as it is.
#[must_use]
pub fn upgrade_restore() -> crate::upgrade::Rollback {
    serde_json::from_value(serde_json::json!({
        "status": "incomplete",
        "results": [
            {"path": "/work/.hack/hack.config.json", "label": "global: hack.config.json", "status": "restored"},
            {"path": "/work/.hack/projects.json", "label": "global: projects.json", "status": "conflict",
             "message": "changed since the snapshot; left as it is"}
        ]
    }))
    .unwrap_or_default()
}

/// Fixtures that open the hackd pane.
#[must_use]
pub fn opens_hackd(f: Fixture) -> bool {
    matches!(f, Fixture::Hackd | Fixture::HackdOff)
}

/// `hack daemon status --json` as a fixture reports it.
#[must_use]
pub fn daemon_status(f: Fixture) -> Option<crate::models::DaemonStatus> {
    let json = match f {
        Fixture::HackdOff => serde_json::json!({
            "status": "stopped", "running": false,
            "service": {"manager": "launchd", "available": true, "installed": true,
                "summary": "the unit's program no longer exists",
                "next_step": "hack daemon install"}
        }),
        Fixture::DaemonDown => serde_json::json!({
            "status": "stopped", "running": false,
            "service": {"manager": "launchd", "available": true, "installed": false}
        }),
        Fixture::Loading | Fixture::CliMissing => return None,
        _ => serde_json::json!({
            "status": "running", "running": true, "api_ok": true, "pid": 4242,
            "version": "5.0.0", "cli_version": "5.0.0",
            "service": {"manager": "launchd", "available": true, "installed": true, "enabled": true}
        }),
    };
    serde_json::from_value(json).ok()
}

/// Always-on in every state the hackd pane summarises, and a login run
/// under way.
fn always_on_fixture(payload: &mut ProjectsPayload) {
    use crate::models::{AutostartGlobal, AutostartLoginRun, AutostartResult};
    for p in &mut payload.projects {
        p.autostart = match p.name.as_str() {
            "docs-site" => Some(Autostart {
                enabled: true,
                state: "on".into(),
                ..Autostart::default()
            }),
            "storefront" => Some(Autostart {
                enabled: true,
                state: "on".into(),
                last_result: Some(AutostartResult {
                    status: "skipped".into(),
                    reason: Some("engine_timeout".into()),
                    at: Some("2026-01-01T08:58:00Z".into()),
                }),
                ..Autostart::default()
            }),
            "notes" => Some(Autostart {
                enabled: true,
                state: "paused".into(),
                paused_reason: Some("manual_stop".into()),
                paused: true,
                ..Autostart::default()
            }),
            "billing-api" => Some(Autostart {
                enabled: true,
                state: "needs_attention".into(),
                failures: AutostartFailures {
                    count: 3,
                    last_at: Some("2026-01-01T08:59:00Z".into()),
                    failed_services: vec!["api".into()],
                    last_error_code: Some("start_failed".into()),
                },
                max_failures: Some(3),
                ..Autostart::default()
            }),
            _ => None,
        };
    }
    payload.autostart_global = Some(AutostartGlobal {
        paused: false,
        login_run: AutostartLoginRun {
            in_progress: true,
            started_at: Some("2026-01-01T08:57:00Z".into()),
            pending: vec!["storefront-id".into()],
            started: vec!["docs-site-id".into()],
            failed: vec!["billing-api-id".into()],
            waiting_for_engine: false,
        },
        service_ready: true,
    });
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
        fix: None,
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
