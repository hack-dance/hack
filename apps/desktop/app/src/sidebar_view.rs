use gpui_kit::base::{Popover, TestSupportExt as _};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::{AnyElement, Context, Div, Stateful, Window, div, prelude::*, px};
use hack_desktop_core::state::{Action, ProjectState, ServiceView};
use hack_desktop_core::viewmodel::{DetailView, InstanceKey, ListView, Row};

use crate::service_view::ServiceTab;
use hack_desktop_ui::components::{StyledExt as _, Ui, dot, icon, icon_button};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::{Status, project_label};
use hack_desktop_ui::tokens::{radius, size, space, text};

use crate::doctor_view::Pane;
use crate::view::HackApp;

fn disclosure(open: bool, ui: &Ui) -> impl IntoElement {
    icon(
        if open {
            Glyph::ChevronDown
        } else {
            Glyph::ChevronRight
        },
        size::ICON,
        ui.p.text_muted,
    )
}

fn tree_dot(status: Status, ui: &Ui) -> Div {
    if status == Status::Stopped {
        div()
            .size(size::DOT)
            .rounded_full()
            .flex_none()
            .border(px(1.))
            .border_color(ui.p.states.stopped.dot)
    } else {
        dot(status, ui)
    }
}

fn sidebar_row(ui: &Ui) -> Div {
    div()
        .h(size::ROW)
        .flex_none()
        .flex()
        .items_center()
        .rounded(radius::CONTROL)
        .type_step(text::BODY)
        .text_color(ui.p.text_secondary)
}

fn name(label: String, strong: bool, ui: &Ui) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .truncate()
        .type_step(if strong {
            text::BODY_STRONG
        } else {
            text::BODY
        })
        .when(strong, |d| d.text_color(ui.p.text_primary))
        .child(label)
}

pub(crate) fn short_path(path: &str) -> String {
    if let Some(home) = std::env::var_os("HOME")
        && let Ok(relative) = std::path::Path::new(path).strip_prefix(home)
    {
        return format!("~/{}", relative.display());
    }
    path.to_owned()
}

fn tag(label: String, ui: &Ui) -> Div {
    div()
        .max_w(px(120.))
        .min_w_0()
        .truncate()
        .type_step(text::MONO)
        .font_family(ui.mono.clone())
        .text_color(ui.p.text_muted)
        .child(label)
}

/// A selectable copy has a CLI instance key. Detached worktrees still have
/// a row, even when the CLI cannot name an isolated instance for them.
struct CopyItem<'a> {
    name: &'a str,
    tag: String,
    glyph: Glyph,
    key: Option<&'a InstanceKey>,
    state: Option<&'a ProjectState>,
    route: Option<&'a str>,
    not_started: bool,
}

fn copies(row: &Row) -> impl Iterator<Item = CopyItem<'_>> {
    std::iter::once(CopyItem {
        name: "main",
        tag: row.root.as_deref().map(short_path).unwrap_or_default(),
        glyph: Glyph::Branch,
        key: Some(&row.key),
        state: Some(&row.state),
        route: row.url.as_deref(),
        not_started: false,
    })
    .chain(row.branches.iter().map(|branch| {
        CopyItem {
            name: &branch.branch,
            tag: if branch.worktree {
                "worktree"
            } else {
                "branch"
            }
            .into(),
            glyph: if branch.worktree {
                Glyph::Worktree
            } else {
                Glyph::Branch
            },
            key: Some(&branch.key),
            state: Some(&branch.state),
            route: branch.url.as_deref(),
            not_started: branch.not_started,
        }
    }))
    .chain(row.unaddressed_worktrees.iter().map(|worktree| CopyItem {
        name: worktree.branch.as_deref().unwrap_or_else(|| {
            worktree
                .path
                .as_deref()
                .and_then(|path| path.rsplit('/').next())
                .unwrap_or("worktree")
        }),
        tag: "worktree".into(),
        glyph: Glyph::Worktree,
        key: None,
        state: None,
        route: None,
        not_started: false,
    }))
}

impl HackApp {
    pub(crate) fn copy_menu(&self, ui: &Ui, cx: &mut Context<Self>) -> impl IntoElement {
        let app = cx.entity().downgrade();
        let p = ui.p;
        let trigger = action_icon("copy-more", Glyph::More, "Copy actions", ui).into_any_element();
        Popover::new("copy-menu")
            .anchor(gpui_kit::Anchor::TopRight)
            .trigger_with(move |_, _, _| trigger)
            .content(move |_, _, cx| {
                let popover = cx.entity().downgrade();
                div()
                    .id("copies-details")
                    .px(space::S5)
                    .py(space::S4)
                    .bg(p.surface_1)
                    .hairline(p.border)
                    .rounded(radius::CONTROL)
                    .hover(move |row| row.bg(p.surface_2))
                    .cursor_pointer()
                    .child("Inspect copies")
                    .on_click(move |_, window, cx| {
                        let _ = popover.update(cx, |popover, cx| popover.dismiss(window, cx));
                        let _ = app.update(cx, |app, cx| app.set_tab(3, cx));
                    })
            })
    }

