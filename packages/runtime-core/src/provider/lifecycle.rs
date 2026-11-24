use backend::smolvm_cli::{SmolvmCli, binary, root};
use backend::{MachineSpec, VmBackend};
mod admission_pool;
mod backend;
mod disk_handles;
mod guest_memory_peak;
pub mod host_filesystem;
mod interrupted;
mod leased_trees;
mod operating_guard;
mod pool_users;
mod prepared_boot;
#[cfg(test)]
mod pressure_tests;
#[cfg(any(target_os = "macos", test))]
mod private_child;
#[cfg(all(test, target_os = "macos"))]
mod provider_repair_tests;
mod relay_process;
mod rootfs_proof;
mod running_start;
mod short_home;
mod socket_repairs;
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

/// Expected executable for read-only identity checks; grants no launch authority.
#[cfg(target_os = "macos")]
pub(super) fn provider_binary(candidate: &Candidate) -> std::path::PathBuf {
    binary(candidate)
}

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
    /// Host-to-guest change notifications for the shared project directories, as the pool's
    /// last boot chose them (`hot_reload`); `null` before the pool exists.
    pub hot_reload: Option<super::hot_reload::Report>,
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
    /// Graph runs this home records, Compose and native-authored, running or
    /// retained after `down`; `null` when either inventory cannot be read.
    pub graph_runs: Option<usize>,
    /// `true` only when the pool runs with a live provider process and records
    /// no graph, environment allocation or exec session (see
    /// [`pool_users`]); `false` when it is not running or something uses it;
    /// `null` when that cannot be established. An active image build is not
    /// observed here; `runtime down` refuses during one.
    pub pool_idle: Option<bool>,
    /// Guest memory peaks of the pool's last boots that ended in `runtime down`, oldest
    /// first (see `guest_memory_peak`). A record only; absent when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest_memory_peaks: Option<Vec<guest_memory_peak::Boot>>,
    /// How a disk-holder scan started now would read the host (`disk_handles`): in this
    /// process, or through `lsof` with the reason; or unknown when the self-test did not
    /// answer in time. Computed when status runs, by the self-test a scan runs first, so
    /// it describes this host and build and no pool or earlier scan. On macOS that test
    /// makes and removes a private file in the process's temporary directory; status
    /// waits at most 100 ms for it, and failing to make the file is reported as a
    /// reason, never an error.
    pub disk_handle_scan: disk_handles::MethodReport,
    /// Provider sockets native found world-accessible and made private for the running
    /// provider (`socket_repairs`); absent when there were none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repaired_sockets: Option<socket_repairs::RepairedSockets>,
    /// Only from `runtime down` of a running pool: graph runs, Compose and
    /// native-authored, whose receipts were live when it stopped the pool under them
    /// (HACK-2456). Their containers
    /// stopped with the guest; `hack up` in each project starts the pool and recovers
    /// the run with its data kept. An empty list when there were none, absent otherwise
    /// or when the inventory could not be read (`interrupted_runs_unknown`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_runs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub interrupted_runs_unknown: bool,
    /// Graph runs whose receipt is live (`pool_users::live_graph_runs`), sorted, so the
    /// CLI can name the projects that keep a running pool in use (HACK-2535). Absent
    /// for an uninitialized pool or when the receipts cannot be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_runs: Option<Vec<String>>,
    /// Whether this process hashes SHA-256 with the CPU's instructions (`sha256_backend`).
    pub hashing: crate::sha256_backend::Report,
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
/// Record a lifecycle phase. Every phase other than `stopped` clears the clean-stop marker
/// in the same write; only `down` records the marker (see [`finish_quiesced_stop`]), so a
/// `stopped` rewrite after a refused start keeps a clean stop clean but never makes an
/// unclean one clean.
fn phase(candidate: &Candidate, owner: &mut Owner, value: &str) -> Result<(), CandidateError> {
    if value != "stopped" {
        owner.clean_stop = None;
    }
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
    if recorded.executable != binary(candidate) {
        artifact::check_process_pin(candidate, &recorded.executable)?;
    }
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
    let lock = match deadline {
        Some(deadline) => state::Lock::acquire_until(root, deadline),
        None => state::Lock::acquire(root),
    }?;
    let current = verify()?;
    Ok((lock, current))
}

/// How long owned cleanup and recovery wait for a provider lease that another operation
/// holds, such as a finite `graph inspect`. Acquisition admits nothing,
/// and a foreground owner that gives up its cleanup exits with its publication and services
/// still bound, so this waits longer than startup does.
#[cfg(target_os = "macos")]
pub(super) const OWNED_CLEANUP_LEASE_WAIT: Duration = Duration::from_secs(30);
/// Refusals of every command that needs the running pool (source transfer,
/// graph start, stop, inspect, exec). They say only what the refusal establishes:
/// the pool record is absent, or its phase is not `running` (which includes a pool
/// that is still booting or quiescing, whose containers may still run). They name no
/// command of their own: the CLI adds the next step for its own command (HACK-2420).
const NOT_STARTED: &str =
    "No native runtime has been started in this Hack home; nothing was changed.";
const NOT_RUNNING: &str = "The native runtime is not in its running state, so this command did not connect to it; nothing was changed.";

/// How long ordinary startup waits for a provider lease that another operation holds, such as
/// a finite `graph inspect` (presentation `ps` takes no provider lease).
pub(super) const STARTUP_LEASE_WAIT: Duration = Duration::from_secs(5);

/// Startup's provider lease. Everything `start_pool` does before taking it is read-only
/// validation, admission sampling and RAII guards, so waiting for a briefly held lease admits
/// nothing early, and on expiry it refuses `provider_busy` with nothing admitted.
pub(super) fn startup_lease(root: &Path, wait: Duration) -> Result<state::Lock, CandidateError> {
    operation_lease(root, Some(Instant::now() + wait), || Ok(())).map(|(lock, ())| lock)
}

/// Serialize a host cache retention decision with every graph state mutation,
/// including when archive acquisition runs with the guest stopped.
pub(super) fn graph_inventory_lease(candidate: &Candidate) -> Result<state::Lock, CandidateError> {
    startup_lease(&root(candidate), STARTUP_LEASE_WAIT)
}

/// Returning the mutation lease requires a fresh Development admission sample under it,
/// taken no sooner than the admission window after the start's first sample, or after an
/// earlier recorded sample of this home that `earlier` finds usable (`admission::opening`).
/// The record is read under the lease. On failure RAII drops the lease, without granting
/// owner/allocation authority.
fn startup_admission_lease(
    root: &Path,
    wait: Duration,
    profile: super::Profile,
    opened: Option<admission::Opened>,
    clock: &impl process::Clock,
    earlier: &impl admission::Earlier,
    observe: impl FnMut() -> Result<admission::Admission, CandidateError>,
) -> Result<(state::Lock, admission::Leased), CandidateError> {
    let lock = startup_lease(root, wait)?;
    let leased = admission::recheck_after_lease(profile, opened, clock, earlier, observe)?;
    Ok((lock, leased))
}

/// Read-only observation takes no mutation lease and detects lifecycle changes around each read.
pub(super) struct ObservedGuest<'a> {
    candidate: &'a Candidate,
    owner: Owner,
}

impl<'a> ObservedGuest<'a> {
    pub(super) fn boot_id(&self) -> Result<&str, CandidateError> {
        self.owner.guest_boot_id.as_deref().ok_or_else(|| {
            CandidateError::new("runtime_changed", "Observed guest boot is unavailable.")
        })
    }
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
        // A stopped pool is not running, not changed: `hack ps` reports it as an ordinary
        // state (HACK-2376). `runtime_changed` stays for a pool that changes during the read.
        if observed_stopped(&observed.owner)? {
            return Err(CandidateError::new(
                "runtime_not_running",
                format!(
                    "The candidate runtime is not running (phase {}).",
                    observed.owner.phase
                ),
            ));
        }
        observed.verify()?;
        // No mutation lease is held here: observe without repairing.
        audit_with(candidate, &observed.owner, Repair::Observe, &mut Vec::new())?;
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
            || current.additional_project_shares != self.owner.additional_project_shares
            || current.application_bridge != self.owner.application_bridge
            || current.dependency_sockets != self.owner.dependency_sockets
            || current.amd64_emulation != self.owner.amd64_emulation
            || current.process != self.owner.process
        {
            return Err(CandidateError::new(
                "runtime_changed",
                "Runtime identity changed during read-only observation.",
            ));
        }
        verify_live(self.candidate, &current)
    }

    pub(super) fn amd64_emulation(&self) -> bool {
        self.owner.amd64_emulation
    }

    pub(super) fn engine_socket(&self) -> Result<std::path::PathBuf, CandidateError> {
        self.verify()?;
        socket(self.candidate, &self.owner, "docker.sock")
    }

    /// The observed runtime incarnation; receipts name the incarnation that owns them.
    pub(super) fn incarnation(&self) -> &str {
        &self.owner.token
    }
}

pub(super) struct OwnedGuest<'a> {
    candidate: &'a Candidate,
    owner: Owner,
    _lock: state::Lock,
    lease_root: (u64, u64),
    allocation_allowed: bool,
    guard: Option<operating_guard::OperatingGuard>,
}

fn operating_observation(
    owner: &Owner,
) -> Result<(admission::OperatingSample, u64), CandidateError> {
    let sample = admission::operating_sample()?;
    let usage = identity::memory_usage(owner.process.as_ref().expect("verified process").pid)?;
    Ok((sample, usage.physical_footprint_bytes))
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
        let root = root(self.candidate);
        self._lock.verify_path(&root)?;
        let current = fs::symlink_metadata(&root).map_err(io)?;
        if (current.dev(), current.ino()) != self.lease_root {
            return Err(CandidateError::new(
                "runtime_changed",
                "Provider mutation root changed.",
            ));
        }
        verify_live(self.candidate, &self.owner)
    }

    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn persistent_identity(
        &self,
    ) -> Result<super::graph::native::persistent_data::GuestIdentity, CandidateError> {
        self.verify()?;
        Ok(super::graph::native::persistent_data::GuestIdentity {
            owner: self.owner.token.clone(),
            boot_id: self.boot_id().into(),
            storage: self.owner.storage.clone().ok_or_else(|| {
                CandidateError::new(
                    "disk_identity_mismatch",
                    "Persistent storage requires an independently retained backing disk.",
                )
            })?,
        })
    }

    /// The pool's primary share. Device-rebind recovery is defined only for single-root
    /// pools and refuses when additional shares exist. That recovery is macOS-only.
    #[cfg(target_os = "macos")]
    pub(super) fn project_share(&self) -> Option<&super::ProjectShareIntent> {
        self.owner.project_share.as_ref()
    }
    /// Whether the pool's additional shares are empty (a single-root pool).
    #[cfg(target_os = "macos")]
    pub(super) fn single_project_share(&self) -> bool {
        self.owner.additional_project_shares.is_empty()
    }
    /// The exact share this pool approved for one project root. A graph binds only its
    /// own root's share; another project's share is never selected for it.
    pub(super) fn project_share_for(&self, project: &Path) -> Option<&super::ProjectShareIntent> {
        self.owner.project_share_for(project)
    }
    /// Exact membership of one retained share in the pool's current share set.
    pub(super) fn has_project_share(&self, share: &super::ProjectShareIntent) -> bool {
        self.owner.project_shares().contains(&share)
    }
    /// Whether this audited boot runs with Rosetta 2 x86_64 translation.
    pub(super) fn amd64_emulation(&self) -> bool {
        self.owner.amd64_emulation
    }
    pub(super) fn before_effect(&self) -> Result<(), CandidateError> {
        if let Some(guard) = &self.guard {
            guard.before_effect(self.owner.profile, || operating_observation(&self.owner))?;
        }
        Ok(())
    }

    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, true, None)
    }

    pub(super) fn connect_cleanup(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false, None)
    }

    pub(super) fn connect_cleanup_for_start(
        candidate: &'a Candidate,
    ) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false, Some(Instant::now() + STARTUP_LEASE_WAIT))
    }

    #[cfg(target_os = "macos")]
    pub(super) fn connect_cleanup_wait(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(
            candidate,
            false,
            Some(Instant::now() + OWNED_CLEANUP_LEASE_WAIT),
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
            return Err(CandidateError::new("runtime_not_running", NOT_STARTED));
        }
        let owner = Owner::load(candidate)?;
        if owner.phase != "running" || owner.guest_boot_id.is_none() {
            return Err(CandidateError::new("runtime_not_running", NOT_RUNNING));
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
            Some(operating_guard::OperatingGuard::connect(
                current.profile,
                || operating_observation(&current),
            )?)
        } else {
            None
        };
        lock.verify_path(&root(candidate))?;
        let lease_root = fs::symlink_metadata(root(candidate)).map_err(io)?;
        Ok(Self {
            candidate,
            owner: current,
            _lock: lock,
            lease_root: (lease_root.dev(), lease_root.ino()),
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

    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn execute_until(
        &self,
        script: &str,
        arguments: &[&str],
        deadline: Instant,
    ) -> Result<String, CandidateError> {
        self.execute_input_until(script, arguments, None, deadline, false)
    }

    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn execute_input_until(
        &self,
        script: &str,
        arguments: &[&str],
        input: Option<&str>,
        deadline: Instant,
        allocation: bool,
    ) -> Result<String, CandidateError> {
        self.verify()?;
        if allocation {
            self.before_effect()?;
        }
        let script = format!(
            "set -eu\ntest \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$1\"\ntest \"$(cat /storage/.hack-local-owner)\" = \"$2\"\ntest \"$(findmnt -n -o FSTYPE --mountpoint /storage)\" = ext4\nshift 2\n{script}"
        );
        let mut args = vec![self.boot_id(), self.incarnation()];
        args.extend_from_slice(arguments);
        let path = socket(self.candidate, &self.owner, "agent.sock")?;
        let result = match input {
            Some(input) => agent::exec_input_until(&path, &script, &args, Some(input), deadline),
            None => agent::exec_until(&path, &script, &args, deadline),
        };
        self.verify()?;
        result
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
        self.verify()?;
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
        self.verify()?;
        Ok(result)
    }
}
/// The host's Rosetta 2 Linux runtime, which SmolVM shares into the guest for x86_64
/// translation. Installed by `softwareupdate --install-rosetta` on Apple silicon.
pub const HOST_ROSETTA_RUNTIME: &str = "/Library/Apple/usr/libexec/oah/RosettaLinux/rosetta";

/// Whether this host can provide Rosetta 2 translation to the guest: Apple silicon macOS
/// with the system-owned Rosetta Linux runtime installed. Read-only.
pub fn host_translation_available() -> bool {
    if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
        return false;
    }
    fs::symlink_metadata(HOST_ROSETTA_RUNTIME).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.uid() == 0
            && metadata.mode() & 0o022 == 0
            && metadata.mode() & 0o111 != 0
    })
}

fn require_host_translation() -> Result<(), CandidateError> {
    if host_translation_available() {
        return Ok(());
    }
    Err(CandidateError::new(
        "amd64_emulation_unavailable",
        "linux/amd64 services need Rosetta 2 on an Apple silicon Mac. Install it with `softwareupdate --install-rosetta`, or run the arm64 image variant. Nothing was started.",
    ))
}

/// The refusal for an emulated platform in a pool booted without x86_64 translation.
pub(super) fn amd64_emulation_not_enabled() -> CandidateError {
    CandidateError::new(
        "amd64_emulation_unavailable",
        "This native VM pool was booted without x86_64 translation; a linux/amd64 image cannot run in it.",
    )
}

/// Whether the recorded provider still runs, checked only where a translation request
/// meets a pool recorded as running without it; elsewhere the answer does not matter.
/// `false` needs positive evidence that the recorded process is gone. A missing identity,
/// an uncertain observation or a live process that fails verification is returned as
/// that error, never as an exit.
fn emulation_pool_alive(
    candidate: &Candidate,
    owner: &Owner,
    requested: bool,
) -> Result<bool, CandidateError> {
    if !(requested && !owner.amd64_emulation && owner.phase == "running") {
        return Ok(true);
    }
    if let Some(process) = &owner.process {
        if !identity::alive(process.pid)? {
            return Ok(false);
        }
    }
    verify_live(candidate, owner)?;
    Ok(true)
}

