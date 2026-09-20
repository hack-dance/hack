//! Explicit data removal after a cleanly retired foreground owner. The old relay
//! acknowledgement proves compute retirement, not authority for this new effect.
use super::*;
use crate::provider::graph::{self, Kind, cleanup_enrollment, host_relay, state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    binding: String,
    boot: String,
    volumes: BTreeMap<String, Value>,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "graph_retained_data",
        "Retained data removal requires confirmed retired ownership and unchanged resource identities.",
    )
}
fn binding(receipt: &Receipt) -> Result<String, CandidateError> {
    let mut value = serde_json::to_value(receipt).map_err(|_| refused())?;
    value.as_object_mut().ok_or_else(refused)?.remove("phase");
    for resource in value["resources"]
        .as_object_mut()
        .ok_or_else(refused)?
        .values_mut()
    {
        resource
            .as_object_mut()
            .ok_or_else(refused)?
            .remove("phase");
    }
    let bytes = serde_json::to_vec(&value).map_err(|_| refused())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn allowed(receipt: &Receipt, intent: Option<&Intent>, boot: &str) -> Result<(), CandidateError> {
    if receipt.relay_startup.is_none()
        || receipt
            .relay_cleanup
            .as_ref()
            .is_none_or(|m| m.phase() != cleanup_enrollment::Phase::Confirmed)
    {
        return Err(refused());
    }
    match intent {
        None if receipt.phase == "stopped-data-retained" => Ok(()),
        Some(intent)
            if intent.version == 1
                && intent.boot == boot
                && intent.binding == binding(receipt)?
                && ["stopped-data-retained", "cleanup-intent", "removed"]
                    .contains(&receipt.phase.as_str()) =>
        {
            Ok(())
        }
        _ => Err(refused()),
    }
}
fn no_pending(root: &Path, name: &str) -> Result<(), CandidateError> {
    match std::fs::symlink_metadata(root.join(name)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}
fn volume_matches(
    expected: Option<&Value>,
    observed: Option<&Value>,
    recovering: bool,
) -> Result<(), CandidateError> {
    match (expected, observed) {
        (Some(a), Some(b)) if a == b => Ok(()),
        (Some(_), None) if recovering => Ok(()),
        (None, None) => Ok(()),
        _ => Err(refused()),
    }
}
pub(super) fn remove(
    candidate: &Candidate,
    run: &str,
    guard: transport::Retired,
) -> Result<Value, CandidateError> {
    guard.verify()?;
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = graph::load(candidate, &engine, run)?;
    no_pending(&root, "state.pending")?;
    no_pending(&root, "retired-data-removal.pending")?;
    let path = root.join("retired-data-removal.json");
    let intent: Option<Intent> = match std::fs::symlink_metadata(&path) {
        Ok(_) => Some(state::read(&path)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(refused()),
    };
    allowed(&receipt, intent.as_ref(), engine.guest().boot_id())?;
    cleanup_enrollment::retention(&root, &receipt)?;
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&receipt.owner, engine.guest().boot_id())?;
    if marker.runtime != context.runtime
        || marker.boot != context.boot
        || receipt
            .relay_startup
            .as_ref()
            .ok_or_else(refused)?
            .control_root
            != marker.control_root
    {
        return Err(refused());
    }
    let mut volumes = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        let observed = graph::inspect_resource(&engine, &receipt, resource)?;
        if resource.kind != Kind::Volume {
            if observed.is_some() {
                return Err(refused());
            }
            continue;
        }
        if let Some(intent) = &intent {
            volume_matches(intent.volumes.get(key), observed.as_ref(), true)?;
        }
        if let Some(value) = observed {
            if value["CreatedAt"].as_str().is_none_or(str::is_empty) {
                return Err(refused());
            }
            graph::cache_provenance::verify(&engine, &receipt, resource)?;
            volumes.insert(key.clone(), value);
        } else if intent.is_none() && resource.phase == "created" {
            return Err(refused());
        }
    }
    if let Some(intent) = &intent {
        if intent.volumes.keys().any(|key| {
            receipt
                .resources
                .get(key)
                .is_none_or(|r| r.kind != Kind::Volume)
        }) {
            return Err(refused());
        }
    } else {
        state::write(
            &path,
            &Intent {
                version: 1,
                binding: binding(&receipt)?,
                boot: engine.guest().boot_id().into(),
                volumes,
            },
        )?;
    }
    guard.verify()?;
    let cleaned = graph::cleanup_owned(candidate, &engine, receipt, &root, true)?;
    guard.verify()?;
    Ok(json!({"ok":true,"run":run,"phase":cleaned.phase,"receipt":cleaned}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"resources":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"relay_cleanup":{"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/owned","phase":"confirmed"}})).unwrap()
    }
    #[test]
    fn explicit_intent_binds_retired_generation_and_partial_removal() {
        let mut receipt = receipt();
        assert!(allowed(&receipt, None, "boot").is_ok());
        let intent = Intent {
            version: 1,
            binding: binding(&receipt).unwrap(),
            boot: "boot".into(),
            volumes: BTreeMap::new(),
        };
        receipt.phase = "cleanup-intent".into();
        assert!(allowed(&receipt, None, "boot").is_err());
        assert!(allowed(&receipt, Some(&intent), "boot").is_ok());
        receipt.phase = "removed".into();
        assert!(allowed(&receipt, Some(&intent), "boot").is_ok());
        assert!(allowed(&receipt, Some(&intent), "other-boot").is_err());
        receipt.plan_id = "f".repeat(64);
        assert!(allowed(&receipt, Some(&intent), "boot").is_err());
    }
    #[test]
    fn live_unconfirmed_and_unenrolled_receipts_refuse() {
        for phase in [
            "preparing",
            "ready-observed",
            "failed-retained",
            "restarting",
        ] {
            let mut receipt = receipt();
            receipt.phase = phase.into();
            assert!(allowed(&receipt, None, "boot").is_err());
        }
        for phase in [
            cleanup_enrollment::Phase::Pending,
            cleanup_enrollment::Phase::Dormant,
        ] {
            let mut receipt = receipt();
            receipt.relay_cleanup.as_mut().unwrap().phase = phase;
            assert!(allowed(&receipt, None, "boot").is_err());
        }
        let mut receipt = receipt();
        receipt.relay_cleanup = None;
        assert!(allowed(&receipt, None, "boot").is_err());
    }
    #[test]
    fn volume_replacement_never_becomes_recovery_authority() {
        let original =
            json!({"Name":"owned","Driver":"local","CreatedAt":"original","Mountpoint":"/owned"});
        assert!(volume_matches(Some(&original), Some(&original), false).is_ok());
        assert!(volume_matches(Some(&original), None, false).is_err());
        assert!(volume_matches(Some(&original), None, true).is_ok());
        let mut replacement = original.clone();
        replacement["CreatedAt"] = json!("replacement");
        assert!(volume_matches(Some(&original), Some(&replacement), true).is_err());
        assert!(volume_matches(None, Some(&original), true).is_err());
    }
}
