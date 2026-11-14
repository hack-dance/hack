//! Bounded CLI-only adapters. No file bytes, keys, automatic updates or admin fixes.
use crate::{runner::CliRunner, source::LiveSource, upgrade::*};
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
pub fn check(source: &LiveSource) -> Result<Observation, String> {
    let report: Report = read(&source.runner, &["upgrade", "check", "--json"])?;
    if report.report_version != 1 {
        return Err("This upgrade report version is not supported".into());
    }
    Ok(Observation {
        cli_program: source
            .runner
            .resolve_program()
            .map_err(|_| "CLI unavailable")?
            .to_string_lossy()
            .into_owned(),
        cli: source
            .runner
            .clone()
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .with_cwd("/")
            .version(Duration::from_secs(5))
            .ok(),
        daemon: source
            .daemon
            .as_ref()
            .and_then(|d| d.status().ok())
            .map(|d| d.version),
        // No verified R14 install/target evidence: never probe update --check or
        // infer Homebrew ownership from PATH/current version. No daily poll.
        app: None,
        report: Some(report),
    })
}
pub fn snapshot(runner: &CliRunner) -> Result<Snapshot, String> {
    read(runner, &["upgrade", "snapshot", "--json"])
}
pub fn rollback(runner: &CliRunner, snapshot: &Snapshot) -> Result<Rollback, String> {
    let path = snapshot
        .manifest()
        .ok_or("A complete snapshot is required")?;
    // No --overwrite. The CLI owns validation and conflict preservation.
    read(
        runner,
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
