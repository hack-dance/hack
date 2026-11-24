//! `--drive <steps>` (feature `terminal`): run a short script against the
//! real window, then report what the terminal tabs left running.
//!
//! The by-hand checks (keys, a container tab, an env tab, a large paste,
//! nothing left running after quit) can be run from the command line with
//! this, on live data or a fixture. Each step calls what the matching click
//! or key calls: tabs come from the panel's own new-tab menu, keys go
//! through the window's keymap, and `quit` is the platform quit, so the
//! app's quit handlers run exactly as they do when the user quits.
//!
//! `hack-desktop --drive <steps>` starts the app as a child
//! (`--drive-child`), echoes its report, waits for it to exit, waits
//! [`LINGER`] more, then counts every process still alive in a session a
//! tab started (each tab's leader is its session id). Container-side
//! processes are not host processes; `check-container` counts them through
//! the CLI after the app has gone. Exit status 0 only when every step
//! passed and nothing is left.
//!
//! Steps file, one per line (`#` starts a comment):
//!
//! ```text
//! select <project> [<branch>]     select an instance; waits for live data
//! logs                            show the Logs tab
//! host                            open "Host shell"
//! container <service>             open "Shell in <service>"
//! env <overlay> [<scope>]         open "Host shell with env…" for it
//! key <keystroke>                 dispatch a keystroke, e.g. key ctrl-c
//! type <text>                     type it, one keystroke per character
//!                                 (\r or \n is Enter, \t is Tab, \\)
//! paste <file>                    paste a file's text as the Paste action
//!                                 does (relative to the steps file)
//! expect <text> [<seconds>]       wait for text on the active tab's screen
//! use-cli <name>                  switch to the other Hack CLI found
//!                                 (hack or hack-next), as the status bar does
//! expect-cli <text> [<seconds>]   wait for the status bar's CLI label
//! expect-styled <count> [<seconds>]
//!                                 wait for at least <count> styled cells
//!                                 (colour, bold, faint…) on the active tab
//! expect-notice <text> [<seconds>]
//!                                 wait for the active tab's notice (a
//!                                 refused paste) to contain text
//! tab <services|logs|env>        show that detail tab
//! expect-usage <text> [<seconds>] wait for a line of the Services tab's
//!                                 usage: "<service> <cpu> <memory>",
//!                                 "emulated <service>" or the header total
//! upgrade                         open the Upgrade pane (runs the check and
//!                                 lists the snapshots)
//! expect-upgrade <text> [<seconds>]
//!                                 wait for a line of the Upgrade pane
//!                                 (verdict, snapshot or restore result)
//! upgrade-snapshot                Save snapshot
//! upgrade-restore                 Restore… then confirm, on the newest
//!                                 listed snapshot (never --overwrite)
//! hackd                           open the hackd pane (reads hackd's status)
//! expect-hackd <text> [<seconds>] wait for the hackd card's title, or a line
//!                                 of its always-on summary, to contain text
//! expect-env <NAME> [<seconds>]   wait for NAME in the Env listing
//! env-set <NAME> <value>          edit an existing row, as the pencil and
//!                                 Save do (rest of the line is the value)
//! env-add [--secret] <NAME> <value>
//!                                 add a variable, as + Variable and Save do
//!                                 (for a test project only: these write
//!                                 through the CLI; the report never prints
//!                                 a value, only its length)
//! wait <milliseconds>
//! check-container <service> <pattern>
//!                                 after the app quits, count processes in
//!                                 the service whose command line contains
//!                                 <pattern> (start one with `type`). A
//!                                 count above 0 is reported as known open
//!                                 (DESIGN.md R21: the app cannot end what
//!                                 a shell started inside a container) and
//!                                 does not fail the run
//! quit                            quit the app (implied at the end)
//! ```

use std::collections::BTreeSet;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use gpui_kit::{AnyWindowHandle, AppContext as _, AsyncApp, Entity, Keystroke};
use hack_desktop_core::viewmodel::InstanceKey;

use crate::terminal::NewTab;
use crate::view::HackApp;

/// How long after the app exits the leftover count is taken.
pub const LINGER: Duration = Duration::from_secs(5);
/// How long `select` waits for the instance to appear in live data.
const READY_WAIT: Duration = Duration::from_secs(60);
/// How long a tab-opening step waits for its tab.
const TAB_WAIT: Duration = Duration::from_secs(20);
/// The longest a whole drive may take before the child is killed.
const DRIVE_TIMEOUT: Duration = Duration::from_secs(600);
/// Report lines the supervisor reads start with this.
const TAG: &str = "@drive";

/// A value an env step writes. The report prints steps with `Debug`, so this
/// prints only the value's length.
#[derive(Clone, PartialEq, Eq)]
pub struct DriveValue(pub String);

