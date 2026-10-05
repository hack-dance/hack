//! Explicit retirement of one acknowledged, dead publication whose lock path
//! disappeared. A caller must first quiesce older candidate-home launchers:
//! the publication gate cannot serialize binaries predating that gate.
use super::*;
use crate::provider::{lifecycle, state::Owner};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    },
    path::PathBuf,
};

const INTENT: &str = "missing-lock-retirement-intent.json";
const COMPLETE: &str = "missing-lock-retirement-complete.json";
const LIMIT: u64 = 64 * 1024;

fn refused() -> CandidateError {
    error(
        "graph_missing_publication_lock",
        "Selected missing-lock retirement changed or is incomplete; publication and retained data were preserved.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
fn raw(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    host_pin_recovery::read_raw(path, limit).map_err(|_| refused())
}
fn raw_with_id(path: &Path, limit: u64) -> Result<(Vec<u8>, (u64, u64)), CandidateError> {
    let before = id(path)?;
    let bytes = raw(path, limit)?;
    if id(path)? != before {
        return Err(refused());
    }
    Ok((bytes, before))
}
fn id(path: &Path) -> Result<(u64, u64), CandidateError> {
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    Ok((m.dev(), m.ino()))
}
fn sync(root: &Path) -> Result<(), CandidateError> {
    File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(|_| refused())
}
fn marker(selection: &str, nonce: &str) -> Vec<u8> {
    format!("hack-missing-publication-lock-v1 {selection} {nonce}\n").into_bytes()
}
fn temp_name(selection: &str) -> String {
    format!("missing-lock-{selection}.lock")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u8,
    checkout: PathBuf,
    state_root: PathBuf,
    run: String,
    owner: String,
    owner_sha256: String,
    owner_file: (u64, u64),
    guest_boot: String,
    host_boot_micros: u64,
    receipt_sha256: String,
    receipt_file: (u64, u64),
    graph_root: (u64, u64),
    namespace: String,
    plan: String,
    foreground_root: (u64, u64),
    publisher: foreground::transport::LegacyPublisher,
}
impl Selection {
    fn sha256(&self) -> Result<String, CandidateError> {
        Ok(digest(&serde_json::to_vec(self).map_err(|_| refused())?))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    selection: Selection,
    selection_sha256: String,
    nonce: String,
    marker_sha256: String,
}
impl Intent {
    fn new(selection: Selection) -> Result<Self, CandidateError> {
        let selection_sha256 = selection.sha256()?;
        let mut random = [0u8; 32];
        File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut random))
            .map_err(|_| refused())?;
        let nonce = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(Self {
            version: 1,
            marker_sha256: digest(&marker(&selection_sha256, &nonce)),
            selection,
            selection_sha256,
            nonce,
        })
    }
    fn validate(&self) -> Result<(), CandidateError> {
        if self.version != 1
            || self.selection.version != 1
            || !hex(&self.selection.run, 32)
            || !hex(&self.selection.owner, 32)
            || !hex(&self.selection.owner_sha256, 64)
            || !hex(&self.selection.receipt_sha256, 64)
            || !hex(&self.selection.publisher.owner_sha256, 64)
            || !hex(&self.nonce, 64)
            || self.selection.publisher.parent != self.selection.foreground_root
            || self.selection.sha256()? != self.selection_sha256
            || self.marker_sha256 != digest(&marker(&self.selection_sha256, &self.nonce))
        {
            return Err(refused());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u8,
    intent_sha256: String,
    retirement_sha256: String,
    lock: (u64, u64),
}
fn intent_path(root: &Path) -> PathBuf {
    root.join(INTENT)
}
fn completion_path(root: &Path) -> PathBuf {
    root.join(COMPLETE)
}
fn retirement_path(root: &Path, owner: &str) -> PathBuf {
    root.join(format!("retirement-{owner}.json"))
}
fn selected_root(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    foreground::transport::root(candidate, run)
}
fn initial_publication_clear(root: &Path) -> Result<(), CandidateError> {
    state::check_private_directory(root).map_err(|_| refused())?;
    for path in [
        root.join("operation.lock"),
        intent_path(root),
        completion_path(root),
        completion_path(root).with_extension("pending"),
    ] {
        if !absent(&path)? {
            return Err(refused());
        }
    }
    Ok(())
}
fn provider_owner_stable(candidate: &Candidate) -> Result<(), CandidateError> {
    if !absent(&candidate.state_root.join("run/smolvm/owner.pending"))? {
        return Err(refused());
    }
    Ok(())
}

/// Fail closed for any interrupted repair. Completed evidence is checked
/// independently against its exact lock marker, journal and archived pins.
pub(in crate::provider::graph) fn require_no_pending(
    candidate: &Candidate,
    run: &str,
) -> Result<(), CandidateError> {
    let root = selected_root(candidate, run)?;
    require_no_pending_root(&root)?;
    if !absent(&intent_path(&root))? {
        let intent: Intent =
            serde_json::from_slice(&raw(&intent_path(&root), LIMIT)?).map_err(|_| refused())?;
        if intent.selection.checkout != candidate.checkout
            || intent.selection.state_root != candidate.state_root
            || intent.selection.run != run
        {
            return Err(refused());
        }
    }
    Ok(())
}
pub(in crate::provider::graph) fn require_no_pending_root(
    root: &Path,
) -> Result<(), CandidateError> {
    if absent(root)? {
        return Ok(());
    }
    state::check_private_directory(root).map_err(|_| refused())?;
    for name in [
        "missing-lock-retirement-intent.pending",
        "missing-lock-retirement-complete.pending",
    ] {
        if !absent(&root.join(name))? {
            return Err(refused());
        }
    }
    let present = !absent(&intent_path(root))?;
    if !present {
        return if absent(&completion_path(root))? {
            Ok(())
        } else {
            Err(refused())
        };
    }
    let intent_bytes = raw(&intent_path(root), LIMIT)?;
    let intent: Intent = serde_json::from_slice(&intent_bytes).map_err(|_| refused())?;
    intent.validate()?;
    if intent.selection.state_root != intent.selection.checkout.join(".hack-local")
        || foreground::transport::root_from_state(
            &intent.selection.state_root,
            &intent.selection.run,
        )
        .map_err(|_| refused())?
            != root
        || id(root)? != intent.selection.foreground_root
    {
        return Err(refused());
    }
    let complete: Completion =
        serde_json::from_slice(&raw(&completion_path(root), LIMIT)?).map_err(|_| refused())?;
    if complete.version != 1 || complete.intent_sha256 != digest(&intent_bytes) {
        return Err(refused());
    }
    let journal = raw(
        &retirement_path(root, &intent.selection.publisher.owner_sha256),
        LIMIT,
    )?;
    if !absent(
        &retirement_path(root, &intent.selection.publisher.owner_sha256).with_extension("pending"),
    )? || !absent(&root.join(temp_name(&intent.selection_sha256)))?
    {
        return Err(refused());
    }
    let lock_path = root.join("operation.lock");
    let retired: Value = serde_json::from_slice(&journal).map_err(|_| refused())?;
    if complete.retirement_sha256 != digest(&journal)
        || complete.lock != id(&lock_path)?
        || raw(&lock_path, 256)? != marker(&intent.selection_sha256, &intent.nonce)
        || retired["version"] != 1
        || retired["candidate"] != json!(intent.selection.checkout)
        || retired["run"] != intent.selection.run
        || retired["receipt_sha256"] != intent.selection.receipt_sha256
        || retired["owner_sha256"] != intent.selection.publisher.owner_sha256
        || retired["parent"] != json!(intent.selection.publisher.parent)
        || retired["lock"] != json!(complete.lock)
        || retired["socket"] != json!(intent.selection.publisher.socket)
        || retired["record"] != json!(intent.selection.publisher.record)
    {
        return Err(refused());
    }
    let archived_owner = root.join(format!(
        "owner-{}.retired.json",
        &intent.selection.publisher.owner_sha256[..24]
    ));
    let archived_socket = root.join(format!(
        "control-{}.retired.sock",
        &intent.selection.publisher.owner_sha256[..24]
    ));
    let owner_bytes = raw(&archived_owner, 8192)?;
    let archived_owner_value: Value =
        serde_json::from_slice(&owner_bytes).map_err(|_| refused())?;
    let socket = fs::symlink_metadata(&archived_socket).map_err(|_| refused())?;
    if retired["owner"] != archived_owner_value
        || digest(&owner_bytes) != intent.selection.publisher.owner_sha256
        || id(&archived_owner)? != intent.selection.publisher.record
        || (socket.dev(), socket.ino()) != intent.selection.publisher.socket
        || !socket.file_type().is_socket()
        || socket.nlink() != 1
        || socket.uid() != unsafe { libc::geteuid() }
        || socket.mode() & 0o7777 != 0o600
    {
        return Err(refused());
    }
    // The archived generation must never reappear under its original names.
    // New generations may later bind those names under the same retained lock.
    if !absent(&root.join("owner.json"))?
        && digest(&raw(&root.join("owner.json"), 8192)?) == intent.selection.publisher.owner_sha256
    {
        return Err(refused());
    }
    if !absent(&root.join("control.sock"))?
        && id(&root.join("control.sock"))? == intent.selection.publisher.socket
    {
        return Err(refused());
    }
    Ok(())
}

fn current_selection(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<(Selection, Receipt, PathBuf, PathBuf), CandidateError> {
    if !hex(run, 32) {
        return Err(refused());
    }
    let foreground = selected_root(candidate, run)?;
    initial_publication_clear(&foreground)?;
    provider_owner_stable(candidate)?;
    let owner = Owner::load(candidate).map_err(|_| refused())?;
    lifecycle::verify_disks(candidate, &owner).map_err(|_| refused())?;
    let (owner_bytes, owner_file) =
        raw_with_id(&candidate.state_root.join("run/smolvm/owner.json"), LIMIT)?;
    let parsed: Owner = serde_json::from_slice(&owner_bytes).map_err(|_| refused())?;
    if parsed != owner || owner.phase != "running" || owner.token != engine.guest().incarnation() {
        return Err(refused());
    }
    host_pin_recovery::verify_guest_identity(engine).map_err(|_| refused())?;
    let (receipt, graph_root) = load(candidate, engine, run).map_err(|_| refused())?;
    let (receipt_bytes, receipt_file) = raw_with_id(&graph_root.join("state.json"), LIMIT * 32)?;
    if serde_json::to_vec_pretty(&receipt).map_err(|_| refused())? != receipt_bytes {
        return Err(refused());
    }
    let publisher = foreground::transport::dead_publisher_without_lock(candidate, run)
        .map_err(|_| refused())?;
    let short = publisher.owner_sha256.get(..24).ok_or_else(refused)?;
    for path in [
        retirement_path(&foreground, &publisher.owner_sha256),
        retirement_path(&foreground, &publisher.owner_sha256).with_extension("pending"),
        foreground.join(format!("owner-{short}.retired.json")),
        foreground.join(format!("control-{short}.retired.sock")),
    ] {
        if !absent(&path)? {
            return Err(refused());
        }
    }
    let selection = Selection {
        version: 1,
        checkout: candidate.checkout.clone(),
        state_root: candidate.state_root.clone(),
        run: run.into(),
        owner: owner.token,
        owner_sha256: digest(&owner_bytes),
        owner_file,
        guest_boot: engine.guest().boot_id().into(),
        host_boot_micros: lifecycle::host_filesystem::host_boot_micros().map_err(|_| refused())?,
        receipt_sha256: digest(&receipt_bytes),
        receipt_file,
        graph_root: id(&graph_root)?,
        namespace: receipt.namespace.clone(),
        plan: receipt.plan_id.clone(),
        foreground_root: id(&foreground)?,
        publisher,
    };
    verify_cleanup(
        candidate,
        engine,
        &receipt,
        &graph_root,
        &CleanupSelection {
            run,
            owner: &selection.owner,
            receipt_sha256: &selection.receipt_sha256,
        },
    )
    .map_err(|_| refused())?;
    if receipt.owner != selection.owner || selection.publisher.parent != selection.foreground_root {
        return Err(refused());
    }
    Ok((selection, receipt, graph_root, foreground))
}

/// Read-only qualification; the returned digest is an exact effect selector,
/// not proof that older launchers have entered a maintenance window.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate).map_err(|_| refused())?;
    let root = selected_root(candidate, run)?;
    if !absent(&intent_path(&root))? {
        let bytes = raw(&intent_path(&root), LIMIT)?;
        let intent: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        intent.validate()?;
        if intent.selection.checkout != candidate.checkout
            || intent.selection.state_root != candidate.state_root
            || intent.selection.run != run
        {
            return Err(refused());
        }
        if !absent(&completion_path(&root))? {
            require_no_pending(candidate, run)?;
            return Ok(json!({"run":run,"selection_sha256":intent.selection_sha256,
                "stage":"completed-historical","quiescence_required":false}));
        }
        let _ = verify_fixed(candidate, &engine, &intent.selection)?;
        return Ok(json!({"run":run,"selection_sha256":intent.selection_sha256,
            "stage":"interrupted","quiescence_required":true}));
    }
    let (selection, _, _, _) = current_selection(candidate, &engine, run)?;
    let pending = intent_path(&root).with_extension("pending");
    if !absent(&pending)? {
        let bytes = raw(&pending, LIMIT)?;
        let interrupted: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        interrupted.validate()?;
        if interrupted.selection != selection {
            return Err(refused());
        }
    }
    Ok(json!({"run":run,"selection_sha256":selection.sha256()?,
        "stage":if absent(&pending)? {"selected"} else {"interrupted-intent"},
        "quiescence_required":true,"current_boot_acknowledged":true,
        "data_retained":true,"publisher_dead":true,"lock_missing":true}))
}

fn verify_fixed(
    candidate: &Candidate,
    engine: &Engine<'_>,
    selected: &Selection,
) -> Result<(Receipt, PathBuf, PathBuf), CandidateError> {
    if selected.version != 1
        || selected.checkout != candidate.checkout
        || selected.state_root != candidate.state_root
        || lifecycle::host_filesystem::host_boot_micros().map_err(|_| refused())?
            != selected.host_boot_micros
    {
        return Err(refused());
    }
    provider_owner_stable(candidate)?;
    let owner = Owner::load(candidate).map_err(|_| refused())?;
    lifecycle::verify_disks(candidate, &owner).map_err(|_| refused())?;
    let (owner_bytes, owner_file) =
        raw_with_id(&candidate.state_root.join("run/smolvm/owner.json"), LIMIT)?;
    if serde_json::from_slice::<Owner>(&owner_bytes).map_err(|_| refused())? != owner
        || digest(&owner_bytes) != selected.owner_sha256
        || owner_file != selected.owner_file
        || owner.token != selected.owner
        || owner.token != engine.guest().incarnation()
        || engine.guest().boot_id() != selected.guest_boot
    {
        return Err(refused());
    }
    host_pin_recovery::verify_guest_identity(engine).map_err(|_| refused())?;
    let (receipt, graph_root) = load(candidate, engine, &selected.run).map_err(|_| refused())?;
    let (bytes, receipt_file) = raw_with_id(&graph_root.join("state.json"), LIMIT * 32)?;
    if digest(&bytes) != selected.receipt_sha256
        || serde_json::to_vec_pretty(&receipt).map_err(|_| refused())? != bytes
        || receipt.namespace != selected.namespace
        || receipt.plan_id != selected.plan
        || receipt_file != selected.receipt_file
        || id(&graph_root)? != selected.graph_root
    {
        return Err(refused());
    }
    verify_cleanup(
        candidate,
        engine,
        &receipt,
        &graph_root,
        &CleanupSelection {
            run: &selected.run,
            owner: &selected.owner,
            receipt_sha256: &selected.receipt_sha256,
        },
    )
    .map_err(|_| refused())?;
    let foreground = selected_root(candidate, &selected.run)?;
    if id(&foreground)? != selected.foreground_root {
        return Err(refused());
    }
    Ok((receipt, graph_root, foreground))
}

fn verify_initial_files(candidate: &Candidate, selected: &Selection) -> Result<(), CandidateError> {
    if selected.checkout != candidate.checkout
        || selected.state_root != candidate.state_root
        || lifecycle::host_filesystem::host_boot_micros().map_err(|_| refused())?
            != selected.host_boot_micros
    {
        return Err(refused());
    }
    provider_owner_stable(candidate)?;
    let owner = Owner::load(candidate).map_err(|_| refused())?;
    lifecycle::verify_disks(candidate, &owner).map_err(|_| refused())?;
    let (owner_bytes, owner_file) =
        raw_with_id(&candidate.state_root.join("run/smolvm/owner.json"), LIMIT)?;
    if serde_json::from_slice::<Owner>(&owner_bytes).map_err(|_| refused())? != owner
        || owner.token != selected.owner
        || digest(&owner_bytes) != selected.owner_sha256
        || owner_file != selected.owner_file
    {
        return Err(refused());
    }
    let graph_root = directory(candidate, &selected.run).map_err(|_| refused())?;
    let (receipt_bytes, receipt_file) = raw_with_id(&graph_root.join("state.json"), LIMIT * 32)?;
    let receipt: Receipt = serde_json::from_slice(&receipt_bytes).map_err(|_| refused())?;
    if digest(&receipt_bytes) != selected.receipt_sha256
        || receipt.run != selected.run
        || receipt.owner != selected.owner
        || receipt.namespace != selected.namespace
        || receipt.plan_id != selected.plan
        || receipt_file != selected.receipt_file
        || id(&graph_root)? != selected.graph_root
    {
        return Err(refused());
    }
    let foreground = selected_root(candidate, &selected.run)?;
    if id(&foreground)? != selected.foreground_root
        || !absent(&foreground.join("operation.lock"))?
        || foreground::transport::dead_publisher_without_lock(candidate, &selected.run)
            .map_err(|_| refused())?
            != selected.publisher
    {
        return Err(refused());
    }
    Ok(())
}

fn exact_marker(root: &Path, intent: &Intent, lock: &state::Lock) -> Result<(), CandidateError> {
    host_pin_recovery::exact_lock_path(root, lock).map_err(|_| refused())?;
    if raw(&root.join("operation.lock"), 256)? != marker(&intent.selection_sha256, &intent.nonce) {
        return Err(refused());
    }
    Ok(())
}
fn exact_temp(file: &File, path: &Path, expected_links: u64) -> Result<(u64, u64), CandidateError> {
    let held = file.metadata().map_err(|_| refused())?;
    let named = fs::symlink_metadata(path).map_err(|_| refused())?;
    // SAFETY: geteuid takes no arguments and has no side effects.
    if !held.is_file()
        || !named.is_file()
        || held.nlink() != expected_links
        || named.nlink() != expected_links
        || held.mode() & 0o7777 != 0o600
        || named.mode() != held.mode()
        || held.uid() != unsafe { libc::geteuid() }
        || named.uid() != held.uid()
        || (held.dev(), held.ino()) != (named.dev(), named.ino())
    {
        return Err(refused());
    }
    Ok((held.dev(), held.ino()))
}
fn exact_temp_bytes(
    file: &mut File,
    path: &Path,
    links: u64,
    expected: &[u8],
) -> Result<(), CandidateError> {
    exact_temp(file, path, links)?;
    file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(257)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
    exact_temp(file, path, links)?;
    if bytes != expected {
        return Err(refused());
    }
    Ok(())
}

/// Create a private, locked temporary file first; its hard link publishes the
/// exact held inode at operation.lock with destination-exclusive semantics.
fn replacement_lock(root: &Path, intent: &Intent) -> Result<state::Lock, CandidateError> {
    let temp = root.join(temp_name(&intent.selection_sha256));
    let target = root.join("operation.lock");
    let bytes = marker(&intent.selection_sha256, &intent.nonce);
    if absent(&temp)? && absent(&target)? {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)
            .map_err(|_| refused())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| refused())?;
        sync(root)?;
        let lock = state::Lock::from_file(file).map_err(|_| refused())?;
        if raw(&temp, 256)? != bytes || id(&temp)? != lock.identity()? {
            return Err(refused());
        }
        exact_temp(lock.file(), &temp, 1)?;
        fs::hard_link(&temp, &target).map_err(|_| refused())?;
        sync(root)?;
        if id(&target)? != lock.identity()? {
            return Err(refused());
        }
        exact_temp(lock.file(), &temp, 2)?;
        fs::remove_file(&temp).map_err(|_| refused())?;
        sync(root)?;
        exact_marker(root, intent, &lock)?;
        return Ok(lock);
    }
    // A crashed hard-link publication may retain two names for one inode.
    // Recover only the exact durable marker and inode, holding flock before
    // reducing the link count. An incomplete temp marker is never removed.
    if !absent(&temp)? {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&temp)
            .map_err(|_| refused())?;
        let links = if absent(&target)? { 1 } else { 2 };
        exact_temp_bytes(&mut file, &temp, links, &bytes)?;
        if !absent(&target)? && id(&temp)? != id(&target)? {
            return Err(refused());
        }
        // SAFETY: fd is owned and remains live until adopted by Lock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(refused());
        }
        if absent(&target)? {
            exact_temp(&file, &temp, 1)?;
            fs::hard_link(&temp, &target).map_err(|_| refused())?;
            sync(root)?;
        }
        exact_temp(&file, &temp, 2)?;
        if id(&temp)? != id(&target)? {
            return Err(refused());
        }
        fs::remove_file(&temp).map_err(|_| refused())?;
        sync(root)?;
        let lock = state::Lock::from_file(file).map_err(|_| refused())?;
        exact_marker(root, intent, &lock)?;
        return Ok(lock);
    }
    let lock = state::Lock::acquire_existing(root).map_err(|_| refused())?;
    exact_marker(root, intent, &lock)?;
    Ok(lock)
}

