//! Immutable, value-free allocation intent. Recovery grants cleanup, never renewed delivery.
mod retention;
use super::{environment::EnvironmentLease, lifecycle::OwnedGuest, state};
use crate::{Candidate, CandidateError};
pub use retention::{RetiredExport, export_retired};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GraphBinding {
    pub run: String,
    pub container: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<GraphBinding>,
    service: String,
    #[serde(default, skip_serializing_if = "zero")]
    uid: u32,
    #[serde(default, skip_serializing_if = "zero")]
    gid: u32,
    slot: String,
    incarnation: String,
    boot: String,
}
fn zero(value: &u32) -> bool {
    *value == 0
}
fn error() -> CandidateError {
    CandidateError::new(
        "environment_recovery",
        "Environment cleanup requires valid, matching allocation intent; no values are restored.",
    )
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/environment-leases")
}
fn valid_slot(slot: &str) -> bool {
    let Some(rest) = slot.strip_prefix("hack-env-lease-") else {
        return false;
    };
    rest.is_ascii()
        && rest.len() == 69
        && uuid(&rest[..36])
        && rest.as_bytes()[36] == b'-'
        && hex(&rest[37..], 32)
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn validate(intent: &Intent, slot: &str) -> Result<(), CandidateError> {
    if intent.version != 1
        || intent.slot != slot
        || !valid_slot(slot)
        || !uuid(&intent.boot)
        || !slot.starts_with(&format!("hack-env-lease-{}-", intent.boot))
        || !hex(&intent.incarnation, 32)
        || intent.graph.as_ref().is_some_and(|g| {
            !hex(&g.run, 32)
                || !g
                    .container
                    .strip_prefix(&format!("hkg-{}-container-", g.run))
                    .is_some_and(|n| {
                        !n.is_empty() && n.len() <= 2 && n.bytes().all(|b| b.is_ascii_digit())
                    })
        })
        || !super::environment::name(&intent.service)
    {
        return Err(error());
    }
    Ok(())
}
const MAX_INTENT_ENTRIES: usize = 4096;

/// Retired and uncertain entries still reserve history capacity. This never removes evidence.
pub(super) fn preflight_records(
    candidate: &Candidate,
    requested: usize,
) -> Result<(), CandidateError> {
    if requested == 0 || requested > MAX_INTENT_ENTRIES {
        return Err(error());
    }
    let directory = root(candidate);
    crate::reject_aliased_state(&directory)?;
    if !directory.try_exists().map_err(state::io)? {
        return Ok(());
    }
    state::check_private_directory(&directory)?;
    let available = MAX_INTENT_ENTRIES - requested;
    for (index, entry) in fs::read_dir(&directory).map_err(state::io)?.enumerate() {
        entry.map_err(state::io)?;
        if index >= available {
            return Err(error());
        }
    }
    Ok(())
}

pub(super) fn record(
    candidate: &Candidate,
    lease: &EnvironmentLease,
) -> Result<(), CandidateError> {
    if retention::reserved(candidate, &lease.slot)? {
        return Err(error());
    }
    let directory = root(candidate);
    state::private_directory(&directory)?;
    preflight_records(candidate, 1)?;
    let intent = Intent {
        version: 1,
        graph: lease.graph.clone(),
        service: lease.service.clone(),
        uid: lease.uid,
        gid: lease.gid,
        slot: lease.slot.clone(),
        incarnation: lease.incarnation.clone(),
        boot: lease.boot.clone(),
    };
    validate(&intent, &lease.slot)?;
    let path = directory.join(format!("{}.json", lease.slot));
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(error()),
    }
    state::write(&path, &intent)
}
fn read(
    candidate: &Candidate,
    slot: &str,
    incarnation: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<Intent, CandidateError> {
    read_mode(candidate, slot, incarnation, lease, true)
}
fn read_mode(
    candidate: &Candidate,
    slot: &str,
    incarnation: &str,
    lease: Option<&EnvironmentLease>,
    promote: bool,
) -> Result<Intent, CandidateError> {
    if !valid_slot(slot) {
        return Err(error());
    }
    let directory = root(candidate);
    state::check_private_directory(&directory)?;
    let path = directory.join(format!("{slot}.json"));
    let pending = path.with_extension("pending");
    let present = |path: &std::path::Path| match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    };
    let committed = present(&path)?;
    let has_pending = present(&pending)?;
    if committed && has_pending {
        return Err(error());
    }
    let intent: Intent = state::read_bounded(if has_pending { &pending } else { &path }, 2048)?;
    validate(&intent, slot)?;
    if intent.incarnation != incarnation {
        return Err(error());
    }
    if let Some(lease) = lease {
        if lease.uid != intent.uid
            || lease.gid != intent.gid
            || lease.graph != intent.graph
            || lease.service != intent.service
            || lease.boot != intent.boot
            || lease.incarnation != intent.incarnation
        {
            return Err(error());
        }
    }
    // Promote only a complete, validated initial intent. Never delete retained pending state.
    if has_pending && promote {
        fs::rename(&pending, &path).map_err(state::io)?;
        fs::File::open(&directory)
            .and_then(|f| f.sync_all())
            .map_err(state::io)?;
    }
    Ok(intent)
}
/// Lists intent-file IDs, including retired slots. Contents are validated when retiring; this is
/// neither a live-lease inventory nor authorization to automatically retire every entry.
pub fn recorded_slots(candidate: &Candidate) -> Result<Vec<String>, CandidateError> {
    let directory = root(candidate);
    crate::reject_aliased_state(&directory)?;
    if !directory.try_exists().map_err(state::io)? {
        return Ok(Vec::new());
    }
    state::check_private_directory(&directory)?;
    let mut slots = std::collections::BTreeSet::new();
    for (index, entry) in fs::read_dir(directory).map_err(state::io)?.enumerate() {
        if index >= 4096 {
            return Err(error());
        }
        let name = entry
            .map_err(state::io)?
            .file_name()
            .into_string()
            .map_err(|_| error())?;
        let slot = name
            .strip_suffix(".json")
            .or_else(|| name.strip_suffix(".pending"))
            .ok_or_else(error)?;
        if !valid_slot(slot) {
            return Err(error());
        }
        slots.insert(slot.into());
    }
    Ok(slots.into_iter().collect())
}
/// Validates immutable records before associating them with graph cleanup.
pub(super) fn graph_slots(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    run: &str,
) -> Result<Vec<(String, String, GraphBinding)>, CandidateError> {
    let mut bindings = Vec::new();
    for slot in recorded_slots(candidate)? {
        let intent = read_mode(candidate, &slot, guest.incarnation(), None, false)?;
        if let Some(binding) = intent.graph {
            if binding.run == run {
                bindings.push((slot, intent.service, binding));
            }
        }
    }
    Ok(bindings)
}
/// Delivery authority for exec, unlike cleanup inventory: only a committed,
/// current-boot, unique service allocation may be reused. The caller holds the
/// guest lease and still verifies the exact container's read-only mounts.
pub(super) fn active_exec_slot(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    run: &str,
    service: &str,
    container: &str,
) -> Result<Option<String>, CandidateError> {
    active_exec_slot_for(
        candidate,
        guest.incarnation(),
        guest.boot_id(),
        run,
        service,
        container,
    )
}
fn active_exec_slot_for(
    candidate: &Candidate,
    incarnation: &str,
    boot: &str,
    run: &str,
    service: &str,
    container: &str,
) -> Result<Option<String>, CandidateError> {
    if !hex(run, 32) || !hex(incarnation, 32) || !uuid(boot) || !super::environment::name(service) {
        return Err(error());
    }
    let mut selected = None;
    for slot in recorded_slots(candidate)? {
        let intent = read_mode(candidate, &slot, incarnation, None, false)?;
        let Some(binding) = &intent.graph else {
            continue;
        };
        if binding.run != run || intent.service != service {
            continue;
        }
        let pending = root(candidate).join(format!("{slot}.pending"));
        match fs::symlink_metadata(pending) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(error()),
        }
        if intent.boot != boot
            || binding.container != container
            || retention::reserved(candidate, &slot)?
            || selected.replace(slot).is_some()
        {
            return Err(error());
        }
    }
    Ok(selected)
}

