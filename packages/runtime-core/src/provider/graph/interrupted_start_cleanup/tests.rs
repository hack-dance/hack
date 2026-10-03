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
        failed_key: "container:failed".into(),
        failed_id: "d".repeat(64),
    }
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
