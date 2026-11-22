#![cfg(feature = "installed-candidate")]

use hack_runtime_core::Candidate;
use serde_json::Value;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-installed-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn directory(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn invoke(binary: &Path, home: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(binary)
        .arg("--candidate-root")
        .arg(home)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/nonexistent")
        .env("HOME", cwd)
        .env("HACK_HOME", "/must-not-be-used")
        .env("DOCKER_HOST", "unix:///must-not-be-contacted")
        .output()
        .unwrap()
}

#[test]
fn copied_installed_binary_uses_only_explicit_home_and_preserves_reexec_identity() {
    let fixture = Fixture::new();
    let bundle = fixture.directory("copied-bundle");
    let home = fixture.directory("stable-home");
    let cwd = fixture.directory("unrelated-cwd");
    let binary = bundle.join("hack-native");
    fs::copy(env!("CARGO_BIN_EXE_hack-native"), &binary).unwrap();
    let output = invoke(&binary, &home, &cwd, &["info", "--json"]);
    assert!(output.status.success(), "{output:?}");
    let identity: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(identity["channel"], "installed-candidate");
    assert_eq!(identity["checkout"], home.to_str().unwrap());
    assert_eq!(
        identity["state_root"],
        home.join(".hack-local").to_str().unwrap()
    );
    let executable = Path::new(identity["executable"].as_str().unwrap());
    assert_eq!(executable, binary);
    // The same executable/root pair passed by supervisors works after relocation.
    let version = invoke(
        executable,
        Path::new(identity["checkout"].as_str().unwrap()),
        &cwd,
        &["--version"],
    );
    assert!(version.status.success(), "{version:?}");
    assert!(
        String::from_utf8(version.stdout)
            .unwrap()
            .starts_with("hack-native ")
    );
    let plan = invoke(
        &binary,
        &home,
        &cwd,
        &["plan", "--project", cwd.to_str().unwrap(), "--json"],
    );
    assert!(plan.status.success(), "{plan:?}");
    assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&cwd).unwrap().count(), 0);
}

#[test]
fn quiescent_https_recovery_requires_exact_selectors_without_initializing_state() {
    let fixture = Fixture::new();
    let home = fixture.directory("private");
    let cwd = fixture.directory("cwd");
    for (owner, pid) in [
        ("wrong", "999999"),
        (
            "0000000000000000000000000000000000000000000000000000000000000000",
            "1",
        ),
    ] {
        let output = invoke(
            Path::new(env!("CARGO_BIN_EXE_hack-native")),
            &home,
            &cwd,
            &[
                "runtime",
                "recover-quiescent-https",
                "--expect-owner",
                owner,
                "--expect-configuration",
                "1111111111111111111111111111111111111111111111111111111111111111",
                "--expect-frontend-pid",
                pid,
                "--json",
            ],
        );
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("https_recovery_refused")
        );
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
}

#[test]
fn installed_entrypoint_refuses_public_missing_relative_and_aliased_homes() {
    let fixture = Fixture::new();
    let home = fixture.directory("private");
    let alias = fixture.0.join("alias");
    symlink(&home, &alias).unwrap();
    let child = home.join("nested");
    fs::DirBuilder::new().mode(0o700).create(&child).unwrap();
    let public = fixture.directory("public");
    fs::set_permissions(&public, fs::Permissions::from_mode(0o755)).unwrap();
    let paths: [&Path; 5] = [
        &public,
        &alias,
        &alias.join("nested"),
        &fixture.0.join("absent"),
        Path::new("private"),
    ];
    for path in paths {
        let output = invoke(
            Path::new(env!("CARGO_BIN_EXE_hack-native")),
            path,
            &fixture.0,
            &["--version"],
        );
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(output.stdout.is_empty());
    }
    symlink(&public, home.join(".hack-local")).unwrap();
    assert_eq!(
        Candidate::discover_installed(&home).unwrap_err().code,
        "aliased_state"
    );
}

#[test]
fn installed_home_still_refuses_overlapping_source() {
    let fixture = Fixture::new();
    let home = fixture.directory("home");
    let candidate = Candidate::discover_installed(&home).unwrap();
    assert_eq!(
        candidate.plan(&home).unwrap_err().code,
        "overlapping_workspace"
    );
    assert_eq!(
        candidate.plan(&fixture.0).unwrap_err().code,
        "overlapping_workspace"
    );
}