/// Canonical value-free identities, independent of active/archive file placement.
#[cfg(target_os = "macos")]
#[derive(Clone, PartialEq, Eq, Serialize)]
pub(super) struct GraphInventory {
    run: String,
    incarnation: String,
    intents: Vec<Intent>,
}

#[cfg(target_os = "macos")]
impl GraphInventory {
    pub(super) fn is_empty(&self) -> bool {
        self.intents.is_empty()
    }
}

#[cfg(target_os = "macos")]
pub(super) fn graph_inventory(
    candidate: &Candidate,
    incarnation: &str,
    run: &str,
    containers: &std::collections::BTreeMap<String, String>,
    archive: &std::path::Path,
) -> Result<GraphInventory, CandidateError> {
    if !hex(run, 32) || !hex(incarnation, 32) {
        return Err(error());
    }
    let mut selected = std::collections::BTreeMap::new();
    let mut insert = |intent: Intent| -> Result<(), CandidateError> {
        validate(&intent, &intent.slot)?;
        if intent.incarnation != incarnation
            || !intent.graph.as_ref().is_some_and(|g| {
                g.run == run && containers.get(&intent.service) == Some(&g.container)
            })
            || retention::reserved(candidate, &intent.slot)?
            || selected.len() >= 72
            || selected.insert(intent.slot.clone(), intent).is_some()
        {
            return Err(error());
        }
        Ok(())
    };
    for slot in recorded_slots(candidate)? {
        let intent = read_mode(candidate, &slot, incarnation, None, false)?;
        if intent.graph.as_ref().is_some_and(|g| g.run == run) {
            insert(intent)?;
        }
    }
    crate::reject_aliased_state(archive)?;
    match fs::symlink_metadata(archive) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(state::io(e)),
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(error());
            }
            state::check_private_directory(archive)?;
            for (index, entry) in fs::read_dir(archive).map_err(state::io)?.enumerate() {
                if index >= 72 {
                    return Err(error());
                }
                let entry = entry.map_err(state::io)?;
                let name = entry.file_name().into_string().map_err(|_| error())?;
                let slot = name.strip_suffix(".json").ok_or_else(error)?;
                let intent: Intent = state::read_bounded(&entry.path(), 2048)?;
                if intent.slot != slot {
                    return Err(error());
                }
                insert(intent)?;
            }
        }
    }
    Ok(GraphInventory {
        run: run.into(),
        incarnation: incarnation.into(),
        intents: selected.into_values().collect(),
    })
}

