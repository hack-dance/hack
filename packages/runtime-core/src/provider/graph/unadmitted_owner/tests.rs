use super::*;
use crate::provider::{DependencySocketIntent, identity, state::Owner};
use retained_startup::tests::Fixture;
use std::{
    io::Read,
    os::unix::process::ExitStatusExt,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const ROOT: &str = "HACK_TEST_UNADMITTED_OWNER_ROOT";
const RUN: &str = "HACK_TEST_UNADMITTED_OWNER_RUN";
const READY: &str = "unadmitted-owner-ready";

fn receipt_sha(fixture: &Fixture) -> String {
    format!(
        "{:x}",
        Sha256::digest(fs::read(fixture.graph().join("state.json")).unwrap())
    )
}
fn publication(fixture: &Fixture) -> PathBuf {
    foreground::transport::root(&fixture.candidate, &fixture.run).unwrap()
}
fn relay_control(fixture: &Fixture) -> PathBuf {
    let owner = Owner::load(&fixture.candidate).unwrap();
    startup::control_root(
        &fixture.candidate.state_root,
        &owner.token,
        owner.guest_boot_id.as_deref(),
        Some(&fixture.run),
    )
    .unwrap()
}
fn reservation(fixture: &Fixture) -> PathBuf {
    fixture
        .candidate
        .state_root
        .join(format!("run/dependency-assignments/{}.json", fixture.run))
}
/// Paths under the shared temporary directory that this fixture's run created.
struct Scratch(Vec<PathBuf>);
impl Drop for Scratch {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}
fn scratch(fixture: &Fixture) -> Scratch {
    Scratch(vec![publication(fixture), relay_control(fixture)])
}
fn with_dependency_capacity(fixture: &Fixture) {
    let mut owner = Owner::load(&fixture.candidate).unwrap();
    owner.dependency_sockets = Some(DependencySocketIntent::new(2).unwrap());
    owner.save(&fixture.candidate).unwrap();
}
fn refused_code(fixture: &Fixture, expected: &str) -> &'static str {
    retire_unadmitted_owner(&fixture.candidate, &fixture.run, expected)
        .unwrap_err()
        .code
}

/// A foreground restore owner between publication and admission: it started its
/// relay owner, bound its foreground publication and waits for stdin, which the
/// parent never closes before SIGKILL.
#[test]
#[ignore = "private subprocess fixture: a foreground restore owner killed before admission"]
fn unadmitted_owner_child() {
    let root = PathBuf::from(std::env::var_os(ROOT).expect("explicit fixture root"));
    let run = std::env::var(RUN).expect("explicit run");
    let candidate = Candidate::discover(&root).unwrap();
    let _relay = fixture_relay_publication(&candidate, &run);
    let _publication = foreground::transport::fixture_live_publication(&candidate, &run);
    fs::write(root.join(READY), b"published").unwrap();
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// Start the owner child, wait until both publications exist, and return its
/// exact process identity while it is still alive.
fn spawn_owner(fixture: &Fixture) -> (OwnedChild, ProcessIdentity) {
    let child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::graph::unadmitted_owner::tests::unadmitted_owner_child",
            ])
            .env(ROOT, &fixture.root.0)
            .env(RUN, &fixture.run)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while !fixture.root.0.join(READY).exists() {
        assert!(Instant::now() < deadline, "owner child did not publish");
        std::thread::sleep(Duration::from_millis(5));
    }
    let process = identity::observe(child.0.id() as i32).unwrap();
    (child, process)
}
/// SIGKILL the owner and reap it while still holding its stdin, so the only way
/// out is the kill and no drop runs in the child.
fn kill_and_reap(mut child: OwnedChild) {
    let held = child.0.stdin.take().expect("owner child stdin");
    child.0.kill().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = loop {
        if let Some(exit) = child.0.try_wait().unwrap() {
            break exit;
        }
        assert!(Instant::now() < deadline, "killed owner was not reaped");
        std::thread::sleep(Duration::from_millis(1));
    };
    drop(held);
    assert_eq!(exit.signal(), Some(libc::SIGKILL));
}

