mod admission_pool;
pub mod host_filesystem;
mod interrupted;
mod prepared_boot;
#[cfg(any(target_os = "macos", test))]
mod private_child;
mod relay_process;
mod short_home;
use super::{
    admission, agent, artifact, identity, process,
    state::{self, Owner, io},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
pub use prepared_boot::{
    Built as PreparedBaseBuilt, build_prepared_base, prepared_base_status, remove_prepared_base,
    verify_prepared_base,
};
#[cfg(target_os = "macos")]
pub(super) use private_child::{RelayChild, RelayLaunch};
pub(super) use relay_process::RelayProcess;
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
    pub network: Option<super::NetworkIntent>,
    pub project_share: Option<super::ProjectShareIntent>,
    pub application_bridge: Option<super::BridgeIntent>,
    pub dependency_sockets: Option<super::DependencySocketIntent>,
    pub dependency_socket_observations: Vec<super::DependencySocketObservation>,
    pub phase: String,
    pub profile: Option<super::Profile>,
    pub reclamation: Option<state::ReclamationPolicy>,
    pub guest_memory_mib: Option<u32>,
    pub provider_memory: Option<identity::MemoryUsage>,
    pub provider_resources: Option<super::resources::ResourceTree>,
    pub qualification: &'static str,
    pub machine: Option<String>,
    pub process_alive: Option<bool>,
    pub engine_socket: Option<String>,
    pub persistent_disks_identified: bool,
    pub guest_boot_id: Option<String>,
    /// Prepared-base selection and activation, for pools that requested one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_base: Option<super::prepared_start::Status>,
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
        // Pinned Smol forwards this to the guest agent. Its automatic trim can
        // truncate imago backing files; retained disk identity requires exact size.
        .env("SMOLVM_DISK_TRIM", "0")
        .env("DYLD_LIBRARY_PATH", artifact::root(candidate).join("lib"));
    // All provider invocations (including start/recovery and private exec) use
    // this clean environment. DNS-learned answers must not reopen host/private
    // ranges; Smol's local default floor is insufficient for public egress modes.
    if matches!(
        &owner.network,
        super::NetworkIntent::ApprovedHosts { .. } | super::NetworkIntent::Internet
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
    command
}
fn boot_reclamation_policy() -> state::ReclamationPolicy {
    #[cfg(test)]
    if let Ok(value) = std::env::var("HACK_LOCAL_TEST_RECLAIM") {
        if value == "0" || value == "1" {
            return state::ReclamationPolicy {
                enabled: value == "1",
                idle_minutes: None,
            };
        }
    }
    state::ReclamationPolicy::default()
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
pub(super) fn recorded_process(
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
pub(super) fn verify_live(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
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
pub(super) fn verify_disks(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
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

/// Retry only acquisition, never the verification callback or an admitted effect.
/// The callback runs under the acquired lease and must reload current identity.
fn operation_lease<T>(
    root: &Path,
    deadline: Option<Instant>,
    verify: impl FnOnce() -> Result<T, CandidateError>,
) -> Result<(state::Lock, T), CandidateError> {
    let lock = loop {
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(CandidateError::new(
                "provider_busy",
                "Provider lease acquisition deadline expired; no operation was admitted.",
            ));
        }
        match state::Lock::acquire(root) {
            Ok(lock) => break lock,
            Err(error) if error.code == "provider_busy" && deadline.is_some() => {
                let remaining = deadline
                    .expect("bounded acquisition")
                    .saturating_duration_since(Instant::now());
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
            Err(error) => return Err(error),
        }
    };
    let current = verify()?;
    Ok((lock, current))
}

/// How long ordinary startup waits for a provider lease that another operation holds, such as
/// the `graph inspect` behind `hack ps`.
const STARTUP_LEASE_WAIT: Duration = Duration::from_secs(5);

/// Startup's provider lease. Everything `start_pool` does before taking it is read-only
/// validation, admission sampling and RAII guards, so waiting for a briefly held lease admits
/// nothing early, and on expiry it refuses `provider_busy` with nothing admitted.
fn startup_lease(root: &Path, wait: Duration) -> Result<state::Lock, CandidateError> {
    operation_lease(root, Some(Instant::now() + wait), || Ok(())).map(|(lock, ())| lock)
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
            || current.network != self.owner.network
            || current.project_share != self.owner.project_share
            || current.application_bridge != self.owner.application_bridge
            || current.dependency_sockets != self.owner.dependency_sockets
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
    allocation_allowed: bool,
    guard: Option<(u64, std::cell::Cell<Instant>)>,
}

impl<'a> OwnedGuest<'a> {
    pub(super) fn candidate(&self) -> &'a Candidate {
        self.candidate
    }

    pub(super) fn require_allocation(&self) -> Result<(), CandidateError> {
        if !self.allocation_allowed {
            return Err(CandidateError::new(
                "cleanup_only",
                "A cleanup connection cannot allocate or authorize environment use.",
            ));
        }
        Ok(())
    }

    pub(super) fn engine_socket(&self) -> Result<std::path::PathBuf, CandidateError> {
        self.verify()?;
        socket(self.candidate, &self.owner, "docker.sock")
    }

    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        verify_live(self.candidate, &self.owner)
    }

    pub(super) fn project_share(&self) -> Option<&super::ProjectShareIntent> {
        self.owner.project_share.as_ref()
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
        Self::connect_mode(candidate, true, None)
    }

    pub(super) fn connect_cleanup(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false, None)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn connect_cleanup_wait(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(
            candidate,
            false,
            Some(Instant::now() + Duration::from_secs(5)),
        )
    }

    fn connect_mode(
        candidate: &'a Candidate,
        enforce_budget: bool,
        deadline: Option<Instant>,
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
        let (lock, current) = operation_lease(&root(candidate), deadline, || {
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
            Ok(current)
        })?;
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
            allocation_allowed: enforce_budget,
            guard,
        })
    }

    pub(super) fn network_intent(&self) -> &super::NetworkIntent {
        &self.owner.network
    }

    pub(super) fn profile(&self) -> super::Profile {
        self.owner.profile
    }

    pub(super) fn bridge_intent(&self) -> Option<super::BridgeIntent> {
        self.owner.application_bridge
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

    /// Caller holds the Engine lease and a durable, quiescent cache-release intent.
    pub(super) fn release_guest_cache(&self) -> Result<(), CandidateError> {
        self.before_effect()?;
        verify_live(self.candidate, &self.owner)?;
        agent::release_guest_cache(
            &socket(self.candidate, &self.owner, "agent.sock")?,
            &self.owner.token,
            self.boot_id(),
        )?;
        verify_live(self.candidate, &self.owner)
    }
    pub(super) fn execute(
        &self,
        script: &str,
        arguments: &[&str],
        input: Option<&str>,
    ) -> Result<String, CandidateError> {
        self.execute_mode(script, arguments, input, true)
    }

    /// Retains the existing mutation lock and identity checks without allocation admission.
    pub(super) fn execute_cleanup(
        &self,
        script: &str,
        arguments: &[&str],
    ) -> Result<String, CandidateError> {
        self.execute_mode(script, arguments, None, false)
    }

    fn execute_mode(
        &self,
        script: &str,
        arguments: &[&str],
        input: Option<&str>,
        allocation: bool,
    ) -> Result<String, CandidateError> {
        verify_live(self.candidate, &self.owner)?;
        if allocation {
            self.before_effect()?;
        }
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
    super::config_audit::verify(candidate, owner)?;
    super::dependency_socket::verify(candidate, owner)?;
    if let Some(bridge) = owner.application_bridge {
        super::bridge::verify_sockets(&owner.real_data_dir(candidate)?, bridge)?;
    }
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
    owner.network.verify_resources(&config["resources"])?;
    let mut mounts = json!([{"source":artifact::engine_root(candidate),"target":"/opt/hack-engine","read_only":true,"staged":false}]);
    if let Some(share) = &owner.project_share {
        share.validate_receipt()?;
        mounts
            .as_array_mut()
            .expect("mounts")
            .push(share.running_mount());
    }
    if config["version"] != 1
        || config["mounts"] != mounts
        || config["ports"] != json!([])
        || config["resources"]["cpus"] != owner.profile.cpus()
        || config["resources"]["memory_mib"] != owner.profile.memory_mib()
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
    let directory = owner.real_data_dir(candidate)?;
    super::disk_audit::verify(
        process,
        &binary(candidate),
        &[directory.join("storage.raw"), directory.join("overlay.raw")],
    )?;
    Ok(())
}

/// Read-only source compatibility check before application lifecycle hooks.
/// This is advisory: `up_selected` repeats the check before VM effects.
fn require_fresh_source_pool(candidate: &Candidate) -> Result<(), CandidateError> {
    if !root(candidate).try_exists().map_err(io)? {
        return Ok(());
    }
    state::check_private_directory(&root(candidate))?;
    for entry in fs::read_dir(root(candidate)).map_err(io)? {
        let entry = entry.map_err(io)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io)?;
        if entry.file_name() != "operation.lock"
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Source admission requires a fresh or owned source pool; unowned provider state was preserved.",
            ));
        }
    }
    Ok(())
}

