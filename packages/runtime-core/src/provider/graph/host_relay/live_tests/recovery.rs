use super::*;
use crate::provider::relay_owner::{
    lifecycle_intent::{Inspection, Phase},
    publication::PinnedEndpoint,
};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

/// Only this fixture's child is killed, including on an early failure.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

pub(super) fn child(candidate: &Candidate, run: &str) -> Result<(), CandidateError> {
    let control = std::env::var("HACK_RELAY_GRAPH_CONTROL").expect("private control root");
    let operation = std::env::var("HACK_RELAY_GRAPH_OPERATION").unwrap_or_default();
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, _) = if operation == "confirm-cleanup" {
        super::super::super::archive::load_confirmation(candidate, &engine, run)?
    } else {
        load(candidate, &engine, run)?
    };
    let expected = context(&receipt.owner, engine.guest().boot_id())?;
    drop(engine);
    let pin = PinnedEndpoint::load(Path::new(&control), expected)?;
    match operation.as_str() {
        "resume-cleanup" => {
            resume_relay_cleanup(
                candidate,
                run,
                true,
                Path::new(&control),
                receipt
                    .relay_cleanup
                    .as_ref()
                    .ok_or_else(refused)?
                    .selection(),
                &pin,
            )?;
        }
        "confirm-cleanup" => {
            confirm_relay_cleanup(
                candidate,
                run,
                true,
                Path::new(&control),
                receipt
                    .relay_cleanup
                    .as_ref()
                    .ok_or_else(refused)?
                    .selection(),
            )?;
        }
        _ => {
            cleanup_with_relay(candidate, run, true, &pin)?;
        }
    }
    Err(error(
        "relay_fault_missing",
        "Cleanup child did not pause at its fault boundary.",
    ))
}

