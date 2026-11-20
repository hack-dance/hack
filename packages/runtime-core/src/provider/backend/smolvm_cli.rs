//! Released provider command transport. Lifecycle policy stays with the caller.
use crate::provider::{artifact, process, state::Owner};
use crate::{Candidate, CandidateError};
use std::{path::Path, time::Duration};

pub(in crate::provider) fn root(candidate: &Candidate) -> std::path::PathBuf {
    candidate.state_root.join("run/smolvm")
}
pub(in crate::provider) fn binary(candidate: &Candidate) -> std::path::PathBuf {
    artifact::root(candidate).join("smolvm-bin")
}

fn command(candidate: &Candidate, owner: &Owner) -> std::process::Command {
    let mut command = process::clean_command(&binary(candidate));
    command
        .current_dir(root(candidate).join("home"))
        .env("HOME", &owner.short_home)
        .env("TMPDIR", root(candidate).join("tmp"))
        .env("DOCKER_CONFIG", root(candidate).join("docker-config"))
        .env("SMOLVM_AGENT_ROOTFS", root(candidate).join("rootfs"))
        // Pinned Smol forwards this to the guest agent. Its automatic trim can
        // truncate imago backing files; retained disk identity requires exact size.
        .env("SMOLVM_DISK_TRIM", "0")
        .env("DYLD_LIBRARY_PATH", artifact::root(candidate).join("lib"));
    // All provider invocations (including start/recovery and private exec) use
    // this clean environment. DNS-learned answers must not reopen host/private
    // ranges; Smol's local default floor is insufficient for public egress modes.
    if matches!(
        &owner.network,
        crate::provider::NetworkIntent::ApprovedHosts { .. }
            | crate::provider::NetworkIntent::Internet
    ) {
        command.env("SMOLVM_EGRESS_FLOOR", "strict");
    }
    let policy = owner.reclamation.unwrap_or_default();
    command
        .env(
            "SMOLVM_BALLOON_RECLAIM",
            if policy.enabled { "1" } else { "0" },
        )
        .env(
            "SMOLVM_IDLE_RECLAIM",
            policy.idle_minutes.unwrap_or(0).to_string(),
        );
    // The provider reads this at `machine start`; it is set on every invocation so the pool's
    // provider processes agree. An ambient value never reaches the provider (clean command).
    if crate::provider::hot_reload::Choice::off(owner.hot_reload) {
        command.env(crate::provider::hot_reload::PROVIDER_SWITCH, "1");
    }
    command
}
pub(in crate::provider) fn invoke(
    candidate: &Candidate,
    owner: &Owner,
    args: &[&str],
) -> Result<String, CandidateError> {
    let output = process::capture(
        command(candidate, owner).args(args),
        Duration::from_secs(60),
    )?;
    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|_| CandidateError::new("provider_protocol", "Non-UTF8 provider response."));
    }
    // The provider's own last line, cleaned, travels with the failure so the CLI can show it.
    let shares = owner.project_shares();
    let roots: Vec<&Path> = shares.iter().map(|share| share.project.as_path()).collect();
    Err(crate::provider::provider_line::attach(
        failed_provider_command(&output),
        &output.stderr,
        candidate,
        &owner.short_home,
        &roots,
    ))
}

/// The error `process::run` gives a provider command that exited unsuccessfully, word for
/// word (a test compares them), built here because the whole stderr is needed as well.
fn failed_provider_command(output: &process::Captured) -> CandidateError {
    CandidateError::new(
        "provider_command_failed",
        format!(
            "Provider command exited {}; no automatic retry. {}",
            output.status,
            String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(8192)]).trim()
        ),
    )
}

/// Start only the host transport; the caller retains its existing guest identity and wait loop.
#[cfg(target_os = "macos")]
pub(in crate::provider) fn spawn_exec(
    candidate: &Candidate,
    owner: &Owner,
    arguments: &[&str],
) -> std::io::Result<std::process::Child> {
    use std::process::Stdio;
    command(candidate, owner)
        .args(["machine", "exec", "--name", &owner.machine, "--"])
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

#[cfg(test)]
#[path = "smolvm_cli_tests.rs"]
mod tests;