pub fn check_project_share(
    candidate: &Candidate,
    requested: &super::ProjectShareIntent,
) -> Result<serde_json::Value, CandidateError> {
    requested.validate()?;
    reject_aliased_state(&root(candidate))?;
    super::network_update::require_complete(candidate)?;
    let initialized = root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?;
    if initialized {
        let owner = Owner::load(candidate)?;
        super::project_share::check_request(owner.project_share.as_ref(), Some(requested))?;
    } else {
        require_fresh_source_pool(candidate)?;
    }
    Ok(json!({ "source_admitted": true, "pool_initialized": initialized }))
}

pub fn status(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    if !root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        return Ok(RuntimeStatus {
            network: None,
            project_share: None,
            application_bridge: None,
            dependency_sockets: None,
            dependency_socket_observations: Vec::new(),
            phase: "uninitialized".into(),
            profile: None,
            reclamation: None,
            guest_memory_mib: None,
            provider_memory: None,
            provider_resources: None,
            qualification: "WU02-live-qualification-pending",
            machine: None,
            process_alive: Some(false),
            engine_socket: None,
            persistent_disks_identified: false,
            guest_boot_id: None,
            prepared_base: None,
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
    let resources = if alive == Some(true) {
        Some(super::resources::observe(
            owner.process.as_ref().expect("live process"),
        )?)
    } else {
        None
    };
    Ok(RuntimeStatus {
        network: Some(owner.network.clone()),
        project_share: owner.project_share.clone(),
        dependency_sockets: owner.dependency_sockets,
        dependency_socket_observations: super::dependency_socket::observe(candidate, &owner)?,
        provider_resources: resources,
        provider_memory: if alive == Some(true) {
            Some(identity::memory_usage(
                owner.process.as_ref().expect("live process").pid,
            )?)
        } else {
            None
        },
        profile: Some(owner.profile),
        reclamation: owner.reclamation,
        guest_memory_mib: Some(owner.profile.memory_mib()),
        application_bridge: owner.application_bridge,
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
        prepared_base: super::prepared_start::status(candidate),
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
    up_with_bridge(candidate, profile, None)
}

/// Resource admission distinguishes a proven running pool from a new VM allocation.
pub fn probe_with_profile(
    candidate: &Candidate,
    profile: super::Profile,
) -> Result<admission::Admission, CandidateError> {
    let selected = admission_pool::select(candidate, profile)?;
    admission_pool::probe(candidate, profile, selected.as_ref())
}

pub fn up_with_bridge(
    candidate: &Candidate,
    profile: super::Profile,
    requested: Option<super::BridgeIntent>,
) -> Result<RuntimeStatus, CandidateError> {
    up_with_capabilities(candidate, profile, requested, None)
}

/// Create a pool with explicit capabilities or reuse its unchanged durable intent.
/// Omitted network selection preserves the existing mode; new pools are isolated.
/// Gateway mode does not authorize host aliases or identify host service owners.
pub fn up_with_capabilities(
    candidate: &Candidate,
    profile: super::Profile,
    requested: Option<super::BridgeIntent>,
    network: Option<super::NetworkIntent>,
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        requested.into(),
        network,
        None.into(),
        None,
        None,
    )
}

/// Stage fixed inbound and outbound UNIX socket capacity. Missing dependency
/// listeners remain explicitly unready; this does not provision authenticated grants.
pub fn up_with_sockets(
    candidate: &Candidate,
    profile: super::Profile,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<super::DependencySocketIntent>,
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        bridge.into(),
        None,
        dependencies.into(),
        None,
        None,
    )
}

/// Explicit socket and egress selection; an existing pool is never widened.
pub fn up_with_network_sockets(
    candidate: &Candidate,
    profile: super::Profile,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<super::DependencySocketIntent>,
    network: Option<super::NetworkIntent>,
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        bridge.into(),
        network,
        dependencies.into(),
        None,
        None,
    )
}

/// Explicit unfiltered writable project sharing; never modifies an existing pool.
pub fn up_with_project_share(
    candidate: &Candidate,
    profile: super::Profile,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<super::DependencySocketIntent>,
    network: Option<super::NetworkIntent>,
    project_share: Option<super::ProjectShareIntent>,
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        bridge.into(),
        network,
        dependencies.into(),
        project_share,
        None,
    )
}