/// The child is observed live at a durable fault marker before killing its exact PID.
fn kill_at_fault(
    active: &Path,
    run: &str,
    control: &Path,
    operation: &str,
    point: &str,
) -> Result<(), CandidateError> {
    let marker = active.join(format!("fault-{point}.json"));
    assert!(!marker.exists());
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().map_err(state::io)?)
            .args([
                "--ignored",
                "--exact",
                "provider::graph::host_relay::live_tests::owned_graph_registration_live",
                "--nocapture",
            ])
            .env("HACK_RELAY_GRAPH_OPERATION", operation)
            .env("HACK_RELAY_GRAPH_CONTROL", control)
            .env("HACK_LOCAL_GRAPH_FAULT", point)
            .stdin(Stdio::null())
            .spawn()
            .map_err(state::io)?,
    );
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        assert!(
            child.0.try_wait().map_err(state::io)?.is_none(),
            "cleanup child exited before fault boundary"
        );
        if marker.exists() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(error(
                "relay_fault_timeout",
                "Cleanup child did not reach its fault boundary.",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
    let fault: Value =
        serde_json::from_slice(&fs::read(&marker).map_err(state::io)?).map_err(|_| refused())?;
    assert_eq!(fault["point"], point);
    assert_eq!(fault["run"], run);
    assert!(child.0.try_wait().map_err(state::io)?.is_none());
    child.0.kill().map_err(state::io)?;
    assert!(!child.0.wait().map_err(state::io)?.success());
    Ok(())
}

pub(super) fn exercise(
    candidate: &Candidate,
    receipt: &Receipt,
    control: &Path,
    context: Context,
) -> Result<(), CandidateError> {
    let run = &receipt.run;
    let active = directory(candidate, run)?;
    kill_at_fault(&active, run, control, "cleanup", "relay-before-admission")?;
    let enrolled: Receipt = state::read(&active.join("state.json"))?;
    let marker = enrolled.relay_cleanup.as_ref().ok_or_else(refused)?;
    assert_eq!(marker.phase, cleanup_enrollment::Phase::Pending);
    let initial = marker.selection();
    let operation = initial.operation;
    let effect = initial.effect;
    if let Ok(inspection) = Inspection::load(control, context) {
        assert_ne!(
            inspection.selection.operation, operation,
            "pre-admission fault already published the new operation"
        );
    }
    assert_eq!(
        cleanup(candidate, run, true)
            .err()
            .ok_or_else(refused)?
            .code,
        "graph_relay_enrollment"
    );
    persistent_sentinel(candidate, receipt)?;
    kill_at_fault(
        &active,
        run,
        control,
        "resume-cleanup",
        "relay-before-selection",
    )?;

    let intent = Inspection::load(control, context)?;
    assert_eq!(intent.phase, Phase::Intent);
    assert!(!intent.selection_observed);
    assert!(intent.targets.is_empty());
    assert_eq!(intent.selection.operation, operation);
    assert_eq!(intent.selection.effect, effect);
    for file in [
        "relay-cleanup-bridges.json",
        "relay-cleanup-bridges.pending",
    ] {
        assert!(matches!(fs::symlink_metadata(active.join(file)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound));
    }
    let pin = PinnedEndpoint::load(control, context)?;
    assert!(resume_relay_cleanup(candidate, run, false, control, intent.selection, &pin).is_err());
    let unchanged = Inspection::load(control, context)?;
    assert_eq!(unchanged.phase, Phase::Intent);
    assert_eq!(unchanged.selection.operation, operation);
    assert_eq!(unchanged.selection.effect, effect);
    assert!(!unchanged.selection_observed);
    assert!(unchanged.targets.is_empty());
    assert!(!active.join("relay-cleanup-bridges.json").exists());
    assert!(!active.join("relay-cleanup-bridges.pending").exists());
    // Wrong-policy recovery must leave the application and actual helper alive.
    persistent_sentinel(candidate, receipt)?;
    let observed = inspect(candidate, run)?;
    assert_eq!(observed.receipt.phase, "ready-observed");
    if std::env::var_os("HACK_RELAY_GRAPH_BRIDGE").is_some() {
        let engine = Engine::connect_cleanup(candidate)?;
        let selected = bridges::cleanup::capture(candidate, &engine, receipt)?;
        assert!(bridges::cleanup::verify(candidate, &engine, receipt, &selected).is_err());
    }
    kill_at_fault(
        &active,
        run,
        control,
        "resume-cleanup",
        "relay-after-effect",
    )?;
    println!(
        "owned-graph-relay-pre-effect-recovery-complete: killed-before-selection, durable-intent, wrong-policy-refusal, fresh-owner-resume"
    );
    let pending = Inspection::load(control, context)?;
    assert_eq!(pending.phase, Phase::EffectStarted);
    assert_eq!(pending.selection.operation, operation);
    assert_eq!(pending.selection.effect, effect);
    assert_eq!(pending.targets.len(), 4);
    assert!(
        resume_relay_cleanup(
            candidate,
            run,
            true,
            control,
            Inspection::load(control, context)?.selection,
            &pin
        )
        .is_err()
    );
    assert_eq!(
        Inspection::load(control, context)?.phase,
        Phase::EffectStarted
    );

    let archived = super::super::super::archive(candidate, run)?;
    assert_eq!(archived.phase, "removed");
    assert!(!active.exists());
    assert_retention_refused(candidate, run)?;
    assert!(
        super::super::super::archive::path(candidate, run)?
            .join("environment-intents")
            .is_dir()
    );
    if std::env::var_os("HACK_RELAY_GRAPH_BRIDGE").is_some() {
        verify_selection_refusals(candidate, run, control, context)?;
    }
    assert!(confirm_relay_cleanup(candidate, run, false, control, pending.selection).is_err());
    assert_eq!(
        Inspection::load(control, context)?.phase,
        Phase::EffectStarted
    );

    // A same-name replacement must not be mistaken for the removed owned container.
    let resource = &receipt.resources["container:web"];
    let engine = Engine::connect(candidate)?;
    let created = engine.request(Method::POST,
        &format!("/v1.53/containers/create?name={}", resource.name),
        Some(&json!({"Image":resource.image, "Cmd":["bun","--version"],
            "Labels":{"hack.test.fixture":"relay-recovery-replacement"},
            "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"Memory":67108864,"NanoCpus":100000000,"PidsLimit":16}})))?;
    let id = created["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?
        .to_string();
    drop(engine);
    let refused_confirmation = confirm_relay_cleanup(
        candidate,
        run,
        true,
        control,
        Inspection::load(control, context)?.selection,
    );
    let engine = Engine::connect_cleanup(candidate)?;
    let replacement = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    assert_eq!(replacement["Id"], id);
    assert_eq!(
        replacement["Config"]["Labels"]["hack.test.fixture"],
        "relay-recovery-replacement"
    );
    assert_eq!(replacement["State"]["Running"], false);
    // Delete only the ID returned by this fixture's create, after proving it survived observation.
    engine.request(Method::DELETE, &format!("/v1.53/containers/{id}"), None)?;
    drop(engine);
    assert!(
        refused_confirmation.is_err(),
        "same-name replacement was incorrectly confirmed"
    );
    assert_eq!(
        Inspection::load(control, context)?.phase,
        Phase::EffectStarted
    );
    let archived_root = super::super::super::archive::path(candidate, run)?;
    kill_at_fault(
        &archived_root,
        run,
        control,
        "confirm-cleanup",
        "relay-before-confirmed-receipt",
    )?;
    assert_confirmation_gap(
        candidate,
        run,
        control,
        context,
        cleanup_enrollment::Phase::Pending,
    )?;
    verify_archived_journal_recovery(candidate, run, control, context)?;
    kill_at_fault(
        &archived_root,
        run,
        control,
        "confirm-cleanup",
        "relay-before-ack",
    )?;
    assert_confirmation_gap(
        candidate,
        run,
        control,
        context,
        cleanup_enrollment::Phase::Confirmed,
    )?;
    let confirmed = confirm_relay_cleanup(
        candidate,
        run,
        true,
        control,
        Inspection::load(control, context)?.selection,
    )?;
    assert_eq!(confirmed.phase, "removed");
    let acknowledged = Inspection::load(control, context)?;
    assert_eq!(acknowledged.phase, Phase::Confirmed);
    assert!(!acknowledged.acknowledgement_pending);
    assert_eq!(
        confirmed.relay_cleanup.as_ref().ok_or_else(refused)?.phase,
        cleanup_enrollment::Phase::Confirmed
    );
    assert!(
        confirm_relay_cleanup(
            candidate,
            run,
            true,
            control,
            Inspection::load(control, context)?.selection
        )
        .is_err()
    );
    assert!(cleanup(candidate, run, true).is_err());
    let exported = export(candidate, run)?;
    assert!(exported.original_retained);
    assert!(exported.bytes > 0);
    let exported_bytes = fs::read(&exported.path).map_err(state::io)?;
    assert_eq!(
        format!("{:x}", Sha256::digest(&exported_bytes)),
        exported.sha256
    );
    let pruned = prune(candidate, run)?;
    assert_eq!(pruned["archive_absent"], true);
    assert_eq!(pruned["export_retained"], true);
    assert!(!archived_root.exists());
    assert_eq!(fs::read(&exported.path).map_err(state::io)?, exported_bytes);
    assert!(
        super::super::super::retention::consumed(candidate, run)?
            .join("state.json")
            .is_file()
    );
    println!(
        "owned-graph-relay-enrollment-recovery-complete: pre-admission-marker, confirmation-gap, acknowledgement-gap, pending-retention-refusal, acknowledged-export-prune"
    );
    println!(
        "owned-graph-relay-recovery-complete: killed-after-effect, archived-environment, wrong-effect-refusal, replacement-refusal, independent-confirmation, no-replay"
    );
    Ok(())
}

/// Snapshot only owned relay metadata and hashes, never application environment values.
fn bridge_snapshot(engine: &Engine<'_>, reservation: &str) -> Result<String, CandidateError> {
    assert!(hex(reservation, 32));
    engine.guest().execute_cleanup(r#"
root=/run/hack-local
slot=$root/relay-slots/slot-0
allocation=$root/graph-relays/$1
for dir in "$root" "$root/relay-slots" "$slot" "$root/graph-relays" "$allocation"; do
  test -d "$dir"; test ! -L "$dir"
  stat -c '%n %d:%i %a %s %Y' "$dir"
done
for file in "$slot/lock" "$slot/state" "$slot/pending" "$allocation/owner" "$allocation/relay" "$allocation/process" "$allocation/socket" "$root/bridge-00.sock"; do
  test ! -L "$file"
  if test -e "$file"; then
    stat -c '%n %d:%i %a %s %Y' "$file"
    if test -f "$file"; then sha256sum "$file"; fi
  else printf 'absent %s\n' "$file"; fi
done
"#, &[reservation])
}

pub(super) fn start_and_verify_live_bridge(
    candidate: &Candidate,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    let snapshot = inspect(candidate, &receipt.run)?;
    let endpoint = snapshot.guest_endpoints.get("web").ok_or_else(refused)?;
    let reserved = reserve_bridge(
        candidate,
        ReserveBridgeOptions {
            run: &receipt.run,
            service: "web",
            slot: 0,
            expected_generation: &endpoint.generation,
        },
    )?;
    let assignment = start_bridge(candidate, &receipt.run, 0, &reserved.reservation)?;
    assert_eq!(assignment.phase, "running");
    let engine = Engine::connect_cleanup(candidate)?;
    let selection = bridges::cleanup::capture(candidate, &engine, receipt)?;
    let before = bridge_snapshot(&engine, &assignment.reservation)?;
    let evidence = relay::capture_cleanup(&engine, 0, &assignment)?;
    let live_refusal = relay::verify_cleanup(&engine, 0, &assignment, &evidence)
        .err()
        .ok_or_else(refused)?;
    assert_eq!(live_refusal.code, "graph_bridge_observation");
    assert_eq!(
        live_refusal.message,
        "Bridge observation refused at stage 16 (process retirement); no guest mutation was performed."
    );
    assert!(bridges::cleanup::verify(candidate, &engine, receipt, &selection).is_err());
    assert_eq!(
        relay::capture_cleanup(&engine, 0, &assignment)?,
        evidence,
        "read-only refusal changed the captured live helper"
    );
    assert_eq!(
        bridge_snapshot(&engine, &assignment.reservation)?,
        before,
        "read-only bridge observation changed owned files"
    );
    println!("owned-graph-relay-live-bridge-refusal-complete: same-process, same-owned-files");
    Ok(())
}

/// These deliberate corruptions are restricted to this fixture's archived selection.
/// Restore the original inode and bytes before checking each refusal assertion.
fn verify_selection_refusals(
    candidate: &Candidate,
    run: &str,
    control: &Path,
    context: Context,
) -> Result<(), CandidateError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let root = super::super::super::archive::path(candidate, run)?;
    let path = root.join("relay-cleanup-bridges.json");
    let backup = root.join("fixture-relay-selection-backup.json");
    let pending = root.join("relay-cleanup-bridges.pending");
    assert!(!backup.exists() && !backup.is_symlink());
    assert!(!pending.exists() && !pending.is_symlink());
    let original = fs::read(&path).map_err(state::io)?;
    assert!(!original.is_empty());
    let inode = fs::symlink_metadata(&path).map_err(state::io)?.ino();
    let observe = || -> Result<bool, CandidateError> {
        let selection = Inspection::load(control, context)?;
        if selection.phase != Phase::EffectStarted {
            return Err(refused());
        }
        Ok(confirm_relay_cleanup(candidate, run, true, control, selection.selection).is_err())
    };
    for case in ["missing", "truncated", "pending"] {
        let outcome = if case == "pending" {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&pending)
                .map_err(state::io)?;
            let result = (|| {
                file.write_all(b"{").map_err(state::io)?;
                file.sync_all().map_err(state::io)?;
                observe()
            })();
            drop(file);
            fs::remove_file(&pending).map_err(state::io)?;
            result
        } else {
            fs::rename(&path, &backup).map_err(state::io)?;
            let result = (|| {
                if case == "truncated" {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&path)
                        .map_err(state::io)?;
                    file.write_all(b"{").map_err(state::io)?;
                    file.sync_all().map_err(state::io)?;
                }
                observe()
            })();
            if case == "truncated" && path.exists() {
                fs::remove_file(&path).map_err(state::io)?;
            }
            fs::rename(&backup, &path).map_err(state::io)?;
            result
        };
        assert!(
            outcome?,
            "{case} bridge selection was incorrectly confirmed"
        );
        assert_eq!(
            Inspection::load(control, context)?.phase,
            Phase::EffectStarted
        );
        assert_eq!(fs::read(&path).map_err(state::io)?, original);
        assert_eq!(fs::symlink_metadata(&path).map_err(state::io)?.ino(), inode);
    }
    println!(
        "owned-graph-relay-selection-refusal-complete: missing, truncated, pending, exact-restoration"
    );
    Ok(())
}

fn assert_retention_refused(candidate: &Candidate, run: &str) -> Result<(), CandidateError> {
    let archived = super::super::super::archive::path(candidate, run)?;
    let before = super::super::super::export::bundle(&archived)?.0;
    let inode = fs::symlink_metadata(archived.join("state.json"))
        .map_err(state::io)?
        .ino();
    assert_eq!(
        export(candidate, run).err().ok_or_else(refused)?.code,
        "graph_relay_enrollment"
    );
    assert_eq!(
        prune(candidate, run).err().ok_or_else(refused)?.code,
        "graph_relay_enrollment"
    );
    assert_eq!(super::super::super::export::bundle(&archived)?.0, before);
    assert_eq!(
        fs::symlink_metadata(archived.join("state.json"))
            .map_err(state::io)?
            .ino(),
        inode
    );
    for path in [
        candidate
            .state_root
            .join("exports/graphs")
            .join(format!("{run}.tar")),
        candidate
            .state_root
            .join("exports/graphs")
            .join(format!("{run}.pending")),
        super::super::super::retention::consumed(candidate, run)?,
    ] {
        assert!(
            matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        );
    }
    Ok(())
}

fn assert_confirmation_gap(
    candidate: &Candidate,
    run: &str,
    control: &Path,
    context: Context,
    phase: cleanup_enrollment::Phase,
) -> Result<(), CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::Coordinator;
    let before = Inspection::load(control, context)?;
    assert_eq!(before.phase, Phase::Confirmed);
    assert!(before.acknowledgement_pending);
    let archived = super::super::super::archive::path(candidate, run)?;
    let receipt: Receipt = state::read(&archived.join("state.json"))?;
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    assert_eq!(marker.phase, phase);
    assert_eq!(marker.selection().operation, before.selection.operation);
    let pin = PinnedEndpoint::load(control, context)?;
    let scope = graph_scope(context, run)?;
    assert!(
        Coordinator::begin_graph(&pin, scope, before.selection.effect).is_err(),
        "unacknowledged graph confirmation allowed coordinator rollover"
    );
    let after = Inspection::load(control, context)?;
    assert_eq!(after.phase, Phase::Confirmed);
    assert!(after.acknowledgement_pending);
    assert_eq!(after.selection.operation, before.selection.operation);
    assert_eq!(after.selection.effect, before.selection.effect);
    assert_retention_refused(candidate, run)
}

/// Controlled partial bytes exercise archived lookup and retention; this is not a
/// claim that the process was killed midway through the filesystem write itself.
fn verify_archived_journal_recovery(
    candidate: &Candidate,
    run: &str,
    control: &Path,
    context: Context,
) -> Result<(), CandidateError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let root = super::super::super::archive::path(candidate, run)?;
    let committed = root.join("state.json");
    let before = fs::read(&committed).map_err(state::io)?;
    let inode = fs::symlink_metadata(&committed).map_err(state::io)?.ino();
    let pending = root.join("state.pending");
    let partial = b"{\"relay_cleanup\":{\"phase\":\"confirmed\"";
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .map_err(state::io)?;
    file.write_all(partial).map_err(state::io)?;
    file.sync_all().map_err(state::io)?;
    drop(file);
    let original = Inspection::load(control, context)?;
    assert_eq!(original.phase, Phase::Confirmed);
    assert!(original.acknowledgement_pending);
    assert!(
        confirm_relay_cleanup(
            candidate,
            run,
            true,
            control,
            Inspection::load(control, context)?.selection
        )
        .is_err()
    );
    assert_eq!(fs::read(&committed).map_err(state::io)?, before);
    assert_eq!(
        fs::symlink_metadata(&committed).map_err(state::io)?.ino(),
        inode
    );
    assert_eq!(fs::read(&pending).map_err(state::io)?, partial);
    let refused_state = Inspection::load(control, context)?;
    assert_eq!(refused_state.phase, Phase::Confirmed);
    assert!(refused_state.acknowledgement_pending);
    assert_eq!(
        refused_state.selection.operation,
        original.selection.operation
    );
    assert_eq!(refused_state.selection.effect, original.selection.effect);
    let reconciled = reconcile(candidate, run)?;
    assert_eq!(reconciled.phase, "removed");
    assert_eq!(
        reconciled.relay_cleanup.as_ref().ok_or_else(refused)?.phase,
        cleanup_enrollment::Phase::Pending
    );
    assert_eq!(fs::read(&committed).map_err(state::io)?, before);
    assert_eq!(
        fs::symlink_metadata(&committed).map_err(state::io)?.ino(),
        inode
    );
    assert!(
        matches!(fs::symlink_metadata(&pending), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    );
    let mut retained = Vec::new();
    for index in 1..=8 {
        let evidence = root
            .join(format!("recovery-{index}"))
            .join("interrupted.pending");
        if evidence.exists() && fs::read(&evidence).map_err(state::io)? == partial {
            retained.push(evidence);
        }
    }
    assert_eq!(
        retained.len(),
        1,
        "partial bytes must be retained exactly once within eight recovery slots"
    );
    let after = Inspection::load(control, context)?;
    assert_eq!(after.phase, Phase::Confirmed);
    assert!(after.acknowledgement_pending);
    assert_eq!(after.selection.operation, original.selection.operation);
    assert_eq!(after.selection.effect, original.selection.effect);
    let engine = Engine::connect_cleanup(candidate)?;
    for resource in reconciled.resources.values() {
        assert!(inspect_resource(&engine, &reconciled, resource)?.is_none());
    }
    println!(
        "owned-graph-relay-archived-journal-recovery-complete: controlled-partial-write, committed-receipt-preserved, bounded-byte-retention, no-replay"
    );
    Ok(())
}
