//! Owned synthetic bad-cache fixture. A corrupt marker inside a declared
//! disposable cache directory fails a synthetic route check. After a retaining
//! stop, explicit quarantine and a retaining restore, the check passes while a
//! separate persistent marker and every other byte of the cache volume survive.
//! This qualifies the path through `Engine::connect_cleanup`, guest execution,
//! Docker volume inspection and the container list; it does not classify the
//! cause of a real framework cache corruption.
use super::absent_publication_recovery::{ready, refused_cli};
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use base64::Engine as _;

const CACHE: &str = "dev/cache/turbopack";
/// The synthetic route succeeds only without the corrupt cache marker, and
/// prints a sibling build marker from the same volume.
const ROUTE: &str = "test ! -e /cache/dev/cache/turbopack/CURRENT && cat /cache/BUILD_ID";

fn shell(
    binary: &Path,
    candidate: &Candidate,
    run: &str,
    script: &str,
    deadline: Instant,
) -> (u64, Vec<u8>) {
    let mut process = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "exec",
            "--run-id",
            run,
            "--service",
            "web",
            "--timeout-seconds",
            "12",
            "--json",
            "--",
            "/bin/sh",
            "-ec",
            script,
        ],
        None,
    );
    let status = process.wait(deadline);
    let result: Value = serde_json::from_slice(&process.out).expect("admitted exec result");
    let code = result["exit_code"].as_u64().expect("application exit code");
    assert_eq!(status.code().map(i64::from), Some(code as i64));
    assert_eq!(result["truncated"], false);
    let stdout = base64::engine::general_purpose::STANDARD
        .decode(result["stdout_base64"].as_str().unwrap())
        .unwrap();
    (code, stdout)
}

fn target_args<'a>(action: &'a str, run: &'a str, volume: &'a str, path: &'a str) -> Vec<&'a str> {
    vec![
        "graph", action, "--run-id", run, "--volume", volume, "--path", path,
    ]
}

