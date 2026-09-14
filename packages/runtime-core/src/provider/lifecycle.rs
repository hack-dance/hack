use super::{
    admission, agent, artifact, identity, process,
    state::{self, Owner, io},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::{
    fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    net::UnixStream,
};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub phase: String,
    pub profile: Option<super::Profile>,
    pub guest_memory_mib: Option<u32>,
    pub provider_memory: Option<identity::MemoryUsage>,
    pub qualification: &'static str,
    pub machine: Option<String>,
    pub process_alive: Option<bool>,
    pub engine_socket: Option<String>,
    pub persistent_disks_identified: bool,
    pub guest_boot_id: Option<String>,
}
fn root(candidate: &Candidate) -> std::path::PathBuf {
    candidate.state_root.join("run/smolvm")
}
fn binary(candidate: &Candidate) -> std::path::PathBuf {
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
        .env("DYLD_LIBRARY_PATH", artifact::root(candidate).join("lib"));
    command
}
fn invoke(candidate: &Candidate, owner: &Owner, args: &[&str]) -> Result<String, CandidateError> {
    process::run(
        command(candidate, owner).args(args),
        Duration::from_secs(60),
    )
}
fn phase(candidate: &Candidate, owner: &mut Owner, value: &str) -> Result<(), CandidateError> {
    owner.phase = value.into();
    owner.save(candidate)
}

fn provider_file(
    candidate: &Candidate,
    owner: &Owner,
    name: &str,
) -> Result<String, CandidateError> {
    let path = owner.real_data_dir(candidate)?.join(name);
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io)?;
    let m = file.metadata().map_err(io)?;
    if !m.is_file() || m.len() > 65536 || m.uid() != unsafe { libc::geteuid() } || m.nlink() != 1 {
        return Err(CandidateError::new(
            "foreign_state",
            "Unsafe provider metadata.",
        ));
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(io)?;
    Ok(text)
}
fn recorded_process(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<identity::ProcessIdentity, CandidateError> {
    let text = provider_file(candidate, owner, "agent.pid")?;
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
fn verify_live(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    let recorded = owner.process.as_ref().ok_or_else(|| {
        CandidateError::new(
            "process_identity_unavailable",
            "No independently retained provider identity.",
        )
    })?;
    if recorded_process(candidate, owner)? != *recorded {
        return Err(CandidateError::new(
            "process_identity_mismatch",
            "Provider PID file changed.",
        ));
    }
    identity::verify(
        recorded,
        &identity::observe(recorded.pid)?,
        &binary(candidate),
        unsafe { libc::geteuid() },
    )?;
    verify_disks(candidate, owner)
}
fn verify_disks(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    let directory = owner.real_data_dir(candidate)?;
    for (name, expected) in [
        ("storage.raw", &owner.storage),
        ("overlay.raw", &owner.overlay),
    ] {
        if let Some(expected) = expected {
            if identity::disk(&directory.join(name))? != *expected {
                return Err(CandidateError::new(
                    "disk_identity_mismatch",
                    "Owned disk identity changed; refusing lifecycle action.",
                ));
            }
        }
    }
    if provider_file(candidate, owner, "name")?.trim() != owner.machine {
        return Err(CandidateError::new(
            "foreign_state",
            "Provider machine name differs from receipt.",
        ));
    }
    Ok(())
}
fn socket(
    candidate: &Candidate,
    owner: &Owner,
    name: &str,
) -> Result<std::path::PathBuf, CandidateError> {
    let path = owner.real_data_dir(candidate)?.join(name);
    let m = fs::symlink_metadata(&path).map_err(io)?;
    if !m.file_type().is_socket() || m.uid() != unsafe { libc::geteuid() } {
        return Err(CandidateError::new(
            "foreign_state",
            "Expected a private owned Unix socket.",
        ));
    }
    // The short alias avoids sockaddr_un's limit; its target was verified by Owner::load.
    Ok(owner.data_dir().join(name))
}
fn guest(
    candidate: &Candidate,
    owner: &Owner,
    script: &str,
    args: &[&str],
    background: bool,
) -> Result<String, CandidateError> {
    verify_live(candidate, owner)?;
    let response = agent::exec(
        &socket(candidate, owner, "agent.sock")?,
        script,
        args,
        background,
    )?;
    verify_live(candidate, owner)?;
    Ok(response)
}

/// Read-only observation takes no mutation lease and detects lifecycle changes around each read.
pub(super) struct ObservedGuest<'a> {
    candidate: &'a Candidate,
    owner: Owner,
}

impl<'a> ObservedGuest<'a> {
    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        reject_aliased_state(&root(candidate))?;
        if !root(candidate)
            .join("owner.json")
            .try_exists()
            .map_err(io)?
        {
            return Err(CandidateError::new(
                "runtime_not_running",
                "The candidate runtime is not running.",
            ));
        }
        let observed = Self {
            candidate,
            owner: Owner::load(candidate)?,
        };
        observed.verify()?;
        audit_boot(candidate, &observed.owner)?;
        observed.verify()?;
        Ok(observed)
    }

    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        let current = Owner::load(self.candidate)?;
        if current.phase != "running"
            || current.guest_boot_id.is_none()
            || current.token != self.owner.token
            || current.guest_boot_id != self.owner.guest_boot_id
            || current.process != self.owner.process
        {
            return Err(CandidateError::new(
                "runtime_changed",
                "Runtime identity changed during read-only observation.",
            ));
        }
        verify_live(self.candidate, &current)
    }

    pub(super) fn engine_socket(&self) -> Result<std::path::PathBuf, CandidateError> {
        self.verify()?;
        socket(self.candidate, &self.owner, "docker.sock")
    }
}

