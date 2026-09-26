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
        live_source: false,
        shared_source: false,
        release_initializer_cache: std::collections::BTreeSet::new(),
        routing_enrolled: false,
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
    startup_recovery(false);
}
#[test]
#[ignore = "Owned reclamation VM, launcher feature and external watchdog required"]
fn graph_reclamation_preserves_live_memory_scoped_delivery_and_fresh_restore() {
    startup_recovery(true);
}
fn startup_recovery(reclaim: bool) {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit root"),
    ))
    .unwrap();
    if reclaim {
        assert!(
            super::super::lifecycle::status(&candidate)
                .unwrap()
                .reclamation
                .unwrap()
                .enabled
        );
    }
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
        let memory_check = if reclaim && uid != 0 {
            format!(
                "const retained=Buffer.alloc(64*1024*1024,{});process.on('SIGUSR1',()=>{{for(const b of retained)if(b!=={})process.exit(75);console.log('memory-ok')}});",
                uid % 251,
                uid % 251
            )
        } else {
            String::new()
        };
        let program = if uid == 0 {
            format!(
                "{check}const f=Bun.file('/data/counter');const n=(await f.exists()?Number(await f.text()):0)+1;if((n===2)!==process.env.TOKEN.endsWith('-fresh'))process.exit(74);await Bun.write('/data/counter',String(n));console.log('root-exec-ok');console.log('counter='+n)"
            )
        } else {
            format!(
                "{check}{memory_check}process.on('{signal}',()=>{{console.log('signal-ok');process.exit({exit})}});console.log('ready');setInterval(()=>{{}},1000)"
            )
        };
        let mut service = json!({"image":image,"read_only":true,"network_mode":"none","init":uid!=0,"user":format!("{uid}:{uid}"),"entrypoint":["/usr/local/bin/bun","-e",program],"command":[],"environment":{"TOKEN":null}});
        if uid == 0 {
            service["volumes"] = json!(["data:/data"]);
        }
        if uid != 0 {
            service["depends_on"] = json!({"root":{"condition":"service_completed_successfully"}});
        }
        if name == "term" {
            service["healthcheck"] = json!({"test":["CMD","/usr/local/bin/bun","-e","const v=await Bun.file('/run/hack-environment.json').json();console.log(process.env.TOKEN);console.error(process.env.TOKEN);process.exit(process.getuid()===1001&&process.env.TOKEN===v.TOKEN?0:73)"],"interval":"1s","timeout":"2s","retries":1});
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
        &json!({"services":services,"volumes":{"data":{}}}),
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
        ("term".into(), Condition::Healthy),
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
                        "root-exec-ok\ncounter=1\n"
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
        if reclaim {
            exercise_reclamation(&candidate, &engine, &receipt);
        }
        let signal_log = if reclaim {
            "ready\nmemory-ok\nmemory-ok\nmemory-ok\nsignal-ok\n"
        } else {
            "ready\nsignal-ok\n"
        };
        // Health output deliberately prints the synthetic value; none may reach engine history.
        let term = &receipt.resources["container:term"];
        let inspected = inspect_resource(&engine, &receipt, term)?.unwrap();
        assert_eq!(inspected["State"]["Health"]["Status"], "healthy");
        let slots =
            super::super::environment_recovery::graph_slots(&candidate, engine.guest(), &run_id)?;
        let slot = &slots
            .iter()
            .find(|(_, service, _)| service == "term")
            .unwrap()
            .0;
        engine.guest().execute(
            "(printf 0 > \"/run/$1/expires\") >/dev/null 2>&1; printf 'expired\\n'",
            &[slot],
            None,
        )?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let inspected = inspect_resource(&engine, &receipt, term)?.unwrap();
            assert_eq!(inspected["State"]["Running"], true);
            let health = &inspected["State"]["Health"];
            for entry in health["Log"].as_array().unwrap() {
                assert_eq!(entry["Output"], "");
            }
            if health["Status"] == "unhealthy" {
                assert_eq!(
                    health["Log"].as_array().unwrap().last().unwrap()["ExitCode"],
                    125
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "expired health delivery was not refused"
            );
            std::thread::sleep(Duration::from_millis(100));
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
            assert_eq!(engine.logs(id)?.0, signal_log);
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
        assert_eq!(engine.logs(id)?.0, signal_log);
        assert!(engine.logs(id)?.1.is_empty());
        let prior_ids = receipt
            .resources
            .iter()
            .map(|(key, value)| (key.clone(), value.id.clone()))
            .collect::<BTreeMap<_, _>>();
        drop(engine);
        cleanup(&candidate, &run_id, false)?;
        let renewed = managed
            .iter()
            .map(|(service, values)| {
                (
                    service.clone(),
                    values
                        .iter()
                        .map(|(key, value)| (key.clone(), format!("{value}-fresh")))
                        .collect(),
                )
            })
            .collect();
        let restored = restore_with_environment(
            &candidate,
            options(&fixture.0, &plan.plan_id, &run_id, &readiness, &public),
            &renewed,
            Duration::from_secs(120),
        )?;
        assert_eq!(restored.phase, "ready-observed");
        assert!(restored.environment_attached);
        for (key, resource) in &restored.resources {
            if resource.kind == Kind::Container {
                assert_ne!(resource.id, prior_ids[key]);
            }
        }
        assert_eq!(
            restore_with_environment(
                &candidate,
                options(&fixture.0, &plan.plan_id, &run_id, &readiness, &public),
                &renewed,
                Duration::from_secs(120),
            )
            .unwrap_err()
            .code,
            "graph_restore_refused"
        );
        let engine = Engine::connect(&candidate)?;
        assert_eq!(
            engine
                .logs(restored.resources["container:root"].id.as_deref().unwrap())?
                .0,
            "root-exec-ok\ncounter=2\n"
        );
        for (key, resource) in &restored.resources {
            if resource.kind == Kind::Volume {
                assert_eq!(resource.id, prior_ids[key]);
            }
        }
        if reclaim {
            exercise_reclamation(&candidate, &engine, &restored);
        }
        let fresh_slots =
            super::super::environment_recovery::graph_slots(&candidate, engine.guest(), &run_id)?;
        assert_eq!(fresh_slots.len(), slots.len() + managed.len());
        for (old, _, _) in &slots {
            // Old cleanup authority cannot retire a fresh allocation while its container exists.
            assert!(
                super::super::environment_recovery::retire(&candidate, engine.guest(), old, None)
                    .is_err()
            );
        }
        for resource in restored
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            let inspected = inspect_resource(&engine, &restored, resource)?.unwrap();
            let text = serde_json::to_string(&inspected).unwrap();
            for values in renewed.values() {
                for value in values.values() {
                    let encoded = serde_json::to_string(value).unwrap();
                    assert!(!text.contains(&encoded[1..encoded.len() - 1]));
                }
            }
        }
        drop(engine);
        Ok(())
    })();
    let cleaned = cleanup(&candidate, &run_id, true);
    outcome.unwrap();
    cleaned.unwrap();
    cleanup(&candidate, &run_id, true).unwrap();
}

