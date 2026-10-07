//! Pure image/build acquisition intent. No registry lookup, cache observation, pull or build occurs here.
use crate::{Diagnostic, json::child, model::Workload};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The initial native contract accepts four canonical spellings without synthesizing defaults.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum PullPolicy {
    Always,
    Never,
    Missing,
    Build,
}

pub(crate) fn validate(
    workload: &Workload,
    pointer: &str,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    if let Some(policy) = &workload.pull_policy {
        let valid = match policy {
            PullPolicy::Always | PullPolicy::Never | PullPolicy::Missing => {
                workload.image.is_some()
            }
            PullPolicy::Build => workload.build.is_some(),
        };
        if !valid {
            return Err(at(
                "invalid_pull_policy_source",
                &child(pointer, "pull_policy"),
            ));
        }
    }
    Ok(())
}
