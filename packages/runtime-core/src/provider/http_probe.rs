//! Experimental resident localhost HTTP probe. Graph integration is not enabled yet.
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
    /// State directory must be a fresh private tmpfs directory for this process generation.
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
        Ok(vec![
            self.port.to_string(),
            self.path.clone(),
            self.interval_ms.to_string(),
            self.timeout_ms.to_string(),
            self.retries.to_string(),
            self.start_period_ms.to_string(),
            directory.into(),
            generation.into(),
        ])
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
        }
        impl Fixture {
            fn new(mode: usize, grace: u64) -> Self {
                Self::with_timeout(mode, grace, 40)
            }
            fn with_timeout(mode: usize, grace: u64, timeout: u64) -> Self {
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
                let mut fixture = Self {
                    root,
                    process: None,
                    mode,
                    stop,
                    server: Some(server),
                    config,
                    accepted,
                };
                fixture.process = Some(fixture.command().spawn().unwrap());
                fixture
            }
            fn command(&self) -> Command {
                let mut c = Command::new(concat!(env!("OUT_DIR"), "/http-probe-host"));
                c.args(
                    self.config
                        .arguments(self.root.to_str().unwrap(), GENERATION)
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
                let health = self.config.health(&raw, GENERATION, true, now).unwrap();
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
                self.server.take().unwrap().join().unwrap();
                fs::remove_dir_all(&self.root).unwrap();
            }
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
            fs::write(f.root.join("status.pending"), b"retained publication").unwrap();
            assert_eq!(f.command().status().unwrap().code(), Some(125));
            assert_eq!(
                fs::read(f.root.join("status.pending")).unwrap(),
                b"retained publication"
            );
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
