//! The one window, in design v1 (`DESIGN-V1.md`): title bar with search,
//! sidebar, detail pane, status bar.
//!
//! All data comes from `hack_desktop_core`; this file lays it out with the
//! `hack_desktop_ui` components and forwards clicks as view-model events.
//! Blocking work (CLI, socket) runs on the background executor, never on the
//! UI thread. Nothing here invents a value: what the CLI does not report is
//! a dash with a tooltip, or absent.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::{
    ActiveTheme, Sizable as _,
    input::{Input, InputEvent, InputState},
};
#[cfg(all(test, feature = "screenshots", hack_terminal))]
use gpui_kit::test::TestSupportExt as _;
use gpui_kit::{
    AnyElement, App, ClipboardItem, Context, Entity, IntoElement, KeyBinding, ParentElement,
    Render, Styled, Task, Window, div, prelude::*, px,
};
use hack_desktop_core::doctor::{DoctorPane, TargetKey, should_auto_refresh};
use hack_desktop_core::machine_gate::{Holder, MachineGate};
use hack_desktop_core::source::{
    ActionOutcome, DaemonRecovery, DoctorTarget, NATIVE_PS_PARALLEL, Snapshot, Source, SourceError,
};

use crate::doctor_view::Pane;
use crate::setup_view::{evidence_status, routing_evidence};
use hack_desktop_core::doctor::DoctorState as DoctorStateView;

use hack_desktop_core::source::target_keys;
use hack_desktop_core::state::{Action, ProjectState, ServiceView};
use hack_desktop_core::viewmodel::{
    AppModel, Banner, DetailView, Event, InstanceKey, ListView, Phase, RefreshToken, Row,
};
use hack_desktop_ui::components::{
    ServiceRow, StyledExt as _, Ui, action_button, always_on_switch, caption, count_pill, dot,
    empty_pane, icon_button, machine_row, neutral_pill, primary_button, services_table_with_rows,
    skeleton, state_pill, status_bar,
};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::{Status, project_label, service_label};
use hack_desktop_ui::tokens::{Mode, Palette, radius, size, space, text};

gpui_kit::actions!(hack_desktop, [FocusSearch]);

/// The search shortcut: Cmd-K on macOS, Ctrl-K elsewhere.
#[cfg(target_os = "macos")]
pub(crate) const SEARCH_KEY: &str = "cmd-k";
#[cfg(not(target_os = "macos"))]
pub(crate) const SEARCH_KEY: &str = "ctrl-k";
/// Where the search shortcut applies. Ctrl-K belongs to the shell in a
/// terminal (readline: delete to the end of the line), so off macOS it
/// applies everywhere but a focused terminal. Cmd-K never reaches a shell.
#[cfg(target_os = "macos")]
const SEARCH_CONTEXT: Option<&str> = None;
#[cfg(not(target_os = "macos"))]
const SEARCH_CONTEXT: Option<&str> = Some("!Terminal");

/// Why the always-on switch is disabled.
const ALWAYS_ON_REASON: &str = "Read-only here: change always-on with hack autostart add or remove";

/// The window's key bindings.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(SEARCH_KEY, FocusSearch, SEARCH_CONTEXT)]);
    crate::service_view::bind_keys(cx);
    #[cfg(hack_terminal)]
    bind_terminal_keys(cx);
}

/// The terminal panel's keys (DESIGN-V1.md, "Keyboard"). Panel and tab keys
/// work wherever focus is; the rest apply in a terminal. Shortcuts that
/// would reach the shell are never taken: on Linux they are Ctrl-Shift
/// chords, as in terminals.
#[cfg(hack_terminal)]
fn bind_terminal_keys(cx: &mut App) {
    use hack_desktop_term::actions::{
        CloseFind, CloseTab, Copy, Find, FindNewer, FindOlder, NewTab, NextTab, Paste, PrevTab,
        ScrollPageDown, ScrollPageUp, ScrollToBottom, ScrollToTop, ToggleFollow, ToggleMaximize,
        TogglePanel,
    };
    const TERMINAL: Option<&str> = Some("Terminal");
    if cfg!(target_os = "macos") {
        cx.bind_keys([
            KeyBinding::new(
                "cmd-up",
                crate::command_control::MakeCommandTaller,
                Some("TerminalCommand"),
            ),
            KeyBinding::new("cmd-j", TogglePanel, None),
            KeyBinding::new("cmd-t", NewTab, None),
            KeyBinding::new("cmd-w", CloseTab, None),
            KeyBinding::new("cmd-shift-]", NextTab, None),
            KeyBinding::new("cmd-shift-[", PrevTab, None),
            KeyBinding::new("cmd-shift-enter", ToggleMaximize, None),
            KeyBinding::new("cmd-f", Find, TERMINAL),
            KeyBinding::new("cmd-c", Copy, TERMINAL),
            KeyBinding::new("cmd-v", Paste, TERMINAL),
        ]);
    } else {
        cx.bind_keys([
            KeyBinding::new(
                "ctrl-shift-up",
                crate::command_control::MakeCommandTaller,
                Some("TerminalCommand"),
            ),
            KeyBinding::new("ctrl-shift-j", TogglePanel, None),
            KeyBinding::new("ctrl-shift-t", NewTab, None),
            KeyBinding::new("ctrl-shift-w", CloseTab, None),
            KeyBinding::new("ctrl-shift-pagedown", NextTab, None),
            KeyBinding::new("ctrl-shift-pageup", PrevTab, None),
            KeyBinding::new("ctrl-shift-enter", ToggleMaximize, None),
            KeyBinding::new("ctrl-shift-f", Find, TERMINAL),
            KeyBinding::new("ctrl-shift-c", Copy, TERMINAL),
            KeyBinding::new("ctrl-shift-v", Paste, TERMINAL),
        ]);
    }
    cx.bind_keys([
        KeyBinding::new("enter", FindOlder, Some("TerminalFind")),
        KeyBinding::new("shift-enter", FindNewer, Some("TerminalFind")),
        KeyBinding::new("escape", CloseFind, Some("TerminalFind")),
        KeyBinding::new("shift-pageup", ScrollPageUp, TERMINAL),
        KeyBinding::new("shift-pagedown", ScrollPageDown, TERMINAL),
        KeyBinding::new("pageup", ScrollPageUp, Some("TerminalLogs")),
        KeyBinding::new("pagedown", ScrollPageDown, Some("TerminalLogs")),
        KeyBinding::new("home", ScrollToTop, Some("TerminalLogs")),
        KeyBinding::new("end", ScrollToBottom, Some("TerminalLogs")),
        KeyBinding::new("f", ToggleFollow, Some("TerminalLogs && !TerminalFind")),
    ]);
}

pub struct HackApp {
    pub(crate) model: AppModel,
    pub(crate) source: Arc<dyn Source>,
    pub(crate) logs: crate::logs_view::LogsPane,
    pub(crate) tab: usize,
    pub(crate) config: crate::config_view::ConfigPane,
    pub(crate) sidebar_menu: Option<String>,
    pub(crate) changes: crate::changes_view::ChangesPane,
    pub(crate) catalog: crate::service_catalog::ServiceCatalog,
    pub(crate) service_pane: crate::service_view::ServicePane,
    pub(crate) service_focus: gpui_kit::FocusHandle,
    pub(crate) copies: crate::copies_view::CopiesPane,
    pub(crate) files: crate::files_view::ProjectFiles,
    pub(crate) env: hack_desktop_core::env::EnvModel,
    /// The Env tab's open edit, if any (`env_view`).
    pub(crate) env_edit: Option<crate::env_view::EnvEdit>,
    /// "Saved NAME" after the last write, until the next edit or listing.
    pub(crate) env_saved: Option<String>,
    /// Numbers each editor opened (`EnvEdit::id`).
    pub(crate) env_edit_seq: u64,
    /// Terminal panels, one per project or branch instance.
    #[cfg(hack_terminal)]
    pub(crate) panels: crate::terminal::Panels,
    pub(crate) live: bool,
    /// The title bar's project filter.
    search: Entity<InputState>,
    filter: String,
    /// When the URL was last copied, for the check mark.
    copied: Option<Instant>,
    pub(crate) pane: Pane,
    pub(crate) doctor: DoctorPane,
    pub(crate) health: crate::health_model::Health,
    /// Is the window visible (not minimised or hidden)? Automatic doctor
    /// runs wait for it.
    pub(crate) window_visible: bool,
    _visibility: Option<gpui_kit::Subscription>,
    _activation: Option<gpui_kit::Subscription>,
    /// One machine action at a time: Setup's actions and Start / Restart
    /// hackd here share it.
    pub(crate) machine: MachineGate,
    recovery_error: Option<String>,
    /// `hack daemon status --json` for the hackd pane, read when the pane
    /// opens, on Check again and after Start / Restart hackd.
    pub(crate) hackd_status: Option<hack_desktop_core::models::DaemonStatus>,
    /// A read finished (its result may be `None`: not readable).
    pub(crate) hackd_read: bool,
    pub(crate) hackd_loading: bool,
    /// The Upgrade pane's reads and results.
    pub(crate) upgrade: crate::upgrade_view::UpgradePane,
    /// Resource use of the shown instance (Services tab).
    pub(crate) usage: Option<crate::usage_view::UsageState>,
    pub(crate) usage_loading: bool,
    pub(crate) stats: crate::stats_view::ServiceStats,
    /// [`Self::hackd_evidence_key`] when hackd was last read: a project read
    /// that changes it makes the stored read stale.
    pub(crate) hackd_evidence_seen: String,
    /// Setup checks (DESIGN.md section 2; `setup_view`).
    pub(crate) setup: hack_desktop_core::setup::Pane,
    #[cfg(hack_terminal)]
    pub(crate) setup_command_check: Option<(crate::command_control::CommandRunId, String)>,
    /// The launch check has not reported yet: when it finds something to
    /// do, setup opens.
    pub(crate) setup_on_launch: bool,
    /// When each project's running action started, for the slow-action
    /// warning. Display only: the app never terminates a lifecycle command.
    action_started: std::collections::HashMap<InstanceKey, Instant>,
}

