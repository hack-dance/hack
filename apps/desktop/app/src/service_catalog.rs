use gpui_kit::component::{
    Sizable as _,
    input::{Input, InputState},
};
use std::path::PathBuf;

use gpui_kit::{ClipboardItem, Context, Entity, div, prelude::*};
use hack_desktop_core::{
    service_catalog::{CatalogEdit, Recipe, recipes},
    source::ServiceActionTarget,
    state::Action,
    viewmodel::DetailView,
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, pill_tab},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

fn search(query: &str) -> impl Iterator<Item = (usize, &'static Recipe)> + '_ {
    recipes()
        .iter()
        .enumerate()
        .filter(move |(_, recipe)| recipe.name.contains(query) || recipe.image.contains(query))
}

pub(crate) struct ServiceCatalog {
    pub(crate) input: Entity<InputState>,
    pub(crate) selected: usize,
    pub(crate) edit: Option<(EditTarget, EditState)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EditTarget {
    root: PathBuf,
    cli_epoch: u64,
    recipe: &'static str,
}

pub(crate) enum EditState {
    Pending { saving: bool },
    Preview(CatalogEdit),
    Saved(CatalogEdit),
    Failed(String),
}

impl EditState {
    fn finished(saving: bool, result: Result<CatalogEdit, String>) -> Self {
        match result {
            Ok(report) if saving && report.saved => Self::Saved(report),
            Ok(report) if !saving && !report.saved => Self::Preview(report),
            Ok(_) => Self::Failed("The CLI returned an unexpected save state.".into()),
            Err(error) => Self::Failed(error),
        }
    }
}

impl HackApp {
    pub(crate) fn show_catalog_edit_fixture(&mut self, fixture: &str) {
        let saved = match fixture {
            "catalog-diff" => false,
            "catalog-saved" => true,
            _ => return,
        };
        let Some((_, recipe)) = search("redis").next() else {
            return;
        };
        let Some(target) = self.catalog_target(recipe) else {
            return;
        };
        let report = CatalogEdit {
            file: ".hack/docker-compose.yml".into(),
            diff: "--- a/.hack/docker-compose.yml\n+++ b/.hack/docker-compose.yml\n@@ -4,0 +5,2 @@\n+  redis:\n+    image: redis:7-alpine\n".into(),
            revision: "fixture".into(),
            saved,
        };
        self.catalog.edit = Some((target, EditState::finished(saved, Ok(report))));
    }

    fn catalog_target(&self, recipe: &'static Recipe) -> Option<EditTarget> {
        let (root, native) = self.selected_root()?;
        (!native).then_some(EditTarget {
            root,
            cli_epoch: self.model.source_epoch(),
            recipe: &recipe.name,
        })
    }

    fn run_catalog_edit(
        &mut self,
        target: EditTarget,
        revision: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.machine.busy()
            || self.selected_root() != Some((target.root.clone(), false))
            || self.model.source_epoch() != target.cli_epoch
            || matches!(self.catalog.edit, Some((_, EditState::Pending { .. })))
        {
            return;
        }
        let saving = revision.is_some();
        self.catalog.edit = Some((target.clone(), EditState::Pending { saving }));
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        cx.spawn(async move |this, cx| {
            let root = target.root.clone();
            let recipe = target.recipe;
            let result = cx
                .background_executor()
                .spawn(async move { source.catalog_edit(&root, recipe, revision.as_deref()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let state = EditState::finished(saving, result);
                if matches!(state, EditState::Saved(_))
                    && this.selected_root() == Some((target.root.clone(), false))
                {
                    this.reset_changes(cx);
                    this.refresh_now_async(cx);
                }
                this.catalog.edit = Some((target, state));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn service_catalog(
        &self,
        detail: &DetailView,
        ui: &Ui,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = ui.p;
        if detail.backend != "compose" {
            return div().text_color(p.text_secondary).child(
                "This catalog previews Compose services. Add native services in the project’s authored configuration.",
            );
        }
        let query = self
            .catalog
            .input
            .read(cx)
            .value()
            .trim()
            .to_ascii_lowercase();
        let available: Vec<_> = search(&query).collect();
        let selected = available
            .iter()
            .find(|(index, _)| *index == self.catalog.selected)
            .or_else(|| available.first())
            .map(|(index, recipe)| (*index, *recipe));
        let body = div()
            .flex()
            .flex_col()
            .gap(space::S5)
            .type_step(text::BODY)
            .child(Input::new(&self.catalog.input).small());
        let Some((selected, recipe)) = selected else {
            return body.child(
                div()
                    .text_color(p.text_secondary)
                    .child("No matching images."),
            );
        };
        let options = div()
            .flex()
            .flex_wrap()
            .gap(space::S3)
            .children(available.into_iter().map(|(index, item)| {
                pill_tab(
                    ("service-image", index),
                    item.name.as_str(),
                    index == selected,
                    ui,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.catalog.selected = index;
                    cx.notify();
                }))
            }));
        let snippet = recipe.snippet();
        let target = self.catalog_target(recipe);
        let edit = self
            .catalog
            .edit
            .as_ref()
            .and_then(|(saved_target, state)| {
                (Some(saved_target) == target.as_ref()).then_some(state)
            });
        let pending = matches!(self.catalog.edit, Some((_, EditState::Pending { .. })));
        let editable = target.is_some()
            && !pending
            && !self.machine.busy()
            && self.model.can_start(&detail.key);
        let (preview, status, action) = match edit {
            Some(EditState::Preview(report)) => {
                let mut save = action_button(
                    "save-catalog-service",
                    Glyph::Check,
                    "Save to project",
                    editable,
                    ui,
                );
                if let Some(target) = target.clone().filter(|_| editable) {
                    let revision = report.revision.clone();
                    save = save.on_click(cx.listener(move |this, _, _, cx| {
                        this.run_catalog_edit(target.clone(), Some(revision.clone()), cx);
                    }));
                }
                (
                    report.diff.clone(),
                    Some("Review the Compose change before saving.".into()),
                    save,
                )
            }
            Some(EditState::Saved(report)) => {
                let can_start = editable
                    && self
                        .model
                        .snapshot()
                        .is_some_and(|s| !s.projects.engine_down());
                let mut start = action_button(
                    "start-catalog-service",
                    Glyph::Play,
                    format!("Start {}", recipe.name),
                    can_start,
                    ui,
                );
                if can_start {
                    start = start.on_click(cx.listener(move |this, _, _, cx| {
                        this.run_scoped_action(
                            Action::Start,
                            Some(ServiceActionTarget {
                                name: recipe.name.clone(),
                                compose_project: None,
                                containers: Vec::new(),
                            }),
                            cx,
                        );
                    }));
                }
                (
                    snippet.clone(),
                    Some(format!("Saved locally — not committed · {}", report.file)),
                    start,
                )
            }
            _ => {
                let status = match edit {
                    Some(EditState::Pending { saving: true }) => {
                        Some("Saving Compose change…".into())
                    }
                    Some(EditState::Pending { saving: false }) => {
                        Some("Preparing Compose diff…".into())
                    }
                    Some(EditState::Failed(error)) => Some(error.clone()),
                    _ => None,
                };
                let mut add = action_button(
                    "add-catalog-service",
                    Glyph::Plus,
                    "Add to project",
                    editable,
                    ui,
                );
                if let Some(target) = target.filter(|_| editable) {
                    add = add.on_click(cx.listener(move |this, _, _, cx| {
                        this.run_catalog_edit(target.clone(), None, cx);
                    }));
                }
                (snippet.clone(), status, add)
            }
        };
        body.child(options)
            .children(status.map(|text| div().text_color(p.text_secondary).child(text)))
            .when(!recipe.env_names.is_empty(), |body| {
                body.child(div().text_color(p.text_secondary).child(format!(
                    "Set {} in Env under the {} service scope before starting.",
                    recipe.env_names.join(", "),
                    recipe.name
                )))
            })
            .child(
                div()
                    .px(space::S5)
                    .py(space::S4)
                    .bg(p.surface_1)
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .children(preview.lines().map(|line| div().child(line.to_owned()))),
            )
            .child(
                div()
                    .flex()
                    .gap(space::S4)
                    .items_center()
                    .child(action)
                    .child(
                        action_button(
                            "copy-service-snippet",
                            Glyph::Copy,
                            "Copy snippet",
                            true,
                            ui,
                        )
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(snippet.clone()));
                        })),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_includes_image_aliases() {
        let (_, mongo) = search("mongo").next().unwrap();
        assert_eq!(mongo.name, "mongodb");
        assert!(search("unlisted").next().is_none());
        assert_eq!(search("").count(), 6);
    }
    #[test]
    fn credential_snippets_match_the_compose_fixture() {
        let mut yaml = String::from("services:\n");
        for recipe in recipes()
            .iter()
            .filter(|recipe| !recipe.env_names.is_empty())
        {
            yaml.push_str(&recipe.snippet());
            yaml.push('\n');
        }
        assert_eq!(yaml, include_str!("../fixtures/catalog-credentials.yaml"));
    }
    #[test]
    fn only_a_confirmed_save_unlocks_start() {
        let mut preview = CatalogEdit {
            file: ".hack/docker-compose.yml".into(),
            diff: "+  redis:".into(),
            revision: "preview-revision".into(),
            saved: false,
        };
        assert!(
            matches!(EditState::finished(false, Ok(preview.clone())), EditState::Preview(report) if report.revision == "preview-revision")
        );
        assert!(matches!(
            EditState::finished(true, Ok(preview.clone())),
            EditState::Failed(_)
        ));
        preview.saved = true;
        assert!(matches!(
            EditState::finished(false, Ok(preview.clone())),
            EditState::Failed(_)
        ));
        assert!(
            matches!(EditState::finished(true, Ok(preview)), EditState::Saved(report) if report.file == ".hack/docker-compose.yml")
        );
        assert!(matches!(
            EditState::finished(true, Err("Compose file changed".into())),
            EditState::Failed(_)
        ));
    }
}
