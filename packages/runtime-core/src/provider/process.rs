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

pub fn capture(command: &mut Command, timeout: Duration) -> Result<Captured, CandidateError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CandidateError::new("provider_spawn_failed", e.to_string()))?;
    // Drain both streams continuously, retaining at most 64 KiB per stream.
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
    let out = std::thread::spawn(move || drain(stdout));
    let err = std::thread::spawn(move || drain(stderr));
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Do not join: detached provider helpers may inherit pipe descriptors.
                // A helper retaining output is treated as uncertain, with a bounded wait.
                while (!out.is_finished() || !err.is_finished()) && start.elapsed() < timeout {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !out.is_finished() || !err.is_finished() {
                    return Err(CandidateError::new(
                        "provider_output_uncertain",
                        "A provider helper retained output descriptors; inspect owned state.",
                    ));
                }
                let output = out.join().unwrap_or_default();
                let diagnostic = err.join().unwrap_or_default();
                return Ok(Captured {
                    status,
                    stdout: output,
                    stderr: diagnostic,
                });
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                // Only the unreaped direct child is signalled; no PID-file or process-group kill.
                let _ = child.kill();
                let _ = child.wait();
                return Err(CandidateError::new(
                    "provider_timeout_uncertain",
                    "Provider request timed out. Detached effects may remain; inspect before retry.",
                ));
            }
            Err(e) => return Err(CandidateError::new("provider_wait_failed", e.to_string())),
        }
    }
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