pub(super) struct OwnedGuest<'a> {
    candidate: &'a Candidate,
    owner: Owner,
    _lock: state::Lock,
    guard: Option<(u64, std::cell::Cell<Instant>)>,
}

impl<'a> OwnedGuest<'a> {
    pub(super) fn engine_socket(&self) -> Result<std::path::PathBuf, CandidateError> {
        self.verify()?;
        socket(self.candidate, &self.owner, "docker.sock")
    }

    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        verify_live(self.candidate, &self.owner)
    }

    pub(super) fn before_effect(&self) -> Result<(), CandidateError> {
        if let Some((swapouts, last)) = &self.guard {
            if last.get().elapsed() >= Duration::from_secs(2) {
                let sample = admission::operating_sample()?;
                let usage = identity::memory_usage(
                    self.owner.process.as_ref().expect("verified process").pid,
                )?;
                admission::validate_operating(
                    &sample,
                    *swapouts,
                    usage.physical_footprint_bytes,
                    self.owner.profile,
                )?;
                last.set(Instant::now());
            }
        }
        Ok(())
    }

    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, true)
    }

    pub(super) fn connect_cleanup(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false)
    }

    fn connect_mode(
        candidate: &'a Candidate,
        enforce_budget: bool,
    ) -> Result<Self, CandidateError> {
        // Load before acquiring a lock: a read/transfer must not initialize absent state.
        reject_aliased_state(&root(candidate))?;
        if !root(candidate)
            .join("owner.json")
            .try_exists()
            .map_err(io)?
        {
            return Err(CandidateError::new(
                "runtime_not_running",
                "Start the owned candidate runtime before transferring source.",
            ));
        }
        let owner = Owner::load(candidate)?;
        if owner.phase != "running" || owner.guest_boot_id.is_none() {
            return Err(CandidateError::new(
                "runtime_not_running",
                "Start the owned candidate runtime before transferring source.",
            ));
        }
        let lock = state::Lock::acquire(&root(candidate))?;
        let current = Owner::load(candidate)?;
        if current.token != owner.token
            || current.phase != "running"
            || current.guest_boot_id != owner.guest_boot_id
        {
            return Err(CandidateError::new(
                "runtime_changed",
                "Runtime identity changed before transfer.",
            ));
        }
        verify_live(candidate, &current)?;
        audit_boot(candidate, &current)?;
        let guard = if enforce_budget && current.profile == super::Profile::Development {
            let sample = admission::operating_sample()?;
            let usage =
                identity::memory_usage(current.process.as_ref().expect("verified process").pid)?;
            admission::validate_operating(
                &sample,
                sample.swapouts,
                usage.physical_footprint_bytes,
                current.profile,
            )?;
            Some((sample.swapouts, std::cell::Cell::new(Instant::now())))
        } else {
            None
        };
        Ok(Self {
            candidate,
            owner: current,
            _lock: lock,
            guard,
        })
    }

    pub(super) fn incarnation(&self) -> &str {
        &self.owner.token
    }

    pub(super) fn boot_id(&self) -> &str {
        self.owner
            .guest_boot_id
            .as_deref()
            .expect("verified guest boot")
    }

    pub(super) fn execute(
        &self,
        script: &str,
        arguments: &[&str],
        input: Option<&str>,
    ) -> Result<String, CandidateError> {
        verify_live(self.candidate, &self.owner)?;
        self.before_effect()?;
        let script = format!(
            "set -eu\ntest \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$1\"\ntest \"$(cat /storage/.hack-local-owner)\" = \"$2\"\ntest \"$(findmnt -n -o FSTYPE --mountpoint /storage)\" = ext4\nshift 2\n{script}"
        );
        let mut args = vec![
            self.owner.guest_boot_id.as_deref().expect("checked boot"),
            &self.owner.token,
        ];
        args.extend_from_slice(arguments);
        let result = agent::exec_input(
            &socket(self.candidate, &self.owner, "agent.sock")?,
            &script,
            &args,
            false,
            input,
        )?;
        verify_live(self.candidate, &self.owner)?;
        Ok(result)
    }
}
fn audit_boot(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    // 1.14.3 consumes and removes boot-config.json. Its retained running config plus
    // independently observed disk descriptors form the host audit boundary.
    // Guest mount mode and executable digests are verified before engine startup.
    let config: Value =
        serde_json::from_str(&provider_file(candidate, owner, "agent.config.json")?).map_err(
            |_| {
                CandidateError::new(
                    "provider_protocol",
                    "Invalid retained provider configuration.",
                )
            },
        )?;
    let mounts = json!([{"source":artifact::engine_root(candidate),"target":"/opt/hack-engine","read_only":true,"staged":false}]);
    if config["version"] != 1
        || config["mounts"] != mounts
        || config["ports"] != json!([])
        || config["resources"]["cpus"] != owner.profile.cpus()
        || config["resources"]["memory_mib"] != owner.profile.memory_mib()
        || config["resources"]["network"] != false
        || config["resources"]["gpu"] != false
        || config["resources"]["cuda"] != false
        || config["resources"]["rosetta"] != false
        || config["resources"]["storage_gib"] != owner.profile.storage_gib()
        || config["resources"]["overlay_gib"] != owner.profile.overlay_gib()
        || config["forkable"] != false
    {
        return Err(CandidateError::new(
            "unaudited_provider_config",
            "Mounts, limits or capabilities differ from the candidate contract.",
        ));
    }
    let process = owner
        .process
        .as_ref()
        .expect("process retained before audit");
    let output = process::run(
        process::clean_command(Path::new("/usr/sbin/lsof")).args([
            "-n",
            "-P",
            "-p",
            &process.pid.to_string(),
            "-F",
            "n",
        ]),
        Duration::from_secs(5),
    )?;
    let opened: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter_map(|name| Path::new(name).canonicalize().ok())
        .collect();
    let directory = owner.real_data_dir(candidate)?;
    for expected in [directory.join("storage.raw"), directory.join("overlay.raw")] {
        if !opened.contains(&expected) {
            return Err(CandidateError::new(
                "unaudited_provider_config",
                format!(
                    "Provider does not hold the expected disk: {}",
                    expected.display()
                ),
            ));
        }
    }
    identity::verify(
        process,
        &identity::observe(process.pid)?,
        &binary(candidate),
        unsafe { libc::geteuid() },
    )?;
    Ok(())
}

