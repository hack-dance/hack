use gpui_kit::prelude::*;
use gpui_kit::{Context, IntoElement, div, px, relative};
use hack_desktop_core::config::{ConfigLayer, ConfigReport, ConfigService};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, dot},
    status::Status,
    tokens::{space, text},
};

use super::{View, card, chip, mono, muted, strong};
use crate::view::HackApp;

impl HackApp {
    pub(super) fn config_map(
        &self,
        report: &ConfigReport,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let selected = report
            .services
            .iter()
            .find(|service| service.name == self.config.service);
        let p = ui.p;
        let layers = div()
            .w(relative(0.22))
            .min_w(px(145.))
            .flex()
            .flex_col()
            .gap(space::S2)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .child(caption("Layers", ui))
                    .child(muted("later wins", ui)),
            )
            .children(
                report
                    .layers
                    .iter()
                    .filter(|layer| layer.kind != "internal")
                    .map(|layer| {
                        let id = layer.id.clone();
                        let selected = self.config.layer.as_ref() == Some(&id);
                        card(ui)
                            .id(gpui_kit::SharedString::from(format!("config-layer-{}", id)))
                            .p(space::S3)
                            .when(!layer.active || layer.ownership == "generated", |d| {
                                d.border_dashed()
                            })
                            .flex()
                            .items_start()
                            .gap(space::S3)
                            .cursor_pointer()
                            .when(selected, |d| d.bg(p.surface_2))
                            .child(chip(layer.chip().to_owned(), selected, ui))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(mono(layer_title(layer), ui).truncate())
                                    .child(muted(layer_description(layer), ui)),
                            )
                            .on_click(cx.listener(move |app, _, _, cx| {
                                app.config.layer = if app.config.layer.as_ref() == Some(&id) {
                                    None
                                } else {
                                    Some(id.clone())
                                };
                                cx.notify();
                            }))
                    }),
            );
        let graph = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(space::S3)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap(space::S2)
                    .child(caption("Routes → Services → Depends on", ui))
                    .child(
                        muted(report.branch.as_deref().unwrap_or("main").to_owned(), ui).truncate(),
                    ),
            )
            .children(
                report
                    .services
                    .iter()
                    .map(|service| self.config_graph_row(report, service, ui, cx)),
            )
            .when(report.services.is_empty(), |d| {
                d.child(muted("No services in this Compose file.", ui))
            })
            .child(div().flex_1())
            .child(muted("┄ route · □ service · [2] from layer 2", ui))
            .child(muted("Click a layer to see what it sets", ui));
        let resolved = selected.map_or_else(
            || card(ui).p(space::S4).child(muted("Choose a service", ui)),
            |service| self.config_resolved(report, service, ui),
        );
        div()
            .id("config-map-scroll")
            .min_h_0()
            .flex_1()
            .overflow_y_scroll()
            .child(
                div()
                    .min_h_full()
                    .flex()
                    .items_start()
                    .gap(space::S4)
                    .child(layers)
                    .child(graph)
                    .child(resolved.w(relative(0.28)).min_w(px(170.))),
            )
            .into_any_element()
    }

    fn config_service_status(&self, report: &ConfigReport, name: &str) -> Status {
        if let Some(detail) = self.model.detail()
            && detail.branch == report.branch
            && let Some(service) = detail.services.iter().find(|service| service.name == name)
        {
            return Status::of_service(service);
        }
        Status::Unknown
    }

    fn config_graph_row(
        &self,
        report: &ConfigReport,
        service: &ConfigService,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let layer = self.config.layer.as_deref();
        let p = ui.p;
        let scope = report.env_for(&service.name);
        let route_layers = service
            .routes
            .iter()
            .flat_map(|route| route.from.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let route_matches = layer.is_some_and(|id| route_layers.contains(&id));
        let service_matches = layer.is_some_and(|id| {
            id == "2"
                || scope
                    .iter()
                    .any(|row| row.values.iter().any(|cell| cell.layer == id))
        });
        let name = service.name.clone();
        let selected = service.name == self.config.service;
        let active = card(ui)
            .id(gpui_kit::SharedString::from(format!(
                "config-service-{}",
                name
            )))
            .w(px(108.))
            .flex_shrink_0()
            .px(space::S2)
            .py(space::S2)
            .cursor_pointer()
            .when(selected, |d| d.border_2().border_color(p.text_primary))
            .when(service_matches, |d| d.bg(p.surface_2))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .child(dot(self.config_service_status(report, &name), ui))
                    .child(strong(name.clone(), ui).truncate()),
            )
            .child(
                div()
                    .flex()
                    .gap(space::S2)
                    .child(chip("2", layer == Some("2"), ui))
                    .child(muted(
                        format!(
                            "{} env",
                            scope.iter().filter(|row| row.winning.is_some()).count()
                        ),
                        ui,
                    )),
            )
            .on_click(cx.listener(move |app, _, _, cx| {
                app.config.service.clone_from(&name);
                cx.notify();
            }));
        let routes = card(ui)
            .border_dashed()
            .flex_1()
            .min_w_0()
            .px(space::S2)
            .py(space::S2)
            .when(route_matches, |d| d.bg(p.surface_2))
            .when(service.routes.is_empty(), |d| {
                d.child(muted("Internal only", ui))
                    .child(div().flex().child(chip("2", layer == Some("2"), ui)))
            })
            .children(service.routes.iter().map(|route| {
                div()
                    .min_w_0()
                    .child(mono(route.host.clone(), ui).truncate())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S1)
                            .children(route.from.iter().map(|id| {
                                chip(layer_chip(report, id), layer == Some(id.as_str()), ui)
                            }))
                            .child(muted(if route.tls { "https" } else { "http" }, ui)),
                    )
            }));
        let dependencies = div()
            .w(px(78.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(space::S1)
            .children(service.depends_on.iter().map(|name| {
                let key = name.clone();
                card(ui)
                    .id(gpui_kit::SharedString::from(format!(
                        "config-dependency-{}/{}",
                        service.name, name
                    )))
                    .px(space::S2)
                    .py(space::S1)
                    .cursor_pointer()
                    .when(layer == Some("2"), |d| d.bg(p.surface_2))
                    .child(strong(name.clone(), ui).truncate())
                    .child(chip("2", layer == Some("2"), ui))
                    .on_click(cx.listener(move |app, _, _, cx| {
                        app.config.service.clone_from(&key);
                        cx.notify();
                    }))
            }));
        div()
            .flex()
            .items_center()
            .child(routes)
            .child(arrow(ui))
            .child(active)
            .child(if service.depends_on.is_empty() {
                div().w(px(16.))
            } else {
                arrow(ui)
            })
            .child(dependencies)
    }

    fn config_resolved(
        &self,
        report: &ConfigReport,
        service: &ConfigService,
        ui: &Ui,
    ) -> gpui_kit::Div {
        let accent = self.config.layer.as_deref();
        let scope = report.env_for(&service.name);
        let env_count = scope.iter().filter(|row| row.winning.is_some()).count();
        let ports = service
            .ports
            .iter()
            .map(hack_desktop_core::config::scalar_label)
            .collect::<Vec<_>>()
            .join(", ");
        let port = service
            .routes
            .first()
            .and_then(|route| route.port)
            .map_or(ports, |port| port.to_string());
        card(ui)
            .min_h(px(250.))
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .p(space::S3)
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(space::S2)
                    .child(dot(self.config_service_status(report, &service.name), ui))
                    .child(strong(service.name.clone(), ui))
                    .child(muted(
                        format!(
                            "resolved for {}",
                            report.branch.as_deref().unwrap_or("main")
                        ),
                        ui,
                    )),
            )
            .children(service.routes.iter().map(|route| {
                self.resolved_row("route", &route.host, &route.from, None, report, ui)
            }))
            .child(self.resolved_row(
                "port",
                if port.is_empty() { "—" } else { &port },
                &["2".into()],
                None,
                report,
                ui,
            ))
            .child(self.resolved_row(
                "image",
                service.image.as_deref().unwrap_or("—"),
                &["2".into()],
                None,
                report,
                ui,
            ))
            .child(caption(format!("Env · {env_count} keys"), ui).p(space::S3))
            .children(scope.iter().filter_map(|row| {
                let winner = row.values.last().filter(|cell| !cell.unset)?;
                let prior = row
                    .values
                    .iter()
                    .rev()
                    .skip(1)
                    .take_while(|cell| !cell.unset)
                    .find(|cell| cell.layer != winner.layer);
                Some(self.resolved_row(
                    &row.key,
                    &winner.label(),
                    std::slice::from_ref(&winner.layer),
                    prior.map(|cell| cell.layer.as_str()),
                    report,
                    ui,
                ))
            }))
            .when(accent == Some("1"), |d| {
                d.child(
                    div()
                        .p(space::S3)
                        .bg(ui.p.surface_2)
                        .child(caption("Project settings · 1", ui))
                        .children(report.project.as_object().into_iter().flatten().map(
                            |(key, value)| {
                                let value = value.as_object().map_or_else(
                                    || hack_desktop_core::config::scalar_label(value),
                                    |_| "·".into(),
                                );
                                mono(format!("{key} {value}"), ui).truncate()
                            },
                        )),
                )
            })
    }

    fn resolved_row(
        &self,
        label: &str,
        value: &str,
        layers: &[String],
        over: Option<&str>,
        report: &ConfigReport,
        ui: &Ui,
    ) -> gpui_kit::Div {
        let selected = self.config.layer.as_deref();
        div()
            .px(space::S3)
            .py(space::S2)
            .hairline_b(ui.p.border)
            .when(
                selected
                    .is_some_and(|id| layers.iter().any(|layer| layer == id) || over == Some(id)),
                |d| d.bg(ui.p.surface_2),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S1)
                    .child(muted(label.to_owned(), ui).flex_1().truncate())
                    .children(layers.iter().map(|id| {
                        chip(
                            layer_chip(report, id),
                            selected.is_none_or(|selected| selected == id),
                            ui,
                        )
                    }))
                    .children(over.map(|id| muted(format!("over {}", layer_chip(report, id)), ui))),
            )
            .child(mono(value.to_owned(), ui).truncate())
    }

    pub(super) fn go_to_source(&mut self, id: &str, cx: &mut Context<Self>) {
        self.config.view = View::Source;
        self.config.file = id.into();
        cx.notify();
    }
}

