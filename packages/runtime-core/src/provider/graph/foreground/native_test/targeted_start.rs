//! Drive the real normalized foreground owner and its authenticated append socket.
use super::absent_publication_recovery::ready;
use super::dependency_rebind::{checked_cli, snapshot};
use super::*;

struct Fixture {
    candidate: Candidate,
    binary: PathBuf,
    project: graph::tests::Fixture,
    inputs: graph::tests::Fixture,
    run: String,
    deadline: Instant,
}

struct Review {
    plan: project::PlanReport,
    original: String,
    file: PathBuf,
}

impl Fixture {
    fn review(&self, document: &Value) -> Review {
        let bytes = document.to_string().into_bytes();
        let original = format!(
            "{:x}",
            crate::Hex(Sha256::digest(
                fs::read(self.project.0.join("compose.yaml")).unwrap()
            ))
        );
        let namespace = self.candidate.plan(&self.project.0).unwrap().namespace;
        let plan = project::plan_normalized(
            &self.candidate,
            project::NormalizedComposeOptions {
                project: &self.project.0,
                branch: None,
                expected_namespace: &namespace,
                compose_file: Path::new("compose.yaml"),
                expected_compose_sha256: &original,
                compose_bytes: &bytes,
                profiles: &[],
            },
        )
        .unwrap();
        let file = self.inputs.0.join(format!("{}.json", plan.plan_id));
        fs::write(&file, bytes).unwrap();
        Review {
            plan,
            original,
            file,
        }
    }

