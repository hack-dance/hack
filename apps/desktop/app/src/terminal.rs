//! The terminal panel (feature `terminal`; DESIGN-V1.md, "Terminal panel"):
//! an edge-to-edge panel docked at the bottom of the detail pane, one per
//! project or branch instance, with a drag handle, a tab strip and the
//! terminal.
//!
//! The `term` crate owns the PTYs, the emulator and session teardown
//! (`TerminalPanel`, embedded here so the app draws the design v1 chrome and
//! handles the panel actions). The app owns each PTY and runs the CLI in it:
//!
//! | Tab | What runs, in the instance's checkout |
//! |---|---|
//! | Logs (first, not closable) | `hack logs [--branch b] [--no-follow] --tail 500`, read-only |
//! | Shell in a service | `hack exec [--branch b] <service> -- bash`, then `sh` |
//! | Host shell | the user's login shell |
//! | Host shell with env | `hack host shell --env <overlay> --scope <scope>` |
//!
//! It passes subcommands, validated names and a shell name only. It never
//! builds an environment and never sees a value: it sets the terminal's
//! identity (`TERM`, `COLORTERM`, `TERM_PROGRAM`) and, for a CLI tab, the
//! instance's backend (`HACK_RUNTIME_BACKEND=native|compose`), the same
//! selector the core passes on every CLI call, so a shell or log stream
//! targets the instance's own backend.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, App, ClickEvent, Context, Entity, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, Window, div, prelude::*, px, relative,
};
use hack_desktop_core::viewmodel::{DetailView, InstanceKey};
use hack_desktop_term::ghostty_config::{ConfigEnv, GhosttyLook};
use hack_desktop_term::launch::{
    self, HackCli, Launch, LoginShell, Name, SessionKind, SessionPlan, TermChoice,
};
use hack_desktop_term::panel::TerminalPanel;
use hack_desktop_term::pty::PtyOptions;
use hack_desktop_term::stream::StreamSource;
use hack_desktop_term::terminal::TerminalCore;
use hack_desktop_term::view::{Status as TermStatus, TerminalView};
use hack_desktop_ui::components::{StyledExt as _, Ui, icon};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::panel::{PanelState, TabKind};
use hack_desktop_ui::tokens::{TermPalette, panel as tok, radius, size, space, text};

use crate::view::HackApp;

/// Lines of history the Logs tab asks for when it opens.
const LOG_TAIL: &str = "500";
/// Scrollback of a file-backed Logs tab (fixtures, notes).
const NOTE_SCROLLBACK: usize = 1_000;
/// The panel never gets smaller than its handle and strip plus a few rows.
const MIN_OPEN: f32 = 0.12;

/// One instance's panel.
pub struct ProjectPanel {
    /// Owns every tab's session; drawn embedded (active terminal only).
    pub sessions: Entity<TerminalPanel>,
    pub state: PanelState,
    pub menu: Menu,
    /// The checkout and backend the tabs were started in. When the
    /// instance's checkout changes (a branch recreated from another
    /// worktree), its sessions are ended and the panel starts again.
    origin: Option<(PathBuf, bool)>,
    /// Whether the instance was running when last drawn.
    was_active: bool,
    /// Whether the Logs session follows (`hack logs` without
    /// `--no-follow`). A running instance whose Logs tab does not follow is
    /// given a following one; a following stream that fails is not
    /// restarted in a loop. Stopping the instance clears it, so the next
    /// start follows again.
    logs_follow: bool,
}

/// The new-tab menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Closed,
    Main,
    /// "Host shell with env…": overlay and scope choices.
    Env,
}

/// What a click in the new-tab menu opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewTab {
    Logs,
    Container(String),
    Host,
    HostWithEnv {
        overlay: String,
        scope: String,
        is_default: bool,
    },
}

/// Every panel of the window, by instance.
#[derive(Default)]
pub struct Panels {
    pub by_key: HashMap<InstanceKey, ProjectPanel>,
    look: Option<GhosttyLook>,
    /// The handle is being dragged.
    pub dragging: bool,
    /// Why the last tab could not start, shown in the strip until the next
    /// tab starts.
    pub error: Option<String>,
}

impl Panels {
    pub fn maximized(&self, key: &InstanceKey) -> bool {
        self.by_key
            .get(key)
            .is_some_and(|p| p.state == PanelState::Maximized)
    }
}

fn tab_kind(kind: &SessionKind) -> TabKind {
    match kind {
        SessionKind::Logs => TabKind::Logs,
        SessionKind::ContainerShell { service, shell } => TabKind::ContainerShell {
            service: service.clone(),
            shell: shell.clone(),
        },
        SessionKind::HostShell { shell } => TabKind::HostShell {
            shell: shell.clone(),
        },
        SessionKind::HostShellWithEnv {
            shell,
            overlay,
            scope,
            is_default,
        } => TabKind::HostShellWithEnv {
            shell: shell.clone(),
            overlay: overlay.clone(),
            scope: scope.clone(),
            is_default: *is_default,
        },
    }
}

/// Select the instance's backend for every attempt of a CLI plan.
fn with_backend(mut plan: SessionPlan, native: bool) -> SessionPlan {
    let backend = if native { "native" } else { "compose" };
    for attempt in &mut plan.attempts {
        attempt
            .options
            .env
            .push(("HACK_RUNTIME_BACKEND".into(), backend.into()));
    }
    plan
}

/// `--branch <b>` for a branch instance, as validated names.
fn branch_args(branch: Option<&str>) -> Result<Vec<OsString>, String> {
    match branch {
        None => Ok(vec![]),
        Some(b) => {
            let name = Name::new(b).map_err(|e| format!("branch {b:?}: {}", e.0))?;
            Ok(vec!["--branch".into(), name.as_str().into()])
        }
    }
}

/// The Logs tab: `hack logs` on an app-owned PTY, so it prints exactly what
/// it prints in a terminal (colours included), read-only.
pub fn logs_plan(
    hack: &Path,
    root: &Path,
    branch: Option<&str>,
    follow: bool,
) -> Result<SessionPlan, String> {
    let mut options = PtyOptions::new(hack);
    options.env = launch::terminal_identity("xterm-256color");
    options.cwd = Some(root.to_owned());
    let mut args: Vec<OsString> = vec!["logs".into()];
    args.extend(branch_args(branch)?);
    if !follow {
        args.push("--no-follow".into());
    }
    args.extend(["--tail".into(), LOG_TAIL.into()]);
    options.args = args;
    Ok(SessionPlan {
        attempts: vec![Launch {
            kind: SessionKind::Logs,
            options,
        }],
    })
}

