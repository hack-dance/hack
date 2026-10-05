//! Retire only the dead relay-control publication from one acknowledged graph.
//! The confirmed coordinator record is proof of cleanup, not permission to
//! adopt a later publication under the same run-scoped control root.
use super::*;
use crate::provider::{
    identity::ProcessIdentity,
    relay_owner::{
        lifecycle_intent::{Inspection, Phase},
        publication::dead,
    },
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

const PREFIX: &str = "acknowledged-relay-retirement-";
const LIMIT: u64 = 16 * 1024;

fn refused() -> CandidateError {
    error(
        "graph_acknowledged_relay_retirement",
        "Selected relay-control retirement changed or is incomplete; publication evidence was preserved.",
    )
}
fn raw(path: &Path) -> Result<Vec<u8>, CandidateError> {
    host_pin_recovery::read_raw(path, LIMIT).map_err(|_| refused())
}
fn receipt_digest(root: &Path) -> Result<String, CandidateError> {
    Ok(digest(
        &host_pin_recovery::read_raw(&root.join("state.json"), super::LIMIT)
            .map_err(|_| refused())?,
    ))
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn intent_path(root: &Path, publisher: &str) -> PathBuf {
    root.join(format!("{PREFIX}{publisher}-intent.json"))
}
fn complete_path(root: &Path, publisher: &str) -> PathBuf {
    root.join(format!("{PREFIX}{publisher}-complete.json"))
}
fn pending_name(path: &Path) -> Result<&str, CandidateError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(refused)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    candidate: PathBuf,
    run: String,
    owner: String,
    receipt_sha256: String,
    publisher_sha256: String,
    host_boot_micros: u64,
    guest_boot: String,
    control_root: PathBuf,
    control_lock: (u64, u64),
    lifecycle_fingerprint: String,
    process: ProcessIdentity,
    selection: dead::Selection,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u8,
    intent_sha256: String,
    selection_sha256: String,
}

pub(super) struct RetireOptions<'a, 'g> {
    pub candidate: &'a Candidate,
    pub engine: &'a Engine<'g>,
    pub receipt: &'a Receipt,
    pub graph_root: &'a Path,
    pub publisher: &'a foreground::transport::LegacyPublisher,
    pub verify: &'a dyn Fn() -> Result<(), CandidateError>,
}

fn exact_acknowledged_selection(
    inspected: &Inspection,
    marker: &cleanup_enrollment::RelayCleanup,
    context: crate::provider::relay_owner::Context,
    run: &str,
    process: &ProcessIdentity,
) -> bool {
    inspected.phase == Phase::Confirmed
        && !inspected.acknowledgement_pending
        && inspected.selection.context == context
        && inspected.selection.operation == marker.operation
        && inspected.selection.effect == marker.effect
        && host_relay::graph_scope(context, run).is_ok_and(|scope| inspected.graph == Some(scope))
        && &inspected.process == process
}

fn exact_publication(inspected: &Inspection, owner: [u8; 16], publication: [u8; 32]) -> bool {
    inspected.owner == owner && inspected.publication == publication
}

fn current_ack(options: &RetireOptions<'_, '_>) -> Result<Inspection, CandidateError> {
    let marker = options.receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    let startup = options.receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&options.receipt.owner, options.engine.guest().boot_id())
        .map_err(|_| refused())?;
    if options.receipt.phase != "stopped-data-retained"
        || !marker.valid()
        || marker.phase != cleanup_enrollment::Phase::Confirmed
        || marker.runtime != context.runtime
        || marker.boot != context.boot
        || marker.control_root != startup.control_root
    {
        return Err(refused());
    }
    let inspected = Inspection::load(&startup.control_root, context).map_err(|_| refused())?;
    if !exact_acknowledged_selection(
        &inspected,
        marker,
        context,
        &options.receipt.run,
        &options.publisher.process,
    ) {
        return Err(refused());
    }
    Ok(inspected)
}