impl std::fmt::Debug for DriveValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{} bytes>", self.0.len())
    }
}

/// How long an env write step waits for "Saved NAME".
const ENV_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Select {
        project: String,
        branch: Option<String>,
    },
    Logs,
    Host,
    Container(String),
    Env {
        overlay: String,
        scope: Option<String>,
    },
    Key(String),
    Type(String),
    Paste(PathBuf),
    Expect {
        text: String,
        within: Duration,
    },
    ExpectNotice {
        text: String,
        within: Duration,
    },
    UseCli(String),
    ExpectCli {
        text: String,
        within: Duration,
    },
    ExpectStyled {
        count: usize,
        within: Duration,
    },
    Wait(Duration),
    Tab(usize),
    ExpectUsage {
        text: String,
        within: Duration,
    },
    Upgrade,
    ExpectUpgrade {
        text: String,
        within: Duration,
    },
    UpgradeSnapshot,
    UpgradeRestore,
    Hackd,
    ExpectHackd {
        text: String,
        within: Duration,
    },
    ExpectEnv {
        name: String,
        within: Duration,
    },
    EnvSet {
        name: String,
        value: DriveValue,
    },
    EnvAdd {
        name: String,
        value: DriveValue,
        secret: bool,
    },
    CheckContainer {
        service: String,
        pattern: String,
    },
    Quit,
}

