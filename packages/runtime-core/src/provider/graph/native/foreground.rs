//! Explicit native foreground lifetime; dead ownership never authorizes adoption or replay.
use super::*;
use crate::provider::engine::LOG_STREAM_BUDGET;
use crate::provider::graph::foreground::{signals, signals::Wake, transport};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    io::Write,
    time::{Duration, Instant},
};
mod host_boot;
mod owner;
pub mod recovery;
pub(super) use owner::DirectGuard;
#[cfg(test)]
mod tests;
const LIMIT: usize = 64 * 1024;

fn refused() -> CandidateError {
    error(
        "native_graph_foreground",
        "Native foreground ownership is changed, unavailable or uncertain; its exact evidence was preserved. Use tagged native control for a live owner; no recovery or replay was attempted.",
    )
}
/// A finite command's requester failed before it wrote its request (HACK-2742
/// review): nothing was sent, so nothing ran. It reaches the CLI as the owner's
/// not-started code under this module's refusal, as the owner's own refusal
/// does. Failures after the write keep their codes ("unconfirmed").
fn command_not_sent(_error: CandidateError) -> CandidateError {
    refused().with_cause_code(runtime::OWNER_COMMAND_NOT_STARTED.to_owned())
}

/// Whether the owner closed `stream` before it sent a single byte of its answer
/// (HACK-2742 review). Waits until `deadline` for the first byte or the close,
/// and consumes nothing: a peeked byte is left for the reply reader. A timeout
/// or any other error is not a proof and answers false.
fn closed_unanswered(stream: &std::os::unix::net::UnixStream, deadline: Instant) -> bool {
    use std::os::fd::AsRawFd;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: one valid pollfd for a descriptor the stream owns.
        let ready = unsafe { libc::poll(&mut descriptor, 1, timeout) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return false;
        }
        if ready == 0 {
            return false;
        }
        let mut byte = [0_u8; 1];
        // SAFETY: one writable byte; MSG_PEEK leaves it queued for the reader.
        let count = unsafe {
            libc::recv(
                stream.as_raw_fd(),
                byte.as_mut_ptr().cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if count == 0 {
            return true;
        }
        if count > 0 {
            return false;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ECONNRESET | libc::ENOTCONN | libc::EPIPE) => return true,
            Some(libc::EAGAIN | libc::EINTR) => continue,
            _ => return false,
        }
    }
}