/// One explicit start bound to offline retained graph eligibility. The selection
/// is revalidated under the provider lease and before boot; uncertainty is never replayed.
pub fn up_with_retained_project_share(
    candidate: &Candidate,
    profile: super::Profile,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<super::DependencySocketIntent>,
    network: Option<super::NetworkIntent>,
    project_share: Option<super::ProjectShareIntent>,
    retained: (&str, &str),
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        bridge.into(),
        network,
        dependencies.into(),
        project_share,
        Some(retained),
    )
}

/// Start for a graph requiring at least this many ingress sockets. New pools use
/// the minimum; existing pools keep their exact durable capacity. This does not
/// reserve free slots, which remain the graph owner's responsibility.
pub fn up_with_minimum_bridges(
    candidate: &Candidate,
    profile: super::Profile,
    required: super::BridgeIntent,
    dependencies: Option<super::DependencySocketIntent>,
    network: Option<super::NetworkIntent>,
    project_share: Option<super::ProjectShareIntent>,
    retained: Option<(&str, &str)>,
) -> Result<RuntimeStatus, CandidateError> {
    up_selected(
        candidate,
        profile,
        super::bridge::Request::Minimum(required),
        network,
        dependencies.into(),
        project_share,
        retained,
    )
}

/// Admit exact or minimum capacity independently for ingress and dependencies.
/// Graph startup must separately allocate free slots under the provider lease.
pub fn up_with_socket_requests(
    candidate: &Candidate,
    profile: super::Profile,
    sockets: super::SocketRequests,
    network: Option<super::NetworkIntent>,
    project_share: Option<super::ProjectShareIntent>,
    retained: Option<(&str, &str)>,
) -> Result<RuntimeStatus, CandidateError> {
    let (bridges, dependencies) = sockets.resolve()?;
    up_selected(
        candidate,
        profile,
        bridges,
        network,
        dependencies,
        project_share,
        retained,
    )
}

fn up_selected(
    candidate: &Candidate,
    profile: super::Profile,
    bridge_request: super::bridge::Request,
    network: Option<super::NetworkIntent>,
    dependency_request: super::dependency_socket::Request,
    project_share: Option<super::ProjectShareIntent>,
    retained: Option<(&str, &str)>,
) -> Result<RuntimeStatus, CandidateError> {
    start_pool(
        candidate,
        profile,
        bridge_request,
        network,
        dependency_request,
        project_share,
        super::prepared_start::Start {
            retained,
            prepared: None,
        },
    )
}

/// Start with a prepared-base request for a fresh pool. Existing wrappers pass none and keep
/// the stock templates; `prepared_start` documents fallback and refusal.
pub fn up_with_prepared_base(
    candidate: &Candidate,
    profile: super::Profile,
    sockets: super::SocketRequests,
    network: Option<super::NetworkIntent>,
    project_share: Option<super::ProjectShareIntent>,
    start: super::prepared_start::Start<'_>,
) -> Result<RuntimeStatus, CandidateError> {
    let (bridges, dependencies) = sockets.resolve()?;
    start_pool(
        candidate,
        profile,
        bridges,
        network,
        dependencies,
        project_share,
        start,
    )
}