/// Parse a steps file. Relative `paste` paths resolve against `base`.
///
/// # Errors
/// The first line that is not a step, with its line number.
pub fn parse(text: &str, base: &Path) -> Result<Vec<Step>, String> {
    let mut out = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (word, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        let rest = rest.trim();
        let args: Vec<&str> = rest.split_whitespace().collect();
        // A line that writes an env value is never echoed: a malformed one
        // (a missing name, say) could otherwise print its value.
        let writes_value = matches!(word, "env-set" | "env-add");
        let bad = |why: &str| {
            if writes_value {
                format!(
                    "line {}: {why} (the line holds a value, so it is not shown)",
                    n + 1
                )
            } else {
                format!("line {}: {why}: {line}", n + 1)
            }
        };
        let step = match (word, args.as_slice()) {
            ("select", [p]) => Step::Select {
                project: (*p).into(),
                branch: None,
            },
            ("select", [p, b]) => Step::Select {
                project: (*p).into(),
                branch: Some((*b).into()),
            },
            ("logs", []) => Step::Logs,
            ("host", []) => Step::Host,
            ("container", [s]) => Step::Container((*s).into()),
            ("env", [o]) => Step::Env {
                overlay: (*o).into(),
                scope: None,
            },
            ("env", [o, s]) => Step::Env {
                overlay: (*o).into(),
                scope: Some((*s).into()),
            },
            ("key", [k]) => Step::Key((*k).into()),
            ("type", _) if !rest.is_empty() => Step::Type(unescape(rest)),
            ("paste", _) if !rest.is_empty() => Step::Paste(base.join(rest)),
            ("use-cli", [name]) => Step::UseCli((*name).into()),
            ("tab", [t]) => Step::Tab(match *t {
                "services" => 0,
                "logs" => 1,
                "env" => 2,
                _ => return Err(bad("tab is services, logs or env")),
            }),
            ("expect-env", [name]) => Step::ExpectEnv {
                name: (*name).into(),
                within: Duration::from_secs(20),
            },
            ("expect-env", [name, secs]) => Step::ExpectEnv {
                name: (*name).into(),
                within: Duration::from_secs(
                    secs.parse().map_err(|_| bad("not a number of seconds"))?,
                ),
            },
            ("env-set", [_, _, ..]) => {
                let (name, value) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                Step::EnvSet {
                    name: name.into(),
                    value: DriveValue(value.trim_start().into()),
                }
            }
            ("env-add", [_, _, ..]) => {
                let (secret, rest) = match rest.strip_prefix("--secret") {
                    Some(r) => (true, r.trim_start()),
                    None => (false, rest),
                };
                let (name, value) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                if value.trim().is_empty() {
                    return Err(bad("env-add needs a name and a value"));
                }
                Step::EnvAdd {
                    name: name.into(),
                    value: DriveValue(value.trim_start().into()),
                    secret,
                }
            }
            ("expect-styled", [n]) | ("expect-styled", [n, _]) => Step::ExpectStyled {
                count: n.parse().map_err(|_| bad("not a number of cells"))?,
                within: Duration::from_secs(
                    args.get(1)
                        .map(|s| s.parse().map_err(|_| bad("not a number of seconds")))
                        .transpose()?
                        .unwrap_or(10),
                ),
            },
            ("hackd", []) => Step::Hackd,
            ("upgrade", []) => Step::Upgrade,
            ("upgrade-snapshot", []) => Step::UpgradeSnapshot,
            ("upgrade-restore", []) => Step::UpgradeRestore,
            (
                "expect" | "expect-notice" | "expect-cli" | "expect-hackd" | "expect-upgrade"
                | "expect-usage",
                _,
            ) if !rest.is_empty() => {
                let (text, within) = match rest.rsplit_once(char::is_whitespace) {
                    Some((t, secs)) if secs.parse::<u64>().is_ok() => (
                        t.trim(),
                        Duration::from_secs(secs.parse().unwrap_or_default()),
                    ),
                    _ => (rest, Duration::from_secs(10)),
                };
                let text = unescape(text);
                match word {
                    "expect" => Step::Expect { text, within },
                    "expect-cli" => Step::ExpectCli { text, within },
                    "expect-hackd" => Step::ExpectHackd { text, within },
                    "expect-upgrade" => Step::ExpectUpgrade { text, within },
                    "expect-usage" => Step::ExpectUsage { text, within },
                    _ => Step::ExpectNotice { text, within },
                }
            }
            ("wait", [ms]) => Step::Wait(Duration::from_millis(
                ms.parse()
                    .map_err(|_| bad("not a number of milliseconds"))?,
            )),
            ("check-container", [s, p]) => Step::CheckContainer {
                service: (*s).into(),
                pattern: (*p).into(),
            },
            ("quit", []) => Step::Quit,
            _ => return Err(bad("not a step")),
        };
        out.push(step);
    }
    Ok(out)
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// The keystroke a user makes for `c`: Enter for a line break, Tab, Space,
/// shift for an upper-case letter, otherwise the character itself. The
/// window turns its text into input as the platform would.
fn keystroke_for(c: char) -> Keystroke {
    let (key, key_char): (String, Option<String>) = match c {
        '\r' | '\n' => ("enter".into(), None),
        '\t' => ("tab".into(), None),
        ' ' => ("space".into(), Some(" ".into())),
        c => (c.to_lowercase().collect(), Some(c.to_string())),
    };
    Keystroke {
        modifiers: gpui_kit::Modifiers {
            shift: c.is_uppercase(),
            ..Default::default()
        },
        key,
        key_char,
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{TAG} {line}");
    let _ = out.flush();
}

// ---------------------------------------------------------------- child

/// Run `steps` against the app's window, then quit the app. Runs in the
/// child (`--drive-child`) on the app's foreground executor.
pub async fn run(win: Win, steps: Vec<Step>, cx: &mut AsyncApp) {
    let handle = &win;
    let mut seen = BTreeSet::new();
    let mut ran = 0;
    let mut all = true;
    for (i, step) in steps.iter().enumerate() {
        if *step == Step::Quit {
            break;
        }
        let result = run_step(handle, step, cx).await;
        report_sessions(handle, &mut seen, cx);
        match result {
            Ok(detail) => {
                ran += 1;
                say(&format!("step {} ok {step:?}{detail}", i + 1));
            }
            Err(why) => {
                all = false;
                say(&format!("step {} failed {step:?}: {why}", i + 1));
                break;
            }
        }
    }
    // The supervisor accepts a run only with this receipt: an app that
    // exits early, even cleanly, has not run every step.
    if all {
        say(&format!("done\t{ran}"));
    }
    // Once more just before quitting: a container shell that fell back
    // from bash to sh after its step has a new leader.
    report_sessions(handle, &mut seen, cx);
    say("quit");
    cx.update(|cx| cx.quit());
}

/// The app's window and view.
pub struct Win {
    pub window: AnyWindowHandle,
    pub app: Entity<HackApp>,
}

impl Win {
    fn update<R>(
        &self,
        cx: &mut AsyncApp,
        f: impl FnOnce(&mut HackApp, &mut gpui_kit::Window, &mut gpui_kit::Context<HackApp>) -> R,
    ) -> Result<R, String> {
        let app = self.app.clone();
        cx.update_window(self.window, |_, window, cx| {
            app.update(cx, |app, cx| f(app, window, cx))
        })
        .map_err(|e| e.to_string())
    }
}

async fn pause(cx: &mut AsyncApp, d: Duration) {
    cx.background_executor().timer(d).await;
}

/// Poll `check` on the window every 50 ms until it returns `Some`, or
/// `limit` passes.
async fn poll<R>(
    handle: &Win,
    cx: &mut AsyncApp,
    limit: Duration,
    mut check: impl FnMut(
        &mut HackApp,
        &mut gpui_kit::Window,
        &mut gpui_kit::Context<HackApp>,
    ) -> Option<R>,
) -> Option<R> {
    let start = Instant::now();
    loop {
        if let Ok(Some(r)) = handle.update(cx, &mut check) {
            return Some(r);
        }
        if start.elapsed() >= limit {
            return None;
        }
        pause(cx, Duration::from_millis(50)).await;
    }
}

/// The Env listing's row `name`, once the listing has it.
async fn env_row(
    handle: &Win,
    cx: &mut AsyncApp,
    name: &str,
    within: Duration,
) -> Result<hack_desktop_core::env::EnvRow, String> {
    poll(handle, cx, within, |app, _, _| match &app.env.view {
        hack_desktop_core::env::EnvView::Report(r) => {
            r.vars.iter().find(|v| v.key == name).cloned()
        }
        _ => None,
    })
    .await
    .ok_or_else(|| format!("{name} not in the Env listing within {within:?}"))
}

/// Fill the open editor (`new_name` for a new variable), press Save, and
/// wait for "Saved NAME" or the editor's error (which never holds a value).
async fn save_env(
    handle: &Win,
    cx: &mut AsyncApp,
    name: &str,
    new_name: Option<&str>,
    value: &str,
) -> Result<String, String> {
    handle
        .update(cx, |app, window, cx| {
            let Some(edit) = app.env_edit.as_ref() else {
                return;
            };
            let (field, name_field) = (edit.value.clone(), edit.name.clone());
            if let (Some(n), Some(field)) = (new_name, name_field) {
                let n = n.to_owned();
                field.update(cx, |s, cx| s.set_value(n, window, cx));
            }
            let v = value.to_owned();
            field.update(cx, |s, cx| s.set_value(v, window, cx));
            app.save_env_edit(cx);
        })
        .map_err(|e| e.to_string())?;
    let saved = format!("Saved {name}");
    let outcome = poll(handle, cx, ENV_WAIT, |app, _, _| {
        if app.env_saved.as_deref() == Some(saved.as_str()) {
            return Some(Ok(()));
        }
        app.env_edit.as_ref().and_then(|e| e.error.clone()).map(Err)
    })
    .await
    .ok_or_else(|| format!("{saved:?} not shown within {ENV_WAIT:?}"))?;
    outcome.map(|()| String::new())
}

async fn run_step(handle: &Win, step: &Step, cx: &mut AsyncApp) -> Result<String, String> {
    match step {
        Step::Select { project, branch } => {
            let key = InstanceKey {
                project: project.clone(),
                branch: branch.clone(),
            };
            poll(handle, cx, READY_WAIT, |app, window, cx| {
                app.drive_select(&key, window, cx).then_some(())
            })
            .await
            .ok_or_else(|| format!("{key} did not appear within {READY_WAIT:?}"))?;
            Ok(String::new())
        }
        Step::Logs => handle
            .update(cx, |app, window, cx| app.drive_activate(0, window, cx))
            .map_err(|e| e.to_string())?
            .map(|()| String::new()),
        Step::Host | Step::Container(_) => {
            let want = match step {
                Step::Container(service) => NewTab::Container(service.clone()),
                _ => NewTab::Host,
            };
            let tab = handle
                .update(cx, |app, _, _| app.drive_menu_choice(&want))
                .map_err(|e| e.to_string())??;
            open(handle, cx, tab).await
        }
        Step::Env { overlay, scope } => {
            handle
                .update(cx, |app, _, cx| app.read_env(cx))
                .map_err(|e| e.to_string())?;
            let tab = poll(handle, cx, TAB_WAIT, |app, _, _| {
                app.drive_env_choice(overlay, scope.as_deref()).ok()
            })
            .await
            .ok_or_else(|| {
                handle
                    .update(cx, |app, _, _| {
                        app.drive_env_choice(overlay, scope.as_deref())
                            .err()
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
            })?;
            open(handle, cx, tab).await
        }
        Step::Key(k) => {
            // Keystroke::parse wants a 'static str; a drive is short.
            let source: &'static str = Box::leak(k.clone().into_boxed_str());
            let stroke = Keystroke::parse(source).map_err(|e| e.to_string())?;
            // Through the window only: the key's handlers update the app
            // view, which must not already be borrowed here.
            // Whether a handler stopped propagation says nothing about
            // whether the terminal got the key; check its effect with
            // `expect`.
            cx.update_window(handle.window, |_, window, cx| {
                window.dispatch_keystroke(stroke, cx);
            })
            .map_err(|e| e.to_string())?;
            Ok(String::new())
        }
        Step::Type(text) => {
            for c in text.chars() {
                let stroke = keystroke_for(c);
                cx.update_window(handle.window, |_, window, cx| {
                    window.dispatch_keystroke(stroke, cx);
                })
                .map_err(|e| e.to_string())?;
            }
            Ok(String::new())
        }
        Step::Paste(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            let detail = handle
                .update(cx, |app, _, cx| app.drive_paste(&text, cx))
                .map_err(|e| e.to_string())??;
            Ok(format!(" {} bytes{detail}", text.len()))
        }
        Step::Expect { text, within } => {
            poll(handle, cx, *within, |app, _, cx| {
                app.drive_screen(cx).contains(text.as_str()).then_some(())
            })
            .await
            .ok_or_else(|| format!("{text:?} not on screen within {within:?}"))?;
            Ok(String::new())
        }
        Step::UseCli(name) => {
            let path = handle
                .update(cx, |app, _, _| {
                    app.source
                        .cli_choice()
                        .and_then(|c| c.others().find(|i| i.name == *name).map(|i| i.path.clone()))
                })?
                .ok_or_else(|| format!("no other Hack CLI named {name} was found"))?;
            handle.update(cx, |app, window, cx| app.use_cli(&path, window, cx))?;
            Ok(String::new())
        }
        Step::ExpectCli { text, within } => {
            poll(handle, cx, *within, |app, _, _| {
                app.cli_label()
                    .filter(|l| l.contains(text.as_str()))
                    .map(|_| ())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, _| app.cli_label())
                    .ok()
                    .flatten();
                format!("CLI label {text:?} not shown within {within:?} (label: {now:?})")
            })?;
            Ok(String::new())
        }
        Step::ExpectStyled { count, within } => {
            poll(handle, cx, *within, |app, _, cx| {
                (app.drive_styled_cells(cx) >= *count).then_some(())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, cx| app.drive_styled_cells(cx))
                    .unwrap_or_default();
                format!("{count} styled cells not on screen within {within:?} (found {now})")
            })?;
            Ok(String::new())
        }
        Step::ExpectNotice { text, within } => {
            poll(handle, cx, *within, |app, _, cx| {
                app.drive_notice(cx)
                    .is_some_and(|n| n.contains(text.as_str()))
                    .then_some(())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, cx| app.drive_notice(cx))
                    .ok()
                    .flatten();
                format!("notice {text:?} not shown within {within:?} (notice: {now:?})")
            })?;
            Ok(String::new())
        }
        Step::Wait(d) => {
            pause(cx, *d).await;
            Ok(String::new())
        }
        Step::Tab(i) => {
            handle
                .update(cx, |app, _, cx| app.set_tab(*i, cx))
                .map_err(|e| e.to_string())?;
            Ok(String::new())
        }
        Step::ExpectUsage { text, within } => {
            poll(handle, cx, *within, |app, _, _| {
                app.usage_lines()
                    .iter()
                    .any(|l| l.contains(text.as_str()))
                    .then_some(())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, _| app.usage_lines())
                    .unwrap_or_default();
                format!("Services tab did not show {text:?} within {within:?} (shows: {now:?})")
            })?;
            Ok(String::new())
        }
        Step::Upgrade => {
            handle
                .update(cx, |app, _, cx| app.open_upgrade(cx))
                .map_err(|e| e.to_string())?;
            // The check probes the machine: wait for it (and the listing).
            poll(handle, cx, Duration::from_secs(180), |app, _, _| {
                (app.upgrade.check.is_some() && !app.upgrade.checking).then_some(())
            })
            .await
            .ok_or("the upgrade check did not finish within 180 s")?;
            Ok(String::new())
        }
        Step::ExpectUpgrade { text, within } => {
            poll(handle, cx, *within, |app, _, _| {
                app.upgrade_lines()
                    .iter()
                    .any(|l| l.contains(text.as_str()))
                    .then_some(())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, _| app.upgrade_lines())
                    .unwrap_or_default();
                format!("Upgrade pane did not show {text:?} within {within:?} (shows: {now:?})")
            })?;
            Ok(String::new())
        }
        Step::UpgradeSnapshot => {
            handle
                .update(cx, |app, _, cx| app.save_upgrade_snapshot(cx))
                .map_err(|e| e.to_string())?;
            Ok(String::new())
        }
        Step::UpgradeRestore => {
            handle
                .update(cx, |app, _, cx| {
                    let id = app
                        .newest_upgrade_snapshot()
                        .ok_or("no snapshot is listed")?;
                    app.ask_upgrade_restore(id, cx);
                    app.confirm_upgrade_restore(cx);
                    Ok::<_, String>(())
                })
                .map_err(|e| e.to_string())??;
            Ok(String::new())
        }
        Step::Hackd => {
            handle
                .update(cx, |app, _, cx| app.open_hackd(cx))
                .map_err(|e| e.to_string())?;
            Ok(String::new())
        }
        Step::ExpectHackd { text, within } => {
            poll(handle, cx, *within, |app, _, _| {
                app.hackd_lines()
                    .iter()
                    .any(|l| l.contains(text.as_str()))
                    .then_some(())
            })
            .await
            .ok_or_else(|| {
                let now = handle
                    .update(cx, |app, _, _| app.hackd_lines())
                    .unwrap_or_default();
                format!("hackd pane did not show {text:?} within {within:?} (shows: {now:?})")
            })?;
            Ok(String::new())
        }
        Step::ExpectEnv { name, within } => {
            env_row(handle, cx, name, *within).await?;
            Ok(String::new())
        }
        Step::EnvSet { name, value } => {
            let row = env_row(handle, cx, name, Duration::from_secs(20)).await?;
            handle
                .update(cx, |app, window, cx| {
                    app.open_env_edit(Some(&row), window, cx)
                })
                .map_err(|e| e.to_string())?;
            save_env(handle, cx, name, None, &value.0).await
        }
        Step::EnvAdd {
            name,
            value,
            secret,
        } => {
            handle
                .update(cx, |app, window, cx| {
                    app.open_env_edit(None, window, cx);
                    if *secret {
                        app.toggle_env_edit_secret(window, cx);
                    }
                })
                .map_err(|e| e.to_string())?;
            save_env(handle, cx, name, Some(name), &value.0).await
        }
        Step::CheckContainer { service, pattern } => {
            let target = handle
                .update(cx, |app, _, _| app.drive_target())
                .map_err(|e| e.to_string())??;
            say(&format!(
                "check-container\t{service}\t{pattern}\t{}\t{}\t{}\t{}",
                target.native,
                target.branch.as_deref().unwrap_or("-"),
                target.hack.display(),
                target.root.display(),
            ));
            Ok(String::new())
        }
        Step::Quit => Ok(String::new()),
    }
}

