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

use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    AnyElement, ClipboardItem, Context, Entity, IntoElement, ParentElement, SharedString, Styled,
    Window, div, prelude::*, px,
};
use hack_desktop_core::env::{
    EnvRow, EnvView, KeyState, REVEAL_FOR, Revealed, ValueKey, ValueState, key_line,
};
use hack_desktop_core::source::EnvTarget;
use hack_desktop_ui::components::{StyledExt as _, Ui, icon, icon_button, pill};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, size, space, text};

use crate::view::HackApp;

/// An open edit: a new variable, or one row's new value. The value lives in
/// the input until Save hands it to the CLI on stdin, or Cancel drops it.
pub(crate) struct EnvEdit {
    /// The row edited; `None` for a new variable (the name is typed).
    pub key: Option<String>,
    pub secret: bool,
    /// The row's own scope (`None` for a new variable).
    pub scope: Option<String>,
    /// The row lives in a worktree-local layer: written there (`--local`).
    pub local: bool,
    /// Which editor this is: a write's completion only touches the editor
    /// that started it, not one opened since.
    pub id: u64,
    pub name: Option<Entity<InputState>>,
    pub value: Entity<InputState>,
    pub busy: bool,
    pub error: Option<String>,
    /// Why this row cannot be written from the app at all (a legacy row for
    /// several services); Save stays off.
    pub blocked: Option<String>,
    /// The field holds the value Save may store: false while an existing
    /// plaintext value is still being read, or could not be. Until then
    /// Save stores only text the user typed, never an empty field, so an
    /// unchanged Save never blanks the value.
    pub ready: bool,
}

/// Why Save stays off when an existing value could not be read.
const UNREAD_ERROR: &str =
    "Could not read the current value. Type the new value to replace it, or close and try again.";

/// Most plaintext values read with one listing (one `hack env get` each).
/// A listing in one read is DESIGN.md request R25.
const PLAIN_VALUES_MAX: usize = 48;

impl HackApp {
    /// The CLI arguments for the overlay tab and scope shown.
    fn env_target(&self) -> EnvTarget {
        EnvTarget {
            env: self.env.env.clone(),
            scope: self.env.scope.clone(),
            local: false,
        }
    }