/// Reporting an acknowledged publisher as fully retired also requires its
/// current relay-control names to be gone. This grants no cleanup authority.
pub(super) fn require_retired(
    receipt: &Receipt,
    engine: &Engine<'_>,
) -> Result<(), CandidateError> {
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    let context =
        host_relay::context(&receipt.owner, engine.guest().boot_id()).map_err(|_| refused())?;
    let inspected = Inspection::load(&startup.control_root, context).map_err(|_| refused())?;
    if inspected.phase != Phase::Confirmed
        || inspected.acknowledgement_pending
        || inspected.selection.operation != marker.operation
        || inspected.selection.effect != marker.effect
        || inspected.graph
            != Some(host_relay::graph_scope(context, &receipt.run).map_err(|_| refused())?)
    {
        return Err(refused());
    }
    let witness = dead::CleanupWitness::acquire(&startup.control_root, context, &inspected.process)
        .map_err(|_| refused())?;
    witness.verify().map_err(|_| refused())?;
    if witness.present_selection().is_some() {
        return Err(refused());
    }
    Ok(())
}

fn validate_selected(
    options: &RetireOptions<'_, '_>,
    intent: &Intent,
) -> Result<(), CandidateError> {
    let startup = options.receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&options.receipt.owner, options.engine.guest().boot_id())
        .map_err(|_| refused())?;
    let inspected = current_ack(options)?;
    let (process, owner, publication) = intent
        .selection
        .identity(&startup.control_root, context)
        .map_err(|_| refused())?;
    if intent.version != 1
        || intent.candidate != options.candidate.checkout
        || intent.run != options.receipt.run
        || intent.owner != options.receipt.owner
        || intent.receipt_sha256 != receipt_digest(options.graph_root)?
        || intent.publisher_sha256 != options.publisher.owner_sha256
        || intent.host_boot_micros
            != crate::provider::host_filesystem::host_boot_micros().map_err(|_| refused())?
        || intent.guest_boot != options.engine.guest().boot_id()
        || intent.control_root != startup.control_root
        || intent.lifecycle_fingerprint != inspected.recovery_fingerprint
        || intent.process != options.publisher.process
        || process != intent.process
        || !exact_publication(&inspected, owner, publication)
        || intent.control_lock.1 == 0
    {
        return Err(refused());
    }
    Ok(())
}

fn completed(root: &Path, intent_bytes: &[u8], intent: &Intent) -> Result<bool, CandidateError> {
    let path = complete_path(root, &intent.publisher_sha256);
    if !absent(&path.with_extension("pending"))? && !absent(&path)? {
        return Err(refused());
    }
    if absent(&path)? {
        return Ok(false);
    }
    let complete: Completion = serde_json::from_slice(&raw(&path)?).map_err(|_| refused())?;
    let selection_sha256 = digest(&serde_json::to_vec(&intent.selection).map_err(|_| refused())?);
    if complete.version != 1
        || complete.intent_sha256 != digest(intent_bytes)
        || complete.selection_sha256 != selection_sha256
    {
        return Err(refused());
    }
    Ok(true)
}

/// Ordinary admission may use this historical completion only as a barrier
/// check. It grants no authority over a later relay-control generation.
pub(in crate::provider::graph) fn require_complete(
    candidate: &Candidate,
    run: &str,
) -> Result<(), CandidateError> {
    let root = directory(candidate, run).map_err(|_| refused())?;
    if absent(&root)? {
        return Ok(());
    }
    state::check_private_directory(&root).map_err(|_| refused())?;
    let mut keys = BTreeSet::new();
    for entry in fs::read_dir(&root).map_err(|_| refused())? {
        let entry = entry.map_err(|_| refused())?;
        let name = entry.file_name().into_string().map_err(|_| refused())?;
        let Some(rest) = name.strip_prefix(PREFIX) else {
            continue;
        };
        let (publisher, suffix) = rest.split_once('-').ok_or_else(refused)?;
        if !hex(publisher, 64) || !["intent.json", "complete.json"].contains(&suffix) {
            return Err(refused());
        }
        keys.insert(publisher.to_owned());
    }
    for publisher in keys {
        let bytes = raw(&intent_path(&root, &publisher))?;
        let intent: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if intent.version != 1
            || intent.candidate != candidate.checkout
            || intent.run != run
            || !hex(&intent.receipt_sha256, 64)
            || intent.publisher_sha256 != publisher
            || !completed(&root, &bytes, &intent)?
        {
            return Err(refused());
        }
    }
    Ok(())
}

