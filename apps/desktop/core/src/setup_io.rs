//! Setup I/O, separate from the pure evidence model. No observer starts a service.
use crate::{
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
        let selected = self.runner.resolve_program().and_then(|p| {
            p.into_os_string()
                .into_string()
                .map_err(|_| crate::runner::RunError::Spawn("CLI path is not UTF-8".into()))
        });
        let context = crate::execution::ExecutionContext::capture(&self.runner);
        let runner = match (&selected, &context) {
            (Ok(program), Ok(context)) => context
                .runner(program)
                .map(|r| r.with_term_grace(Duration::from_secs(2))),
            (Err(e), _) => Err(e.to_string()),
            (_, Err(e)) => Err(e.clone()),
        };
        let runner = match runner {
            Ok(r) => r,
            Err(reason) => {
                let mut report = setup::derive(
                    Err(&reason),
                    None,
                    None,
                    None,
                    &[],
                    setup::Platform::current(),
                );
                report.force_cli_gate = matches!(selected, Err(crate::runner::RunError::NotFound));
                return report;
            }
        };
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
            let mut report = setup::derive(
                Err(&reason),
                None,
                None,
                None,
                &[],
                setup::Platform::current(),
            );
            report.force_cli_gate = matches!(cli, Err(crate::runner::RunError::NotFound));
            return report;
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
        // CLI projects writes the registry even with --no-daemon. Until R18,
        // only a matching daemon snapshot is allowed, including during setup.
        let client = self.effective_daemon(daemon.as_ref());
        let socket = client.as_ref().and_then(|d| d.status().ok());
        let mut projects = socket
            .as_ref()
            .filter(|s| cli.as_ref().is_ok_and(|v| v == &s.version))
            .and(client.as_ref())
            .and_then(|d| d.projects().ok());
        if let Some(p) = &mut projects {
            for row in p.projects.iter_mut().filter(|p| p.is_native()) {
                if row.status != "missing"
                    && let Some(root) = &row.repo_root
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
        report.cli_program = selected.ok();
        report.context = context.ok();
        setup::qualify_login(&mut report, daemon.as_ref());
        let restart = report
            .command(vec!["daemon".into(), "restart".into()])
            .and_then(|c| c.display())
            .ok();
        for card in &mut report.cards {
            if card.remedy == setup::Remedy::Copy("hack daemon restart".into()) {
                card.remedy = restart.clone().map(setup::Remedy::Copy).unwrap_or_else(|| {
                    setup::Remedy::Doc(
                        "https://github.com/hack-dance/hack/blob/next/docs/architecture.md#daemon"
                            .into(),
                    )
                });
            }
        }
        report
    }
}

/// Only these two fixed non-admin actions may run inside setup. Output is bounded
/// and memory-only. Callers must refresh evidence even after an exit of zero.
pub fn run_safe(action: SafeAction, checked: &Report) -> String {
    let execute = || -> Result<(String, String, Option<i32>), String> {
        if !checked.cli_ready()
            || !checked.cards.iter().any(|c| {
                c.remedy == setup::Remedy::Run(action) && c.status != setup::Status::Passed
            })
        {
            return Err("Action is not supported by the checked setup report".into());
        }
        let context = checked
            .context
            .as_ref()
            .ok_or("Execution context has not been checked")?;
        if action == SafeAction::InstallDaemon
            && let Some(why) = context.install_refusal()
        {
            return Err(why.into());
        }
        let runner = context.runner(
            checked
                .cli_program
                .as_deref()
                .ok_or("CLI has not been checked")?,
        )?;
        if action == SafeAction::InstallDaemon {
            let status = runner
                .run_json::<serde_json::Value>(
                    &["daemon", "status", "--json"],
                    None,
                    Duration::from_secs(5),
                )
                .map_err(|e| e.to_string())?;
            if let Some(why) = setup::installation_refusal(Some(&status), Some(context)) {
                return Err(format!("{why}; no install was attempted"));
            }
        }
        let mut args = action.args().to_vec();
        args.push("--no-interactive");
        runner
            .run_raw(&args, None, Duration::from_secs(120))
            .map_err(|e| e.to_string())
    };
    match execute() {
        Ok((out, err, code)) => format!(
            "Command exit: {code:?}. Checking fresh status.\n{}\n{}",
            bounded(&out),
            bounded(&err)
        ),
        Err(e) => format!("No supported action completed: {e}. Check again."),
    }
}
fn bounded(s: &str) -> String {
    s.chars().take(2048).collect()
}