#[test]
fn project_plan_reports_shared_start_refusals_without_runtime_effects() {
    use serde_json::json;
    let fixture = Fixture::new();
    let project = fixture.directory("project");
    let candidate = fixture.directory("candidate");
    let home = fixture.directory("fake-home");
    let config = fixture.directory("config");
    let state = fixture.directory("state");
    let cache = fixture.directory("cache");
    let data = fixture.directory("data");
    let empty_path = fixture.directory("empty-path");
    let image = format!("sha256:{}", "a".repeat(64));
    let base = json!({"image": image});
    let mut udp = base.clone();
    udp["ports"] = json!(["8787:3000/udp"]);
    let mut disabled_health = base.clone();
    disabled_health["healthcheck"] = json!({"disable":true});
    let mut limited = base.clone();
    limited["deploy"] = json!({"resources":{"limits":{"cpus":"2"}}});
    let cases = [
        (
            json!({"services":{"web":udp}}),
            Some("graph_port_publication"),
        ),
        (
            json!({"services":{"web":{"image":image,"ports":[{"target":3000,"published":8787,"protocol":"udp"}]}}}),
            Some("graph_port_publication"),
        ),
        (
            json!({"services":{"web":base,"worker":{"image":image,"profiles":["worker"],"ports":["8787:3000/udp"]}}}),
            None,
        ),
        (
            json!({"services":{"job":disabled_health}}),
            Some("graph_readiness"),
        ),
        (
            json!({"services":{"a":limited,"b":limited,"c":limited}}),
            Some("graph_budget"),
        ),
    ];
    for (document, expected) in cases {
        std::fs::write(
            project.join("compose.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_hack-native"))
            .arg("--candidate-root")
            .arg(&candidate)
            .args(["project", "plan", "--project"])
            .arg(&project)
            .args(["--file", "compose.json", "--json"])
            .env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", &config)
            .env("XDG_STATE_HOME", &state)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .env("HACK_NO_INTERACTIVE", "1")
            .env("PATH", &empty_path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        let refusals = report["start_refusals"].as_array().unwrap();
        if let Some(code) = expected {
            assert!(
                refusals.iter().any(|r| r["code"] == code),
                "missing {code}: {report}"
            );
            let refusal = refusals.iter().find(|r| r["code"] == code).unwrap();
            assert_eq!(refusal["message_fixed"], true);
            if code == "graph_port_publication" {
                assert_eq!(refusal["service"], "web");
                assert_eq!(
                    refusal["message"],
                    "Native publishes only TCP ports; keep UDP publication on the Compose backend."
                );
            }
        } else {
            assert!(refusals.is_empty(), "{refusals:?}");
        }
        assert_eq!(std::fs::read_dir(&candidate).unwrap().count(), 0);
    }
}

#[test]
fn preflight_readiness_and_cli_plan_fields_match_shared_fixtures() {
    use hack_runtime_core::{
        Candidate,
        project::{self, PlanOptions},
    };
    let fixture = Fixture::new();
    let project = fixture.directory("project");
    let candidate_root = fixture.directory("candidate");
    let candidate = Candidate::discover(&candidate_root).unwrap();
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-start-readiness.json"
    ))
    .unwrap();
    let image = format!("sha256:{}", "a".repeat(64));
    for case in cases {
        let mut compose = case["compose"].clone();
        for service in compose["services"].as_object_mut().unwrap().values_mut() {
            service["image"] = image.clone().into();
        }
        std::fs::write(
            project.join("compose.json"),
            serde_json::to_vec(&compose).unwrap(),
        )
        .unwrap();
        let profiles: Vec<String> = serde_json::from_value(
            case["profiles"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
        )
        .unwrap();
        let report = project::plan(
            &candidate,
            PlanOptions {
                branch: None,
                project: &project,
                compose_file: Path::new("compose.json"),
                profiles: &profiles,
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&report.start_readiness).unwrap(),
            case["goals"],
            "{}",
            case["name"]
        );
        // Snapshot exactly the reviewed fields the CLI's readiness/cache/route
        // helpers consume. The Bun suite feeds this same snapshot to those
        // helpers, so neither job needs the other language's toolchain.
        let snapshot: serde_json::Map<String, Value> = report.plan.services.iter().map(|(name, service)| {
            (name.clone(), serde_json::json!({
                "active": service.active,
                "one_shot": service.one_shot,
                "dependency_cache": service.dependency_cache.as_ref().map(|_| serde_json::json!({})),
                "routing": service.routing.as_ref().map(|route| serde_json::json!({"port": route.port})),
                "healthcheck": service.healthcheck.as_ref().map(|health| serde_json::json!({
                    "disabled": health.disabled,
                    "native_http": health.native_http.as_ref().map(|probe| serde_json::json!({"port": probe.port})),
                })),
            }))
        }).collect();
        assert_eq!(
            Value::Object(snapshot),
            case["reviewed_services"],
            "{}",
            case["name"]
        );
        assert_eq!(std::fs::read_dir(&candidate_root).unwrap().count(), 0);
    }
}