/// Historical completion for one explicitly selected old foreground publisher.
/// This proves only that our selected relay names were retired earlier; it never
/// selects or deletes names now published by a later generation.
pub(super) fn selected_complete(
    candidate: &Candidate,
    root: &Path,
    run: &str,
    receipt_sha256: &str,
    publisher_sha256: &str,
) -> Result<bool, CandidateError> {
    let path = intent_path(root, publisher_sha256);
    if absent(&path)? {
        return Ok(false);
    }
    let bytes = raw(&path)?;
    let intent: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if intent.version != 1
        || intent.candidate != candidate.checkout
        || intent.run != run
        || intent.receipt_sha256 != receipt_sha256
        || intent.publisher_sha256 != publisher_sha256
    {
        return Err(refused());
    }
    completed(root, &bytes, &intent)
}

fn publish_completion(root: &Path, path: &Path, value: &Completion) -> Result<(), CandidateError> {
    if !absent(path)? {
        return Err(refused());
    }
    let pending = path.with_extension("pending");
    if !absent(&pending)? {
        let bytes = raw(&pending)?;
        if bytes != serde_json::to_vec_pretty(value).map_err(|_| refused())? {
            return Err(refused());
        }
        journal::retain_file(
            root,
            pending_name(&pending)?,
            "relay-retirement-complete-interrupted",
            LIMIT,
        )
        .map_err(|_| refused())?;
    }
    state::write(path, value).map_err(|_| refused())
}

