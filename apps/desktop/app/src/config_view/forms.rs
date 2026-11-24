use std::path::PathBuf;

use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState, Position};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, Div, Entity, IntoElement, SharedString, Window, div, px,
    relative,
};
use hack_desktop_core::config::{
    ConfigChange, ConfigIssue, ConfigLayer, ConfigReport, ConfigService, EnvCell, EnvRow,
    scalar_label,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, icon},
    icons::Glyph,
    tokens::space,
};
use serde_json::Value;

use super::{
    EditSection, View, card, chip,
    map::{caption, layer_chip, layer_description, layer_title},
    mono, muted, picker, setting, strong, warning,
};
use crate::view::HackApp;

#[derive(Clone)]
enum Field {
    Project(String),
    Route {
        service: String,
        port: bool,
        sites: String,
        upstream: String,
    },
    ServiceImage(String),
    ServiceList {
        service: String,
        field: String,
    },
    Env {
        layer: String,
        scope: String,
        key: String,
    },
}

impl Field {
    fn id(&self) -> String {
        match self {
            Self::Project(path) => format!("project/{path}"),
            Self::Route { service, port, .. } => {
                format!("route/{service}/{}", if *port { "port" } else { "sites" })
            }
            Self::ServiceImage(service) => format!("service/{service}/image"),
            Self::ServiceList { service, field } => format!("service/{service}/{field}"),
            Self::Env { layer, scope, key } => format!("env/{layer}/{scope}/{key}"),
        }
    }

    fn item(&self) -> String {
        match self {
            Self::Route { service, .. } => format!("route/{service}"),
            _ => self.id(),
        }
    }

    fn stage(
        &self,
        app: &mut HackApp,
        value: String,
        original: Option<&str>,
        cx: &mut Context<HackApp>,
    ) {
        let id = self.item();
        let text_changed = Some(value.as_str()) != original;
        let changed = match self {
            Self::Project(path) => text_changed.then(|| ConfigChange::Project {
                layer: "1".into(),
                path: path.clone(),
                value: Value::String(value),
            }),
            Self::Route {
                service,
                port,
                sites,
                upstream,
            } => {
                let (mut hosts, mut number) = match app.config.draft.changes.get(&id) {
                    Some(ConfigChange::Route { sites, port, .. }) => (sites.clone(), port.clone()),
                    _ => (sites.clone(), upstream.clone()),
                };
                if *port {
                    number = value;
                } else {
                    hosts = value;
                }
                (hosts != *sites || number != *upstream).then(|| ConfigChange::Route {
                    layer: "2".into(),
                    service: service.clone(),
                    sites: hosts,
                    port: number,
                })
            }
            Self::ServiceImage(service) => text_changed.then(|| ConfigChange::Service {
                layer: "2".into(),
                service: service.clone(),
                field: "image".into(),
                value: Value::String(value),
            }),
            Self::ServiceList { service, field } => text_changed.then(|| ConfigChange::Service {
                layer: "2".into(),
                service: service.clone(),
                field: field.clone(),
                value: Value::Array(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(|part| Value::String(part.into()))
                        .collect(),
                ),
            }),
            Self::Env { layer, scope, key } => text_changed.then(|| ConfigChange::Env {
                layer: layer.clone(),
                scope: scope.clone(),
                key: key.clone(),
                value: Some(value),
            }),
        };
        app.stage_config(id, changed, cx);
    }

    fn value(&self, app: &HackApp, original: &str) -> String {
        let Some(edit) = app.config.draft.changes.get(&self.item()) else {
            return original.to_owned();
        };
        match edit {
            ConfigChange::Project { value, .. } | ConfigChange::Service { value, .. } => {
                value.as_array().map_or_else(
                    || scalar_label(value),
                    |values| {
                        values
                            .iter()
                            .map(scalar_label)
                            .collect::<Vec<_>>()
                            .join(", ")
                    },
                )
            }
            ConfigChange::Route { sites, port, .. } => {
                if matches!(self, Self::Route { port: true, .. }) {
                    port.clone()
                } else {
                    sites.clone()
                }
            }
            ConfigChange::Env { value, .. } => value.clone().unwrap_or_default(),
            ConfigChange::Source { .. } => original.to_owned(),
        }
    }
}

