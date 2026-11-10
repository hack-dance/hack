use super::recovery::{
    Acknowledgement, Journal, Step, StopDecision, acknowledgement, steps, stop_decision,
};
use super::*;
use crate::provider::{identity, relay_owner::Context};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

struct ShortRoot(PathBuf);
impl ShortRoot {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = fs::canonicalize("/tmp").unwrap().join(format!(
            "hgack-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        state::private_directory(&root).unwrap();
        Self(root)
    }
}
impl Drop for ShortRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn original() -> Receipt {
    serde_json::from_value(json!({
        "version": 1,
        "run": "a".repeat(32),
        "owner": "b".repeat(32),
        "namespace": "private",
        "plan_id": "c".repeat(64),
        "phase": "cleanup-intent",
        "readiness": {},
        "resources": {
            "container:failed": {"kind":"container","key":"failed","name":"failed","id":"d".repeat(64),"image":"sha256:image","phase":"uncertain"},
            "container:reserved": {"kind":"container","key":"reserved","name":"reserved","id":null,"image":"sha256:image","phase":"reserved"},
            "network:private": {"kind":"network","key":"private","name":"private","id":"e".repeat(64),"image":null,"phase":"created"},
            "volume:data": {"kind":"volume","key":"data","name":"data","id":null,"image":null,"phase":"created"}
        }
    })).unwrap()
}

fn selected(original: &Receipt) -> Selection {
    Selection {
        version: 1,
        run: original.run.clone(),
        owner: original.owner.clone(),
        boot: "f".repeat(32),
        receipt_sha256: digest(&serde_json::to_vec_pretty(original).unwrap()),
        coordinator_sha256: "1".repeat(64),
        coordinator_identity_sha256: "7".repeat(64),
        foreground_sha256: "2".repeat(64),
        relay_sha256: "3".repeat(64),
        bridge_sha256: "4".repeat(64),
        environment_sha256: "5".repeat(64),
        reservation_sha256: "6".repeat(64),
        shutdown_rebased: false,
        failed_key: "container:failed".into(),
        failed_id: "d".repeat(64),
        owner_stopped: false,
    }
}

#[test]
fn retained_plain_volume_requires_created_receipt_and_present_inspection() {
    let receipt = original();
    let volume = &receipt.resources["volume:data"];
    let observed = json!({"CreatedAt":"2026-09-18T00:00:00Z"});
    assert!(retained_volume_observation(&receipt, volume, Some(&observed)).is_ok());
    assert!(retained_volume_observation(&receipt, volume, None).is_err());
    assert!(retained_volume_observation(&receipt, volume, Some(&json!({}))).is_err());
    let mut changed = volume.clone();
    changed.phase = "absent".into();
    assert!(retained_volume_observation(&receipt, &changed, Some(&observed)).is_err());
}

#[test]
fn retained_cache_requires_exact_binding_and_provenance() {
    let mut receipt = original();
    let mut volume = receipt.resources["volume:data"].clone();
    let cache = dependency_cache::CacheBinding {
        scope: "a".repeat(64),
        fingerprint: "b".repeat(64),
        image: format!("sha256:{}", "c".repeat(64)),
    };
    volume.name = cache.name();
    volume.cache = Some(cache);
    volume.cache_provenance = Some(
        serde_json::from_value(json!({
            "version":1,
            "origin":"adopted",
            "boot":"prior-boot",
            "identity":{"created_at":"2026-09-18T00:00:00Z","directory":"1:2"},
            "initializers":[],
            "completed":{}
        }))
        .unwrap(),
    );
    receipt
        .resources
        .insert("volume:data".into(), volume.clone());
    let observed = json!({"CreatedAt":"2026-09-18T00:00:00Z"});
    assert!(retained_volume_observation(&receipt, &volume, Some(&observed)).is_ok());
    assert!(retained_volume_observation(&receipt, &volume, None).is_err());

    let mut missing_provenance = volume.clone();
    missing_provenance.cache_provenance = None;
    assert!(retained_volume_observation(&receipt, &missing_provenance, Some(&observed)).is_err());
    let mut stale_name = volume.clone();
    stale_name.name = "replacement".into();
    assert!(retained_volume_observation(&receipt, &stale_name, Some(&observed)).is_err());
    let mut stale_binding = volume.clone();
    stale_binding.cache.as_mut().unwrap().fingerprint = "d".repeat(64);
    assert!(retained_volume_observation(&receipt, &stale_binding, Some(&observed)).is_err());
    let mut malformed_provenance = volume;
    malformed_provenance.cache_provenance = Some(
        serde_json::from_value(json!({
            "version":1,
            "origin":"adopted",
            "boot":"prior-boot",
            "identity":{"created_at":"2026-09-18T00:00:00Z","directory":"missing"},
            "initializers":[],
            "completed":{}
        }))
        .unwrap(),
    );
    assert!(retained_volume_observation(&receipt, &malformed_provenance, Some(&observed)).is_err());
}

#[test]
fn step_plan_never_deletes_retained_volume_and_keeps_reserved_name_check() {
    let planned = steps(&original(), &["slot-one".into()]).unwrap();
    assert_eq!(
        planned,
        vec![
            Step::Stop("container:failed".into()),
            Step::Delete("container:failed".into()),
            Step::Delete("container:reserved".into()),
            Step::Delete("network:private".into()),
            Step::Startup,
            Step::Environment("slot-one".into()),
        ]
    );
}

#[test]
fn journal_binds_original_and_selection_and_refuses_invalid_completion() {
    let original = original();
    let selection = selected(&original);
    let expected = selection.digest().unwrap();
    let steps = steps(&original, &[]).unwrap();
    let mut journal = Journal {
        version: 1,
        selection,
        selection_sha256: expected.clone(),
        original,
        steps,
        cursor: 0,
        pending: false,
        graph_complete: false,
        publisher_retired: false,
        reservation_released: false,
    };
    assert!(journal.validate_basic(&"a".repeat(32), &expected).is_ok());
    assert!(journal.validate_phase(&journal.original).is_ok());
    let mut stopped = journal.original.clone();
    stopped.phase = "stopped-data-retained".into();
    assert!(journal.validate_phase(&stopped).is_err());
    journal.cursor = journal.steps.len();
    assert!(journal.validate_phase(&stopped).is_ok());
    journal.pending = true;
    assert!(journal.validate_phase(&stopped).is_err());
    journal.pending = false;
    assert!(journal.validate_basic(&"b".repeat(32), &expected).is_err());
    journal.cursor = 0;
    journal.graph_complete = true;
    assert!(journal.validate_basic(&"a".repeat(32), &expected).is_err());
    journal.graph_complete = false;
    journal
        .original
        .resources
        .get_mut("volume:data")
        .unwrap()
        .name = "replacement".into();
    assert!(journal.validate_basic(&"a".repeat(32), &expected).is_err());
}

#[test]
fn uncertain_stop_never_reissues_to_still_running_or_failed_created_target() {
    let receipt = original();
    let resource = &receipt.resources["container:failed"];
    let created = json!({
        "Id":resource.id,"RestartCount":0,
        "Config":{"StopTimeout":10,"StopSignal":null},
        "State":{"Paused":false,"Restarting":false,"Dead":false,"OOMKilled":false,
            "ExitCode":128,"Running":false,"Pid":0,"Status":"created",
            "StartedAt":"0001-01-01T00:00:00Z"}
    });
    assert!(failed_created(resource, &created).is_ok());
    assert_eq!(
        stop_decision(resource, &created, false).unwrap(),
        StopDecision::AlreadyTerminal
    );
    assert!(stop_decision(resource, &created, true).is_err());
    let mut now_running = created.clone();
    now_running["State"]["Status"] = json!("running");
    now_running["State"]["Running"] = json!(true);
    now_running["State"]["Pid"] = json!(42);
    now_running["State"]["ExitCode"] = json!(0);
    now_running["State"]["StartedAt"] = json!("2026-10-02T12:00:00Z");
    assert!(failed_created(resource, &now_running).is_err());
    assert_eq!(
        stop_decision(resource, &now_running, false).unwrap(),
        StopDecision::IssueOneStop
    );
    assert!(stop_decision(resource, &now_running, true).is_err());
    let mut exited = now_running;
    exited["State"]["Status"] = json!("exited");
    exited["State"]["Running"] = json!(false);
    exited["State"]["Pid"] = json!(0);
    assert_eq!(
        stop_decision(resource, &exited, true).unwrap(),
        StopDecision::AlreadyTerminal
    );
}

#[test]
fn all_ack_crash_windows_require_the_exact_marker_pairing() {
    use cleanup_enrollment::Phase as Marker;
    assert_eq!(
        acknowledgement(Marker::Pending, Phase::EffectStarted, true, true).unwrap(),
        Acknowledgement::Confirm
    );
    // Coordinator confirmation can persist before the graph marker is written.
    assert_eq!(
        acknowledgement(Marker::Pending, Phase::Confirmed, true, true).unwrap(),
        Acknowledgement::Confirm
    );
    assert_eq!(
        acknowledgement(Marker::Confirmed, Phase::Confirmed, true, true).unwrap(),
        Acknowledgement::Confirm
    );
    assert_eq!(
        acknowledgement(Marker::Confirmed, Phase::Confirmed, false, true).unwrap(),
        Acknowledgement::Complete
    );
    for (marker, coordinator, pending, selected) in [
        (Marker::Pending, Phase::Confirmed, false, true),
        (Marker::Pending, Phase::Intent, true, true),
        (Marker::Confirmed, Phase::EffectStarted, true, true),
        (Marker::Confirmed, Phase::Confirmed, false, false),
    ] {
        assert!(acknowledgement(marker, coordinator, pending, selected).is_err());
    }
}

#[test]
fn incomplete_hint_tracks_publication_and_reservation_without_overwriting_history() {
    let fixture = super::super::tests::Fixture::new();
    let original = original();
    let selection = selected(&original);
    let sha = selection.digest().unwrap();
    let planned = steps(&original, &[]).unwrap();
    let mut record = Journal {
        version: 1,
        selection,
        selection_sha256: sha,
        original,
        cursor: planned.len(),
        steps: planned,
        pending: false,
        graph_complete: true,
        publisher_retired: false,
        reservation_released: false,
    };
    state::write(&fixture.0.join(JOURNAL), &record).unwrap();
    assert!(incomplete(&fixture.0, &"a".repeat(32)).unwrap());
    record.publisher_retired = true;
    state::write(&fixture.0.join(JOURNAL), &record).unwrap();
    assert!(incomplete(&fixture.0, &"a".repeat(32)).unwrap());
    record.reservation_released = true;
    state::write(&fixture.0.join(JOURNAL), &record).unwrap();
    assert!(!incomplete(&fixture.0, &"a".repeat(32)).unwrap());
    record.publisher_retired = false;
    state::write(&fixture.0.join(JOURNAL), &record).unwrap();
    assert!(incomplete(&fixture.0, &"a".repeat(32)).is_err());
}

#[test]
fn ack_boundary_rechecks_absent_publication_after_confirmed_receipt_write() {
    let fixture = ShortRoot::new();
    let control = fixture.0.join("relay-control");
    state::private_directory(&control).unwrap();
    drop(state::Lock::acquire(&control).unwrap());
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let process = identity::observe(child.id() as i32).unwrap();
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(state::check_private_directory(&fixture.0).is_ok());
    assert!(state::Lock::acquire_existing(&control).is_ok());
    assert!(identity::verify(&process, &process, &process.executable, process.uid).is_ok());
    assert!(!identity::alive(process.pid).unwrap());
    let witness = dead::CleanupWitness::acquire(
        &fixture.0,
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        },
        &process,
    )
    .unwrap();
    state::write(&fixture.0.join("state.json"), &json!({"phase":"confirmed"})).unwrap();
    assert!(host_relay::verify_selected_relay(Some(&witness)).is_ok());
    fs::write(control.join("control.sock"), b"replacement").unwrap();
    assert!(host_relay::verify_selected_relay(Some(&witness)).is_err());
}

