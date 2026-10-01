//! Exact pool quiescence proof for explicit legacy dependency-socket recovery.
//! This grants no graph cleanup or data deletion authority. In particular, a
//! private unrecorded socket inode does not prove who originally created it.
use super::{
    Candidate, CandidateError, Engine, Kind, Method, Receipt, directory, host_pin_recovery,
    inspect_resource, load_at, publication_gate, restore, state,
};
use crate::provider::{lifecycle, state::Owner};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_GRAPHS: usize = 64;
const MAX_GRAPH_FILES: usize = 256;
const MAX_STATE_BYTES: u64 = 2 * 1024 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "dependency_socket_recovery",
        "Pool quiescence or selected runtime identity changed; dependency sockets and data were retained.",
    )
}

fn id(path: &Path) -> Result<(u64, u64), CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
    Ok((metadata.dev(), metadata.ino()))
}

fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}

type GraphInventory = (Option<(u64, u64)>, Vec<String>);

fn graph_runs(candidate: &Candidate) -> Result<GraphInventory, CandidateError> {
    let root = candidate.state_root.join("run/graphs");
    if absent(&root)? {
        return Ok((None, Vec::new()));
    }
    state::check_private_directory(&root).map_err(|_| refused())?;
    let identity = id(&root)?;
    let entries = fs::read_dir(&root)
        .map_err(|_| refused())?
        .take(MAX_GRAPHS + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| refused())?;
    if entries.len() > MAX_GRAPHS {
        return Err(refused());
    }
    let mut runs = Vec::with_capacity(entries.len());
    for entry in entries {
        let run = entry.file_name().into_string().map_err(|_| refused())?;
        if !super::hex(&run, 32) || directory(candidate, &run)? != entry.path() {
            return Err(refused());
        }
        state::check_private_directory(&entry.path()).map_err(|_| refused())?;
        runs.push(run);
    }
    runs.sort();
    if runs.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(refused());
    }
    Ok((Some(identity), runs))
}

struct Foreground {
    root: PathBuf,
    directory: (u64, u64),
    lock: state::Lock,
}

impl Foreground {
    fn acquire(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = super::foreground::transport::root(candidate, run)?;
        let lock = if absent(&root)? {
            state::Lock::acquire(&root)?
        } else {
            state::check_private_directory(&root).map_err(|_| refused())?;
            state::Lock::acquire_existing(&root)?
        };
        let result = Self {
            directory: id(&root)?,
            root,
            lock,
        };
        result.verify()?;
        Ok(result)
    }

