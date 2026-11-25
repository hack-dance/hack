//! View-model state machines for the project list and the detail pane.
//!
//! Pure: no I/O, no clock. The app feeds events in and renders `view()`.
//!
//! List rules (DESIGN.md, "Project list"):
//! - A failed refresh keeps the last good snapshot and marks it stale; with
//!   no snapshot yet it shows the error state.
//! - Banners stack: daemon off, daemon version mismatch, engine down, stale.
//! - One action per instance at a time; the row's state shows it.
//!
//! Instances: a project's base instance and each of its branch instances
//! (`hack up --branch <name>`, reported in `branch_runtime`) are separate
//! [`InstanceKey`]s with their own state, selection and in-flight action.

use std::collections::HashMap;

use crate::models::{
    LifecycleResult, ProjectRow, ProjectRuntime, StoppedContainerExecution, Worktree,
};
pub use crate::source::UpdateSide;
use crate::source::{ActionOutcome, DaemonRecovery, ServiceActionError, Snapshot, SourceError};
use crate::state::{self, Action, LocalContext, ProjectState, ServiceStopEvidence, ServiceView};

/// One runnable instance: a project's base instance (`branch: None`) or one
/// of its branch instances.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize)]
pub struct InstanceKey {
    pub project: String,
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
}

impl InstanceKey {
    /// The base instance of a project.
    #[must_use]
    pub fn project(name: impl Into<String>) -> Self {
        Self {
            project: name.into(),
            branch: None,
            checkout: None,
        }
    }

    /// A branch instance of a project.
    #[must_use]
    pub fn branch(name: impl Into<String>, branch: impl Into<String>) -> Self {
        Self {
            project: name.into(),
            branch: Some(branch.into()),
            checkout: None,
        }
    }

    /// A branch instance tied to its owning checkout.
    #[must_use]
    pub fn branch_at(
        name: impl Into<String>,
        branch: impl Into<String>,
        checkout: Option<String>,
    ) -> Self {
        Self {
            checkout,
            ..Self::branch(name, branch)
        }
    }

    #[must_use]
    pub fn is_main(&self) -> bool {
        self.branch.is_none() && self.checkout.is_none()
    }
}

impl std::fmt::Display for InstanceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.branch {
            None => write!(f, "{}", self.project),
            Some(b) => write!(f, "{} · {b}", self.project),
        }
    }
}

/// Navigation intent for the service detail pane, scoped to an instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceDestination {
    Info,
    Stats,
    Logs,
    Terminal,
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSelection {
    pub instance: InstanceKey,
    pub name: String,
    pub destination: ServiceDestination,
}

/// The checkout and runtime a live reader or terminal panel was opened for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeTarget {
    pub root: String,
    pub native: bool,
    pub compose_project: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "banner", rename_all = "snake_case")]
pub enum Banner {
    DaemonOff,
    /// hackd runs but the CLI cannot use it; `update` names the side to
    /// update (only [`UpdateSide::Daemon`] offers "Restart hackd").
    DaemonMismatch {
        daemon: String,
        cli: String,
        update: UpdateSide,
    },
    DaemonReadFailed {
        error: String,
    },
    /// The hackd here belongs to another Hack install that shares this home
    /// (named in the message). No start or restart is offered.
    SharedHome {
        message: String,
    },
    EngineDown {
        error: String,
    },
    Stale {
        error: String,
    },
}

impl Banner {
    /// A mismatch banner for these versions, with the side to update.
    #[must_use]
    pub fn mismatch(daemon: &str, cli: &str) -> Self {
        Self::DaemonMismatch {
            daemon: daemon.to_owned(),
            cli: cli.to_owned(),
            update: UpdateSide::for_versions(daemon, cli),
        }
    }

    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::DaemonOff => {
                "hackd is off or unreachable: run `hack daemon start` to read project status".into()
            }
            Self::DaemonMismatch { daemon, cli, .. } => crate::source::mismatch_text(daemon, cli),
            Self::EngineDown { error } => format!("Docker not reachable: {error}"),
            Self::DaemonReadFailed { error } => error.clone(),
            Self::SharedHome { message } => message.clone(),
            Self::Stale { error } => format!("Showing last known state: {error}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Phase {
    Loading,
    CliMissing,
    Error { code: String, message: String },
    Empty,
    Ready,
}

/// A project in the sidebar: its base instance plus its branch instances.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Row {
    /// The base instance.
    pub key: InstanceKey,
    pub name: String,
    pub root: Option<String>,
    pub url: Option<String>,
    pub running_services: usize,
    /// The base instance's state.
    pub state: ProjectState,
    pub always_on: bool,
    /// The base instance is selected.
    pub selected: bool,
    /// Branch instances, sorted by branch.
    pub branches: Vec<BranchRow>,
    pub unaddressed_worktrees: Vec<Worktree>,
}

