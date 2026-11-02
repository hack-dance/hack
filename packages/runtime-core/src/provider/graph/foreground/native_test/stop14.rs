//! HACK-1212 foreground-owner, fourteen-service retaining-cleanup baseline.
//!
//! Run only against a separately prepared, owned M3 development pool with a
//! pinned, already loaded local image and an external 240-second watchdog.
//! Set HACK_STOP14_TEST_ROOT, HACK_STOP14_TEST_BINARY (current candidate CLI),
//! and HACK_STOP14_TEST_IMAGE (sha256 content ID).
//! The root must contain no prior graph attempts. A failed assertion deliberately
//! retains the named volume and graph for explicit inspection/recovery; it never
//! retries an uncertain stop or prunes resources in a panic handler. The owner
//! child is intentionally left running on test failure for explicit recovery.
use super::*;
use std::{collections::BTreeMap, mem::ManuallyDrop};

fn options(project_path: &Path) -> project::PlanOptions<'_> {
    project::PlanOptions {
        branch: None,
        project: project_path,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    }
}

fn token() -> String {
    let mut bytes = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn wait_ready(owner: &mut Process, run: &str, deadline: Instant) {
    loop {
        if owner.poll().is_some() {
            let code = serde_json::from_slice::<Value>(&owner.err)
                .ok()
                .and_then(|value| value["code"].as_str().map(str::to_owned))
                .filter(|code| {
                    !code.is_empty()
                        && code.len() <= 64
                        && code
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                })
                .unwrap_or_else(|| "unstructured_native_error".into());
            panic!("foreground owner exited before readiness; native code: {code}");
        }
        if let Some(end) = owner.out.iter().position(|byte| *byte == b'\n') {
            let ready: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(ready["kind"], "graph_foreground_ready");
            assert_eq!(ready["run"], run);
            return;
        }
        assert!(Instant::now() < deadline, "foreground readiness deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn volume_path(engine: &graph::Engine<'_>, receipt: &graph::Receipt) -> String {
    let volume = graph::inspect_resource(engine, receipt, &receipt.resources["volume:data"])
        .unwrap()
        .unwrap();
    let path = volume["Mountpoint"].as_str().unwrap();
    assert_eq!(
        path,
        format!(
            "/var/lib/docker/volumes/{}/_data",
            receipt.resources["volume:data"].name
        )
    );
    path.to_owned()
}

fn assert_marker(engine: &graph::Engine<'_>, receipt: &graph::Receipt) {
    let data = volume_path(engine, receipt);
    // The started readiness condition may precede the shell's first write.
    // Only the exact owned volume mountpoint is supplied to this read-only probe.
    let result = engine.guest().execute_cleanup(
        "set -eu; test -d \"$1\"; test ! -L \"$1\"; i=0; while [ \"$i\" -lt 100 ]; do if [ -f \"$1/marker\" ] && [ -f \"$1/completed\" ]; then test ! -L \"$1/marker\"; test \"$(cat \"$1/marker\")\" = h1212-retained-marker; test \"$(cat \"$1/completed\")\" = completed; printf retained; exit 0; fi; i=$((i+1)); sleep 0.1; done; exit 1",
        &[&data],
    ).unwrap();
    assert_eq!(result, "retained");
}

fn write_first_marker(engine: &graph::Engine<'_>, receipt: &graph::Receipt) -> String {
    let volume = graph::inspect_resource(engine, receipt, &receipt.resources["volume:data"])
        .unwrap()
        .unwrap();
    let created = volume["CreatedAt"].as_str().unwrap().to_owned();
    let data = volume_path(engine, receipt);
    assert_eq!(engine.guest().execute_cleanup(
        "set -eu; test -d \"$1\"; test ! -L \"$1\"; test ! -e \"$1/marker\"; test ! -L \"$1/marker\"; printf h1212-retained-marker > \"$1/marker\"; printf written",
        &[&data],
    ).unwrap(), "written");
    created
}

#[test]
#[ignore = "Separate owned M3 pool, pinned local image, and external 240-second watchdog required"]
fn fourteen_services_retain_named_data_across_cleanup_and_restore() {
    let began = Instant::now();
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_STOP14_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_STOP14_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_STOP14_TEST_IMAGE").unwrap();
    assert!(image.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }));
    let graphs = candidate.state_root.join("run/graphs");
    assert!(
        !graphs.exists() || fs::read_dir(&graphs).unwrap().next().is_none(),
        "Use a fresh isolated graph pool"
    );

    // Retain the reviewed source on failure as well as graph/data evidence.
    let mut fixture = ManuallyDrop::new(graph::tests::Fixture::new());
    let mut services = serde_json::Map::new();
    let mut readiness = BTreeMap::new();
    for index in 0..12 {
        let name = format!("worker-{index:02}");
        services.insert(
            name.clone(),
            json!({
                "image":image,"read_only":true,"network_mode":"none","user":"0:0",
                "cpus":0.1,"mem_limit":"64m","pids_limit":32,
                "entrypoint":["/bin/sh","-ec","while :; do sleep 1; done"],"command":[],
                "stop_grace_period":"1s"
            }),
        );
        readiness.insert(name, graph::Condition::Started);
    }
    services.insert(
        "app".into(),
        json!({
            "image":image,"read_only":true,"network_mode":"none","user":"0:0",
            "cpus":0.1,"mem_limit":"64m","pids_limit":32,
            "entrypoint":["/bin/sh","-ec","while :; do sleep 1; done"],
            "command":[],"stop_grace_period":"1s","volumes":["data:/data"]
        }),
    );
    readiness.insert("app".into(), graph::Condition::Started);
    services.insert(
        "completed".into(),
        json!({
            "image":image,"read_only":true,"network_mode":"none","user":"0:0",
            "cpus":0.1,"mem_limit":"64m","pids_limit":32,
            "entrypoint":["/bin/sh","-ec","printf completed > /data/completed"],
            "command":[],"stop_grace_period":"1s","volumes":["data:/data"]
        }),
    );
    readiness.insert("completed".into(), graph::Condition::Completed);
    assert_eq!(services.len(), 14);
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":services,"volumes":{"data":{}}}),
    )
    .unwrap();

    let run_id = token();
    eprintln!("HACK-1212 owned fixture run: {run_id}");
    let review = project::plan(&candidate, options(&fixture.0)).unwrap();
    let plan = &review.plan_id;
    // The dependency selection is control input, not project source. Writing it
    // inside the reviewed project would change the plan before graph admission.
    let selection = std::env::temp_dir().join(format!("hack-stop14-{}.json", token()));
    state::write(&selection, &json!({"version":1,"plan":plan,"artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),"dependencies":[]})).unwrap();
    let dependency_plan = cli(
        &binary,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selection.to_str().unwrap(),
            "--json",
        ],
        None,
        began + Duration::from_secs(210),
    );
    let mut serve_args = vec![
        "graph".to_owned(),
        "serve".into(),
        "--project".into(),
        fixture.0.to_str().unwrap().into(),
        "--file".into(),
        "compose.yaml".into(),
        "--expect-plan".into(),
        plan.to_owned(),
        "--run-id".into(),
        run_id.clone(),
        "--dependencies".into(),
        selection.to_str().unwrap().into(),
        "--expect-dependencies".into(),
        dependency_plan["dependency_plan_id"]
            .as_str()
            .unwrap()
            .into(),
        "--timeout-seconds".into(),
        "90".into(),
        "--json".into(),
    ];
    serve_args.extend([
        "--normalized-file".into(),
        fixture.0.join("compose.yaml").to_str().unwrap().into(),
        "--expect-original".into(),
        review.plan.compose_sha256.clone(),
        "--expect-namespace".into(),
        review.plan.namespace.clone(),
    ]);
    for (name, condition) in &readiness {
        serve_args.push("--ready".into());
        serve_args.push(format!(
            "{name}={}",
            if *condition == graph::Condition::Completed {
                "completed"
            } else {
                "started"
            }
        ));
    }
    let serve_refs = serve_args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut owner = ManuallyDrop::new(Process::start(&binary, &candidate, &serve_refs, None));
    let deadline = began + Duration::from_secs(210);
    wait_ready(&mut owner, &run_id, deadline);
    let ready = graph::inspect(&candidate, &run_id).unwrap().receipt;
    assert_eq!(ready.phase, "ready-observed");
    assert_eq!(
        ready
            .resources
            .values()
            .filter(|resource| resource.kind == graph::Kind::Container)
            .count(),
        14
    );
    let named_volume = ready.resources["volume:data"].name.clone();
    let volume_created;
    {
        let engine = graph::Engine::connect(&candidate).unwrap();
        volume_created = write_first_marker(&engine, &ready);
        assert_marker(&engine, &ready);
        for resource in ready
            .resources
            .values()
            .filter(|resource| resource.kind == graph::Kind::Container)
        {
            let observation = graph::inspect_resource(&engine, &ready, resource)
                .unwrap()
                .unwrap();
            assert_eq!(observation["State"]["Running"], resource.key != "completed");
        }
    }
    let reply = cli(
        &binary,
        &candidate,
        &["graph", "cleanup", "--run-id", &run_id, "--json"],
        None,
        deadline,
    );
    assert_eq!(reply["phase"], "stopped-data-retained");
    assert!(owner.wait(deadline).success());
    // SAFETY: the child has exited; dropping the completed process only reaps it.
    unsafe { ManuallyDrop::drop(&mut owner) };
    let stopped = graph::inspect(&candidate, &run_id).unwrap().receipt;
    assert_eq!(stopped.phase, "stopped-data-retained");
    assert_eq!(stopped.resources["volume:data"].name, named_volume);
    let evidence: Value = state::read(
        &graph::directory(&candidate, &run_id)
            .unwrap()
            .join("shutdown.json"),
    )
    .unwrap();
    assert_eq!(evidence["containers"].as_object().unwrap().len(), 14);
    assert_eq!(
        evidence["containers"]["container:completed"]["stop_requested"],
        false
    );
    for (key, value) in evidence["containers"].as_object().unwrap() {
        if key != "container:completed" {
            assert_eq!(value["stop_requested"], true);
        }
    }
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        assert_marker(&engine, &stopped);
    }
    let selection_reply = cli(
        &binary,
        &candidate,
        &["graph", "restore-selection", "--run-id", &run_id, "--json"],
        None,
        deadline,
    );
    let mut restore_args = serve_args.clone();
    restore_args[1] = "serve-restore".into();
    restore_args.extend([
        "--expect-generation".into(),
        selection_reply["generation"].as_str().unwrap().into(),
    ]);
    let restore_refs = restore_args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut restored_owner =
        ManuallyDrop::new(Process::start(&binary, &candidate, &restore_refs, None));
    wait_ready(&mut restored_owner, &run_id, deadline);
    let restored = graph::inspect(&candidate, &run_id).unwrap().receipt;
    assert_eq!(restored.phase, "ready-observed");
    assert_eq!(restored.resources["volume:data"].name, named_volume);
    assert_ne!(
        restored.resources["container:app"].id,
        ready.resources["container:app"].id
    );
    {
        let engine = graph::Engine::connect(&candidate).unwrap();
        assert_marker(&engine, &restored);
        let volume =
            graph::inspect_resource(&engine, &restored, &restored.resources["volume:data"])
                .unwrap()
                .unwrap();
        assert_eq!(volume["CreatedAt"].as_str(), Some(volume_created.as_str()));
    }
    let removed_reply = cli(
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &run_id,
            "--remove-data",
            "--json",
        ],
        None,
        deadline,
    );
    assert_eq!(removed_reply["phase"], "removed");
    assert!(restored_owner.wait(deadline).success());
    // SAFETY: the replacement owner exited after acknowledged graph removal.
    unsafe { ManuallyDrop::drop(&mut restored_owner) };
    let removed = graph::inspect(&candidate, &run_id).unwrap().receipt;
    assert_eq!(removed.phase, "removed");
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        assert!(
            graph::inspect_resource(&engine, &removed, &removed.resources["volume:data"])
                .unwrap()
                .is_none()
        );
    }
    assert!(began.elapsed() < Duration::from_secs(210));
    fs::remove_file(selection).unwrap();
    // SAFETY: all graph resources were removed and the foreground child exited.
    unsafe { ManuallyDrop::drop(&mut fixture) };
}