impl HackApp {
    /// `live`: poll the source. Fixtures load once and never poll.
    pub fn new(
        source: Arc<dyn Source>,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let logs = crate::logs_view::LogsPane::new(window, cx);
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Search projects, branches, services")
        });
        cx.subscribe(&search, |this: &mut HackApp, state, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                this.filter = state.read(cx).value().trim().to_lowercase();
                cx.notify();
            }
        })
        .detach();
        let catalog_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search images"));
        cx.subscribe(&catalog_input, |_: &mut HackApp, _, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        let mut this = Self {
            model: AppModel::new(),
            source,
            logs,
            tab: 0,
            config: Default::default(),
            sidebar_menu: None,
            changes: Default::default(),
            catalog: crate::service_catalog::ServiceCatalog {
                input: catalog_input,
                selected: 0,
            },
            service_pane: Default::default(),
            service_focus: cx.focus_handle(),
            copies: Default::default(),
            files: Default::default(),
            pane: Pane::Project,
            doctor: DoctorPane::default(),
            health: Default::default(),
            window_visible: true,
            _visibility: None,
            _activation: None,
            env: Default::default(),
            env_edit: None,
            env_saved: None,
            env_edit_seq: 0,
            live,
            search,
            filter: String::new(),
            copied: None,
            #[cfg(hack_terminal)]
            panels: Default::default(),
            machine: MachineGate::default(),
            recovery_error: None,
            hackd_status: None,
            hackd_read: false,
            hackd_loading: false,
            upgrade: crate::upgrade_view::UpgradePane::default(),
            usage: None,
            usage_loading: false,
            stats: Default::default(),
            hackd_evidence_seen: String::new(),
            action_started: std::collections::HashMap::new(),
            setup: Default::default(),
            #[cfg(hack_terminal)]
            setup_command_check: None,
            setup_on_launch: live,
        };
        if live {
            this.start_polling(cx);
            this.start_usage_polling(cx);
            this.start_doctor_refresh(cx);
            this.load_setup(cx);
        } else {
            this.refresh_now();
        }
        this.start_log_drain(cx);
        // A secret copied less than REVEAL_FOR ago: clear it on quit too, if
        // the clipboard still holds it.
        cx.on_app_quit(|this, cx| {
            this.clear_owned_clipboard(cx);
            async {}
        })
        .detach();
        this
    }

    /// Fixtures: show the Logs tab in a designed state.
    pub fn show_logs_fixture(
        &mut self,
        f: hack_desktop_core::logs::fixtures::LogsFixture,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use hack_desktop_core::logs::fixtures::{LogsFixture, model};
        if f == LogsFixture::Native {
            self.select("docs-site");
        }
        self.tab = 1;
        self.logs.set_model(model(f), window, cx);
    }

    /// Synchronous refresh, for fixtures and screenshots.
    pub fn refresh_now(&mut self) {
        let snap = self.source.snapshot();
        self.model.apply(Event::Refreshed(snap));
    }

    /// Fixtures and screenshots: open the Doctor pane with its data loaded.
    pub fn show_doctor_now(&mut self) {
        self.pane = Pane::Doctor;
        let targets = self.doctor_targets();
        let names = self.doctor_target_keys();
        let generation = self.doctor.begin(names.as_deref());
        let runs = self
            .source
            .doctor_runs(targets.as_deref().unwrap_or_default());
        self.accept_health_report(generation, runs, self.source.setup());
    }

    /// `None` when the project list has not been read: doctor then runs
    /// machine checks only and reports the projects as not checked.
    pub(crate) fn doctor_targets(&self) -> Option<Vec<DoctorTarget>> {
        if !self.model.project_list_readable() {
            return None;
        }
        self.model
            .snapshot()
            .map(|s| DoctorTarget::from_projects(&s.projects))
    }

    pub(crate) fn doctor_target_keys(&self) -> Option<Vec<TargetKey>> {
        self.doctor_targets().map(|t| target_keys(&t))
    }

    /// Open the Doctor pane, optionally filtered to one project, and run
    /// doctor when it never ran or the result is older than 10 minutes.
    pub fn open_doctor(&mut self, filter: Option<String>, cx: &mut Context<Self>) {
        self.pane = Pane::Doctor;
        self.user_navigated();
        self.doctor.filter = filter;
        if self.doctor.needs_refresh(std::time::Instant::now()) {
            self.load_doctor(cx);
        }
        cx.notify();
    }

    /// Start a doctor run if the pane is shown in a visible window and the
    /// result is missing, old or stale. Returns whether it started one.
    pub(crate) fn maybe_auto_refresh(&mut self, cx: &mut Context<Self>) -> bool {
        let start = self.health.queue.is_none()
            && should_auto_refresh(
                self.pane == Pane::Doctor,
                self.window_visible,
                &self.doctor,
                std::time::Instant::now(),
            );
        if start {
            self.load_doctor(cx);
        }
        start
    }

    /// Track window visibility; when it becomes visible again, refresh a
    /// missing, old or stale doctor result.
    pub fn watch_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.window_visible = window.is_visible();
        self._visibility = Some(cx.observe_window_visibility(
            window,
            |this, visibility, _window, cx| {
                this.window_visible = visibility.is_visible();
                this.maybe_auto_refresh(cx);
                if this.window_visible {
                    this.recheck_setup_on_return(cx);
                } else {
                    this.hide_env_values(cx);
                }
            },
        ));
        // Focus coming back checks setup again (switching back from the
        // terminal usually leaves the window visible throughout); focus
        // going away hides any revealed env value.
        self._activation = Some(cx.observe_window_activation(window, |this, window, cx| {
            if window.is_window_active() {
                this.recheck_setup_on_return(cx);
            } else {
                this.hide_env_values(cx);
            }
        }));
    }

    /// Once a minute: refresh an old Doctor or Setup result on screen.
    pub(crate) fn minute_tick(&mut self, cx: &mut Context<Self>) {
        self.refresh_update_notice(cx);
        if hack_desktop_core::setup::should_recheck_periodically(
            self.pane == Pane::Setup,
            self.window_visible,
            &self.setup,
            Instant::now(),
        ) {
            self.load_setup(cx);
        }
        if !self.maybe_auto_refresh(cx) && self.pane == Pane::Doctor && self.window_visible {
            // Keep "Checked N min ago" current.
            cx.notify();
        }
    }

    /// Back from the terminal after an admin step: check setup again while
    /// it is shown or a fix is outstanding.
    fn recheck_setup_on_return(&mut self, cx: &mut Context<Self>) {
        if hack_desktop_core::setup::should_recheck_on_focus(
            self.pane == Pane::Setup,
            self.setup.pending_fix,
            self.setup.loading,
            self.setup.action_busy,
        ) {
            self.load_setup(cx);
        }
    }

    /// While the Doctor or Setup pane is visible, check again every 10
    /// minutes.
    fn start_doctor_refresh(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(60))
                    .await;
                let alive = this.update(cx, |this, cx| this.minute_tick(cx));
                if alive.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    /// Fixtures: show the selected project (after loading doctor).
    pub fn show_project(&mut self) {
        self.pane = Pane::Project;
    }

    /// Apply a fresh snapshot. If it changed the selected project (the old
    /// one disappeared), the Logs tab's stream follows the new selection.
    pub(crate) fn apply_refresh(
        &mut self,
        token: RefreshToken,
        snap: Result<Snapshot, SourceError>,
        cx: &mut Context<Self>,
    ) -> bool {
        let before = self.model.selected_key();
        let previous_root = self.selected_root();
        let runtime_before = self.model.selected_runtime_target();
        let had_service = self.model.selected_service().is_some();
        if !self.model.finish_refresh(token, snap) {
            return false;
        }
        // hackd changed under the stored card (stopped, started, another
        // version): read it again while the pane shows it, else forget it so
        // the sidebar dot follows the project reads.
        let evidence = self.hackd_evidence_key();
        if self.hackd_read && evidence != self.hackd_evidence_seen {
            // Never leave the old card (and its action) up against the new
            // evidence: drop it, and read again while the pane shows it.
            self.hackd_read = false;
            self.hackd_status = None;
            if self.pane == Pane::Hackd {
                self.load_hackd(cx);
            }
        }
        let after = self.model.selected_key();
        let selection_changed = before != after || previous_root != self.selected_root();
        let runtime_changed = runtime_before != self.model.selected_runtime_target();
        if selection_changed || (had_service && self.model.selected_service().is_none()) {
            self.clear_selected_service();
        }
        let invalid_filter = self.logs.model.service.as_ref().is_some_and(|filter| {
            self.model.project_list_readable()
                && self.model.detail().is_none_or(|detail| {
                    !detail
                        .services
                        .iter()
                        .any(|service| &service.name == filter)
                })
        });
        if selection_changed || invalid_filter {
            self.logs.model.set_service(None);
        }
        if selection_changed || self.model.selected_service().is_none() {
            self.sidebar_menu = None;
        }
        if selection_changed {
            // Only accepted snapshots may invalidate a tail or replace a
            // stream. Root/backend changes also change stream ownership.
            self.files = Default::default();
            self.reset_env_selection();
            self.reset_changes(cx);
            self.refresh_copies_if_open(cx);
            self.sync_config_tab(cx);
            if self.tab == 2 {
                self.read_env(cx);
            }
        }
        if self.shows_json_logs() && (selection_changed || invalid_filter || runtime_changed) {
            self.open_logs(cx);
        } else if self.shows_json_logs() {
            // A stopped project's finite read becomes a followed stream once
            // the project runs (started here or elsewhere).
            let running = self.displayed_logs_running();
            if self.logs.model.should_follow_now(running) {
                self.open_logs(cx);
            }
        }
        // A new, removed or moved project (or a project list that becomes
        // readable) makes a shown Doctor result stale, so a visible Doctor
        // pane checks again.
        let current = self.doctor_target_keys();
        self.doctor.targets_seen(current.as_deref());
        self.maybe_auto_refresh(cx);
        self.refresh_update_notice(cx);
        if self.health.follow_ups.has_dismissals() {
            crate::follow_up_view::reconcile(self, &self.model.list());
        }
        cx.notify();
        true
    }

    /// Type into the title bar search (frame sequences).
    #[cfg(feature = "screenshots")]
    pub(crate) fn type_search(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.search
            .update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
        self.filter = text.trim().to_lowercase();
        cx.notify();
    }

    /// Fixtures: select a project by name.
    pub fn select(&mut self, name: &str) {
        self.model.apply(Event::Select(name.to_owned()));
        self.refresh_now();
        self.env.begin();
    }

    /// Select the Env fixture without opening a window.
    pub fn show_env_fixture(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = 2;
        // The CLI does not report a running overlay per instance yet (R22).
        self.env.running = (name == "env-running").then(|| "staging".to_owned());
        self.read_env(cx);
        if name == "env-revealed"
            && let hack_desktop_core::env::EnvView::Report(r) = &self.env.view
            && let Some(row) = r.vars.iter().find(|v| v.key == "APP_MODE").cloned()
        {
            self.toggle_reveal(&row, cx);
        }
        // The editor open on a secret: an empty masked field and the command.
        if name == "env-edit"
            && let hack_desktop_core::env::EnvView::Report(r) = &self.env.view
            && let Some(row) = r.vars.iter().find(|v| v.key == "API_TOKEN").cloned()
        {
            self.open_env_edit(Some(&row), window, cx);
        }
    }

    /// Synthetic search and preview states.
    pub(crate) fn show_catalog_fixture(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tab = 5;
        let query = match name {
            "catalog-empty" => "unlisted",
            "catalog-all" => "",
            _ => "postgres",
        };
        self.catalog
            .input
            .update(cx, |input, cx| input.set_value(query, window, cx));
    }

    /// Fixtures: mark an action as in flight without running it.
    pub fn simulate_in_flight(&mut self, action: Action) {
        if let Some(key) = self.model.detail().map(|d| d.key) {
            self.model.apply(Event::ActionStarted { key, action });
        }
    }

    /// Fixture-only unavailable daemon after a previously readable snapshot.
    pub fn simulate_daemon_unavailable(&mut self, mismatch: bool) {
        self.model.apply(Event::Refreshed(Err(
            hack_desktop_core::source::SourceError::DaemonUnavailable {
                cli: "5.0.0".into(),
                daemon: mismatch.then(|| "4.3.0".into()),
                message: if mismatch {
                    "hackd v4.3.0, CLI v5.0.0: restart hackd"
                } else {
                    "hackd is off or unreachable: start hackd"
                }
                .into(),
                compatible: false,
                shared_with: None,
            },
        )));
    }

    pub(crate) fn selected_root(&self) -> Option<(PathBuf, bool)> {
        let r = self.model.selected_row()?;
        Some((PathBuf::from(r.repo_root.as_ref()?), r.is_native()))
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                let Ok((source, token)) = this.update(cx, |this, _| {
                    (this.source.clone(), this.model.begin_refresh())
                }) else {
                    return;
                };
                let snap = cx
                    .background_executor()
                    .spawn({
                        let source = source.clone();
                        async move { source.listing() }
                    })
                    .await;
                let workers = this
                    .update(cx, |this, cx| {
                        if this.apply_refresh(token, snap, cx) {
                            this.read_pending_native(token, cx)
                        } else {
                            Vec::new()
                        }
                    })
                    .unwrap_or_default();
                // The next poll waits for this one's native reads.
                for worker in workers {
                    worker.await;
                }
                let delay = this
                    .update(cx, |this, _| this.model.poll_interval())
                    .unwrap_or(Duration::from_secs(10));
                cx.background_executor().timer(delay).await;
            }
        })
        .detach();
    }

    pub(crate) fn run_action(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.machine.busy() {
            return;
        }
        let Some(row) = self.model.selected_row() else {
            return;
        };
        let Some(key) = self.model.selected_key() else {
            return;
        };
        let native = row.is_native();
        let Some(root) = row.repo_root.clone().map(PathBuf::from) else {
            return;
        };
        if !self.model.can_start(&key) {
            return;
        }
        let Some(detail) = self.model.detail() else {
            return;
        };
        if !detail.actions.contains(&action) {
            return;
        }
        if action == Action::Open && !detail.runtime_addressable {
            if let Some(url) = detail.url {
                cx.open_url(&url);
            }
            return;
        }
        let compose_project = row
            .compose_project
            .or_else(|| row.runtime.and_then(|rt| rt.project));
        self.model.apply(Event::ActionStarted {
            key: key.clone(),
            action,
        });
        self.action_started.insert(key.clone(), Instant::now());
        cx.notify();
        if !self.live {
            return;
        }
        // Bound to the CLI selected now: a switch before the background
        // task runs cannot make this action run another CLI.
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let branch = key.branch.clone();
                    async move {
                        source.act_on_copy(
                            &root,
                            native,
                            branch.as_deref(),
                            compose_project.as_deref(),
                            action,
                        )
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                // Started under a CLI the app no longer runs: its result
                // belongs to that installation, not to what is shown now.
                if this.model.source_epoch() != epoch {
                    this.action_started.remove(&key);
                    cx.notify();
                    return;
                }
                if let Ok(ActionOutcome::Opened(o)) = &result {
                    cx.open_url(&o.url);
                }
                this.action_started.remove(&key);
                if this.model.apply(Event::ActionFinished {
                    key,
                    action,
                    result,
                }) {
                    this.refresh_now_async(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn can_run_service_action(
        &self,
        detail: &DetailView,
        service: &ServiceView,
        action: Action,
    ) -> bool {
        detail.backend == "compose"
            && detail.runtime_addressable
            && !detail.busy
            && !self.machine.busy()
            && self.model.can_start(&detail.key)
            && service.compose_container
            && match action {
                Action::Restart => true,
                Action::Stop => service.running,
                _ => false,
            }
    }

    pub(crate) fn run_service_action(
        &mut self,
        key: InstanceKey,
        service: &str,
        action: Action,
        cx: &mut Context<Self>,
    ) {
        if self.model.selected_key().as_ref() != Some(&key) {
            return;
        }
        let Some((root, false)) = self.selected_root() else {
            return;
        };
        let valid_service = self.model.detail().is_some_and(|detail| {
            detail
                .services
                .iter()
                .any(|row| row.name == service && self.can_run_service_action(&detail, row, action))
        });
        if !valid_service {
            return;
        }
        if !self.live || !self.model.start_service_action(&key, service) {
            return;
        }
        self.action_started.insert(key.clone(), Instant::now());
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let branch = key.branch.clone();
        let service = service.to_owned();
        let compose_project = self.model.selected_row().and_then(|row| {
            row.compose_project
                .or_else(|| row.runtime.and_then(|rt| rt.project))
        });
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    source.act_on_service(
                        &root,
                        branch.as_deref(),
                        compose_project.as_deref(),
                        &service,
                        action,
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() == epoch {
                    this.action_started.remove(&key);
                    this.model.finish_service_action(key, action, result);
                    this.refresh_now_async(cx);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn refresh_now_async(&mut self, cx: &mut Context<Self>) {
        let source = self.source.clone();
        let token = self.model.begin_refresh();
        cx.spawn(async move |this, cx| {
            let snap = cx
                .background_executor()
                .spawn(async move { source.listing() })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.apply_refresh(token, snap, cx) {
                    for worker in this.read_pending_native(token, cx) {
                        worker.detach();
                    }
                }
            });
        })
        .detach();
    }

    /// Read each native project the shown listing left pending, at most
    /// [`NATIVE_PS_PARALLEL`] at a time, applying each `hack ps` as it
    /// returns ([`AppModel::finish_native`] drops it once a newer read is
    /// shown or an action starts). The tasks end when the queue is empty.
    fn read_pending_native(
        &mut self,
        token: RefreshToken,
        cx: &mut Context<Self>,
    ) -> Vec<Task<()>> {
        let queue = std::rc::Rc::new(std::cell::RefCell::new(std::collections::VecDeque::from(
            self.model.pending_native(),
        )));
        let workers = queue.borrow().len().min(NATIVE_PS_PARALLEL);
        (0..workers)
            .map(|_| {
                let queue = queue.clone();
                let source = self.source.clone();
                cx.spawn(async move |this, cx| {
                    loop {
                        let Some((name, root)) = queue.borrow_mut().pop_front() else {
                            return;
                        };
                        let ps = cx
                            .background_executor()
                            .spawn({
                                let source = source.clone();
                                let root = root.clone();
                                async move { source.native_ps(std::path::Path::new(&root)) }
                            })
                            .await;
                        let applied = this
                            .update(cx, |this, cx| {
                                let applied = this.model.finish_native(token, &name, &root, ps);
                                if applied {
                                    this.native_filled(cx);
                                }
                                applied
                            })
                            .unwrap_or(false);
                        // A newer read or an action superseded this one: the
                        // rest of its queue is stale too.
                        if !applied {
                            return;
                        }
                    }
                })
            })
            .collect()
    }

    /// A native project's state arrived: a shown stopped project's Logs
    /// read follows once it runs, as after a full refresh.
    fn native_filled(&mut self, cx: &mut Context<Self>) {
        if self.tab == 1 {
            let running = self.model.detail().is_some_and(|d| d.state.is_active());
            if self.logs.model.should_follow_now(running) {
                self.open_logs(cx);
            }
        }
        cx.notify();
    }

    /// The last Start / Restart hackd failure, if any.
    pub(crate) fn recovery_error(&self) -> Option<&str> {
        self.recovery_error.as_deref()
    }

    /// Open the hackd pane and read hackd's status.
    pub(crate) fn open_hackd(&mut self, cx: &mut Context<Self>) {
        self.pane = Pane::Hackd;
        self.user_navigated();
        self.load_hackd(cx);
        cx.notify();
    }

    /// Fixtures and screenshots: the hackd pane with its status read.
    pub fn show_hackd_now(&mut self) {
        self.pane = Pane::Hackd;
        self.hackd_status = self.source.daemon_status();
        self.hackd_read = true;
        self.hackd_evidence_seen = self.hackd_evidence_key();
    }

    /// Read `hack daemon status --json` off the UI thread with the CLI
    /// selected now. A read started under another CLI is dropped.
    pub(crate) fn load_hackd(&mut self, cx: &mut Context<Self>) {
        if !self.live {
            self.show_hackd_now();
            cx.notify();
            return;
        }
        if self.hackd_loading {
            return;
        }
        self.hackd_loading = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        // What the project reads said when this read started: an answer
        // that lands after they changed may describe the hackd before.
        let started = self.hackd_evidence_key();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let status = cx
                .background_executor()
                .spawn(async move { source.daemon_status() })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                this.hackd_loading = false;
                if this.hackd_evidence_key() != started {
                    if this.pane == Pane::Hackd {
                        this.load_hackd(cx);
                    } else {
                        this.hackd_read = false;
                        this.hackd_status = None;
                    }
                    cx.notify();
                    return;
                }
                this.hackd_status = status;
                this.hackd_read = true;
                this.hackd_evidence_seen = started;
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn recover_daemon(&mut self, action: DaemonRecovery, cx: &mut Context<Self>) {
        if !self.live {
            return;
        }
        let Some(ticket) = self.machine.try_begin(Holder::Recovery) else {
            return;
        };
        self.recovery_error = None;
        // Starts or restarts the hackd of the CLI selected now, whatever is
        // selected by the time the task runs.
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.recover_daemon(action) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // After a switch the recovery state belongs to the new CLI:
                // leave its guard and error alone.
                if this.model.source_epoch() != epoch {
                    cx.notify();
                    return;
                }
                this.machine.finish(ticket);
                this.recovery_error = result.err();
                // The card shows what hackd says now, not the button's exit.
                if this.pane == Pane::Hackd {
                    this.load_hackd(cx);
                }
                // A command exit is not evidence that a compatible daemon
                // is ready. Only the next ordered snapshot can restore rows.
                this.refresh_now_async(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

impl HackApp {
    /// Palette and fonts for the current light or dark mode.
    pub(crate) fn ui(&self, cx: &App) -> Ui {
        let t = cx.theme();
        Ui {
            p: Palette::for_mode(if t.is_dark() { Mode::Dark } else { Mode::Light }),
            font: t.font_family.clone(),
            mono: t.mono_font_family.clone(),
        }
    }

    /// Whether a project row (or one of its branch instances) matches the
    /// title bar's filter. An empty filter matches everything.
    pub(crate) fn matches(&self, r: &Row) -> bool {
        self.filter.is_empty()
            || r.name.to_lowercase().contains(&self.filter)
            || r.branches
                .iter()
                .any(|b| b.branch.to_lowercase().contains(&self.filter))
            || self.model.project_has_service_match(&r.name, &self.filter)
    }

    pub(crate) fn select_instance(&mut self, key: InstanceKey, cx: &mut Context<Self>) {
        self.model.apply(Event::SelectInstance(key));
        self.after_select(cx);
    }

    pub(crate) fn select_project(&mut self, name: String, cx: &mut Context<Self>) {
        self.model.apply(Event::Select(name));
        self.after_select(cx);
    }

    /// Everything a selection change resets: the pane, the env read, the
    /// Logs tab's stream and its service filter.
    /// Another instance: its own overlays and scopes, nothing revealed.
    /// Explicit selections and refreshes that change the selection both
    /// come through here, so a new project is never listed with the last
    /// one's overlay or scope.
    fn reset_env_selection(&mut self) {
        self.env_edit = None;
        self.env_saved = None;
        self.env.env = None;
        self.env.scope = None;
        self.env.running = None;
        self.env.begin();
    }

    pub(crate) fn after_select(&mut self, cx: &mut Context<Self>) {
        self.sidebar_menu = None;
        self.pane = Pane::Project;
        self.clear_selected_service();
        self.files = Default::default();
        self.user_navigated();
        self.copied = None;
        self.reset_env_selection();
        self.reset_changes(cx);
        if self.tab == 2 {
            self.read_env(cx);
        }
        if !self.live {
            self.refresh_now();
        }
        self.refresh_copies_if_open(cx);
        self.sync_config_tab(cx);
        // A service filter belongs to one project: reset it on every
        // project change, whichever tab is open.
        self.logs.model.set_service(None);
        if self.tab == 1 {
            self.open_logs(cx);
        }
        cx.notify();
    }

    pub(crate) fn set_tab(&mut self, to: usize, cx: &mut Context<Self>) {
        self.clear_selected_service();
        self.user_navigated();
        let from = self.tab;
        if from == to {
            return;
        }
        self.tab = to;
        #[cfg(hack_terminal)]
        if matches!(to, 1 | crate::config_view::TAB) {
            self.collapse_detail_terminal(cx);
        }
        self.files = Default::default();
        self.refresh_copies_if_open(cx);
        self.sync_config_tab(cx);
        self.env_edit = None;
        self.env.begin();
        if to == 1 {
            self.open_logs(cx);
        } else if from == 1 {
            self.logs.close();
        }
        if to == 2 {
            self.read_env(cx);
        }
        cx.notify();
    }

    /// The status bar, naming the Hack CLI the app runs (`hack-next
    /// 5.0.0-next.19 · prerelease`) and offering another install when one
    /// was found (HACK-2283).
    fn status_bar_with_cli(
        &self,
        list: &ListView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let choice = self.source.cli_choice();
        let version = self.cli_label_for(list);
        let other = choice.as_ref().and_then(|c| c.others().next().cloned());
        let p = ui.p;
        status_bar(self.status_items(list), version, ui).children(other.map(|o| {
            let label = format!("Use {} ({})", o.name, o.channel.label());
            div()
                .id("use-other-cli")
                .ml(space::S5)
                .cursor_pointer()
                .text_color(p.accent)
                .hover(|d| d.underline())
                .child(label)
                .on_click(cx.listener(move |this, _, window, cx| this.use_cli(&o.path, window, cx)))
        }))
    }

    /// The status bar's CLI label: `hack-next 5.0.0-next.19 · prerelease`.
    fn cli_label_for(&self, list: &ListView) -> Option<String> {
        let selected = self.source.cli_choice().and_then(|c| c.selected);
        list.cli_version.clone().map(|v| match &selected {
            Some(i) => format!("{} {v} · {}", i.name, i.channel.label()),
            None => format!("hack {v}"),
        })
    }

    /// The CLI label the status bar shows now (`--drive`).
    #[cfg_attr(not(hack_terminal), allow(dead_code))]
    pub(crate) fn cli_label(&self) -> Option<String> {
        self.cli_label_for(&self.model.list())
    }

    /// Run another Hack CLI from now on (saved for next launch), and read
    /// its hackd.
    ///
    /// The switch is an ownership boundary: the other CLI has its own
    /// hackd, registry and homes. Everything read from or started through
    /// the previous one is dropped (the snapshot, reads in flight, Env,
    /// Doctor, the Logs stream and the terminal tabs) before the new CLI's
    /// first read.
    pub(crate) fn use_cli(
        &mut self,
        path: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let before = self.source.cli_choice().and_then(|c| c.selected);
        let result = self.source.use_cli(path);
        let after = self.source.cli_choice().and_then(|c| c.selected);
        if let Err(why) = result {
            // Saving the choice can fail after the switch itself applied.
            self.recovery_error = Some(why);
        }
        if before != after {
            self.clear_selected_service();
            self.model.source_changed();
            self.config.switch_cli(after.map(|install| install.path));
            self.changes = Default::default();
            self.action_started.clear();
            self.copies = Default::default();
            // A Start or Restart hackd still running belongs to the
            // previous installation: it must not block this one.
            self.machine.reset();
            self.recovery_error = None;
            // hackd's status was the previous CLI's.
            self.hackd_status = None;
            self.hackd_read = false;
            self.hackd_loading = false;
            if self.pane == Pane::Hackd {
                self.load_hackd(cx);
            }
            // The upgrade and usage reads were the previous CLI's.
            self.upgrade = crate::upgrade_view::UpgradePane::default();
            self.usage = None;
            self.reset_stats_source();
            if self.pane == Pane::Upgrade {
                self.load_upgrade(cx);
            }
            self.logs.close();
            self.env.begin();
            self.doctor.source_changed();
            self.health = Default::default();
            // Setup's report and bound commands were the previous CLI's.
            self.setup.source_changed();
            if self.pane == Pane::Setup {
                self.load_setup(cx);
            } else if self.pane == Pane::Doctor {
                self.load_doctor(cx);
            }
            #[cfg(hack_terminal)]
            self.close_all_terminals(window, cx);
            if self.pane == Pane::Project {
                self.sync_config_tab(cx);
            }
        }
        let _ = window;
        self.refresh_now_async(cx);
        cx.notify();
    }

    pub(crate) fn copy_url(&mut self, url: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(url));
        self.copied = Some(Instant::now());
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1600))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this
                    .copied
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(1500))
                {
                    this.copied = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn title_bar(&self, ui: &Ui, projects_open: bool) -> impl IntoElement {
        let p = ui.p;
        let background = if projects_open {
            p.chrome
        } else {
            p.title_bar()
        };
        gpui_kit::component::TitleBar::new()
            .h(size::TITLE_BAR)
            .bg(background)
            .border_color(p.border)
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .type_step(text::BODY_STRONG)
                            .text_color(p.text_primary)
                            .child("Hack"),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("search")
                            .w(size::SEARCH_W)
                            .h(px(24.))
                            .rounded(radius::CONTROL)
                            .bg(p.surface)
                            .hairline(p.border_strong)
                            .child(
                                Input::new(&self.search)
                                    .appearance(false)
                                    .small()
                                    .cleanable(true)
                                    .prefix(hack_desktop_ui::components::icon(
                                        Glyph::Search,
                                        size::ICON,
                                        p.text_muted,
                                    )),
                            ),
                    )
                    .child(div().w(space::S6)),
            )
    }

    fn sidebar(&self, list: &ListView, ui: &Ui, cx: &mut Context<Self>) -> impl IntoElement {
        let p = ui.p;
        let mut projects = div()
            .id("projects")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .px(space::S3)
            .pb(space::S4);
        match &list.phase {
            Phase::Loading => {
                projects = projects.child(caption("Projects", ui));
                for (i, w) in [120., 96., 132.].into_iter().enumerate() {
                    projects = projects.child(
                        div()
                            .id(("skeleton", i))
                            .h(size::ROW)
                            .px(space::S5)
                            .flex()
                            .items_center()
                            .gap(space::S4)
                            .child(div().size(size::DOT).rounded_full().bg(p.surface_1))
                            .child(skeleton(w, ui)),
                    );
                }
            }
            Phase::Ready => {
                projects = projects.child(self.project_tree(list, ui, cx));
            }
            Phase::Empty | Phase::CliMissing | Phase::Error { .. } => {}
        }
        let routing = self.routing_status();
        let hackd = self.hackd_sidebar_status();
        let machine = div()
            .flex_none()
            .flex()
            .flex_col()
            .px(space::S3)
            .pb(space::S4)
            .child(caption("Machine", ui))
            .child(
                machine_row(
                    "routing",
                    Glyph::Globe,
                    "Routing and DNS",
                    dot(routing, ui),
                    ui,
                )
                .aria_label(format!(
                    "Routing and DNS: {}",
                    machine_status_label(routing)
                ))
                .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx)))
                .map(|row| {
                    #[cfg(all(test, feature = "screenshots", hack_terminal))]
                    let row = row.test_support();
                    row
                }),
            )
            .child(
                machine_row("hackd", Glyph::Power, "hackd", dot(hackd, ui), ui)
                    .aria_label(format!("hackd: {}", machine_status_label(hackd)))
                    .when(self.pane == Pane::Hackd, |d| d.bg(p.selection))
                    .on_click(cx.listener(|this, _, _, cx| this.open_hackd(cx)))
                    .map(|row| {
                        #[cfg(all(test, feature = "screenshots", hack_terminal))]
                        let row = row.test_support();
                        row
                    }),
            )
            .child(
                machine_row(
                    "upgrade",
                    Glyph::Upgrade,
                    "Upgrade",
                    dot(self.upgrade_status(), ui),
                    ui,
                )
                .when(self.pane == Pane::Upgrade, |d| d.bg(p.selection))
                .on_click(cx.listener(|this, _, _, cx| this.open_upgrade(cx))),
            )
            .child(
                machine_row(
                    "doctor",
                    Glyph::Stethoscope,
                    "Doctor",
                    self.doctor_trailing(list, ui),
                    ui,
                )
                .when(self.pane == Pane::Doctor, |d| d.bg(p.selection))
                .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
            );
        div()
            .w(size::SIDEBAR)
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .bg(p.chrome)
            .when(self.pane != Pane::Project, |sidebar| {
                sidebar.hairline_r(p.border)
            })
            .child(projects)
            .child(machine)
    }

    fn hackd_sidebar_status(&self) -> Status {
        if self.pane == Pane::Setup
            && let Some(card) = self
                .setup
                .report
                .cards
                .iter()
                .find(|card| card.id == "daemon")
        {
            return evidence_status(card.status).0;
        }
        self.hackd_card()
            .map(|card| card.tone)
            .or_else(|| self.hackd_tone_from_snapshot())
            .map_or(Status::Unknown, crate::machine_view::status_of)
    }

    /// Setup owns its visible cards and dots. Elsewhere use the newest
    /// current report, ordered by read start so a slow older Doctor run
    /// cannot replace a post-command Setup check.
    fn routing_status(&self) -> Status {
        let setup = routing_evidence(&self.setup.report).map(|s| evidence_status(s).0);
        if self.pane == Pane::Setup
            && let Some(status) = setup
        {
            return status;
        }

        let now = Instant::now();
        let setup = setup.zip(self.setup.observed_at).filter(|_| {
            self.setup.checked_at.is_some_and(|at| {
                now.saturating_duration_since(at) < hack_desktop_core::setup::RECHECK_EVERY
            })
        });
        let doctor = self.doctor.fresh_observation(now);
        if let Some((status, start)) = setup
            && doctor.is_none_or(|other| start >= other)
        {
            return status;
        }
        if doctor.is_some() {
            return match &self.doctor.result {
                DoctorStateView::Loaded(view) => routing_from_doctor(view),
                _ => None,
            }
            .unwrap_or(Status::Unknown);
        }
        self.model
            .snapshot()
            .filter(|_| self.model.project_list_readable())
            .and_then(|snapshot| snapshot.doctor.as_ref())
            .and_then(|report| {
                hack_desktop_ui::window::routing_status(
                    report
                        .checks
                        .iter()
                        .map(|c| (c.id.as_str(), c.status.as_str())),
                )
            })
            .unwrap_or(Status::Unknown)
    }

    /// The Doctor row's trailing mark (see [`doctor_mark`]).
    fn doctor_trailing(&self, list: &ListView, ui: &Ui) -> AnyElement {
        if !self.doctor.stale
            && let DoctorStateView::Loaded(v) = &self.doctor.result
        {
            let count = crate::doctor_view::attention_count(self, v);
            if count > 0 {
                return count_pill(count, ui).into_any_element();
            }
        }
        match doctor_mark(&self.doctor, list) {
            DoctorMark::Count(n) => count_pill(n, ui).into_any_element(),
            DoctorMark::Dot(s) => dot(s, ui).into_any_element(),
        }
    }

    fn header(
        &self,
        list: &ListView,
        d: &DetailView,
        compact: bool,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = ui.p;
        let status = Status::of(&d.state);
        let mut actions = div().flex().items_center().gap(space::S3);
        for a in [Action::Open, Action::Restart, Action::Stop, Action::Start] {
            if !d.actions.contains(&a) {
                continue;
            }
            let enabled = !d.busy && !self.machine.busy();
            let (glyph, id) = match a {
                Action::Open => (Glyph::ExternalLink, "open"),
                Action::Restart => (Glyph::Restart, "restart"),
                Action::Stop => (Glyph::Stop, "stop"),
                Action::Start => (Glyph::Play, "start"),
            };
            let button = if a == Action::Start && enabled {
                primary_button(id, glyph, a.label(), ui)
            } else {
                action_button(id, glyph, a.label(), enabled, ui)
            };
            actions = actions.child(if enabled {
                button.on_click(cx.listener(move |this, _, _, cx| this.run_action(a, cx)))
            } else {
                button
            });
        }
        if !compact {
            actions = actions.child(self.copy_menu(ui, cx));
        }
        let project = list
            .running
            .iter()
            .chain(&list.stopped)
            .find(|row| row.key.project == d.name);
        let branch = project.and_then(|row| row.branches.iter().find(|b| b.key == d.key));
        let root = branch.and_then(|b| b.checkout.as_deref()).or_else(|| {
            project
                .filter(|_| d.branch.is_none())
                .and_then(|row| row.root.as_deref())
        });
        let title = if compact {
            d.name.clone()
        } else {
            branch.map_or_else(|| "main".into(), |b| b.branch.clone())
        };
        let kind = branch.map_or(d.backend.as_str(), |b| {
            if b.worktree { "worktree" } else { "branch" }
        });
        let breadcrumb = root.map_or_else(
            || format!("{} · {kind}", d.name),
            |root| {
                format!(
                    "{} · {kind} · {}",
                    d.name,
                    crate::sidebar_view::short_path(root)
                )
            },
        );
        let daemon_banner = list
            .banners
            .iter()
            .any(|b| matches!(b, Banner::DaemonOff | Banner::DaemonMismatch { .. }));
        let reason = match (&d.state, &d.last_error) {
            (_, Some(e)) => Some(format!("Last action failed: {e}")),
            (ProjectState::NeedsAttention { reason }, None) => Some(reason.clone()),
            // A daemon banner already explains an unobserved project.
            (ProjectState::Unknown { reason }, None) if !daemon_banner => Some(reason.clone()),
            _ => None,
        };
        let url_row = div()
            .flex()
            .items_center()
            .gap(space::S3)
            .min_h(px(22.))
            .children(d.url.clone().map(|u| {
                let copied = self.copied.is_some();
                let to_copy = u.clone();
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .child(
                        div()
                            .font_family(ui.mono.clone())
                            .type_step(text::MONO)
                            .text_color(p.text_secondary)
                            .child(u),
                    )
                    .child(
                        icon_button(
                            "copy-url",
                            if copied { Glyph::Check } else { Glyph::Copy },
                            ui,
                        )
                        .tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(if copied {
                                "Copied"
                            } else {
                                "Copy URL"
                            })
                            .build(window, cx)
                        })
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.copy_url(to_copy.clone(), cx)),
                        ),
                    )
            }))
            .child(div().flex_1())
            .child(always_on_switch(d.always_on, Some(ALWAYS_ON_REASON), ui));
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .when(!compact, |header| {
                header.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .text_color(p.text_muted)
                        .child(hack_desktop_ui::components::icon(
                            Glyph::Container,
                            size::ICON,
                            p.text_muted,
                        ))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(ui.mono.clone())
                                .type_step(text::MONO)
                                .child(breadcrumb),
                        ),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .child(
                        div()
                            .type_step(if compact {
                                text::BODY_STRONG
                            } else {
                                text::TITLE
                            })
                            .text_color(p.text_primary)
                            .child(title),
                    )
                    .children(d.branch.clone().filter(|_| compact).map(|b| {
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .type_step(text::BODY)
                            .text_color(p.text_secondary)
                            .child(hack_desktop_ui::components::icon(
                                Glyph::Branch,
                                size::ICON,
                                p.text_muted,
                            ))
                            .child(b)
                    }))
                    .child(if compact {
                        state_pill(status, project_label(&d.state), ui)
                    } else {
                        let running = d.services.iter().filter(|s| s.running).count();
                        let label = if matches!(d.state, ProjectState::Running { .. })
                            && !d.services.is_empty()
                        {
                            format!("Running · {running} of {}", d.services.len())
                        } else {
                            d.state.label()
                        };
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .px(space::S3)
                            .rounded(radius::CONTROL)
                            .hairline(p.border)
                            .type_step(text::SMALL)
                            .text_color(p.text_secondary)
                            .child(dot(status, ui))
                            .child(label)
                    })
                    .when(compact, |row| {
                        row.child(neutral_pill(d.backend.clone(), ui))
                    })
                    .children(self.usage_total_label().filter(|_| !compact).map(|t| {
                        div()
                            .type_step(text::SMALL)
                            .text_color(p.text_secondary)
                            .child(t)
                    }))
                    .child(div().flex_1())
                    .child(if self.tab == crate::config_view::TAB && !compact {
                        self.config_checkout_picker(cx)
                    } else {
                        actions.into_any_element()
                    }),
            )
            .when(!compact, |col| {
                col.child(url_row).children(
                    self.changes_badge(ui)
                        .map(|badge| div().flex().child(badge)),
                )
            })
            .children(
                d.always_on_note
                    .clone()
                    .filter(|_| !compact)
                    .map(|(tone, note)| {
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S3)
                            .type_step(text::BODY)
                            .text_color(p.text_secondary)
                            .child(dot(crate::machine_view::status_of(tone), ui))
                            .child(note)
                    }),
            )
            .children((!compact).then_some(()).and(reason).map(|r| {
                let c = if status == Status::Failed {
                    p.states.failed.fg
                } else {
                    p.text_secondary
                };
                div().type_step(text::BODY).text_color(c).child(r)
            }))
            .children(
                (!compact)
                    .then(|| self.doctor_link(&d.name, ui, cx))
                    .flatten(),
            )
            .children(
                (!compact)
                    .then(|| self.slow_action_warning(&d.key))
                    .flatten()
                    .map(|w| {
                        div()
                            .type_step(text::BODY)
                            .text_color(p.states.degraded.fg)
                            .child(w)
                    }),
            )
            .children(d.note.clone().filter(|_| !compact).map(|n| {
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .child(n)
            }))
    }

    /// "Doctor: N findings for this project", linking to the Doctor pane
    /// filtered on the project. A link only: it never changes the state pill.
    fn doctor_link(&self, project: &str, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let n = self.doctor.findings_for(project);
        if n == 0 {
            return None;
        }
        let name = project.to_owned();
        Some(
            div()
                .id("doctor-link")
                .type_step(text::BODY)
                .text_color(ui.p.accent)
                .cursor_pointer()
                .hover(|d| d.underline())
                .child(format!(
                    "Doctor: {n} finding{} for this project",
                    if n == 1 { "" } else { "s" }
                ))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_doctor(Some(name.clone()), cx);
                }))
                .into_any_element(),
        )
    }

    fn remote_targets(d: &DetailView, ui: &Ui) -> Option<gpui_kit::Div> {
        if d.remotes.is_empty() {
            return None;
        }
        let p = ui.p;
        Some(
            div()
                .pt(space::S6)
                .flex()
                .flex_col()
                .child(
                    div()
                        .pb(space::S3)
                        .type_step(text::SMALL_STRONG)
                        .text_color(p.text_secondary)
                        .child("Remote targets"),
                )
                .children(d.remotes.iter().map(|remote| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S2)
                        .py(space::S4)
                        .hairline_t(p.border)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(space::S3)
                                .child(
                                    div()
                                        .type_step(text::BODY_STRONG)
                                        .child(remote.service.clone()),
                                )
                                .child(neutral_pill(remote.target.clone(), ui))
                                .child(neutral_pill(remote.probe.clone(), ui)),
                        )
                        .child(
                            div()
                                .type_step(text::MONO)
                                .font_family(ui.mono.clone())
                                .text_color(p.text_secondary)
                                .child(remote.address_label()),
                        )
                        .child(
                            div()
                                .type_step(text::SMALL)
                                .text_color(p.text_secondary)
                                .child(remote.state.clone()),
                        )
                })),
        )
    }

    fn detail(
        &mut self,
        list: &ListView,
        d: &DetailView,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let _ = &window;
        let rows: Vec<ServiceRow> = d
            .services
            .iter()
            .map(|s| {
                let usage = self.shown_usage();
                let row = usage
                    .and_then(|u| u.rows.as_ref().ok())
                    .and_then(|rows| rows.get(&s.name));
                let native = self.model.selected_row().is_some_and(|r| r.is_native());
                let usage_note = if native {
                    crate::usage_view::NATIVE_NOTE
                } else if !s.running {
                    crate::usage_view::NOT_RUNNING_NOTE
                } else {
                    match usage.map(|u| &u.rows) {
                        None => hack_desktop_ui::components::UNKNOWN_USAGE,
                        Some(Err(_)) => "Usage could not be read (is Docker running?)",
                        Some(Ok(_)) => crate::usage_view::NO_VALUE_NOTE,
                    }
                };
                ServiceRow {
                    name: s.name.clone(),
                    status: Status::of_service(s),
                    state: service_label(s),
                    cpu: row
                        .filter(|_| s.running)
                        .and_then(|r| r.cpu_percent)
                        .map(hack_desktop_core::usage::cpu),
                    memory: row
                        .filter(|_| s.running)
                        .and_then(|r| r.mem_used_bytes)
                        .map(hack_desktop_core::usage::bytes),
                    memory_note: row
                        .and_then(|r| r.mem_limit_bytes)
                        .map(|l| format!("limit {}", hack_desktop_core::usage::bytes(l))),
                    usage_note,
                    emulated: usage.is_some_and(|u| u.emulated.contains(&s.name)),
                    route: s.route.clone().ok_or_else(|| "internal".to_owned()),
                }
            })
            .collect();
        let mut tabs = div().flex().items_center().gap(space::S7).children(
            [
                (0, "Services"),
                (1, "Logs"),
                (2, "Env"),
                (3, "Copies"),
                (crate::config_view::TAB, "Config"),
                (6, "Changes"),
                (5, "Add service"),
                (crate::files_view::FILES_TAB, "Files"),
            ]
            .into_iter()
            .map(|(i, label)| {
                let selected = self.tab == i;
                div()
                    .id(("detail-tab", i))
                    .pb(space::S2)
                    .border_b_2()
                    .border_color(if selected {
                        ui.p.text_primary
                    } else {
                        gpui_kit::transparent_black()
                    })
                    .type_step(if selected {
                        text::BODY_STRONG
                    } else {
                        text::BODY
                    })
                    .text_color(if selected {
                        ui.p.text_primary
                    } else {
                        ui.p.text_secondary
                    })
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| this.set_tab(i, cx)))
                    .child(label)
            }),
        );
        if self.tab == crate::files_view::FILES_TAB {
            tabs = tabs.child(self.project_files_picker(d, cx));
        }
        let body: AnyElement = match self.tab {
            crate::config_view::TAB => self.config_view(ui, window, cx),
            5 => div()
                .id("service-catalog")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(space::S8)
                .pb(space::S5)
                .child(self.service_catalog(d, ui, cx))
                .into_any_element(),
            6 => self.changes_view(ui, cx).into_any_element(),
            crate::files_view::FILES_TAB => {
                self.project_files(d, ui, window, cx).into_any_element()
            }
            3 => self.copies_view(ui, cx).into_any_element(),
            1 => {
                // The Logs tab scrolls inside its own virtualized list.
                let names: Vec<String> = d.services.iter().map(|s| s.name.clone()).collect();
                self.render_logs(&names, cx).into_any_element()
            }
            2 => div()
                .id("detail-body")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(space::S8)
                .pb(space::S5)
                .child(self.env_tab(ui, cx))
                .into_any_element(),
            _ => div()
                .id("detail-body")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(space::S8)
                .pb(space::S5)
                .child(if rows.is_empty() {
                    div()
                        .pt(space::S5)
                        .type_step(text::BODY)
                        .text_color(ui.p.text_muted)
                        .child("No services reported for this project")
                } else {
                    services_table_with_rows(&rows, ui, |row, service| {
                        let key = d.key.clone();
                        let service = service.name.clone();
                        let p = ui.p;
                        row.cursor_pointer()
                            .hover(move |d| d.bg(p.surface_1))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_service(key.clone(), service.clone(), window, cx);
                            }))
                    })
                })
                .children(self.other_copies(list, d, ui, cx))
                .children(Self::remote_targets(d, ui))
                .into_any_element(),
        };
        #[cfg(hack_terminal)]
        let (maximized, panel) = if self.panels.command.visible() {
            (false, None)
        } else {
            (
                self.panels.maximized(&d.key),
                Some(self.terminal_area(d, ui, window, cx)),
            )
        };
        #[cfg(not(hack_terminal))]
        let (maximized, panel): (bool, Option<AnyElement>) = (false, None);
        div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(space::S8)
                    .pt(if maximized { space::S5 } else { space::S7 })
                    .pb(space::S5)
                    .when(maximized, |d| d.hairline_b(ui.p.border))
                    .child(self.header(list, d, maximized, ui, cx)),
            )
            .when(!maximized, |col| {
                col.child(div().px(space::S8).pb(space::S3).child(tabs))
                    .child(body)
            })
            .children(panel)
    }

    /// Shown, never acted on, once an action has run past
    /// `LiveSource::LIFECYCLE_WARN_AFTER`.
    fn slow_action_warning(&self, key: &InstanceKey) -> Option<String> {
        let started = self.action_started.get(key)?;
        (started.elapsed() >= hack_desktop_core::source::LiveSource::LIFECYCLE_WARN_AFTER).then(|| {
            "Still running after 6 hours. Hack owns this command and its timeouts; the app has not stopped it.".to_owned()
        })
    }

    fn status_items(&self, list: &ListView) -> Vec<(Option<Status>, String)> {
        if list.cli_version.is_none() {
            return vec![(None, "not connected".into())];
        }
        let c = list.counts;
        let always_on = list
            .running
            .iter()
            .chain(&list.stopped)
            .filter(|r| r.always_on)
            .count();
        let mut items = vec![];
        if c.unknown > 0 && c.running == 0 {
            items.push((None, format!("{} not observed", c.unknown)));
        } else {
            items.push((None, format!("{} running", c.running)));
        }
        items.push((None, format!("{always_on} always on")));
        let banners = &list.banners;
        let engine = if !self.model.engine_observed() {
            (Status::Unknown, "engine unknown")
        } else if banners
            .iter()
            .any(|b| matches!(b, Banner::EngineDown { .. }))
        {
            (Status::Failed, "engine down")
        } else {
            (Status::Running, "engine ok")
        };
        items.push((Some(engine.0), engine.1.into()));
        if banners.iter().any(|b| matches!(b, Banner::DaemonOff)) {
            items.push((Some(Status::Stopped), "hackd off".into()));
        } else if banners
            .iter()
            .any(|b| matches!(b, Banner::DaemonMismatch { .. }))
        {
            items.push((Some(Status::Degraded), "hackd mismatch".into()));
        }
        items
    }
}