/// A running pool cannot gain translation without a restart, and running workloads are never
/// stopped implicitly to add it. `alive` is whether the recorded provider process still runs:
/// a pool recorded as running whose process has exited only needs its stop recorded, so it is
/// named as that instead of as a running pool.
fn check_amd64_emulation_request(
    owner: &Owner,
    requested: bool,
    alive: bool,
) -> Result<(), CandidateError> {
    if requested && !owner.amd64_emulation && owner.phase == "running" {
        if !alive {
            return Err(CandidateError::new(
                "pool_process_exited",
                "The native VM pool is recorded as running, but its process has exited, so its stop was never recorded. Run `runtime recover --json` on this native home (it proves the process exited, then records the stop), then start again; nothing was stopped or started.",
            ));
        }
        return Err(CandidateError::new(
            "amd64_emulation_restart_required",
            "The running native VM pool was started without x86_64 translation. Stop every native project that uses it (`hack down` in each), stop the pool (`runtime down --json` on this native home), then start again; nothing was stopped or started.",
        ));
    }
    Ok(())
}

/// Record translation intent before its provider effect, then make the stopped machine match.
/// A created machine whose provider record lacks translation is updated with `machine update
/// --rosetta`; an interrupted update is repeated on the next start, and boot refuses any
/// record, running config or guest registration that differs from the recorded intent.
fn enable_amd64_emulation(
    candidate: &Candidate,
    owner: &mut Owner,
    requested: bool,
    restart: &mut admission_pool::Restart<'_>,
    lock: &state::Lock,
) -> Result<(), CandidateError> {
    let enabled = requested && !owner.amd64_emulation;
    if enabled {
        owner.amd64_emulation = true;
        owner.save(candidate)?;
    }
    if owner.amd64_emulation {
        require_host_translation()?;
        if owner.created && !super::config_audit::recorded_amd64_emulation(candidate, owner)? {
            SmolvmCli::new(candidate, owner).enable_translation()?;
        }
    }
    if enabled {
        // A reserve-qualified restart follows this authorized intent change, rechecked on
        // the provider's updated configuration, instead of refusing it as a changed owner.
        restart.requalify_amd64_emulation(candidate, lock)?;
    }
    Ok(())
}

fn audit_boot(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    audit_boot_after(candidate, owner, Vec::new())
}

/// [`audit_boot`], also recording `earlier` repairs (the fresh-boot socket wait's).
fn audit_boot_after(
    candidate: &Candidate,
    owner: &Owner,
    mut repaired: Vec<String>,
) -> Result<(), CandidateError> {
    let result = audit_with(candidate, owner, Repair::Allowed, &mut repaired);
    // Recorded even when the audit then refuses: a mode already changed stays changed.
    socket_repairs::record(&root(candidate), owner.process.as_ref(), &repaired);
    result
}

/// Whether an audit may repair the provider's world-accessible sockets (HACK-2375). Only a
/// caller holding the provider's mutation lease (boot, warm start, a leased operation)
/// repairs; lease-free observation stays read-only and refuses such a bridge socket as before.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Repair {
    Allowed,
    Observe,
}

/// Adds each provider socket this audit repairs to `repaired` as it is repaired, also when a
/// later check refuses (none under `Repair::Observe`).
fn audit_with(
    candidate: &Candidate,
    owner: &Owner,
    repair: Repair,
    repaired: &mut Vec<String>,
) -> Result<(), CandidateError> {
    super::config_audit::verify(candidate, owner)?;
    super::dependency_socket::verify(candidate, owner)?;
    if repair == Repair::Allowed {
        // The provider's own sockets share the bridge sockets' umask exposure.
        super::bridge::secure_provider_sockets(&owner.real_data_dir(candidate)?, repaired)?;
    }
    if let Some(bridge) = owner.application_bridge {
        let directory = owner.real_data_dir(candidate)?;
        if repair == Repair::Allowed {
            super::bridge::verify_sockets(&directory, bridge, repaired)?;
        } else {
            super::bridge::observe_sockets(&directory, bridge)?;
        }
    }
    // The pinned SmolVM consumes and removes boot-config.json. Its retained running config plus
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
    for share in owner.project_shares() {
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
        || config["resources"]["rosetta"] != owner.amd64_emulation
        || config["resources"]["storage_gib"] != owner.profile.storage_gib()
        || config["resources"]["overlay_gib"] != owner.profile.overlay_gib()
        || config["forkable"] != false
    {
        return Err(CandidateError::new(
            "unaudited_provider_config",
            "Mounts, limits or capabilities differ from the candidate contract.",
        ));
    }
    super::config_audit::verify_running_resources(&config["resources"])?;
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
    super::share_update::require_complete(candidate)?;
    let initialized = root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?;
    if initialized {
        let owner = Owner::load(candidate)?;
        super::project_share::check_request(&owner.project_shares(), Some(requested))?;
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
        let users = pool_users::observe_with(&candidate.state_root, |_| Some(false));
        return Ok(RuntimeStatus {
            network: None,
            project_share: None,
            application_bridge: None,
            dependency_sockets: None,
            dependency_socket_observations: Vec::new(),
            phase: "uninitialized".into(),
            profile: None,
            reclamation: None,
            hot_reload: None,
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
            graph_runs: users.graph_runs,
            pool_idle: Some(false),
            guest_memory_peaks: None,
            disk_handle_scan: disk_handles::method_within(disk_handles::STATUS_METHOD_WAIT),
            repaired_sockets: None,
            interrupted_runs: None,
            interrupted_runs_unknown: false,
            live_runs: None,
            hashing: crate::sha256_backend::report(),
        });
    }
    let owner = Owner::load(candidate)?;
    // Status is read-only. Only the strict, same-owner retirement proof can
    // exclude a native journal retained in place after all resources are removed.
    let users = pool_users::observe_with(&candidate.state_root, |run| {
        #[cfg(feature = "native-config-plan")]
        {
            super::graph::native::retired(candidate, run, &owner.token).ok()
        }
        #[cfg(not(feature = "native-config-plan"))]
        {
            let _ = run;
            Some(false)
        }
    });
    let alive = if let Some(process) = &owner.process {
        // HACK-2579: a killed provider whose parent has not reaped it (a zombie), or a
        // reused pid, is gone too; status then reports `process-exited`.
        let alive = !identity::provider_gone(process)?;
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
    let phase = if alive == Some(false) && owner.phase == "running" {
        "process-exited".to_owned()
    } else {
        owner.phase.clone()
    };
    let pool_idle = pool_users::pool_idle(&phase, alive, users);
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
        hot_reload: Some(super::hot_reload::report(owner.hot_reload)),
        guest_memory_mib: Some(owner.profile.memory_mib()),
        application_bridge: owner.application_bridge,
        phase,
        qualification: owner.profile.qualification(),
        machine: Some(owner.machine.clone()),
        process_alive: alive,
        engine_socket: Some(format!(
            "unix://{}",
            owner.data_dir().join("docker.sock").display()
        )),
        persistent_disks_identified: owner.storage.is_some(),
        repaired_sockets: socket_repairs::report(&root(candidate), owner.process.as_ref()),
        interrupted_runs: None,
        interrupted_runs_unknown: false,
        live_runs: pool_users::live_graph_runs(&candidate.state_root),
        hashing: crate::sha256_backend::report(),
        guest_boot_id: owner.guest_boot_id,
        prepared_base: super::prepared_start::status(candidate),
        graph_runs: users.graph_runs,
        pool_idle,
        guest_memory_peaks: guest_memory_peak::history(&root(candidate)),
        disk_handle_scan: disk_handles::method_within(disk_handles::STATUS_METHOD_WAIT),
    })
}

pub fn up(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    // The profile lookup below is a strict owner read; a squatted clean-stop alias must
    // move to a fresh alias first, as in `start_pool`.
    restore_released_short_home_before_use(candidate)?;
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
    let choice = admission_pool::select(candidate, profile)?;
    admission_pool::probe(candidate, profile, &choice)
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
            amd64_emulation: false,
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
    // `admission_reused` on this span says whether a recorded earlier sample replaced the
    // admission wait; a start whose sample under the lease was not accepted leaves it out.
    crate::timings::measure_attributed(crate::timings::Step::VmEnsure, None, |_, attributes| {
        start_pool_observed(
            candidate,
            profile,
            bridge_request,
            network,
            dependency_request,
            project_share,
            start,
            &mut attributes.admission_reused,
        )
    })
}

// The last argument reports on the caller's timing span, on either outcome.
#[allow(clippy::too_many_arguments)]
fn start_pool_observed(
    candidate: &Candidate,
    profile: super::Profile,
    bridge_request: super::bridge::Request,
    network: Option<super::NetworkIntent>,
    dependency_request: super::dependency_socket::Request,
    project_share: Option<super::ProjectShareIntent>,
    start: super::prepared_start::Start<'_>,
    admission_reused: &mut Option<bool>,
) -> Result<RuntimeStatus, CandidateError> {
    // A mistyped setting is refused before any effect.
    let hot_reload = super::hot_reload::Setting::from_environment()?;
    let admission_reuse = admission::opening::Reuse::from_environment()?;
    // A clean stop whose alias path another entry holds is moved to a fresh alias before
    // any strict owner read below refuses it.
    restore_released_short_home_before_use(candidate)?;
    let retained = start.retained;
    if start.amd64_emulation {
        require_host_translation()?;
    }
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
    let request = running_start::StartRequest {
        bridges: bridge_request,
        network: network.as_ref(),
        dependencies: dependency_request,
        project_share: project_share.as_ref(),
        amd64_emulation: start.amd64_emulation,
        own_run: retained.map(|(run, _)| run),
    };
    super::network_update::require_complete(candidate)?;
    super::share_update::require_complete(candidate)?;
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
    let (existing, existing_network, existing_dependencies, existing_share, existing_additional) =
        if root(candidate)
            .join("owner.json")
            .try_exists()
            .map_err(io)?
        {
            let owner = Owner::load(candidate)?;
            request.check(
                &owner,
                emulation_pool_alive(candidate, &owner, request.amd64_emulation)?,
            )?;
            (
                owner.application_bridge,
                owner.network.clone(),
                owner.dependency_sockets,
                owner.project_share.clone(),
                owner.additional_project_shares.clone(),
            )
        } else {
            (
                requested,
                network.clone().unwrap_or_default(),
                dependencies,
                project_share.clone(),
                Vec::new(),
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
    // A pool that is already running and owned by this home allocates nothing, so it takes
    // the named fast path instead of the admission windows below (`running_start`).
    if let Some(running) = running_start::select(candidate, profile)? {
        return crate::timings::measure(crate::timings::Step::VmReattach, None, |_| {
            running_start::resume(candidate, running, &request, || {
                #[cfg(target_os = "macos")]
                if let Some(guard) = &retained_guard {
                    guard.verify(candidate)?;
                }
                Ok(())
            })
        });
    }
    // Admission before aliases, provider commands, disks or VM effects. Only
    // independently verified ownership of existing disks (a live pool, or an exactly
    // clean stopped pool this start reuses) avoids charging a second VM's disks.
    let mut admission_owner = admission_pool::select(candidate, profile)?;
    // A host this start sees failing, or cannot observe, before it holds the lease is not
    // one an earlier record may vouch for: the record is removed if the lease is free.
    let forget_record = || {
        if profile == super::Profile::Development {
            admission::opening::forget_unleased(&root(candidate));
        }
    };
    let admission = admission_pool::probe(candidate, profile, &admission_owner)
        .inspect_err(|_| forget_record())?;
    if !admission.admitted {
        forget_record();
        return Err(CandidateError::new(
            "admission_rejected",
            admission.reasons.join(" "),
        ));
    }
    // Development qualifies on two chained samples at least the admission window apart:
    // this one, and one under the startup lease. The checks between them fill the window,
    // so only the remainder of it is ever slept.
    let admission_clock = process::MonotonicClock::new();
    let (mut samples, opened) = if profile == super::Profile::Development {
        let opened =
            admission::open(&admission, &admission_clock).inspect_err(|_| forget_record())?;
        (vec![admission], Some(opened))
    } else {
        // Retain the frozen Research window and baseline semantics.
        let samples = admission::sample_with(profile, || {
            admission_pool::probe(candidate, profile, &admission_owner)
        })?;
        (samples, None)
    };
    // The content proofs, taken inside the admission window and rechecked under the lease
    // (`leased_trees`). A boot records them in its tree witness (`tree_witness`). A cleanly
    // stopped pool's root files are proven beside them, read-only, on a thread of their own
    // (`rootfs_proof`): both fill the window instead of adding to the start after it. Root
    // files on a filesystem where that proof could not be accepted get none, and no thread.
    // No thread, or a proof that fails or panics, is no early proof, never a refusal.
    let (proven_trees, early_rootfs) =
        rootfs_proof::early_beside(candidate, || -> Result<_, CandidateError> {
            let smolvm = artifact::verify_witnessed(candidate, &artifact::SMOLVM)?;
            let engine = artifact::verify_witnessed(candidate, &artifact::ENGINE)?;
            Ok(std::collections::BTreeMap::from([
                (super::tree_witness::SMOLVM.to_owned(), smolvm),
                (super::tree_witness::ENGINE.to_owned(), engine),
            ]))
        });
    let mut proven_trees = proven_trees?;
    super::network_tools::verify(candidate)?;
    // A recorded earlier sample of this home may replace the rest of the window, never a
    // sample: the start takes its sample under the lease either way (`admission::opening`).
    let pool_root = root(candidate);
    let opening_host = admission::opening::System;
    let opening = admission::opening::Opening::new(&pool_root, &opening_host, admission_reuse);
    let (lock, leased) = startup_admission_lease(
        &pool_root,
        STARTUP_LEASE_WAIT,
        profile,
        opened,
        &admission_clock,
        &opening,
        || admission_pool::probe(candidate, profile, &admission_owner),
    )?;
    let admission::Leased {
        samples: fresh_samples,
        reused,
        sampled_at,
    } = leased;
    *admission_reused = reused;
    samples.extend(fresh_samples);
    // The trees were proven before the lease, which is what fences their writers. Before
    // anything below reads or executes them, each must still be what its proof saw, or be
    // proven again; the witness this boot records names these proofs (`leased_trees`).
    leased_trees::recheck(candidate, &lock, &mut proven_trees)?;
    // The same for the root files proven beside them: still what that proof saw, or proven
    // again here, before the admission record, any later owner record update or any
    // provider command (`rootfs_proof`). Without an early proof, or once the root files are
    // not on a qualified filesystem, nothing is proven here and `prepare_rootfs` decides.
    // The recheck writes nothing; an alias repaired before admission stays repaired.
    let leased_rootfs = rootfs_proof::recheck(candidate, &lock, early_rootfs)?;
    // Recheck a clean stop's alias under the lease before the release checks probe its
    // sockets or the provider runs with it as HOME.
    restore_released_short_home(candidate)?;
    // First under the lease, before admission or anything else can rewrite the phase: a
    // set-aside of a previous failed first boot must not meet this start's new disks.
    if root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        interrupted::before_boot(candidate, &Owner::load(candidate)?)?;
    }
    // Under the lease: the selection is rechecked. A stopped pool keeps the reserve only if
    // a sample needs it, and then its provider release (VM lock, disk handles, listeners,
    // provider configuration) is proven; otherwise this start uses the fresh budget.
    let settled = admission_pool::settle(candidate, &mut admission_owner, &lock, &mut samples)?;
    #[cfg(target_os = "macos")]
    if let Some(guard) = &retained_guard {
        guard.verify(candidate)?;
    }
    super::network_update::require_complete(candidate)?;
    super::share_update::require_complete(candidate)?;
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
    // This start's passing sample under the lease becomes the home's recorded earlier
    // sample, also when the start reused one. It is written only now that the pool has its
    // owner record: an unowned pool root may hold nothing but the operation lock
    // (`require_fresh_source_pool` above), and both rechecks have passed. A record that
    // cannot be written costs the next start its wait and nothing else.
    if let (Some(_), Some(sample)) = (reused, samples.last()) {
        admission::opening::record(&pool_root, &lock, &opening_host, sample, sampled_at);
    }
    // These leased checks must stay a superset of `running_start::StartRequest::check`, which
    // the fast path runs under its lease; network is bound to the pre-lease receipt here.
    super::project_share::check_request(&owner.project_shares(), project_share.as_ref())?;
    if owner.project_share != existing_share
        || owner.additional_project_shares != existing_additional
    {
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
    let alive = emulation_pool_alive(candidate, &owner, start.amd64_emulation)?;
    check_amd64_emulation_request(&owner, start.amd64_emulation, alive)?;
    if fresh_owner {
        super::graph::initialize_owner_registry(candidate, &owner)?;
    } else {
        super::graph::verify_owner_registry(candidate, &owner)?;
    }
    super::dependency_socket::verify(candidate, &owner)?;
    state::write(&root(candidate).join("admission.json"), &samples)?;
    // A pool running at this point became running after `running_start::select` (a concurrent
    // start won the lease first); every other running pool took the fast path. Keep the full
    // re-verification for that race.
    if owner.phase == "running" {
        request.check_free_slots(candidate, &owner)?;
        return crate::timings::measure(crate::timings::Step::VmReattach, None, |_| {
            if let Some(selected) = settled.selected() {
                selected.reverify(candidate)?;
            }
            #[cfg(target_os = "macos")]
            if let Some(guard) = &retained_guard {
                guard.verify(candidate)?;
            }
            verify_live(candidate, &owner)?;
            audit_boot(candidate, &owner)?;
            status(candidate)
        });
    }
    // Only a clean stopped selection continues, as a restart of its verified retained disks.
    let mut restart = admission_pool::restart_only(candidate, settled, &owner, &lock)?;
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
            "Previous operation did not finish; run hack native recover (runtime recover --json with the executor), then start again.",
        ));
    }
    if let Some(process) = &owner.process {
        if !identity::provider_gone(process)? {
            return Err(CandidateError::new(
                "process_identity_mismatch",
                "Previous PID is still alive; refusing restart or adoption.",
            ));
        }
        verify_disks(candidate, &owner)?;
    }
    // The provider mounts every share at boot: each must still be its exact approved root.
    super::project_share::check_boot(&owner.project_shares())?;
    enable_amd64_emulation(
        candidate,
        &mut owner,
        start.amd64_emulation,
        &mut restart,
        &lock,
    )?;
    // The root files were last compared before the owner record updates and provider
    // commands above: `prepare_rootfs` walks their metadata once more before the digest of
    // the recheck is used, and proves them by content on any difference (`rootfs_proof`).
    let rootfs_metadata = prepare_rootfs(candidate, &mut owner, leased_rootfs.as_ref())?;
    // Guest commands search the guest's own directories before the engine share
    // (`agent::GUEST_PATH`): the engine binaries are found only if the root files hold
    // nothing of their names.
    agent::require_engine_names_unshadowed(
        &root(candidate).join("rootfs"),
        &artifact::engine_root(candidate),
    )?;
    proven_trees.insert(
        super::tree_witness::ROOTFS.to_owned(),
        super::tree_witness::Proven {
            metadata: rootfs_metadata,
            content: owner.rootfs_digest.clone().unwrap_or_default(),
        },
    );
    if !owner.created {
        // A reserve-qualified start never reaches `machine create`.
        let fresh = admission_pool::fresh_create(&restart)?;
        // SmolVM clones the expanded templates in `home/.smolvm` into the new disks at the
        // machine's first start. Choose them (stock, or an activated prepared base) and verify
        // them before the phase records a create attempt; `verify_templates` checks again
        // around that start.
        super::prepared_start::before_create(candidate, &owner, &lock, start.prepared)?;
        phase(candidate, &mut owner, "creating")?;
        let spec = pool_spec(candidate, &owner, profile);
        create_machine(&SmolvmCli::new(candidate, &owner), &spec, fresh)?;
        super::config_audit::pin_created_network(candidate, &mut owner)?;
        owner.created = true;
        owner.save(candidate)?;
    }
    // A fresh admission immediately before boot, on the qualification's basis, closes
    // installation/lock delays. `machine start` needs the permit it leads to.
    // The check before boot is a host sample too: one that fails or cannot be taken removes
    // the record this start wrote above, so a retry waits its window again.
    let forget_leased = || {
        if profile == super::Profile::Development {
            admission::opening::forget(&pool_root, &lock);
        }
    };
    let boot = match admission_pool::admit_boot(
        candidate,
        profile,
        &restart,
        samples.last().and_then(|sample| sample.swapouts),
    )
    .inspect_err(|_| forget_leased())?
    {
        admission_pool::BootGate::Admitted(boot) => boot,
        admission_pool::BootGate::Refused(error) => {
            forget_leased();
            // Nothing booted: a clean stop stays clean, an unclean one stays unclean.
            phase(candidate, &mut owner, "stopped")?;
            return Err(error);
        }
    };
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
    // The last check before `machine start` releases the VM lock to the provider.
    let permit = boot.release(candidate, &lock)?;
    // `begin_boot` keeps only one earlier boot id; dead-owner recovery of a run from an
    // older boot needs its raw id, so record the ids being superseded first.
    super::boot_history::record(candidate, &owner)?;
    let previous_boot = owner.begin_boot();
    owner.reclamation = Some(boot_reclamation_policy());
    // Chosen from the shares this boot mounts; the `booting` receipt below records it before
    // `machine start` reads it.
    owner.hot_reload = {
        let shares = owner.project_shares();
        let roots: Vec<&Path> = shares.iter().map(|share| share.project.as_path()).collect();
        super::hot_reload::decide(hot_reload, &roots)
    };
    // The previous provider was proven dead above. Until this start records its own provider,
    // the receipt names none, so recovery identifies it (`interrupted`) instead of trusting the
    // old identity.
    owner.process = None;
    phase(candidate, &mut owner, "booting")?;
    crate::timings::measure(crate::timings::Step::VmBoot, None, |_| {
        start_machine(&SmolvmCli::new(candidate, &owner), permit)?;
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
        // A witness is recorded only where it can be accepted (a qualified filesystem).
        super::tree_witness::record_boot(
            candidate,
            &lock,
            result.is_ok() && witness_qualified(candidate),
            owner.process.as_ref(),
            proven_trees,
        );
        if let Err(error) = &result {
            // Disk rejection must not keep an allocation alive. Process authority is
            // independent of disk adoption; this is an unclean stop, never reconciliation.
            let process = owner.process.as_ref().expect("process just recorded");
            let cleanup = stop_verified_provider(process, &binary(candidate));
            state::write(
                &root(candidate).join("failed-boot.json"),
                &failed_boot_record(error, process, cleanup.is_ok()),
            )?;
            if cleanup.is_ok() {
                phase(candidate, &mut owner, "failed-boot-stopped")?;
            }
            cleanup.map_err(failed_boot_stop_error)?;
        }
        result
    })
}