fn arrow(ui: &Ui) -> gpui_kit::Div {
    div()
        .w(px(16.))
        .flex_shrink_0()
        .flex()
        .justify_center()
        .text_color(ui.p.text_muted)
        .child("→")
}

pub(super) fn layer_title(layer: &ConfigLayer) -> String {
    if layer.kind == "branch" {
        "branch override".into()
    } else {
        layer.name().into()
    }
}

pub(super) fn layer_description(layer: &ConfigLayer) -> String {
    if !layer.active {
        return "overlay · not in use".into();
    }
    match layer.kind.as_str() {
        "project" => "project settings · shared".into(),
        "compose" => "services and routes · shared".into(),
        "branch" => "generated · branch prefix".into(),
        "internal" => "Hack-managed · read-only".into(),
        _ if layer.inherited == Some(true) => "env · from the main checkout".into(),
        _ if layer.ownership == "local" => "env · this checkout".into(),
        _ => "env · shared".into(),
    }
}

pub(super) fn layer_chip(report: &ConfigReport, id: &str) -> String {
    report.layer(id).map_or(id, ConfigLayer::chip).to_owned()
}

pub(super) fn caption(label: impl Into<gpui_kit::SharedString>, ui: &Ui) -> gpui_kit::Div {
    let label: gpui_kit::SharedString = label.into();
    div()
        .type_step(text::SMALL)
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .text_color(ui.p.text_muted)
        .child(label.to_uppercase())
}