fn machine_status_label(status: Status) -> &'static str {
    match status {
        Status::Running => "Passed",
        Status::Degraded => "Needs attention",
        Status::Failed => "Failed",
        Status::Unknown => "Unknown",
        Status::Busy => "In progress",
        Status::Stopped => "Off",
    }
}

impl HackApp {
    #[cfg(hack_terminal)]
    fn stats_tab_open(&self) -> bool {
        self.pane == Pane::Project
            && self.selected_service().is_some()
            && self.service_pane.tab == crate::service_view::ServiceTab::Stats
    }

    /// The panel's window-level handlers: drag the handle, and the panel
    /// actions wherever focus is.
    #[cfg(hack_terminal)]
    fn terminal_handlers(
        &self,
        root: gpui_kit::Stateful<gpui_kit::Div>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        use hack_desktop_term::actions::{
            CloseTab, NewTab, NextTab, PrevTab, ToggleMaximize, TogglePanel,
        };
        root.on_mouse_move(
            cx.listener(|this, ev: &gpui_kit::MouseMoveEvent, window, cx| {
                if this.panels.dragging {
                    if ev.pressed_button != Some(gpui_kit::MouseButton::Left) {
                        this.panels.dragging = false;
                        return;
                    }
                    this.drag_to(f32::from(ev.position.y), window, cx);
                }
            }),
        )
        .on_mouse_up(
            gpui_kit::MouseButton::Left,
            cx.listener(|this, _, _, _| this.panels.dragging = false),
        )
        .on_action(cx.listener(|this, _: &TogglePanel, window, cx| {
            if !this.toggle_command_drawer(window, cx) {
                this.toggle_visible_panel(window, cx);
            }
        }))
        .on_action(cx.listener(|this, _: &ToggleMaximize, _, cx| {
            if this.panels.command.visible() {
                this.make_command_taller(cx);
            } else if !this.stats_tab_open() {
                this.toggle_maximize(cx);
            }
        }))
        .on_action(cx.listener(
            |this, _: &crate::command_control::MakeCommandTaller, _, cx| {
                this.make_command_taller(cx);
            },
        ))
        .on_action(cx.listener(|this, _: &NewTab, window, cx| {
            if !this.panels.command.visible() {
                this.terminal_new_tab(window, cx);
            }
        }))
        .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
            if this.panels.command.visible() {
                this.close_command_drawer(cx);
            } else if !this.stats_tab_open() {
                this.close_active_tab(window, cx);
            }
        }))
        .on_action(cx.listener(|this, _: &NextTab, window, cx| {
            if !this.panels.command.visible() && !this.stats_tab_open() {
                this.step_tab(true, window, cx);
            }
        }))
        .on_action(cx.listener(|this, _: &PrevTab, window, cx| {
            if !this.panels.command.visible() && !this.stats_tab_open() {
                this.step_tab(false, window, cx);
            }
        }))
    }

    #[cfg(not(hack_terminal))]
    fn terminal_handlers(
        &self,
        root: gpui_kit::Stateful<gpui_kit::Div>,
        _: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        root
    }
}