pub fn status(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    if !root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        return Ok(RuntimeStatus {
            phase: "uninitialized".into(),
            profile: None,
            guest_memory_mib: None,
            provider_memory: None,
            qualification: "WU02-live-qualification-pending",
            machine: None,
            process_alive: Some(false),
            engine_socket: None,
            persistent_disks_identified: false,
            guest_boot_id: None,
        });
    }
    let owner = Owner::load(candidate)?;
    let alive = if let Some(process) = &owner.process {
        let alive = identity::alive(process.pid)?;
        if alive {
            verify_live(candidate, &owner)?;
        }
        Some(alive)
    } else if owner.phase == "initializing" {
        Some(false)
    } else {
        None
    };
    if owner.storage.is_some() {
        verify_disks(candidate, &owner)?;
    }
    Ok(RuntimeStatus {
        provider_memory: if alive == Some(true) {
            Some(identity::memory_usage(
                owner.process.as_ref().expect("live process").pid,
            )?)
        } else {
            None
        },
        profile: Some(owner.profile),
        guest_memory_mib: Some(owner.profile.memory_mib()),
        phase: if alive == Some(false) && owner.phase == "running" {
            "process-exited".into()
        } else {
            owner.phase.clone()
        },
        qualification: owner.profile.qualification(),
        machine: Some(owner.machine.clone()),
        process_alive: alive,
        engine_socket: Some(format!(
            "unix://{}",
            owner.data_dir().join("docker.sock").display()
        )),
        persistent_disks_identified: owner.storage.is_some(),
        guest_boot_id: owner.guest_boot_id,
    })
}

pub fn up(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    let profile = if root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        Owner::load(candidate)?.profile
    } else {
        super::Profile::Research
    };
    up_with_profile(candidate, profile)
}