impl HackApp {
    fn field_input(
        &mut self,
        field: Field,
        original: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        let id = field.id();
        if let Some((input, _)) = self.config.inputs.get(&id) {
            return input.clone();
        }
        let value = field.value(self, original.as_deref().unwrap_or_default());
        let state = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(value, window, cx);
            input
        });
        let subscription = cx.subscribe(&state, move |app, state, event, cx| {
            if matches!(event, InputEvent::Change)
                || (original.is_none() && matches!(event, InputEvent::PressEnter { .. }))
            {
                field.stage(
                    app,
                    state.read(cx).value().to_string(),
                    original.as_deref(),
                    cx,
                );
            }
        });
        self.config.inputs.insert(id, (state.clone(), subscription));
        state
    }

    fn field_control(
        &mut self,
        field: Field,
        original: Option<String>,
        enabled: bool,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let id = field.id();
        let issue = self
            .config
            .issues()
            .iter()
            .find(|issue| issue_field(issue).as_deref() == Some(id.as_str()))
            .cloned();
        let input = self.field_input(field, original, window, cx);
        if self.config.pending_focus.as_deref() == Some(id.as_str()) {
            self.config.pending_focus = None;
            input.update(cx, |input, cx| input.focus(window, cx));
        }
        div()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(space::S1)
            .child(
                div()
                    .rounded(px(5.))
                    .when(issue.is_some(), |d| {
                        d.border_1().border_color(ui.p.states.failed.fg)
                    })
                    .child(
                        Input::new(&input)
                            .disabled(!enabled)
                            .font_family(ui.mono.clone()),
                    ),
            )
            .children(issue.map(|issue| warning(issue.message, ui)))
    }

    pub(super) fn config_form(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let groups = [
            (EditSection::Project, "Project", Glyph::Container),
            (EditSection::Routes, "Routes", Glyph::Globe),
            (EditSection::Services, "Services", Glyph::Logs),
            (EditSection::Env, "Env", Glyph::Key),
            (EditSection::Worktrees, "Worktrees", Glyph::Branch),
        ];
        let sidebar =
            div()
                .w(relative(0.20))
                .min_w(px(125.))
                .flex_shrink_0()
                .flex()
                .flex_col()
                .gap(space::S1)
                .children(
                    groups
                        .into_iter()
                        .enumerate()
                        .map(|(index, (group, label, glyph))| {
                            let selected = self.config.edit_section == group;
                            let issue = self
                                .config
                                .issues()
                                .iter()
                                .any(|issue| issue_section(issue) == group);
                            div()
                                .id(("config-field-group", index))
                                .h(px(31.))
                                .px(space::S3)
                                .rounded(px(5.))
                                .cursor_pointer()
                                .flex()
                                .items_center()
                                .gap(space::S3)
                                .when(selected, |d| d.bg(ui.p.surface_2))
                                .child(icon(glyph, px(15.), ui.p.text_secondary))
                                .child(if selected {
                                    strong(label, ui)
                                } else {
                                    muted(label, ui)
                                })
                                .child(div().flex_1())
                                .children(issue.then(|| {
                                    icon(Glyph::CircleAlert, px(13.), ui.p.states.failed.fg)
                                }))
                                .on_click(cx.listener(move |app, _, _, cx| {
                                    app.config.edit_section = group;
                                    cx.notify();
                                }))
                        }),
                );
        let body = match self.config.edit_section {
            EditSection::Project => self.config_project_form(report, ui, window, cx),
            EditSection::Routes => self.config_route_form(report, ui, window, cx),
            EditSection::Services => self.config_services_form(report, ui, window, cx),
            EditSection::Env => {
                let enabled = self.field_enabled(report, "1");
                let path = "env.defaultOverlay";
                let original = report
                    .default_overlay
                    .clone()
                    .unwrap_or_else(|| legacy_default_overlay(&report.project));
                let field = self.field_control(
                    Field::Project(path.into()),
                    Some(original),
                    enabled,
                    ui,
                    window,
                    cx,
                );
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S3)
                    .child(group_title("Environment selection", report, "1", ui))
                    .child(field_row(
                        "Default overlay",
                        "Used when no overlay is selected",
                        field,
                        ui,
                    ))
                    .child(
                        action_button("config-to-env", Glyph::Key, "Open Env layers", true, ui)
                            .on_click(cx.listener(|app, _, _, cx| {
                                app.config.view = View::Env;
                                cx.notify();
                            })),
                    )
            }
            EditSection::Worktrees => {
                let enabled = self.field_enabled(report, "1");
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S3)
                    .child(group_title("Worktree defaults", report, "1", ui))
                    .child(field_row(
                        "Branch instances",
                        "Use the worktree’s branch by default",
                        self.config_toggle(
                            report,
                            "worktree.auto_branch",
                            "Auto branch",
                            true,
                            enabled,
                            ui,
                            cx,
                        ),
                        ui,
                    ))
                    .child(field_row(
                        "Local environment",
                        "Read local values from the main checkout",
                        self.config_toggle(
                            report,
                            "worktree.inherit_local",
                            "Inherit local env",
                            true,
                            enabled,
                            ui,
                            cx,
                        ),
                        ui,
                    ))
            }
        };
        div()
            .flex()
            .min_h_0()
            .flex_1()
            .gap(space::S4)
            .child(sidebar)
            .child(
                div()
                    .id("config-edit-scroll")
                    .min_w_0()
                    .flex_1()
                    .overflow_y_scroll()
                    .child(body),
            )
            .into_any_element()
    }

    fn field_enabled(&self, report: &ConfigReport, layer: &str) -> bool {
        report.layer(layer).is_some_and(|layer| layer.writable)
            && !self.config.conflict
            && !self.config.saving()
            && !self.config.loading
            && !self
                .config
                .draft
                .changes
                .contains_key(&format!("source/{layer}"))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "native input rendering needs the window and app context"
    )]
    fn project_text(
        &mut self,
        report: &ConfigReport,
        name: &str,
        fallback: &str,
        enabled: bool,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let initial = setting(&report.project, name)
            .as_str()
            .unwrap_or(fallback)
            .to_owned();
        self.field_control(
            Field::Project(name.into()),
            Some(initial),
            enabled,
            ui,
            window,
            cx,
        )
    }

    fn config_project_form(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let enabled = self.field_enabled(report, "1");
        div()
            .flex()
            .flex_col()
            .gap(space::S2)
            .child(group_title("Project settings", report, "1", ui))
            .child(field_row(
                "Name",
                "",
                self.project_text(report, "name", "", enabled, ui, window, cx),
                ui,
            ))
            .child(field_row(
                "Open preference",
                "auto, dev or alias",
                self.project_text(report, "open.prefer", "auto", enabled, ui, window, cx),
                ui,
            ))
            .child(group_title("Logs", report, "1", ui).mt(space::S4))
            .child(field_row(
                "Follow backend",
                "compose or loki",
                self.project_text(
                    report,
                    "logs.follow_backend",
                    "compose",
                    enabled,
                    ui,
                    window,
                    cx,
                ),
                ui,
            ))
            .child(field_row(
                "Snapshot backend",
                "compose or loki",
                self.project_text(
                    report,
                    "logs.snapshot_backend",
                    "loki",
                    enabled,
                    ui,
                    window,
                    cx,
                ),
                ui,
            ))
            .child(field_row(
                "Retention period",
                "",
                self.project_text(report, "logs.retention_period", "", enabled, ui, window, cx),
                ui,
            ))
            .child(field_row(
                "Clear logs on Down",
                "",
                self.config_toggle(
                    report,
                    "logs.clear_on_down",
                    "Clear logs",
                    false,
                    enabled,
                    ui,
                    cx,
                ),
                ui,
            ))
    }

    fn config_route_form(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let project_enabled = self.field_enabled(report, "1");
        let routes_enabled = self.field_enabled(report, "2");
        let dev_host = self.project_text(report, "dev_host", "", project_enabled, ui, window, cx);
        let dns = self.config_toggle(report, "internal.dns", "DNS", true, project_enabled, ui, cx);
        let tls = self.config_toggle(report, "internal.tls", "TLS", true, project_enabled, ui, cx);
        let alias = self.config_toggle(
            report,
            "oauth.enabled",
            "Enabled",
            false,
            project_enabled,
            ui,
            cx,
        );
        div()
            .flex()
            .flex_col()
            .gap(space::S2)
            .child(group_title("Host and DNS", report, "1", ui))
            .child(field_row(
                "Dev host",
                "Base name for project routes",
                dev_host,
                ui,
            ))
            .child(field_row(
                "Internal DNS and TLS",
                "Containers reach *.hack too",
                div().flex().gap(space::S5).child(dns).child(tls),
                ui,
            ))
            .child(field_row("OAuth alias", "Adds a .hack.gy name", alias, ui))
            .children(
                (setting(&report.project, "oauth.enabled").as_bool() == Some(true)
                    || matches!(
                        self.config.draft.changes.get("project/oauth.enabled"),
                        Some(ConfigChange::Project {
                            value: Value::Bool(true),
                            ..
                        })
                    ))
                .then(|| {
                    field_row(
                        "OAuth suffix",
                        "",
                        self.project_text(
                            report,
                            "oauth.tld",
                            "hack.gy",
                            project_enabled,
                            ui,
                            window,
                            cx,
                        ),
                        ui,
                    )
                }),
            )
            .child(group_title("Routes", report, "2", ui).mt(space::S5))
            .children(
                report
                    .services
                    .iter()
                    .map(|service| self.route_form_row(service, routes_enabled, ui, window, cx)),
            )
            .child(muted("Branch copies get their prefix from layer 6.", ui))
    }

    fn route_form_row(
        &mut self,
        service: &ConfigService,
        enabled: bool,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut row = div()
            .flex()
            .items_start()
            .gap(space::S3)
            .py(space::S2)
            .hairline_b(ui.p.border)
            .child(strong(service.name.clone(), ui).w(px(72.)).mt(space::S2));
        if let Some(route) = &service.route_edit {
            let port = route.port.map_or_else(String::new, |port| port.to_string());
            let field = |is_port| Field::Route {
                service: service.name.clone(),
                port: is_port,
                sites: route.sites.clone(),
                upstream: port.clone(),
            };
            let hosts = self.field_control(
                field(false),
                Some(route.sites.clone()),
                enabled,
                ui,
                window,
                cx,
            );
            let input = self.field_control(field(true), Some(port), enabled, ui, window, cx);
            row = row.child(hosts.flex_1()).child(input.w(px(82.))).child(
                muted(
                    if route.sites.is_empty() {
                        "internal only"
                    } else if service.routes.first().is_some_and(|route| !route.tls) {
                        "http"
                    } else {
                        "https"
                    },
                    ui,
                )
                .w(px(78.))
                .mt(space::S2),
            );
        } else {
            row = row.child(
                action_button(
                    SharedString::from(format!("config-complex-route-{}", service.name)),
                    Glyph::Pencil,
                    "Edit in source",
                    true,
                    ui,
                )
                .on_click(cx.listener(|app, _, _, cx| app.go_to_source("2", cx))),
            );
        }
        row
    }

    fn config_services_form(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let enabled = self.field_enabled(report, "2");
        div()
            .flex()
            .flex_col()
            .gap(space::S3)
            .child(group_title("Services", report, "2", ui))
            .children(report.services.iter().map(|service| {
                let fields = [
                    (
                        "image",
                        "Image",
                        "",
                        Field::ServiceImage(service.name.clone()),
                        service.image.clone().unwrap_or_default(),
                    ),
                    (
                        "ports",
                        "Ports",
                        "Comma-separated Compose port mappings",
                        Field::ServiceList {
                            service: service.name.clone(),
                            field: "ports".into(),
                        },
                        service
                            .ports
                            .iter()
                            .map(scalar_label)
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                    (
                        "depends_on",
                        "Depends on",
                        "Service names separated by commas",
                        Field::ServiceList {
                            service: service.name.clone(),
                            field: "depends_on".into(),
                        },
                        service.depends_on.join(", "),
                    ),
                ];
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S2)
                    .child(strong(service.name.clone(), ui))
                    .children(fields.into_iter().map(|(id, title, hint, field, initial)| {
                        let control = if service.source_fields.iter().any(|field| field == id) {
                            div().child(
                                action_button(
                                    SharedString::from(format!(
                                        "config-complex-{}-{id}",
                                        service.name
                                    )),
                                    Glyph::Pencil,
                                    "Edit in source",
                                    true,
                                    ui,
                                )
                                .on_click(cx.listener(|app, _, _, cx| app.go_to_source("2", cx))),
                            )
                        } else {
                            self.field_control(field, Some(initial), enabled, ui, window, cx)
                        };
                        field_row(title, hint, control, ui)
                    }))
            }))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "native input rendering needs the window and app context"
    )]
    fn config_toggle(
        &self,
        report: &ConfigReport,
        path: &'static str,
        label: &'static str,
        fallback: bool,
        enabled: bool,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> Div {
        let id = format!("project/{path}");
        let original = project_toggle_value(&report.project, path, fallback);
        let on = self
            .config
            .draft
            .changes
            .get(&id)
            .and_then(|edit| match edit {
                ConfigChange::Project { value, .. } => value.as_bool(),
                _ => None,
            })
            .unwrap_or(original);
        div().child(
            div()
                .id(SharedString::from(format!("config-toggle-{path}")))
                .flex()
                .items_center()
                .gap(space::S2)
                .when(enabled, |d| d.cursor_pointer())
                .child(
                    div()
                        .h(px(16.))
                        .w(px(28.))
                        .p(px(2.))
                        .rounded_full()
                        .flex()
                        .when(on, |d| d.bg(ui.p.text_primary).justify_end())
                        .when(!on, |d| d.bg(ui.p.surface_2))
                        .child(div().size(px(12.)).rounded_full().bg(if on {
                            ui.p.surface
                        } else {
                            ui.p.text_muted
                        })),
                )
                .child(muted(label, ui))
                .on_click(cx.listener(move |app, _, _, cx| {
                    if enabled {
                        let value = !on;
                        let edit = (value != original).then(|| ConfigChange::Project {
                            layer: "1".into(),
                            path: path.into(),
                            value: Value::Bool(value),
                        });
                        app.stage_config(id.clone(), edit, cx);
                    }
                })),
        )
    }

    pub(super) fn scope_picker(&self, report: &ConfigReport, cx: &Context<Self>) -> AnyElement {
        let choices = ["global".to_owned(), "host".to_owned()]
            .into_iter()
            .chain(report.services.iter().map(|service| service.name.clone()))
            .map(|name| (name.clone(), name))
            .collect();
        picker(
            "config-scope",
            format!("Scope:   {}", self.config.scope),
            choices,
            cx,
            |app, scope, cx| {
                app.config.scope = scope;
                app.config.active_cell = None;
                cx.notify();
            },
        )
    }

    pub(super) fn config_env_grid(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let layers: Vec<_> = report
            .layers
            .iter()
            .filter(|layer| layer.kind == "env" && layer.active)
            .collect();
        let rows = report.env_for(&self.config.scope);
        let header = div()
            .flex()
            .gap(space::S3)
            .py(space::S3)
            .hairline_b(ui.p.border)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(strong("Key", ui))
                    .child(muted(format!("{} scope", self.config.scope), ui)),
            )
            .children(layers.iter().map(|layer| {
                let name = layer.overlay.clone().map_or_else(
                    || match layer.id.as_str() {
                        "3" => "default".to_owned(),
                        "4" => "main local".to_owned(),
                        _ => "this checkout".to_owned(),
                    },
                    |overlay| {
                        if layer.ownership == "local" {
                            format!("{overlay} local")
                        } else {
                            overlay
                        }
                    },
                );
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .gap(space::S1)
                            .items_center()
                            .child(chip(layer.chip().to_owned(), false, ui))
                            .child(strong(name, ui).truncate()),
                    )
                    .child(
                        muted(
                            if layer.inherited == Some(true) {
                                "inherited"
                            } else if layer.ownership == "shared" {
                                "shared, committed"
                            } else {
                                "local, not committed"
                            },
                            ui,
                        )
                        .truncate(),
                    )
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(strong("Resolved", ui))
                    .child(muted(format!("what {} gets", self.config.scope), ui)),
            );
        div()
            .id("config-env-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(header)
            .when(rows.is_empty(), |d| {
                d.child(muted("No keys in this scope.", ui).mt(space::S4))
            })
            .children(
                rows.iter()
                    .map(|row| self.env_grid_row(row, &layers, report, ui, window, cx)),
            )
            .into_any_element()
    }

    fn env_grid_row(
        &mut self,
        row: &EnvRow,
        layers: &[&ConfigLayer],
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut entries = row.values.clone();
        for change in self.config.draft.changes.values() {
            let ConfigChange::Env {
                layer,
                scope,
                key,
                value,
            } = change
            else {
                continue;
            };
            if *key != row.key || (scope != "global" && *scope != self.config.scope) {
                continue;
            }
            entries.retain(|entry| entry.layer != *layer || entry.scope != *scope);
            if value.is_some() || (layer.starts_with('5') && report.layer("4").is_some()) {
                entries.push(EnvCell {
                    layer: layer.clone(),
                    scope: scope.clone(),
                    unset: value.is_none(),
                    secret: false,
                    value: value.clone().map(Value::String),
                });
            }
        }
        entries.sort_by_key(|entry| {
            (
                layers
                    .iter()
                    .position(|layer| layer.id == entry.layer)
                    .unwrap_or(usize::MAX),
                entry.scope != "global",
            )
        });
        let winner = entries.last().filter(|entry| !entry.unset);
        div()
            .flex()
            .items_center()
            .gap(space::S3)
            .min_h(px(36.))
            .py(space::S1)
            .hairline_b(ui.p.border)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(mono(row.key.clone(), ui).truncate())
                    .child(muted(row.scope.clone(), ui)),
            )
            .children(layers.iter().map(|layer| {
                let cell = entries.iter().rev().find(|entry| entry.layer == layer.id);
                let original = row
                    .values
                    .iter()
                    .rev()
                    .find(|entry| entry.layer == layer.id);
                let scope = cell
                    .or(original)
                    .map_or_else(|| self.config.scope.clone(), |cell| cell.scope.clone());
                let field = Field::Env {
                    layer: layer.id.clone(),
                    scope,
                    key: row.key.clone(),
                };
                let id = field.id();
                let editable = self.field_enabled(report, &layer.id)
                    && !row.values.iter().any(|entry| entry.secret)
                    && !cell.is_some_and(|entry| entry.secret);
                let title = cell.map_or_else(|| "—".into(), EnvCell::label);
                let winner = winner.is_some_and(|winner| winner.layer == layer.id);
                let mut entry = div().flex_1().min_w_0();
                if self.config.active_cell.as_deref() == Some(&id) && editable {
                    let initial = original
                        .filter(|cell| !cell.unset)
                        .and_then(|cell| cell.value.as_ref())
                        .map(scalar_label);
                    entry =
                        entry.child(self.field_control(field, initial, editable, ui, window, cx));
                } else {
                    entry = entry.child(
                        div()
                            .id(SharedString::from(format!("config-env-cell-{}", id)))
                            .when(editable, |d| d.cursor_pointer())
                            .child(
                                mono(title, ui)
                                    .truncate()
                                    .when(winner, |d| d.font_weight(gpui_kit::FontWeight::SEMIBOLD))
                                    .when(!winner && cell.is_some(), |d| {
                                        d.line_through().text_color(ui.p.text_muted)
                                    }),
                            )
                            .on_click(cx.listener(move |app, _, _, cx| {
                                if editable {
                                    app.config.active_cell = Some(id.clone());
                                    app.config.pending_focus = Some(id.clone());
                                    cx.notify();
                                }
                            })),
                    );
                }
                entry
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(space::S1)
                    .children(winner.map(|winner| {
                        mono(winner.label(), ui)
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .truncate()
                    }))
                    .children(
                        winner.map(|winner| chip(layer_chip(report, &winner.layer), true, ui)),
                    ),
            )
    }

    pub(super) fn config_source(
        &mut self,
        report: &ConfigReport,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let list = div()
            .w(relative(0.24))
            .min_w(px(130.))
            .flex()
            .flex_col()
            .gap(space::S1)
            .child(caption("Files", ui).pb(space::S2))
            .children(report.layers.iter().map(|layer| {
                let id = layer.id.clone();
                let selected = id == self.config.file;
                let problem = self
                    .config
                    .issues()
                    .iter()
                    .any(|issue| issue.layer.as_ref() == Some(&id));
                div()
                    .id(SharedString::from(format!("config-source-file-{}", id)))
                    .p(space::S2)
                    .rounded(px(5.))
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .when(selected, |d| d.bg(ui.p.surface_2))
                    .child(chip(layer.chip().to_owned(), selected, ui))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .child(mono(layer_title(layer), ui).truncate())
                            .child(muted(layer_description(layer), ui).truncate()),
                    )
                    .children(
                        problem.then(|| icon(Glyph::CircleAlert, px(13.), ui.p.states.failed.fg)),
                    )
                    .on_click(cx.listener(move |app, _, _, cx| {
                        app.config.file.clone_from(&id);
                        app.config.editor = None;
                        cx.notify();
                    }))
            }));
        let file = report
            .layer(&self.config.file)
            .or_else(|| report.layers.first());
        let pane = file.map_or_else(
            || card(ui).child(muted("No files to show.", ui)),
            |layer| self.source_file(layer, ui, window, cx),
        );
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .gap(space::S4)
            .child(
                div()
                    .id("config-source-nav")
                    .overflow_y_scroll()
                    .child(list.w_full())
                    .w(relative(0.24))
                    .min_w(px(130.)),
            )
            .child(pane.flex_1().min_w_0())
            .into_any_element()
    }

    fn source_file(
        &mut self,
        layer: &ConfigLayer,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let changed_in_form =
            self.config.draft.changes.values().any(|edit| {
                edit.layer() == layer.id && !matches!(edit, ConfigChange::Source { .. })
            });
        let allow_edit = layer.source_writable
            && !changed_in_form
            && !self.config.conflict
            && !self.config.saving()
            && !self.config.loading;
        let original = layer.source.as_deref().unwrap_or_default();
        let edit_id = format!("source/{}", layer.id);
        let issue = self
            .config
            .issues()
            .iter()
            .find(|issue| issue.layer.as_deref() == Some(layer.id.as_str()))
            .cloned();
        let draft = self
            .config
            .draft
            .changes
            .get(&edit_id)
            .and_then(|edit| match edit {
                ConfigChange::Source { text, .. } => Some(text.as_str()),
                _ => None,
            });
        let preview = self
            .config
            .validation
            .as_ref()
            .and_then(|check| check.previews.get(&layer.id))
            .and_then(|preview| preview.as_deref());
        let buffer = draft.or(preview).unwrap_or(original).to_owned();
        let path = layer.file.clone();
        let editor = if layer.source.is_some() {
            Some(self.config_source_editor(
                layer,
                &edit_id,
                original,
                buffer,
                issue.as_ref(),
                window,
                cx,
            ))
        } else {
            None
        };
        card(ui)
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .p(space::S2)
                    .hairline_b(ui.p.border)
                    .child(
                        mono(layer.name().to_owned(), ui)
                            .flex_1()
                            .min_w_0()
                            .truncate(),
                    )
                    .when(!allow_edit, |row| row.child(muted("read-only", ui)))
                    .child(
                        action_button("config-copy-path", Glyph::Copy, "Copy path", true, ui)
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(path.clone()))
                            }),
                    )
                    .children(
                        layer
                            .exists
                            .then(|| self.editor_button(layer.file.clone(), ui, cx)),
                    ),
            )
            .children(issue.as_ref().map(|issue| {
                let message = issue.line.map_or_else(
                    || issue.message.clone(),
                    |line| format!("Line {line} · {}", issue.message),
                );
                warning(message, ui)
                    .px(space::S3)
                    .py(space::S2)
                    .bg(ui.p.surface_1)
            }))
            .child(if let Some(editor) = editor {
                div().bg(ui.p.surface_1).flex_1().min_h_0().child(
                    Editor::new(&editor)
                        .readonly(!allow_edit)
                        .appearance(false)
                        .bordered(false)
                        .h(relative(1.))
                        .aria_label(layer.name().to_owned()),
                )
            } else {
                div().p(space::S3).child(muted(
                    if layer.hidden {
                        "Source preview unavailable. Open the file in your editor."
                    } else {
                        "This file is not on disk yet."
                    },
                    ui,
                ))
            })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "native input rendering needs the window and app context"
    )]
    fn config_source_editor(
        &mut self,
        layer: &ConfigLayer,
        edit_id: &str,
        original: &str,
        buffer: String,
        issue: Option<&ConfigIssue>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<EditorState> {
        // Recreate a read-only preview when a structured change updates it.
        let preview_key = if self.config.draft.changes.contains_key(edit_id)
            || self.config.validation.is_none()
        {
            layer.id.clone()
        } else {
            format!("{}-{}", layer.id, self.config.revision)
        };
        let editor = if let Some((identity, editor, _)) = &self.config.editor
            && *identity == preview_key
        {
            editor.clone()
        } else {
            let editor = cx.new(|cx| {
                let mut editor =
                    EditorState::new(window, cx).language(if layer.file.ends_with(".json") {
                        "json"
                    } else {
                        "yaml"
                    });
                editor.set_value(buffer, window, cx);
                editor
            });
            let layer_id = layer.id.clone();
            let edit_id = edit_id.to_owned();
            let original = original.to_owned();
            let subscription = cx.subscribe(&editor, move |app, editor, event, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = editor.read(cx).value().to_string();
                    let edit = (text != original).then(|| ConfigChange::Source {
                        layer: layer_id.clone(),
                        text,
                    });
                    app.stage_config(edit_id.clone(), edit, cx);
                }
            });
            self.config.editor = Some((preview_key, editor.clone(), subscription));
            editor
        };
        let line_issue = issue.and_then(|issue| {
            let line = u32::try_from(issue.line?.saturating_sub(1)).ok()?;
            let diag = gpui_kit::base::input::Diagnostic::new(
                Position::new(line, 0)..Position::new(line.saturating_add(1), 0),
                issue.message.clone(),
            )
            .with_severity(gpui_kit::base::input::DiagnosticSeverity::Error);
            Some(diag)
        });
        editor.update(cx, |editor, _| {
            if let Some(diagnostics) = editor.diagnostics_mut() {
                diagnostics.clear();
                diagnostics.extend(line_issue);
            }
        });
        if self.config.pending_focus.as_deref() == Some(edit_id) {
            self.config.pending_focus = None;
            let line = issue
                .and_then(|issue| issue.line)
                .unwrap_or(1)
                .saturating_sub(1);
            editor.update(cx, |state, cx| {
                state.set_cursor_position(
                    Position::new(u32::try_from(line).unwrap_or(u32::MAX), 0),
                    window,
                    cx,
                )
            });
        }
        editor
    }

    pub(super) fn editor_button(
        &self,
        file: String,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<Div> {
        action_button(
            "config-open-editor",
            Glyph::Pencil,
            "Open in editor",
            true,
            ui,
        )
        .on_click(cx.listener(move |app, _, _, cx| {
            if !app.live {
                return;
            }
            let path = PathBuf::from(&file);
            cx.background_executor()
                .spawn(async move {
                    if !path.is_absolute() {
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    let _ = std::process::Command::new("/usr/bin/open")
                        .arg("-t")
                        .arg(path)
                        .status();
                    #[cfg(not(target_os = "macos"))]
                    let _ = std::process::Command::new("xdg-open").arg(path).status();
                })
                .detach();
        }))
    }

    pub(super) fn jump_config_issue(&mut self, issue: &ConfigIssue, cx: &mut Context<Self>) {
        if let Some(field) = issue_field(issue)
            .filter(|_| self.config.view != View::Source && !issue.path.is_empty())
        {
            let section = issue_section(issue);
            if section == EditSection::Env {
                self.config.view = View::Env;
                self.config.scope = issue
                    .path
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "global".into());
                self.config.active_cell = Some(field.clone());
            } else {
                self.config.view = View::Edit;
                self.config.edit_section = section;
            }
            self.config.pending_focus = Some(field);
        } else if let Some(layer) = &issue.layer {
            self.config.view = View::Source;
            self.config.file.clone_from(layer);
            self.config.pending_focus = Some(format!("source/{layer}"));
        }
        cx.notify();
    }
}