fn pool_spec(candidate: &Candidate, owner: &Owner, profile: super::Profile) -> MachineSpec {
    MachineSpec {
        cpus: profile.cpus(),
        memory_mib: profile.memory_mib(),
        storage_gib: profile.storage_gib(),
        overlay_gib: profile.overlay_gib(),
        engine_share: Some(artifact::engine_root(candidate)),
        amd64_translation: owner.amd64_emulation,
        project_shares: owner.project_shares().into_iter().cloned().collect(),
        network: owner.network.clone(),
        exposed_sockets: owner
            .application_bridge
            .map(|bridge| bridge.guest_paths())
            .unwrap_or_default(),
        mounted_sockets: owner
            .dependency_sockets
            .map(|intent| {
                intent
                    .paths(&owner.short_home)
                    .into_iter()
                    .map(|path| (path.host_path, path.guest_path))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Define a machine whose first boot can allocate disks; reserve selections cannot create.
fn create_machine(
    backend: &impl VmBackend,
    spec: &MachineSpec,
    fresh: admission_pool::FreshCreate,
) -> Result<(), CandidateError> {
    backend.create(spec, fresh)
}

/// `machine start` hands the VM lock to the provider; only a released boot admission may.
fn start_machine(
    backend: &impl VmBackend,
    permit: admission_pool::StartPermit,
) -> Result<(), CandidateError> {
    backend.start(permit).map_err(stalled_boot)
}

/// The pinned provider's words when it ends a start whose VM showed no boot progress for its
/// limit (30 seconds).
const NO_BOOT_PROGRESS: &str = "no boot progress";

/// Names a start the provider ended for lack of boot progress, with a message that is safe to
/// show. Any other failure is returned unchanged. The receipt stays `booting`, as for every
/// failed `machine start`.
fn stalled_boot(error: CandidateError) -> CandidateError {
    if error.code != "provider_command_failed" || !error.message.contains(NO_BOOT_PROGRESS) {
        return error;
    }
    let stalled = CandidateError::new(
        "provider_boot_stalled",
        "The provider ended the start: the VM made no boot progress within the provider's \
         limit. Recover the pool before retrying. A large shared project directory is one \
         known cause; HACK_NATIVE_HOT_RELOAD=off starts without the scan that causes it.",
    );
    // The provider's own line stays with the renamed failure.
    match error
        .refusals
        .as_ref()
        .and_then(|diagnostics| diagnostics.provider_line.as_deref())
    {
        Some(line) => stalled.with_provider_line(line),
        None => stalled,
    }
}

/// SIGTERM a provider whose identity is verified at the signal, then wait for it to exit.
fn stop_verified_provider(
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
                "Verified provider did not stop after SIGTERM.",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Verify the expanded disk templates around a start that can format this pool's disks.
///
/// The pinned SmolVM formats a machine's disks from the templates during its first start
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

#[cfg(test)]
#[path = "lifecycle/boot_sequence_tests.rs"]
mod boot_sequence_tests;

/// The record of a boot that failed after its provider process was recorded
/// (`failed-boot.json` in the pool's private state directory). `process_absent` says whether
/// the cleanup that followed the failure confirmed the provider stopped; it does not mean the
/// provider had exited by itself.
///
/// The record keeps the failure's message as well as its code. A command reports most
/// failures by code alone, because a message that is not a fixed literal can carry a path or
/// another runtime value; many failures share one code (`provider_state` is any I/O error),
/// and without the message the cause of a failed boot can only be found by reproducing it.
/// This file is private to the home, like the paths it may name.
fn failed_boot_record(
    failure: &CandidateError,
    process: &identity::ProcessIdentity,
    cleanup_confirmed: bool,
) -> serde_json::Value {
    json!({
        "failure_code": failure.code, "failure_message": failure.message,
        "process": process, "process_absent": cleanup_confirmed, "disk_adoption": false,
    })
}

fn failed_boot_stop_error(failure: CandidateError) -> CandidateError {
    CandidateError::new(
        failure.code,
        "Failed-boot provider cleanup could not be confirmed. Run hack native recover before retrying (with an executor selected by hand: the same executor and --candidate-root as the failed start, then runtime recover --json).",
    )
}

fn finish_boot(
    candidate: &Candidate,
    owner: &mut Owner,
    previous_boot: Option<&str>,
    lock: &state::Lock,
) -> Result<RuntimeStatus, CandidateError> {
    finish_boot_with(
        owner,
        |owner| {
            verify_templates(
                candidate,
                owner,
                lock,
                super::disk_template::Stage::AfterFirstStart,
            )?;
            owner
                .application_bridge
                .map(|bridge| {
                    owner
                        .real_data_dir(candidate)
                        .map(|directory| (directory, bridge))
                })
                .transpose()
        },
        |owner| verify_live(candidate, owner),
        |owner, repaired| audit_boot_after(candidate, owner, repaired),
        |owner| adopt_boot(candidate, owner, previous_boot, lock),
        &process::MonotonicClock::new(),
    )
}

/// Fresh boot's ordering boundary. Only effectful host/guest operations are
/// injected: the real complete-set socket wait always precedes audit/adoption.
fn finish_boot_with<S, T>(
    owner: &mut S,
    prepare: impl FnOnce(
        &S,
    ) -> Result<
        Option<(std::path::PathBuf, super::bridge::BridgeIntent)>,
        CandidateError,
    >,
    mut verify_provider: impl FnMut(&S) -> Result<(), CandidateError>,
    audit: impl FnOnce(&S, Vec<String>) -> Result<(), CandidateError>,
    adopt: impl FnOnce(&mut S) -> Result<T, CandidateError>,
    clock: &impl process::Clock,
) -> Result<T, CandidateError> {
    // Before any disk is adopted: a refusal here takes the caller's failed-boot path.
    let bridge = prepare(owner)?;
    // The provider's agent-ready signal can precede expose-thread socket binds.
    // Wait before adoption, without weakening the immediate audit used by
    // running-pool commands. Failure keeps the existing verified-stop path.
    let mut repaired = Vec::new();
    if let Some((directory, bridge)) = bridge {
        repaired =
            super::bridge::wait_for_sockets(&directory, bridge, || verify_provider(owner), clock)?;
    }
    audit(owner, repaired)?;
    adopt(owner)
}

fn adopt_boot(
    candidate: &Candidate,
    owner: &mut Owner,
    previous_boot: Option<&str>,
    lock: &state::Lock,
) -> Result<RuntimeStatus, CandidateError> {
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
    let translation = if owner.amd64_emulation {
        "enabled"
    } else {
        "disabled"
    };
    let observed = guest(
        candidate,
        owner,
        include_str!("guest-translation.sh"),
        &[&owner.token, boot, translation],
        false,
    )?;
    if observed != format!("amd64-translation-{translation}-v1\n") {
        return Err(CandidateError::new(
            "amd64_emulation",
            "Guest x86_64 translation differs from the pool's audited intent; engine startup refused.",
        ));
    }
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
    engine_ping(|| socket(candidate, owner, "docker.sock"))?;
    if network_mode != "isolated" {
        // Build-bridge isolation is not a startup requirement: graph containers never
        // join the default bridge. A failure leaves no readiness marker, and native
        // image builds refuse on that pool (see `image_build::verify_build_network`).
        let _ = guest(
            candidate,
            owner,
            include_str!("guest-build-network.sh"),
            &[
                network_mode,
                owner.guest_boot_id.as_deref().expect("verified boot"),
            ],
            false,
        );
    }
    start_memory_return(owner, |script, args, background| {
        guest(candidate, owner, script, args, background)
    });
    start_memory_peak(owner, |script, args, background| {
        guest(candidate, owner, script, args, background)
    });
    phase(candidate, owner, "running")?;
    status(candidate)
}

/// Start the guest job that returns freed memory to the host (`guest-memory-return.sh`):
/// it reports smaller free blocks and compacts once when the guest has gone quiet. It runs
/// in the agent's background mode and its result is ignored, so a fresh boot neither waits
/// for it nor fails because of it. The warm `running_start` path does not boot and so does
/// not start it.
fn start_memory_return(
    owner: &Owner,
    run: impl FnOnce(&str, &[&str], bool) -> Result<String, CandidateError>,
) {
    let Some(boot) = owner.guest_boot_id.as_deref() else {
        return;
    };
    let _ = run(
        include_str!("guest-memory-return.sh"),
        &[&owner.token, boot],
        true,
    );
}

/// Start the guest job that records this boot's memory peak (`guest-memory-peak.sh`), the
/// same way as [`start_memory_return`]: background mode, result ignored, fresh boots only.
fn start_memory_peak(
    owner: &Owner,
    run: impl FnOnce(&str, &[&str], bool) -> Result<String, CandidateError>,
) {
    let Some(boot) = owner.guest_boot_id.as_deref() else {
        return;
    };
    let _ = run(
        include_str!("guest-memory-peak.sh"),
        &[&owner.token, boot],
        true,
    );
}

/// Read this boot's memory peak from a running guest, just before `down` stops it. Best-effort
/// and bounded by [`guest_memory_peak::READ_BUDGET`]: a guest that does not answer and a
/// reading that does not decode give `None`, and `down` goes on exactly as it would have.
/// Nothing is written here; `down` keeps the reading only after the stop has finished.
fn read_memory_peak(
    state_root: &Path,
    owner: &Owner,
    read: impl FnOnce(&str, &[&str], Instant) -> Result<String, CandidateError>,
) -> Option<guest_memory_peak::Boot> {
    if owner.phase != "running" {
        return None;
    }
    let boot = owner.guest_boot_id.as_deref()?;
    let deadline = Instant::now() + guest_memory_peak::READ_BUDGET;
    let output = read(
        guest_memory_peak::READ_SCRIPT,
        &[&owner.token, boot],
        deadline,
    )
    .ok()?;
    Some(guest_memory_peak::Boot {
        boot_id: boot.to_owned(),
        guest_memory_mib: owner.profile.memory_mib(),
        cpus: owner.profile.cpus(),
        reading: guest_memory_peak::parse(&output)?,
        graphs: guest_memory_peak::graph_runs(state_root),
    })
}

/// Keep a reading taken before the stop, once `down` has succeeded. It runs after the stop
/// and every owner write the stop needs, so the record cannot take the disk space or the
/// time of either, and a record that cannot be written leaves `result` as it is.
fn keep_memory_peak(
    pool_root: &Path,
    peak: Option<guest_memory_peak::Boot>,
    result: &mut Result<RuntimeStatus, CandidateError>,
) {
    let (Some(boot), Ok(status)) = (peak, result.as_mut()) else {
        return;
    };
    if let Ok(boots) = guest_memory_peak::record(pool_root, boot) {
        status.guest_memory_peaks = Some(boots);
    }
}

/// Copy (once) and prove the pool's guest rootfs by content. Returns its metadata digest
/// (`tree_witness`), taken around the final content proof. `leased` is what this start's
/// recheck under the lease established for the root files (`rootfs_proof::recheck`); it
/// stands in for the proof here only for the marker and the pin it was made against, and
/// only while one more metadata walk, made here, finds the root files as the recheck left
/// them (`rootfs_proof::Leased::stands`).
fn prepare_rootfs(
    candidate: &Candidate,
    owner: &mut Owner,
    leased: Option<&rootfs_proof::Leased>,
) -> Result<String, CandidateError> {
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
    let marker = rootfs_marker(owner)?;
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
    if let Some(metadata) = leased
        .and_then(|leased| leased.stands(&destination, &marker, owner.rootfs_digest.as_deref()))
    {
        return Ok(metadata);
    }
    prove_rootfs(&destination, &marker, owner.rootfs_digest.as_deref())
}

/// The provider's per-machine readiness marker in the shared guest rootfs, which every
/// rootfs proof excludes.
/// Whether the witnessed trees (the SmolVM tree, the engine tree and the pool's rootfs copy)
/// are all on a filesystem qualified for the metadata check. A witness is accepted only when
/// they are; otherwise every start proves them by content.
pub(super) fn witness_qualified(candidate: &Candidate) -> bool {
    super::tree_witness::qualified(&[
        &artifact::tree_root(candidate, &artifact::SMOLVM),
        &artifact::tree_root(candidate, &artifact::ENGINE),
        &root(candidate).join("rootfs"),
    ])
}

pub(super) fn rootfs_marker(owner: &Owner) -> Result<String, CandidateError> {
    let data = owner.data_dir();
    let hash = data.file_name().and_then(|v| v.to_str()).ok_or_else(|| {
        CandidateError::new("foreign_state", "Owned machine identity is missing.")
    })?;
    Ok(format!(".smolvm-ready.{hash}"))
}

/// Prove the rootfs copy by content against its pin, bracketed by its metadata digest, which
/// is returned.
pub(super) fn prove_rootfs(
    destination: &Path,
    marker: &str,
    expected: Option<&str>,
) -> Result<String, CandidateError> {
    let changed = || {
        CandidateError::new(
            "artifact_digest_mismatch",
            "Runtime guest base changed; refusing boot.",
        )
    };
    let before = super::tree_witness::metadata_digest(destination, Some(marker))?;
    super::tree_witness::note_content_proof();
    if Some(artifact::rootfs_digest(destination, Some(marker))?.as_str()) != expected {
        return Err(changed());
    }
    if super::tree_witness::metadata_digest(destination, Some(marker))? != before {
        return Err(changed());
    }
    Ok(before)
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
    let marker = rootfs_marker(owner)?;
    // A running pool whose boot witnessed this rootfs by content against this pin accepts an
    // unchanged metadata digest (`tree_witness`); a stopped pool, or any difference, proves by
    // content. Read-only: nothing is recorded here.
    if owner.phase == "running"
        && let Some(process) = &owner.process
        && super::tree_witness::qualified(&[
            &artifact::tree_root(candidate, &artifact::SMOLVM),
            &artifact::tree_root(candidate, &artifact::ENGINE),
        ])
        && let Some(metadata) = super::tree_witness::qualified_digest(&destination, Some(&marker))?
        && super::tree_witness::matches(
            candidate,
            process,
            super::tree_witness::ROOTFS,
            &metadata,
            expected,
        )
    {
        return Ok(());
    }
    super::tree_witness::note_content_proof();
    if artifact::rootfs_digest(&destination, Some(&marker))? != expected {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Retained guest rootfs changed.",
        ));
    }
    Ok(())
}

/// How long one attempt of the host-side engine check may take from its request to the end
/// of the reply, and how many attempts a boot makes.
///
/// Three seconds is what the single attempt allowed each read before, so the first attempt
/// accepts every reply the old check accepted, apart from one that arrives in pieces more
/// than three seconds apart in total: the limit now covers the whole exchange, where it used
/// to start again at every read. A forward that never answers fails the boot after about
/// 9.2 s (three attempts and two pauses); it used to fail it after 3 s.
const ENGINE_PING_LIMIT: Duration = Duration::from_secs(3);
const ENGINE_PING_ATTEMPTS: u32 = 3;
/// The pause before each further attempt.
const ENGINE_PING_PAUSE: Duration = Duration::from_millis(100);
/// What the path checks answer for a path that is not safe to connect to: a socket that is
/// not this user's own socket, a symlink on the way to it, or an ancestor that is not a
/// directory. None of these is retried.
const ENGINE_SOCKET_REFUSALS: [&str; 3] = ["foreign_state", "aliased_state", "invalid_state"];
/// The longest single wait for reply bytes within an attempt.
const ENGINE_PING_WAIT: Duration = Duration::from_millis(250);

/// Confirm from the host that the engine answers through the provider's forwarded socket.
///
/// The engine has already answered inside the guest when this runs. The provider's host
/// socket is a forward to it, and the forward can lag behind the provider's ready signal:
/// a connection accepted in that window is never answered. One such connection used to
/// fail the whole boot (HACK-2475: the request was written, no reply came for three
/// seconds, and the boot was stopped as failed). So every attempt opens a fresh connection,
/// and the boot fails when all of them failed, or at once on an unsafe path (below). The
/// error is the last attempt's, so the failure codes are the ones a single attempt reported.
///
/// `socket` yields the path to connect to and is asked again for every attempt, so each
/// connection is made to a path whose checks have just passed, as the single attempt's was.
/// A path refused as unsafe ([`ENGINE_SOCKET_REFUSALS`]) ends the check at once: that is
/// not a forward that is still coming up. A socket file that is not there yet is retried.
/// The check does not identify which process answers; it never did.
fn engine_ping(
    socket: impl Fn() -> Result<std::path::PathBuf, CandidateError>,
) -> Result<(), CandidateError> {
    engine_ping_within(
        socket,
        ENGINE_PING_LIMIT,
        ENGINE_PING_ATTEMPTS,
        ENGINE_PING_PAUSE,
    )
}

fn engine_ping_within(
    socket: impl Fn() -> Result<std::path::PathBuf, CandidateError>,
    limit: Duration,
    attempts: u32,
    pause: Duration,
) -> Result<(), CandidateError> {
    let mut result = Err(CandidateError::new(
        "engine_not_ready",
        "Private engine ping was not attempted.",
    ));
    for attempt in 0..attempts {
        if attempt > 0 {
            std::thread::sleep(pause);
        }
        result = socket().and_then(|path| engine_ping_once(&path, limit));
        match &result {
            Ok(()) => break,
            Err(error) if ENGINE_SOCKET_REFUSALS.contains(&error.code) => break,
            Err(_) => {}
        }
    }
    result
}

/// One attempt on its own connection. `limit` covers the whole reply: it is read in waits of
/// at most [`ENGINE_PING_WAIT`], and the attempt fails when the limit has passed, whatever
/// the last read returned, so a reply that trickles in cannot outlast it by more than one
/// wait. The request is sent with the limit as its write timeout. Connecting is not timed: a
/// local connect normally returns at once or is refused, and only a listener with a full
/// backlog could hold it.
///
/// Both socket timeouts are set once, before the request is written. Setting one later is
/// not safe here: on macOS it fails with `EINVAL` on a connection the engine has already
/// closed, which is what the engine does as soon as it has answered.
fn engine_ping_once(path: &Path, limit: Duration) -> Result<(), CandidateError> {
    const MOST: usize = 8192;
    let deadline = Instant::now() + limit;
    let mut stream = UnixStream::connect(path).map_err(io)?;
    stream.set_write_timeout(Some(limit)).map_err(io)?;
    stream
        .set_read_timeout(Some(limit.min(ENGINE_PING_WAIT)))
        .map_err(io)?;
    stream
        .write_all(b"GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .map_err(io)?;
    let mut reply = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let wanted = chunk.len().min(MOST - reply.len());
        let read = stream.read(&mut chunk[..wanted]);
        // The limit holds for every outcome of the read, the end of the reply included.
        if Instant::now() >= deadline {
            return Err(io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the engine did not answer through its forwarded socket in time",
            )));
        }
        match read {
            Ok(0) => break,
            Ok(read) => reply.extend_from_slice(&chunk[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(io(error)),
        }
        if reply.len() >= MOST {
            break;
        }
    }
    let response = String::from_utf8(reply)
        .map_err(|error| io(std::io::Error::new(std::io::ErrorKind::InvalidData, error)))?;
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

/// Pool phases written only before a start or after proven provider absence.
const STOPPED_PHASES: [&str; 4] = [
    "stopped",
    "stopped-before-engine",
    "stopped-after-engine-failure",
    "recovered-unclean",
];

/// Whether lease-free observation finds the pool stopped: a stopped phase, or a failed boot
/// whose provider was stopped (`failed-boot-stopped`), with no live recorded provider. A
/// transitional phase is not stopped here: an operation may be changing it.
fn observed_stopped(owner: &Owner) -> Result<bool, CandidateError> {
    if !STOPPED_PHASES.contains(&owner.phase.as_str()) && owner.phase != "failed-boot-stopped" {
        return Ok(false);
    }
    match &owner.process {
        None => Ok(true),
        Some(process) => identity::provider_gone(process),
    }
}

/// A stopped phase with no live provider; no recorded provider (`None`) is as stopped
/// as a dead one. Nothing runs from the prepared provider tree in this state.
fn provider_stopped(phase: &str, process_alive: Option<bool>) -> bool {
    STOPPED_PHASES.contains(&phase) && process_alive != Some(true)
}

pub fn down(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    crate::timings::measure(crate::timings::Step::VmStop, None, |_| {
        down_observed(candidate, None)
    })
}

/// Stop a running pool that nothing uses, so a stopped-pool share update can follow
/// (HACK-2535). The pool is checked idle (`pool_users::require_idle`) under the provider
/// lease, and again right before the guest stops. The lease is held from the first
/// check to the stop, and graph starts and interactive sessions are admitted only under
/// it, so a start that begins meanwhile waits for the lease and then finds the pool
/// stopped. The second check is a second guard, should a receipt ever turn live
/// without the lease; it costs one read of the receipts.
pub(super) fn stop_idle_pool(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    crate::timings::measure(crate::timings::Step::VmStop, None, |_| {
        down_observed(
            candidate,
            Some(&|| pool_users::require_idle(&candidate.state_root)),
        )
    })
}

/// `runtime down`. With `idle` (HACK-2535) the check runs under the lease before any
/// effect, and again right before the guest stops; the host-side releases (the managed
/// hostname authority and every publisher) then follow that second check, so a refusal
/// at either check has changed nothing. Plain `down` releases them before it verifies
/// the live guest, as before.
fn down_observed(
    candidate: &Candidate,
    idle: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<RuntimeStatus, CandidateError> {
    // Status is read-only and idempotent down on an uninitialized pool creates nothing.
    let initial = status(candidate)?;
    if initial.phase == "uninitialized" {
        return Ok(initial);
    }
    let lock = state::Lock::acquire(&root(candidate))?;
    // The provider lease prevents a build from being admitted after this check.
    super::image_build::require_no_active_build(candidate)?;
    if let Some(idle) = idle {
        idle()?;
    }
    let mut owner = Owner::load(candidate)?;
    let stopped = provider_stopped(&owner.phase, initial.process_alive);
    // When there is a pool to stop, one host sample is taken beside the stop, on its own
    // thread, so a start that follows soon need not wait out its admission window
    // (`admission::opening`). It is taken on the unowned basis, which claims nothing about
    // this pool. The stop never waits for it and cannot fail on it: it is settled after the
    // stop, under this lease, if it is back by then.
    let stop_sample = if stopped {
        admission::opening::StopSample::NotTaken
    } else {
        let checkout = candidate.checkout.clone();
        admission::opening::StopSample::beside(
            owner.profile,
            move || admission::probe_for(&checkout, super::Profile::Development),
            || admission::opening::Host::now(&admission::opening::System),
        )
    };
    // Only stopping a provider reaches the prepared tree. A stopped pool's down executes
    // nothing from it, so a tree changed outside Hack cannot block quiescence; any later
    // start still verifies the tree (see `repair_provider_trees`).
    if !stopped {
        artifact::verify(candidate)?;
    }
    let release = |owner: &Owner| -> Result<(), CandidateError> {
        super::hostname_authority::managed::stop(candidate, owner)?;
        super::publication::release(candidate, &owner.token, None)
    };
    if stopped {
        release(&owner)?;
        return status(candidate);
    }
    if idle.is_none() {
        release(&owner)?;
    }
    verify_live(candidate, &owner)?;
    // Stopping a running pool stops every graph's containers with the guest. This is
    // reported, not refused: a crash or host reboot ends the same way, and `hack up`
    // recovers each run (HACK-2456).
    let live = pool_users::live_graph_runs(&candidate.state_root);
    let peak = read_memory_peak(&candidate.state_root, &owner, |script, args, deadline| {
        agent::exec_until(
            &socket(candidate, &owner, "agent.sock")?,
            script,
            args,
            deadline,
        )
    });
    // The second idle check, right before the guest stops (HACK-2535); nothing was
    // released before it.
    if let Some(idle) = idle {
        idle()?;
        release(&owner)?;
    }
    let mut result = match guest_stop(candidate, &mut owner) {
        Ok(()) => status(candidate),
        Err(error)
            if error.code == "agent_protocol_uncertain" && agent_silent(candidate, &owner)? =>
        {
            stop_silent_guest(candidate, &mut owner)?;
            status(candidate)
        }
        Err(error) if authorizes_unclean_stop(&error) => {
            stop_silent_guest(candidate, &mut owner)?;
            status(candidate)
        }
        Err(error) => Err(error),
    };
    keep_memory_peak(&root(candidate), peak, &mut result);
    if let Ok(status) = &mut result {
        status.interrupted_runs_unknown = live.is_none();
        status.interrupted_runs = live;
    }
    stop_sample.settle(&root(candidate), &lock, &admission::opening::System);
    result
}

/// The code `guest_stop` returns when the engine quiesce failed again on a resumed stop.
const QUIESCE_STALLED: &str = "engine_quiesce_stalled";

/// Whether a `guest_stop` failure lets `down` or `recover` stop a responsive guest's
/// provider without flushing it. Only a resumed quiesce stall does; see [`quiesce_stalled`].
fn authorizes_unclean_stop(error: &CandidateError) -> bool {
    error.code == QUIESCE_STALLED
}

/// Classify a failed engine quiesce. A resumed stall becomes [`QUIESCE_STALLED`]. A guest
/// identity refusal keeps its own code with the next step, on every attempt, so it never
/// authorizes an unclean stop. Anything else is returned as is.
fn quiesce_failure(error: CandidateError, resumed: bool) -> CandidateError {
    if error.code == "guest_identity_mismatch" {
        CandidateError::new(
            "guest_identity_mismatch",
            "The guest's owner, boot or engine identity does not match the runtime receipt, so its engine was not quiesced and the provider was not stopped. Inspect runtime status; once the recorded provider has exited or its guest stops answering, runtime recover records the stop.",
        )
    } else if quiesce_stalled(&error, resumed) {
        CandidateError::new(
            QUIESCE_STALLED,
            "The guest engine did not finish quiescing after a resumed stop.",
        )
    } else {
        error
    }
}

/// Whether a failed engine quiesce means the engine cannot be quiesced from the guest.
///
/// A first attempt that times out or exits nonzero leaves the pool `quiescing` and is
/// reported as is: the engine may still be finishing its own shutdown. A resumed attempt
/// (the pool was already `quiescing` before this stop began) that fails the same way has
/// now sent TERM to the same engine identity twice without it exiting, or found the guest
/// unable to finish the bounded quiesce command at all. The guest agent may still answer
/// pings, so the silent-guest rule cannot apply; waiting longer gives no further evidence,
/// and the only remaining way out is a provider stop. Identity refusals are never treated
/// as a stall: the quiesce script reports them with the reserved
/// [`agent::GUEST_IDENTITY_REFUSED`] status, which decodes to `guest_identity_mismatch`,
/// and host-side refusals carry their own codes.
fn quiesce_stalled(error: &CandidateError, resumed: bool) -> bool {
    resumed && ["agent_protocol_uncertain", "guest_command_failed"].contains(&error.code)
}

/// The outcome of `runtime repair-provider-tree`.
#[derive(Serialize)]
pub struct ProviderRepair {
    /// Each prepared provider tree, repaired or found intact.
    pub trees: Vec<artifact::TreeRepair>,
    pub runtime: RuntimeStatus,
}

/// Re-prepare provider trees that something outside Hack changed (for example a cleanup
/// tool that pruned empty directories), from the archives preparation retained.
///
/// Requires a stopped or uninitialized pool under the provider lock, so no provider runs
/// from a tree while it is replaced and no start can begin meanwhile. Each tree is
/// re-proved from its pinned archive digest and recorded tree digest; see
/// `artifact::repair_tree`. Runtime state, disks and volumes are untouched. Until a
/// repair succeeds, every start keeps refusing the changed tree.
pub fn repair_provider_trees(candidate: &Candidate) -> Result<ProviderRepair, CandidateError> {
    repair_trees(candidate, &[artifact::SMOLVM, artifact::ENGINE])
}

fn repair_trees(
    candidate: &Candidate,
    pins: &[artifact::TreePin],
) -> Result<ProviderRepair, CandidateError> {
    let providers = candidate.state_root.join("providers");
    let mut any = false;
    for pin in pins {
        any |= providers.join(pin.record_name()).try_exists().map_err(io)?;
    }
    if !any {
        // Nothing was prepared: create no state, like status and down.
        return Ok(ProviderRepair {
            trees: Vec::new(),
            runtime: status(candidate)?,
        });
    }
    let lock = state::Lock::acquire(&root(candidate))?;
    super::image_build::require_no_active_build(candidate)?;
    let current = status(candidate)?;
    if current.phase != "uninitialized" && !provider_stopped(&current.phase, current.process_alive)
    {
        return Err(CandidateError::new(
            "provider_repair_requires_stopped_runtime",
            "Provider tree repair requires a stopped runtime; run runtime down first.",
        ));
    }
    let mut trees = Vec::new();
    for pin in pins {
        lock.verify_path(&root(candidate))?;
        trees.extend(artifact::repair_tree(candidate, pin, &lock)?);
    }
    Ok(ProviderRepair {
        trees,
        runtime: status(candidate)?,
    })
}

/// How many pings, a few seconds apart, a guest agent must leave unanswered before
/// `down` or `recover` treats it as stopped responding.
const SILENT_PINGS: u32 = 3;
#[cfg(not(test))]
const SILENT_PING_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(not(test))]
const SILENT_PING_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(test)]
const SILENT_PING_TIMEOUT: Duration = Duration::from_millis(200);
#[cfg(test)]
const SILENT_PING_INTERVAL: Duration = Duration::from_millis(50);

/// `true` when the owned guest agent answered none of [`SILENT_PINGS`] pings.
fn agent_silent(candidate: &Candidate, owner: &Owner) -> Result<bool, CandidateError> {
    Ok(agent_silent_at(&socket(candidate, owner, "agent.sock")?))
}

/// Any reply, even an unexpected one, means the guest is alive and keeps the normal stop
/// path.
fn agent_silent_at(path: &Path) -> bool {
    agent_silent_with(|| agent::answers_ping(path, SILENT_PING_TIMEOUT))
}

fn agent_silent_with(mut answers: impl FnMut() -> bool) -> bool {
    for attempt in 0..SILENT_PINGS {
        if attempt > 0 {
            std::thread::sleep(SILENT_PING_INTERVAL);
        }
        if answers() {
            return false;
        }
    }
    true
}

/// Stop the verified provider of a guest whose agent stopped responding, or whose engine did
/// not quiesce on a resumed stop (see [`quiesce_stalled`]). Nothing in the
/// guest is quiesced or flushed, so the pool is recorded `recovered-unclean`, as after a
/// provider exit; the next start checks its retained disks as usual. The signal reaches
/// only this home's recorded provider, rechecked by PID, start time, user and executable
/// immediately before it is sent. A provider that already exited is only recorded.
fn stop_silent_guest(candidate: &Candidate, owner: &mut Owner) -> Result<(), CandidateError> {
    // Checked again at the effect: the caller holds the operation lease, but a running
    // build holds only its shared fence while its client runs.
    require_no_build_for_silent_stop(candidate)?;
    let process = owner.process.clone().ok_or_else(|| {
        CandidateError::new("process_identity_unavailable", "No recorded provider.")
    })?;
    if identity::alive(process.pid)? {
        verify_live(candidate, owner)?;
        stop_verified_provider(&process, &binary(candidate))?;
    }
    finish_stopped(candidate, owner, "recovered-unclean")
}

/// Refuse to stop a silent guest while a native image build is admitted. A build releases
/// the operation lease while its client runs and keeps only the shared build fence
/// (`run/image-builds/active.lock`), so the lease alone does not prove the engine is idle.
/// The fence is a `flock`: it is released when the build's processes exit, including on
/// SIGKILL, so a refusal lasts only while a build process is alive. Callers hold the
/// operation lease, which prevents new build admission.
fn require_no_build_for_silent_stop(candidate: &Candidate) -> Result<(), CandidateError> {
    super::image_build::require_no_active_build(candidate).map_err(|error| {
        if error.code == "provider_busy" {
            CandidateError::new(
                "provider_busy",
                "A native image build is running against this guest. Finish or cancel it first (Ctrl-C the `hack up` that started it); the next attempt then stops the guest that stopped responding.",
            )
        } else {
            error
        }
    })
}

/// `down`'s guest-facing part: quiesce the engine, ask the guest to flush and shut down,
/// stop the provider and record the stop.
fn guest_stop(candidate: &Candidate, owner: &mut Owner) -> Result<(), CandidateError> {
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
            owner,
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
        let resumed = owner.phase == "quiescing";
        let quiesce_mode = if resumed { "resume" } else { "initial" };
        phase(candidate, owner, "quiescing")?;
        let quiescence = guest(
            candidate,
            owner,
            include_str!("guest-quiesce.sh"),
            &[
                &owner.token,
                owner.guest_boot_id.as_deref().unwrap_or(""),
                &daemon,
                &start,
                quiesce_mode,
            ],
            false,
        )
        .map_err(|error| quiesce_failure(error, resumed))?;
        state::write(
            &root(candidate).join("quiescence.json"),
            &json!({
                "guest_boot_id": owner.guest_boot_id, "daemon_pid": owner.daemon_pid,
                "daemon_start": owner.daemon_start, "result": quiescence.trim()
            }),
        )?;
    }
    phase(candidate, owner, "stopping")?;
    let response = agent::request(
        &socket(candidate, owner, "agent.sock")?,
        json!({"method":"shutdown"}),
        Duration::from_secs(15),
    )?;
    if response["status"] != "ok" || response["data"]["shutdown"] != true {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Guest did not acknowledge flush/unmount.",
        ));
    }
    verify_live(candidate, owner)?;
    let process = owner.process.as_ref().expect("live identity verified");
    // Revalidate immediately before signalling. macOS has no Linux pidfd equivalent;
    // this is cooperative same-user ownership, not hostile-process containment.
    identity::terminate(process, &binary(candidate))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    // A provider that exited but is not yet reaped (a zombie) is gone too (HACK-2579).
    while !identity::provider_gone(process)? && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !identity::provider_gone(process)? {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Provider remains alive after TERM; no force-kill or false stopped receipt.",
        ));
    }
    if before_engine {
        finish_stopped(candidate, owner, "stopped-before-engine")?;
    } else if failed_engine {
        finish_stopped(candidate, owner, "stopped-after-engine-failure")?;
    } else {
        finish_quiesced_stop(candidate, owner)?;
        // The stopped receipt is written. The `/private/tmp` HOME alias stays reserved for
        // this pool, so no other user can take its name; only the provider sockets the
        // stop proved closed are removed.
        remove_closed_sockets(candidate, owner)?;
    }
    Ok(())
}

