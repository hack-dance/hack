//! Real incremental callers use framed stdin, private fixtures and no daemon.
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TOKEN: &str = "synthetic-incremental-owner";
static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    owners: Vec<Child>,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "incremental-{}-{nonce}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        let root = base.join("private-instance-with-a-deliberately-long-directory-name-so-unix-socket-addresses-exceed-the-darwin-limit-without-relative-addressing");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self {
            base,
            root,
            owners: Vec::new(),
        }
    }
    fn command(&self, operation: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hack-lifecycle-supervisor"));
        command
            .arg(operation)
            .env_clear()
            .env("HOME", &self.base)
            .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }
    fn process(&self, name: &str, mode: &str) -> Value {
        json!({"name":name,"argv":[std::env::current_exe().unwrap(),"--exact","incremental_fixture","--nocapture"],"cwd":self.root,"env":{"HOME":self.base,"HACK_DAEMON_AUTOSTART_DISABLE":"1","INCREMENTAL_MODE":mode,"INCREMENTAL_VALUE":"synthetic-stdin-only-value"}})
    }
    fn launch(&self, process: Value) -> Value {
        json!({"version":1,"root":self.root,"ownerToken":TOKEN,"processes":[process]})
    }
    fn call(&self, operation: &str, request: &Value) -> (Child, Value) {
        let mut child = self.command(operation).spawn().unwrap();
        send(child.stdin.as_mut().unwrap(), request);
        // Keep stdin open: neither side may wait on descriptor closure.
        let receipt = receive(child.stdout.as_mut().unwrap());
        (child, receipt)
    }
    fn serve(&mut self, process: Value) -> Value {
        let (child, receipt) = self.call("serve", &self.launch(process));
        self.owners.push(child);
        assert_eq!(receipt["outcome"], "ready");
        receipt
    }
    fn add(&self, process: Value) -> Value {
        let (mut child, receipt) = self.call("add", &self.launch(process));
        assert!(wait(&mut child).success());
        assert_eq!(receipt["outcome"], "ready");
        receipt
    }
    fn control(&self, operation: &str) -> Value {
        let (mut child, receipt) = self.call(
            operation,
            &json!({"version":1,"root":self.root,"ownerToken":TOKEN}),
        );
        assert!(wait(&mut child).success());
        receipt
    }
    fn state(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.root.join(format!("{name}.json"))).unwrap()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(mut child) = self.command("stop").spawn() {
            if let Some(mut input) = child.stdin.take() {
                send(
                    &mut input,
                    &json!({"version":1,"root":self.root,"ownerToken":TOKEN}),
                );
            }
            let _ = wait(&mut child);
        }
        for child in &mut self.owners {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn send(output: &mut impl Write, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    output.write_all(&bytes).unwrap();
    output.flush().unwrap();
}
fn exact(input: &mut (impl Read + AsRawFd), bytes: &mut [u8]) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut offset = 0;
    while offset < bytes.len() {
        assert!(
            Instant::now() < deadline,
            "framed response deadline expired"
        );
        let mut fd = libc::pollfd {
            fd: input.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one live initialized poll record.
        assert!(unsafe { libc::poll(&mut fd, 1, 1000) } >= 0);
        if fd.revents == 0 {
            continue;
        }
        let count = input.read(&mut bytes[offset..]).unwrap();
        assert!(count > 0, "incomplete frame");
        offset += count;
    }
}
fn receive(input: &mut (impl Read + AsRawFd)) -> Value {
    let mut header = [0; 4];
    exact(input, &mut header);
    let length = u32::from_be_bytes(header) as usize;
    assert!(length <= 1024 * 1024);
    let mut bytes = vec![0; length];
    exact(input, &mut bytes);
    serde_json::from_slice(&bytes).unwrap()
}
fn wait(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned child did not settle");
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn eventually(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn incremental_fixture() {
    let Ok(mode) = std::env::var("INCREMENTAL_MODE") else {
        return;
    };
    assert_eq!(
        std::env::var("INCREMENTAL_VALUE").unwrap(),
        "synthetic-stdin-only-value"
    );
    if mode == "fd" {
        // The command only inherits its three intended standard descriptors.
        for fd in 3..256 {
            // SAFETY: observation only; the command fixture owns no other fd.
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_GETFD) },
                -1,
                "unexpected inherited descriptor {fd}"
            );
        }
    }
    println!("incremental-ready-{mode}");
    if mode == "short" {
        return;
    }
    loop {
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn long_root_and_incremental_hook_order_keep_one_owner() {
    let mut fixture = Fixture::new();
    assert!(fixture.root.as_os_str().len() > 104);
    let first = fixture.serve(fixture.process("before-one", "hold"));
    let second = fixture.add(fixture.process("before-two", "fd"));
    let third = fixture.add(fixture.process("service", "hold"));
    assert_eq!(first["supervisorPid"], second["supervisorPid"]);
    assert_eq!(first["supervisorPid"], third["supervisorPid"]);
    let status = fixture.control("status");
    assert_eq!(status["liveProcessNames"].as_array().unwrap().len(), 3);
    assert_eq!(status["unknownProcessNames"], json!([]));
    assert_eq!(
        fs::metadata(fixture.root.join("control.sock"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    fixture.control("stop");
    for owner in &mut fixture.owners {
        assert!(wait(owner).success());
    }
    assert!(!fixture.root.join("control.sock").exists());
}

#[test]
fn wrong_token_and_duplicate_add_refuse_without_harming_owner() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    for mut request in [
        fixture.launch(fixture.process("helper", "hold")),
        fixture.launch(fixture.process("HELPER", "hold")),
        fixture.launch(fixture.process("other", "hold")),
    ] {
        if request["processes"][0]["name"] == "other" {
            request["ownerToken"] = json!("wrong-owner");
        }
        let (mut child, response) = fixture.call("add", &request);
        assert_eq!(response["outcome"], "refused");
        assert!(!wait(&mut child).success());
    }
    assert_eq!(
        fixture.control("status")["liveProcessNames"],
        json!(["helper"])
    );
}

#[test]
fn owner_death_keeps_native_status_and_recovery_stop() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    fixture.owners[0].kill().unwrap();
    fixture.owners[0].wait().unwrap();
    let (mut duplicate, response) =
        fixture.call("serve", &fixture.launch(fixture.process("helper", "hold")));
    assert_eq!(response["outcome"], "refused");
    assert!(!wait(&mut duplicate).success());
    assert_eq!(
        fixture.control("status")["liveProcessNames"],
        json!(["helper"])
    );
    fixture.control("stop");
    let state = fixture.state("helper");
    assert!(matches!(
        state["phase"].as_str(),
        Some("exited") | Some("killed")
    ));
}

#[test]
fn completed_stop_cannot_be_followed_by_add_to_old_owner() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    fixture.control("stop");
    let (mut add, receipt) = fixture.call("add", &fixture.launch(fixture.process("later", "hold")));
    assert_eq!(receipt["outcome"], "refused");
    assert!(!wait(&mut add).success());
    assert!(!fixture.root.join("later.json").exists());
}

#[test]
fn external_private_log_is_shared_and_add_cannot_redirect_it() {
    let mut fixture = Fixture::new();
    let logs = fixture.base.join("logs");
    fs::DirBuilder::new().mode(0o700).create(&logs).unwrap();
    let log = logs.join("project.log");
    let mut request = fixture.launch(fixture.process("helper", "hold"));
    request["logPath"] = json!(log);
    let (owner, reply) = fixture.call("serve", &request);
    assert_eq!(reply["outcome"], "ready");
    fixture.owners.push(owner);
    let mut add = fixture.launch(fixture.process("service", "hold"));
    add["logPath"] = json!(log);
    let (mut caller, reply) = fixture.call("add", &add);
    assert_eq!(reply["outcome"], "ready");
    assert!(wait(&mut caller).success());
    eventually(|| {
        fs::read_to_string(&log).is_ok_and(|value| {
            value.contains("helper\tstdout") && value.contains("service\tstdout")
        })
    });
    assert_eq!(fs::metadata(&log).unwrap().mode() & 0o777, 0o600);
    assert!(!fixture.root.join("lifecycle.log").exists());
    add["processes"][0]["name"] = json!("redirect");
    add["logPath"] = json!(logs.join("other.log"));
    let (mut caller, reply) = fixture.call("add", &add);
    assert_eq!(reply["outcome"], "refused");
    assert!(!wait(&mut caller).success());
    assert!(!logs.join("other.log").exists());
}

#[test]
fn short_hook_owner_retires_then_later_hook_can_serve_again() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("first", "short"));
    assert!(wait(&mut fixture.owners[0]).success());
    fixture.serve(fixture.process("later", "hold"));
    assert_eq!(
        fixture.control("status")["liveProcessNames"],
        json!(["later"])
    );
}

