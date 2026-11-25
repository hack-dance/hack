use gpui_kit::{Context, Div, SharedString, div, prelude::*};
use hack_desktop_core::{
    resource_inventory::{InventoryReport, RemovalPlan, Resource},
    usage::bytes,
    viewmodel::InstanceKey,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, neutral_pill},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

#[derive(Default)]
pub(crate) struct InventoryPane {
    pub(crate) report: Option<InventoryReport>,
    selection: Option<String>,
    confirmation: Option<(u64, RemovalPlan)>,
    busy: bool,
    notice: Option<String>,
}

impl InventoryPane {
    fn take_confirmation(&mut self, epoch: u64) -> Option<RemovalPlan> {
        let (preview_epoch, plan) = self.confirmation.take()?;
        (!self.busy && preview_epoch == epoch && !plan.removed && !plan.token.is_empty())
            .then_some(plan)
    }
}

fn key(resource: &Resource) -> String {
    format!("{}:{}:{}", resource.backend, resource.kind, resource.id)
}

impl HackApp {
    pub(crate) fn refresh_resource_inventory(&mut self, cx: &mut Context<Self>) {
        if !self.live || self.resource_inventory.busy {
            return;
        }
        self.resource_inventory.confirmation = None;
        self.resource_inventory.busy = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_executor()
                .spawn(async move { source.resource_inventory() })
                .await;
            let _ = this.update(cx, |this, cx| {
                let pane = &mut this.resource_inventory;
                pane.busy = false;
                if this.model.source_epoch() == epoch {
                    match report {
                        Ok(report) => pane.report = Some(report),
                        Err(error) => {
                            pane.report = None;
                            pane.notice = Some(error);
                        }
                    }
                } else {
                    pane.report = None;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn preview_removal(&mut self, id: String, cx: &mut Context<Self>) {
        if self.resource_inventory.busy || !self.live {
            return;
        }
        self.resource_inventory.notice = None;
        self.resource_inventory.confirmation = None;
        self.remove_resource(id, None, cx);
    }

    fn confirm_resource_removal(&mut self, cx: &mut Context<Self>) {
        if let Some(plan) = self
            .resource_inventory
            .take_confirmation(self.model.source_epoch())
            && self.live
        {
            self.remove_resource(plan.id, Some(plan.token), cx);
        }
        cx.notify();
    }

    fn remove_resource(&mut self, id: String, token: Option<String>, cx: &mut Context<Self>) {
        self.resource_inventory.busy = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let confirming = token.is_some();
        cx.spawn(async move |this, cx| {
            let requested = id.clone();
            let result = cx
                .background_executor()
                .spawn(async move { source.resource_removal(&requested, token.as_deref()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let pane = &mut this.resource_inventory;
                pane.busy = false;
                if this.model.source_epoch() != epoch {
                    pane.report = None;
                } else {
                    match result {
                        Ok(plan) if plan.id == id && plan.removed == confirming => {
                            if confirming {
                                pane.notice = Some("Resource removed.".into());
                                this.refresh_resource_inventory(cx);
                            } else {
                                pane.confirmation = Some((epoch, plan));
                            }
                        }
                        Ok(_) => {
                            pane.notice =
                                Some("The CLI returned an unexpected removal response.".into())
                        }
                        Err(error) => pane.notice = Some(error),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn show_resource_inventory_fixture(&mut self, name: &str) {
        let mut report = hack_desktop_core::resource_inventory::fixture();
        if name == "resources-partial" {
            report.native_complete = false;
            report
                .native_issues
                .push("A native run’s checkout or project name could not be read.".into());
        }
        self.resource_inventory.selection = report.rows.first().map(key);
        self.resource_inventory.report = Some(report);
        if name == "resources-confirm" {
            self.resource_inventory.confirmation = Some((self.model.source_epoch(), RemovalPlan {
                id: "volume:old-copy_data".into(),
                message: "Delete volume old-copy_data permanently? This cannot be undone.\nSize: 2097152 bytes.\nCheckouts: \"/work/old-copy\".\nNo registered checkout or run references this Compose project. Hack has not seen this project at any other path.".into(),
                token: "fixture".into(),
                removed: false,
            }));
        }
    }
}

pub(crate) fn render(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> impl IntoElement {
    let pane = &app.resource_inventory;
    let busy = pane.busy;
    let p = ui.p;
    let title = div()
        .flex()
        .items_center()
        .gap(space::S4)
        .child(div().type_step(text::TITLE).child("Resources"))
        .child(div().flex_1())
        .child(
            action_button("inventory-refresh", Glyph::Restart, "Refresh", !busy, ui)
                .on_click(cx.listener(|this, _, _, cx| this.refresh_resource_inventory(cx))),
        )
        .child(
            action_button("inventory-doctor", Glyph::Stethoscope, "Doctor", true, ui)
                .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
        );
    let confirm = pane
        .confirmation
        .as_ref()
        .filter(|(epoch, _)| *epoch == app.model.source_epoch());
    let report = pane.report.as_ref();
    div()
        .id("resource-inventory")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .px(space::S8)
        .py(space::S6)
        .gap(space::S5)
        .type_step(text::BODY)
        .child(title)
        .children(pane.notice.as_ref().map(|line| div().child(line.clone())))
        .children((busy && report.is_none()).then_some("Reading resource inventory…"))
        .children(confirm.map(|(_, plan)| {
            div()
                .flex()
                .flex_col()
                .gap(space::S4)
                .p(space::S5)
                .bg(p.surface_1)
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .child(plan.message.clone()),
                )
                .child(
                    div()
                        .flex()
                        .gap(space::S4)
                        .child(
                            action_button(
                                "cancel-resource-removal",
                                Glyph::Close,
                                "Cancel",
                                true,
                                ui,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.resource_inventory.confirmation = None;
                                cx.notify();
                            })),
                        )
                        .child(
                            action_button(
                                "confirm-resource-removal",
                                Glyph::Minus,
                                "Delete permanently",
                                !busy,
                                ui,
                            )
                            .on_click(
                                cx.listener(|this, _, _, cx| this.confirm_resource_removal(cx)),
                            ),
                        ),
                )
        }))
        .children(report.map(|report| {
            div()
                .flex()
                .flex_col()
                .gap(space::S4)
                .children(
                    (!report.compose_complete
                        || (!report.native_complete && report.native_issues.is_empty()))
                    .then_some("Some observations are unavailable."),
                )
                .children(report.native_issues.iter().cloned())
                .children(
                    report
                        .rows
                        .is_empty()
                        .then_some("No Hack resources reported."),
                )
                .children(
                    report
                        .rows
                        .iter()
                        .map(|row| resource_row(row, pane, ui, cx)),
                )
        }))
}

fn resource_row(row: &Resource, pane: &InventoryPane, ui: &Ui, cx: &mut Context<HackApp>) -> Div {
    let p = ui.p;
    let key = key(row);
    let expanded = pane.selection.as_ref() == Some(&key);
    let id = format!("{}:{}", row.kind, row.id);
    let removable = row.backend == "compose"
        && matches!(row.kind.as_str(), "container" | "volume")
        && row.refusal.is_none()
        && !pane.busy;
    let logs = (row.backend == "compose" && row.kind == "container")
        .then(|| row.owners.iter().find(|owner| !owner.detached))
        .flatten()
        .map(|owner| match &owner.branch {
            Some(branch) => InstanceKey::branch_at(&owner.project, branch, owner.checkout.clone()),
            None => InstanceKey::project(&owner.project),
        });
    let details = div()
        .flex()
        .flex_col()
        .gap(space::S2)
        .type_step(text::SMALL)
        .child(format!("ID · {}", row.id))
        .children(row.state.as_ref().map(|state| format!("State · {state}")))
        .children(
            row.ports
                .as_ref()
                .filter(|ports| !ports.is_empty())
                .map(|ports| format!("Ports · {ports}")),
        )
        .children(row.owners.iter().filter_map(|owner| {
            owner
                .checkout
                .as_ref()
                .map(|checkout| format!("Checkout · {checkout}"))
        }))
        .children(row.mounts.iter().map(|mount| {
            format!(
                "Mount · {} · {}",
                mount.name.as_deref().unwrap_or(&mount.kind),
                mount.destination
            )
        }))
        .children(
            row.labels
                .iter()
                .filter_map(|(key, value)| value.as_ref().map(|value| format!("{key} · {value}"))),
        )
        .children(row.refusal.clone())
        .children(logs.map(|instance| {
            action_button(
                SharedString::from(format!("resource-logs:{id}")),
                Glyph::Logs,
                "Logs",
                true,
                ui,
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_resource_logs(instance.clone(), window, cx);
            }))
        }))
        .children(removable.then(|| {
            action_button(
                SharedString::from(format!("remove-resource:{id}")),
                Glyph::Minus,
                "Review removal",
                true,
                ui,
            )
            .on_click(cx.listener(move |this, _, _, cx| this.preview_removal(id.clone(), cx)))
        }));
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .py(space::S4)
        .hairline_t(p.border)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(div().type_step(text::BODY_STRONG).child(row.name.clone()))
                .child(neutral_pill(format!("{} · {}", row.backend, row.kind), ui))
                .children(
                    row.owners
                        .iter()
                        .any(|owner| owner.detached)
                        .then(|| neutral_pill("Detached", ui)),
                )
                .child(div().flex_1())
                .child(
                    div()
                        .text_color(p.text_secondary)
                        .child(row.bytes.map_or_else(|| "Size unavailable".into(), bytes)),
                )
                .child(
                    action_button(
                        SharedString::from(format!("inspect-resource:{key}")),
                        Glyph::Search,
                        if expanded { "Hide details" } else { "Inspect" },
                        true,
                        ui,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.resource_inventory.selection = (!expanded).then(|| key.clone());
                        cx.notify();
                    })),
                ),
        )
        .children(row.owners.iter().map(|owner| {
            let name = owner.branch.as_ref().map_or_else(
                || owner.project.clone(),
                |branch| format!("{} · {branch}", owner.project),
            );
            div().text_color(p.text_secondary).child(name)
        }))
        .children(expanded.then_some(details))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_consumes_only_a_current_cli_preview_once() {
        let plan = RemovalPlan {
            id: "volume:old-copy_data".into(),
            message: "Delete permanently?".into(),
            token: "fixture-token".into(),
            removed: false,
        };
        let mut pane = InventoryPane {
            confirmation: Some((1, plan.clone())),
            ..Default::default()
        };
        assert!(pane.take_confirmation(2).is_none());
        assert!(pane.take_confirmation(1).is_none());
        pane.confirmation = Some((2, plan));
        assert_eq!(pane.take_confirmation(2).unwrap().token, "fixture-token");
        assert!(pane.take_confirmation(2).is_none());
    }
}
