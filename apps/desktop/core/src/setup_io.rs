//! Setup I/O, separate from the pure evidence model. No observer starts a service.
use crate::{
    runner::CliRunner,
    setup::{self, Report, SafeAction},
    source::{DoctorTarget, LiveSource},
};
use std::time::{Duration, Instant};

impl LiveSource {
    /// One bounded setup refresh, including native observations and doctor.
    pub fn read_setup(&self) -> Report {
        self.read_setup_within(Duration::from_secs(120))
    }

    /// Budget seam for bounded adapter tests; live callers use `read_setup`.
    pub fn read_setup_within(&self, budget: Duration) -> Report {
        let deadline = Instant::now() + budget;
        let left = || {
            deadline
                .saturating_duration_since(Instant::now())
                .saturating_sub(Duration::from_secs(2))
        };
        let runner = self
            .runner
            .clone()
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .with_term_grace(Duration::from_secs(2));
        let cli = if left().is_zero() {
            Err(crate::runner::RunError::Timeout { after: budget })
        } else {
            runner.version(Duration::from_secs(5).min(left()))
        };
        // Missing CLI is decisive; no reason to attempt other subprocesses.
        if cli.is_err() {
            let reason = cli
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default();
            return setup::derive(
                Err(&reason),
                None,
                None,
                None,
                &[],
                setup::Platform::current(),
            );
        }
        // CLI projects writes the registry even with --no-daemon. Until R18,
        // only a matching daemon snapshot is allowed, including during setup.
        let socket = self.daemon.as_ref().and_then(|d| d.status().ok());
        let mut projects = socket
            .as_ref()
            .filter(|s| cli.as_ref().is_ok_and(|v| v == &s.version))
            .and(self.daemon.as_ref())
            .and_then(|d| d.projects().ok());
        if let Some(p) = &mut projects {
            for row in p.projects.iter_mut().filter(|p| p.is_native()) {
                if let Some(root) = &row.repo_root
                    && !left().is_zero()
                {
                    row.native = runner
                        .clone()
                        .with_env("HACK_RUNTIME_BACKEND", "native")
                        .run_json(
                            &["ps", "--json"],
                            Some(std::path::Path::new(root)),
                            Duration::from_secs(10).min(left()),
                        )
                        .ok();
                }
            }
        }
        let daemon = if left().is_zero() {
            None
        } else {
            runner
                .run_json::<serde_json::Value>(
                    &["daemon", "status", "--json"],
                    None,
                    Duration::from_secs(5).min(left()),
                )
                .ok()
        };
        let targets = projects
            .as_ref()
            .map(DoctorTarget::from_projects)
            .unwrap_or_default();
        let observer = LiveSource {
            runner,
            daemon: None,
        };
        let runs = observer.doctor_runs_within(
            &targets,
            Duration::from_secs(90).min(left()),
            Duration::from_secs(60),
        );
        let mut report = setup::derive(
            cli.as_deref().map_err(|_| "CLI unavailable"),
            projects.as_ref(),
            socket.as_ref().map(|d| d.version.as_str()),
            daemon.as_ref(),
            &runs,
            setup::Platform::current(),
        );
        report.cli_program = observer
            .runner
            .resolve_program()
            .ok()
            .and_then(|p| p.into_os_string().into_string().ok());
        if let Some(program) = &report.cli_program {
            for card in &mut report.cards {
                if card.remedy == setup::Remedy::Copy("hack daemon restart".into()) {
                    card.remedy = setup::Remedy::Copy(
                        crate::terminal::CommandSpec {
                            program: program.clone(),
                            args: vec!["daemon".into(), "restart".into()],
                        }
                        .display()
                        .unwrap_or_else(|_| "CLI command unavailable".into()),
                    );
                }
            }
        }
        report
    }
}

/// Only these two fixed non-admin actions may run inside setup. Output is bounded
/// and memory-only. Callers must refresh evidence even after an exit of zero.
pub fn run_safe(runner: &CliRunner, action: SafeAction) -> String {
    let mut args = action.args().to_vec();
    args.push("--no-interactive");
    match runner
        .clone()
        .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .run_raw(&args, None, Duration::from_secs(120))
    {
        Ok((out, err, code)) => format!(
            "Command exit: {code:?}. Checking fresh status.\n{}\n{}",
            bounded(&out),
            bounded(&err)
        ),
        Err(e) => format!("Command could not finish: {e}. Checking fresh status."),
    }
}
fn bounded(s: &str) -> String {
    s.chars().take(2048).collect()
}