impl Render for HackApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(hack_terminal)]
        self.reconcile_terminal_targets(window, cx);
        let list = self.model.list();
        let mut ui = self.ui(cx);
        let projects_open = self.pane == Pane::Project && list.phase == Phase::Ready;
        if projects_open {
            ui.p = Palette::projects(ui.p.mode);
        }
        if self.model.selected_service().is_none() || self.pane != Pane::Project {
            self.sidebar_menu = None;
        }
        let p = ui.p;
        self.sync_service_logs(cx);
        #[cfg(hack_terminal)]
        self.reconcile_selected_service_panel(window, cx);
        let follow_up = if self.pane == Pane::Project {
            crate::follow_up_view::render(self, &list, &ui, cx)
        } else {
            crate::follow_up_view::reconcile(self, &list);
            None
        };
        let main: AnyElement = match &list.phase {
            _ if self.pane == Pane::BannersSheet => crate::health_fixtures::banners(&ui, cx),
            _ if self.pane == Pane::ErrorsSheet => {
                crate::health_fixtures::errors(self, &ui, window, cx)
            }
            // Setup applies whatever the project list shows, a missing CLI
            // included.
            _ if self.pane == Pane::Hackd => crate::machine_view::render(self, &ui, cx),
            _ if self.pane == Pane::Upgrade => crate::upgrade_view::render(self, &ui, cx),
            _ if self.pane == Pane::Setup => crate::setup_view::render(self, &ui, cx),
            // Machine checks matter most before any project exists, so the
            // Doctor pane renders for an empty registry too.
            // Diagnostics are most useful when the project list fails.
            _ if self.pane == Pane::Doctor => crate::doctor_view::render(self, &ui, window, cx),
            Phase::CliMissing => empty_pane(
                Glyph::CircleAlert,
                "Hack CLI not found",
                "The app runs the hack command for everything. Install it, then reopen the app.",
                Some("brew install hack-dance/tap/hack"),
                &ui,
            )
            .into_any_element(),
            Phase::Error { code, message } => empty_pane(
                Glyph::CircleAlert,
                "Could not read projects",
                format!("{message} ({code})"),
                self.model
                    .daemon_recovery()
                    .is_none()
                    .then_some("hack projects --json"),
                &ui,
            )
            .into_any_element(),
            Phase::Empty => empty_pane(
                Glyph::Folder,
                "No projects yet",
                "Set up a repository with Hack and it shows up here.",
                Some("cd your-repo && hack init"),
                &ui,
            )
            .into_any_element(),
            Phase::Loading => {
                empty_pane(Glyph::Loader, "Loading projects…", "", None, &ui).into_any_element()
            }
            Phase::Ready => match self.model.detail() {
                Some(d) if self.selected_service().is_some() => {
                    self.service_detail(&d, &ui, window, cx)
                }
                Some(d) => self.detail(&list, &d, &ui, window, cx).into_any_element(),
                None => {
                    empty_pane(Glyph::Folder, "Select a project", "", None, &ui).into_any_element()
                }
            },
        };
        #[cfg(hack_terminal)]
        let command_drawer = self.render_command_drawer(&ui, cx);
        #[cfg(not(hack_terminal))]
        let command_drawer: Option<AnyElement> = None;
        let sheet = matches!(self.pane, Pane::BannersSheet | Pane::ErrorsSheet);
        let right_pane = div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .when(
                        self.health.fixture.is_some()
                            || self.pane == Pane::Doctor
                            || follow_up.is_some(),
                        |main| {
                            main.mx(space::S4)
                                .my(space::S2)
                                .rounded(radius::PANEL)
                                .hairline(p.border)
                        },
                    )
                    .when(
                        projects_open
                            && follow_up.is_none()
                            && self.health.fixture.is_none()
                            && self.selected_service().is_none(),
                        |main| {
                            main.mr(space::S4)
                                .bg(p.surface)
                                .rounded(radius::PANEL)
                                .hairline(p.border)
                        },
                    )
                    .children(follow_up)
                    .child(main),
            )
            .children(command_drawer);
        div()
            .id("hack-window")
            .key_context("HackWindow")
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| {
                this.search.update(cx, |s, cx| s.focus(window, cx));
            }))
            .map(|root| self.service_handlers(root, cx))
            .map(|root| self.terminal_handlers(root, cx))
            .size_full()
            .flex()
            .flex_col()
            .bg(if projects_open { p.chrome } else { p.window })
            .text_color(p.text_primary)
            .font_family(ui.font.clone())
            .child(self.title_bar(&ui, projects_open))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(!sheet, |d| d.child(self.sidebar(&list, &ui, cx)))
                    .child(right_pane),
            )
            .when(!sheet, |d| {
                d.child(self.status_bar_with_cli(&list, &ui, cx))
            })
    }
}