    fn verify(&self) -> Result<(), CandidateError> {
        state::check_private_directory(&self.root).map_err(|_| refused())?;
        if id(&self.root)? != self.directory {
            return Err(refused());
        }
        host_pin_recovery::exact_lock_path(&self.root, &self.lock).map_err(|_| refused())?;
        let entries = fs::read_dir(&self.root)
            .map_err(|_| refused())?
            .take(2)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| refused())?;
        if entries.len() != 1 || entries[0].file_name().to_str() != Some("operation.lock") {
            return Err(refused());
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct GraphProof {
    run: String,
    graph_root: (u64, u64),
    state_file: (u64, u64),
    state_sha256: String,
    foreground_root: (u64, u64),
    retained_volumes: BTreeMap<String, (String, String, String)>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct Selection {
    version: u8,
    checkout: PathBuf,
    owner_sha256: String,
    owner_file: (u64, u64),
    owner_root: (u64, u64),
    owner_token: String,
    guest_boot: String,
    host_boot_micros: u64,
    home: (u64, u64),
    graph_directory: Option<(u64, u64)>,
    dependency_assignments: Option<(u64, u64)>,
    graphs: Vec<GraphProof>,
}

fn no_pending(root: &Path) -> Result<(), CandidateError> {
    let entries = fs::read_dir(root)
        .map_err(|_| refused())?
        .take(MAX_GRAPH_FILES + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| refused())?;
    if entries.len() > MAX_GRAPH_FILES
        || entries.iter().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_none_or(|name| name.ends_with(".pending"))
        })
    {
        return Err(refused());
    }
    Ok(())
}

fn no_dependency_assignments(candidate: &Candidate) -> Result<Option<(u64, u64)>, CandidateError> {
    let root = candidate.state_root.join("run/dependency-assignments");
    if absent(&root)? {
        return Ok(None);
    }
    state::check_private_directory(&root).map_err(|_| refused())?;
    if fs::read_dir(&root).map_err(|_| refused())?.next().is_some() {
        return Err(refused());
    }
    Ok(Some(id(&root)?))
}

fn no_guest_containers(engine: &Engine<'_>) -> Result<(), CandidateError> {
    let inventory = engine.request(
        Method::GET,
        "/v1.53/containers/json?all=true&limit=129",
        None,
    )?;
    let entries = inventory.as_array().ok_or_else(refused)?;
    // A nonempty list includes either a still-live consumer or an unrecorded
    // stopped object whose mounts cannot be attributed to this selection.
    if !entries.is_empty() {
        return Err(refused());
    }
    Ok(())
}

fn no_compute(engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError> {
    for resource in receipt.resources.values() {
        if resource.kind == Kind::Volume {
            continue;
        }
        if resource.phase != "absent" || inspect_resource(engine, receipt, resource)?.is_some() {
            return Err(refused());
        }
        let suffix = if resource.kind == Kind::Container {
            "/json"
        } else {
            ""
        };
        let path = format!(
            "/v1.53/{}/{}{}",
            resource.kind.collection(),
            resource.name,
            suffix
        );
        match engine.request(Method::GET, &path, None) {
            Err(error) if error.code == "engine_not_found" => {}
            _ => return Err(refused()),
        }
    }
    Ok(())
}

fn stopped_startup(receipt: &Receipt) -> Result<&super::startup::Startup, CandidateError> {
    if receipt.phase != "stopped-data-retained" || receipt.relay_cleanup.is_some() {
        return Err(refused());
    }
    receipt.relay_startup.as_ref().ok_or_else(refused)
}

fn graph_proof(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
    foreground: &Foreground,
) -> Result<GraphProof, CandidateError> {
    foreground.verify()?;
    let root = directory(candidate, run)?;
    no_pending(&root)?;
    let (receipt, _) = load_at(root.clone(), run, engine.guest().incarnation())?;
    let startup = stopped_startup(&receipt)?;
    if !absent(&startup.control_root)? {
        return Err(refused());
    }
    let state_path = root.join("state.json");
    let state_bytes = host_pin_recovery::read_raw(&state_path, MAX_STATE_BYTES)?;
    let raw_receipt: Receipt = serde_json::from_slice(&state_bytes).map_err(|_| refused())?;
    if serde_json::to_value(&raw_receipt).map_err(|_| refused())?
        != serde_json::to_value(&receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    no_compute(engine, &receipt)?;
    let retained_volumes = restore::observed_volumes(engine, &receipt)?;
    Ok(GraphProof {
        run: run.into(),
        graph_root: id(&root)?,
        state_file: id(&state_path)?,
        state_sha256: format!("{:x}", Sha256::digest(state_bytes)),
        foreground_root: foreground.directory,
        retained_volumes,
    })
}

fn observe(
    candidate: &Candidate,
    engine: &Engine<'_>,
    foreground: &[Foreground],
) -> Result<(Owner, Selection), CandidateError> {
    lifecycle::host_filesystem::no_auxiliary_update(candidate)?;
    let owner = Owner::load(candidate)?;
    if owner.phase != "running"
        || owner.token != engine.guest().incarnation()
        || owner.guest_boot_id.as_deref() != Some(engine.guest().boot_id())
        || owner.dependency_sockets.is_none()
    {
        return Err(refused());
    }
    host_pin_recovery::verify_guest_identity(engine)?;
    let owner_root = candidate.state_root.join("run/smolvm");
    let owner_path = owner_root.join("owner.json");
    let owner_bytes = host_pin_recovery::read_raw(&owner_path, 1024 * 1024)?;
    if serde_json::from_slice::<Owner>(&owner_bytes).map_err(|_| refused())? != owner {
        return Err(refused());
    }
    let home = owner_root.join("home");
    state::check_private_directory(&home).map_err(|_| refused())?;
    let home_id = id(&home)?;
    let alias = fs::metadata(&owner.short_home).map_err(|_| refused())?;
    if (alias.dev(), alias.ino()) != home_id {
        return Err(refused());
    }
    let (graph_directory, runs) = graph_runs(candidate)?;
    if runs.len() != foreground.len() {
        return Err(refused());
    }
    no_guest_containers(engine)?;
    super::bridges::cleanup::require_quiescent(candidate, engine)?;
    let mut graphs = Vec::with_capacity(runs.len());
    for (run, guard) in runs.iter().zip(foreground) {
        graphs.push(graph_proof(candidate, engine, run, guard)?);
    }
    let selected = Selection {
        version: 1,
        checkout: candidate.checkout.clone(),
        owner_sha256: format!("{:x}", Sha256::digest(owner_bytes)),
        owner_file: id(&owner_path)?,
        owner_root: id(&owner_root)?,
        owner_token: owner.token.clone(),
        guest_boot: engine.guest().boot_id().into(),
        host_boot_micros: lifecycle::host_filesystem::host_boot_micros()?,
        home: home_id,
        graph_directory,
        dependency_assignments: no_dependency_assignments(candidate)?,
        graphs,
    };
    Ok((owner, selected))
}

/// Holds the publication gate, every selected foreground lock, and then the
/// provider Engine lease. Rechecking this exact observation is required before
/// each socket unlink and after the last unlink.
pub(crate) struct Guard<'a> {
    candidate: &'a Candidate,
    gate: publication_gate::Guard,
    foreground: Vec<Foreground>,
    engine: Engine<'a>,
    owner: Owner,
    selected: Selection,
    sha256: String,
}

impl<'a> Guard<'a> {
    pub(crate) fn acquire(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        let gate = publication_gate::Guard::acquire(candidate)?;
        let (_, runs) = graph_runs(candidate)?;
        let mut foreground = Vec::with_capacity(runs.len());
        for run in &runs {
            foreground.push(Foreground::acquire(candidate, run)?);
        }
        gate.verify(candidate)?;
        let engine = Engine::connect_cleanup_wait(candidate)?;
        let (owner, selected) = observe(candidate, &engine, &foreground)?;
        let bytes = serde_json::to_vec(&selected).map_err(|_| refused())?;
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let guard = Self {
            candidate,
            gate,
            foreground,
            engine,
            owner,
            selected,
            sha256,
        };
        guard.verify(candidate)?;
        Ok(guard)
    }

    pub(crate) fn verify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        if self.candidate.state_root != candidate.state_root
            || self.candidate.checkout != candidate.checkout
        {
            return Err(refused());
        }
        self.gate.verify(candidate)?;
        for guard in &self.foreground {
            guard.verify()?;
        }
        self.engine.guest().verify()?;
        let (owner, selected) = observe(candidate, &self.engine, &self.foreground)?;
        if owner != self.owner || selected != self.selected {
            return Err(refused());
        }
        self.gate.verify(candidate)?;
        Ok(())
    }

    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }

