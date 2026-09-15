//! Actual driver loss with live leases; all payloads are synthetic and local to the helper.
use super::*;
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Instant,
};

fn execute(
    candidate: &Candidate,
    path: &Path,
    run_id: &str,
    restore: bool,
) -> Result<Receipt, CandidateError> {
    let project = || PlanOptions {
        project: path,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    };
    let plan = project::plan(candidate, project())?;
    let managed = BTreeMap::from([(
        "app".into(),
        BTreeMap::from([(
            "TOKEN".into(),
            if restore {
                "synthetic-restored"
            } else {
                "synthetic-initial"
            }
            .into(),
        )]),
    )]);
    let public = BTreeMap::new();
    let readiness = BTreeMap::from([("app".into(), Condition::Started)]);
    let options = RunOptions {
        project: project(),
        expected_plan: &plan.plan_id,
        source_revision: None,
        non_secret_values: &public,
        readiness: &readiness,
        run_id,
        timeout: Duration::from_secs(30),
    };
    if restore {
        restore_with_environment(candidate, options, &managed, Duration::from_secs(120))
    } else {
        run_with_environment(candidate, options, &managed, Duration::from_secs(120))
    }
}
#[test]
#[ignore = "Owned subprocess helper only"]
fn environment_crash_child() {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    if std::env::var("HACK_LOCAL_GRAPH_ACTION").unwrap() == "cleanup" {
        cleanup(
            &candidate,
            &std::env::var("HACK_LOCAL_GRAPH_RUN").unwrap(),
            false,
        )
        .unwrap();
        panic!("cleanup helper unexpectedly completed");
    }
    execute(
        &candidate,
        Path::new(&std::env::var("HACK_LOCAL_GRAPH_PROJECT").unwrap()),
        &std::env::var("HACK_LOCAL_GRAPH_RUN").unwrap(),
        std::env::var("HACK_LOCAL_GRAPH_ACTION").unwrap() == "restore",
    )
    .unwrap();
    panic!("fault helper unexpectedly completed");
}
struct OwnedChild(Option<Child>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[test]
#[ignore = "Manual owned VM, launcher feature, pinned image and external watchdog"]
fn managed_driver_loss_preserves_cleanup_and_requires_fresh_restore() -> Result<(), CandidateError>
{
    use std::os::unix::process::ExitStatusExt;
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    for (restore, point) in [
        (false, "after-environment-stage"),
        (false, "after-create"),
        (false, "after-start"),
        (true, "restore-intent"),
        (true, "after-environment-stage"),
        (true, "after-create"),
        (true, "after-start"),
    ] {
        let fixture = tests::Fixture::new();
        let run = format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        state::write(
            &fixture.0.join("compose.yaml"),
            &json!({"services":{"app":{"image":image,"user":"1001:1001","init":true,"read_only":true,"network_mode":"none","environment":{"TOKEN":null},"entrypoint":["/usr/local/bin/bun","-e","if(!process.env.TOKEN?.startsWith('synthetic-'))process.exit(71);setInterval(()=>{},1000)"],"command":[]}}}),
        )?;
        let root = directory(&candidate, &run)?;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<(), CandidateError> {
                if restore {
                    execute(&candidate, &fixture.0, &run, false)?;
                    cleanup(&candidate, &run, false)?;
                }
                let child = Command::new(std::env::current_exe().map_err(state::io)?)
                    .args([
                        "--ignored",
                        "--exact",
                        "provider::graph::environment_crash_test::environment_crash_child",
                    ])
                    .env("HACK_LOCAL_GRAPH_PROJECT", &fixture.0)
                    .env("HACK_LOCAL_GRAPH_RUN", &run)
                    .env(
                        "HACK_LOCAL_GRAPH_ACTION",
                        if restore { "restore" } else { "run" },
                    )
                    .env("HACK_LOCAL_GRAPH_FAULT", point)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(state::io)?;
                let mut child = OwnedChild(Some(child));
                let marker = root.join(format!("fault-{point}.json"));
                let deadline = Instant::now() + Duration::from_secs(20);
                while !marker.exists() {
                    assert!(
                        child
                            .0
                            .as_mut()
                            .unwrap()
                            .try_wait()
                            .map_err(state::io)?
                            .is_none(),
                        "helper exited before marker"
                    );
                    assert!(Instant::now() < deadline, "fault marker timed out");
                    std::thread::sleep(Duration::from_millis(20));
                }
                let marked: Value = state::read(&marker)?;
                assert_eq!(marked["run"], run);
                assert_eq!(marked["point"], point);
                child.0.as_mut().unwrap().kill().map_err(state::io)?;
                assert_eq!(
                    child
                        .0
                        .as_mut()
                        .unwrap()
                        .wait()
                        .map_err(state::io)?
                        .signal(),
                    Some(libc::SIGKILL)
                );
                child.0 = None;
                let engine = Engine::connect(&candidate)?;
                let (receipt, _) = load(&candidate, &engine, &run)?;
                let resource = &receipt.resources["container:app"];
                let present = inspect_resource(&engine, &receipt, resource)?;
                let slots = super::super::environment_recovery::graph_slots(
                    &candidate,
                    engine.guest(),
                    &run,
                )?;
                assert_eq!(
                    slots.len(),
                    if restore && point != "restore-intent" {
                        2
                    } else {
                        1
                    }
                );
                if point == "restore-intent" || point == "after-environment-stage" {
                    assert!(present.is_none());
                } else {
                    let value = present.unwrap();
                    assert!(
                        !serde_json::to_string(&value)
                            .unwrap()
                            .contains("synthetic-initial")
                    );
                    assert!(
                        !serde_json::to_string(&value)
                            .unwrap()
                            .contains("synthetic-restored")
                    );
                    if point == "after-create" {
                        assert!(resource.id.is_none());
                        assert_eq!(value["State"]["Status"], "created");
                    } else {
                        assert!(resource.id.is_some());
                        assert_eq!(value["State"]["Running"], true);
                    }
                }
                drop(engine);
                let before = fs::read(root.join("state.json")).map_err(state::io)?;
                assert_eq!(
                    execute(&candidate, &fixture.0, &run, true)
                        .unwrap_err()
                        .code,
                    "graph_restore_refused"
                );
                assert_eq!(
                    fs::read(root.join("state.json")).map_err(state::io)?,
                    before
                );
                cleanup(&candidate, &run, false)?;
                cleanup(&candidate, &run, false)?;
                let fresh = execute(&candidate, &fixture.0, &run, true)?;
                assert_eq!(fresh.phase, "ready-observed");
                Ok(())
            },
        ));
        let cleaned = cleanup(&candidate, &run, true);
        outcome.unwrap()?;
        cleaned?;
        cleanup(&candidate, &run, true)?;
    }
    Ok(())
}