/// Caller holds the selected foreground lock and Engine lease. The callback
/// repeats its full acknowledged-cleanup proof at every relay pathname effect.
pub(super) fn retire(options: RetireOptions<'_, '_>) -> Result<(), CandidateError> {
    (options.verify)()?;
    let inspected = current_ack(&options)?;
    let startup = options.receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&options.receipt.owner, options.engine.guest().boot_id())
        .map_err(|_| refused())?;
    let path = intent_path(options.graph_root, &options.publisher.owner_sha256);
    let complete_path = complete_path(options.graph_root, &options.publisher.owner_sha256);
    let pending = path.with_extension("pending");
    if absent(&path)? {
        if !absent(&complete_path)? || !absent(&complete_path.with_extension("pending"))? {
            return Err(refused());
        }
        let witness = dead::CleanupWitness::acquire(
            &startup.control_root,
            context,
            &options.publisher.process,
        )
        .map_err(|_| refused())?;
        witness.verify().map_err(|_| refused())?;
        let Some(selection) = witness.present_selection() else {
            // Clean owner Drop already retired both names. There is no effect
            // and no new historical authority to record.
            return if absent(&pending)? {
                Ok(())
            } else {
                Err(refused())
            };
        };
        if witness
            .present_identity()
            .is_none_or(|(owner, publication)| !exact_publication(&inspected, owner, publication))
        {
            return Err(refused());
        }
        let value = Intent {
            version: 1,
            candidate: options.candidate.checkout.clone(),
            run: options.receipt.run.clone(),
            owner: options.receipt.owner.clone(),
            receipt_sha256: receipt_digest(options.graph_root)?,
            publisher_sha256: options.publisher.owner_sha256.clone(),
            host_boot_micros: crate::provider::host_filesystem::host_boot_micros()
                .map_err(|_| refused())?,
            guest_boot: options.engine.guest().boot_id().into(),
            control_root: startup.control_root.clone(),
            control_lock: witness.lock_identity().map_err(|_| refused())?,
            lifecycle_fingerprint: inspected.recovery_fingerprint,
            process: options.publisher.process.clone(),
            selection,
        };
        drop(witness);
        validate_selected(&options, &value)?;
        if !absent(&pending)? {
            let bytes = raw(&pending)?;
            if bytes != serde_json::to_vec_pretty(&value).map_err(|_| refused())? {
                return Err(refused());
            }
            (options.verify)()?;
            journal::retain_file(
                options.graph_root,
                pending_name(&pending)?,
                "relay-retirement-intent-interrupted",
                LIMIT,
            )
            .map_err(|_| refused())?;
        }
        (options.verify)()?;
        state::write(&path, &value).map_err(|_| refused())?;
    } else if !absent(&pending)? {
        return Err(refused());
    }
    let intent_bytes = raw(&path)?;
    let intent: Intent = serde_json::from_slice(&intent_bytes).map_err(|_| refused())?;
    validate_selected(&options, &intent)?;
    if completed(options.graph_root, &intent_bytes, &intent)? {
        return Ok(());
    }
    let check = || {
        (options.verify)()?;
        validate_selected(&options, &intent)
    };
    dead::retire_checked(
        &intent.control_root,
        context,
        &intent.selection,
        Some(intent.control_lock),
        &check,
    )
    .map_err(|_| refused())?;
    check()?;
    let completion = Completion {
        version: 1,
        intent_sha256: digest(&intent_bytes),
        selection_sha256: digest(&serde_json::to_vec(&intent.selection).map_err(|_| refused())?),
    };
    publish_completion(options.graph_root, &complete_path, &completion)?;
    require_complete(options.candidate, &options.receipt.run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::relay_owner::lifecycle_intent::Selection as LifecycleSelection;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (
        super::super::super::tests::Fixture,
        Candidate,
        String,
        PathBuf,
    ) {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let run = "a".repeat(32);
        let root = directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        (fixture, candidate, run, root)
    }

    fn selected(candidate: &Candidate, run: &str, publisher: &str) -> Intent {
        Intent {
            version: 1,
            candidate: candidate.checkout.clone(),
            run: run.into(),
            owner: "b".repeat(32),
            receipt_sha256: "c".repeat(64),
            publisher_sha256: publisher.into(),
            host_boot_micros: 1,
            guest_boot: "fixture-boot".into(),
            control_root: candidate.checkout.join("relay"),
            control_lock: (1, 2),
            lifecycle_fingerprint: "d".repeat(64),
            process: crate::provider::identity::observe(std::process::id() as i32).unwrap(),
            selection: serde_json::from_value(json!({"bytes":[1],"record_id":[1,2]})).unwrap(),
        }
    }

    fn completion(root: &Path, intent: &Intent) -> Completion {
        Completion {
            version: 1,
            intent_sha256: digest(&raw(&intent_path(root, &intent.publisher_sha256)).unwrap()),
            selection_sha256: digest(&serde_json::to_vec(&intent.selection).unwrap()),
        }
    }

    fn private_pending(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn every_publisher_generation_requires_its_own_complete_pair() {
        let (_fixture, candidate, run, root) = fixture();
        let first = selected(&candidate, &run, &"1".repeat(64));
        state::write(&intent_path(&root, &first.publisher_sha256), &first).unwrap();
        assert!(require_complete(&candidate, &run).is_err());
        let first_completion = completion(&root, &first);
        state::write(
            &complete_path(&root, &first.publisher_sha256),
            &first_completion,
        )
        .unwrap();
        require_complete(&candidate, &run).unwrap();
        let second = selected(&candidate, &run, &"2".repeat(64));
        state::write(&intent_path(&root, &second.publisher_sha256), &second).unwrap();
        assert!(require_complete(&candidate, &run).is_err());
        let second_completion = completion(&root, &second);
        state::write(
            &complete_path(&root, &second.publisher_sha256),
            &second_completion,
        )
        .unwrap();
        require_complete(&candidate, &run).unwrap();
        assert!(
            selected_complete(
                &candidate,
                &root,
                &run,
                &first.receipt_sha256,
                &first.publisher_sha256
            )
            .unwrap()
        );
        assert!(
            selected_complete(
                &candidate,
                &root,
                &run,
                &"e".repeat(64),
                &first.publisher_sha256
            )
            .is_err()
        );
        let pending = intent_path(&root, &second.publisher_sha256).with_extension("pending");
        private_pending(&pending, b"foreign");
        assert!(require_complete(&candidate, &run).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"foreign");
    }

    #[test]
    fn exact_completion_pending_is_retained_but_foreign_pending_refuses() {
        let (_fixture, candidate, run, root) = fixture();
        let intent = selected(&candidate, &run, &"3".repeat(64));
        state::write(&intent_path(&root, &intent.publisher_sha256), &intent).unwrap();
        let value = completion(&root, &intent);
        let path = complete_path(&root, &intent.publisher_sha256);
        let pending = path.with_extension("pending");
        private_pending(&pending, b"foreign");
        assert!(publish_completion(&root, &path, &value).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"foreign");
        private_pending(&pending, &serde_json::to_vec_pretty(&value).unwrap());
        assert!(require_complete(&candidate, &run).is_err());
        publish_completion(&root, &path, &value).unwrap();
        require_complete(&candidate, &run).unwrap();
        assert!(!pending.exists());
        assert!(
            root.join("relay-retirement-complete-interrupted-1/interrupted.pending")
                .is_file()
        );
    }

    #[test]
    fn graph_receipt_digest_uses_full_graph_limit() {
        let (_fixture, _candidate, _run, root) = fixture();
        let bytes = vec![b'x'; (LIMIT + 1) as usize];
        private_pending(&root.join("state.json"), &bytes);
        assert_eq!(receipt_digest(&root).unwrap(), digest(&bytes));
    }

    #[test]
    fn exact_ack_refuses_rollover_and_foreign_publisher_identity() {
        let (_fixture, _candidate, run, root) = fixture();
        let publication = root.join("selected-publication");
        fs::write(&publication, b"unchanged").unwrap();
        let context = host_relay::context(&"b".repeat(32), "fixture-boot").unwrap();
        let lifecycle = LifecycleSelection {
            context,
            operation: [3; 16],
            effect: [4; 32],
        };
        let mut marker = cleanup_enrollment::RelayCleanup::new(&root, &lifecycle).unwrap();
        marker.phase = cleanup_enrollment::Phase::Confirmed;
        let process = crate::provider::identity::observe(std::process::id() as i32).unwrap();
        let mut inspected = Inspection {
            selection: lifecycle,
            phase: Phase::Confirmed,
            targets: Vec::new(),
            graph: Some(host_relay::graph_scope(context, &run).unwrap()),
            selection_observed: true,
            acknowledgement_pending: false,
            owner: [5; 16],
            process: process.clone(),
            publication: [6; 32],
            recovery_fingerprint: "7".repeat(64),
        };
        let exact = |inspected: &Inspection, marker: &cleanup_enrollment::RelayCleanup| {
            exact_acknowledged_selection(inspected, marker, context, &run, &process)
                && exact_publication(inspected, [5; 16], [6; 32])
        };
        assert!(exact(&inspected, &marker));
        marker.operation = [8; 16];
        assert!(!exact(&inspected, &marker));
        marker.operation = [3; 16];
        marker.effect = [8; 32];
        assert!(!exact(&inspected, &marker));
        marker.effect = [4; 32];
        inspected.selection.operation = [8; 16];
        assert!(!exact(&inspected, &marker));
        inspected.selection = LifecycleSelection {
            context,
            operation: [3; 16],
            effect: [4; 32],
        };
        inspected.acknowledgement_pending = true;
        assert!(!exact(&inspected, &marker));
        inspected.acknowledgement_pending = false;
        inspected.process.start_micros += 1;
        assert!(!exact(&inspected, &marker));
        inspected.process = process.clone();
        inspected.owner = [8; 16];
        assert!(!exact(&inspected, &marker));
        inspected.owner = [5; 16];
        inspected.publication = [8; 32];
        assert!(!exact(&inspected, &marker));
        assert_eq!(fs::read(&publication).unwrap(), b"unchanged");
    }
}