fn dead_observation(id: &str) -> Value {
    json!({
        "Id":id,"RestartCount":0,
        "Config":{"StopTimeout":10,"StopSignal":null},
        "State":{"Paused":false,"Restarting":false,"Dead":true,"OOMKilled":false,
            "ExitCode":1,"Running":false,"Pid":0,"Status":"dead",
            "StartedAt":"2026-10-02T12:00:00Z"}
    })
}

/// HACK-1968: selections journaled before the owner-stopped kind existed keep their
/// exact digest, and the new kind is bound into the digest when present.
#[test]
fn owner_stopped_selection_is_backward_compatible_and_digest_bound() {
    let original = original();
    let legacy = selected(&original);
    let encoded = serde_json::to_value(&legacy).unwrap();
    assert!(encoded.get("owner_stopped").is_none());
    let decoded: Selection = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded, legacy);
    assert!(!decoded.owner_stopped);
    let mut stopped = legacy.clone();
    stopped.owner_stopped = true;
    assert_ne!(stopped.digest().unwrap(), legacy.digest().unwrap());
    let roundtrip: Selection =
        serde_json::from_value(serde_json::to_value(&stopped).unwrap()).unwrap();
    assert_eq!(roundtrip, stopped);
}

#[test]
fn owner_stopped_journal_admits_the_started_failed_container_only_for_that_kind() {
    let mut original = original();
    original
        .resources
        .get_mut("container:failed")
        .unwrap()
        .phase = "started".into();
    let mut selection = selected(&original);
    selection.owner_stopped = true;
    let expected = selection.digest().unwrap();
    let mut journal = Journal {
        version: 1,
        selection,
        selection_sha256: expected.clone(),
        steps: steps(&original, &[]).unwrap(),
        original,
        cursor: 0,
        pending: false,
        graph_complete: false,
        publisher_retired: false,
        reservation_released: false,
    };
    assert!(journal.validate_basic(&"a".repeat(32), &expected).is_ok());
    // The created-failure kind still requires the uncertain create it selected.
    journal.selection.owner_stopped = false;
    journal.selection_sha256 = journal.selection.digest().unwrap();
    let legacy = journal.selection_sha256.clone();
    assert!(journal.validate_basic(&"a".repeat(32), &legacy).is_err());
}