fn issue_field(issue: &ConfigIssue) -> Option<String> {
    let layer = issue.layer.as_deref()?;
    match (layer, issue.path.as_slice()) {
        ("1", path) if !path.is_empty() => Some(format!("project/{}", path.join("."))),
        ("2", [_, service, field, rest @ ..]) if field == "route" => Some(format!(
            "route/{service}/{}",
            if rest.first().is_some_and(|part| part == "port") {
                "port"
            } else {
                "sites"
            }
        )),
        ("2", [_, service, field]) => Some(format!("service/{service}/{field}")),
        (_, [prefix, scope, key]) if prefix == "values" => {
            Some(format!("env/{layer}/{scope}/{key}"))
        }
        _ => None,
    }
}

fn issue_section(issue: &ConfigIssue) -> EditSection {
    match issue.path.first().map(String::as_str) {
        Some("services") if issue.path.get(2).is_some_and(|part| part == "route") => {
            EditSection::Routes
        }
        Some("services") => EditSection::Services,
        Some("dev_host" | "internal" | "oauth") => EditSection::Routes,
        Some("env" | "values") => EditSection::Env,
        Some("worktree") => EditSection::Worktrees,
        _ => EditSection::Project,
    }
}

fn group_title(title: &str, report: &ConfigReport, id: &str, ui: &Ui) -> Div {
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .py(space::S2)
        .child(caption(title.to_owned(), ui))
        .child(div().flex_1())
        .children(
            report
                .layer(id)
                .map(|layer| chip(layer.chip().to_owned(), false, ui)),
        )
        .children(
            report
                .layer(id)
                .map(|layer| mono(layer.name().to_owned(), ui).text_color(ui.p.text_muted)),
        )
}

