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
///
/// `Ok(None)` means the first inspection found no volume. Each caller maps it
/// to its own absence contract: missing retained data, a closed recovery
/// refusal, or the removal-recovery absent branch. A volume that disappears
/// after the first inspection is an identity failure, not absence.
pub(super) fn observe(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<Option<Value>, CandidateError> {
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
) -> Result<Option<Value>, CandidateError> {
    let Some(before) = inspect()? else {
        return Ok(None);
    };
    let directory = volume_subpaths::directory_identity_with(execute, resource, &before)?;
    let after = inspect()?
        .ok_or_else(|| error("graph_volume_identity", "Volume identity is unavailable."))?;
    if stable_fields(&before) != stable_fields(&after) {
        return Err(error(
            "graph_volume_identity",
            "Volume changed during observation.",
        ));
    }
    Ok(Some(projection(&before, &directory)))
}

/// Recovery selections keep their closed refusal, as before the stable
/// projection: absence and identity refusals from this module or the `_data`
/// identity check become `refused`, while provider inspection and guest
/// transport failures propagate unchanged.
#[cfg(any(test, target_os = "macos"))]
pub(super) fn recovery(
    observed: Result<Option<Value>, CandidateError>,
    refused: impl FnOnce() -> CandidateError,
) -> Result<Value, CandidateError> {
    match observed {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(refused()),
        Err(failure)
            if matches!(
                failure.code,
                "graph_volume_identity" | "graph_volume_subpath"
            ) =>
        {
            Err(refused())
        }
        Err(failure) => Err(failure),
    }
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
