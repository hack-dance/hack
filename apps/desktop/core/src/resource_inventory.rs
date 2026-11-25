//! Versioned machine-wide resource observation and removal preview.

use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    pub rows: Vec<Resource>,
    pub compose_complete: bool,
    pub native_complete: bool,
}

#[derive(Clone, Deserialize)]
pub struct Resource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub backend: String,
    pub owners: Vec<ResourceOwner>,
    pub bytes: Option<u64>,
    pub state: Option<String>,
    #[serde(default)]
    pub labels: std::collections::BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub mounts: Vec<ResourceMount>,
    pub ports: Option<String>,
    pub refusal: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct ResourceOwner {
    pub project: String,
    pub checkout: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
}

#[derive(Clone, Deserialize)]
pub struct ResourceMount {
    pub name: Option<String>,
    pub destination: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Deserialize)]
pub struct RemovalPlan {
    pub id: String,
    pub message: String,
    pub token: String,
    pub removed: bool,
}

#[must_use]
pub fn fixture() -> InventoryReport {
    serde_json::from_str(include_str!("../tests/fixtures/resource-inventory.json"))
        .expect("valid resource inventory fixture")
}