#[test]
#[ignore = "Owned development VM, matching all-feature CLI, pinned static image and external 300s watchdog required"]
fn synthetic_bad_cache_is_quarantined_and_a_retaining_restore_keeps_application_data() {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = graph::tests::Fixture::new();
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({
            "services":{"web":{"image":image,"read_only":true,"network_mode":"none",
                "init":true,"user":"0:0","entrypoint":["/bin/sleep","300"],"command":[],
                "volumes":["data:/data","cache:/cache"],
                "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","complete"],
                    "interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}}},
            "volumes":{"data":{},"cache":{"x-hack-disposable-cache":[CACHE]}}
        }),
    )
    .unwrap();
    let review = project::plan(
        &candidate,
        project::PlanOptions {
            branch: None,
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    // The reviewed project tree must stay unchanged after planning, or `serve`
    // refuses with `stale_plan`. The selection lives in its own private fixture.
    let selection_fixture = graph::tests::Fixture::new();
    let dependencies_path = selection_fixture.0.join("dependencies.json");
    state::write(
        &dependencies_path,
        &json!({"version":1,"plan":review.plan_id,
        "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),
        "dependencies":[]}),
    )
    .unwrap();
    let dependency = checked_cli(
        "dependency-plan",
        &binary,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            dependencies_path.to_str().unwrap(),
            "--json",
        ],
        deadline,
    );
    let run = graph::probes::token().unwrap();
    let normalized = fixture.0.join("compose.yaml");
    let start = |generation: Option<&str>| {
        let mut args = vec![
            "graph",
            if generation.is_some() {
                "serve-restore"
            } else {
                "serve"
            },
            "--project",
            fixture.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan_id,
            "--run-id",
            &run,
            "--ready",
            "web=healthy",
            "--timeout-seconds",
            "90",
            "--dependencies",
            dependencies_path.to_str().unwrap(),
            "--expect-dependencies",
            dependency["dependency_plan_id"].as_str().unwrap(),
            "--normalized-file",
            normalized.to_str().unwrap(),
            "--expect-original",
            &review.plan.compose_sha256,
            "--expect-namespace",
            &review.plan.namespace,
            "--json",
        ];
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        Process::start(&binary, &candidate, &args, None)
    };
    let mut owner = start(None);
    let mut cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &run,
        done: false,
    };
    ready(&mut owner, &run, deadline);
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "write-data", deadline)["exit_code"],
        0
    );
    let (code, _) = shell(
        &binary,
        &candidate,
        &run,
        "mkdir -p /cache/dev/cache/turbopack/sst \
         && printf corrupt-checksum > /cache/dev/cache/turbopack/CURRENT \
         && printf 1234567 > /cache/dev/cache/turbopack/sst/00001.sst \
         && printf keep > /cache/BUILD_ID",
        deadline,
    );
    assert_eq!(code, 0);
    // Container health is green while the synthetic route fails.
    assert_ne!(shell(&binary, &candidate, &run, ROUTE, deadline).0, 0);
    let ready_receipt = snapshot(&candidate, &run, deadline).receipt;
    assert_eq!(
        ready_receipt.resources["volume:cache"].disposable_caches,
        [CACHE]
    );
    let cache_volume = ready_receipt.resources["volume:cache"].name.clone();
    let data_volume = ready_receipt.resources["volume:data"].name.clone();
    let mut inspect = target_args("inspect-cache-quarantine", &run, "cache", CACHE);
    inspect.push("--json");

    let stopped = checked_cli(
        "retaining-cleanup",
        &binary,
        &candidate,
        &["graph", "cleanup", "--run-id", &run, "--json"],
        deadline,
    );
    assert_eq!(stopped["phase"], "stopped-data-retained");
    assert!(owner.wait(deadline).success());
    // Undeclared paths and application-data volumes are never selectable.
    for (volume, path) in [
        ("cache", "dev/cache"),
        ("cache", "BUILD_ID"),
        ("data", CACHE),
    ] {
        let mut args = target_args("inspect-cache-quarantine", &run, volume, path);
        args.push("--json");
        refused_cli(
            &binary,
            &candidate,
            &args,
            "graph_cache_quarantine",
            deadline,
        );
    }
    let selection = checked_cli("inspect-cache", &binary, &candidate, &inspect, deadline);
    assert_eq!(selection["phase"], "selectable");
    assert_eq!(selection["target_bytes"], 16 + 7);
    assert_eq!(selection["entries"], 4);
    assert_eq!(selection["mutation"], false);
    let sha = selection["selection_sha256"].as_str().unwrap();
    let unreviewed = "0".repeat(64);
    let mut wrong = target_args("quarantine-cache", &run, "cache", CACHE);
    wrong.extend(["--expect-selection", &unreviewed, "--json"]);
    refused_cli(
        &binary,
        &candidate,
        &wrong,
        "graph_cache_quarantine",
        deadline,
    );
    let mut quarantine = target_args("quarantine-cache", &run, "cache", CACHE);
    quarantine.extend(["--expect-selection", sha, "--json"]);
    let done = checked_cli(
        "quarantine-cache",
        &binary,
        &candidate,
        &quarantine,
        deadline,
    );
    assert_eq!(done["phase"], "quarantined");
    assert_eq!(done["quarantined_bytes"], 16 + 7);
    assert_eq!(done["reclaimed_bytes"], 0);
    assert_eq!(done["moved_now"], true);
    // HACK-1301: creating `hack-quarantine` changes Docker's `CreatedAt`; the
    // first quarantine still settles and counts its retained bytes.
    assert_eq!(done["resumed"], false);
    assert_eq!(done["retained_quarantine_bytes"], 16 + 7);
    // The reviewed selection cannot be replayed.
    refused_cli(
        &binary,
        &candidate,
        &quarantine,
        "graph_cache_quarantine",
        deadline,
    );
    let absent = checked_cli("inspect-absent", &binary, &candidate, &inspect, deadline);
    assert_eq!(absent["phase"], "target_absent");
    assert_eq!(absent["retained_quarantine_bytes"], 16 + 7);

    let next = checked_cli(
        "restore-selection",
        &binary,
        &candidate,
        &["graph", "restore-selection", "--run-id", &run, "--json"],
        deadline,
    );
    owner = start(Some(next["generation"].as_str().unwrap()));
    ready(&mut owner, &run, deadline);
    // The route recovers; the sibling build marker and data volume survive.
    assert_eq!(
        shell(&binary, &candidate, &run, ROUTE, deadline),
        (0, b"keep".to_vec())
    );
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "read-data", deadline)["exit_code"],
        0
    );
    let restored = snapshot(&candidate, &run, deadline).receipt;
    assert_eq!(restored.resources["volume:cache"].name, cache_volume);
    assert_eq!(restored.resources["volume:data"].name, data_volume);

    let removed = checked_cli(
        "remove-selected-data",
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &run,
            "--remove-data",
            "--json",
        ],
        deadline,
    );
    assert_eq!(removed["phase"], "removed");
    assert!(owner.wait(deadline).success());
    cleanup.done = true;
}
