//! Spike window: a per-project bottom panel with terminal tabs, all drawn
//! by the same libghostty-vt component.
//!
//! Tabs: `logs` (a read-only stream), a container shell, the host login
//! shell, and a host shell with an env overlay (with its badge).
//!
//! ```sh
//! cargo run -p hack-desktop-term --features ghostty --example term_spike
//! cargo run -p hack-desktop-term --features ghostty --example term_spike -- --file app.log
//! # Real CLI sessions, in a real Hack project (manual; needs a running service):
//! cargo run -p hack-desktop-term --features ghostty --example term_spike -- \
//!     --project /path/to/project --hack "$(command -v hack)" --service api --env staging --scope api
//! cargo run -p hack-desktop-term --features screenshots --example term_spike -- --screenshots DIR
//! ```
//!
//! Without `--hack` and `--service`, the two CLI-backed tabs run a stand-in
//! script that checks the argv the app would pass to `hack` and then starts
//! a plain shell. The stand-in can pretend the container has no `bash`
//! (the default), which shows the fallback to `sh`.
//!
//! Keys in this example (the crate itself binds none): ctrl-` toggle the
//! panel, ctrl-shift-t new host shell, ctrl-shift-w close tab,
//! ctrl-pagedown / ctrl-pageup next / previous tab, ctrl-shift-m maximize,
//! ctrl-shift-f find. Closing the window ends every session.

use std::path::{Path, PathBuf};

use gpui_kit::component::{ActiveTheme as _, Theme, ThemeMode};
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, InteractiveElement as _, IntoElement,
    KeyBinding, ParentElement as _, Render, Styled as _, Window, WindowBounds, WindowOptions, div,
    px, size,
};
use hack_desktop_term::actions::{
    CloseTab, Find, NewTab, NextTab, PrevTab, ToggleMaximize, TogglePanel,
};
use hack_desktop_term::ghostty_config::{ConfigEnv, GhosttyLook};
use hack_desktop_term::launch::{
    HackCli, LoginShell, Name, SessionPlan, TermChoice, container_shell, host_shell,
    host_shell_with_env,
};
use hack_desktop_term::panel::{PanelEvent, TerminalPanel};
use hack_desktop_term::stream::{ProcessSpec, StreamSource};
use hack_desktop_term::terminal::TerminalCore;
use hack_desktop_term::view::TerminalView;

struct Args {
    source: Option<StreamSource>,
    theme: Option<ThemeMode>,
    screenshots: Option<PathBuf>,
    project: Option<PathBuf>,
    hack: Option<PathBuf>,
    service: String,
    overlay: String,
    scope: String,
    use_ghostty_config: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: term_spike [--file PATH | --cmd PROGRAM [ARGS...]] [--theme light|dark]\n\
         \x20                 [--project DIR] [--hack PATH --service NAME [--env OVERLAY --scope SCOPE]]\n\
         \x20                 [--no-ghostty-config] [--screenshots DIR]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        source: None,
        theme: None,
        screenshots: None,
        project: None,
        hack: None,
        service: "api".into(),
        overlay: "staging".into(),
        scope: "api".into(),
        use_ghostty_config: true,
    };
    let mut it = std::env::args().skip(1);
    let next = |it: &mut dyn Iterator<Item = String>| it.next().unwrap_or_else(|| usage());
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--file" => a.source = Some(StreamSource::File(next(&mut it).into())),
            "--cmd" => {
                let mut spec = ProcessSpec::new(next(&mut it));
                spec.args = it.by_ref().map(Into::into).collect();
                a.source = Some(StreamSource::Process(spec));
            }
            "--theme" => {
                a.theme = Some(match next(&mut it).as_str() {
                    "light" => ThemeMode::Light,
                    "dark" => ThemeMode::Dark,
                    _ => usage(),
                })
            }
            "--screenshots" => a.screenshots = Some(next(&mut it).into()),
            "--project" => a.project = Some(next(&mut it).into()),
            "--hack" => a.hack = Some(next(&mut it).into()),
            "--service" => a.service = next(&mut it),
            "--env" => a.overlay = next(&mut it),
            "--scope" => a.scope = next(&mut it),
            "--no-ghostty-config" => a.use_ghostty_config = false,
            _ => usage(),
        }
    }
    a
}