#[test]
fn a_restore_owner_killed_before_admission_is_retired_and_the_run_starts_again() {
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    with_dependency_capacity(&fixture);
    let (child, process) = spawn_owner(&fixture);
    // Reserved by the owner before it published, as a dependency restore does.
    dependency_slots::fixture_reservation(&fixture.candidate, &fixture.run, process, 1);
    kill_and_reap(child);
    let receipt = fs::read(fixture.graph().join("state.json")).unwrap();
    let selected = receipt_sha(&fixture);

    // Before: the start is refused and names the supported recovery.
    let refusal = retained_startup::preflight(&fixture.candidate, &fixture.run).unwrap_err();
    assert_eq!(refusal.code, "graph_foreground_owner_exited_unadmitted");
    assert!(refusal.message.contains("hack down --recover"));
    let observed = foreground_owner(&fixture.candidate, &fixture.run).unwrap();
    assert_eq!(observed["foreground"], "exited");
    assert_eq!(observed["phase"], "stopped-data-retained");
    assert_eq!(observed["receipt_sha256"], selected.as_str());
    assert!(observed["live_owner_recovery"].is_null());

    // Any other receipt selection is refused with nothing changed.
    assert_eq!(
        refused_code(&fixture, &"0".repeat(64)),
        "graph_unadmitted_owner_recovery"
    );
    assert!(publication(&fixture).join("owner.json").exists());
    assert!(
        relay_control(&fixture)
            .join("relay-control/owner.json")
            .exists()
    );
    assert!(reservation(&fixture).exists());

    let value = retire_unadmitted_owner(&fixture.candidate, &fixture.run, &selected).unwrap();
    assert_eq!(value["publisher_retired"], true);
    assert_eq!(value["data_retained"], true);
    assert_eq!(value["relay_retired"], true);
    assert_eq!(value["dependency_reservation_released"], true);
    // Data and the acknowledged receipt are exactly retained.
    assert_eq!(
        fs::read(fixture.graph().join("state.json")).unwrap(),
        receipt
    );
    assert!(!publication(&fixture).join("owner.json").exists());
    assert!(!publication(&fixture).join("control.sock").exists());
    assert!(
        !relay_control(&fixture)
            .join("relay-control/owner.json")
            .exists()
    );
    assert!(
        !relay_control(&fixture)
            .join("relay-control/control.sock")
            .exists()
    );
    assert!(!reservation(&fixture).exists());
    assert_eq!(
        foreground_owner(&fixture.candidate, &fixture.run).unwrap()["foreground"],
        "absent"
    );
    // Nothing remains to retire.
    assert_eq!(
        refused_code(&fixture, &selected),
        "graph_unadmitted_owner_recovery"
    );

    // After: the retained start is eligible, and the next owner can bind its
    // relay and foreground publications at the same paths.
    let eligible = retained_startup::preflight(&fixture.candidate, &fixture.run).unwrap();
    assert_eq!(eligible["run"], fixture.run.as_str());
    let relay = fixture_relay_publication(&fixture.candidate, &fixture.run);
    let next = foreground::transport::fixture_live_publication(&fixture.candidate, &fixture.run);
    drop(next);
    drop(relay);
}

#[test]
fn unproven_owner_receipt_or_reservation_refuses_without_effects() {
    // A live owner (this process) still holds the run.
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    let live = foreground::transport::fixture_live_publication(&fixture.candidate, &fixture.run);
    assert_eq!(
        refused_code(&fixture, &receipt_sha(&fixture)),
        "graph_unadmitted_owner_recovery"
    );
    assert!(publication(&fixture).join("owner.json").exists());
    drop(live);

    // An admitted attempt: the receipt left the acknowledged retained stop.
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    let mut receipt = fixture.receipt();
    receipt.phase = "failed-retained".into();
    state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
    foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
    assert_eq!(
        refused_code(&fixture, &receipt_sha(&fixture)),
        "graph_unadmitted_owner_recovery"
    );
    assert!(publication(&fixture).join("owner.json").exists());

    // A reservation made by any other process than the dead owner is not released,
    // and the publication stays in place.
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    with_dependency_capacity(&fixture);
    foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
    let mut other = identity::observe(std::process::id() as i32).unwrap();
    other.pid = 2_000_001;
    dependency_slots::fixture_reservation(&fixture.candidate, &fixture.run, other, 0);
    let before = fs::read(reservation(&fixture)).unwrap();
    assert_eq!(
        refused_code(&fixture, &receipt_sha(&fixture)),
        "dependency_reservation"
    );
    assert_eq!(fs::read(reservation(&fixture)).unwrap(), before);
    assert!(publication(&fixture).join("owner.json").exists());
    assert!(publication(&fixture).join("control.sock").exists());
}

#[test]
fn an_owner_without_relay_or_reservation_is_retired() {
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
    let value =
        retire_unadmitted_owner(&fixture.candidate, &fixture.run, &receipt_sha(&fixture)).unwrap();
    assert_eq!(value["relay_retired"], false);
    assert_eq!(value["dependency_reservation_released"], false);
    retained_startup::preflight(&fixture.candidate, &fixture.run).unwrap();
}

#[test]
fn a_retirement_interrupted_between_its_renames_resumes_by_its_journal() {
    let fixture = Fixture::new();
    let _scratch = scratch(&fixture);
    foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
    let selected = receipt_sha(&fixture);
    // Interrupt the first retirement after the socket rename, before the record's.
    {
        let owner = foreground::DeadOwner::acquire(&fixture.candidate, &fixture.run).unwrap();
        let calls = std::cell::Cell::new(0);
        let interrupt = || {
            calls.set(calls.get() + 1);
            if calls.get() >= 5 {
                return Err(refused());
            }
            Ok(())
        };
        assert!(
            owner
                .retire(&fixture.candidate, &fixture.run, &selected, &interrupt)
                .is_err()
        );
    }
    assert!(!publication(&fixture).join("control.sock").exists());
    assert!(publication(&fixture).join("owner.json").exists());
    // Any other receipt selection is refused; the journal stays as it was.
    assert_eq!(
        refused_code(&fixture, &"0".repeat(64)),
        "graph_unadmitted_owner_recovery"
    );
    retire_unadmitted_owner(&fixture.candidate, &fixture.run, &selected).unwrap();
    assert!(!publication(&fixture).join("owner.json").exists());
    retained_startup::preflight(&fixture.candidate, &fixture.run).unwrap();
}
