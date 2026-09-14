use super::*;
use std::{io::Read, path::Path, process::Command};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
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
            "import {{Database}} from 'bun:sqlite';const db=new Database('/data/proof.sqlite');db.exec('CREATE TABLE IF NOT EXISTS proof(id INTEGER PRIMARY KEY,value TEXT)');db.query('INSERT OR IGNORE INTO proof VALUES (1,?)').run('{marker}');if(db.query('SELECT value FROM proof WHERE id=1').get().value!=='{marker}')throw Error('persistence');db.close();"
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
        let first = launch(&candidate, &fixture, &run, "run")?;
        if launch(&candidate, &fixture, &run, "run").is_ok() {
            return Err(error("graph_test", "Duplicate attempt replayed."));
        }
        if launch(&candidate, &fixture, &run, "restart").is_ok() {
            return Err(error("graph_test", "Restart accepted a running graph."));
        }
        super::super::down(&candidate)?;
        super::super::up_with_profile(&candidate, super::super::Profile::Development)?;
        let second = launch(&candidate, &fixture, &run, "restart")?;
        for name in ["init", "web", "check"] {
            let key = format!("container:{name}");
            if first["resources"][&key]["id"] != second["resources"][&key]["id"] {
                return Err(error("graph_test", "Restart recreated a container."));
            }
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
        cli(&candidate, &["inspect", "--run-id", &run])?;
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
        Ok::<_, CandidateError>(())
    })();
    state::write(
        &evidence.join(format!("driver-{run}.json")),
        &json!({"passed":result.is_ok()&&cleanup.is_ok(),"run":run,"failed_run":failed,"cleanup_confirmed":cleanup.is_ok(),"receipts":result.as_ref().ok(),"failure":result.as_ref().err().map(|e|(&e.code,&e.message)),"scope":"Public graph driver, explicit restart identity/persistence, simulated missing create receipt, foreign-name refusal; not actual process-kill or Event Agent qualification"}),
    )?;
    cleanup?;
    result.map(|_| ())
}
