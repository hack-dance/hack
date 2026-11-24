//! Inventory attributable to the current CLI and daemon observations.

use crate::{models::ProjectsPayload, viewmodel::InstanceKey};
use std::collections::BTreeSet;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiskUsage {
    scope: String,
    pub complete: bool,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub categories: Vec<DiskCategory>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskCategory {
    pub label: String,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
}

impl NativeDiskUsage {
    pub(crate) fn read(runner: &crate::runner::CliRunner) -> Result<Self, &'static str> {
        let result: Self = runner
            .run_json(
                &["native", "disk-usage", "--json"],
                None,
                std::time::Duration::from_secs(18),
            )
            .map_err(
                |_| "Could not read disk usage. Check `hack native disk-usage` in a terminal.",
            )?;
        if result.scope != "native-home-host-files" {
            return Err("The CLI returned an unsupported disk usage report.");
        }
        Ok(result)
    }
}

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
    for project in &projects.projects {
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
        let base = project.runtime.iter().map(|r| (None, r));
        let branches = project
            .branch_runtime
            .iter()
            .map(|b| (Some(b.branch.clone()), &b.runtime));
        for (branch, runtime) in base.chain(branches) {
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
                    key: InstanceKey {
                        project: project.name.clone(),
                        branch,
                    },
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
    fn native_disk_usage_calls_the_read_only_command_and_preserves_partial_totals() {
        let root = std::env::temp_dir().join(format!("desktop-disk-usage-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let cli = root.join("hack");
        crate::test_support::script(
            &cli,
            r#"#!/bin/sh
[ "$#" -eq 3 ] && [ "$1:$2:$3" = native:disk-usage:--json ] || exit 2
printf '%s\n' '{"ok":true,"data":{"scope":"native-home-host-files","complete":false,"allocatedBytes":512,"logicalBytes":32768,"categories":[{"label":"Runtime state and VM disks","allocatedBytes":512,"logicalBytes":32768}]}}'
"#,
        );
        let report = NativeDiskUsage::read(&crate::runner::CliRunner::new(cli));
        std::fs::remove_dir_all(&root).unwrap();
        let report = report.unwrap();
        assert!(!report.complete);
        assert_eq!((report.allocated_bytes, report.logical_bytes), (512, 32768));
        assert_eq!(report.categories[0].label, "Runtime state and VM disks");
    }

    #[test]
    fn attachments_keep_project_and_branch_ownership_without_bind_paths() {
        let mut payload: ProjectsPayload = serde_json::from_str(
            r#"{
            "runtime_ok":true,"projects":[{"name":"storefront","backend":"compose",
            "branch_runtime":[{"branch":"review","runtime":{"services":[{"service":"api",
                "containers":[{"name":"storefront-review-api","id":"fixture","state":"running",
                  "image":"example.invalid/api:1","mounts":[{"type":"volume","name":"api-data"},
                  {"type":"bind","name":"fixture-bind","source":"/work/local-only"}],
                  "networks":[{"name":"storefront-review"}]}]}]}}]}]
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