/// This action assumes a separately enforced candidate-home maintenance
/// window, acknowledged by the explicit flag. It never changes graph, guest,
/// dependency or retained volume state.
pub fn retire(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    if !hex(run, 32) || !hex(expected, 64) {
        return Err(refused());
    }
    let root = selected_root(candidate, run)?;
    // Selection may borrow the provider lease only before the publication
    // gate. No effect holds Engine ahead of the run lock.
    let preselected = if absent(&intent_path(&root))? {
        let engine = Engine::connect_cleanup_wait(candidate).map_err(|_| refused())?;
        let (selection, _, _, _) = current_selection(candidate, &engine, run)?;
        if selection.sha256()? != expected {
            return Err(refused());
        }
        Some(selection)
    } else {
        None
    };
    let gate = publication_gate::Guard::acquire(candidate).map_err(|_| refused())?;
    state::check_private_directory(&root).map_err(|_| refused())?;
    let intent = if absent(&intent_path(&root))? {
        let selection = preselected.ok_or_else(refused)?;
        if !absent(&completion_path(&root))? {
            return Err(refused());
        }
        if !absent(&completion_path(&root).with_extension("pending"))? {
            return Err(refused());
        }
        verify_initial_files(candidate, &selection)?;
        gate.verify(candidate).map_err(|_| refused())?;
        let pending = intent_path(&root).with_extension("pending");
        let value = if absent(&pending)? {
            Intent::new(selection)?
        } else {
            let bytes = raw(&pending, LIMIT)?;
            let interrupted: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            interrupted.validate()?;
            if interrupted.selection != selection || interrupted.selection_sha256 != expected {
                return Err(refused());
            }
            journal::retain_file(
                &root,
                "missing-lock-retirement-intent.pending",
                "missing-lock-intent-interrupted",
                LIMIT,
            )
            .map_err(|_| refused())?;
            interrupted
        };
        // The durable intent closes admission before creating a new lock inode.
        state::write(&intent_path(&root), &value).map_err(|_| refused())?;
        value
    } else {
        if !absent(&intent_path(&root).with_extension("pending"))? {
            return Err(refused());
        }
        let value: Intent =
            serde_json::from_slice(&raw(&intent_path(&root), LIMIT)?).map_err(|_| refused())?;
        value.validate()?;
        if value.selection_sha256 != expected || value.selection.run != run {
            return Err(refused());
        }
        value
    };
    if !absent(&completion_path(&root))? {
        require_no_pending_root(&root)?;
        return Ok(json!({"run":run,"historical_completion":true,
            "missing_lock_repaired":true}));
    }
    let lock = replacement_lock(&root, &intent)?;
    gate.verify(candidate).map_err(|_| refused())?;
    let engine = Engine::connect_cleanup_wait(candidate).map_err(|_| refused())?;
    let selected = &intent.selection;
    let verify = || {
        gate.verify(candidate).map_err(|_| refused())?;
        exact_marker(&root, &intent, &lock)?;
        let _ = verify_fixed(candidate, &engine, selected)?;
        Ok(())
    };
    verify()?;
    foreground::transport::retire_recovered_publisher_locked_fenced(
        candidate,
        run,
        &selected.publisher.owner_sha256,
        &selected.receipt_sha256,
        None,
        &lock,
        &verify,
    )
    .map_err(|_| refused())?;
    verify()?;
    let intent_bytes = raw(&intent_path(&root), LIMIT)?;
    let journal = raw(
        &retirement_path(&root, &selected.publisher.owner_sha256),
        LIMIT,
    )?;
    let completion = Completion {
        version: 1,
        intent_sha256: digest(&intent_bytes),
        retirement_sha256: digest(&journal),
        lock: lock.identity().map_err(|_| refused())?,
    };
    // A crash during this atomic write leaves a pending file; only this exact
    // selected retry may archive that interrupted candidate and complete.
    if !absent(&completion_path(&root).with_extension("pending"))? {
        let pending_bytes = raw(&completion_path(&root).with_extension("pending"), LIMIT)?;
        let pending: Completion = serde_json::from_slice(&pending_bytes).map_err(|_| refused())?;
        if pending != completion
            || pending_bytes != serde_json::to_vec_pretty(&completion).map_err(|_| refused())?
        {
            return Err(refused());
        }
        journal::retain_file(
            &root,
            "missing-lock-retirement-complete.pending",
            "missing-lock-completion-interrupted",
            LIMIT,
        )
        .map_err(|_| refused())?;
    }
    state::write(&completion_path(&root), &completion).map_err(|_| refused())?;
    require_no_pending_root(&root)?;
    verify()?;
    Ok(
        json!({"run":run,"publisher_retired":true,"data_retained":true,
        "same_boot":true,"acknowledged_cleanup":true,"missing_lock_repaired":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abandoned() -> (
        super::super::super::tests::Fixture,
        Candidate,
        String,
        PathBuf,
        Intent,
    ) {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let run = "a".repeat(32);
        let root = selected_root(&candidate, &run).unwrap();
        foreground::transport::fixture_dead_publisher_without_lock(&candidate, &run);
        let publisher =
            foreground::transport::dead_publisher_without_lock(&candidate, &run).unwrap();
        let selection = Selection {
            version: 1,
            checkout: candidate.checkout.clone(),
            state_root: candidate.state_root.clone(),
            run: run.clone(),
            owner: "b".repeat(32),
            owner_sha256: "c".repeat(64),
            owner_file: (1, 2),
            guest_boot: "test-guest-boot".into(),
            host_boot_micros: 1,
            receipt_sha256: "d".repeat(64),
            receipt_file: (3, 4),
            graph_root: (5, 6),
            namespace: "test".into(),
            plan: "e".repeat(64),
            foreground_root: id(&root).unwrap(),
            publisher,
        };
        let intent = Intent::new(selection).unwrap();
        (fixture, candidate, run, root, intent)
    }

    #[test]
    fn missing_lock_intent_blocks_ordinary_publication_until_exact_archival_completion() {
        let (_fixture, candidate, run, root, intent) = abandoned();
        state::write(&intent_path(&root), &intent).unwrap();
        assert!(require_no_pending(&candidate, &run).is_err());
        assert!(foreground::transport::Retired::acquire(&candidate, &run).is_err());
        assert!(foreground::transport::DeadOwner::acquire(&candidate, &run).is_err());
        assert!(foreground::transport::Retired::acquire(&candidate, &run).is_err());
        let lock = replacement_lock(&root, &intent).unwrap();
        exact_marker(&root, &intent, &lock).unwrap();
        foreground::transport::retire_recovered_publisher_locked_fenced(
            &candidate,
            &run,
            &intent.selection.publisher.owner_sha256,
            &intent.selection.receipt_sha256,
            None,
            &lock,
            &|| Ok(()),
        )
        .unwrap();
        // The ordinary Retired path remains fenced between the second rename
        // and the separately durable completion witness.
        assert!(require_no_pending(&candidate, &run).is_err());
        let completion = Completion {
            version: 1,
            intent_sha256: digest(&raw(&intent_path(&root), LIMIT).unwrap()),
            retirement_sha256: digest(
                &raw(
                    &retirement_path(&root, &intent.selection.publisher.owner_sha256),
                    LIMIT,
                )
                .unwrap(),
            ),
            lock: lock.identity().unwrap(),
        };
        state::write(&completion_path(&root), &completion).unwrap();
        require_no_pending(&candidate, &run).unwrap();
        drop(lock);
        let retired = foreground::transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .unwrap();
        retired
            .verify_recovery(
                &candidate,
                &run,
                &intent.selection.publisher.owner_sha256,
                &intent.selection.receipt_sha256,
            )
            .unwrap();
        drop(retired);
        foreground::transport::fixture_next_publication(&candidate, &run);
        require_no_pending(&candidate, &run).unwrap();
        // Changed bytes cannot turn a prior completion into current authority.
        let mut changed = completion;
        changed.retirement_sha256 = "0".repeat(64);
        fs::write(
            completion_path(&root),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(require_no_pending(&candidate, &run).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_lock_recovers_exact_temp_and_hardlink_crashes() {
        for stage in ["temp", "linked", "final"] {
            let (_fixture, candidate, run, root, intent) = abandoned();
            state::write(&intent_path(&root), &intent).unwrap();
            let temp = root.join(temp_name(&intent.selection_sha256));
            let target = root.join("operation.lock");
            if stage != "final" {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temp)
                    .unwrap();
                file.write_all(&marker(&intent.selection_sha256, &intent.nonce))
                    .unwrap();
                file.sync_all().unwrap();
                sync(&root).unwrap();
                if stage == "linked" {
                    fs::hard_link(&temp, &target).unwrap();
                    sync(&root).unwrap();
                }
            } else {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&target)
                    .unwrap();
                file.write_all(&marker(&intent.selection_sha256, &intent.nonce))
                    .unwrap();
                file.sync_all().unwrap();
            }
            let lock = replacement_lock(&root, &intent)
                .unwrap_or_else(|error| panic!("{stage}: {error:?}"));
            exact_marker(&root, &intent, &lock).unwrap();
            assert!(absent(&temp).unwrap());
            assert_eq!(id(&target).unwrap(), lock.identity().unwrap());
            drop(lock);
            fs::remove_dir_all(root).unwrap();
            drop((candidate, run));
        }
    }

    #[test]
    fn replacement_lock_preserves_foreign_names_and_malformed_intent() {
        let (_fixture, candidate, run, root, mut intent) = abandoned();
        let temp = root.join(temp_name(&intent.selection_sha256));
        std::os::unix::fs::symlink("/tmp/foreign", &temp).unwrap();
        assert!(replacement_lock(&root, &intent).is_err());
        assert!(
            fs::symlink_metadata(&temp)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_file(&temp).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .unwrap();
        file.write_all(b"foreign marker").unwrap();
        file.sync_all().unwrap();
        assert!(replacement_lock(&root, &intent).is_err());
        assert_eq!(fs::read(&temp).unwrap(), b"foreign marker");
        fs::remove_file(&temp).unwrap();
        intent.selection.publisher.owner_sha256 = "bad".into();
        intent.selection_sha256 = intent.selection.sha256().unwrap();
        intent.marker_sha256 = digest(&marker(&intent.selection_sha256, &intent.nonce));
        state::write(&intent_path(&root), &intent).unwrap();
        assert!(require_no_pending(&candidate, &run).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn initial_selection_refuses_foreign_completion_pending_without_effects() {
        let (_fixture, _candidate, _run, root, _intent) = abandoned();
        let pending = completion_path(&root).with_extension("pending");
        let original_owner = fs::read(root.join("owner.json")).unwrap();
        let original_socket = id(&root.join("control.sock")).unwrap();
        let foreign = b"foreign interrupted completion";
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&pending)
            .unwrap();
        file.write_all(foreign).unwrap();
        file.sync_all().unwrap();
        assert!(initial_publication_clear(&root).is_err());
        assert_eq!(fs::read(&pending).unwrap(), foreign);
        assert_eq!(fs::read(root.join("owner.json")).unwrap(), original_owner);
        assert_eq!(id(&root.join("control.sock")).unwrap(), original_socket);
        assert!(absent(&root.join("operation.lock")).unwrap());
        assert!(absent(&intent_path(&root)).unwrap());
        assert!(absent(&retirement_path(&root, &digest(&original_owner))).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_lock_path_substitution_refuses_with_both_inodes_preserved() {
        let (_fixture, _candidate, _run, root, intent) = abandoned();
        state::write(&intent_path(&root), &intent).unwrap();
        let held = replacement_lock(&root, &intent).unwrap();
        let original = root.join("original-held.lock");
        fs::rename(root.join("operation.lock"), &original).unwrap();
        let replacement = state::Lock::acquire(&root).unwrap();
        assert_ne!(held.identity().unwrap(), replacement.identity().unwrap());
        assert!(exact_marker(&root, &intent, &held).is_err());
        assert_eq!(
            fs::read(&original).unwrap(),
            marker(&intent.selection_sha256, &intent.nonce)
        );
        assert!(root.join("operation.lock").exists());
        drop((held, replacement));
        fs::remove_dir_all(root).unwrap();
    }
}
