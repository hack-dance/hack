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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery: Option<String>,
    // Absent on legacy intents: those always selected previous-boot recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_source: Option<RecoverySource>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RecoverySource {
    PreviousBoot,
    SameBoot,
}
impl RecoverySource {
    fn selection(
        self,
        root: &Path,
        receipt: &Receipt,
        boot: &str,
        expected: Option<&str>,
    ) -> Result<graph::dead_owner_cleanup::RemovalProof, CandidateError> {
        match self {
            Self::PreviousBoot => {
                graph::dead_owner_cleanup::removal_selection(root, receipt, boot, expected)
            }
            Self::SameBoot => {
                graph::live_owner_cleanup::removal_selection(root, receipt, boot, expected)
            }
        }
    }
}
/// Dispatch by the exact current completion only on first admission. Persisted
/// retries never switch proof sources, even when another sidecar is present.
fn recovery_source(
    root: &Path,
    receipt: &Receipt,
    intent: Option<&Intent>,
) -> Result<RecoverySource, CandidateError> {
    if let Some(intent) = intent {
        return Ok(intent
            .recovery_source
            .unwrap_or(RecoverySource::PreviousBoot));
    }
    let previous = graph::dead_owner_cleanup::current_completion(root, receipt)?;
    let same = graph::live_owner_cleanup::current_completion(root, receipt)?;
    match (previous, same) {
        (false, true) => Ok(RecoverySource::SameBoot),
        (_, false) => Ok(RecoverySource::PreviousBoot),
        (true, true) => Err(refused()),
    }
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
fn allowed(
    receipt: &Receipt,
    intent: Option<&Intent>,
    boot: &str,
    recovery: Option<&str>,
) -> Result<(), CandidateError> {
    if intent.is_some_and(|i| i.recovery_source.is_some() && i.recovery.is_none())
        || receipt.relay_startup.is_none()
        || (recovery.is_none()
            && receipt
                .relay_cleanup
                .as_ref()
                .is_none_or(|m| m.phase() != cleanup_enrollment::Phase::Confirmed))
    {
        return Err(refused());
    }
    match intent {
        None if receipt.phase == "stopped-data-retained" => Ok(()),
        Some(intent)
            if intent.version == 1
                && intent.boot == boot
                && intent.binding == binding(receipt)?
                && intent.recovery.as_deref() == recovery
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
    remove_guarded(candidate, run, Guard::Retired(guard))
}
pub(super) fn remove_recovered(
    candidate: &Candidate,
    run: &str,
    guard: transport::DeadOwner,
) -> Result<Value, CandidateError> {
    remove_guarded(candidate, run, Guard::Recovered(guard))
}
enum Guard {
    Retired(transport::Retired),
    Recovered(transport::DeadOwner),
}
impl Guard {
    fn verify(&self) -> Result<(), CandidateError> {
        match self {
            Self::Retired(g) => g.verify(),
            Self::Recovered(g) => g.verify(),
        }
    }
}
// Ordinary acknowledged cleanup remains authoritative even when an older
// recovery sidecar exists. Never fall back to recovery after ACK validation fails.
fn needs_recovery(receipt: &Receipt, intent: Option<&Intent>) -> bool {
    intent.map_or_else(
        || {
            receipt
                .relay_cleanup
                .as_ref()
                .is_none_or(|m| m.phase() != cleanup_enrollment::Phase::Confirmed)
        },
        |i| i.recovery.is_some(),
    )
}
fn remove_guarded(candidate: &Candidate, run: &str, guard: Guard) -> Result<Value, CandidateError> {
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
    let source = if needs_recovery(&receipt, intent.as_ref()) {
        no_pending(&root, "live-owner-cleanup.pending")?;
        no_pending(&root, "dead-owner-cleanup.pending")?;
        Some(match &guard {
            Guard::Retired(_) => recovery_source(&root, &receipt, intent.as_ref())?,
            Guard::Recovered(_) => {
                if intent.as_ref().and_then(|i| i.recovery_source) == Some(RecoverySource::SameBoot)
                {
                    return Err(refused());
                }
                RecoverySource::PreviousBoot
            }
        })
    } else {
        None
    };
    let retired_proof = match &guard {
        Guard::Retired(retired) if needs_recovery(&receipt, intent.as_ref()) => {
            let proof = source.ok_or_else(refused)?.selection(
                &root,
                &receipt,
                engine.guest().boot_id(),
                intent.as_ref().and_then(|i| i.recovery.as_deref()),
            )?;
            retired.verify_recovery(candidate, run, &proof.owner, &proof.complete)?;
            Some(proof)
        }
        _ => None,
    };
    let verify_guard = || {
        guard.verify()?;
        if let (Guard::Retired(retired), Some(proof)) = (&guard, &retired_proof) {
            let current = source.ok_or_else(refused)?.selection(
                &root,
                &receipt,
                engine.guest().boot_id(),
                Some(&proof.digest),
            )?;
            retired.verify_recovery(candidate, run, &current.owner, &current.complete)?;
        }
        Ok::<(), CandidateError>(())
    };
    let recovery = match &guard {
        Guard::Retired(_) => retired_proof.as_ref().map(|p| p.digest.clone()),
        Guard::Recovered(dead) => Some(graph::dead_owner_cleanup::removal_proof(
            &root,
            &receipt,
            &dead.fingerprint(),
            engine.guest().boot_id(),
            intent.as_ref().and_then(|i| i.recovery.as_deref()),
        )?),
    };
    allowed(
        &receipt,
        intent.as_ref(),
        engine.guest().boot_id(),
        recovery.as_deref(),
    )?;
    if recovery.is_none() {
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
                recovery,
                recovery_source: source,
            },
        )?;
    }
    verify_guard()?;
    let cleaned = graph::cleanup_owned_fenced(
        candidate,
        &engine,
        receipt.clone(),
        &root,
        true,
        false,
        verify_guard,
    )?;
    verify_guard()?;
    Ok(json!({"ok":true,"run":run,"phase":cleaned.phase,"receipt":cleaned}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"resources":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"relay_cleanup":{"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/owned","phase":"confirmed"}})).unwrap()
    }
    #[test]
    fn recovery_selection_preserves_ordinary_ack_and_pins_retry_authority() {
        let mut receipt = receipt();
        // Even with historical recovery evidence, current ACK cleanup must use
        // its own marker. A bad marker is rejected, never retried as recovery.
        assert!(!needs_recovery(&receipt, None));
        let mut intent = Intent {
            version: 1,
            binding: binding(&receipt).unwrap(),
            boot: "boot".into(),
            volumes: BTreeMap::new(),
            recovery: None,
            recovery_source: None,
        };
        receipt.relay_cleanup = None;
        assert!(needs_recovery(&receipt, None));
        assert!(!needs_recovery(&receipt, Some(&intent)));
        assert!(allowed(&receipt, Some(&intent), "boot", None).is_err());
        intent.recovery = Some("a".repeat(64));
        assert!(needs_recovery(&receipt, Some(&intent)));
        receipt = self::receipt();
        assert!(needs_recovery(&receipt, Some(&intent)));
    }
    #[test]
    fn proof_source_dispatch_is_exact_and_retries_keep_legacy_authority() {
        let fixture = graph::tests::Fixture::new();
        let mut receipt = receipt();
        receipt.relay_cleanup = None;
        let complete = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec_pretty(&receipt).unwrap())
        );
        let live = json!({"version":1,"boot":"boot","original":receipt,
            "original_sha256":"1".repeat(64),"foreground_sha256":"2".repeat(64),
            "relay":{"bytes":[],"record_id":[1,1]},"environment":{},
            "bridges":{"version":1,"owner":receipt.owner,"boot":"boot","run":receipt.run,"plan":receipt.plan_id,"capacity":0,"serial":0,"selected":{}},
            "prior_bridges":null,"listeners_retired":true,"complete_sha256":complete});
        let mut previous = json!({"version":1,"original_sha256":"3".repeat(64),
            "owner_sha256":"4".repeat(64),"old_boot":"old","new_boot":"boot",
            "original":receipt,"environment":null,"bridges":null,
            "complete_sha256":"5".repeat(64)});
        state::write(&fixture.0.join("live-owner-cleanup.json"), &live).unwrap();
        state::write(&fixture.0.join("dead-owner-cleanup.json"), &previous).unwrap();
        assert_eq!(
            recovery_source(&fixture.0, &receipt, None).unwrap(),
            RecoverySource::SameBoot
        );
        // Dispatch is not validation: invalid selected proof cannot fall back.
        assert!(
            RecoverySource::SameBoot
                .selection(&fixture.0, &receipt, "boot", None)
                .is_err()
        );
        previous["complete_sha256"] = json!(complete);
        state::write(&fixture.0.join("dead-owner-cleanup.json"), &previous).unwrap();
        assert!(recovery_source(&fixture.0, &receipt, None).is_err());
        let mut historical = live.clone();
        historical["complete_sha256"] = json!("6".repeat(64));
        state::write(&fixture.0.join("live-owner-cleanup.json"), &historical).unwrap();
        assert_eq!(
            recovery_source(&fixture.0, &receipt, None).unwrap(),
            RecoverySource::PreviousBoot
        );
        let mut intent: Intent = serde_json::from_value(json!({"version":1,
            "binding":binding(&receipt).unwrap(),"boot":"boot","volumes":{},
            "recovery":"7".repeat(64)}))
        .unwrap();
        assert_eq!(
            recovery_source(&fixture.0, &receipt, Some(&intent)).unwrap(),
            RecoverySource::PreviousBoot
        );
        intent.recovery_source = Some(RecoverySource::SameBoot);
        assert_eq!(
            recovery_source(&fixture.0, &receipt, Some(&intent)).unwrap(),
            RecoverySource::SameBoot
        );
        assert!(serde_json::from_value::<Intent>(json!({"version":1,"binding":"b","boot":"boot","volumes":{},"recovery":"p","recovery_source":"unknown"})).is_err());
        intent.recovery = None;
        assert!(allowed(&receipt, Some(&intent), "boot", None).is_err());
        std::fs::write(fixture.0.join("live-owner-cleanup.json"), b"malformed").unwrap();
        assert!(recovery_source(&fixture.0, &receipt, None).is_err());
    }

    #[test]
    fn recovered_removal_intent_does_not_fabricate_relay_acknowledgement() {
        let mut receipt = receipt();
        receipt.relay_cleanup = None;
        let proof = "a".repeat(64);
        assert!(allowed(&receipt, None, "boot", None).is_err());
        assert!(allowed(&receipt, None, "boot", Some(&proof)).is_ok());
        let intent = Intent {
            version: 1,
            binding: binding(&receipt).unwrap(),
            boot: "boot".into(),
            volumes: BTreeMap::new(),
            recovery: Some(proof.clone()),
            recovery_source: None,
        };
        for phase in ["cleanup-intent", "removed"] {
            receipt.phase = phase.into();
            assert!(allowed(&receipt, Some(&intent), "boot", Some(&proof)).is_ok());
            assert!(allowed(&receipt, Some(&intent), "other", Some(&proof)).is_err());
            assert!(allowed(&receipt, Some(&intent), "boot", Some(&"b".repeat(64))).is_err());
        }
    }
    #[test]
    fn explicit_intent_binds_retired_generation_and_partial_removal() {
        let mut receipt = receipt();
        assert!(allowed(&receipt, None, "boot", None).is_ok());
        let intent = Intent {
            version: 1,
            binding: binding(&receipt).unwrap(),
            boot: "boot".into(),
            volumes: BTreeMap::new(),
            recovery: None,
            recovery_source: None,
        };
        receipt.phase = "cleanup-intent".into();
        assert!(allowed(&receipt, None, "boot", None).is_err());
        assert!(allowed(&receipt, Some(&intent), "boot", None).is_ok());
        receipt.phase = "removed".into();
        assert!(allowed(&receipt, Some(&intent), "boot", None).is_ok());
        assert!(allowed(&receipt, Some(&intent), "other-boot", None).is_err());
        receipt.plan_id = "f".repeat(64);
        assert!(allowed(&receipt, Some(&intent), "boot", None).is_err());
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
            assert!(allowed(&receipt, None, "boot", None).is_err());
        }
        for phase in [
            cleanup_enrollment::Phase::Pending,
            cleanup_enrollment::Phase::Dormant,
        ] {
            let mut receipt = receipt();
            receipt.relay_cleanup.as_mut().unwrap().phase = phase;
            assert!(allowed(&receipt, None, "boot", None).is_err());
        }
        let mut receipt = receipt();
        receipt.relay_cleanup = None;
        assert!(allowed(&receipt, None, "boot", None).is_err());
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
