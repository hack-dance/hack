//! The Logs tab (DESIGN.md, "Logs tab").
//!
//! One `hack logs --json` stream per open tab. The stream is opened on the
//! background executor and drained on a short timer; dropping the feed kills
//! the CLI's process group. Changing project, tab or service filter closes
//! the stream (no banner) and opens a new one. Nothing is written to disk and
//! there is no copy-all.

use std::time::Duration;

use gpui_kit::component::{
    ActiveTheme, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex,
};
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, ScrollStrategy,
    SharedString, Styled, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list,
};
use hack_desktop_core::logs::{LogsModel, StreamState};
use hack_desktop_core::source::LogFeed;

use crate::view::HackApp;

const DRAIN_EVERY: Duration = Duration::from_millis(150);
/// Events applied per tick. The reader's queue is bounded too, so a busy
/// stream slows the CLI down instead of stalling the UI or growing memory.
const BATCH: usize = 500;

/// Logs tab state owned by the window.
pub struct LogsPane {
    pub model: LogsModel,
    feed: Option<Box<dyn LogFeed>>,
    search: Entity<InputState>,
    scroll: UniformListScrollHandle,
    /// Bumped on every (re)open so a late open result is discarded.
    generation: u64,
    /// Visible buffer indices, recomputed on change.
    visible: Vec<usize>,
}

impl LogsPane {
    pub fn new(window: &mut Window, cx: &mut Context<HackApp>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search logs"));
        cx.subscribe(&search, |this: &mut HackApp, state, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                this.logs.model.search = state.read(cx).value().to_string();
                this.logs.refresh_visible();
                cx.notify();
            }
        })
        .detach();
        Self {
            model: LogsModel::default(),
            feed: None,
            search,
            scroll: UniformListScrollHandle::new(),
            generation: 0,
            visible: Vec::new(),
        }
    }

    /// Show a fixture state (screenshots and `--logs-fixture`).
    pub fn set_model(&mut self, model: LogsModel) {
        self.feed = None;
        self.model = model;
        self.refresh_visible();
        if self.should_autoscroll() {
            self.scroll
                .scroll_to_item(self.visible.len() - 1, ScrollStrategy::Bottom);
        }
    }

    /// Auto-scroll only while following a live stream and not paused.
    fn should_autoscroll(&self) -> bool {
        self.model.follow
            && self.model.state == StreamState::Following
            && !self.model.paused
            && !self.visible.is_empty()
    }

    fn refresh_visible(&mut self) {
        self.visible = self.model.visible_indices();
    }

    /// The app closes the stream: no banner.
    pub fn close(&mut self) {
        self.generation += 1;
        self.feed = None;
        self.model.close();
    }
}

impl HackApp {
    /// The equivalent terminal command for the current project and filter,
    /// shell-quoted. Following, so it keeps streaming in the terminal.
    fn logs_command(&self) -> Option<String> {
        let (root, native) = self.selected_root()?;
        if native {
            return None;
        }
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let mut cmd = format!("hack logs --path {}", quote(&root.to_string_lossy()));
        if let Some(svc) = &self.logs.model.service {
            cmd.push(' ');
            cmd.push_str(&quote(svc));
        }
        Some(cmd)
    }