/// What the sidebar's Doctor row shows at its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DoctorMark {
    /// Findings from a current run.
    Count(usize),
    Dot(Status),
}

/// The Doctor row's mark. A completed run decides it: its findings as a
/// count, or a dot in the run's tone, which is green only when every run
/// finished clean and nothing changed since (`DoctorPane::tone`). Without a
/// run, the snapshot's machine checks; a ring while nothing has reported.
fn doctor_mark(pane: &DoctorPane, list: &ListView) -> DoctorMark {
    use hack_desktop_core::state::Tone;
    let tone = |t: Tone| match t {
        Tone::Ok => Status::Running,
        Tone::Warn | Tone::Busy => Status::Degraded,
        Tone::Error => Status::Failed,
        Tone::Idle => Status::Unknown,
    };
    match &pane.result {
        DoctorStateView::Loaded(v) if !pane.stale && v.attention_count() > 0 => {
            DoctorMark::Count(v.attention_count())
        }
        DoctorStateView::Loaded(_) | DoctorStateView::Error(_) => {
            DoctorMark::Dot(tone(pane.tone()))
        }
        DoctorStateView::NeverRun => match (list.doctor_known, list.doctor_count) {
            (true, n) if n > 0 => DoctorMark::Count(n),
            (true, _) => DoctorMark::Dot(Status::Running),
            (false, _) => DoctorMark::Dot(Status::Unknown),
        },
    }
}

