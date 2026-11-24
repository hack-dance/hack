//! Shared catalog recipes and the CLI service-add result.

use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Recipe {
    pub name: String,
    pub image: String,
    pub command: Option<String>,
    pub env_names: Vec<String>,
}

impl Recipe {
    #[must_use]
    pub fn snippet(&self) -> String {
        let mut yaml = format!("  {}:\n    image: {}", self.name, self.image);
        if let Some(command) = &self.command {
            yaml.push_str(&format!("\n    command: {command}"));
        }
        if !self.env_names.is_empty() {
            yaml.push_str("\n    environment:");
            for name in &self.env_names {
                yaml.push_str(&format!("\n      {name}: null"));
            }
        }
        yaml
    }
}

#[must_use]
pub fn recipes() -> &'static [Recipe] {
    static RECIPES: OnceLock<Vec<Recipe>> = OnceLock::new();
    RECIPES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../src/lib/service-catalog.json"))
            .expect("the bundled catalog must match the recipe schema")
    })
}

#[derive(Clone, Debug, Deserialize)]
pub struct CatalogEdit {
    pub file: String,
    pub diff: String,
    pub revision: String,
    pub saved: bool,
}