    fn start(
        &self,
        action: &str,
        review: &Review,
        goals: &[&str],
        generation: Option<&str>,
    ) -> Process {
        let mut args = vec![
            "graph",
            action,
            "--project",
            self.project.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan.plan_id,
            "--normalized-file",
            review.file.to_str().unwrap(),
            "--expect-original",
            &review.original,
            "--expect-namespace",
            &review.plan.plan.namespace,
            "--run-id",
            &self.run,
            "--timeout-seconds",
            "60",
            "--json",
        ];
        for goal in goals {
            args.extend(["--ready", goal]);
        }
        let routes: Vec<_> = review
            .plan
            .plan
            .services
            .iter()
            .filter(|(_, service)| service.active && service.routing.is_some())
            .map(|(name, _)| format!("{name}=auto"))
            .collect();
        for route in &routes {
            args.extend(["--route-slot", route]);
        }
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        if action == "extend" {
            return Process::start(&self.binary, &self.candidate, &args, None);
        }
        let selection = self.inputs.0.join("dependencies.json");
        state::write(&selection, &json!({"version":1,"plan":review.plan.plan_id,
            "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),"dependencies":[]})).unwrap();
        let dependency = self.cli(
            "dependency-plan",
            &[
                "graph",
                "dependency-plan",
                "--dependencies",
                selection.to_str().unwrap(),
                "--json",
            ],
        );
        args.extend([
            "--dependencies",
            selection.to_str().unwrap(),
            "--expect-dependencies",
            dependency["dependency_plan_id"].as_str().unwrap(),
        ]);
        let mut owner = Process::start(&self.binary, &self.candidate, &args, None);
        ready(&mut owner, &self.run, self.deadline);
        owner
    }

    fn cli(&self, stage: &str, args: &[&str]) -> Value {
        checked_cli(stage, &self.binary, &self.candidate, args, self.deadline)
    }

    fn graph(&self, action: &str) -> Value {
        self.cli(action, &["graph", action, "--run-id", &self.run, "--json"])
    }

    fn receipt(&self) -> Receipt {
        snapshot(&self.candidate, &self.run, self.deadline).receipt
    }

    fn wait_started_append(&self, service: &str) {
        let root = graph::directory(&self.candidate, &self.run).unwrap();
        loop {
            let (receipt, _) =
                graph::load_at(root.clone(), &self.run, &self.receipt_owner()).unwrap();
            if receipt.extending.contains(service)
                && receipt.resources[&format!("container:{service}")].phase == "started"
            {
                return;
            }
            assert!(Instant::now() < self.deadline, "extension start deadline");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn receipt_owner(&self) -> String {
        state::Owner::load(&self.candidate).unwrap().token
    }
}

fn result(process: &mut Process, deadline: Instant, success: bool) -> Value {
    let status = process.wait(deadline);
    let bytes = if status.success() {
        &process.out
    } else {
        &process.err
    };
    let reply: Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(
        status.success(),
        success,
        "code={}, cause={}",
        reply["code"],
        reply["cause_code"]
    );
    reply
}

#[test]
#[ignore = "Isolated macOS development VM, fixture image and matching CLI required"]
fn normalized_owner_appends_rolls_back_serializes_and_restores() {
    let fixture = Fixture {
        candidate: Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))
            .unwrap(),
        binary: PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap()),
        project: graph::tests::Fixture::new(),
        inputs: graph::tests::Fixture::new(),
        run: graph::probes::token().unwrap(),
        deadline: Instant::now() + Duration::from_secs(180),
    };
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let service = |command: &str| {
        json!({"image":image,"network_mode":"none","user":"0:0",
        "entrypoint":["/bin/sh","-ec",command],"command":[],"stop_grace_period":"1s"})
    };
    let old = json!({"services":{"web":service("sleep 300")}});
    let mut combined = old.clone();
    combined["services"]["db"] = service("sleep 300");
    combined["services"]["db"]["volumes"] = json!(["data:/data"]);
    combined["volumes"] = json!({"data":{}});
    let mut authored = combined.clone();
    authored["services"]["bad"] = service("exit 7");
    authored["services"]["slow"] = service("sleep 120");
    let compose = fixture.project.0.join("compose.yaml");
    fs::write(&compose, authored.to_string()).unwrap();
    let mut owner = fixture.start("serve", &fixture.review(&old), &["web=started"], None);
    let mut cleanup = Cleanup {
        binary: &fixture.binary,
        candidate: &fixture.candidate,
        run: &fixture.run,
        done: false,
    };
    let before = fixture.receipt();
    let generation = graph::service_exec_generation(&before).unwrap();

    let bad = fixture.review(&json!({"services":{"bad":authored["services"]["bad"]}}));
    let mut failure = fixture.start("extend", &bad, &["bad=completed"], Some(&generation));
    assert_eq!(
        result(&mut failure, fixture.deadline, false)["cause_code"],
        "graph_service_failed"
    );
    let rolled_back = fixture.receipt();
    assert_eq!(rolled_back.resources.len(), before.resources.len());
    assert!(rolled_back.extending.is_empty());

    let slow = fixture.review(&json!({"services":{"slow":authored["services"]["slow"]}}));
    let mut first = fixture.start("extend", &slow, &["slow=completed"], Some(&generation));
    fixture.wait_started_append("slow");
    assert_eq!(
        fixture.graph("owner-status")["runtime_error"],
        "graph_starting"
    );
    let db = fixture.review(
        &json!({"services":{"db":combined["services"]["db"]},"volumes":combined["volumes"]}),
    );
    let mut second = fixture.start("extend", &db, &["db=started"], Some(&generation));
    assert_eq!(
        result(&mut second, fixture.deadline, false)["cause_code"],
        "graph_starting"
    );
    first.child.kill().unwrap();
    first.wait(fixture.deadline);
    loop {
        let current = fixture.receipt();
        if current.extending.is_empty() {
            assert!(!current.resources.contains_key("container:slow"));
            break;
        }
        assert!(Instant::now() < fixture.deadline);
    }

    let mut second = fixture.start("extend", &db, &["db=started"], Some(&generation));
    let added = result(&mut second, fixture.deadline, true);
    assert_eq!(added["started"], json!(["db"]));
    let after = fixture.receipt();
    assert_eq!(
        after.resources["container:web"].id,
        before.resources["container:web"].id
    );
    assert_eq!(after.resources["container:db"].phase, "started");
    assert_ne!(after.normalized_input, before.normalized_input);
    assert_ne!(
        after.input_plan_id.as_deref(),
        Some(before.plan_id.as_str())
    );
    assert_eq!(after.plan_id, before.plan_id);
    let reviewed_combined = fixture.review(&combined);
    assert_eq!(
        after.input_plan_id.as_deref(),
        Some(reviewed_combined.plan.plan_id.as_str())
    );
    assert_eq!(
        after
            .normalized_input
            .as_ref()
            .unwrap()
            .normalized_compose_sha256,
        reviewed_combined.plan.plan.compose_sha256,
    );

    let mut repeat = fixture.start(
        "extend",
        &db,
        &["db=started"],
        Some(&graph::service_exec_generation(&after).unwrap()),
    );
    assert_eq!(
        result(&mut repeat, fixture.deadline, true)["started"],
        json!([])
    );
    let current = fixture.receipt();
    let generation = graph::service_exec_generation(&current).unwrap();
    {
        let engine = graph::Engine::connect(&fixture.candidate).unwrap();
        let id = current.resources["container:db"].id.clone().unwrap();
        engine
            .stop_containers_diagnosed(&[(id, 1)])
            .map_err(|failure| failure.error)
            .unwrap();
    }
    let mut resumed = fixture.start("extend", &db, &["db=started"], Some(&generation));
    assert_eq!(
        result(&mut resumed, fixture.deadline, true)["started"],
        json!(["db"])
    );
    assert_eq!(
        fixture.receipt().resources["container:db"].id,
        current.resources["container:db"].id
    );

    // Explicit down receives the stop through the startup request server,
    // cancels this append, and then cleans up the original run as well.
    let generation = graph::service_exec_generation(&fixture.receipt()).unwrap();
    let mut cancelled = fixture.start("extend", &slow, &["slow=completed"], Some(&generation));
    fixture.wait_started_append("slow");
    fixture.graph("cleanup");
    assert_eq!(
        result(&mut cancelled, fixture.deadline, false)["cause_code"],
        "graph_cancelled"
    );
    assert_eq!(fixture.receipt().phase, "stopped-data-retained");
    assert!(owner.wait(fixture.deadline).success());
    let retained = fixture.graph("restore-selection");
    let mut restored = fixture.start(
        "serve-restore",
        &fixture.review(&combined),
        &["db=started", "web=started"],
        retained["generation"].as_str(),
    );
    assert_eq!(
        fixture.receipt().resources["volume:data"].name,
        after.resources["volume:data"].name
    );
    fixture.graph("cleanup");
    assert!(restored.wait(fixture.deadline).success());

    // Restore the original Compose bytes and make sure the prior normalized
    // identity cannot select exact replay of a now different resource set.
    fs::write(&compose, old.to_string()).unwrap();
    let retained = fixture.graph("restore-selection");
    let mut reverted = fixture.start(
        "serve-restore",
        &fixture.review(&old),
        &["web=started"],
        retained["generation"].as_str(),
    );
    let receipt = fixture.receipt();
    assert!(!receipt.resources.contains_key("container:db"));
    assert_eq!(
        receipt.resources["volume:data"].name,
        after.resources["volume:data"].name
    );
    fixture.cli(
        "remove fixture data",
        &[
            "graph",
            "cleanup",
            "--run-id",
            &fixture.run,
            "--remove-data",
            "--json",
        ],
    );
    assert!(reverted.wait(fixture.deadline).success());
    cleanup.done = true;
}

#[test]
#[ignore = "Caller-owned macOS development VM, three free bridge slots, BusyBox HTTP image and external watchdog"]
fn routed_append_rolls_back_route_and_port_and_releases_hostname_for_retry() {
    let fixture = Fixture {
        candidate: Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))
            .unwrap(),
        binary: PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap()),
        project: graph::tests::Fixture::new(),
        inputs: graph::tests::Fixture::new(),
        run: graph::probes::token().unwrap(),
        deadline: Instant::now() + Duration::from_secs(150),
    };
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let web_host = format!("web-{}.hack", &fixture.run[..12]);
    let appended_host = format!("added-{}.hack", &fixture.run[..12]);
    let route = |hostname: &str| {
        json!({"image":image,"user":"0:0","init":true,
            "entrypoint":["/bin/sh","-ec","printf ok >/tmp/index.html; exec httpd -f -p 3000 -h /tmp"],"command":[],
            "stop_grace_period":"1s",
            "labels":{"caddy":hostname,"caddy.reverse_proxy":"{{upstreams 3000}}","caddy.tls":"internal"}})
    };
    let web = route(&web_host);
    let mut added = route(&appended_host);
    added["ports"] = json!([format!("127.0.0.1:{}:3000", address.port())]);
    let slow = json!({"image":image,"user":"0:0","entrypoint":["/bin/sleep","120"],
        "command":[],"stop_grace_period":"1s",
        "depends_on":{"added":{"condition":"service_healthy"}}});
    let networks = json!({"default":{"internal":true}});
    let original = json!({"services":{"web":web},"networks":networks});
    let attempt = json!({"services":{"added":added,"slow":slow},"networks":networks});
    fs::write(
        fixture.project.0.join("compose.yaml"),
        json!({"services":{"web":web,"added":added,"slow":slow},"networks":networks}).to_string(),
    )
    .unwrap();
    let mut owner = fixture.start("serve", &fixture.review(&original), &["web=healthy"], None);
    let mut cleanup = Cleanup {
        binary: &fixture.binary,
        candidate: &fixture.candidate,
        run: &fixture.run,
        done: false,
    };
    let before = fixture.receipt();
    let generation = graph::service_exec_generation(&before).unwrap();
    let lookup =
        |hostname| crate::provider::publication::lookup_hostname(&fixture.candidate, hostname);
    let web_claim = lookup(&web_host).unwrap();
    let mut client = fixture.start(
        "extend",
        &fixture.review(&attempt),
        &["added=healthy", "slow=completed"],
        Some(&generation),
    );
    fixture.wait_started_append("slow");
    assert_eq!(lookup(&appended_host).unwrap()["run"], fixture.run);
    assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_ok());
    client.child.kill().unwrap();
    client.wait(fixture.deadline);
    let restored = loop {
        let current = fixture.receipt();
        if current.extending.is_empty() {
            break current;
        }
        assert!(Instant::now() < fixture.deadline, "route rollback deadline");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(!restored.resources.contains_key("container:added"));
    assert_eq!(
        restored.resources["container:web"].id,
        before.resources["container:web"].id
    );
    assert_eq!(lookup(&web_host).unwrap(), web_claim);
    assert!(lookup(&appended_host).is_err());
    assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_err());

    let retry = fixture.review(&json!({"services":{"added":added},"networks":networks}));
    let generation = graph::service_exec_generation(&restored).unwrap();
    let mut client = fixture.start("extend", &retry, &["added=healthy"], Some(&generation));
    assert_eq!(
        result(&mut client, fixture.deadline, true)["started"],
        json!(["added"])
    );
    assert_eq!(lookup(&appended_host).unwrap()["run"], fixture.run);
    assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_ok());
    assert_eq!(lookup(&web_host).unwrap(), web_claim);
    fixture.graph("cleanup");
    assert!(owner.wait(fixture.deadline).success());
    cleanup.done = true;
}