#[test]
fn plan_delivery_context_is_names_only_action_scoped_and_outside_identity() {
    let fixture = Fixture::new();
    let project = fixture.directory("project");
    let candidate = fixture.directory("candidate");
    let binary = Path::new(env!("CARGO_BIN_EXE_hack-native"));
    fs::write(project.join("compose.json"), serde_json::to_vec(&serde_json::json!({"services": {
        "app": {"image": format!("sha256:{}", "a".repeat(64)), "restart": "always", "environment": {"TOKEN": null}},
        "worker": {"image": format!("sha256:{}", "a".repeat(64)), "profiles": ["worker"], "restart": "always"}
    }})).unwrap()).unwrap();
    let base = [
        "project",
        "plan",
        "--project",
        project.to_str().unwrap(),
        "--file",
        "compose.json",
        "--json",
    ];
    let plain = invoke(binary, &candidate, &project, &base);
    assert!(plain.status.success());
    let plain: Value = serde_json::from_slice(&plain.stdout).unwrap();
    assert_eq!(plain["start_refusals"], serde_json::json!([]));
    let mut flags = base.to_vec();
    flags.extend([
        "--start-managed-service",
        "app",
        "--start-managed-service",
        "worker",
    ]);
    let reviewed = invoke(binary, &candidate, &project, &flags);
    assert!(
        reviewed.status.success(),
        "{}",
        String::from_utf8_lossy(&reviewed.stderr)
    );
    let reviewed: Value = serde_json::from_slice(&reviewed.stdout).unwrap();
    assert_eq!(reviewed["plan_id"], plain["plan_id"]);
    assert_eq!(reviewed["plan"], plain["plan"]);
    // HACK-2324: managed delivery now starts without the engine restart policy,
    // so the action-scoped context produces no start refusal for `app`.
    assert_eq!(reviewed["start_refusals"], serde_json::json!([]));
    flags.extend(["--start-managed-service", "not-a-service"]);
    let unknown = invoke(binary, &candidate, &project, &flags);
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("invalid_start_review_context"));
    flags[1] = "capture";
    let capture = invoke(binary, &candidate, &project, &flags);
    assert!(!capture.status.success());
    assert!(String::from_utf8_lossy(&capture.stderr).contains("invalid_arguments"));
    assert_eq!(fs::read_dir(&candidate).unwrap().count(), 0);
}

#[test]
fn delivery_context_admits_the_full_compose_budget_and_oversized_files_refuse_before_context() {
    let fixture = Fixture::new();
    let project = fixture.directory("project");
    let candidate = fixture.directory("candidate");
    let image = format!("sha256:{}", "a".repeat(64));
    for count in [hack_runtime_core::project::MAX_COMPOSE_SERVICES, 130] {
        let services: serde_json::Map<String, Value> = (0..count)
        .map(|index| {
            (
                format!("service-{index}"),
                serde_json::json!({
                    "image": image, "profiles": if index == 0 { vec![] } else { vec!["optional"] },
                    "environment": {"TOKEN": null}
                }),
            )
        })
        .collect();
        fs::write(
            project.join("compose.json"),
            serde_json::to_vec(&serde_json::json!({"services": services})).unwrap(),
        )
        .unwrap();
        let mut args = vec![
            "project",
            "plan",
            "--project",
            project.to_str().unwrap(),
            "--file",
            "compose.json",
            "--json",
        ];
        // The CLI's first review has no delivery context. An over-budget project
        // stops there before the normalized review and cannot hit the context cap.
        if count == hack_runtime_core::project::MAX_COMPOSE_SERVICES {
            for name in services.keys() {
                args.extend(["--start-managed-service", name.as_str()]);
            }
        }
        let output = invoke(
            Path::new(env!("CARGO_BIN_EXE_hack-native")),
            &candidate,
            &project,
            &args,
        );
        if count == hack_runtime_core::project::MAX_COMPOSE_SERVICES {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["start_refusals"], serde_json::json!([]));
            assert_eq!(report["plan"]["services"].as_object().unwrap().len(), count);
        } else {
            assert!(!output.status.success());
            let error: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert_eq!(error["code"], "service_budget");
        }
        assert_eq!(fs::read_dir(&candidate).unwrap().count(), 0);
    }
}