    /// The target for one row's value: the listing's, with the row's own
    /// service when the listing named none (see [`EnvRow::value_scope`]).
    fn row_target(&self, row: &EnvRow) -> EnvTarget {
        let mut target = self.env_target();
        if target.scope.is_none() {
            target.scope = row.value_scope();
        }
        target
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
        let rows: Vec<(ValueKey, String, EnvTarget)> = report
            .vars
            .iter()
            .filter(|r| r.is_plaintext() && !r.missing)
            .take(PLAIN_VALUES_MAX)
            .map(|r| (self.value_key(r), r.key.clone(), self.row_target(r)))
            .collect();
        for (key, _, _) in &rows {
            self.env
                .set_value(generation, key.clone(), ValueState::Reading);
        }
        if !self.live {
            for (key, name, target) in rows {
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
            for (key, name, target) in rows {
                let (source, root) = (source.clone(), root.clone());
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
        self.env_edit = None;
        self.user_navigated();
        self.env.env = Some(env);
        self.read_env(cx);
        cx.notify();
    }

    /// List one scope (`--service`).
    pub(crate) fn select_scope(&mut self, scope: String, cx: &mut Context<Self>) {
        self.env_edit = None;
        self.user_navigated();
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
        let target = self.row_target(row);
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
        // A second press hides it, or cancels a read still in flight: the
        // completion below lands only while the name is still "Reading".
        if matches!(
            self.env.value(&key),
            ValueState::Shown { .. } | ValueState::Reading
        ) {
            self.env.hide(&key);
            cx.notify();
            return;
        }
        let generation = self.env.generation();
        let token = self.env.start_reveal(key.clone());
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
                if this.env.finish_reveal(generation, key, token, state) {
                    this.expire_values_later(cx);
                    cx.notify();
                }
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
    /// On macOS the item is marked concealed (`crate::clipboard`).
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
                        crate::clipboard::write_secret(value.expose(), cx);
                        this.env.copied = Some(key.clone());
                        this.env.clipboard = Some(value);
                        this.env.clipboard_copy += 1;
                        this.clear_clipboard_later(this.env.clipboard_copy, cx);
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

    fn clear_clipboard_later(&mut self, copy: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REVEAL_FOR).await;
            let _ = this.update(cx, |this, cx| {
                // Only the copy this timer was started for: a later copy,
                // even of the same value, restarts the time with its own.
                if this.env.clipboard_copy == copy {
                    this.clear_owned_clipboard(cx);
                }
                this.env.copied = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// Clear the clipboard if it still holds the value the app put there,
    /// never what the user copied since. Runs after `REVEAL_FOR` and on quit.
    pub(crate) fn clear_owned_clipboard(&mut self, cx: &mut Context<Self>) {
        let Some(value) = self.env.clipboard.take() else {
            return;
        };
        let still = cx
            .read_from_clipboard()
            .and_then(|item| item.text())
            .is_some_and(|text| text == value.expose());
        if still {
            cx.write_to_clipboard(ClipboardItem::new_string(String::new()));
        }
    }

    /// Open the editor for `row`, or for a new variable. A plaintext value
    /// starts filled in; a secret starts empty (the new value is typed, the
    /// old one is never put in the field).
    pub(crate) fn open_env_edit(
        &mut self,
        row: Option<&EnvRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let secret = row.is_some_and(EnvRow::is_secret);
        let mut current = row.and_then(|r| match self.env.value(&self.value_key(r)) {
            ValueState::Plain(v) if !secret => Some(v.expose().to_owned()),
            _ => None,
        });
        // An existing plaintext value the listing has not read (still
        // loading, failed, or past PLAIN_VALUES_MAX): read it before Save
        // is allowed. A missing required name has no value to keep.
        let unread = row.filter(|r| !secret && !r.missing && current.is_none());
        let mut read_error = None;
        if let Some(r) = unread.filter(|_| !self.live)
            && let Some((root, native)) = self.selected_root()
        {
            match self
                .source
                .env_value(&root, native, &self.row_target(r), &r.key)
            {
                Ok(v) => current = Some(v.expose().to_owned()),
                Err(_) => read_error = Some(UNREAD_ERROR.to_owned()),
            }
        }
        let ready = current.is_some() || unread.is_none();
        let value = cx.new(|cx| {
            let mut state = InputState::new(window, cx)
                .masked(secret)
                .placeholder(if secret {
                    "New secret value"
                } else if ready {
                    "Value"
                } else {
                    "Reading the current value…"
                });
            if let Some(current) = current {
                state.set_value(current, window, cx);
            }
            state
        });
        let name = row
            .is_none()
            .then(|| cx.new(|cx| InputState::new(window, cx).placeholder("NAME")));
        self.env_edit = Some(EnvEdit {
            key: row.map(|r| r.key.clone()),
            secret,
            // An existing row is written where it lives (a global row
            // shown in a service listing stays global); a missing required
            // name has no scope yet and takes the listing's.
            scope: row
                .and_then(|r| r.write_scope().ok())
                .filter(|s| s != "unknown"),
            blocked: row.and_then(EnvRow::write_blocked),
            local: row.is_some_and(EnvRow::is_local_layer),
            id: {
                self.env_edit_seq += 1;
                self.env_edit_seq
            },
            name,
            value,
            busy: false,
            error: row.and_then(EnvRow::write_blocked).or(read_error),
            ready,
        });
        self.env_saved = None;
        if let Some(r) = unread.filter(|_| self.live && !ready) {
            self.read_edit_value(r.clone(), window, cx);
        }
        cx.notify();
    }

    /// Fill the open editor with the row's current value, read for this one
    /// name. Only that editor: one opened since is left alone.
    fn read_edit_value(&mut self, row: EnvRow, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((root, native)), Some(editor)) =
            (self.selected_root(), self.env_edit.as_ref().map(|e| e.id))
        else {
            return;
        };
        let target = self.row_target(&row);
        let source = self.source.clone();
        cx.spawn_in(window, async move |this, cx| {
            let key = row.key.clone();
            let result = cx
                .background_executor()
                .spawn(async move { source.env_value(&root, native, &target, &key) })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(edit) = this.env_edit.as_mut().filter(|e| e.id == editor) else {
                    return;
                };
                match result {
                    Ok(value) => {
                        // Text typed while reading is the user's new value:
                        // keep it, and fill only an empty field.
                        let typed = !edit.value.read(cx).value().is_empty();
                        let text = value.expose().to_owned();
                        edit.value.update(cx, |state, cx| {
                            if !typed {
                                state.set_value(text, window, cx);
                            }
                            state.set_placeholder("Value", window, cx);
                        });
                        edit.ready = true;
                    }
                    Err(_) => edit.error = Some(UNREAD_ERROR.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// A new variable only: store it encrypted or as plaintext.
    pub(crate) fn toggle_env_edit_secret(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self
            .env_edit
            .as_mut()
            .filter(|e| e.key.is_none() && !e.busy)
        else {
            return;
        };
        edit.secret = !edit.secret;
        let masked = edit.secret;
        edit.value
            .update(cx, |state, cx| state.set_masked(masked, window, cx));
        cx.notify();
    }

    pub(crate) fn cancel_env_edit(&mut self, cx: &mut Context<Self>) {
        self.env_edit = None;
        cx.notify();
    }

    /// Where a write goes, always named explicitly (never the CLI's
    /// default): the overlay tab shown, and the row's own scope, else the
    /// scope listed, else `global`.
    fn edit_target(&self, edit: &EnvEdit) -> EnvTarget {
        let listed_scope = match &self.env.view {
            EnvView::Report(r) => r.selected_scope.clone(),
            _ => None,
        };
        EnvTarget {
            env: self.env_tab_shown().or_else(|| Some("default".into())),
            scope: edit
                .scope
                .clone()
                .or_else(|| self.env.scope.clone())
                .or(listed_scope)
                .or_else(|| Some("global".into())),
            local: edit.local,
        }
    }

    /// Save is allowed once the field holds the current value, or text the
    /// user typed. An empty field over an unread value is never saved.
    fn edit_can_save(edit: &EnvEdit, cx: &gpui_kit::App) -> bool {
        edit.blocked.is_none() && (edit.ready || !edit.value.read(cx).value().is_empty())
    }

    fn edit_name(edit: &EnvEdit, cx: &gpui_kit::App) -> String {
        match (&edit.key, &edit.name) {
            (Some(key), _) => key.clone(),
            (None, Some(name)) => name.read(cx).value().trim().to_owned(),
            (None, None) => String::new(),
        }
    }

    /// The exact command Save runs (without the checkout path and never
    /// the value), or why it cannot run.
    pub(crate) fn env_edit_command(&self, cx: &gpui_kit::App) -> Result<String, String> {
        let edit = self.env_edit.as_ref().ok_or("No edit open")?;
        let name = Self::edit_name(edit, cx);
        if name.is_empty() {
            return Err("Type a name".into());
        }
        hack_desktop_core::source::env_set_command(&self.edit_target(edit), &name, edit.secret)
    }

    /// Hand the value to the CLI on stdin, then list again.
    pub(crate) fn save_env_edit(&mut self, cx: &mut Context<Self>) {
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let Some(edit) = self
            .env_edit
            .as_ref()
            .filter(|e| !e.busy && Self::edit_can_save(e, cx))
        else {
            return;
        };
        let name = Self::edit_name(edit, cx);
        if let Err(why) = self.env_edit_command(cx) {
            if let Some(edit) = self.env_edit.as_mut() {
                edit.error = Some(why);
            }
            cx.notify();
            return;
        }
        let target = self.edit_target(edit);
        let secret = edit.secret;
        let editor = edit.id;
        let value = Revealed::new(edit.value.read(cx).value().to_string());
        let project = root.clone();
        // Bound to the CLI chosen now: a switch before the write runs does
        // not move it to another CLI, and a completion after a switch does
        // not land in the new CLI's listing.
        let epoch = self.model.source_epoch();
        let pinned = self.source.pinned().unwrap_or_else(|| self.source.clone());
        if let Some(edit) = self.env_edit.as_mut() {
            edit.busy = true;
            edit.error = None;
        }
        let label = name.clone();
        let done = move |this: &mut Self, result: Result<(), String>, cx: &mut Context<Self>| {
            this.finish_env_save(&project, epoch, editor, &label, result, cx);
        };
        if !self.live {
            let result = pinned.env_set(&root, native, &target, &name, secret, &value);
            done(self, result, cx);
            return;
        }
        let source = pinned;
        let key = name.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.env_set(&root, native, &target, &key, secret, &value) })
                .await;
            let _ = this.update(cx, |this, cx| done(this, result, cx));
        })
        .detach();
        cx.notify();
    }

    /// A write finished. Another project or another CLI meanwhile: show
    /// nothing over it.
    /// Only the editor that started it (`editor`) is closed or given the
    /// error: one opened since (after Cancel) keeps its input, and its own
    /// write still completes even if this one listed again first (listing
    /// generations do not gate writes).
    pub(crate) fn finish_env_save(
        &mut self,
        project: &std::path::Path,
        epoch: u64,
        editor: u64,
        label: &str,
        result: Result<(), String>,
        cx: &mut Context<Self>,
    ) {
        if self.model.source_epoch() != epoch
            || self.selected_root().map(|(root, _)| root).as_deref() != Some(project)
        {
            return;
        }
        let own = self.env_edit.as_ref().is_some_and(|e| e.id == editor);
        match result {
            Ok(()) => {
                if own {
                    self.env_edit = None;
                }
                self.env_saved = Some(format!("Saved {label}"));
                self.read_env(cx);
            }
            Err(e) if own => {
                if let Some(edit) = self.env_edit.as_mut() {
                    edit.busy = false;
                    edit.error = Some(e);
                }
            }
            Err(_) => {}
        }
        cx.notify();
    }

    /// The editor: name (new only), value, Secret (new only), Save, Cancel,
    /// and the command Save runs.
    fn env_editor(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let edit = self.env_edit.as_ref()?;
        let p = ui.p;
        let field = |input: &Entity<InputState>| {
            div()
                .h(px(26.))
                .px(space::S3)
                .flex()
                .items_center()
                .rounded(radius::CONTROL)
                .bg(p.surface)
                .hairline(p.border_strong)
                .font_family(ui.mono.clone())
                .child(Input::new(input).appearance(false).small())
        };
        let mut row = div().flex().items_center().gap(space::S3);
        match (&edit.key, &edit.name) {
            (Some(key), _) => {
                row = row.child(
                    div()
                        .w(px(220.))
                        .flex_none()
                        .truncate()
                        .font_family(ui.mono.clone())
                        .type_step(text::MONO)
                        .child(key.clone()),
                );
            }
            (None, Some(name)) => row = row.child(div().w(px(220.)).flex_none().child(field(name))),
            (None, None) => {}
        }
        row = row.child(div().flex_1().min_w_0().child(field(&edit.value)));
        if edit.key.is_none() {
            row = row.child(
                div()
                    .id("env-edit-secret")
                    .px(space::S3)
                    .py(px(1.))
                    .rounded(radius::CONTROL)
                    .cursor_pointer()
                    .type_step(text::SMALL)
                    .text_color(if edit.secret {
                        p.text_primary
                    } else {
                        p.text_muted
                    })
                    .when(edit.secret, |d| d.bg(p.surface_1))
                    .child(if edit.secret { "Secret ✓" } else { "Secret" })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_env_edit_secret(window, cx);
                    })),
            );
        }
        row = row
            .child(
                hack_desktop_ui::components::action_button(
                    "env-edit-save",
                    Glyph::Check,
                    if edit.busy { "Saving…" } else { "Save" },
                    !edit.busy && Self::edit_can_save(edit, cx),
                    ui,
                )
                .on_click(cx.listener(|this, _, _, cx| this.save_env_edit(cx))),
            )
            .child(
                hack_desktop_ui::components::action_button(
                    "env-edit-cancel",
                    Glyph::Close,
                    "Cancel",
                    true,
                    ui,
                )
                .on_click(cx.listener(|this, _, _, cx| this.cancel_env_edit(cx))),
            );
        let command = self.env_edit_command(cx);
        let mut block = div()
            .id("env-editor")
            .flex()
            .flex_col()
            .gap(space::S2)
            .p(space::S3)
            .rounded(radius::PANEL)
            .bg(p.surface_1)
            .child(row);
        if let Ok(command) = &command {
            block = block.child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .font_family(ui.mono.clone())
                    .child(format!("Runs: {command}")),
            );
        }
        if let Some(error) = &edit.error {
            block = block.child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.states.failed.fg)
                    .child(error.clone()),
            );
        }
        Some(block.into_any_element())
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
        // Creating an overlay needs the CLI (R27); listing every overlay
        // needs R24. Shown, not hidden, so the gap is visible.
        let needs_cli = |id: &'static str, label: &'static str, why: &'static str| {
            div()
                .id(id)
                .h(size::CONTROL)
                .px(space::S4)
                .flex()
                .items_center()
                .rounded(radius::CONTROL)
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(label)
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(why).build(window, cx)
                })
        };
        tabs = tabs.child(needs_cli(
            "env-add-overlay",
            "+ Overlay",
            "Needs the CLI: creating an overlay (R27) and listing every overlay (R24)",
        ));
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .child(tabs)
                .child(div().flex_1())
                .child(scopes),
        );

        // The key line (what the CLI reports about the key), and + Variable.
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
            if !ok {
                // Supplying a key source needs the CLI (R26).
                for (id, label) in [
                    ("env-key-file", "Choose key file"),
                    ("env-key-env", "Use env var"),
                ] {
                    key_row = key_row.child(needs_cli(
                        id,
                        label,
                        "Needs the CLI: choosing the key source for a run (R26)",
                    ));
                }
            }
        }
        key_row = key_row.child(div().flex_1());
        if let Some(saved) = &self.env_saved {
            key_row = key_row.child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .child(saved.clone()),
            );
        }
        key_row = key_row.child(
            hack_desktop_ui::components::action_button(
                "env-add-variable",
                Glyph::Plus,
                "Variable",
                self.env_edit.is_none(),
                ui,
            )
            .on_click(cx.listener(|this, _, window, cx| {
                if this.env_edit.is_none() {
                    this.open_env_edit(None, window, cx);
                }
            })),
        );
        body = body.child(key_row);
        if let Some(editor) = self.env_editor(ui, cx) {
            body = body.child(editor);
        }

        if report.vars.is_empty() {
            return body.child(line(report.empty_label().to_owned()));
        }

        // Name, Value, actions.
        let name_w = px(260.);
        let actions_w = px(84.);
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
            // Edit: a secret needs the key to be stored encrypted.
            if !(secret && locked) && self.env_edit.is_none() {
                let r = row.clone();
                actions = actions.child(
                    icon_button(
                        SharedString::from(format!("env-edit-{i}")),
                        Glyph::Pencil,
                        ui,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_env_edit(Some(&r), window, cx);
                    })),
                );
            }
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
                        a.show_env_fixture("env-overlays", window, cx);
                        a
                    })
                })
            })
            .expect("open a headless window");
        (cx, app)
    }

    fn app_window() -> (
        HeadlessAppContext,
        gpui_kit::AnyWindowHandle,
        gpui_kit::Entity<HackApp>,
    ) {
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
        let (window, app) = cx
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
                        a.show_env_fixture("env-overlays", window, cx);
                        a
                    })
                })
            })
            .expect("open a headless window");
        (cx, window, app)
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
    fn quitting_clears_a_copied_secret_but_never_what_was_copied_since() {
        let (mut cx, app) = app();
        let secret = row(&mut cx, &app, "DATABASE_URL");
        cx.update(|cx| app.update(cx, |a, cx| a.copy_value(&secret, cx)));
        cx.update(|cx| app.update(cx, |a, cx| a.clear_owned_clipboard(cx)));
        let text = cx.update(|cx| cx.read_from_clipboard().and_then(|i| i.text()));
        assert!(
            text.as_deref().unwrap_or_default().is_empty(),
            "the secret is gone"
        );
        // The user copies something else after the secret.
        cx.update(|cx| app.update(cx, |a, cx| a.copy_value(&secret, cx)));
        cx.update(|cx| {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("user text".into()));
        });
        cx.update(|cx| app.update(cx, |a, cx| a.clear_owned_clipboard(cx)));
        let text = cx.update(|cx| cx.read_from_clipboard().and_then(|i| i.text()));
        assert_eq!(text.as_deref(), Some("user text"));
    }

    #[test]
    fn copying_again_restarts_the_clipboard_time() {
        let (mut cx, app) = app();
        let secret = row(&mut cx, &app, "DATABASE_URL");
        cx.update(|cx| app.update(cx, |a, cx| a.copy_value(&secret, cx)));
        let first = cx.update(|cx| app.read(cx).env.clipboard_copy);
        cx.update(|cx| app.update(cx, |a, cx| a.copy_value(&secret, cx)));
        let second = cx.update(|cx| app.read(cx).env.clipboard_copy);
        assert_ne!(first, second, "the first copy's timer no longer matches");
        assert!(cx.update(|cx| app.read(cx).env.clipboard.is_some()));
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

    #[test]
    fn editing_a_secret_names_overlay_and_scope_and_starts_empty() {
        let (mut cx, window, app) = app_window();
        let secret = row(&mut cx, &app, "API_TOKEN");
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&secret), window, cx));
        })
        .unwrap();
        let (command, value) = cx.update(|cx| {
            let a = app.read(cx);
            let edit = a.env_edit.as_ref().expect("editor open");
            (
                a.env_edit_command(cx),
                edit.value.read(cx).value().to_string(),
            )
        });
        assert_eq!(
            command.unwrap(),
            "hack env add API_TOKEN --secret --value-stdin --env staging --service api"
        );
        assert!(value.is_empty(), "the old secret never goes in the field");
        // Another overlay closes the editor.
        cx.update(|cx| app.update(cx, |a, cx| a.select_overlay("dev".into(), cx)));
        assert!(cx.update(|cx| app.read(cx).env_edit.is_none()));
    }

    #[test]
    fn editing_plaintext_starts_with_its_value_in_its_own_scope() {
        let (mut cx, window, app) = app_window();
        let plain = row(&mut cx, &app, "APP_MODE");
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&plain), window, cx));
        })
        .unwrap();
        let (command, value) = cx.update(|cx| {
            let a = app.read(cx);
            let edit = a.env_edit.as_ref().unwrap();
            (
                a.env_edit_command(cx).unwrap(),
                edit.value.read(cx).value().to_string(),
            )
        });
        assert_eq!(value, "fake-app-mode-value");
        assert_eq!(
            command,
            "hack env add APP_MODE --value-stdin --env staging --service global"
        );
    }

    #[test]
    fn a_new_variable_saves_or_keeps_the_editor_with_the_reason() {
        let (mut cx, window, app) = app_window();
        let type_in = |cx: &mut HeadlessAppContext, name: &str, value: &str| {
            let (name, value) = (name.to_owned(), value.to_owned());
            cx.update_window(window, |_, window, cx| {
                app.update(cx, |a, cx| {
                    let edit = a.env_edit.as_ref().unwrap();
                    let (n, v) = (edit.name.clone().unwrap(), edit.value.clone());
                    n.update(cx, |s, cx| s.set_value(name, window, cx));
                    v.update(cx, |s, cx| s.set_value(value, window, cx));
                });
            })
            .unwrap();
        };
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(None, window, cx));
        })
        .unwrap();
        // A name the CLI would not take: refused before anything runs.
        type_in(&mut cx, "--bad name", "fake");
        cx.update(|cx| app.update(cx, |a, cx| a.save_env_edit(cx)));
        let error = cx.update(|cx| app.read(cx).env_edit.as_ref().and_then(|e| e.error.clone()));
        assert!(error.is_some(), "the editor stays, with the reason");
        type_in(&mut cx, "NEW_FLAG", "fake-new-value");
        cx.update(|cx| app.update(cx, |a, cx| a.save_env_edit(cx)));
        let (open, saved) = cx.update(|cx| {
            let a = app.read(cx);
            (a.env_edit.is_some(), a.env_saved.clone())
        });
        assert!(!open);
        assert_eq!(saved.as_deref(), Some("Saved NEW_FLAG"));
    }

    #[test]
    fn a_row_from_a_local_layer_is_written_there() {
        let (mut cx, window, app) = app_window();
        let mut local = row(&mut cx, &app, "APP_MODE");
        local.layer = Some(".hack/hack.env.staging.local.yaml".into());
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&local), window, cx));
        })
        .unwrap();
        let command = cx.update(|cx| app.read(cx).env_edit_command(cx).unwrap());
        assert_eq!(
            command,
            "hack env add APP_MODE --value-stdin --local --env staging --service global"
        );
    }

    #[test]
    fn an_old_write_never_touches_an_editor_opened_since() {
        let (mut cx, window, app) = app_window();
        let open = |cx: &mut HeadlessAppContext| {
            cx.update_window(window, |_, window, cx| {
                app.update(cx, |a, cx| a.open_env_edit(None, window, cx));
            })
            .unwrap();
            cx.update(|cx| app.read(cx).env_edit.as_ref().unwrap().id)
        };
        let first = open(&mut cx);
        let project = cx.update(|cx| app.read(cx).selected_root().unwrap().0);
        let epoch = cx.update(|cx| app.read(cx).model.source_epoch());
        cx.update(|cx| app.update(cx, |a, cx| a.cancel_env_edit(cx)));
        let second = open(&mut cx);
        assert_ne!(first, second);
        // The first editor's write fails: the second gets no error.
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.finish_env_save(&project, epoch, first, "OLD", Err("no".into()), cx)
            });
        });
        assert!(cx.update(|cx| app.read(cx).env_edit.as_ref().unwrap().error.is_none()));
        // The first editor's write succeeds: the second stays open.
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.finish_env_save(&project, epoch, first, "OLD", Ok(()), cx)
            });
        });
        let (open_id, saved) = cx.update(|cx| {
            let a = app.read(cx);
            (a.env_edit.as_ref().map(|e| e.id), a.env_saved.clone())
        });
        assert_eq!(open_id, Some(second));
        assert_eq!(saved.as_deref(), Some("Saved OLD"));
        // The second editor's own write still completes after the first one
        // listed again (which moved the listing generation).
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.finish_env_save(&project, epoch, second, "NEW", Ok(()), cx)
            });
        });
        let (open_id, saved) = cx.update(|cx| {
            let a = app.read(cx);
            (a.env_edit.as_ref().map(|e| e.id), a.env_saved.clone())
        });
        assert_eq!(open_id, None, "B's editor closes on its own success");
        assert_eq!(saved.as_deref(), Some("Saved NEW"));
        // A write started under the previous CLI shows nothing after a switch.
        cx.update(|cx| app.update(cx, |a, _| a.model.source_changed()));
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.finish_env_save(&project, epoch, second, "STALE", Ok(()), cx)
            });
        });
        assert_ne!(
            cx.update(|cx| app.read(cx).env_saved.clone()).as_deref(),
            Some("Saved STALE")
        );
    }

    #[test]
    fn an_unread_plaintext_value_is_read_before_save_is_allowed() {
        let (mut cx, window, app) = app_window();
        // The listing has not read APP_MODE's value (past the limit, say).
        cx.update(|cx| app.update(cx, |a, _| a.env.hide_all()));
        let plain = row(&mut cx, &app, "APP_MODE");
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&plain), window, cx));
        })
        .unwrap();
        let (ready, value) = cx.update(|cx| {
            let edit = app.read(cx).env_edit.as_ref().unwrap();
            (edit.ready, edit.value.read(cx).value().to_string())
        });
        assert!(ready);
        assert_eq!(value, "fake-app-mode-value", "the current value, not empty");
        // A value that cannot be read: Save stays off and does nothing.
        let mut unknown = plain.clone();
        unknown.key = "NOT_LISTED".into();
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&unknown), window, cx));
        })
        .unwrap();
        cx.update(|cx| app.update(cx, |a, cx| a.save_env_edit(cx)));
        let (ready, busy, error, saved) = cx.update(|cx| {
            let a = app.read(cx);
            let edit = a.env_edit.as_ref().unwrap();
            (
                edit.ready,
                edit.busy,
                edit.error.clone(),
                a.env_saved.clone(),
            )
        });
        assert!(!ready && !busy && saved.is_none(), "nothing was written");
        assert!(error.unwrap().contains("Could not read the current value"));
        // Typing a new value (deliberate) allows Save; it never stores an
        // empty field over the unread value.
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| {
                let v = a.env_edit.as_ref().unwrap().value.clone();
                v.update(cx, |s, cx| s.set_value("fake-typed-value", window, cx));
            });
        })
        .unwrap();
        cx.update(|cx| app.update(cx, |a, cx| a.save_env_edit(cx)));
        assert_eq!(
            cx.update(|cx| app.read(cx).env_saved.clone()).as_deref(),
            Some("Saved NOT_LISTED")
        );
    }

    #[test]
    fn a_legacy_row_for_several_services_cannot_be_saved_and_says_why() {
        use hack_desktop_core::env::Scope;
        let (mut cx, window, app) = app_window();
        let mut legacy = row(&mut cx, &app, "APP_MODE");
        legacy.scope = Scope::Legacy(vec!["api".into(), "web".into()]);
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&legacy), window, cx));
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| {
                let v = a.env_edit.as_ref().unwrap().value.clone();
                v.update(cx, |s, cx| s.set_value("fake-typed", window, cx));
                a.save_env_edit(cx);
            });
        })
        .unwrap();
        let (busy, error, saved) = cx.update(|cx| {
            let a = app.read(cx);
            let e = a.env_edit.as_ref().unwrap();
            (e.busy, e.error.clone(), a.env_saved.clone())
        });
        assert!(!busy && saved.is_none(), "nothing was written");
        assert!(error.unwrap().contains("api, web"));
    }

    #[test]
    fn a_value_mirrored_into_the_backend_cannot_be_saved_and_says_why() {
        // Saving it would copy the plaintext into the shared YAML (or a new
        // local file) instead of the backend it lives in.
        let (mut cx, window, app) = app_window();
        let mut mirrored = row(&mut cx, &app, "APP_MODE");
        mirrored.layer = Some("portable_backend".into());
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| a.open_env_edit(Some(&mirrored), window, cx));
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |a, cx| {
                let v = a.env_edit.as_ref().unwrap().value.clone();
                v.update(cx, |s, cx| s.set_value("fake-typed", window, cx));
                assert!(!HackApp::edit_can_save(a.env_edit.as_ref().unwrap(), cx));
                a.save_env_edit(cx);
            });
        })
        .unwrap();
        let (busy, error, saved) = cx.update(|cx| {
            let a = app.read(cx);
            let e = a.env_edit.as_ref().unwrap();
            (e.busy, e.error.clone(), a.env_saved.clone())
        });
        assert!(!busy && saved.is_none(), "nothing was written");
        assert!(error.unwrap().contains("portable_backend"));
    }
}