fn exercise_reclamation(candidate: &Candidate, engine: &Engine<'_>, receipt: &Receipt) {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let status = super::super::lifecycle::status(candidate).unwrap();
    assert_eq!(status.process_alive, Some(true));
    let socket = Path::new(
        status
            .engine_socket
            .as_ref()
            .unwrap()
            .trim_start_matches("unix://"),
    )
    .with_file_name("control.sock");
    let control = |command: &str| {
        let mut stream = UnixStream::connect(&socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        writeln!(stream, "{command}").unwrap();
        let mut reply = Vec::new();
        loop {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            if byte[0] == b'\n' {
                break;
            }
            assert!(reply.len() < 1024);
            reply.push(byte[0]);
        }
        let reply = String::from_utf8(reply).unwrap();
        assert!(reply.starts_with("OK"));
        reply
    };
    for cycle in 1..=3 {
        for target in [1024, 0] {
            control(&format!("BALLOON {target}"));
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if control("BALLOON")
                    .split_whitespace()
                    .any(|v| v == format!("actual={target}"))
                {
                    break;
                }
                assert!(Instant::now() < deadline, "balloon target not reached");
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        for name in ["term", "int"] {
            let resource = &receipt.resources[&format!("container:{name}")];
            let id = resource.id.as_deref().unwrap();
            engine
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/{id}/kill?signal=SIGUSR1"),
                    None,
                )
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let inspected = inspect_resource(engine, receipt, resource)
                    .unwrap()
                    .unwrap();
                assert_eq!(inspected["State"]["Running"], true);
                assert_eq!(inspected["State"]["OOMKilled"], false);
                let (out, err, truncated) = engine.logs(id).unwrap();
                assert!(err.is_empty() && !truncated);
                if out.lines().filter(|line| *line == "memory-ok").count() == cycle {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "application memory check did not complete"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        assert_eq!(
            inspect_resource(engine, receipt, &receipt.resources["container:term"])
                .unwrap()
                .unwrap()["State"]["Health"]["Status"],
            "healthy"
        );
    }
    assert_eq!(
        super::super::lifecycle::status(candidate)
            .unwrap()
            .guest_boot_id,
        status.guest_boot_id
    );
}