#[cfg(target_os = "macos")]
pub(super) fn verify_graph_retired(
    guest: &OwnedGuest<'_>,
    inventory: &GraphInventory,
) -> Result<(), CandidateError> {
    if inventory.incarnation != guest.incarnation() {
        return Err(error());
    }
    for intent in &inventory.intents {
        let binding = intent.graph.as_ref().ok_or_else(error)?;
        super::engine::require_container_absent(guest, &binding.container)?;
        retention::absent(guest, &intent.slot)?;
    }
    guest.verify()?;
    Ok(())
}

/// Move retired, value-free intents into a removed graph's retained evidence. The graph ID
/// stays reserved by its active/archive directory, then by the verified-prune consumed record.
/// A rename interrupted before final graph archival is recovered by validating both inventories.
pub(super) fn archive_graph(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    run: &str,
    containers: &std::collections::BTreeMap<String, String>,
    directory: &std::path::Path,
) -> Result<(), CandidateError> {
    state::private_directory(directory)?;
    let matches = |intent: &Intent| -> Result<(), CandidateError> {
        validate(intent, &intent.slot)?;
        if intent.incarnation != guest.incarnation()
            || !intent.graph.as_ref().is_some_and(|binding| {
                binding.run == run && containers.get(&intent.service) == Some(&binding.container)
            })
        {
            return Err(error());
        }
        Ok(())
    };
    let mut archived = std::collections::BTreeMap::new();
    for (index, entry) in fs::read_dir(directory).map_err(state::io)?.enumerate() {
        if index >= 72 {
            return Err(error());
        }
        let entry = entry.map_err(state::io)?;
        let name = entry.file_name().into_string().map_err(|_| error())?;
        let slot = name.strip_suffix(".json").ok_or_else(error)?;
        let intent: Intent = state::read_bounded(&entry.path(), 2048)?;
        matches(&intent)?;
        if slot != intent.slot || archived.insert(intent.slot.clone(), intent).is_some() {
            return Err(error());
        }
    }
    let mut active = Vec::new();
    for (slot, _, _) in graph_slots(candidate, guest, run)? {
        let intent = read_mode(candidate, &slot, guest.incarnation(), None, false)?;
        matches(&intent)?;
        if archived.contains_key(&slot) || active.len() + archived.len() >= 72 {
            return Err(error());
        }
        active.push(intent);
    }
    // Validate the complete inventory before retirement or movement. Reinspection precedes every
    // retry; moved records are never interpreted as renewed delivery authority.
    for intent in archived.values().chain(active.iter()) {
        retire_intent(guest, intent)?;
    }
    for intent in active {
        let slot = &intent.slot;
        read(candidate, slot, guest.incarnation(), None)?; // Promote only a complete retained intent.
        let source = root(candidate).join(format!("{slot}.json"));
        let target = directory.join(format!("{slot}.json"));
        if target.symlink_metadata().is_ok() {
            return Err(error());
        }
        fs::rename(&source, &target).map_err(state::io)?;
        for parent in [directory, root(candidate).as_path()] {
            fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(state::io)?;
        }
        #[cfg(test)]
        super::graph::fault_pause(
            directory.parent().expect("graph evidence"),
            run,
            "archive-after-environment-move",
        )?;
    }
    Ok(())
}

