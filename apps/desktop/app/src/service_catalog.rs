use gpui_kit::component::{
    Sizable as _,
    input::{Input, InputState},
};
use gpui_kit::{ClipboardItem, Context, Entity, div, prelude::*};
use hack_desktop_core::{state::Action, viewmodel::DetailView};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, pill_tab},
    icons::Glyph,
    tokens::{space, text},
};

use crate::view::HackApp;

struct Recipe {
    name: &'static str,
    image: &'static str,
    command: Option<&'static str>,
    env_names: &'static [&'static str],
}

impl Recipe {
    fn snippet(&self) -> String {
        let mut yaml = format!("  {}:\n    image: {}", self.name, self.image);
        if let Some(command) = self.command {
            yaml.push_str(&format!("\n    command: {command}"));
        }
        if !self.env_names.is_empty() {
            yaml.push_str("\n    environment:");
            for name in self.env_names {
                // Hack supplies service-scoped values in its generated override.
                yaml.push_str(&format!("\n      {name}: null"));
            }
        }
        yaml
    }
}

const RECIPES: &[Recipe] = &[
    Recipe {
        name: "redis",
        image: "redis:7-alpine",
        command: None,
        env_names: &[],
    },
    Recipe {
        name: "postgres",
        image: "postgres:17-alpine",
        command: None,
        env_names: &["POSTGRES_PASSWORD"],
    },
    Recipe {
        name: "mysql",
        image: "mysql:8.4",
        command: None,
        env_names: &["MYSQL_ROOT_PASSWORD"],
    },
    Recipe {
        name: "mongodb",
        image: "mongo:8",
        command: None,
        env_names: &[],
    },
    Recipe {
        name: "minio",
        image: "minio/minio",
        command: Some("server /data"),
        env_names: &["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"],
    },
    Recipe {
        name: "mailpit",
        image: "axllent/mailpit",
        command: None,
        env_names: &[],
    },
];

fn search(query: &str) -> impl Iterator<Item = (usize, &'static Recipe)> + '_ {
    RECIPES
        .iter()
        .enumerate()
        .filter(move |(_, recipe)| recipe.name.contains(query) || recipe.image.contains(query))
}

pub(crate) struct ServiceCatalog {
    pub(crate) input: Entity<InputState>,
    pub(crate) selected: usize,
}

impl HackApp {
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
                pill_tab(("service-image", index), item.name, index == selected, ui).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.catalog.selected = index;
                        cx.notify();
                    }),
                )
            }));
        let snippet = recipe.snippet();
        let preview = snippet.clone();
        let can_start = !self.machine.busy()
            && self.selected_root().is_some()
            && self.model.can_start(&detail.key)
            && self
                .model
                .snapshot()
                .is_some_and(|s| !s.projects.engine_down());
        let mut start = action_button(
            "start-catalog-project",
            Glyph::Play,
            "Start project",
            can_start,
            ui,
        );
        if can_start {
            start =
                start.on_click(cx.listener(|this, _, _, cx| this.run_action(Action::Start, cx)));
        }
        body.child(options)
            .child(
                div().text_color(p.text_secondary)
                    .child("Add this entry under services: in your Compose file, then start the project. The Hack CLI does not edit services yet."),
            )
            .when(!recipe.env_names.is_empty(), |body| {
                body.child(div().text_color(p.text_secondary).child(format!(
                    "Set the listed variables in Env under the {} service scope before starting.",
                    recipe.name
                )))
            })
            .child(
                div().px(space::S5).py(space::S4).bg(p.surface_1)
                    .font_family(ui.mono.clone()).type_step(text::MONO)
                    .children(preview.lines().map(|line| div().child(line.to_owned()))),
            )
            .child(
                div().flex().gap(space::S4).items_center()
                    .child(action_button("copy-service-snippet", Glyph::Copy, "Copy snippet", true, ui)
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(snippet.clone()));
                        })))
                    .child(start),
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
        for recipe in RECIPES.iter().filter(|recipe| !recipe.env_names.is_empty()) {
            yaml.push_str(&recipe.snippet());
            yaml.push('\n');
        }
        assert_eq!(yaml, include_str!("../fixtures/catalog-credentials.yaml"));
    }
}
