use super::*;
use std::{io::Read, path::Path, time::Instant};
fn token() -> String {
    let mut bytes = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn options<'a>(
    fixture: &'a Path,
    plan: &'a str,
    run: &'a str,
    readiness: &'a BTreeMap<String, Condition>,
    public: &'a BTreeMap<String, String>,
) -> RunOptions<'a> {
    RunOptions {
        project: PlanOptions {
            project: fixture,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
        expected_plan: plan,
        source_revision: None,
        non_secret_values: public,
        readiness,
        run_id: run,
        timeout: Duration::from_secs(30),
    }
}
fn wait_exit(
    engine: &Engine<'_>,
    receipt: &Receipt,
    service: &str,
    expected: i64,
) -> Result<(), CandidateError> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let value = inspect_resource(
            engine,
            receipt,
            &receipt.resources[&format!("container:{service}")],
        )?
        .unwrap();
        if value["State"]["Running"] == false {
            assert_eq!(value["State"]["ExitCode"], expected);
            return Ok(());
        }
        assert!(Instant::now() < deadline, "owned application did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
}
#[test]
#[ignore = "Manual owned VM, pinned Bun image, launcher feature and external watchdog"]
fn graph_startup_delivers_nonroot_values_and_preserves_exec_signals_and_exit_codes() {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit root"),
    ))
    .unwrap();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned image");
    let fixture = super::tests::Fixture::new();
    let nonce = token();
    let mut services = serde_json::Map::new();
    let mut managed = BTreeMap::new();
    for (name, uid, signal, exit) in [
        ("root", 0, "", 0),
        ("term", 1001, "SIGTERM", 42),
        ("int", 1002, "SIGINT", 43),
    ] {
        let pid_check = if uid == 0 {
            "process.pid!==1"
        } else {
            "process.ppid!==1"
        };
        let check = format!(
            "const v=await Bun.file('/run/hack-environment.json').json();if(process.getuid()!=={uid}||process.getgid()!=={uid}||{pid_check}||process.env.TOKEN!==v.TOKEN||!process.env.TOKEN.startsWith('synthetic-startup-{uid}-'))process.exit(71);"
        );
        let program = if uid == 0 {
            format!("{check}console.log('root-exec-ok')")
        } else {
            format!(
                "{check}process.on('{signal}',()=>{{console.log('signal-ok');process.exit({exit})}});console.log('ready');setInterval(()=>{{}},1000)"
            )
        };
        let mut service = json!({"image":image,"read_only":true,"network_mode":"none","init":uid!=0,"user":format!("{uid}:{uid}"),"entrypoint":["/usr/local/bin/bun","-e",program],"command":[],"environment":{"TOKEN":null}});
        if uid != 0 {
            service["depends_on"] = json!({"root":{"condition":"service_completed_successfully"}});
        }
        services.insert(name.into(), service);
        managed.insert(
            name.into(),
            BTreeMap::from([(
                "TOKEN".into(),
                format!("synthetic-startup-{uid}-{nonce}\n'\"$UNCHANGED=é😀\r"),
            )]),
        );
    }
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":services}),
    )
    .unwrap();
    let plan = project::plan(
        &candidate,
        PlanOptions {
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    assert!(plan.plan.enrollment_compatible);
    let readiness = BTreeMap::from([
        ("root".into(), Condition::Completed),
        ("term".into(), Condition::Started),
        ("int".into(), Condition::Started),
    ]);
    let public = BTreeMap::new();
    let run_id = token();
    let outcome = (|| -> Result<(), CandidateError> {
        let receipt = run_with_environment(
            &candidate,
            options(&fixture.0, &plan.plan_id, &run_id, &readiness, &public),
            &managed,
            Duration::from_secs(120),
        )?;
        assert!(receipt.environment_attached);
        assert_eq!(
            restart(
                &candidate,
                options(&fixture.0, &plan.plan_id, &run_id, &readiness, &public)
            )
            .err()
            .unwrap()
            .code,
            "execution_environment_missing"
        );
        let engine = Engine::connect(&candidate)?;
        for name in ["root", "term", "int"] {
            let resource = &receipt.resources[&format!("container:{name}")];
            let inspected = inspect_resource(&engine, &receipt, resource)?.unwrap();
            let text = serde_json::to_string(&inspected).unwrap();
            for values in managed.values() {
                for value in values.values() {
                    let encoded = serde_json::to_string(value).unwrap();
                    assert!(!text.contains(&encoded[1..encoded.len() - 1]));
                }
            }
            assert!(
                !inspected["Config"]["Env"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v.as_str().unwrap_or_default().starts_with("TOKEN="))
            );
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let (out, err, truncated) = engine.logs(resource.id.as_deref().unwrap())?;
                assert!(err.is_empty() && !truncated);
                if out
                    == if name == "root" {
                        "root-exec-ok\n"
                    } else {
                        "ready\n"
                    }
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "application readiness marker missing"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        for (name, signal, exit) in [("term", "SIGTERM", 42), ("int", "SIGINT", 43)] {
            let id = receipt.resources[&format!("container:{name}")]
                .id
                .as_deref()
                .unwrap();
            engine.request(
                Method::POST,
                &format!("/v1.53/containers/{id}/kill?signal={signal}"),
                None,
            )?;
            wait_exit(&engine, &receipt, name, exit)?;
            assert_eq!(engine.logs(id)?.0, "ready\nsignal-ok\n");
        }
        // Bypass host revalidation only in this owned negative control: the guest must also refuse expiry.
        let slots =
            super::super::environment_recovery::graph_slots(&candidate, engine.guest(), &run_id)?;
        let slot = &slots
            .iter()
            .find(|(_, service, _)| service == "term")
            .unwrap()
            .0;
        assert_eq!(
            engine.guest().execute(
                "(printf 0 > \"/run/$1/expires\") >/dev/null 2>&1; printf 'expired\\n'",
                &[slot],
                None
            )?,
            "expired\n"
        );
        let id = receipt.resources["container:term"].id.as_deref().unwrap();
        engine.request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        wait_exit(&engine, &receipt, "term", 125)?;
        assert_eq!(engine.logs(id)?.0, "ready\nsignal-ok\n");
        assert!(engine.logs(id)?.1.is_empty());
        drop(engine);
        Ok(())
    })();
    let cleaned = cleanup(&candidate, &run_id, true);
    outcome.unwrap();
    cleaned.unwrap();
    cleanup(&candidate, &run_id, true).unwrap();
}