/// A 10,000-line log with levels, colours, a wide-character line, an OSC 8
/// link and a progress line, written to a private temp file.
fn demo_log(dir: &Path) -> PathBuf {
    let path = dir.join("demo.log");
    let mut s = String::new();
    let services = ["api", "worker", "web", "db"];
    for i in 0..10_000u32 {
        let svc = services[(i % 4) as usize];
        let (lvl, colour) = match i % 17 {
            0 => ("ERROR", "\x1b[1;31m"),
            3 | 11 => ("WARN ", "\x1b[33m"),
            5 => ("DEBUG", "\x1b[2m"),
            _ => ("INFO ", "\x1b[32m"),
        };
        s.push_str(&format!(
            "\x1b[90m12:{:02}:{:02}.{:03}\x1b[0m \x1b[36m{svc:<6}\x1b[0m {colour}{lvl}\x1b[0m request {i} handled in \x1b[38;2;120;170;255m{}ms\x1b[0m",
            (i / 60) % 60,
            i % 60,
            (i * 37) % 1000,
            (i * 7) % 250
        ));
        if i % 500 == 250 {
            s.push_str(" — 日本語 wide text ✓");
        }
        if i % 1000 == 999 {
            s.push_str(" docs: \x1b]8;;https://example.invalid/docs\x1b\\example.invalid/docs\x1b]8;;\x1b\\");
        }
        s.push('\n');
    }
    std::fs::write(&path, s).expect("write demo log");
    path
}

/// A stand-in for the `hack` CLI: it checks the argv the app passes, then
/// starts a plain shell. See the module docs.
fn write_stand_in(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = r#"#!/bin/sh
case "$1" in
  exec)
    [ "$#" -eq 4 ] && [ "$3" = "--" ] || { echo "stand-in: bad exec argv: $*" >&2; exit 2; }
    if [ "$4" = bash ] && [ -z "$STAND_IN_HAS_BASH" ]; then
      echo 'exec: "bash": executable file not found in $PATH' >&2
      exit 127
    fi
    printf '\033[2m(stand-in for: hack exec %s -- %s)\033[0m\n' "$2" "$4"
    HOME=/root PS1="root@$2:/app# " exec /bin/sh
    ;;
  host)
    [ "$#" -eq 6 ] && [ "$2" = shell ] && [ "$3" = --env ] && [ "$5" = --scope ] \
      || { echo "stand-in: bad host argv: $*" >&2; exit 2; }
    printf '\033[2m(stand-in for: hack host shell --env %s --scope %s)\033[0m\n' "$4" "$6"
    exec "${SHELL:-/bin/sh}" -l
    ;;
  *) echo "stand-in: unknown command: $*" >&2; exit 2 ;;
esac
"#;
    let pending = dir.join("hack-stand-in.pending");
    std::fs::write(&pending, script).expect("write stand-in");
    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let path = dir.join("hack-stand-in");
    std::fs::rename(&pending, &path).expect("rename");
    path
}

