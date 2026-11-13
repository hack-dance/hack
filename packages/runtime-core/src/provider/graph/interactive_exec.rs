//! Exact interactive admission followed by a lease-free terminal lifetime.
use crate::{Candidate, CandidateError};
use std::os::fd::OwnedFd;

pub struct Options<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub owner: &'a str,
    pub plan: &'a str,
    pub namespace: &'a str,
    pub native: bool,
    pub argv: &'a [String],
    pub workdir: Option<&'a str>,
    pub expected_container: Option<&'a str>,
    pub expected_generation: Option<&'a str>,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "interactive_exec_refused",
        "Interactive exec requires a current ready service, exact ownership and a foreground terminal; no fallback was attempted.",
    )
}
impl Options<'_> {
    pub fn validate(&self) -> Result<(), CandidateError> {
        if !super::hex(self.run, 32)
            || !super::hex(self.owner, 32)
            || !super::hex(self.plan, 64)
            || !super::hex(self.namespace, 64)
            || self.service.is_empty()
            || self.service.len() > 128
            || !self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || self.argv.is_empty()
            || self.argv.len() > 256
            || self.argv[0].is_empty()
            || self
                .argv
                .iter()
                .any(|s| s.len() > 16384 || s.contains('\0'))
            || self.argv.iter().map(String::len).sum::<usize>() > 65536
            || self
                .workdir
                .is_some_and(|s| !s.starts_with('/') || s.len() > 4096 || s.contains('\0'))
            || self
                .expected_container
                .is_some_and(|id| !super::hex(id, 64))
            || self
                .expected_generation
                .is_some_and(|id| !super::hex(id, 64))
            || self.expected_container.is_some() != self.expected_generation.is_some()
        {
            return Err(refused());
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct Completion {
    pub exit_code: i32,
    pub session: String,
    pub retained: bool,
}
pub fn execute(
    candidate: &Candidate,
    options: &Options<'_>,
    frontend: OwnedFd,
) -> Result<Completion, CandidateError> {
    options.validate()?;
    #[cfg(target_os = "macos")]
    {
        native(candidate, options, frontend)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (candidate, frontend);
        Err(CandidateError::new(
            "interactive_exec_platform",
            "Native interactive exec requires macOS.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn native(
    candidate: &Candidate,
    options: &Options<'_>,
    frontend: OwnedFd,
) -> Result<Completion, CandidateError> {
    use crate::provider::{
        engine::{Observer, interactive_exec},
        interactive_session,
        interactive_terminal::{Leash, Terminal},
        managed_environment,
    };
    use std::time::{Duration, Instant};
    let mut terminal = Terminal::open()?;
    let ingress = Instant::now();
    let (leash, payload) = Leash::receive(frontend)?;
    if options.native && !payload.is_empty() {
        return Err(refused());
    }
    let managed = if payload.is_empty() {
        None
    } else {
        if options.expected_container.is_none() {
            return Err(refused());
        }
        Some(managed_environment::receive_interactive_bytes(
            &payload,
            options.plan,
            options.run,
            ingress,
        )?)
    };
    drop(payload);
    leash.check()?;
    let _ = interactive_session::reconcile_observed(candidate);
    // Capture before either owner admission or Engine create/start, so even a
    // command which exits immediately observes the initial terminal dimensions.
    let (rows, cols) = terminal.size()?;
    let console_size = [rows, cols];
    let admission = if options.native {
        #[cfg(feature = "native-config-plan")]
        {
            super::native::foreground::interactive(candidate, options, console_size, &leash)
        }
        #[cfg(not(feature = "native-config-plan"))]
        {
            return Err(refused());
        }
    } else {
        let selected = super::service_selection(candidate, options.run, options.service)?;
        if selected.owner != options.owner
            || selected.plan != options.plan
            || selected.namespace != options.namespace
            || options
                .expected_container
                .is_some_and(|v| v != selected.container)
            || options
                .expected_generation
                .is_some_and(|v| v != selected.generation)
        {
            return Err(refused());
        }
        super::service_exec::interactive(
            candidate,
            &super::ServiceExecOptions {
                run: options.run,
                service: options.service,
                expected_container: &selected.container,
                expected_boot: &selected.boot,
                expected_generation: &selected.generation,
                argv: options.argv,
                workdir: options.workdir,
                timeout: Duration::from_secs(30),
            },
            console_size,
            managed.as_ref(),
            &|| leash.check(),
        )
    };
    let mut attached = admission?;
    let receipt = &attached.receipt;
    let result = (|| {
        leash.check()?;
        if let Some(managed) = &managed {
            interactive_exec::deliver(
                &mut attached.stream,
                managed.values().get(options.service).ok_or_else(refused)?,
                managed.deadline(),
                &|| leash.check(),
            )?;
        }
        drop(managed);
        let observer = Observer::connect(candidate)?;
        crate::provider::interactive_terminal::with_resize_worker(
            |rows, cols| {
                let _ = observer.interactive_resize(receipt, rows, cols);
            },
            |resize| {
                terminal.relay(&mut attached.stream, &leash, &mut |rows, cols| {
                    resize(rows, cols)
                })
            },
        )?;
        observer.interactive_exit(receipt)
    })();
    terminal.restore()?;
    drop(attached.stream);
    let _ = interactive_session::reconcile_observed(candidate);
    let remains = interactive_session::retained(candidate)?
        .iter()
        .any(|r| r.session == receipt.session);
    result
        .map(|exit_code| Completion {
            exit_code,
            session: receipt.session.clone(),
            retained: remains,
        })
        .map_err(|error| error.with_session(&receipt.session))
}
