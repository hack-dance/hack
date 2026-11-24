use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use gpui_kit::component::{
    button::Button,
    input::{EditorState, InputState},
    menu::{DropdownMenu as _, PopupMenuItem},
};
use gpui_kit::{
    AnyElement, ClipboardItem, Context, Entity, IntoElement, ParentElement as _, SharedString,
    Styled as _, Subscription, Task, Window, div, prelude::*, px,
};
use hack_desktop_core::{
    config::{
        ConfigChange, ConfigError, ConfigIssue, ConfigPatch, ConfigReport, ConfigSaved,
        ConfigState, ConfigTarget, ConfigValidation,
    },
    viewmodel::InstanceKey,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, icon, primary_button},
    icons::Glyph,
    tokens::{space, text},
};
use serde_json::Value;

use crate::view::HackApp;

mod forms;
mod map;
#[cfg(feature = "screenshots")]
pub(crate) mod screenshots;

pub(crate) const TAB: usize = 7;
const STATE_ACTION_WIDTH: gpui_kit::Pixels = px(136.);

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum View {
    #[default]
    Map,
    Edit,
    Env,
    Source,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum EditSection {
    Project,
    #[default]
    Routes,
    Services,
    Env,
    Worktrees,
}

#[derive(Clone, Default, PartialEq, Eq, Hash)]
struct Selection {
    cli: Option<PathBuf>,
    root: PathBuf,
    target: ConfigTarget,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SaveOperation {
    epoch: u64,
    generation: u64,
}

#[derive(Clone, Default)]
struct Draft {
    base: BTreeMap<String, String>,
    changes: BTreeMap<String, ConfigChange>,
    pending_save: Option<SaveOperation>,
    save_result: Option<Result<ConfigSaved, ConfigError>>,
}

#[derive(Default)]
pub(crate) struct ConfigPane {
    project: Option<InstanceKey>,
    project_root: PathBuf,
    selection: Selection,
    choices: Vec<(String, Selection)>,
    view: View,
    edit_section: EditSection,
    service: String,
    scope: String,
    layer: Option<String>,
    file: String,
    active_cell: Option<String>,
    report: Option<Result<ConfigReport, ConfigError>>,
    draft: Draft,
    stashed: std::collections::HashMap<Selection, Draft>,
    validation: Option<ConfigValidation>,
    error: Option<ConfigError>,
    conflict: bool,
    saved: Option<ConfigSaved>,
    loading: bool,
    save_generation: u64,
    restarting: bool,
    inputs: BTreeMap<String, (Entity<InputState>, Subscription)>,
    editor: Option<(String, Entity<EditorState>, Subscription)>,
    watch: Option<Task<()>>,
    validation_task: Option<Task<()>>,
    load_task: Option<Task<()>>,
    copies_task: Option<Task<()>>,
    pending_focus: Option<String>,
    revision: u64,
}

impl ConfigPane {
    pub(crate) fn switch_cli(&mut self, cli: Option<PathBuf>) {
        self.stash_draft();
        *self = Self {
            selection: Selection {
                cli,
                ..Selection::default()
            },
            stashed: std::mem::take(&mut self.stashed),
            save_generation: self.save_generation,
            ..Self::default()
        };
    }

    fn report(&self) -> Option<&ConfigReport> {
        self.report.as_ref()?.as_ref().ok()
    }

    fn stage(&mut self, id: String, value: Option<ConfigChange>) {
        if let Some(change) = value {
            self.draft.changes.insert(id, change);
        } else {
            self.draft.changes.remove(&id);
        }
        self.revision += 1;
        self.draft.save_result = None;
        self.saved = None;
        self.error = None;
        self.validation = None;
    }

    fn patch(&self) -> ConfigPatch {
        ConfigPatch {
            base: self.draft.base.clone(),
            changes: self.draft.changes.values().cloned().collect(),
        }
    }

    fn issues(&self) -> &[ConfigIssue] {
        if let Some(validation) = &self.validation {
            &validation.issues
        } else if let Some(error) = &self.error
            && !error.issues.is_empty()
        {
            &error.issues
        } else {
            self.report().map_or(&[], |report| report.issues.as_slice())
        }
    }

    fn can_save(&self) -> bool {
        !self.draft.changes.is_empty()
            && !self.saving()
            && !self.conflict
            && !self.loading
            && self.validation.as_ref().is_some_and(|check| check.valid)
            && self.error.is_none()
    }

    fn saving(&self) -> bool {
        self.draft.pending_save.is_some()
    }

    fn begin_save(&mut self, epoch: u64) -> SaveOperation {
        self.save_generation += 1;
        let operation = SaveOperation {
            epoch,
            generation: self.save_generation,
        };
        self.draft.pending_save = Some(operation);
        self.draft.save_result = None;
        operation
    }

    fn finish_save(
        &mut self,
        selection: &Selection,
        operation: SaveOperation,
        result: Result<ConfigSaved, ConfigError>,
    ) -> bool {
        let visible = &self.selection == selection;
        let draft = if visible {
            &mut self.draft
        } else if let Some(draft) = self.stashed.get_mut(selection) {
            draft
        } else {
            return false;
        };
        if draft.pending_save != Some(operation) {
            return false;
        }
        draft.pending_save = None;
        if result.is_ok() {
            draft.base.clear();
            draft.changes.clear();
        }
        draft.save_result = Some(result);
        visible
    }

    fn present_save(&mut self) -> bool {
        match &self.draft.save_result {
            Some(Ok(saved)) => {
                self.saved = Some(saved.clone());
                self.draft.save_result = None;
                self.validation = None;
                self.conflict = false;
                self.view = View::Map;
                self.clear_editors();
                true
            }
            Some(Err(error)) => {
                self.conflict |= error.code == "E_CONFLICT" || !error.changed.is_empty();
                self.error = Some(error.clone());
                false
            }
            None => false,
        }
    }

    fn stash_draft(&mut self) {
        if !self.draft.changes.is_empty() || self.draft.save_result.is_some() {
            self.stashed
                .insert(self.selection.clone(), std::mem::take(&mut self.draft));
        }
    }

    fn restore_draft(&mut self) {
        self.draft = self.stashed.remove(&self.selection).unwrap_or_default();
        self.present_save();
    }

    fn clear_editors(&mut self) {
        self.validation_task = None;
        self.inputs.clear();
        self.editor = None;
        self.active_cell = None;
        self.pending_focus = None;
        self.revision += 1;
    }

    fn revert_draft(&mut self) {
        self.draft.changes.clear();
        self.draft.save_result = None;
        self.error = None;
        self.validation = None;
        self.clear_editors();
    }

    fn settle_report(&mut self, report: Result<ConfigReport, ConfigError>) {
        self.loading = false;
        if let Ok(data) = &report {
            let current = data.revisions();
            if self.draft.changes.is_empty() {
                self.draft.base = current;
            } else {
                self.conflict |= self.draft.base != current;
            }
            if !data
                .services
                .iter()
                .any(|service| service.name == self.service)
            {
                self.service = data
                    .services
                    .first()
                    .map_or_else(String::new, |service| service.name.clone());
            }
            if self.scope.is_empty()
                || (self.scope != "global"
                    && self.scope != "host"
                    && !data
                        .services
                        .iter()
                        .any(|service| service.name == self.scope))
            {
                self.scope = if self.service.is_empty() {
                    "global".into()
                } else {
                    self.service.clone()
                };
            }
            if data.layer(&self.file).is_none() {
                self.file = "1".into();
            }
        }
        self.report = Some(report);
    }
}

impl HackApp {
    pub(crate) fn sync_config_tab(&mut self, cx: &mut Context<Self>) {
        if self.tab != TAB || !self.live {
            self.config.watch = None;
            return;
        }
        let Some((root, native)) = self.selected_root() else {
            return;
        };
        let key = self.model.selected_key();
        let cli = self
            .source
            .cli_choice()
            .and_then(|choice| choice.selected.map(|install| install.path));
        if native {
            self.config.stash_draft();
            self.config = ConfigPane {
                project: key,
                selection: Selection {
                    cli,
                    ..Selection::default()
                },
                stashed: std::mem::take(&mut self.config.stashed),
                save_generation: self.config.save_generation,
                ..ConfigPane::default()
            };
            return;
        }
        if self.config.project != key
            || self.config.project_root != root
            || self.config.selection.cli != cli
        {
            #[cfg(hack_terminal)]
            self.collapse_detail_terminal(cx);
            self.config.stash_draft();
            let branch = key.as_ref().and_then(|key| key.branch.clone());
            let selection = Selection {
                cli,
                root: root.clone(),
                target: ConfigTarget {
                    branch,
                    overlay: None,
                },
            };
            self.config = ConfigPane {
                project: key,
                project_root: root,
                stashed: std::mem::take(&mut self.config.stashed),
                save_generation: self.config.save_generation,
                selection,
                ..ConfigPane::default()
            };
            self.config.restore_draft();
            self.load_config(false, cx);
            self.load_config_copies(cx);
        } else if self.config.report.is_none() && !self.config.loading {
            self.load_config(false, cx);
        }
        self.watch_config(cx);
    }

    fn load_config_copies(&mut self, cx: &mut Context<Self>) {
        let root = self.config.project_root.clone();
        let cli = self.config.selection.cli.clone();
        let epoch = self.model.source_epoch();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        self.config.copies_task = Some(cx.spawn(async move |this, cx| {
            let copies = cx
                .background_executor()
                .spawn(async move { source.copies(&root, false) })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.model.source_epoch() != epoch {
                    return;
                }
                app.config.copies_task = None;
                if let Ok(report) = copies {
                    app.config.choices = report
                        .copies
                        .into_iter()
                        .map(|copy| {
                            let label = copy.branch.unwrap_or_else(|| copy.checkout.name.clone());
                            (
                                label,
                                Selection {
                                    cli: cli.clone(),
                                    root: PathBuf::from(copy.checkout.root),
                                    target: ConfigTarget {
                                        branch: copy.instance,
                                        overlay: None,
                                    },
                                },
                            )
                        })
                        .collect();
                }
                cx.notify();
            });
        }));
    }

    fn load_config(&mut self, keep: bool, cx: &mut Context<Self>) {
        let selection = self.config.selection.clone();
        if !self.live || selection.root.as_os_str().is_empty() {
            return;
        }
        if !keep {
            self.config.report = None;
        }
        self.config.loading = true;
        let epoch = self.model.source_epoch();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        self.config.load_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.config_show(&selection.root, &selection.target) })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.model.source_epoch() != epoch {
                    return;
                }
                app.config.load_task = None;
                app.config.inputs.clear();
                app.config.editor = None;
                app.config.settle_report(result);
                app.queue_config_validation(cx);
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn watch_config(&mut self, cx: &mut Context<Self>) {
        if self.config.watch.is_some() {
            return;
        }
        self.config.watch = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(4)).await;
                let Ok(request) = this.update(cx, |app, _| {
                    let pane = &app.config;
                    (app.tab == TAB
                        && app.pane == crate::doctor_view::Pane::Project
                        && !pane.loading
                        && !pane.saving()
                        && pane.load_task.is_none()
                        && !pane.conflict
                        && pane.report().is_some())
                    .then(|| {
                        (
                            pane.selection.clone(),
                            app.source.pinned().unwrap_or_else(|| app.source.clone()),
                            pane.revision,
                            app.model.source_epoch(),
                        )
                    })
                }) else {
                    break;
                };
                let Some((selection, source, revision, epoch)) = request else {
                    continue;
                };
                let target = selection.clone();
                let result = cx
                    .background_executor()
                    .spawn(async move { source.config_show(&target.root, &target.target) })
                    .await;
                if this
                    .update(cx, |app, cx| {
                        let pane = &mut app.config;
                        if app.model.source_epoch() != epoch
                            || pane.selection != selection
                            || pane.revision != revision
                            || pane.saving()
                            || pane.loading
                        {
                            return;
                        }
                        if let (Some(previous), Ok(next)) = (pane.report(), result)
                            && (previous.state != next.state
                                || previous.revisions() != next.revisions())
                        {
                            if previous.state == ConfigState::Missing {
                                pane.settle_report(Ok(next));
                                app.load_config_copies(cx);
                            } else {
                                pane.conflict = true;
                            }
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    fn select_config_target(&mut self, selection: Selection, cx: &mut Context<Self>) {
        if self.config.selection == selection || self.config.saving() || self.config.restarting {
            return;
        }
        self.config.stash_draft();
        self.config.selection = selection;
        self.config.clear_editors();
        self.config.conflict = false;
        self.config.saved = None;
        self.config.error = None;
        self.config.validation = None;
        self.config.restore_draft();
        self.load_config(false, cx);
    }

    fn reload_config(&mut self, cx: &mut Context<Self>) {
        if self.config.saving() {
            return;
        }
        self.config.draft = Draft::default();
        self.config.error = None;
        self.config.conflict = false;
        self.config.validation = None;
        self.config.clear_editors();
        self.load_config(false, cx);
        self.load_config_copies(cx);
    }

    fn stage_config(&mut self, id: String, change: Option<ConfigChange>, cx: &mut Context<Self>) {
        if self.config.loading || self.config.saving() || self.config.conflict {
            return;
        }
        self.config.stage(id, change);
        self.queue_config_validation(cx);
        cx.notify();
    }

    fn queue_config_validation(&mut self, cx: &mut Context<Self>) {
        self.config.validation_task = None;
        if !self.live
            || self.config.draft.changes.is_empty()
            || self.config.conflict
            || self.config.saving()
        {
            return;
        }
        let revision = self.config.revision;
        let epoch = self.model.source_epoch();
        let patch = self.config.patch();
        let selection = self.config.selection.clone();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        self.config.validation_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(270))
                .await;
            let result =
                cx.background_executor()
                    .spawn(async move {
                        source.config_validate(&selection.root, &selection.target, &patch)
                    })
                    .await;
            let _ = this.update(cx, |app, cx| {
                if app.model.source_epoch() != epoch || app.config.revision != revision {
                    return;
                }
                app.config.validation_task = None;
                match result {
                    Ok(check) => {
                        app.config.conflict |=
                            check.issues.iter().any(|issue| issue.code == "E_CONFLICT");
                        app.config.validation = Some(check);
                    }
                    Err(error) => app.config.error = Some(error),
                }
                cx.notify();
            });
        }));
    }

    fn save_config(&mut self, cx: &mut Context<Self>) {
        if !self.live || !self.config.can_save() {
            return;
        }
        let patch = self.config.patch();
        let selection = self.config.selection.clone();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let operation = self.config.begin_save(epoch);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let selection = selection.clone();
                    async move { source.config_apply(&selection.root, &selection.target, &patch) }
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if !app.config.finish_save(&selection, operation, result) {
                    return;
                }
                if app.config.present_save() {
                    app.load_config(true, cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn restart_config(&mut self, cx: &mut Context<Self>) {
        let Some(report) = self.config.report() else {
            return;
        };
        let Some(root) = report.checkout.as_ref().map(PathBuf::from) else {
            return;
        };
        if !self.live || self.config.restarting {
            return;
        }
        let target = ConfigTarget {
            branch: report.branch.clone(),
            overlay: self.config.selection.target.overlay.clone(),
        };
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let selection = self.config.selection.clone();
        let epoch = self.model.source_epoch();
        self.config.restarting = true;
        cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move { source.config_restart(&root, &target) })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.model.source_epoch() != epoch || app.config.selection != selection {
                    return;
                }
                app.config.restarting = false;
                if outcome.is_ok() {
                    app.config.saved = None;
                    app.refresh_now_async(cx);
                } else {
                    app.config.error = Some(ConfigError {
                        code: "E_RESTART".into(),
                        message: "Restart failed. Check the copy’s status and try again.".into(),
                        issues: vec![],
                        changed: vec![],
                    });
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn config_checkout_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        let pane = &self.config;
        let name = pane
            .choices
            .iter()
            .find(|(_, choice)| {
                choice.root == pane.selection.root
                    && choice.target.branch == pane.selection.target.branch
            })
            .map(|(name, _)| name.clone())
            .or_else(|| pane.report().and_then(|report| report.branch.clone()))
            .unwrap_or_else(|| "main".into());
        let choices = if pane.choices.is_empty() {
            vec![("main".into(), pane.selection.clone())]
        } else {
            pane.choices.clone()
        };
        let overlay = pane.selection.target.overlay.clone();
        picker(
            "config-checkout",
            format!("Viewing as   {name}"),
            choices,
            cx,
            move |app, mut selection, cx| {
                selection.target.overlay.clone_from(&overlay);
                app.select_config_target(selection, cx);
            },
        )
    }

    pub(crate) fn config_view(
        &mut self,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.model.selected_row().is_some_and(|row| row.is_native()) {
            return div()
                .px(space::S8)
                .child("Config editing is available for Compose projects.")
                .into_any_element();
        }
        let report = self.config.report().cloned();
        let overlay = report
            .as_ref()
            .and_then(|report| report.overlay.clone())
            .unwrap_or_else(|| "default".into());
        let overlays = std::iter::once("default".to_owned())
            .chain(report.iter().flat_map(|report| report.overlays.clone()))
            .map(|name| (name.clone(), name))
            .collect();
        let mut bar = div().flex().items_center().gap(space::S6).child(picker(
            "config-overlay",
            format!("Env:   {overlay}"),
            overlays,
            cx,
            |app, value, cx| {
                let mut selection = app.config.selection.clone();
                selection.target.overlay = Some(value);
                app.select_config_target(selection, cx);
            },
        ));
        for (index, (tab, name)) in [
            (View::Map, "Map"),
            (View::Edit, "Edit"),
            (View::Env, "Env layers"),
            (View::Source, "Source"),
        ]
        .into_iter()
        .enumerate()
        {
            bar = bar.child(
                config_tab(("config-view", index), name, self.config.view == tab, ui).on_click(
                    cx.listener(move |app, _, _, cx| {
                        if tab == View::Map && app.config.view == View::Map {
                            app.config.saved = None;
                        }
                        app.config.view = tab;
                        cx.notify();
                    }),
                ),
            );
        }
        bar = bar.child(div().flex_1());
        if self.config.view == View::Env
            && let Some(report) = &report
        {
            bar = bar.child(self.scope_picker(report, cx));
        } else if !self.config.draft.changes.is_empty() {
            let count = self.config.draft.changes.len();
            bar = bar.child(muted(format!("{count} {}", change_noun(count)), ui));
        }
        let body = match &self.config.report {
            Some(Err(error)) => {
                let message = error.message.clone();
                self.config_failure(message, ui, cx)
            }
            _ => match report {
                None => config_loading(ui),
                Some(report) if report.state == ConfigState::Missing => self.config_missing(ui, cx),
                Some(report) if self.config.view == View::Source => {
                    self.config_source(&report, ui, window, cx)
                }
                Some(report) if report.state == ConfigState::Invalid => {
                    self.config_invalid(&report, ui, cx)
                }
                Some(_) if self.config.saved.is_some() && self.config.view == View::Map => {
                    self.config_saved(ui, cx)
                }
                Some(report) => match self.config.view {
                    View::Map => self.config_map(&report, ui, cx),
                    View::Edit => self.config_form(&report, ui, window, cx),
                    View::Env => self.config_env_grid(&report, ui, window, cx),
                    View::Source => unreachable!(),
                },
            },
        };
        let read_only = self
            .config
            .report()
            .is_some_and(|report| report.state == ConfigState::Ready && !report.writable);
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .px(space::S8)
            .pb(space::S5)
            .gap(space::S4)
            .child(bar)
            .when(read_only, |d| {
                d.child(muted("This checkout is read-only.", ui))
            })
            .child(div().flex_1().min_h_0().flex().flex_col().child(body))
            .children(self.config_dock(ui, cx))
            .into_any_element()
    }

    fn config_dock(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pane = &self.config;
        if pane.conflict {
            return Some(
                card(ui)
                    .px(space::S4)
                    .py(space::S3)
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .child("Changed outside Hack")
                    .child(
                        action_button("config-reload", Glyph::Restart, "Reload", true, ui)
                            .on_click(cx.listener(|app, _, _, cx| app.reload_config(cx))),
                    )
                    .into_any_element(),
            );
        }
        let count = pane.draft.changes.len();
        let error = pane.error.as_ref();
        if count == 0 && error.is_none() {
            return None;
        }
        let first = pane.issues().first().cloned();
        let issue_label = first.as_ref().map(|issue| {
            if pane.view == View::Source
                && let Some(line) = issue.line
            {
                format!("Line {line} needs a fix")
            } else {
                let n = pane.issues().len();
                format!(
                    "{n} {} need{} a fix",
                    if n == 1 { "field" } else { "fields" },
                    if n == 1 { "s" } else { "" }
                )
            }
        });
        let can_save = pane.can_save();
        let saved = if can_save {
            primary_button("config-save", Glyph::Check, "Save", ui)
                .on_click(cx.listener(|app, _, _, cx| app.save_config(cx)))
        } else {
            action_button(
                "config-save",
                Glyph::Check,
                if pane.saving() { "Saving…" } else { "Save" },
                false,
                ui,
            )
        };
        Some(
            card(ui)
                .px(space::S4)
                .py(space::S3)
                .flex()
                .items_center()
                .gap(space::S3)
                .child(strong(
                    format!("{count} unsaved {}", change_noun(count)),
                    ui,
                ))
                .children(error.map(|error| warning(error.message.clone(), ui)))
                .child(div().flex_1())
                .children(first.zip(issue_label).map(|(issue, label)| {
                    warning(label, ui)
                        .id("config-jump-issue")
                        .underline()
                        .cursor_pointer()
                        .on_click(
                            cx.listener(move |app, _, _, cx| app.jump_config_issue(&issue, cx)),
                        )
                }))
                .child(
                    action_button(
                        "config-revert",
                        Glyph::Restart,
                        "Revert",
                        !pane.saving(),
                        ui,
                    )
                    .w(px(96.))
                    .on_click(cx.listener(|app, _, _, cx| {
                        if !app.config.saving() {
                            app.config.revert_draft();
                            cx.notify();
                        }
                    })),
                )
                .child(saved.w(px(96.)))
                .into_any_element(),
        )
    }

    fn config_failure(&self, message: String, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        state_card("Can’t read config", message, ui)
            .child(
                action_button("config-try", Glyph::Restart, "Reload", true, ui)
                    .on_click(cx.listener(|app, _, _, cx| app.reload_config(cx))),
            )
            .into_any_element()
    }

    fn config_invalid(&self, report: &ConfigReport, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.code == "E_CONFIG_PARSE")
            .cloned();
        let layer = issue
            .as_ref()
            .and_then(|issue| issue.layer.as_deref())
            .and_then(|id| report.layer(id));
        let title = layer.map_or_else(
            || "Can’t read config".to_owned(),
            |layer| format!("{} has a syntax error", layer.name()),
        );
        let detail = issue.as_ref().map_or_else(String::new, |issue| {
            issue.line.map_or_else(
                || issue.message.clone(),
                |line| format!("Line {line} · {}", issue.message),
            )
        });
        state_card(title, detail, ui)
            .child(
                div()
                    .flex()
                    .gap(space::S3)
                    .children(issue.map(|issue| {
                        action_button("config-error-source", Glyph::Logs, "Open source", true, ui)
                            .w(STATE_ACTION_WIDTH)
                            .justify_center()
                            .on_click(
                                cx.listener(move |app, _, _, cx| app.jump_config_issue(&issue, cx)),
                            )
                    }))
                    .children(layer.filter(|layer| layer.exists).map(|layer| {
                        self.editor_button(layer.file.clone(), ui, cx)
                            .w(STATE_ACTION_WIDTH)
                            .justify_center()
                    })),
            )
            .child(muted("Running copies keep using the last good config.", ui))
            .into_any_element()
    }

    #[cfg(hack_terminal)]
    fn run_config_init(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use hack_desktop_core::terminal::{
            CommandAvailability, CommandControl, CommandControlSize, CommandExit,
        };
        let selection = self.config.selection.clone();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let spec = match source.config_init_command() {
            Ok(spec) => spec,
            Err(message) => {
                self.config.error = Some(ConfigError {
                    message,
                    ..ConfigError::unavailable()
                });
                cx.notify();
                return;
            }
        };
        self.config.error = None;
        self.run_init_in_drawer(
            CommandControl {
                id: format!("config-init:{}", selection.root.display()),
                label: "hack init".into(),
                title: "Terminal".into(),
                availability: CommandAvailability::Ready(spec),
                size: CommandControlSize::Standard,
                cwd: Some(selection.root.clone()),
                expects_password: false,
            },
            move |app, completion, cx| {
                if completion.exit == CommandExit::Code(0) {
                    app.check_config_init(selection, source, epoch, completion.run, cx);
                }
            },
            window,
            cx,
        );
    }

    #[cfg(hack_terminal)]
    fn check_config_init(
        &mut self,
        selection: Selection,
        source: std::sync::Arc<dyn hack_desktop_core::source::Source>,
        epoch: u64,
        run: crate::command_control::CommandRunId,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |app, cx| {
            let target = selection.clone();
            let report = cx
                .background_executor()
                .spawn(async move { source.config_show(&target.root, &target.target) })
                .await;
            let _ = app.update(cx, |app, cx| {
                if app.model.source_epoch() != epoch {
                    return;
                }
                let check = match &report {
                    Ok(report) if report.state == ConfigState::Ready => Ok(()),
                    _ => Err("The checkout’s Config is still unavailable.".into()),
                };
                app.command_checked(run, check, cx);
                app.refresh_now_async(cx);
                if app.config.selection == selection && app.tab == TAB {
                    app.load_config(true, cx);
                    app.load_config_copies(cx);
                }
            });
        })
        .detach();
    }

    fn config_missing(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let can_run = cfg!(hack_terminal)
            && !self.config.selection.root.as_os_str().is_empty()
            && !self.machine.busy();
        let run = if can_run {
            primary_button("config-init", Glyph::Play, "Run", ui)
        } else {
            action_button("config-init", Glyph::Play, "Run", false, ui)
        };
        state_card(
            "This folder has no .hack config",
            "Set it up once and every worktree shares it.",
            ui,
        )
        .child(
            card(ui)
                .px(space::S3)
                .py(space::S2)
                .flex()
                .items_center()
                .gap(space::S2)
                .child(mono("hack init", ui).flex_1())
                .child(
                    run.w(px(76.))
                        .on_click(cx.listener(|_app, _, _window, _cx| {
                            #[cfg(hack_terminal)]
                            _app.run_config_init(_window, _cx);
                        })),
                )
                .child(
                    action_button("config-init-copy", Glyph::Copy, "Copy", true, ui)
                        .w(px(76.))
                        .on_click(|_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string("hack init".into()))
                        }),
                ),
        )
        .child(muted(
            "Run opens the terminal drawer and runs it there.",
            ui,
        ))
        .children(
            self.config
                .error
                .as_ref()
                .map(|error| muted(error.message.clone(), ui)),
        )
        .into_any_element()
    }

    fn config_saved(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let Some(saved) = &self.config.saved else {
            return div().into_any_element();
        };
        let detail = if saved.restart_offered {
            "This copy picks up the changes on its next restart."
        } else if saved.changed.is_empty() {
            "The files already match these settings."
        } else {
            "Env changes apply on the next start of each service."
        };
        state_card("Saved just now", detail, ui)
            .child(
                div()
                    .flex()
                    .gap(space::S3)
                    .when(saved.restart_offered, |row| {
                        row.child(
                            action_button(
                                "config-restart",
                                Glyph::Restart,
                                if self.config.restarting {
                                    "Restarting…"
                                } else {
                                    "Restart now"
                                },
                                !self.config.restarting,
                                ui,
                            )
                            .w(STATE_ACTION_WIDTH)
                            .justify_center()
                            .on_click(cx.listener(|app, _, _, cx| app.restart_config(cx))),
                        )
                    })
                    .child(
                        action_button("config-view-changes", Glyph::Eye, "View changes", true, ui)
                            .w(STATE_ACTION_WIDTH)
                            .justify_center()
                            .on_click(cx.listener(|app, _, _, cx| {
                                if let Some(id) = app
                                    .config
                                    .saved
                                    .as_ref()
                                    .and_then(|saved| saved.changed.first())
                                {
                                    app.config.file.clone_from(id);
                                }
                                app.config.view = View::Source;
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }
}

pub(crate) fn config_tab(
    id: impl Into<gpui_kit::ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
    ui: &Ui,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .relative()
        .h(px(30.))
        .flex()
        .items_center()
        .cursor_pointer()
        .type_step(if selected {
            text::BODY_STRONG
        } else {
            text::BODY
        })
        .text_color(if selected {
            ui.p.text_primary
        } else {
            ui.p.text_muted
        })
        .child(label.into())
        .when(selected, |d| {
            d.child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(px(2.))
                    .rounded(px(1.))
                    .bg(ui.p.text_primary),
            )
        })
}

fn picker<T: Clone + 'static>(
    id: &'static str,
    label: String,
    choices: Vec<(String, T)>,
    cx: &Context<HackApp>,
    select: impl Fn(&mut HackApp, T, &mut Context<HackApp>) + Clone + 'static,
) -> AnyElement {
    let view = cx.entity().downgrade();
    Button::new(id)
        .outline()
        .label(format!("{label}  ⌄"))
        .dropdown_menu(move |mut menu, _, _| {
            for (label, value) in &choices {
                let view = view.clone();
                let select = select.clone();
                let value = value.clone();
                menu = menu.item(PopupMenuItem::new(label.clone()).on_click(move |_, _, cx| {
                    let _ = view.update(cx, |app, cx| select(app, value.clone(), cx));
                }));
            }
            menu
        })
        .into_any_element()
}

fn card(ui: &Ui) -> gpui_kit::Div {
    div().border_1().border_color(ui.p.border).rounded(px(8.))
}

fn state_card(
    title: impl Into<SharedString>,
    detail: impl Into<SharedString>,
    ui: &Ui,
) -> gpui_kit::Div {
    card(ui)
        .max_w(px(480.))
        .p(space::S6)
        .flex()
        .flex_col()
        .gap(space::S4)
        .child(div().type_step(text::TITLE).child(title.into()))
        .child(div().type_step(text::BODY).child(detail.into()))
}

fn config_loading(ui: &Ui) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(muted("Reading project config…", ui))
        .children((0..5).map(|_| card(ui).h(px(46.)).w(px(230.))))
        .into_any_element()
}

fn muted(label: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .type_step(text::SMALL)
        .text_color(ui.p.text_muted)
        .child(label.into())
}

fn change_noun(count: usize) -> &'static str {
    if count == 1 { "change" } else { "changes" }
}