/// Routing and DNS from a completed Doctor run: the worst finding in its
/// Routing and DNS or Certificates areas; green when the machine was
/// checked and none was found; `None` when the machine was not checked.
fn routing_from_doctor(v: &hack_desktop_core::doctor::DoctorView) -> Option<Status> {
    use hack_desktop_core::doctor::{Area, Severity};
    let rank = |s: Status| match s {
        Status::Failed => 3,
        Status::Degraded => 2,
        _ => 1,
    };
    let worst = v
        .groups
        .iter()
        .filter(|(area, _)| matches!(area, Area::RoutingDns | Area::Certificates))
        .flat_map(|(_, cards)| cards)
        .map(|c| match c.severity {
            Severity::Error => Status::Failed,
            Severity::Warn => Status::Degraded,
            Severity::CouldNotCheck => Status::Unknown,
        })
        .max_by_key(|s| rank(*s));
    worst.or_else(|| v.machine_checked.then_some(Status::Running))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hack_desktop_core::doctor::aggregate;
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;

    fn loaded(f: Fixture) -> DoctorPane {
        let source = FixtureSource(f);
        let targets = source
            .snapshot()
            .ok()
            .map(|s| DoctorTarget::from_projects(&s.projects))
            .unwrap_or_default();
        let keys = target_keys(&targets);
        let mut pane = DoctorPane::default();
        let generation = pane.begin(Some(&keys));
        pane.finish(
            generation,
            &source.doctor_runs(&targets),
            Some(&keys),
            Instant::now(),
        );
        pane
    }

    fn list(f: Fixture) -> ListView {
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(FixtureSource(f).snapshot()));
        m.list()
    }

    #[cfg(all(feature = "screenshots", hack_terminal))]
    #[test]
    fn stats_keeps_the_hidden_shell_open_and_selected() {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{HeadlessAppContext, WindowOptions};
        use hack_desktop_term::actions::CloseTab;
        use hack_desktop_term::launch::{Launch, SessionKind, SessionPlan};
        use hack_desktop_term::pty::PtyOptions;
        use hack_desktop_term::terminal::{Status, TerminalCore};
        use hack_desktop_term::view::TerminalView;

        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let (handle, app) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        focus: false,
                        show: false,
                        ..crate::window_options()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let mut app = HackApp::new(
                                Arc::new(FixtureSource(Fixture::Usage)),
                                false,
                                window,
                                cx,
                            );
                            app.select("storefront");
                            app
                        })
                    },
                )
            })
            .unwrap();

        let (sessions, shell) = cx
            .update_window(handle, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.ensure_panel(window, cx);
                    let key = app.model.selected_key().unwrap();
                    let sessions = app.panels.by_key[&key].sessions.clone();
                    let mut options = PtyOptions::new("/bin/sh")
                        .arg("-c")
                        .arg("IFS= read -r line");
                    options.env_clear = true;
                    let core = TerminalCore::session(SessionPlan {
                        attempts: vec![Launch {
                            kind: SessionKind::HostShell { shell: "sh".into() },
                            options,
                        }],
                    })
                    .unwrap();
                    let shell = cx.new(|cx| TerminalView::from_core(core, cx));
                    sessions.update(cx, |panel, cx| panel.add_tab(shell.clone(), window, cx));
                    app.select_service(key, "api".into(), window, cx);
                    app.set_service_tab(crate::service_view::ServiceTab::Stats, window, cx);
                    app.search.update(cx, |search, cx| search.focus(window, cx));
                    (sessions, shell)
                })
            })
            .unwrap();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.dispatch_action(Box::new(CloseTab), cx);
        })
        .unwrap();
        cx.run_until_parked();

        cx.update_window(handle, |_, window, cx| {
            app.update(cx, |app, cx| {
                assert!(app.stats_tab_open());
                app.clear_selected_service();
                cx.notify();
            });
            window.render_frame(cx);
            assert_eq!(sessions.read(cx).active(), Some(&shell));
            assert_eq!(shell.read(cx).status(), &Status::Running);
            window.dispatch_action(Box::new(CloseTab), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update(|cx| assert_eq!(sessions.read(cx).tab_count(), 1));
    }

    #[test]
    fn routing_follows_the_completed_doctor_run() {
        let DoctorStateView::Loaded(v) = &loaded(Fixture::Doctor).result else {
            panic!("doctor fixture loads");
        };
        assert_eq!(
            routing_from_doctor(v),
            Some(Status::Failed),
            "resolver error"
        );
        let DoctorStateView::Loaded(v) = &loaded(Fixture::DoctorClean).result else {
            panic!("doctor-clean fixture loads");
        };
        assert_eq!(routing_from_doctor(v), Some(Status::Running));
        let empty = aggregate(&[]);
        assert_eq!(routing_from_doctor(&empty), None, "machine not checked");
    }

    #[test]
    fn the_doctor_row_is_green_only_for_a_clean_current_run() {
        let clean = loaded(Fixture::DoctorClean);
        let l = list(Fixture::DoctorClean);
        assert_eq!(doctor_mark(&clean, &l), DoctorMark::Dot(Status::Running));
        // A project appears after the run: the result is stale, not green.
        let mut stale = clean;
        stale.targets_seen(Some(&[]));
        assert!(stale.stale);
        assert_ne!(doctor_mark(&stale, &l), DoctorMark::Dot(Status::Running));
        // Findings: a count.
        let found = loaded(Fixture::Doctor);
        assert!(
            matches!(doctor_mark(&found, &list(Fixture::Doctor)), DoctorMark::Count(n) if n > 0)
        );
        // Never run: the snapshot decides; nothing reported is a ring.
        let never = DoctorPane::default();
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Err(SourceError::Pending)));
        assert_eq!(
            doctor_mark(&never, &m.list()),
            DoctorMark::Dot(Status::Unknown)
        );
    }
}