pub fn up_with_profile(
    candidate: &Candidate,
    profile: super::Profile,
) -> Result<RuntimeStatus, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    if root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
        && Owner::load(candidate)?.profile != profile
    {
        return Err(CandidateError::new(
            "profile_conflict",
            "Existing capacity belongs to another profile. No resize, replacement or adoption was attempted.",
        ));
    }
    // Admission before locks, aliases, provider commands, disks or VM effects.
    let admission = admission::probe_for(&candidate.checkout, profile)?;
    if !admission.admitted {
        return Err(CandidateError::new(
            "admission_rejected",
            admission.reasons.join(" "),
        ));
    }
    let samples = admission::sample_for(&candidate.checkout, profile)?;
    artifact::verify(candidate)?;
    artifact::verify_engine(candidate)?;
    let _lock = state::Lock::acquire(&root(candidate))?;
    state::write(&root(candidate).join("admission.json"), &samples)?;
    let mut owner = Owner::create(candidate, profile)?;
    if owner.profile != profile {
        return Err(CandidateError::new(
            "profile_conflict",
            "Capacity profile changed before the operation lock was acquired.",
        ));
    }
    if owner.phase == "running" {
        verify_live(candidate, &owner)?;
        return status(candidate);
    }
    if ![
        "initializing",
        "stopped",
        "stopped-before-engine",
        "stopped-after-engine-failure",
        "recovered-unclean",
    ]
    .contains(&owner.phase.as_str())
    {
        return Err(CandidateError::new(
            "recovery_required",
            "Previous operation did not finish; inspect runtime status and recover before restarting.",
        ));
    }
    if let Some(process) = &owner.process {
        if identity::alive(process.pid)? {
            return Err(CandidateError::new(
                "process_identity_mismatch",
                "Previous PID is still alive; refusing restart or adoption.",
            ));
        }
        verify_disks(candidate, &owner)?;
    }
    prepare_rootfs(candidate, &mut owner)?;
    if !owner.created {
        phase(candidate, &mut owner, "creating")?;
        let mount = format!(
            "{}:/opt/hack-engine:ro",
            artifact::engine_root(candidate).display()
        );
        invoke(
            candidate,
            &owner,
            &[
                "machine",
                "create",
                "--name",
                &owner.machine,
                "--label",
                &format!("hack-local.owner={}", owner.token),
                "--cpus",
                &profile.cpus().to_string(),
                "--mem",
                &profile.memory_mib().to_string(),
                "--storage",
                &profile.storage_gib().to_string(),
                "--overlay",
                &profile.overlay_gib().to_string(),
                "--docker-socket",
                "--volume",
                &mount,
            ],
        )?;
        owner.created = true;
        owner.save(candidate)?;
    }
    // A fresh admission immediately before boot closes installation/lock delays.
    let admission = admission::probe_for(&candidate.checkout, profile)?;
    if !admission.admitted {
        phase(candidate, &mut owner, "stopped")?;
        return Err(CandidateError::new(
            "admission_rejected",
            admission.reasons.join(" "),
        ));
    }
    if admission.swapouts != samples.last().and_then(|sample| sample.swapouts) {
        phase(candidate, &mut owner, "stopped")?;
        return Err(CandidateError::new(
            "admission_rejected",
            "Swapouts changed after qualification; refusing boot.",
        ));
    }
    let previous_boot = owner.begin_boot();
    phase(candidate, &mut owner, "booting")?;
    invoke(
        candidate,
        &owner,
        &["machine", "start", "--name", &owner.machine],
    )?;
    let observed = recorded_process(candidate, &owner)?;
    identity::verify(
        &observed,
        &identity::observe(observed.pid)?,
        &binary(candidate),
        unsafe { libc::geteuid() },
    )?;
    owner.process = Some(observed);
    owner.save(candidate)?;
    let result = finish_boot(candidate, &mut owner, previous_boot.as_deref());
    if let Err(error) = &result {
        // Disk rejection must not keep an allocation alive. Process authority is
        // independent of disk adoption; this is an unclean stop, never reconciliation.
        let process = owner.process.as_ref().expect("process just recorded");
        let cleanup = stop_failed_boot(process, &binary(candidate));
        state::write(
            &root(candidate).join("failed-boot.json"),
            &json!({
                "failure_code": error.code, "process": process,
                "process_absent": cleanup.is_ok(), "disk_adoption": false,
            }),
        )?;
        if cleanup.is_ok() {
            phase(candidate, &mut owner, "failed-boot-stopped")?;
        }
        cleanup?;
    }
    result
}