/// Open a menu entry, and wait for its tab to start.
async fn open(handle: &Win, cx: &mut AsyncApp, tab: NewTab) -> Result<String, String> {
    let before = handle
        .update(cx, |app, window, cx| app.drive_open(tab, window, cx))
        .map_err(|e| e.to_string())??;
    poll(handle, cx, TAB_WAIT, |app, _, cx| {
        app.drive_tab_count(cx)
            .filter(|n| *n > before)
            .and_then(|_| app.drive_active_label(cx))
    })
    .await
    .map(|label| format!(" -> {label}"))
    .ok_or_else(|| {
        handle
            .update(cx, |app, _, _| app.panels.error.clone())
            .ok()
            .flatten()
            .unwrap_or_else(|| "the tab did not start".into())
    })
}

/// Print each session leader not reported yet, with its tab.
fn report_sessions(handle: &Win, seen: &mut BTreeSet<u32>, cx: &mut AsyncApp) {
    let Ok(now) = handle.update(cx, |app, _, cx| app.drive_sessions(cx)) else {
        return;
    };
    for (leader, label) in now {
        if seen.insert(leader) {
            say(&format!("session\t{leader}\t{label}"));
        }
    }
}

/// Where `check-container` runs the CLI.
pub struct Target {
    pub hack: PathBuf,
    pub root: PathBuf,
    pub native: bool,
    pub branch: Option<String>,
}