/// Restore a clean stop's HOME alias under the caller's pool lock, when host cleanup removed
/// it or another entry holds its path (see [`Owner::restore_released_short_home`]). Any
/// other receipt, or one whose alias is present and owned, is left as [`Owner::load`]
/// checks it.
pub(super) fn restore_released_short_home(candidate: &Candidate) -> Result<(), CandidateError> {
    if !root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        return Ok(());
    }
    let mut owner = Owner::load_for_alias_restore(candidate)?;
    if owner.short_home_releasable() {
        owner.restore_released_short_home(candidate)?;
    }
    Ok(())
}

/// Before a mutating operation's first strict owner read: a clean stop whose alias path
/// another entry holds, which [`Owner::load`] refuses, moves to a fresh alias under the
/// startup lease, which is then released. Every other state takes no lease here and is
/// left to the operation's own checks; an absent alias is restored later under its lock.
fn restore_released_short_home_before_use(candidate: &Candidate) -> Result<(), CandidateError> {
    reject_aliased_state(&root(candidate))?;
    if !root(candidate)
        .join("owner.json")
        .try_exists()
        .map_err(io)?
    {
        return Ok(());
    }
    let Ok(owner) = Owner::load_for_alias_restore(candidate) else {
        // Refusals are reported by the operation's strict read.
        return Ok(());
    };
    if !owner.short_home_releasable() || Owner::load(candidate).is_ok() {
        return Ok(());
    }
    let _lease = startup_lease(&root(candidate), STARTUP_LEASE_WAIT)?;
    restore_released_short_home(candidate)
}

