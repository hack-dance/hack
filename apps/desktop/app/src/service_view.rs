//! A service route within the selected project instance. The sidebar and the
//! Services table both enter through select_service.
use gpui_kit::{
    AnyElement, App, ClipboardItem, Context, Div, IntoElement, KeyBinding, ParentElement,
    SharedString, Stateful, Styled, TestSupportExt as _, Window, div, prelude::*, px,
};
use hack_desktop_core::{
    models::{Container, ProjectRow},
    state::{Action, ServiceView},
    viewmodel::{DetailView, InstanceKey},
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, dot, icon, icon_button},
    icons::Glyph,
    status::{Status, service_label, short_duration},
    tokens::{Mode, radius, size, space, text},
};

use crate::doctor_view::Pane;
use crate::view::HackApp;

gpui_kit::actions!(
    hack_desktop,
    [
        ServiceInfo,
        ServiceStats,
        ServiceLogs,
        ServiceTerminal,
        ServiceFiles,
        FilterServiceLogs,
        PauseServiceLogs,
        DismissServiceMenu
    ]
);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ServiceTab {
    Info,
    Stats,
    #[default]
    Logs,
    Terminal,
    Files,
}

const TABS: [(ServiceTab, &str); 5] = [
    (ServiceTab::Info, "Info"),
    (ServiceTab::Stats, "Stats"),
    (ServiceTab::Logs, "Logs"),
    (ServiceTab::Terminal, "Terminal"),
    (ServiceTab::Files, "Files"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ServiceMenu {
    Actions,
    LogService,
    LogOptions,
}

#[derive(Default)]
pub(crate) struct ServicePane {
    name: Option<String>,
    pub tab: ServiceTab,
    pub menu: Option<ServiceMenu>,
}

pub(crate) const SERVICE_TAB_KEYS: [&str; 5] = if cfg!(target_os = "macos") {
    ["cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5"]
} else {
    ["ctrl-1", "ctrl-2", "ctrl-3", "ctrl-4", "ctrl-5"]
};

pub(crate) fn bind_keys(cx: &mut App) {
    const CONTEXT: Option<&str> = Some("ServiceDetails");
    cx.bind_keys([
        KeyBinding::new(SERVICE_TAB_KEYS[0], ServiceInfo, CONTEXT),
        KeyBinding::new(SERVICE_TAB_KEYS[1], ServiceStats, CONTEXT),
        KeyBinding::new(SERVICE_TAB_KEYS[2], ServiceLogs, CONTEXT),
        KeyBinding::new(SERVICE_TAB_KEYS[3], ServiceTerminal, CONTEXT),
        KeyBinding::new(SERVICE_TAB_KEYS[4], ServiceFiles, CONTEXT),
        KeyBinding::new("/", FilterServiceLogs, Some("ServiceLogsPane && !Input")),
        KeyBinding::new("space", PauseServiceLogs, Some("ServiceLogsPane && !Input")),
        KeyBinding::new("escape", DismissServiceMenu, Some("ServiceMenu")),
    ]);
}

impl HackApp {
    pub(crate) fn selected_service(&self) -> Option<&str> {
        (self.pane == Pane::Project)
            .then_some(self.service_pane.name.as_deref())
            .flatten()
    }

    pub(crate) fn select_service(
        &mut self,
        key: InstanceKey,
        service: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.model.selected_key().as_ref() != Some(&key) || self.pane != Pane::Project {
            self.select_instance(key.clone(), cx);
        }
        if !self.model.detail().is_some_and(|detail| {
            detail.key == key && detail.services.iter().any(|row| row.name == service)
        }) || self.selected_service() == Some(&service)
        {
            return;
        }
        self.user_navigated();
        self.service_focus.focus(window, cx);
        self.service_pane = ServicePane {
            name: Some(service.clone()),
            ..Default::default()
        };
        self.logs.reset_service_search(window, cx);
        self.logs.model.set_service(Some(service));
        self.open_logs(cx);
        cx.notify();
    }

    pub(crate) fn clear_selected_service(&mut self) {
        if self.service_pane.name.is_some() {
            #[cfg(hack_terminal)]
            self.leave_terminal_log_scope();
            self.logs.close();
            self.logs.model.set_service(None);
            self.logs.model.set_paused(false);
            self.service_pane = ServicePane::default();
        }
    }

    pub(crate) fn shows_json_logs(&self) -> bool {
        if self.service_pane.name.is_some() {
            self.selected_service().is_some() && self.service_pane.tab == ServiceTab::Logs
        } else {
            self.tab == 1
        }
    }

    pub(crate) fn sync_service_logs(&mut self, cx: &mut Context<Self>) {
        if self.service_pane.name.is_none() {
            return;
        }
        let idle = self.logs.model.state == hack_desktop_core::logs::StreamState::Idle;
        if self.shows_json_logs() && idle {
            self.open_logs(cx);
        } else if !self.shows_json_logs() && !idle {
            self.logs.close();
        }
    }

    pub(crate) fn set_service_tab(
        &mut self,
        to: ServiceTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected_service().is_none() {
            return;
        }
        self.service_pane.menu = None;
        if self.service_pane.tab != to {
            self.service_pane.tab = to;
            self.sync_service_logs(cx);
            self.service_focus.focus(window, cx);
        }
        #[cfg(hack_terminal)]
        if to == ServiceTab::Terminal
            && let Some(name) = self.selected_service().map(str::to_owned)
        {
            self.open_service_shell(&name, window, cx);
        }
        cx.notify();
    }

    pub(crate) fn service_handlers(
        &self,
        root: Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let root = root
            .on_action(cx.listener(|this, _: &ServiceInfo, window, cx| {
                this.set_service_tab(ServiceTab::Info, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ServiceStats, window, cx| {
                this.set_service_tab(ServiceTab::Stats, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ServiceLogs, window, cx| {
                this.set_service_tab(ServiceTab::Logs, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ServiceTerminal, window, cx| {
                this.set_service_tab(ServiceTab::Terminal, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ServiceFiles, window, cx| {
                this.set_service_tab(ServiceTab::Files, window, cx)
            }));
        if self.selected_service().is_none() {
            return root;
        }
        let context = match (
            self.service_pane.tab == ServiceTab::Logs,
            self.service_pane.menu.is_some(),
        ) {
            (true, true) => "HackWindow ServiceDetails ServiceLogsPane ServiceMenu",
            (true, false) => "HackWindow ServiceDetails ServiceLogsPane",
            (false, true) => "HackWindow ServiceDetails ServiceMenu",
            (false, false) => "HackWindow ServiceDetails",
        };
        let root = root.track_focus(&self.service_focus).key_context(context);
        let root = root.when(self.service_pane.tab == ServiceTab::Logs, |root| {
            root.on_action(cx.listener(|this, _: &FilterServiceLogs, window, cx| {
                if this.service_focus.is_focused(window) {
                    this.logs.focus_search(window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &PauseServiceLogs, window, cx| {
                if this.service_focus.is_focused(window) {
                    this.toggle_log_pause(cx);
                }
            }))
        });
        root.when(self.service_pane.menu.is_some(), |root| {
            root.on_click(cx.listener(|this, _, _, cx| {
                this.service_pane.menu = None;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &DismissServiceMenu, _, cx| {
                this.service_pane.menu = None;
                cx.notify();
            }))
        })
    }

    fn service_tabs(&self, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let p = ui.p;
        div()
            .flex()
            .items_end()
            .gap(space::S8)
            .children(TABS.into_iter().enumerate().map(|(index, (tab, label))| {
                let active = self.service_pane.tab == tab;
                div()
                    .id(("service-tab", index))
                    .relative()
                    .cursor_pointer()
                    .pb(px(7.))
                    .type_step(if active {
                        text::BODY_STRONG
                    } else {
                        text::BODY
                    })
                    .text_color(if active { p.text_primary } else { p.text_muted })
                    .hover(move |d| d.text_color(p.text_primary))
                    .on_click(
                        cx.listener(move |this, _, window, cx| {
                            this.set_service_tab(tab, window, cx)
                        }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .child(label)
                            .when(active, |d| {
                                let modifier = if cfg!(target_os = "macos") {
                                    "⌘"
                                } else {
                                    "Ctrl+"
                                };
                                d.child(
                                    div()
                                        .font_family(ui.mono.clone())
                                        .type_step(text::MICRO)
                                        .text_color(p.text_muted)
                                        .child(format!("{modifier}{}", index + 1)),
                                )
                            }),
                    )
                    .when(active, |d| {
                        d.child(
                            div()
                                .absolute()
                                .left_0()
                                .right_0()
                                .bottom_0()
                                .h(px(2.))
                                .rounded_full()
                                .bg(p.text_primary),
                        )
                    })
            }))
    }

    pub(crate) fn service_detail(
        &mut self,
        detail: &DetailView,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut service_ui = ui.clone();
        let p = &mut service_ui.p;
        let (surface, chrome, raised, hover, line, ink, secondary, muted, green, amber, red) =
            match p.mode {
                Mode::Light => (
                    0xfdfdfd, 0xf2f2f2, 0xfdfdfd, 0xeeeeee, 0xdcdcdc, 0x080808, 0x303030, 0x5f5f5f,
                    0x008400, 0x737300, 0xc40000,
                ),
                Mode::Dark => (
                    0x0e1319, 0x0b0f14, 0x1b2027, 0x24292f, 0x2b3138, 0xe6edf3, 0xbcc3ca, 0x9098a0,
                    0x3bb650, 0xe0a41c, 0xff7771,
                ),
            };
        let color = |value| gpui_kit::Hsla::from(gpui_kit::rgb(value));
        p.surface = color(surface);
        p.chrome = color(chrome);
        p.surface_1 = color(hover);
        p.surface_2 = color(raised);
        p.border = color(line);
        p.border_strong = p.border;
        p.text_primary = color(ink);
        p.text_secondary = color(secondary);
        p.text_muted = color(muted);
        p.states.running.dot = color(green);
        p.states.degraded.fg = color(amber);
        p.states.failed.fg = color(red);
        let ui = &service_ui;
        let name = self.selected_service().unwrap_or_default().to_owned();
        let row = self.model.selected_row();
        let service = detail.services.iter().find(|service| service.name == name);
        let containers = row
            .as_ref()
            .map(|row| containers_for(row, &name))
            .unwrap_or_default();
        let facts = ServiceFacts::new(row.as_ref(), service, containers);
        let body = match self.service_pane.tab {
            ServiceTab::Info => render_info(&facts, self.live, ui),
            ServiceTab::Stats => render_service_stats(ui),
            ServiceTab::Logs => self.render_service_logs(detail, ui, cx),
            ServiceTab::Terminal => self.render_service_terminal(detail, ui, window, cx),
            ServiceTab::Files => render_service_files(ui),
        };
        #[cfg(hack_terminal)]
        if self.service_pane.tab == ServiceTab::Terminal && self.panels.maximized(&detail.key) {
            return body;
        }
        div()
            .id("service-detail")
            .m(space::S4)
            .mt_0()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .bg(ui.p.surface)
            .rounded(radius::PANEL)
            .border_1()
            .border_color(ui.p.border)
            .p(space::S8)
            .pb(space::S5)
            .gap(space::S6)
            .child(self.service_header(detail, &name, service, &facts, ui, cx))
            .child(self.service_tabs(ui, cx))
            .child(body)
            .into_any_element()
    }

    fn service_header(
        &self,
        detail: &DetailView,
        name: &str,
        service: Option<&ServiceView>,
        facts: &ServiceFacts,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = ui.p;
        let (status, label) = service.map_or((Status::Unknown, "Unknown".into()), |s| {
            let mut label = service_label(s);
            if let Some(first) = label.get_mut(..1) {
                first.make_ascii_uppercase();
            }
            if s.running
                && let Some(uptime) = &facts.uptime
            {
                label.push_str(&format!(" · {uptime}"));
            }
            (Status::of_service(s), label)
        });
        let copy = detail.branch.as_deref().unwrap_or("main");
        let menu = self.service_actions_menu(detail, facts, ui, cx);
        let can_act = self.can_act_on_service(detail);
        let can_stop = can_act && service.is_some_and(|s| s.running);
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .type_step(text::MONO)
                    .font_family(ui.mono.clone())
                    .text_color(p.text_muted)
                    .child(icon(Glyph::Container, size::ICON, p.text_muted))
                    .child(detail.name.clone())
                    .child("·")
                    .child(icon(Glyph::Branch, size::ICON, p.text_muted))
                    .child(format!("{copy} · {}", detail.backend)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .type_step(text::TITLE)
                            .child(name.to_owned()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .px(space::S4)
                            .rounded(radius::CONTROL)
                            .border_1()
                            .border_color(p.border)
                            .type_step(text::SMALL)
                            .text_color(p.text_secondary)
                            .child(dot(status, ui))
                            .child(label),
                    )
                    .child(div().flex_1())
                    .child(route_open_button(facts.route.clone(), self.live, ui))
                    .child(service_action_button(
                        Action::Restart,
                        Glyph::Restart,
                        can_act,
                        ui,
                        cx,
                    ))
                    .child(service_action_button(
                        Action::Stop,
                        Glyph::Stop,
                        can_stop,
                        ui,
                        cx,
                    ))
                    .child(
                        self.service_menu_trigger(
                            "service-actions",
                            ServiceMenu::Actions,
                            menu,
                            ui,
                            cx,
                        )
                        .test_support(),
                    ),
            )
            .children(facts.route.clone().map(|route| {
                div()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .text_color(p.text_secondary)
                    .child(icon(Glyph::Link, size::ICON, p.text_muted))
                    .child(div().min_w_0().truncate().child(route.clone()))
                    .children(facts.port.as_ref().map(|port| format!("→ :{port}")))
                    .child(copy_button("service-route-copy", "Copy route", route, ui))
            }))
            .children(detail.last_error.as_ref().map(|error| {
                div()
                    .type_step(text::SMALL)
                    .text_color(p.states.failed.fg)
                    .child(error.clone())
            }))
    }

    fn can_act_on_service(&self, detail: &DetailView) -> bool {
        detail.backend == "compose"
            && !detail.busy
            && !self.machine.busy()
            && detail.actions.contains(&Action::Restart)
    }

    fn run_service_action(&mut self, action: Action, cx: &mut Context<Self>) {
        let Some(name) = self.selected_service().map(str::to_owned) else {
            return;
        };
        let Some(detail) = self.model.detail().filter(|d| self.can_act_on_service(d)) else {
            return;
        };
        if !detail
            .services
            .iter()
            .any(|s| s.name == name && (action != Action::Stop || s.running))
        {
            return;
        }
        let Some(row) = self.model.selected_row() else {
            return;
        };
        let target = hack_desktop_core::source::ServiceActionTarget {
            compose_project: row
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.project.clone()),
            containers: containers_for(&row, &name)
                .iter()
                .filter(|c| c.is_running())
                .map(|c| {
                    (
                        c.id.clone().unwrap_or_default(),
                        c.name.clone().unwrap_or_default(),
                    )
                })
                .collect(),
            name,
        };
        self.service_pane.menu = None;
        self.run_scoped_action(action, Some(target), cx);
    }

    fn service_actions_menu(
        &self,
        detail: &DetailView,
        facts: &ServiceFacts,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut menu = service_menu(ui);
        if let Some(route) = &facts.route {
            let url = route.clone();
            menu = menu.child(
                menu_row(
                    "open-service-route",
                    Glyph::ExternalLink,
                    "Open in browser",
                    false,
                    ui,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.service_pane.menu = None;
                    if this.live {
                        cx.open_url(&url);
                    }
                    cx.notify();
                })),
            );
        }
        let shell = format!("Shell in {}", self.selected_service().unwrap_or_default());
        for (tab, label, glyph) in [
            (ServiceTab::Logs, "Logs", Glyph::Logs),
            (ServiceTab::Terminal, shell.as_str(), Glyph::Terminal),
            (ServiceTab::Files, "Files", Glyph::Folder),
        ] {
            menu = menu.child(
                menu_row(
                    ("service-jump", tab as usize),
                    glyph,
                    label.to_owned(),
                    false,
                    ui,
                )
                .on_click(
                    cx.listener(move |this, _, window, cx| this.set_service_tab(tab, window, cx)),
                ),
            );
        }
        if self.can_act_on_service(detail) {
            menu = menu.child(menu_separator(ui)).child(
                menu_row("service-menu-restart", Glyph::Restart, "Restart", false, ui).on_click(
                    cx.listener(|this, _, _, cx| this.run_service_action(Action::Restart, cx)),
                ),
            );
            if detail
                .services
                .iter()
                .any(|s| Some(s.name.as_str()) == self.selected_service() && s.running)
            {
                menu = menu.child(
                    menu_row("service-menu-stop", Glyph::Stop, "Stop", false, ui).on_click(
                        cx.listener(|this, _, _, cx| this.run_service_action(Action::Stop, cx)),
                    ),
                );
            }
        }
        if let Some(route) = &facts.route {
            let route = route.clone();
            menu = menu.child(menu_separator(ui)).child(
                menu_row("service-menu-copy", Glyph::Copy, "Copy route", false, ui).on_click(
                    cx.listener(move |this, _, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(route.clone()));
                        this.service_pane.menu = None;
                        cx.notify();
                    }),
                ),
            );
        }
        menu
    }

    pub(crate) fn service_menu_trigger(
        &self,
        id: &'static str,
        kind: ServiceMenu,
        menu: Div,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let trigger = action_button(id, Glyph::More, "", true, ui)
            .w(px(28.))
            .justify_center()
            .px_0();
        self.with_service_menu(trigger, kind, menu, cx)
    }

    pub(crate) fn with_service_menu(
        &self,
        trigger: Stateful<Div>,
        kind: ServiceMenu,
        menu: Div,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        trigger
            .relative()
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.service_pane.menu = (this.service_pane.menu != Some(kind)).then_some(kind);
                cx.notify();
            }))
            .when(self.service_pane.menu == Some(kind), |trigger| {
                let menu = menu
                    .id("service-menu-surface")
                    .on_click(|_, _, cx| cx.stop_propagation());
                trigger.child(
                    gpui_kit::deferred(div().absolute().top(px(32.)).right_0().child(menu))
                        .with_priority(2),
                )
            })
    }
}

pub(crate) fn service_menu(ui: &Ui) -> Div {
    div()
        .flex()
        .flex_col()
        .min_w(px(220.))
        .p(space::S2)
        .rounded(radius::PANEL)
        .bg(ui.p.surface_2)
        .border_1()
        .border_color(ui.p.border)
}

pub(crate) fn menu_separator(ui: &Ui) -> Div {
    div().h(px(1.)).mx(space::S4).my(space::S2).bg(ui.p.border)
}

pub(crate) fn menu_row(
    id: impl Into<gpui_kit::ElementId>,
    glyph: Glyph,
    label: impl Into<SharedString>,
    checked: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(space::S4)
        .rounded(radius::CONTROL)
        .px(space::S4)
        .h(px(28.))
        .cursor_pointer()
        .whitespace_nowrap()
        .hover(move |d| d.bg(p.surface_1))
        .type_step(text::BODY)
        .text_color(p.text_primary)
        .child(icon(glyph, size::ICON, p.text_secondary))
        .child(label.into())
        .child(div().flex_1())
        .when(checked, |d| {
            d.child(icon(Glyph::Check, size::ICON, p.text_primary))
        })
}

fn service_action_button(
    action: Action,
    glyph: Glyph,
    enabled: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Stateful<Div> {
    action_button(
        ("service-action", action as usize),
        glyph,
        action.label(),
        enabled,
        ui,
    )
    .min_w(px(84.))
    .justify_center()
    .when(enabled, |button| {
        button.on_click(cx.listener(move |this, _, _, cx| this.run_service_action(action, cx)))
    })
}

fn route_open_button(route: Option<String>, live: bool, ui: &Ui) -> Stateful<Div> {
    action_button(
        "service-open",
        Glyph::ExternalLink,
        "Open",
        route.is_some(),
        ui,
    )
    .min_w(px(84.))
    .justify_center()
    .when_some(route, |button, url| {
        button.on_click(move |_, _, cx| {
            if live {
                cx.open_url(&url);
            }
        })
    })
}

fn copy_button(
    id: impl Into<gpui_kit::ElementId>,
    label: impl Into<SharedString>,
    value: String,
    ui: &Ui,
) -> Stateful<Div> {
    let label = label.into();
    icon_button(id, Glyph::Copy, ui)
        .tooltip(move |window, cx| {
            gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx)
        })
        .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(value.clone())))
}

fn containers_for<'a>(row: &'a ProjectRow, name: &str) -> &'a [Container] {
    row.runtime
        .as_ref()
        .and_then(|runtime| runtime.services.iter().find(|s| s.service == name))
        .map_or(&[], |service| service.containers.as_slice())
}

struct ServiceFacts {
    route: Option<String>,
    port: Option<u16>,
    health: Option<String>,
    image: Option<String>,
    mounts: Option<String>,
    container_name: Option<String>,
    started_by: Option<String>,
    uptime: Option<String>,
}

impl ServiceFacts {
    fn new(
        row: Option<&ProjectRow>,
        service: Option<&ServiceView>,
        containers: &[Container],
    ) -> Self {
        let route = service
            .and_then(|s| s.route.as_deref())
            .and_then(service_url);
        let port = containers.iter().find_map(|container| {
            let proxy = container.labels.get("caddy.reverse_proxy")?;
            proxy
                .strip_prefix("{{upstreams ")?
                .strip_suffix("}}")?
                .trim()
                .parse()
                .ok()
        });
        let health = service.and_then(|s| {
            let state = s.status.to_ascii_lowercase();
            ["unhealthy", "healthy", "starting"]
                .into_iter()
                .find(|health| state.contains(&format!("({health})")))
                .map(|health| health.to_owned())
        });
        let image = distinct(containers.iter().filter_map(|c| c.image.clone()));
        let container_name = distinct(containers.iter().filter_map(|c| c.name.clone()));
        let mounts = distinct(containers.iter().flat_map(|c| &c.mounts).map(|mount| {
            let source = mount.name.as_deref().unwrap_or(&mount.source);
            let kind = if mount.kind == "bind"
                && row
                    .and_then(|r| r.repo_root.as_deref())
                    .is_some_and(|root| std::path::Path::new(source).starts_with(root))
            {
                "worktree"
            } else {
                &mount.kind
            };
            format!("{source} → {} · {kind}", mount.destination)
        }));
        // The Compose ownership label identifies the launcher family. The
        // daemon does not attest that a person ran a specific Hack command.
        let started_by = containers
            .iter()
            .any(|c| c.labels.contains_key("com.docker.compose.project"))
            .then(|| "Docker Compose".to_owned());
        let uptime = containers
            .iter()
            .find(|c| c.is_running())
            .and_then(Container::uptime)
            .filter(|uptime| !uptime.is_empty())
            .map(short_duration);
        Self {
            route,
            port,
            health,
            image,
            mounts,
            container_name,
            started_by,
            uptime,
        }
    }
}

fn distinct(values: impl IntoIterator<Item = String>) -> Option<String> {
    let mut values: Vec<_> = values
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
    values.sort();
    values.dedup();
    (!values.is_empty()).then(|| values.join("\n"))
}

fn service_url(route: &str) -> Option<String> {
    let host = route
        .strip_prefix("https://")
        .or_else(|| route.strip_prefix("http://"))
        .unwrap_or(route);
    (!host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b)))
    .then(|| {
        if route.contains("://") {
            route.to_owned()
        } else {
            format!("https://{host}")
        }
    })
}

fn render_info(facts: &ServiceFacts, live: bool, ui: &Ui) -> AnyElement {
    let rows = [
        (
            "Route",
            &facts.route,
            facts.port.map(|port| format!("→ :{port}")),
        ),
        ("Health", &facts.health, None),
        ("Image", &facts.image, None),
        ("Mounts", &facts.mounts, None),
        ("Container name", &facts.container_name, None),
        (
            "Started by",
            &facts.started_by,
            facts.uptime.as_ref().map(|time| format!("· {time} ago")),
        ),
    ];
    div()
        .id("service-info")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .children(
            rows.into_iter()
                .enumerate()
                .map(|(i, (label, value, note))| {
                    div()
                        .flex()
                        .items_center()
                        .min_h(px(32.))
                        .py(space::S2)
                        .gap(space::S4)
                        .when(i > 0, |d| d.hairline_t(ui.p.border))
                        .child(
                            div()
                                .w(px(144.))
                                .flex_none()
                                .type_step(text::BODY)
                                .text_color(ui.p.text_muted)
                                .child(label),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(space::S3)
                                .child(
                                    div()
                                        .min_w_0()
                                        .font_family(ui.mono.clone())
                                        .type_step(text::MONO)
                                        .text_color(if value.is_some() {
                                            ui.p.text_primary
                                        } else {
                                            ui.p.text_muted
                                        })
                                        .child(value.clone().unwrap_or_else(|| "—".into())),
                                )
                                .children(note.map(|note| {
                                    div()
                                        .text_color(ui.p.text_muted)
                                        .type_step(text::SMALL)
                                        .child(note)
                                })),
                        )
                        .children(value.clone().map(|value| {
                            copy_button(
                                ("service-fact-copy", i),
                                format!("Copy {}", label.to_lowercase()),
                                value,
                                ui,
                            )
                        }))
                        .when_some(value.as_ref().filter(|_| i == 0).cloned(), |d, route| {
                            d.child(
                                icon_button("service-info-open", Glyph::ExternalLink, ui).on_click(
                                    move |_, _, cx| {
                                        if live {
                                            cx.open_url(&route);
                                        }
                                    },
                                ),
                            )
                        })
                }),
        )
        .into_any_element()
}

/// Slice 4 supplies the service's historical usage view here.
fn render_service_stats(ui: &Ui) -> AnyElement {
    div()
        .type_step(text::BODY)
        .text_color(ui.p.text_muted)
        .child("No usage history yet")
        .into_any_element()
}

/// Slice 3 supplies the service's file browser here.
fn render_service_files(ui: &Ui) -> AnyElement {
    div()
        .type_step(text::BODY)
        .text_color(ui.p.text_muted)
        .child("Files are unavailable in this preview")
        .into_any_element()
}

#[cfg(not(hack_terminal))]
impl HackApp {
    fn render_service_terminal(
        &self,
        _: &DetailView,
        ui: &Ui,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .type_step(text::BODY)
            .text_color(ui.p.text_muted)
            .child("Terminal is unavailable in this build")
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_uses_the_selected_branch_and_service() {
        use hack_desktop_core::{
            fixtures::{Fixture, snapshot},
            state::services,
        };
        let snapshot = snapshot(Fixture::Branches).expect("branch fixture");
        let original = snapshot
            .projects
            .projects
            .iter()
            .find(|row| row.name == "storefront")
            .expect("project");
        let branch = original.instance("feature-search").expect("branch");
        let services = services(&branch);
        let api = ServiceFacts::new(
            Some(&branch),
            services.iter().find(|row| row.name == "api"),
            containers_for(&branch, "api"),
        );
        assert_eq!(
            api.route.as_deref(),
            Some("https://api.feature-search.storefront.hack")
        );
        assert_eq!(api.port, Some(3000));
        assert_eq!(api.health.as_deref(), Some("healthy"));
        assert_eq!(api.image.as_deref(), Some("storefront-api:dev"));
        assert_eq!(
            api.mounts.as_deref(),
            Some("/work/storefront → /app · worktree")
        );
        assert_eq!(
            api.container_name.as_deref(),
            Some("storefront--feature-search-api-1")
        );
        assert_eq!(api.started_by.as_deref(), Some("Docker Compose"));
        assert_eq!(api.uptime.as_deref(), Some("2h"));
        let unknown = ServiceFacts::new(None, None, &[]);
        assert!(
            unknown.route.is_none() && unknown.health.is_none() && unknown.started_by.is_none()
        );
    }

    #[test]
    fn opens_only_http_service_hosts() {
        assert_eq!(
            service_url("api.project.hack").as_deref(),
            Some("https://api.project.hack")
        );
        assert!(service_url("file:///tmp/demo").is_none());
        assert!(service_url("https://name@example.test").is_none());
    }
}