/// One branch instance under its project's row.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BranchRow {
    pub key: InstanceKey,
    pub branch: String,
    pub state: ProjectState,
    pub url: Option<String>,
    pub selected: bool,
    pub checkout: Option<String>,
    pub worktree: bool,
    /// True when there is no runtime and the engine listing was successful.
    pub not_started: bool,
    pub running_services: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ListView {
    pub phase: Phase,
    pub banners: Vec<Banner>,
    pub running: Vec<Row>,
    pub stopped: Vec<Row>,
    pub doctor_count: usize,
    /// Doctor results exist in this snapshot. Until then the Doctor row is
    /// unknown (grey), never "no findings" (green).
    pub doctor_known: bool,
    pub cli_version: Option<String>,
    /// Counts by state for the status bar; unknown is never "stopped".
    pub counts: Counts,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Counts {
    /// Active instances, base and branch.
    pub running: usize,
    /// Projects in the stopped group whose base instance is not unknown.
    pub stopped: usize,
    /// Projects in the stopped group whose base instance is unknown.
    pub unknown: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DetailView {
    pub key: InstanceKey,
    /// The project name (also for a branch instance).
    pub name: String,
    /// The branch instance shown, `None` for the base instance.
    pub branch: Option<String>,
    pub state: ProjectState,
    pub backend: String,
    pub url: Option<String>,
    pub always_on: bool,
    /// The always-on line under the header (read-only), when this instance
    /// is the one its marker names.
    pub always_on_note: Option<(crate::machine::Tone, String)>,
    pub actions: Vec<Action>,
    pub busy: bool,
    pub services: Vec<ServiceView>,
    #[serde(skip)]
    pub runtime_addressable: bool,
    pub remotes: Vec<crate::models::RemoteStatus>,
    /// Services to offer a shell in: the running services of the last read
    /// that reported this instance's runtime. A failed read, a read with the
    /// engine down or a row without runtime keeps the previous list, so the
    /// new-tab menu never loses its shells while a refresh is slow or
    /// failing; only a good read that reports a service stopped drops it.
    pub shells: Vec<String>,
    /// `shells` comes from an earlier read than the one shown, or the last
    /// read failed: the services may have changed since.
    pub shells_stale: bool,
    pub last_error: Option<String>,
    /// Why actions are limited (native projects in v0).
    pub note: Option<String>,
}

/// A branch instance whose checkout is not one this project registered (or
/// is not reported): its actions would run against the wrong code, so the
/// app offers none.
pub const UNKNOWN_CHECKOUT_NOTE: &str = "The checkout that started this branch instance is not one this project registered, so the app does not run actions on it. Run them from that checkout: hack up / down / restart --branch <name>.";

/// v0 scope: native projects are view-only. Native `restart` (and authored
/// `down`/`restart`) stay in the foreground and refuse `--json`; native
/// `up --json` is detached, but the app waits for one contract (design R2b).
pub const NATIVE_ACTIONS_NOTE: &str = "Native projects are view-only in this preview: start, stop or restart them in a terminal with HACK_RUNTIME_BACKEND=native hack up / down / restart.";

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Refreshed(Result<Snapshot, SourceError>),
    /// Select a project's base instance.
    Select(String),
    /// Select an instance (base or branch).
    SelectInstance(InstanceKey),
    ActionStarted {
        key: InstanceKey,
        action: Action,
    },
    ActionFinished {
        key: InstanceKey,
        action: Action,
        result: Result<ActionOutcome, SourceError>,
    },
}

/// Identity of a read request, captured before any I/O starts.
#[derive(Debug, Clone, Copy)]
pub struct RefreshToken {
    sequence: u64,
    action_epoch: u64,
}

#[derive(Debug, Default)]
pub struct AppModel {
    snapshot: Option<Snapshot>,
    last_error: Option<SourceError>,
    selected: Option<InstanceKey>,
    selected_service: Option<ServiceSelection>,
    local: HashMap<InstanceKey, LocalContext>,
    service_actions: HashMap<InstanceKey, String>,
    action_errors: HashMap<InstanceKey, String>,
    loaded_once: bool,
    refresh_sequence: u64,
    applied_sequence: u64,
    action_epoch: u64,
    /// Per instance, the running services of the last read that reported
    /// its runtime, and whether that was an earlier read than the current
    /// snapshot. See [`DetailView::shells`].
    shells: HashMap<InstanceKey, (Vec<String>, bool)>,
    /// Bumped by [`AppModel::source_changed`]: work started under an earlier
    /// CLI carries an older value and is not applied.
    source_epoch: u64,
}

/// The running services a read reports for a row, `None` when it does not
/// report them. Native rows come from native `ps`, whatever Docker's state,
/// when it observed the services (or confirmed the project not started).
/// A Compose row needs a reachable engine and either its runtime, or a
/// runtime the read confirmed absent (`runtime: null` with
/// `runtime_status: "stopped"`: no shells). An unknown or unavailable
/// runtime is not reported.
fn reported_shells(s: &Snapshot, row: &ProjectRow) -> Option<Vec<String>> {
    let running = |row: &ProjectRow| {
        state::services(row)
            .into_iter()
            .filter(|v| v.running)
            .map(|v| v.name)
            .collect()
    };
    if row.is_native() {
        // Not read yet in this snapshot: whatever it holds is an earlier
        // read's, so the shells stay as last reported (and marked so).
        if row.native_pending {
            return None;
        }
        // As `state::native_state` reads it: only an observation that
        // establishes service state replaces the list. `runtime_busy` and
        // the other non-observations return no items without meaning the
        // services stopped.
        return match row.native.as_ref().map(|n| n.status.as_str()) {
            Some("observed" | "runtime_degraded") => Some(running(row)),
            Some("not_started") => Some(Vec::new()),
            _ => None,
        };
    }
    if s.projects.engine_down() {
        return None;
    }
    if row.runtime.is_some() {
        return Some(running(row));
    }
    (row.runtime_status.as_deref() == Some("stopped")).then(Vec::new)
}

fn branch_keys(p: &ProjectRow) -> Vec<InstanceKey> {
    let observed = p
        .branch_runtime
        .iter()
        .map(|br| InstanceKey::branch_at(&p.name, &br.branch, p.branch_owner(br)));
    let configured = p
        .branch_copies
        .iter()
        .filter(|copy| {
            copy.branch.is_some()
                || copy.compose_project.is_some()
                || copy.compose_project_unresolved
        })
        .map(|copy| InstanceKey {
            project: p.name.clone(),
            branch: copy.branch.clone(),
            checkout: Some(copy.checkout.root.clone()),
        });
    let mut keys: Vec<_> = observed.chain(configured).collect();
    keys.sort_by(|a, b| a.branch.cmp(&b.branch).then(a.checkout.cmp(&b.checkout)));
    keys.dedup();
    keys
}

/// Borrow the runtime behind each navigable instance. An observed branch takes
/// precedence over a configured copy with the same key, just as in the sidebar.
pub(crate) fn instance_runtimes(
    project: &ProjectRow,
) -> impl Iterator<Item = (InstanceKey, &ProjectRuntime)> {
    project
        .runtime
        .iter()
        .map(move |runtime| (InstanceKey::project(&project.name), runtime))
        .chain(branch_keys(project).into_iter().filter_map(move |key| {
            let checkout = key.checkout.as_deref();
            let branch = key.branch.as_deref();
            let copy = project.branch_copy_at(branch, checkout);
            let observed =
                branch.and_then(|branch| project.branch_observation_at(branch, checkout, copy));
            let runtime = observed
                .map(|branch| &branch.runtime)
                .or_else(|| copy.and_then(|copy| copy.runtime.as_ref()))?;
            Some((key, runtime))
        }))
}

/// Every instance a snapshot reports: each project and its copies.
fn instance_keys(s: &Snapshot) -> Vec<InstanceKey> {
    s.projects
        .projects
        .iter()
        .flat_map(|p| std::iter::once(InstanceKey::project(&p.name)).chain(branch_keys(p)))
        .collect()
}

/// The row for an instance in a snapshot: the project row itself, or the
/// row derived for a branch instance.
fn instance_row(s: &Snapshot, key: &InstanceKey) -> Option<ProjectRow> {
    let p = s.projects.projects.iter().find(|p| p.name == key.project)?;
    match &key.branch {
        None if key.is_main() => Some(p.clone()),
        None => p
            .branch_copy_at(None, key.checkout.as_deref())
            .filter(|copy| copy.compose_project.is_some() || copy.compose_project_unresolved)
            .map(|copy| p.configured_instance(copy)),
        Some(b) => p.instance_at(b, key.checkout.as_deref()),
    }
}

fn instance_exists(s: &Snapshot, key: &InstanceKey) -> bool {
    instance_row(s, key).is_some()
}

fn select_instance(s: &Snapshot, key: InstanceKey) -> InstanceKey {
    if key.is_main() || instance_exists(s, &key) {
        return key;
    }
    // Callers with only a slug can select it when there is exactly one copy.
    if key.checkout.is_none()
        && let Some(project) = s.projects.projects.iter().find(|p| p.name == key.project)
    {
        let mut matches = branch_keys(project)
            .into_iter()
            .filter(|copy| copy.branch == key.branch);
        if let Some(copy) = matches.next()
            && matches.next().is_none()
        {
            return copy;
        }
    }
    InstanceKey::project(key.project)
}

impl AppModel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Update the remembered shells from a good read: instances it reports
    /// take its list; ones whose runtime it did not report keep theirs,
    /// marked stale; instances it no longer has are forgotten.
    fn remember_shells(&mut self, s: &Snapshot) {
        let mut next = HashMap::new();
        for key in instance_keys(s) {
            let Some(row) = instance_row(s, &key) else {
                continue;
            };
            let entry = match reported_shells(s, &row) {
                Some(names) => (names, false),
                None => match self.shells.remove(&key) {
                    Some((names, _)) => (names, true),
                    None => continue,
                },
            };
            next.insert(key, entry);
        }
        self.shells = next;
    }

    fn remember_service_stops(&mut self, snapshot: &Snapshot) {
        if snapshot.projects.engine_down() {
            return;
        }
        for (key, local) in &mut self.local {
            if local.service_stops.is_empty() {
                continue;
            }
            let row = instance_row(snapshot, key);
            let exited: std::collections::BTreeMap<_, _> = row
                .as_ref()
                .and_then(|row| row.runtime.as_ref())
                .iter()
                .flat_map(|runtime| &runtime.services)
                .flat_map(|service| &service.containers)
                .filter(|container| container.state.eq_ignore_ascii_case("exited"))
                .filter_map(|container| {
                    container
                        .id
                        .as_ref()
                        .map(|id| (id, container.started_at.as_ref()))
                })
                .collect();
            let checked = snapshot.projects.runtime_checked_at.as_deref();
            local.service_stops.retain(|id, receipt| {
                checked.is_none_or(|time| time <= receipt.stopped_at.as_str())
                    || exited.get(id).is_some_and(|started_at| {
                        started_at.is_none_or(|start| start == &receipt.started_at)
                    })
            });
        }
    }

    /// Start a read. Results from before an action boundary or a newer
    /// applied read cannot replace current state or prove failure recovery.
    pub fn begin_refresh(&mut self) -> RefreshToken {
        self.refresh_sequence += 1;
        RefreshToken {
            sequence: self.refresh_sequence,
            action_epoch: self.action_epoch,
        }
    }

    #[must_use]
    pub fn poll_interval(&self) -> std::time::Duration {
        if self.last_error.is_some() {
            std::time::Duration::from_secs(10)
        } else {
            Snapshot::poll_interval(self.snapshot.as_ref())
        }
    }

    /// The daemon action the app may offer. A daemon newer than the CLI is
    /// fixed by updating the CLI, never by restarting hackd from it.
    #[must_use]
    pub fn daemon_recovery(&self) -> Option<DaemonRecovery> {
        match &self.last_error {
            // Another install's hackd in a shared home: starting or
            // restarting it from here would only start a fight over it.
            Some(SourceError::DaemonUnavailable {
                shared_with: Some(_),
                ..
            }) => None,
            Some(SourceError::DaemonUnavailable { daemon: None, .. }) => {
                Some(DaemonRecovery::Start)
            }
            Some(SourceError::DaemonUnavailable {
                daemon: Some(d),
                cli,
                compatible: false,
                ..
            }) => match UpdateSide::for_versions(d, cli) {
                UpdateSide::Daemon => Some(DaemonRecovery::Restart),
                UpdateSide::Cli => None,
            },
            Some(SourceError::DaemonUnavailable { .. }) => Some(DaemonRecovery::Restart),
            _ => None,
        }
    }

    /// What the project reads say about hackd, for the hackd card: from the
    /// unavailable-daemon error when the last read failed that way, else from
    /// a good snapshot; nothing otherwise. Never an older read's versions
    /// after a newer read failed.
    #[must_use]
    pub fn hackd_evidence(&self) -> crate::machine::HackdEvidence<'_> {
        match &self.last_error {
            Some(SourceError::DaemonUnavailable {
                cli,
                daemon,
                shared_with,
                ..
            }) => crate::machine::HackdEvidence {
                hackd_version: daemon.as_deref(),
                cli_version: Some(cli),
                shared_with: shared_with.as_deref(),
            },
            Some(_) => crate::machine::HackdEvidence::default(),
            None => self
                .snapshot
                .as_ref()
                .map(|s| crate::machine::HackdEvidence {
                    hackd_version: s.daemon.as_ref().map(|d| d.version.as_str()),
                    cli_version: Some(&s.cli_version),
                    shared_with: None,
                })
                .unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn engine_observed(&self) -> bool {
        self.last_error.is_none()
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.projects.runtime_ok.is_some())
    }

    fn local_for(&self, key: &InstanceKey) -> LocalContext {
        self.local.get(key).cloned().unwrap_or_default()
    }

    fn observed_state(&self, row: &ProjectRow, local: &LocalContext) -> ProjectState {
        if let Some(error) = &self.last_error {
            return ProjectState::Unknown {
                reason: describe(error),
            };
        }
        state::derive(row, local)
    }

    /// The source now runs another Hack CLI, with its own hackd, registry and
    /// homes. Nothing read from the previous one may be shown or acted on:
    /// reads in flight are rejected (a new action epoch), and until the new
    /// CLI's first snapshot the window is loading with no actions. The
    /// selection is kept by name, so the same project is shown again if the
    /// new CLI has it.
    pub fn source_changed(&mut self) {
        self.source_epoch += 1;
        self.action_epoch += 1;
        self.snapshot = None;
        self.last_error = None;
        self.local.clear();
        self.service_actions.clear();
        self.action_errors.clear();
        self.loaded_once = false;
        // Shells the other CLI's reads reported are not this one's.
        self.shells.clear();
        self.selected_service = None;
    }

    /// Which CLI the model is showing: capture it when work starts, and
    /// apply the work's result only if it is unchanged.
    #[must_use]
    pub fn source_epoch(&self) -> u64 {
        self.source_epoch
    }

    /// Apply an ordered live read; returns whether it was accepted.
    pub fn finish_refresh(
        &mut self,
        token: RefreshToken,
        result: Result<Snapshot, SourceError>,
    ) -> bool {
        if token.action_epoch != self.action_epoch || token.sequence <= self.applied_sequence {
            return false;
        }
        self.applied_sequence = token.sequence;
        self.apply(Event::Refreshed(result));
        true
    }

    /// Apply one event. Returns `true` when the app should refresh now.
    pub fn apply(&mut self, event: Event) -> bool {
        match event {
            Event::Refreshed(Ok(mut s)) => {
                let previous_checkout = self.selected_row().and_then(|row| row.repo_root);
                self.keep_pending_native(&mut s);
                self.loaded_once = true;
                self.clear_recovered_failures(&s);
                self.last_error = None;
                self.remember_service_stops(&s);
                self.selected = match self.selected.take() {
                    Some(k) if instance_exists(&s, &k) => Some(k),
                    // A branch instance that went away: its project's base.
                    Some(k)
                        if !k.is_main()
                            && instance_exists(&s, &InstanceKey::project(k.project.clone())) =>
                    {
                        Some(InstanceKey::project(k.project))
                    }
                    _ => first_by_group(&s, &self.local),
                };
                self.remember_shells(&s);
                self.snapshot = Some(s);
                if self.selected_service.as_ref().is_some_and(|service| {
                    self.selected.as_ref() != Some(&service.instance)
                        || self.selected_row().is_none_or(|row| {
                            row.repo_root != previous_checkout
                                || !state::services(&row).iter().any(|s| s.name == service.name)
                        })
                }) {
                    self.selected_service = None;
                }
                false
            }
            Event::Refreshed(Err(SourceError::Pending)) => false,
            Event::Refreshed(Err(e)) => {
                self.loaded_once = true;
                self.last_error = Some(e);
                false
            }
            Event::Select(name) => {
                self.selected_service = None;
                self.selected = Some(InstanceKey::project(name));
                false
            }
            Event::SelectInstance(key) => {
                self.selected_service = None;
                self.selected = Some(if let Some(s) = self.snapshot.as_ref() {
                    select_instance(s, key)
                } else {
                    key
                });
                false
            }
            Event::ActionStarted { key, action } => {
                if self.action_in_flight(&key) {
                    return false;
                }
                self.local.entry(key.clone()).or_default().in_flight = Some(action);
                self.action_epoch += 1;
                self.action_errors.remove(&key);
                false
            }
            Event::ActionFinished {
                key,
                action,
                result,
            } => {
                self.action_epoch += 1;
                let ctx = self.local.entry(key.clone()).or_default();
                if ctx.in_flight == Some(action) {
                    ctx.in_flight = None;
                }
                match result {
                    Ok(ActionOutcome::Lifecycle(r)) => {
                        ctx.last_failed = if matches!(action, Action::Start | Action::Restart) {
                            r.services.failed
                        } else {
                            vec![]
                        };
                    }
                    Ok(ActionOutcome::Opened(_)) => {}
                    Err(e) => {
                        if let SourceError::Cli { failed, .. } = &e
                            && matches!(action, Action::Start | Action::Restart)
                        {
                            ctx.last_failed.clone_from(failed);
                        }
                        self.action_errors.insert(key, describe(&e));
                    }
                }
                action != Action::Open
            }
        }
    }

    /// A listing ([`crate::source::Source::listing`]) has not read native
    /// projects yet: until each `hack ps` returns ([`Self::finish_native`]),
    /// a pending row shows the observation the previous snapshot had for the
    /// same project and checkout. It stays pending, so it is not evidence.
    fn keep_pending_native(&self, s: &mut Snapshot) {
        let Some(previous) = &self.snapshot else {
            return;
        };
        for row in s.projects.projects.iter_mut().filter(|r| r.native_pending) {
            row.native = previous
                .projects
                .projects
                .iter()
                .find(|p| p.name == row.name && p.repo_root == row.repo_root && p.is_native())
                .and_then(|p| p.native.clone());
        }
    }

    /// Apply one native project's `hack ps` to the snapshot it was read
    /// for: only while that read (`token`) is the one shown and no action
    /// started or finished since. `ps` is `None` when the read failed, which
    /// shows as not read. Returns whether it was applied.
    pub fn finish_native(
        &mut self,
        token: RefreshToken,
        name: &str,
        repo_root: &str,
        ps: Option<crate::models::NativePs>,
    ) -> bool {
        if token.action_epoch != self.action_epoch || token.sequence != self.applied_sequence {
            return false;
        }
        let Some(mut s) = self.snapshot.take() else {
            return false;
        };
        let applied = match s.projects.projects.iter_mut().find(|r| {
            r.native_pending && r.name == name && r.repo_root.as_deref() == Some(repo_root)
        }) {
            Some(row) => {
                row.native = ps;
                row.native_pending = false;
                true
            }
            None => false,
        };
        if applied && self.last_error.is_none() {
            self.clear_recovered_failures(&s);
            self.remember_shells(&s);
        }
        self.snapshot = Some(s);
        applied
    }

    /// The native projects the shown snapshot still has to read, as
    /// `(name, repo_root)`.
    #[must_use]
    pub fn pending_native(&self) -> Vec<(String, String)> {
        self.snapshot
            .iter()
            .flat_map(|s| &s.projects.projects)
            .filter(|r| r.native_pending)
            .filter_map(|r| Some((r.name.clone(), r.repo_root.clone()?)))
            .collect()
    }

    /// A startup failure is cleared only on evidence that it is over: every
    /// failed service is observed running again. (A successful Stop from
    /// this app clears it too, in `ActionFinished`.) "Nothing runs" is not
    /// evidence: a failed start can leave containers never created.
    fn clear_recovered_failures(&mut self, s: &Snapshot) {
        for (key, ctx) in &mut self.local {
            if ctx.last_failed.is_empty()
                || ctx.in_flight.is_some()
                || self.service_actions.contains_key(key)
            {
                continue;
            }
            let Some(row) = instance_row(s, key) else {
                continue;
            };
            // A kept observation is from before this read: not evidence.
            if row.native_pending {
                continue;
            }
            let svcs = state::services(&row);
            let recovered = ctx
                .last_failed
                .iter()
                .all(|f| svcs.iter().any(|s| &s.name == f && s.running));
            if recovered {
                ctx.last_failed.clear();
            }
        }
    }

    /// A scoped action shares the instance's single flight and refresh epoch.
    /// Its in-flight state does not override the state of the whole copy.
    pub fn start_service_action(&mut self, key: &InstanceKey, service: &str) -> bool {
        if !self.can_start(key) {
            return false;
        }
        self.service_actions.insert(key.clone(), service.to_owned());
        self.action_errors.remove(key);
        self.action_epoch += 1;
        true
    }

    /// Apply only the changes that belong to the named service.
    pub fn finish_service_action(
        &mut self,
        key: InstanceKey,
        action: Action,
        result: Result<LifecycleResult, ServiceActionError>,
    ) -> bool {
        let Some(service) = self.service_actions.remove(&key) else {
            return false;
        };
        self.action_epoch += 1;
        let failed = &mut self.local.entry(key.clone()).or_default().last_failed;
        match result {
            Ok(receipt) => {
                failed.retain(|name| name != &service);
                if action == Action::Restart && receipt.services.failed.contains(&service) {
                    failed.push(service);
                }
                if let Some(stopped_at) = receipt.stopped_at {
                    self.record_service_stop(&key, receipt.stopped_containers, &stopped_at);
                }
            }
            Err(error) => {
                if action == Action::Restart
                    && let SourceError::Cli {
                        failed: reported, ..
                    } = error.source.as_ref()
                    && reported.contains(&service)
                    && !failed.contains(&service)
                {
                    failed.push(service);
                }
                if let Some(receipt) = error.stopped {
                    self.record_service_stop(&key, receipt.stopped_containers, &receipt.stopped_at);
                }
                self.action_errors.insert(key, describe(&error.source));
            }
        }
        true
    }

    /// Remember only executions whose stop was confirmed by the CLI.
    fn record_service_stop(
        &mut self,
        key: &InstanceKey,
        containers: Vec<StoppedContainerExecution>,
        stopped_at: &str,
    ) {
        if containers.is_empty() {
            return;
        }
        self.local
            .entry(key.clone())
            .or_default()
            .service_stops
            .extend(containers.into_iter().map(|container| {
                (
                    container.id,
                    ServiceStopEvidence {
                        started_at: container.started_at,
                        stopped_at: stopped_at.to_owned(),
                    },
                )
            }));
    }

    /// Can an action start for this instance now? Each instance has its
    /// own single flight: a branch action does not block the base.
    #[must_use]
    pub fn can_start(&self, key: &InstanceKey) -> bool {
        self.last_error.is_none() && !self.action_in_flight(key)
    }

    fn action_in_flight(&self, key: &InstanceKey) -> bool {
        self.service_actions.contains_key(key)
            || self.local.get(key).is_some_and(|c| c.in_flight.is_some())
    }

    /// The last good snapshot, if any.
    #[must_use]
    pub fn snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }

    #[must_use]
    pub fn project_list_readable(&self) -> bool {
        self.snapshot.is_some() && self.last_error.is_none()
    }

    /// The selected instance.
    #[must_use]
    pub fn selected_key(&self) -> Option<InstanceKey> {
        self.selected.clone()
    }

    #[must_use]
    pub fn runtime_target(&self, key: &InstanceKey) -> Option<RuntimeTarget> {
        let row = instance_row(self.snapshot.as_ref()?, key)?;
        if !self.can_target_compose(&row) {
            return None;
        }
        let native = row.is_native();
        Some(RuntimeTarget {
            root: row.repo_root?,
            native,
            compose_project: if native {
                None
            } else {
                row.compose_project
                    .or_else(|| row.runtime.and_then(|runtime| runtime.project))
            },
        })
    }

    #[must_use]
    pub fn selected_runtime_target(&self) -> Option<RuntimeTarget> {
        self.runtime_target(self.selected.as_ref()?)
    }

    #[must_use]
    pub fn instance_checkout(&self, key: &InstanceKey) -> Option<(String, bool)> {
        let row = instance_row(self.snapshot.as_ref()?, key)?;
        if row.checkout_verified == Some(false) {
            return None;
        }
        let native = row.is_native();
        Some((row.repo_root?, native))
    }

    /// Select a service in the current copy without resetting copy-level navigation.
    pub fn select_service(&mut self, name: String, destination: ServiceDestination) {
        let Some(instance) = self.selected_key() else {
            return;
        };
        self.selected_service = Some(ServiceSelection {
            instance,
            name,
            destination,
        });
    }

    #[must_use]
    pub fn selected_service(&self) -> Option<&ServiceSelection> {
        self.selected_service.as_ref()
    }

    pub fn clear_service_selection(&mut self) {
        self.selected_service = None;
    }

    /// Search includes service names in closed copies, without expanding them.
    #[must_use]
    pub fn project_has_service_match(&self, name: &str, query: &str) -> bool {
        let Some(project) = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.projects.projects.iter().find(|p| p.name == name))
        else {
            return false;
        };
        project
            .defined_services
            .iter()
            .map(String::as_str)
            .chain(
                project
                    .runtime
                    .iter()
                    .chain(project.branch_runtime.iter().map(|b| &b.runtime))
                    .flat_map(|runtime| runtime.services.iter().map(|s| s.service.as_str())),
            )
            .chain(
                project
                    .branch_copies
                    .iter()
                    .flat_map(|copy| copy.defined_services.iter().map(String::as_str)),
            )
            .chain(
                project
                    .native
                    .iter()
                    .flat_map(|report| report.items.iter().map(|item| item.service.as_str())),
            )
            .any(|service| service.to_lowercase().contains(query))
    }

    /// The selected instance's row: the project row, or the row derived
    /// for a branch instance ([`ProjectRow::instance`]).
    #[must_use]
    pub fn selected_row(&self) -> Option<ProjectRow> {
        instance_row(self.snapshot.as_ref()?, self.selected.as_ref()?)
    }

    #[must_use]
    pub fn list(&self) -> ListView {
        let mut banners = Vec::new();
        let phase = match (&self.snapshot, &self.last_error) {
            (_, Some(SourceError::CliMissing)) => Phase::CliMissing,
            (None, Some(SourceError::Cli { code, message, .. })) => Phase::Error {
                code: code.clone(),
                message: message.clone(),
            },
            (None, Some(SourceError::DaemonUnavailable { message, .. })) => Phase::Error {
                code: "E_APP_DAEMON_UNAVAILABLE".into(),
                message: message.clone(),
            },
            (None, _) => Phase::Loading,
            (Some(s), _) if s.projects.projects.is_empty() => Phase::Empty,
            (Some(_), _) => Phase::Ready,
        };
        let mut running = Vec::new();
        let mut stopped = Vec::new();
        let mut active_instances = 0;
        if let Some(SourceError::DaemonUnavailable {
            cli,
            daemon,
            compatible,
            message,
            shared_with,
        }) = &self.last_error
        {
            banners.push(match daemon {
                _ if shared_with.is_some() => Banner::SharedHome {
                    message: message.clone(),
                },
                None => Banner::DaemonOff,
                Some(d) if !compatible => Banner::mismatch(d, cli),
                Some(_) => Banner::DaemonReadFailed {
                    error: message.clone(),
                },
            });
        }
        if let Some(s) = &self.snapshot {
            if !matches!(self.last_error, Some(SourceError::DaemonUnavailable { .. })) {
                match (&s.daemon, s.daemon_mismatch()) {
                    (None, _) => banners.push(Banner::DaemonOff),
                    (Some(_), Some(v)) => banners.push(Banner::mismatch(v, &s.cli_version)),
                    _ => {}
                }
            }
            if s.projects.engine_down() {
                banners.push(Banner::EngineDown {
                    error: s.projects.runtime_error.clone().unwrap_or_default(),
                });
            }
            if let Some(e) = &self.last_error {
                banners.push(Banner::Stale { error: describe(e) });
            }
            for p in &s.projects.projects {
                let key = InstanceKey::project(p.name.clone());
                let branches = self.branch_rows(p);
                let mut unaddressed: std::collections::BTreeMap<_, _> = p
                    .worktrees
                    .iter()
                    .filter_map(|w| Some((w.path.clone()?, w.clone())))
                    .collect();
                for copy in p.branch_copies.iter().filter(|c| {
                    c.branch.is_none()
                        && c.compose_project.is_none()
                        && !c.compose_project_unresolved
                        && c.checkout.kind == "worktree"
                }) {
                    let path = copy.checkout.root.clone();
                    unaddressed.insert(
                        path.clone(),
                        Worktree {
                            path: Some(path),
                            branch: Some(copy.branch_name.clone()),
                        },
                    );
                }
                for path in branches.iter().filter_map(|b| b.checkout.as_ref()) {
                    unaddressed.remove(path);
                }
                let row = Row {
                    state: self.observed_state(p, &self.local_for(&key)),
                    always_on: p.autostart.as_ref().is_some_and(|a| a.enabled),
                    selected: self.selected.as_ref() == Some(&key),
                    name: p.name.clone(),
                    root: p.repo_root.clone(),
                    url: p.route(),
                    running_services: if self.last_error.is_some() {
                        0
                    } else {
                        state::services(p).iter().filter(|s| s.running).count()
                            + branches.iter().map(|b| b.running_services).sum::<usize>()
                    },
                    key,
                    branches,
                    unaddressed_worktrees: unaddressed.into_values().collect(),
                };
                let active_branches = row.branches.iter().filter(|b| b.state.is_active()).count();
                active_instances += active_branches + usize::from(row.state.is_active());
                if row.state.is_active() || active_branches > 0 {
                    running.push(row);
                } else {
                    stopped.push(row);
                }
            }
        }
        running.sort_by(|a, b| a.name.cmp(&b.name));
        stopped.sort_by(|a, b| a.name.cmp(&b.name));
        let unknown = stopped
            .iter()
            .filter(|r| matches!(r.state, ProjectState::Unknown { .. }))
            .count();
        let counts = Counts {
            running: active_instances,
            stopped: stopped.len() - unknown,
            unknown,
        };
        ListView {
            phase,
            banners,
            running,
            stopped,
            doctor_known: self.snapshot.as_ref().is_some_and(|s| s.doctor.is_some()),
            doctor_count: self
                .snapshot
                .as_ref()
                .and_then(|s| s.doctor.as_ref())
                .map_or(0, crate::models::DoctorReport::attention_count),
            cli_version: self.snapshot.as_ref().map(|s| s.cli_version.clone()),
            counts,
        }
    }

    fn branch_rows(&self, p: &ProjectRow) -> Vec<BranchRow> {
        let mut rows: Vec<BranchRow> = branch_keys(p)
            .into_iter()
            .filter_map(|key| {
                let slug = key.branch.as_deref();
                let checkout = key.checkout.clone();
                let configured = p.branch_copy_at(slug, checkout.as_deref());
                let row = match slug {
                    Some(slug) => p.instance_at(slug, checkout.as_deref())?,
                    None => p.configured_instance(configured?),
                };
                let runtime = p
                    .branch_runtime
                    .iter()
                    .find(|br| Some(br.branch.as_str()) == slug && p.branch_owner(br) == checkout);
                let worktree = configured.is_some_and(|copy| copy.checkout.kind == "worktree")
                    || checkout.as_ref().is_some_and(|root| {
                        p.worktrees.iter().any(|w| w.path.as_ref() == Some(root))
                    });
                let state = self.observed_state(&row, &self.local_for(&key));
                Some(BranchRow {
                    not_started: row.runtime.is_none()
                        && state == ProjectState::Stopped
                        && configured.is_some_and(|copy| !copy.recorded),
                    state,
                    url: row.route(),
                    selected: self.selected.as_ref() == Some(&key),
                    branch: runtime
                        .and_then(|br| br.branch_name.clone())
                        .or_else(|| configured.map(|c| c.branch_name.clone()))
                        .or_else(|| slug.map(str::to_owned))
                        .unwrap_or_else(|| "worktree".to_owned()),
                    key,
                    worktree,
                    checkout,
                    running_services: state::services(&row).iter().filter(|s| s.running).count(),
                })
            })
            .collect();
        rows.sort_by(|a, b| a.branch.cmp(&b.branch));
        rows
    }

    #[must_use]
    pub fn detail(&self) -> Option<DetailView> {
        let key = self.selected.clone()?;
        let row = self.selected_row()?;
        let local = self.local_for(&key);
        let st = self.observed_state(&row, &local);
        let mut services = state::services_with_stops(&row, &local);
        let can_target = self.can_target_compose(&row);
        let can_target_runtime = self.last_error.is_none() && can_target && row.owns_runtime();
        for service in &mut services {
            service.compose_container &= can_target_runtime;
        }
        if self.last_error.is_some() {
            for service in &mut services {
                service.running = false;
                service.completed = false;
                service.intentionally_stopped = false;
                service.exit_code = None;
                service.status = "Status unknown".into();
            }
        }
        Some(DetailView {
            name: row.name.clone(),
            branch: key.branch.clone(),
            backend: if row.is_native() {
                "native".into()
            } else {
                row.backend.clone().unwrap_or_else(|| "compose".into())
            },
            url: row.route(),
            always_on: row.autostart.as_ref().is_some_and(|a| a.enabled),
            // The marker lives on the project's own row (a branch instance's
            // derived row has none); it names the instance it is for.
            always_on_note: self
                .snapshot
                .as_ref()
                .and_then(|s| s.projects.projects.iter().find(|p| p.name == key.project))
                .and_then(|p| p.autostart.as_ref())
                .filter(|a| a.branch == key.branch && (key.is_main() || key.branch.is_some()))
                // The state line already says it (`state::derive`) when this
                // instance's row carries the marker (the base instance); a
                // branch instance's derived row does not, so keep it there.
                .filter(|a| a.state != "needs_attention" || row.autostart.is_none())
                .and_then(|a| {
                    crate::machine::always_on_note(
                        a,
                        self.snapshot
                            .as_ref()
                            .and_then(|s| s.projects.autostart_global.as_ref()),
                    )
                }),
            actions: if row.is_native()
                || self.last_error.is_some()
                || (!key.is_main() && row.repo_root.is_none())
            {
                vec![]
            } else if !can_target {
                st.actions()
                    .iter()
                    .copied()
                    .filter(|action| *action == Action::Open && row.route().is_some())
                    .collect()
            } else {
                st.actions().to_vec()
            },
            note: if row.is_native() {
                Some(NATIVE_ACTIONS_NOTE.to_owned())
            } else if !key.is_main() && row.repo_root.is_none() {
                Some(UNKNOWN_CHECKOUT_NOTE.to_owned())
            } else if row.compose_project_unresolved {
                Some("The Compose project name could not be resolved.".into())
            } else if !can_target {
                Some("The Compose project belongs to a different checkout or configuration.".into())
            } else {
                None
            },
            busy: self.action_in_flight(&key),
            runtime_addressable: can_target && row.repo_root.is_some(),
            shells: if can_target {
                self.shells
                    .get(&key)
                    .map(|(names, _)| names.clone())
                    .unwrap_or_default()
            } else {
                vec![]
            },
            shells_stale: self.last_error.is_some()
                || self.shells.get(&key).is_some_and(|(_, stale)| *stale),
            // The daemon only reports authored targets from the registered checkout.
            // Branch instance rows and stale or native observations carry none.
            remotes: if self.last_error.is_none() && !row.is_native() {
                row.remotes
            } else {
                vec![]
            },
            services,
            last_error: self.action_errors.get(&key).cloned(),
            state: st,
            key,
        })
    }

    fn can_target_compose(&self, row: &ProjectRow) -> bool {
        if row.compose_project_unresolved || row.checkout_verified == Some(false) {
            return false;
        }
        let Some(expected) = &row.compose_project else {
            return true;
        };
        if let Some(runtime) = &row.runtime {
            return runtime.project.as_ref() == Some(expected) && row.owns_runtime();
        }
        !self
            .snapshot
            .iter()
            .flat_map(|s| &s.projects.projects)
            .any(|project| {
                project
                    .runtime
                    .iter()
                    .chain(project.branch_runtime.iter().map(|item| &item.runtime))
                    .chain(
                        project
                            .branch_copies
                            .iter()
                            .filter_map(|copy| copy.runtime.as_ref()),
                    )
                    .any(|runtime| runtime.project.as_ref() == Some(expected))
            })
    }
}