/// A shell in a service container: `hack exec [--branch b] <service> --
/// bash`, then `sh`.
pub fn container_plan(
    hack: &Path,
    root: &Path,
    branch: Option<&str>,
    service: &str,
) -> Result<SessionPlan, String> {
    let name = Name::new(service).map_err(|e| format!("service {service:?}: {}", e.0))?;
    let mut plan = launch::container_shell(
        &HackCli {
            program: hack.to_owned(),
            project_root: root.to_owned(),
        },
        &name,
    );
    let extra = branch_args(branch)?;
    for attempt in &mut plan.attempts {
        // After the subcommand: `exec --branch <b> <service> -- <shell>`.
        for (i, arg) in extra.iter().enumerate() {
            attempt.options.args.insert(1 + i, arg.clone());
        }
    }
    Ok(plan)
}

/// A host shell with an env overlay: the CLI injects the values.
pub fn host_env_plan(
    hack: &Path,
    root: &Path,
    overlay: &str,
    scope: &str,
    is_default: bool,
) -> Result<SessionPlan, String> {
    let overlay = Name::new(overlay).map_err(|e| format!("overlay {overlay:?}: {}", e.0))?;
    let scope = Name::new(scope).map_err(|e| format!("scope {scope:?}: {}", e.0))?;
    Ok(launch::host_shell_with_env(
        &HackCli {
            program: hack.to_owned(),
            project_root: root.to_owned(),
        },
        &LoginShell::detect(),
        &overlay,
        &scope,
        is_default,
        TermChoice::default(),
    ))
}

/// "Host shell with env…" choices: each overlay × each scope, names only.
/// The overlays are the project's default and the effective one; with no
/// named overlay (only `hack.env.default.yaml`), the base environment
/// (`--env base`). The badge warns unless the overlay is the default.
pub fn env_choices(
    selection: &hack_desktop_core::env::EnvSelection,
    scopes: &[String],
    selected_scope: Option<&str>,
) -> Result<Vec<(String, NewTab)>, String> {
    let mut overlays = selection.overlays();
    let base_only = overlays.is_empty();
    if base_only {
        overlays.push("base".into());
    }
    let mut scopes = scopes.to_vec();
    if scopes.is_empty() {
        scopes.extend(selected_scope.map(str::to_owned));
    }
    if scopes.is_empty() {
        return Err("No env scope reported".into());
    }
    let mut out = Vec::new();
    for overlay in &overlays {
        for scope in &scopes {
            out.push((
                format!("env {overlay} · {scope}"),
                NewTab::HostWithEnv {
                    overlay: overlay.clone(),
                    scope: scope.clone(),
                    is_default: base_only || selection.default.as_deref() == Some(overlay.as_str()),
                },
            ));
        }
    }
    Ok(out)
}

/// A read-only tab showing `text` (fixtures, and notes such as "native
/// projects have no log stream here"). The file is removed once open.
fn note_core(text: &str) -> std::io::Result<TerminalCore> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "hack-desktop-note-{}-{}.log",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, text)?;
    let core = TerminalCore::stream(&StreamSource::File(path.clone()), NOTE_SCROLLBACK);
    let _ = std::fs::remove_file(&path);
    core
}

impl HackApp {
    fn instance_root(&self) -> Option<(PathBuf, bool, Option<String>)> {
        let row = self.model.selected_row()?;
        Some((
            PathBuf::from(row.repo_root.as_ref()?),
            row.is_native(),
            row.branch.clone(),
        ))
    }