fn startup_request(id: u32, cwd: &Path, intent: &Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": id, "cwd": cwd, "environment": {}, "step_store": null,
        "timeout_ms": 5000, "intent": intent,
    }))
    .unwrap()
}

fn read_startup_frame(input: &mut impl std::io::Read) -> Vec<u8> {
    let mut length = [0; 4];
    input.read_exact(&mut length).unwrap();
    let mut reply = vec![0; u32::from_be_bytes(length) as usize];
    input.read_exact(&mut reply).unwrap();
    reply
}

#[test]
fn startup_preflight_matches_one_shot_bytes_and_launches_once() {
    use serde_json::json;
    use std::io::{Read, Write};
    use std::process::Stdio;

    let fixture = Fixture::new();
    let home = fixture.directory("native");
    let cwd = fixture.directory("example");
    let wrapper = fixture.0.join("count-runtime");
    let count = fixture.0.join("launches");
    fs::write(
        &wrapper,
        "#!/bin/sh\nprintf x >> \"$1\"\nshift\nexec \"$@\"\n",
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let command = || {
        let mut command = Command::new(&wrapper);
        command
            .arg(&count)
            .arg(env!("CARGO_BIN_EXE_hack-native"))
            .arg("--candidate-root")
            .arg(&home)
            .current_dir(&cwd)
            .env_clear();
        command
    };
    fs::write(
        cwd.join("compose.yml"),
        "services:\n  web:\n    image: alpine:3.21\n",
    )
    .unwrap();
    let project = cwd.to_str().unwrap();
    let run = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let oversized_image = "a".repeat(131_040);
    let cases = [
        (
            vec![
                "project",
                "plan",
                "--project",
                project,
                "--file",
                "compose.yml",
                "--json",
            ],
            json!({"operation":"plan","options":["--project",project,"--file","compose.yml","--json"]}),
        ),
        (
            vec![
                "project",
                "plan",
                "--project",
                project,
                "--file",
                "absent.yml",
                "--json",
            ],
            json!({"operation":"plan","options":["--project",project,"--file","absent.yml","--json"]}),
        ),
        (
            vec![
                "runtime",
                "check-project-share",
                "--project-share",
                project,
                "--unfiltered-source",
                "--json",
            ],
            json!({"operation":"check_project_share","project":project}),
        ),
        (
            vec![
                "runtime",
                "check-project-share",
                "--project-share",
                "",
                "--unfiltered-source",
                "--json",
            ],
            json!({"operation":"check_project_share","project":""}),
        ),
        (
            vec!["project", "source-size", "--project", project, "--json"],
            json!({"operation":"source_size","project":project}),
        ),
        (
            vec![
                "project",
                "source-size",
                "--project",
                "/nonexistent",
                "--json",
            ],
            json!({"operation":"source_size","project":"/nonexistent"}),
        ),
        (
            vec![
                "runtime",
                "admit-image",
                "--reference",
                "alpine:3.21",
                "--json",
            ],
            json!({"operation":"admit_image","reference":"alpine:3.21","policy":[]}),
        ),
        (
            vec![
                "runtime",
                "admit-image",
                "--reference",
                "invalid image",
                "--json",
            ],
            json!({"operation":"admit_image","reference":"invalid image","policy":[]}),
        ),
        (
            vec![
                "runtime",
                "admit-image",
                "--reference",
                &oversized_image,
                "--json",
            ],
            json!({"operation":"admit_image","reference":oversized_image,"policy":[]}),
        ),
        (
            vec!["graph", "retained-preflight", "--run-id", run, "--json"],
            json!({"operation":"retained_preflight","run":run}),
        ),
        (
            vec!["graph", "inspect", "--run-id", run, "--json"],
            json!({"operation":"inspect","run":run}),
        ),
    ];
    let expected: Vec<_> = cases
        .iter()
        .map(|(args, _)| command().args(args).output().unwrap())
        .collect();
    assert_eq!(fs::metadata(&count).unwrap().len(), cases.len() as u64);
    fs::write(&count, b"").unwrap();

    let mut stream = command()
        .args(["up", "preflight", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = stream.stdin.take().unwrap();
    let mut output = stream.stdout.take().unwrap();
    assert_eq!(read_startup_frame(&mut output), br#"{"version":1}"#);
    for (index, ((_, intent), old)) in cases.iter().zip(expected).enumerate() {
        let id = u32::try_from(index + 1).unwrap();
        let request = startup_request(id, &cwd, intent);
        input
            .write_all(&u32::try_from(request.len()).unwrap().to_be_bytes())
            .unwrap();
        input.write_all(&request).unwrap();
        let reply = read_startup_frame(&mut output);
        let mut same = if old.status.success() {
            let mut same = format!(r#"{{"id":{id},"value":"#).into_bytes();
            same.extend(old.stdout);
            same
        } else {
            assert_eq!(old.status.code(), Some(2));
            let mut same = format!(r#"{{"id":{id},"error":"#).into_bytes();
            same.extend(old.stderr.strip_suffix(b"\n").unwrap());
            same
        };
        same.push(b'}');
        assert_eq!(reply, same, "operation {}", intent["operation"]);
    }
    let next = u32::try_from(cases.len() + 1).unwrap();
    let absent = startup_request(next, &cwd.join("missing"), &cases[0].1);
    input
        .write_all(&u32::try_from(absent.len()).unwrap().to_be_bytes())
        .unwrap();
    input.write_all(&absent).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&read_startup_frame(&mut output)).unwrap(),
        json!({"id":next,"standalone":true})
    );
    let duplicate = startup_request(next, &cwd, &cases[0].1);
    input
        .write_all(&u32::try_from(duplicate.len()).unwrap().to_be_bytes())
        .unwrap();
    input.write_all(&duplicate).unwrap();
    assert_eq!(output.read(&mut [0]).unwrap(), 0);
    drop(input);
    assert_eq!(stream.wait().unwrap().code(), Some(2));
    assert_eq!(fs::read(&count).unwrap(), b"x");
}

#[test]
fn startup_preflight_frontend_death_retires_the_runtime() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    const CHECKOUT: &str = "PREFLIGHT_TEST_FRONTEND";
    if let Some(home) = std::env::var_os(CHECKOUT) {
        let mut runtime = Command::new(env!("CARGO_BIN_EXE_hack-native"))
            .arg("--candidate-root")
            .arg(&home)
            .args(["up", "preflight", "--json"])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = runtime.stdin.take().unwrap();
        let mut output = runtime.stdout.take().unwrap();
        assert_eq!(read_startup_frame(&mut output), br#"{"version":1}"#);
        let request = startup_request(
            1,
            Path::new(&home),
            &serde_json::json!({"operation":"admit_image","reference":"alpine:3.21","policy":[]}),
        );
        input
            .write_all(&u32::try_from(request.len()).unwrap().to_be_bytes())
            .unwrap();
        input.write_all(&request).unwrap();
        let reply = read_startup_frame(&mut output);
        assert!(serde_json::from_slice::<Value>(&reply).unwrap()["value"].is_object());
        input.write_all(&[0]).unwrap();
        println!("runtime={}", runtime.id());
        std::io::stdout().flush().unwrap();
        let status = runtime.wait().unwrap();
        panic!("runtime exited before frontend death: {status}");
    }

    let fixture = Fixture::new();
    let home = fixture.directory("native");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "startup_preflight_frontend_death_retires_the_runtime",
            "--nocapture",
        ])
        .env(CHECKOUT, &home)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut frontend = output;
    let mut stdout = frontend.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(&mut stdout).lines() {
            if let Some(pid) = line.unwrap().strip_prefix("runtime=") {
                send.send(pid.parse::<i32>().unwrap()).unwrap();
                break;
            }
        }
    });
    let pid = receive.recv_timeout(Duration::from_secs(15));
    frontend.kill().unwrap();
    frontend.wait().unwrap();
    reader.join().unwrap();
    let pid = pid.unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    while Instant::now() < limit {
        // SAFETY: signal zero only observes existence. Linux containers may
        // retain zombies, so use the proc state there when the PID still exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        #[cfg(target_os = "linux")]
        if fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(") ")
                    .map(|(_, fields)| fields.starts_with('Z'))
            })
            == Some(true)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("runtime preflight process survived frontend death");
}