fn project_toggle_value(project: &Value, path: &str, fallback: bool) -> bool {
    let authored = setting(project, path);
    // The CLI uses nullish precedence before checking the selected value's type.
    let effective = match (path, authored.is_null()) {
        ("worktree.auto_branch", true) => setting(project, "worktree.autoBranch"),
        ("worktree.inherit_local", true) => setting(project, "worktree.inheritLocal"),
        _ => authored,
    };
    effective.as_bool().unwrap_or(fallback)
}

#[cfg(test)]
#[test]
fn worktree_toggles_follow_runtime_alias_precedence() {
    for (path, snake_case, camel_case) in [
        ("worktree.auto_branch", "auto_branch", "autoBranch"),
        ("worktree.inherit_local", "inherit_local", "inheritLocal"),
    ] {
        let mut project = serde_json::json!({ "worktree": { (camel_case): false } });
        assert!(!project_toggle_value(&project, path, true));

        project["worktree"][snake_case] = Value::Null;
        assert!(!project_toggle_value(&project, path, true));

        project["worktree"][snake_case] = Value::Bool(true);
        assert!(project_toggle_value(&project, path, true));

        project["worktree"][snake_case] = Value::String("invalid".into());
        assert!(project_toggle_value(&project, path, true));
    }
}

// Older v1 producers expose only authored fields. Follow the CLI's legacy
// name normalization and precedence without using the active preview overlay.
fn legacy_default_overlay(project: &Value) -> String {
    let name = |paths: [&str; 2]| {
        let raw = paths
            .into_iter()
            .find_map(|path| setting(project, path).as_str())?
            .trim();
        if raw.starts_with("[redacted") {
            return None;
        }
        let name: String = raw
            .to_lowercase()
            .replace(['_', ' ', '/'], "-")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let name = name
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        (!name.is_empty()).then_some(name)
    };
    name(["env.defaultOverlay", "env.default_overlay"])
        .or_else(|| name(["defaultEnvConfig", "default_env_config"]))
        .filter(|name| name.len() <= 128 && !matches!(name.as_str(), "base" | "default" | "none"))
        .unwrap_or_else(|| "default".into())
}

