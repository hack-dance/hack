//! The Logs tab (DESIGN.md, "Logs tab").
//!
//! One `hack logs --json` stream per open tab. The stream is opened on the
//! background executor and drained on a short timer; dropping the feed kills
//! the CLI's process group. Changing project, tab or service filter closes
//! the stream (no banner) and opens a new one. Nothing is written to disk and
//! there is no copy-all.

use std::time::Duration;

use crate::service_view::{ServiceMenu, menu_row, menu_separator, service_menu};
use gpui_kit::component::{
    ActiveTheme, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex,
};
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, HighlightStyle, IntoElement, ListAlignment, ListState,
    ParentElement, ScrollStrategy, SharedString, Styled, StyledText, TestSupportExt as _,
    UniformListScrollHandle, Window, div, list, prelude::*, px, uniform_list,
};
use hack_desktop_core::logs::{LogLine, LogsModel, StreamState, json_key_ranges, line_matches};
use hack_desktop_core::source::LogFeed;
use hack_desktop_core::viewmodel::DetailView;
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, icon},
    icons::Glyph,
    tokens::{size, space, text},
};

use crate::view::HackApp;

const DRAIN_EVERY: Duration = Duration::from_millis(150);
/// Events applied per tick. The reader discards overflow without blocking
/// stdout, because the CLI does not await pipe backpressure.
const BATCH: usize = 500;

/// Logs tab state owned by the window.
pub struct LogsPane {
    pub model: LogsModel,
    feed: Option<Box<dyn LogFeed>>,
    search: Entity<InputState>,
    scroll: UniformListScrollHandle,
    service_scroll: ListState,
    wrap: bool,
    highlight_json: bool,
    only_matching: bool,
    /// Bumped on every (re)open so a late open result is discarded.
    generation: u64,
    /// Visible buffer indices, recomputed on change.
    visible: Vec<usize>,
    matching: usize,
}

