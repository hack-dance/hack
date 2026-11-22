use super::{
    discover_candidate, graph_cli, image_policy, project_command, resolve_candidate_root,
    write_json,
};
use hack_runtime_core::{CandidateError, provider};
use serde::Deserialize;
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

// A legacy argv can be up to 2 MiB on Linux. JSON may encode each
// byte as six characters. The frontend uses a one-shot for larger input.
const REQUEST_MAX: usize = 16 * 1024 * 1024;
// Keep the same budgets as standalone stdout and stderr. The envelope
// is transport overhead and does not count against an operation's JSON.
const STDOUT_MAX: usize = 16 * 1024 * 1024;
const STDERR_MAX: usize = 1024 * 1024;
const REPLY_MAX: usize = STDOUT_MAX + 32;
const MESSAGE_MAX_MS: u64 = 600_000;
const SESSION_MS: u64 = 24 * 60 * 60 * 1000;
const SYSTEM_ENVIRONMENT: [&str; 5] = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u32,
    timeout_ms: u64,
    cwd: PathBuf,
    step_store: Option<PathBuf>,
    environment: std::collections::BTreeMap<String, String>,
    intent: Intent,
}

/// Operation bodies are independent of the pipe framing and candidate discovery.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Intent {
    RetainedPreflight {
        run: String,
    },
    Inspect {
        run: String,
    },
    Plan {
        options: Vec<String>,
    },
    CheckProjectShare {
        project: String,
    },
    SourceSize {
        project: String,
    },
    AdmitImage {
        reference: String,
        policy: Vec<String>,
    },
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_arguments",
        "Invalid native startup preflight frame.",
    )
}

impl Intent {
    fn arguments(&self) -> Vec<&str> {
        match self {
            Self::RetainedPreflight { run } => {
                vec!["graph", "retained-preflight", "--run-id", run, "--json"]
            }
            Self::Inspect { run } => vec!["graph", "inspect", "--run-id", run, "--json"],
            Self::Plan { options } => ["project", "plan"]
                .into_iter()
                .chain(options.iter().map(String::as_str))
                .collect(),
            Self::CheckProjectShare { project } => vec![
                "runtime",
                "check-project-share",
                "--project-share",
                project,
                "--unfiltered-source",
                "--json",
            ],
            Self::SourceSize { project } => {
                vec!["project", "source-size", "--project", project, "--json"]
            }
            Self::AdmitImage { reference, policy } => {
                ["runtime", "admit-image", "--reference", reference, "--json"]
                    .into_iter()
                    .chain(policy.iter().map(String::as_str))
                    .collect()
            }
        }
    }

    fn execute(
        &self,
        root: &Path,
        arguments: &[&str],
        output: &mut Vec<u8>,
    ) -> Result<(), CandidateError> {
        let root = &resolve_candidate_root(root)?;
        match self {
            Self::RetainedPreflight { .. } | Self::Inspect { .. } => write_json(
                output,
                &graph_cli::command(&discover_candidate(root)?, &arguments[1..])?,
            ),
            Self::Plan { .. } | Self::SourceSize { .. } => {
                project_command(&discover_candidate(root)?, &arguments[1..], output, true)
            }
            Self::CheckProjectShare { project } => {
                let share = provider::ProjectShareIntent::approve(Path::new(project), true)?;
                write_json(
                    output,
                    &provider::check_project_share(&discover_candidate(root)?, &share)?,
                )
            }
            Self::AdmitImage { reference, .. } => write_json(
                output,
                &provider::registry_image::admit(reference, &image_policy(&arguments[5..])?)?,
            ),
        }
    }
}

impl Request {
    fn admits_process_context(&self) -> bool {
        self.environment
            .keys()
            .all(|key| SYSTEM_ENVIRONMENT.contains(&key.as_str()))
            && SYSTEM_ENVIRONMENT.iter().all(|&key| {
                std::env::var_os(key).as_deref()
                    == self.environment.get(key).map(std::ffi::OsStr::new)
            })
            && self.cwd.is_absolute()
            && std::env::set_current_dir(&self.cwd).is_ok()
    }

