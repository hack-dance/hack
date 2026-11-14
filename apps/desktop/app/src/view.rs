//! The one window: sidebar, detail pane, status bar.
//!
//! All data comes from `hack_desktop_core`; this file only lays it out and
//! forwards clicks as view-model events. Blocking work (CLI, socket) runs on
//! the background executor, never on the UI thread.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::{
    ActiveTheme, Disableable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    switch::Switch,
    tab::{Tab, TabBar},
    tag::Tag,
    v_flex,
};
use gpui_kit::{
    AnyElement, Context, FontWeight, Hsla, IntoElement, ParentElement, Render, SharedString,
    Styled, Window, div, prelude::*, px,
};
use hack_desktop_core::models::LogEntry;
use hack_desktop_core::source::{ActionOutcome, DaemonRecovery, Source};
use hack_desktop_core::state::{Action, ProjectState, ServiceView, Tone};
use hack_desktop_core::viewmodel::{AppModel, DetailView, Event, ListView, Phase, Row};

const TAIL_LINES: u32 = 20;

pub struct HackApp {
    model: AppModel,
    source: Arc<dyn Source>,
    tab: usize,
    tail: Result<Vec<LogEntry>, String>,
    follow: bool,
    live: bool,
    recovery_busy: bool,
    recovery_error: Option<String>,
    /// When each project's running action started, for the slow-action
    /// warning. Display only: the app never terminates a lifecycle command.
    action_started: std::collections::HashMap<String, std::time::Instant>,
}