    /// Create the selected instance's panel (with its Logs tab) the first
    /// time it is shown.
    pub(crate) fn ensure_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.model.detail() else {
            return;
        };
        if self.panels.by_key.contains_key(&d.key) {
            return;
        }
        let sessions = cx.new(|cx| {
            let mut p = TerminalPanel::new(cx);
            p.set_embedded(true, cx);
            p
        });
        cx.observe(&sessions, |_, _, cx| cx.notify()).detach();
        self.panels.by_key.insert(
            d.key.clone(),
            ProjectPanel {
                sessions,
                state: PanelState::half(),
                menu: Menu::Closed,
                origin: self.instance_root().map(|(root, native, _)| (root, native)),
                was_active: d.state.is_active(),
                logs_follow: false,
            },
        );
        self.open_tab(&d, NewTab::Logs, window, cx);
    }

    /// Keep the selected instance's panel in step with the snapshot: a new
    /// checkout ends the old sessions and starts again; a stopped instance
    /// that now runs gets a followed Logs stream (once per transition, so a
    /// stream that keeps failing is not restarted on every frame).
    fn reconcile_panel(&mut self, d: &DetailView, window: &mut Window, cx: &mut Context<Self>) {
        let origin = self.instance_root().map(|(root, native, _)| (root, native));
        let active = d.state.is_active();
        let Some(panel) = self.panels.by_key.get_mut(&d.key) else {
            return;
        };
        let moved = panel.origin != origin;
        if panel.was_active && !active {
            // Stopped: whatever stream it had is over; follow on next start.
            panel.logs_follow = false;
        }
        panel.was_active = active;
        let follow_now = active && !panel.logs_follow;
        if moved {
            panel.origin = origin;
            let sessions = panel.sessions.clone();
            sessions.update(cx, |s, cx| {
                for i in (0..s.tab_count()).rev() {
                    s.close(i, window, cx);
                }
            });
            self.open_tab(d, NewTab::Logs, window, cx);
        } else if follow_now {
            // A finite read (started while stopped), running or ended:
            // replace it with a following stream, in the background.
            self.start_tab(d, NewTab::Logs, true, window, cx);
        }
    }

    fn look(&mut self, cx: &App) -> GhosttyLook {
        use gpui_kit::component::ActiveTheme as _;
        self.panels
            .look
            .get_or_insert_with(|| {
                GhosttyLook::load(&ConfigEnv::from_process(), cx.theme().is_dark())
            })
            .clone()
    }

    fn core_for(&self, d: &DetailView, tab: &NewTab) -> Result<TerminalCore, String> {
        let hack = self.source.hack_program();
        let root = self.instance_root();
        let io = |e: std::io::Error| e.to_string();
        match tab {
            NewTab::Logs => match (&hack, &root) {
                (_, Some((_, true, _))) => note_core(&format!(
                    "{}\r\n",
                    hack_desktop_core::source::NATIVE_LOGS_NOTE
                ))
                .map_err(io),
                (Some(hack), Some((root, false, branch))) => TerminalCore::session(with_backend(
                    logs_plan(hack, root, branch.as_deref(), d.state.is_active())?,
                    false,
                ))
                .map_err(io),
                // Fixtures: the fixture's log lines, as a service prints them.
                _ if !self.live => note_core(&self.fixture_log_text()).map_err(io),
                (None, _) => {
                    note_core("The hack CLI was not found, so logs cannot be read.\r\n").map_err(io)
                }
                (_, None) => {
                    note_core("This instance has no checkout the app can read logs from.\r\n")
                        .map_err(io)
                }
            },
            NewTab::Container(service) => {
                let (Some(hack), Some((root, native, branch))) = (&hack, &root) else {
                    return Err("A shell in a service needs the hack CLI.".into());
                };
                TerminalCore::session(with_backend(
                    container_plan(hack, root, branch.as_deref(), service)?,
                    *native,
                ))
                .map_err(io)
            }
            NewTab::Host => {
                let root = root
                    .map(|(r, _, _)| r)
                    .filter(|r| r.is_dir())
                    .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                    .ok_or("No folder to start the shell in")?;
                TerminalCore::session(launch::host_shell(
                    &root,
                    &LoginShell::detect(),
                    TermChoice::default(),
                ))
                .map_err(io)
            }
            NewTab::HostWithEnv {
                overlay,
                scope,
                is_default,
            } => {
                let (Some(hack), Some((root, native, _))) = (&hack, &root) else {
                    return Err("A host shell with env needs the hack CLI.".into());
                };
                TerminalCore::session(with_backend(
                    host_env_plan(hack, root, overlay, scope, *is_default)?,
                    *native,
                ))
                .map_err(io)
            }
        }
    }

    /// Fixture log lines with the colours a service prints (fixtures only).
    fn fixture_log_text(&self) -> String {
        const COLORS: [&str; 4] = ["36", "35", "34", "32"];
        let mut out = String::new();
        for e in
            hack_desktop_core::fixtures::log_tail(hack_desktop_core::fixtures::Fixture::Running)
        {
            let svc = e.service.clone().unwrap_or_default();
            let c = COLORS[svc.bytes().map(usize::from).sum::<usize>() % COLORS.len()];
            let msg = match e.level.as_deref() {
                Some("error" | "fatal") => format!("\x1b[31m{}\x1b[0m", e.message),
                Some("warn" | "warning") => format!("\x1b[33m{}\x1b[0m", e.message),
                _ => e.message.clone(),
            };
            out.push_str(&format!(
                "\x1b[2m{}\x1b[0m \x1b[{c}m{svc:<7}|\x1b[0m {msg}\r\n",
                e.timestamp.clone().unwrap_or_default()
            ));
        }
        out
    }

    /// Open a tab in the selected instance's panel and show it.
    pub(crate) fn open_tab(
        &mut self,
        d: &DetailView,
        tab: NewTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.start_tab(d, tab, false, window, cx);
    }

    /// Open a tab. `quiet`: work the user did not ask for (a Logs stream
    /// restarted in the background); it replaces the tab in place and never
    /// changes the active tab, focus, the menu or a collapsed panel.
    fn start_tab(
        &mut self,
        d: &DetailView,
        tab: NewTab,
        quiet: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let core = self.core_for(d, &tab);
        let look = self.look(cx);
        let Some(panel) = self.panels.by_key.get_mut(&d.key) else {
            return;
        };
        if tab == NewTab::Logs {
            // Recorded whether or not the stream starts: a failed start is
            // shown and retried by a click on the tab or the next start,
            // never on every frame.
            panel.logs_follow = d.state.is_active();
        }
        if !quiet {
            panel.menu = Menu::Closed;
            if panel.state == PanelState::Collapsed {
                panel.state = PanelState::half();
            }
        }
        let sessions = panel.sessions.clone();
        let core = match core {
            Ok(core) => {
                self.panels.error = None;
                core
            }
            // The Logs tab always exists: when its stream cannot start, it
            // says why, and a click on it tries again (its note has ended).
            Err(why) if tab == NewTab::Logs => {
                let note =
                    format!("Logs could not start: {why}\r\nClick the Logs tab to try again.\r\n");
                match note_core(&note) {
                    Ok(core) => {
                        self.panels.error = Some(why);
                        core
                    }
                    Err(e) => {
                        self.panels.error = Some(format!("{why} ({e})"));
                        cx.notify();
                        return;
                    }
                }
            }
            Err(why) => {
                self.panels.error = Some(why);
                cx.notify();
                return;
            }
        };
        let view = cx.new(|cx| {
            let mut v = TerminalView::from_core(core, cx);
            v.set_look(look, cx);
            v
        });
        if tab == NewTab::Logs && quiet && sessions.read(cx).tab_count() > 0 {
            sessions.update(cx, |p, cx| p.replace_in_place(0, view, cx));
        } else if tab == NewTab::Logs && sessions.read(cx).tab_count() > 0 {
            sessions.update(cx, |p, cx| p.replace(0, view, window, cx));
        } else {
            sessions.update(cx, |p, cx| p.add_tab(view, window, cx));
        }
        cx.notify();
    }

    /// Restart the Logs tab when its stream has ended (a project that was
    /// stopped and now runs, or a stream that exited).
    pub(crate) fn refresh_logs_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.model.detail() else {
            return;
        };
        let Some(panel) = self.panels.by_key.get(&d.key) else {
            return;
        };
        let ended = panel
            .sessions
            .read(cx)
            .tab(0)
            .is_some_and(|v| matches!(v.read(cx).status(), TermStatus::Ended(_)));
        if ended {
            self.open_tab(&d, NewTab::Logs, window, cx);
        }
    }

    /// Pump every open terminal until it is quiet (offscreen renders).
    #[cfg(feature = "screenshots")]
    pub(crate) fn settle_terminals(&mut self, cx: &mut Context<Self>) {
        let views: Vec<Entity<TerminalView>> = self
            .panels
            .by_key
            .values()
            .flat_map(|p| {
                let s = p.sessions.read(cx);
                (0..s.tab_count())
                    .filter_map(|i| s.tab(i).cloned())
                    .collect::<Vec<_>>()
            })
            .collect();
        for v in views {
            v.update(cx, |v, cx| {
                v.settle(
                    std::time::Duration::from_millis(150),
                    std::time::Duration::from_secs(3),
                    cx,
                );
            });
        }
    }

    fn set_state(&mut self, key: &InstanceKey, state: PanelState, cx: &mut Context<Self>) {
        if let Some(p) = self.panels.by_key.get_mut(key) {
            p.state = state;
            p.menu = Menu::Closed;
            cx.notify();
        }
    }

    pub(crate) fn toggle_panel(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.model.selected_key() else {
            return;
        };
        let next = match self.panels.by_key.get(&key).map(|p| p.state) {
            Some(PanelState::Collapsed) => PanelState::half(),
            Some(_) => PanelState::Collapsed,
            None => return,
        };
        self.set_state(&key, next, cx);
    }

    pub(crate) fn toggle_maximize(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.model.selected_key() else {
            return;
        };
        let next = match self.panels.by_key.get(&key).map(|p| p.state) {
            Some(PanelState::Maximized) => PanelState::half(),
            Some(_) => PanelState::Maximized,
            None => return,
        };
        self.set_state(&key, next, cx);
    }

    pub(crate) fn open_menu(&mut self, menu: Menu, cx: &mut Context<Self>) {
        let Some(key) = self.model.selected_key() else {
            return;
        };
        if menu == Menu::Env {
            // Overlay and scope names come from `hack env list --json`.
            self.read_env(cx);
        }
        if let Some(p) = self.panels.by_key.get_mut(&key) {
            p.menu = if p.menu == menu { Menu::Closed } else { menu };
            if p.state == PanelState::Collapsed {
                p.state = PanelState::half();
            }
            cx.notify();
        }
    }

    pub(crate) fn close_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        // The Logs tab (first) is not closable.
        if index == 0 {
            return;
        }
        if let Some(p) = self
            .model
            .selected_key()
            .and_then(|k| self.panels.by_key.get(&k))
        {
            p.sessions
                .clone()
                .update(cx, |s, cx| s.close(index, window, cx));
        }
    }

    pub(crate) fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let active = self
            .model
            .selected_key()
            .and_then(|k| self.panels.by_key.get(&k))
            .and_then(|p| p.sessions.read(cx).active_index());
        if let Some(i) = active {
            self.close_tab(i, window, cx);
        }
    }

    pub(crate) fn step_tab(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = self
            .model
            .selected_key()
            .and_then(|k| self.panels.by_key.get(&k))
        {
            p.sessions.clone().update(cx, |s, cx| {
                if forward {
                    s.next_tab(window, cx);
                } else {
                    s.prev_tab(window, cx);
                }
            });
        }
    }

    /// Follow the handle while it is dragged: the panel takes the space
    /// below the pointer. Near the top it maximizes; below the strip it
    /// collapses.
    pub(crate) fn drag_to(&mut self, y: f32, window: &Window, cx: &mut Context<Self>) {
        let Some(key) = self.model.selected_key() else {
            return;
        };
        let height = f32::from(window.viewport_size().height);
        let top = f32::from(size::TITLE_BAR);
        let bottom = height - f32::from(size::STATUS_BAR);
        let area = (bottom - top).max(1.);
        let fraction = (bottom - y) / area;
        let strip = (f32::from(tok::HANDLE) + f32::from(tok::STRIP)) / area;
        let state = if y <= top + 24. {
            PanelState::Maximized
        } else if fraction <= strip + 0.02 {
            PanelState::Collapsed
        } else {
            PanelState::Open {
                fraction_milli: (fraction.clamp(MIN_OPEN, 0.95) * 1000.) as u16,
            }
        };
        if let Some(p) = self.panels.by_key.get_mut(&key)
            && p.state != state
        {
            p.state = state;
            cx.notify();
        }
    }

    /// The new-tab menu's entries: a shell in each running service, a host
    /// shell, and a host shell with env.
    pub(crate) fn menu_entries(&self, d: &DetailView) -> Vec<(String, Glyph, Option<NewTab>)> {
        let cli = self.source.hack_program().is_some();
        let mut out: Vec<(String, Glyph, Option<NewTab>)> = d
            .services
            .iter()
            .filter(|s| s.running)
            .map(|s| {
                (
                    format!("Shell in {}", s.name),
                    Glyph::Container,
                    cli.then(|| NewTab::Container(s.name.clone())),
                )
            })
            .collect();
        if !out.is_empty() {
            out.push((String::new(), Glyph::HostShell, None));
        }
        out.push(("Host shell".into(), Glyph::HostShell, Some(NewTab::Host)));
        out
    }

    /// Overlay and scope choices for "Host shell with env…", names only.
    pub(crate) fn env_entries(&self) -> Result<Vec<(String, NewTab)>, String> {
        use hack_desktop_core::env::EnvView;
        if self.source.hack_program().is_none() {
            return Err("Needs the hack CLI".into());
        }
        let report = match &self.env.view {
            EnvView::Report(r) => r,
            EnvView::Loading => return Err("Reading overlays…".into()),
            EnvView::Unreadable => return Err("Could not read env overlays".into()),
        };
        env_choices(
            &report.env_selection.clone().unwrap_or_default(),
            &report.scopes,
            report.selected_scope.as_deref(),
        )
    }

    fn menu(&self, d: &DetailView, menu: Menu, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let p = ui.p;
        let mut m = div()
            .id("term-menu")
            .occlude()
            .w(px(240.))
            .max_h(tok::MENU_MAX_H)
            .overflow_y_scroll()
            .py(space::S2)
            .rounded(radius::PANEL)
            .bg(p.surface)
            .hairline(p.border_strong)
            .shadow_lg()
            .type_step(text::BODY)
            .text_color(p.text_primary);
        let row = |id: SharedString, glyph: Glyph, label: String, enabled: bool| {
            div()
                .id(id)
                .mx(space::S2)
                .h(size::ROW)
                .px(space::S4)
                .flex()
                .items_center()
                .gap(space::S4)
                .rounded(radius::CONTROL)
                .text_color(if enabled {
                    p.text_primary
                } else {
                    p.text_muted
                })
                .when(enabled, |d| {
                    d.cursor_pointer().hover(move |d| d.bg(p.surface_1))
                })
                .child(icon(glyph, size::ICON, p.text_secondary))
                .child(label)
        };
        match menu {
            Menu::Main | Menu::Closed => {
                for (i, (label, glyph, tab)) in self.menu_entries(d).into_iter().enumerate() {
                    if label.is_empty() {
                        m = m.child(div().my(space::S2).hairline_t(p.border));
                        continue;
                    }
                    let enabled = tab.is_some();
                    let mut r = row(
                        SharedString::from(format!("term-menu-{i}")),
                        glyph,
                        label,
                        enabled,
                    );
                    if let Some(tab) = tab {
                        let d = d.clone();
                        r = r.on_click(cx.listener(move |this, _, window, cx| {
                            this.open_tab(&d, tab.clone(), window, cx);
                        }));
                    }
                    m = m.child(r);
                }
                m = m.child(
                    row(
                        "term-menu-env".into(),
                        Glyph::HostShell,
                        "Host shell with env…".into(),
                        true,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.open_menu(Menu::Env, cx))),
                );
            }
            Menu::Env => match self.env_entries() {
                Ok(entries) => {
                    for (i, (label, tab)) in entries.into_iter().enumerate() {
                        let d = d.clone();
                        m = m.child(
                            row(
                                SharedString::from(format!("term-env-{i}")),
                                Glyph::HostShell,
                                label,
                                true,
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.open_tab(&d, tab.clone(), window, cx);
                                },
                            )),
                        );
                    }
                }
                Err(why) => {
                    m = m.child(row("term-env-none".into(), Glyph::HostShell, why, false));
                }
            },
        }
        m.into_any_element()
    }

    fn strip(
        &self,
        d: &DetailView,
        panel: &ProjectPanel,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let t = TermPalette::fallback();
        let sessions = panel.sessions.read(cx);
        let active = sessions.active_index();
        let kinds: Vec<TabKind> = sessions.kinds(cx).iter().map(tab_kind).collect();
        let left_running = sessions.left_running();
        let mut tabs = div().flex().items_stretch().min_w_0().overflow_hidden();
        for (i, kind) in kinds.iter().enumerate() {
            let sel = active == Some(i);
            let fg = if sel { t.fg } else { t.tab_fg };
            let mut tab = div()
                .id(("term-tab", i))
                .flex()
                .items_center()
                .gap(space::S3)
                .px(space::S5)
                .hairline_r(t.strip_border)
                .when(sel, |d| d.bg(t.bg))
                .text_color(fg)
                .type_step(if sel { text::SMALL_STRONG } else { text::SMALL })
                .whitespace_nowrap()
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| {
                    if i == 0 {
                        this.refresh_logs_tab(window, cx);
                    }
                    if let Some(p) = this
                        .model
                        .selected_key()
                        .and_then(|k| this.panels.by_key.get(&k))
                    {
                        p.sessions
                            .clone()
                            .update(cx, |s, cx| s.activate(i, window, cx));
                    }
                }))
                .child(icon(kind.glyph(), size::ICON, fg))
                .child(kind.label());
            if let Some((label, warn)) = kind.badge() {
                let (bg, bfg) = if warn {
                    (t.badge_warn_bg, t.badge_warn_fg)
                } else {
                    (t.badge_bg, t.badge_fg)
                };
                tab = tab.child(
                    div()
                        .flex_none()
                        .px(space::S3)
                        .rounded(radius::PILL)
                        .bg(bg)
                        .text_color(bfg)
                        .type_step(text::MICRO)
                        .child(label),
                );
            }
            if kind.closable() {
                tab = tab.child(
                    div()
                        .id(("term-tab-close", i))
                        .rounded(px(3.))
                        .hover(move |d| d.bg(t.strip_border))
                        .child(icon(Glyph::Close, px(12.), t.tab_fg))
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            cx.stop_propagation();
                            this.close_tab(i, window, cx);
                        })),
                );
            }
            tabs = tabs.child(tab);
        }
        let new_tab = div()
            .id("term-new")
            .relative()
            .flex_none()
            .flex()
            .items_center()
            .gap(space::S1)
            .px(space::S5)
            .cursor_pointer()
            .child(icon(Glyph::Plus, size::ICON, t.tab_fg))
            .child(icon(Glyph::ChevronDown, px(12.), t.tab_fg))
            .on_click(cx.listener(|this, _, _, cx| this.open_menu(Menu::Main, cx)))
            .when(panel.menu != Menu::Closed, |d0| {
                // Toward the larger space: above when docked, below when
                // maximized (the strip is then near the top).
                let anchor = div().absolute().left(px(0.));
                let anchor = if panel.state == PanelState::Maximized {
                    anchor.top(tok::STRIP + px(4.))
                } else {
                    anchor.bottom(tok::STRIP + px(4.))
                };
                d0.child(
                    gpui_kit::deferred(anchor.child(self.menu(d, panel.menu, ui, cx)))
                        .with_priority(1),
                )
            });
        let (size_glyph, find) = match panel.state {
            PanelState::Collapsed => (Glyph::ChevronUp, false),
            PanelState::Open { .. } => (Glyph::Maximize, true),
            PanelState::Maximized => (Glyph::Restore, true),
        };
        let notice = self.panels.error.clone().or_else(|| {
            (left_running > 0).then(|| {
                if left_running == 1 {
                    "1 process from a closed tab is still running".to_owned()
                } else {
                    format!("{left_running} processes from closed tabs are still running")
                }
            })
        });
        div()
            .h(tok::STRIP)
            .flex_none()
            .flex()
            .items_stretch()
            .bg(t.strip)
            .hairline_b(t.strip_border)
            .child(tabs)
            .child(new_tab)
            .child(div().flex_1())
            .children(notice.map(|n| {
                div()
                    .flex()
                    .items_center()
                    .px(space::S5)
                    .type_step(text::SMALL)
                    .text_color(t.badge_warn_fg)
                    .truncate()
                    .child(n)
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S5)
                    .px(space::S5)
                    .when(find, |d| {
                        d.child(
                            div()
                                .id("term-find")
                                .cursor_pointer()
                                .child(icon(Glyph::Search, size::ICON, t.tab_fg))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(p) = this
                                        .model
                                        .selected_key()
                                        .and_then(|k| this.panels.by_key.get(&k))
                                    {
                                        p.sessions.clone().update(cx, |s, cx| s.find(cx));
                                    }
                                })),
                        )
                    })
                    .child(
                        div()
                            .id("term-size")
                            .cursor_pointer()
                            .child(icon(size_glyph, size::ICON, t.tab_fg))
                            .on_click(cx.listener(|this, _, _, cx| {
                                let collapsed = this
                                    .model
                                    .selected_key()
                                    .and_then(|k| this.panels.by_key.get(&k))
                                    .is_some_and(|p| p.state == PanelState::Collapsed);
                                if collapsed {
                                    this.toggle_panel(cx);
                                } else {
                                    this.toggle_maximize(cx);
                                }
                            })),
                    ),
            )
    }

    fn handle(&self, ui: &Ui, cx: &mut Context<Self>) -> impl IntoElement {
        let p = ui.p;
        div()
            .id("term-handle")
            .h(tok::HANDLE)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .bg(p.surface_1)
            .hairline_t(p.border_strong)
            .cursor_row_resize()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.panels.dragging = true;
                    cx.stop_propagation();
                }),
            )
            .on_click(cx.listener(|this, ev: &ClickEvent, _, cx| {
                if ev.click_count() >= 2 {
                    this.panels.dragging = false;
                    this.toggle_maximize(cx);
                }
            }))
            .child(
                div()
                    .w(tok::GRIP_W)
                    .h(tok::GRIP_H)
                    .rounded(px(2.))
                    .bg(p.border_strong),
            )
    }

    /// The panel for the selected instance: handle, strip and terminal, at
    /// the height its state gives.
    pub(crate) fn terminal_area(
        &mut self,
        d: &DetailView,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.ensure_panel(window, cx);
        self.reconcile_panel(d, window, cx);
        let Some(panel) = self.panels.by_key.get(&d.key) else {
            return div().into_any_element();
        };
        let state = panel.state;
        let sessions = panel.sessions.clone();
        let strip = self.strip(d, panel, ui, cx).into_any_element();
        let surface = div()
            .flex_1()
            .min_h_0()
            .bg(TermPalette::fallback().bg)
            .child(sessions)
            .into_any_element();
        let base = div().flex().flex_col().min_h_0().relative();
        match state {
            PanelState::Collapsed => base
                .flex_none()
                .child(self.handle(ui, cx))
                .child(strip)
                .into_any_element(),
            PanelState::Open { fraction_milli } => base
                .flex_none()
                .h(relative(f32::from(fraction_milli) / 1000.))
                .child(self.handle(ui, cx))
                .child(strip)
                .child(surface)
                .into_any_element(),
            PanelState::Maximized => base.flex_1().child(strip).child(surface).into_any_element(),
        }
    }
}

