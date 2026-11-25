use gpui_kit::{Context, Div, Task, div, prelude::*};
use hack_desktop_core::git_changes::{ChangedFile, Changes, REFUSED};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, pill},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

#[derive(Default)]
pub(crate) struct ChangesPane {
    result: Option<Result<Changes, &'static str>>,
    pending: Option<Task<()>>,
}

impl HackApp {
    pub(crate) fn reset_changes(&mut self, cx: &mut Context<Self>) {
        self.changes = ChangesPane::default();
        self.read_changes(cx);
    }

    fn read_changes(&mut self, cx: &mut Context<Self>) {
        let Some((root, _)) = self.selected_root() else {
            return;
        };
        if !self.live || self.changes.pending.is_some() {
            return;
        }
        self.changes.result = None;
        self.changes.pending = Some(cx.spawn(async move |this, cx| {
            let status = cx
                .background_executor()
                .spawn(async move { Changes::read(&root) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.changes.pending = None;
                this.changes.result = Some(status);
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub(crate) fn changes_badge(&self, ui: &Ui) -> Option<Div> {
        let report = self.changes.result.as_ref()?.as_ref().ok()?;
        (!report.files.is_empty()).then(|| {
            pill(
                "Not committed",
                ui.p.states.degraded.bg,
                ui.p.states.degraded.fg,
            )
        })
    }

    pub(crate) fn changes_view(&self, ui: &Ui, cx: &mut Context<Self>) -> impl IntoElement {
        let p = ui.p;
        let check = self.live && self.changes.pending.is_none() && self.selected_root().is_some();
        let mut button = action_button("check-git", Glyph::Restart, "Check again", check, ui);
        if check {
            button = button.on_click(cx.listener(|this, _, _, cx| this.read_changes(cx)));
        }
        let heading = div()
            .flex()
            .items_center()
            .gap(space::S4)
            .type_step(text::BODY);
        let heading = match &self.changes.result {
            None if self.changes.pending.is_some() || !self.live => {
                heading.child("Reading Git status…")
            }
            None => heading.child("Select a project with a known checkout."),
            Some(Err(error)) => heading.child(*error),
            Some(Ok(report)) => heading
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .child(report.branch.clone()),
                )
                .child(
                    div()
                        .text_color(p.text_secondary)
                        .child(report.checkout.clone()),
                ),
        };
        let body = div().flex().flex_col().gap(space::S4).type_step(text::BODY);
        let body = match &self.changes.result {
            Some(Ok(report)) => body
                .children(
                    report
                        .files
                        .is_empty()
                        .then_some("No uncommitted changes to Hack files."),
                )
                .children(report.files.iter().map(|file| {
                    div()
                        .flex()
                        .gap(space::S5)
                        .items_center()
                        .py(space::S4)
                        .hairline_t(p.border)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .type_step(text::MONO)
                                .font_family(ui.mono.clone())
                                .child(file.path.clone()),
                        )
                        .child(div().text_color(p.text_secondary).child(file.state.clone()))
                })),
            _ => body,
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .gap(space::S4)
            .px(space::S8)
            .pb(space::S5)
            .child(heading.child(button))
            .child(
                div()
                    .id("changed-files")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
    }

    pub(crate) fn show_changes_fixture(&mut self, name: &str) {
        self.tab = 6;
        self.changes.result = match name {
            "changes-loading" => None,
            "changes-error" => Some(Err(REFUSED)),
            _ => Some(Ok(Changes {
                branch: "feature/search".into(),
                checkout: "storefront-search".into(),
                files: if name == "changes-clean" {
                    vec![]
                } else {
                    vec![
                        ChangedFile {
                            path: ".hack/hack.config.json".into(),
                            state: "Modified".into(),
                        },
                        ChangedFile {
                            path: ".hack/notes.md".into(),
                            state: "Untracked".into(),
                        },
                    ]
                },
            })),
        };
    }
}
