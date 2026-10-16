//! Real Docker stop behavior in an externally owned development VM. No signal
//! outcome here proves dependency ordering or application-specific data flushing.
use super::super::*;
use std::{io::Read, path::Path, time::Instant};

struct Cleanup<'a> {
    candidate: &'a Candidate,
    run: String,
    done: bool,
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if !self.done {
            let _ = cleanup(self.candidate, &self.run, true);
        }
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

fn options(project: &Path) -> PlanOptions<'_> {
    PlanOptions {
        project,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    }
}

fn volume_path(engine: &Engine<'_>, receipt: &Receipt) -> String {
    let value = inspect_resource(engine, receipt, &receipt.resources["volume:data"])
        .unwrap()
        .unwrap();
    let path = value["Mountpoint"].as_str().unwrap();
    let name = &receipt.resources["volume:data"].name;
    assert_eq!(path, format!("/var/lib/docker/volumes/{name}/_data"));
    path.into()
}

#[test]
#[ignore = "Owned development VM, pinned local image and external 90-second watchdog required"]
fn owned_graph_shutdown_signals_and_escalation() {
    let began = Instant::now();
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = super::super::tests::Fixture::new();
    let mut services = serde_json::Map::new();
    for (name, signal, script) in [
        (
            "term",
            "SIGTERM",
            "trap 'printf term > /data/term-stopped; exit 0' TERM; printf ready > /data/term-ready; while :; do sleep 0.1; done",
        ),
        (
            "custom",
            "SIGUSR1",
            "trap 'printf custom > /data/custom-stopped; exit 0' USR1; printf ready > /data/custom-ready; while :; do sleep 0.1; done",
        ),
        (
            "ignore",
            "SIGTERM",
            "trap '' TERM; printf ready > /data/ignore-ready; while :; do sleep 0.1; done",
        ),
        (
            "completed",
            "SIGTERM",
            "printf completed > /data/completed-ready; exit 0",
        ),
    ] {
        services.insert(
            name.into(),
            json!({
                "image":image,"read_only":true,"network_mode":"none","user":"0:0","init":true,
                "cpus":0.1,"mem_limit":"64m","pids_limit":32,
                "entrypoint":["/bin/sh","-c",script],"command":[],
                "stop_signal":signal,"stop_grace_period":"1s","volumes":["data:/data"]
            }),
        );
    }
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":services,"volumes":{"data":{}}}),
    )
    .unwrap();
    let run_id = token();
    let mut guard = Cleanup {
        candidate: &candidate,
        run: run_id.clone(),
        done: false,
    };
    let report = project::plan(&candidate, options(&fixture.0)).unwrap();
    let readiness = BTreeMap::from([
        ("term".into(), Condition::Started),
        ("custom".into(), Condition::Started),
        ("ignore".into(), Condition::Started),
        ("completed".into(), Condition::Completed),
    ]);
    let receipt = run(
        &candidate,
        RunOptions {
            live_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: options(&fixture.0),
            expected_plan: &report.plan_id,
            source_revision: None,
            non_secret_values: &BTreeMap::new(),
            readiness: &readiness,
            run_id: &run_id,
            timeout: Duration::from_secs(25),
        },
    )
    .unwrap();
    assert_eq!(receipt.phase, "ready-observed");
    {
        let engine = Engine::connect(&candidate).unwrap();
        let data = volume_path(&engine, &receipt);
        // Each marker is written only after its real shell installs the trap.
        // Bounded polling is inside one owned guest command, without another lease.
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test -d \"$1\"; test ! -L \"$1\"; i=0; while [ \"$i\" -lt 50 ]; do if [ -f \"$1/term-ready\" ] && [ -f \"$1/custom-ready\" ] && [ -f \"$1/ignore-ready\" ] && [ -f \"$1/completed-ready\" ]; then test \"$(cat \"$1/term-ready\")\" = ready; test \"$(cat \"$1/custom-ready\")\" = ready; test \"$(cat \"$1/ignore-ready\")\" = ready; test \"$(cat \"$1/completed-ready\")\" = completed; printf ready; exit 0; fi; i=$((i+1)); sleep 0.1; done; exit 1",
            &[&data]).unwrap(), "ready");
        for name in ["term", "custom", "ignore", "completed"] {
            let resource = &receipt.resources[&format!("container:{name}")];
            let observed = inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .unwrap();
            assert_eq!(observed["State"]["Running"], name != "completed");
            assert_eq!(observed["State"]["OOMKilled"], false);
            assert_eq!(observed["Config"]["StopTimeout"], 1);
            assert_eq!(
                observed["Config"]["StopSignal"],
                if name == "custom" {
                    "SIGUSR1"
                } else {
                    "SIGTERM"
                }
            );
        }
    }
    let stopped = cleanup(&candidate, &run_id, false).unwrap();
    assert_eq!(stopped.phase, "stopped-data-retained");
    let evidence: Value = state::read(
        &directory(&candidate, &run_id)
            .unwrap()
            .join("shutdown.json"),
    )
    .unwrap();
    assert_eq!(evidence["run"], run_id);
    assert_eq!(evidence["owner"], receipt.owner);
    assert_eq!(evidence["plan"], receipt.plan_id);
    assert_eq!(evidence["containers"].as_object().unwrap().len(), 4);
    for (name, exit) in [
        ("term", 0),
        ("custom", 0),
        ("ignore", 137),
        ("completed", 0),
    ] {
        let key = format!("container:{name}");
        let terminal = &evidence["containers"][&key];
        assert_eq!(
            terminal["id"].as_str(),
            receipt.resources[&key].id.as_deref()
        );
        assert_eq!(terminal["exit_code"], exit);
        assert_eq!(terminal["oom_killed"], false);
        assert_eq!(terminal["stop_requested"], name != "completed");
    }
    {
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        for resource in receipt
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            assert!(
                inspect_resource(&engine, &receipt, resource)
                    .unwrap()
                    .is_none()
            );
        }
        let data = volume_path(&engine, &stopped);
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test -d \"$1\"; test ! -L \"$1\"; test ! -L \"$1/term-stopped\"; test ! -L \"$1/custom-stopped\"; test \"$(cat \"$1/term-stopped\")\" = term; test \"$(cat \"$1/custom-stopped\")\" = custom; test \"$(cat \"$1/ignore-ready\")\" = ready; printf retained",
            &[&data]).unwrap(), "retained");
    }
    let removed = cleanup(&candidate, &run_id, true).unwrap();
    assert_eq!(removed.phase, "removed");
    {
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        assert!(
            inspect_resource(&engine, &removed, &removed.resources["volume:data"])
                .unwrap()
                .is_none()
        );
    }
    guard.done = true;
    assert!(began.elapsed() < Duration::from_secs(80));
}
