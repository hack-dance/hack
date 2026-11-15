//! Spike window: a read-only log stream (left) beside an interactive shell
//! on an app-owned PTY (right), both drawn by the libghostty-vt surface.
//!
//! ```sh
//! cargo run -p hack-desktop-term --features ghostty --example term_spike
//! cargo run -p hack-desktop-term --features ghostty --example term_spike -- --file app.log
//! cargo run -p hack-desktop-term --features ghostty --example term_spike -- --cmd /bin/sh -c 'ls --color=always'
//! cargo run -p hack-desktop-term --features screenshots --example term_spike -- --screenshot shot.png
//! ```
//!
//! Without `--file`/`--cmd` the stream is a generated 10,000-line ANSI log.
//! Closing the window ends the shell's whole session.

use std::path::{Path, PathBuf};

use gpui_kit::component::{ActiveTheme as _, Theme, ThemeMode};
use gpui_kit::{
    AppContext as _, Bounds, Context, Entity, Focusable as _, IntoElement, ParentElement as _,
    Render, Styled as _, Window, WindowBounds, WindowOptions, div, px, size,
};
use hack_desktop_term::pty::{PtyOptions, PtySize};
use hack_desktop_term::stream::{ProcessSpec, StreamSource};
use hack_desktop_term::view::TerminalView;

struct Args {
    source: Option<StreamSource>,
    theme: Option<ThemeMode>,
    screenshot: Option<PathBuf>,
}

fn usage() -> ! {
    eprintln!(
        "usage: term_spike [--file PATH | --cmd PROGRAM [ARGS...]] [--theme light|dark] [--screenshot OUT.png]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        source: None,
        theme: None,
        screenshot: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--file" => {
                a.source = Some(StreamSource::File(
                    it.next().unwrap_or_else(|| usage()).into(),
                ))
            }
            "--cmd" => {
                let program = it.next().unwrap_or_else(|| usage());
                let mut spec = ProcessSpec::new(program);
                spec.args = it.by_ref().map(Into::into).collect();
                a.source = Some(StreamSource::Process(spec));
            }
            "--theme" => {
                a.theme = Some(match it.next().as_deref() {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    _ => usage(),
                })
            }
            "--screenshot" => a.screenshot = Some(it.next().unwrap_or_else(|| usage()).into()),
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

fn shell_options(screenshot: bool) -> PtyOptions {
    let mut o = if screenshot {
        // Hermetic and deterministic for the capture.
        let mut o = PtyOptions::new("/bin/sh");
        o.env.push(("PS1".into(), "$ ".into()));
        o.env_remove.push("ENV".into());
        o
    } else {
        PtyOptions::new(std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into()))
    };
    o.env.push(("COLORTERM".into(), "truecolor".into()));
    o.size = PtySize::cells(80, 24);
    o
}

struct Spike {
    logs: Entity<TerminalView>,
    shell: Entity<TerminalView>,
}

impl Render for Spike {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme();
        let follow = self.logs.read(cx).follow();
        let header = |title: &str, hint: String| {
            div()
                .flex()
                .justify_between()
                .px(px(12.))
                .py(px(6.))
                .text_size(px(12.))
                .text_color(t.muted_foreground)
                .border_b_1()
                .border_color(t.border)
                .child(div().text_color(t.foreground).child(title.to_owned()))
                .child(hint)
        };
        let pane = |title: &str, hint: String, body: Entity<TerminalView>| {
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .border_1()
                .border_color(t.border)
                .rounded(px(8.))
                .overflow_hidden()
                .child(header(title, hint))
                .child(div().flex_1().min_h_0().child(body))
        };
        div()
            .size_full()
            .flex()
            .gap(px(10.))
            .p(px(10.))
            .bg(t.background)
            .child(pane(
                "Logs (read-only stream)",
                format!(
                    "follow {} · f toggles · Ctrl-Shift-F find",
                    if follow { "on" } else { "off" }
                ),
                self.logs.clone(),
            ))
            .child(pane(
                "Shell (app-owned PTY)",
                "Ctrl-Shift-C copy · Ctrl-Shift-V paste".into(),
                self.shell.clone(),
            ))
    }
}

fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1280.), px(760.)),
        })),
        app_id: Some("dance.hack.desktop.term-spike".into()),
        ..WindowOptions::default()
    }
}

fn build(
    source: &StreamSource,
    screenshot: bool,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) -> Entity<Spike> {
    let logs = cx.new(|cx| TerminalView::new_stream(source, 10_000, cx).expect("open stream"));
    let shell =
        cx.new(|cx| TerminalView::new_pty(&shell_options(screenshot), cx).expect("spawn shell"));
    let focus = shell.read(cx).focus_handle(cx);
    window.focus(&focus, cx);
    cx.new(|cx| {
        cx.observe(&logs, |_, _, cx| cx.notify()).detach();
        Spike { logs, shell }
    })
}

fn main() {
    let args = parse_args();
    let tmp = std::env::temp_dir().join(format!("hack-term-spike-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("temp dir");
    let source = args
        .source
        .clone()
        .unwrap_or_else(|| StreamSource::File(demo_log(&tmp)));

    if let Some(out) = &args.screenshot {
        #[cfg(feature = "screenshots")]
        screenshot::run(&source, args.theme.unwrap_or(ThemeMode::Dark), out);
        let _ = std::fs::remove_dir_all(&tmp);
        if cfg!(not(feature = "screenshots")) {
            eprintln!(
                "--screenshot {} needs --features screenshots",
                out.display()
            );
            std::process::exit(2);
        }
        return;
    }

    let theme = args.theme;
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.on_window_closed(|cx, _| cx.quit()).detach();
            gpui_kit::open_window(window_options(), cx, move |window, cx| {
                match theme {
                    Some(mode) => Theme::change(mode, Some(window), cx),
                    None => Theme::sync_system_appearance(Some(window), cx),
                }
                build(&source, false, window, cx)
            })
            .expect("open window");
        });
    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(feature = "screenshots")]
mod screenshot {
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use gpui_kit::component::{Theme, ThemeMode};
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_term::stream::StreamSource;

    pub fn run(source: &StreamSource, mode: ThemeMode, out: &Path) {
        let mut cx = HeadlessAppContext::with_platform(
            gpui_kit::platform::current_platform(true).text_system(),
            Arc::new(gpui_kit::assets::Assets),
            gpui_kit::platform::current_headless_renderer,
        );
        cx.update(gpui_kit::init);
        cx.update(|cx| Theme::change(mode, None, cx));
        let opts = WindowOptions {
            focus: false,
            show: false,
            ..super::window_options()
        };
        let (handle, spike) = cx
            .update(|cx| {
                gpui_kit::open_window(opts, cx, |window, cx| {
                    super::build(source, true, window, cx)
                })
            })
            .expect("open offscreen window");
        // First frame sizes both grids.
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .expect("layout");
        let (logs, shell) = cx.update(|cx| {
            let s = spike.read(cx);
            (s.logs.clone(), s.shell.clone())
        });
        let quiet = Duration::from_millis(400);
        let deadline = Duration::from_secs(20);
        cx.update(|cx| {
            logs.update(cx, |v, cx| {
                v.settle(quiet, deadline, cx);
                v.search("error", cx);
                v.search_step(true, cx);
            });
            shell.update(cx, |v, cx| {
                v.settle(quiet, deadline, cx);
                v.type_text(
                    "printf '\\033[1;32mok\\033[0m \\033[33mwarn\\033[0m \\033[7minverse\\033[0m \\033[4munderline\\033[0m 日本 ✓\\n'; for c in 1 2 3 4 5 6; do printf \"\\033[4${c}m  \\033[0m\"; done; echo; echo selection demo line\n",
                );
                v.settle(quiet, deadline, cx);
                v.emulator().select_start(2, 2);
                v.emulator().select_to(19, 3);
            });
        });
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .expect("render");
        let img = cx
            .capture_screenshot(handle)
            .expect("offscreen rendering must be available");
        img.save(out).expect("write png");
        println!("{}", out.display());
        cx.update_window(handle, |_, window, _| window.remove_window())
            .ok();
        // Dropping the views ends the shell session.
        drop((logs, shell, spike));
        cx.update(|_| {});
    }
}
