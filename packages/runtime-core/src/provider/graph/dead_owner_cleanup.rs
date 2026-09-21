//! Explicit two-phase recovery. VM stop plus owner death is selected before reboot;
//! no endpoint-file deletion is treated as a relay retirement acknowledgement.
use super::*;
use crate::provider::{identity, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
const FILE: &str = "dead-owner-cleanup.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    original_sha256: String,
    owner_sha256: String,
    old_boot: String,
    new_boot: Option<String>,
    original: Receipt,
    environment: Option<Value>,
    bridges: Option<bridges::cleanup::Selection>,
    complete_sha256: Option<String>,
}
fn refused() -> CandidateError {
    error(
        "graph_dead_owner_recovery",
        "Dead-owner cleanup requires the exact stopped selection, absent foreground owner, a fresh verified boot and unchanged inventories; evidence retained.",
    )
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn receipt_digest(root: &std::path::Path) -> Result<String, CandidateError> {
    let value: Receipt = state::read(&root.join("state.json"))?;
    Ok(digest(
        &serde_json::to_vec_pretty(&value).map_err(|_| refused())?,
    ))
}
/// Digest of the canonical pretty-encoded state.json written by state::write.
fn selected(receipt: &Receipt) -> Result<String, CandidateError> {
    Ok(digest(
        &serde_json::to_vec_pretty(receipt).map_err(|_| refused())?,
    ))
}
fn immutable(receipt: &Receipt) -> Result<Value, CandidateError> {
    let mut value = serde_json::to_value(receipt).map_err(|_| refused())?;
    value.as_object_mut().ok_or_else(refused)?.remove("phase");
    for group in ["resources", "probes"] {
        if let Some(items) = value.get_mut(group).and_then(Value::as_object_mut) {
            for item in items.values_mut() {
                item.as_object_mut().ok_or_else(refused)?.remove("phase");
            }
        }
    }
    Ok(value)
}
fn validate(
    intent: &Intent,
    receipt: &Receipt,
    expected: &str,
    owner: &str,
) -> Result<(), CandidateError> {
    if intent.version != 1
        || intent.original_sha256 != expected
        || selected(&intent.original)? != expected
        || intent.owner_sha256 != owner
        || !hex(owner, 64)
        || intent.old_boot.is_empty()
        || immutable(&intent.original)? != immutable(receipt)?
    {
        return Err(refused());
    }
    Ok(())
}
fn exists(path: &std::path::Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn no_pending(root: &std::path::Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}
fn retain_interrupted_write(root: &std::path::Path) -> Result<(), CandidateError> {
    journal::retain_file(
        root,
        "dead-owner-cleanup.pending",
        "dead-owner-cleanup-recovery",
        2 * 1024 * 1024,
    )?;
    Ok(())
}
/// The first call occurs while stopped; the second follows explicit runtime up.
/// This operation never starts a VM or deletes retained data.
pub fn recover_cleanup(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected, 64) {
        return Err(refused());
    }
    let owner = Owner::load(candidate)?;
    if owner.phase == "stopped" {
        return prepare(candidate, run, expected);
    }
    execute(candidate, run, expected)
}
fn prepare(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    let _lease = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm"))?;
    let owner = Owner::load(candidate)?;
    let status = lifecycle::status(candidate)?;
    if owner.phase != "stopped"
        || status.process_alive != Some(false)
        || !status.persistent_disks_identified
    {
        return Err(refused());
    }
    if owner
        .process
        .as_ref()
        .is_none_or(|p| identity::alive(p.pid).unwrap_or(true))
    {
        return Err(refused());
    }
    let dead = foreground::DeadOwner::acquire(candidate, run)?;
    let (receipt, root) = load_at(directory(candidate, run)?, run, &owner.token)?;
    no_pending(&root)?;
    initializer_cache::require_resolved(&receipt)?;
    if exists(&root.join("relay-cleanup-bridges.json"))?
        || exists(&root.join("relay-cleanup-bridges.pending"))?
    {
        return Err(refused());
    }
    if receipt.relay_startup.is_none()
        || receipt.relay_cleanup.is_some()
        || !["failed-retained", "preparing", "cleanup-intent"].contains(&receipt.phase.as_str())
    {
        return Err(refused());
    }
    let path = root.join(FILE);
    if exists(&path)? {
        let intent: Intent = state::read(&path)?;
        validate(&intent, &receipt, expected, &dead.fingerprint())?;
        return Ok(json!({"run":run,"phase":"awaiting-runtime-start","receipt_sha256":expected}));
    }
    if selected(&receipt)? != expected {
        return Err(refused());
    }
    let old_boot = owner
        .guest_boot_id
        .or(owner.previous_guest_boot_id)
        .filter(|s| !s.is_empty())
        .ok_or_else(refused)?;
    let intent = Intent {
        version: 1,
        original_sha256: expected.into(),
        owner_sha256: dead.fingerprint(),
        old_boot,
        new_boot: None,
        original: receipt,
        environment: None,
        bridges: None,
        complete_sha256: None,
    };
    dead.verify()?;
    retain_interrupted_write(&root)?;
    state::write(&path, &intent)?;
    Ok(json!({"run":run,"phase":"awaiting-runtime-start","receipt_sha256":expected}))
}
fn fresh_boot(
    intent: &Intent,
    previous: Option<&str>,
    current: &str,
) -> Result<(), CandidateError> {
    if previous != Some(intent.old_boot.as_str())
        || current == intent.old_boot
        || current.is_empty()
        || intent.new_boot.as_deref().is_some_and(|b| b != current)
    {
        return Err(refused());
    }
    Ok(())
}
fn execute(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let dead = foreground::DeadOwner::acquire(candidate, run)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    no_pending(&root)?;
    let mut intent: Intent = state::read(&root.join(FILE))?;
    validate(&intent, &receipt, expected, &dead.fingerprint())?;
    let owner = Owner::load(candidate)?;
    let boot = engine.guest().boot_id();
    fresh_boot(&intent, owner.previous_guest_boot_id.as_deref(), boot)?;
    host_relay::cleanup_preflight(&engine, &receipt, &root, false)?;
    for resource in receipt.resources.values() {
        inspect_resource(&engine, &receipt, resource)?;
    }
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    let environment_value = serde_json::to_value(&environment).map_err(|_| refused())?;
    let bridges = match &intent.bridges {
        Some(selection) => selection.clone(),
        None => bridges::cleanup::capture(candidate, &engine, &receipt)?,
    };
    if intent
        .environment
        .as_ref()
        .is_some_and(|v| v != &environment_value)
    {
        return Err(refused());
    }
    if let Some(hash) = &intent.complete_sha256 {
        if receipt.phase != "stopped-data-retained" || selected(&receipt)? != *hash {
            return Err(refused());
        }
        host_relay::inspect_cleanup(candidate, &engine, &receipt, false, &environment, &bridges)?;
        dead.verify()?;
        return Ok(
            json!({"run":run,"phase":"stopped-data-retained","recovered":true,"data_retained":true}),
        );
    }
    intent.environment = Some(environment_value);
    intent.bridges = Some(bridges.clone());
    intent.new_boot = Some(boot.into());
    dead.verify()?;
    retain_interrupted_write(&root)?;
    state::write(&root.join(FILE), &intent)?;
    bridges::cleanup::recover_persist(&root, &bridges)?;
    let cleaned = cleanup_owned(candidate, &engine, receipt, &root, false)?;
    host_relay::inspect_cleanup(candidate, &engine, &cleaned, false, &environment, &bridges)?;
    dead.verify()?;
    intent.complete_sha256 = Some(selected(&cleaned)?);
    retain_interrupted_write(&root)?;
    state::write(&root.join(FILE), &intent)?;
    Ok(json!({"run":run,"phase":"stopped-data-retained","recovered":true,"data_retained":true}))
}
/// Only local retained receipts are covered. Exported receipt-only retention still
/// requires the existing relay acknowledgement; recovery does not fabricate one.
pub(super) fn retained(root: &std::path::Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(false);
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    validate(
        &intent,
        receipt,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
    if intent.complete_sha256.as_deref() != Some(receipt_digest(root)?.as_str())
        || receipt.phase != "stopped-data-retained"
        || immutable(&intent.original)? != immutable(receipt)?
    {
        return Err(refused());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn partial() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"failed-retained","readiness":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"resources":{
          "container:init":{"kind":"container","key":"init","name":"owned-init","id":"f".repeat(64),"image":format!("sha256:{}","a".repeat(64)),"phase":"started"},
          "container:app":{"kind":"container","key":"app","name":"owned-app","id":null,"image":format!("sha256:{}","a".repeat(64)),"phase":"reserved"},
          "volume:data":{"kind":"volume","key":"data","name":"owned-data","id":null,"image":null,"phase":"created"}
        }})).unwrap()
    }
    fn intent(receipt: &Receipt) -> Intent {
        Intent {
            version: 1,
            original_sha256: selected(receipt).unwrap(),
            owner_sha256: "1".repeat(64),
            old_boot: "old-boot".into(),
            new_boot: None,
            original: receipt.clone(),
            environment: None,
            bridges: None,
            complete_sha256: None,
        }
    }
    #[test]
    fn partial_provision_cleanup_progress_retains_volume_and_exact_identity() {
        let original = partial();
        let intent = intent(&original);
        let mut progress = original.clone();
        progress.phase = "cleanup-intent".into();
        progress.resources.get_mut("container:init").unwrap().phase = "absent".into();
        assert!(
            validate(
                &intent,
                &progress,
                &intent.original_sha256,
                &intent.owner_sha256
            )
            .is_ok()
        );
        progress.resources.get_mut("container:app").unwrap().phase = "absent".into();
        progress.phase = "stopped-data-retained".into();
        assert!(
            validate(
                &intent,
                &progress,
                &intent.original_sha256,
                &intent.owner_sha256
            )
            .is_ok()
        );
        assert_eq!(progress.resources["volume:data"].phase, "created");
        assert_ne!(selected(&progress).unwrap(), intent.original_sha256);
    }
    #[test]
    fn boot_selection_cannot_roll_over_or_use_same_boot() {
        let mut intent = intent(&partial());
        for (prior, current) in [
            (None, "next"),
            (Some("foreign"), "next"),
            (Some("old-boot"), "old-boot"),
        ] {
            assert!(fresh_boot(&intent, prior, current).is_err());
        }
        assert!(fresh_boot(&intent, Some("old-boot"), "next").is_ok());
        intent.new_boot = Some("next".into());
        assert!(fresh_boot(&intent, Some("old-boot"), "third").is_err());
        assert!(fresh_boot(&intent, Some("old-boot"), "next").is_ok());
    }
    #[test]
    fn stale_pins_and_changed_resource_identity_refuse() {
        let receipt = partial();
        let intent = intent(&receipt);
        assert!(validate(&intent, &receipt, &"2".repeat(64), &intent.owner_sha256).is_err());
        assert!(validate(&intent, &receipt, &intent.original_sha256, &"2".repeat(64)).is_err());
        for field in ["owner", "plan_id", "namespace"] {
            let mut value = serde_json::to_value(&receipt).unwrap();
            value[field] = json!("2".repeat(64));
            let changed: Receipt = serde_json::from_value(value).unwrap();
            assert!(
                validate(
                    &intent,
                    &changed,
                    &intent.original_sha256,
                    &intent.owner_sha256
                )
                .is_err()
            );
        }
        for field in ["id", "name", "image"] {
            let mut value = serde_json::to_value(&receipt).unwrap();
            value["resources"]["container:init"][field] = json!("changed");
            let changed: Receipt = serde_json::from_value(value).unwrap();
            assert!(
                validate(
                    &intent,
                    &changed,
                    &intent.original_sha256,
                    &intent.owner_sha256
                )
                .is_err()
            );
        }
    }
    #[test]
    fn completion_is_receipt_pinned_and_interrupted_bytes_never_become_authority() {
        let fixture = super::super::tests::Fixture::new();
        state::private_directory(&fixture.0).unwrap();
        let mut receipt = partial();
        let mut intent = intent(&receipt);
        receipt.phase = "stopped-data-retained".into();
        state::write(&fixture.0.join("state.json"), &receipt).unwrap();
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(retained(&fixture.0, &receipt).is_err());
        intent.complete_sha256 = Some(selected(&receipt).unwrap());
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(retained(&fixture.0, &receipt).unwrap());
        fs::write(
            fixture.0.join("dead-owner-cleanup.pending"),
            b"untrusted partial bytes",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.0.join("dead-owner-cleanup.pending"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        retain_interrupted_write(&fixture.0).unwrap();
        let saved: Intent = state::read(&fixture.0.join(FILE)).unwrap();
        assert_eq!(saved.complete_sha256, intent.complete_sha256);
        assert!(!fixture.0.join("dead-owner-cleanup.pending").exists());
        receipt.resources.get_mut("volume:data").unwrap().name = "foreign".into();
        state::write(&fixture.0.join("state.json"), &receipt).unwrap();
        assert!(retained(&fixture.0, &receipt).is_err());
    }
}