fn strong(label: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .type_step(text::BODY_STRONG)
        .text_color(ui.p.text_primary)
        .child(label.into())
}

fn mono(label: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .font_family(ui.mono.clone())
        .type_step(text::MONO)
        .child(label.into())
}

fn warning(label: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .type_step(text::SMALL)
        .text_color(ui.p.states.failed.fg)
        .child(icon(Glyph::CircleAlert, px(13.), ui.p.states.failed.fg))
        .child(label.into())
}

fn chip(label: impl Into<SharedString>, active: bool, ui: &Ui) -> gpui_kit::Div {
    mono(label, ui)
        .flex_shrink_0()
        .px(px(4.))
        .rounded(px(4.))
        .border_1()
        .border_color(if active {
            ui.p.text_primary
        } else {
            ui.p.border
        })
}

fn setting<'a>(project: &'a Value, key: &str) -> &'a Value {
    key.split('.').fold(project, |value, part| &value[part])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select(pane: &mut ConfigPane, selection: &Selection) {
        pane.stash_draft();
        pane.selection = selection.clone();
        pane.error = None;
        pane.restore_draft();
    }

    fn stage_name(pane: &mut ConfigPane) {
        pane.stage(
            "name".into(),
            Some(ConfigChange::Project {
                layer: "1".into(),
                path: "name".into(),
                value: Value::String("storefront".into()),
            }),
        );
    }

    #[test]
    fn a_pending_save_preserves_its_draft_and_failure_across_project_switches() {
        let mut pane = ConfigPane::default();
        let storefront = Selection {
            root: "/storefront".into(),
            ..Selection::default()
        };
        let other = Selection {
            root: "/other".into(),
            ..Selection::default()
        };
        select(&mut pane, &storefront);
        stage_name(&mut pane);
        let operation = pane.begin_save(1);

        select(&mut pane, &other);
        select(&mut pane, &storefront);
        assert!(pane.saving());
        select(&mut pane, &other);
        assert!(!pane.finish_save(&storefront, operation, Err(ConfigError::unavailable())));
        select(&mut pane, &storefront);
        assert!(!pane.saving());
        assert!(pane.draft.changes.contains_key("name"));
        assert_eq!(
            pane.error.as_ref().map(|e| e.code.as_str()),
            Some("E_UNAVAILABLE")
        );

        stage_name(&mut pane);
        let retry = pane.begin_save(1);
        let saved = ConfigSaved {
            changed: vec!["1".into()],
            restart_offered: true,
        };
        assert!(!pane.finish_save(&storefront, operation, Ok(saved.clone())));
        assert!(pane.draft.changes.contains_key("name"));
        assert!(pane.finish_save(&storefront, retry, Ok(saved)));
        assert!(pane.draft.changes.is_empty());
    }

    #[test]
    fn the_previous_cli_cannot_complete_a_new_installations_save() {
        let mut pane = ConfigPane::default();
        let first = Selection {
            cli: Some("/cli/first/hack".into()),
            ..Selection::default()
        };
        let second = Selection {
            cli: Some("/cli/second/hack".into()),
            ..Selection::default()
        };
        select(&mut pane, &first);
        stage_name(&mut pane);
        let first_save = pane.begin_save(1);

        pane.switch_cli(second.cli.clone());
        select(&mut pane, &second);
        stage_name(&mut pane);
        let second_save = pane.begin_save(2);
        assert!(!pane.finish_save(&first, first_save, Err(ConfigError::unavailable())));
        assert!(pane.saving());
        assert!(pane.draft.save_result.is_none());

        pane.switch_cli(first.cli.clone());
        select(&mut pane, &first);
        assert!(!pane.saving());
        assert!(pane.draft.changes.contains_key("name"));
        assert!(pane.error.is_some());
        assert!(!pane.finish_save(&second, second_save, Err(ConfigError::unavailable())));
    }

    #[test]
    fn reverting_a_failed_save_discards_its_error_with_the_draft() {
        let mut pane = ConfigPane::default();
        let first = pane.selection.clone();
        stage_name(&mut pane);
        let operation = pane.begin_save(1);
        assert!(pane.finish_save(&first, operation, Err(ConfigError::unavailable())));
        assert!(!pane.present_save());
        assert!(pane.error.is_some());

        pane.revert_draft();
        let other = Selection {
            root: "/other".into(),
            ..Selection::default()
        };
        select(&mut pane, &other);
        select(&mut pane, &first);
        assert!(pane.draft.changes.is_empty());
        assert!(pane.error.is_none());
    }
}
