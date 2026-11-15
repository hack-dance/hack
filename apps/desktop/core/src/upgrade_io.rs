//! Bounded CLI-only adapters. No file bytes, keys, automatic updates or admin fixes.
use crate::{
    execution::ExecutionContext,
    runner::CliRunner,
    source::{LiveSource, ProbeTools, trusted_probe_path},
    upgrade::*,
};
use serde::de::DeserializeOwned;
use std::time::Duration;

/// Accept valid success envelopes even when readiness exits nonzero. Bare JSON,
/// signals, unsupported report versions and error envelopes are not observations.
pub fn read<T: DeserializeOwned>(runner: &CliRunner, args: &[&str]) -> Result<T, String> {
    let (stdout, _, code) = runner
        .clone()
        .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .with_cwd("/")
        .run_raw(args, None, Duration::from_secs(60))
        .map_err(|_| "The CLI read failed or timed out".to_owned())?;
    if code.is_none() {
        return Err("The CLI was interrupted before confirming a result".into());
    }
    #[derive(serde::Deserialize)]
    struct Envelope<T> {
        ok: bool,
        data: Option<T>,
    }
    let envelope: Envelope<T> = serde_json::from_str(&stdout)
        .map_err(|_| "The CLI returned an invalid upgrade report".to_owned())?;
    if !envelope.ok {
        return Err("The CLI refused this upgrade operation".into());
    }
    envelope
        .data
        .ok_or_else(|| "The CLI returned no upgrade report".into())
}
/// One checked CLI operation: the resolved executable, the non-secret
/// execution context it runs with, and a runner bound to both plus Doctor's
/// private tool PATH. The wrapper directory lives as long as this value, so
/// keep it alive until every child of the operation has exited.
struct Checked {
    runner: CliRunner,
    program: String,
    context: ExecutionContext,
    _tools: ProbeTools,
}

/// Bind the selected CLI to the checked context. Its children (docker, git
/// and other tools) resolve only through wrappers for executables no other
/// user can change, with interpreter startup variables removed. Anything
/// that cannot be established refuses the operation before the CLI runs.
fn checked(source: &LiveSource) -> Result<Checked, String> {
    let program = source
        .runner
        .resolve_program()
        .map_err(|_| "The Hack CLI is unavailable or in a location other users can change")?
        .into_os_string()
        .into_string()
        .map_err(|_| "The Hack CLI path is not UTF-8")?;
    let context = ExecutionContext::capture(&source.runner)?;
    let tools = trusted_probe_path(std::ffi::OsStr::new(
        context.value("PATH").unwrap_or_default(),
    ))
    .map_err(|_| "Could not prepare a private tool PATH, so the CLI was not run")?;
    if tools.coverage.is_some() {
        return Err(
            "PATH has too many entries to check every tool, so the CLI was not run. Shorten PATH, then check again."
                .into(),
        );
    }
    if !tools.unchecked.is_empty() {
        let names = tools
            .unchecked
            .iter()
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "These tools on PATH are in locations other users can change: {names}. The CLI was not run. Fix their permissions or remove them from PATH, then check again."
        ));
    }
    let tool_path = tools
        .path()
        .to_str()
        .ok_or("The private tool PATH is not UTF-8, so the CLI was not run")?
        .to_owned();
    // `upgrade check` runs `git ls-files` in registered checkouts: apply
    // Doctor's Git overrides so repository config cannot run fsmonitor or hooks.
    let runner = crate::source::git_reads_only(
        context
            .runner(&program)?
            .with_env("PATH", &tool_path)
            .without_interpreter_startup()
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .with_cwd("/"),
    );
    // The checks call docker and the native runtime too: apply Doctor's
    // helper and Docker preflight (local socket only, checked plugins and
    // helpers) before anything runs, and pin the checked native runtime.
    let native = crate::doctor_plugins::validate_helpers(&runner)
        .and_then(|pin| {
            crate::doctor_plugins::validate(&crate::doctor_plugins::Discovery::from_runner(&runner))
                .map(|()| pin)
        })
        .map_err(|why| format!("{why}. The CLI was not run."))?;
    let runner = native.apply(runner, std::path::Path::new(tools.path()));
    Ok(Checked {
        runner,
        program,
        context,
        _tools: tools,
    })
}

pub fn check(source: &LiveSource) -> Result<Observation, String> {
    let checked = checked(source)?;
    let report: Report = read(&checked.runner, &["upgrade", "check", "--json"])?;
    if report.report_version != REPORT_VERSION {
        return Err("This upgrade report version is not supported".into());
    }
    let cli = checked.runner.version(Duration::from_secs(5)).ok();
    // The injected client is a test seam; a normal launch finds the socket
    // in the selected CLI's own read-only `daemon status` answer.
    let status = checked
        .runner
        .run_raw(
            &["daemon", "status", "--json"],
            None,
            Duration::from_secs(5),
        )
        .ok()
        .and_then(|(out, _, _)| serde_json::from_str::<serde_json::Value>(&out).ok());
    let daemon = source
        .effective_daemon(status.as_ref())
        .and_then(|d| d.status().ok())
        .map(|d| d.version);
    Ok(Observation {
        cli_program: checked.program,
        cli,
        daemon,
        // No verified R14 install/target evidence: never probe update --check or
        // infer Homebrew ownership from PATH/current version. No daily poll.
        app: None,
        report: Some(report),
        // Copied commands carry the same home, backend and guards as this read.
        context: Some(checked.context),
    })
}
pub fn snapshot(source: &LiveSource) -> Result<Snapshot, String> {
    let checked = checked(source)?;
    read(&checked.runner, &["upgrade", "snapshot", "--json"])
}
pub fn rollback(source: &LiveSource, snapshot: &Snapshot) -> Result<Rollback, String> {
    let path = snapshot
        .manifest()
        .ok_or("A complete snapshot is required")?;
    let checked = checked(source)?;
    // No --overwrite. The CLI owns validation and conflict preservation.
    read(
        &checked.runner,
        &["upgrade", "rollback", "--rollback-manifest", path, "--json"],
    )
}

/// Observe an installed cask only after installation ownership is verified by
/// R14. The caller supplies the discovered Homebrew runner; live discovery is
/// intentionally not wired yet. Tests inject a fake; live Homebrew is not called.
pub fn installed_app(runner: &CliRunner) -> Result<String, String> {
    let (stdout, _, exit) = runner
        .run_raw(
            &["info", "--json=v2", "--cask", "hack-desktop"],
            None,
            Duration::from_secs(15),
        )
        .map_err(|_| "Could not read the installed app version")?;
    if exit != Some(0) {
        return Err("Could not read the installed app version".into());
    }
    #[derive(serde::Deserialize)]
    struct Info {
        casks: Vec<Cask>,
    }
    #[derive(serde::Deserialize)]
    struct Cask {
        token: String,
        installed: Option<String>,
    }
    let info: Info = serde_json::from_str(&stdout).map_err(|_| "Invalid installed app report")?;
    match info.casks.as_slice() {
        [cask] if cask.token == "hack-desktop" => cask
            .installed
            .clone()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "App is not installed".into()),
        _ => Err("Installed app identity is unknown".into()),
    }
}
