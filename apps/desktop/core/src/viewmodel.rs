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
    local: HashMap<InstanceKey, LocalContext>,
    action_errors: HashMap<InstanceKey, String>,
    loaded_once: bool,
    refresh_sequence: u64,
    applied_sequence: u64,
    action_epoch: u64,
    /// Per instance, the running services of the last read that reported
    /// its runtime, and whether that was an earlier read than the current
    /// snapshot. See [`DetailView::shells`].
    shells: HashMap<InstanceKey, (Vec<String>, bool)>,
}

/// The running services of a row whose runtime the read reported, `None`
/// when it did not (engine down, or no runtime or native observation).
fn reported_shells(s: &Snapshot, row: &ProjectRow) -> Option<Vec<String>> {
    let reported = if row.is_native() {
        row.native.is_some()
    } else {
        row.runtime.is_some()
    };
    if s.projects.engine_down() || !reported {
        return None;
    }
    Some(
        state::services(row)
            .into_iter()
            .filter(|v| v.running)
            .map(|v| v.name)
            .collect(),
    )
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
            Event::Refreshed(Ok(s)) => {
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
                let ctx = self.local.entry(key.clone()).or_default();
                if ctx.in_flight.is_some() {
                    return false;
                }
                ctx.in_flight = Some(action);
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

    /// A startup failure is cleared only on evidence that it is over: every
    /// failed service is observed running again. (A successful Stop from
    /// this app clears it too, in `ActionFinished`.) "Nothing runs" is not
    /// evidence: a failed start can leave containers never created.
    fn clear_recovered_failures(&mut self, s: &Snapshot) {
        for (key, ctx) in &mut self.local {
            if ctx.last_failed.is_empty() || ctx.in_flight.is_some() {
                continue;
            }
            let Some(row) = instance_row(s, key) else {
                continue;
            };
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

    /// Can an action start for this instance now? Each instance has its
    /// own single flight: a branch action does not block the base.
    #[must_use]
    pub fn can_start(&self, key: &InstanceKey) -> bool {
        self.last_error.is_none() && self.local.get(key).is_none_or(|c| c.in_flight.is_none())
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
        }) = &self.last_error
        {
            banners.push(match daemon {
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
            actions: if row.is_native()
                || self.last_error.is_some()
                || (row.branch.is_some() && row.repo_root.is_none())
            {
                vec![]
            } else {
                st.actions().to_vec()
            },
            note: if row.is_native() {
                Some(NATIVE_ACTIONS_NOTE.to_owned())
            } else if row.branch.is_some() && row.repo_root.is_none() {
                Some(UNKNOWN_CHECKOUT_NOTE.to_owned())
            } else {
                None
            },
            busy: local.in_flight.is_some(),
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