#[cfg(all(test, feature = "screenshots", hack_terminal))]
mod machine_status_render_tests {
    use super::*;
    use crate::command_control::screenshots::tests::{assert_rendered_status, open};
    use hack_desktop_core::models::{DoctorCheck, DoctorReport};
    use hack_desktop_core::{
        doctor::{DoctorRun, Finish},
        setup::Status,
    };

    #[test]
    fn rendered_dns_tracks_a_fresh_setup_check_and_rejects_older_and_stale_reads() {
        let (mut cx, window, app) = open(1);
        assert_rendered_status(
            &mut cx,
            window,
            "routing",
            "Routing and DNS: Needs attention",
            Some("Needs attention"),
        );
        let warn = DoctorRun::machine(Ok(DoctorReport {
            checks: vec![DoctorCheck {
                id: "resolver:hack".into(),
                status: "warn".into(),
                detail: "Resolver missing".into(),
                fix: None,
            }],
            ..Default::default()
        }));
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let older_doctor = a.doctor.begin(Some(&[]));
                let stale_setup = a.setup.begin();
                let generation = a.setup.begin();
                let before = a.setup.report.clone();
                let mut after = before.clone();
                after.cards[1].status = Status::Passed;
                a.setup_checked(generation, after, cx);
                a.setup_checked(stale_setup, before, cx);
                assert_eq!(
                    a.doctor.finish(
                        older_doctor,
                        std::slice::from_ref(&warn),
                        Some(&[]),
                        Instant::now()
                    ),
                    Finish::Applied
                );
            })
        });
        assert_rendered_status(
            &mut cx,
            window,
            "routing",
            "Routing and DNS: Passed",
            Some("Passed"),
        );

        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.show_project();
                cx.notify();
            })
        });
        assert_rendered_status(&mut cx, window, "routing", "Routing and DNS: Passed", None);

        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let newer_doctor = a.doctor.begin(None);
                assert_eq!(
                    a.doctor.finish(
                        newer_doctor,
                        std::slice::from_ref(&warn),
                        Some(&[]),
                        Instant::now()
                    ),
                    Finish::AppliedStale
                );
                cx.notify();
            })
        });
        assert_rendered_status(&mut cx, window, "routing", "Routing and DNS: Passed", None);

        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let newer_doctor = a.doctor.begin(Some(&[]));
                assert_eq!(
                    a.doctor
                        .finish(newer_doctor, &[warn], Some(&[]), Instant::now()),
                    Finish::Applied
                );
                cx.notify();
            })
        });
        assert_rendered_status(
            &mut cx,
            window,
            "routing",
            "Routing and DNS: Needs attention",
            None,
        );
    }
}