/// A home directory whose `.profile` gives `/bin/sh` a prompt in the style
/// of a themed zsh or starship prompt: truecolour segments and Nerd Font
/// glyphs. Also a `showcase` command for the rendering checks.
fn write_themed_home(dir: &Path) -> PathBuf {
    let home = dir.join("home");
    std::fs::create_dir_all(&home).expect("home");
    let e = '\x1b';
    // Folder U+F07C, branch U+E0A0, powerline separator U+E0B0.
    let profile = format!(
        "PS1='\n{e}[48;2;76;86;106m{e}[38;2;236;239;244m \u{f07c} project {e}[48;2;94;129;172m{e}[38;2;76;86;106m\u{e0b0}{e}[38;2;236;239;244m \u{e0a0} main {e}[0m{e}[38;2;94;129;172m\u{e0b0}{e}[0m\n{e}[38;2;163;190;140m\u{276f}{e}[0m '\n\
         showcase() {{\n\
         printf '\\033[1mbold\\033[0m \\033[3mitalic\\033[0m \\033[1;3mbold italic\\033[0m \\033[4munderline\\033[0m \\033[9mstrike\\033[0m \\033[2mfaint\\033[0m\\n'\n\
         printf 'wide: 日本語 한국어 ✓   glyphs: \u{e0b0} \u{e0a0} \u{f07c} \u{f418} \u{f120}   link: \\033]8;;https://example.invalid/docs\\033\\\\example.invalid/docs\\033]8;;\\033\\\\\\n'\n\
         i=0; while [ $i -lt 64 ]; do printf '\\033[48;2;%d;%d;%dm ' $((i * 4)) $((255 - i * 4)) 160; i=$((i + 1)); done; printf '\\033[0m\\n'\n\
         i=0; while [ $i -lt 16 ]; do printf '\\033[48;5;%dm  ' $i; i=$((i + 1)); done; printf '\\033[0m\\n'\n\
         }}\n"
    );
    std::fs::write(home.join(".profile"), profile).expect("profile");
    home
}

/// How each tab is started, decided once from the arguments.
struct Sessions {
    logs: StreamSource,
    project: PathBuf,
    cli: HackCli,
    real_cli: bool,
    service: Name,
    overlay: Name,
    scope: Name,
    shell: LoginShell,
    /// Extra environment for the fixture sessions of the screenshot run.
    fixture_env: Vec<(String, String)>,
}

impl Sessions {
    fn new(args: &Args, tmp: &Path, fixtures: bool) -> Self {
        std::fs::create_dir_all(tmp).expect("session temp dir");
        let name = |s: &str| {
            Name::new(s).unwrap_or_else(|e| {
                eprintln!("{s:?}: {e}");
                std::process::exit(2)
            })
        };
        let project = args
            .project
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| tmp.to_owned());
        let real_cli = args.hack.is_some() && !fixtures;
        let (shell, fixture_env, project) = if fixtures {
            // Deterministic and hermetic for the capture.
            let home = write_themed_home(tmp);
            (
                LoginShell {
                    path: "/bin/sh".into(),
                },
                vec![
                    ("HOME".to_owned(), home.display().to_string()),
                    ("SHELL".to_owned(), "/bin/sh".to_owned()),
                    ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ],
                home,
            )
        } else {
            (LoginShell::detect(), Vec::new(), project)
        };
        Self {
            logs: args
                .source
                .clone()
                .unwrap_or_else(|| StreamSource::File(demo_log(tmp))),
            cli: HackCli {
                program: match (&args.hack, real_cli) {
                    (Some(hack), true) => hack.clone(),
                    _ => write_stand_in(tmp),
                },
                project_root: project.clone(),
            },
            project,
            real_cli,
            service: name(&args.service),
            overlay: name(&args.overlay),
            scope: name(&args.scope),
            shell,
            fixture_env,
        }
    }

    fn prepare(&self, mut plan: SessionPlan) -> SessionPlan {
        if !self.fixture_env.is_empty() {
            for attempt in &mut plan.attempts {
                attempt.options.env_clear = true;
                for (k, v) in &self.fixture_env {
                    attempt.options.env.push((k.into(), v.into()));
                }
            }
        }
        plan
    }

    fn container(&self) -> SessionPlan {
        self.prepare(container_shell(&self.cli, &self.service))
    }

    fn host(&self) -> SessionPlan {
        self.prepare(host_shell(
            &self.project,
            &self.shell,
            TermChoice::default(),
        ))
    }

    fn host_with_env(&self) -> SessionPlan {
        // A real app reads the default overlay from `hack env list --json`.
        let is_default = self.overlay.as_str() == "default";
        self.prepare(host_shell_with_env(
            &self.cli,
            &self.shell,
            &self.overlay,
            &self.scope,
            is_default,
            TermChoice::default(),
        ))
    }
}

/// The window: a stand-in for the project's content above, the terminal
/// panel below.
struct Spike {
    panel: Entity<TerminalPanel>,
    sessions: Sessions,
    look: GhosttyLook,
}

