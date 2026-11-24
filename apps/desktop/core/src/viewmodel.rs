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

use crate::models::ProjectRow;
pub use crate::source::UpdateSide;
use crate::source::{ActionOutcome, DaemonRecovery, Snapshot, SourceError};
use crate::state::{self, Action, LocalContext, ProjectState, ServiceView};

/// One runnable instance: a project's base instance (`branch: None`) or one
/// of its branch instances.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize)]
pub struct InstanceKey {
    pub project: String,
    pub branch: Option<String>,
}

impl InstanceKey {
    /// The base instance of a project.
    #[must_use]
    pub fn project(name: impl Into<String>) -> Self {
        Self {
            project: name.into(),
            branch: None,
        }
    }

    /// A branch instance of a project.
    #[must_use]
    pub fn branch(name: impl Into<String>, branch: impl Into<String>) -> Self {
        Self {
            project: name.into(),
            branch: Some(branch.into()),
        }
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
    /// The base instance's state.
    pub state: ProjectState,
    pub always_on: bool,
    /// The base instance is selected.
    pub selected: bool,
    /// Branch instances, sorted by branch.
    pub branches: Vec<BranchRow>,
}

/// One branch instance under its project's row.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BranchRow {
    pub key: InstanceKey,
    pub branch: String,
    pub state: ProjectState,
    pub url: Option<String>,
    pub selected: bool,
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

/// Native Start uses detached JSON. The terminal handles Stop and Restart.
pub const NATIVE_ACTIONS_NOTE: &str = "Stop or restart native projects in a terminal with HACK_RUNTIME_BACKEND=native hack down / restart.";

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

/// Every instance a snapshot reports: each project and its branches.
fn instance_keys(s: &Snapshot) -> Vec<InstanceKey> {
    s.projects
        .projects
        .iter()
        .flat_map(|p| {
            std::iter::once(InstanceKey::project(p.name.clone())).chain(
                p.branch_runtime
                    .iter()
                    .map(|b| InstanceKey::branch(p.name.clone(), b.branch.clone())),
            )
        })
        .collect()
}

/// The row for an instance in a snapshot: the project row itself, or the
/// row derived for a branch instance.
fn instance_row(s: &Snapshot, key: &InstanceKey) -> Option<ProjectRow> {
    let p = s.projects.projects.iter().find(|p| p.name == key.project)?;
    match &key.branch {
        None => Some(p.clone()),
        Some(b) => p.instance(b),
    }
}

fn instance_exists(s: &Snapshot, key: &InstanceKey) -> bool {
    s.projects.projects.iter().any(|p| {
        p.name == key.project
            && key
                .branch
                .as_ref()
                .is_none_or(|b| p.branch_runtime.iter().any(|r| &r.branch == b))
    })
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
                self.keep_pending_native(&mut s);
                self.loaded_once = true;
                self.clear_recovered_failures(&s);
                self.last_error = None;
                self.selected = match self.selected.take() {
                    Some(k) if instance_exists(&s, &k) => Some(k),
                    // A branch instance that went away: its project's base.
                    Some(k)
                        if k.branch.is_some()
                            && instance_exists(&s, &InstanceKey::project(k.project.clone())) =>
                    {
                        Some(InstanceKey::project(k.project))
                    }
                    _ => first_by_group(&s, &self.local),
                };
                self.remember_shells(&s);
                self.snapshot = Some(s);
                false
            }
            Event::Refreshed(Err(SourceError::Pending)) => false,
            Event::Refreshed(Err(e)) => {
                self.loaded_once = true;
                self.last_error = Some(e);
                false
            }
            Event::Select(name) => {
                self.selected = Some(InstanceKey::project(name));
                false
            }
            Event::SelectInstance(key) => {
                // A branch instance the current snapshot does not have
                // selects its project's base instead.
                let missing = key.branch.is_some()
                    && self
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| !instance_exists(s, &key));
                self.selected = Some(if missing {
                    InstanceKey::project(key.project)
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
        result: Result<ActionOutcome, SourceError>,
    ) -> bool {
        let Some(service) = self.service_actions.remove(&key) else {
            return false;
        };
        self.action_epoch += 1;
        let failed = &mut self.local.entry(key.clone()).or_default().last_failed;
        match result {
            Ok(ActionOutcome::Lifecycle(result)) => {
                failed.retain(|name| name != &service);
                if action == Action::Restart && result.services.failed.contains(&service) {
                    failed.push(service);
                }
            }
            Err(error) => {
                if action == Action::Restart
                    && let SourceError::Cli {
                        failed: reported, ..
                    } = &error
                    && reported.contains(&service)
                    && !failed.contains(&service)
                {
                    failed.push(service);
                }
                self.action_errors.insert(key, describe(&error));
            }
            Ok(ActionOutcome::Opened(_)) => {}
        }
        true
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
                let row = Row {
                    state: self.observed_state(p, &self.local_for(&key)),
                    always_on: p.autostart.as_ref().is_some_and(|a| a.enabled),
                    selected: self.selected.as_ref() == Some(&key),
                    name: p.name.clone(),
                    key,
                    branches,
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
        let mut rows: Vec<BranchRow> = p
            .branch_runtime
            .iter()
            .filter_map(|br| {
                let row = p.instance(&br.branch)?;
                let key = InstanceKey::branch(p.name.clone(), br.branch.clone());
                Some(BranchRow {
                    state: self.observed_state(&row, &self.local_for(&key)),
                    url: row.dev_host.as_ref().map(|h| format!("https://{h}")),
                    selected: self.selected.as_ref() == Some(&key),
                    branch: br.branch.clone(),
                    key,
                })
            })
            .collect();
        rows.sort_by(|a, b| a.branch.cmp(&b.branch));
        rows.dedup_by(|a, b| a.branch == b.branch);
        rows
    }

    #[must_use]
    pub fn detail(&self) -> Option<DetailView> {
        let key = self.selected.clone()?;
        let row = self.selected_row()?;
        let local = self.local_for(&key);
        let st = self.observed_state(&row, &local);
        let mut services = state::services(&row);
        if self.last_error.is_some() {
            for service in &mut services {
                service.running = false;
                service.completed = false;
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
            url: row.dev_host.as_ref().map(|h| format!("https://{h}")),
            always_on: row.autostart.as_ref().is_some_and(|a| a.enabled),
            // The marker lives on the project's own row (a branch instance's
            // derived row has none); it names the instance it is for.
            always_on_note: self
                .snapshot
                .as_ref()
                .and_then(|s| s.projects.projects.iter().find(|p| p.name == key.project))
                .and_then(|p| p.autostart.as_ref())
                .filter(|a| a.branch == key.branch)
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
            actions: if self.last_error.is_some() || row.repo_root.is_none() {
                vec![]
            } else if row.is_native() {
                let can_start = !row.native_pending
                    && (matches!(st, ProjectState::Stopped)
                        || (matches!(st, ProjectState::Unknown { .. })
                            && row
                                .native
                                .as_ref()
                                .is_some_and(|ps| ps.status == "runtime_not_running")));
                if can_start {
                    vec![Action::Start]
                } else {
                    vec![]
                }
            } else {
                st.actions().to_vec()
            },
            note: if row.branch.is_some() && row.repo_root.is_none() {
                Some(UNKNOWN_CHECKOUT_NOTE.to_owned())
            } else if row.is_native() {
                Some(NATIVE_ACTIONS_NOTE.to_owned())
            } else {
                None
            },
            busy: self.action_in_flight(&key),
            shells: self
                .shells
                .get(&key)
                .map(|(names, _)| names.clone())
                .unwrap_or_default(),
            shells_stale: self.last_error.is_some()
                || self.shells.get(&key).is_some_and(|(_, stale)| *stale),
            services,
            last_error: self.action_errors.get(&key).cloned(),
            state: st,
            key,
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
                p.instance(&br.branch).is_some_and(|row| {
                    active(
                        &row,
                        &InstanceKey::branch(p.name.clone(), br.branch.clone()),
                    )
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
    fn service_actions_preserve_other_failures_and_the_observed_instance_state() {
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        model.apply(Event::Select("storefront".into()));
        let key = model.selected_key().unwrap();
        model.local.entry(key.clone()).or_default().last_failed = vec!["web".into(), "api".into()];
        let observed = model.detail().unwrap().state;
        let ok = || {
            Ok(ActionOutcome::Lifecycle(
                crate::models::LifecycleResult::default(),
            ))
        };

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
        });
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
            owner: None,
            branch: "elsewhere".into(),
            runtime: ProjectRuntime {
                project: Some("storefront--elsewhere".into()),
                working_dir: Some("/unregistered/checkout/.hack".into()),
                services: vec![],
            },
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
    fn running_native_projects_use_the_terminal_for_stop_and_restart() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("docs-site".into()));
        let d = m.detail().unwrap();
        assert!(d.actions.is_empty());
        assert!(d.note.is_some());
        assert_eq!(d.backend, "native");
    }

    #[test]
    fn native_start_requires_a_confirmed_stopped_project_and_checkout() {
        let mut s = fixtures::snapshot(Fixture::ImageRefused).unwrap();
        let mut m = model(Fixture::ImageRefused);
        m.apply(Event::Select("storefront".into()));
        assert_eq!(m.detail().unwrap().actions, [Action::Start]);

        s.projects.projects[0].native_pending = true;
        m.apply(Event::Refreshed(Ok(s.clone())));
        assert!(m.detail().unwrap().actions.is_empty());

        s.projects.projects[0].native_pending = false;
        s.projects.projects[0].repo_root = None;
        m.apply(Event::Refreshed(Ok(s)));
        assert!(m.detail().unwrap().actions.is_empty());
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
        InstanceKey::branch("storefront", b)
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
}