    fn execute(self, root: &Path, output: &mut Vec<u8>) -> Result<(), CandidateError> {
        let arguments = self.intent.arguments();
        let mut label_arguments = Vec::with_capacity(arguments.len() + 4);
        label_arguments.extend(["--candidate-root", root.to_str().ok_or_else(invalid)?]);
        if let Some(store) = &self.step_store {
            label_arguments.extend(["--step-store", store.to_str().ok_or_else(invalid)?]);
        }
        label_arguments.extend(arguments.iter().copied());
        provider::with_operation_arguments(&label_arguments, || {
            hack_runtime_core::with_request_state_roots(|| {
                hack_runtime_core::store::with_request_root(self.step_store.clone(), || {
                    self.intent.execute(root, &arguments, output)
                })
            })
        })
    }
}

fn frame(input: &mut impl Read) -> Result<Option<Vec<u8>>, CandidateError> {
    let mut length = [0; 4];
    if input.read(&mut length[..1]).map_err(|_| invalid())? == 0 {
        return Ok(None);
    }
    input.read_exact(&mut length[1..]).map_err(|_| invalid())?;
    let length = u32::from_be_bytes(length) as usize;
    if !(1..=REQUEST_MAX).contains(&length) {
        return Err(invalid());
    }
    let mut body = vec![0; length];
    input.read_exact(&mut body).map_err(|_| invalid())?;
    Ok(Some(body))
}

/// POLLHUP is observable without consuming input, even during a handler. The
/// child has no background work to finish on disconnect and the kernel drops
/// its descriptors and leases on exit just as for a killed one-shot request.
fn watch_parent(start: Instant, deadline: &AtomicU64) {
    let mut input = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: 0,
        revents: 0,
    };
    loop {
        // SAFETY: one initialized pollfd, valid for the duration of the call.
        let result = unsafe { libc::poll(&mut input, 1, 50) };
        if result > 0 && input.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            std::process::exit(0);
        }
        if start.elapsed().as_millis() >= u128::from(deadline.load(Ordering::Relaxed)) {
            std::process::exit(2);
        }
    }
}

fn send(output: &mut impl Write, reply: &[u8]) -> Result<(), CandidateError> {
    if reply.len() > REPLY_MAX {
        return Err(invalid());
    }
    let len = u32::try_from(reply.len()).map_err(|_| invalid())?;
    output
        .write_all(&len.to_be_bytes())
        .and_then(|()| output.write_all(reply))
        .and_then(|()| output.flush())
        .map_err(|_| invalid())
}

pub(super) fn run(root: &Path) -> Result<(), CandidateError> {
    run_with(|request, output| request.execute(root, output))
}

