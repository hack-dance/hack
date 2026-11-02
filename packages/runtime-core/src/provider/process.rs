//! Bounded, credential-blind child processes. A timed-out provider operation is uncertain.
use crate::CandidateError;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Captured {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Time source for bounded waits, so a test can drive a deadline without real time.
pub trait Clock {
    /// Monotonic time since an arbitrary fixed origin.
    fn now(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}

/// The host's monotonic clock.
pub struct MonotonicClock(Instant);

impl MonotonicClock {
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// A started child that [`wait_within`] polls until it completes or its bound expires.
pub trait Pending {
    /// `Some` once the child exited and both its output streams closed; `None` while it runs
    /// or a detached helper still holds a stream open.
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError>;
    /// The bound expired: signal and reap only the unreaped direct child (no PID-file or
    /// process-group kill) and return the uncertain outcome.
    fn expire(&mut self) -> CandidateError;
}

/// A spawned child whose streams are drained continuously, keeping at most 64 KiB each.
pub struct Running {
    child: std::process::Child,
    status: Option<std::process::ExitStatus>,
    out: Option<std::thread::JoinHandle<Vec<u8>>>,
    err: Option<std::thread::JoinHandle<Vec<u8>>>,
}

pub fn spawn(command: &mut Command) -> Result<Running, CandidateError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CandidateError::new("provider_spawn_failed", e.to_string()))?;
    fn drain(mut pipe: impl Read) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = pipe.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let keep = count.min(65536_usize.saturating_sub(output.len()));
            output.extend_from_slice(&buffer[..keep]);
        }
        output
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    Ok(Running {
        child,
        status: None,
        out: Some(std::thread::spawn(move || drain(stdout))),
        err: Some(std::thread::spawn(move || drain(stderr))),
    })
}

impl Pending for Running {
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
        if self.status.is_none() {
            match self.child.try_wait() {
                Ok(Some(status)) => self.status = Some(status),
                Ok(None) => return Ok(None),
                Err(e) => return Err(CandidateError::new("provider_wait_failed", e.to_string())),
            }
        }
        // Do not join early: detached provider helpers may inherit pipe descriptors.
        let finished = |stream: &Option<std::thread::JoinHandle<Vec<u8>>>| {
            stream.as_ref().is_some_and(|handle| handle.is_finished())
        };
        if !finished(&self.out) || !finished(&self.err) {
            return Ok(None);
        }
        let join = |stream: &mut Option<std::thread::JoinHandle<Vec<u8>>>| {
            stream
                .take()
                .map(|handle| handle.join().unwrap_or_default())
                .unwrap_or_default()
        };
        Ok(Some(Captured {
            status: self.status.expect("exit status recorded"),
            stdout: join(&mut self.out),
            stderr: join(&mut self.err),
        }))
    }

    fn expire(&mut self) -> CandidateError {
        if self.status.is_some() {
            // A helper retaining output is treated as uncertain, with a bounded wait.
            return CandidateError::new(
                "provider_output_uncertain",
                "A provider helper retained output descriptors; inspect owned state.",
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        CandidateError::new(
            "provider_timeout_uncertain",
            "Provider request timed out. Detached effects may remain; inspect before retry.",
        )
    }
}

/// How often [`wait_within`] polls a pending child.
pub const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Wait for `pending` on `clock` until it completes, or expire it once `timeout` has passed
/// since this call. The bound covers both the child's exit and its streams closing.
pub fn wait_within(
    pending: &mut dyn Pending,
    timeout: Duration,
    clock: &dyn Clock,
) -> Result<Captured, CandidateError> {
    let start = clock.now();
    loop {
        if let Some(captured) = pending.poll()? {
            return Ok(captured);
        }
        if clock.now().saturating_sub(start) >= timeout {
            return Err(pending.expire());
        }
        clock.sleep(POLL_INTERVAL);
    }
}

pub fn capture(command: &mut Command, timeout: Duration) -> Result<Captured, CandidateError> {
    let mut running = spawn(command)?;
    wait_within(&mut running, timeout, &MonotonicClock::new())
}

pub fn run(command: &mut Command, timeout: Duration) -> Result<String, CandidateError> {
    let output = capture(command, timeout)?;
    if !output.status.success() {
        return Err(CandidateError::new(
            "provider_command_failed",
            format!(
                "Provider command exited {}; no automatic retry. {}",
                output.status,
                String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(8192)]).trim()
            ),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| CandidateError::new("provider_protocol", "Non-UTF8 provider response."))
}

pub fn clean_command(binary: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    // Child-only: changing the multithreaded parent's umask would race unrelated file creation.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o077);
            Ok(())
        });
    }
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C");
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = clean_command(std::path::Path::new("/bin/sh"));
        command.args(["-c", script]);
        command
    }

    #[test]
    fn capture_returns_the_exit_status_and_both_streams() {
        let output = capture(
            &mut shell("printf out; printf err >&2; exit 3"),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[test]
    fn capture_kills_and_reaps_a_child_that_outlives_its_bound() {
        let started = Instant::now();
        let error = capture(&mut shell("exec sleep 30"), Duration::from_millis(200))
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_timeout_uncertain");
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn capture_reports_a_helper_that_retains_output_as_uncertain() {
        // The shell exits at once; its background child keeps stdout open past the bound.
        let error = capture(&mut shell("sleep 3 & exit 0"), Duration::from_millis(300))
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_output_uncertain");
    }

    #[test]
    fn private_child_mask_does_not_depend_on_or_change_parent_mask() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::process::tests::permissive_parent_mask_probe",
                "--nocapture",
            ])
            .env("HACK_TEST_PERMISSIVE_MASK_PROBE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("private-child-mask-verified"));
    }

    #[test]
    fn permissive_parent_mask_probe() {
        if std::env::var_os("HACK_TEST_PERMISSIVE_MASK_PROBE").is_none() {
            return;
        }
        // This exact test runs alone in a subprocess; never mutate the suite's shared mask.
        let previous = unsafe { libc::umask(0) };
        let result = run(
            clean_command(std::path::Path::new("/bin/sh")).args(["-c", "umask"]),
            Duration::from_secs(5),
        );
        let parent = unsafe { libc::umask(previous) };
        assert_eq!(parent, 0);
        let mask = u32::from_str_radix(result.unwrap().trim(), 8).unwrap();
        assert_eq!(mask, 0o077);
        println!("private-child-mask-verified");
    }
}
