//! Shared Run/Copy control and the command mode of the existing Ghostty drawer.
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, ClipboardItem, Context, Entity, Focusable, IntoElement, ParentElement,
    SharedString, Styled, Subscription, Window, div, prelude::*, px, relative,
};
use hack_desktop_core::machine_gate::{Holder, Ticket};
use hack_desktop_core::terminal::{
    CommandAvailability, CommandControl, CommandControlSize, CommandExit, CommandSpec, Platform,
    Script, SystemLauncher, linux_adapter,
};
use hack_desktop_term::launch::{Launch, SessionKind, SessionPlan, terminal_identity};
use hack_desktop_term::panel::TerminalPanel;
use hack_desktop_term::pty::PtyOptions;
use hack_desktop_term::session::ExitInfo;
use hack_desktop_term::terminal::{Status, TerminalCore};
use hack_desktop_term::view::TerminalView;
use hack_desktop_ui::components::{
    StyledExt as _, Ui, action_button, icon, icon_button, primary_button,
};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::view::HackApp;

gpui_kit::actions!(hack_desktop, [MakeCommandTaller]);

const CLOSE_DELAY: Duration = Duration::from_millis(1500);
const PASSWORD_GUIDANCE: &str = if cfg!(target_os = "macos") {
    "Type your Mac password in the terminal below. It goes straight to macOS. Hack never sees or stores it."
} else {
    "Type your password in the terminal below. It goes straight to your system. Hack never sees or stores it."
};

/// Identifies one attempt, including retries of the same control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommandRunId(u64);

/// Observed process exit and a short diagnosis from its output, if present.
pub(crate) struct CommandCompletion {
    pub run: CommandRunId,
    pub exit: CommandExit,
    pub diagnosis: Option<String>,
}

type OnExit = Box<dyn FnOnce(&mut HackApp, CommandCompletion, &mut Context<HackApp>)>;
type ResolveDirectory = fn(&CommandControl, &CommandSpec) -> Result<Option<PathBuf>, String>;

#[derive(Default)]
pub(crate) struct Drawer {
    serial: u64,
    session: Option<Entity<TerminalPanel>>,
    last: Option<Run>,
    visible: bool,
    taller: bool,
    menu: bool,
}

impl Drawer {
    pub(crate) fn visible(&self) -> bool {
        self.visible
    }

    pub(crate) fn waiting_for_password(&self, control_id: &str) -> bool {
        self.last
            .as_ref()
            .is_some_and(|run| run.props.id == control_id && run.waiting_for_password)
    }
}

struct Run {
    id: CommandRunId,
    props: CommandControl,
    spec: CommandSpec,
    resolve_directory: ResolveDirectory,
    phase: Phase,
    waiting_for_password: bool,
    fallback: Option<String>,
    handoff_on_exit: bool,
    ticket: Option<Ticket>,
    on_exit: Option<OnExit>,
    _observer: Option<Subscription>,
}

enum Phase {
    Running,
    Ended {
        exit: CommandExit,
        at: Instant,
        diagnosis: Option<String>,
        check: Check,
    },
}

enum Check {
    Pending,
    Output,
    NeedsAttention(String),
    Closing,
    Passed,
}

impl Run {
    fn running(&self) -> bool {
        matches!(self.phase, Phase::Running)
    }
}

fn checked_home(spec: &CommandSpec) -> Option<&Path> {
    if spec.program != "/usr/bin/env" || spec.args.first().map(String::as_str) != Some("-i") {
        return None;
    }
    spec.args[1..]
        .iter()
        .take_while(|arg| arg.contains('='))
        .find_map(|arg| arg.strip_prefix("HOME=").map(Path::new))
}

/// The same checked command and working directory for inline and banner Copy.
pub(crate) fn copy_text(props: &CommandControl) -> Option<String> {
    let (CommandAvailability::Ready(spec) | CommandAvailability::CopyOnly(spec)) =
        &props.availability
    else {
        return None;
    };
    let cwd = props.cwd.as_deref().or_else(|| checked_home(spec));
    spec.display_in(cwd).ok()
}

fn command_directory(
    props: &CommandControl,
    spec: &CommandSpec,
) -> Result<Option<PathBuf>, String> {
    if let Some(root) = &props.cwd {
        return hack_desktop_core::source::trusted_root(root)
            .map(Some)
            .map_err(|e| format!("Could not use the checked project directory: {e:?}"));
    }
    Ok(checked_home(spec).map(Path::to_owned))
}