    pub(crate) fn project_tree(&self, list: &ListView, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let detail = self.model.detail();
        let mut rows: Vec<_> = list
            .running
            .iter()
            .chain(&list.stopped)
            .filter(|row| self.matches(row))
            .collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.running_services));
        let p = ui.p;
        let mut tree = div().flex().flex_col().child(
            div()
                .flex()
                .justify_between()
                .px(space::S4)
                .pt(space::S6)
                .pb(space::S4)
                .type_step(text::SMALL_STRONG)
                .text_color(p.text_muted)
                .child("PROJECTS")
                .child(rows.len().to_string()),
        );
        if rows.is_empty() {
            return tree.child(
                div()
                    .px(space::S4)
                    .py(space::S4)
                    .child("No project matches"),
            );
        }
        for row in rows {
            let opened = detail
                .as_ref()
                .filter(|d| self.pane == Pane::Project && d.key.project == row.name);
            let project = row.name.clone();
            let active = row.running_services;
            let status = if active > 0 {
                Status::Running
            } else {
                Status::of(&row.state)
            };
            tree = tree.child(
                sidebar_row(ui)
                    .id(format!("project-{project}"))
                    .px(space::S4)
                    .gap(space::S4)
                    .cursor_pointer()
                    .hover(move |row| row.bg(p.surface_1))
                    .child(disclosure(opened.is_some(), ui))
                    .child(tree_dot(status, ui))
                    .child(name(project.clone(), true, ui))
                    .when(row.always_on, |row| {
                        row.child(icon(Glyph::Pin, size::ICON, p.text_muted))
                    })
                    .children((active > 0).then(|| {
                        div()
                            .flex_none()
                            .type_step(text::SMALL_STRONG)
                            .text_color(p.text_muted)
                            .child(format!("{active} running"))
                    }))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.select_project(project.clone(), cx)),
                    ),
            );
            let Some(detail) = opened else { continue };
            for (i, copy) in copies(row).enumerate() {
                let expanded = copy.key == Some(&detail.key);
                let selected = expanded && self.model.selected_service().is_none();
                let mut entry = sidebar_row(ui)
                    .id(format!("copy-{}-{i}", row.name))
                    .pl(space::S8)
                    .pr(space::S4)
                    .gap(space::S4)
                    .when(selected, |row| row.bg(p.surface_2))
                    .child(disclosure(expanded, ui))
                    .child(icon(copy.glyph, size::ICON, p.text_muted))
                    .child(name(copy.name.to_owned(), selected, ui))
                    .child(tag(copy.tag, ui))
                    .child(tree_dot(copy.state.map_or(Status::Unknown, Status::of), ui));
                if let Some(key) = copy.key.cloned() {
                    entry =
                        entry
                            .cursor_pointer()
                            .hover(move |row| row.bg(p.surface_1))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_instance(key.clone(), cx)
                            }));
                }
                tree = tree.child(entry.test_support());
                if expanded {
                    for svc in &detail.services {
                        tree = tree.child(self.sidebar_service(detail, svc, ui, cx));
                    }
                }
            }
        }
        tree
    }

    fn sidebar_service(
        &self,
        detail: &DetailView,
        service: &ServiceView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = ui.p;
        let service_name = service.name.clone();
        let group = format!("service-{}", service.name);
        let selected = self
            .model
            .selected_service()
            .is_some_and(|s| s.instance == detail.key && s.name == service.name);
        let menu_open = self.sidebar_menu.as_deref() == Some(service.name.as_str());
        let menu = if menu_open {
            self.service_menu(detail, service, ui, cx)
                .into_any_element()
        } else {
            div().into_any_element()
        };
        let app = cx.entity().downgrade();
        let menu_name = service.name.clone();
        let menu_key = detail.key.clone();
        let service_key = detail.key.clone();
        let mut actions = div().flex_none().flex().items_center().gap(space::S1);
        if let Some(url) = service_url(service) {
            actions = actions.child(
                action_icon("service-open", Glyph::ExternalLink, "Open in browser", ui)
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            );
        }
        if self.can_run_service_action(detail, service, Action::Stop) {
            let name = service.name.clone();
            let key = detail.key.clone();
            actions = actions.child(
                action_icon("service-stop", Glyph::Stop, "Stop", ui).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.run_service_action(key.clone(), &name, Action::Stop, cx);
                    },
                )),
            );
        }
        let more = action_icon("service-more", Glyph::More, "Service actions", ui)
            .test_support()
            .into_any_element();
        actions = actions.child(
            Popover::new("service-menu")
                .open(menu_open)
                .trigger_with(move |_, _, _| more)
                .on_open_change(move |open, window, cx| {
                    let _ = app.update(cx, |app, cx| {
                        if *open {
                            app.select_service(menu_key.clone(), menu_name.clone(), window, cx);
                            app.sidebar_menu = Some(menu_name.clone());
                        } else if app.sidebar_menu.as_deref() == Some(menu_name.as_str()) {
                            app.sidebar_menu = None;
                        }
                        cx.notify();
                    });
                })
                .content(move |_, _, _| menu),
        );
        sidebar_row(ui)
            .id(group.clone())
            .group(group.clone())
            .pl(px(40.))
            .pr(space::S4)
            .gap(space::S4)
            .when(selected, |row| row.bg(p.surface_2))
            .when(!selected, |row| row.hover(move |row| row.bg(p.surface_1)))
            .child(tree_dot(Status::of_service(service), ui))
            .child(
                div()
                    .id("select-service")
                    .h_full()
                    .flex()
                    .items_center()
                    .flex_1()
                    .min_w_0()
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .child(name(service.name.clone(), selected, ui))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_service(service_key.clone(), service_name.clone(), window, cx);
                    }))
                    .test_support(),
            )
            .children(
                service
                    .exit_code
                    .filter(|_| !selected && !service.intentionally_stopped)
                    .map(|code| {
                        tag(format!("exited ({code})"), ui)
                            .id("exit-code")
                            .group_hover(group.clone(), |s| s.invisible())
                    }),
            )
            .child(
                actions
                    .id("service-actions")
                    .when(!selected && !menu_open, |actions| {
                        actions.invisible().group_hover(group, |s| s.visible())
                    }),
            )
            .test_support()
    }

    fn service_menu(
        &self,
        detail: &DetailView,
        svc: &ServiceView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = ui.p;
        let url = service_url(svc);
        let items = [
            (
                ServiceCommand::Open,
                Glyph::ExternalLink,
                "Open in browser".into(),
                url.is_some(),
            ),
            (
                ServiceCommand::Logs,
                Glyph::Logs,
                "Logs".into(),
                detail.runtime_addressable,
            ),
            (
                ServiceCommand::Shell,
                Glyph::Terminal,
                format!("Shell in {}", svc.name),
                cfg!(hack_terminal) && detail.shells.contains(&svc.name),
            ),
            (
                ServiceCommand::Files,
                Glyph::Directory,
                "Files".into(),
                true,
            ),
            (
                ServiceCommand::Restart,
                Glyph::Restart,
                "Restart".into(),
                self.can_run_service_action(detail, svc, Action::Restart),
            ),
            (
                ServiceCommand::Stop,
                Glyph::Stop,
                "Stop".into(),
                self.can_run_service_action(detail, svc, Action::Stop),
            ),
            (
                ServiceCommand::Copy,
                Glyph::Copy,
                "Copy route".into(),
                url.is_some(),
            ),
        ];
        let mut menu = div()
            .w(px(224.))
            .flex()
            .flex_col()
            .p(space::S2)
            .rounded(radius::PANEL)
            .bg(if matches!(p.mode, hack_desktop_ui::tokens::Mode::Light) {
                p.surface
            } else {
                p.surface_1
            })
            .hairline(p.border);
        for (i, (command, glyph, label, enabled)) in items.into_iter().enumerate() {
            if matches!(command, ServiceCommand::Restart | ServiceCommand::Copy) {
                menu = menu.child(div().mx(space::S4).my(space::S2).hairline_t(p.border));
            }
            let mut item = sidebar_row(ui)
                .id(("service-command", i))
                .px(space::S4)
                .gap(space::S4)
                .text_color(if enabled {
                    p.text_primary
                } else {
                    p.text_muted
                })
                .child(icon(glyph, size::ICON, p.text_secondary))
                .child(label);
            if enabled {
                let name = svc.name.clone();
                let url = url.clone();
                let key = detail.key.clone();
                item = item
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .hover(move |row| row.bg(p.surface_2))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.service_command(
                            command,
                            key.clone(),
                            name.clone(),
                            url.as_deref(),
                            window,
                            cx,
                        )
                    }));
            }
            menu = menu.child(item.test_support());
        }
        menu
    }

    fn service_command(
        &mut self,
        command: ServiceCommand,
        key: InstanceKey,
        service: String,
        url: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_menu = None;
        if self.model.selected_key().as_ref() != Some(&key) {
            cx.notify();
            return;
        }
        if matches!(command, ServiceCommand::Logs | ServiceCommand::Shell)
            && self.model.detail().is_none_or(|d| !d.runtime_addressable)
        {
            cx.notify();
            return;
        }
        match command {
            ServiceCommand::Open => {
                if let Some(url) = url {
                    cx.open_url(url);
                }
            }
            ServiceCommand::Copy => {
                if let Some(url) = url {
                    self.copy_url(url.to_owned(), cx);
                }
            }
            ServiceCommand::Logs => {
                self.select_service(key, service, window, cx);
                self.set_service_tab(ServiceTab::Logs, window, cx);
            }
            ServiceCommand::Shell => {
                self.select_service(key, service, window, cx);
                self.set_service_tab(ServiceTab::Terminal, window, cx);
            }
            ServiceCommand::Files => {
                self.select_service(key, service, window, cx);
                self.set_service_tab(ServiceTab::Files, window, cx);
            }
            ServiceCommand::Restart => self.run_service_action(key, &service, Action::Restart, cx),
            ServiceCommand::Stop => self.run_service_action(key, &service, Action::Stop, cx),
        }
        cx.notify();
    }

    pub(crate) fn other_copies(
        &self,
        list: &ListView,
        detail: &DetailView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let project = list
            .running
            .iter()
            .chain(&list.stopped)
            .find(|row| row.name == detail.name)?;
        let p = ui.p;
        let column = gpui_kit::relative(size::SERVICE_COL_FRACTION);
        let mut entries = copies(project)
            .filter(|copy| copy.key != Some(&detail.key))
            .peekable();
        entries.peek()?;
        let mut section = div().pt(space::S9).flex().flex_col().child(
            div()
                .pb(space::S4)
                .type_step(text::SMALL_STRONG)
                .text_color(p.text_muted)
                .child(format!("OTHER COPIES OF {}", project.name.to_uppercase())),
        );
        for (i, copy) in entries.enumerate() {
            let status = copy.state.map_or(Status::Unknown, Status::of);
            let label = match copy.state {
                Some(ProjectState::FailedStart { services }) if !services.is_empty() => {
                    format!("failed to start: {}", services.join(", "))
                }
                _ if copy.not_started => "not started".into(),
                Some(state) => project_label(state),
                None => "unknown".into(),
            };
            let mut row = div()
                .id(("other-copy", i))
                .h(size::TABLE_ROW)
                .flex()
                .items_center()
                .when(i > 0, |row| row.hairline_t(p.border))
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(
                    div()
                        .w(column)
                        .flex_none()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .child(icon(copy.glyph, size::ICON, p.text_secondary))
                        .child(
                            div()
                                .truncate()
                                .text_color(p.text_primary)
                                .child(copy.name.to_owned()),
                        ),
                )
                .child(
                    div()
                        .w(column)
                        .flex_none()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .when(
                            status == Status::Failed || status == Status::Running,
                            |row| row.child(tree_dot(status, ui)),
                        )
                        .child(div().truncate().child(label)),
                )
                .child(div().w(size::CPU_COL + size::MEMORY_COL).flex_none())
                .child(
                    div()
                        .flex_1()
                        .pl(space::S4)
                        .min_w_0()
                        .truncate()
                        .font_family(ui.mono.clone())
                        .type_step(text::MONO)
                        .child(
                            copy.route
                                .map(|url| {
                                    url.trim_start_matches("https://")
                                        .trim_start_matches("http://")
                                })
                                .unwrap_or("—")
                                .to_owned(),
                        ),
                );
            if let Some(key) = copy.key.cloned() {
                row = row
                    .cursor_pointer()
                    .hover(move |row| row.bg(p.surface_1))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.select_instance(key.clone(), cx)),
                    );
            }
            section = section.child(row.test_support());
        }
        Some(section.into_any_element())
    }
}

#[derive(Clone, Copy)]
enum ServiceCommand {
    Open,
    Logs,
    Shell,
    Files,
    Restart,
    Stop,
    Copy,
}

fn action_icon(id: &'static str, glyph: Glyph, label: &'static str, ui: &Ui) -> Stateful<Div> {
    icon_button(id, glyph, ui).tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
}

fn service_url(service: &ServiceView) -> Option<String> {
    let host = service.route.as_deref()?;
    let url = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_owned()
    } else {
        format!("https://{host}")
    };
    Some(url)
}