fn field_row(label: &str, detail: &str, element: impl IntoElement, ui: &Ui) -> Div {
    div()
        .flex()
        .items_start()
        .gap(space::S3)
        .py(space::S2)
        .hairline_b(ui.p.border)
        .child(
            div()
                .w(relative(0.25))
                .min_w(px(110.))
                .flex_shrink_0()
                .pt(space::S1)
                .child(strong(label.to_owned(), ui))
                .children((!detail.is_empty()).then(|| muted(detail.to_owned(), ui))),
        )
        .child(div().flex_1().min_w_0().child(element))
}

#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use std::sync::Arc;

    use gpui_kit::{AnyWindowHandle, HeadlessAppContext, NoopTextSystem, WindowOptions};
    use hack_desktop_core::{config::ConfigState, fixtures::Fixture};

    use super::*;

    #[test]
    fn the_snapshot_backend_defaults_to_loki_and_can_be_changed_to_compose() {
        assert_project_field_can_stage(
            ConfigReport::default(),
            EditSection::Project,
            "logs.snapshot_backend",
            "loki",
            "compose",
        );
    }

    #[test]
    fn the_default_overlay_field_uses_the_resolved_project_default() {
        assert_project_field_can_stage(
            ConfigReport {
                project: serde_json::json!({ "defaultEnvConfig": "qa" }),
                default_overlay: Some("qa".into()),
                overlay: Some("staging".into()),
                ..Default::default()
            },
            EditSection::Env,
            "env.defaultOverlay",
            "qa",
            "default",
        );
    }

    #[test]
    fn the_default_overlay_field_resolves_aliases_in_older_reports() {
        assert_project_field_can_stage(
            ConfigReport {
                project: serde_json::json!({
                    "env": { "default_overlay": " QA " },
                    "defaultEnvConfig": "development",
                }),
                overlay: Some("staging".into()),
                ..Default::default()
            },
            EditSection::Env,
            "env.defaultOverlay",
            "qa",
            "default",
        );
        assert_eq!(
            legacy_default_overlay(&serde_json::json!({"defaultEnvConfig": "qa"})),
            "qa"
        );
        assert_eq!(
            legacy_default_overlay(&serde_json::json!({"default_env_config": " qa_team "})),
            "qa-team"
        );
        assert_eq!(
            legacy_default_overlay(&serde_json::json!({
                "env": { "defaultOverlay": "none", "default_overlay": "qa" },
                "defaultEnvConfig": "qa",
            })),
            "default"
        );
    }

    #[test]
    fn env_cells_keep_an_explicit_empty_override() {
        let (mut cx, window, app) = headless_config_app();
        let report = ConfigReport {
            state: ConfigState::Ready,
            writable: true,
            layers: vec![ConfigLayer {
                id: "5".into(),
                file: ".hack/hack.env.local.yaml".into(),
                kind: "env".into(),
                ownership: "local".into(),
                active: true,
                writable: true,
                revision: "fixture".into(),
                exists: true,
                source: None,
                hidden: false,
                source_writable: false,
                inherited: None,
                overlay: None,
            }],
            ..Default::default()
        };
        for (key, cell) in [
            ("ABSENT", None),
            ("UNSET", Some((true, None))),
            ("EMPTY", Some((false, Some(Value::String(String::new()))))),
        ] {
            let id = format!("env/5/global/{key}");
            let mut values = vec![EnvCell {
                layer: "3".into(),
                scope: "global".into(),
                unset: false,
                secret: false,
                value: Some(Value::String("inherited".into())),
            }];
            if let Some((unset, value)) = cell {
                values.push(EnvCell {
                    layer: "5".into(),
                    scope: "global".into(),
                    unset,
                    secret: false,
                    value,
                });
            }
            let row = EnvRow {
                key: key.into(),
                scope: "global".into(),
                values,
                winning: None,
            };
            cx.update_window(window, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.config.scope = "global".into();
                    app.config.active_cell = Some(id.clone());
                    app.env_grid_row(&row, &[&report.layers[0]], &report, &app.ui(cx), window, cx);
                    assert!(app.config.inputs[&id].0.read(cx).value().is_empty());
                    assert!(!app.config.draft.changes.contains_key(&id));
                });
            })
            .expect("render the Env cell");
            for value in ["temporary", ""] {
                cx.update_window(window, |_, window, cx| {
                    let input = app.read(cx).config.inputs[&id].0.clone();
                    input.update(cx, |input, cx| input.replace_all(value, window, cx));
                })
                .expect("edit the Env cell");
                cx.update(|cx| {
                    let changes = &app.read(cx).config.draft.changes;
                    if key == "EMPTY" && value.is_empty() {
                        assert!(!changes.contains_key(&id));
                    } else {
                        assert!(matches!(
                            changes.get(&id),
                            Some(ConfigChange::Env { layer, scope, value: Some(staged), .. })
                                if layer == "5" && scope == "global" && staged == value
                        ));
                    }
                });
            }
            if key == "ABSENT" {
                cx.update(|cx| {
                    let input = app.read(cx).config.inputs[&id].0.clone();
                    app.update(cx, |app, cx| app.stage_config(id.clone(), None, cx));
                    input.update(cx, |_, cx| {
                        cx.emit(InputEvent::PressEnter {
                            secondary: false,
                            shift: false,
                        });
                    });
                });
                cx.update(|cx| {
                    assert!(matches!(
                        app.read(cx).config.draft.changes.get(&id),
                        Some(ConfigChange::Env { value: Some(value), .. }) if value.is_empty()
                    ));
                });
            }
        }
    }

    fn headless_config_app() -> (HeadlessAppContext, AnyWindowHandle, Entity<HackApp>) {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(hack_desktop_ui::tokens::init);
        let (window, app) = cx
            .update(|cx| {
                gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
                    cx.new(|cx| {
                        HackApp::new(crate::source_for(Some(Fixture::Running)), false, window, cx)
                    })
                })
            })
            .expect("open a headless window");
        (cx, window, app)
    }

    fn assert_project_field_can_stage(
        mut report: ConfigReport,
        section: EditSection,
        path: &str,
        initial: &str,
        edited: &str,
    ) {
        let (mut cx, window, app) = headless_config_app();
        report.state = ConfigState::Ready;
        report.writable = true;
        report.layers.push(ConfigLayer {
            id: "1".into(),
            file: ".hack/hack.config.json".into(),
            kind: "project".into(),
            ownership: "shared".into(),
            active: true,
            writable: true,
            revision: "fixture".into(),
            exists: true,
            source: None,
            hidden: false,
            source_writable: true,
            inherited: None,
            overlay: None,
        });
        let field_id = format!("project/{path}");
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| {
                app.config.edit_section = section;
                app.config_form(&report, &app.ui(cx), window, cx);
                let original = app.config.inputs[&field_id].0.read(cx).value();
                assert_eq!(original.as_ref(), initial);
                Field::Project(path.into()).stage(app, edited.into(), Some(&original), cx);
            });
        })
        .expect("edit the project field");
        cx.update(|cx| {
            assert!(matches!(
                app.read(cx).config.draft.changes.get(&field_id),
                Some(ConfigChange::Project { layer, path: staged_path, value })
                    if layer == "1" && staged_path == path && value == edited
            ));
        });
    }
}