impl LogsPane {
    pub fn new(window: &mut Window, cx: &mut Context<HackApp>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Filter lines"));
        cx.subscribe(&search, |this: &mut HackApp, state, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                this.logs.model.search = state.read(cx).value().to_string();
                if this.selected_service().is_some() && !this.logs.only_matching {
                    // Highlighting changes styling only. Leave the paused
                    // viewport and its row measurements in place.
                    this.logs.matching = this.logs.model.visible_indices().len();
                } else {
                    this.refresh_log_rows();
                }
                if this.logs.should_autoscroll() {
                    this.logs.scroll_end();
                }
                cx.notify();
            }
        })
        .detach();
        Self {
            model: LogsModel::default(),
            feed: None,
            search,
            scroll: UniformListScrollHandle::new(),
            service_scroll: ListState::new(0, ListAlignment::Top, px(200.)),
            wrap: true,
            highlight_json: true,
            only_matching: false,
            generation: 0,
            visible: Vec::new(),
            matching: 0,
        }
    }

    /// Show a fixture state (screenshots and `--logs-fixture`).
    pub fn set_model(&mut self, model: LogsModel, window: &mut Window, cx: &mut Context<HackApp>) {
        self.feed = None;
        self.search.update(cx, |input, cx| {
            input.set_value(model.search.clone(), window, cx);
        });
        self.model = model;
        self.refresh_project_visible();
        if self.should_autoscroll() {
            self.scroll_end();
        }
    }

    pub(crate) fn reset_service_search(&mut self, window: &mut Window, cx: &mut Context<HackApp>) {
        self.search.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.model.search.clear();
        self.model.set_paused(false);
        self.refresh_visible(None);
    }

    pub(crate) fn focus_search(&self, window: &mut Window, cx: &mut Context<HackApp>) {
        self.search.update(cx, |input, cx| input.focus(window, cx));
    }

    fn scroll_end(&self) {
        if !self.visible.is_empty() {
            self.scroll
                .scroll_to_item(self.visible.len() - 1, ScrollStrategy::Bottom);
            self.service_scroll.scroll_to_end();
        }
    }

    /// Auto-scroll only while following a live stream and not paused.
    fn should_autoscroll(&self) -> bool {
        self.model.follow
            && self.model.state == StreamState::Following
            && !self.model.paused
            && !self.visible.is_empty()
    }

    fn refresh_visible(&mut self, evicted: Option<u64>) {
        let old_len = self.visible.len();
        let removed = evicted.map(|count| {
            self.visible
                .partition_point(|&index| (index as u64) < count)
        });
        let indices = self.model.visible_indices();
        self.matching = indices.len();
        self.visible = if self.only_matching {
            indices
        } else {
            (0..self.model.len()).collect()
        };
        // A drain only removes old rows from the front and appends new
        // ones. Keep measurements and the viewport for surviving rows.
        match removed {
            Some(removed) => {
                if removed > 0 {
                    self.service_scroll.splice(0..removed, 0);
                }
                let retained = old_len - removed;
                if self.visible.len() > retained {
                    self.service_scroll
                        .splice(retained..retained, self.visible.len() - retained);
                }
            }
            None => self.service_scroll.reset(self.visible.len()),
        }
    }

    fn refresh_project_visible(&mut self) {
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
        if self
            .model
            .detail()
            .is_none_or(|detail| !detail.runtime_addressable)
        {
            return None;
        }
        let (root, native) = self.selected_root()?;
        if native {
            return None;
        }
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let mut cmd = format!("hack logs --path {}", quote(&root.to_string_lossy()));
        if let Some(branch) = self.model.selected_key().and_then(|k| k.branch) {
            cmd.push_str(" --branch ");
            cmd.push_str(&quote(&branch));
        }
        if let Some(name) = self
            .model
            .selected_runtime_target()
            .and_then(|target| target.compose_project)
        {
            cmd.push_str(" --expect-compose-project ");
            cmd.push_str(&quote(&name));
        }
        if let Some(svc) = &self.logs.model.service {
            cmd.push(' ');
            cmd.push_str(&quote(svc));
        }
        Some(cmd)
    }

    fn refresh_log_rows(&mut self) {
        if self.selected_service().is_some() {
            self.logs.refresh_visible(None);
        } else {
            self.logs.refresh_project_visible();
        }
    }

    pub(crate) fn toggle_log_pause(&mut self, cx: &mut Context<Self>) {
        if self.logs.model.follow {
            let paused = !self.logs.model.paused;
            self.logs.model.set_paused(paused);
            if !paused {
                self.logs.scroll_end();
            }
            cx.notify();
        }
    }

    pub(crate) fn displayed_logs_running(&self) -> bool {
        self.model.detail().is_some_and(|detail| {
            self.selected_service().map_or_else(
                || detail.state.is_active(),
                |_| {
                    self.logs.model.service.as_ref().map_or_else(
                        || detail.state.is_active(),
                        |name| detail.services.iter().any(|s| &s.name == name && s.running),
                    )
                },
            )
        })
    }

    /// (Re)open the stream for the selected project and current filter.
    pub(crate) fn open_logs(&mut self, cx: &mut Context<Self>) {
        self.logs.close();
        if self
            .model
            .detail()
            .is_some_and(|detail| !detail.runtime_addressable)
        {
            self.logs
                .model
                .unavailable("The displayed runtime has no current checkout or Compose target.");
            self.refresh_log_rows();
            cx.notify();
            return;
        }
        let Some((root, native)) = self.selected_root() else {
            // No folder to read from: never leave another project's lines.
            self.logs
                .model
                .unavailable("This project has no folder to read logs from.");
            self.refresh_log_rows();
            cx.notify();
            return;
        };
        if native {
            self.logs
                .model
                .unavailable(hack_desktop_core::source::NATIVE_LOGS_NOTE);
            self.refresh_log_rows();
            cx.notify();
            return;
        }
        let running = self.displayed_logs_running();
        let mut args = self.logs.model.cli_args(running);
        if let Some(name) = self
            .model
            .selected_runtime_target()
            .and_then(|target| target.compose_project)
        {
            args.insert(1, format!("--expect-compose-project={name}"));
        }
        self.logs.model.start(running);
        self.refresh_log_rows();
        let generation = self.logs.generation;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let branch = self.model.selected_key().and_then(|k| k.branch);
        cx.spawn(async move |this, cx| {
            let opened = cx
                .background_executor()
                .spawn(async move { source.open_logs(&root, false, branch.as_deref(), &args) })
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
        let hack_desktop_core::runner::StreamPoll {
            events,
            exit,
            skipped,
        } = feed.poll(BATCH);
        self.logs.model.skipped = self.logs.model.skipped.saturating_add(skipped);
        if events.is_empty() && exit.is_none() && skipped == 0 {
            return;
        }
        let service_logs = self.selected_service().is_some();
        let dropped_before = self.logs.model.dropped;
        // GPUI's variable-height list anchors its own viewport across splices.
        let anchor = if !service_logs && self.logs.model.paused {
            let state = self.logs.scroll.0.borrow();
            let top = state.deferred_scroll_to_item.as_ref().map_or_else(
                || state.base_handle.logical_scroll_top().0,
                |d| d.item_index,
            );
            self.logs
                .visible
                .get(top)
                .and_then(|&i| self.logs.model.line(i))
                .map(|line| line.seq)
        } else {
            None
        };
        for e in &events {
            self.logs.model.apply(e);
        }
        if let Some(code) = exit {
            self.logs.feed = None;
            self.logs.model.exited(code);
        }
        if service_logs {
            self.logs
                .refresh_visible(Some(self.logs.model.dropped - dropped_before));
        } else {
            self.logs.refresh_project_visible();
        }
        if self.logs.should_autoscroll() {
            self.logs.scroll_end();
        } else if let Some(seq) = anchor {
            let pos = self.logs.model.position_of_seq(&self.logs.visible, seq);
            self.logs.scroll.scroll_to_item(pos, ScrollStrategy::Top);
        }
        cx.notify();
    }

    pub(crate) fn render_service_logs(
        &self,
        detail: &DetailView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = ui.p;
        let m = &self.logs.model;
        let selected = m.service.as_deref().unwrap_or("All");
        let unavailable = matches!(m.state, StreamState::Unavailable { .. });
        let mut service_choices = service_menu(ui).child(
            menu_row(
                "service-filter-all",
                Glyph::Layers,
                "All services",
                m.service.is_none(),
                ui,
            )
            .on_click(cx.listener(|this, _, _, cx| this.filter_service_logs(None, cx))),
        );
        for (index, service) in detail.services.iter().enumerate() {
            let name = service.name.clone();
            service_choices = service_choices.child(
                menu_row(
                    ("service-filter", index),
                    Glyph::Container,
                    name.clone(),
                    selected == name,
                    ui,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.filter_service_logs(Some(name.clone()), cx)
                })),
            );
        }
        let service_button = action_button(
            "service-log-filter",
            Glyph::Filter,
            format!("Service: {selected}"),
            true,
            ui,
        )
        .h(px(28.))
        .child(icon(Glyph::ChevronDown, size::ICON, p.text_muted));
        let toolbar = h_flex()
            .flex_none()
            .gap(space::S4)
            .child(div().flex_1().min_w_0().child(
                Input::new(&self.logs.search).small().prefix(icon(
                    Glyph::Search,
                    size::ICON,
                    p.text_muted,
                )),
            ))
            .child(self.with_service_menu(
                service_button,
                ServiceMenu::LogService,
                service_choices,
                cx,
            ))
            .when(
                m.follow && matches!(m.state, StreamState::Following | StreamState::Connecting),
                |bar| {
                    let label = if m.paused && m.unseen > 0 {
                        format!("Resume · {} new", m.unseen)
                    } else if m.paused {
                        "Resume".into()
                    } else {
                        "Pause".into()
                    };
                    bar.child(
                        action_button(
                            "service-log-pause",
                            if m.paused { Glyph::Play } else { Glyph::Pause },
                            label,
                            true,
                            ui,
                        )
                        .h(px(28.))
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_log_pause(cx)))
                        .test_support(),
                    )
                },
            )
            .child(
                self.service_menu_trigger(
                    "service-log-options",
                    ServiceMenu::LogOptions,
                    self.log_options(detail, ui, cx),
                    ui,
                    cx,
                )
                .test_support(),
            );
        let ui_for_rows = ui.clone();
        let lines = list(
            self.logs.service_scroll.clone(),
            cx.processor(move |this, index: usize, _, cx| {
                let Some(line) = this
                    .logs
                    .visible
                    .get(index)
                    .and_then(|&i| this.logs.model.line(i))
                else {
                    return div().into_any_element();
                };
                let seq = line.seq;
                let query = this.logs.model.search.trim().to_lowercase();
                service_log_line(line, &query, &this.logs, &ui_for_rows)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.logs.model.toggle_expanded(seq);
                        this.logs.service_scroll.remeasure_items(index..index + 1);
                        cx.notify();
                    }))
                    .into_any_element()
            }),
        )
        .flex_1()
        .min_h_0()
        .w_full();
        let following = match (&m.state, m.paused) {
            (StreamState::Following, true) => "Paused",
            (StreamState::Following, false) => "Following",
            (StreamState::Finished, _) => "History",
            (StreamState::FollowEnded, _) => "Follow ended",
            (StreamState::Connecting, _) => "Connecting",
            _ => "Logs",
        };
        let search_count = if m.search.trim().is_empty() {
            String::new()
        } else {
            format!(" · {} matches", self.logs.matching)
        };
        let retained = format!("{following} · {} lines{search_count}", m.len());
        v_flex()
            .flex_1()
            .min_h_0()
            .gap(space::S6)
            .when(!unavailable, |d| d.child(toolbar))
            .children(m.banner().map(|banner| {
                h_flex()
                    .flex_none()
                    .gap(space::S4)
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .child(banner)
                    .when(m.can_reconnect(), |row| {
                        row.child(
                            action_button(
                                "service-log-reconnect",
                                Glyph::Restart,
                                "Reconnect",
                                true,
                                ui,
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.open_logs(cx))),
                        )
                    })
            }))
            .when(m.skipped > 0, |d| {
                d.child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_muted)
                        .child(format!(
                            "{} events skipped while the log stream outran the display",
                            m.skipped
                        )),
                )
            })
            .child(
                div()
                    .id("service-log-lines")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .on_scroll(cx.listener(|this, ev: &gpui_kit::ScrollEvent, _, cx| {
                        if ev.delta.pixel_delta(px(20.)).y > px(0.)
                            && this.logs.model.follow
                            && !this.logs.model.paused
                        {
                            this.toggle_log_pause(cx);
                        }
                    }))
                    .when(
                        self.logs.visible.is_empty()
                            && !unavailable
                            && !matches!(m.state, StreamState::Failed { .. }),
                        |d| {
                            let label = if m.search.trim().is_empty() {
                                "No log lines yet"
                            } else {
                                "No lines match the filter"
                            };
                            d.child(
                                div()
                                    .type_step(text::SMALL)
                                    .text_color(p.text_muted)
                                    .child(label),
                            )
                        },
                    )
                    .child(lines),
            )
            .child(
                h_flex()
                    .justify_between()
                    .gap(space::S4)
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .child(div().truncate().child(format!(
                        "{retained} · Logs are shown as printed, including any secrets"
                    )))
                    .child(
                        div()
                            .font_family(ui.mono.clone())
                            .flex_none()
                            .type_step(text::MICRO)
                            .child(if cfg!(target_os = "macos") {
                                "/ filter   space pause   ⌘K jump"
                            } else {
                                "/ filter   space pause   Ctrl+K jump"
                            }),
                    ),
            )
            .into_any_element()
    }

    fn filter_service_logs(&mut self, service: Option<String>, cx: &mut Context<Self>) {
        self.service_pane.menu = None;
        if self.logs.model.set_service(service) {
            self.logs.model.set_paused(false);
            self.open_logs(cx);
        }
        cx.notify();
    }

    fn log_options(&self, detail: &DetailView, ui: &Ui, cx: &mut Context<Self>) -> gpui_kit::Div {
        let copy = detail.branch.as_deref().unwrap_or("main");
        let mut menu = service_menu(ui)
            .child(
                menu_row("log-wrap", Glyph::Wrap, "Wrap lines", self.logs.wrap, ui).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.service_pane.menu = None;
                        this.logs.wrap = !this.logs.wrap;
                        cx.notify();
                    }),
                ),
            )
            .child(
                menu_row(
                    "log-json",
                    Glyph::Braces,
                    "Highlight JSON",
                    self.logs.highlight_json,
                    ui,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.service_pane.menu = None;
                    this.logs.highlight_json = !this.logs.highlight_json;
                    cx.notify();
                })),
            )
            .child(
                menu_row(
                    "log-matches",
                    Glyph::ListFilter,
                    "Only matching lines",
                    self.logs.only_matching,
                    ui,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.service_pane.menu = None;
                    this.logs.only_matching = !this.logs.only_matching;
                    this.refresh_log_rows();
                    if this.logs.should_autoscroll() {
                        this.logs.scroll_end();
                    }
                    cx.notify();
                })),
            )
            .child(menu_separator(ui));
        #[cfg(hack_terminal)]
        {
            menu =
                menu.child(
                    menu_row(
                        "log-terminal",
                        Glyph::Terminal,
                        "Open in terminal",
                        false,
                        ui,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_service_logs_in_terminal(window, cx)
                    })),
                );
        }
        #[cfg(not(hack_terminal))]
        if let Some(command) = self.logs_command() {
            menu = menu.child(
                menu_row(
                    "log-terminal",
                    Glyph::Terminal,
                    "Copy terminal command",
                    false,
                    ui,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.service_pane.menu = None;
                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(command.clone()));
                    cx.notify();
                })),
            );
        }
        menu.child(
            menu_row(
                "log-all-services",
                Glyph::Layers,
                format!("All services in {copy}"),
                self.logs.model.service.is_none(),
                ui,
            )
            .on_click(cx.listener(|this, _, _, cx| this.filter_service_logs(None, cx)))
            .test_support(),
        )
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
            let stopped = self
                .model
                .detail()
                .is_some_and(|d| d.state == hack_desktop_core::state::ProjectState::Stopped);
            let text = if !m.follow && stopped && !unavailable {
                format!("{text} · project stopped")
            } else {
                text
            };
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
                        let color = if line.error_level {
                            t.danger
                        } else if line.stderr {
                            t.muted_foreground
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
            .when(m.skipped > 0, |d| d.child(div().mx_5().mb_2().text_xs()
                .text_color(t.muted_foreground)
                .child(format!("{} events skipped while the log stream outran the display.", m.skipped))))
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

fn service_log_line(
    line: &LogLine,
    query: &str,
    pane: &LogsPane,
    ui: &Ui,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let p = ui.p;
    let expanded = pane.model.is_expanded(line.seq);
    let (message, hidden) = line.display(expanded);
    let style = if !query.is_empty() && !pane.only_matching && line_matches(line, query) {
        p.surface_1
    } else {
        p.surface
    };
    let level_color = if line.error_level {
        p.states.failed.fg
    } else if line.warn_level {
        p.states.degraded.fg
    } else {
        p.text_muted
    };
    let timestamp = line.timestamp.as_deref().unwrap_or_default();
    let timestamp = timestamp
        .split_once('T')
        .map_or(timestamp, |(_, t)| t.get(..8).unwrap_or(t));
    let mut tail = String::new();
    if hidden + line.cut > 0 {
        tail = format!(" … (+{} KB)", (hidden + line.cut).div_ceil(1024));
    }
    if line.truncated_by_hack {
        tail.push_str(" · truncated by hack");
    }
    let highlights = if pane.highlight_json {
        json_key_ranges(message)
            .into_iter()
            .map(|range| {
                (
                    range,
                    HighlightStyle {
                        color: Some(p.text_muted),
                        ..Default::default()
                    },
                )
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    div()
        .id(("service-log-line", line.seq as usize))
        .w_full()
        .flex()
        .items_start()
        .min_h(px(20.))
        .gap(space::S4)
        .font_family(ui.mono.clone())
        .type_step(text::MONO)
        .cursor_pointer()
        .bg(style)
        .hover(move |d| d.bg(p.surface_1))
        .child(
            div()
                .w(px(68.))
                .flex_none()
                .text_color(p.text_muted)
                .child(timestamp.to_owned()),
        )
        .child(
            div()
                .w(px(38.))
                .flex_none()
                .text_color(level_color)
                .child(line.level()),
        )
        .when(pane.model.service.is_none(), |row| {
            row.child(
                div()
                    .w(px(72.))
                    .flex_none()
                    .truncate()
                    .text_color(p.text_muted)
                    .child(line.service.clone().unwrap_or_default()),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_color(if line.stderr {
                    p.text_muted
                } else {
                    p.text_secondary
                })
                .when(!expanded && !pane.wrap, |d| d.truncate())
                .child(StyledText::new(format!("{message}{tail}")).with_highlights(highlights)),
        )
}

#[cfg(feature = "screenshots")]
impl LogsPane {
    pub(crate) fn show_service_fixture(&mut self) {
        self.close();
        self.model.start(true);
        for (time, level, message) in [
            ("04:12:03", "info", "listening on :3000"),
            ("04:12:03", "info", r#"{"msg":"db pool ready","size":10}"#),
            ("04:12:09", "info", "GET /health 200 2ms"),
            ("04:12:14", "info", "GET /api/search?q=lamp 200 41ms"),
            (
                "04:12:14",
                "warn",
                "slow query search_products 380ms (limit 250ms)",
            ),
            ("04:12:20", "info", "GET /api/search?q=desk 200 38ms"),
            ("04:12:31", "info", "POST /api/cart 201 12ms"),
            ("04:12:44", "error", "search index stale: rebuild queued"),
            ("04:12:45", "info", "index rebuild started (example)"),
            ("04:12:52", "info", "GET /api/search?q=chair 200 44ms"),
            ("04:13:02", "info", "index rebuild done in 17s"),
            ("04:13:05", "info", "GET /health 200 1ms"),
            ("04:13:11", "info", "GET /api/search?q=lamp 200 22ms"),
            (
                "04:13:19",
                "info",
                r#"{"msg":"cache hit","key":"search:lamp"}"#,
            ),
            ("04:13:24", "info", "GET /api/products/42 200 9ms"),
            ("04:13:30", "info", "GET /health 200 1ms"),
        ] {
            self.model.apply(&hack_desktop_core::models::LogEvent {
                kind: "log".into(),
                entry: Some(hack_desktop_core::models::LogEntry {
                    service: Some("api".into()),
                    message: message.into(),
                    timestamp: Some(time.into()),
                    level: Some(level.into()),
                    ..Default::default()
                }),
                ..Default::default()
            });
        }
        self.refresh_visible(None);
    }
}