/// The live refresh path in a window: list first, then each native `ps`.
#[cfg(all(test, feature = "screenshots"))]
mod native_fill_tests {
    use super::*;
    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::{self, Fixture};
    use hack_desktop_core::models::{LogEntry, NativePs};
    use hack_desktop_core::source::{FixtureSource, LogFeed};
    use std::path::Path;
    use std::sync::Mutex;

    /// Fixture data, with `storefront` native: `listing` leaves it pending,
    /// `native_ps` reports it stopped. Records every read, in order.
    struct Listing {
        calls: Mutex<Vec<String>>,
    }

    impl Listing {
        fn snapshot_with(&self, pending: bool) -> Result<Snapshot, SourceError> {
            let mut s = fixtures::snapshot(Fixture::Running)?;
            for row in &mut s.projects.projects {
                if row.name == "storefront" {
                    row.backend = Some("native".into());
                    row.repo_root = Some("/work/storefront".into());
                    row.native_pending = pending;
                }
            }
            Ok(s)
        }
        fn log(&self, call: &str) {
            self.calls.lock().unwrap().push(call.to_owned());
        }
    }

    impl Source for Listing {
        fn snapshot(&self) -> Result<Snapshot, SourceError> {
            self.log("snapshot");
            self.snapshot_with(false)
        }
        fn listing(&self) -> Result<Snapshot, SourceError> {
            self.log("listing");
            self.snapshot_with(true)
        }
        fn native_ps(&self, repo_root: &Path) -> Option<NativePs> {
            self.log(&format!("ps {}", repo_root.display()));
            Some(NativePs {
                status: "not_started".into(),
                items: vec![],
            })
        }
        fn act(
            &self,
            repo_root: &Path,
            native: bool,
            branch: Option<&str>,
            action: Action,
        ) -> Result<ActionOutcome, SourceError> {
            FixtureSource(Fixture::Running).act(repo_root, native, branch, action)
        }
        fn log_tail(
            &self,
            repo_root: &Path,
            native: bool,
            branch: Option<&str>,
            lines: u32,
        ) -> Result<Vec<LogEntry>, String> {
            FixtureSource(Fixture::Running).log_tail(repo_root, native, branch, lines)
        }
        fn doctor_runs(
            &self,
            projects: &[DoctorTarget],
        ) -> Vec<hack_desktop_core::doctor::DoctorRun> {
            FixtureSource(Fixture::Running).doctor_runs(projects)
        }
        fn open_logs(
            &self,
            repo_root: &Path,
            native: bool,
            branch: Option<&str>,
            args: &[String],
        ) -> Result<Box<dyn LogFeed>, String> {
            FixtureSource(Fixture::Running).open_logs(repo_root, native, branch, args)
        }
    }

    #[test]
    fn a_refresh_lists_first_and_then_reads_each_native_project() {
        let source = Arc::new(Listing {
            calls: Mutex::new(Vec::new()),
        });
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| HackApp::new(source.clone(), false, window, cx))
                })
            })
            .unwrap();
        source.calls.lock().unwrap().clear();
        cx.update(|cx| app.update(cx, |a, cx| a.refresh_now_async(cx)));
        cx.run_until_parked();
        assert_eq!(
            *source.calls.lock().unwrap(),
            vec!["listing".to_owned(), "ps /work/storefront".to_owned()],
            "the window lists without native ps, then reads each native project once"
        );
        let state = cx.update(|cx| {
            let a = app.read(cx);
            assert!(a.model.pending_native().is_empty());
            a.model
                .snapshot()
                .and_then(|s| {
                    s.projects
                        .projects
                        .iter()
                        .find(|p| p.name == "storefront")
                        .cloned()
                })
                .and_then(|p| p.native)
                .map(|n| n.status)
        });
        assert_eq!(
            state.as_deref(),
            Some("not_started"),
            "applied when it returned"
        );
    }
}