    pub(crate) fn owner(&self) -> &Owner {
        &self.owner
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn graph_inventory_accepts_only_absent_or_bounded_private_run_directories() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        assert_eq!(graph_runs(&candidate).unwrap(), (None, Vec::new()));
        let graphs = candidate.state_root.join("run/graphs");
        state::private_directory(&graphs).unwrap();
        assert_eq!(graph_runs(&candidate).unwrap().1, Vec::<String>::new());
        fs::write(graphs.join("unknown"), b"not a graph").unwrap();
        assert!(graph_runs(&candidate).is_err());
        fs::remove_file(graphs.join("unknown")).unwrap();
        state::private_directory(&graphs.join("a".repeat(32))).unwrap();
        assert_eq!(graph_runs(&candidate).unwrap().1, vec!["a".repeat(32)]);
    }

    #[test]
    fn pending_and_active_graphs_never_satisfy_stopped_policy() {
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("graph");
        state::private_directory(&root).unwrap();
        assert!(no_pending(&root).is_ok());
        fs::write(root.join("state.pending"), b"interrupted").unwrap();
        assert!(no_pending(&root).is_err());
        fs::remove_file(root.join("state.pending")).unwrap();
        fs::write(root.join("unknown.pending"), b"interrupted").unwrap();
        assert!(no_pending(&root).is_err());

        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"ready-observed","readiness":{},"resources":{},
            "relay_startup":{"control_only":true,"guest_root":null,
                "control_root":"/private/missing","artifact":"e".repeat(64),"services":{}}
        }))
        .unwrap();
        assert!(stopped_startup(&receipt).is_err());
        receipt.phase = "stopped-data-retained".into();
        assert!(stopped_startup(&receipt).is_ok());
        receipt.relay_startup = None;
        assert!(stopped_startup(&receipt).is_err());
    }

    #[test]
    fn dependency_assignment_directory_must_be_empty_and_private() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        assert_eq!(no_dependency_assignments(&candidate).unwrap(), None);
        let assignments = candidate.state_root.join("run/dependency-assignments");
        state::private_directory(&assignments).unwrap();
        assert!(no_dependency_assignments(&candidate).unwrap().is_some());
        fs::write(assignments.join("stale.json"), b"selected").unwrap();
        assert!(no_dependency_assignments(&candidate).is_err());
    }

    #[test]
    fn foreground_reservation_refuses_replaced_lock_path() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let run = "a".repeat(32);
        let guard = Foreground::acquire(&candidate, &run).unwrap();
        guard.verify().unwrap();
        let root = guard.root.clone();
        fs::rename(root.join("operation.lock"), root.join("old.lock")).unwrap();
        let replacement = state::Lock::acquire(&root).unwrap();
        assert!(guard.verify().is_err());
        drop(replacement);
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }
}
