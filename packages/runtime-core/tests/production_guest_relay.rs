#![cfg(target_os = "macos")]
//! Explicit owned-VM fixture. Uses the production guest, credential descriptor and
//! RelayOwner; the guest probe supplies ordinary application bytes, never codecs.
use hack_runtime_core::CandidateError;
use hack_runtime_core::provider::{
    host_endpoint::HostEndpoint,
    relay_auth::{Binding, Credential},
    relay_loop,
    relay_owner::{Context, OwnerLimits, RelayOwner, Target},
};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{Shutdown, TcpListener},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::UnixListener,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn checked<T>(result: std::result::Result<T, CandidateError>) -> Result<T> {
    result.map_err(|error| error.code.into())
}
fn require(value: bool, message: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
fn hex16(value: &str) -> Result<[u8; 16]> {
    require(
        value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid fixture scope",
    )?;
    let mut out = [0; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    require(out != [0; 16], "empty fixture scope")?;
    Ok(out)
}
struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    home: PathBuf,
    machine: String,
    context: Context,
}
impl Fixture {
    fn load() -> Result<Self> {
        let root = PathBuf::from(std::env::var("HACK_GUEST_RELAY_ROOT")?);
        require(
            root.is_absolute() && root.canonicalize()? == root,
            "fixture root must be canonical",
        )?;
        let m = fs::symlink_metadata(&root)?;
        require(
            m.is_dir() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0,
            "fixture root must be private",
        )?;
        let runtime = root.join(".hack-local/run/smolvm");
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(runtime.join("owner.json"))?;
        let m = file.metadata()?;
        require(
            m.is_file()
                && m.nlink() == 1
                && m.uid() == unsafe { libc::geteuid() }
                && m.mode() & 0o077 == 0
                && m.len() <= 65536,
            "unsafe fixture owner",
        )?;
        let mut bytes = Vec::new();
        file.take(65537).read_to_end(&mut bytes)?;
        require(bytes.len() == m.len() as usize, "fixture owner changed")?;
        let owner: Value = serde_json::from_slice(&bytes)?;
        require(
            owner["checkout"].as_str() == root.to_str()
                && owner["phase"] == "running"
                && owner["network"] == "isolated"
                && owner["dependency_sockets"]["slots"] == 1,
            "fixture runtime contract mismatch",
        )?;
        let token = owner["token"].as_str().ok_or("missing owner token")?;
        let runtime_id = hex16(token)?;
        let machine = owner["machine"]
            .as_str()
            .ok_or("missing machine")?
            .to_owned();
        require(
            machine == format!("hack-{}", &token[..12]),
            "foreign fixture machine",
        )?;
        let home = PathBuf::from(owner["short_home"].as_str().ok_or("missing short home")?);
        require(
            home == Path::new("/private/tmp").join(format!("hkl-{}", &token[..12])),
            "foreign short home",
        )?;
        let alias = fs::symlink_metadata(&home)?;
        require(
            alias.file_type().is_symlink()
                && alias.uid() == unsafe { libc::geteuid() }
                && fs::read_link(&home)? == runtime.join("home"),
            "replaced short home",
        )?;
        let boot = owner["guest_boot_id"].as_str().ok_or("missing boot")?;
        require(
            boot.len() == 36
                && [8, 13, 18, 23]
                    .into_iter()
                    .all(|i| boot.as_bytes()[i] == b'-'),
            "invalid guest boot",
        )?;
        let context = Context {
            runtime: runtime_id,
            boot: hex16(&boot.replace('-', ""))?,
        };
        Ok(Self {
            root,
            runtime,
            home,
            machine,
            context,
        })
    }
    fn base_command(&self) -> Command {
        let bundle = self
            .root
            .join(".hack-local/providers/smolvm-1.14.3-darwin-arm64");
        let mut child = Command::new(bundle.join("smolvm-bin"));
        child
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "C")
            .env("HOME", &self.home)
            .env("TMPDIR", self.runtime.join("tmp"))
            .env("DOCKER_CONFIG", self.runtime.join("docker-config"))
            .env("SMOLVM_AGENT_ROOTFS", self.runtime.join("rootfs"))
            .env("DYLD_LIBRARY_PATH", bundle.join("lib"))
            .current_dir(self.runtime.join("home"));
        child
    }
    fn command(&self, credential: Credential, success: bool) -> Result<ChildRun> {
        let mut child = self.base_command();
        child
            .args([
                "machine",
                "exec",
                "--name",
                &self.machine,
                "--timeout",
                "18s",
                "-i",
                "--",
                "/tmp/hack-production-guest-probe",
                if success { "success" } else { "refuse" },
            ])
            .stdin(checked(credential.into_private_input())?.into_stdin())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        ChildRun::new(child.spawn()?)
    }
}
struct ChildRun {
    child: Option<Child>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out: Vec<u8>,
    err: Vec<u8>,
}
impl ChildRun {
    fn new(mut child: Child) -> Result<Self> {
        let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
            (Some(stdout), Some(stderr)) => (stdout, stderr),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("missing child output pipes".into());
            }
        };
        let result = Self {
            child: Some(child),
            stdout,
            stderr,
            out: Vec::new(),
            err: Vec::new(),
        };
        for fd in [result.stdout.as_raw_fd(), result.stderr.as_raw_fd()] {
            // SAFETY: descriptors are owned by result and remain live; only status flags change.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            require(
                flags >= 0
                    && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0,
                "cannot bound child output",
            )?;
        }
        Ok(result)
    }
    fn drain(&mut self) -> Result<()> {
        fn read(stream: &mut impl Read, output: &mut Vec<u8>) -> Result<()> {
            let mut bytes = [0; 512];
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) => return Ok(()),
                    Ok(n) => {
                        require(
                            output.len() + n <= 4096,
                            "child output exceeded fixture bound",
                        )?;
                        output.extend_from_slice(&bytes[..n]);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => return Err("child output read failed".into()),
                }
            }
        }
        read(&mut self.stdout, &mut self.out)?;
        read(&mut self.stderr, &mut self.err)
    }
}
impl Drop for ChildRun {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
struct Socket {
    listener: Option<UnixListener>,
    actual: PathBuf,
    parent: (u64, u64),
    identity: (u64, u64),
    closed: bool,
}
impl Socket {
    fn bind(fixture: &Fixture) -> Result<Self> {
        let actual = fixture.runtime.join("home/dependency-00.sock");
        require(
            matches!(fs::symlink_metadata(&actual),Err(e) if e.kind()==io::ErrorKind::NotFound),
            "occupied fixture socket",
        )?;
        let parent = fs::symlink_metadata(actual.parent().ok_or("missing socket parent")?)?;
        require(
            parent.is_dir()
                && parent.uid() == unsafe { libc::geteuid() }
                && parent.mode() & 0o077 == 0,
            "unsafe socket parent",
        )?;
        let listener = UnixListener::bind(fixture.home.join("dependency-00.sock"))?;
        let m = fs::symlink_metadata(&actual)?;
        require(m.file_type().is_socket(), "fixture socket not realized")?;
        let socket = Self {
            listener: Some(listener),
            actual,
            parent: (parent.dev(), parent.ino()),
            identity: (m.dev(), m.ino()),
            closed: false,
        };
        fs::set_permissions(&socket.actual, fs::Permissions::from_mode(0o600))?;
        socket
            .listener
            .as_ref()
            .ok_or("missing listener")?
            .set_nonblocking(true)?;
        Ok(socket)
    }
    fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.listener.take();
        let parent = fs::symlink_metadata(self.actual.parent().ok_or("missing socket parent")?)?;
        require(
            (parent.dev(), parent.ino()) == self.parent,
            "socket parent replaced",
        )?;
        match fs::symlink_metadata(&self.actual) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.closed = true;
                Ok(())
            }
            Err(_) => Err("socket identity unreadable".into()),
            Ok(m) => {
                require(
                    m.file_type().is_socket() && (m.dev(), m.ino()) == self.identity,
                    "foreign socket preserved",
                )?;
                fs::remove_file(&self.actual)?;
                self.closed = true;
                Ok(())
            }
        }
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
struct Backend {
    endpoint: HostEndpoint,
    accepted: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<std::result::Result<(), &'static str>>>,
}
impl Backend {
    fn new() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let endpoint = checked(HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr()?.port(),
        ))?;
        let accepted = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, total, done) = (accepted.clone(), bytes.clone(), stop.clone());
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(90);
            while !done.load(Ordering::Acquire) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if count.fetch_add(1, Ordering::AcqRel) >= 64 {
                            return Err("backend connection cap");
                        }
                        stream.set_nonblocking(false).map_err(|_| "backend mode")?;
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .map_err(|_| "backend timeout")?;
                        stream
                            .set_write_timeout(Some(Duration::from_secs(5)))
                            .map_err(|_| "backend timeout")?;
                        let mut body = Vec::new();
                        (&mut stream)
                            .take(65537)
                            .read_to_end(&mut body)
                            .map_err(|_| "backend read")?;
                        total.fetch_add(body.len(), Ordering::AcqRel);
                        if body.len() != 65536
                            || !body.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8)
                        {
                            return Err("backend unexpected application bytes");
                        }
                        stream.write_all(&body).map_err(|_| "backend write")?;
                        stream
                            .shutdown(Shutdown::Write)
                            .map_err(|_| "backend shutdown")?;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => return Err("backend accept"),
                }
            }
            if !done.load(Ordering::Acquire) {
                return Err("backend lifetime expired");
            }
            Ok(())
        });
        Ok(Self {
            endpoint,
            accepted,
            bytes,
            stop,
            worker: Some(worker),
        })
    }
    fn finish(&mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "backend worker panicked")??;
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
fn owner(context: Context) -> Result<RelayOwner> {
    checked(RelayOwner::new(
        context,
        OwnerLimits {
            registrations: 8,
            controls: 2,
            relay: relay_loop::Limits {
                max_flows: 8,
                connect_timeout: Duration::from_secs(5),
                idle_timeout: Duration::from_secs(10),
            },
        },
    ))
}
struct Budget {
    connections: usize,
    deadline: Instant,
}
fn case(
    fixture: &Fixture,
    socket: &Socket,
    owner: &mut RelayOwner,
    target: &Target,
    credential: Credential,
    success: bool,
    budget: &mut Budget,
) -> Result<()> {
    let mut child = fixture.command(credential, success)?;
    let deadline = (Instant::now() + Duration::from_secs(20)).min(budget.deadline);
    let connections_before = budget.connections;
    let timeouts_before = owner.stats().timed_out;
    let mut status = None;
    loop {
        require(
            Instant::now() < deadline,
            "production guest fixture timed out",
        )?;
        child.drain()?;
        if status.is_none() {
            if let Some(exit) = child.child.as_mut().ok_or("missing child")?.try_wait()? {
                status = Some(exit);
                child.child.take();
            }
        }
        match socket
            .listener
            .as_ref()
            .ok_or("closed fixture listener")?
            .accept()
        {
            Ok((stream, _)) => {
                budget.connections += 1;
                require(budget.connections <= 64, "mounted connection cap")?;
                checked(owner.admit(target, stream, Duration::from_secs(5)))?;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return Err("mounted accept failed".into()),
        }
        checked(owner.tick(Duration::from_millis(2)))?;
        if status.is_some() && owner.connections() == 0 {
            break;
        }
    }
    child.drain()?;
    require(
        budget.connections == connections_before + 1,
        "expected one authenticated transport attempt",
    )?;
    require(
        status.is_some_and(|s| s.success()),
        "production guest probe failed",
    )?;
    let marker = if success {
        b"production-guest-echo-v1".as_slice()
    } else {
        b"production-guest-refused-v1".as_slice()
    };
    require(
        child
            .out
            .windows(marker.len())
            .filter(|v| *v == marker)
            .count()
            == 1,
        "missing exact production probe marker",
    )?;
    require(owner.connections() == 0, "relay retained connections")?;
    require(
        owner.stats().timed_out == timeouts_before,
        "a timeout cannot qualify an authentication refusal",
    )
}

#[test]
#[ignore = "Owned HACK_GUEST_RELAY_ROOT with uploaded production guest/probe and external VM watchdog required"]
fn production_guest_mounted_relay() -> Result<()> {
    let fixture = Fixture::load()?;
    let mut backend = Backend::new()?;
    let mut socket = Socket::bind(&fixture)?;
    let mut owner_a = owner(fixture.context)?;
    let grant = checked(owner_a.register([7; 32], backend.endpoint.clone()))?;
    // The public hello exposes the binding, never the key. Reuse its endpoint so
    // the negative case changes only the secret, not the selected target identity.
    let (_, public_hello) = checked(grant.credential.begin())?;
    let mut budget = Budget {
        connections: 0,
        deadline: Instant::now() + Duration::from_secs(58),
    };
    case(
        &fixture,
        &socket,
        &mut owner_a,
        &grant.target,
        grant.credential,
        true,
        &mut budget,
    )?;
    require(
        backend.accepted.load(Ordering::Acquire) == 1
            && backend.bytes.load(Ordering::Acquire) == 65536,
        "valid grant did not deliver exact payload",
    )?;
    let wrong = checked(Credential::from_private_input(
        Binding {
            owner: fixture.context.runtime,
            boot: fixture.context.boot,
            endpoint: public_hello[40..72].try_into()?,
            service: [7; 32],
        },
        [5; 32],
    ))?;
    case(
        &fixture,
        &socket,
        &mut owner_a,
        &grant.target,
        wrong,
        false,
        &mut budget,
    )?;
    require(
        backend.accepted.load(Ordering::Acquire) == 1
            && backend.bytes.load(Ordering::Acquire) == 65536,
        "wrong credential reached backend",
    )?;
    let stale = checked(owner_a.register([8; 32], backend.endpoint.clone()))?;
    drop(owner_a);
    socket.close()?;
    let previous = socket.identity;
    socket = Socket::bind(&fixture)?;
    require(
        socket.identity != previous,
        "replacement socket identity did not change",
    )?;
    let mut owner_b = owner(fixture.context)?;
    let fresh = checked(owner_b.register([8; 32], backend.endpoint.clone()))?;
    case(
        &fixture,
        &socket,
        &mut owner_b,
        &fresh.target,
        stale.credential,
        false,
        &mut budget,
    )?;
    require(
        backend.accepted.load(Ordering::Acquire) == 1
            && backend.bytes.load(Ordering::Acquire) == 65536,
        "stale credential reached replacement backend",
    )?;
    case(
        &fixture,
        &socket,
        &mut owner_b,
        &fresh.target,
        fresh.credential,
        true,
        &mut budget,
    )?;
    require(
        backend.accepted.load(Ordering::Acquire) == 2
            && backend.bytes.load(Ordering::Acquire) == 131072,
        "fresh replacement grant did not deliver exact payload",
    )?;
    drop(owner_b);
    socket.close()?;
    backend.finish()?;
    require(
        budget.connections == 4,
        "unexpected mounted connection count",
    )?;
    println!(
        "production-guest-relay-qualified-v1 connections=4 backend_connections=2 bytes=131072"
    );
    Ok(())
}

impl Backend {
    fn idle() -> Result<(Self, Arc<AtomicUsize>)> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let endpoint = checked(HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr()?.port(),
        ))?;
        let accepted = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicUsize::new(0));
        let (count, done, observed) = (accepted.clone(), stop.clone(), closed.clone());
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut streams = Vec::new();
            while !done.load(Ordering::Acquire) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if count.fetch_add(1, Ordering::AcqRel) >= 2 {
                            return Err("idle backend connection cap");
                        }
                        stream
                            .set_nonblocking(true)
                            .map_err(|_| "idle backend mode")?;
                        streams.push(stream);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(_) => return Err("idle backend accept"),
                }
                let mut i = 0;
                while i < streams.len() {
                    match streams[i].read(&mut [0; 1]) {
                        Ok(0) => {
                            streams.swap_remove(i);
                            observed.fetch_add(1, Ordering::AcqRel);
                        }
                        Ok(_) => return Err("idle backend received unexpected bytes"),
                        Err(e)
                            if e.kind() == io::ErrorKind::WouldBlock
                                || e.kind() == io::ErrorKind::Interrupted =>
                        {
                            i += 1;
                        }
                        Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {
                            streams.swap_remove(i);
                            observed.fetch_add(1, Ordering::AcqRel);
                        }
                        Err(_) => return Err("idle backend read"),
                    }
                }
                thread::sleep(Duration::from_millis(2));
            }
            if !done.load(Ordering::Acquire) {
                return Err("idle backend lifetime expired");
            }
            Ok(())
        });
        Ok((
            Self {
                endpoint,
                accepted,
                bytes,
                stop,
                worker: Some(worker),
            },
            closed,
        ))
    }
}
impl Fixture {
    fn docker(&self, args: &[&str], input: Option<Credential>) -> Result<ChildRun> {
        let mut command = self.base_command();
        command
            .args([
                "machine",
                "exec",
                "--name",
                &self.machine,
                "--timeout",
                "65s",
                "-i",
                "--",
                "/opt/hack-engine/docker",
                "--host",
                "unix:///run/hack-local/docker.sock",
            ])
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(input) = input {
            command.stdin(checked(input.into_private_input())?.into_stdin());
        } else {
            command.stdin(Stdio::null());
        }
        ChildRun::new(command.spawn()?)
    }
}
fn finish_command(mut child: ChildRun, deadline: Instant) -> Result<Vec<u8>> {
    loop {
        require(Instant::now() < deadline, "container command deadline")?;
        child.drain()?;
        if let Some(status) = child.child.as_mut().ok_or("missing command")?.try_wait()? {
            child.child.take();
            child.drain()?;
            require(status.success(), "container command failed")?;
            return Ok(std::mem::take(&mut child.out));
        }
        thread::sleep(Duration::from_millis(2));
    }
}
fn listener_identity(child: &mut ChildRun, deadline: Instant) -> Result<(u32, u64)> {
    loop {
        require(
            Instant::now() < deadline,
            "container listener readiness deadline",
        )?;
        child.drain()?;
        require(
            child
                .child
                .as_mut()
                .ok_or("missing listener process")?
                .try_wait()?
                .is_none(),
            "container listener exited before readiness",
        )?;
        for line in child.out.split(|byte| *byte == b'\n') {
            let Ok(line) = std::str::from_utf8(line) else {
                continue;
            };
            let Some(rest) = line.strip_prefix("hack-relay-listener-v1 pid=") else {
                continue;
            };
            let Some((pid, rest)) = rest.split_once(" start=") else {
                continue;
            };
            let Some((start, port)) = rest.split_once(" port=") else {
                continue;
            };
            if port != "25252" {
                continue;
            }
            let (pid, start) = (pid.parse::<u32>()?, start.parse::<u64>()?);
            require(pid > 1 && start > 0, "invalid listener identity")?;
            return Ok((pid, start));
        }
        thread::sleep(Duration::from_millis(2));
    }
}
fn stop_listener(
    fixture: &Fixture,
    container: &str,
    child: ChildRun,
    identity: (u32, u64),
    deadline: Instant,
) -> Result<()> {
    // Numeric identity is parsed from the production marker. Verify the same
    // container process generation and executable immediately before SIGTERM.
    let script = format!(
        "set -eu; p={}; s={}; test \"$(readlink /proc/$p/exe)\" = /tmp/hack-relay-guest; v=$(cat /proc/$p/stat); v=${{v##*) }}; set -- $v; shift 19; test \"$1\" = \"$s\"; kill -TERM \"$p\"",
        identity.0, identity.1
    );
    finish_command(
        fixture.docker(
            &[
                "exec",
                "--user",
                "0:0",
                container,
                "/bin/busybox",
                "sh",
                "-c",
                &script,
            ],
            None,
        )?,
        deadline,
    )?;
    finish_command(child, deadline)?;
    Ok(())
}
#[test]
#[ignore = "Owned container and HACK_GUEST_RELAY_ROOT plus external cleanup watchdog required"]
fn production_container_tcp_relay() -> Result<()> {
    let fixture = Fixture::load()?;
    let container = std::env::var("HACK_RELAY_CONTAINER_ID")?;
    require(
        container.len() == 64
            && container
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid immutable container ID",
    )?;
    require(
        std::env::var("HACK_RELAY_CONTAINER_PORT")? == "25252",
        "invalid container port",
    )?;
    let deadline = Instant::now() + Duration::from_secs(70);
    let inspection = finish_command(fixture.docker(&["inspect", "--format", "[{{json .Id}},{{json .Config.Labels}},{{json .State.Running}},{{json .HostConfig.NetworkMode}},{{json .Mounts}}]", &container], None)?, deadline)?;
    let metadata: Value = serde_json::from_slice(&inspection)?;
    let runtime: String = fixture
        .context
        .runtime
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    require(
        metadata[0] == container
            && metadata[1]["hack.relay.fixture"] == runtime
            && metadata[2] == true
            && metadata[3] == "none",
        "container ownership contract mismatch",
    )?;
    let mounts = metadata[4].as_array().ok_or("missing container mounts")?;
    for destination in [
        "/tmp/hack-relay-guest",
        "/tmp/hack-container-tcp-probe",
        "/run/hack-dependencies/dependency-00.sock",
    ] {
        require(
            mounts
                .iter()
                .filter(|mount| {
                    mount["Destination"] == destination
                        && mount["RW"] == false
                        && mount["Type"] == "bind"
                })
                .count()
                == 1,
            "container readonly mount mismatch",
        )?;
    }
    let mut backend = Backend::new()?;
    let mut socket = Socket::bind(&fixture)?;
    let mut owner = owner(fixture.context)?;
    let mut connections = 0;
    for (index, success) in [true, false, true].into_iter().enumerate() {
        let service = [40 + index as u8; 32];
        let grant = checked(owner.register(service, backend.endpoint.clone()))?;
        let credential = if success {
            grant.credential
        } else {
            let (_, hello) = checked(grant.credential.begin())?;
            let endpoint: [u8; 32] = hello[40..72].try_into()?;
            checked(Credential::from_private_input(
                Binding {
                    owner: fixture.context.runtime,
                    boot: fixture.context.boot,
                    endpoint,
                    service,
                },
                [5; 32],
            ))?
        };
        let failed_before = owner.stats().failed;
        let timed_out_before = owner.stats().timed_out;
        let mut server = fixture.docker(
            &[
                "exec",
                "-i",
                "--user",
                "0:0",
                &container,
                "/tmp/hack-relay-guest",
                "--slot",
                "0",
                "--listen-port",
                "25252",
            ],
            Some(credential),
        )?;
        let identity = listener_identity(
            &mut server,
            (Instant::now() + Duration::from_secs(8)).min(deadline),
        )?;
        let mut probe = fixture.docker(
            &[
                "exec",
                "--user",
                "0:0",
                &container,
                "/tmp/hack-container-tcp-probe",
                "25252",
                if success { "success" } else { "refuse" },
            ],
            None,
        )?;
        let before = connections;
        let mut status = None;
        let case_deadline = (Instant::now() + Duration::from_secs(15)).min(deadline);
        loop {
            require(
                Instant::now() < case_deadline,
                "container application deadline",
            )?;
            server.drain()?;
            require(
                server
                    .child
                    .as_mut()
                    .ok_or("missing listener")?
                    .try_wait()?
                    .is_none(),
                "listener exited during application",
            )?;
            probe.drain()?;
            if status.is_none() {
                if let Some(exit) = probe.child.as_mut().ok_or("missing probe")?.try_wait()? {
                    status = Some(exit);
                    probe.child.take();
                }
            }
            match socket.listener.as_ref().ok_or("missing socket")?.accept() {
                Ok((stream, _)) => {
                    connections += 1;
                    require(connections <= 64, "connection cap")?;
                    checked(owner.admit(&grant.target, stream, Duration::from_secs(5)))?;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(_) => return Err("container mounted accept failed".into()),
            }
            checked(owner.tick(Duration::from_millis(2)))?;
            if status.is_some() && owner.connections() == 0 {
                break;
            }
        }
        probe.drain()?;
        require(
            status.is_some_and(|s| s.success()) && connections == before + 1,
            "container probe or mounted attempt failed",
        )?;
        let marker = if success {
            b"container-tcp-echo-v1".as_slice()
        } else {
            b"container-tcp-refused-v1".as_slice()
        };
        require(
            probe
                .out
                .windows(marker.len())
                .filter(|bytes| *bytes == marker)
                .count()
                == 1,
            "container probe marker missing",
        )?;
        require(
            owner.stats().timed_out == timed_out_before
                && owner.stats().failed == failed_before + u64::from(!success),
            "container authentication failure classification mismatch",
        )?;
        let expected = if index == 2 { 2 } else { 1 };
        require(
            backend.accepted.load(Ordering::Acquire) == expected
                && backend.bytes.load(Ordering::Acquire) == expected * 65536,
            "container backend isolation or payload failed",
        )?;
        stop_listener(
            &fixture,
            &container,
            server,
            identity,
            (Instant::now() + Duration::from_secs(8)).min(deadline),
        )?;
        require(
            owner.connections() == 0,
            "container relay retained connections",
        )?;
    }
    let (mut idle_backend, idle_closed) = Backend::idle()?;
    let grant = checked(owner.register([50; 32], idle_backend.endpoint.clone()))?;
    let mut server = fixture.docker(
        &[
            "exec",
            "-i",
            "--user",
            "0:0",
            &container,
            "/tmp/hack-relay-guest",
            "--slot",
            "0",
            "--listen-port",
            "25252",
        ],
        Some(grant.credential),
    )?;
    let identity = listener_identity(
        &mut server,
        (Instant::now() + Duration::from_secs(8)).min(deadline),
    )?;
    let mut idle_probes = Vec::new();
    for _ in 0..2 {
        idle_probes.push(fixture.docker(
            &[
                "exec",
                "--user",
                "0:0",
                &container,
                "/tmp/hack-container-tcp-probe",
                "25252",
                "idle",
            ],
            None,
        )?);
    }
    let idle_deadline = (Instant::now() + Duration::from_secs(8)).min(deadline);
    let timeout_before = owner.stats().timed_out;
    loop {
        require(
            Instant::now() < idle_deadline,
            "concurrent idle authentication deadline",
        )?;
        server.drain()?;
        require(
            server
                .child
                .as_mut()
                .ok_or("missing idle listener")?
                .try_wait()?
                .is_none(),
            "idle listener exited early",
        )?;
        for probe in &mut idle_probes {
            probe.drain()?;
            require(
                probe
                    .child
                    .as_mut()
                    .ok_or("missing idle probe")?
                    .try_wait()?
                    .is_none(),
                "idle application closed before stop",
            )?;
        }
        match socket
            .listener
            .as_ref()
            .ok_or("missing idle socket")?
            .accept()
        {
            Ok((stream, _)) => {
                connections += 1;
                require(connections <= 5, "unexpected idle admission")?;
                checked(owner.admit(&grant.target, stream, Duration::from_secs(5)))?;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return Err("idle mounted accept failed".into()),
        }
        checked(owner.tick(Duration::from_millis(2)))?;
        if idle_backend.accepted.load(Ordering::Acquire) == 2 && owner.connections() == 2 {
            break;
        }
    }
    require(
        idle_closed.load(Ordering::Acquire) == 0,
        "idle backend closed before signal",
    )?;
    stop_listener(
        &fixture,
        &container,
        server,
        identity,
        (Instant::now() + Duration::from_secs(8)).min(deadline),
    )?;
    for probe in idle_probes {
        let output = finish_command(
            probe,
            (Instant::now() + Duration::from_secs(3)).min(deadline),
        )?;
        let marker = b"container-tcp-idle-closed-v1";
        require(
            output
                .windows(marker.len())
                .filter(|bytes| *bytes == marker)
                .count()
                == 1,
            "idle application did not observe EOF",
        )?;
    }
    let drain_deadline = (Instant::now() + Duration::from_secs(3)).min(deadline);
    while owner.connections() != 0 || idle_closed.load(Ordering::Acquire) != 2 {
        require(
            Instant::now() < drain_deadline,
            "idle relay retained connections after signal",
        )?;
        checked(owner.tick(Duration::from_millis(2)))?;
    }
    require(
        owner.stats().timed_out == timeout_before
            && idle_backend.accepted.load(Ordering::Acquire) == 2,
        "idle shutdown depended on timeout",
    )?;
    idle_backend.finish()?;
    drop(owner);
    socket.close()?;
    backend.finish()?;
    require(connections == 5, "unexpected container transport count")?;
    println!(
        "production-container-tcp-qualified-v1 connections=5 backend_connections=2 bytes=131072 concurrent_idle=2 idle_closed=2"
    );
    Ok(())
}
