//! Publication-only recovery after ordinary cleanup was acknowledged, but a
//! later archival step failed. Historical recovery receipts grant no authority.
use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;

const LIMIT: u64 = 2 * 1024 * 1024;

pub struct AcknowledgedPublisherSelection<'a> {
    pub run: &'a str,
    pub owner: &'a str,
    pub receipt_sha256: &'a str,
    pub publisher_sha256: &'a str,
}

fn refused() -> CandidateError {
    error(
        "graph_acknowledged_publisher",
        "Publisher retirement requires the exact stopped receipt, current-boot cleanup acknowledgement, absent compute and unchanged retained data; evidence preserved.",
    )
}

fn no_pending(root: &Path) -> Result<(), CandidateError> {
    for name in [
        "state.pending",
        "restore-history.pending",
        "one-off.json",
        "one-off.pending",
        "one-off-normalization.json",
        "dependency-rebind.pending",
        "source-device-rebind.pending",
        "dead-owner-cleanup.pending",
        "live-owner-cleanup.pending",
        "absent-publication-cleanup.pending",
        "absent-publication-retirement.pending",
        "relay-cleanup-bridges.pending",
        "retired-data-removal.json",
        "retired-data-removal.pending",
    ] {
        match fs::symlink_metadata(root.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
    }
    Ok(())
}

fn eligible(
    receipt: &Receipt,
    selected: &AcknowledgedPublisherSelection<'_>,
    boot: &str,
) -> Result<(), CandidateError> {
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(selected.owner, boot)?;
    if receipt.run != selected.run
        || receipt.owner != selected.owner
        || receipt.phase != "stopped-data-retained"
        || receipt.normalized_input.is_none()
        || !marker.valid()
        || marker.phase != cleanup_enrollment::Phase::Confirmed
        || marker.runtime != context.runtime
        || marker.boot != context.boot
        || marker.control_root != startup.control_root
        || receipt
            .resources
            .values()
            .any(|resource| match resource.kind {
                Kind::Volume => resource.phase != "created",
                _ => resource.phase != "absent",
            })
    {
        return Err(refused());
    }
    initializer_cache::require_resolved(receipt)
}

fn exact_receipt(root: &Path, expected: &str) -> Result<(), CandidateError> {
    no_pending(root)?;
    let bytes = host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)?;
    if format!("{:x}", Sha256::digest(bytes)) != expected {
        return Err(refused());
    }
    Ok(())
}

fn acknowledged_effect(receipt: &Receipt, effect: [u8; 32]) -> Result<(), CandidateError> {
    if receipt
        .relay_cleanup
        .as_ref()
        .is_none_or(|marker| marker.effect != effect)
    {
        return Err(refused());
    }
    Ok(())
}

fn verify_cleanup(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &Path,
    selected: &AcknowledgedPublisherSelection<'_>,
) -> Result<(), CandidateError> {
    eligible(receipt, selected, engine.guest().boot_id())?;
    exact_receipt(root, selected.receipt_sha256)?;
    startup::require_dependency_rebind_complete(root, receipt)?;
    let environment = environment::cleanup_inventory(candidate, engine, receipt, root)?;
    let bridges = bridges::cleanup::read(engine, receipt, root)?;
    acknowledged_effect(
        receipt,
        host_relay::cleanup_effect(
            receipt,
            engine.guest().boot_id(),
            false,
            &(&environment, &bridges),
        )?,
    )?;
    host_relay::require_acknowledged_enrollment(receipt)?;
    host_relay::inspect_cleanup(candidate, engine, receipt, false, &environment, &bridges)?;
    engine.guest().verify()
}

