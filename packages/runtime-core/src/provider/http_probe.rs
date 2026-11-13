//! Resident localhost HTTP probe used by native graph readiness checks.
//! Status is ephemeral and needs both a live exec identity and a fresh generation-bound sample.
use crate::{CandidateError, project::execution::Health};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpProbe {
    pub port: u16,
    pub path: String,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub retries: u32,
    pub start_period_ms: u64,
    /// Generated route readiness only; absent for authored HTTP healthchecks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<HttpProbePolicy>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HttpProbePolicy {
    Route,
}
fn invalid() -> CandidateError {
    CandidateError::new(
        "http_probe",
        "Invalid native HTTP probe configuration or status.",
    )
}
fn generation_valid(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl HttpProbe {
    /// A reviewed route without an authored healthcheck gets a bounded localhost
    /// TCP connection followed by a complete HTTP response from that endpoint.
    pub fn inferred_route(port: u16) -> Self {
        // These defaults are part of retained route admission in Rust and
        // TypeScript. Changing them requires a compatibility migration.
        Self {
            port,
            path: "/".into(),
            interval_ms: 1_000,
            timeout_ms: 1_000,
            retries: 3,
            start_period_ms: 300_000,
            policy: Some(HttpProbePolicy::Route),
        }
    }
    pub fn validate(&self) -> Result<(), CandidateError> {
        if self.port == 0
            || !self.path.starts_with('/')
            || self.path.len() > 512
            || !self
                .path
                .bytes()
                .all(|b| (33..127).contains(&b) && b != b'#')
            || !(10..=3_600_000).contains(&self.interval_ms)
            || !(1..=60_000).contains(&self.timeout_ms)
            || !(1..=100).contains(&self.retries)
            || self.start_period_ms > 3_600_000
        {
            return Err(invalid());
        }
        Ok(())
    }
    /// Samples must be absent in the private tmpfs directory for this generation.
    /// Owner rearm may retain the mount after proving the prior exec inactive
    /// and clearing its exact samples under the existing probe lock.
    pub fn arguments(
        &self,
        directory: &str,
        generation: &str,
    ) -> Result<Vec<String>, CandidateError> {
        self.validate()?;
        if !generation_valid(generation) || !directory.starts_with('/') || directory.contains('\0')
        {
            return Err(invalid());
        }
        let mut arguments = vec![
            self.port.to_string(),
            self.path.clone(),
            self.interval_ms.to_string(),
            self.timeout_ms.to_string(),
            self.retries.to_string(),
            self.start_period_ms.to_string(),
            directory.into(),
            generation.into(),
        ];
        if self.policy == Some(HttpProbePolicy::Route) {
            arguments.push("route".into());
        }
        Ok(arguments)
    }
    /// A historical healthy sample cannot outlive its exec, generation, or freshness window.
    pub fn health(
        &self,
        raw: &str,
        generation: &str,
        exec_running: bool,
        now_ms: u64,
    ) -> Result<Health, CandidateError> {
        self.validate()?;
        if raw.len() > 256 || !raw.ends_with('\n') || !generation_valid(generation) {
            return Err(invalid());
        }
        let fields: Vec<_> = raw
            .strip_suffix('\n')
            .expect("checked newline")
            .split(' ')
            .collect();
        if fields.len() != 7 || fields[0] != "v1" || fields[1] != generation {
            return Err(invalid());
        }
        let numbers: Vec<u64> = fields[2..]
            .iter()
            .map(|v| {
                if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(invalid());
                }
                v.parse().map_err(|_| invalid())
            })
            .collect::<Result<_, _>>()?;
        let [sequence, health, failures, observed_ms, _elapsed_ms] = numbers[..] else {
            return Err(invalid());
        };
        if health > 2
            || failures > u64::from(self.retries)
            || failures > sequence
            || (sequence == 0 && health != 2)
            || (health == 0 && failures != u64::from(self.retries))
            || (health != 0 && failures >= u64::from(self.retries))
        {
            return Err(invalid());
        }
        // A small wall-clock allowance is explicit; excessive skew fails closed.
        let freshness = self.interval_ms + self.timeout_ms + 1_000;
        if !exec_running
            || observed_ms > now_ms.saturating_add(1_000)
            || now_ms.saturating_sub(observed_ms) > freshness
        {
            return Ok(Health::Unhealthy);
        }
        Ok(match health {
            0 => Health::Unhealthy,
            1 => Health::Healthy,
            _ => Health::Starting,
        })
    }
}
#[cfg(feature = "native-http-probe")]
pub fn guest_binary() -> &'static [u8] {
    // Built from this crate's guest source by build.rs and embedded in the same
    // runtime as the planner; publication addresses it by its content hash.
    include_bytes!(concat!(env!("OUT_DIR"), "/http-probe"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const GENERATION: &str = "0123456789abcdef0123456789abcdef";
    fn config() -> HttpProbe {
        HttpProbe {
            port: 8080,
            path: "/health".into(),
            interval_ms: 100,
            timeout_ms: 40,
            retries: 3,
            start_period_ms: 0,
            policy: None,
        }
    }
    #[test]
    fn healthy_samples_require_live_fresh_matching_generation() {
        let p = config();
        let raw = format!("v1 {GENERATION} 5 1 0 10000 2\n");
        assert_eq!(
            p.health(&raw, GENERATION, true, 10010).unwrap(),
            Health::Healthy
        );
        for (running, now) in [(false, 10010), (true, 11141), (true, 8999)] {
            assert_eq!(
                p.health(&raw, GENERATION, running, now).unwrap(),
                Health::Unhealthy
            );
        }
        assert!(
            p.health(&raw, "ffffffffffffffffffffffffffffffff", true, 10010)
                .is_err()
        );
        assert!(
            p.health(&format!("{raw}injected"), GENERATION, true, 10010)
                .is_err()
        );
        for suffix in [
            "0 1 0 10000 0",
            "5 0 1 10000 0",
            "5 3 0 10000 0",
            "5 1 4 10000 0",
        ] {
            assert!(
                p.health(
                    &format!("v1 {GENERATION} {suffix}\n"),
                    GENERATION,
                    true,
                    10000
                )
                .is_err()
            );
        }
    }
    #[test]
    fn configuration_refuses_unbounded_requests_and_header_injection() {
        for path in [
            "http://outside/",
            "/\r\nHost: outside",
            "/a b",
            "/fragment#x",
            "/é",
        ] {
            let mut p = config();
            p.path = path.into();
            assert!(p.validate().is_err());
        }
        let mut p = config();
        p.timeout_ms = 60_001;
        assert!(p.validate().is_err());
        let mut p = config();
        p.retries = 0;
        assert!(p.validate().is_err());
    }

    #[test]
    fn inferred_policy_is_reviewed_while_explicit_serialization_and_arguments_stay_unchanged() {
        let explicit = config();
        assert!(
            serde_json::to_value(&explicit)
                .unwrap()
                .get("policy")
                .is_none()
        );
        assert_eq!(
            explicit
                .arguments("/private/probe", GENERATION)
                .unwrap()
                .len(),
            8
        );
        let inferred = HttpProbe::inferred_route(3000);
        inferred.validate().unwrap();
        assert_eq!(serde_json::to_value(&inferred).unwrap()["policy"], "route");
        assert_eq!(
            inferred
                .arguments("/private/probe", GENERATION)
                .unwrap()
                .last()
                .unwrap(),
            "route"
        );
        let mut invalid = serde_json::to_value(&inferred).unwrap();
        invalid["policy"] = serde_json::json!("anything");
        assert!(serde_json::from_value::<HttpProbe>(invalid).is_err());
    }

    #[cfg(feature = "native-http-probe")]
    mod native {
        use super::*;
        use std::{
            fs,
            io::{Read, Write},
            net::TcpListener,
            os::unix::fs::PermissionsExt,
            path::PathBuf,
            process::{Child, Command, Stdio},
            sync::{
                Arc,
                atomic::{AtomicUsize, Ordering},
            },
            thread,
            time::{Duration, Instant, SystemTime, UNIX_EPOCH},
        };
        static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
        struct Fixture {
            root: PathBuf,
            process: Option<Child>,
            mode: Arc<AtomicUsize>,
            stop: Arc<AtomicUsize>,
            server: Option<thread::JoinHandle<()>>,
            config: HttpProbe,
            accepted: Arc<AtomicUsize>,
            generation: String,
        }
        impl Fixture {
            fn new(mode: usize, grace: u64) -> Self {
                Self::with_timeout(mode, grace, 40)
            }
            fn with_timeout(mode: usize, grace: u64, timeout: u64) -> Self {
                Self::with_policy(mode, grace, timeout, None)
            }
            fn with_policy(
                mode: usize,
                grace: u64,
                timeout: u64,
                policy: Option<HttpProbePolicy>,
            ) -> Self {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let port = listener.local_addr().unwrap().port();
                listener.set_nonblocking(true).unwrap();
                let mode = Arc::new(AtomicUsize::new(mode));
                let stop = Arc::new(AtomicUsize::new(0));
                let accepted = Arc::new(AtomicUsize::new(0));
                let a = accepted.clone();
                let m = mode.clone();
                let s = stop.clone();
                let server = thread::spawn(move || {
                    while s.load(Ordering::SeqCst) == 0 {
                        let Ok((mut stream, _)) = listener.accept() else {
                            thread::sleep(Duration::from_millis(2));
                            continue;
                        };
                        a.fetch_add(1, Ordering::SeqCst);
                        stream
                            .set_read_timeout(Some(Duration::from_millis(100)))
                            .unwrap();
                        let mut request = [0; 1024];
                        let _ = stream.read(&mut request);
                        let response: &[u8] = match m.load(Ordering::SeqCst) {
                            0 => b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n",
                            1 => b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n\0",
                            2 => {
                                thread::sleep(Duration::from_millis(200));
                                continue;
                            }
                            3 => b"HTTP/1.1 302 Found\r\nLocation: http://outside/\r\n\r\n",
                            4 => b"HTTP/1.1 200 OK\r\nUnterminated: true\r\n",
                            6 => {
                                for byte in b"HTTP/1.1 200 OK\r\n\r\n" {
                                    if stream.write_all(&[*byte]).is_err() {
                                        break;
                                    }
                                    thread::sleep(Duration::from_millis(20));
                                }
                                continue;
                            }
                            7 => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                            8 => b"HTTP/1.1 499 Client Closed\r\n\r\n",
                            9 => b"HTTP/1.1 500 Failed\r\n\r\n",
                            10 => b"HTTP/",
                            11 => b"",
                            12 => b"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
                            13 => b"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 503 Failed\r\n\r\n",
                            14 => b"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
                            15 => {
                                let response = format!("HTTP/1.1 200 OK\r\nX-Large: {}\r\n\r\n", "x".repeat(8192));
                                let _ = stream.write_all(response.as_bytes());
                                continue;
                            }
                            _ => b"NOT-HTTP 200 OK\r\n\r\n",
                        };
                        let _ = stream.write_all(response);
                    }
                });
                let root = std::env::temp_dir().join(format!(
                    "hack-native-probe-{}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&root).unwrap();
                fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
                let mut config = config();
                config.port = port;
                config.start_period_ms = grace;
                config.timeout_ms = timeout;
                config.policy = policy;
                if policy == Some(HttpProbePolicy::Route) {
                    config.path = "/".into();
                }
                let mut fixture = Self {
                    root,
                    process: None,
                    mode,
                    stop,
                    server: Some(server),
                    config,
                    accepted,
                    generation: GENERATION.into(),
                };
                fixture.process = Some(fixture.command().spawn().unwrap());
                fixture
            }
            fn command(&self) -> Command {
                let mut c = Command::new(concat!(env!("OUT_DIR"), "/http-probe-host"));
                c.args(
                    self.config
                        .arguments(self.root.to_str().unwrap(), &self.generation)
                        .unwrap(),
                )
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
                c
            }
            fn sample(&self) -> Option<(Health, u64)> {
                let raw = fs::read_to_string(self.root.join("status")).ok()?;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                let health = self
                    .config
                    .health(&raw, &self.generation, true, now)
                    .unwrap();
                Some((health, raw.split(' ').nth(2).unwrap().parse().unwrap()))
            }
            fn wait(&mut self, health: Health, after: u64) -> u64 {
                let deadline = Instant::now() + Duration::from_secs(4);
                loop {
                    assert!(
                        self.process.as_mut().unwrap().try_wait().unwrap().is_none(),
                        "probe exited"
                    );
                    if let Some((h, sequence)) = self.sample() {
                        if h == health && sequence > after {
                            return sequence;
                        }
                    }
                    assert!(
                        Instant::now() < deadline,
                        "expected probe state not observed"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(mut p) = self.process.take() {
                    let _ = p.kill();
                    let _ = p.wait();
                }
                self.stop.store(1, Ordering::SeqCst);
                if let Some(server) = self.server.take() {
                    server.join().unwrap();
                }
                fs::remove_dir_all(&self.root).unwrap();
            }
        }

        #[cfg(target_os = "linux")]
        fn prepare_rearm(fixture: &Fixture, previous: &str) -> std::process::Output {
            use std::os::unix::fs::MetadataExt;
            let owner = fs::metadata(&fixture.root).unwrap();
            let script = format!(
                "state=$1; uid=$2; gid=$3; previous=$4\n{}",
                include_str!("graph/probe-rearm-samples.sh")
            );
            Command::new("/bin/sh")
                .args(["-eu", "-c", &script, "probe-rearm-test"])
                .arg(&fixture.root)
                .arg(owner.uid().to_string())
                .arg(owner.gid().to_string())
                .arg(previous)
                .output()
                .unwrap()
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn retained_probe_rearm_clears_old_and_interrupted_samples_without_remounting() {
            use std::os::unix::fs::MetadataExt;
            for pending in [b"".as_slice(), b"v1 interrupted sample".as_slice()] {
                let mut f = Fixture::new(1, 0);
                f.wait(Health::Healthy, 0);
                let before = fs::read(f.root.join("status")).unwrap();
                // A live writer's lock refuses before any sample is removed.
                assert!(!prepare_rearm(&f, GENERATION).status.success());
                assert!(f.root.join("first-sample").exists());
                let mut old = f.process.take().unwrap();
                old.kill().unwrap();
                old.wait().unwrap();
                fs::write(f.root.join("status.pending"), pending).unwrap();
                fs::set_permissions(
                    f.root.join("status.pending"),
                    fs::Permissions::from_mode(0o600),
                )
                .unwrap();
                let directory = fs::metadata(&f.root).unwrap().ino();
                let lock = fs::metadata(f.root.join("lock")).unwrap().ino();
                assert!(prepare_rearm(&f, GENERATION).status.success());
                assert!(!prepare_rearm(&f, GENERATION).status.success());
                for name in ["status", "first-sample", "status.pending"] {
                    assert!(!f.root.join(name).exists());
                }
                assert_eq!(fs::metadata(&f.root).unwrap().ino(), directory);
                assert_eq!(fs::metadata(f.root.join("lock")).unwrap().ino(), lock);
                f.generation = "f".repeat(32);
                assert!(
                    f.config
                        .health(
                            std::str::from_utf8(&before).unwrap(),
                            &f.generation,
                            true,
                            0
                        )
                        .is_err()
                );
                f.process = Some(f.command().spawn().unwrap());
                f.wait(Health::Healthy, 0);
                let first = fs::read_to_string(f.root.join("first-sample")).unwrap();
                assert!(first.starts_with(&format!("v1 {} 1 ", f.generation)));
            }
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn retained_probe_rearm_refuses_foreign_generation_and_aliased_samples() {
            use std::os::unix::fs::symlink;
            let mut f = Fixture::new(1, 0);
            f.wait(Health::Healthy, 0);
            let mut old = f.process.take().unwrap();
            old.kill().unwrap();
            old.wait().unwrap();
            let before = fs::read(f.root.join("status")).unwrap();
            assert!(!prepare_rearm(&f, &"f".repeat(32)).status.success());
            assert_eq!(fs::read(f.root.join("status")).unwrap(), before);
            symlink("status", f.root.join("status.pending")).unwrap();
            assert!(!prepare_rearm(&f, GENERATION).status.success());
            assert_eq!(fs::read(f.root.join("status")).unwrap(), before);
            fs::remove_file(f.root.join("status.pending")).unwrap();
            fs::hard_link(f.root.join("status"), f.root.join("status.pending")).unwrap();
            assert!(!prepare_rearm(&f, GENERATION).status.success());
            assert_eq!(fs::read(f.root.join("status")).unwrap(), before);
        }
        #[test]
        fn resident_probe_counts_retries_recovers_and_refuses_duplicate_or_replay() {
            let mut f = Fixture::new(1, 0);
            let seq = f.wait(Health::Healthy, 0);
            let out = f.command().output().unwrap();
            assert_eq!(out.status.code(), Some(125));
            assert!(out.stdout.is_empty() && out.stderr.is_empty());
            f.mode.store(0, Ordering::SeqCst);
            let failed = f.wait(Health::Unhealthy, seq);
            assert!(failed >= seq + 3);
            f.mode.store(1, Ordering::SeqCst);
            f.wait(Health::Healthy, failed);
            let mut child = f.process.take().unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(f.command().status().unwrap().code(), Some(125));
            fs::remove_file(f.root.join("status")).unwrap();
            fs::remove_file(f.root.join("first-sample")).unwrap();
            fs::write(f.root.join("status.pending"), b"retained publication").unwrap();
            assert_eq!(f.command().status().unwrap().code(), Some(125));
            assert_eq!(
                fs::read(f.root.join("status.pending")).unwrap(),
                b"retained publication"
            );
        }
        #[test]
        fn inferred_route_accepts_http_2xx_through_4xx_but_never_tcp_only_or_http_5xx() {
            for (mode, expected) in [
                (1, Health::Healthy),
                (2, Health::Unhealthy), // TCP without HTTP is not a ready route.
                (3, Health::Healthy),   // Redirect is observed, never followed.
                (5, Health::Unhealthy),
                (7, Health::Healthy),
                (8, Health::Healthy),
                (11, Health::Unhealthy),
                (0, Health::Unhealthy),
                (4, Health::Unhealthy),
                (6, Health::Unhealthy), // Slowly delivered partial HTTP cannot fall back to TCP.
                (9, Health::Unhealthy),
                (10, Health::Unhealthy),
                (12, Health::Healthy),
                (13, Health::Unhealthy),
                (14, Health::Unhealthy),
                (15, Health::Unhealthy),
            ] {
                let mut f = Fixture::with_policy(mode, 0, 40, Some(HttpProbePolicy::Route));
                f.wait(expected, 0);
                assert!(f.accepted.load(Ordering::SeqCst) > 0);
            }
            for mode in [2, 3, 5, 7, 8, 11] {
                let mut f = Fixture::new(mode, 0);
                f.wait(Health::Unhealthy, 0);
            }
        }

        #[test]
        fn inferred_route_requires_tcp_and_later_5xx_revokes_readiness() {
            let mut f = Fixture::with_policy(7, 0, 40, Some(HttpProbePolicy::Route));
            let ready = f.wait(Health::Healthy, 0);
            f.mode.store(9, Ordering::SeqCst);
            let down = f.wait(Health::Unhealthy, ready);
            assert!(down >= ready + 3);
            f.mode.store(7, Ordering::SeqCst);
            let ready = f.wait(Health::Healthy, down);
            f.stop.store(1, Ordering::SeqCst);
            f.server.take().unwrap().join().unwrap();
            f.wait(Health::Unhealthy, ready);
        }
        #[test]
        fn first_sample_survives_recovery_without_overriding_live_health() {
            for mode in [0, 1] {
                let mut f = Fixture::new(mode, 3000);
                let initial_health = if mode == 1 {
                    Health::Healthy
                } else {
                    Health::Starting
                };
                let sequence = f.wait(initial_health, 2);
                let first_path = f.root.join("first-sample");
                let first = fs::read_to_string(&first_path).unwrap();
                let fields: Vec<_> = first.trim_end().split(' ').collect();
                assert_eq!(fields.len(), 7);
                assert_eq!(&fields[..3], &["v1", GENERATION, "1"]);
                assert_eq!(fields[3], if mode == 1 { "1" } else { "2" });
                assert_eq!(fields[4], "0");
                assert!(first.len() <= 256);
                assert_eq!(
                    fs::metadata(&first_path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                f.mode.store(1 - mode, Ordering::SeqCst);
                f.wait(
                    if mode == 1 {
                        Health::Unhealthy
                    } else {
                        Health::Healthy
                    },
                    sequence,
                );
                assert_eq!(fs::read_to_string(&first_path).unwrap(), first);
                assert_ne!(fs::read_to_string(f.root.join("status")).unwrap(), first);
                // Removing only the latest status cannot replay this generation or overwrite evidence.
                let mut child = f.process.take().unwrap();
                child.kill().unwrap();
                child.wait().unwrap();
                fs::remove_file(f.root.join("status")).unwrap();
                assert_eq!(f.command().status().unwrap().code(), Some(125));
                assert_eq!(fs::read_to_string(&first_path).unwrap(), first);
            }
        }
        #[test]
        fn timeout_redirect_and_malformed_response_fail_closed() {
            for mode in [2, 3, 4, 5, 6] {
                let mut f = Fixture::new(mode, 0);
                f.wait(Health::Unhealthy, 0);
            }
        }
        #[test]
        fn startup_grace_does_not_mask_failure_after_first_success() {
            let mut f = Fixture::new(0, 3000);
            let seq = f.wait(Health::Starting, 2);
            assert!(seq >= 3);
            f.mode.store(1, Ordering::SeqCst);
            let seq = f.wait(Health::Healthy, seq);
            f.mode.store(0, Ordering::SeqCst);
            f.wait(Health::Unhealthy, seq);
        }
        #[test]
        fn term_interrupts_hung_request_without_output() {
            let mut f = Fixture::with_timeout(2, 0, 5000);
            let deadline = Instant::now() + Duration::from_secs(2);
            while f.accepted.load(Ordering::SeqCst) == 0 {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(1));
            }
            let child = f.process.as_mut().unwrap();
            assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
            let start = Instant::now();
            while child.try_wait().unwrap().is_none() {
                assert!(start.elapsed() < Duration::from_secs(1));
                thread::sleep(Duration::from_millis(5));
            }
            let output = f.process.take().unwrap().wait_with_output().unwrap();
            assert!(
                output.status.success() && output.stdout.is_empty() && output.stderr.is_empty()
            );
        }
    }
}