impl HackApp {
    /// `live`: poll the source. Fixtures load once and never poll.
    pub fn new(source: Arc<dyn Source>, live: bool, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            model: AppModel::new(),
            source,
            tab: 0,
            tail: Ok(Vec::new()),
            follow: true,
            live,
            recovery_busy: false,
            recovery_error: None,
            action_started: std::collections::HashMap::new(),
        };
        if live {
            this.start_polling(cx);
        } else {
            this.refresh_now();
        }
        this
    }

    /// Synchronous refresh, for fixtures and screenshots.
    pub fn refresh_now(&mut self) {
        let snap = self.source.snapshot();
        self.model.apply(Event::Refreshed(snap));
        self.tail = self.selected_root().map_or_else(
            || Ok(Vec::new()),
            |(root, native)| self.source.log_tail(&root, native, TAIL_LINES),
        );
    }

    /// Fixtures: select a project by name.
    pub fn select(&mut self, name: &str) {
        self.model.apply(Event::Select(name.to_owned()));
        self.refresh_now();
    }

    /// Fixtures: mark an action as in flight without running it.
    pub fn simulate_in_flight(&mut self, action: Action) {
        if let Some(name) = self.model.detail().map(|d| d.name) {
            self.model.apply(Event::ActionStarted {
                project: name,
                action,
            });
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
            },
        )));
        self.tail = Err("Project status could not be read".into());
    }

    fn selected_root(&self) -> Option<(PathBuf, bool)> {
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
                        async move { source.snapshot() }
                    })
                    .await;
                let root = this
                    .update(cx, |this, cx| {
                        if !this.model.finish_refresh(token, snap) {
                            return None;
                        }
                        cx.notify();
                        this.follow.then(|| this.selected_root()).flatten()
                    })
                    .ok()
                    .flatten();
                if let Some((root, native)) = root {
                    let requested = root.clone();
                    let tail = cx
                        .background_executor()
                        .spawn(async move { source.log_tail(&root, native, TAIL_LINES) })
                        .await;
                    let _ = this.update(cx, |this, cx| {
                        // Drop a tail fetched for a project no longer selected.
                        if this.selected_root().is_some_and(|(r, _)| r == requested) {
                            this.tail = tail;
                            cx.notify();
                        }
                    });
                }
                let delay = this
                    .update(cx, |this, _| this.model.poll_interval())
                    .unwrap_or(Duration::from_secs(10));
                cx.background_executor().timer(delay).await;
            }
        })
        .detach();
    }

    fn run_action(&mut self, action: Action, cx: &mut Context<Self>) {
        let Some(row) = self.model.selected_row() else {
            return;
        };
        let project = row.name.clone();
        let native = row.is_native();
        let Some(root) = row.repo_root.clone().map(PathBuf::from) else {
            return;
        };
        if !self.model.can_start(&project) {
            return;
        }
        self.model.apply(Event::ActionStarted {
            project: project.clone(),
            action,
        });
        self.action_started
            .insert(project.clone(), std::time::Instant::now());
        cx.notify();
        if !self.live {
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.act(&root, native, action) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(ActionOutcome::Opened(o)) = &result {
                    cx.open_url(&o.url);
                }
                this.action_started.remove(&project);
                if this.model.apply(Event::ActionFinished {
                    project,
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

    fn refresh_now_async(&mut self, cx: &mut Context<Self>) {
        let source = self.source.clone();
        let token = self.model.begin_refresh();
        cx.spawn(async move |this, cx| {
            let snap = cx
                .background_executor()
                .spawn(async move { source.snapshot() })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.model.finish_refresh(token, snap);
                cx.notify();
            });
        })
        .detach();
    }

    fn recover_daemon(&mut self, action: DaemonRecovery, cx: &mut Context<Self>) {
        if self.recovery_busy || !self.live {
            return;
        }
        self.recovery_busy = true;
        self.recovery_error = None;
        let source = self.source.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.recover_daemon(action) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.recovery_busy = false;
                this.recovery_error = result.err();
                // A command exit is not evidence that a compatible daemon
                // is ready. Only the next ordered snapshot can restore rows.
                this.refresh_now_async(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

fn tone_color(tone: Tone, cx: &gpui_kit::App) -> Hsla {
    let t = cx.theme().clone();
    match tone {
        Tone::Ok => t.success,
        Tone::Warn => t.warning,
        Tone::Busy => t.info,
        Tone::Error => t.danger,
        Tone::Idle => t.muted_foreground,
    }
}

fn dot(color: Hsla) -> impl IntoElement {
    div().size(px(8.)).rounded_full().bg(color).flex_none()
}

fn state_tag(state: &ProjectState) -> Tag {
    let tag = match state.tone() {
        Tone::Ok => Tag::success(),
        Tone::Warn => Tag::warning(),
        Tone::Busy => Tag::info(),
        Tone::Error => Tag::danger(),
        Tone::Idle => Tag::secondary(),
    };
    tag.small().rounded_full().child(state.label())
}

impl HackApp {
    fn sidebar(&self, list: &ListView, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let header = |label: &'static str| {
            div()
                .px_3()
                .pt_3()
                .pb_1()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(t.muted_foreground)
                .child(label)
        };
        let mut col = v_flex()
            .w(px(232.))
            .h_full()
            .flex_none()
            .bg(t.sidebar)
            .border_r_1()
            .border_color(t.sidebar_border)
            .text_color(t.sidebar_foreground)
            .text_sm();
        col = col.child(
            div()
                .px_3()
                .py_3()
                .font_weight(FontWeight::BOLD)
                .child("Hack"),
        );
        // Project groups scroll; the header above and the machine rows below
        // stay fixed, so every project stays reachable however many there are.
        let mut body = v_flex()
            .id("project-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        match &list.phase {
            Phase::Loading => {
                for i in 0..3usize {
                    body = body.child(
                        div()
                            .id(("skeleton", i))
                            .mx_3()
                            .my_1()
                            .h(px(20.))
                            .rounded_md()
                            .bg(t.muted),
                    );
                }
            }
            Phase::Empty | Phase::CliMissing | Phase::Error { .. } => {}
            Phase::Ready => {
                if !list.running.is_empty() {
                    body = body.child(header("RUNNING"));
                    for r in &list.running {
                        body = body.child(self.project_row(r, cx));
                    }
                }
                if !list.stopped.is_empty() {
                    let unknown = list
                        .stopped
                        .iter()
                        .filter(|r| matches!(r.state, ProjectState::Unknown { .. }))
                        .count();
                    body = body.child(header(if unknown == list.stopped.len() {
                        "UNKNOWN"
                    } else if unknown > 0 {
                        "STOPPED / UNKNOWN"
                    } else {
                        "STOPPED"
                    }));
                    for r in &list.stopped {
                        body = body.child(self.project_row(r, cx));
                    }
                }
            }
        }
        let t = cx.theme().clone();
        col.child(body).child(
            v_flex()
                .border_t_1()
                .border_color(t.sidebar_border)
                .py_2()
                // v0 does not read routing status yet: shown as unknown.
                .child(machine_row("Routing and DNS", None, t.muted_foreground))
                .child(machine_row(
                    "Doctor",
                    (list.doctor_count > 0).then_some(list.doctor_count),
                    // Unknown until Doctor has actually reported.
                    match (list.doctor_known, list.doctor_count) {
                        (false, _) => t.muted_foreground,
                        (true, 0) => t.success,
                        (true, _) => t.warning,
                    },
                )),
        )
    }

    fn project_row(&self, r: &Row, cx: &mut Context<Self>) -> AnyElement {
        let t = cx.theme().clone();
        let name = r.name.clone();
        h_flex()
            .id(SharedString::from(format!("project-{}", r.name)))
            .mx_2()
            .px_2()
            .py_1()
            .gap_2()
            .rounded_md()
            .when(r.selected, |d| {
                d.bg(t.sidebar_accent)
                    .text_color(t.sidebar_accent_foreground)
            })
            .hover(|d| d.bg(t.sidebar_accent))
            .cursor_pointer()
            .child(dot(tone_color(r.state.tone(), cx)))
            .child(div().flex_1().truncate().child(r.name.clone()))
            .when(r.always_on, |d| {
                d.child(
                    div()
                        .text_xs()
                        .text_color(t.muted_foreground)
                        .child("always on"),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.model.apply(Event::Select(name.clone()));
                this.tail = Ok(Vec::new());
                if !this.live {
                    this.refresh_now();
                }
                cx.notify();
            }))
            .into_any_element()
    }

    fn banners(&self, list: &ListView, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let mut col = v_flex();
        for b in &list.banners {
            col = col.child(
                div()
                    .px_4()
                    .py_1()
                    .text_xs()
                    .bg(t.warning.opacity(0.15))
                    .border_b_1()
                    .border_color(t.border)
                    .child(b.text()),
            );
        }
        if let Some(action) = self.model.daemon_recovery() {
            col = col.child(
                h_flex()
                    .px_4()
                    .py_2()
                    .gap_3()
                    .child(
                        Button::new("recover-hackd")
                            .label(action.label())
                            .small()
                            .disabled(self.recovery_busy)
                            .loading(self.recovery_busy)
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.recover_daemon(action, cx)),
                            ),
                    )
                    .children(
                        self.recovery_error
                            .clone()
                            .map(|e| div().text_sm().text_color(t.danger).child(e)),
                    ),
            );
        }
        col
    }

    fn detail(&self, d: &DetailView, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let mut buttons = h_flex().gap_2();
        for a in [Action::Open, Action::Restart, Action::Stop, Action::Start] {
            if !d.actions.contains(&a) {
                continue;
            }
            let mut b = Button::new(a.label())
                .label(a.label())
                .small()
                .disabled(d.busy);
            b = match a {
                Action::Start => b.primary(),
                Action::Stop => b.outline(),
                _ => b.outline(),
            };
            buttons = buttons.child(b.on_click(cx.listener(move |this, _, _, cx| {
                this.run_action(a, cx);
            })));
        }
        let header = v_flex()
            .gap_2()
            .px_5()
            .pt_4()
            .pb_3()
            .border_b_1()
            .border_color(t.border)
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .child(d.name.clone()),
                    )
                    .child(state_tag(&d.state))
                    .child(
                        Tag::secondary()
                            .small()
                            .outline()
                            .rounded_full()
                            .child(d.backend.clone()),
                    )
                    .child(div().flex_1())
                    .child(buttons),
            )
            .child(
                h_flex()
                    .gap_4()
                    .text_sm()
                    .text_color(t.muted_foreground)
                    .children(d.url.clone().map(|u| div().text_color(t.link).child(u)))
                    .child(div().flex_1())
                    .child(
                        Switch::new("always-on")
                            .label("Always on")
                            .checked(d.always_on)
                            .small()
                            .disabled(true)
                            .tooltip("Needs hack autostart (HACK-2213)"),
                    ),
            )
            .children(reason_line(&d.state, d.last_error.as_deref(), cx))
            .children(
                self.slow_action_warning(&d.name)
                    .map(|w| div().text_sm().text_color(t.warning).child(w)),
            )
            .children(
                d.note
                    .clone()
                    .map(|n| div().text_sm().text_color(t.muted_foreground).child(n)),
            );
        let tabs = TabBar::new("detail-tabs")
            .underline()
            .small()
            .selected_index(self.tab)
            .child(Tab::new().label("Services"))
            .child(Tab::new().label("Logs").disabled(true))
            .child(Tab::new().label("Env").disabled(true))
            .child(Tab::new().label("Activity").disabled(true))
            .on_click(cx.listener(|this, ix: &usize, _, cx| {
                this.tab = *ix;
                cx.notify();
            }));
        // The header and tabs stay fixed; the tab content scrolls within the
        // remaining height so every service row and log line is reachable.
        v_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(header)
            .child(div().px_5().pt_2().child(tabs))
            .child(
                v_flex()
                    .id("detail-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(services_table(&d.services, cx))
                    .child(self.log_tail(cx)),
            )
    }

    /// Shown, never acted on, once an action has run past
    /// `LiveSource::LIFECYCLE_WARN_AFTER`.
    fn slow_action_warning(&self, project: &str) -> Option<String> {
        let started = self.action_started.get(project)?;
        (started.elapsed() >= hack_desktop_core::source::LiveSource::LIFECYCLE_WARN_AFTER).then(|| {
            "Still running after 6 hours. Hack owns this command and its timeouts; the app has not stopped it.".to_owned()
        })
    }

    fn log_tail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let mono = t.mono_font_family.clone();
        let mut lines = v_flex().font_family(mono).text_xs().gap_0p5().px_3().py_2();
        let entries: &[LogEntry] = match &self.tail {
            Ok(v) => v,
            Err(why) => {
                // A failed read is shown as such, never as an empty log.
                lines = lines.child(div().text_color(t.muted_foreground).child(why.clone()));
                &[]
            }
        };
        if matches!(&self.tail, Ok(v) if v.is_empty()) {
            lines = lines.child(
                div()
                    .text_color(t.muted_foreground)
                    .child("No recent log lines"),
            );
        }
        for e in entries {
            let error = e.level.as_deref() == Some("error");
            lines = lines.child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .w(px(64.))
                            .flex_none()
                            .text_color(t.muted_foreground)
                            .child(e.service.clone().unwrap_or_default()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .when(error, |d| d.text_color(t.danger))
                            .child(e.message.clone()),
                    ),
            );
        }
        v_flex()
            .mx_5()
            .mb_3()
            .flex_1()
            .min_h(px(120.))
            .rounded_md()
            .border_1()
            .border_color(t.border)
            .bg(t.muted.opacity(0.4))
            .child(
                h_flex()
                    .px_3()
                    .py_1()
                    .border_b_1()
                    .border_color(t.border)
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child("Log tail")
                    .child(div().flex_1())
                    .child(
                        Switch::new("follow")
                            .label("Follow")
                            .checked(self.follow)
                            .xsmall()
                            .on_change(cx.listener(|this, v: &bool, _, cx| {
                                this.follow = *v;
                                cx.notify();
                            })),
                    ),
            )
            .child(lines)
            .child(
                div()
                    .px_3()
                    .pb_2()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child("Logs are shown as your services print them. Hack does not hide secrets in logs."),
            )
    }

    fn full_pane(
        &self,
        title: &str,
        body: String,
        command: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = cx.theme().clone();
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_2()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.to_owned()),
            )
            .child(div().text_sm().text_color(t.muted_foreground).child(body))
            .children(command.map(|c| {
                div()
                    .mt_2()
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .bg(t.muted)
                    .font_family(t.mono_font_family.clone())
                    .text_sm()
                    .child(c.to_owned())
            }))
            .into_any_element()
    }

    fn status_bar(&self, list: &ListView, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let stale = list
            .banners
            .iter()
            .any(|b| matches!(b, hack_desktop_core::viewmodel::Banner::Stale { .. }));
        let engine = if !self.model.engine_observed() {
            ("Docker unknown", t.muted_foreground)
        } else if list
            .banners
            .iter()
            .any(|b| matches!(b, hack_desktop_core::viewmodel::Banner::EngineDown { .. }))
        {
            ("Docker down", t.danger)
        } else {
            ("Docker ok", t.success)
        };
        let daemon = if list
            .banners
            .iter()
            .any(|b| matches!(b, hack_desktop_core::viewmodel::Banner::DaemonOff))
        {
            ("hackd off", t.muted_foreground)
        } else if list.banners.iter().any(|b| {
            matches!(
                b,
                hack_desktop_core::viewmodel::Banner::DaemonMismatch { .. }
            )
        }) {
            ("hackd version mismatch", t.warning)
        } else if stale
            || list.banners.iter().any(|b| {
                matches!(
                    b,
                    hack_desktop_core::viewmodel::Banner::DaemonReadFailed { .. }
                )
            })
        {
            ("hackd unknown", t.muted_foreground)
        } else {
            ("hackd on", t.success)
        };
        h_flex()
            .h(px(26.))
            .px_3()
            .gap_4()
            .text_xs()
            .bg(t.status_bar)
            .border_t_1()
            .border_color(t.status_bar_border)
            .text_color(t.muted_foreground)
            .child({
                let c = list.counts;
                let mut text = format!("{} running · {} stopped", c.running, c.stopped);
                if c.unknown > 0 {
                    text.push_str(&format!(" · {} unknown", c.unknown));
                }
                text
            })
            // Without a snapshot the engine and hackd states are unknown.
            .when(list.cli_version.is_some(), |d| {
                d.child(h_flex().gap_1().child(dot(engine.1)).child(engine.0))
                    .child(h_flex().gap_1().child(dot(daemon.1)).child(daemon.0))
            })
            .child(div().flex_1())
            .children(list.cli_version.clone().map(|v| format!("hack {v}")))
    }
}