fn stop_failed_boot(
    process: &identity::ProcessIdentity,
    binary: &Path,
) -> Result<(), CandidateError> {
    if !identity::alive(process.pid)? {
        return Ok(());
    }
    identity::terminate(process, binary)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while identity::alive(process.pid)? {
        if Instant::now() >= deadline {
            return Err(CandidateError::new(
                "stop_uncertain",
                "Verified failed-boot provider did not stop after SIGTERM.",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn verify_disk_allocation(
    storage: &identity::DiskIdentity,
    overlay: &identity::DiskIdentity,
    profile: super::Profile,
) -> Result<(), CandidateError> {
    if storage.bytes != u64::from(profile.storage_gib()) * 1024 * 1024 * 1024
        || overlay.bytes != u64::from(profile.overlay_gib()) * 1024 * 1024 * 1024
    {
        return Err(CandidateError::new(
            "disk_allocation_mismatch",
            "Provider disk sizes differ from the declared profile; refusing silent template-size fallback.",
        ));
    }
    Ok(())
}

fn finish_boot(
    candidate: &Candidate,
    owner: &mut Owner,
    previous_boot: Option<&str>,
) -> Result<RuntimeStatus, CandidateError> {
    audit_boot(candidate, owner)?;
    let dir = owner.real_data_dir(candidate)?;
    let storage = identity::disk(&dir.join("storage.raw"))?;
    let overlay = identity::disk(&dir.join("overlay.raw"))?;
    if owner.storage.as_ref().is_some_and(|v| *v != storage)
        || owner.overlay.as_ref().is_some_and(|v| *v != overlay)
    {
        return Err(CandidateError::new(
            "disk_identity_mismatch",
            "Disk identity changed during boot; refusing engine startup.",
        ));
    }
    verify_disk_allocation(&storage, &overlay, owner.profile)?;
    for name in ["storage.formatted", "overlay.formatted"] {
        let marker = fs::symlink_metadata(dir.join(name)).map_err(io)?;
        if !marker.is_file() || marker.nlink() != 1 || marker.uid() != unsafe { libc::geteuid() } {
            return Err(CandidateError::new(
                "disk_format_incomplete",
                "Provider disk format completion is not confirmed.",
            ));
        }
    }
    owner.storage = Some(storage);
    owner.overlay = Some(overlay);
    owner.save(candidate)?;
    agent::ping(&socket(candidate, owner, "agent.sock")?)?;
    phase(candidate, owner, "provisioning")?;
    let boot = guest(
        candidate,
        owner,
        include_str!("guest-setup.sh"),
        &[
            &owner.token,
            &owner.storage.as_ref().expect("storage verified").uuid,
            previous_boot.unwrap_or("new"),
            &artifact::digest(&artifact::engine_root(candidate).join("dockerd"))?,
            &artifact::digest(
                &artifact::root(candidate).join("agent-rootfs/usr/local/bin/smolvm-agent"),
            )?,
        ],
        false,
    )?;
    let boot = boot.trim();
    if boot.len() != 36 || !boot.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err(CandidateError::new(
            "guest_protocol",
            "Invalid boot identity.",
        ));
    }
    owner.guest_boot_id = Some(boot.to_owned());
    owner.save(candidate)?;
    super::network_tools::provision(candidate, &owner.token, &mut |script, args, input| {
        verify_live(candidate, owner)?;
        let guarded = format!(
            "set -eu\ntest \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$1\"\ntest \"$(cat /storage/.hack-local-owner)\" = \"$2\"\nshift 2\n{script}"
        );
        let mut arguments = vec![
            owner.guest_boot_id.as_deref().expect("verified boot"),
            &owner.token,
        ];
        arguments.extend_from_slice(args);
        let result = agent::exec_input(
            &socket(candidate, owner, "agent.sock")?,
            &guarded,
            &arguments,
            false,
            input,
        )?;
        verify_live(candidate, owner)?;
        Ok(result)
    })?;
    guest(candidate, owner, include_str!("guest-daemon.sh"), &[], true)?;
    let result = guest(
        candidate,
        owner,
        r#"set -eu
for attempt in $(seq 1 100); do
 if docker --host=unix:///run/hack-local/docker.sock info >/dev/null 2>&1; then
  pid=$(cat /run/hack-local/docker.pid)
  test "$(readlink /proc/$pid/exe)" = /opt/hack-engine/dockerd
  printf '%s %s\n' "$pid" "$(awk '{print $22}' /proc/$pid/stat)"
  exit 0
 fi
 sleep 0.1
done
for category in libnftables 'unknown flag' 'operation not supported' iptables 'permission denied' 'not found' 'protocol not supported'; do
 if tail -c 8192 /storage/hack-local-dockerd.log | grep -Fqi "$category"; then
  printf 'Engine startup log category: %s\n' "$category" >&2
 fi
done
exit 43"#,
        &[],
        false,
    )?;
    let fields: Vec<_> = result.split_whitespace().collect();
    if fields.len() != 2 {
        return Err(CandidateError::new(
            "guest_protocol",
            "Invalid engine identity.",
        ));
    }
    owner.daemon_pid = fields[0].parse::<u32>().ok().filter(|v| *v > 1);
    owner.daemon_start = fields[1].parse::<u64>().ok().filter(|v| *v > 0);
    if owner.daemon_pid.is_none() || owner.daemon_start.is_none() {
        return Err(CandidateError::new(
            "guest_protocol",
            "Missing engine identity.",
        ));
    }
    owner.save(candidate)?;
    engine_ping(&socket(candidate, owner, "docker.sock")?)?;
    phase(candidate, owner, "running")?;
    status(candidate)
}

fn prepare_rootfs(candidate: &Candidate, owner: &mut Owner) -> Result<(), CandidateError> {
    let templates = root(candidate).join("home/.smolvm");
    state::private_directory(&templates)?;
    for name in ["storage-template.ext4.zst", "overlay-template.ext4.zst"] {
        let target = templates.join(name);
        let source = artifact::root(candidate).join(name);
        if !target.try_exists().map_err(io)? {
            let mut input = File::open(&source).map_err(io)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&target)
                .map_err(io)?;
            std::io::copy(&mut input, &mut output).map_err(io)?;
            output.sync_all().map_err(io)?;
        }
        if fs::symlink_metadata(&target)
            .map_err(io)?
            .file_type()
            .is_symlink()
            || artifact::digest(&target)? != artifact::digest(&source)?
        {
            return Err(CandidateError::new(
                "artifact_digest_mismatch",
                "Private compressed disk template changed.",
            ));
        }
    }
    let destination = root(candidate).join("rootfs");
    reject_aliased_state(&destination)?;
    let data = owner.data_dir();
    let hash = data
        .file_name()
        .and_then(|v| v.to_str())
        .expect("machine hash");
    let marker = format!(".smolvm-ready.{hash}");
    if owner.rootfs_digest.is_none() {
        if destination.try_exists().map_err(io)? {
            return Err(CandidateError::new(
                "foreign_state",
                "Unclaimed runtime rootfs exists; refusing adoption.",
            ));
        }
        process::run(
            process::clean_command(Path::new("/bin/cp"))
                .args(["-RPp"])
                .arg(artifact::root(candidate).join("agent-rootfs"))
                .arg(&destination),
            Duration::from_secs(60),
        )?;
        let source_hash =
            artifact::rootfs_digest(&artifact::root(candidate).join("agent-rootfs"), None)?;
        if artifact::rootfs_digest(&destination, None)? != source_hash {
            return Err(CandidateError::new(
                "artifact_digest_mismatch",
                "Runtime rootfs copy differs from verified artifact.",
            ));
        }
        owner.rootfs_digest = Some(source_hash);
        owner.save(candidate)?;
    }
    if Some(artifact::rootfs_digest(&destination, Some(&marker))?) != owner.rootfs_digest {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Runtime guest base changed; refusing boot.",
        ));
    }
    Ok(())
}

fn engine_ping(path: &Path) -> Result<(), CandidateError> {
    let mut stream = UnixStream::connect(path).map_err(io)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(io)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(io)?;
    stream
        .write_all(b"GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .map_err(io)?;
    let mut response = String::new();
    stream
        .take(8192)
        .read_to_string(&mut response)
        .map_err(io)?;
    if !response.starts_with("HTTP/1.0 200 ") && !response.starts_with("HTTP/1.1 200 ") {
        return Err(CandidateError::new(
            "engine_not_ready",
            "Private engine ping failed.",
        ));
    }
    if !response.ends_with("\r\n\r\nOK") {
        return Err(CandidateError::new(
            "engine_not_ready",
            "Unexpected private engine response.",
        ));
    }
    Ok(())
}

pub fn down(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    // Status is read-only and idempotent down on an uninitialized pool creates nothing.
    let initial = status(candidate)?;
    if initial.phase == "uninitialized" {
        return Ok(initial);
    }
    artifact::verify(candidate)?;
    let _lock = state::Lock::acquire(&root(candidate))?;
    let mut owner = Owner::load(candidate)?;
    if [
        "stopped",
        "stopped-before-engine",
        "stopped-after-engine-failure",
        "recovered-unclean",
    ]
    .contains(&owner.phase.as_str())
        && initial.process_alive == Some(false)
    {
        return status(candidate);
    }
    verify_live(candidate, &owner)?;
    let before_engine = engine_was_not_started(
        &owner.phase,
        owner.guest_boot_id.as_deref(),
        owner.daemon_pid,
    );
    let failed_engine = owner.phase == "provisioning"
        && owner.daemon_pid.is_none()
        && owner.guest_boot_id.is_some();
    if failed_engine {
        guest(
            candidate,
            &owner,
            r#"set -eu
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
test ! -f /run/hack-local/docker.pid
! pidof dockerd
! pidof containerd
sync"#,
            &[&owner.token, owner.guest_boot_id.as_deref().unwrap_or("")],
            false,
        )?;
    }
    if !before_engine && !failed_engine && owner.phase != "stopping" {
        let daemon = owner
            .daemon_pid
            .ok_or_else(|| {
                CandidateError::new(
                    "recovery_required",
                    "Engine identity unavailable; cannot claim a clean stop.",
                )
            })?
            .to_string();
        let start = owner
            .daemon_start
            .ok_or_else(|| {
                CandidateError::new("recovery_required", "Engine start time unavailable.")
            })?
            .to_string();
        let quiesce_mode = if owner.phase == "quiescing" {
            "resume"
        } else {
            "initial"
        };
        phase(candidate, &mut owner, "quiescing")?;
        let quiescence = guest(
            candidate,
            &owner,
            include_str!("guest-quiesce.sh"),
            &[
                &owner.token,
                owner.guest_boot_id.as_deref().unwrap_or(""),
                &daemon,
                &start,
                quiesce_mode,
            ],
            false,
        )?;
        state::write(
            &root(candidate).join("quiescence.json"),
            &json!({
                "guest_boot_id": owner.guest_boot_id, "daemon_pid": owner.daemon_pid,
                "daemon_start": owner.daemon_start, "result": quiescence.trim()
            }),
        )?;
    }
    phase(candidate, &mut owner, "stopping")?;
    let response = agent::request(
        &socket(candidate, &owner, "agent.sock")?,
        json!({"method":"shutdown"}),
        Duration::from_secs(15),
    )?;
    if response["status"] != "ok" || response["data"]["shutdown"] != true {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Guest did not acknowledge flush/unmount.",
        ));
    }
    verify_live(candidate, &owner)?;
    let process = owner.process.as_ref().expect("live identity verified");
    // Revalidate immediately before signalling. macOS has no Linux pidfd equivalent;
    // this is cooperative same-user ownership, not hostile-process containment.
    identity::terminate(process, &binary(candidate))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while identity::alive(process.pid)? && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if identity::alive(process.pid)? {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Provider remains alive after TERM; no force-kill or false stopped receipt.",
        ));
    }
    finish_stopped(
        candidate,
        &mut owner,
        if before_engine {
            "stopped-before-engine"
        } else if failed_engine {
            "stopped-after-engine-failure"
        } else {
            "stopped"
        },
    )?;
    status(candidate)
}