#[test]
#[ignore = "Isolated macOS development VM, fixture image and matching CLI required"]
fn owner_killed_with_pending_append_reconciles_into_a_loadable_receipt() {
    let fixture = Fixture {
        candidate: Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))
            .unwrap(),
        binary: PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap()),
        project: graph::tests::Fixture::new(),
        inputs: graph::tests::Fixture::new(),
        run: graph::probes::token().unwrap(),
        deadline: Instant::now() + Duration::from_secs(120),
    };
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let app = json!({"image":image,"network_mode":"none","user":"0:0",
        "entrypoint":["/bin/sleep","120"],"command":[],"stop_grace_period":"1s"});
    let old = json!({"services":{"web":app}});
    let slow = json!({"services":{"slow":app}});
    fs::write(
        fixture.project.0.join("compose.yaml"),
        json!({"services":{"web":app,"slow":app}}).to_string(),
    )
    .unwrap();
    let mut owner = fixture.start("serve", &fixture.review(&old), &["web=started"], None);
    let before = fixture.receipt();
    let mut client = fixture.start(
        "extend",
        &fixture.review(&slow),
        &["slow=completed"],
        Some(&graph::service_exec_generation(&before).unwrap()),
    );
    fixture.wait_started_append("slow");
    owner.child.kill().unwrap();
    assert!(!owner.wait(fixture.deadline).success());
    assert!(!client.wait(fixture.deadline).success());

    let root = graph::directory(&fixture.candidate, &fixture.run).unwrap();
    let pending = root.join("state.pending");
    use std::os::unix::fs::OpenOptionsExt as _;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .unwrap()
        .write_all(b"{interrupted")
        .unwrap();
    let selection = fixture.graph("foreground-owner");
    let recovered = fixture.cli(
        "down --recover",
        &[
            "graph",
            "recover-live-owner",
            "--run-id",
            &fixture.run,
            "--expect-receipt",
            selection["receipt_sha256"].as_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(recovered["phase"], "stopped-data-retained");
    assert_eq!(
        fixture.graph("inspect")["receipt"]["phase"],
        "stopped-data-retained"
    );
}
