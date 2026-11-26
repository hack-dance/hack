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
    {
        // `started_from` is part of the phase (`Receipt::set_phase`).
        let value = value.as_object_mut().ok_or_else(refused)?;
        value.remove("phase");
        value.remove("started_from");
    }
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
    Ok(format!("{:x}", crate::Hex(Sha256::digest(bytes))))
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
    if graph::volume_identity::retained_matches(expected, observed, recovering) {
        Ok(())
    } else {
        Err(refused())
    }
}

/// One observation decides absence: a volume absent at its first inspection
/// takes the removal-recovery absent branch. `expected` is `Some` when a
/// removal intent exists, holding that intent's recorded projection.
fn observed_volume(
    expected: Option<Option<&Value>>,
    observe: impl FnOnce() -> Result<Option<Value>, CandidateError>,
) -> Result<Option<Value>, CandidateError> {
    let observed = observe()?;
    if let Some(expected) = expected {
        volume_matches(expected, observed.as_ref(), true)?;
    }
    Ok(observed)
}

fn lost_removal_refused() -> CandidateError {
    CandidateError::new(
        "graph_lost_removal",
        "Removing graph containers again requires a stopped retained receipt that records them removed, a retired foreground owner, and each one stopped with its recorded identity; nothing was changed.",
    )
}

/// Whether `graph cleanup` without data removal of a run whose foreground owner
/// retired its publication is a lost-removal repair: its receipt, read without
/// the provider lease, is the stopped retained one. Selection only; the repair
/// rechecks everything under the lease. Any other receipt keeps the owner path.
pub(super) fn lost_removal_selected(candidate: &Candidate, run: &str) -> bool {
    crate::provider::state::Owner::load(candidate)
        .ok()
        .and_then(|owner| {
            graph::load_at(graph::directory(candidate, run).ok()?, run, &owner.token).ok()
        })
        .is_some_and(|(receipt, _)| receipt.phase == "stopped-data-retained")
}

/// HACK-2719: remove again, keeping the data, the containers and networks a stopped
/// retained receipt records removed and the guest engine lists again after a VM
/// loss (the removal had not reached the guest disk; real VM, row 8). The retired
/// owner's held operation lock keeps any restore out, the provider lease keeps
/// every other graph operation out, and each removal is the ordinary owned removal
/// of the recorded identity, which `inspect_resource` verifies by labels and this
/// repair by id. Named volumes, and with them the run's data, are never touched;
/// each container's anonymous volumes go with it (`?v=true`), as in the original
/// down. No hook replays, and the receipt is unchanged: it already says absent.
/// Anything running, recorded present or unexpected refuses.
pub(super) fn repair_lost_removals(
    candidate: &Candidate,
    run: &str,
    guard: transport::Retired,
) -> Result<Value, CandidateError> {
    guard.verify()?;
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = graph::load(candidate, &engine, run)?;
    for name in [
        "state.pending",
        "retired-data-removal.pending",
        "retired-data-removal.json",
        "live-owner-cleanup.pending",
        "dead-owner-cleanup.pending",
    ] {
        no_pending(&root, name).map_err(|_| lost_removal_refused())?;
    }
    if receipt.phase != "stopped-data-retained" || receipt.relay_startup.is_none() {
        return Err(lost_removal_refused());
    }
    let marker = root.join(graph::LOST_REMOVAL_REPAIR);
    let pending = match std::fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() => {
            // Only an exact marker of this run's receipt resumes; anything else is
            // retained as evidence.
            let recorded: LostRemovalRepair =
                state::read_bounded(&marker, 4096).map_err(|_| lost_removal_refused())?;
            if recorded != LostRemovalRepair::of(&receipt)? {
                return Err(lost_removal_refused());
            }
            true
        }
        Ok(_) => return Err(lost_removal_refused()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(lost_removal_refused()),
    };
    let mut present = Vec::new();
    for resource in receipt
        .resources
        .values()
        .filter(|resource| matches!(resource.kind, Kind::Container | Kind::Network))
    {
        let Some(value) = graph::inspect_resource(&engine, &receipt, resource)? else {
            continue;
        };
        if !lost_removal_admits(resource, &value) {
            return Err(lost_removal_refused());
        }
        present.push(resource.clone());
    }
    // Containers first: a network is removed only once nothing is attached to it.
    present.sort_by_key(|resource| resource.kind != Kind::Container);
    if !present.is_empty() && !pending {
        // Durable before the first removal: a repair that ends before its barrier
        // confirms leaves this marker, so the stop is not accepted until a later
        // repair has flushed the guest disk, even when the guest lists nothing.
        state::write(&marker, &LostRemovalRepair::of(&receipt)?)?;
    }
    for resource in &present {
        graph::remove_owned_resource(&engine, &receipt, resource, || guard.verify())?;
    }
    if pending || !present.is_empty() {
        graph::storage_barrier(&engine)?;
        guard.verify()?;
        std::fs::remove_file(&marker).map_err(state::io)?;
        std::fs::File::open(&root)
            .and_then(|directory| directory.sync_all())
            .map_err(state::io)?;
    }
    guard.verify()?;
    Ok(
        json!({"ok":true,"run":run,"phase":receipt.phase,"receipt":receipt,"removed_again":present.len()}),
    )
}