fn start_pool(
    candidate: &Candidate,
    profile: super::Profile,
    bridge_request: super::bridge::Request,
    network: Option<super::NetworkIntent>,
    dependency_request: super::dependency_socket::Request,
    project_share: Option<super::ProjectShareIntent>,
    start: super::prepared_start::Start<'_>,
) -> Result<RuntimeStatus, CandidateError> {
    let retained = start.retained;
    #[cfg(target_os = "macos")]
    let retained_guard = retained
        .map(|(run, selection)| {
            super::graph::retained_startup::Guard::acquire(candidate, run, Some(selection))
        })
        .transpose()?;
    #[cfg(not(target_os = "macos"))]
    if retained.is_some() {
        return Err(CandidateError::new(
            "unsupported_host",
            "Retained foreground startup requires macOS.",
        ));
    }
    let requested = bridge_request.initial();
    let dependencies = dependency_request.initial();
    super::network_update::require_complete(candidate)?;
    if let Some(share) = &project_share {
        share.validate()?;
    }
    if let Some(intent) = &network {
        intent.validate()?;
    }
    if let Some(intent) = dependencies {
        super::DependencySocketIntent::new(intent.slots)?;
    }
    super::dependency_socket::check_capacity(requested, dependencies)?;
    if let Some(intent) = requested {
        super::BridgeIntent::new(intent.slots)?;
    }
    reject_aliased_state(&root(candidate))?;
    let (existing, existing_network, existing_dependencies, existing_share) = if root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        let owner = Owner::load(candidate)?;
        super::project_share::check_request(owner.project_share.as_ref(), project_share.as_ref())?;
        bridge_request.check(owner.application_bridge)?;
        super::network_intent::check_request(&owner.network, network.as_ref())?;
        dependency_request.check(owner.dependency_sockets)?;
        (
            owner.application_bridge,
            owner.network.clone(),
            owner.dependency_sockets,
            owner.project_share.clone(),
        )
    } else {
        (
            requested,
            network.unwrap_or_default(),
            dependencies,
            project_share.clone(),
        )
    };
    super::dependency_socket::check_capacity(existing, existing_dependencies)?;
    if existing.is_some() && !cfg!(feature = "native-stream-relay") {
        return Err(CandidateError::new(
            "bridge_unavailable",
            "Application bridges require a native-stream-relay build.",
        ));
    }
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
    // Admission before aliases, provider commands, disks or VM effects. Only
    // independently verified live ownership avoids charging a second VM's disks.
    let admission_owner = admission_pool::select(candidate, profile)?;
    let admission = admission_pool::probe(candidate, profile, admission_owner.as_ref())?;
    if !admission.admitted {
        return Err(CandidateError::new(
            "admission_rejected",
            admission.reasons.join(" "),
        ));
    }
    let samples = admission::sample_with(profile, || {
        admission_pool::probe(candidate, profile, admission_owner.as_ref())
    })?;
    artifact::verify(candidate)?;
    artifact::verify_engine(candidate)?;
    super::network_tools::verify(candidate)?;
    let lock = startup_lease(&root(candidate), STARTUP_LEASE_WAIT)?;
    if let Some(selected) = &admission_owner {
        selected.reverify(candidate)?;
    }
    #[cfg(target_os = "macos")]
    if let Some(guard) = &retained_guard {
        guard.verify(candidate)?;
    }
    super::network_update::require_complete(candidate)?;
    let fresh_owner = match fs::symlink_metadata(root(candidate).join("owner.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Ok(_) => false,
        Err(error) => return Err(io(error)),
    };
    // Hooks and admission can outlive the read-only frontend check. Never adopt
    // unrelated state that appeared before this operation acquired its lock.
    if fresh_owner && project_share.is_some() {
        require_fresh_source_pool(candidate)?;
    }
    let mut owner = Owner::create_with_project_share(
        candidate,
        profile,
        requested,
        existing_network.clone(),
        existing_dependencies,
        existing_share.clone(),
    )?;
    super::project_share::check_request(owner.project_share.as_ref(), existing_share.as_ref())?;
    if owner.project_share != existing_share {
        return Err(CandidateError::new(
            "project_share",
            "Project share changed before the operation lock.",
        ));
    }
    bridge_request.check(owner.application_bridge)?;
    super::network_intent::check_request(&owner.network, Some(&existing_network))?;
    dependency_request.check(owner.dependency_sockets)?;
    if owner.dependency_sockets != existing_dependencies {
        return Err(CandidateError::new(
            "dependency_socket_conflict",
            "Dependency socket ownership changed before the operation lock.",
        ));
    }
    if owner.application_bridge != existing {
        return Err(CandidateError::new(
            "bridge_conflict",
            "Bridge ownership changed before the operation lock.",
        ));
    }
    if owner.profile != profile {
        return Err(CandidateError::new(
            "profile_conflict",
            "Capacity profile changed before the operation lock was acquired.",
        ));
    }
    if fresh_owner {
        super::graph::initialize_owner_registry(candidate, &owner)?;
    } else {
        super::graph::verify_owner_registry(candidate, &owner)?;
    }
    super::dependency_socket::verify(candidate, &owner)?;
    state::write(&root(candidate).join("admission.json"), &samples)?;
    if owner.phase == "running" {
        if let Some(selected) = &admission_owner {
            selected.reverify(candidate)?;
        }
        #[cfg(target_os = "macos")]
        if let Some(guard) = &retained_guard {
            guard.verify(candidate)?;
        }
        verify_live(candidate, &owner)?;
        audit_boot(candidate, &owner)?;
        return status(candidate);
    }
    if admission_owner.is_some() {
        return Err(CandidateError::new(
            "admission_owner_changed",
            "Reserve-qualified ownership no longer names a running pool; no create or boot was admitted.",
        ));
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
        // SmolVM clones the expanded templates in `home/.smolvm` into the new disks at the
        // machine's first start. Choose them (stock, or an activated prepared base) and verify
        // them before the phase records a create attempt; `verify_templates` checks again
        // around that start.
        super::prepared_start::before_create(candidate, &owner, &lock, start.prepared)?;
        phase(candidate, &mut owner, "creating")?;
        let mount = format!(
            "{}:/opt/hack-engine:ro",
            artifact::engine_root(candidate).display()
        );
        let mut arguments = vec![
            "machine".to_owned(),
            "create".into(),
            "--name".into(),
            owner.machine.clone(),
            "--label".into(),
            format!("hack-local.owner={}", owner.token),
            "--cpus".into(),
            profile.cpus().to_string(),
            "--mem".into(),
            profile.memory_mib().to_string(),
            "--storage".into(),
            profile.storage_gib().to_string(),
            "--overlay".into(),
            profile.overlay_gib().to_string(),
            "--docker-socket".into(),
            "--volume".into(),
            mount,
        ];
        if let Some(share) = &owner.project_share {
            share.validate()?;
            arguments.extend(["--volume".into(), share.argument()]);
        }
        arguments.extend(
            owner
                .network
                .arguments()
                .iter()
                .map(|value| (*value).to_owned()),
        );
        if let Some(bridge) = owner.application_bridge {
            for path in bridge.guest_paths() {
                arguments.extend(["--expose-socket".into(), path]);
            }
        }
        if let Some(intent) = owner.dependency_sockets {
            for path in intent.paths(&owner.short_home) {
                arguments.extend([
                    "--mount-socket".into(),
                    format!("{}:{}", path.host_path.display(), path.guest_path),
                ]);
            }
        }
        invoke(
            candidate,
            &owner,
            &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
        super::config_audit::pin_created_network(candidate, &mut owner)?;
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
    if let Err(error) = super::config_audit::verify(candidate, &owner) {
        phase(candidate, &mut owner, "stopped-before-engine")?;
        return Err(error);
    }
    if let Err(error) = verify_templates(
        candidate,
        &owner,
        &lock,
        super::disk_template::Stage::BeforeUse,
    ) {
        phase(candidate, &mut owner, "stopped-before-engine")?;
        return Err(error);
    }
    #[cfg(target_os = "macos")]
    if let Some(guard) = &retained_guard {
        guard.verify(candidate)?;
    }
    let previous_boot = owner.begin_boot();
    owner.reclamation = Some(boot_reclamation_policy());
    // The previous provider was proven dead above. Until this start records its own provider,
    // the receipt names none, so recovery identifies it (`interrupted`) instead of trusting the
    // old identity.
    owner.process = None;
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
    let result = finish_boot(candidate, &mut owner, previous_boot.as_deref(), &lock);
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

/// Verify the expanded disk templates around a start that can format this pool's disks.
///
/// Pinned SmolVM 1.14.3 formats a machine's disks from the templates during its first start
/// (`prepare_for_launch`); `machine create` makes no disks, so nothing is expanded until then.
/// Until the pool adopts its disk identities, a start may clone templates: verify the ones it
/// would reuse before the start, and the ones it cloned after it, before adoption. Adopted disks
/// are not formatted again, and a replaced disk is refused by its pinned identity. A pool bound
/// to a prepared base verifies its activated templates against the base receipt instead of
/// the stock pins (`prepared_start::verify`).
fn verify_templates(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
    stage: super::disk_template::Stage,
) -> Result<(), CandidateError> {
    super::prepared_start::verify(candidate, owner, lock, stage)
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
    lock: &state::Lock,
) -> Result<RuntimeStatus, CandidateError> {
    // Before any disk is adopted: a refusal here takes the caller's failed-boot path.
    verify_templates(
        candidate,
        owner,
        lock,
        super::disk_template::Stage::AfterFirstStart,
    )?;
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
    super::prepared_start::after_adoption(candidate, owner, lock);
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
    if let Some(intent) = owner.dependency_sockets {
        let paths = intent.paths(&owner.short_home);
        let mut args = vec![owner.token.as_str(), boot];
        args.extend(paths.iter().map(|path| path.guest_path.as_str()));
        let observed = guest(
            candidate,
            owner,
            "set -eu\ntest \"$(cat /storage/.hack-local-owner)\" = \"$1\"\ntest \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$2\"\nshift 2\nfor path do test ! -L \"$path\"; test -S \"$path\"; done\nprintf 'dependency-sockets-present-v1\\n'",
            &args,
            false,
        )?;
        if observed != "dependency-sockets-present-v1\n" {
            return Err(CandidateError::new(
                "dependency_socket",
                "Guest dependency socket realization was not confirmed; engine startup refused.",
            ));
        }
    }
    let tools_owner = super::prepared_start::network_tools_owner(candidate, owner, lock)?;
    super::network_tools::provision(candidate, &tools_owner, &mut |script, args, input| {
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
    let cached = guest(
        candidate,
        owner,
        include_str!("guest-runc-cache.sh"),
        &[
            &owner.token,
            owner.guest_boot_id.as_deref().expect("verified boot"),
            &artifact::digest(&artifact::engine_root(candidate).join("runc"))?,
            &artifact::digest(&artifact::engine_root(candidate).join("docker-init"))?,
        ],
        false,
    )?;
    if cached != "engine-exec-cache-v1\n" {
        return Err(CandidateError::new(
            "engine_execution_cache",
            "Verified guest executable cache was not confirmed; engine startup refused.",
        ));
    }
    let network_mode = match owner.network {
        super::NetworkIntent::Isolated => "isolated",
        super::NetworkIntent::Internet => "internet",
        super::NetworkIntent::HostGateway => "host-gateway",
        super::NetworkIntent::ApprovedHosts { .. } => "approved-hosts",
    };
    guest(
        candidate,
        owner,
        include_str!("guest-daemon.sh"),
        &[network_mode],
        true,
    )?;
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

/// Retained startup may verify existing templates/rootfs but never reconstruct
/// missing provider state before refusing a stale or interrupted selection.
#[cfg(target_os = "macos")]
pub(super) fn verify_retained_rootfs(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<(), CandidateError> {
    let expected = owner.rootfs_digest.as_deref().ok_or_else(|| {
        CandidateError::new(
            "graph_retained_startup",
            "Retained runtime rootfs pin is missing.",
        )
    })?;
    let templates = root(candidate).join("home/.smolvm");
    state::check_private_directory(&templates)?;
    for name in ["storage-template.ext4.zst", "overlay-template.ext4.zst"] {
        let path = templates.join(name);
        let metadata = fs::symlink_metadata(&path).map_err(io)?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || artifact::digest(&path)? != artifact::digest(&artifact::root(candidate).join(name))?
        {
            return Err(CandidateError::new(
                "artifact_digest_mismatch",
                "Retained disk template changed or is missing.",
            ));
        }
    }
    let destination = root(candidate).join("rootfs");
    reject_aliased_state(&destination)?;
    let data = owner.data_dir();
    let machine = data.file_name().and_then(|v| v.to_str()).ok_or_else(|| {
        CandidateError::new("foreign_state", "Owned machine identity is missing.")
    })?;
    let marker = format!(".smolvm-ready.{machine}");
    if artifact::rootfs_digest(&destination, Some(&marker))? != expected {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Retained guest rootfs changed.",
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
    super::hostname_authority::managed::stop(candidate, &owner)?;
    super::publication::release(candidate, &owner.token, None)?;
    if [
        "stopped",
        "stopped-before-engine",
        "stopped-after-engine-failure",
        "recovered-unclean",
    ]
    .contains(&owner.phase.as_str())
        && initial.process_alive != Some(true)
    {
        // These phases are written only before a start or after proven absence; no recorded
        // provider (`None`) is as stopped as a dead one.
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
    finish_absent(candidate, owner, value, true)
}

/// Record `value` once the provider's VM lock is free, no handle remains on the owned disks and
/// no owned socket accepts connections. The caller has established that no provider process
/// remains; this proves the machine it launched released everything before the receipt changes.
/// With `record_disks`, unadopted disks are identified now; without it they stay unadopted, so
/// the next boot's size, format-marker and template checks decide whether to adopt them.
fn finish_absent(
    candidate: &Candidate,
    owner: &mut Owner,
    value: &str,
    record_disks: bool,
) -> Result<(), CandidateError> {
    let vm_lock = lock_absent_disks(candidate, owner)?;
    finish_absent_locked(candidate, owner, value, record_disks, &vm_lock)
}

/// Closing alone can leave a flock held by a fork/dup copy until that copy closes.
/// Explicitly unlock this open-file description when the recovery scope ends.
struct VmLock(File);
impl std::ops::Deref for VmLock {
    type Target = File;
    fn deref(&self) -> &File {
        &self.0
    }
}
impl Drop for VmLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the owned descriptor remains live through this Drop call.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Keep this guard through alias restoration and the stopped receipt.
fn lock_absent_disks(candidate: &Candidate, owner: &Owner) -> Result<VmLock, CandidateError> {
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
    // Keep the exclusive VM lock through the stopped receipt.
    if unsafe { libc::flock(vm_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Provider VM lock is still held.",
        ));
    }
    let vm_lock = VmLock(vm_lock);
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
    Ok(vm_lock)
}

fn finish_absent_locked(
    candidate: &Candidate,
    owner: &mut Owner,
    value: &str,
    record_disks: bool,
    _vm_lock: &File,
) -> Result<(), CandidateError> {
    if record_disks && owner.storage.is_none() {
        owner.storage = Some(identity::disk(
            &owner.real_data_dir(candidate)?.join("storage.raw"),
        )?);
    }
    if record_disks && owner.overlay.is_none() {
        owner.overlay = Some(identity::disk(
            &owner.real_data_dir(candidate)?.join("overlay.raw"),
        )?);
    }
    let mut sockets = vec!["agent.sock".to_owned(), "docker.sock".to_owned()];
    if let Some(bridge) = owner.application_bridge {
        sockets.extend(bridge.guest_paths().into_iter().map(|path| {
            Path::new(&path)
                .file_name()
                .expect("fixed socket name")
                .to_string_lossy()
                .into_owned()
        }));
    }
    for name in sockets {
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
    let initial = match status(candidate) {
        Ok(initial) => initial,
        Err(error) if error.code == "provider_home_missing" => {
            return short_home::recover(candidate);
        }
        Err(error) => return Err(error),
    };
    if initial.phase == "uninitialized" {
        return Ok(initial);
    }
    let lock = state::Lock::acquire(&root(candidate))?;
    let mut owner = Owner::load(candidate)?;
    let Some(process) = owner.process.as_ref() else {
        // A start interrupted before the provider identity was recorded; see `interrupted`.
        interrupted::recover(candidate, &mut owner, &lock)?;
        return status(candidate);
    };
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
pub(super) fn kill_owned_vm_for_test(candidate: &Candidate) -> Result<(), CandidateError> {
    let guest = OwnedGuest::connect(candidate)?;
    if guest.profile() != super::Profile::Development {
        return Err(CandidateError::new(
            "fixture_profile",
            "VM kill control requires development profile.",
        ));
    }
    let recorded = guest.owner.process.as_ref().expect("verified process");
    identity::verify(
        recorded,
        &identity::observe(recorded.pid)?,
        &binary(candidate),
        unsafe { libc::geteuid() },
    )?;
    // Test-only abrupt VM loss, after checking native PID/start/UID/executable identity.
    if unsafe { libc::kill(recorded.pid, libc::SIGKILL) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while identity::alive(recorded.pid)? && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if identity::alive(recorded.pid)? {
        return Err(CandidateError::new(
            "fixture_kill",
            "Owned VM remains alive after kill control.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_preflight_is_read_only_and_preserves_unowned_state() {
        let directory = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-source-preflight-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        state::private_directory(&directory).unwrap();
        struct Remove(std::path::PathBuf);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _remove = Remove(directory.clone());
        let project = directory.join("app");
        state::private_directory(&project).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();
        let candidate = Candidate::discover(&directory).unwrap();
        let share = super::super::ProjectShareIntent::approve(&project, true).unwrap();
        assert_eq!(
            check_project_share(&candidate, &share).unwrap(),
            json!({"source_admitted":true,"pool_initialized":false})
        );
        assert!(!candidate.state_root.exists());
        let lock = state::Lock::acquire(&root(&candidate)).unwrap();
        assert!(require_fresh_source_pool(&candidate).is_ok());
        state::private_directory(&root(&candidate)).unwrap();
        let canary = root(&candidate).join("unowned");
        fs::write(&canary, "preserved").unwrap();
        assert_eq!(
            check_project_share(&candidate, &share).unwrap_err().code,
            "foreign_state"
        );
        assert_eq!(fs::read_to_string(canary).unwrap(), "preserved");
        assert_eq!(
            require_fresh_source_pool(&candidate).unwrap_err().code,
            "foreign_state"
        );
        drop(lock);
        assert!(!root(&candidate).join("owner.json").exists());
        #[cfg(target_os = "macos")]
        {
            fs::remove_file(root(&candidate).join("unowned")).unwrap();
            let owner = Owner::create_with_project_share(
                &candidate,
                super::super::Profile::Development,
                None,
                super::super::NetworkIntent::Internet,
                None,
                Some(share.clone()),
            )
            .unwrap();
            let before = fs::read(root(&candidate).join("owner.json")).unwrap();
            assert_eq!(
                check_project_share(&candidate, &share).unwrap(),
                json!({"source_admitted":true,"pool_initialized":true})
            );
            let second = directory.join("other-app");
            state::private_directory(&second).unwrap();
            fs::write(second.join("package.json"), "{}").unwrap();
            let other = super::super::ProjectShareIntent::approve(&second, true).unwrap();
            assert_eq!(
                check_project_share(&candidate, &other).unwrap_err().code,
                "project_share"
            );
            assert_eq!(
                fs::read(root(&candidate).join("owner.json")).unwrap(),
                before
            );
            assert_eq!(
                fs::read_link(&owner.short_home).unwrap(),
                root(&candidate).join("home")
            );
            fs::remove_file(&owner.short_home).unwrap();
        }
    }

    #[test]
    fn cleanup_operation_lease_waits_then_revalidates_without_replaying_effects() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hkl-lease-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        struct Remove(std::path::PathBuf);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _remove = Remove(root.clone());
        state::private_directory(&root).unwrap();
        let identity = root.join("identity");
        std::fs::write(&identity, "original").unwrap();
        for changed in [false, true] {
            std::fs::write(&identity, "original").unwrap();
            let held = state::Lock::acquire(&root).unwrap();
            let calls = std::cell::Cell::new(0);
            assert!(
                matches!(operation_lease(&root, None, || { calls.set(1); Ok(()) }), Err(e) if e.code == "provider_busy")
            );
            let writer = identity.clone();
            let worker = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                if changed {
                    std::fs::write(writer, "replacement").unwrap();
                }
                drop(held);
            });
            let acquired =
                operation_lease(&root, Some(Instant::now() + Duration::from_secs(2)), || {
                    calls.set(calls.get() + 1);
                    if std::fs::read_to_string(&identity).unwrap() != "original" {
                        return Err(CandidateError::new(
                            "runtime_changed",
                            "Fixture identity changed.",
                        ));
                    }
                    Ok(())
                });
            worker.join().unwrap();
            assert_eq!(calls.get(), 1);
            if changed {
                assert!(matches!(acquired, Err(e) if e.code == "runtime_changed"));
            } else {
                assert!(acquired.is_ok());
            }
        }
        let _held = state::Lock::acquire(&root).unwrap();
        let called = std::cell::Cell::new(false);
        let expired = operation_lease(
            &root,
            Some(Instant::now() + Duration::from_millis(75)),
            || {
                called.set(true);
                Ok(())
            },
        );
        assert!(matches!(expired, Err(e) if e.code == "provider_busy"));
        assert!(!called.get());
        assert_eq!(std::fs::read_to_string(&identity).unwrap(), "replacement");
    }

    #[test]
    fn startup_lease_waits_out_a_brief_holder_and_refuses_a_lasting_one() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hkl-startup-lease-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        struct Remove(std::path::PathBuf);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _remove = Remove(root.clone());
        state::private_directory(&root).unwrap();
        // A brief holder, such as the inspection behind `hack ps`: startup waits, then takes it.
        let held = state::Lock::acquire(&root).unwrap();
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let lock = startup_lease(&root, Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
        // The lease stays exclusive: an immediate acquisition is still refused while held.
        assert!(matches!(state::Lock::acquire(&root), Err(e) if e.code == "provider_busy"));
        drop(lock);
        // A holder that outlasts the wait is refused with nothing admitted.
        let _held = state::Lock::acquire(&root).unwrap();
        let refused = startup_lease(&root, Duration::from_millis(100));
        assert!(matches!(
            &refused,
            Err(e) if e.code == "provider_busy" && e.message.contains("no operation was admitted")
        ));
    }

    #[test]
    fn provider_command_enforces_strict_floor_for_public_egress_modes() {
        let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut owner: Owner = serde_json::from_value(json!({
            "version":1,"checkout":"/fixture","token":"fixture","machine":"fixture",
            "short_home":"/fixture","created":true,"phase":"stopped","process":null,
            "storage":null,"overlay":null,"guest_boot_id":null,
            "daemon_pid":null,"daemon_start":null,"rootfs_digest":null
        }))
        .unwrap();
        for intent in [
            super::super::NetworkIntent::Isolated,
            super::super::NetworkIntent::HostGateway,
            super::super::NetworkIntent::Internet,
            super::super::NetworkIntent::approved_hosts(vec!["registry.example.com".into()])
                .unwrap(),
        ] {
            let approved = matches!(
                &intent,
                super::super::NetworkIntent::ApprovedHosts { .. }
                    | super::super::NetworkIntent::Internet
            );
            owner.network = intent;
            // The same constructor supplies normal start, re-start after stop,
            // recovery and exec. Inspect argv/env only; never spawn a provider.
            for action in ["create", "start", "stop", "exec"] {
                let mut cmd = command(&candidate, &owner);
                cmd.args(["machine", action, "--name", &owner.machine]);
                let env: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
                assert_eq!(
                    env.get(std::ffi::OsStr::new("SMOLVM_EGRESS_FLOOR"))
                        .copied()
                        .flatten(),
                    approved.then_some(std::ffi::OsStr::new("strict"))
                );
                for override_name in [
                    "SMOLVM_EGRESS_ALLOW_PRIVATE",
                    "SMOLVM_ALLOW_HOST_LOOPBACK",
                    "SMOLVM_PUBLISH_ADDR",
                ] {
                    assert!(!env.contains_key(std::ffi::OsStr::new(override_name)));
                }
            }
        }
    }

    #[test]
    fn provider_command_disables_trim_despite_ambient_override() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::lifecycle::tests::provider_command_uses_recorded_reclamation_policy",
                "--nocapture",
            ])
            .env("SMOLVM_DISK_TRIM", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("provider-trim-disabled"));
    }

    #[test]
    fn provider_command_uses_recorded_reclamation_policy() {
        println!("provider-trim-disabled");
        let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut owner: Owner = serde_json::from_value(json!({
            "version":1, "checkout":"/fixture", "token":"fixture", "machine":"fixture",
            "short_home":"/fixture", "created":true, "phase":"stopped", "process":null,
            "storage":null, "overlay":null, "guest_boot_id":null,
            "daemon_pid":null, "daemon_start":null, "rootfs_digest":null
        }))
        .unwrap();
        for policy in [
            state::ReclamationPolicy::default(),
            state::ReclamationPolicy {
                enabled: false,
                idle_minutes: None,
            },
        ] {
            owner.reclamation = Some(policy);
            let cmd = command(&candidate, &owner);
            let env: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
            assert_eq!(
                env[std::ffi::OsStr::new("SMOLVM_DISK_TRIM")],
                Some(std::ffi::OsStr::new("0"))
            );
            assert_eq!(
                env[std::ffi::OsStr::new("SMOLVM_BALLOON_RECLAIM")],
                Some(std::ffi::OsStr::new(if policy.enabled { "1" } else { "0" }))
            );
            assert_eq!(
                env[std::ffi::OsStr::new("SMOLVM_IDLE_RECLAIM")],
                Some(std::ffi::OsStr::new(if policy.enabled {
                    "10"
                } else {
                    "0"
                }))
            );
        }
    }

    #[test]
    #[ignore = "Owned reclamation experiment boot helper; external watchdog and teardown required"]
    fn start_reclamation_experiment() {
        assert!(matches!(
            std::env::var("HACK_LOCAL_TEST_RECLAIM").as_deref(),
            Ok("0" | "1")
        ));
        let candidate = Candidate::discover(Path::new(
            &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root"),
        ))
        .unwrap();
        assert_eq!(status(&candidate).unwrap().phase, "stopped");
        let running = up_with_profile(&candidate, super::super::Profile::Development).unwrap();
        assert_eq!(running.process_alive, Some(true));
        println!("{}", serde_json::to_string(&running).unwrap());
    }

    #[test]
    fn executable_cache_requires_both_digest_arguments_before_guest_effects() {
        use std::process::{Command, Stdio};
        let script = include_str!("guest-runc-cache.sh");
        assert!(
            Command::new("/bin/sh")
                .args(["-n", "-c", script])
                .status()
                .unwrap()
                .success()
        );
        for digests in [
            vec!["a".repeat(64)],
            vec!["a".repeat(64), "b".repeat(63)],
            vec!["a".repeat(64), "G".repeat(64)],
        ] {
            let status = Command::new("/bin/sh")
                .args(["-c", script, "cache-test", "owner", "boot"])
                .args(digests)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(!status.success());
        }
    }

    #[test]
    #[ignore = "Manual owned VM, loaded shell image HACK_LOCAL_TEST_IMAGE and watchdog required"]
    fn cached_init_executes_in_image_only_container_without_capabilities() {
        let candidate =
            Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))
                .unwrap();
        let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
        assert!(image.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        }));
        let owned = OwnedGuest::connect_cleanup(&candidate).unwrap();
        assert_eq!(owned.execute_cleanup(r#"
name=init-cache-check-$1
docker=/opt/hack-engine/docker
if "$docker" inspect "$name" >/dev/null 2>&1; then exit 1; fi
cleanup() {
 if test "$("$docker" inspect --format '{{index .Config.Labels "io.hack-local.init-cache-test"}}' "$name" 2>/dev/null || true)" = "$1"; then "$docker" rm -f "$name" >/dev/null; fi
}
trap 'cleanup "$1"' EXIT
"$docker" run --rm --pull never --name "$name" --label "io.hack-local.init-cache-test=$1" --network none --read-only --cap-drop ALL --security-opt no-new-privileges --init --entrypoint /bin/sh "$2" -c 'test "$(cat /proc/1/comm)" = docker-init; grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status'
printf 'init-without-capabilities\n'
"#,&[&owned.owner.token,&image]).unwrap(),"init-without-capabilities\n");
    }

    #[test]
    #[ignore = "Manual owned VM and external watchdog required"]
    fn executable_cache_is_pinned_bounded_read_only_and_refuses_replacement() {
        let candidate = Candidate::discover(std::path::Path::new(
            &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root"),
        ))
        .unwrap();
        let owned = OwnedGuest::connect_cleanup(&candidate).unwrap();
        let digest = artifact::digest(&artifact::engine_root(&candidate).join("runc")).unwrap();
        let init_digest =
            artifact::digest(&artifact::engine_root(&candidate).join("docker-init")).unwrap();
        let verify = || {
            assert_eq!(
                owned
                    .execute_cleanup(
                        r#"
cache=/run/hack-local/engine-exec
test "$(stat -c %u:%g:%a "$cache")" = 0:0:700
test "$(stat -c %u:%g:%a "$cache/runc")" = 0:0:555
test "$(stat -c %u:%g:%a "$cache/docker-init")" = 0:0:555
for target in "$cache" /opt/hack-engine/runc /opt/hack-engine/docker-init; do
 test "$(findmnt -n -o FSTYPE --mountpoint "$target")" = tmpfs
 case ",$(findmnt -n -o OPTIONS --mountpoint "$target")," in *,ro,*) ;; *) exit 1;; esac
done
for path in "$cache/runc" /opt/hack-engine/runc; do
 test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$1"
 if (exec 3>>"$path") >/dev/null 2>&1; then exit 1; fi
done
for path in "$cache/docker-init" /opt/hack-engine/docker-init; do
 test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$2"
 if (exec 3>>"$path") >/dev/null 2>&1; then exit 1; fi
done
/opt/hack-engine/runc --version >/dev/null
/opt/hack-engine/docker-init --version >/dev/null
set -- $(stat -f -c '%S %b' "$cache")
test "$(( $1 * $2 ))" = 33554432
printf 'verified-cache\n'
"#,
                        &[&digest, &init_digest],
                    )
                    .unwrap(),
                "verified-cache\n"
            );
        };
        verify();
        for (expected, expected_init) in [
            ("0".repeat(64), init_digest.clone()),
            (digest.clone(), "0".repeat(64)),
            (digest.clone(), init_digest.clone()),
        ] {
            let error = guest(
                &candidate,
                &owned.owner,
                include_str!("guest-runc-cache.sh"),
                &[
                    &owned.owner.token,
                    owned.boot_id(),
                    &expected,
                    &expected_init,
                ],
                false,
            )
            .unwrap_err();
            assert_eq!(error.code, "guest_command_failed");
            verify();
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "Manual owned development VM; HACK_LOCAL_TEST_ROOT and external watchdog required"]
    fn environment_cleanup_retains_lock_when_allocation_admission_refuses() {
        use super::super::environment::PendingEnvironment;
        let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(Path::new(&root)).unwrap();
        let mut guest = OwnedGuest::connect(&candidate).unwrap();
        assert_eq!(guest.profile(), super::super::Profile::Development);
        let values = std::collections::BTreeMap::from([(
            "TOKEN".into(),
            "synthetic-pressure-control".into(),
        )]);
        let lease = PendingEnvironment::new("web", &values, Duration::from_secs(120))
            .unwrap()
            .stage_with_guest(&guest)
            .unwrap();
        // Force a baseline mismatch without creating real host pressure or changing global state.
        guest.guard = Some((
            u64::MAX,
            std::cell::Cell::new(Instant::now() - Duration::from_secs(3)),
        ));
        assert_eq!(
            lease
                .verified_path_with_guest(&guest, "web")
                .err()
                .unwrap()
                .code,
            "runtime_pressure"
        );
        lease.remove_with_guest(&guest).unwrap();
        lease.remove_with_guest(&guest).unwrap();
        assert_eq!(
            guest.before_effect().err().unwrap().code,
            "runtime_pressure"
        );
        assert_eq!(
            OwnedGuest::connect_cleanup(&candidate).err().unwrap().code,
            "provider_busy"
        );
        drop(guest);
        OwnedGuest::connect_cleanup(&candidate).unwrap();
    }

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
    fn a_prepared_start_refuses_ambiguous_capacity_before_any_pool_state() {
        let checkout = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-prepared-sockets-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        let one = super::super::BridgeIntent::new(1).unwrap();
        let request = super::super::prepared_start::Request {
            mode: super::super::prepared_start::Mode::Require,
            store: checkout.join("store"),
        };
        let error = up_with_prepared_base(
            &candidate,
            super::super::Profile::Development,
            super::super::SocketRequests {
                bridges: Some(one),
                minimum_bridges: Some(one),
                ..Default::default()
            },
            None,
            None,
            super::super::prepared_start::Start {
                retained: None,
                prepared: Some(&request),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_arguments");
        assert!(!root(&candidate).exists());
        fs::remove_dir_all(&checkout).unwrap();
    }

    #[test]
    fn templates_are_verified_around_the_first_start_not_after_create() {
        // The state a live fresh pool reached after `machine create`: pinned SmolVM makes no
        // disks and expands nothing until the first start, so only the compressed templates
        // exist. The removed after-create check refused exactly this state.
        let checkout = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-template-sequence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        let templates = root(&candidate).join("home/.smolvm");
        state::private_directory(&templates).unwrap();
        for name in ["storage-template.ext4.zst", "overlay-template.ext4.zst"] {
            fs::write(templates.join(name), b"compressed").unwrap();
        }
        let owner = |adopted: bool| -> Owner {
            let disk = serde_json::json!({"device": 1, "inode": 2, "bytes": 3, "uuid": "fixture"});
            let disk = if adopted {
                disk
            } else {
                serde_json::Value::Null
            };
            serde_json::from_value(serde_json::json!({
                "version": 1, "checkout": "/fixture", "token": "fixture", "machine": "fixture",
                "short_home": "/fixture", "created": adopted, "phase": "creating",
                "process": null, "storage": disk, "overlay": disk, "guest_boot_id": null,
                "daemon_pid": null, "daemon_start": null, "rootfs_digest": null
            }))
            .unwrap()
        };
        let fresh = owner(false);
        let lock = state::Lock::acquire(&root(&candidate)).unwrap();
        // Before the first start: nothing to reuse yet, so the start may proceed.
        verify_templates(
            &candidate,
            &fresh,
            &lock,
            super::super::disk_template::Stage::BeforeUse,
        )
        .unwrap();
        // After a first start that left no verifiable expansion beside the compressed input,
        // its disks are refused rather than adopted.
        let error = verify_templates(
            &candidate,
            &fresh,
            &lock,
            super::super::disk_template::Stage::AfterFirstStart,
        )
        .unwrap_err();
        assert_eq!(error.code, "disk_template_untrusted");
        assert!(
            error.message.contains("missing after the first start"),
            "{}",
            error.message
        );
        // Adopted disks are never formatted again, so their starts do not depend on templates.
        let adopted = owner(true);
        for stage in [
            super::super::disk_template::Stage::BeforeUse,
            super::super::disk_template::Stage::AfterFirstStart,
        ] {
            verify_templates(&candidate, &adopted, &lock, stage).unwrap();
        }
        fs::remove_dir_all(&checkout).unwrap();
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