/// What `--drive` (see `drive.rs`) calls: each is what the matching click
/// or key calls, plus a read of the result.
impl HackApp {
    fn selected_panel(&self) -> Option<&ProjectPanel> {
        self.panels.by_key.get(&self.model.detail()?.key)
    }

    fn active_view(&self, cx: &App) -> Option<Entity<TerminalView>> {
        self.selected_panel()?.sessions.read(cx).active().cloned()
    }

    /// Select an instance and create its panel. False until live data has
    /// it.
    pub(crate) fn drive_select(
        &mut self,
        key: &InstanceKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.select_instance(key.clone(), cx);
        if self.model.detail().is_none_or(|d| d.key != *key) {
            return false;
        }
        self.ensure_panel(window, cx);
        self.selected_panel().is_some()
    }

    pub(crate) fn drive_activate(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let panel = self.selected_panel().ok_or("no instance selected")?;
        let sessions = panel.sessions.clone();
        if index >= sessions.read(cx).tab_count() {
            return Err(format!("there is no tab {index}"));
        }
        sessions.update(cx, |s, cx| s.activate(index, window, cx));
        Ok(())
    }

    /// The new-tab menu entry that `want` matches.
    pub(crate) fn drive_menu_choice(&self, want: &NewTab) -> Result<NewTab, String> {
        let d = self.model.detail().ok_or("no instance selected")?;
        let offered: Vec<NewTab> = self
            .menu_entries(&d)
            .into_iter()
            .filter_map(|(_, _, tab)| tab)
            .collect();
        offered
            .iter()
            .find(|t| *t == want)
            .cloned()
            .ok_or_else(|| format!("not in the new-tab menu, which offers {offered:?}"))
    }