#[test]
fn owner_stop_records_bind_run_owner_plan_and_container_keys() {
    let root = ShortRoot::new();
    let receipt = original();
    assert!(owner_stop_records(&root.0, &receipt).unwrap().is_none());
    let write = |value: Value| {
        state::write(&root.0.join("shutdown.json"), &value).unwrap();
    };
    let record = |run: &str, owner: &str, plan: &str, key: &str, id: &str| {
        json!({"version":1,"run":run,"owner":owner,"plan":plan,"containers":{
            key:{"id":id,"exit_code":1,"oom_killed":false,"stop_requested":false}}})
    };
    let (run, owner, plan) = (
        receipt.run.clone(),
        receipt.owner.clone(),
        receipt.plan_id.clone(),
    );
    let id = "d".repeat(64);
    write(record(&run, &owner, &plan, "container:failed", &id));
    assert_eq!(
        owner_stop_records(&root.0, &receipt).unwrap().unwrap(),
        BTreeMap::from([("container:failed".to_owned(), id.clone())])
    );
    for invalid in [
        record("other", &owner, &plan, "container:failed", &id),
        record(&run, "other", &plan, "container:failed", &id),
        record(&run, &owner, "other", "container:failed", &id),
        record(&run, &owner, &plan, "volume:data", &id),
        record(&run, &owner, &plan, "container:missing", &id),
        record(&run, &owner, &plan, "container:failed", "not-an-id"),
    ] {
        write(invalid);
        assert!(owner_stop_records(&root.0, &receipt).is_err());
    }
}