fn finish_stopped(
    candidate: &Candidate,
    owner: &mut Owner,
    value: &str,
) -> Result<(), CandidateError> {
    if owner
        .process
        .as_ref()
        .map(|p| identity::alive(p.pid))
        .transpose()?
        .unwrap_or(true)
    {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Provider process absence is not established.",
        ));
    }
    let directory = owner.real_data_dir(candidate)?;
    let vm_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("vm.lock"))
        .map_err(io)?;
    let metadata = vm_lock.metadata().map_err(io)?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err(CandidateError::new("foreign_state", "Unsafe VM lock."));
    }
    use std::os::fd::AsRawFd;
    // Keep the exclusive VM lock through the stopped receipt; closing the FD releases it.
    if unsafe { libc::flock(vm_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Provider VM lock is still held.",
        ));
    }
    let handles = process::capture(
        process::clean_command(Path::new("/usr/sbin/lsof"))
            .args(["-n", "-P", "-t", "--"])
            .arg(directory.join("storage.raw"))
            .arg(directory.join("overlay.raw")),
        Duration::from_secs(5),
    )?;
    if handles.status.code() != Some(1) || !handles.stdout.is_empty() || !handles.stderr.is_empty()
    {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Cannot confirm that all handles to owned disks are closed.",
        ));
    }
    verify_disks(candidate, owner)?;
    if owner.storage.is_none() {
        owner.storage = Some(identity::disk(
            &owner.real_data_dir(candidate)?.join("storage.raw"),
        )?);
    }
    if owner.overlay.is_none() {
        owner.overlay = Some(identity::disk(
            &owner.real_data_dir(candidate)?.join("overlay.raw"),
        )?);
    }
    for name in ["agent.sock", "docker.sock"] {
        match UnixStream::connect(owner.data_dir().join(name)) {
            Ok(_) => {
                return Err(CandidateError::new(
                    "stop_uncertain",
                    "An owned socket still accepts connections.",
                ));
            }
            Err(error)
                if [Some(libc::ENOENT), Some(libc::ECONNREFUSED)]
                    .contains(&error.raw_os_error()) => {}
            Err(_) => {
                return Err(CandidateError::new(
                    "stop_uncertain",
                    "Cannot establish socket listener absence.",
                ));
            }
        }
    }
    for name in ["storage.raw", "overlay.raw"] {
        File::open(owner.real_data_dir(candidate)?.join(name))
            .map_err(io)?
            .sync_all()
            .map_err(io)?;
    }
    phase(candidate, owner, value)
}