/// The first project by sidebar group (running group first), then name.
fn first_by_group(s: &Snapshot, local: &HashMap<InstanceKey, LocalContext>) -> Option<InstanceKey> {
    let default = LocalContext::default();
    let active = |row: &ProjectRow, key: &InstanceKey| {
        state::derive(row, local.get(key).unwrap_or(&default)).is_active()
    };
    let mut rows: Vec<(bool, &str)> = s
        .projects
        .projects
        .iter()
        .map(|p| {
            let base = active(p, &InstanceKey::project(p.name.clone()));
            let any_branch = p.branch_runtime.iter().any(|br| {
                let checkout = p.branch_owner(br);
                p.instance_at(&br.branch, checkout.as_deref())
                    .is_some_and(|row| {
                        active(&row, &InstanceKey::branch_at(&p.name, &br.branch, checkout))
                    })
            });
            (!(base || any_branch), p.name.as_str())
        })
        .collect();
    rows.sort();
    rows.first().map(|(_, n)| InstanceKey::project(*n))
}

fn describe(e: &SourceError) -> String {
    match e {
        SourceError::Pending => "still loading".into(),
        SourceError::CliMissing => "hack was not found on PATH".into(),
        SourceError::DaemonUnavailable { message, .. } => message.clone(),
        SourceError::Cli { code, message, .. } => format!("{code}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn remotes_are_descriptor_only_and_belong_to_the_registered_checkout() {
        let mut snap = crate::fixtures::snapshot(crate::fixtures::Fixture::Running).unwrap();
        let row = snap
            .projects
            .projects
            .iter_mut()
            .find(|r| r.name == "storefront")
            .unwrap();
        row.remotes = serde_json::from_str(
            r#"[{
            "kind":"remote","service":"db","target":"staging","state":"declared",
            "probe":"not checked","address":{"kind":"env_ref","name":"DB_HOST",
            "port":5432,"value":"fixture-value"}
        }]"#,
        )
        .unwrap();
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snap)));
        model.apply(Event::Select("storefront".into()));
        let detail = model.detail().unwrap();
        assert_eq!(detail.remotes[0].address_label(), "$DB_HOST:5432");
        assert_eq!(detail.remotes[0].probe, "not checked");
        assert!(!format!("{detail:?}").contains("fixture-value"));
        model.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "fix-login",
        )));
        assert!(model.detail().unwrap().remotes.is_empty());
    }

    #[test]
    fn service_actions_preserve_other_failures_and_the_observed_instance_state() {
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        model.apply(Event::Select("storefront".into()));
        let key = model.selected_key().unwrap();
        model.local.entry(key.clone()).or_default().last_failed = vec!["web".into(), "api".into()];
        let observed = model.detail().unwrap().state;
        let ok = || Ok(LifecycleResult::default());

        assert!(model.start_service_action(&key, "api"));
        assert!(!model.can_start(&key));
        assert!(model.detail().unwrap().busy);
        assert_eq!(model.detail().unwrap().state, observed);
        assert!(model.finish_service_action(key.clone(), Action::Stop, ok()));
        assert!(model.can_start(&key));
        assert_eq!(model.local_for(&key).last_failed, ["web"]);

        assert!(model.start_service_action(&key, "api"));
        let failure = Err(SourceError::Cli {
            code: "E_RESTART".into(),
            message: "Restart failed".into(),
            failed: vec!["api".into()],
        }
        .into());
        assert!(model.finish_service_action(key.clone(), Action::Restart, failure));
        assert_eq!(model.local_for(&key).last_failed, ["web", "api"]);
        assert!(model.start_service_action(&key, "api"));
        assert!(model.finish_service_action(key.clone(), Action::Restart, ok()));
        assert_eq!(model.local_for(&key).last_failed, ["web"]);
    }

    #[test]
    fn a_branch_instance_url_is_its_instance_host_not_a_service_route() {
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(crate::fixtures::snapshot(
            crate::fixtures::Fixture::Branches,
        )));
        let list = m.list();
        let row = list
            .running
            .iter()
            .find(|r| r.name == "storefront")
            .expect("storefront runs through its branches");
        let release = row
            .branches
            .iter()
            .find(|b| b.branch == "release-2")
            .expect("release-2 listed");
        assert_eq!(
            release.url.as_deref(),
            Some("https://release-2.storefront.hack")
        );
        m.apply(Event::SelectInstance(release.key.clone()));
        let d = m.detail().unwrap();
        assert_eq!(d.url.as_deref(), Some("https://release-2.storefront.hack"));
        // The routes stay per service.
        let core = d.services.iter().find(|s| s.name == "core").unwrap();
        assert_eq!(
            core.route.as_deref(),
            Some("core.release-2.storefront.hack")
        );
    }

    #[test]
    fn a_branch_instance_from_an_unknown_checkout_offers_no_actions() {
        use crate::models::{BranchRuntime, ProjectRuntime};
        let mut snap = crate::fixtures::snapshot(crate::fixtures::Fixture::Branches).unwrap();
        let row = snap
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        row.branch_runtime.push(BranchRuntime {
            branch: "elsewhere".into(),
            runtime: ProjectRuntime {
                project: Some("storefront--elsewhere".into()),
                working_dir: Some("/unregistered/checkout/.hack".into()),
                services: vec![],
            },
            ..BranchRuntime::default()
        });
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap)));
        m.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "elsewhere",
        )));
        let d = m.detail().unwrap();
        assert!(d.actions.is_empty(), "{:?}", d.actions);
        assert_eq!(d.note.as_deref(), Some(UNKNOWN_CHECKOUT_NOTE));
        // A branch started from a registered linked worktree keeps its actions.
        m.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "fix-login",
        )));
        let d = m.detail().unwrap();
        assert!(!d.actions.is_empty());
        assert_eq!(d.note, None);
    }

    use super::*;
    use crate::fixtures::{self, Fixture};
    use crate::models::LifecycleResult;

    #[test]
    fn a_cli_switch_drops_the_old_snapshot_and_rejects_reads_already_in_flight() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        assert!(m.detail().is_some_and(|d| !d.actions.is_empty()));
        let in_flight = m.begin_refresh();
        let epoch = m.source_epoch();
        m.source_changed();
        assert_ne!(
            m.source_epoch(),
            epoch,
            "work started before the switch can tell"
        );
        assert!(
            m.detail().is_none(),
            "nothing from the previous CLI is shown or actionable"
        );
        assert!(
            !m.finish_refresh(in_flight, Ok(fixtures::snapshot(Fixture::Running).unwrap())),
            "a read started before the switch is rejected"
        );
        assert!(m.detail().is_none());
        let fresh = m.begin_refresh();
        assert!(m.finish_refresh(fresh, Ok(fixtures::snapshot(Fixture::Running).unwrap())));
        assert_eq!(
            m.detail().map(|d| d.name),
            Some("storefront".into()),
            "the selection comes back when the new CLI has the project"
        );
    }

    #[test]
    fn unavailable_daemon_invalidates_rows_and_offers_exact_recovery() {
        for (daemon, expected) in [
            (None, DaemonRecovery::Start),
            (Some("4.0.0".into()), DaemonRecovery::Restart),
        ] {
            let mut m = model(Fixture::Running);
            assert!(m.engine_observed());
            m.apply(Event::Select("storefront".into()));
            let token = m.begin_refresh();
            let message = if daemon.is_some() {
                "hackd v4.0.0, CLI v5.0.0: restart hackd"
            } else {
                "hackd is off: start hackd"
            };
            m.finish_refresh(
                token,
                Err(SourceError::DaemonUnavailable {
                    cli: "5.0.0".into(),
                    compatible: false,
                    shared_with: None,
                    daemon,
                    message: message.into(),
                }),
            );
            let list = m.list();
            assert!(list.running.is_empty());
            assert_eq!(list.counts.unknown, 4);
            assert_eq!(list.counts.stopped, 0);
            assert!(list.stopped.iter().all(
                |r| matches!(&r.state, ProjectState::Unknown { reason } if reason.contains("hackd"))
            ));
            assert!(list.banners.iter().any(|b| match expected {
                DaemonRecovery::Start => matches!(b, Banner::DaemonOff),
                DaemonRecovery::Restart => matches!(b, Banner::DaemonMismatch { .. }),
            }));
            assert_eq!(m.daemon_recovery(), Some(expected));
            assert!(m.detail().unwrap().actions.is_empty());
            assert!(!m.can_start(&InstanceKey::project("storefront")));
            assert!(!m.engine_observed());
            assert!(
                m.detail()
                    .unwrap()
                    .services
                    .iter()
                    .all(|s| !s.running && s.status == "Status unknown")
            );
            let refreshed = m.begin_refresh();
            m.finish_refresh(refreshed, fixtures::snapshot(Fixture::Running));
            assert!(m.engine_observed());
            assert!(m.can_start(&InstanceKey::project("storefront")));
            assert!(!m.detail().unwrap().actions.is_empty());
        }
        let mut first_launch = AppModel::new();
        first_launch.apply(Event::Refreshed(Err(SourceError::DaemonUnavailable {
            cli: "5.0.0".into(),
            compatible: false,
            shared_with: None,
            daemon: None,
            message: "hackd is off".into(),
        })));
        assert_eq!(first_launch.daemon_recovery(), Some(DaemonRecovery::Start));
        assert!(matches!(first_launch.list().phase, Phase::Error { .. }));
    }

    fn running_storefront() -> AppModel {
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        m.apply(Event::Select("storefront".into()));
        m
    }

    fn shells(m: &AppModel) -> (Vec<String>, bool) {
        let d = m.detail().expect("storefront is selected");
        (d.shells, d.shells_stale)
    }

    fn read_error() -> SourceError {
        SourceError::Cli {
            code: "E_TIMEOUT".into(),
            message: "the read timed out".into(),
            failed: vec![],
        }
    }

    #[test]
    fn a_good_read_offers_a_shell_in_each_running_service() {
        let m = running_storefront();
        let (names, stale) = shells(&m);
        assert_eq!(names, ["api", "db", "web", "worker"]);
        assert!(!stale);
    }

    #[test]
    fn a_failed_read_keeps_the_last_good_shells_marked_stale() {
        let mut m = running_storefront();
        m.apply(Event::Refreshed(Err(read_error())));
        let d = m.detail().unwrap();
        assert!(
            d.services.iter().all(|s| !s.running),
            "the service list itself says the status is unknown"
        );
        assert_eq!(d.shells, ["api", "db", "web", "worker"]);
        assert!(d.shells_stale);
        // The next good read clears the mark.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        assert!(!shells(&m).1);
    }

    #[test]
    fn a_slow_read_in_flight_changes_nothing() {
        let mut m = running_storefront();
        let _token = m.begin_refresh();
        m.apply(Event::Refreshed(Err(SourceError::Pending)));
        assert_eq!(
            shells(&m),
            (
                vec!["api".into(), "db".into(), "web".into(), "worker".into()],
                false
            )
        );
    }

    #[test]
    fn a_read_without_the_runtime_keeps_the_last_good_shells() {
        let mut m = running_storefront();
        // The engine is down: nothing proves the services stopped.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::EngineDown)));
        let (names, stale) = shells(&m);
        assert_eq!(names, ["api", "db", "web", "worker"]);
        assert!(stale);
        // A row without its runtime (the daemon still reading it).
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        for p in &mut snap.projects.projects {
            p.runtime = None;
        }
        m.apply(Event::Refreshed(Ok(snap)));
        let (names, stale) = shells(&m);
        assert_eq!(names, ["api", "db", "web", "worker"]);
        assert!(stale);
    }

    #[test]
    fn a_read_that_confirms_the_runtime_absent_clears_the_shells() {
        let mut m = running_storefront();
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        for p in &mut snap.projects.projects {
            p.runtime = None;
            p.runtime_status = Some("stopped".into());
        }
        m.apply(Event::Refreshed(Ok(snap)));
        assert_eq!(shells(&m), (Vec::<String>::new(), false));
    }

    #[test]
    fn native_shells_follow_native_ps_while_the_engine_is_down() {
        let mut snap = fixtures::snapshot(Fixture::EngineDown).unwrap();
        let row = snap
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        row.backend = Some("native".into());
        row.native = Some(crate::models::NativePs {
            status: "observed".into(),
            items: vec![crate::models::NativePsItem {
                service: "api".into(),
                state: "running".into(),
                ..Default::default()
            }],
        });
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap)));
        m.apply(Event::Select("storefront".into()));
        assert_eq!(shells(&m), (vec!["api".to_owned()], false));
    }

    /// `storefront` as a native project. `ps`: `Some((status, api
    /// running))` an observation, `None` none. `pending`: a listing that
    /// has not read it yet.
    fn native_storefront(ps: Option<(&str, bool)>, pending: bool) -> Snapshot {
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        let row = snap
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        row.backend = Some("native".into());
        row.repo_root = Some("/work/storefront".into());
        row.native = ps.map(|(status, running)| crate::models::NativePs {
            status: status.into(),
            items: vec![crate::models::NativePsItem {
                service: "api".into(),
                state: if running { "running" } else { "exited" }.into(),
                exit_code: (!running).then_some(1),
                ..Default::default()
            }],
        });
        row.native_pending = pending;
        snap
    }

    fn observed(running: bool) -> Option<crate::models::NativePs> {
        native_storefront(Some(("observed", running)), false)
            .projects
            .projects
            .into_iter()
            .find(|p| p.name == "storefront")
            .and_then(|p| p.native)
    }

    #[test]
    fn a_listing_keeps_the_previous_native_state_until_its_ps_returns() {
        let mut m = AppModel::new();
        let t = m.begin_refresh();
        assert!(m.finish_refresh(t, Ok(native_storefront(Some(("observed", true)), false))));
        m.apply(Event::Select("storefront".into()));
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
        assert_eq!(shells(&m), (vec!["api".to_owned()], false));

        // The next poll lists at once; native ps is still running.
        let listing = m.begin_refresh();
        assert!(m.finish_refresh(listing, Ok(native_storefront(None, true))));
        assert!(
            matches!(m.detail().unwrap().state, ProjectState::Running { .. }),
            "the previous observation is shown meanwhile"
        );
        assert_eq!(
            shells(&m),
            (vec!["api".to_owned()], true),
            "marked as earlier"
        );
        assert_eq!(
            m.pending_native(),
            vec![("storefront".to_owned(), "/work/storefront".to_owned())]
        );

        // Its ps returns: the new state replaces the kept one.
        let stopped = native_storefront(Some(("not_started", false)), false);
        let ps = stopped
            .projects
            .projects
            .iter()
            .find(|p| p.name == "storefront")
            .unwrap()
            .native
            .clone();
        assert!(m.finish_native(listing, "storefront", "/work/storefront", ps));
        assert_eq!(m.detail().unwrap().state, ProjectState::Stopped);
        assert_eq!(shells(&m), (Vec::<String>::new(), false));
        assert!(m.pending_native().is_empty());
        // Applied once only.
        assert!(!m.finish_native(listing, "storefront", "/work/storefront", observed(true)));
    }

    #[test]
    fn a_first_listing_says_native_status_is_being_read() {
        let mut m = AppModel::new();
        let t = m.begin_refresh();
        assert!(m.finish_refresh(t, Ok(native_storefront(None, true))));
        m.apply(Event::Select("storefront".into()));
        assert_eq!(
            m.detail().unwrap().state,
            ProjectState::Unknown {
                reason: "Reading native status…".into()
            }
        );
        // A read that failed shows as not read, not as still reading.
        assert!(m.finish_native(t, "storefront", "/work/storefront", None));
        assert_eq!(
            m.detail().unwrap().state,
            ProjectState::Unknown {
                reason: "Native status was not read".into()
            }
        );
    }

    #[test]
    fn a_native_result_for_a_superseded_read_or_across_an_action_is_dropped() {
        let mut m = AppModel::new();
        let first = m.begin_refresh();
        assert!(m.finish_refresh(first, Ok(native_storefront(None, true))));
        let second = m.begin_refresh();
        assert!(m.finish_refresh(second, Ok(native_storefront(None, true))));
        assert!(!m.finish_native(first, "storefront", "/work/storefront", observed(true)));
        assert!(!m.pending_native().is_empty(), "the newer read still waits");
        let third = m.begin_refresh();
        assert!(m.finish_refresh(third, Ok(native_storefront(None, true))));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
        });
        assert!(!m.finish_native(third, "storefront", "/work/storefront", observed(true)));
        // Another checkout of the same name is not this row.
        let fourth = m.begin_refresh();
        assert!(m.finish_refresh(fourth, Ok(native_storefront(None, true))));
        assert!(!m.finish_native(fourth, "storefront", "/elsewhere", observed(true)));
    }

    #[test]
    fn a_kept_native_observation_never_clears_a_failed_start() {
        let mut m = AppModel::new();
        let t = m.begin_refresh();
        assert!(m.finish_refresh(t, Ok(native_storefront(Some(("observed", true)), false))));
        let key = InstanceKey::project("storefront");
        m.apply(Event::ActionStarted {
            key: key.clone(),
            action: Action::Start,
        });
        m.apply(Event::ActionFinished {
            key: key.clone(),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["api".into()],
            }),
        });
        let failed = |m: &AppModel| {
            m.local
                .get(&key)
                .map(|c| c.last_failed.clone())
                .unwrap_or_default()
        };
        assert_eq!(failed(&m), vec!["api".to_owned()]);
        // The listing keeps the pre-start observation (api running): that is
        // not evidence the failure is over.
        let listing = m.begin_refresh();
        assert!(m.finish_refresh(listing, Ok(native_storefront(None, true))));
        assert_eq!(failed(&m), vec!["api".to_owned()]);
        // This read's own ps: api down, still failed; a later one running.
        assert!(m.finish_native(listing, "storefront", "/work/storefront", observed(false)));
        assert_eq!(failed(&m), vec!["api".to_owned()]);
        let later = m.begin_refresh();
        assert!(m.finish_refresh(later, Ok(native_storefront(None, true))));
        assert!(m.finish_native(later, "storefront", "/work/storefront", observed(true)));
        assert!(failed(&m).is_empty());
    }

    #[test]
    fn the_always_on_line_belongs_to_the_instance_its_marker_names() {
        let mut snap = fixtures::snapshot(Fixture::Hackd).unwrap();
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap.clone())));
        let note = |m: &mut AppModel, key: InstanceKey| {
            m.apply(Event::SelectInstance(key));
            m.detail().unwrap().always_on_note.map(|(_, t)| t)
        };
        assert_eq!(
            note(&mut m, InstanceKey::project("notes")).as_deref(),
            Some("Always on · paused until you start it")
        );
        assert!(
            note(&mut m, InstanceKey::project("storefront"))
                .unwrap()
                .contains("skipped (engine_timeout)")
        );
        // A marker for a branch instance is not the base instance's.
        let mut branch_marker = snap.clone();
        branch_marker
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap()
            .autostart
            .as_mut()
            .unwrap()
            .branch = Some("preview".into());
        m.apply(Event::Refreshed(Ok(branch_marker)));
        assert_eq!(note(&mut m, InstanceKey::project("storefront")), None);
        // Needs attention: the state line already says it, once.
        snap.projects
            .projects
            .iter_mut()
            .find(|p| p.name == "notes")
            .unwrap()
            .autostart
            .as_mut()
            .unwrap()
            .state = "needs_attention".into();
        m.apply(Event::Refreshed(Ok(snap)));
        assert_eq!(note(&mut m, InstanceKey::project("notes")), None);
    }

    #[test]
    fn a_branch_marker_shows_on_that_branch_instance_only() {
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        snap.projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap()
            .autostart = Some(crate::models::Autostart {
            enabled: true,
            state: "paused".into(),
            paused_reason: Some("manual_stop".into()),
            branch: Some("feature-search".into()),
            ..crate::models::Autostart::default()
        });
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap)));
        m.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "feature-search",
        )));
        assert_eq!(
            m.detail().unwrap().branch.as_deref(),
            Some("feature-search")
        );
        assert_eq!(
            m.detail()
                .unwrap()
                .always_on_note
                .map(|(_, t)| t)
                .as_deref(),
            Some("Always on · paused until you start it")
        );
        m.apply(Event::SelectInstance(InstanceKey::project("storefront")));
        assert_eq!(m.detail().unwrap().always_on_note, None);
        // Needs attention on a branch marker: the branch's state line cannot
        // say it, so the always-on line does.
        let mut attention = fixtures::snapshot(Fixture::Running).unwrap();
        attention
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap()
            .autostart = Some(crate::models::Autostart {
            enabled: true,
            state: "needs_attention".into(),
            branch: Some("feature-search".into()),
            failures: crate::models::AutostartFailures {
                count: 3,
                ..crate::models::AutostartFailures::default()
            },
            ..crate::models::Autostart::default()
        });
        m.apply(Event::Refreshed(Ok(attention)));
        m.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "feature-search",
        )));
        assert_eq!(
            m.detail()
                .unwrap()
                .always_on_note
                .map(|(_, t)| t)
                .as_deref(),
            Some("Always-on stopped trying after 3 failures")
        );
    }

    #[test]
    fn switching_cli_forgets_the_last_good_shells() {
        let mut m = running_storefront();
        m.source_changed();
        m.apply(Event::Refreshed(Err(read_error())));
        assert!(m.detail().is_none_or(|d| d.shells.is_empty()));
    }

    #[test]
    fn a_busy_native_runtime_keeps_the_last_native_shells() {
        let native = |status: &str, running: bool| {
            let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
            let row = snap
                .projects
                .projects
                .iter_mut()
                .find(|p| p.name == "storefront")
                .unwrap();
            row.backend = Some("native".into());
            row.native = Some(crate::models::NativePs {
                status: status.into(),
                items: if running {
                    vec![crate::models::NativePsItem {
                        service: "api".into(),
                        state: "running".into(),
                        ..Default::default()
                    }]
                } else {
                    vec![]
                },
            });
            snap
        };
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(native("observed", true))));
        m.apply(Event::Select("storefront".into()));
        assert_eq!(shells(&m), (vec!["api".to_owned()], false));
        for status in [
            "runtime_busy",
            "pending",
            "runtime_not_running",
            "owner_unconfirmed",
        ] {
            m.apply(Event::Refreshed(Ok(native(status, false))));
            assert_eq!(shells(&m), (vec!["api".to_owned()], true), "{status}");
        }
        m.apply(Event::Refreshed(Ok(native("not_started", false))));
        assert_eq!(shells(&m), (Vec::<String>::new(), false));
    }

    #[test]
    fn only_a_good_read_that_reports_a_service_stopped_drops_its_shell() {
        let mut m = running_storefront();
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        let row = snap
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        row.runtime
            .as_mut()
            .unwrap()
            .services
            .retain(|s| s.service != "web");
        m.apply(Event::Refreshed(Ok(snap)));
        let (names, stale) = shells(&m);
        assert_eq!(names, ["api", "db", "worker"]);
        assert!(!stale);
    }

    #[test]
    fn stale_reads_cannot_erase_startup_failure() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        let before_start = m.begin_refresh();
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Restart,
        });
        let during_action = m.begin_refresh();
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Restart,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "Could not start api".into(),
                failed: vec!["api".into()],
            }),
        });
        assert!(!m.finish_refresh(before_start, fixtures::snapshot(Fixture::Running)));
        assert!(!m.finish_refresh(during_action, fixtures::snapshot(Fixture::Running)));
        let fresh = m.begin_refresh();
        let mut snapshot = fixtures::snapshot(Fixture::Running).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        project
            .runtime
            .as_mut()
            .unwrap()
            .services
            .retain(|s| s.service != "api");
        assert!(m.finish_refresh(fresh, Ok(snapshot)));
        assert_eq!(
            m.detail().unwrap().state,
            ProjectState::FailedStart {
                services: vec!["api".into()]
            }
        );
        let recovered = m.begin_refresh();
        assert!(m.finish_refresh(recovered, fixtures::snapshot(Fixture::Running)));
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
    }

    #[test]
    fn last_applied_request_wins_and_failed_reads_retry_slowly() {
        let mut m = model(Fixture::Running);
        let old = m.begin_refresh();
        let new = m.begin_refresh();
        assert!(m.finish_refresh(new, fixtures::snapshot(Fixture::Stopped)));
        assert!(!m.finish_refresh(old, fixtures::snapshot(Fixture::Running)));
        assert_eq!(m.poll_interval(), std::time::Duration::from_secs(2));
        let failed = m.begin_refresh();
        m.finish_refresh(failed, fixtures::snapshot(Fixture::Error));
        assert_eq!(m.poll_interval(), std::time::Duration::from_secs(10));
        assert_eq!(
            Snapshot::poll_interval(None),
            std::time::Duration::from_secs(10)
        );
    }

    fn model(f: Fixture) -> AppModel {
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(fixtures::snapshot(f)));
        m
    }

    #[test]
    fn list_phases_for_every_list_fixture() {
        assert_eq!(model(Fixture::Loading).list().phase, Phase::Loading);
        assert_eq!(model(Fixture::Empty).list().phase, Phase::Empty);
        assert_eq!(model(Fixture::CliMissing).list().phase, Phase::CliMissing);
        assert!(matches!(
            model(Fixture::Error).list().phase,
            Phase::Error { .. }
        ));
        assert_eq!(
            model(Fixture::DaemonDown).list().banners,
            vec![Banner::DaemonOff]
        );
        assert!(matches!(
            model(Fixture::DaemonMismatch).list().banners[..],
            [Banner::DaemonMismatch { .. }]
        ));
        let engine = model(Fixture::EngineDown).list();
        assert!(matches!(engine.banners[..], [Banner::EngineDown { .. }]));
        assert!(engine.running.is_empty(), "unknown is not running");
        assert_eq!(engine.counts.stopped, 0, "unknown is not stopped");
        assert_eq!(engine.counts.unknown, 4);
    }

    #[test]
    fn groups_and_selection() {
        let v = model(Fixture::Running).list();
        let names = |rows: &[Row]| rows.iter().map(|r| r.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&v.running), ["docs-site", "storefront"]);
        assert_eq!(names(&v.stopped), ["billing-api", "notes"]);
        assert!(v.running[0].selected, "first running project selected");
        assert!(v.running[0].always_on);
        assert_eq!(v.doctor_count, 1);
        assert!(v.doctor_known);
    }

    #[test]
    fn doctor_is_unknown_until_it_has_run() {
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        snap.doctor = None; // live snapshots carry no doctor results
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap)));
        let v = m.list();
        assert!(!v.doctor_known);
        assert_eq!(v.doctor_count, 0);
    }

    #[test]
    fn failed_refresh_keeps_last_good_and_marks_stale() {
        let mut m = model(Fixture::Running);
        assert!(m.project_list_readable());
        m.apply(Event::Refreshed(Err(SourceError::Cli {
            code: "E_UNEXPECTED".into(),
            message: "boom".into(),
            failed: vec![],
        })));
        let v = m.list();
        assert_eq!(v.phase, Phase::Ready);
        assert!(matches!(v.banners.last(), Some(Banner::Stale { .. })));
        assert!(!m.project_list_readable());
        assert!(v.running.is_empty());
        assert_eq!(v.counts.unknown, 4);
        assert!(m.detail().unwrap().actions.is_empty());
    }

    #[test]
    fn action_lifecycle_and_single_flight() {
        let mut m = model(Fixture::Stopped);
        m.apply(Event::Select("storefront".into()));
        assert_eq!(m.detail().unwrap().actions, vec![Action::Start]);
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
        });
        let d = m.detail().unwrap();
        assert_eq!(d.state, ProjectState::Starting);
        assert!(d.busy);
        assert!(!m.can_start(&InstanceKey::project("storefront")));
        // A second action while one runs is ignored.
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Restart,
        });
        let refresh = m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
            result: Ok(ActionOutcome::Lifecycle(LifecycleResult {
                services: crate::models::LifecycleServices {
                    failed: vec!["api".into()],
                    ..Default::default()
                },
                ..Default::default()
            })),
        });
        assert!(refresh, "lifecycle actions refresh at once");
        assert_eq!(
            m.detail().unwrap().state,
            ProjectState::FailedStart {
                services: vec!["api".into()]
            }
        );
    }

    #[test]
    fn open_is_single_flight_too() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Open,
        });
        assert!(!m.can_start(&InstanceKey::project("storefront")));
        assert!(m.detail().unwrap().busy);
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
    }

    #[test]
    fn startup_failure_error_names_failed_services() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Restart,
        });
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Restart,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        // Fixture still shows all running; the failure shows once a service is down.
        assert!(m.detail().unwrap().last_error.is_some());
        let mut d = model(Fixture::Degraded);
        d.apply(Event::Select("storefront".into()));
        d.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
        });
        d.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        assert_eq!(
            d.detail().unwrap().state,
            ProjectState::FailedStart {
                services: vec!["worker".into()]
            }
        );
    }

    #[test]
    fn recovered_failure_does_not_stay_latched() {
        let mut m = model(Fixture::Degraded);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
        });
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::FailedStart { .. }
        ));
        // Recovered elsewhere: everything runs.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
        // Then stopped elsewhere: plain Stopped, not "Failed to start".
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Stopped)));
        assert_eq!(m.detail().unwrap().state, ProjectState::Stopped);
    }

    #[test]
    fn failed_start_with_nothing_created_stays_failed() {
        let mut m = model(Fixture::Stopped);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
        });
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["api".into()],
            }),
        });
        let failed = ProjectState::FailedStart {
            services: vec!["api".into()],
        };
        assert_eq!(m.detail().unwrap().state, failed);
        // The same stopped observation is no evidence of recovery.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Stopped)));
        assert_eq!(m.detail().unwrap().state, failed);
        // An explicit successful Stop clears it.
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Stop,
        });
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Stop,
            result: Ok(ActionOutcome::Lifecycle(LifecycleResult::default())),
        });
        assert_eq!(m.detail().unwrap().state, ProjectState::Stopped);
    }

    #[test]
    fn native_projects_offer_no_actions_and_say_why() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("docs-site".into()));
        let d = m.detail().unwrap();
        assert!(d.actions.is_empty());
        assert!(d.note.is_some());
        assert_eq!(d.backend, "native");
    }

    #[test]
    fn action_error_is_shown_on_the_project() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            key: InstanceKey::project("storefront"),
            action: Action::Stop,
        });
        m.apply(Event::ActionFinished {
            key: InstanceKey::project("storefront"),
            action: Action::Stop,
            result: Err(SourceError::Cli {
                code: "E_DOCKER_UNAVAILABLE".into(),
                message: "down".into(),
                failed: vec![],
            }),
        });
        let d = m.detail().unwrap();
        assert_eq!(d.last_error.as_deref(), Some("E_DOCKER_UNAVAILABLE: down"));
        assert!(!d.busy);
    }

    fn branch(b: &str) -> InstanceKey {
        let root = match b {
            "fix-login" => "/work/storefront-wt/fix-login",
            _ => "/work/storefront",
        };
        InstanceKey::branch_at("storefront", b, Some(root.into()))
    }

    #[test]
    fn instance_keys_display_and_compare() {
        assert_eq!(InstanceKey::project("storefront").to_string(), "storefront");
        assert_eq!(branch("fix-login").to_string(), "storefront · fix-login");
        assert_ne!(InstanceKey::project("storefront"), branch("fix-login"));
    }

    #[test]
    fn branch_instances_group_and_count() {
        // Base stopped, three branches running: the project is in the running group.
        let v = model(Fixture::Branches).list();
        let names = |rows: &[Row]| rows.iter().map(|r| r.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&v.running), ["docs-site", "storefront"]);
        assert_eq!(names(&v.stopped), ["billing-api", "notes"]);
        let sf = &v.running[1];
        assert_eq!(sf.key, InstanceKey::project("storefront"));
        assert_eq!(sf.state, ProjectState::Stopped);
        let br: Vec<_> = sf.branches.iter().map(|b| b.branch.as_str()).collect();
        assert_eq!(br, ["feature-search", "fix-login", "release-2"]);
        assert!(sf.branches.iter().all(|b| b.state.is_active()));
        assert_eq!(sf.branches[0].key, branch("feature-search"));
        assert_eq!(
            sf.branches[0].url.as_deref(),
            Some("https://feature-search.storefront.hack")
        );
        // docs-site + three branch instances; storefront's base is not counted.
        assert_eq!(
            v.counts,
            Counts {
                running: 4,
                stopped: 2,
                unknown: 0
            }
        );

        // Running fixture: base running, one branch running, one failed.
        let v = model(Fixture::Running).list();
        let sf = v.running.iter().find(|r| r.name == "storefront").unwrap();
        assert!(sf.state.is_active());
        assert!(sf.branches[0].state.is_active());
        assert_eq!(
            sf.branches[1].state,
            ProjectState::FailedStart {
                services: vec!["api".into()]
            }
        );
        assert_eq!(v.counts.running, 3, "storefront, feature-search, docs-site");
        assert_eq!(v.counts.stopped, 2);

        // An unreadable daemon makes every instance unknown.
        let mut m = model(Fixture::Branches);
        m.apply(Event::Refreshed(Err(SourceError::Cli {
            code: "E_UNEXPECTED".into(),
            message: "boom".into(),
            failed: vec![],
        })));
        let v = m.list();
        assert!(v.running.is_empty());
        assert_eq!(v.counts.running, 0);
        assert_eq!(v.counts.unknown, 4);
    }

    #[test]
    fn selecting_a_branch_instance_and_falling_back() {
        let mut m = model(Fixture::Branches);
        m.apply(Event::SelectInstance(branch("feature-search")));
        assert_eq!(m.selected_key(), Some(branch("feature-search")));
        let row = m.selected_row().unwrap();
        assert_eq!(row.branch.as_deref(), Some("feature-search"));
        let d = m.detail().unwrap();
        assert_eq!(d.key, branch("feature-search"));
        assert_eq!(d.name, "storefront");
        assert_eq!(d.branch.as_deref(), Some("feature-search"));
        assert_eq!(
            d.url.as_deref(),
            Some("https://feature-search.storefront.hack")
        );
        assert!(matches!(d.state, ProjectState::Running { .. }));
        assert_eq!(d.actions, [Action::Open, Action::Restart, Action::Stop]);
        assert!(!d.always_on);
        let v = m.list();
        let sf = v.running.iter().find(|r| r.name == "storefront").unwrap();
        assert!(!sf.selected, "only the branch is selected");
        assert!(sf.branches[0].selected && !sf.branches[1].selected);

        // The base instance is its own selection.
        m.apply(Event::Select("storefront".into()));
        let d = m.detail().unwrap();
        assert_eq!(d.branch, None);
        assert_eq!(d.state, ProjectState::Stopped);
        assert_eq!(d.url.as_deref(), Some("https://storefront.hack"));

        // The branch goes away: fall back to the project's base instance.
        m.apply(Event::SelectInstance(branch("fix-login")));
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Stopped)));
        assert_eq!(m.selected_key(), Some(InstanceKey::project("storefront")));
        assert_eq!(m.detail().unwrap().branch, None);

        // Selecting a branch the snapshot does not have selects the base.
        m.apply(Event::SelectInstance(branch("nope")));
        assert_eq!(m.selected_key(), Some(InstanceKey::project("storefront")));
    }

    #[test]
    fn actions_are_single_flight_per_instance() {
        let mut m = model(Fixture::Running);
        let base = InstanceKey::project("storefront");
        let fs = branch("feature-search");
        m.apply(Event::ActionStarted {
            key: fs.clone(),
            action: Action::Restart,
        });
        assert!(!m.can_start(&fs));
        assert!(
            m.can_start(&base),
            "a branch action does not block the base"
        );
        m.apply(Event::Select("storefront".into()));
        assert!(!m.detail().unwrap().busy);
        m.apply(Event::ActionStarted {
            key: base.clone(),
            action: Action::Stop,
        });
        assert!(!m.can_start(&base));
        m.apply(Event::SelectInstance(fs.clone()));
        let d = m.detail().unwrap();
        assert!(d.busy);
        assert_eq!(d.state, ProjectState::Starting);
        // Finishing the branch's action leaves the base in flight.
        m.apply(Event::ActionFinished {
            key: fs.clone(),
            action: Action::Restart,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["api".into()],
            }),
        });
        assert!(m.can_start(&fs));
        assert!(!m.can_start(&base));
        let d = m.detail().unwrap();
        assert_eq!(d.last_error.as_deref(), Some("E_STARTUP_INCOMPLETE: m"));
        m.apply(Event::Select("storefront".into()));
        let d = m.detail().unwrap();
        assert_eq!(d.state, ProjectState::Stopping);
        assert_eq!(d.last_error, None, "errors are per instance");
    }

    #[test]
    fn mismatch_banner_names_the_side_to_update() {
        let v = model(Fixture::DaemonMismatch).list();
        assert_eq!(
            v.banners,
            [Banner::DaemonMismatch {
                daemon: "4.3.0".into(),
                cli: "5.0.0".into(),
                update: UpdateSide::Daemon,
            }]
        );
        assert_eq!(
            v.banners[0].text(),
            "hackd 4.3.0 is older than this CLI (5.0.0): restart hackd"
        );
        assert_eq!(
            Banner::mismatch("5.1.0", "5.0.0").text(),
            "hackd 5.1.0 is newer than this CLI (5.0.0): update the CLI with hack update"
        );
        // A compatible daemon whose project read failed is not a mismatch.
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Err(SourceError::DaemonUnavailable {
            cli: "5.0.0-next.18".into(),
            daemon: Some("4.3.0".into()),
            compatible: true,
            shared_with: None,
            message: "hackd could not provide project status".into(),
        })));
        assert!(matches!(
            m.list().banners[..],
            [Banner::DaemonReadFailed { .. }]
        ));
        assert_eq!(m.daemon_recovery(), Some(DaemonRecovery::Restart));
    }

    #[test]
    fn every_detail_fixture_renders_a_detail() {
        for f in [
            Fixture::Stopped,
            Fixture::Starting,
            Fixture::Running,
            Fixture::Degraded,
            Fixture::Stopping,
            Fixture::FailedStart,
            Fixture::NeedsAttention,
        ] {
            let mut m = model(f);
            m.apply(Event::Select(fixtures::selected(f).into()));
            if let Some(a) = fixtures::local(f).in_flight {
                m.apply(Event::ActionStarted {
                    key: InstanceKey::project(fixtures::selected(f)),
                    action: a,
                });
            }
            let d = m.detail().unwrap_or_else(|| panic!("{f:?}"));
            assert_eq!(d.name, "storefront");
            assert_eq!(d.url.as_deref(), Some("https://storefront.hack"));
        }
    }

    #[test]
    fn stopped_copies_keep_routes_and_scope_service_selection() {
        let mut model = model(Fixture::GroupedSidebar);
        let feature = InstanceKey::branch_at(
            "storefront",
            "feature-search",
            Some("/work/storefront/.worktrees/feature-search".into()),
        );
        let release = branch("release-2");
        model.apply(Event::SelectInstance(feature.clone()));
        model.select_service("api".into(), ServiceDestination::Files);
        model.apply(Event::Refreshed(fixtures::snapshot(
            Fixture::GroupedSidebar,
        )));
        assert_eq!(
            model.selected_service().map(|s| &s.instance),
            Some(&feature)
        );
        assert!(model.start_service_action(&feature, "api"));
        assert!(model.detail().unwrap().busy);
        assert!(model.detail().unwrap().state.is_active());
        assert!(model.can_start(&release));
        model.finish_service_action(feature, Action::Stop, Ok(LifecycleResult::default()));

        model.apply(Event::SelectInstance(release.clone()));
        assert!(model.selected_service().is_none());
        model.apply(Event::Refreshed(fixtures::snapshot(
            Fixture::GroupedSidebar,
        )));
        let detail = model.detail().unwrap();
        assert_eq!(detail.key, release);
        assert_eq!(detail.state, ProjectState::Stopped);
        assert_eq!(detail.services[0].name, "deploy");
        assert_eq!(
            detail.url.as_deref(),
            Some("https://release-2.storefront.hack")
        );
    }

    #[test]
    fn a_worktree_copy_does_not_show_services_from_the_primary_checkout() {
        let mut snapshot = fixtures::snapshot(Fixture::GroupedSidebar).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        project.defined_services.push("primary-only".into());
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot)));
        model.apply(Event::SelectInstance(InstanceKey::branch(
            "storefront",
            "feature-search",
        )));
        let services = model.detail().unwrap().services;
        assert_eq!(services.len(), 4);
        assert!(!services.iter().any(|s| s.name == "primary-only"));
    }

    #[test]
    fn a_shared_slug_never_redirects_selection_when_the_runtime_disappears() {
        use crate::models::{BranchCheckout, BranchCopy};
        let mut snapshot = fixtures::snapshot(Fixture::Branches).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let worktree = "/work/storefront-wt/fix-login";
        project.branch_copies.push(BranchCopy {
            branch: Some("release-2".into()),
            branch_name: "release-2".into(),
            checkout: BranchCheckout {
                root: worktree.into(),
                kind: "worktree".into(),
            },
            defined_services: vec!["core".into()],
            ..BranchCopy::default()
        });
        let mut after = snapshot.clone();
        after
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap()
            .branch_runtime
            .retain(|runtime| runtime.branch != "release-2");

        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot)));
        let row = model
            .list()
            .running
            .into_iter()
            .find(|r| r.name == "storefront")
            .unwrap();
        assert_eq!(
            row.branches
                .iter()
                .filter(|r| r.key.branch.as_deref() == Some("release-2"))
                .count(),
            2
        );
        model.apply(Event::SelectInstance(branch("release-2")));
        model.select_service("core".into(), ServiceDestination::Files);
        assert_eq!(
            model.selected_row().unwrap().repo_root.as_deref(),
            Some("/work/storefront")
        );
        model.apply(Event::Refreshed(Ok(after)));
        assert_eq!(
            model.selected_key(),
            Some(InstanceKey::project("storefront"))
        );
        assert!(model.selected_service().is_none());
    }

    #[test]
    fn partial_stop_keeps_the_error_and_records_only_confirmed_replicas() {
        let mut snapshot = fixtures::snapshot(Fixture::GroupedSidebar).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let runtime = &mut project.branch_runtime[0].runtime;
        runtime.services.retain(|service| service.service == "api");
        let containers = &mut runtime.services[0].containers;
        containers[0].id = Some("confirmed".into());
        containers[0].started_at = Some("2026-11-23T00:00:00.000Z".into());
        let mut replica = containers[0].clone();
        replica.id = Some("unconfirmed".into());
        containers.push(replica);

        let key = InstanceKey::branch_at(
            "storefront",
            "feature-search",
            Some("/work/storefront/.worktrees/feature-search".into()),
        );
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot.clone())));
        model.apply(Event::SelectInstance(key.clone()));
        assert!(model.start_service_action(&key, "api"));
        model.finish_service_action(
            key,
            Action::Stop,
            Err(crate::runner::RunError::Cli(crate::models::CliError {
                code: "E_COMPOSE_FAILED".into(),
                message: "Could not stop api (Docker exit 1).".into(),
                detail: Some(serde_json::json!({
                    "stoppedContainers": [{ "id": "confirmed", "startedAt": "2026-11-23T00:00:00.000Z" }],
                    "stoppedAt": "2026-11-23T00:00:30.000Z"
                })),
            })
            .into()),
        );

        let mut refresh = |replicas: usize| {
            let project = snapshot
                .projects
                .projects
                .iter_mut()
                .find(|p| p.name == "storefront")
                .unwrap();
            for container in
                &mut project.branch_runtime[0].runtime.services[0].containers[..replicas]
            {
                container.state = "exited".into();
                container.status = "Exited (137)".into();
            }
            model.apply(Event::Refreshed(Ok(snapshot.clone())));
            model.detail().unwrap()
        };
        let partial = refresh(1);
        assert!(matches!(partial.state, ProjectState::Running { .. }));
        assert_eq!(
            partial.last_error.as_deref(),
            Some("E_COMPOSE_FAILED: Could not stop api (Docker exit 1).")
        );
        assert!(matches!(refresh(2).state, ProjectState::FailedStart { .. }));
    }

    #[test]
    fn a_retained_stopped_container_can_restart_and_a_host_process_cannot() {
        let mut snapshot = fixtures::snapshot(Fixture::GroupedSidebar).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let runtime = &mut project.branch_runtime[0].runtime;
        runtime.services.retain(|service| service.service == "api");
        let container = &mut runtime.services[0].containers[0];
        container.id = Some("stopped-api".into());
        container.started_at = Some("2026-11-23T00:00:00.000000111Z".into());
        container.state = "exited".into();
        container.status = "Exited (137) 2 seconds ago".into();
        let mut completed_replica = container.clone();
        completed_replica.id = Some("completed-replica".into());
        completed_replica.status = "Exited (0) 2 seconds ago".into();
        runtime.services[0].containers.push(completed_replica);
        let key = InstanceKey::branch_at(
            "storefront",
            "feature-search",
            Some("/work/storefront/.worktrees/feature-search".into()),
        );
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot.clone())));
        model.apply(Event::SelectInstance(key.clone()));
        assert!(matches!(
            model.detail().unwrap().state,
            ProjectState::FailedStart { .. }
        ));
        model.record_service_stop(
            &key,
            vec![StoppedContainerExecution {
                id: "stopped-api".into(),
                started_at: "2026-11-23T00:00:00.000000111Z".into(),
            }],
            "2026-11-23T00:00:30.000Z",
        );
        let mut cached = snapshot.clone();
        cached.projects.runtime_checked_at = Some("2026-11-23T00:00:29.999Z".into());
        let project = cached
            .projects
            .projects
            .iter_mut()
            .find(|row| row.name == "storefront")
            .unwrap();
        let api = &mut project.branch_runtime[0].runtime.services[0].containers[0];
        api.state = "running".into();
        api.status = "Up".into();
        model.apply(Event::Refreshed(Ok(cached)));
        let mut partial = snapshot.clone();
        partial.projects.runtime_checked_at = Some("2026-11-23T00:00:31.000Z".into());
        let project = partial
            .projects
            .projects
            .iter_mut()
            .find(|row| row.name == "storefront")
            .unwrap();
        let containers = &mut project.branch_runtime[0].runtime.services[0].containers;
        containers[0].started_at = None;
        containers.swap(0, 1);
        model.apply(Event::Refreshed(Ok(partial)));
        assert!(matches!(
            model.detail().unwrap().state,
            ProjectState::Unknown { .. }
        ));
        assert_eq!(model.detail().unwrap().services[0].status, "Status unknown");
        model.apply(Event::Refreshed(Ok(snapshot.clone())));
        let detail = model.detail().unwrap();
        assert_eq!(detail.state, ProjectState::Stopped);
        assert!(detail.services[0].intentionally_stopped);
        assert!(detail.services[0].compose_container);

        let mut restarted = snapshot.clone();
        restarted.projects.runtime_checked_at = Some("2026-11-23T00:01:00.000Z".into());
        let project = restarted
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let container = &mut project.branch_runtime[0].runtime.services[0].containers[0];
        // The same ID restarted and crashed during the batch. Its newer
        // execution began before the batch finished, even in the same ms.
        container.started_at = Some("2026-11-23T00:00:00.000000222Z".into());
        model.apply(Event::Refreshed(Ok(restarted)));
        let detail = model.detail().unwrap();
        assert!(matches!(detail.state, ProjectState::FailedStart { .. }));
        assert!(!detail.services[0].intentionally_stopped);

        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let containers = &mut project.branch_runtime[0].runtime.services[0].containers;
        let mut synthetic = containers[0].clone();
        synthetic.id = Some("host-api".into());
        synthetic
            .labels
            .insert("hack.lifecycle.process".into(), "true".into());
        containers.push(synthetic);
        model.apply(Event::Refreshed(Ok(snapshot)));
        assert!(!model.detail().unwrap().services[0].compose_container);
    }

    #[test]
    fn a_linked_base_marks_the_primary_compose_target_as_taken() {
        use crate::models::{BranchCheckout, BranchCopy};
        let mut snapshot = fixtures::snapshot(Fixture::GroupedSidebar).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        project.compose_project = Some("storefront".into());
        project.runtime = None;
        let owner = "/work/storefront/.worktrees/feature-search";
        let mut runtime = project.branch_runtime.remove(0).runtime;
        runtime.project = Some("storefront".into());
        project.branch_copies.push(BranchCopy {
            branch_name: "feature-search".into(),
            checkout: BranchCheckout {
                root: owner.into(),
                kind: "worktree".into(),
            },
            compose_project: Some("storefront".into()),
            runtime: Some(runtime),
            ..BranchCopy::default()
        });
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot)));
        model.apply(Event::Select("storefront".into()));
        assert!(model.detail().unwrap().actions.is_empty());
        let worktree = model
            .list()
            .running
            .into_iter()
            .find(|row| row.name == "storefront")
            .unwrap()
            .branches
            .into_iter()
            .find(|row| row.branch == "feature-search")
            .unwrap();
        assert!(worktree.state.is_active());
        model.apply(Event::SelectInstance(worktree.key));
        let detail = model.detail().unwrap();
        assert!(detail.actions.contains(&Action::Stop));
        assert!(
            detail
                .services
                .iter()
                .any(|service| service.running && service.compose_container)
        );
    }

    #[test]
    fn an_unresolved_compose_name_cannot_start_another_checkouts_stack() {
        let mut snapshot = fixtures::snapshot(Fixture::GroupedSidebar).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        project.runtime = None;
        project.compose_project = None;
        project.compose_project_unresolved = true;
        project.branch_copies[0].compose_project_unresolved = true;
        let mut runtime = project.branch_runtime[0].runtime.clone();
        let working_dir = "/work/billing-api/.hack";
        runtime.project = Some("shared".into());
        runtime.working_dir = Some(working_dir.into());
        for container in runtime
            .services
            .iter_mut()
            .flat_map(|service| &mut service.containers)
        {
            container.labels.insert(
                "com.docker.compose.project.working_dir".into(),
                working_dir.into(),
            );
        }
        let other = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "billing-api")
            .unwrap();
        other.runtime = Some(runtime);

        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot)));
        model.apply(Event::Select("storefront".into()));
        assert!(!model.detail().unwrap().actions.contains(&Action::Start));
        assert!(model.selected_runtime_target().is_none());
        model.apply(Event::SelectInstance(branch("release-2")));
        let detail = model.detail().unwrap();
        assert_eq!(detail.branch.as_deref(), Some("release-2"));
        assert!(!detail.actions.contains(&Action::Start));
        assert!(model.selected_runtime_target().is_none());
    }

    #[test]
    fn a_legacy_stack_cannot_retarget_compose_actions() {
        let mut snapshot = fixtures::snapshot(Fixture::Branches).unwrap();
        let project = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        let legacy = project
            .branch_runtime
            .iter_mut()
            .find(|br| br.branch == "feature-search")
            .unwrap();
        legacy.compose_project = Some("new--feature-search".into());
        legacy.checkout_verified = Some(true);
        let mut current = legacy.clone();
        current.runtime.project.clone_from(&current.compose_project);
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(snapshot.clone())));
        model.apply(Event::SelectInstance(branch("feature-search")));
        assert_eq!(model.detail().unwrap().actions, [Action::Open]);
        assert!(!model.detail().unwrap().runtime_addressable);
        assert!(model.detail().unwrap().shells.is_empty());
        assert_eq!(
            model.instance_checkout(&model.selected_key().unwrap()),
            Some(("/work/storefront".into(), false))
        );
        let p = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
            .unwrap();
        p.branch_runtime.push(current);
        model.apply(Event::Refreshed(Ok(snapshot)));
        assert!(model.detail().unwrap().actions.contains(&Action::Stop));
    }
}