fn init_directory(props: &CommandControl, _: &CommandSpec) -> Result<Option<PathBuf>, String> {
    let root = props.cwd.as_deref().ok_or("The checkout is unavailable.")?;
    hack_desktop_core::source::trusted_init_root(root)
        .map(Some)
        .map_err(|error| match error {
            hack_desktop_core::source::SourceError::Cli { message, .. } => message,
            _ => "The checkout is unavailable.".into(),
        })
}

fn command_options(spec: &CommandSpec, cwd: Option<PathBuf>) -> Result<PtyOptions, String> {
    if !Path::new(&spec.program).is_absolute() {
        return Err("The command must use an absolute executable path".into());
    }
    spec.display()?;
    let mut options = PtyOptions::new(&spec.program);
    options.cwd = cwd;
    options.env_clear = true;
    options.env = terminal_identity("xterm-256color");
    options.args = spec.args.iter().map(Into::into).collect();
    // Checked CLI specs use env -i. Add terminal identity on its side of
    // the clear as well, without substituting any checked selectors.
    if spec.program == "/usr/bin/env" && spec.args.first().is_some_and(|arg| arg == "-i") {
        options.args.splice(
            1..1,
            [
                "TERM=xterm-256color",
                "COLORTERM=truecolor",
                "TERM_PROGRAM=hack",
            ]
            .into_iter()
            .map(Into::into),
        );
    }
    Ok(options)
}

fn command_core(
    props: &CommandControl,
    spec: &CommandSpec,
    cwd: Option<PathBuf>,
) -> Result<TerminalCore, String> {
    if props.label.is_empty() || props.label.chars().any(char::is_control) {
        return Err("The command label must be one plain line".into());
    }
    TerminalCore::session(SessionPlan {
        attempts: vec![Launch {
            kind: SessionKind::Command {
                label: props.label.clone(),
                expects_password: props.expects_password,
                project: props.cwd.is_some(),
            },
            options: command_options(spec, cwd)?,
        }],
    })
    .map_err(|e| e.to_string())
}

fn diagnosis(output: &str) -> Option<String> {
    // Use the most recent CLI hint or error. Terminal formatting has
    // already stripped ANSI escapes and joined soft wraps.
    ["hint ", "error "].into_iter().find_map(|prefix| {
        output.lines().rev().find_map(|line| {
            line.trim_start()
                .strip_prefix(prefix)
                .or_else(|| {
                    line.trim_start()
                        .strip_prefix(prefix.trim_end())?
                        .strip_prefix(':')
                })
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(300).collect())
        })
    })
}

