use gpui_kit::{
    Context, Div, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, Task, div,
};
use hack_desktop_core::source::{
    CopiesObservation, CopiesReport, CopyCheckout, ProjectCopy, SourceError,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, neutral_pill},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

#[derive(Default)]
pub(crate) struct CopiesPane {
    result: Option<Result<CopiesReport, SourceError>>,
    pending: Option<Task<()>>,
}

impl HackApp {
    pub(crate) fn refresh_copies_if_open(&mut self, cx: &mut Context<Self>) {
        self.copies = CopiesPane::default();
        if self.tab == 3 && self.live {
            self.read_copies(cx);
        }
    }

    fn read_copies(&mut self, cx: &mut Context<Self>) {
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        if self.copies.pending.is_some() || !self.live {
            return;
        }
        self.copies.result = None;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        self.copies.pending = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.copies(&root, native) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.copies.result = Some(result);
                this.copies.pending = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub(crate) fn copies_view(&self, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let check_again =
            self.live && self.copies.pending.is_none() && self.selected_root().is_some();
        let mut refresh = action_button(
            "refresh-copies",
            Glyph::Restart,
            "Check again",
            check_again,
            ui,
        );
        if check_again {
            refresh = refresh.on_click(cx.listener(|this, _, _, cx| this.read_copies(cx)));
        }
        let body = div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .type_step(text::BODY)
            .text_color(ui.p.text_secondary);
        let body = match &self.copies.result {
            None if self.copies.pending.is_some() || !self.live => {
                body.child("Reading project copies…")
            }
            None => body.child("Select a project with a known checkout to read copies."),
            Some(Err(error)) => body.child(match error {
                SourceError::Cli { code, .. } => format!("Could not read project copies ({code})."),
                _ => "Could not read project copies.".into(),
            }),
            Some(Ok(report)) => body
                .children((!report.observation.ok).then(|| {
                    let reason = report
                        .observation
                        .code
                        .as_deref()
                        .unwrap_or("status unavailable");
                    format!("Runtime observation incomplete ({reason}).")
                }))
                .children(
                    (report.copies.is_empty() && report.observation.ok)
                        .then_some("No project copies reported."),
                )
                .children(report.copies.iter().map(|copy| {
                    let instance = copy.instance.as_deref().unwrap_or("Base instance");
                    let branch = copy.branch.as_deref().unwrap_or("Branch unknown");
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S2)
                        .py(space::S4)
                        .hairline_b(ui.p.border)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(space::S4)
                                .child(
                                    div()
                                        .type_step(text::BODY_STRONG)
                                        .text_color(ui.p.text_primary)
                                        .child(format!("{} · {instance}", copy.checkout.name)),
                                )
                                .child(neutral_pill(copy.backend.clone(), ui))
                                .child(neutral_pill(copy.state.clone(), ui)),
                        )
                        .child(format!("{branch} · {}", copy.checkout.kind))
                        .child(
                            div()
                                .type_step(text::MONO)
                                .font_family(ui.mono.clone())
                                .child(copy.checkout.root.clone()),
                        )
                        .children(copy.address.clone())
                })),
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .px(space::S8)
            .pb(space::S5)
            .gap(space::S4)
            .child(div().flex().justify_end().child(refresh))
            .child(
                div()
                    .id("copies-list")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
    }

    pub(crate) fn show_copies_fixture(&mut self, name: &str) {
        self.tab = 3;
        let partial = name == "copies-partial";
        let copies = if name == "copies-empty" {
            vec![]
        } else {
            vec![
                ProjectCopy {
                    branch: Some("main".into()),
                    checkout: CopyCheckout {
                        name: "primary".into(),
                        root: "/work/storefront".into(),
                        kind: "primary".into(),
                    },
                    instance: None,
                    backend: "compose".into(),
                    state: "running".into(),
                    address: Some("https://storefront.hack".into()),
                },
                ProjectCopy {
                    branch: Some("feature/search".into()),
                    checkout: CopyCheckout {
                        name: "feature/search".into(),
                        root: "/work/storefront-search".into(),
                        kind: "worktree".into(),
                    },
                    instance: Some("feature-search".into()),
                    backend: "compose".into(),
                    state: if partial { "unknown" } else { "running" }.into(),
                    address: (!partial).then(|| "https://feature-search.storefront.hack".into()),
                },
            ]
        };
        self.copies.result = match name {
            "copies-loading" => None,
            "copies-error" => Some(Err(SourceError::CliMissing)),
            _ => Some(Ok(CopiesReport {
                copies,
                observation: CopiesObservation {
                    ok: !partial,
                    code: partial.then(|| "E_TIMEOUT".into()),
                },
            })),
        };
    }
}
