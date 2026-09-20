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
        (2, None),
        (3, Some("graph_budget")),
        (4, Some("graph_dependency_hosts")),
    ] {
        let mut document = base.clone();
        match case {
            1 => document["services"]["web"]["read_only"] = json!(false),
            2 => document["services"]["web"]["environment"] = json!({"PUBLIC":"value"}),
            3 => document["services"]["web"]["mem_limit"] = json!("5g"),
            4 => document["services"]["web"]["extra_hosts"] = json!(["one.example:host-gateway"]),
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
        match config::prepare(inputs, &goals(), &"a".repeat(32), &"b".repeat(32), None) {
            Ok(prepared) => {
                assert!(code.is_none());
                if case == 2 {
                    assert_eq!(prepared.configs["web"]["Env"], json!(["PUBLIC=value"]));
                } else {
                    assert!(prepared.configs["web"].get("Env").is_none());
                }
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
fn larger_graphs_fit_by_resources_and_receipts_keep_matching_bounds() {
    let fixture = Fixture::new();
    let candidate_root = Fixture::new();
    let candidate = Candidate::discover(&candidate_root.0).unwrap();
    let image = format!("sha256:{}", "a".repeat(64));
    for (count, cpus, memory, accepted) in [
        (1, 2.0, "3g", true),
        (1, 2.0, "4g", true),
        (1, 2.0, "4097m", false),
        (2, 1.0, "3g", false),
        (12, 0.1, "32m", true),
        (32, 0.1, "32m", true),
        (33, 0.1, "32m", false),
        (12, 0.5, "32m", false),
        (32, 0.1, "256m", false),
    ] {
        let services: serde_json::Map<String, Value> = (0..count)
            .map(|i| (format!("job-{i}"), json!({"image":image,"read_only":true,"network_mode":"none","cpus":cpus,"mem_limit":memory,"command":["true"]})))
            .collect();
        let goals = services
            .keys()
            .map(|name| (name.clone(), Condition::Completed))
            .collect();
        state::write(
            &fixture.0.join("compose.yaml"),
            &json!({"services":services}),
        )
        .unwrap();
        let review = project::plan(&candidate, fixture.options()).unwrap();
        let inputs = project::inputs::compile(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
        )
        .unwrap();
        let result = config::prepare(inputs, &goals, &"a".repeat(32), &"b".repeat(32), None);
        if !accepted {
            assert_eq!(result.err().unwrap().code, "graph_budget");
            continue;
        }
        let prepared = result.unwrap();
        assert_eq!(prepared.configs.len(), count);
        assert!(resource_counts_fit(&prepared.resources));
        if count == MAX_SERVICES {
            let mut resources = prepared.resources.clone();
            let template = resources.values().next().unwrap().clone();
            for (kind, maximum) in [(Kind::Network, MAX_NETWORKS), (Kind::Volume, MAX_VOLUMES)] {
                for index in 0..maximum {
                    let key = format!("{}:{index}", kind.word());
                    resources.insert(
                        key,
                        Resource {
                            routing: None,
                            networks: None,
                            outbound: false,
                            cache: None,
                            cache_provenance: None,
                            kind,
                            ..template.clone()
                        },
                    );
                }
            }
            assert!(resource_counts_fit(&resources));
            for kind in [Kind::Container, Kind::Network, Kind::Volume] {
                let mut overflow = resources.clone();
                overflow.insert(
                    "excess".into(),
                    Resource {
                        routing: None,
                        networks: None,
                        outbound: false,
                        cache: None,
                        cache_provenance: None,
                        kind,
                        ..template.clone()
                    },
                );
                assert!(!resource_counts_fit(&overflow));
            }
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
        let before_vm_token = {
            let engine = Engine::connect(&candidate)?;
            let (output, _, _) = engine.logs(
                first["resources"]["container:init"]["id"]
                    .as_str()
                    .expect("init"),
            )?;
            output.lines().last().unwrap_or_default().to_owned()
        };
        super::super::lifecycle::kill_owned_vm_for_test(&candidate)?;
        super::super::recover(&candidate)?;
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
        {
            let engine = Engine::connect(&candidate)?;
            let (output, _, _) = engine.logs(
                second["resources"]["container:init"]["id"]
                    .as_str()
                    .expect("init"),
            )?;
            if before_vm_token.len() != 36
                || output.lines().last() != Some(before_vm_token.as_str())
            {
                return Err(error(
                    "graph_test",
                    "Abrupt VM loss lost committed database token.",
                ));
            }
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
        let previous: Receipt = super::restore_history::latest(&directory(&candidate, &run)?)?;
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
            let export_parent = candidate.state_root.join("exports/graphs");
            state::private_directory(&export_parent)?;
            let partial = export_parent.join(format!("{id}.pending"));
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&partial)
                    .map_err(state::io)?;
                file.write_all(b"partial export").map_err(state::io)?;
                file.sync_all().map_err(state::io)?;
            }
            if cli(&candidate, &["export", "--run-id", id]).is_ok() {
                return Err(error("graph_test", "Partial export was overwritten."));
            }
            let repaired = cli(&candidate, &["reconcile-export", "--run-id", id])?;
            if fs::read(
                Path::new(repaired["retained"].as_str().expect("retained path"))
                    .join("interrupted.pending"),
            )
            .map_err(state::io)?
                != b"partial export"
            {
                return Err(error(
                    "graph_test",
                    "Partial export bytes were not retained.",
                ));
            }
            let exported = cli(&candidate, &["export", "--run-id", id])?;
            let export_path = Path::new(exported["path"].as_str().expect("export path"));
            let payload = fs::read(export_path).map_err(state::io)?;
            use sha2::Digest;
            if exported["sha256"] != format!("{:x}", sha2::Sha256::digest(&payload))
                || exported["original_retained"] != true
            {
                return Err(error(
                    "graph_test",
                    "Export hash or retention proof differs.",
                ));
            }
            let mut bundle = tar::Archive::new(payload.as_slice());
            let mut count = 0;
            for entry in bundle.entries().map_err(state::io)? {
                let mut entry = entry.map_err(state::io)?;
                let source = archive::path(&candidate, id)?.join(entry.path().map_err(state::io)?);
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).map_err(state::io)?;
                if bytes != fs::read(source).map_err(state::io)? {
                    return Err(error(
                        "graph_test",
                        "Export changed retained evidence bytes.",
                    ));
                }
                count += 1;
            }
            if count == 0 || exported["files"] != count {
                return Err(error("graph_test", "Export file inventory differs."));
            }
            if !matches!(cli(&candidate, &["export", "--run-id", id]), Err(e) if e.message=="graph_export_exists")
                || fs::read(export_path).map_err(state::io)? != payload
            {
                return Err(error("graph_test", "Export overwrote existing evidence."));
            }
            // Simulate a process loss before consumed-ID publication; the directory already reserves the ID.
            let consumed = retention::consumed(&candidate, id)?;
            state::private_directory(&consumed)?;
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(consumed.join("state.pending"))
                    .map_err(state::io)?;
                file.write_all(b"partial consumed ID").map_err(state::io)?;
            }
            let pruned = cli(&candidate, &["prune", "--run-id", id])?;
            if pruned["consumed_id_retained"] != true
                || archive::path(&candidate, id)?.exists()
                || fs::read(export_path).map_err(state::io)? != payload
            {
                return Err(error(
                    "graph_test",
                    "Pruning lost export or consumed-ID reservation.",
                ));
            }
            cli(&candidate, &["prune", "--run-id", id])?;
            if !matches!(launch(&candidate, &fixture, id, "run"), Err(e) if e.message == "graph_replay_refused")
            {
                return Err(error("graph_test", "Archived attempt allowed replay."));
            }
        }
        Ok::<_, CandidateError>(())
    })();
    state::write(
        &evidence.join(format!("driver-{run}.json")),
        &json!({"passed":result.is_ok()&&cleanup.is_ok(),"run":run,"failed_run":failed,"cleanup_confirmed":cleanup.is_ok(),"bidirectional_workload_admission":result.is_ok(),"restore_and_archive":result.is_ok()&&cleanup.is_ok(),"archive_export":cleanup.is_ok(),"retention_recovery":cleanup.is_ok(),"abrupt_vm_loss":result.is_ok(),"receipts":result.as_ref().ok(),"failure":result.as_ref().err().map(|e|(&e.code,&e.message)),"scope":"Public graph driver, explicit restart identity/persistence, simulated missing create receipt, foreign-name refusal; not actual process-kill or Event Agent qualification"}),
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
    let execute = if std::env::var("HACK_LOCAL_GRAPH_ACTION").as_deref() == Ok("restore") {
        super::restore
    } else {
        super::run
    };
    execute(
        &candidate,
        RunOptions {
            live_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: options(),
            expected_plan: &review.plan_id,
            source_revision: None,
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
        for (action, point) in [
            ("run", "after-create"),
            ("run", "after-start"),
            ("restore", "restore-intent"),
            ("restore", "after-create"),
            ("restore", "after-start"),
        ] {
            let fixture = Fixture::new();
            let run = token();
            let root = directory(&candidate, &run)?;
            let mut document = compose(&image, &run, false);
            if action == "run" {
                document["services"]["init"]["entrypoint"] =
                    json!(["/usr/local/bin/bun", "-e", "await Bun.sleep(30000)"]);
            }
            state::write(&fixture.0.join("compose.yaml"), &document)?;
            state::write(
                &evidence.join(format!("driver-kill-{suite}.json")),
                &json!({"phase":"intent","point":point,"run":run,"completed_controls":controls}),
            )?;
            let mut prior_token = None;
            let outcome = (|| {
                if action == "restore" {
                    let initial = launch(&candidate, &fixture, &run, "run")?;
                    let engine = Engine::connect(&candidate)?;
                    let (output, _, _) = engine.logs(
                        initial["resources"]["container:init"]["id"]
                            .as_str()
                            .expect("init"),
                    )?;
                    prior_token = output.lines().last().map(str::to_owned);
                    drop(engine);
                    cli(&candidate, &["cleanup", "--run-id", &run])?;
                }
                let child = Command::new(std::env::current_exe().map_err(state::io)?)
                    .args([
                        "provider::graph::tests::fault_child",
                        "--ignored",
                        "--exact",
                    ])
                    .env("HACK_LOCAL_GRAPH_FAULT", point)
                    .env("HACK_LOCAL_GRAPH_ACTION", action)
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
                if point == "restore-intent" {
                    if init["phase"] != "reserved"
                        || snapshot["observations"]["container:init"]["state"] != "absent"
                    {
                        return Err(error(
                            "graph_test",
                            "Restore intent allocated compute early.",
                        ));
                    }
                } else if point == "after-create" {
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
                    || !(snapshot["observations"]["container:init"]["state"] == "running"
                        || (action == "restore"
                            && snapshot["observations"]["container:init"]["state"] == "exited"))
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
                if action == "restore" {
                    if !matches!(launch(&candidate, &fixture, &run, "restore"), Err(e) if e.message=="graph_restore_refused")
                    {
                        return Err(error("graph_test", "Interrupted restore replayed."));
                    }
                    let history: Receipt = super::restore_history::latest(&root)?;
                    if history.phase != "stopped-data-retained"
                        || snapshot["observations"]["volume:data"]["state"] != "present"
                    {
                        return Err(error(
                            "graph_test",
                            "Restore lost history or retained volume.",
                        ));
                    }
                    cli(&candidate, &["cleanup", "--run-id", &run])?;
                    let restored = launch(&candidate, &fixture, &run, "restore")?;
                    let engine = Engine::connect(&candidate)?;
                    let (output, _, _) = engine.logs(
                        restored["resources"]["container:init"]["id"]
                            .as_str()
                            .expect("init"),
                    )?;
                    if prior_token.as_ref().is_none_or(|v| v.len() != 36)
                        || output.lines().last() != prior_token.as_deref()
                    {
                        return Err(error(
                            "graph_test",
                            "Explicit post-crash restore lost the database token.",
                        ));
                    }
                }
                Ok(
                    json!({"action":action,"data_preserved":action=="restore","point":point,"helper_pid":pid,"signal":"SIGKILL","snapshot":snapshot,"replay_refused":true,"reservation_preserved":true,"source_launch_refused":true}),
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
            controls.push(json!({"action":action,"point":point,"passed":outcome.is_ok() && cleanup.is_ok(),"cleanup_confirmed":cleanup.is_ok(),"evidence":outcome.as_ref().ok(),"failure":outcome.as_ref().err().map(|e|(&e.code,&e.message))}));
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

#[test]
fn driver_refuses_managed_inputs_even_when_public_environment_is_empty() {
    let fixture = Fixture::new();
    let candidate_root = Fixture::new();
    let candidate = Candidate::discover(&candidate_root.0).unwrap();
    let image = format!("sha256:{}", "a".repeat(64));
    let mut document = compose(&image, "marker", false);
    document["services"]["web"]["environment"] = json!(["TOKEN"]);
    state::write(&fixture.0.join("compose.yaml"), &document).unwrap();
    let review = project::plan(&candidate, fixture.options()).unwrap();
    let managed = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]),
    )]);
    let inputs = project::inputs::compile_scoped(
        &candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
        &managed,
    )
    .unwrap();
    assert!(inputs.executable.services["web"].environment.is_empty());
    let failure = config::prepare(
        inputs.executable,
        &goals(),
        &"a".repeat(32),
        &"b".repeat(32),
        None,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "graph_subset");
    assert!(!candidate.state_root.exists());
}

#[test]
#[cfg(feature = "native-http-probe")]
#[ignore = "Owned development VM, pinned Bun image and external watchdog required"]
fn native_http_graph_readiness_restart_restore_and_supervisor_loss() -> Result<(), CandidateError> {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = Fixture::new();
    let run = token();
    let failed = token();
    let marker = token();
    let mut document = compose(&image, &marker, false);
    document["services"]["web"]["user"] = json!("1001:1001");
    document["services"]["web"]["healthcheck"] = json!({"x-hack-http":{"port":3000,"path":"/","interval_ms":100,"timeout_ms":50,"retries":3,"start_period_ms":0}});
    fs::write(
        fixture.0.join("compose.yaml"),
        serde_json::to_vec(&document).unwrap(),
    )
    .map_err(state::io)?;
    let review = project::plan(&candidate, fixture.options())?;
    let goals = goals();
    let public = BTreeMap::new();
    let options = |run_id| RunOptions {
        live_source: false,
        release_initializer_cache: std::collections::BTreeSet::new(),
        routing_enrolled: false,
        project: fixture.options(),
        expected_plan: &review.plan_id,
        source_revision: None,
        non_secret_values: &public,
        readiness: &goals,
        run_id,
        timeout: Duration::from_secs(30),
    };
    let result = (|| {
        let ready = super::run(&candidate, options(&run))?;
        assert_eq!(ready.phase, "ready-observed");
        let first = ready.probes["web"].clone();
        let engine = Engine::connect(&candidate)?;
        let id = ready.resources["container:web"].id.as_ref().unwrap();
        let inspected =
            inspect_resource(&engine, &ready, &ready.resources["container:web"])?.unwrap();
        assert_eq!(inspected["Config"]["Healthcheck"]["Test"], json!(["NONE"]));
        assert_eq!(
            probes::observe(&engine, &ready, "web", &inspected)?,
            Observation::Running {
                health: Health::Healthy
            }
        );
        let v = engine.request(
            Method::GET,
            &format!("/v1.53/exec/{}/json", first.exec_id.as_ref().unwrap()),
            None,
        )?;
        let pid = v["Pid"]
            .as_u64()
            .filter(|p| *p > 1 && *p < i32::MAX as u64)
            .unwrap()
            .to_string();
        engine.guest().execute_cleanup(
            r#"
test "$(readlink /proc/$1/exe)" = /run/hack-http-probe
grep -F "$2" /proc/$1/cgroup >/dev/null
kill -KILL "$1"
"#,
            &[&pid, id],
        )?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if probes::observe(&engine, &ready, "web", &inspected)?
                == (Observation::Running {
                    health: Health::Unhealthy,
                })
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        engine.request(
            Method::POST,
            &format!("/v1.53/containers/{id}/stop?t=1"),
            None,
        )?;
        drop(engine);
        let restarted = restart(&candidate, options(&run))?;
        assert_eq!(
            restarted.resources["container:web"].id,
            ready.resources["container:web"].id
        );
        assert_ne!(restarted.probes["web"].generation, first.generation);
        assert_ne!(restarted.probes["web"].exec_id, first.exec_id);
        // A boot loses tmpfs probe storage. Reproduce its absence with owned cleanup,
        // keeping the stopped container and persistent graph resources unchanged.
        let engine = Engine::connect(&candidate)?;
        engine.request(
            Method::POST,
            &format!("/v1.53/containers/{id}/stop?t=1"),
            None,
        )?;
        probes::cleanup(&engine, &mut restarted.clone())?;
        drop(engine);
        let rebuilt = restart(&candidate, options(&run))?;
        assert_eq!(
            rebuilt.resources["container:web"].id,
            restarted.resources["container:web"].id
        );
        assert_eq!(
            rebuilt.probes["web"].allocation,
            restarted.probes["web"].allocation
        );
        assert_ne!(
            rebuilt.probes["web"].generation,
            restarted.probes["web"].generation
        );
        let stopped = cleanup(&candidate, &run, false)?;
        assert_eq!(stopped.probes["web"].phase, "retired");
        let restored = restore(&candidate, options(&run))?;
        assert_ne!(restored.probes["web"].allocation, first.allocation);
        assert_ne!(
            restored.resources["container:web"].id,
            ready.resources["container:web"].id
        );
        let snapshot = inspect(&candidate, &run)?;
        assert_eq!(snapshot.observations["container:web"]["health"], "healthy");
        Ok(())
    })();
    let cleaned = cleanup(&candidate, &run, true);
    result?;
    cleaned?;
    cleanup(&candidate, &run, true)?;
    document["services"]["init"]["entrypoint"] =
        json!(["/usr/local/bin/bun", "-e", "process.exit(23)"]);
    fs::write(
        fixture.0.join("compose.yaml"),
        serde_json::to_vec(&document).unwrap(),
    )
    .map_err(state::io)?;
    let review = project::plan(&candidate, fixture.options())?;
    let failed_result = super::run(
        &candidate,
        RunOptions {
            live_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: fixture.options(),
            expected_plan: &review.plan_id,
            source_revision: None,
            non_secret_values: &public,
            readiness: &goals,
            run_id: &failed,
            timeout: Duration::from_secs(30),
        },
    );
    assert!(failed_result.is_err());
    let retained = inspect(&candidate, &failed)?;
    assert!(retained.receipt.probes["web"].exec_id.is_none());
    assert!(retained.receipt.resources["container:web"].id.is_none());
    cleanup(&candidate, &failed, true)?;
    Ok(())
}

#[test]
#[cfg(feature = "native-http-probe")]
#[ignore = "Owned VM, native probe build and external watchdog required"]
fn native_http_driver_loss_retains_intents_and_cleans_owned_allocations()
-> Result<(), CandidateError> {
    use std::process::{Child, Stdio};
    struct OwnedChild(Option<Child>);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    for point in [
        "probe-after-allocation",
        "probe-after-exec-create",
        "probe-after-exec-start",
    ] {
        let fixture = Fixture::new();
        let run = token();
        let mut document = compose(&image, &run, false);
        document["services"]["web"]["healthcheck"] = json!({"x-hack-http":{"port":3000,"path":"/","interval_ms":100,"timeout_ms":50,"retries":3,"start_period_ms":0}});
        state::write(&fixture.0.join("compose.yaml"), &document)?;
        let child = Command::new(std::env::current_exe().map_err(state::io)?)
            .args([
                "--ignored",
                "--exact",
                "provider::graph::tests::fault_child",
            ])
            .env("HACK_LOCAL_GRAPH_FAULT", point)
            .env("HACK_LOCAL_GRAPH_PROJECT", &fixture.0)
            .env("HACK_LOCAL_GRAPH_RUN", &run)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(state::io)?;
        let mut child = OwnedChild(Some(child));
        let marker = directory(&candidate, &run)?.join(format!("fault-{point}.json"));
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !marker.exists() {
            assert!(
                child
                    .0
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .map_err(state::io)?
                    .is_none(),
                "fault child exited early"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "fault boundary was not reached"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        child.0.as_mut().unwrap().kill().map_err(state::io)?;
        child.0.as_mut().unwrap().wait().map_err(state::io)?;
        child.0 = None;
        let retained = inspect(&candidate, &run)?;
        let p = &retained.receipt.probes["web"];
        assert_eq!(
            p.phase,
            match point {
                "probe-after-allocation" => "allocation-intent",
                "probe-after-exec-create" => "exec-intent",
                _ => "starting",
            }
        );
        assert_eq!(p.exec_id.is_some(), point == "probe-after-exec-start");
        assert!(retained.receipt.resources["container:check"].id.is_none());
        assert!(launch(&candidate, &fixture, &run, "run").is_err());
        let cleaned = cleanup(&candidate, &run, true)?;
        assert_eq!(cleaned.probes["web"].phase, "retired");
        cleanup(&candidate, &run, true)?;
    }
    Ok(())
}

#[test]
#[cfg(feature = "native-http-probe")]
fn native_http_rejects_reserved_mounts_and_completed_readiness_before_allocation() {
    let fixture = Fixture::new();
    let candidate_root = Fixture::new();
    let candidate = Candidate::discover(&candidate_root.0).unwrap();
    let mut document = compose(&format!("sha256:{}", "a".repeat(64)), "fixture", false);
    document["services"]["web"]["healthcheck"] = json!({"x-hack-http":{"port":3000,"path":"/","interval_ms":1000,"timeout_ms":500,"retries":3,"start_period_ms":0}});
    for target in [
        "/run",
        "/run/hack-http-probe",
        "/run/hack-http-probe-state/nested",
    ] {
        document["services"]["web"]["volumes"] = json!([format!("data:{target}")]);
        fs::write(
            fixture.0.join("compose.yaml"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let review = project::plan(&candidate, fixture.options()).unwrap();

        assert!(
            review
                .plan
                .diagnostics
                .iter()
                .any(|d| d.code == "reserved_mount_target")
        );
        assert!(
            project::inputs::compile(
                &candidate,
                fixture.options(),
                &review.plan_id,
                &BTreeMap::new()
            )
            .is_err()
        );
    }
    document["services"]["web"]["volumes"] = json!(["data:/data"]);
    fs::write(
        fixture.0.join("compose.yaml"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let review = project::plan(&candidate, fixture.options()).unwrap();
    let inputs = project::inputs::compile(
        &candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
    )
    .unwrap();
    let mut goals = goals();
    goals.insert("web".into(), Condition::Completed);
    assert_eq!(
        config::prepare(inputs, &goals, &token(), &token(), None)
            .err()
            .unwrap()
            .code,
        "native_http_readiness"
    );
    assert!(!candidate.state_root.join("run/graphs").exists());
}

#[test]
#[cfg(all(feature = "native-http-probe", feature = "environment-launcher"))]
#[ignore = "Owned VM, managed launcher, native probe and external watchdog required"]
fn native_http_preserves_scoped_nonroot_delivery_and_fresh_restore() -> Result<(), CandidateError> {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = Fixture::new();
    let run = token();
    let mut document = compose(&image, &run, false);
    let init = document["services"]["init"]["entrypoint"][2]
        .as_str()
        .unwrap()
        .to_owned();
    document["services"]["init"]["entrypoint"][2] = json!(format!(
        "const f=Bun.file('/data/native-starts');await Bun.write('/data/native-starts',String((await f.exists()?Number(await f.text()):0)+1));{init}"
    ));
    let web = document["services"]["web"]["entrypoint"][2]
        .as_str()
        .unwrap()
        .to_owned();
    document["services"]["web"]["entrypoint"][2] = json!(format!(
        "if(process.getuid()!==1001||!process.env.TOKEN?.startsWith('synthetic-native-')||((await Bun.file('/data/native-starts').text())==='2')!==process.env.TOKEN.endsWith('-fresh'))process.exit(77);{web}"
    ));
    document["services"]["web"]["user"] = json!("1001:1001");
    document["services"]["web"]["environment"] = json!({"TOKEN":null});
    document["services"]["web"]["healthcheck"] = json!({"x-hack-http":{"port":3000,"path":"/","interval_ms":100,"timeout_ms":50,"retries":10,"start_period_ms":500}});
    state::write(&fixture.0.join("compose.yaml"), &document)?;
    let review = project::plan(&candidate, fixture.options())?;
    let goals = goals();
    let public = BTreeMap::new();
    let options = || RunOptions {
        live_source: false,
        release_initializer_cache: std::collections::BTreeSet::new(),
        routing_enrolled: false,
        project: fixture.options(),
        expected_plan: &review.plan_id,
        source_revision: None,
        non_secret_values: &public,
        readiness: &goals,
        run_id: &run,
        timeout: Duration::from_secs(30),
    };
    let values = |suffix: &str| {
        BTreeMap::from([(
            "web".into(),
            BTreeMap::from([("TOKEN".into(), format!("synthetic-native-{suffix}"))]),
        )])
    };
    let result = (|| {
        let initial = run_with_environment(
            &candidate,
            options(),
            &values("initial"),
            Duration::from_secs(120),
        )?;
        assert!(initial.environment_attached);
        cleanup(&candidate, &run, false)?;
        let restored = restore_with_environment(
            &candidate,
            options(),
            &values("restored-fresh"),
            Duration::from_secs(120),
        )?;
        assert_ne!(
            restored.probes["web"].generation,
            initial.probes["web"].generation
        );
        let engine = Engine::connect(&candidate)?;
        let value =
            inspect_resource(&engine, &restored, &restored.resources["container:web"])?.unwrap();
        assert!(
            !value["Config"]["Env"]
                .to_string()
                .contains("synthetic-native")
        );
        assert_eq!(
            probes::observe(&engine, &restored, "web", &value)?,
            Observation::Running {
                health: Health::Healthy
            }
        );
        Ok(())
    })();
    let cleaned = cleanup(&candidate, &run, true);
    result?;
    cleaned?;
    Ok(())
}

#[test]
fn public_environment_composes_with_private_delivery_without_metadata_leakage() {
    let fixture = Fixture::new();
    let home = Fixture::new();
    let candidate = Candidate::discover(&home.0).unwrap();
    let document = json!({"services":{"web":{
        "image":format!("sha256:{}", "a".repeat(64)), "read_only":true,
        "network_mode":"none", "user":"1001:1002", "init":true,
        "entrypoint":["/bin/app","--literal"], "command":["space argument"],
        "environment":{"PUBLIC":"literal=with space","REGION":"${REGION}","TOKEN":null}
    }}});
    state::write(&fixture.0.join("compose.yaml"), &document).unwrap();
    let review = project::plan(&candidate, fixture.options()).unwrap();
    let public = BTreeMap::from([("REGION".into(), "us-east-1".into())]);
    let managed = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([(
            "TOKEN".into(),
            "synthetic-private-environment-canary".into(),
        )]),
    )]);
    let scoped = project::inputs::compile_scoped(
        &candidate,
        fixture.options(),
        &review.plan_id,
        &public,
        &managed,
    )
    .unwrap();
    assert_eq!(scoped.managed_environment, managed);
    let mut prepared = config::prepare_delivery(
        scoped.executable,
        &BTreeMap::from([("web".into(), Condition::Started)]),
        &token(),
        &token(),
        None,
        config::DeliveryOptions {
            environment: true,
            ..Default::default()
        },
    )
    .unwrap();
    let config = prepared.configs.get_mut("web").unwrap();
    let expected = json!(["PUBLIC=literal=with space", "REGION=us-east-1"]);
    assert_eq!(config["Env"], expected);
    launcher::attach(config, "/run/slot/values.json", "/storage/launcher").unwrap();
    assert_eq!(config["Env"], expected);
    assert_eq!(config["User"], "1001:1002");
    assert_eq!(config["HostConfig"]["Init"], true);
    assert_eq!(
        config["Entrypoint"],
        json!([
            "/run/hack-environment-launcher",
            "/run/hack-environment.json",
            "/run/hack-environment.expires",
            "/bin/app",
            "--literal",
            "space argument"
        ])
    );
    assert!(
        !serde_json::to_string(config)
            .unwrap()
            .contains("synthetic-private-environment-canary")
    );
    assert!(
        project::inputs::compile_scoped(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
            &managed
        )
        .is_err()
    );
    let mut collision = managed;
    collision
        .get_mut("web")
        .unwrap()
        .insert("PUBLIC".into(), "replacement".into());
    assert!(
        project::inputs::compile_scoped(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &public,
            &collision
        )
        .is_err()
    );
    assert!(!candidate.state_root.exists());
}

#[test]
fn dependency_cache_graphs_share_only_verified_binding_and_pin_restore_targets() {
    let fixture = Fixture::new();
    let home = Fixture::new();
    let candidate = Candidate::discover(&home.0).unwrap();
    fs::write(fixture.0.join("bun.lock"), "lock-one").unwrap();
    fs::write(fixture.0.join("package.json"), "{}").unwrap();
    let document = json!({"services":{"deps":{
        "image":format!("sha256:{}", "a".repeat(64)),"read_only":true,"network_mode":"none",
        "entrypoint":["/bin/true"],"command":[],"volumes":[".:/app:ro","deps:/app/node_modules"],
        "labels":{"hack.dependencies.cache-volume":"deps","hack.dependencies.lockfiles":"bun.lock","hack.dependencies.bootstrap":"true"}
    }},"volumes":{"deps":{}}});
    fs::write(fixture.0.join("compose.yaml"), document.to_string()).unwrap();
    let prepare = |run: &str, ready: Condition| {
        let review = project::plan(&candidate, fixture.options()).unwrap();
        let snapshot = project::snapshot::capture(
            &fixture.0,
            &std::collections::BTreeSet::new(),
            &review.plan.source_selection.metadata_sha256,
        )
        .unwrap();
        let manifest = snapshot.receipt().clone();
        let source = source::Inputs {
            current_manifest: None,
            binding: SourceBinding {
                live: None,
                revision: manifest.revision.clone(),
                archive_sha256: "b".repeat(64),
                selection_sha256: manifest.selection_sha256.clone(),
            },
            manifest,
            paths: BTreeMap::from([(".".into(), "/storage/reviewed-source/tree".into())]),
        };
        let inputs = project::inputs::compile(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
        )
        .unwrap();
        config::prepare(
            inputs,
            &BTreeMap::from([("deps".into(), ready)]),
            run,
            &"b".repeat(32),
            Some(&source),
        )
    };
    assert_eq!(
        prepare(&"a".repeat(32), Condition::Started)
            .err()
            .unwrap()
            .code,
        "graph_cache_readiness"
    );
    let first = prepare(&"a".repeat(32), Condition::Completed).unwrap();
    let second = prepare(&"c".repeat(32), Condition::Completed).unwrap();
    assert_eq!(
        first.cache_initializers,
        BTreeMap::from([("deps".into(), "deps".into())])
    );
    let cache = &first.resources["volume:deps"];
    assert!(cache.cache.is_some());
    assert_eq!(cache.name, second.resources["volume:deps"].name);
    assert_ne!(
        first.resources["container:deps"].name,
        second.resources["container:deps"].name
    );
    assert_eq!(
        first.configs["deps"]["HostConfig"]["Mounts"][1]["Source"],
        cache.name
    );
    assert!(same_resource_bindings(&first.resources, &first.resources));
    let mut retained = first.resources.clone();
    retained.get_mut("volume:deps").unwrap().phase = "created".into();
    assert!(same_resource_bindings(&first.resources, &retained));
    fs::write(fixture.0.join("bun.lock"), "lock-two").unwrap();
    let changed = prepare(&"a".repeat(32), Condition::Completed).unwrap();
    assert_ne!(cache.name, changed.resources["volume:deps"].name);
    assert!(!same_resource_bindings(&changed.resources, &retained));
    assert!(!candidate.state_root.exists());
}

#[test]
fn outbound_network_is_pinned_and_requires_explicit_pool_capability() {
    let resource = Resource {
        routing: None,
        networks: None,
        outbound: true,
        cache: None,
        cache_provenance: None,
        kind: Kind::Network,
        key: "default".into(),
        name: "owned-network".into(),
        id: None,
        image: None,
        phase: "reserved".into(),
    };
    let resources = BTreeMap::from([("network:default".into(), resource)]);
    assert!(check_network_request(&super::super::NetworkIntent::Isolated, &resources).is_err());
    assert!(check_network_request(&super::super::NetworkIntent::HostGateway, &resources).is_err());
    let approved = super::super::NetworkIntent::ApprovedHosts {
        hosts: vec!["registry.example.com".into()],
        cidrs: vec!["1.1.1.1/32".into()],
    };
    check_network_request(&approved, &resources).unwrap();
    let mut internal = resources.clone();
    internal.get_mut("network:default").unwrap().outbound = false;
    check_network_request(&super::super::NetworkIntent::Isolated, &internal).unwrap();
    assert!(!same_resource_bindings(&resources, &internal));
    let encoded = serde_json::to_value(&internal["network:default"]).unwrap();
    assert!(encoded.get("outbound").is_none());
    assert!(
        !serde_json::from_value::<Resource>(encoded)
            .unwrap()
            .outbound
    );
}

#[test]
fn two_subpath_mounts_keep_one_volume_and_exact_docker_selection() {
    let fixture = Fixture::new();
    let home = Fixture::new();
    let candidate = Candidate::discover(&home.0).unwrap();
    let document = json!({"services":{"web":{"image":format!("sha256:{}","a".repeat(64)),"read_only":true,"network_mode":"none","volumes":[
        {"type":"volume","source":"cache","target":"/one","volume":{"subpath":"workspaces/one"}},
        {"type":"volume","source":"cache","target":"/two","volume":{"subpath":"workspaces/two"}}
    ]}},"volumes":{"cache":{}}});
    fs::write(fixture.0.join("compose.yaml"), document.to_string()).unwrap();
    let review = project::plan(&candidate, fixture.options()).unwrap();
    let inputs = project::inputs::compile(
        &candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
    )
    .unwrap();
    let prepared = config::prepare(
        inputs,
        &BTreeMap::from([("web".into(), Condition::Started)]),
        &"a".repeat(32),
        &"b".repeat(32),
        None,
    )
    .unwrap();
    assert_eq!(
        prepared
            .resources
            .values()
            .filter(|r| r.kind == Kind::Volume)
            .count(),
        1
    );
    let mounts = &prepared.configs["web"]["HostConfig"]["Mounts"];
    assert_eq!(mounts[0]["Source"], mounts[1]["Source"]);
    assert_eq!(
        mounts[0]["VolumeOptions"],
        json!({"Subpath":"workspaces/one","NoCopy":true})
    );
    assert_eq!(
        mounts[1]["VolumeOptions"],
        json!({"Subpath":"workspaces/two","NoCopy":true})
    );
    let mut changed = prepared.configs["web"]["HostConfig"].clone();
    changed["Mounts"][0]["VolumeOptions"]["Subpath"] = json!("workspaces/two");
    assert!(!contains_request(
        &prepared.configs["web"]["HostConfig"],
        &changed
    ));
}

#[test]
fn endpoint_selects_service_primary_not_unrelated_first_graph_network() {
    let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
    let mut networks = BTreeMap::new();
    for (key, name, id) in [
        ("aaa", "owned-unrelated", "1".repeat(64)),
        ("zzz", "owned-primary", "2".repeat(64)),
    ] {
        receipt.resources.insert(
            format!("network:{key}"),
            Resource {
                routing: None,
                networks: None,
                outbound: false,
                cache: None,
                cache_provenance: None,
                kind: Kind::Network,
                key: key.into(),
                name: name.into(),
                id: Some(id.clone()),
                image: None,
                phase: "created".into(),
            },
        );
        networks.insert(format!("network:{key}"), Some(json!({"Id":id,"Name":name,"Containers":{"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee":{"EndpointID":"f".repeat(64),"IPv4Address":"172.20.0.2/16"}}})));
    }
    let container = json!({"Id":"e".repeat(64),"HostConfig":{"NetworkMode":"owned-primary"},"State":{"Running":true,"StartedAt":"2026-09-18T12:00:00Z"},"NetworkSettings":{"Networks":{"owned-primary":{"NetworkID":"2".repeat(64),"EndpointID":"f".repeat(64),"IPAddress":"172.20.0.2"}}}});
    let selected = endpoint_network(&receipt, &container, &networks)
        .unwrap()
        .unwrap();
    let endpoint = endpoints::resolve(
        &container,
        selected,
        6980,
        &endpoints::EndpointScope {
            receipt: &receipt,
            boot: "owned-boot",
            service: "search",
        },
    )
    .unwrap();
    assert_eq!(endpoint.network_id, "2".repeat(64));
    assert_eq!(endpoint.address.to_string(), "172.20.0.2");
    // The previous graph-wide first selection cannot resolve this service.
    assert!(
        endpoints::resolve(
            &container,
            networks.first_key_value().unwrap().1.as_ref().unwrap(),
            6980,
            &endpoints::EndpointScope {
                receipt: &receipt,
                boot: "owned-boot",
                service: "search"
            }
        )
        .is_err()
    );
    for field in [
        "missing-network",
        "missing-attachment",
        "changed-id",
        "unknown-mode",
    ] {
        let mut observed = container.clone();
        let mut snapshots = networks.clone();
        match field {
            "missing-network" => {
                snapshots.insert("network:zzz".into(), None);
            }
            "missing-attachment" => observed["NetworkSettings"]["Networks"] = json!({}),
            "changed-id" => {
                observed["NetworkSettings"]["Networks"]["owned-primary"]["NetworkID"] =
                    json!("3".repeat(64))
            }
            _ => observed["HostConfig"]["NetworkMode"] = json!("foreign"),
        }
        assert_eq!(
            endpoint_network(&receipt, &observed, &snapshots)
                .unwrap_err()
                .code,
            "graph_endpoint_identity",
            "{field}"
        );
    }
    let mut isolated = container;
    isolated["HostConfig"]["NetworkMode"] = json!("none");
    assert!(
        endpoint_network(&receipt, &isolated, &networks)
            .unwrap()
            .is_none()
    );
}

#[test]
fn declared_networks_survive_compile_and_bind_restore_identity() {
    for count in [2, MAX_NETWORKS] {
        let fixture = Fixture::new();
        let candidate_root = Fixture::new();
        let candidate = Candidate::discover(&candidate_root.0).unwrap();
        let names: Vec<String> = (0..count).rev().map(|i| format!("net{i}")).collect();
        let declarations: serde_json::Map<String, Value> = names
            .iter()
            .map(|name| (name.clone(), json!({"internal":true})))
            .collect();
        let document = json!({"services":{"web":{"image":format!("sha256:{}","a".repeat(64)),"read_only":true,"command":["true"],"networks":names}},"networks":declarations});
        state::write(&fixture.0.join("compose.yaml"), &document).unwrap();
        let review = project::plan(&candidate, fixture.options()).unwrap();
        let inputs = project::inputs::compile(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
        )
        .unwrap();
        let prepared = config::prepare(
            inputs,
            &BTreeMap::from([("web".into(), Condition::Completed)]),
            &"a".repeat(32),
            &"b".repeat(32),
            None,
        )
        .unwrap();
        assert_eq!(
            prepared.resources["container:web"].networks.as_ref(),
            Some(&names)
        );
        let endpoints = prepared.configs["web"]["NetworkingConfig"]["EndpointsConfig"]
            .as_object()
            .unwrap();
        assert_eq!(endpoints.len(), count);
        assert_eq!(
            prepared.configs["web"]["HostConfig"]["NetworkMode"],
            prepared.resources[&format!("network:{}", names[0])].name
        );
        assert!(network_bindings_valid(&prepared.resources));
        assert!(resource_counts_fit(&prepared.resources));
        let mut changed = prepared.resources.clone();
        changed
            .get_mut("container:web")
            .unwrap()
            .networks
            .as_mut()
            .unwrap()
            .reverse();
        assert!(!same_resource_bindings(&prepared.resources, &changed));
        changed.get_mut("container:web").unwrap().networks = Some(vec!["foreign".into()]);
        assert!(!network_bindings_valid(&changed));
        changed.get_mut("container:web").unwrap().networks =
            Some(vec![names[0].clone(), names[0].clone()]);
        assert!(!network_bindings_valid(&changed));
        changed.get_mut("container:web").unwrap().networks = None;
        assert!(!network_bindings_valid(&changed));
        assert!(!same_resource_bindings(&prepared.resources, &changed));
        assert!(!candidate.state_root.exists());
    }
}