#[test]
fn a_dead_generation_is_stopped_terminal_and_a_removal_retry_target() {
    let receipt = original();
    let resource = &receipt.resources["container:failed"];
    let id = resource.id.clone().unwrap();
    let dead = dead_observation(&id);
    assert!(stopped_terminal(resource, &dead).is_ok());
    assert!(recovery::dead_terminal(resource, &dead));
    assert_eq!(
        stop_decision(resource, &dead, false).unwrap(),
        StopDecision::AlreadyTerminal
    );
    // A dead container is never the created failure the original kind selects.
    assert!(failed_created(resource, &dead).is_err());
    // Another generation, or one with a process, is neither.
    let other = dead_observation(&"e".repeat(64));
    assert!(stopped_terminal(resource, &other).is_err());
    assert!(!recovery::dead_terminal(resource, &other));
    let mut running = dead.clone();
    running["State"]["Dead"] = json!(false);
    running["State"]["Running"] = json!(true);
    running["State"]["Status"] = json!("running");
    running["State"]["Pid"] = json!(42);
    assert!(stopped_terminal(resource, &running).is_err());
    assert!(!recovery::dead_terminal(resource, &running));
    let mut exited = running;
    exited["State"]["Running"] = json!(false);
    exited["State"]["Status"] = json!("exited");
    exited["State"]["Pid"] = json!(0);
    assert!(stopped_terminal(resource, &exited).is_ok());
    assert!(!recovery::dead_terminal(resource, &exited));
}