/// Retire only a selected dead publication after independent current-boot ACK
/// and guest absence checks. The existing immutable publisher journal preserves
/// both original files and resumes either rename interruption. No graph receipt,
/// VM resource, dependency journal or persistent volume is changed here.
pub fn retire(
    candidate: &Candidate,
    selected: AcknowledgedPublisherSelection<'_>,
) -> Result<Value, CandidateError> {
    if !hex(selected.run, 32)
        || !hex(selected.owner, 32)
        || !hex(selected.receipt_sha256, 64)
        || !hex(selected.publisher_sha256, 64)
    {
        return Err(refused());
    }
    // Match the existing explicit recovery lock order; both locks stay held
    // through observation, journal publication and each retirement rename.
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let publication = foreground::transport::root(candidate, selected.run)?;
    let lock = state::Lock::acquire_existing(&publication)?;
    host_pin_recovery::exact_lock_path(&publication, &lock)?;
    let (receipt, root) = load(candidate, &engine, selected.run)?;
    let verify = || {
        host_pin_recovery::exact_lock_path(&publication, &lock)?;
        verify_cleanup(candidate, &engine, &receipt, &root, &selected)
    };
    verify()?;
    // This helper checks the selected publisher bytes, dead process, refused
    // listener and exact lock/path identities before writing or moving files.
    // Its durable journal permits retry after either original name has moved.
    foreground::transport::retire_recovered_publisher_locked_fenced(
        candidate,
        selected.run,
        selected.publisher_sha256,
        selected.receipt_sha256,
        None,
        &lock,
        &verify,
    )?;
    verify()?;
    Ok(
        json!({"run":selected.run,"publisher_retired":true,"data_retained":true,"same_boot":true,"acknowledged_cleanup":true}),
    )
}

