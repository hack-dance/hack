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
//! builds an environment and never sees a value.

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
            },
        );
        self.open_tab(&d, NewTab::Logs, window, cx);
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
                (Some(hack), Some((root, false, branch))) => TerminalCore::session(logs_plan(
                    hack,
                    root,
                    branch.as_deref(),
                    d.state.is_active(),
                )?)
                .map_err(io),
                // Fixtures: the fixture's log lines, as a service prints them.
                _ => note_core(&self.fixture_log_text()).map_err(io),
            },
            NewTab::Container(service) => {
                let (Some(hack), Some((root, _, branch))) = (&hack, &root) else {
                    return Err("A shell in a service needs the hack CLI.".into());
                };
                TerminalCore::session(container_plan(hack, root, branch.as_deref(), service)?)
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
                let (Some(hack), Some((root, _, _))) = (&hack, &root) else {
                    return Err("A host shell with env needs the hack CLI.".into());
                };
                TerminalCore::session(host_env_plan(hack, root, overlay, scope, *is_default)?)
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
        let core = self.core_for(d, &tab);
        let look = self.look(cx);
        let Some(panel) = self.panels.by_key.get_mut(&d.key) else {
            return;
        };
        panel.menu = Menu::Closed;
        if panel.state == PanelState::Collapsed {
            panel.state = PanelState::half();
        }
        let sessions = panel.sessions.clone();
        let core = match core {
            Ok(core) => core,
            Err(why) => {
                self.panels.error = Some(why);
                cx.notify();
                return;
            }
        };
        self.panels.error = None;
        let view = cx.new(|cx| {
            let mut v = TerminalView::from_core(core, cx);
            v.set_look(look, cx);
            v
        });
        if tab == NewTab::Logs && sessions.read(cx).tab_count() > 0 {
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
    fn menu_entries(&self, d: &DetailView) -> Vec<(String, Glyph, Option<NewTab>)> {
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
    fn env_entries(&self) -> Result<Vec<(String, NewTab)>, String> {
        use hack_desktop_core::env::EnvView;
        if self.source.hack_program().is_none() {
            return Err("Needs the hack CLI".into());
        }
        let report = match &self.env.view {
            EnvView::Report(r) => r,
            EnvView::Loading => return Err("Reading overlays…".into()),
            EnvView::Unreadable => return Err("Could not read env overlays".into()),
        };
        let selection = report.env_selection.clone().unwrap_or_default();
        let overlays = selection.overlays();
        let mut scopes = report.scopes.clone();
        if scopes.is_empty() {
            scopes.extend(report.selected_scope.clone());
        }
        if overlays.is_empty() || scopes.is_empty() {
            return Err("No env overlay or scope reported".into());
        }
        let mut out = Vec::new();
        for overlay in &overlays {
            for scope in &scopes {
                out.push((
                    format!("env {overlay} · {scope}"),
                    NewTab::HostWithEnv {
                        overlay: overlay.clone(),
                        scope: scope.clone(),
                        is_default: selection.default.as_deref() == Some(overlay.as_str()),
                    },
                ));
            }
        }
        Ok(out)
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