fn run_with(
    mut execute: impl FnMut(Request, &mut Vec<u8>) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let start = Instant::now();
    let deadline = Arc::new(AtomicU64::new(SESSION_MS));
    let watched = Arc::clone(&deadline);
    std::thread::Builder::new()
        .spawn(move || watch_parent(start, &watched))
        .map_err(|_| invalid())?;
    let mut input = io::stdin();
    let mut output = io::stdout();
    send(&mut output, br#"{"version":1}"#)?;
    let mut last_id = 0u32;
    while let Some(body) = frame(&mut input)? {
        let request: Request = serde_json::from_slice(&body).map_err(|_| invalid())?;
        if last_id.checked_add(1) != Some(request.id)
            || !(1..=MESSAGE_MAX_MS).contains(&request.timeout_ms)
        {
            return Err(invalid());
        }
        last_id = request.id;
        let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(SESSION_MS);
        // The caller applies the same request timeout from before writing. A
        // server backstop also bounds execution if the client stops progressing.
        deadline.store(elapsed + request.timeout_ms + 100, Ordering::Relaxed);
        if !request.admits_process_context() {
            send(
                &mut output,
                format!(r#"{{"id":{last_id},"standalone":true}}"#).as_bytes(),
            )?;
            deadline.store(SESSION_MS, Ordering::Relaxed);
            continue;
        }
        let prefix = format!(r#"{{"id":{last_id},"value":"#);
        let mut reply = prefix.as_bytes().to_vec();
        let result = execute(request, &mut reply);
        // Only this pipe worker uses process cwd. Its watchdog observes stdin
        // and never uses paths. A future socket worker can resolve the same
        // request's paths without changing process cwd.
        std::env::set_current_dir("/").map_err(|_| invalid())?;
        match result {
            Ok(()) if reply.len() - prefix.len() > STDOUT_MAX => {
                // The client sees the oversized frame header and uses its
                // standalone output-budget diagnostic without reading a body.
                output
                    .write_all(&((REPLY_MAX + 1) as u32).to_be_bytes())
                    .and_then(|()| output.flush())
                    .map_err(|_| invalid())?;
                return Ok(());
            }
            Ok(()) => {}
            Err(error) => {
                let prefix = format!(r#"{{"id":{last_id},"error":"#);
                reply = prefix.as_bytes().to_vec();
                serde_json::to_writer(&mut reply, &error).map_err(|_| invalid())?;
                // Standalone stderr has a trailing newline.
                if reply.len() - prefix.len() >= STDERR_MAX {
                    reply = format!("{prefix}null").into_bytes();
                }
            }
        }
        reply.push(b'}');
        send(&mut output, &reply)?;
        deadline.store(SESSION_MS, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::{BufRead, BufReader},
        os::fd::AsRawFd,
        process::{Command, Stdio},
    };

    const ROLE: &str = "HACK_PREFLIGHT_LOCK_TEST_ROLE";
    const FIXTURE: &str = "HACK_PREFLIGHT_LOCK_TEST_ROOT";
    const TEST: &str = "startup_preflight::tests::lease_released_between_worker_replies";

    fn fixture_lease(root: &Path) -> io::Result<File> {
        let file = File::open(root.join("operation.lock"))?;
        // SAFETY: the descriptor is owned by this file and remains live.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(file)
    }

    #[test]
    fn lease_released_between_worker_replies() {
        if let Some(role) = std::env::var_os(ROLE) {
            let root = PathBuf::from(std::env::var_os(FIXTURE).unwrap());
            if role == "contender" {
                drop(fixture_lease(&root).expect("lease still held after a worker reply"));
            } else {
                println!("worker frames follow");
                run_with(|_, reply| {
                    let lease = fixture_lease(&root).unwrap();
                    write_json(reply, &true)?;
                    drop(lease);
                    Ok(())
                })
                .unwrap();
            }
            return;
        }
        let root = std::env::temp_dir().join(format!("preflight-lease-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        File::create(root.join("operation.lock")).unwrap();
        let command = |role: &str| {
            let mut child = Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", TEST, "--nocapture"]).env_clear();
            child.env(ROLE, role).env(FIXTURE, &root);
            child
        };
        let mut worker = command("worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = worker.stdin.take().unwrap();
        let mut output = BufReader::new(worker.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
            if line.ends_with("worker frames follow\n") {
                break;
            }
        }
        assert_eq!(frame(&mut output).unwrap().unwrap(), br#"{"version":1}"#);
        let message = |id| {
            serde_json::to_vec(&serde_json::json!({
                "id":id, "timeout_ms":5000, "cwd":root, "environment":{},
                "intent":{"operation":"inspect","run":"fixture"},
            }))
            .unwrap()
        };
        send(&mut input, &message(1)).unwrap();
        let first = frame(&mut output).unwrap().unwrap();
        let contender = command("contender").output().unwrap();
        if contender.status.success() {
            send(&mut input, &message(2)).unwrap();
            assert_eq!(
                frame(&mut output).unwrap().unwrap(),
                b"{\"id\":2,\"value\":true\n}"
            );
        }
        drop(input);
        assert!(worker.wait().unwrap().success());
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(first, b"{\"id\":1,\"value\":true\n}");
        assert!(
            contender.status.success(),
            "{}",
            String::from_utf8_lossy(&contender.stderr)
        );
    }
}