/// Release a selected same-boot dependency claim only after exact publisher
/// retirement and current acknowledged cleanup. Every socket must be absent;
/// the record is exclusively moved to history, never deleted or overwritten.
pub fn release_dependencies(
    candidate: &Candidate,
    selected: AcknowledgedPublisherSelection<'_>,
    expected_reservation: &str,
) -> Result<Value, CandidateError> {
    if !hex(selected.run, 32)
        || !hex(selected.owner, 32)
        || !hex(selected.receipt_sha256, 64)
        || !hex(selected.publisher_sha256, 64)
        || !hex(expected_reservation, 64)
    {
        return Err(refused());
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let retired =
        foreground::transport::Retired::acquire(candidate, selected.run)?.ok_or_else(refused)?;
    let (receipt, root) = load(candidate, &engine, selected.run)?;
    let verify = || {
        retired.verify_recovery(
            candidate,
            selected.run,
            selected.publisher_sha256,
            selected.receipt_sha256,
        )?;
        verify_cleanup(candidate, &engine, &receipt, &root, &selected)
    };
    verify()?;
    let process = retired.publisher_process(
        candidate,
        selected.run,
        selected.publisher_sha256,
        selected.receipt_sha256,
    )?;
    dependency_slots::archive_acknowledged(
        candidate,
        &receipt,
        engine.guest().boot_id(),
        &process,
        expected_reservation,
        &verify,
    )?;
    verify()?;
    Ok(
        json!({"run":selected.run,"reservation_released":true,"record_retained":true,"data_retained":true,"same_boot":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> Receipt {
        let mut value: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","normalized_input":{"namespace":"c".repeat(64),"original_compose_sha256":"d".repeat(64),"normalized_compose_sha256":"e".repeat(64)},"readiness":{},"resources":{"container:web":{"kind":"container","key":"web","name":"owned-web","id":"f".repeat(64),"image":"sha256:".to_owned()+&"f".repeat(64),"phase":"absent"},"volume:data":{"kind":"volume","key":"data","name":"owned-data","id":null,"image":null,"phase":"created"}},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"relay_cleanup":{"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/owned","phase":"confirmed"}})).unwrap();
        let context = host_relay::context(&value.owner, "fixture-boot").unwrap();
        let marker = value.relay_cleanup.as_mut().unwrap();
        marker.runtime = context.runtime;
        marker.boot = context.boot;
        value
    }

    #[test]
    fn acknowledgement_eligibility_refuses_other_generations_and_partial_cleanup() {
        let value = receipt();
        let selected = AcknowledgedPublisherSelection {
            run: &value.run,
            owner: &value.owner,
            receipt_sha256: &"1".repeat(64),
            publisher_sha256: &"2".repeat(64),
        };
        eligible(&value, &selected, "fixture-boot").unwrap();
        assert!(eligible(&value, &selected, "other-boot").is_err());
        for field in [
            "run",
            "owner",
            "phase",
            "normalized",
            "marker",
            "ack",
            "root",
            "compute",
            "volume",
        ] {
            let mut changed = value.clone();
            match field {
                "run" => changed.run = "9".repeat(32),
                "owner" => changed.owner = "9".repeat(32),
                "phase" => changed.phase = "failed-retained".into(),
                "normalized" => changed.normalized_input = None,
                "marker" => changed.relay_cleanup = None,
                "ack" => {
                    changed.relay_cleanup.as_mut().unwrap().phase =
                        cleanup_enrollment::Phase::Pending
                }
                "root" => {
                    changed.relay_startup.as_mut().unwrap().control_root = "/private/other".into()
                }
                "compute" => {
                    changed.resources.get_mut("container:web").unwrap().phase = "started".into()
                }
                "volume" => {
                    changed.resources.get_mut("volume:data").unwrap().phase = "absent".into()
                }
                _ => unreachable!(),
            }
            assert!(
                eligible(&changed, &selected, "fixture-boot").is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn pending_operations_and_changed_receipt_bytes_are_preserved() {
        let fixture = super::super::tests::Fixture::new();
        let value = receipt();
        state::write(&fixture.0.join("state.json"), &value).unwrap();
        let before = fs::read(fixture.0.join("state.json")).unwrap();
        let selected = format!("{:x}", Sha256::digest(&before));
        exact_receipt(&fixture.0, &selected).unwrap();
        assert!(exact_receipt(&fixture.0, &"0".repeat(64)).is_err());
        for name in [
            "state.pending",
            "restore-history.pending",
            "dependency-rebind.pending",
            "source-device-rebind.pending",
            "one-off.json",
            "retired-data-removal.json",
            "relay-cleanup-bridges.pending",
        ] {
            fs::write(fixture.0.join(name), b"preserve").unwrap();
            assert!(exact_receipt(&fixture.0, &selected).is_err(), "{name}");
            assert_eq!(fs::read(fixture.0.join(name)).unwrap(), b"preserve");
            assert_eq!(fs::read(fixture.0.join("state.json")).unwrap(), before);
            fs::remove_file(fixture.0.join(name)).unwrap();
        }
        fs::write(fixture.0.join("state.json"), b"changed").unwrap();
        assert!(exact_receipt(&fixture.0, &selected).is_err());
        assert_eq!(fs::read(fixture.0.join("state.json")).unwrap(), b"changed");
    }

    #[test]
    fn completed_old_boot_journal_is_inert_but_uncertain_rebind_refuses() {
        let fixture = super::super::tests::Fixture::new();
        let value = receipt();
        let mut journal = json!({"version":1,"operation":"1".repeat(32),"run":value.run,"owner":value.owner,"boot":"prior-boot","expected_generation":"2".repeat(64),"phase":"completed","slots":{},"processes":{},"completed_services":["deps"],"completed_generation":"3".repeat(64)});
        let path = fixture.0.join("dependency-rebind.json");
        for phase in ["completed", "cleaned"] {
            journal["phase"] = json!(phase);
            state::write(&path, &journal).unwrap();
            let before = fs::read(&path).unwrap();
            startup::require_dependency_rebind_complete(&fixture.0, &value).unwrap();
            assert_eq!(fs::read(&path).unwrap(), before);
            fs::write(fixture.0.join("dependency-rebind.pending"), b"partial").unwrap();
            assert!(startup::require_dependency_rebind_complete(&fixture.0, &value).is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
            fs::remove_file(fixture.0.join("dependency-rebind.pending")).unwrap();
        }
        journal["phase"] = json!("provisioning");
        state::write(&path, &journal).unwrap();
        assert!(startup::require_dependency_rebind_complete(&fixture.0, &value).is_err());
        fs::write(&path, b"malformed").unwrap();
        assert!(startup::require_dependency_rebind_complete(&fixture.0, &value).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"malformed");
    }

    #[test]
    fn acknowledgement_is_bound_to_the_selected_cleanup_effect() {
        let mut value = receipt();
        let calculate = |receipt: &Receipt| {
            host_relay::cleanup_effect(receipt, "fixture-boot", false, &json!(["inventory"]))
                .unwrap()
        };
        let effect = calculate(&value);
        value.relay_cleanup.as_mut().unwrap().effect = effect;
        acknowledged_effect(&value, calculate(&value)).unwrap();
        let mut changed = value.clone();
        changed.relay_cleanup.as_mut().unwrap().effect[0] ^= 1;
        assert!(acknowledged_effect(&changed, calculate(&changed)).is_err());
        changed = value.clone();
        changed.resources.get_mut("container:web").unwrap().id = Some("9".repeat(64));
        assert!(acknowledged_effect(&changed, calculate(&changed)).is_err());
        let wrong_inventory =
            host_relay::cleanup_effect(&value, "fixture-boot", false, &json!(["other-inventory"]))
                .unwrap();
        assert!(acknowledged_effect(&value, wrong_inventory).is_err());
    }
}