    /// Open a tab the menus offer, as their click does. Returns the tab
    /// count before, so the caller can wait for the new one.
    pub(crate) fn drive_open(
        &mut self,
        tab: NewTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<usize, String> {
        let d = self.model.detail().ok_or("no instance selected")?;
        let before = self
            .drive_tab_count(cx)
            .ok_or("the instance has no panel; select it first")?;
        self.open_tab(&d, tab, window, cx);
        Ok(before)
    }

    /// The "Host shell with env…" choice for `overlay` (and `scope`).
    pub(crate) fn drive_env_choice(
        &self,
        overlay: &str,
        scope: Option<&str>,
    ) -> Result<NewTab, String> {
        let entries = self.env_entries()?;
        entries
            .iter()
            .map(|(_, tab)| tab)
            .find(|tab| {
                matches!(tab, NewTab::HostWithEnv { overlay: o, scope: s, .. }
                    if o == overlay && scope.is_none_or(|want| want == s))
            })
            .cloned()
            .ok_or_else(|| {
                let offered: Vec<&String> = entries.iter().map(|(l, _)| l).collect();
                format!("no env choice {overlay} (offered: {offered:?})")
            })
    }

    pub(crate) fn drive_tab_count(&self, cx: &App) -> Option<usize> {
        Some(self.selected_panel()?.sessions.read(cx).tab_count())
    }

    /// The active tab's label and env badge, as the strip shows them.
    pub(crate) fn drive_active_label(&self, cx: &App) -> Option<String> {
        let view = self.active_view(cx)?;
        let kind = view.read(cx).kind().clone();
        Some(match kind.badge() {
            Some(b) => format!("{} [{} {:?}]", kind.label(), b.text, b.tone),
            None => kind.label(),
        })
    }

    /// Paste into the active tab as the Paste action does (into find while
    /// it is open). Reports a notice the tab shows (a refused paste).
    pub(crate) fn drive_paste(
        &mut self,
        text: &str,
        cx: &mut Context<Self>,
    ) -> Result<String, String> {
        let view = self.active_view(cx).ok_or("no active tab")?;
        if !view.read(cx).kind().is_interactive() {
            return Err("the active tab is read-only".into());
        }
        view.update(cx, |v, cx| v.paste(text, cx));
        Ok(view
            .read(cx)
            .notice()
            .map(|n| format!(" (notice: {n})"))
            .unwrap_or_default())
    }

    /// The active tab's screen, row by row.
    pub(crate) fn drive_screen(&self, cx: &mut Context<Self>) -> String {
        let Some(view) = self.active_view(cx) else {
            return String::new();
        };
        view.update(cx, |v, _| {
            v.emulator()
                .frame()
                .map(|f| {
                    (0..f.rows.len())
                        .map(|r| f.row_text(r))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        })
    }

    /// Every session leader each open tab has started (fallbacks
    /// included) and the tab's label, in every panel.
    pub(crate) fn drive_sessions(&self, cx: &App) -> Vec<(u32, String)> {
        let mut out = Vec::new();
        for panel in self.panels.by_key.values() {
            let sessions = panel.sessions.read(cx);
            for i in 0..sessions.tab_count() {
                if let Some(view) = sessions.tab(i) {
                    let v = view.read(cx);
                    for &leader in v.leaders() {
                        out.push((leader, v.kind().label()));
                    }
                }
            }
        }
        out
    }

    /// Where `check-container` runs the CLI for the selected instance.
    pub(crate) fn drive_target(&self) -> Result<crate::drive::Target, String> {
        let hack = self
            .source
            .hack_program()
            .ok_or("needs the hack CLI (live data)")?;
        let (root, native, branch) = self.instance_root().ok_or("no instance selected")?;
        Ok(crate::drive::Target {
            hack,
            root,
            native,
            branch,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(plan: &SessionPlan) -> Vec<Vec<String>> {
        plan.attempts
            .iter()
            .map(|a| {
                a.options
                    .args
                    .iter()
                    .map(|s| s.to_string_lossy().into_owned())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn the_logs_tab_runs_hack_logs_read_only_in_the_instance_checkout() {
        let plan = logs_plan(Path::new("/bin/hack"), Path::new("/work/p"), None, true).unwrap();
        assert_eq!(argv(&plan), [["logs", "--tail", "500"]]);
        assert_eq!(plan.kind(), &SessionKind::Logs, "read-only");
        assert_eq!(
            plan.attempts[0].options.cwd.as_deref(),
            Some(Path::new("/work/p"))
        );
        let names: Vec<String> = plan.attempts[0]
            .options
            .env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            ["TERM", "COLORTERM", "TERM_PROGRAM"],
            "names only, no values from the app"
        );
        let stopped = logs_plan(
            Path::new("/bin/hack"),
            Path::new("/work/wt"),
            Some("fix-login"),
            false,
        )
        .unwrap();
        assert_eq!(
            argv(&stopped),
            [[
                "logs",
                "--branch",
                "fix-login",
                "--no-follow",
                "--tail",
                "500"
            ]]
        );
    }

    fn env_of(plan: &SessionPlan) -> Vec<Vec<(String, String)>> {
        plan.attempts
            .iter()
            .map(|a| {
                a.options
                    .env
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.to_string_lossy().into_owned(),
                            v.to_string_lossy().into_owned(),
                        )
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn every_cli_tab_selects_the_instance_backend_and_nothing_else() {
        let hack = Path::new("/bin/hack");
        let root = Path::new("/work/p");
        for native in [false, true] {
            let backend = if native { "native" } else { "compose" };
            for plan in [
                container_plan(hack, root, None, "api").unwrap(),
                logs_plan(hack, root, None, true).unwrap(),
                host_env_plan(hack, root, "staging", "api", false).unwrap(),
            ] {
                for env in env_of(&with_backend(plan, native)) {
                    let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
                    assert_eq!(
                        names,
                        ["TERM", "COLORTERM", "TERM_PROGRAM", "HACK_RUNTIME_BACKEND"]
                    );
                    assert_eq!(env[3].1, backend, "every attempt, bash and sh alike");
                }
            }
        }
    }

    #[test]
    fn a_container_shell_targets_the_branch_instance() {
        let plan = container_plan(
            Path::new("/bin/hack"),
            Path::new("/work/wt"),
            Some("fix-login"),
            "api",
        )
        .unwrap();
        assert_eq!(
            argv(&plan),
            [
                ["exec", "--branch", "fix-login", "api", "--", "bash"],
                ["exec", "--branch", "fix-login", "api", "--", "sh"],
            ]
        );
        let base =
            container_plan(Path::new("/bin/hack"), Path::new("/work/p"), None, "api").unwrap();
        assert_eq!(argv(&base)[0], ["exec", "api", "--", "bash"]);
    }

    #[test]
    fn env_choices_offer_the_base_environment_when_no_overlay_is_named() {
        use hack_desktop_core::env::EnvSelection;
        let scopes = vec!["global".to_owned(), "api".to_owned()];
        // Only hack.env.default.yaml: default and effective are null.
        let base = env_choices(&EnvSelection::default(), &scopes, None).unwrap();
        let labels: Vec<&str> = base.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, ["env base · global", "env base · api"]);
        assert!(base.iter().all(|(_, t)| matches!(
            t,
            NewTab::HostWithEnv {
                is_default: true,
                ..
            }
        )));
        // Named overlays: default (neutral) and effective (warns).
        let named = EnvSelection {
            requested: Some("staging".into()),
            default: Some("local".into()),
            effective: Some("staging".into()),
        };
        let choices = env_choices(&named, &scopes[1..], None).unwrap();
        assert_eq!(
            choices.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(),
            ["env local · api", "env staging · api"]
        );
        assert!(matches!(
            choices[1].1,
            NewTab::HostWithEnv {
                is_default: false,
                ..
            }
        ));
        // No scope at all: nothing to offer, said plainly.
        assert!(env_choices(&named, &[], None).is_err());
        assert_eq!(env_choices(&named, &[], Some("api")).unwrap().len(), 2);
    }

    #[test]
    fn names_that_could_be_options_never_reach_argv() {
        for bad in ["--rm", "-x", "a b", ""] {
            assert!(
                container_plan(Path::new("/bin/hack"), Path::new("/w"), None, bad).is_err(),
                "{bad:?}"
            );
            assert!(
                logs_plan(Path::new("/bin/hack"), Path::new("/w"), Some(bad), true).is_err(),
                "{bad:?}"
            );
            assert!(
                host_env_plan(Path::new("/bin/hack"), Path::new("/w"), bad, "api", true).is_err(),
                "{bad:?}"
            );
        }
        let ok = host_env_plan(
            Path::new("/bin/hack"),
            Path::new("/w"),
            "staging",
            "api",
            false,
        )
        .unwrap();
        assert_eq!(
            argv(&ok),
            [["host", "shell", "--env", "staging", "--scope", "api"]]
        );
        assert_eq!(
            tab_kind(ok.kind()).badge(),
            Some(("env staging · api".into(), true)),
            "warns when not the default overlay"
        );
    }
}

/// The panel in a headless window, on fixtures.
#[cfg(all(test, feature = "screenshots"))]
mod window_tests {
    use std::sync::Arc;

    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{AnyWindowHandle, HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::{self, Fixture};
    use hack_desktop_core::source::FixtureSource;

    use super::*;

    fn open(live: bool) -> (HeadlessAppContext, AnyWindowHandle, Entity<HackApp>) {
        // GPUI's test platform with its no-op text system: libtest runs this
        // off the main thread, where macOS cannot build the real platform.
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
        let (window, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, move |window, cx| {
                    cx.new(|cx| {
                        let mut app = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Running)),
                            live,
                            window,
                            cx,
                        );
                        app.select(fixtures::selected(Fixture::Running));
                        app
                    })
                })
            })
            .expect("open a headless window");
        (cx, window, app)
    }

    fn draw(cx: &mut HeadlessAppContext, window: AnyWindowHandle, app: &Entity<HackApp>) {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            app.update(cx, |a, cx| a.settle_terminals(cx));
            window.render_frame(cx);
        })
        .expect("draw");
    }

    fn panel(cx: &mut HeadlessAppContext, app: &Entity<HackApp>) -> Entity<TerminalPanel> {
        cx.update(|cx| {
            let a = app.read(cx);
            let key = a.model.selected_key().expect("selected");
            a.panels.by_key[&key].sessions.clone()
        })
    }

    fn logs_text(cx: &mut HeadlessAppContext, app: &Entity<HackApp>) -> String {
        let sessions = panel(cx, app);
        cx.update(|cx| {
            let view = sessions.read(cx).tab(0).cloned().expect("a Logs tab");
            view.update(cx, |v, _| {
                let f = v.emulator().frame().expect("frame");
                (0..f.rows.len())
                    .map(|r| f.row_text(r))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        })
    }

    #[test]
    fn a_live_window_never_shows_fixture_lines_as_logs() {
        let (mut cx, window, app) = open(true);
        draw(&mut cx, window, &app);
        let text = logs_text(&mut cx, &app);
        assert!(text.contains("hack CLI was not found"), "{text:?}");
        assert!(
            !text.contains("checkpoint complete"),
            "fixture lines: {text:?}"
        );
        // Fixtures show fixture lines.
        let (mut cx, window, app) = open(false);
        draw(&mut cx, window, &app);
        assert!(logs_text(&mut cx, &app).contains("checkpoint complete"));
    }

    #[test]
    fn a_background_logs_restart_keeps_the_tab_focus_and_collapsed_panel() {
        let (mut cx, window, app) = open(false);
        draw(&mut cx, window, &app);
        let sessions = panel(&mut cx, &app);
        // The user works in a second tab (from a file: no shell starts) and
        // collapses the panel.
        cx.update_window(window, |_, window, cx| {
            let view = cx.new(|cx| TerminalView::from_core(note_core("shell\r\n").unwrap(), cx));
            sessions.update(cx, |s, cx| s.add_tab(view, window, cx));
        })
        .unwrap();
        let logs = cx.update(|cx| sessions.read(cx).tab(0).cloned().unwrap());
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.toggle_panel(cx);
                let key = a.model.selected_key().unwrap();
                a.panels.by_key.get_mut(&key).unwrap().logs_follow = false;
            });
        });
        draw(&mut cx, window, &app);
        let (new_logs, active) = cx.update(|cx| {
            let s = sessions.read(cx);
            (s.tab(0).cloned().unwrap(), s.active_index())
        });
        assert_ne!(new_logs.entity_id(), logs.entity_id(), "Logs restarted");
        assert_eq!(active, Some(1), "the tab being worked in stays active");
        let state = cx.update(|cx| {
            let a = app.read(cx);
            a.panels.by_key[&a.model.selected_key().unwrap()].state
        });
        assert_eq!(
            state,
            PanelState::Collapsed,
            "a collapsed panel stays collapsed"
        );
    }

    #[test]
    fn a_new_checkout_ends_the_old_sessions_and_starts_again() {
        let (mut cx, window, app) = open(false);
        draw(&mut cx, window, &app);
        let sessions = panel(&mut cx, &app);
        // A second tab, from a file: no shell is started by this test.
        cx.update_window(window, |_, window, cx| {
            let view = cx.new(|cx| TerminalView::from_core(note_core("second\r\n").unwrap(), cx));
            sessions.update(cx, |s, cx| s.add_tab(view, window, cx));
        })
        .unwrap();
        let first_logs = cx.update(|cx| sessions.read(cx).tab(0).cloned().unwrap());
        assert_eq!(cx.update(|cx| sessions.read(cx).tab_count()), 2);
        // The instance's checkout changes under the panel.
        cx.update(|cx| {
            app.update(cx, |a, _| {
                let key = a.model.selected_key().unwrap();
                a.panels.by_key.get_mut(&key).unwrap().origin =
                    Some((PathBuf::from("/elsewhere/checkout"), false));
            });
        });
        draw(&mut cx, window, &app);
        let (count, logs) = cx.update(|cx| {
            let s = sessions.read(cx);
            (s.tab_count(), s.tab(0).cloned().unwrap())
        });
        assert_eq!(count, 1, "the old tabs are closed, Logs starts again");
        assert_ne!(
            logs.entity_id(),
            first_logs.entity_id(),
            "a new Logs session"
        );
    }

    #[test]
    fn an_instance_that_starts_gets_its_logs_once() {
        let (mut cx, window, app) = open(false);
        draw(&mut cx, window, &app);
        let sessions = panel(&mut cx, &app);
        // The fixture's Logs tab is a finite read and has ended.
        let ended = cx.update(|cx| sessions.read(cx).tab(0).cloned().unwrap());
        assert!(cx.update(|cx| matches!(ended.read(cx).status(), TermStatus::Ended(_))));
        // Its Logs session is a finite read (started while stopped), and the
        // instance runs now.
        cx.update(|cx| {
            app.update(cx, |a, _| {
                let key = a.model.selected_key().unwrap();
                a.panels.by_key.get_mut(&key).unwrap().logs_follow = false;
            });
        });
        draw(&mut cx, window, &app);
        let restarted = cx.update(|cx| sessions.read(cx).tab(0).cloned().unwrap());
        assert_ne!(restarted.entity_id(), ended.entity_id(), "restarted once");
        // Still running on the next frames: not restarted again, even though
        // the (fixture) stream ends again.
        draw(&mut cx, window, &app);
        draw(&mut cx, window, &app);
        let later = cx.update(|cx| sessions.read(cx).tab(0).cloned().unwrap());
        assert_eq!(
            later.entity_id(),
            restarted.entity_id(),
            "not on every frame"
        );
    }
}
