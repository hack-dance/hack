use super::{
    discover_candidate, graph_cli, image_policy, project_command, resolve_candidate_root,
    write_json,
};
use hack_runtime_core::{CandidateError, provider};
use serde::Deserialize;
use std::{
    io::{self, Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

const REQUEST_MAX: usize = 128 * 1024;
// Keep the same budgets as standalone stdout and stderr. The envelope
// is transport overhead and does not count against an operation's JSON.
const STDOUT_MAX: usize = 16 * 1024 * 1024;
const STDERR_MAX: usize = 1024 * 1024;
const REPLY_MAX: usize = STDOUT_MAX + 32;
const SESSION_MS: u64 = 600_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    timeout_ms: u64,
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
    fn execute(self, root: &Path, output: &mut Vec<u8>) -> Result<(), CandidateError> {
        let root = &resolve_candidate_root(root)?;
        match self {
            Self::RetainedPreflight { run } => write_json(
                output,
                &graph_cli::command(
                    &discover_candidate(root)?,
                    &["retained-preflight", "--run-id", &run, "--json"],
                )?,
            ),
            Self::Inspect { run } => write_json(
                output,
                &graph_cli::command(
                    &discover_candidate(root)?,
                    &["inspect", "--run-id", &run, "--json"],
                )?,
            ),
            Self::Plan { options } => {
                let mut args = vec!["plan"];
                // The existing plan parser owns option validation. Require JSON
                // output so the handler cannot write text onto the control stream.
                if options.last().is_none_or(|arg| arg != "--json") {
                    return Err(invalid());
                }
                args.extend(options.iter().map(String::as_str));
                project_command(&discover_candidate(root)?, &args, output, true)
            }
            Self::CheckProjectShare { project } => {
                let share = provider::ProjectShareIntent::approve(Path::new(&project), true)?;
                write_json(
                    output,
                    &provider::check_project_share(&discover_candidate(root)?, &share)?,
                )
            }
            Self::SourceSize { project } => project_command(
                &discover_candidate(root)?,
                &["source-size", "--project", &project, "--json"],
                output,
                true,
            ),
            Self::AdmitImage { reference, policy } => write_json(
                output,
                &provider::registry_image::admit(
                    &reference,
                    &image_policy(&policy.iter().map(String::as_str).collect::<Vec<_>>())?,
                )?,
            ),
        }
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
    let start = Instant::now();
    let deadline = Arc::new(AtomicU64::new(SESSION_MS));
    let watched = Arc::clone(&deadline);
    std::thread::Builder::new()
        .spawn(move || watch_parent(start, &watched))
        .map_err(|_| invalid())?;
    let mut input = io::stdin();
    let mut output = io::stdout();
    send(&mut output, br#"{"version":1}"#)?;
    while let Some(body) = frame(&mut input)? {
        let request: Request = serde_json::from_slice(&body).map_err(|_| invalid())?;
        if !(1..=SESSION_MS).contains(&request.timeout_ms) {
            return Err(invalid());
        }
        let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(SESSION_MS);
        // The caller applies the same request timeout from before writing. A
        // server backstop also bounds execution if the client stops progressing.
        deadline.store(
            SESSION_MS.min(elapsed + request.timeout_ms + 100),
            Ordering::Relaxed,
        );
        let mut reply = b"{\"value\":".to_vec();
        match request.intent.execute(root, &mut reply) {
            Ok(()) if reply.len() - b"{\"value\":".len() > STDOUT_MAX => {
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
                reply = b"{\"error\":".to_vec();
                serde_json::to_writer(&mut reply, &error).map_err(|_| invalid())?;
                // Standalone stderr has a trailing newline.
                if reply.len() - b"{\"error\":".len() >= STDERR_MAX {
                    reply = b"{\"error\":null".to_vec();
                }
            }
        }
        reply.push(b'}');
        send(&mut output, &reply)?;
        deadline.store(SESSION_MS, Ordering::Relaxed);
    }
    Ok(())
}