/// The repair-in-progress marker: the exact receipt (by digest) it repairs.
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LostRemovalRepair {
    version: u8,
    run: String,
    receipt_sha256: String,
}
impl LostRemovalRepair {
    fn of(receipt: &Receipt) -> Result<Self, CandidateError> {
        let bytes = serde_json::to_vec_pretty(receipt).map_err(|_| lost_removal_refused())?;
        Ok(Self {
            version: 1,
            run: receipt.run.clone(),
            receipt_sha256: format!("{:x}", crate::Hex(Sha256::digest(bytes))),
        })
    }
}

/// One brought-back resource: recorded removed, with its recorded id (container or
/// network; `inspect_resource` has already matched its labels), and for a
/// container stopped and not restarting.
fn lost_removal_admits(resource: &graph::Resource, observed: &Value) -> bool {
    resource.phase == "absent"
        && matches!(resource.kind, Kind::Container | Kind::Network)
        && resource
            .id
            .as_deref()
            .is_some_and(|id| observed["Id"] == id)
        && (resource.kind != Kind::Container
            || (observed["State"]["Running"] == false && observed["State"]["Restarting"] != true))
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
        if resource.kind != Kind::Volume {
            if graph::inspect_resource(&engine, &receipt, resource)?.is_some() {
                return Err(refused());
            }
            continue;
        }
        let observed = observed_volume(
            intent.as_ref().map(|intent| intent.volumes.get(key)),
            || graph::volume_identity::observe(&engine, &receipt, resource),
        )?;
        if let Some(value) = observed {
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
    graph::explicit_cleanup_done(&root);
    Ok(json!({"ok":true,"run":run,"phase":cleaned.phase,"receipt":cleaned}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"resources":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"relay_cleanup":{"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/owned","phase":"confirmed"}})).unwrap()
    }
    #[test]
    fn an_unfinished_lost_removal_repair_resumes_only_for_its_own_receipt() {
        // Codex review of #1273: the marker binds the exact receipt it repairs, so
        // a repair interrupted before its barrier is finished only for that stop.
        let stopped = receipt();
        let marker = LostRemovalRepair::of(&stopped).unwrap();
        assert!(marker == LostRemovalRepair::of(&stopped).unwrap());
        assert_eq!(marker.run, stopped.run);
        assert_eq!(marker.receipt_sha256.len(), 64);
        let mut later = stopped.clone();
        later.namespace = "f".repeat(64);
        assert!(marker != LostRemovalRepair::of(&later).unwrap());
        // The persisted shape is exact.
        let value = serde_json::to_value(&marker).unwrap();
        assert_eq!(value["version"], 1);
        let mut unknown = value.clone();
        unknown["extra"] = json!(true);
        assert!(serde_json::from_value::<LostRemovalRepair>(unknown).is_err());
    }

    #[test]
    fn a_lost_removal_is_repaired_only_for_a_stopped_recorded_removed_resource() {
        // HACK-2719 (real VM, row 8): the engine lists the removed container again,
        // exited with the code the stop recorded (137).
        let container: graph::Resource = serde_json::from_value(json!({
            "kind":"container","key":"web","name":"hkg-web","id":"f".repeat(64),
            "image":null,"phase":"absent"
        }))
        .unwrap();
        let exited = json!({"Id":"f".repeat(64),"State":{"Running":false,"Restarting":false,"ExitCode":137}});
        assert!(lost_removal_admits(&container, &exited));
        let mut running = exited.clone();
        running["State"]["Running"] = json!(true);
        assert!(!lost_removal_admits(&container, &running));
        let mut restarting = exited.clone();
        restarting["State"]["Restarting"] = json!(true);
        assert!(!lost_removal_admits(&container, &restarting));
        let mut replaced = exited.clone();
        replaced["Id"] = json!("e".repeat(64));
        assert!(!lost_removal_admits(&container, &replaced));
        // The receipt must record it removed; a container it still records is the
        // ordinary owner path's, never this repair's.
        let mut recorded = container.clone();
        recorded.phase = "started".into();
        assert!(!lost_removal_admits(&recorded, &exited));
        let mut unknown = container.clone();
        unknown.id = None;
        assert!(!lost_removal_admits(&unknown, &exited));
        let network: graph::Resource = serde_json::from_value(json!({
            "kind":"network","key":"default","name":"hkg-net","id":"1".repeat(64),
            "image":null,"phase":"absent"
        }))
        .unwrap();
        assert!(lost_removal_admits(&network, &json!({"Id":"1".repeat(64)})));
        // A network of the same name and labels with another id is not the one
        // the receipt recorded, and one recorded without an id is never removed.
        assert!(!lost_removal_admits(
            &network,
            &json!({"Id":"2".repeat(64)})
        ));
        let mut unrecorded = network.clone();
        unrecorded.id = None;
        assert!(!lost_removal_admits(
            &unrecorded,
            &json!({"Id":"1".repeat(64)})
        ));
        let volume: graph::Resource = serde_json::from_value(json!({
            "kind":"volume","key":"data","name":"hkg-data","id":null,
            "image":null,"phase":"absent"
        }))
        .unwrap();
        assert!(!lost_removal_admits(&volume, &json!({"Name":"hkg-data"})));
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
            crate::Hex(Sha256::digest(serde_json::to_vec_pretty(&receipt).unwrap()))
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
        let original = graph::volume_identity::projection(
            &json!({"Name":"owned","Driver":"local","CreatedAt":"original","Mountpoint":"/owned"}),
            "1:2",
        );
        assert!(volume_matches(Some(&original), Some(&original), false).is_ok());
        assert!(volume_matches(Some(&original), None, false).is_err());
        assert!(volume_matches(Some(&original), None, true).is_ok());
        let mut replacement = original.clone();
        replacement["directory"] = json!("1:3");
        assert!(volume_matches(Some(&original), Some(&replacement), true).is_err());
        assert!(volume_matches(None, Some(&original), true).is_err());
    }
    #[test]
    fn removal_recovery_decides_volume_absence_from_one_observation() {
        let resource: graph::Resource = serde_json::from_value(json!({
            "kind":"volume","key":"data","name":"owned","id":null,"image":null,"phase":"created"
        }))
        .unwrap();
        let inspected = json!({"Name":"owned","Driver":"local","CreatedAt":"t",
            "Mountpoint":"/var/lib/docker/volumes/owned/_data"});
        let recorded = graph::volume_identity::projection(&inspected, "1:2");
        let resource = &resource;
        let observe = |answers: Vec<Option<Value>>| {
            let mut answers = answers.into_iter();
            move || {
                graph::volume_identity::observe_with(
                    resource,
                    || Ok(answers.next().unwrap()),
                    |_, _| Ok("1:2\n".into()),
                )
            }
        };
        // Absent at the first inspection: the allowed removal-recovery branch.
        assert_eq!(
            observed_volume(Some(Some(&recorded)), observe(vec![None])).unwrap(),
            None
        );
        // Present and unchanged: the recorded projection matches.
        assert_eq!(
            observed_volume(
                Some(Some(&recorded)),
                observe(vec![Some(inspected.clone()), Some(inspected.clone())])
            )
            .unwrap(),
            Some(recorded.clone())
        );
        // Vanishing during the observation itself still fails closed.
        assert!(
            observed_volume(
                Some(Some(&recorded)),
                observe(vec![Some(inspected.clone()), None])
            )
            .is_err()
        );
        // Without a removal intent, absence is reported to the caller as-is.
        assert_eq!(observed_volume(None, observe(vec![None])).unwrap(), None);
    }
}
