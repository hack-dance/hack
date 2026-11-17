//! The Env tab: overlay tabs, a key line, and a Name / Value table.
//!
//! Every read goes through the CLI (`hack env list --json` per overlay and
//! scope, `hack env get KEY` per value). Plaintext values load with the
//! listing; a secret's value only when its eye or copy button is pressed,
//! for that one name. A revealed value hides again after
//! [`REVEAL_FOR`](hack_desktop_core::env::REVEAL_FOR), and when the tab, the
//! overlay, the scope, the project or the window changes. Copy clears the
//! clipboard after the same time if it still holds the value. Values never
//! reach a log, `--drive` output or an error message.

use gpui_kit::{
    ClipboardItem, Context, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};
use hack_desktop_core::env::{
    EnvRow, EnvView, KeyState, REVEAL_FOR, Revealed, ValueKey, ValueState, key_line,
};
use hack_desktop_core::source::EnvTarget;
use hack_desktop_ui::components::{StyledExt as _, Ui, icon, icon_button, pill};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, size, space, text};

use crate::view::HackApp;

/// Most plaintext values read with one listing (one `hack env get` each).
/// A listing in one read is DESIGN.md request R25.
const PLAIN_VALUES_MAX: usize = 48;

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

    fn value_key(&self, row: &EnvRow) -> ValueKey {
        ValueKey {
            env: self.env_tab_shown().unwrap_or_default(),
            scope: row.scope_name(),
            name: row.key.clone(),
        }
    }

    /// List the overlay and scope shown; then read its plaintext values.
    pub(crate) fn read_env(&mut self, cx: &mut Context<Self>) {
        let generation = self.env.begin();
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let target = self.env_target();
        if !self.live {
            let view = self.source.env_for(&root, native, &target);
            self.env.finish(generation, view);
            self.load_plain_values(cx);
            return;
        }
        let source = self.source.clone();
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
                    this.load_plain_values(cx);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Plaintext values for the listing shown, one `hack env get` each.
    fn load_plain_values(&mut self, cx: &mut Context<Self>) {
        let EnvView::Report(report) = &self.env.view else {
            return;
        };
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let generation = self.env.generation();
        let target = self.env_target();
        let rows: Vec<(ValueKey, String)> = report
            .vars
            .iter()
            .filter(|r| r.is_plaintext() && !r.missing)
            .take(PLAIN_VALUES_MAX)
            .map(|r| (self.value_key(r), r.key.clone()))
            .collect();
        for (key, _) in &rows {
            self.env
                .set_value(generation, key.clone(), ValueState::Reading);
        }
        if !self.live {
            for (key, name) in rows {
                let state = match self.source.env_value(&root, native, &target, &name) {
                    Ok(v) => ValueState::Plain(v),
                    Err(e) => ValueState::Failed(e),
                };
                self.env.set_value(generation, key, state);
            }
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            for (key, name) in rows {
                let (source, root, target) = (source.clone(), root.clone(), target.clone());
                let state = cx
                    .background_executor()
                    .spawn(async move {
                        match source.env_value(&root, native, &target, &name) {
                            Ok(v) => ValueState::Plain(v),
                            Err(e) => ValueState::Failed(e),
                        }
                    })
                    .await;
                let current = this.update(cx, |this, cx| {
                    this.env.set_value(generation, key, state);
                    cx.notify();
                    this.env.generation() == generation
                });
                if !matches!(current, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    /// Show the overlay `env` (`default` is base).
    pub(crate) fn select_overlay(&mut self, env: String, cx: &mut Context<Self>) {
        self.env.env = Some(env);
        self.read_env(cx);
        cx.notify();
    }

    /// List one scope (`--service`).
    pub(crate) fn select_scope(&mut self, scope: String, cx: &mut Context<Self>) {
        self.env.scope = Some(scope);
        self.read_env(cx);
        cx.notify();
    }

    /// Read one value (`hack env get` for this one name), then `then`, unless
    /// a hide (focus lost, another overlay) happened while it was read.
    fn read_value(
        &mut self,
        row: &EnvRow,
        then: impl FnOnce(&mut Self, Result<Revealed, String>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let generation = self.env.generation();
        let epoch = self.env.reveal_epoch();
        let target = self.env_target();
        let name = row.key.clone();
        if !self.live {
            let result = self.source.env_value(&root, native, &target, &name);
            then(self, result, cx);
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.env_value(&root, native, &target, &name) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // Moved to another listing, or anything was hidden (the
                // window lost focus) while reading: drop the value.
                if this.env.generation() == generation && this.env.reveal_epoch() == epoch {
                    then(this, result, cx);
                }
            });
        })
        .detach();
    }

    /// The eye: show a secret's value for [`REVEAL_FOR`], or hide it.
    pub(crate) fn toggle_reveal(&mut self, row: &EnvRow, cx: &mut Context<Self>) {
        let key = self.value_key(row);
        if matches!(self.env.value(&key), ValueState::Shown { .. }) {
            self.env.hide(&key);
            cx.notify();
            return;
        }
        let generation = self.env.generation();
        self.env
            .set_value(generation, key.clone(), ValueState::Reading);
        self.read_value(
            row,
            move |this, result, cx| {
                let state = match result {
                    Ok(value) => ValueState::Shown {
                        value,
                        at: std::time::Instant::now(),
                    },
                    Err(e) => ValueState::Failed(e),
                };
                this.env.set_value(generation, key, state);
                this.expire_values_later(cx);
                cx.notify();
            },
            cx,
        );
        cx.notify();
    }

    /// Hide revealed values when their time is up.
    fn expire_values_later(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REVEAL_FOR).await;
            let _ = this.update(cx, |this, cx| {
                if this.env.expire() {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Copy: the value goes to the clipboard, read for this one name if it
    /// is not shown, and is cleared after [`REVEAL_FOR`] if still there.
    /// GPUI cannot mark a clipboard item concealed yet (see DESIGN.md).
    pub(crate) fn copy_value(&mut self, row: &EnvRow, cx: &mut Context<Self>) {
        let key = self.value_key(row);
        let known = match self.env.value(&key) {
            ValueState::Shown { value, .. } | ValueState::Plain(value) => Some(value),
            _ => None,
        };
        let generation = self.env.generation();
        let done =
            move |this: &mut Self, result: Result<Revealed, String>, cx: &mut Context<Self>| {
                match result {
                    Ok(value) => {
                        cx.write_to_clipboard(ClipboardItem::new_string(value.expose().to_owned()));
                        this.env.copied = Some(key.clone());
                        this.clear_clipboard_later(value, cx);
                    }
                    Err(e) => this
                        .env
                        .set_value(generation, key.clone(), ValueState::Failed(e)),
                }
                cx.notify();
            };
        match known {
            Some(value) => done(self, Ok(value), cx),
            None => self.read_value(row, done, cx),
        }
    }

    fn clear_clipboard_later(&mut self, value: Revealed, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REVEAL_FOR).await;
            let _ = this.update(cx, |this, cx| {
                let still = cx
                    .read_from_clipboard()
                    .and_then(|item| item.text())
                    .is_some_and(|text| text == value.expose());
                if still {
                    cx.write_to_clipboard(ClipboardItem::new_string(String::new()));
                }
                this.env.copied = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// Hide every revealed value: the window was hidden or lost focus.
    pub(crate) fn hide_env_values(&mut self, cx: &mut Context<Self>) {
        if self.env.hide_revealed() {
            cx.notify();
        }
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
        let mut tabs = div().flex().items_center().gap(space::S2);
        for (i, tab) in report
            .env_selection
            .clone()
            .unwrap_or_default()
            .tabs()
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
        let mut scopes = div().flex().items_center().gap(space::S1);
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
                .items_center()
                .gap(space::S4)
                .child(tabs)
                .child(div().flex_1())
                .child(scopes),
        );

        // The key line: only when the CLI said something about the key.
        if let Some((ok, label)) = key_line(report.key_state) {
            body = body.child(
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

        if report.vars.is_empty() {
            return body.child(line(report.empty_label().to_owned()));
        }

        // Name, Value, actions.
        let name_w = px(260.);
        let actions_w = px(56.);
        let mut table = div().flex().flex_col().child(
            div()
                .h(px(26.))
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(div().w(name_w).flex_none().child("Name"))
                .child(div().flex_1().child("Value"))
                .child(div().w(actions_w).flex_none()),
        );
        let locked = matches!(report.key_state, KeyState::Missing | KeyState::Unreadable);
        for (i, row) in report.vars.iter().enumerate() {
            let key = self.value_key(row);
            let state = self.env.value(&key);
            let secret = row.is_secret();
            let mut name = div()
                .w(name_w)
                .flex_none()
                .min_w_0()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(ui.mono.clone())
                        .type_step(text::MONO)
                        .text_color(if row.missing {
                            p.states.failed.fg
                        } else {
                            p.text_primary
                        })
                        .child(row.key.clone()),
                );
            let scope = row.scope_name();
            if scope != "global" && scope != "unknown" {
                name = name.child(pill(scope, p.surface_1, p.text_secondary));
            }
            if row.missing {
                name = name.child(pill(
                    "required · missing",
                    p.states.failed.bg,
                    p.states.failed.fg,
                ));
            }
            let value_text: SharedString = match &state {
                _ if row.missing => "—".into(),
                ValueState::Shown { value, .. } | ValueState::Plain(value) => {
                    value.expose().to_owned().into()
                }
                ValueState::Reading => "…".into(),
                ValueState::Failed(_) => "could not read".into(),
                ValueState::Hidden if secret => "••••••••••••".into(),
                ValueState::Hidden => "—".into(),
            };
            let failed = matches!(state, ValueState::Failed(_));
            let value = div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(if failed {
                    p.text_muted
                } else {
                    p.text_secondary
                })
                .child(value_text);
            let shown = matches!(state, ValueState::Shown { .. });
            let copied = self.env.copied.as_ref() == Some(&key);
            let mut actions = div()
                .w(actions_w)
                .flex_none()
                .flex()
                .items_center()
                .justify_end()
                .gap(space::S1);
            if !row.missing {
                if secret && !locked {
                    let r = row.clone();
                    actions = actions.child(
                        icon_button(
                            SharedString::from(format!("env-eye-{i}")),
                            if shown { Glyph::EyeOff } else { Glyph::Eye },
                            ui,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_reveal(&r, cx))),
                    );
                }
                if !(secret && locked) {
                    let r = row.clone();
                    actions = actions.child(
                        icon_button(
                            SharedString::from(format!("env-copy-{i}")),
                            if copied { Glyph::Check } else { Glyph::Copy },
                            ui,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.copy_value(&r, cx))),
                    );
                }
            }
            table = table.child(
                div()
                    .h(size::TABLE_ROW)
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .hairline_t(p.border)
                    .child(name)
                    .child(value)
                    .child(actions),
            );
        }
        body.child(table)
    }
}

// A headless app needs GPUI's test support (the `screenshots` feature).
#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use std::sync::Arc;

    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::env::{EnvRow, EnvView, ValueState};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;

    use super::*;

    fn app() -> (HeadlessAppContext, gpui_kit::Entity<HackApp>) {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| {
                        let mut a = HackApp::new(
                            Arc::new(FixtureSource(Fixture::EnvOverlays)),
                            false,
                            window,
                            cx,
                        );
                        a.select("storefront");
                        a.show_env_fixture("env-overlays", cx);
                        a
                    })
                })
            })
            .expect("open a headless window");
        (cx, app)
    }

    fn row(cx: &mut HeadlessAppContext, app: &gpui_kit::Entity<HackApp>, name: &str) -> EnvRow {
        cx.update(|cx| match &app.read(cx).env.view {
            EnvView::Report(r) => r.vars.iter().find(|v| v.key == name).cloned().unwrap(),
            other => panic!("no listing: {other:?}"),
        })
    }

    fn state(
        cx: &mut HeadlessAppContext,
        app: &gpui_kit::Entity<HackApp>,
        r: &EnvRow,
    ) -> ValueState {
        cx.update(|cx| {
            let a = app.read(cx);
            a.env.value(&a.value_key(r))
        })
    }

    #[test]
    fn plaintext_loads_with_the_listing_and_secrets_stay_masked() {
        let (mut cx, app) = app();
        let plain = row(&mut cx, &app, "APP_MODE");
        assert!(
            matches!(state(&mut cx, &app, &plain), ValueState::Plain(v) if v.expose() == "fake-app-mode-value")
        );
        let secret = row(&mut cx, &app, "DATABASE_URL");
        assert_eq!(state(&mut cx, &app, &secret), ValueState::Hidden);
    }

    #[test]
    fn the_eye_reveals_one_secret_and_any_move_hides_it() {
        let (mut cx, app) = app();
        let secret = row(&mut cx, &app, "DATABASE_URL");
        let other = row(&mut cx, &app, "API_TOKEN");
        cx.update(|cx| app.update(cx, |a, cx| a.toggle_reveal(&secret, cx)));
        assert!(matches!(
            state(&mut cx, &app, &secret),
            ValueState::Shown { .. }
        ));
        assert_eq!(
            state(&mut cx, &app, &other),
            ValueState::Hidden,
            "only that name"
        );
        // The eye again hides it.
        cx.update(|cx| app.update(cx, |a, cx| a.toggle_reveal(&secret, cx)));
        assert_eq!(state(&mut cx, &app, &secret), ValueState::Hidden);
        // Window hidden or unfocused.
        cx.update(|cx| app.update(cx, |a, cx| a.toggle_reveal(&secret, cx)));
        cx.update(|cx| app.update(cx, |a, cx| a.hide_env_values(cx)));
        assert_eq!(state(&mut cx, &app, &secret), ValueState::Hidden);
        let plain = row(&mut cx, &app, "APP_MODE");
        assert!(
            matches!(state(&mut cx, &app, &plain), ValueState::Plain(_)),
            "plaintext stays"
        );
        // Another overlay.
        cx.update(|cx| app.update(cx, |a, cx| a.toggle_reveal(&secret, cx)));
        cx.update(|cx| app.update(cx, |a, cx| a.select_overlay("dev".into(), cx)));
        let secret = row(&mut cx, &app, "DATABASE_URL");
        assert_eq!(state(&mut cx, &app, &secret), ValueState::Hidden);
        // Another detail tab.
        cx.update(|cx| app.update(cx, |a, cx| a.toggle_reveal(&secret, cx)));
        cx.update(|cx| app.update(cx, |a, cx| a.set_tab(0, cx)));
        assert!(cx.update(|cx| {
            let a = app.read(cx);
            !matches!(a.env.value(&a.value_key(&secret)), ValueState::Shown { .. })
        }));
    }

    #[test]
    fn copy_puts_one_value_on_the_clipboard_without_revealing_it() {
        let (mut cx, app) = app();
        let secret = row(&mut cx, &app, "DATABASE_URL");
        cx.update(|cx| app.update(cx, |a, cx| a.copy_value(&secret, cx)));
        let text = cx.update(|cx| cx.read_from_clipboard().and_then(|i| i.text()));
        assert_eq!(
            text.as_deref(),
            Some(hack_desktop_core::env::fixture_value("DATABASE_URL").as_str())
        );
        assert_eq!(
            state(&mut cx, &app, &secret),
            ValueState::Hidden,
            "copy does not reveal"
        );
    }

    #[test]
    fn a_refresh_that_changes_the_project_resets_overlay_and_scope() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.select_overlay("staging".into(), cx);
                a.select_scope("api".into(), cx);
            })
        });
        // The selected project goes away in a live refresh.
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let token = a.model.begin_refresh();
                let mut snap = hack_desktop_core::fixtures::snapshot(Fixture::Running).unwrap();
                snap.projects.projects.retain(|p| p.name != "storefront");
                a.apply_refresh(token, Ok(snap), cx);
            })
        });
        let (env, scope, selected) = cx.update(|cx| {
            let a = app.read(cx);
            (
                a.env.env.clone(),
                a.env.scope.clone(),
                a.model.selected_key().map(|k| k.project),
            )
        });
        assert_ne!(selected.as_deref(), Some("storefront"), "another project");
        assert_eq!(
            (env, scope),
            (None, None),
            "not the last project's overlay or scope"
        );
    }
}