fn machine_row(label: &'static str, count: Option<usize>, color: Hsla) -> impl IntoElement {
    h_flex()
        .mx_2()
        .px_2()
        .py_1()
        .gap_2()
        .child(dot(color))
        .child(div().flex_1().child(label))
        .children(count.map(|n| Tag::warning().xsmall().rounded_full().child(n.to_string())))
}

fn reason_line(
    state: &ProjectState,
    error: Option<&str>,
    cx: &Context<HackApp>,
) -> Option<AnyElement> {
    let t = cx.theme().clone();
    let text = match (state, error) {
        (_, Some(e)) => format!("Last action failed: {e}"),
        (ProjectState::NeedsAttention { reason } | ProjectState::Unknown { reason }, None) => {
            reason.clone()
        }
        _ => return None,
    };
    Some(
        div()
            .text_sm()
            .text_color(t.danger)
            .child(text)
            .into_any_element(),
    )
}

fn services_table(services: &[ServiceView], cx: &Context<HackApp>) -> impl IntoElement {
    let t = cx.theme().clone();
    let cell = |w: f32| div().w(px(w)).flex_none().truncate();
    let mut table = v_flex()
        .mx_5()
        .my_3()
        .rounded_md()
        .border_1()
        .border_color(t.border)
        .text_sm()
        .child(
            h_flex()
                .px_3()
                .py_1()
                .bg(t.table_head)
                .text_color(t.table_head_foreground)
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .child(cell(140.).child("SERVICE"))
                .child(cell(200.).child("STATE"))
                .child(cell(64.).child("CPU"))
                .child(cell(80.).child("MEMORY"))
                .child(div().flex_1().child("ROUTE")),
        );
    for s in services {
        let color = if s.running {
            t.success
        } else if s.exit_code.is_some_and(|c| c != 0) {
            t.danger
        } else {
            t.muted_foreground
        };
        table = table.child(
            h_flex()
                .px_3()
                .py_1()
                .border_t_1()
                .border_color(t.table_row_border)
                .child(cell(140.).child(s.name.clone()))
                .child(cell(200.).child(h_flex().gap_2().child(dot(color)).child(s.status.clone())))
                .child(cell(64.).text_color(t.muted_foreground).child("—"))
                .child(cell(80.).text_color(t.muted_foreground).child("—"))
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_color(t.muted_foreground)
                        .child(s.route.clone().unwrap_or_default()),
                ),
        );
    }
    table
}