/// The provider sockets [`sockets_absent`] checks, by file name in the data directory.
fn owned_socket_names(owner: &Owner) -> Vec<String> {
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
    sockets
}

/// After a clean stop proved that no owned provider socket accepts connections, remove the
/// socket files left in the private data directory. The path is the real data directory,
/// never the alias. Only sockets owned by this user are removed; any other entry is kept.
fn remove_closed_sockets(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    use std::os::unix::fs::FileTypeExt;
    let data = owner.real_data_dir(candidate)?;
    for name in owned_socket_names(owner) {
        let path = data.join(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io(error)),
        };
        // SAFETY: geteuid has no preconditions.
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            continue;
        }
        match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(io(error)),
            _ => {}
        }
    }
    Ok(())
}

/// `down`'s completion after the guest acknowledged flush and shutdown of a quiesced engine
/// and the provider exited: the clean-stop marker names this boot and is written with the
/// `stopped` phase once the provider's release is proven. If any proof fails, nothing is
/// written and the receipt keeps its in-progress phase.
fn finish_quiesced_stop(candidate: &Candidate, owner: &mut Owner) -> Result<(), CandidateError> {
    owner.clean_stop = state::CleanStop::of(owner);
    finish_stopped(candidate, owner, "stopped")
}

fn finish_stopped(
    candidate: &Candidate,
    owner: &mut Owner,
    value: &str,
) -> Result<(), CandidateError> {
    if owner
        .process
        .as_ref()
        .map(|p| identity::provider_gone(p).map(|gone| !gone))
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

/// Record `value` once the provider's VM lock is free, the disk-holder scan names no process
/// on the owned disks and no owned socket accepts connections. The caller has established that
/// no provider process remains; these checks look for anything the machine it launched left
/// behind before the receipt changes. The scan inspects what `lsof` inspects and does not
/// prove that nothing maps a disk (`disk_handles`).
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

/// The bound [`lock_absent_disks`] gives the disk-handle scan: the production stop-path
/// bound [`disk_handles::STOP_HANDLE_WAIT`].
#[cfg(not(test))]
const STOP_SCAN_WAIT: Duration = disk_handles::STOP_HANDLE_WAIT;
/// The unit-test build of [`STOP_SCAN_WAIT`]. Release-check fixtures prove what the scan
/// reports (no holder, nothing unknown), not how fast it reports it, and they run beside other
/// tests' work; on a loaded host one scan took longer than 5 s and the fixture failed as
/// `provider_timeout_uncertain` before its result under test (HACK-1457). The production
/// bounds themselves are tested on a fake clock in [`disk_handles`].
#[cfg(test)]
const STOP_SCAN_WAIT: Duration = super::test_executable::LOADED_HOST_SCAN_WAIT;

/// Keep this guard through alias restoration and the stopped receipt.
fn lock_absent_disks(candidate: &Candidate, owner: &Owner) -> Result<VmLock, CandidateError> {
    lock_absent_disks_within(candidate, owner, STOP_SCAN_WAIT)
}

/// [`lock_absent_disks`] with a caller-chosen bound on the disk-handle scan
/// ([`disk_handles::disks_closed`]). A scan that does not finish within `handle_wait` fails
/// as `provider_timeout_uncertain`.
fn lock_absent_disks_within(
    candidate: &Candidate,
    owner: &Owner,
    handle_wait: Duration,
) -> Result<VmLock, CandidateError> {
    let directory = owner.real_data_dir(candidate)?;
    lock_disks_closed(
        candidate,
        owner,
        &[directory.join("storage.raw"), directory.join("overlay.raw")],
        handle_wait,
    )
}

/// [`lock_absent_disks_within`] for disks at `disks`, which a resumed set-aside of
/// unadopted disks (`interrupted`) may have partly moved.
fn lock_disks_closed(
    candidate: &Candidate,
    owner: &Owner,
    disks: &[std::path::PathBuf],
    handle_wait: Duration,
) -> Result<VmLock, CandidateError> {
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
    disk_handles::disks_closed(
        &disk_handles::HostScan::host(),
        &process::MonotonicClock::new(),
        disks,
        handle_wait,
    )?;
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
    sockets_absent(owner)?;
    for name in ["storage.raw", "overlay.raw"] {
        File::open(owner.real_data_dir(candidate)?.join(name))
            .map_err(io)?
            .sync_all()
            .map_err(io)?;
    }
    #[cfg(target_os = "macos")]
    super::interactive_session::after_boot_stopped(candidate, owner);
    phase(candidate, owner, value)
}

/// No owned provider socket accepts connections. Read-only: connecting never creates one.
fn sockets_absent(owner: &Owner) -> Result<(), CandidateError> {
    for name in owned_socket_names(owner) {
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
    Ok(())
}

pub fn recover(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    restore_released_short_home_before_use(candidate)?;
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
    // Recovery rewrites the phase, which needs a clean stop's alias restored.
    restore_released_short_home(candidate)?;
    let mut owner = Owner::load(candidate)?;
    let Some(process) = owner.process.as_ref() else {
        // A start interrupted before the provider identity was recorded; see `interrupted`.
        interrupted::recover(candidate, &mut owner, &lock)?;
        return status(candidate);
    };
    if !identity::provider_gone(process)? {
        // A live provider is stopped here only when its identity verifies and its guest
        // agent stopped responding; a responsive guest is stopped cleanly by `down`.
        // Refuse first, without probing, while a build is admitted.
        require_no_build_for_silent_stop(candidate)?;
        verify_live(candidate, &owner)?;
        let silent = agent_silent(candidate, &owner)?;
        if !silent && owner.phase == "quiescing" {
            // A stop already began quiescing the engine and did not finish. Resume it once;
            // an engine that still does not quiesce is stopped with the provider, unclean.
            return match guest_stop(candidate, &mut owner) {
                Ok(()) => status(candidate),
                Err(error) if authorizes_unclean_stop(&error) => {
                    stop_silent_guest(candidate, &mut owner)?;
                    status(candidate)
                }
                Err(error) => Err(error),
            };
        }
        if !silent {
            return Err(CandidateError::new(
                "recovery_required",
                "Recovery only accepts a confirmed dead recorded process or a guest that stopped responding. Use down for a responsive guest.",
            ));
        }
        // The operation lease taken above stays held through the stop and its receipt.
        stop_silent_guest(candidate, &mut owner)?;
        return status(candidate);
    }
    // A stopped phase was written only after the provider's release was proven, and its
    // provider is dead: nothing to recover, so a clean stop stays clean and repeating
    // recovery changes nothing (a retained run's eligibility depends on the phase).
    if STOPPED_PHASES.contains(&owner.phase.as_str()) {
        return status(candidate);
    }
    // A failed first boot whose provider was recorded (`failed-boot-stopped` after a template
    // refusal) must not reach the stopped path, which adopts its disks unchecked.
    if interrupted::set_aside_recorded(candidate, &mut owner, &lock)? {
        return status(candidate);
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
    // A provider that exited but is not yet reaped (a zombie) is gone too (HACK-2579).
    while !identity::provider_gone(recorded)? && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !identity::provider_gone(recorded)? {
        return Err(CandidateError::new(
            "fixture_kill",
            "Owned VM remains alive after kill control.",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "lifecycle_log_follow_tests.rs"]
mod log_follow_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed boot's record names the failure by code and by message, so a code shared by
    /// many causes (`provider_state` is any I/O error) can be told apart afterwards.
    #[test]
    fn a_failed_boot_record_keeps_the_failure_message() {
        let process = identity::ProcessIdentity {
            pid: 41,
            start_micros: 7,
            uid: 501,
            executable: std::path::PathBuf::from("/fixture/smolvm-bin"),
        };
        let failure = state::io(std::io::Error::other("fixture: socket vanished"));
        let record = failed_boot_record(&failure, &process, true);
        assert_eq!(
            record,
            json!({
                "failure_code": "provider_state",
                "failure_message": "fixture: socket vanished",
                "process": {
                    "pid": 41, "start_micros": 7, "uid": 501,
                    "executable": "/fixture/smolvm-bin",
                },
                "process_absent": true,
                "disk_adoption": false,
            })
        );
        assert_eq!(
            failed_boot_record(&failure, &process, false)["process_absent"],
            json!(false)
        );
    }

    #[test]
    fn observation_treats_only_a_stopped_pool_without_a_live_provider_as_not_running() {
        // `ObservedGuest::connect` answers `runtime_not_running` exactly when this holds,
        // before any identity comparison; otherwise `verify` keeps `runtime_changed`.
        let owner = |phase: &str, process: Option<&identity::ProcessIdentity>| -> Owner {
            serde_json::from_value(json!({
                "version": 1, "checkout": "/fixture", "token": "fixture", "machine": "fixture",
                "short_home": "/fixture", "created": true, "phase": phase,
                "process": process, "storage": null, "overlay": null, "guest_boot_id": "boot",
                "daemon_pid": null, "daemon_start": null, "rootfs_digest": null
            }))
            .unwrap()
        };
        let live_pid = i32::try_from(std::process::id()).unwrap();
        #[cfg(target_os = "macos")]
        let live = identity::observe(live_pid).unwrap();
        #[cfg(not(target_os = "macos"))]
        let live = identity::ProcessIdentity {
            pid: live_pid,
            start_micros: 1,
            uid: 0,
            executable: "/fixture/smolvm".into(),
        };
        let dead = {
            let mut child = std::process::Command::new("true").spawn().unwrap();
            let pid = i32::try_from(child.id()).unwrap();
            child.wait().unwrap();
            identity::ProcessIdentity {
                pid,
                ..live.clone()
            }
        };
        for phase in [
            "stopped",
            "stopped-before-engine",
            "stopped-after-engine-failure",
            "recovered-unclean",
            "failed-boot-stopped",
        ] {
            assert!(observed_stopped(&owner(phase, None)).unwrap(), "{phase}");
            assert!(
                observed_stopped(&owner(phase, Some(&dead))).unwrap(),
                "{phase}"
            );
            #[cfg(target_os = "macos")]
            {
                // A live PID with a different birth belongs to a replacement process.
                let mut reused = live.clone();
                reused.start_micros -= 1;
                assert!(
                    observed_stopped(&owner(phase, Some(&reused))).unwrap(),
                    "{phase}"
                );
            }
            // A live recorded provider is not stopped, whatever the phase says.
            assert!(
                !observed_stopped(&owner(phase, Some(&live))).unwrap(),
                "{phase}"
            );
        }
        // An operation may be changing a transitional phase.
        for phase in ["running", "booting", "creating", "quiescing", "stopping"] {
            assert!(!observed_stopped(&owner(phase, None)).unwrap(), "{phase}");
        }
    }

    #[test]
    fn source_preflight_is_read_only_and_preserves_unowned_state() {
        let directory = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-source-preflight-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
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
                "project_share_extension_required"
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

    #[cfg(target_os = "macos")]
    #[test]
    fn running_pool_reuse_ignores_a_removed_primary_root_but_boot_refuses() {
        let directory = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-share-reuse-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
        ));
        state::private_directory(&directory).unwrap();
        struct Remove(std::path::PathBuf);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _remove = Remove(directory.clone());
        let approve = |name: &str| {
            let project = directory.join(name);
            state::private_directory(&project).unwrap();
            fs::write(project.join("package.json"), "{}").unwrap();
            super::super::ProjectShareIntent::approve(&project, true).unwrap()
        };
        let primary = approve("first-app");
        let second = approve("second-app");
        let pool = directory.join("pool");
        state::private_directory(&pool).unwrap();
        let candidate = Candidate::discover(&pool).unwrap();
        let create = |candidate: &Candidate, share: &super::super::ProjectShareIntent| {
            Owner::create_with_project_share(
                candidate,
                super::super::Profile::Development,
                None,
                super::super::NetworkIntent::Internet,
                None,
                Some(share.clone()),
            )
        };
        let mut owner = create(&candidate, &primary).unwrap();
        struct Unlink(std::path::PathBuf);
        impl Drop for Unlink {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let _unlink = Unlink(owner.short_home.clone());
        owner.additional_project_shares.push(second.clone());
        owner.phase = "running".into();
        owner.save(&candidate).unwrap();
        let before = fs::read(root(&candidate).join("owner.json")).unwrap();

        // The primary root disappears while the pool runs.
        fs::remove_dir_all(&primary.project).unwrap();
        let reused = create(&candidate, &primary).unwrap();
        assert_eq!(reused.project_share.as_ref(), Some(&primary));
        assert_eq!(reused.additional_project_shares, vec![second.clone()]);
        assert_eq!(reused.phase, "running");
        assert_eq!(
            fs::read(root(&candidate).join("owner.json")).unwrap(),
            before
        );
        // The second root is still admitted against the reused owner; its own project is
        // not blocked by the stale neighbor.
        assert!(
            super::super::project_share::check_request(&reused.project_shares(), Some(&second))
                .is_ok()
        );
        // Booting with the whole set still checks every root live.
        assert_eq!(
            super::super::project_share::check_boot(&reused.project_shares())
                .unwrap_err()
                .code,
            "project_share_stale"
        );

        // A cold pool never records a share whose root is missing.
        let cold_pool = directory.join("cold-pool");
        state::private_directory(&cold_pool).unwrap();
        let cold = Candidate::discover(&cold_pool).unwrap();
        assert!(create(&cold, &primary).is_err());
        assert!(!root(&cold).join("owner.json").exists());
    }

    #[test]
    fn cleanup_operation_lease_waits_then_revalidates_without_replaying_effects() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hkl-lease-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                crate::next_test_scratch()
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
            let immediate = Instant::now();
            assert!(
                matches!(operation_lease(&root, None, || { calls.set(1); Ok(()) }), Err(e) if e.code == "provider_busy")
            );
            assert!(immediate.elapsed() < Duration::from_secs(1));
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
                "hkl-startup-lease-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                crate::next_test_scratch()
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
    fn only_a_provably_exited_provider_is_reported_as_an_exited_pool() {
        let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let owner = |process: Value| -> Owner {
            serde_json::from_value(json!({
                "version":1,"checkout":"/fixture","token":"fixture","machine":"fixture",
                "short_home":"/fixture","created":true,"phase":"running","process":process,
                "storage":null,"overlay":null,"guest_boot_id":null,
                "daemon_pid":null,"daemon_start":null,"rootfs_digest":null,
                "amd64_emulation":false
            }))
            .unwrap()
        };
        // A process that has exited: positive evidence of absence.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = i32::try_from(child.id()).unwrap();
        child.wait().unwrap();
        let exited = owner(json!({"pid":pid,"start_micros":0,"uid":0,"executable":"/fixture"}));
        assert!(!emulation_pool_alive(&candidate, &exited, true).unwrap());
        // No recorded identity is not evidence of exit: the verification error surfaces.
        let unknown = emulation_pool_alive(&candidate, &owner(Value::Null), true).unwrap_err();
        assert_eq!(unknown.code, "process_identity_unavailable");
        // A live process that fails verification keeps its own error.
        let live = owner(json!({
            "pid": i32::try_from(std::process::id()).unwrap(),
            "start_micros":0,"uid":0,"executable":"/fixture"
        }));
        assert_ne!(
            emulation_pool_alive(&candidate, &live, true)
                .unwrap_err()
                .code,
            "pool_process_exited"
        );
        // Without a translation request nothing is observed.
        assert!(emulation_pool_alive(&candidate, &owner(Value::Null), false).unwrap());
    }

    #[test]
    fn amd64_emulation_is_never_added_to_a_running_pool_and_is_never_dropped() {
        let owner = |phase: &str, emulation: bool| -> Owner {
            serde_json::from_value(json!({
                "version":1,"checkout":"/fixture","token":"fixture","machine":"fixture",
                "short_home":"/fixture","created":true,"phase":phase,"process":null,
                "storage":null,"overlay":null,"guest_boot_id":null,
                "daemon_pid":null,"daemon_start":null,"rootfs_digest":null,
                "amd64_emulation":emulation
            }))
            .unwrap()
        };
        let refused =
            check_amd64_emulation_request(&owner("running", false), true, true).unwrap_err();
        assert_eq!(refused.code, "amd64_emulation_restart_required");
        assert!(refused.message.contains("runtime down --json"));
        // A recorded running pool whose process has exited is named as that, with its recovery.
        let exited =
            check_amd64_emulation_request(&owner("running", false), true, false).unwrap_err();
        assert_eq!(exited.code, "pool_process_exited");
        assert!(exited.message.contains("runtime recover --json"));
        for (phase, emulation, requested) in [
            ("running", false, false),
            ("running", true, true),
            ("running", true, false),
            ("stopped", false, true),
            ("initializing", false, true),
        ] {
            check_amd64_emulation_request(&owner(phase, emulation), requested, true).unwrap();
        }
        // A pool without translation keeps its original receipt shape.
        let saved = serde_json::to_value(owner("stopped", false)).unwrap();
        assert!(saved.get("amd64_emulation").is_none());
        let saved = serde_json::to_value(owner("stopped", true)).unwrap();
        assert_eq!(saved["amd64_emulation"], json!(true));
        // Detection is read-only and only ever true on Apple silicon macOS.
        if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
            assert!(!host_translation_available());
        }
        let _ = host_translation_available();
    }

    #[test]
    fn only_a_start_the_provider_ended_for_no_boot_progress_is_named_stalled() {
        let provider = "Provider command exited exit status: 1; no automatic retry. Error: agent \
                        operation failed: start machine: agent operation failed: wait for ready: \
                        agent did not become ready within 30 seconds: no boot progress for 30 \
                        seconds";
        let stalled = stalled_boot(CandidateError::new(
            "provider_command_failed",
            provider.to_owned(),
        ));
        assert_eq!(stalled.code, "provider_boot_stalled");
        assert!(stalled.message_fixed);
        assert!(
            serde_json::to_value(&stalled)
                .unwrap()
                .get("provider_line")
                .is_none()
        );
        // A stalled start that carried the provider's own line keeps it under the new code.
        let with_line = stalled_boot(
            CandidateError::new("provider_command_failed", provider.to_owned())
                .with_provider_line("Error: no boot progress for 30 seconds"),
        );
        assert_eq!(with_line.code, "provider_boot_stalled");
        assert_eq!(
            serde_json::to_value(&with_line).unwrap()["provider_line"],
            "Error: no boot progress for 30 seconds"
        );
        assert!(stalled.message.contains("HACK_NATIVE_HOT_RELOAD=off"));
        // Another failure of the same command keeps its code and text.
        let other = stalled_boot(CandidateError::new(
            "provider_command_failed",
            "Provider command exited exit status: 1; no automatic retry. Error: machine not found"
                .to_owned(),
        ));
        assert_eq!(other.code, "provider_command_failed");
        assert!(other.message.contains("machine not found"));
        // The words alone, under another code, change nothing.
        let timeout = stalled_boot(CandidateError::new(
            "provider_timeout_uncertain",
            format!("{NO_BOOT_PROGRESS} seen elsewhere"),
        ));
        assert_eq!(timeout.code, "provider_timeout_uncertain");
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

    /// Every active line of the executable cache script, in order. None of them runs a file
    /// from the cache or from the share: each command is a shell word or a fixed utility
    /// (`test`, `cat`, `findmnt`, `stat`, `mountpoint`, `mkdir`, `mount`, `sha256sum`, `cut`,
    /// `chmod`, `printf`). A change to the script must change this list, and whoever
    /// changes it answers for that property. An exact list is used because a reader of shell
    /// words cannot be made tight without parsing quotes, comments and substitutions.
    const CACHE_SCRIPT_LINES: [&str; 49] = [
        "set -eu",
        r#"test "$#" = 4"#,
        r#"for digest in "$3" "$4"; do"#,
        r#"test "${#digest}" = 64"#,
        r#"case "$digest" in *[!0-9a-f]*) exit 64;; esac"#,
        "done",
        r#"test "$(cat /storage/.hack-local-owner)" = "$1""#,
        r#"test "$(cat /proc/sys/kernel/random/boot_id)" = "$2""#,
        r#"test "$(findmnt -n -o FSTYPE --mountpoint /opt/hack-engine)" = virtiofs"#,
        r#"test "$(findmnt -n -o FSTYPE --mountpoint /run/hack-local)" = tmpfs"#,
        r#"test "$(stat -c %u:%g:%a /run/hack-local)" = 0:0:700"#,
        "total=0",
        "for name in runc docker-init; do",
        "path=/opt/hack-engine/$name",
        r#"test -f "$path""#,
        r#"test ! -L "$path""#,
        r#"size=$(stat -c %s "$path")"#,
        r#"test "$size" -gt 0"#,
        r#"test "$size" -le 33554432"#,
        "total=$((total + size))",
        r#"if mountpoint -q "$path"; then exit 44; fi"#,
        "done",
        r#"test "$total" -le 33554432"#,
        "cache=/run/hack-local/engine-exec",
        r#"test ! -e "$cache""#,
        r#"test ! -L "$cache""#,
        r#"mkdir -m 700 "$cache""#,
        r#"mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs "$cache""#,
        "for name in runc docker-init; do",
        r#"case "$name" in runc) expected=$3;; docker-init) expected=$4;; esac"#,
        r#"cat "/opt/hack-engine/$name" > "$cache/$name""#,
        r#"test "$(sha256sum "$cache/$name" | cut -d ' ' -f 1)" = "$expected""#,
        r#"chmod 555 "$cache/$name""#,
        r#"test "$(stat -c %u:%g:%a "$cache/$name")" = 0:0:555"#,
        "done",
        r#"mount -o remount,ro "$cache""#,
        "for name in runc docker-init; do",
        "path=/opt/hack-engine/$name",
        r#"mount --bind "$cache/$name" "$path""#,
        r#"mount -o remount,bind,ro "$path""#,
        r#"test "$(findmnt -n -o FSTYPE --mountpoint "$path")" = tmpfs"#,
        r#"test "$(stat -c %u:%g:%a "$path")" = 0:0:555"#,
        r#"case "$name" in runc) expected=$3;; docker-init) expected=$4;; esac"#,
        r#"test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$expected""#,
        "done",
        r#"for target in "$cache" /opt/hack-engine/runc /opt/hack-engine/docker-init; do"#,
        r#"case ",$(findmnt -n -o OPTIONS --mountpoint "$target")," in *,ro,*) ;; *) exit 45;; esac"#,
        "done",
        r#"printf 'engine-exec-cache-v1\n'"#,
    ];

    #[test]
    fn executable_cache_runs_nothing_it_copied_and_confirms_only_after_the_final_hash() {
        let script = include_str!("guest-runc-cache.sh");
        let lines: Vec<&str> = script
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        // The script is exactly the reviewed lines: a failed check ends it (`set -eu`), and
        // the confirmation is its last command.
        assert_eq!(lines, CACHE_SCRIPT_LINES);
        assert_eq!(lines.first(), Some(&"set -eu"));
        assert_eq!(lines.last(), Some(&"printf 'engine-exec-cache-v1\\n'"));
        // No quoted text runs over a line end, so a comment line is a comment to the shell too.
        for line in &lines {
            assert_eq!(line.matches('"').count() % 2, 0, "{line}");
            assert_eq!(line.matches('\'').count() % 2, 0, "{line}");
        }
        assert!(!script.contains('`'));
        // The cache's own copy is hashed after the copy and before it is made executable,
        // and the bound path is hashed after the cache is read-only and bound: that second
        // hash is the last check before the read-only checks and the confirmation.
        let position = |needle: &str| {
            let found: Vec<_> = script.match_indices(needle).collect();
            assert_eq!(found.len(), 1, "{needle}");
            found[0].0
        };
        let copied = position(r#"cat "/opt/hack-engine/$name" > "$cache/$name""#);
        let checked =
            position(r#"test "$(sha256sum "$cache/$name" | cut -d ' ' -f 1)" = "$expected""#);
        let executable = position(r#"chmod 555 "$cache/$name""#);
        assert!(copied < checked && checked < executable);
        // Nothing but that one line writes into the cache. The only pipelines are the two
        // that cut a digest out of `sha256sum`'s line, where a failed `sha256sum` leaves
        // nothing to compare: no command whose failure the shell would not see stands
        // between the copy and its digest.
        assert_eq!(script.matches(" > ").count(), 1);
        assert_eq!(script.matches('|').count(), 2);
        assert_eq!(script.matches("| cut -d ' ' -f 1)").count(), 2);
        // The loop the other cache tests replay is these lines of the script.
        let replayed: Vec<&str> = cache_copy_loop().lines().map(str::trim).collect();
        assert_eq!(replayed, CACHE_SCRIPT_LINES[28..35]);
        let read_only = position(r#"mount -o remount,ro "$cache""#);
        let bound = position(r#"mount --bind "$cache/$name" "$path""#);
        let hashed = position(r#"test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$expected""#);
        let confirmed = position("printf 'engine-exec-cache-v1");
        assert!(executable < read_only && read_only < bound);
        assert!(bound < hashed && hashed < confirmed);
    }

    /// The copy-and-check loop of the executable cache script, verbatim: copy one
    /// executable into `$cache`, compare the digest of that copy with `$3` (`runc`) or `$4`
    /// (`docker-init`), and only then make it executable.
    fn cache_copy_loop() -> &'static str {
        let script = include_str!("guest-runc-cache.sh");
        let start = script
            .find("for name in runc docker-init; do\n case \"$name\" in")
            .unwrap();
        let end = start + script[start..].find("\ndone\n").unwrap() + "\ndone\n".len();
        &script[start..end]
    }

    /// Runs [`cache_copy_loop`] on the host against a fixture share and cache. `cat` is the
    /// stub at `copier` when one is given; `sha256sum` and `stat` are stand-ins for the
    /// guest's (the owner the script requires is reported as it is in the guest, root).
    #[cfg(target_os = "macos")]
    fn replay_cache_copy(
        root: &Path,
        copier: Option<&str>,
        digests: [&str; 2],
    ) -> (bool, Vec<(String, u32, Vec<u8>)>) {
        use std::os::unix::fs::PermissionsExt;
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let stub = |name: &str, body: &str| {
            fs::write(bin.join(name), format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        };
        stub("sha256sum", "exec /usr/bin/shasum -a 256 \"$@\"");
        stub(
            "stat",
            "printf '0:0:%s\\n' \"$(/usr/bin/stat -f %Lp \"$3\")\"",
        );
        stub("cat", copier.unwrap_or("exec /bin/cat \"$@\""));
        let cache = root.join("cache");
        let _ = fs::remove_dir_all(&cache);
        fs::create_dir(&cache).unwrap();
        let script = format!(
            "set -eu\ncache=$5\n{}",
            cache_copy_loop().replace(
                "/opt/hack-engine/",
                &format!("{}/", root.join("share").display())
            )
        );
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", &script, "cache-copy", "owner", "boot"])
            .args(digests)
            .arg(&cache)
            .env_clear()
            .env("PATH", format!("{}:/bin:/usr/bin", bin.display()))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        let mut left: Vec<_> = fs::read_dir(&cache)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().into_string().unwrap(),
                    entry.metadata().unwrap().permissions().mode() & 0o777,
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect();
        left.sort();
        (status.success(), left)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn executable_cache_checks_its_own_copy_before_the_copy_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-cache-copy-loop",
        );
        fs::create_dir_all(root.join("share")).unwrap();
        for (name, bytes) in [("runc", &b"runc bytes"[..]), ("docker-init", b"init bytes")] {
            fs::write(root.join("share").join(name), bytes).unwrap();
            // As on the host share: the source is executable already.
            fs::set_permissions(
                root.join("share").join(name),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let digest = |name: &str| artifact::digest(&root.join("share").join(name)).unwrap();
        let (runc, init) = (digest("runc"), digest("docker-init"));
        let wrong = "0".repeat(64);
        // The right digests: both copies are in the cache, executable, byte for byte.
        let (passed, left) = replay_cache_copy(&root, None, [&runc, &init]);
        assert!(passed);
        assert_eq!(
            left,
            [
                ("docker-init".to_owned(), 0o555, b"init bytes".to_vec()),
                ("runc".to_owned(), 0o555, b"runc bytes".to_vec()),
            ]
        );
        // A wrong digest for either: the script ends at the comparison. The copy it was
        // made of is there and is not executable, and nothing after it was copied.
        let (passed, left) = replay_cache_copy(&root, None, [&wrong, &init]);
        assert!(!passed);
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].0.as_str(), left[0].1 & 0o111), ("runc", 0));
        let (passed, left) = replay_cache_copy(&root, None, [&runc, &wrong]);
        assert!(!passed);
        assert_eq!(
            left.iter()
                .map(|(name, mode, _)| (name.as_str(), mode & 0o111 != 0))
                .collect::<Vec<_>>(),
            [("docker-init", false), ("runc", true)]
        );
        // A copy that fails ends the script at that line: no digest is asked for.
        let (passed, left) =
            replay_cache_copy(&root, Some("/bin/cat \"$@\"; exit 1"), [&runc, &init]);
        assert!(!passed);
        assert_eq!((left.len(), left[0].1 & 0o111), (1, 0));
        // A copy that reports success but wrote other bytes than it read (what a digest of
        // the bytes read would accept): the digest is of the cache's copy, so it refuses,
        // before that copy is executable.
        let (passed, left) = replay_cache_copy(
            &root,
            Some("/bin/cat \"$@\" | /usr/bin/head -c 4"),
            [&runc, &init],
        );
        assert!(!passed);
        assert_eq!(left, [("runc".to_owned(), left[0].1, b"runc".to_vec())]);
        assert_eq!(left[0].1 & 0o111, 0);
        let _ = fs::remove_dir_all(&root);
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
        // The replays above end where the script first meets the live cache (its bound
        // executables are mount points), before any digest is compared. So the script's
        // copy-and-check loop, verbatim, is replayed on a scratch directory beside the
        // cache: it reaches the comparison of each copy's digest, passes with the right
        // digests and stops at the comparison with a wrong one, leaving the copy it
        // refused not executable. The scratch directory is a tmpfs of its own, as the
        // cache is (`/run/hack-local` holds 16 MiB), and is unmounted and removed each time.
        let replay = format!(
            r#"
scratch=/run/hack-local/engine-exec-replay
test ! -e "$scratch"
test ! -L "$scratch"
mkdir -m 700 "$scratch"
trap 'umount "$scratch" 2>/dev/null; rmdir "$scratch"' EXIT
mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs "$scratch"
set +e
(set -eu; cache=$scratch; set -- - - "$1" "$2"
{}) >/dev/null 2>&1
status=$?
set -e
left=
for name in runc docker-init; do
 if test -e "$scratch/$name"; then left="$left $name:$(stat -c %a "$scratch/$name")"; fi
done
printf 'status=%s%s\n' "$status" "$left"
"#,
            cache_copy_loop()
        );
        let replayed = |runc: &str, init: &str| {
            let reply = owned.execute_cleanup(&replay, &[runc, init]).unwrap();
            let mut fields = reply.split_whitespace().map(str::to_owned);
            let passed = fields.next().unwrap() == "status=0";
            (passed, fields.collect::<Vec<_>>())
        };
        assert_eq!(
            replayed(&digest, &init_digest),
            (
                true,
                vec!["runc:555".to_owned(), "docker-init:555".to_owned()]
            )
        );
        // A wrong `runc` digest: copied, compared, refused; never made executable, and the
        // loop went no further.
        let (passed, left) = replayed(&"0".repeat(64), &init_digest);
        assert!(!passed);
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(
            left[0].starts_with("runc:") && left[0] != "runc:555",
            "{left:?}"
        );
        // A wrong `docker-init` digest: `runc` passed its comparison, `docker-init` did not.
        let (passed, left) = replayed(&digest, &"0".repeat(64));
        assert!(!passed);
        assert_eq!(left.len(), 2, "{left:?}");
        assert_eq!(left[0], "runc:555");
        assert!(
            left[1].starts_with("docker-init:") && left[1] != "docker-init:555",
            "{left:?}"
        );
        verify();
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
        guest.guard = Some(operating_guard::OperatingGuard::fixture(
            u64::MAX,
            Instant::now() - Duration::from_secs(3),
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
    #[ignore = "Manual owned macOS fixture only; requires explicit candidate root and host watchdog"]
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

    /// A short private directory for a fake agent socket (`sockaddr_un` is small).
    struct ShortDirectory(std::path::PathBuf);
    impl ShortDirectory {
        fn new() -> Self {
            let mut bytes = [0_u8; 6];
            File::open("/dev/urandom")
                .unwrap()
                .read_exact(&mut bytes)
                .unwrap();
            let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let path = Path::new("/tmp").join(format!("hka-{name}"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for ShortDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_a_guest_agent_that_never_starts_a_reply_counts_as_silent() {
        use std::net::Shutdown;
        use std::os::unix::net::{UnixListener, UnixStream};

        let directory = ShortDirectory::new();
        let path = directory.0.join("agent.sock");
        // No listener: refused connections are silence.
        assert!(agent_silent_at(&path));
        let listener = UnixListener::bind(&path).unwrap();
        let connect = || -> std::io::Result<_> {
            let client = UnixStream::connect(&path)?;
            let (peer, _) = listener.accept()?;
            Ok((client, peer))
        };

        // Keep every accepted connection open and unanswered through its deadline.
        let mut kept = Vec::new();
        let started = Instant::now();
        assert!(agent_silent_with(|| agent::answers_ping_with(
            || {
                let (client, peer) = connect()?;
                kept.push(peer);
                Ok(client)
            },
            SILENT_PING_TIMEOUT,
            Instant::now,
        )));
        assert!(started.elapsed() >= SILENT_PING_TIMEOUT * SILENT_PINGS);
        assert_eq!(kept.len(), SILENT_PINGS as usize);

        // Queue one byte before polling, with no responder thread to schedule.
        // The agent never sends a complete reply. A fixed clock makes this check
        // independent of how long the test process is descheduled.
        let now = Instant::now();
        let mut attempts = 0;
        assert!(!agent_silent_with(|| {
            attempts += 1;
            agent::answers_ping_with(
                || {
                    let (client, mut peer) = connect()?;
                    peer.write_all(b"?")?;
                    peer.shutdown(Shutdown::Write)?;
                    kept.push(peer);
                    Ok(client)
                },
                SILENT_PING_TIMEOUT,
                || now,
            )
        }));
        assert_eq!(attempts, 1);

        // EOF before the first reply byte is silence.
        assert!(agent_silent_with(|| agent::answers_ping_with(
            || {
                let (client, peer) = connect()?;
                peer.shutdown(Shutdown::Write)?;
                kept.push(peer);
                Ok(client)
            },
            SILENT_PING_TIMEOUT,
            || now,
        )));
    }

    /// A stand-in for the provider's forwarded engine socket. It holds its first `hold`
    /// connections open and unanswered, then answers every later one with `reply` until it
    /// is dropped, one byte every `gap` when a gap is given. A client that has already given
    /// up is ignored. Dropping it stops and joins its thread, also when an assertion has
    /// failed or no client ever connected: the thread polls for connections and never blocks
    /// in accept.
    struct Forward {
        path: std::path::PathBuf,
        done: std::sync::Arc<std::sync::atomic::AtomicBool>,
        accepted: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Forward {
        fn bind(path: &Path, hold: usize, reply: &'static [u8]) -> Self {
            Self::bind_slow(path, hold, reply, None)
        }

        fn bind_slow(
            path: &Path,
            hold: usize,
            reply: &'static [u8],
            gap: Option<Duration>,
        ) -> Self {
            use std::sync::atomic::Ordering;
            let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
            let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let thread = {
                let (done, accepted) = (done.clone(), accepted.clone());
                std::thread::spawn(move || {
                    let mut held = Vec::new();
                    // Never block in accept: the thread must end when it is told to, without
                    // anybody having to connect.
                    listener.set_nonblocking(true).unwrap();
                    while !done.load(Ordering::SeqCst) {
                        let mut stream = match listener.accept() {
                            Ok((stream, _)) => stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(2));
                                continue;
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue;
                            }
                            Err(_) => break,
                        };
                        if accepted.fetch_add(1, Ordering::SeqCst) < hold {
                            held.push(stream);
                            continue;
                        }
                        // An accepted socket can inherit the listener's mode, and a client
                        // that sends nothing must not hold the thread. A client that has
                        // already gone makes these fail: drop it and carry on.
                        if stream.set_nonblocking(false).is_err()
                            || stream
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .is_err()
                        {
                            continue;
                        }
                        let mut request = [0_u8; 64];
                        let _ = stream.read(&mut request);
                        let Some(gap) = gap else {
                            let _ = stream.write_all(reply);
                            continue;
                        };
                        for byte in reply {
                            if done.load(Ordering::SeqCst) || stream.write_all(&[*byte]).is_err() {
                                break;
                            }
                            std::thread::sleep(gap);
                        }
                    }
                })
            };
            Self {
                path: path.to_owned(),
                done,
                accepted,
                thread: Some(thread),
            }
        }

        fn accepted(&self) -> usize {
            self.accepted.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Drop for Forward {
        fn drop(&mut self) {
            self.done.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            let _ = fs::remove_file(&self.path);
        }
    }

    /// HACK-2475: the provider's forwarded engine socket can accept a connection it never
    /// answers while the forward is still coming up. A later, fresh connection must be
    /// tried before the boot is failed.
    #[test]
    fn the_engine_check_tries_a_fresh_connection_when_one_is_never_answered() {
        const OK: &[u8] = b"HTTP/1.0 200 OK\r\n\r\nOK";
        let limit = Duration::from_millis(400);
        let pause = Duration::from_millis(10);
        let directory = ShortDirectory::new();
        let path = directory.0.join("docker.sock");
        let check = |attempts| engine_ping_within(|| Ok(path.clone()), limit, attempts, pause);

        // The first connection is accepted and never answered; the second is answered.
        {
            let forward = Forward::bind(&path, 1, OK);
            let started = Instant::now();
            check(8).unwrap();
            assert!(
                started.elapsed() >= limit,
                "the first attempt used its whole limit"
            );
            assert!(forward.accepted() >= 2);
        }
        // A forward that never answers fails the check with the code a single attempt
        // reported, after every attempt, each on its own connection.
        {
            let forward = Forward::bind(&path, usize::MAX, OK);
            let started = Instant::now();
            let error = check(3).unwrap_err();
            assert_eq!(error.code, "provider_state");
            assert!(
                error.message.contains("did not answer"),
                "{}",
                error.message
            );
            assert!(started.elapsed() >= limit * 3);
            assert_eq!(forward.accepted(), 3);
        }
        // No listener at all: every attempt is refused, and the check still ends.
        assert_eq!(check(3).unwrap_err().code, "provider_state");
        // An engine that answers at once is confirmed on the first connection.
        {
            let forward = Forward::bind(&path, 0, OK);
            check(3).unwrap();
            assert_eq!(forward.accepted(), 1);
        }
        // A wrong reply keeps `engine_not_ready`, after every attempt.
        {
            let forward = Forward::bind(&path, 0, b"HTTP/1.0 503 no\r\n\r\n");
            assert_eq!(check(3).unwrap_err().code, "engine_not_ready");
            assert_eq!(forward.accepted(), 3);
        }
        // A reply that trickles in cannot outlast the limit of its attempt.
        {
            let forward = Forward::bind_slow(&path, 0, OK, Some(Duration::from_millis(100)));
            let started = Instant::now();
            let error = check(1).unwrap_err();
            assert_eq!(error.code, "provider_state");
            assert!(
                error.message.contains("did not answer"),
                "{}",
                error.message
            );
            assert!(started.elapsed() >= limit && started.elapsed() < limit * 3);
            assert_eq!(forward.accepted(), 1);
        }
    }

    /// Every attempt of the engine check asks for the socket path again, and a path refused
    /// as foreign ends the check at once instead of being retried.
    #[test]
    fn the_engine_check_validates_its_socket_for_every_attempt() {
        let calls = std::cell::Cell::new(0_u32);
        let missing = std::path::PathBuf::from("/nonexistent/hack-fixture/docker.sock");
        let error = engine_ping_within(
            || {
                calls.set(calls.get() + 1);
                Ok(missing.clone())
            },
            Duration::from_millis(50),
            3,
            Duration::ZERO,
        )
        .unwrap_err();
        assert_eq!((error.code, calls.get()), ("provider_state", 3));

        // An unsafe path is not a forward that is still coming up: no further attempt.
        for refusal in ENGINE_SOCKET_REFUSALS {
            calls.set(0);
            let error = engine_ping_within(
                || {
                    calls.set(calls.get() + 1);
                    if calls.get() == 2 {
                        Err(CandidateError::new(refusal, "Fixture refusal."))
                    } else {
                        Ok(missing.clone())
                    }
                },
                Duration::from_millis(50),
                5,
                Duration::ZERO,
            )
            .unwrap_err();
            assert_eq!((error.code, calls.get()), (refusal, 2));
        }
    }

    /// HACK-1968: a guest whose agent still answers pings, but whose engine never finishes
    /// quiescing, is stopped only after a resumed quiesce failed the same way; a first
    /// failure, and any identity or protocol refusal, keep the ordinary report.
    #[test]
    fn only_a_resumed_quiesce_failure_is_a_stall() {
        for code in ["agent_protocol_uncertain", "guest_command_failed"] {
            let error = CandidateError::new(code, "Fixed.");
            assert!(quiesce_stalled(&error, true), "{code}");
            assert!(!quiesce_stalled(&error, false), "{code}");
        }
        for code in [
            "process_identity_mismatch",
            "foreign_state",
            "recovery_required",
            "stop_uncertain",
            "guest_identity_mismatch",
            QUIESCE_STALLED,
        ] {
            assert!(
                !quiesce_stalled(&CandidateError::new(code, "Fixed."), true),
                "{code}"
            );
        }
    }

    /// A fixture guest filesystem for `guest-quiesce.sh`: owner `owner`, boot `boot`, and a
    /// recorded engine at a PID no host process can hold, started at `777`. The script runs
    /// with `PATH` holding only the fixture's `bin`, so no host tool, and in particular no
    /// host `pidof` that sees a real engine, can decide a case. `bin` holds a fake `pidof`
    /// (see [`QuiesceFixture::guest_processes`]), a no-op `sync`, and the plain host
    /// `cat`, `awk` and `readlink` the script reads fixture files with. `seq` and `sleep`
    /// are absent: only the bounded wait after `kill` uses them, and no case reaches it.
    struct QuiesceFixture(std::path::PathBuf);

    const FIXTURE_ENGINE_PID: &str = "2147483646";

    impl QuiesceFixture {
        fn new() -> Self {
            let root = crate::test_root::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                "hack-quiesce-identity",
            );
            let engine = root.join("proc").join(FIXTURE_ENGINE_PID);
            for directory in [
                root.join("storage"),
                root.join("proc/sys/kernel/random"),
                root.join("run/hack-local"),
                root.join("opt/hack-engine"),
                root.join("bin"),
                root.join("pidof"),
                engine.clone(),
            ] {
                fs::create_dir_all(directory).unwrap();
            }
            let executable = |name: &str, body: String| {
                use std::os::unix::fs::PermissionsExt;
                let path = root.join("bin").join(name);
                fs::write(&path, body).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            };
            // Prints the fixture's PIDs for a name, like `pidof`, using shell builtins only.
            let pidof = root.join("pidof");
            executable(
                "pidof",
                format!(
                    "#!/bin/sh\nfile='{}'/\"$1\"\ntest -f \"$file\" || exit 1\nwhile IFS= read -r line || test -n \"$line\"; do printf '%s\\n' \"$line\"; done < \"$file\"\n",
                    pidof.display()
                ),
            );
            executable("sync", "#!/bin/sh\nexit 0\n".into());
            for tool in ["cat", "awk", "readlink"] {
                let host = ["/bin", "/usr/bin"]
                    .iter()
                    .map(|directory| Path::new(directory).join(tool))
                    .find(|path| path.is_file())
                    .unwrap_or_else(|| panic!("host {tool}"));
                std::os::unix::fs::symlink(host, root.join("bin").join(tool)).unwrap();
            }
            fs::write(root.join("storage/.hack-local-owner"), "owner").unwrap();
            fs::write(root.join("proc/sys/kernel/random/boot_id"), "boot").unwrap();
            fs::write(root.join("run/hack-local/docker.pid"), FIXTURE_ENGINE_PID).unwrap();
            let fixture = Self(root);
            fixture.engine_started_at("777");
            fixture.engine_exe("opt/hack-engine/dockerd");
            fixture
        }

        fn engine_started_at(&self, start: &str) {
            let stat = format!(
                "{FIXTURE_ENGINE_PID} (dockerd) S {}{start}",
                "0 ".repeat(18)
            );
            fs::write(
                self.0.join("proc").join(FIXTURE_ENGINE_PID).join("stat"),
                stat,
            )
            .unwrap();
        }

        /// Make the fake `pidof NAME` print `pids` and succeed, as for a running process.
        fn guest_processes(&self, name: &str, pids: &str) {
            fs::write(self.0.join("pidof").join(name), pids).unwrap();
        }

        fn engine_exe(&self, relative: &str) {
            let link = self.0.join("proc").join(FIXTURE_ENGINE_PID).join("exe");
            let _ = fs::remove_file(&link);
            std::os::unix::fs::symlink(self.0.join(relative), link).unwrap();
        }

        /// Run the shipped script with its absolute guest paths moved under the fixture and
        /// decode its exit status the way the agent's reply is decoded. Every case below
        /// refuses or finishes before `kill`, which could reach no host process anyway.
        fn quiesce(&self, owner: &str, boot: &str, mode: &str) -> Result<String, CandidateError> {
            let root = self.0.to_str().unwrap();
            let mut script = include_str!("guest-quiesce.sh").to_owned();
            for path in [
                "/storage/",
                "/proc/",
                "/run/hack-local/",
                "/opt/hack-engine/",
            ] {
                script = script.replace(path, &format!("{root}{path}"));
            }
            let output = std::process::Command::new("/bin/sh")
                .env_clear()
                .env("PATH", self.0.join("bin"))
                .args(["-c", &script, "hack-local", owner, boot])
                .args([FIXTURE_ENGINE_PID, "777", mode])
                .output()
                .unwrap();
            agent::decode_execution_for_test(json!({
                "status":"completed", "exit_code":output.status.code(),
                "stdout":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &output.stdout)
            }))
        }
    }

    impl Drop for QuiesceFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// HACK-1968 review: every owner, boot or engine identity refusal in the quiesce script
    /// decodes to `guest_identity_mismatch`, which never authorizes an unclean stop, on a
    /// first or a resumed attempt.
    #[test]
    fn a_guest_identity_refusal_never_authorizes_an_unclean_stop() {
        type Change = fn(&QuiesceFixture);
        let refusals: [(&str, &str, &str, Change); 5] = [
            ("other-owner", "boot", "initial", |_| {}),
            ("owner", "other-boot", "resume", |_| {}),
            ("owner", "boot", "initial", |fixture| {
                fs::write(fixture.0.join("run/hack-local/docker.pid"), "4243").unwrap();
            }),
            ("owner", "boot", "resume", |fixture| {
                fixture.engine_exe("opt/other/dockerd");
            }),
            ("owner", "boot", "initial", |fixture| {
                fixture.engine_started_at("778")
            }),
        ];
        for (index, (owner, boot, mode, change)) in refusals.into_iter().enumerate() {
            let fixture = QuiesceFixture::new();
            change(&fixture);
            for resumed in [false, true] {
                let error = fixture.quiesce(owner, boot, mode).unwrap_err();
                assert_eq!(error.code, "guest_identity_mismatch", "case {index}");
                let classified = quiesce_failure(error, resumed);
                assert_eq!(classified.code, "guest_identity_mismatch", "case {index}");
                assert!(!authorizes_unclean_stop(&classified), "case {index}");
                assert!(
                    classified
                        .message
                        .contains("does not match the runtime receipt")
                );
                assert!(classified.message.contains("runtime recover"));
                assert!(classified.message_fixed);
            }
        }
    }

    /// A real stall, the script's bounded wait ending (exit 42), still authorizes the
    /// unclean stop on a resumed attempt only. A resumed stop whose recorded PID now names a
    /// later process sees the engine exited and quiesces cleanly instead of refusing.
    #[test]
    fn a_resumed_quiesce_timeout_still_authorizes_an_unclean_stop() {
        let timeout = || {
            agent::decode_execution_for_test(json!({"status":"completed", "exit_code":42}))
                .unwrap_err()
        };
        assert!(!authorizes_unclean_stop(&quiesce_failure(timeout(), false)));
        let stalled = quiesce_failure(timeout(), true);
        assert_eq!(stalled.code, QUIESCE_STALLED);
        assert!(authorizes_unclean_stop(&stalled));
        let fixture = QuiesceFixture::new();
        fixture.engine_started_at("778");
        fs::remove_file(fixture.0.join("run/hack-local/docker.pid")).unwrap();
        assert_eq!(
            fixture.quiesce("owner", "boot", "resume").unwrap(),
            "quiesced\n"
        );
    }

    /// HACK-1993: once the recorded engine is gone, a resumed stop reports `quiesced` only
    /// when no pidfile, dockerd or containerd remains. `set -e` ignores a failing
    /// `! pidof`, so the script used to print `quiesced` while an engine still ran. Each
    /// remaining engine now exits 42, the engine-did-not-exit status, which a resumed
    /// stop treats as a stall.
    #[test]
    fn a_resumed_stop_never_reports_quiesced_while_an_engine_remains() {
        type Remaining = fn(&QuiesceFixture);
        let remaining: [(&str, Remaining); 3] = [
            ("dockerd", |fixture| {
                fixture.guest_processes("dockerd", "1322")
            }),
            ("containerd", |fixture| {
                fixture.guest_processes("containerd", "1089")
            }),
            ("pidfile", |fixture| {
                fs::write(fixture.0.join("run/hack-local/docker.pid"), "1322").unwrap();
            }),
        ];
        for (case, remain) in remaining {
            let fixture = QuiesceFixture::new();
            fs::remove_file(fixture.0.join("proc").join(FIXTURE_ENGINE_PID).join("stat")).unwrap();
            fs::remove_file(fixture.0.join("run/hack-local/docker.pid")).unwrap();
            assert_eq!(
                fixture.quiesce("owner", "boot", "resume").unwrap(),
                "quiesced\n",
                "{case}"
            );
            remain(&fixture);
            let error = fixture.quiesce("owner", "boot", "resume").unwrap_err();
            assert_eq!(error.code, "guest_command_failed", "{case}");
            assert!(error.message.contains("exit 42"), "{case}");
            assert!(!authorizes_unclean_stop(&quiesce_failure(
                fixture.quiesce("owner", "boot", "resume").unwrap_err(),
                false
            )));
            assert!(
                authorizes_unclean_stop(&quiesce_failure(error, true)),
                "{case}"
            );
        }
    }

    /// The first stop's identity refusal leaves the pool `quiescing`; the next `down` and
    /// `recover` resume it (`resumed` is true) and, refused again, still do not stop the
    /// provider. Both share `authorizes_unclean_stop`.
    #[test]
    fn a_second_down_or_recover_after_an_identity_refusal_still_refuses() {
        let fixture = QuiesceFixture::new();
        let first = fixture
            .quiesce("other-owner", "boot", "initial")
            .unwrap_err();
        assert!(!authorizes_unclean_stop(&quiesce_failure(first, false)));
        for _second_down_then_recover in 0..2 {
            let again = fixture
                .quiesce("other-owner", "boot", "resume")
                .unwrap_err();
            let classified = quiesce_failure(again, true);
            assert_eq!(classified.code, "guest_identity_mismatch");
            assert_ne!(classified.code, QUIESCE_STALLED);
            assert!(!authorizes_unclean_stop(&classified));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_silent_guest_is_not_stopped_under_an_admitted_build() {
        let root = crate::test_root::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-silent-stop-build",
        );
        let checkout = root.join("checkout");
        state::private_directory(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        // A live process stands in for the recorded provider; it must not be signalled.
        let mut provider = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut owner: Owner = serde_json::from_value(json!({
            "version":1,"checkout":"/fixture","token":"fixture","machine":"fixture",
            "short_home":"/fixture","created":true,"phase":"running","process":null,
            "storage":null,"overlay":null,"guest_boot_id":null,
            "daemon_pid":null,"daemon_start":null,"rootfs_digest":null
        }))
        .unwrap();
        owner.process = Some(identity::observe(provider.id() as i32).unwrap());
        // An admitted build holds the shared fence, as `image_build::run` does.
        let fence = super::super::image_build::hold_build_fence_for_test(&candidate);
        let refused = stop_silent_guest(&candidate, &mut owner).unwrap_err();
        assert_eq!(refused.code, "provider_busy");
        assert!(refused.message.contains("Ctrl-C"));
        assert!(
            provider.try_wait().unwrap().is_none(),
            "provider was signalled"
        );
        assert_eq!(owner.phase, "running");
        drop(fence);
        // Without a build, the check passes and the stop proceeds to identity checks.
        assert!(require_no_build_for_silent_stop(&candidate).is_ok());
        provider.kill().unwrap();
        provider.wait().unwrap();
        let _ = fs::remove_dir_all(&root);
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
        stop_verified_provider(&observed, &observed.executable).unwrap();
        reaper.join().unwrap();
        assert!(!identity::alive(observed.pid).unwrap());
        assert!(sentinel.try_wait().unwrap().is_none());
        sentinel.kill().unwrap();
        sentinel.wait().unwrap();
    }

    #[test]
    fn a_prepared_start_refuses_ambiguous_capacity_before_any_pool_state() {
        let checkout = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-prepared-sockets-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
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
                amd64_emulation: false,
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
            "hack-template-sequence-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
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