impl Spike {
    fn add(
        &mut self,
        core: std::io::Result<TerminalCore>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<TerminalView>> {
        let core = match core {
            Ok(core) => core,
            Err(error) => {
                eprintln!("could not start the session: {error}");
                return None;
            }
        };
        let look = self.look.clone();
        let view = cx.new(|cx| {
            let mut view = TerminalView::from_core(core, cx);
            view.set_look(look, cx);
            view
        });
        self.panel
            .update(cx, |p, cx| p.add_tab(view.clone(), window, cx));
        Some(view)
    }

    /// The four tabs, in order: logs, container shell, host shell, host
    /// shell with env.
    fn open_all(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Option<Entity<TerminalView>>> {
        let logs = TerminalCore::stream(&self.sessions.logs, 10_000);
        let container = TerminalCore::session(self.sessions.container());
        let host = TerminalCore::session(self.sessions.host());
        let host_env = TerminalCore::session(self.sessions.host_with_env());
        [logs, container, host, host_env]
            .into_iter()
            .map(|core| self.add(core, window, cx))
            .collect()
    }

    fn new_host_shell(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let core = TerminalCore::session(self.sessions.host());
        self.add(core, window, cx);
    }
}

impl Render for Spike {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme();
        let (visible, maximized) = {
            let p = self.panel.read(cx);
            (p.is_visible(), p.is_maximized())
        };
        let cli_note = if self.sessions.real_cli {
            "CLI tabs run the real hack CLI."
        } else {
            "CLI tabs run a stand-in for hack (pass --hack and --service for the real CLI)."
        };
        let content = (!maximized).then(|| {
            div()
                .flex_1()
                .min_h_0()
                .p(px(16.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_size(px(12.))
                .text_color(t.muted_foreground)
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(t.foreground)
                        .child("Project content"),
                )
                .child(cli_note)
                .child(
                    "ctrl-` panel · ctrl-shift-t new host shell · ctrl-shift-w close · \
                     ctrl-pagedown/pageup tabs · ctrl-shift-m maximize · ctrl-shift-f find",
                )
        });
        // The panel stays in the tree when hidden (it draws nothing), so
        // its actions remain reachable.
        let slot = div().border_color(t.border).child(self.panel.clone());
        let slot = match (visible, maximized) {
            (false, _) => slot.flex_none(),
            (true, true) => slot.flex_1().min_h_0(),
            (true, false) => slot.h(px(420.)).flex_none().border_t_1(),
        };
        div()
            .id("spike")
            .size_full()
            .flex()
            .flex_col()
            .bg(t.background)
            // These also work when focus is outside the panel.
            .on_action(cx.listener(|this, _: &TogglePanel, window, cx| {
                this.panel.update(cx, |p, cx| p.toggle(window, cx));
            }))
            .on_action(cx.listener(|this, _: &NewTab, window, cx| {
                this.new_host_shell(window, cx);
            }))
            .children(content)
            .child(slot)
    }
}

fn window_options(height: f32) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1280.), px(height)),
        })),
        app_id: Some("dance.hack.desktop.term-spike".into()),
        ..WindowOptions::default()
    }
}

type Tabs = Vec<Option<Entity<TerminalView>>>;

fn build(
    sessions: Sessions,
    look: GhosttyLook,
    window: &mut Window,
    cx: &mut App,
) -> (Entity<Spike>, Tabs) {
    let panel = cx.new(TerminalPanel::new);
    let spike = cx.new(|cx| {
        cx.subscribe_in(
            &panel,
            window,
            |this: &mut Spike, _, event, window, cx| match event {
                PanelEvent::NewTabRequested => this.new_host_shell(window, cx),
                PanelEvent::Changed => cx.notify(),
            },
        )
        .detach();
        Spike {
            panel,
            sessions,
            look,
        }
    });
    let tabs = spike.update(cx, |s, cx| s.open_all(window, cx));
    (spike, tabs)
}