/// A run restored after a finished recovery and failed again keeps its run identity
/// but has new container generations; only then is the old journal history.
#[test]
fn only_a_finished_journal_of_replaced_generations_is_superseded() {
    let original = original();
    let selection = selected(&original);
    let journal = Journal {
        version: 1,
        selection_sha256: selection.digest().unwrap(),
        selection,
        steps: steps(&original, &[]).unwrap(),
        cursor: 0,
        pending: false,
        graph_complete: true,
        publisher_retired: true,
        reservation_released: true,
        original: original.clone(),
    };
    let mut restored = original.clone();
    restored.resources.get_mut("container:failed").unwrap().id = Some("9".repeat(64));
    assert!(superseded(&journal, &restored));
    // The same generation is the journal's own run, never history.
    assert!(!superseded(&journal, &original));
    // Every step must have finished.
    for unfinished in 0..3 {
        let mut partial = journal.clone();
        match unfinished {
            0 => partial.graph_complete = false,
            1 => partial.publisher_retired = false,
            _ => partial.reservation_released = false,
        }
        assert!(!superseded(&partial, &restored));
    }
    // The new generation must itself be a pending cleanup of the same run and plan.
    for change in ["phase", "owner", "namespace", "plan"] {
        let mut other = restored.clone();
        match change {
            "phase" => other.phase = "ready-observed".into(),
            "owner" => other.owner = "e".repeat(32),
            "namespace" => other.namespace = "other".into(),
            _ => other.plan_id = "e".repeat(64),
        }
        assert!(!superseded(&journal, &other), "{change}");
    }
}