pub fn recover(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    let initial = status(candidate)?;
    if initial.phase == "uninitialized" {
        return Ok(initial);
    }
    let _lock = state::Lock::acquire(&root(candidate))?;
    let mut owner = Owner::load(candidate)?;
    let process = owner.process.as_ref().ok_or_else(|| CandidateError::new("recovery_required","No retained process identity; manual inspection required. No state adopted or removed."))?;
    if identity::alive(process.pid)? {
        return Err(CandidateError::new(
            "recovery_required",
            "Recovery only accepts a confirmed dead recorded process. Use down for a verified live guest.",
        ));
    }
    finish_stopped(candidate, &mut owner, "recovered-unclean")?;
    status(candidate)
}

fn engine_was_not_started(phase: &str, boot: Option<&str>, daemon: Option<u32>) -> bool {
    ["booting", "provisioning", "stopping"].contains(&phase) && boot.is_none() && daemon.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "Manual owned M3 fixture only; requires explicit candidate root and host watchdog"]
    fn owned_provider_exit_recovery() {
        let path = std::env::var("HACK_LOCAL_CRASH_FIXTURE_ROOT").expect("explicit fixture root");
        let candidate = Candidate::discover(Path::new(&path)).unwrap();
        assert_eq!(status(&candidate).unwrap().phase, "stopped");
        let first = up(&candidate).unwrap();
        assert_eq!(recover(&candidate).unwrap_err().code, "recovery_required");
        let owner = Owner::load(&candidate).unwrap();
        verify_live(&candidate, &owner).unwrap();
        let recorded = owner.process.as_ref().unwrap();
        // Deliberately bypass guest/engine quiescence to exercise an unclean provider exit.
        // The normal adapter's native PID/start/UID/executable checks still gate the signal.
        identity::terminate(recorded, &binary(&candidate)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while identity::alive(recorded.pid).unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!identity::alive(recorded.pid).unwrap());
        assert_eq!(Owner::load(&candidate).unwrap().phase, "running");
        let recovered = recover(&candidate).unwrap();
        assert_eq!(recovered.phase, "recovered-unclean");
        assert_eq!(recovered.process_alive, Some(false));
        let second = up(&candidate).unwrap();
        assert_ne!(first.guest_boot_id, second.guest_boot_id);
        let after = Owner::load(&candidate).unwrap();
        assert_eq!(owner.token, after.token);
        assert_eq!(owner.storage, after.storage);
        assert_eq!(owner.overlay, after.overlay);
        assert_eq!(down(&candidate).unwrap().phase, "stopped");
        println!(
            "{}",
            json!({"provider_exit_recovered": true, "live_recovery_rejected": true,
            "first_boot": first.guest_boot_id, "second_boot": second.guest_boot_id,
            "data_marker_checked_on_reboot": true, "signal": "native-identity-verified SIGTERM without guest quiescence"})
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_boot_cleanup_stops_only_the_verified_process() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut sentinel = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let observed = identity::observe(child.id() as i32).unwrap();
        let reaper = std::thread::spawn(move || child.wait().unwrap());
        stop_failed_boot(&observed, &observed.executable).unwrap();
        reaper.join().unwrap();
        assert!(!identity::alive(observed.pid).unwrap());
        assert!(sentinel.try_wait().unwrap().is_none());
        sentinel.kill().unwrap();
        sentinel.wait().unwrap();
    }

    #[test]
    fn disk_template_fallback_cannot_exceed_the_declared_profile() {
        let disk = |gib: u64| identity::DiskIdentity {
            device: 1,
            inode: 1,
            bytes: gib * 1024 * 1024 * 1024,
            uuid: "fixture".into(),
        };
        assert!(
            verify_disk_allocation(&disk(32), &disk(10), super::super::Profile::Development)
                .is_ok()
        );
        assert!(
            verify_disk_allocation(&disk(4), &disk(10), super::super::Profile::Research).is_err()
        );
        assert!(
            verify_disk_allocation(&disk(32), &disk(12), super::super::Profile::Development)
                .is_err()
        );
    }

    #[test]
    fn failed_setup_before_the_boot_receipt_can_stop_without_a_daemon() {
        assert!(engine_was_not_started("booting", None, None));
        assert!(engine_was_not_started("provisioning", None, None));
        assert!(engine_was_not_started("stopping", None, None));
        assert!(!engine_was_not_started("provisioning", Some("boot"), None));
        assert!(!engine_was_not_started("running", Some("boot"), Some(42)));
        assert!(!engine_was_not_started("unknown", None, None));
    }
}
