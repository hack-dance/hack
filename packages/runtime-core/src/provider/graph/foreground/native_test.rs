//! Explicit owned CLI integration. Synthetic values stay in private pipes/RAM;
//! dependencies=[] qualifies control-only restore, not host-listener restoration.
use super::super as graph;
use super::*;
use crate::{project, provider::state};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
};
use zeroize::Zeroizing;

const FIRST: &str = "synthetic-owner-restore-first";
const SECOND: &str = "synthetic-owner-restore-second";

struct Process {
    child: Child,
    out: Vec<u8>,
    err: Vec<u8>,
}
fn nonblocking(fd: i32) {
    // SAFETY: descriptors remain owned by the child pipe handles.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
        0
    );
}
fn drain(reader: &mut impl Read, bytes: &mut Vec<u8>) {
    let mut buffer = [0; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => {
                assert!(
                    bytes.len() + count <= 256 * 1024,
                    "bounded child output exceeded"
                );
                bytes.extend_from_slice(&buffer[..count]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => panic!("owned child pipe failed"),
        }
    }
}
impl Process {
    fn start(binary: &Path, candidate: &Candidate, args: &[&str], input: Option<&[u8]>) -> Self {
        let mut command = Command::new(binary);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        let child = command
            .arg("--candidate-root")
            .arg(&candidate.checkout)
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut process = Self {
            child,
            out: Vec::new(),
            err: Vec::new(),
        };
        nonblocking(process.child.stdout.as_ref().unwrap().as_raw_fd());
        nonblocking(process.child.stderr.as_ref().unwrap().as_raw_fd());
        if let Some(input) = input {
            // This fixture's complete envelope fits the minimum empty pipe
            // capacity; it cannot block behind an unbounded upload.
            assert!(input.len() <= 512);
            process
                .child
                .stdin
                .take()
                .unwrap()
                .write_all(input)
                .unwrap();
        }
        process
    }
    fn poll(&mut self) -> Option<ExitStatus> {
        drain(self.child.stdout.as_mut().unwrap(), &mut self.out);
        drain(self.child.stderr.as_mut().unwrap(), &mut self.err);
        for value in [FIRST, SECOND] {
            assert!(
                !self
                    .out
                    .windows(value.len())
                    .any(|part| part == value.as_bytes())
            );
            assert!(
                !self
                    .err
                    .windows(value.len())
                    .any(|part| part == value.as_bytes())
            );
        }
        let status = self.child.try_wait().unwrap();
        if status.is_some() {
            // Child exit can race the preceding nonblocking read.
            drain(self.child.stdout.as_mut().unwrap(), &mut self.out);
            drain(self.child.stderr.as_mut().unwrap(), &mut self.err);
            for value in [FIRST, SECOND] {
                assert!(
                    !self
                        .out
                        .windows(value.len())
                        .any(|part| part == value.as_bytes())
                );
                assert!(
                    !self
                        .err
                        .windows(value.len())
                        .any(|part| part == value.as_bytes())
                );
            }
        }
        status
    }
    fn wait(&mut self, deadline: Instant) -> ExitStatus {
        loop {
            if let Some(status) = self.poll() {
                return status;
            }
            assert!(Instant::now() < deadline, "owned CLI deadline");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
fn cli(
    binary: &Path,
    candidate: &Candidate,
    args: &[&str],
    input: Option<&[u8]>,
    deadline: Instant,
) -> Value {
    let mut process = Process::start(binary, candidate, args, input);
    assert!(process.wait(deadline).success(), "owned CLI refused");
    serde_json::from_slice(&process.out).unwrap()
}
fn private_input(plan: &str, run: &str, token: &str) -> Zeroizing<Vec<u8>> {
    // All inputs here are fixture constants; do not generalize this formatting
    // helper to arbitrary credentials or persist its return value.
    Zeroizing::new(format!("{{\"version\":1,\"plan\":\"{plan}\",\"run\":\"{run}\",\"lifetime_seconds\":120,\"services\":{{\"app\":{{\"TOKEN\":\"{token}\"}}}}}}").into_bytes())
}
struct Cleanup<'a> {
    binary: &'a Path,
    candidate: &'a Candidate,
    run: &'a str,
    done: bool,
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if !self.done {
            // Keep the owner alive until this bounded best-effort request finishes.
            // The external harness owns whole-VM teardown if this cannot complete.
            let mut process = Process::start(
                self.binary,
                self.candidate,
                &[
                    "graph",
                    "cleanup",
                    "--run-id",
                    self.run,
                    "--remove-data",
                    "--json",
                ],
                None,
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if process.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
fn observe(
    candidate: &Candidate,
    run: &str,
    marker: &str,
    deadline: Instant,
) -> (graph::Receipt, Vec<String>) {
    loop {
        {
            let engine = graph::Engine::connect(candidate).unwrap();
            let (receipt, _) = graph::load(candidate, &engine, run).unwrap();
            let resource = &receipt.resources["container:app"];
            let observed = graph::inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .unwrap();
            assert_eq!(observed["State"]["Running"], true);
            assert!(
                !observed["Config"]["Env"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry
                        .as_str()
                        .is_some_and(|entry| entry.starts_with("TOKEN=")))
            );
            let metadata = serde_json::to_vec(&observed).unwrap();
            for value in [FIRST, SECOND] {
                assert!(
                    !metadata
                        .windows(value.len())
                        .any(|part| part == value.as_bytes())
                );
            }
            let (out, err, truncated) = engine.logs(resource.id.as_deref().unwrap()).unwrap();
            assert!(!truncated);
            for value in [FIRST, SECOND] {
                assert!(!out.contains(value));
                assert!(!err.contains(value));
            }
            if out.lines().any(|line| line == marker) {
                let slots =
                    graph::environment::cleanup_slots(candidate, &engine, &receipt).unwrap();
                return (receipt, slots);
            }
        }
        assert!(
            Instant::now() < deadline,
            "application delivery marker absent"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "Owned development VM, pinned image, matching environment-launcher candidate CLI, external watchdog required"]
fn private_owner_restore_preserves_data_and_retires_values() {
    let deadline = Instant::now() + Duration::from_secs(80);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixture = graph::tests::Fixture::new();
    let project = fixture.0.join("project");
    fs::create_dir(&project).unwrap();
    let mut random = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let run: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let first_hash = format!("{:x}", Sha256::digest(FIRST.as_bytes()));
    let second_hash = format!("{:x}", Sha256::digest(SECOND.as_bytes()));
    let script = format!(
        "hash=$$(printf '%s' \"$$TOKEN\" | sha256sum); case \"$$hash\" in {first_hash}*) test ! -e /data/sentinel; printf owned-sentinel > /data/sentinel; printf 'delivery-one\\n';; {second_hash}*) test \"$$(cat /data/sentinel)\" = owned-sentinel; printf 'delivery-two\\n';; *) exit 71;; esac; exec sleep 300"
    );
    state::write(&project.join("compose.yaml"),&json!({"services":{"app":{"image":image,"read_only":true,"network_mode":"none","user":"0:0","entrypoint":["/bin/sh","-ec",script],"command":[],"environment":{"TOKEN":null},"volumes":["data:/data"]}},"volumes":{"data":{}}})).unwrap();
    let review = project::plan(
        &candidate,
        project::PlanOptions {
            project: &project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    let plan = &review.plan_id;
    let selection = fixture.0.join("dependencies.json");
    state::write(&selection,&json!({"version":1,"plan":plan,"artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),"dependencies":[]})).unwrap();
    let selection_text = selection.to_str().unwrap();
    let dependency_plan = cli(
        &binary,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selection_text,
            "--json",
        ],
        None,
        deadline,
    );
    let mut owner = Process::start(
        &binary,
        &candidate,
        &[
            "graph",
            "serve",
            "--project",
            project.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            plan,
            "--run-id",
            &run,
            "--ready",
            "app=started",
            "--dependencies",
            selection_text,
            "--expect-dependencies",
            dependency_plan["dependency_plan_id"].as_str().unwrap(),
            "--environment-stdin",
            "--json",
        ],
        Some(&private_input(plan, &run, FIRST)),
    );
    let mut cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &run,
        done: false,
    };
    loop {
        assert!(
            owner.poll().is_none(),
            "foreground owner exited before readiness"
        );
        if let Some(end) = owner.out.iter().position(|b| *b == b'\n') {
            let ready: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(ready["kind"], "graph_foreground_ready");
            assert_eq!(ready["run"], run);
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let (before, old_slots) = observe(&candidate, &run, "delivery-one", deadline);
    assert_eq!(old_slots.len(), 1);
    let status = cli(
        &binary,
        &candidate,
        &["graph", "owner-status", "--run-id", &run, "--json"],
        None,
        deadline,
    );
    let old_generation = status["generation"].as_str().unwrap();
    let restored = cli(
        &binary,
        &candidate,
        &[
            "graph",
            "owner-restore",
            "--run-id",
            &run,
            "--expect-plan",
            plan,
            "--expect-generation",
            old_generation,
            "--environment-stdin",
            "--json",
        ],
        Some(&private_input(plan, &run, SECOND)),
        deadline,
    );
    assert_eq!(restored["phase"], "ready-observed");
    let (after, all_slots) = observe(&candidate, &run, "delivery-two", deadline);
    assert_ne!(
        before.resources["container:app"].id,
        after.resources["container:app"].id
    );
    assert_eq!(
        before.resources["volume:data"].name,
        after.resources["volume:data"].name
    );
    let fresh = all_slots
        .iter()
        .filter(|slot| !old_slots.contains(slot))
        .collect::<Vec<_>>();
    assert_eq!(fresh.len(), 1);
    {
        let engine = graph::Engine::connect(&candidate).unwrap();
        for slot in &old_slots {
            assert_eq!(
                engine
                    .guest()
                    .execute_cleanup(
                        "set -eu; test ! -e \"/run/$1\"; test ! -L \"/run/$1\"; printf absent",
                        &[slot]
                    )
                    .unwrap(),
                "absent"
            );
        }
        assert_eq!(
            engine
                .guest()
                .execute_cleanup(
                    "set -eu; test -d \"/run/$1\"; test ! -L \"/run/$1\"; printf present",
                    &[fresh[0]]
                )
                .unwrap(),
            "present"
        );
        let volume = graph::inspect_resource(&engine, &after, &after.resources["volume:data"])
            .unwrap()
            .unwrap();
        assert_eq!(engine.guest().execute_cleanup("set -eu; test ! -L \"$1/sentinel\"; test \"$(cat \"$1/sentinel\")\" = owned-sentinel; printf preserved",&[volume["Mountpoint"].as_str().unwrap()]).unwrap(),"preserved");
    }
    let verify_running = || {
        let (observed, slots) = observe(&candidate, &run, "delivery-two", deadline);
        assert_eq!(
            observed.resources["container:app"].id,
            after.resources["container:app"].id
        );
        assert_eq!(
            observed.resources["volume:data"].name,
            after.resources["volume:data"].name
        );
        assert_eq!(slots, all_slots);
    };
    for (selected_plan, generation) in [
        (plan.as_str(), old_generation),
        (
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            restored["generation"].as_str().unwrap(),
        ),
    ] {
        let mut rejected = Process::start(
            &binary,
            &candidate,
            &[
                "graph",
                "owner-restore",
                "--run-id",
                &run,
                "--expect-plan",
                selected_plan,
                "--expect-generation",
                generation,
                "--environment-stdin",
                "--json",
            ],
            Some(&private_input(selected_plan, &run, FIRST)),
        );
        assert_eq!(rejected.wait(deadline).code(), Some(2));
        let failure: Value = serde_json::from_slice(&rejected.err).unwrap();
        assert_eq!(failure["code"], "graph_foreground_restore_failed");
        let current = cli(
            &binary,
            &candidate,
            &["graph", "owner-status", "--run-id", &run, "--json"],
            None,
            deadline,
        );
        assert_eq!(current["generation"], restored["generation"]);
        verify_running();
    }
    let expired = Zeroizing::new(format!("{{\"version\":1,\"plan\":\"{plan}\",\"run\":\"{run}\",\"deadline_nanos\":0,\"services\":{{\"app\":{{\"TOKEN\":\"{FIRST}\"}}}}}}").into_bytes());
    let pin = transport::Pin::load(&candidate, &run).unwrap();
    let mut socket = pin.connect().unwrap();
    transport::write(
        &mut socket,
        &WireRequest {
            version: 1,
            run: run.clone(),
            remove_data: None,
            restore: Some(transport::RestoreRequest {
                plan: plan.clone(),
                generation: restored["generation"].as_str().unwrap().into(),
                environment: transport::PrivateText::from_bytes(&expired).unwrap(),
            }),
        },
        Duration::from_secs(5),
    )
    .unwrap();
    let refused: Value = transport::read(&mut socket, Duration::from_secs(5), 4096).unwrap();
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["code"], "graph_environment_input");
    let current = cli(
        &binary,
        &candidate,
        &["graph", "owner-status", "--run-id", &run, "--json"],
        None,
        deadline,
    );
    assert_eq!(current["generation"], restored["generation"]);
    verify_running();
    let cleaned = cli(
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
        None,
        deadline,
    );
    assert_eq!(cleaned["phase"], "removed");
    assert!(owner.wait(deadline).success());
    cleanup.done = true;
    let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
    let (receipt, _) = graph::load(&candidate, &engine, &run).unwrap();
    for resource in receipt.resources.values() {
        assert!(
            graph::inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .is_none()
        );
    }
    for slot in all_slots {
        assert_eq!(
            engine
                .guest()
                .execute_cleanup(
                    "set -eu; test ! -e \"/run/$1\"; test ! -L \"/run/$1\"; printf absent",
                    &[&slot]
                )
                .unwrap(),
            "absent"
        );
    }
}

mod startup_cancellation;