// ----------------------------------------------------------- supervisor

/// Run the app as a child on `steps_file`, then count what is left.
/// Returns the process exit status.
pub fn supervise(steps_file: &Path, child_args: &[String]) -> i32 {
    let text = match std::fs::read_to_string(steps_file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("read {}: {e}", steps_file.display());
            return 2;
        }
    };
    let base = steps_file.parent().unwrap_or(Path::new("."));
    if let Err(e) = parse(&text, base) {
        eprintln!("{}: {e}", steps_file.display());
        return 2;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cannot find this executable: {e}");
            return 2;
        }
    };
    let mut child = match Command::new(exe)
        .arg("--drive-child")
        .arg(steps_file)
        .args(child_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("start the app: {e}");
            return 2;
        }
    };
    // Read on a thread: a process a tab left behind could hold the pipe
    // open after the app has exited.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let stdout = child.stdout.take().expect("piped stdout");
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let expected = parse(&text, base)
        .map(|steps| steps.iter().take_while(|s| **s != Step::Quit).count())
        .unwrap_or_default();
    let mut leaders = Vec::new();
    let mut checks = Vec::new();
    let mut failed = false;
    let mut done = false;
    let mut take = |line: String| {
        println!("{line}");
        let Some(rest) = line.strip_prefix(TAG).map(str::trim_start) else {
            return;
        };
        let fields: Vec<&str> = rest.split('\t').collect();
        match fields.as_slice() {
            ["session", pid, ..] => {
                if let Ok(pid) = pid.parse::<u32>()
                    && !leaders.contains(&pid)
                {
                    leaders.push(pid);
                }
            }
            ["done", n] => done = n.parse::<usize>().is_ok_and(|n| n == expected),
            ["check-container", svc, pat, native, branch, hack, root] => {
                checks.push(ContainerCheck {
                    service: (*svc).into(),
                    pattern: (*pat).into(),
                    native: *native == "true",
                    branch: (*branch != "-").then(|| (*branch).to_owned()),
                    hack: PathBuf::from(hack),
                    root: PathBuf::from(root),
                });
            }
            // A step's own line says whether it failed; its echoed text (an
            // expected "1 failed", say) must not.
            _ if rest.starts_with("step ") => failed |= step_failed(rest),
            _ if rest.contains(" failed ") => failed = true,
            _ => {}
        }
    };
    let start = Instant::now();
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            take(line);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() < DRIVE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                eprintln!("the drive did not finish within {DRIVE_TIMEOUT:?}; ending the app");
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // What the app printed just before it exited.
    let drained = Instant::now();
    while drained.elapsed() < Duration::from_millis(200) {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => take(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let quit_ok = status.is_some_and(|s| s.success());
    println!(
        "{TAG} app exited: {}",
        status.map_or_else(|| "killed after timeout".into(), |s| s.to_string())
    );
    std::thread::sleep(LINGER);
    let left = leftovers(&leaders);
    println!(
        "{TAG} after quit + {}s: {} process(es) alive in the {} session(s) the tabs started",
        LINGER.as_secs(),
        left.len(),
        leaders.len()
    );
    for (pid, sid) in &left {
        println!("{TAG} left\t{pid}\tsession {sid}\t{}", command_name(*pid));
    }
    // Known open (DESIGN.md R21): what a shell started inside a container
    // outlives the tab until the CLI can end an exec session. Reported on
    // every run, never dropped, and does not fail it.
    let mut container_left = 0;
    for c in &checks {
        match c.count() {
            Ok(n) => {
                container_left += n;
                let known = if n > 0 {
                    " (known open: DESIGN.md R21)"
                } else {
                    ""
                };
                println!(
                    "{TAG} container {}: {n} process(es) matching {:?}{known}",
                    c.service, c.pattern
                );
            }
            Err(e) => {
                failed = true;
                println!("{TAG} container {}: check failed: {e}", c.service);
            }
        }
    }
    if !done {
        println!("{TAG} the app did not report every step done ({expected} expected)");
    }
    let ok = quit_ok && done && !failed && left.is_empty();
    let known = if container_left > 0 {
        format!(" (known open: {container_left} process(es) left inside containers, DESIGN.md R21)")
    } else {
        String::new()
    };
    println!("{TAG} result {}{known}", if ok { "pass" } else { "fail" });
    i32::from(!ok)
}

/// `step <n> failed …` (as opposed to `step <n> ok …`).
fn step_failed(line: &str) -> bool {
    let mut words = line.split_whitespace();
    words.next() == Some("step")
        && words.next().is_some_and(|n| n.parse::<usize>().is_ok())
        && words.next() == Some("failed")
}

/// Every live process in one of `leaders`' sessions, and the leaders
/// themselves, as (pid, session).
fn leftovers(leaders: &[u32]) -> Vec<(u32, u32)> {
    use hack_desktop_term::session::{is_alive, members};
    let mut out = BTreeSet::new();
    for &leader in leaders {
        let Ok(sid) = i32::try_from(leader) else {
            continue;
        };
        if is_alive(sid) {
            out.insert((leader, leader));
        }
        for pid in members(sid) {
            out.insert((pid.unsigned_abs(), leader));
        }
    }
    out.into_iter().collect()
}

/// How long a probe after the app has exited (`ps`, `hack exec`) may run.
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// Run `cmd` with stdout captured, for at most `limit`. On timeout the
/// command is killed and an error returned; a process it left holding the
/// pipe cannot hang the caller, because the pipe is read on a thread.
fn run_bounded(mut cmd: Command, limit: Duration) -> Result<(bool, String), String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut buf);
        let _ = tx.send(buf);
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("did not finish within {limit:?}"));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let left = limit
        .saturating_sub(start.elapsed())
        .max(Duration::from_secs(1));
    let out = rx
        .recv_timeout(left)
        .map_err(|_| "its output stayed open (a process it started holds the pipe)".to_owned())?;
    Ok((status.success(), out))
}