#[test]
fn framing_refusal_is_finite_without_stdin_eof() {
    let fixture = Fixture::new();
    let request = json!({"version":42,"root":fixture.root,"ownerToken":TOKEN,"processes":[]});
    let (mut child, receipt) = fixture.call("serve", &request);
    assert_eq!(receipt["outcome"], "refused");
    assert_eq!(receipt["processes"], json!([]));
    assert!(!wait(&mut child).success());
}

#[test]
fn concurrent_add_and_stop_leave_no_later_command_running() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    let mut add = fixture.command("add").spawn().unwrap();
    send(
        add.stdin.as_mut().unwrap(),
        &fixture.launch(fixture.process("later", "hold")),
    );
    let mut stop = fixture.command("stop").spawn().unwrap();
    send(
        stop.stdin.as_mut().unwrap(),
        &json!({"version":1,"root":fixture.root,"ownerToken":TOKEN}),
    );
    let add_reply = receive(add.stdout.as_mut().unwrap());
    let stop_reply = receive(stop.stdout.as_mut().unwrap());
    let add_status = wait(&mut add);
    assert_eq!(add_status.success(), add_reply["outcome"] == "ready");
    assert_eq!(stop_reply["outcome"], "stopped");
    assert!(wait(&mut stop).success());
    for owner in &mut fixture.owners {
        assert!(wait(owner).success());
    }
    assert_eq!(fixture.control("status")["liveProcessNames"], json!([]));
}

