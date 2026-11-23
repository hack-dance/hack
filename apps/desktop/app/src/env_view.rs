//! Names-only environment metadata, supplied by the selected Hack CLI.

use gpui_kit::{Context, IntoElement, SharedString, div, prelude::*, px};
use hack_desktop_core::env::{EnvView, key_line};
use hack_desktop_core::source::EnvTarget;
use hack_desktop_ui::components::{StyledExt as _, Ui, icon, pill};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, size, space, text};

use crate::view::HackApp;

impl HackApp {
    /// The CLI arguments for the overlay tab and scope shown.
    fn env_target(&self) -> EnvTarget {
        EnvTarget {
            env: self.env.env.clone(),
            scope: self.env.scope.clone(),
        }
    }

    /// The `--env` value of the tab shown: the one chosen, else the
    /// overlay the CLI selected.
    pub(crate) fn env_tab_shown(&self) -> Option<String> {
        self.env.env.clone().or_else(|| match &self.env.view {
            EnvView::Report(r) => r
                .env_selection
                .as_ref()
                .and_then(|s| s.effective.clone().or_else(|| s.default.clone())),
            _ => None,
        })
    }

    /// List names in the selected overlay and scope.
    pub(crate) fn read_env(&mut self, cx: &mut Context<Self>) {
        let generation = self.env.begin();
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let target = self.env_target();
        if !self.live {
            let view = self.source.env_for(&root, native, &target);
            self.env.finish(generation, view);
            return;
        }
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let requested = root.clone();
        cx.spawn(async move |this, cx| {
            let view = cx
                .background_executor()
                .spawn(async move { source.env_for(&root, native, &target) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // The generation drops a read the user has moved away from.
                if this.selected_root() == Some((requested, native)) {
                    this.env.finish(generation, view);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn select_overlay(&mut self, env: String, cx: &mut Context<Self>) {
        self.user_navigated();
        self.env.env = Some(env);
        self.read_env(cx);
        cx.notify();
    }

    /// List one scope (`--service`).
    pub(crate) fn select_scope(&mut self, scope: String, cx: &mut Context<Self>) {
        self.user_navigated();
        self.env.scope = Some(scope);
        self.read_env(cx);
        cx.notify();
    }

    pub(crate) fn env_tab(&self, ui: &Ui, cx: &mut Context<Self>) -> impl IntoElement {
        let p = ui.p;
        let mut body = div().flex().flex_col().gap(space::S3).pt(space::S3);
        let line = |s: String| {
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(s)
        };
        let report = match &self.env.view {
            EnvView::Loading => return body.child(line("Reading environment…".into())),
            EnvView::Unreadable => {
                return body.child(line(
                    "Could not read this project's environment. Check again or run hack doctor."
                        .into(),
                ));
            }
            EnvView::Report(r) => r,
        };

        // Overlay tabs, then the scope choice on the right.
        let shown = self.env_tab_shown();
        let mut tabs = div().flex().flex_wrap().items_center().gap(space::S2);
        for (i, tab) in report
            .env_selection
            .clone()
            .unwrap_or_default()
            .tabs(&report.overlays)
            .into_iter()
            .enumerate()
        {
            let sel = shown.as_deref() == Some(tab.env.as_str())
                || (shown.is_none() && tab.env == "default");
            let running = self.env.running.as_deref() == Some(tab.env.as_str());
            let env = tab.env.clone();
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("env-overlay-{i}")))
                    .h(size::CONTROL)
                    .px(space::S5)
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .rounded(radius::CONTROL)
                    .cursor_pointer()
                    .type_step(if sel { text::BODY_STRONG } else { text::BODY })
                    .text_color(if sel {
                        p.text_primary
                    } else {
                        p.text_secondary
                    })
                    .when(sel, |d| d.bg(p.surface_1))
                    .child(tab.label.clone())
                    .when(running, |d| {
                        d.child(pill("running", p.states.running.bg, p.states.running.fg))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_overlay(env.clone(), cx);
                    })),
            );
        }
        let selected_scope = self
            .env
            .scope
            .clone()
            .or_else(|| report.selected_scope.clone())
            .unwrap_or_else(|| "global".into());
        let mut scopes = div().flex().flex_wrap().items_center().gap(space::S1);
        for (i, scope) in report.scopes.iter().enumerate() {
            let sel = *scope == selected_scope;
            let s = scope.clone();
            scopes = scopes.child(
                div()
                    .id(SharedString::from(format!("env-scope-{i}")))
                    .px(space::S3)
                    .py(px(1.))
                    .rounded(radius::CONTROL)
                    .cursor_pointer()
                    .type_step(text::SMALL)
                    .text_color(if sel { p.text_primary } else { p.text_muted })
                    .when(sel, |d| d.bg(p.surface_1))
                    .child(scope.clone())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_scope(s.clone(), cx);
                    })),
            );
        }
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(space::S3)
                .child(tabs)
                .child(scopes),
        );

        // The key line uses only the status reported by the CLI.
        let mut key_row = div().flex().items_center().gap(space::S3);
        if let Some((ok, label)) = key_line(report.key_state) {
            key_row = key_row.child(
                div()
                    .id("env-key-line")
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .type_step(text::SMALL)
                    .text_color(if ok {
                        p.text_muted
                    } else {
                        p.states.degraded.fg
                    })
                    .child(icon(
                        Glyph::Key,
                        size::ICON,
                        if ok {
                            p.text_muted
                        } else {
                            p.states.degraded.fg
                        },
                    ))
                    .child(label),
            );
        }
        body = body.child(key_row);

        if report.vars.is_empty() {
            return body.child(line(report.empty_label().to_owned()));
        }

        let mut table = div().flex().flex_col().child(
            div()
                .h(px(26.))
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(div().flex_1().child("Name"))
                .child(div().w(px(120.)).child("Scope")),
        );
        for row in &report.vars {
            let scope = row.scope_name();
            table = table.child(
                div()
                    .h(size::TABLE_ROW)
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .hairline_t(p.border)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(ui.mono.clone())
                            .type_step(text::MONO)
                            .text_color(p.text_primary)
                            .child(row.key.clone()),
                    )
                    .children(row.missing.then(|| {
                        pill("required · missing", p.states.failed.bg, p.states.failed.fg)
                    }))
                    .child(
                        div()
                            .w(px(120.))
                            .flex_none()
                            .truncate()
                            .text_color(p.text_secondary)
                            .type_step(text::BODY)
                            .child(scope),
                    ),
            );
        }
        body.child(table)
    }
}