impl Render for HackApp {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let list = self.model.list();
        let t = cx.theme().clone();
        let (bg, fg, font) = (t.background, t.foreground, t.font_family.clone());
        let main: AnyElement = match &list.phase {
            Phase::CliMissing => self.full_pane(
                "Hack CLI not found",
                "The app runs the hack command for everything. Install it, then reopen the app."
                    .into(),
                Some("brew install hack-dance/tap/hack"),
                cx,
            ),
            Phase::Error { code, message } => self.full_pane(
                "Could not read projects",
                format!("{code}: {message}"),
                self.model
                    .daemon_recovery()
                    .is_none()
                    .then_some("hack projects --json"),
                cx,
            ),
            Phase::Empty => self.full_pane(
                "No projects yet",
                "Set up a repository with Hack and it appears here.".into(),
                Some("cd your-repo && hack init"),
                cx,
            ),
            Phase::Loading => self.full_pane("Loading projects…", String::new(), None, cx),
            Phase::Ready => match self.model.detail() {
                Some(d) => self.detail(&d, cx).into_any_element(),
                None => self.full_pane("Select a project", String::new(), None, cx),
            },
        };
        v_flex()
            .size_full()
            .bg(bg)
            .text_color(fg)
            .font_family(font)
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_start()
                    .child(self.sidebar(&list, cx))
                    .child(
                        v_flex()
                            .flex_1()
                            .h_full()
                            .min_w_0()
                            .child(self.banners(&list, cx))
                            .child(main),
                    ),
            )
            .child(self.status_bar(&list, cx))
    }
}