#[test]
#[cfg(target_os = "linux")]
fn incremental_environment_is_absent_from_argv_and_persisted_files() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("first", "hold"));
    let receipt = fixture.add(fixture.process("second", "hold"));
    let sentinel = b"synthetic-stdin-only-value";
    for state in receipt["processes"].as_array().unwrap() {
        for key in ["guardPid", "commandPid"] {
            let args = fs::read(format!("/proc/{}/cmdline", state[key].as_i64().unwrap())).unwrap();
            assert!(!args.windows(sentinel.len()).any(|v| v == sentinel));
        }
    }
    for entry in fs::read_dir(&fixture.root).unwrap() {
        let entry = entry.unwrap();
        let metadata = entry.metadata().unwrap();
        assert_eq!(metadata.mode() & 0o077, 0);
        if metadata.is_file() {
            let bytes = fs::read(entry.path()).unwrap();
            assert!(!bytes.windows(sentinel.len()).any(|v| v == sentinel));
        }
    }
}

#[test]
#[cfg(target_os = "linux")]
fn status_names_unknown_when_guard_lost_with_live_command() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    let state = fixture.state("helper");
    let guard = state["guardPid"].as_i64().unwrap() as i32;
    let command = state["commandPid"].as_i64().unwrap() as i32;
    let original = fs::read_to_string(format!("/proc/{command}/stat")).unwrap();
    let birth = original
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .to_owned();
    // SAFETY: the guard identity was returned by this fixture's own launch.
    unsafe {
        libc::kill(guard, libc::SIGKILL);
    }
    eventually(|| fs::read_to_string(format!("/proc/{guard}/stat")).is_err());
    let status = fixture.control("status");
    assert_eq!(status["liveProcessNames"], json!([]));
    assert_eq!(status["unknownProcessNames"], json!(["helper"]));
    // The test deliberately removed the recovery guard. Stop this synthetic
    // direct command only after rechecking its captured native birth.
    let now = fs::read_to_string(format!("/proc/{command}/stat")).unwrap();
    assert_eq!(
        now.rsplit_once(") ").unwrap().1.split_whitespace().nth(19),
        Some(birth.as_str())
    );
    // SAFETY: exact live birth matches this fixture's captured command identity.
    unsafe {
        libc::kill(command, libc::SIGKILL);
    }
}