fn command_name(pid: u32) -> String {
    let mut cmd = Command::new("ps");
    cmd.args(["-o", "comm=", "-p", &pid.to_string()]);
    run_bounded(cmd, Duration::from_secs(5))
        .ok()
        .map(|(_, out)| out.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "?".into())
}

struct ContainerCheck {
    service: String,
    pattern: String,
    native: bool,
    branch: Option<String>,
    hack: PathBuf,
    root: PathBuf,
}

impl ContainerCheck {
    /// Processes in the service whose command line contains the pattern,
    /// read through `hack exec` (names and command lines only).
    fn count(&self) -> Result<usize, String> {
        let mut cmd = Command::new(&self.hack);
        cmd.current_dir(&self.root).arg("exec");
        if let Some(b) = &self.branch {
            cmd.args(["--branch", b]);
        }
        cmd.arg(&self.service)
            .args(["--", "sh", "-c", "ps -eo args 2>/dev/null || ps"])
            .env(
                "HACK_RUNTIME_BACKEND",
                if self.native { "native" } else { "compose" },
            );
        let (ok, out) = run_bounded(cmd, PROBE_TIMEOUT).map_err(|e| format!("hack exec: {e}"))?;
        if !ok {
            return Err("hack exec failed".into());
        }
        Ok(out
            .lines()
            .filter(|l| l.contains(&self.pattern) && !l.contains("ps -eo args"))
            .count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_fails_by_its_status_word_not_its_echoed_text() {
        assert!(!step_failed(
            r#"step 4 ok ExpectHackd { text: "At login: started 1 of 3 · 1 failed · 1 pending", within: 10s }"#
        ));
        assert!(step_failed(
            r#"step 2 failed ExpectHackd { text: "hackd running", within: 10s }: not shown"#
        ));
        assert!(!step_failed("step x failed"), "not a step number");
    }

    #[test]
    fn env_steps_never_print_their_values() {
        let base = Path::new("/");
        // Parsed: the report prints only the length.
        let steps = parse("env-set FIXTURE_MODE fake-value-SENTINEL\nenv-add --secret FIXTURE_TOKEN fake-value-SENTINEL\n", base).unwrap();
        assert!(!format!("{steps:?}").contains("SENTINEL"), "{steps:?}");
        // Malformed: the error names the line, not its value.
        for line in [
            "env-add --secret fake-value-SENTINEL",
            "env-set fake-value-SENTINEL",
            "env-add fake-value-SENTINEL",
        ] {
            let err = parse(line, base).expect_err(line);
            assert!(!err.contains("SENTINEL"), "{err}");
            assert!(err.starts_with("line 1:"), "{err}");
        }
    }

    #[test]
    fn a_steps_file_parses_every_step() {
        let text = "# by-hand list\n\
            select storefront fix-login\n\
            logs\n\
            expect ready 5\n\
            expect-notice input limit 3\n\
            expect-styled 40 5\n\
            host\n\
            container api\n\
            env staging api\n\
            env base\n\
            key ctrl-c\n\
            type sleep 86399 &\\r\n\
            paste big.txt\n\
            wait 250\n\
            check-container api drive-marker\n\
            quit\n";
        let steps = parse(text, Path::new("/tmp/d")).expect("parse");
        assert_eq!(
            steps[0],
            Step::Select {
                project: "storefront".into(),
                branch: Some("fix-login".into())
            }
        );
        assert_eq!(
            steps[2],
            Step::Expect {
                text: "ready".into(),
                within: Duration::from_secs(5)
            }
        );
        assert_eq!(steps[10], Step::Type("sleep 86399 &\r".into()));
        assert_eq!(steps[11], Step::Paste(PathBuf::from("/tmp/d/big.txt")));
        assert_eq!(steps[12], Step::Wait(Duration::from_millis(250)));
        assert_eq!(
            steps[3],
            Step::ExpectNotice {
                text: "input limit".into(),
                within: Duration::from_secs(3)
            }
        );
        assert_eq!(
            steps[4],
            Step::ExpectStyled {
                count: 40,
                within: Duration::from_secs(5)
            }
        );
        assert_eq!(steps.len(), 15);
    }

    #[test]
    fn a_pattern_with_spaces_is_one_argument_only_where_it_is_the_last() {
        // check-container takes one word: a pattern with spaces is refused
        // rather than silently cut.
        let err = parse("check-container api sleep 86399", Path::new("."));
        assert!(err.is_err());
        assert_eq!(
            parse("check-container api drive-marker", Path::new(".")).expect("parse"),
            vec![Step::CheckContainer {
                service: "api".into(),
                pattern: "drive-marker".into()
            }]
        );
    }

    #[test]
    fn the_leftover_count_sees_a_live_leader_and_not_a_reaped_one() {
        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(
            leftovers(&[pid]).iter().any(|&(p, _)| p == pid),
            "a live leader was not counted"
        );
        child.kill().expect("kill");
        child.wait().expect("reap");
        assert!(leftovers(&[pid]).is_empty(), "a reaped leader was counted");
    }

    #[test]
    fn an_unknown_step_names_its_line() {
        let err = parse("logs\nfly away\n", Path::new(".")).expect_err("refused");
        assert!(err.starts_with("line 2:"), "{err}");
    }
}
