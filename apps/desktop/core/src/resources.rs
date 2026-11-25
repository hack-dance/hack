//! Inventory attributable to the current CLI and daemon observations.

use crate::{
    models::ProjectsPayload,
    viewmodel::{InstanceKey, instance_runtimes},
};
use std::collections::BTreeSet;

#[derive(Debug, PartialEq, Eq)]
pub struct ResourceGroup {
    pub key: InstanceKey,
    pub native: bool,
    pub containers: Vec<ObservedContainer>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ObservedContainer {
    pub name: String,
    pub id: Option<String>,
    pub state: String,
    pub image: Option<String>,
    pub volumes: BTreeSet<String>,
    pub networks: BTreeSet<String>,
}

#[must_use]
pub fn inventory(projects: &ProjectsPayload) -> Vec<ResourceGroup> {
    let mut groups = Vec::new();
    for project in projects
        .projects
        .iter()
        .filter(|row| row.kind.as_deref() != Some("unregistered"))
    {
        if project.is_native() {
            if let Some(ps) = project.native.as_ref().filter(|_| !project.native_pending) {
                let containers = ps
                    .items
                    .iter()
                    .filter_map(|item| {
                        let id = item.container_id.clone()?;
                        Some(ObservedContainer {
                            name: item.service.clone(),
                            id: Some(id),
                            state: item.state.clone(),
                            image: None,
                            volumes: BTreeSet::new(),
                            networks: BTreeSet::new(),
                        })
                    })
                    .collect::<Vec<_>>();
                if !containers.is_empty() {
                    groups.push(ResourceGroup {
                        key: InstanceKey::project(project.name.clone()),
                        native: true,
                        containers,
                    });
                }
            }
            continue;
        }
        if projects.engine_down() {
            continue;
        }
        for (key, runtime) in instance_runtimes(project) {
            let containers = runtime
                .services
                .iter()
                .flat_map(|service| {
                    service.containers.iter().map(|c| ObservedContainer {
                        name: c.name.clone().unwrap_or_else(|| service.service.clone()),
                        id: c.id.clone(),
                        state: c.state.clone(),
                        image: c.image.clone(),
                        volumes: c
                            .mounts
                            .iter()
                            .filter(|m| m.kind == "volume")
                            .filter_map(|m| m.name.clone())
                            .collect(),
                        networks: c.networks.iter().map(|n| n.name.clone()).collect(),
                    })
                })
                .collect::<Vec<_>>();
            if !containers.is_empty() {
                groups.push(ResourceGroup {
                    key,
                    native: false,
                    containers,
                });
            }
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_keep_project_and_branch_ownership_without_bind_paths() {
        let mut payload: ProjectsPayload = serde_json::from_str(
            r#"{
            "runtime_ok":true,"projects":[{"name":"storefront","backend":"compose",
            "branch_runtime":[{"branch":"review","runtime":{"services":[{"service":"api",
                "containers":[{"name":"storefront-review-api","id":"fixture","state":"running",
                  "image":"example.invalid/api:1","mounts":[{"type":"volume","name":"api-data"},
                  {"type":"bind","name":"fixture-bind","source":"/work/local-only"}],
                  "networks":[{"name":"storefront-review"}]}]}]}}]},
            {"name":"foreign","kind":"unregistered","runtime":{"services":[{"service":"other",
              "containers":[{"name":"foreign","state":"running"}]}]}}]
        }"#,
        )
        .unwrap();
        let groups = inventory(&payload);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].key.branch.as_deref(), Some("review"));
        let container = &groups[0].containers[0];
        assert_eq!(container.volumes, ["api-data".to_owned()].into());
        assert_eq!(container.networks, ["storefront-review".to_owned()].into());
        assert!(!format!("{container:?}").contains("local-only"));
        payload.runtime_ok = Some(false);
        assert!(inventory(&payload).is_empty());
    }
}