    /// (Re)open the stream for the selected project and current filter.
    pub(crate) fn open_logs(&mut self, cx: &mut Context<Self>) {
        self.logs.close();
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        if native {
            self.logs
                .model
                .unavailable(hack_desktop_core::source::NATIVE_LOGS_NOTE);
            self.logs.refresh_visible();
            cx.notify();
            return;
        }
        let running = self.model.detail().is_some_and(|d| d.state.is_active());
        let args = self.logs.model.cli_args(running);
        self.logs.model.start(running);
        self.logs.refresh_visible();
        let generation = self.logs.generation;
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let opened = cx
                .background_executor()
                .spawn(async move { source.open_logs(&root, false, &args) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.logs.generation != generation {
                    return; // closed or reopened meanwhile; drop the feed
                }
                match opened {
                    Ok(feed) => this.logs.feed = Some(feed),
                    Err(reason) => {
                        this.logs.model.state = StreamState::Failed { reason };
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Drain the open stream on a timer while the window exists.
    pub(crate) fn start_log_drain(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(DRAIN_EVERY).await;
                if this.update(cx, |this, cx| this.drain_logs(cx)).is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    fn drain_logs(&mut self, cx: &mut Context<Self>) {
        let Some(feed) = self.logs.feed.as_mut() else {
            return;
        };
        let hack_desktop_core::runner::StreamPoll { events, exit } = feed.poll(BATCH);
        if events.is_empty() && exit.is_none() {
            return;
        }
        for e in &events {
            self.logs.model.apply(e);
        }
        if let Some(code) = exit {
            self.logs.feed = None;
            self.logs.model.exited(code);
        }
        self.logs.refresh_visible();
        if self.logs.should_autoscroll() {
            self.logs
                .scroll
                .scroll_to_item(self.logs.visible.len() - 1, ScrollStrategy::Bottom);
        }
        cx.notify();
    }

    pub(crate) fn render_logs(&self, services: &[String], cx: &mut Context<Self>) -> AnyElement {
        let t = cx.theme().clone();
        let m = &self.logs.model;

        let pause_label: SharedString = if m.paused {
            if m.unseen > 0 {
                format!("Resume · {} new", m.unseen).into()
            } else {
                "Resume".into()
            }
        } else {
            "Pause".into()
        };
        let unavailable = matches!(m.state, StreamState::Unavailable { .. });
        // Pause only makes sense while following; a finite read has ended.
        let mut toolbar = h_flex()
            .gap_2()
            .px_5()
            .py_2()
            .when(m.follow, |d| {
                d.child(
                    Button::new("logs-pause")
                        .label(pause_label)
                        .small()
                        .outline()
                        .on_click(cx.listener(|this, _, _, cx| {
                            let paused = !this.logs.model.paused;
                            this.logs.model.set_paused(paused);
                            if !paused && !this.logs.visible.is_empty() {
                                this.logs.scroll.scroll_to_item(
                                    this.logs.visible.len() - 1,
                                    ScrollStrategy::Bottom,
                                );
                            }
                            cx.notify();
                        })),
                )
            })
            .child(
                div()
                    .w(px(220.))
                    .child(Input::new(&self.logs.search).small()),
            );
        // Service filter: one at a time (positional `hack logs <service>`).
        let chip = |id: SharedString, label: String, active: bool| {
            let b = Button::new(id).label(label).small();
            if active { b.primary() } else { b.ghost() }
        };
        toolbar = toolbar.child(
            chip("svc-all".into(), "All".into(), m.service.is_none()).on_click(cx.listener(
                |this, _, _, cx| {
                    if this.logs.model.set_service(None) {
                        this.open_logs(cx);
                    }
                },
            )),
        );
        for s in services {
            let name = s.clone();
            toolbar = toolbar.child(
                chip(
                    format!("svc-{s}").into(),
                    s.clone(),
                    m.service.as_deref() == Some(s.as_str()),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if this.logs.model.set_service(Some(name.clone())) {
                        this.open_logs(cx);
                    }
                })),
            );
        }
        toolbar = toolbar.child(div().flex_1());
        if !m.search.trim().is_empty() {
            toolbar = toolbar.child(
                div()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .child(format!("{} matches", self.logs.visible.len())),
            );
        }
        if let Some(cmd) = self.logs_command() {
            toolbar = toolbar.child(
                Button::new("logs-copy-cmd")
                    .label("Copy command")
                    .small()
                    .ghost()
                    .tooltip("Copy the hack logs command to run in a terminal")
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(cmd.clone()));
                    }),
            );
        }
        if m.can_reconnect() {
            toolbar = toolbar.child(
                Button::new("logs-reconnect")
                    .label("Reconnect")
                    .small()
                    .primary()
                    .on_click(cx.listener(|this, _, _, cx| this.open_logs(cx))),
            );
        }

        let banner = m.banner().map(|text| {
            let failed = matches!(m.state, StreamState::Failed { .. });
            div()
                .mx_5()
                .mb_2()
                .px_3()
                .py_1()
                .rounded_md()
                .text_xs()
                .bg(if failed {
                    t.danger.opacity(0.12)
                } else {
                    t.muted
                })
                .text_color(if failed { t.danger } else { t.muted_foreground })
                .child(text)
        });

        let list = uniform_list(
            "log-lines",
            self.logs.visible.len(),
            cx.processor(|this, range: std::ops::Range<usize>, _window, cx| {
                let t = cx.theme().clone();
                range
                    .filter_map(|ix| {
                        let buf_ix = *this.logs.visible.get(ix)?;
                        let line = this.logs.model.line(buf_ix)?;
                        let (text, shown_hidden) = line.display(false);
                        let hidden = shown_hidden + line.cut;
                        let seq = line.seq;
                        let color = if line.error_level || line.stderr {
                            t.danger
                        } else {
                            t.foreground
                        };
                        let mut row = h_flex()
                            .id(("log-line", seq as usize))
                            .w_full()
                            .overflow_hidden()
                            .h(px(20.))
                            .px_3()
                            .gap_2()
                            .whitespace_nowrap()
                            .child(
                                div()
                                    .w(px(72.))
                                    .flex_none()
                                    .text_color(t.muted_foreground)
                                    .child(line.service.clone().unwrap_or_default()),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_color(color)
                                    .child(text.to_owned()),
                            );
                        if hidden > 0 {
                            row = row.child(
                                div()
                                    .flex_none()
                                    .text_color(t.muted_foreground)
                                    .child(format!("… (+{} KB)", hidden.div_ceil(1024))),
                            );
                        }
                        // Any row expands on click: a line can be clipped by
                        // the row width long before the 4 KB cut applies.
                        let expanded = this.logs.model.is_expanded(seq);
                        row = row
                            .cursor_pointer()
                            .when(expanded, |r| r.bg(t.muted))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.logs.model.toggle_expanded(seq);
                                cx.notify();
                            }));
                        if line.truncated_by_hack {
                            row = row.child(
                                div()
                                    .flex_none()
                                    .text_color(t.muted_foreground)
                                    .child("truncated by hack"),
                            );
                        }
                        Some(row)
                    })
                    .collect()
            }),
        )
        .track_scroll(&self.logs.scroll)
        .flex_1()
        .font_family(t.mono_font_family.clone())
        .text_xs();

        let empty = self.logs.visible.is_empty()
            && !matches!(
                m.state,
                StreamState::Unavailable { .. } | StreamState::Failed { .. }
            );
        let body = v_flex()
            .id("log-body")
            // Scrolling up to read older lines pauses following.
            .on_scroll(cx.listener(|this, ev: &gpui_kit::ScrollEvent, _, cx| {
                let up = match ev.delta {
                    gpui_kit::ScrollDelta::Pixels(p) => p.y > px(0.),
                    gpui_kit::ScrollDelta::Lines(l) => l.y > 0.,
                };
                if up && this.logs.model.follow && !this.logs.model.paused {
                    this.logs.model.set_paused(true);
                    cx.notify();
                }
            }))
            .mx_5()
            .flex_1()
            .min_h(px(160.))
            .rounded_md()
            .border_1()
            .border_color(t.border)
            .bg(t.muted.opacity(0.4))
            .py_1()
            .child(list)
            .when(empty, |d| {
                d.child(div().px_3().text_xs().text_color(t.muted_foreground).child(
                    if m.search.trim().is_empty() {
                        "No log lines yet"
                    } else {
                        "No lines match the search"
                    },
                ))
            });

        let expanded = m.expanded_lines();
        let detail = (!expanded.is_empty()).then(|| {
            let mut col = v_flex()
                .id("log-expanded")
                .mx_5()
                .mt_2()
                .max_h(px(160.))
                .overflow_y_scroll()
                .rounded_md()
                .border_1()
                .border_color(t.border)
                .p_2()
                .gap_1()
                .text_xs()
                .font_family(t.mono_font_family.clone());
            for l in expanded {
                col = col.child(l.message.clone());
            }
            col
        });

        v_flex()
            .flex_1()
            .min_h_0()
            .when(!unavailable, |d| d.child(toolbar))
            .children(banner)
            .child(body)
            .children(detail)
            .child(
                div()
                    .px_5()
                    .py_2()
                    .text_xs()
                    .text_color(t.muted_foreground)
                    .font_weight(FontWeight::NORMAL)
                    .child(
                        "Logs are shown as your services print them. Hack does not hide secrets in logs. Nothing here is saved to disk.",
                    ),
            )
            .into_any_element()
    }
}
