use gpui_kit::{AnyElement, Context, Div, Window, div, prelude::*};
use hack_desktop_core::resources::{ObservedContainer, ResourceGroup, inventory};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, neutral_pill},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

pub(crate) fn render(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let body = div()
        .id("resources-list")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(space::S6)
        .px(space::S8)
        .py(space::S5)
        .type_step(text::BODY);
    let body = match app
        .model
        .snapshot()
        .filter(|_| app.model.project_list_readable())
    {
        None => body.child("A current project report is unavailable."),
        Some(snapshot) => {
            let groups = inventory(&snapshot.projects);
            body.children(
                snapshot
                    .projects
                    .engine_down()
                    .then_some("Compose container status is unavailable."),
            )
            .children(
                (groups.is_empty() && !snapshot.projects.engine_down())
                    .then_some("No containers reported for registered projects."),
            )
            .children(
                groups
                    .into_iter()
                    .enumerate()
                    .map(|(index, g)| group(index, g, ui, cx)),
            )
        }
    };
    div()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .flex()
        .flex_col()
        .child(
            div().px(space::S8).py(space::S6).hairline_b(p.border).flex().items_center().gap(space::S4)
                .child(div().type_step(text::TITLE).child("Resources"))
                .child(div().flex_1())
                .child(action_button("resources-doctor", Glyph::Stethoscope, "Doctor", true, ui)
                    .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx)))),
        )
        .child(div().px(space::S8).pt(space::S4).type_step(text::SMALL).text_color(p.text_secondary)
            .child("Observed containers and attachments. Detached resources and disk usage are unavailable."))
        .children(app.observed_pool().map(|report| {
            div().px(space::S8).py(space::S4).child(crate::doctor_view::native_pool_card(report, ui))
        }))
        .child(body)
        .into_any_element()
}

impl HackApp {
    pub(crate) fn open_resource_logs(
        &mut self,
        key: hack_desktop_core::viewmodel::InstanceKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_instance(key.clone(), cx);
        if self.model.selected_key().as_ref() != Some(&key) {
            return;
        }
        #[cfg(hack_terminal)]
        {
            self.set_tab(0, cx);
            self.show_instance_terminal_logs(window, cx);
        }
        #[cfg(not(hack_terminal))]
        {
            let _ = window;
            self.set_tab(1, cx);
        }
    }
}

fn group(index: usize, group: ResourceGroup, ui: &Ui, cx: &mut Context<HackApp>) -> Div {
    let title = group.key.branch.as_deref().map_or_else(
        || group.key.project.clone(),
        |branch| format!("{} · {branch}", group.key.project),
    );
    let key = group.key;
    let logs_key = key.clone();
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(
            div()
                .flex()
                .gap(space::S4)
                .items_center()
                .child(div().type_step(text::BODY_STRONG).child(title))
                .child(neutral_pill(
                    if group.native { "native" } else { "compose" },
                    ui,
                ))
                .child(div().flex_1())
                .child(
                    action_button(
                        ("resource-project", index),
                        Glyph::Folder,
                        "Open project",
                        true,
                        ui,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_instance(key.clone(), cx);
                        this.set_tab(0, cx);
                    })),
                )
                .children((!group.native).then(|| {
                    action_button(("resource-logs", index), Glyph::Logs, "Logs", true, ui).on_click(
                        cx.listener(move |this, _, window, cx| {
                            this.open_resource_logs(logs_key.clone(), window, cx);
                        }),
                    )
                })),
        )
        .children(group.containers.into_iter().map(|c| container(c, ui)))
}

fn container(row: ObservedContainer, ui: &Ui) -> Div {
    let p = ui.p;
    let attachments = |label: &str, names: std::collections::BTreeSet<String>| {
        (!names.is_empty()).then(|| {
            format!(
                "{label} · {}",
                names.into_iter().collect::<Vec<_>>().join(", ")
            )
        })
    };
    div()
        .flex()
        .flex_col()
        .gap(space::S2)
        .py(space::S4)
        .hairline_t(p.border)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(div().type_step(text::BODY_STRONG).child(row.name))
                .child(neutral_pill(row.state, ui)),
        )
        .children(row.id.map(|id| {
            div()
                .type_step(text::MONO)
                .font_family(ui.mono.clone())
                .text_color(p.text_secondary)
                .child(id)
        }))
        .children(
            [
                row.image.map(|image| format!("Image · {image}")),
                attachments("Volumes", row.volumes),
                attachments("Networks", row.networks),
            ]
            .into_iter()
            .flatten()
            .map(|line| {
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_secondary)
                    .child(line)
            }),
        )
}