/// Explicitly retires a recorded allocation. It may still be live: the caller must own its lifecycle.
/// Same-boot partial tmpfs allocations are removable. An older boot permits only absent/empty,
/// unmounted directories. Foreign incarnations, symlinks and unexpected mounts are refused.
pub fn retire_recorded(candidate: &Candidate, slot: &str) -> Result<(), CandidateError> {
    let guest = OwnedGuest::connect_cleanup(candidate)?;
    retire(candidate, &guest, slot, None)
}
pub(super) fn retire(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    slot: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<(), CandidateError> {
    if retention::reserved(candidate, slot)? {
        return retention::verify_retired(candidate, guest, slot, lease);
    }
    let intent = read(candidate, slot, guest.incarnation(), lease)?;
    retire_intent(guest, &intent)
}
fn retire_intent(guest: &OwnedGuest<'_>, intent: &Intent) -> Result<(), CandidateError> {
    let slot = &intent.slot;
    if let Some(binding) = &intent.graph {
        super::engine::require_container_absent(guest, &binding.container)?;
    }
    let mode = if intent.boot == guest.boot_id() {
        "same"
    } else {
        "old"
    };
    let result = guest.execute_cleanup(RETIRE, &[slot, mode])?;
    if result != "environment-removed-v1\n" {
        return Err(error());
    }
    Ok(())
}
const RETIRE: &str = r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
if test ! -e "$root"; then exit 0; fi
test -d "$root"
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
if mountpoint -q "$root"; then
 test "$2" = same
 test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
 test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
 umount "$root"
fi
rmdir "$root"
) >/dev/null 2>&1
printf 'environment-removed-v1\n'
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::fs::OpenOptionsExt,
    };
    struct Fixture(Candidate);
    #[test]
    fn admission_counts_retained_and_uncertain_intents_before_new_records() {
        let fixture = Fixture::new();
        let directory = root(&fixture.0);
        assert!(preflight_records(&fixture.0, 12).is_ok());
        assert!(preflight_records(&fixture.0, 0).is_err());
        for n in 0..4084 {
            fs::write(directory.join(format!("uncertain-{n}.pending")), b"").unwrap();
        }
        assert!(preflight_records(&fixture.0, 12).is_ok());
        fs::write(directory.join("retained.json"), b"").unwrap();
        assert!(preflight_records(&fixture.0, 12).is_err());
        assert!(preflight_records(&fixture.0, 1).is_ok());
        for n in 4085..4096 {
            fs::write(directory.join(format!("uncertain-{n}.pending")), b"").unwrap();
        }
        assert!(preflight_records(&fixture.0, 1).is_err());
        assert_eq!(fs::read_dir(directory).unwrap().count(), 4096);
    }
    #[test]
    fn active_exec_requires_committed_current_unique_exact_service_intent() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        let run = "c".repeat(32);
        let container = format!("hkg-{run}-container-0");
        intent.graph = Some(GraphBinding {
            run: run.clone(),
            container: container.clone(),
        });
        let select = |boot: &str, container: &str| {
            active_exec_slot_for(
                &fixture.0,
                &intent.incarnation,
                boot,
                &run,
                "web",
                container,
            )
        };
        assert_eq!(select(&intent.boot, &container).unwrap(), None);
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        assert!(select(&intent.boot, &container).is_err());
        assert!(pending.exists(), "exec must never promote pending intent");
        let committed = root(&fixture.0).join(format!("{}.json", intent.slot));
        fs::rename(&pending, &committed).unwrap();
        assert_eq!(
            select(&intent.boot, &container).unwrap(),
            Some(intent.slot.clone())
        );
        assert!(select("dddddddd-dddd-4ddd-8ddd-dddddddddddd", &container).is_err());
        assert!(select(&intent.boot, &format!("hkg-{run}-container-1")).is_err());
        let mut second = intent.clone();
        second.slot = format!("hack-env-lease-{}-{}", second.boot, "e".repeat(32));
        state::write(
            &root(&fixture.0).join(format!("{}.json", second.slot)),
            &second,
        )
        .unwrap();
        assert!(select(&intent.boot, &container).is_err());
        fs::remove_file(root(&fixture.0).join(format!("{}.json", second.slot))).unwrap();
        fixture.pending(&bytes, &intent.slot);
        assert!(select(&intent.boot, &container).is_err());
        assert_eq!(fs::read(committed).unwrap(), bytes);
    }
    impl Fixture {
        fn new() -> Self {
            let mut bytes = [0; 16];
            fs::File::open("/dev/urandom")
                .unwrap()
                .read_exact(&mut bytes)
                .unwrap();
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("hack-env-recovery-{token}"));
            state::private_directory(&path).unwrap();
            let candidate = Candidate::discover(&path).unwrap();
            state::private_directory(&root(&candidate)).unwrap();
            Self(candidate)
        }
        fn intent(&self) -> Intent {
            let boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
            Intent {
                version: 1,
                graph: None,
                service: "web".into(),
                uid: 0,
                gid: 0,
                slot: format!("hack-env-lease-{boot}-{}", "a".repeat(32)),
                boot,
                incarnation: "b".repeat(32),
            }
        }
        fn pending(&self, bytes: &[u8], slot: &str) -> PathBuf {
            let path = root(&self.0).join(format!("{slot}.pending"));
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0.checkout).unwrap();
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn graph_inventory_pending_archive_and_disappearance_are_read_only() {
        use std::os::unix::fs::MetadataExt;
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        let run = "a".repeat(32);
        let container = format!("hkg-{run}-container-0");
        intent.graph = Some(GraphBinding {
            run: run.clone(),
            container: container.clone(),
        });
        let containers = std::collections::BTreeMap::from([("web".into(), container)]);
        let archive = fixture.0.state_root.join("graph-environment-archive");
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        let metadata = fs::symlink_metadata(&pending).unwrap();
        let inventory =
            || graph_inventory(&fixture.0, &intent.incarnation, &run, &containers, &archive);
        let first = inventory().unwrap();
        let encoded = serde_json::to_vec(&first).unwrap();
        assert_eq!(fs::read(&pending).unwrap(), bytes);
        let after = fs::symlink_metadata(&pending).unwrap();
        assert_eq!(
            (metadata.ino(), metadata.mtime(), metadata.mtime_nsec()),
            (after.ino(), after.mtime(), after.mtime_nsec())
        );
        assert!(!pending.with_extension("json").exists());
        state::private_directory(&archive).unwrap();
        fs::rename(&pending, archive.join(format!("{}.json", intent.slot))).unwrap();
        assert_eq!(
            serde_json::to_vec(&inventory().unwrap()).unwrap(),
            encoded,
            "moving immutable evidence does not change selection"
        );
        fixture.pending(&bytes, &intent.slot);
        assert!(
            inventory().is_err(),
            "duplicate active/archive identity must refuse"
        );
        fs::remove_file(&pending).unwrap();
        fs::remove_file(archive.join(format!("{}.json", intent.slot))).unwrap();
        assert!(
            inventory().unwrap() != first,
            "lost intent must not compare equal to selected inventory"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn graph_inventory_refuses_ambiguous_pending_and_wrong_binding() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        let run = "a".repeat(32);
        let container = format!("hkg-{run}-container-0");
        intent.graph = Some(GraphBinding {
            run: run.clone(),
            container: container.clone(),
        });
        let containers = std::collections::BTreeMap::from([("web".into(), container)]);
        let archive = fixture.0.state_root.join("graph-environment-archive");
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        fs::copy(&pending, pending.with_extension("json")).unwrap();
        assert!(
            graph_inventory(&fixture.0, &intent.incarnation, &run, &containers, &archive).is_err()
        );
        fs::remove_file(pending.with_extension("json")).unwrap();
        assert!(graph_inventory(&fixture.0, &"c".repeat(32), &run, &containers, &archive).is_err());
        assert!(
            graph_inventory(
                &fixture.0,
                &intent.incarnation,
                &run,
                &std::collections::BTreeMap::new(),
                &archive
            )
            .is_err()
        );
        assert_eq!(fs::read(pending).unwrap(), bytes);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn graph_inventory_bounds_combined_active_and_archived_slots() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        let run = "a".repeat(32);
        let container = format!("hkg-{run}-container-0");
        intent.graph = Some(GraphBinding {
            run: run.clone(),
            container: container.clone(),
        });
        let containers = std::collections::BTreeMap::from([("web".into(), container)]);
        let archive = fixture.0.state_root.join("graph-environment-archive");
        state::private_directory(&archive).unwrap();
        for index in 0..72 {
            intent.slot = format!("hack-env-lease-{}-{index:032x}", intent.boot);
            state::write(&archive.join(format!("{}.json", intent.slot)), &intent).unwrap();
        }
        let inventory =
            graph_inventory(&fixture.0, &intent.incarnation, &run, &containers, &archive).unwrap();
        assert_eq!(inventory.intents.len(), 72);
        assert!(
            inventory
                .intents
                .windows(2)
                .all(|pair| pair[0].slot < pair[1].slot)
        );
        intent.slot = format!("hack-env-lease-{}-{:032x}", intent.boot, 72);
        fixture.pending(&serde_json::to_vec(&intent).unwrap(), &intent.slot);
        assert!(
            graph_inventory(&fixture.0, &intent.incarnation, &run, &containers, &archive).is_err()
        );
    }

    #[test]
    fn graph_binding_requires_its_container_namespace_and_preserves_read_only_inventory() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        let run = "a".repeat(32);
        intent.graph = Some(GraphBinding {
            run: run.clone(),
            container: format!("hkg-{run}-container-0"),
        });
        assert!(validate(&intent, &intent.slot).is_ok());
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        assert!(read_mode(&fixture.0, &intent.slot, &intent.incarnation, None, false).is_ok());
        assert!(pending.exists());
        assert!(!pending.with_extension("json").exists());
        for container in [
            "../outside".into(),
            format!("hkg-{}-container-0", "b".repeat(32)),
            format!("hkg-{run}-container-000"),
            format!("hkg-{run}-container-é"),
        ] {
            intent.graph.as_mut().unwrap().container = container;
            assert!(validate(&intent, &intent.slot).is_err());
        }
    }
    #[test]
    fn complete_pending_intent_is_promoted_without_values_or_reallocation() {
        let fixture = Fixture::new();
        let intent = fixture.intent();
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        assert_eq!(
            recorded_slots(&fixture.0).unwrap().as_slice(),
            std::slice::from_ref(&intent.slot)
        );
        let loaded = read(&fixture.0, &intent.slot, &intent.incarnation, None).unwrap();
        assert_eq!(loaded.service, "web");
        assert!(!pending.exists());
        assert_eq!(fs::read(pending.with_extension("json")).unwrap(), bytes);
    }
    #[test]
    fn partial_foreign_conflicting_and_aliased_intents_are_retained() {
        for case in 0..4 {
            let fixture = Fixture::new();
            let intent = fixture.intent();
            let bytes = if case == 0 {
                b"{\"version\":".to_vec()
            } else {
                serde_json::to_vec(&intent).unwrap()
            };
            let pending = fixture.pending(&bytes, &intent.slot);
            let committed = pending.with_extension("json");
            if case == 2 {
                fs::write(&committed, b"foreign").unwrap();
            }
            if case == 3 {
                std::os::unix::fs::symlink("missing-target", &committed).unwrap();
            }
            let owner = if case == 1 {
                "c".repeat(32)
            } else {
                intent.incarnation.clone()
            };
            assert!(read(&fixture.0, &intent.slot, &owner, None).is_err());
            assert_eq!(fs::read(&pending).unwrap(), bytes);
        }
    }
    #[test]
    fn malformed_or_mismatched_slot_identity_cannot_address_state() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        for slot in [
            "../outside".to_string(),
            format!("hack-env-lease-{}", "é".repeat(35)),
            format!("hack-env-lease-{}x", "a".repeat(68)),
        ] {
            assert!(read(&fixture.0, &slot, &intent.incarnation, None).is_err());
        }
        intent.boot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into();
        fixture.pending(&serde_json::to_vec(&intent).unwrap(), &intent.slot);
        assert!(read(&fixture.0, &intent.slot, &intent.incarnation, None).is_err());
    }
    #[test]
    #[ignore = "Manual recovery phase two after owned VM restart; external watchdog required"]
    fn prior_boot_intents_retire_empty_directories_without_restoring_values() {
        let path = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(std::path::Path::new(&path)).unwrap();
        let slots = recorded_slots(&candidate).unwrap();
        assert!(!slots.is_empty());
        for slot in slots {
            {
                let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
                let intent = read(&candidate, &slot, guest.incarnation(), None).unwrap();
                assert_ne!(
                    intent.boot,
                    guest.boot_id(),
                    "phase two requires a fresh guest boot"
                );
                guest
                    .execute("test ! -e \"/run/$1/values.json\"", &[&slot], None)
                    .unwrap();
            }
            retire_recorded(&candidate, &slot).unwrap();
            retire_recorded(&candidate, &slot).unwrap();
        }
        let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
        let inventory = guest
            .execute(
                r#"
for root in /run/hack-env-lease-*; do
 test -d "$root" || continue
 test ! -L "$root" || continue
 slot=${root##*/}; suffix=${slot#hack-env-lease-}
 test "${#suffix}" -eq 32 || continue
 case "$suffix" in *[!0-9a-f]*) continue;; esac
 if mountpoint -q "$root"; then continue; fi
 printf '%s ' "$slot"
 stat -c '%u:%g:%a:%Y' "$root"
done
"#,
                &[],
                None,
            )
            .unwrap();
        println!("legacy-empty-candidates:\n{inventory}");
    }

    #[test]
    #[ignore = "Explicit manifest of approved legacy fixture directories and owned VM watchdog required"]
    fn retire_approved_empty_legacy_fixture_directories() {
        let path = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let manifest =
            std::env::var("HACK_LOCAL_LEGACY_MANIFEST").expect("explicit approved legacy manifest");
        let entries: Vec<(String, u64)> =
            serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        assert!(!entries.is_empty() && entries.len() <= 32);
        let candidate = Candidate::discover(std::path::Path::new(&path)).unwrap();
        let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
        for (slot, modified) in entries {
            assert!(
                slot.strip_prefix("hack-env-lease-")
                    .is_some_and(|s| hex(s, 32))
            );
            assert_eq!(
                guest
                    .execute(
                        r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
test -d "$root"
test "$(stat -c %u:%g:%a:%Y "$root")" = "0:0:700:$2"
if mountpoint -q "$root"; then exit 1; fi
rmdir "$root"
) >/dev/null 2>&1
printf 'legacy-empty-removed\n'
"#,
                        &[&slot, &modified.to_string()],
                        None
                    )
                    .unwrap(),
                "legacy-empty-removed\n"
            );
        }
    }
}
