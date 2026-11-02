//! Owned project bridge topology. External networks and host namespaces are not implicit.
use crate::{Diagnostic, json::child, model::Project, validate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Network {
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NetworkAttachment {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub aliases: Vec<String>,
}

type At<'a> = dyn Fn(&str, &str) -> Diagnostic + 'a;

/// Validate every authored profile before pruning. Default is the owned outbound
/// bridge; an explicit nonempty attachment map replaces that default selection.
pub(crate) fn normalize(project: &mut Project, at: &At) -> Result<(), Diagnostic> {
    let declared = project.networks.as_ref();
    for name in declared.into_iter().flat_map(|values| values.keys()) {
        if !validate::name(name) || matches!(name.as_str(), "default" | "ingress") {
            return Err(at("invalid_name", &child("/networks", name)));
        }
    }
    let workload_names: BTreeSet<String> = project
        .services
        .keys()
        .chain(project.jobs.keys())
        .cloned()
        .collect();
    let mut aliases: BTreeSet<(String, String)> = BTreeSet::new();
    for (kind, workloads) in [
        ("services", &mut project.services),
        ("jobs", &mut project.jobs),
    ] {
        for (name, workload) in workloads {
            let Some(attachments) = &mut workload.networks else {
                continue;
            };
            let pointer = child(&child(&format!("/{kind}"), name), "networks");
            if attachments.is_empty() {
                return Err(at("invalid_network_selection", &pointer));
            }
            for (network, attachment) in attachments {
                let pointer = child(&pointer, network);
                if network != "default"
                    && !declared.is_some_and(|values| values.contains_key(network))
                {
                    return Err(at("unknown_network", &pointer));
                }
                let mut seen = BTreeSet::new();
                for (index, alias) in attachment.aliases.iter().enumerate() {
                    if !validate::name(alias) || !seen.insert(alias) {
                        return Err(at("invalid_name", &format!("{pointer}/aliases/{index}")));
                    }
                    // Compose also installs the workload name as a DNS alias.
                    // Never replace another workload or create round-robin DNS
                    // accidentally through two authored alias owners.
                    if workload_names.contains(alias)
                        || !aliases.insert((network.clone(), alias.clone()))
                    {
                        return Err(at(
                            "network_alias_collision",
                            &format!("{pointer}/aliases/{index}"),
                        ));
                    }
                }
                attachment.aliases.sort();
            }
        }
    }
    if project.networks.as_ref().is_some_and(BTreeMap::is_empty) {
        project.networks = None;
    }
    Ok(())
}

pub(crate) fn share_network(a: &crate::model::Workload, b: &crate::model::Workload) -> bool {
    let attached = |workload: &crate::model::Workload| -> BTreeSet<String> {
        workload.networks.as_ref().map_or_else(
            || BTreeSet::from(["default".to_owned()]),
            |values| values.keys().cloned().collect(),
        )
    };
    !attached(a).is_disjoint(&attached(b))
}