#[test]
#[ignore = "Manual owned VM, launcher feature and external watchdog"]
fn cleanup_driver_loss_recovers_uncommitted_absence_and_retires_leases()
-> Result<(), CandidateError> {
    use std::os::unix::process::ExitStatusExt;
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = tests::Fixture::new();
    let run = format!(
        "{:032x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":{"app":{"image":image,"user":"1001:1001","init":true,"read_only":true,"network_mode":"none","environment":{"TOKEN":null},"entrypoint":["/usr/local/bin/bun","-e","setInterval(()=>{},1000)"],"command":[]}}}),
    )?;
    let root = directory(&candidate, &run)?;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || -> Result<(), CandidateError> {
            execute(&candidate, &fixture.0, &run, false)?;
            let child = Command::new(std::env::current_exe().map_err(state::io)?)
                .args([
                    "--ignored",
                    "--exact",
                    "provider::graph::environment_crash_test::environment_crash_child",
                ])
                .env("HACK_LOCAL_GRAPH_PROJECT", &fixture.0)
                .env("HACK_LOCAL_GRAPH_RUN", &run)
                .env("HACK_LOCAL_GRAPH_ACTION", "cleanup")
                .env("HACK_LOCAL_GRAPH_FAULT", "cleanup-after-remove")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(state::io)?;
            let mut child = OwnedChild(Some(child));
            let marker = root.join("fault-cleanup-after-remove.json");
            let deadline = Instant::now() + Duration::from_secs(20);
            while !marker.exists() {
                assert!(
                    child
                        .0
                        .as_mut()
                        .unwrap()
                        .try_wait()
                        .map_err(state::io)?
                        .is_none()
                );
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(20));
            }
            let value: Value = state::read(&marker)?;
            assert_eq!(value["run"], run);
            assert_eq!(value["point"], "cleanup-after-remove");
            child.0.as_mut().unwrap().kill().map_err(state::io)?;
            assert_eq!(
                child
                    .0
                    .as_mut()
                    .unwrap()
                    .wait()
                    .map_err(state::io)?
                    .signal(),
                Some(libc::SIGKILL)
            );
            child.0 = None;
            let engine = Engine::connect_cleanup(&candidate)?;
            let (receipt, _) = load(&candidate, &engine, &run)?;
            assert_eq!(receipt.phase, "cleanup-intent");
            assert_eq!(receipt.resources["container:app"].phase, "started");
            assert!(
                inspect_resource(&engine, &receipt, &receipt.resources["container:app"])?.is_none()
            );
            let slots =
                super::super::environment_recovery::graph_slots(&candidate, engine.guest(), &run)?;
            assert_eq!(slots.len(), 1);
            assert_eq!(engine.guest().execute_cleanup("set -e; (test -d \"/run/$1\" && mountpoint -q \"/run/$1\") >/dev/null 2>&1; printf 'present\\n'", &[&slots[0].0])?,"present\n");
            drop(engine);
            assert_eq!(
                execute(&candidate, &fixture.0, &run, true)
                    .unwrap_err()
                    .code,
                "graph_restore_refused"
            );
            cleanup(&candidate, &run, false)?;
            cleanup(&candidate, &run, false)?;
            assert_eq!(
                execute(&candidate, &fixture.0, &run, true)?.phase,
                "ready-observed"
            );
            Ok(())
        },
    ));
    let cleaned = cleanup(&candidate, &run, true);
    outcome.unwrap()?;
    cleaned?;
    cleanup(&candidate, &run, true)?;
    Ok(())
}
