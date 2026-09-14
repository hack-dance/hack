use super::*;
use std::{io::Read, path::Path, process::Command};
pub(super) struct Fixture(pub(super) PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-graph-{}", token()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
    fn options(&self) -> PlanOptions<'_> {
        PlanOptions {
            project: &self.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn token() -> String {
    let mut bytes = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn goals() -> BTreeMap<String, Condition> {
    BTreeMap::from([
        ("init".into(), Condition::Completed),
        ("web".into(), Condition::Healthy),
        ("check".into(), Condition::Completed),
    ])
}
fn compose(image: &str, marker: &str, fail: bool) -> Value {
    let init = if fail {
        "process.exit(23)".into()
    } else {
        format!(
            "import {{Database}} from 'bun:sqlite';const db=new Database('/data/proof.sqlite');db.exec('CREATE TABLE IF NOT EXISTS proof(id INTEGER PRIMARY KEY,value TEXT)');db.query('INSERT OR IGNORE INTO proof VALUES (1,?)').run('{marker}');if(db.query('SELECT value FROM proof WHERE id=1').get().value!=='{marker}')throw Error('persistence');db.query('INSERT OR IGNORE INTO proof VALUES (2,?)').run(crypto.randomUUID());console.log(db.query('SELECT value FROM proof WHERE id=2').get().value);db.close();"
        )
    };
    let base = |program: String, data: bool| {
        let mut value = json!({"image":image,"read_only":true,"command":[],"entrypoint":["/usr/local/bin/bun","-e",program],"networks":["private"]});
        if data {
            value["volumes"] = json!(["data:/data"])
        }
        value
    };
    let mut web=base("import {Database} from 'bun:sqlite';const db=new Database('/data/proof.sqlite',{readonly:true});Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response(db.query('SELECT value FROM proof WHERE id=1').get().value)}})".into(),true);
    web["depends_on"] = json!({"init":{"condition":"service_completed_successfully"}});
    web["healthcheck"] = json!({"test":["CMD","/usr/local/bin/bun","-e","const r=await fetch('http://127.0.0.1:3000');if(!r.ok)process.exit(1)"],"interval":"100ms","timeout":"1s","retries":10});
    let mut check = base(
        format!(
            "const r=await fetch('http://web:3000',{{signal:AbortSignal.timeout(2000)}});if(await r.text()!=='{marker}')throw Error('marker')"
        ),
        false,
    );
    check["depends_on"] = json!({"web":{"condition":"service_healthy"}});
    json!({"services":{"init":base(init,true),"web":web,"check":check},"networks":{"private":{"internal":true}},"volumes":{"data":{}}})
}
#[test]
fn driver_profile_preserves_isolation_and_refuses_unqualified_inputs() {
    let fixture = Fixture::new();
    let candidate_root = Fixture::new();
    let candidate = Candidate::discover(&candidate_root.0).unwrap();
    let image = format!("sha256:{}", "a".repeat(64));
    let mut base = compose(&image, "marker", false);
    base["services"]["web"]["expose"] = json!(["3000"]);
    for (case, code) in [
        (0, None),
        (1, Some("graph_subset")),
        (2, Some("graph_subset")),
        (3, Some("graph_budget")),
    ] {
        let mut document = base.clone();
        match case {
            1 => document["services"]["web"]["read_only"] = json!(false),
            2 => document["services"]["web"]["environment"] = json!({"PUBLIC":"value"}),
            3 => document["services"]["web"]["mem_limit"] = json!("2g"),
            _ => {}
        }
        state::write(&fixture.0.join("compose.yaml"), &document).unwrap();
        let review = project::plan(&candidate, fixture.options()).unwrap();
        let inputs = project::inputs::compile(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
        )
        .unwrap();
        match config::prepare(inputs, &goals(), &"a".repeat(32), &"b".repeat(32)) {
            Ok(prepared) => {
                assert!(code.is_none());
                assert_eq!(prepared.resources.len(), 5);
                assert_eq!(
                    prepared.configs["web"]["ExposedPorts"],
                    json!({"3000/tcp":{}})
                );
                assert_eq!(
                    prepared.configs["web"]["HostConfig"]["ReadonlyRootfs"],
                    true
                );
                assert_eq!(
                    prepared.configs["web"]["HostConfig"]["LogConfig"]["Config"]["max-size"],
                    "1m"
                );
            }
            Err(e) => assert_eq!(Some(e.code), code),
        }
    }
    assert!(!candidate.state_root.exists());
}
#[test]
fn config_projection_allows_engine_defaults_but_detects_drift() {
    assert!(contains_request(
        &json!({"Cmd":[],"HostConfig":{"Memory":123}}),
        &json!({"Cmd":null,"HostConfig":{"Memory":123,"Other":true},"Other":true})
    ));
    assert!(!contains_request(
        &json!({"HostConfig":{"Memory":123}}),
        &json!({"HostConfig":{"Memory":124}})
    ));
    assert!(contains_request(&json!({"ReadOnly":false}), &json!({})));
    assert!(contains_request(&json!({"Mounts":[]}), &json!({})));
    assert!(!contains_request(&json!({"CapDrop":["ALL"]}), &json!({})));
    assert!(!contains_request(&json!({"ReadOnly":true}), &json!({})));
    assert!(!contains_request(
        &json!({"ReadOnly":false}),
        &json!({"ReadOnly":true})
    ));
    assert!(!contains_request(&json!(["ALL"]), &json!(["ALL", "OTHER"])));
}
fn cli(candidate: &Candidate, args: &[&str]) -> Result<Value, CandidateError> {
    let output = Command::new(
        candidate
            .state_root
            .join("target/release/hack-runtime-candidate"),
    )
    .arg("--candidate-root")
    .arg(&candidate.checkout)
    .arg("graph")
    .args(args)
    .output()
    .map_err(state::io)?;
    if output.stdout.len() > 65536 || output.stderr.len() > 16384 {
        return Err(error("graph_test", "CLI output exceeded fixture bounds."));
    }
    if !output.status.success() {
        let value: Value = serde_json::from_slice(&output.stderr).unwrap_or(Value::Null);
        if let Some(index) = args.iter().position(|v| *v == "--run-id") {
            let run = args[index + 1];
            state::write(
                &candidate
                    .state_root
                    .join("review/wu07")
                    .join(format!("driver-{run}-last-cli-error.json")),
                &value,
            )?;
        }
        return Err(error(
            "graph_test_cli",
            value["code"].as_str().unwrap_or("unknown CLI failure"),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| error("graph_test", "Invalid CLI receipt."))
}
fn launch(
    candidate: &Candidate,
    fixture: &Fixture,
    run: &str,
    action: &str,
) -> Result<Value, CandidateError> {
    let review = project::plan(candidate, fixture.options())?;
    cli(
        candidate,
        &[
            action,
            "--project",
            fixture.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan_id,
            "--run-id",
            run,
            "--ready",
            "init=completed",
            "--ready",
            "web=healthy",
            "--ready",
            "check=completed",
            "--timeout-seconds",
            "30",
        ],
    )
}
#[test]
#[ignore = "Manual owned M3 development VM, pinned Bun image and external watchdog required"]
fn owned_driver_live() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("root"),
    ))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("image");
    let fixture = Fixture::new();
    let run = token();
    let failed = token();
    let mut foreign: Option<(String, String)> = None;
    let evidence = candidate.state_root.join("review/wu07");
    state::private_directory(&evidence)?;
    state::write(
        &evidence.join(format!("driver-{run}.json")),
        &json!({"phase":"intent","run":run,"failed_run":failed}),
    )?;
    let result = (|| {
        state::write(
            &fixture.0.join("compose.yaml"),
            &compose(&image, &run, true),
        )?;
        if !matches!(launch(&candidate,&fixture,&failed,"run"),Err(e) if e.message=="graph_service_failed")
        {
            return Err(error(
                "graph_test",
                "Failed init did not block dependent launch.",
            ));
        }
        let snapshot = cli(&candidate, &["inspect", "--run-id", &failed])?;
        if snapshot["observations"]["container:web"]["state"] != "absent"
            || snapshot["observations"]["container:check"]["state"] != "absent"
        {
            return Err(error(
                "graph_test",
                "Failed init created downstream services.",
            ));
        }
        cli(
            &candidate,
            &["cleanup", "--run-id", &failed, "--remove-data"],
        )?;
        state::write(
            &fixture.0.join("compose.yaml"),
            &compose(&image, &run, false),
        )?;
        source_reservation_blocks_graph(&candidate, &fixture, &image, &token(), "run")?;
        let first = launch(&candidate, &fixture, &run, "run")?;
        source_launch_is_blocked(&candidate, &image)?;
        if launch(&candidate, &fixture, &run, "run").is_ok() {
            return Err(error("graph_test", "Duplicate attempt replayed."));
        }
        if launch(&candidate, &fixture, &run, "restart").is_ok() {
            return Err(error("graph_test", "Restart accepted a running graph."));
        }
        super::super::down(&candidate)?;
        super::super::up_with_profile(&candidate, super::super::Profile::Development)?;
        source_reservation_blocks_graph(&candidate, &fixture, &image, &run, "restart")?;
        let second = launch(&candidate, &fixture, &run, "restart")?;
        for name in ["init", "web", "check"] {
            let key = format!("container:{name}");
            if first["resources"][&key]["id"] != second["resources"][&key]["id"] {
                return Err(error("graph_test", "Restart recreated a container."));
            }
        }
        if !matches!(launch(&candidate, &fixture, &run, "restore"), Err(e) if e.message == "graph_restore_refused")
        {
            return Err(error("graph_test", "Restore accepted live compute."));
        }
        let prior_token = {
            let engine = Engine::connect(&candidate)?;
            let (output, _, _) = engine.logs(
                second["resources"]["container:init"]["id"]
                    .as_str()
                    .expect("init ID"),
            )?;
            output.lines().last().unwrap_or_default().to_owned()
        };
        cli(&candidate, &["cleanup", "--run-id", &run])?;
        if !matches!(cli(&candidate, &["archive", "--run-id", &run]), Err(e) if e.message == "graph_archive_refused")
        {
            return Err(error("graph_test", "Archive accepted retained data."));
        }
        let restored = launch(&candidate, &fixture, &run, "restore")?;
        {
            let engine = Engine::connect(&candidate)?;
            let (output, _, _) = engine.logs(
                restored["resources"]["container:init"]["id"]
                    .as_str()
                    .expect("init ID"),
            )?;
            if prior_token.len() != 36 || output.lines().last() != Some(prior_token.as_str()) {
                return Err(error(
                    "graph_test",
                    "Restore lost the database-generated token.",
                ));
            }
        }
        for name in ["init", "web", "check"] {
            if restored["resources"][format!("container:{name}")]["id"]
                == second["resources"][format!("container:{name}")]["id"]
            {
                return Err(error(
                    "graph_test",
                    "Restore did not recreate removed compute.",
                ));
            }
        }
        if restored["resources"]["volume:data"]["name"]
            != second["resources"]["volume:data"]["name"]
        {
            return Err(error(
                "graph_test",
                "Restore changed retained volume identity.",
            ));
        }
        let previous: Receipt =
            state::read(&directory(&candidate, &run)?.join("restore-1/previous.json"))?;
        if previous.phase != "stopped-data-retained" {
            return Err(error("graph_test", "Restore history is missing."));
        }
        // Simulate a lost create receipt while retaining its already-durable name reservation.
        let root = directory(&candidate, &run)?;
        let mut receipt: Receipt = state::read(&root.join("state.json"))?;
        let check = receipt.resources.get_mut("container:check").expect("check");
        check.id = None;
        check.phase = "uncertain".into();
        let check_name = check.name.clone();
        receipt.phase = "failed-retained".into();
        state::write(&root.join("state.json"), &receipt)?;
        if launch(&candidate, &fixture, &run, "restart").is_ok() {
            return Err(error("graph_test", "Uncertain graph restarted."));
        }
        let before_reconcile = cli(&candidate, &["inspect", "--run-id", &run])?;
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut pending = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(root.join("state.pending"))
                .map_err(state::io)?;
            pending
                .write_all(b"{interrupted journal")
                .map_err(state::io)?;
            pending.sync_all().map_err(state::io)?;
        }
        if !matches!(cli(&candidate, &["cleanup", "--run-id", &run]), Err(e) if e.message=="graph_journal_uncertain")
        {
            return Err(error(
                "graph_test",
                "Pending journal did not block cleanup.",
            ));
        }
        let reconciled = cli(&candidate, &["reconcile", "--run-id", &run])?;
        if reconciled["phase"] != "reconciled-cleanup-only"
            || fs::read(root.join("recovery-1/interrupted.pending")).map_err(state::io)?
                != b"{interrupted journal"
        {
            return Err(error(
                "graph_test",
                "Journal reconciliation did not preserve the partial file.",
            ));
        }
        let after_reconcile = cli(&candidate, &["inspect", "--run-id", &run])?;
        if before_reconcile["observations"] != after_reconcile["observations"]
            || launch(&candidate, &fixture, &run, "restart").is_ok()
        {
            return Err(error(
                "graph_test",
                "Reconciliation changed runtime state or allowed replay.",
            ));
        }
        cli(&candidate, &["cleanup", "--run-id", &run])?;
        let stopped = cli(&candidate, &["inspect", "--run-id", &run])?;
        if stopped["observations"]["volume:data"]["state"] != "present" {
            return Err(error(
                "graph_test",
                "Ordinary cleanup removed persistent data.",
            ));
        }
        // An unrelated replacement at a now-absent reserved name must never be adopted/deleted.
        {
            let engine = Engine::connect(&candidate)?;
            let value=engine.request(Method::POST,&format!("/v1.53/containers/create?name={check_name}"),Some(&json!({"Image":image,"Entrypoint":["/usr/local/bin/bun","-e","process.exit(0)"],"Labels":{"io.hack-local.foreign-fixture":run},"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"Memory":268435456,"PidsLimit":64,"NanoCpus":500000000}})))?;
            let id = value["Id"]
                .as_str()
                .filter(|v| hex(v, 64))
                .ok_or_else(|| error("graph_test", "Missing foreign fixture ID."))?
                .to_owned();
            foreign = Some((id, check_name));
        }
        if !matches!(cli(&candidate,&["cleanup","--run-id",&run,"--remove-data"]),Err(e) if e.message=="graph_foreign_resource")
        {
            return Err(error("graph_test", "Foreign replacement was not refused."));
        }
        Ok((first, second, stopped))
    })();
    if let Some((id, _)) = foreign {
        let engine = Engine::connect_cleanup(&candidate)?;
        let value = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
        if value["Config"]["Labels"]["io.hack-local.foreign-fixture"] != run {
            return Err(error("graph_test", "Foreign fixture ownership changed."));
        }
        engine.request(
            Method::DELETE,
            &format!("/v1.53/containers/{id}?force=true&v=true"),
            None,
        )?;
    }
    let cleanup = (|| {
        for id in [&failed, &run] {
            if directory(&candidate, id)?.join("state.json").exists() {
                cli(&candidate, &["cleanup", "--run-id", id, "--remove-data"])?;
                let value = cli(&candidate, &["inspect", "--run-id", id])?;
                if !value["observations"]
                    .as_object()
                    .expect("observations")
                    .values()
                    .all(|v| v["state"] == "absent")
                {
                    return Err(error("graph_test", "Cleanup left graph resources."));
                }
            }
        }
        // Missing data cannot become a fresh empty database, even with an ordinary-cleanup receipt.
        let root = directory(&candidate, &run)?;
        let removed: Receipt = state::read(&root.join("state.json"))?;
        let mut missing = removed.clone();
        missing.phase = "stopped-data-retained".into();
        state::write(&root.join("state.json"), &missing)?;
        let refusal = launch(&candidate, &fixture, &run, "restore");
        state::write(&root.join("state.json"), &removed)?;
        if !matches!(refusal, Err(e) if e.message == "graph_data_missing") {
            return Err(error("graph_test", "Restore recreated missing data."));
        }
        for id in [&failed, &run] {
            let active = directory(&candidate, id)?;
            let bytes = fs::read(active.join("state.json")).map_err(state::io)?;
            cli(&candidate, &["archive", "--run-id", id])?;
            if active.exists()
                || fs::read(archive::path(&candidate, id)?.join("state.json")).map_err(state::io)?
                    != bytes
            {
                return Err(error(
                    "graph_test",
                    "Archive did not preserve exact receipt bytes.",
                ));
            }
            if !matches!(launch(&candidate, &fixture, id, "run"), Err(e) if e.message == "graph_replay_refused")
            {
                return Err(error("graph_test", "Archived attempt allowed replay."));
            }
        }
        Ok::<_, CandidateError>(())
    })();
    state::write(
        &evidence.join(format!("driver-{run}.json")),
        &json!({"passed":result.is_ok()&&cleanup.is_ok(),"run":run,"failed_run":failed,"cleanup_confirmed":cleanup.is_ok(),"bidirectional_workload_admission":result.is_ok(),"restore_and_archive":result.is_ok()&&cleanup.is_ok(),"receipts":result.as_ref().ok(),"failure":result.as_ref().err().map(|e|(&e.code,&e.message)),"scope":"Public graph driver, explicit restart identity/persistence, simulated missing create receipt, foreign-name refusal; not actual process-kill or Event Agent qualification"}),
    )?;
    cleanup?;
    result.map(|_| ())
}

fn source_launch_is_blocked(candidate: &Candidate, image: &str) -> Result<(), CandidateError> {
    let source = super::super::source_job::SourceJob {
        namespace: token().repeat(2),
        revision: token().repeat(2),
        image: image.into(),
        argv: vec!["/usr/local/bin/bun".into(), "--version".into()],
        memory_bytes: 268435456,
    };
    let mut started = false;
    let outcome = super::super::source_job::run_source_job(
        candidate,
        &token().repeat(2),
        &source,
        1000,
        |event| {
            if matches!(event, super::super::source_job::SourceJobEvent::Started) {
                started = true;
            }
            Ok(false)
        },
    );
    if started
        || !matches!(outcome, Err(e) if e.code=="source_job_failed_cleaned" && e.message.contains("graph_capacity_reserved"))
    {
        return Err(error(
            "graph_test",
            "Graph reservation did not block source launch.",
        ));
    }
    Ok(())
}

fn source_reservation_blocks_graph(
    candidate: &Candidate,
    fixture: &Fixture,
    image: &str,
    run: &str,
    action: &str,
) -> Result<(), CandidateError> {
    let marker = token();
    let id = {
        let engine = Engine::connect(candidate)?;
        let created = engine.request(Method::POST, &format!("/v1.53/containers/create?name=hack-admission-{marker}"), Some(&json!({
            "Image":image,"Entrypoint":["/usr/local/bin/bun","--version"],
            "Labels":{"io.hack-local.job":marker.repeat(2),"io.hack-local.admission-fixture":marker},
            "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"Memory":268435456,"PidsLimit":64,"NanoCpus":500000000}
        })))?;
        created["Id"]
            .as_str()
            .filter(|v| hex(v, 64))
            .ok_or_else(|| error("graph_test", "Missing admission fixture ID."))?
            .to_owned()
    };
    let result = launch(candidate, fixture, run, action);
    let engine = Engine::connect_cleanup(candidate)?;
    let observed = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    if observed["Config"]["Labels"]["io.hack-local.admission-fixture"] != marker
        || observed["State"]["Status"] != "created"
    {
        return Err(error(
            "graph_test",
            "Admission fixture identity or state changed.",
        ));
    }
    engine.request(
        Method::DELETE,
        &format!("/v1.53/containers/{id}?force=true&v=true"),
        None,
    )?;
    if !matches!(engine.request(Method::GET,&format!("/v1.53/containers/{id}/json"),None),Err(e) if e.code=="engine_not_found")
    {
        return Err(error(
            "graph_test",
            "Admission fixture cleanup unconfirmed.",
        ));
    }
    if !matches!(result,Err(e) if e.message=="source_capacity_reserved") {
        return Err(error(
            "graph_test",
            "Source reservation did not block graph allocation/restart.",
        ));
    }
    if action == "run" && directory(candidate, run)?.exists() {
        return Err(error(
            "graph_test",
            "Refused graph wrote an attempt directory.",
        ));
    }
    Ok(())
}

#[test]
#[ignore = "Helper for the owned graph process-loss test; never invoke without its parent"]
fn fault_child() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("root"),
    ))?;
    let project = PathBuf::from(std::env::var("HACK_LOCAL_GRAPH_PROJECT").expect("fixture"));
    let run_id = std::env::var("HACK_LOCAL_GRAPH_RUN").expect("run");
    let options = || PlanOptions {
        project: &project,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    };
    let review = project::plan(&candidate, options())?;
    super::run(
        &candidate,
        RunOptions {
            project: options(),
            expected_plan: &review.plan_id,
            non_secret_values: &BTreeMap::new(),
            readiness: &goals(),
            run_id: &run_id,
            timeout: Duration::from_secs(60),
        },
    )?;
    Err(error("graph_test", "Fault helper unexpectedly completed."))
}

#[test]
#[ignore = "Manual owned development VM, pinned Bun image and external watchdog required"]
fn owned_graph_process_loss_live() -> Result<(), CandidateError> {
    use std::process::{Child, Stdio};
    use std::time::Instant;
    struct ChildGuard(Option<Child>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("root"),
    ))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("image");
    let evidence = candidate.state_root.join("review/wu07");
    state::private_directory(&evidence)?;
    let suite = token();
    let mut controls = Vec::new();
    let result = (|| {
        for point in ["after-create", "after-start"] {
            let fixture = Fixture::new();
            let run = token();
            let root = directory(&candidate, &run)?;
            let mut document = compose(&image, &run, false);
            document["services"]["init"]["entrypoint"] =
                json!(["/usr/local/bin/bun", "-e", "await Bun.sleep(30000)"]);
            state::write(&fixture.0.join("compose.yaml"), &document)?;
            state::write(
                &evidence.join(format!("driver-kill-{suite}.json")),
                &json!({"phase":"intent","point":point,"run":run,"completed_controls":controls}),
            )?;
            let outcome = (|| {
                let child = Command::new(std::env::current_exe().map_err(state::io)?)
                    .args([
                        "provider::graph::tests::fault_child",
                        "--ignored",
                        "--exact",
                    ])
                    .env("HACK_LOCAL_GRAPH_FAULT", point)
                    .env("HACK_LOCAL_GRAPH_PROJECT", &fixture.0)
                    .env("HACK_LOCAL_GRAPH_RUN", &run)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(state::io)?;
                let mut child = ChildGuard(Some(child));
                let marker = root.join(format!("fault-{point}.json"));
                let deadline = Instant::now() + Duration::from_secs(20);
                while !marker.exists() {
                    if child
                        .0
                        .as_mut()
                        .expect("child")
                        .try_wait()
                        .map_err(state::io)?
                        .is_some()
                        || Instant::now() >= deadline
                    {
                        return Err(error(
                            "graph_test",
                            "Fault helper did not reach its owned marker.",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let reached: Value = state::read(&marker)?;
                if reached["run"] != run || reached["point"] != point {
                    return Err(error("graph_test", "Fault marker identity differs."));
                }
                let pid = child.0.as_ref().expect("child").id();
                child.0.as_mut().expect("child").kill().map_err(state::io)?;
                let status = child.0.as_mut().expect("child").wait().map_err(state::io)?;
                child.0 = None;
                use std::os::unix::process::ExitStatusExt;
                if status.signal() != Some(libc::SIGKILL) {
                    return Err(error(
                        "graph_test",
                        "Owned helper was not killed at the intended boundary.",
                    ));
                }
                source_launch_is_blocked(&candidate, &image)?;
                let snapshot = cli(&candidate, &["inspect", "--run-id", &run])?;
                let init = &snapshot["receipt"]["resources"]["container:init"];
                if point == "after-create" {
                    if !init["id"].is_null()
                        || init["phase"] != "create-intent"
                        || snapshot["observations"]["container:init"]["state"] != "created"
                    {
                        return Err(error(
                            "graph_test",
                            "Create kill did not leave the intended unacknowledged resource.",
                        ));
                    }
                } else if init["id"].is_null()
                    || init["phase"] != "start-intent"
                    || snapshot["observations"]["container:init"]["state"] != "running"
                {
                    return Err(error(
                        "graph_test",
                        "Start kill did not leave the intended unacknowledged running service.",
                    ));
                }
                if snapshot["observations"]["container:web"]["state"] != "absent"
                    || snapshot["observations"]["container:check"]["state"] != "absent"
                {
                    return Err(error(
                        "graph_test",
                        "Process loss launched dependent services.",
                    ));
                }
                if !matches!(launch(&candidate, &fixture, &run, "restart"), Err(e) if e.message=="graph_replay_refused")
                {
                    return Err(error("graph_test", "Process loss allowed restart replay."));
                }
                let another = token();
                if !matches!(launch(&candidate, &fixture, &another, "run"), Err(e) if e.message=="graph_capacity_reserved")
                    || directory(&candidate, &another)?.exists()
                {
                    return Err(error(
                        "graph_test",
                        "Uncertain reservation allowed another graph allocation.",
                    ));
                }
                Ok(
                    json!({"point":point,"helper_pid":pid,"signal":"SIGKILL","snapshot":snapshot,"replay_refused":true,"reservation_preserved":true,"source_launch_refused":true}),
                )
            })();
            let cleanup = (|| {
                if root.join("state.json").exists() {
                    if root.join("state.pending").exists() {
                        cli(&candidate, &["reconcile", "--run-id", &run])?;
                    }
                    cli(&candidate, &["cleanup", "--run-id", &run, "--remove-data"])?;
                    let snapshot = cli(&candidate, &["inspect", "--run-id", &run])?;
                    if !snapshot["observations"]
                        .as_object()
                        .expect("observations")
                        .values()
                        .all(|v| v["state"] == "absent")
                    {
                        return Err(error(
                            "graph_test",
                            "Process-loss cleanup left an owned resource.",
                        ));
                    }
                }
                Ok::<_, CandidateError>(())
            })();
            controls.push(json!({"point":point,"passed":outcome.is_ok() && cleanup.is_ok(),"cleanup_confirmed":cleanup.is_ok(),"evidence":outcome.as_ref().ok(),"failure":outcome.as_ref().err().map(|e|(&e.code,&e.message))}));
            cleanup?;
            outcome?;
        }
        Ok::<_, CandidateError>(())
    })();
    state::write(
        &evidence.join(format!("driver-kill-{suite}.json")),
        &json!({"passed":result.is_ok(),"cleanup_confirmed":controls.iter().all(|v|v["cleanup_confirmed"]==true),"controls":controls,"scope":"Actual owned child SIGKILL after create and start replies but before journal acknowledgement; inspection, no replay, reservation and cleanup via public CLI"}),
    )?;
    result
}