fn bind_example_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-`", TogglePanel, None),
        KeyBinding::new("ctrl-shift-t", NewTab, None),
        KeyBinding::new("ctrl-shift-w", CloseTab, None),
        KeyBinding::new("ctrl-pagedown", NextTab, None),
        KeyBinding::new("ctrl-pageup", PrevTab, None),
        KeyBinding::new("ctrl-shift-m", ToggleMaximize, None),
        KeyBinding::new("ctrl-shift-f", Find, None),
    ]);
}

fn main() {
    let args = parse_args();
    let tmp = std::env::temp_dir().join(format!("hack-term-spike-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("temp dir");

    if let Some(dir) = &args.screenshots {
        #[cfg(feature = "screenshots")]
        screenshots::run(&args, &tmp, dir);
        let _ = std::fs::remove_dir_all(&tmp);
        if cfg!(not(feature = "screenshots")) {
            eprintln!(
                "--screenshots {} needs --features screenshots",
                dir.display()
            );
            std::process::exit(2);
        }
        return;
    }

    let sessions = Sessions::new(&args, &tmp, false);
    let theme = args.theme;
    let use_config = args.use_ghostty_config;
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            bind_example_keys(cx);
            cx.on_window_closed(|cx, _| cx.quit()).detach();
            gpui_kit::open_window(window_options(760.), cx, move |window, cx| {
                match theme {
                    Some(mode) => Theme::change(mode, Some(window), cx),
                    None => Theme::sync_system_appearance(Some(window), cx),
                }
                // The user's own Ghostty look, if they have a config.
                let look = if use_config {
                    GhosttyLook::load(&ConfigEnv::from_process(), cx.theme().is_dark())
                } else {
                    GhosttyLook::default()
                };
                let (spike, _tabs) = build(sessions, look, window, cx);
                // Start on the host shell.
                let panel = spike.read(cx).panel.clone();
                panel.update(cx, |p, cx| p.activate(2, window, cx));
                spike
            })
            .expect("open window");
        });
    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(feature = "screenshots")]
mod screenshots {
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use gpui_kit::component::{Theme, ThemeMode};
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{Entity, HeadlessAppContext, WindowOptions};
    use hack_desktop_term::ghostty_config::{ConfigEnv, GhosttyLook};
    use hack_desktop_term::view::TerminalView;

    use super::{Args, Sessions, build, window_options};

    const QUIET: Duration = Duration::from_millis(350);
    const DEADLINE: Duration = Duration::from_secs(20);

    /// A Ghostty config a user might have, written into the fixture home:
    /// a Nerd Font, a smaller size, a theme, a bar cursor and more padding.
    fn fixture_look(tmp: &Path) -> GhosttyLook {
        let home = tmp.join("ghostty-home");
        let dir = home.join(".config/ghostty");
        std::fs::create_dir_all(dir.join("themes")).expect("config dir");
        std::fs::write(
            dir.join("config"),
            "font-family = JetBrainsMono Nerd Font\nfont-size = 10.5\ntheme = Fixture Mocha\n\
             cursor-style = bar\nwindow-padding-x = 12\nwindow-padding-y = 8\n",
        )
        .expect("config");
        std::fs::write(
            dir.join("themes/Fixture Mocha"),
            "background = #1e1e2e\nforeground = #cdd6f4\n\
             palette = 0=#45475a\npalette = 1=#f38ba8\npalette = 2=#a6e3a1\npalette = 3=#f9e2af\n\
             palette = 4=#89b4fa\npalette = 5=#f5c2e7\npalette = 6=#94e2d5\npalette = 7=#bac2de\n\
             palette = 8=#585b70\npalette = 9=#f38ba8\npalette = 10=#a6e3a1\npalette = 11=#f9e2af\n\
             palette = 12=#89b4fa\npalette = 13=#f5c2e7\npalette = 14=#94e2d5\npalette = 15=#a6adc8\n",
        )
        .expect("theme");
        GhosttyLook::load(
            &ConfigEnv {
                home: Some(home),
                ..ConfigEnv::default()
            },
            true,
        )
    }

    fn settle(cx: &mut HeadlessAppContext, view: &Entity<TerminalView>) {
        cx.update(|cx| view.update(cx, |v, cx| v.settle(QUIET, DEADLINE, cx)));
    }

    fn type_and_settle(cx: &mut HeadlessAppContext, view: &Entity<TerminalView>, text: &str) {
        cx.update(|cx| view.update(cx, |v, cx| v.type_text(text, cx)));
        settle(cx, view);
    }

    /// One window with all four tabs; writes a PNG for each tab in `shots`.
    fn round(
        cx: &mut HeadlessAppContext,
        args: &Args,
        tmp: &Path,
        mode: ThemeMode,
        look: &GhosttyLook,
        shots: &[(usize, String)],
        dir: &Path,
    ) {
        cx.update(|cx| Theme::change(mode, None, cx));
        let options = WindowOptions {
            focus: false,
            show: false,
            ..window_options(600.)
        };
        let sessions = Sessions::new(args, tmp, true);
        let look = look.clone();
        let mut tabs = Vec::new();
        let (handle, spike) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    let (spike, built) = build(sessions, look, window, cx);
                    tabs = built;
                    spike
                })
            })
            .expect("open offscreen window");
        let tabs: Vec<Entity<TerminalView>> = tabs.into_iter().flatten().collect();
        assert_eq!(tabs.len(), 4, "every tab started");
        // The first frame sizes the grids; then let every session reach its prompt.
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .expect("layout");
        for view in &tabs {
            settle(cx, view);
        }
        cx.update(|cx| {
            tabs[0].update(cx, |v, cx| {
                v.search("error", cx);
                v.search_step(true, cx);
            });
        });
        type_and_settle(
            cx,
            &tabs[1],
            "echo \"a shell inside the service container\"; ls -1 / | head -4\n",
        );
        type_and_settle(cx, &tabs[2], "showcase\n");
        type_and_settle(
            cx,
            &tabs[3],
            "echo \"the CLI injected the overlay; the app passed only its name\"\n",
        );
        let panel = cx.update(|cx| spike.read(cx).panel.clone());
        for (index, name) in shots {
            cx.update_window(handle, |_, window, cx| {
                panel.update(cx, |p, cx| p.activate(*index, window, cx));
            })
            .expect("activate");
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("render");
            // The grid is sized on the first frame of a newly shown tab;
            // let output for the new size arrive, then draw again.
            settle(cx, &tabs[*index]);
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("render");
            let image = cx
                .capture_screenshot(handle)
                .expect("offscreen rendering must be available");
            let path = dir.join(name);
            image.save(&path).expect("write png");
            println!("{}", path.display());
        }
        cx.update_window(handle, |_, window, _| window.remove_window())
            .ok();
        // Dropping the views ends every session of this round.
        drop((tabs, spike, panel));
        cx.update(|_| {});
    }

    pub fn run(args: &Args, tmp: &Path, dir: &Path) {
        std::fs::create_dir_all(dir).expect("create screenshot dir");
        let mut cx = HeadlessAppContext::with_platform(
            gpui_kit::platform::current_platform(true).text_system(),
            Arc::new(gpui_kit::assets::Assets),
            gpui_kit::platform::current_headless_renderer,
        );
        cx.update(gpui_kit::init);
        let plain = GhosttyLook::default();
        let shot = |i: usize, name: &str| (i, name.to_owned());
        round(
            &mut cx,
            args,
            &tmp.join("dark"),
            ThemeMode::Dark,
            &plain,
            &[
                shot(0, "panel-logs-dark.png"),
                shot(1, "panel-container-dark.png"),
                shot(2, "panel-host-dark.png"),
                shot(3, "panel-host-env-dark.png"),
            ],
            dir,
        );
        round(
            &mut cx,
            args,
            &tmp.join("light"),
            ThemeMode::Light,
            &plain,
            &[shot(2, "panel-host-light.png")],
            dir,
        );
        let look = fixture_look(tmp);
        round(
            &mut cx,
            args,
            &tmp.join("look"),
            ThemeMode::Dark,
            &look,
            &[shot(2, "panel-host-ghostty-look-dark.png")],
            dir,
        );
    }
}
