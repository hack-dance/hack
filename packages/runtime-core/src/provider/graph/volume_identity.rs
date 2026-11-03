//! Volume incarnation shared by retained-data workflows and cache quarantine.
//! Docker local volume `CreatedAt` is directory mtime, so it is evidence only.
use super::*;

pub(super) fn stable_fields(inspected: &Value) -> Value {
    let mut stable = inspected.clone();
    if let Some(fields) = stable.as_object_mut() {
        fields.remove("CreatedAt");
    }
    stable
}

pub(super) fn same(
    admitted: &Value,
    admitted_root: &str,
    current: &Value,
    current_root: &str,
) -> bool {
    admitted.is_object()
        && volume_subpaths::valid_identity(admitted_root)
        && admitted_root == current_root
        && stable_fields(admitted) == stable_fields(current)
}

/// Capture stable inspection and a guest-observed `_data` dev:ino. A second
/// inspection fences metadata changes during observation; callers retain their
/// provider lease and re-observe this identity at the effect boundary.
pub(super) fn observe(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<Value, CandidateError> {
    observe_with(
        resource,
        || inspect_resource(engine, receipt, resource),
        // Observation must also work under cleanup-only recovery admission.
        // This retains the guest lease/boot checks without allocation admission.
        |program, arguments| engine.guest().execute_cleanup(program, arguments),
    )
}

pub(super) fn observe_with(
    resource: &Resource,
    mut inspect: impl FnMut() -> Result<Option<Value>, CandidateError>,
    execute: impl FnOnce(&str, &[&str]) -> Result<String, CandidateError>,
) -> Result<Value, CandidateError> {
    let unavailable = || error("graph_volume_identity", "Volume identity is unavailable.");
    let before = inspect()?.ok_or_else(unavailable)?;
    let directory = volume_subpaths::directory_identity_with(execute, resource, &before)?;
    let after = inspect()?.ok_or_else(unavailable)?;
    if stable_fields(&before) != stable_fields(&after) {
        return Err(error(
            "graph_volume_identity",
            "Volume changed during observation.",
        ));
    }
    Ok(projection(&before, &directory))
}

pub(super) fn projection(inspected: &Value, directory: &str) -> Value {
    json!({"inspected": stable_fields(inspected), "directory": directory})
}

/// Select exactly the graph's retained volumes. Both host-pin and absent-publisher
/// recovery persist this projection, with no timestamp-based fallback.
#[cfg(any(test, target_os = "macos"))]
pub(super) fn select_with(
    receipt: &Receipt,
    mut observe: impl FnMut(&Resource) -> Result<Value, CandidateError>,
) -> Result<BTreeMap<String, Value>, CandidateError> {
    receipt
        .resources
        .iter()
        .filter(|(_, resource)| resource.kind == Kind::Volume)
        .map(|(key, resource)| Ok((key.clone(), observe(resource)?)))
        .collect()
}

#[cfg(any(test, target_os = "macos"))]
pub(super) fn verify_with(
    receipt: &Receipt,
    selected: &BTreeMap<String, Value>,
    observe: impl FnMut(&Resource) -> Result<Value, CandidateError>,
) -> Result<(), CandidateError> {
    if &select_with(receipt, observe)? != selected {
        return Err(error(
            "graph_volume_identity",
            "Retained volume identity changed.",
        ));
    }
    Ok(())
}

/// An already removed volume is allowed only during explicit removal recovery.
/// Callers supply projections containing the freshly observed `_data` inode.
#[cfg(any(test, target_os = "macos"))]
pub(super) fn retained_matches(
    expected: Option<&Value>,
    observed: Option<&Value>,
    recovering: bool,
) -> bool {
    match (expected, observed) {
        (Some(a), Some(b)) => a == b,
        (Some(_), None) => recovering,
        (None, None) => true,
        _ => false,
    }
}