impl HackApp {
    /// Start an explicit command, including runs initiated by a queue.
    /// Returns false when unavailable or another machine action owns the gate.
    pub(crate) fn run_drawer_command(
        &mut self,
        props: CommandControl,
        on_exit: impl FnOnce(&mut Self, CommandCompletion, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.live {
            return false;
        }
        self.start_drawer_command(props, Box::new(on_exit), command_directory, window, cx)
    }

    pub(crate) fn run_init_in_drawer(
        &mut self,
        props: CommandControl,
        on_exit: impl FnOnce(&mut Self, CommandCompletion, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.live {
            self.start_drawer_command(props, Box::new(on_exit), init_directory, window, cx);
        }
    }

    fn start_drawer_command(
        &mut self,
        props: CommandControl,
        on_exit: OnExit,
        resolve_directory: ResolveDirectory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let CommandAvailability::Ready(spec) = &props.availability else {
            return false;
        };
        let Some(ticket) = self.machine.try_begin(Holder::Command) else {
            return false;
        };
        self.user_navigated();
        let spec = spec.clone();
        let directory = resolve_directory(&props, &spec);
        let core = directory
            .clone()
            .and_then(|cwd| command_core(&props, &spec, cwd));

        let drawer = &mut self.panels.command;
        drawer.serial += 1;
        let id = CommandRunId(drawer.serial);
        drawer.visible = true;
        drawer.menu = false;
        drawer.last = Some(Run {
            id,
            props,
            spec,
            resolve_directory,
            phase: Phase::Running,
            waiting_for_password: false,
            fallback: None,
            handoff_on_exit: false,
            ticket: Some(ticket),
            on_exit: Some(on_exit),
            _observer: None,
        });
        let sessions = drawer
            .session
            .get_or_insert_with(|| Self::embedded_terminal(cx))
            .clone();
        if sessions.read(cx).tab_count() > 0 {
            sessions.update(cx, |s, cx| s.close(0, window, cx));
        }
        match core {
            Ok(core) => {
                let look = self.terminal_look(cx);
                let view = cx.new(|cx| {
                    let mut view = TerminalView::from_core(core, cx);
                    view.set_look(look, cx);
                    view
                });
                let observer = cx.observe(&view, move |app, view, cx| {
                    app.command_terminal_changed(id, view, cx);
                });
                if let Some(run) = &mut self.panels.command.last {
                    run._observer = Some(observer);
                }
                sessions.update(cx, |s, cx| s.add_tab(view, window, cx));
            }
            Err(error) => {
                self.finish_drawer_command(id, CommandExit::LaunchFailed(error), None, cx)
            }
        }
        cx.notify();
        true
    }

    fn command_terminal_changed(
        &mut self,
        id: CommandRunId,
        view: Entity<TerminalView>,
        cx: &mut Context<Self>,
    ) {
        let Some(run) = self
            .panels
            .command
            .last
            .as_mut()
            .filter(|r| r.id == id && r.running())
        else {
            return;
        };
        let term = view.read(cx);
        if matches!(term.status(), Status::Running) {
            let waiting = term.waiting_for_password();
            if run.waiting_for_password != waiting {
                run.waiting_for_password = waiting;
                cx.notify();
            }
            return;
        }
        let exit = match term.exit_status() {
            Some(ExitInfo::Exited(code)) => CommandExit::Code(code),
            Some(ExitInfo::Signaled(signal)) => CommandExit::Signal(signal),
            Some(ExitInfo::Unknown) | None => CommandExit::StatusUnavailable,
        };
        let reason = exit_failed(&exit)
            .then(|| term.output_text().and_then(|output| diagnosis(&output)))
            .flatten();
        self.finish_drawer_command(id, exit, reason, cx);
    }

    fn finish_drawer_command(
        &mut self,
        id: CommandRunId,
        exit: CommandExit,
        reason: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(run) = self
            .panels
            .command
            .last
            .as_mut()
            .filter(|r| r.id == id && r.running())
        else {
            return;
        };
        let completion = CommandCompletion {
            run: id,
            exit,
            diagnosis: reason,
        };
        run.waiting_for_password = false;
        run.phase = Phase::Ended {
            exit: completion.exit.clone(),
            at: Instant::now(),
            diagnosis: completion.diagnosis.clone(),
            check: Check::Pending,
        };
        let handoff = std::mem::take(&mut run.handoff_on_exit);
        let callback = run.on_exit.take();
        if let Some(ticket) = run.ticket.take() {
            self.machine.finish(ticket);
        }
        if handoff
            && matches!(
                completion.exit,
                CommandExit::Code(130) | CommandExit::Signal(2)
            )
        {
            self.open_command_fallback(cx);
        } else if handoff {
            run.fallback = Some(
                "The terminal command ended. Choose Open in Terminal app to run it there.".into(),
            );
        }
        if let Some(callback) = callback {
            callback(self, completion, cx);
        }
        cx.notify();
    }

    /// A manual command leaves its result visible in the drawer.
    pub(crate) fn command_output_ready(&mut self, id: CommandRunId, cx: &mut Context<Self>) {
        if let Some(run) = self.panels.command.last.as_mut().filter(|run| run.id == id)
            && let Phase::Ended { check, .. } = &mut run.phase
            && matches!(check, Check::Pending)
        {
            *check = Check::Output;
            cx.notify();
        }
    }

    /// Apply fresh evidence for this run. Only a successful process and
    /// passing check arm auto-close. Late evidence cannot affect a retry.
    pub(crate) fn command_checked(
        &mut self,
        id: CommandRunId,
        result: Result<(), String>,
        cx: &mut Context<Self>,
    ) {
        let drawer = &mut self.panels.command;
        let Some(run) = drawer.last.as_mut().filter(|r| r.id == id) else {
            return;
        };
        let Phase::Ended {
            exit: CommandExit::Code(0),
            check,
            ..
        } = &mut run.phase
        else {
            return;
        };
        if !matches!(check, Check::Pending) {
            return;
        }
        *check = match result {
            Ok(()) if drawer.visible => Check::Closing,
            Ok(()) => Check::Passed,
            Err(reason) => Check::NeedsAttention(reason),
        };
        if matches!(check, Check::Closing) {
            cx.spawn(async move |app, cx| {
                cx.background_executor().timer(CLOSE_DELAY).await;
                let _ = app.update(cx, |app, cx| {
                    let drawer = &mut app.panels.command;
                    if let Some(run) = drawer.last.as_mut().filter(|r| r.id == id)
                        && let Phase::Ended { check, .. } = &mut run.phase
                        && matches!(check, Check::Closing)
                    {
                        drawer.visible = false;
                        drawer.menu = false;
                        *check = Check::Passed;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        cx.notify();
    }

    pub(crate) fn reset_command_drawer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let drawer = &mut self.panels.command;
        if let Some(ticket) = drawer.last.take().and_then(|r| r.ticket) {
            self.machine.finish(ticket);
        }
        if let Some(sessions) = &drawer.session
            && sessions.read(cx).tab_count() > 0
        {
            sessions.update(cx, |s, cx| s.close(0, window, cx));
        }
        drawer.visible = false;
        drawer.menu = false;
    }

    pub(crate) fn close_command_drawer(&mut self, cx: &mut Context<Self>) {
        let drawer = &mut self.panels.command;
        drawer.visible = false;
        drawer.menu = false;
        if let Some(run) = &mut drawer.last
            && let Phase::Ended { check, .. } = &mut run.phase
            && matches!(check, Check::Closing)
        {
            *check = Check::Passed;
        }
        cx.notify();
    }

    /// Close the visible drawer or bring back a running command.
    pub(crate) fn toggle_command_drawer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.panels.command.visible {
            self.close_command_drawer(cx);
            return true;
        }
        let Some(run) = self
            .panels
            .command
            .last
            .as_ref()
            .filter(|run| run.running())
        else {
            return false;
        };
        self.show_command_output(&run.props.id.clone(), window, cx);
        true
    }

    /// Reopen the last drawer run if it belongs to the supplied control ID.
    /// Can also show a command still running behind a closed drawer.
    pub(crate) fn show_command_output(
        &mut self,
        control_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let drawer = &mut self.panels.command;
        if !drawer
            .last
            .as_ref()
            .is_some_and(|r| r.props.id == control_id)
        {
            return;
        }
        drawer.visible = true;
        if let Some(term) = drawer.session.as_ref().and_then(|s| s.read(cx).active()) {
            window.focus(&term.read(cx).focus_handle(cx), cx);
        }
        cx.notify();
    }

    pub(crate) fn make_command_taller(&mut self, cx: &mut Context<Self>) {
        let drawer = &mut self.panels.command;
        if drawer.visible {
            drawer.taller = !drawer.taller;
            drawer.menu = false;
            cx.notify();
        }
    }

    pub(crate) fn stop_drawer_command(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self
            .panels
            .command
            .last
            .as_ref()
            .map(|run| run.props.id.clone())
        {
            self.health_drawer_stop_requested(&id);
        }
        let drawer = &mut self.panels.command;
        drawer.menu = false;
        if drawer.last.as_ref().is_some_and(Run::running)
            && let Some(term) = drawer.session.as_ref().and_then(|s| s.read(cx).active())
        {
            term.clone()
                .update(cx, |term, cx| term.type_text("\u{3}", cx));
        }
        cx.notify();
    }

    fn open_command_fallback(&mut self, cx: &mut Context<Self>) {
        let drawer = &mut self.panels.command;
        drawer.menu = false;
        let Some(run) = &mut drawer.last else {
            return;
        };
        if run.running() {
            // Do not run a second copy while the embedded command owns the
            // action. Only a confirmed interrupt opens the fallback.
            run.handoff_on_exit = true;
            run.fallback = Some("Stopping the command before opening Terminal…".into());
            self.stop_drawer_command(cx);
            return;
        }
        let id = run.id;
        let spec = run.spec.clone();
        let props = run.props.clone();
        let resolve_directory = run.resolve_directory;
        cx.spawn(async move |app, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let platform = if cfg!(target_os = "macos") {
                        Platform::Mac
                    } else {
                        Platform::Linux
                    };
                    let cwd = resolve_directory(&props, &spec)?;
                    Script::create_in(&std::env::temp_dir(), &spec, cwd.as_deref())?.open(
                        platform,
                        linux_adapter().as_deref(),
                        &SystemLauncher,
                    )
                })
                .await;
            let _ = app.update(cx, |app, cx| {
                if let Some(run) = app.panels.command.last.as_mut().filter(|r| r.id == id) {
                    run.fallback = Some(match result {
                        Ok(()) => {
                            "Opened in Terminal. Press Enter there, then check again here.".into()
                        }
                        Err(error) => error,
                    });
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn copy_drawer_output(&mut self, cx: &mut Context<Self>) {
        let drawer = &mut self.panels.command;
        drawer.menu = false;
        if let Some(output) = drawer
            .session
            .as_ref()
            .and_then(|s| s.read(cx).active())
            .and_then(|term| term.read(cx).output_text())
        {
            cx.write_to_clipboard(ClipboardItem::new_string(output));
        }
        cx.notify();
    }
}

fn exit_label(exit: &CommandExit) -> String {
    match exit {
        CommandExit::Code(code) => format!("exit {code}"),
        CommandExit::Signal(signal) => format!("signal {signal}"),
        CommandExit::StatusUnavailable => "exit status unavailable".into(),
        CommandExit::LaunchFailed(_) => "could not start".into(),
    }
}

fn exit_failed(exit: &CommandExit) -> bool {
    !matches!(exit, CommandExit::Code(0) | CommandExit::StatusUnavailable)
}

fn elapsed_label(at: Instant) -> String {
    let seconds = at.elapsed().as_secs();
    match seconds {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", seconds / 60),
        _ => format!("{} h ago", seconds / 3600),
    }
}

/// Shared Run/Copy control. The callback starts a fresh check on every exit
/// and reports its result back with [HackApp::command_checked].
pub(crate) fn render(
    props: CommandControl,
    caller_busy: bool,
    app: &HackApp,
    ui: &Ui,
    cx: &mut Context<HackApp>,
    on_exit: impl Fn(&mut HackApp, CommandCompletion, &mut Context<HackApp>) + 'static,
) -> AnyElement {
    let on_exit = Rc::new(on_exit);
    render_with_run(
        props,
        caller_busy,
        app,
        ui,
        cx,
        move |app, props, window, cx| {
            let on_exit = Rc::clone(&on_exit);
            app.run_drawer_command(
                props,
                move |app, result, cx| on_exit(app, result, cx),
                window,
                cx,
            );
        },
    )
}

/// Use the shared buttons when a caller must admit the operation before launching the drawer.
pub(crate) fn render_with_run(
    props: CommandControl,
    caller_busy: bool,
    app: &HackApp,
    ui: &Ui,
    cx: &mut Context<HackApp>,
    on_run: impl Fn(&mut HackApp, CommandControl, &mut Window, &mut Context<HackApp>) + 'static,
) -> AnyElement {
    if let CommandAvailability::Blocked(reason) | CommandAvailability::VersionMismatch(reason) =
        &props.availability
    {
        return div()
            .type_step(text::SMALL)
            .text_color(ui.p.text_secondary)
            .child(reason.clone())
            .into_any_element();
    }
    let drawer = &app.panels.command;
    let last = drawer.last.as_ref().filter(|r| r.props.id == props.id);
    let running = last.is_some_and(Run::running);
    let retry = last.is_some_and(|r| match &r.phase {
        Phase::Ended { exit, check, .. } => {
            exit_failed(exit) || matches!(check, Check::NeedsAttention(_))
        }
        Phase::Running => false,
    });
    let can_run = app.live
        && !caller_busy
        && !app.machine.busy()
        && matches!(props.availability, CommandAvailability::Ready(_));
    let copy = copy_text(&props);
    let group = SharedString::from(format!("command-{}", props.id));
    let (width, height) = match props.size {
        CommandControlSize::Standard => (80., 28.),
        CommandControlSize::Compact => (64., 24.),
    };
    let (glyph, label) = if running {
        (Glyph::Loader, "Running")
    } else if retry {
        (Glyph::Restart, "Try again")
    } else {
        (Glyph::Play, "Run")
    };
    let run = if can_run {
        primary_button("run", glyph, label, ui)
    } else {
        action_button("run", glyph, label, false, ui)
    };
    let mut run = run
        .w(px(width))
        .h(px(height))
        .px(px(2.))
        .gap(px(3.))
        .justify_center()
        .whitespace_nowrap()
        .type_step(text::SMALL)
        .flex_none();
    let mut copy_button = action_button("copy", Glyph::Copy, "Copy", copy.is_some(), ui)
        .w(px(width))
        .h(px(height))
        .px(px(2.))
        .gap(px(3.))
        .justify_center()
        .type_step(text::SMALL)
        .flex_none();
    if let Some(copy) = copy {
        copy_button = copy_button.focusable().on_click(move |_, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
        });
    }
    if can_run {
        let props = props.clone();
        run = run.focusable().on_click(
            cx.listener(move |app, _, window, cx| on_run(app, props.clone(), window, cx)),
        );
    }
    #[cfg(all(test, feature = "screenshots"))]
    let run = {
        use gpui_kit::test::TestSupportExt as _;
        run.test_support()
    };

    let compact = props.size == CommandControlSize::Compact;
    let p = ui.p;
    let command = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .font_family(ui.mono.clone())
        .type_step(text::MONO)
        .child(format!("$ {}", props.label));
    let row = div()
        .flex()
        .min_w_0()
        .items_center()
        .gap(space::S3)
        .when(!compact, |row| {
            row.h(px(44.))
                .px(px(8.))
                .rounded(radius::PANEL)
                .hairline(p.border)
                .when(running, |r| r.bg(p.attention))
                .child(command)
        })
        .child(run)
        .child(copy_button);
    let mut control = div()
        .id(group)
        .flex()
        .flex_col()
        .gap(space::S3)
        .min_w_0()
        .child(row);
    if let Some(last) = last {
        if last.waiting_for_password && drawer.visible {
            control = control.child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_secondary)
                    .child(PASSWORD_GUIDANCE),
            );
        }
        if let Phase::Ended {
            exit,
            diagnosis,
            check,
            ..
        } = &last.phase
        {
            let reason = match (exit, check) {
                (CommandExit::LaunchFailed(reason), _) | (_, Check::NeedsAttention(reason)) => {
                    Some(reason)
                }
                _ => diagnosis.as_ref(),
            };
            control = control.when_some(reason, |control, reason| {
                control.child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(reason.clone()),
                )
            });
        }
    }
    if props.expects_password && !running && !retry && !compact {
        let note = if cfg!(target_os = "macos") {
            "Asks for your Mac password once, in the terminal below."
        } else {
            "May ask for your password, in the terminal below."
        };
        control = control.child(
            div()
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(note),
        );
    }
    control
        .children(render_history(&props.id, app, ui, cx))
        .into_any_element()
}

/// Recover the latest output when the drawer is closed, including when a
/// passing check removes the command's Run/Copy buttons.
pub(crate) fn render_history(
    control_id: &str,
    app: &HackApp,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<gpui_kit::Div> {
    let drawer = &app.panels.command;
    let run = drawer
        .last
        .as_ref()
        .filter(|run| !drawer.visible && run.props.id == control_id)?;
    let status = match &run.phase {
        Phase::Running => "· running".into(),
        Phase::Ended {
            exit, at, check, ..
        } => {
            let summary = match (exit, check) {
                (CommandExit::StatusUnavailable, _) => "ended",
                (CommandExit::Code(0), Check::NeedsAttention(_)) => "needs a fix",
                (CommandExit::Code(0), _) => "finished",
                _ => "failed",
            };
            format!(
                "· {summary} · {} · {}",
                exit_label(exit),
                elapsed_label(*at)
            )
        }
    };
    let id = run.props.id.clone();
    let p = ui.p;
    Some(
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(space::S2)
            .type_step(text::SMALL)
            .text_color(p.text_muted)
            .child(icon(Glyph::Terminal, px(12.), p.text_muted))
            .child("Last run ·")
            .child(
                div()
                    .font_family(ui.mono.clone())
                    .child(run.props.label.clone()),
            )
            .child(status)
            .child(
                div()
                    .id("show-output")
                    .focusable()
                    .cursor_pointer()
                    .text_color(p.text_primary)
                    .hover(|d| d.underline())
                    .px(space::S2)
                    .child("Show output")
                    .on_click(cx.listener(move |app, _, window, cx| {
                        app.show_command_output(&id, window, cx)
                    })),
            ),
    )
}

impl HackApp {
    #[cfg(feature = "screenshots")]
    pub(crate) fn settle_command_fixture(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self
            .panels
            .command
            .session
            .as_ref()
            .and_then(|panel| panel.read(cx).active())
            .cloned()
        {
            view.update(cx, |terminal, cx| {
                terminal.settle(Duration::from_millis(100), Duration::from_secs(2), cx)
            });
        }
    }

    /// Alternate chrome for the window's embedded bottom terminal panel.
    pub(crate) fn render_command_drawer(
        &self,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let drawer = &self.panels.command;
        let run = drawer.last.as_ref().filter(|_| drawer.visible)?;
        let p = ui.p;
        let (status_glyph, status, tint) = match &run.phase {
            Phase::Running if run.waiting_for_password => (
                Glyph::Lock,
                "Waiting for your password".into(),
                p.text_secondary,
            ),
            Phase::Running => (Glyph::Loader, "Running".into(), p.text_secondary),
            Phase::Ended {
                exit: CommandExit::Code(0),
                check,
                ..
            } => match check {
                Check::Pending => (Glyph::Loader, "Checking… · exit 0".into(), p.text_secondary),
                Check::Output => (Glyph::Check, "Done · exit 0".into(), p.text_secondary),
                Check::Closing => (Glyph::Check, "Done · closing".into(), p.states.running.dot),
                Check::Passed => (Glyph::Check, "Done · exit 0".into(), p.states.running.dot),
                Check::NeedsAttention(_) => (
                    Glyph::CircleAlert,
                    "Needs a fix · exit 0".into(),
                    p.states.degraded.dot,
                ),
            },
            Phase::Ended {
                exit: CommandExit::StatusUnavailable,
                ..
            } => (
                Glyph::CircleAlert,
                "Ended · status unknown".into(),
                p.text_secondary,
            ),
            Phase::Ended { exit, .. } => (
                Glyph::CircleAlert,
                format!("Failed · {}", exit_label(exit)),
                p.states.failed.dot,
            ),
        };
        let menu = command_menu(run, drawer.taller, ui, cx);
        let end_actions = div()
            .flex()
            .gap(px(8.))
            .items_center()
            .child(
                div()
                    .relative()
                    .child(
                        icon_button("command-menu", Glyph::More, ui)
                            .focusable()
                            .tooltip(|window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new("Terminal actions")
                                    .build(window, cx)
                            })
                            .on_click(cx.listener(|app, _, _, cx| {
                                app.panels.command.menu = !app.panels.command.menu;
                                cx.notify();
                            })),
                    )
                    .when(drawer.menu, |d| {
                        d.child(
                            gpui_kit::deferred(
                                div().absolute().top(px(-24.)).right(px(0.)).child(menu),
                            )
                            .with_priority(1),
                        )
                    }),
            )
            .child(
                icon_button("close-command", Glyph::Close, ui)
                    .focusable()
                    .tooltip(|window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new("Close terminal")
                            .build(window, cx)
                    })
                    .on_click(cx.listener(|app, _, _, cx| app.close_command_drawer(cx))),
            );
        let header = div()
            .flex()
            .items_center()
            .gap(space::S3)
            .h(px(40.))
            .flex_none()
            .px(space::S4)
            .hairline_b(p.border)
            .type_step(text::SMALL)
            .child(icon(Glyph::Terminal, px(14.), p.text_secondary))
            .child(
                div()
                    .flex_none()
                    .type_step(text::SMALL_STRONG)
                    .child(run.props.title.clone()),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(ui.mono.clone())
                    .text_color(p.text_muted)
                    .child(run.props.label.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .flex_none()
                    .child(icon(status_glyph, px(12.), tint))
                    .child(div().text_color(p.text_secondary).child(status)),
            )
            .child(div().flex_1())
            .child(end_actions);
        let mut body = div()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .rounded_b(radius::PANEL);
        if let Phase::Ended {
            exit: CommandExit::LaunchFailed(reason),
            ..
        } = &run.phase
        {
            body = body
                .p(space::S4)
                .type_step(text::SMALL)
                .child(reason.clone());
        } else {
            body = body.children(drawer.session.clone());
        }
        let height = if drawer.taller {
            0.60
        } else if run.props.size == CommandControlSize::Compact {
            0.25
        } else {
            0.35
        };
        Some(
            div()
                .id("command-drawer")
                .relative()
                .h(relative(height))
                .flex_none()
                .mx(space::S3)
                .my(space::S3)
                .flex()
                .flex_col()
                .rounded(radius::PANEL)
                .hairline(p.border)
                .bg(p.surface)
                .child(header)
                .child(body)
                .when_some(run.fallback.as_ref(), |d, message| {
                    d.child(
                        div()
                            .px(space::S4)
                            .py(space::S2)
                            .type_step(text::SMALL)
                            .text_color(p.text_secondary)
                            .child(message.clone()),
                    )
                })
                .into_any_element(),
        )
    }
}

fn command_menu(
    run: &Run,
    taller: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let p = ui.p;
    let size_label = if taller {
        "Restore height"
    } else {
        "Make taller"
    };
    let has_output = !matches!(
        run.phase,
        Phase::Ended {
            exit: CommandExit::LaunchFailed(_),
            ..
        }
    );
    let entries = [
        ("copy-output", Glyph::Copy, "Copy output", "", has_output),
        (
            "open-fallback",
            Glyph::ExternalLink,
            "Open in Terminal app",
            "",
            true,
        ),
        (
            "taller",
            Glyph::Maximize,
            size_label,
            if cfg!(target_os = "macos") {
                "⌘↑"
            } else {
                "Ctrl⇧↑"
            },
            true,
        ),
        (
            "stop-command",
            Glyph::Stop,
            "Stop command",
            "⌃C",
            run.running(),
        ),
    ];
    let mut menu = div()
        .id("command-actions")
        .w(px(220.))
        .p(space::S2)
        .shadow_lg()
        .rounded(radius::PANEL)
        .hairline(p.border)
        .bg(p.raised)
        .type_step(text::SMALL)
        .on_mouse_down_out(cx.listener(|app, _, _, cx| {
            if app.panels.command.menu {
                app.panels.command.menu = false;
                cx.notify();
            }
        }));
    for (id, glyph, label, key, enabled) in entries {
        let fg = if enabled {
            p.text_primary
        } else {
            p.text_muted
        };
        let row = div()
            .id(id)
            .h(px(28.))
            .px(space::S3)
            .flex()
            .items_center()
            .gap(space::S3)
            .rounded(radius::CONTROL)
            .text_color(fg)
            .child(icon(glyph, px(14.), fg))
            .child(label)
            .child(div().flex_1())
            .child(div().text_color(p.text_muted).child(key))
            .when(enabled, |row| {
                row.focusable()
                    .cursor_pointer()
                    .hover(move |d| d.bg(p.surface_2))
                    .on_click(cx.listener(move |app, _, _, cx| match id {
                        "copy-output" => app.copy_drawer_output(cx),
                        "open-fallback" => app.open_command_fallback(cx),
                        "taller" => app.make_command_taller(cx),
                        "stop-command" => app.stop_drawer_command(cx),
                        _ => unreachable!(),
                    }))
            });
        menu = menu.child(row);
    }
    menu
}

#[cfg(feature = "screenshots")]
#[path = "command_screenshots.rs"]
pub(crate) mod screenshots;
#[cfg(feature = "screenshots")]
pub(crate) use screenshots::capture;

#[cfg(test)]
mod tests {
    use super::*;
    use hack_desktop_core::execution::ExecutionContext;

    #[test]
    fn checked_argv_and_selectors_reach_the_pty_without_shell_interpolation() {
        let context = ExecutionContext::from_values(&[
            ("HOME".into(), "/tmp".into()),
            ("PATH".into(), "/usr/bin:.:/bin".into()),
            ("HACK_RUNTIME_BACKEND".into(), "compose".into()),
            ("DOCKER_CONTEXT".into(), "desktop-linux".into()),
            ("DOCKER_CONFIG".into(), "/tmp/example-docker".into()),
        ])
        .unwrap();
        let command = CommandSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(),
                "printf '%s\\n' \"$HOME|$PATH|$HACK_RUNTIME_BACKEND|$DOCKER_CONTEXT|$DOCKER_CONFIG|$TERM|$1\"; exit 7".into(),
                "fixture".into(), "literal ; $(false)".into()],
        };
        let spec = context.bind(&command).unwrap();
        let props = CommandControl {
            id: "test:context".into(),
            title: "Terminal".into(),
            label: "hack global install".into(),
            size: CommandControlSize::Standard,
            availability: CommandAvailability::Ready(spec.clone()),
            cwd: None,
            expects_password: false,
        };
        let cwd = command_directory(&props, &spec).unwrap();
        let copy = spec.display_in(cwd.as_deref()).unwrap();
        assert!(copy.starts_with("cd '/tmp' && '/usr/bin/env' '-i'"));
        assert!(copy.ends_with("'literal ; $(false)'"));
        let mut core = command_core(&props, &spec, cwd).unwrap();
        core.settle(Duration::from_secs(3), Duration::from_secs(4));
        assert_eq!(core.exit_status(), Some(ExitInfo::Exited(7)));
        let output = core.emu().output_text().expect("captured terminal output");
        assert!(output.contains("/tmp|/usr/bin:/bin|compose|desktop-linux|/tmp/example-docker|xterm-256color|literal ; $(false)"), "{output}");
        assert!(output.contains("exit 7"));
    }

    #[test]
    fn failure_diagnosis_prefers_the_last_cli_hint() {
        assert_eq!(
            diagnosis("error: something failed\nhint Try again\nexit 1").as_deref(),
            Some("Try again")
        );
        assert_eq!(
            diagnosis("error Failed to run").as_deref(),
            Some("Failed to run")
        );
        assert_eq!(diagnosis("errors reported\nexit 1"), None);
    }
}