/// Whether the owner ended through its normal cleanup and so never processed a
/// request it left unanswered (HACK-2742 review). The owner serves one request
/// at a time on its only loop and writes each answer before it accepts the
/// next. It returns from that loop only after a cleanup, which saves the run as
/// removed and then retires its publication. A connection it closed without a
/// byte of answer, followed by that retirement, was therefore never processed:
/// it was still in the listen backlog, or its request never fully arrived. An
/// owner that failed instead keeps its publication, so this answers false. The
/// retirement is awaited briefly, because the connection can close as the
/// process exits a moment after its files are removed.
fn owner_ended_unanswered(
    candidate: &Candidate,
    pin: &owner::Pin,
    review: &native_input::Review,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if pin.verify_retired().is_ok()
            && journal::read_control(candidate, review)
                .is_ok_and(|receipt| receipt.phase == Phase::Removed)
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// [`command_not_sent`] for an interactive exec, whose value-free report
/// carries one code, so the owner's not-started code is that code.
fn interactive_not_sent(_error: CandidateError) -> CandidateError {
    CandidateError::new(
        runtime::OWNER_COMMAND_NOT_STARTED,
        "The interactive exec was not sent to its owner; nothing ran.",
    )
}

/// The requester's answer for an owner's pre-intent `Refused { code }` of an
/// interactive exec. The owner's pre-effect wait codes keep their own code,
/// because the interactive report carries only one code and the CLI reads it
/// as "nothing ran" (HACK-2742). Every other code is wrapped as before.
fn interactive_owner_refusal(code: String) -> CandidateError {
    match runtime::owner_pre_effect_code(&code) {
        Some(known) => CandidateError::new(
            known,
            "The owner refused the interactive exec before it started; nothing ran.",
        ),
        None => refused().with_cause_code(code),
    }
}

/// Whether the run's foreground owner process is still running (see `owner::holds_lock`).
pub(in crate::provider) fn owner_running(candidate: &Candidate, run: &str) -> Option<bool> {
    owner::holds_lock(candidate, run)
}
pub(super) fn require_unpublished(candidate: &Candidate, run: &str) -> Result<(), CandidateError> {
    if owner::present(candidate, run)? {
        return Err(refused());
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Status,
    Observe,
    Cleanup,
    Logs,
    Exec,
    InteractiveExec,
    Run,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LogsSelection {
    service: String,
    tail: u16,
}
impl LogsSelection {
    fn valid(&self) -> bool {
        !self.service.is_empty()
            && self.service.len() <= 128
            && self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            && (1..=1000).contains(&self.tail)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RequestKind {
    NativeGraphControl,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    kind: RequestKind,
    run: String,
    review: String,
    action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logs: Option<LogsSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exec: Option<runtime::ExecSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    one_off: Option<runtime::RunSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    console_size: Option<[u16; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
}
impl Request {
    fn validate(&self, review: &native_input::Review) -> Result<(), CandidateError> {
        if self.version != 2
            || self.run != review.scope().run
            || self.review != review.review_id()
            || match self.session.as_deref() {
                Some(id) => {
                    self.action != Action::InteractiveExec
                        || !crate::provider::environment_recovery::uuid(id)
                }
                None => self.action == Action::InteractiveExec,
            }
            || match self.console_size {
                Some(size) => self.action != Action::InteractiveExec || size.contains(&0),
                None => self.action == Action::InteractiveExec,
            }
            || match (&self.action, &self.logs, &self.exec, &self.one_off) {
                (Action::Logs, Some(logs), None, None) => !logs.valid(),
                (Action::Exec | Action::InteractiveExec, None, Some(exec), None) => !exec.valid(),
                (Action::Run, None, None, Some(one_off)) => !one_off.valid(),
                (Action::Status | Action::Observe | Action::Cleanup, None, None, None) => false,
                _ => true,
            }
        {
            return Err(refused());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ReplyKind {
    NativeGraphControlReply,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    kind: ReplyKind,
    run: String,
    review: String,
    result: Outcome,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "kebab-case", deny_unknown_fields)]
enum Outcome {
    Interactive {
        receipt: Receipt,
        session: crate::provider::interactive_session::Receipt,
    },
    InteractiveRefused {
        session: String,
    },
    Exec {
        exec: runtime::ServiceExec,
    },
    OneOff {
        one_off: runtime::ServiceRun,
    },
    Logs {
        logs: runtime::ServiceLogs,
    },
    Status {
        #[serde(deserialize_with = "decode_snapshot")]
        snapshot: Snapshot,
    },
    Observed {
        #[serde(deserialize_with = "decode_snapshot")]
        snapshot: Snapshot,
    },
    Cleaned {
        receipt: Receipt,
    },
    Refused {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_failures: Option<crate::error::StopFailuresDiagnostic>,
    },
}

// The native wire closes nested observation fields without changing the shared
// execution Observation codec used by existing Compose readers.
fn decode_snapshot<'de, D: serde::Deserializer<'de>>(reader: D) -> Result<Snapshot, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct WireSnapshot {
        receipt: Receipt,
        observations: BTreeMap<String, Option<journal::WireObservation>>,
    }
    let decoded = WireSnapshot::deserialize(reader)?;
    Ok(Snapshot {
        receipt: decoded.receipt,
        observations: decoded
            .observations
            .into_iter()
            .map(|(key, value)| (key, value.map(Into::into)))
            .collect(),
    })
}
impl Reply {
    fn validate(
        &self,
        expected: &Receipt,
        action: Action,
        selected: Option<&LogsSelection>,
        exec_selected: Option<&runtime::ExecSelection>,
        one_off_selected: Option<&runtime::RunSelection>,
    ) -> Result<(), CandidateError> {
        let review = &expected.review;
        if self.version != 2 || self.run != review.scope().run || self.review != review.review_id()
        {
            return Err(refused());
        }
        let receipt = match &self.result {
            Outcome::Interactive { receipt, session } => {
                let selected = exec_selected.ok_or_else(refused)?;
                let binding = &session.binding;
                if action != Action::InteractiveExec
                    || !session.valid()
                    || session.exec.is_none()
                    || binding.backend != crate::provider::interactive_session::Backend::Authored
                    || binding.run != review.scope().run
                    || binding.namespace != review.scope().namespace
                    || binding.owner != receipt.owner
                    || binding.boot != receipt.boot
                    || binding.service != selected.service
                    || receipt.phase != Phase::ReadyObserved
                    || receipt
                        .resources
                        .get(&format!("container:{}", selected.service))
                        .and_then(|r| r.id.as_deref())
                        != Some(binding.container.as_str())
                {
                    return Err(refused());
                }
                receipt
            }
            Outcome::InteractiveRefused { session } => {
                if action != Action::InteractiveExec
                    || !crate::provider::environment_recovery::uuid(session)
                {
                    return Err(refused());
                }
                return Ok(());
            }
            Outcome::Exec { exec } => {
                if action != Action::Exec || !exec.valid(exec_selected.ok_or_else(refused)?) {
                    return Err(refused());
                }
                &exec.receipt
            }
            Outcome::OneOff { one_off } => {
                if action != Action::Run || !one_off.valid(one_off_selected.ok_or_else(refused)?) {
                    return Err(refused());
                }
                &one_off.receipt
            }
            Outcome::Logs { logs } => {
                let selected = selected.ok_or_else(refused)?;
                if action != Action::Logs
                    || !selected.valid()
                    || logs.service != selected.service
                    || logs.receipt.phase != Phase::ReadyObserved
                    || logs
                        .receipt
                        .resources
                        .get(&format!("container:{}", selected.service))
                        .and_then(|r| r.id.as_deref())
                        != Some(logs.container.as_str())
                    || !logs.receipt.readiness.contains_key(&selected.service)
                    || serde_json::to_vec(&logs.stdout)
                        .map_err(|_| refused())?
                        .len()
                        > LOG_STREAM_BUDGET
                    || serde_json::to_vec(&logs.stderr)
                        .map_err(|_| refused())?
                        .len()
                        > LOG_STREAM_BUDGET
                {
                    return Err(refused());
                }
                &logs.receipt
            }
            Outcome::Status { snapshot } | Outcome::Observed { snapshot } => {
                if !matches!(
                    (&self.result, action),
                    (Outcome::Status { .. }, Action::Status)
                        | (Outcome::Observed { .. }, Action::Observe)
                ) || snapshot
                    .observations
                    .keys()
                    .ne(snapshot.receipt.readiness.keys())
                {
                    return Err(refused());
                }
                &snapshot.receipt
            }
            Outcome::Cleaned { receipt } => {
                if action != Action::Cleanup || receipt.phase != Phase::Removed {
                    return Err(refused());
                }
                receipt
            }
            Outcome::Refused {
                code,
                stop_failures,
            } => {
                if code.is_empty()
                    || code.len() > 64
                    || !code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    || stop_failures.as_ref().is_some_and(|detail| {
                        action != Action::Cleanup
                            || !detail.valid()
                            || !matches!(
                                code.as_str(),
                                "engine_protocol" | "engine_rejected" | "engine_not_found"
                            )
                            || detail
                                .failures
                                .iter()
                                .any(|failure| !expected.readiness.contains_key(&failure.service))
                    })
                {
                    return Err(refused());
                }
                return Ok(());
            }
        };
        receipt.check_binding(expected)
    }
}

/// How often a ready owner reads the pool record to notice that its boot ended. A
/// lock-free read of one small file; two readings in a row decide.
const POOL_BOOT_CHECK: Duration = Duration::from_secs(1);

/// The owner's own exit once its pool boot ended under it (HACK-2715 review round 2).
fn pool_ended() -> CandidateError {
    error(
        "native_graph_pool_ended",
        "The native pool boot of this run ended under its owner (runtime down --force or a crash); the owner exited without a cleanup effect, and hack down in its project recovers the run. Values omitted.",
    )
}

/// This process remains supervised until TERM/INT, authenticated exact-run cleanup, or
/// the end of its pool boot.
/// Startup and cleanup use the owning native runtime; no Compose receipt is constructed.
pub fn serve(
    candidate: &Candidate,
    prepared: selection::Prepared,
) -> Result<Receipt, CandidateError> {
    serve_with_storage_tool(candidate, prepared, None)
}
pub fn serve_with_storage_tool(
    candidate: &Candidate,
    prepared: selection::Prepared,
    storage_tool: Option<&StorageTool>,
) -> Result<Receipt, CandidateError> {
    prepared.assert_fresh(candidate)?;
    let read_pin = prepared.read_pin();
    let review = prepared.input().review().clone();
    let run = review.scope().run.to_owned();
    let mut publication = owner::Publication::bind(candidate, &review)?;
    let signals = match signals::Events::new_descriptor(publication.descriptor()) {
        Ok(signals) => signals,
        Err(error) => {
            publication.finish()?;
            return Err(error);
        }
    };
    let admitted = Cell::new(false);
    // The pool boot this owner starts in. A start whose boot ends under it (`runtime
    // down --force`, a crash) fails at its next check instead of waiting on a guest
    // that is gone (HACK-2715 review round 2, seen on a real VM).
    let started_in = journal::running_boot(candidate);
    let attempt = {
        let check = || {
            publication.verify()?;
            if signals.pending() {
                return Err(error(
                    "native_graph_canceled",
                    "Native foreground startup canceled; values omitted.",
                ));
            }
            if started_in.as_ref().is_some_and(|(owner, boot)| {
                journal::boot_of(candidate, owner, boot) == journal::ReceiptBoot::Ended
            }) {
                return Err(pool_ended());
            }
            Ok(())
        };
        runtime::run_guarded(
            candidate,
            prepared,
            Some(&check),
            Some(&admitted),
            storage_tool,
        )
    };
    let receipt = match attempt {
        Ok(receipt) => receipt,
        Err(error) => {
            if admitted.get() {
                if journal::read_control(candidate, &review)
                    .and_then(|retained| {
                        runtime::cleanup_guarded(
                            candidate,
                            &run,
                            Some(&retained),
                            Some(&|| publication.verify()),
                        )
                    })
                    .is_ok()
                {
                    publication.finish()?;
                }
            } else if std::fs::symlink_metadata(journal::directory(candidate, &run)?)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                publication.finish()?;
            }
            return Err(error);
        }
    };
    let clean = || {
        runtime::cleanup_guarded(
            candidate,
            &run,
            Some(&receipt),
            Some(&|| publication.verify()),
        )
    };
    if signals.pending() {
        let receipt = clean()?;
        publication.finish()?;
        return Ok(receipt);
    }
    publication.verify()?;
    {
        let ready = json!({"version":2,"kind":"native-graph-foreground-ready","run":run,"review":review.review_id(),"receipt":receipt});
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &ready).map_err(|_| refused())?;
        writeln!(stdout)
            .and_then(|_| stdout.flush())
            .map_err(|_| refused())?;
    }
    let mut ended_seen = false;
    loop {
        match signals.wait_until(Some(Instant::now() + POOL_BOOT_CHECK))? {
            Wake::Signal | Wake::FrontendExit => {
                let receipt = clean()?;
                publication.finish()?;
                return Ok(receipt);
            }
            Wake::Timeout => {
                // HACK-2715 review round 2 (seen on a real VM): a native-authored owner
                // outlived `runtime down --force` and kept its publication until host
                // reboot. Like a Compose owner, it now notices from the pool record that
                // its boot ended (twice in a row, positive evidence only) and exits
                // without a cleanup effect: no engine of that boot remains. Its
                // publication stays as evidence for the dead-owner recovery.
                let ended = journal::boot_of(candidate, &receipt.owner, &receipt.boot)
                    == journal::ReceiptBoot::Ended;
                if ended && ended_seen {
                    return Err(pool_ended());
                }
                ended_seen = ended;
                continue;
            }
            _ => {}
        }
        let Some(mut stream) = publication.accept()? else {
            continue;
        };
        let request: Request =
            match transport::read(&mut stream, Duration::from_secs(5), 512 * 1024) {
                Ok(request) => request,
                Err(_) => continue,
            };
        if request.validate(&review).is_err() {
            continue;
        }
        publication.verify()?;
        let mut attached = None;
        let result = match request.action {
            Action::InteractiveExec => {
                let selected = request.exec.as_ref().ok_or_else(refused)?;
                let client = transport::ClientWatch::half_closed(&stream)?;
                let check = || {
                    publication.verify()?;
                    if signals.pending() || client.disconnected() {
                        return Err(refused());
                    }
                    read_pin.verify(candidate)
                };
                match runtime::interactive_exec(
                    candidate,
                    &receipt,
                    selected,
                    request.console_size.ok_or_else(refused)?,
                    request.session.as_deref().ok_or_else(refused)?,
                    &check,
                ) {
                    Ok(session) => {
                        attached = Some(session.stream);
                        Ok(Outcome::Interactive {
                            receipt: receipt.clone(),
                            session: session.receipt,
                        })
                    }
                    Err(error) if error.session().is_some() => Ok(Outcome::InteractiveRefused {
                        session: error.session().ok_or_else(refused)?.to_owned(),
                    }),
                    Err(error) => Err(error),
                }
            }
            Action::Status => inspect(candidate, &run).map(|snapshot| Outcome::Status { snapshot }),
            Action::Observe => {
                runtime::status(candidate, &run).map(|snapshot| Outcome::Observed { snapshot })
            }
            Action::Cleanup => clean().map(|receipt| Outcome::Cleaned { receipt }),
            Action::Exec => {
                let selected = request.exec.as_ref().ok_or_else(refused)?;
                let check = || {
                    publication.verify()?;
                    if signals.pending() {
                        return Err(refused());
                    }
                    read_pin.verify(candidate)
                };
                runtime::service_exec(candidate, &receipt, selected, &check)
                    .map(|exec| Outcome::Exec { exec })
            }
            Action::Run => {
                let selected = request.one_off.as_ref().ok_or_else(refused)?;
                let check = || {
                    publication.verify()?;
                    if signals.pending() {
                        return Err(refused());
                    }
                    read_pin.verify(candidate)
                };
                runtime::service_run(candidate, &receipt, selected, &check)
                    .map(|one_off| Outcome::OneOff { one_off })
            }
            Action::Logs => {
                let logs = request.logs.as_ref().ok_or_else(refused)?;
                let check = || {
                    publication.verify()?;
                    read_pin.verify(candidate)
                };
                runtime::logs(candidate, &receipt, &logs.service, logs.tail, &check)
                    .map(|logs| Outcome::Logs { logs })
            }
        };
        let result = result.unwrap_or_else(|error| Outcome::Refused {
            code: error.code.into(),
            stop_failures: error.stop_failures.map(|detail| *detail),
        });
        let cleaned = matches!(result, Outcome::Cleaned { .. });
        let reply = Reply {
            version: 2,
            kind: ReplyKind::NativeGraphControlReply,
            run: run.clone(),
            review: review.review_id().into(),
            result,
        };
        reply.validate(
            &receipt,
            request.action,
            request.logs.as_ref(),
            request.exec.as_ref(),
            request.one_off.as_ref(),
        )?;
        if cleaned {
            // Retire before writing on the retained authenticated stream. Clients
            // verify both absent publication paths and the exact durable Removed journal.
            publication.finish()?;
            let _ = transport::write(&mut stream, &reply, Duration::from_secs(5));
            let Outcome::Cleaned { receipt } = reply.result else {
                return Err(refused());
            };
            return Ok(receipt);
        }
        if request.action == Action::InteractiveExec {
            // The connected stream is handed over before the bound reply; its
            // recipient validates that reply before using the fd. Sending
            // consumes our copy even on error, so the owner never holds a shell.
            if crate::provider::interactive_handoff::send(
                &stream,
                attached,
                std::time::Instant::now() + Duration::from_secs(5),
            )
            .is_err()
            {
                continue;
            }
        }
        let _ = transport::write(&mut stream, &reply, Duration::from_secs(5));
    }
}

pub struct RequestOptions<'a> {
    pub run: &'a str,
    pub action: Action,
}
/// Bounded authenticated native-only request. A timeout never authorizes replay or killing the owner.
pub fn request(
    candidate: &Candidate,
    options: RequestOptions<'_>,
) -> Result<Value, CandidateError> {
    if matches!(
        options.action,
        Action::Logs | Action::Exec | Action::InteractiveExec | Action::Run
    ) {
        return Err(refused());
    }
    request_selected(candidate, options.run, options.action, None, None, None)
}
/// Finite authored logs require a live authenticated owner; no direct Engine fallback.
pub fn logs(
    candidate: &Candidate,
    run: &str,
    service: &str,
    tail: u16,
) -> Result<Value, CandidateError> {
    let selected = LogsSelection {
        service: service.into(),
        tail,
    };
    if !selected.valid() {
        return Err(refused());
    }
    request_selected(candidate, run, Action::Logs, Some(selected), None, None)
}
/// Exactly one finite noninteractive authored command; no direct Engine fallback.
pub fn exec(
    candidate: &Candidate,
    run: &str,
    service: &str,
    argv: &[String],
    workdir: Option<&str>,
) -> Result<Value, CandidateError> {
    let selected = runtime::ExecSelection {
        service: service.into(),
        argv: argv.to_vec(),
        workdir: workdir.map(str::to_owned),
    };
    if !selected.valid() {
        return Err(refused());
    }
    // HACK-2739: wait out another project's stop here, in the requesting
    // process, before anything is sent. The owner's own wait stays short
    // because it blocks the owner's only loop. On expiry this returns the raw
    // `provider_busy` naming the holder: nothing was sent and nothing ran.
    #[cfg(target_os = "macos")]
    crate::provider::lifecycle::await_free_command_lease(
        candidate,
        Instant::now() + crate::provider::lifecycle::COMMAND_REQUEST_LEASE_WAIT,
    )?;
    request_selected(candidate, run, Action::Exec, None, Some(selected), None)
}
/// Exactly one finite noninteractive one-off service command in a fresh container
/// created and reaped by the live owner; no direct Engine fallback.
pub fn one_off(
    candidate: &Candidate,
    run: &str,
    service: &str,
    argv: &[String],
    workdir: Option<&str>,
) -> Result<Value, CandidateError> {
    let selected = runtime::RunSelection {
        service: service.into(),
        argv: argv.to_vec(),
        workdir: workdir.map(str::to_owned),
    };
    if !selected.valid() {
        return Err(refused());
    }
    // HACK-2742: as for exec (HACK-2739), wait out another project's stop here,
    // before anything is sent; the owner's own wait stays short.
    #[cfg(target_os = "macos")]
    crate::provider::lifecycle::await_free_command_lease(
        candidate,
        Instant::now() + crate::provider::lifecycle::COMMAND_REQUEST_LEASE_WAIT,
    )?;
    request_selected(candidate, run, Action::Run, None, None, Some(selected))
}
/// The live owner creates and starts under its normal guards, then returns the
/// connected fd. The caller streams without retaining an owner/provider lease.
pub(in crate::provider) fn interactive(
    candidate: &Candidate,
    options: &crate::provider::graph::interactive_exec::Options<'_>,
    console_size: [u16; 2],
    leash: &crate::provider::interactive_terminal::Leash,
) -> Result<crate::provider::engine::interactive_exec::Attached, CandidateError> {
    let (run, service, argv, workdir) =
        (options.run, options.service, options.argv, options.workdir);
    let pins = (options.owner, options.plan, options.namespace);
    let selected = runtime::ExecSelection {
        service: service.into(),
        argv: argv.to_vec(),
        workdir: workdir.map(str::to_owned),
    };
    if !selected.valid() {
        return Err(refused());
    }
    // Everything before the request is written is pre-send: a pin or owner that
    // is gone or changed answers the owner's not-started code (HACK-2742 review).
    let pin = owner::Pin::load(candidate, run).map_err(interactive_not_sent)?;
    let review = pin.review();
    let expected = journal::read_control(candidate, review).map_err(interactive_not_sent)?;
    if (
        expected.owner.as_str(),
        review.review_id(),
        review.scope().namespace,
    ) != pins
    {
        return Err(interactive_not_sent(refused()));
    }
    // HACK-2742: wait out another project's stop before anything is sent, as a
    // finite exec does (HACK-2739). The frontend's leash ends the wait. A
    // refusal here comes before dispatch, so it carries no session.
    #[cfg(target_os = "macos")]
    crate::provider::lifecycle::await_free_command_lease_checked(
        candidate,
        Instant::now() + crate::provider::lifecycle::COMMAND_REQUEST_LEASE_WAIT,
        &|| leash.check(),
    )?;
    // The owner may have exited during that wait (its own `hack down`): its pin
    // no longer connects, and nothing was sent.
    let mut stream = pin.connect().map_err(interactive_not_sent)?;
    let _lifetime = leash.watch_control(&stream).map_err(interactive_not_sent)?;
    let input = Request {
        version: 2,
        kind: RequestKind::NativeGraphControl,
        run: run.into(),
        review: review.review_id().into(),
        action: Action::InteractiveExec,
        console_size: Some(console_size),
        session: Some(options.session.into()),
        logs: None,
        exec: Some(selected.clone()),
        one_off: None,
    };
    // Once dispatch begins, a transport or binding failure cannot prove that
    // the owner stopped before its durable intent. Correlate only this attempt;
    // a validated pre-intent refusal below remains unscoped.
    let uncertain = |error: CandidateError| error.with_session(options.session);
    // HACK-2742 review (VM row 4): an owner that never accepted this connection
    // and then ended through its cleanup closes it unanswered. Only then, with
    // the owner's own retirement and removed run as evidence, is the attempt
    // proven unprocessed and reported with no session.
    let unanswered = |error: CandidateError| {
        if owner_ended_unanswered(candidate, &pin, review) {
            interactive_not_sent(error)
        } else {
            uncertain(error)
        }
    };
    transport::write(&mut stream, &input, Duration::from_secs(5)).map_err(unanswered)?;
    let descriptor = crate::provider::interactive_handoff::receive(
        &stream,
        std::time::Instant::now() + Duration::from_secs(40),
    )
    .map_err(|error| {
        if error.code == crate::provider::interactive_handoff::CLOSED_UNANSWERED {
            unanswered(error)
        } else {
            uncertain(error)
        }
    })?;
    let reply: Reply =
        transport::read(&mut stream, Duration::from_secs(5), LIMIT).map_err(uncertain)?;
    reply
        .validate(
            &expected,
            Action::InteractiveExec,
            None,
            Some(&selected),
            None,
        )
        .map_err(uncertain)?;
    match reply.result {
        Outcome::Interactive { session, .. } if session.session == options.session => {
            let result = (|| {
                journal::read_control(candidate, review)?.check_binding(&expected)?;
                pin.verify()?;
                let stream = descriptor.ok_or_else(refused)?;
                Ok(crate::provider::engine::interactive_exec::Attached { receipt: session.clone(), stream })
            })();
            result.map_err(|_: CandidateError| CandidateError::new("session_cleanup_uncertain", "Interactive session handoff changed; the session was retained and no start was replayed.").with_session(&session.session))
        }
        Outcome::InteractiveRefused { session } if session == options.session => Err(CandidateError::new("session_cleanup_uncertain", "Interactive admission ended after its durable intent; the session was retained and no start was replayed.").with_session(&session)),
        Outcome::Refused { code, .. } if descriptor.is_none() => Err(interactive_owner_refusal(code)),
        _ => Err(uncertain(refused())),
    }
}
fn request_selected(
    candidate: &Candidate,
    run: &str,
    action: Action,
    selected: Option<LogsSelection>,
    exec_selected: Option<runtime::ExecSelection>,
    one_off_selected: Option<runtime::RunSelection>,
) -> Result<Value, CandidateError> {
    // For a command (exec, one-off run), every failure before the request is
    // written is pre-send. The owner may have exited while the requester waited
    // for the lease (its own `hack down`, HACK-2742 review): its pin is gone or no
    // longer connects. Those answer the owner's not-started code so the CLI says
    // nothing ran. Status, observe, logs and cleanup keep their own refusals.
    let command = matches!(action, Action::Exec | Action::Run);
    let not_sent = |error: CandidateError| {
        if command {
            command_not_sent(error)
        } else {
            error
        }
    };
    let pin = owner::Pin::load(candidate, run).map_err(not_sent)?;
    let review = pin.review();
    let expected = journal::read_control(candidate, review).map_err(not_sent)?;
    let mut stream = pin.connect().map_err(not_sent)?;
    let input = Request {
        version: 2,
        kind: RequestKind::NativeGraphControl,
        run: run.into(),
        review: review.review_id().into(),
        action,
        console_size: None,
        session: None,
        logs: selected.clone(),
        exec: exec_selected.clone(),
        one_off: one_off_selected.clone(),
    };
    // HACK-2742 review (VM row 4, later rounds): the owner may have taken this
    // connection into its listen backlog and then exited through its cleanup
    // without ever accepting it. The write, or the first read, then fails with
    // nothing answered. For a command that is proven unprocessed only when the
    // owner closed the connection without a single byte of answer and then
    // retired its publication with its run removed (`owner_ended_unanswered`).
    let unanswered = |error: CandidateError| {
        if command && owner_ended_unanswered(candidate, &pin, review) {
            command_not_sent(error)
        } else {
            error
        }
    };
    transport::write(&mut stream, &input, Duration::from_secs(5)).map_err(unanswered)?;
    let budget = if command {
        Duration::from_secs(40)
    } else {
        Duration::from_secs(30)
    };
    let started = Instant::now();
    if command && closed_unanswered(&stream, started + budget) {
        return Err(unanswered(refused()));
    }
    let reply: Reply = transport::read(
        &mut stream,
        budget.saturating_sub(started.elapsed()),
        if command {
            4 * 1024 * 1024
        } else if action == Action::Logs {
            128 * 1024
        } else {
            LIMIT
        },
    )?;
    reply.validate(
        &expected,
        action,
        selected.as_ref(),
        exec_selected.as_ref(),
        one_off_selected.as_ref(),
    )?;
    let current = journal::read_control(candidate, review)?;
    current.check_binding(&expected)?;
    if let Outcome::Cleaned { receipt } = &reply.result {
        if serde_json::to_vec(receipt).map_err(|_| refused())?
            != serde_json::to_vec(&current).map_err(|_| refused())?
        {
            return Err(refused());
        }
        pin.verify_retired()?;
    } else {
        pin.verify()?;
    }
    if let Outcome::Refused {
        code,
        stop_failures,
    } = reply.result
    {
        let mut error = refused().with_cause_code(code);
        error.stop_failures = stop_failures.map(Box::new);
        return Err(error);
    }
    serde_json::to_value(reply).map_err(|_| refused())
}