#[test]
fn repaired_shutdown_journal_requires_started_exact_original_and_retains_stop_fence() {
    let mut original = original();
    let mut selection = selected(&original);
    selection.shutdown_rebased = true;
    let mut record = Journal {
        version: 1,
        selection_sha256: selection.digest().unwrap(),
        selection,
        original: original.clone(),
        steps: steps(&original, &[]).unwrap(),
        cursor: 0,
        pending: false,
        graph_complete: false,
        publisher_retired: false,
        reservation_released: false,
    };
    assert!(
        record
            .validate_basic(&original.run, &record.selection_sha256)
            .is_err()
    );
    original
        .resources
        .get_mut("container:failed")
        .unwrap()
        .phase = "started".into();
    record.original = original.clone();
    record.selection.receipt_sha256 = digest(&serde_json::to_vec_pretty(&original).unwrap());
    record.selection_sha256 = record.selection.digest().unwrap();
    record
        .validate_basic(&original.run, &record.selection_sha256)
        .unwrap();
    let resource = &original.resources["container:failed"];
    let running = json!({"Id":resource.id,"Config":{"StopTimeout":1,"StopSignal":null},
        "State":{"Paused":false,"Restarting":false,"Dead":false,"OOMKilled":false,
            "ExitCode":0,"Running":true,"Pid":42,"Status":"running"}});
    assert_eq!(
        stop_decision(resource, &running, false).unwrap(),
        StopDecision::IssueOneStop
    );
    assert!(
        stop_decision(resource, &running, true).is_err(),
        "a pending stop cannot be sent again"
    );
    record
        .original
        .resources
        .get_mut("container:failed")
        .unwrap()
        .id = Some("f".repeat(64));
    assert!(
        record
            .validate_basic(&original.run, &record.selection_sha256)
            .is_err()
    );
}

#[test]
fn legacy_cleanup_selection_serialization_keeps_its_original_shape() {
    let original = original();
    let selection = selected(&original);
    let encoded = serde_json::to_value(&selection).unwrap();
    assert!(encoded.get("shutdown_rebased").is_none());
    let decoded: Selection = serde_json::from_value(encoded).unwrap();
    assert!(!decoded.shutdown_rebased);
    assert_eq!(decoded.digest().unwrap(), selection.digest().unwrap());
}

/// PR 660 review: two recoveries of one restored run both validated the superseded
/// journal. The first retires it and publishes a new journal with a pending-effect
/// fence; the second's stale retirement must refuse instead of moving that new journal
/// over the archive. A rewrite with identical bytes is still a different file.
#[test]
fn a_stale_retirement_never_moves_a_journal_it_did_not_validate() {
    let root = ShortRoot::new();
    let journal = root.0.join(JOURNAL);
    let archive = root
        .0
        .join(format!("{RETIRED_PREFIX}{}.json", "f".repeat(64)));
    let old = json!({"generation":"old","reservation_released":true});
    state::write(&journal, &old).unwrap();
    let first = journal_identity(&root.0).unwrap().unwrap();
    let second = journal_identity(&root.0).unwrap().unwrap();
    assert_eq!(first, second);
    rename_unchanged(&root.0, &archive, &first).unwrap();
    assert!(journal_identity(&root.0).unwrap().is_none());
    let fenced = json!({"generation":"new","pending":true});
    state::write(&journal, &fenced).unwrap();
    assert!(rename_unchanged(&root.0, &archive, &second).is_err());
    let read = |path: &Path| state::read_bounded::<Value>(path, LIMIT).unwrap();
    assert_eq!(read(&journal), fenced);
    assert_eq!(read(&archive), old);

    // The same bytes rewritten between check and rename are a different file.
    let other = root
        .0
        .join(format!("{RETIRED_PREFIX}{}.json", "e".repeat(64)));
    let checked = journal_identity(&root.0).unwrap().unwrap();
    state::write(&journal, &fenced).unwrap();
    assert!(rename_unchanged(&root.0, &other, &checked).is_err());
    assert!(fs::symlink_metadata(&other).is_err());
    // An unchanged journal still refuses an existing archive target.
    let unchanged = journal_identity(&root.0).unwrap().unwrap();
    assert!(rename_unchanged(&root.0, &archive, &unchanged).is_err());
    assert_eq!(read(&journal), fenced);
    assert_eq!(read(&archive), old);
}
