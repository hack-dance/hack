//! Released provider command transport. Lifecycle policy stays with the caller.
use super::{FreshCreate, MachineSpec, StartPermit, VmBackend};
use crate::provider::{artifact, identity, process, state::Owner};
use crate::{Candidate, CandidateError};
use std::{path::Path, time::Duration};

/// Released CLI bound to the lifecycle owner's existing machine and launch environment.
/// The receipt is an implementation detail, never part of the backend trait.
pub(in crate::provider::lifecycle) struct SmolvmCli<'a> {
    candidate: &'a Candidate,
    owner: &'a Owner,
}

impl<'a> SmolvmCli<'a> {
    pub(in crate::provider::lifecycle) fn new(candidate: &'a Candidate, owner: &'a Owner) -> Self {
        Self { candidate, owner }
    }

    fn invoke(&self, arguments: &[&str]) -> Result<(), CandidateError> {
        invoke(self.candidate, self.owner, arguments).map(drop)
    }
}

impl VmBackend for SmolvmCli<'_> {
    fn create(&self, spec: &MachineSpec, _fresh: FreshCreate) -> Result<(), CandidateError> {
        let arguments = create_arguments(&self.owner.machine, &self.owner.token, spec)?;
        self.invoke(&arguments.iter().map(String::as_str).collect::<Vec<_>>())
    }

    fn start(&self, _permit: StartPermit) -> Result<identity::ProcessIdentity, CandidateError> {
        self.invoke(&["machine", "start", "--name", &self.owner.machine])?;
        self.recorded_process()
    }

    fn recorded_process(&self) -> Result<identity::ProcessIdentity, CandidateError> {
        let text = super::super::provider_file(self.candidate, self.owner, "agent.pid")?;
        parse_recorded_process(self.candidate, &text)
    }

    fn stop(&self) -> Result<(), CandidateError> {
        self.invoke(&["machine", "stop", "--name", &self.owner.machine])
    }

    fn delete_forced(&self) -> Result<(), CandidateError> {
        self.invoke(&[
            "machine",
            "delete",
            "--name",
            &self.owner.machine,
            "--force",
        ])
    }

    fn enable_translation(&self) -> Result<(), CandidateError> {
        self.invoke(&[
            "machine",
            "update",
            "--name",
            &self.owner.machine,
            "--rosetta",
        ])
    }
}

// A record is a claim from the provider, not independent proof of a live process.
fn parse_recorded_process(
    candidate: &Candidate,
    text: &str,
) -> Result<identity::ProcessIdentity, CandidateError> {
    let lines: Vec<_> = text.lines().collect();
    let pid = lines.first().and_then(|s| s.parse::<i32>().ok());
    let start = lines.get(1).and_then(|s| s.parse::<u64>().ok());
    let (Some(pid), Some(start)) = (pid, start) else {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "SmolVM PID record must include native start time.",
        ));
    };
    if lines.len() != 2 || start == 0 {
        return Err(CandidateError::new(
            "process_identity_unavailable",
            "Ambiguous SmolVM PID record.",
        ));
    }
    Ok(identity::ProcessIdentity {
        pid,
        start_micros: start,
        uid: unsafe { libc::geteuid() },
        executable: binary(candidate),
    })
}

// BEGIN provider create arguments
fn create_arguments(
    machine: &str,
    token: &str,
    spec: &MachineSpec,
) -> Result<Vec<String>, CandidateError> {
    let mut arguments = vec![
        "machine".to_owned(),
        "create".into(),
        "--name".into(),
        machine.into(),
        "--label".into(),
        format!("hack-local.owner={token}"),
        "--cpus".into(),
        spec.cpus.to_string(),
        "--mem".into(),
        spec.memory_mib.to_string(),
        "--storage".into(),
        spec.storage_gib.to_string(),
        "--overlay".into(),
        spec.overlay_gib.to_string(),
    ];
    if let Some(engine) = &spec.engine_share {
        arguments.extend([
            "--docker-socket".into(),
            "--volume".into(),
            format!("{}:/opt/hack-engine:ro", engine.display()),
        ]);
    }
    if spec.amd64_translation {
        arguments.push("--rosetta".into());
    }
    for share in &spec.project_shares {
        share.validate()?;
        arguments.extend(["--volume".into(), share.argument()]);
    }
    arguments.extend(spec.network.arguments());
    for path in &spec.exposed_sockets {
        arguments.extend(["--expose-socket".into(), path.clone()]);
    }
    for (host, guest) in &spec.mounted_sockets {
        arguments.extend([
            "--mount-socket".into(),
            format!("{}:{guest}", host.display()),
        ]);
    }
    Ok(arguments)
}
// END provider create arguments

pub(in crate::provider::lifecycle) fn root(candidate: &Candidate) -> std::path::PathBuf {
    candidate.state_root.join("run/smolvm")
}
pub(in crate::provider::lifecycle) fn binary(candidate: &Candidate) -> std::path::PathBuf {
    artifact::root(candidate).join("smolvm-bin")
}

// BEGIN provider command environment
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
// END provider command environment
fn invoke(candidate: &Candidate, owner: &Owner, args: &[&str]) -> Result<String, CandidateError> {
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
pub(in crate::provider::lifecycle) fn spawn_exec(
    candidate: &Candidate,
    owner: &Owner,
    arguments: &[&str],
) -> std::io::Result<std::process::Child> {
    use std::process::Stdio;
    process::spawn_child(
        command(candidate, owner)
            .args(["machine", "exec", "--name", &owner.machine, "--"])
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
}

#[cfg(test)]
#[path = "smolvm_cli_tests.rs"]
mod tests;
