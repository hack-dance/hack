//! Native allocation intent uses a distinct codec/path; Compose v1 bindings remain strict.
use super::{
    environment::EnvironmentLease, environment_recovery, lifecycle::OwnedGuest, native_input, state,
};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf};
#[cfg(target_os = "macos")]
use std::{collections::BTreeSet, os::unix::fs::MetadataExt};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider) struct Binding {
    pub namespace: String,
    pub run: String,
    pub review: String,
    pub container: String,
}
impl Binding {
    pub(in crate::provider) fn new(
        review: &native_input::Review,
        resource: &super::graph::Resource,
    ) -> Self {
        let scope = review.scope();
        Self {
            namespace: scope.namespace.into(),
            run: scope.run.into(),
            review: review.review_id().into(),
            container: resource.name.clone(),
        }
    }
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    NativeEnvironmentAllocation,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    kind: Kind,
    binding: Binding,
    service: String,
    uid: u32,
    gid: u32,
    slot: String,
    incarnation: String,
    boot: String,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "native_environment_recovery",
        "Native private allocation requires matching tagged intent, guest and native graph ownership; values and guest output omitted.",
    )
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/native-environment-leases")
}
fn validate(intent: &Intent, slot: &str) -> Result<(), CandidateError> {
    let suffix = intent
        .binding
        .container
        .strip_prefix(&format!("hkn-{}-container-", intent.binding.run));
    if intent.version != 2
        || intent.kind != Kind::NativeEnvironmentAllocation
        || intent.slot != slot
        || !environment_recovery::valid_slot(slot)
        || !environment_recovery::uuid(&intent.boot)
        || !slot.starts_with(&format!("hack-env-lease-{}-", intent.boot))
        || !hex(&intent.incarnation, 32)
        || !hex(&intent.binding.namespace, 64)
        || !hex(&intent.binding.run, 32)
        || !hex(&intent.binding.review, 64)
        || !suffix.is_some_and(|index| {
            index
                .parse::<usize>()
                .is_ok_and(|n| n < 32 && n.to_string() == index)
        })
        || !super::environment::name(&intent.service)
    {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn count(candidate: &Candidate) -> Result<usize, CandidateError> {
    environment_recovery::native_count(candidate)
}
pub(super) fn record(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    lease: &EnvironmentLease,
) -> Result<(), CandidateError> {
    let binding = lease.native.as_ref().ok_or_else(refused)?;
    if lease.graph.is_some() {
        return Err(refused());
    }
    super::graph::native::environment_binding(
        candidate,
        guest.incarnation(),
        guest.boot_id(),
        binding,
        &lease.service,
        true,
    )?;
    let intent = Intent {
        version: 2,
        kind: Kind::NativeEnvironmentAllocation,
        binding: binding.clone(),
        service: lease.service.clone(),
        uid: lease.uid,
        gid: lease.gid,
        slot: lease.slot.clone(),
        incarnation: lease.incarnation.clone(),
        boot: lease.boot.clone(),
    };
    validate(&intent, &lease.slot)?;
    environment_recovery::preflight_records(candidate, 1)?;
    let directory = root(candidate);
    state::private_directory(&directory)?;
    let path = directory.join(format!("{}.json", lease.slot));
    for path in [&path, &path.with_extension("pending")] {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
    }
    state::write(&path, &intent)
}
fn read(candidate: &Candidate, slot: &str) -> Result<Intent, CandidateError> {
    if !environment_recovery::valid_slot(slot) {
        return Err(refused());
    }
    let directory = root(candidate);
    for path in directory
        .ancestors()
        .take_while(|path| path.starts_with(&candidate.state_root))
    {
        state::check_private_directory(path).map_err(|_| refused())?;
    }
    let path = directory.join(format!("{slot}.json"));
    match fs::symlink_metadata(path.with_extension("pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(refused()),
    }
    let intent =
        serde_json::from_slice(&native_input::read_file(&path, 4096).map_err(|_| refused())?)
            .map_err(|_| refused())?;
    validate(&intent, slot)?;
    Ok(intent)
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordWitness {
    identity: (u64, u64),
    sha256: String,
}
/// The first current-private slot snapshot becomes immutable retry evidence.
/// Guest enumeration separately detects payloads whose host records were lost.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider) struct Inventory {
    directory: Option<(u64, u64)>,
    records: BTreeMap<String, RecordWitness>,
}
#[cfg(target_os = "macos")]
fn entries(candidate: &Candidate) -> Result<Vec<(Intent, RecordWitness)>, CandidateError> {
    if count(candidate)? == 0 {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for (index, entry) in fs::read_dir(root(candidate))
        .map_err(|_| refused())?
        .enumerate()
    {
        if index >= 4096 {
            return Err(refused());
        }
        let path = entry.map_err(|_| refused())?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        let slot = name.strip_suffix(".json").ok_or_else(refused)?;
        let before = fs::symlink_metadata(&path).map_err(|_| refused())?;
        let intent = read(candidate, slot)?;
        let bytes = native_input::read_file(&path, 4096).map_err(|_| refused())?;
        let again: Intent = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        validate(&again, slot)?;
        let after = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino())
            || serde_json::to_vec(&intent).map_err(|_| refused())?
                != serde_json::to_vec(&again).map_err(|_| refused())?
        {
            return Err(refused());
        }
        entries.push((
            intent,
            RecordWitness {
                identity: (after.dev(), after.ino()),
                sha256: format!("{:x}", Sha256::digest(bytes)),
            },
        ));
    }
    Ok(entries)
}
#[cfg(target_os = "macos")]
impl Inventory {
    pub(in crate::provider) fn capture(
        candidate: &Candidate,
        receipt: &super::graph::native::Receipt,
    ) -> Result<Self, CandidateError> {
        let directory = match fs::symlink_metadata(root(candidate)) {
            Ok(metadata) => {
                state::check_private_directory(&root(candidate)).map_err(|_| refused())?;
                Some((metadata.dev(), metadata.ino()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(refused()),
        };
        let mut records = BTreeMap::new();
        let mut services = BTreeSet::new();
        for (intent, witness) in entries(candidate)? {
            if intent.binding.run != receipt.review().scope().run {
                continue;
            }
            let resource = receipt
                .resources()
                .get(&format!("container:{}", intent.service))
                .ok_or_else(refused)?;
            if records.len() == super::environment::MAX_MANAGED_SERVICES
                || !services.insert(intent.service.clone())
                || intent.incarnation != receipt.owner()
                || intent.boot != receipt.boot()
                || intent.binding.namespace != receipt.review().scope().namespace
                || intent.binding.review != receipt.review().review_id()
                || intent.binding.container != resource.name
            {
                return Err(refused());
            }
            records.insert(intent.slot, witness);
        }
        Ok(Self { directory, records })
    }
    pub(in crate::provider) fn verify(
        &self,
        candidate: &Candidate,
        receipt: &super::graph::native::Receipt,
    ) -> Result<(), CandidateError> {
        if &Self::capture(candidate, receipt)? != self {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn known_slots(
    candidate: &Candidate,
    incarnation: &str,
    boot: &str,
) -> Result<BTreeSet<String>, CandidateError> {
    let mut known = environment_recovery::known_current_slots(candidate, incarnation, boot)?;
    for (intent, _) in entries(candidate)? {
        if intent.incarnation == incarnation && intent.boot == boot && !known.insert(intent.slot) {
            return Err(refused());
        }
    }
    Ok(known)
}
#[cfg(target_os = "macos")]
fn admit_guest_slots(
    output: &str,
    boot: &str,
    known: &BTreeSet<String>,
    absent: Option<&Inventory>,
) -> Result<(), CandidateError> {
    let body = output
        .strip_prefix("environment-slot-inventory-v1\n")
        .ok_or_else(refused)?;
    if !body.is_empty() && !body.ends_with('\n') {
        return Err(refused());
    }
    let mut observed = BTreeSet::new();
    for slot in body.lines() {
        if observed.len() == super::environment::MAX_CONCURRENT_ALLOCATIONS
            || !environment_recovery::valid_slot(slot)
            || !slot.starts_with(&format!("hack-env-lease-{boot}-"))
            || !known.contains(slot)
            || !observed.insert(slot)
            || absent.is_some_and(|inventory| inventory.records.contains_key(slot))
        {
            return Err(refused());
        }
    }
    Ok(())
}
/// Unknown guest slots refuse even when host records are empty. Names only are
/// observed; the retained guest lease independently verifies incarnation/boot.
#[cfg(target_os = "macos")]
pub(in crate::provider) fn verify_inventory(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    receipt: &super::graph::native::Receipt,
    inventory: &Inventory,
    absent: bool,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    check_guard(guard)?;
    inventory.verify(candidate, receipt)?;
    let known = known_slots(candidate, guest.incarnation(), guest.boot_id())?;
    check_guard(guard)?;
    let result = guest.execute_cleanup(
        LIST_SLOTS,
        &[&super::environment::MAX_CONCURRENT_ALLOCATIONS.to_string()],
    );
    check_guard(guard)?;
    inventory.verify(candidate, receipt)?;
    admit_guest_slots(
        &result?,
        guest.boot_id(),
        &known,
        absent.then_some(inventory),
    )
}
#[cfg(target_os = "macos")]
const LIST_SLOTS: &str = r#"
count=0
printf 'environment-slot-inventory-v1\n'
for path in /run/hack-env-lease-*; do
 if test -e "$path" || test -L "$path"; then
  test ! -L "$path"
  test -d "$path"
  count=$((count + 1))
  test "$count" -le "$1"
  printf '%s\n' "${path#/run/}"
 fi
done
"#;
pub(super) fn retire(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    slot: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<(), CandidateError> {
    retire_guarded(candidate, guest, slot, lease, None)
}
fn check_guard(
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    if let Some(guard) = guard {
        guard()?;
    }
    Ok(())
}
fn retire_guarded(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    slot: &str,
    lease: Option<&EnvironmentLease>,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    check_guard(guard)?;
    let intent = read(candidate, slot)?;
    if intent.incarnation != guest.incarnation()
        || intent.boot != guest.boot_id()
        || lease.is_some_and(|lease| {
            lease.graph.is_some()
                || lease.native.as_ref() != Some(&intent.binding)
                || lease.service != intent.service
                || lease.uid != intent.uid
                || lease.gid != intent.gid
                || lease.incarnation != intent.incarnation
                || lease.boot != intent.boot
        })
    {
        return Err(refused());
    }
    super::graph::native::environment_binding(
        candidate,
        guest.incarnation(),
        guest.boot_id(),
        &intent.binding,
        &intent.service,
        false,
    )?;
    // A native payload may disappear only after the exact bound container name is absent.
    check_guard(guard)?;
    let result = super::engine::require_container_absent(guest, &intent.binding.container);
    check_guard(guard)?;
    result?;
    let result = guest.execute_cleanup(environment_recovery::RETIRE, &[slot, "same"]);
    check_guard(guard)?;
    if result? != "environment-removed-v1\n" {
        return Err(refused());
    }
    Ok(())
}
pub(in crate::provider) fn retire_graph(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    receipt: &super::graph::native::Receipt,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    graph_retirement(candidate, guest, receipt, guard, false)
}
pub(in crate::provider) fn verify_retired_graph(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    receipt: &super::graph::native::Receipt,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    graph_retirement(candidate, guest, receipt, guard, true)
}
fn graph_retirement(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    receipt: &super::graph::native::Receipt,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
    already_retired: bool,
) -> Result<(), CandidateError> {
    check_guard(guard)?;
    let directory = root(candidate);
    if *receipt.phase() != super::graph::native::Phase::Removed {
        return Err(refused());
    }
    if count(candidate)? == 0 {
        return Ok(());
    }
    let mut selected = Vec::new();
    let mut services = std::collections::BTreeSet::new();
    for entry in fs::read_dir(directory).map_err(state::io)? {
        let name = entry
            .map_err(state::io)?
            .file_name()
            .into_string()
            .map_err(|_| refused())?;
        let slot = name.strip_suffix(".json").ok_or_else(refused)?;
        let intent = read(candidate, slot)?;
        if intent.binding.run == receipt.review().scope().run {
            if selected.len() == super::environment::MAX_MANAGED_SERVICES
                || !services.insert(intent.service.clone())
                || intent.incarnation != guest.incarnation()
                || intent.boot != guest.boot_id()
            {
                return Err(refused());
            }
            super::graph::native::environment_binding(
                candidate,
                guest.incarnation(),
                guest.boot_id(),
                &intent.binding,
                &intent.service,
                false,
            )?;
            check_guard(guard)?;
            let result = super::engine::require_container_absent(guest, &intent.binding.container);
            check_guard(guard)?;
            result?;
            selected.push(slot.to_owned());
        }
    }
    for slot in selected {
        if already_retired {
            check_guard(guard)?;
            let result = guest.execute_cleanup(VERIFY_REMOVED, &[&slot]);
            check_guard(guard)?;
            if result? != "environment-removed-v1\n" {
                return Err(refused());
            }
        } else {
            retire_guarded(candidate, guest, &slot, None, guard)?;
        }
    }
    check_guard(guard)?;
    Ok(())
}

const VERIFY_REMOVED: &str = r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
test ! -e "$root"
) >/dev/null 2>&1
printf 'environment-removed-v1\n'
"#;

#[cfg(test)]
mod tests;