#[test]
fn display_names_are_visible_labels_never_state_paths() {
    let mut fixture = Fixture::new();
    let display = "API worker / ready\ttask\nnext";
    let mut process = fixture.process("service-0123456789abcdef", "hold");
    process["displayName"] = json!(display);
    let first = fixture.serve(process);
    assert_eq!(first["processes"][0]["name"], "service-0123456789abcdef");
    assert_eq!(first["processes"][0]["displayName"], display);
    let mut second = fixture.process("service-fedcba9876543210", "hold");
    second["displayName"] = json!("other / service");
    fixture.add(second);
    let status = fixture.control("status");
    assert!(
        status["liveProcessNames"]
            .as_array()
            .unwrap()
            .contains(&json!(display))
    );
    assert!(
        status["liveProcessNames"]
            .as_array()
            .unwrap()
            .contains(&json!("other / service"))
    );
    eventually(|| {
        fs::read_to_string(fixture.root.join("lifecycle.log"))
            .is_ok_and(|log| log.contains("\tAPI worker / ready task next\tstdout\t"))
    });
    assert!(fixture.root.join("service-0123456789abcdef.json").exists());
    assert!(fixture.root.join("service-fedcba9876543210.json").exists());
    assert_eq!(
        fs::read_dir(&fixture.root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().unwrap().is_dir())
            .count(),
        0
    );
}

#[test]
fn display_name_limit_refuses_without_launch() {
    let fixture = Fixture::new();
    let mut process = fixture.process("safe-key", "hold");
    process["displayName"] = json!("x".repeat(4097));
    let (mut owner, receipt) = fixture.call("serve", &fixture.launch(process));
    assert_eq!(receipt["outcome"], "refused");
    assert!(!wait(&mut owner).success());
    assert!(!fixture.root.join("safe-key.json").exists());
}

#[test]
fn lost_add_client_reply_retains_native_ownership_and_live_observation() {
    let mut fixture = Fixture::new();
    fixture.serve(fixture.process("helper", "hold"));
    let mut add = fixture.command("add").spawn().unwrap();
    drop(add.stdout.take());
    send(
        add.stdin.as_mut().unwrap(),
        &fixture.launch(fixture.process("late", "hold")),
    );
    assert!(!wait(&mut add).success());
    let status = fixture.control("status");
    assert!(
        status["liveProcessNames"]
            .as_array()
            .unwrap()
            .contains(&json!("late"))
    );
    assert_eq!(fixture.state("late")["ownerToken"], TOKEN);
    fixture.control("stop");
}

#[test]
fn escaped_display_name_cannot_publish_unreadable_state() {
    let fixture = Fixture::new();
    let mut process = fixture.process("safe-key", "hold");
    process["displayName"] = json!(format!("x{}", "\u{1}".repeat(4095)));
    let (mut owner, receipt) = fixture.call("serve", &fixture.launch(process));
    assert_eq!(receipt["outcome"], "refused");
    assert!(!wait(&mut owner).success());
    assert!(!fixture.root.join("safe-key.json").exists());
}
