//! Bounded pre-admission journal for dead-owner bridge normalization. The caller
//! holds provider, foreground and relay witnesses; the journal never replaces them.
use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;
const FILE: &str = "live-owner-bridge-normalization.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    owner: String,
    boot: String,
    authority: String,
    original: Receipt,
    original_sha256: String,
    inventory: BTreeMap<u8, Assignment>,
    targets: BTreeMap<u8, Option<relay::ExitedEvidence>>,
    complete: bool,
}
fn hash(value: &impl Serialize) -> Result<String, CandidateError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(value).map_err(|_| invalid())?)
    ))
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn write(root: &Path, value: &Journal) -> Result<(), CandidateError> {
    journal::retain_file(
        root,
        "live-owner-bridge-normalization.pending",
        "bridge-normalization-interrupted",
        2 * 1024 * 1024,
    )?;
    state::write(&root.join(FILE), value)
}
fn validate(
    journal: &Journal,
    receipt: &Receipt,
    owner: &str,
    boot: &str,
    authority: &str,
) -> Result<(), CandidateError> {
    if journal.version != 1
        || journal.owner != owner
        || journal.boot != boot
        || journal.authority != authority
        || !hex(authority, 64)
        || journal.original_sha256 != hash(receipt)?
        || hash(&journal.original)? != journal.original_sha256
        || journal.inventory.len() > 32
        || journal
            .targets
            .keys()
            .any(|slot| !journal.inventory.contains_key(slot))
    {
        return Err(invalid());
    }
    for (slot, a) in &journal.inventory {
        binding(receipt, boot, a)?;
        match (a.phase.as_str(), &a.relay, journal.targets.get(slot)) {
            ("reserved", None, Some(None)) => {}
            ("running", Some(relay), Some(Some(proof)))
                if relay.transport == relay::Transport::ReservationV1 && proof.valid() => {}
            ("running", Some(_), None) => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
fn binding(receipt: &Receipt, boot: &str, a: &Assignment) -> Result<(), CandidateError> {
    if a.run != receipt.run
        || a.boot_id != boot
        || !receipt
            .resources
            .get(&format!("container:{}", a.service))
            .is_some_and(|r| {
                r.kind == Kind::Container
                    && r.key == a.service
                    && r.id.as_deref() == Some(a.container_id.as_str())
            })
        || !receipt
            .resources
            .values()
            .any(|r| r.kind == Kind::Network && r.id.as_deref() == Some(a.network_id.as_str()))
    {
        return Err(invalid());
    }
    Ok(())
}
/// An interrupted normalization can only advance its exact selected assignments
/// toward absence. New/reused slots and changes to surviving live reservations refuse.
fn remaining(journal: &Journal, store: &Store) -> Result<(), CandidateError> {
    if store.owner != journal.owner
        || store
            .slots
            .iter()
            .any(|(slot, a)| a.run == journal.original.run && !journal.inventory.contains_key(slot))
    {
        return Err(invalid());
    }
    for (slot, expected) in &journal.inventory {
        match store.slots.get(slot) {
            None if journal.targets.contains_key(slot) => {}
            Some(current) => {
                let mut comparable = current.clone();
                if journal.targets.get(slot).is_some_and(Option::is_some)
                    && ["running", "stopping", "stopped"].contains(&current.phase.as_str())
                {
                    comparable.phase = expected.phase.clone();
                }
                if comparable != *expected
                    || (journal.complete && journal.targets.contains_key(slot))
                {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
fn archive_previous(root: &Path, receipt: &Receipt, prior: &Journal) -> Result<(), CandidateError> {
    if !prior.complete
        || prior.original.run != receipt.run
        || prior.original.owner != receipt.owner
        || prior.original.namespace != receipt.namespace
        || prior.original.plan_id != receipt.plan_id
        || !super::super::super::restore_history::confirms_prior_generation(root, receipt)?
        || !prior.original.resources.iter().any(|(key, r)| {
            r.kind == Kind::Container
                && r.id != receipt.resources.get(key).and_then(|v| v.id.clone())
        })
    {
        return Err(invalid());
    }
    validate(
        prior,
        &prior.original,
        &prior.owner,
        &prior.boot,
        &prior.authority,
    )?;
    let archived = root.join("live-owner-bridge-normalization-previous.json");
    if exists(&archived)? {
        let old: Journal = state::read(&archived)?;
        validate(&old, &old.original, &old.owner, &old.boot, &old.authority)?;
        if !old.complete
            || old.original.run != receipt.run
            || old.original.owner != receipt.owner
            || old.original.plan_id != receipt.plan_id
        {
            return Err(invalid());
        }
    }
    fs::rename(root.join(FILE), archived).map_err(state::io)?;
    fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(state::io)
}

pub(crate) fn normalize(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &Path,
    authority: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    verify()?;
    let store = strict_store(candidate, engine)?;
    let path = root.join(FILE);
    if exists(&path)? {
        let previous: Journal = state::read(&path)?;
        if previous.original_sha256 != hash(receipt)? {
            archive_previous(root, receipt, &previous)?;
        }
    }
    let mut journal = if exists(&path)? {
        state::read::<Journal>(&path)?
    } else {
        let inventory: BTreeMap<_, _> = store
            .slots
            .iter()
            .filter(|(_, a)| a.run == receipt.run)
            .map(|(s, a)| (*s, a.clone()))
            .collect();
        let mut targets = BTreeMap::new();
        for (slot, a) in &inventory {
            binding(receipt, engine.guest().boot_id(), a)?;
            match (a.phase.as_str(), &a.relay) {
                ("reserved", None) => {
                    targets.insert(*slot, None);
                }
                ("running", Some(_)) => {
                    if let Some(exited) = relay::normalization_selection(engine, *slot, a)? {
                        targets.insert(*slot, Some(exited));
                    }
                }
                _ => return Err(invalid()),
            }
        }
        Journal {
            version: 1,
            owner: engine.guest().incarnation().into(),
            boot: engine.guest().boot_id().into(),
            authority: authority.into(),
            original: receipt.clone(),
            original_sha256: hash(receipt)?,
            inventory,
            targets,
            complete: false,
        }
    };
    validate(
        &journal,
        receipt,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
        authority,
    )?;
    remaining(&journal, &store)?;
    // A previously live member of this exact inventory can exit before main
    // recovery enrollment. Promote only that unchanged member, never replace a
    // selected proof or add a reservation from another generation.
    for (slot, original) in &journal.inventory {
        if !journal.targets.contains_key(slot)
            && let Some(exited) = relay::normalization_selection(engine, *slot, original)?
        {
            journal.targets.insert(*slot, Some(exited));
            journal.complete = false;
        }
    }
    // Save selection before any publication, helper or reservation is changed.
    write(root, &journal)?;
    #[cfg(test)]
    super::super::super::fault_pause(root, &receipt.run, "bridge-normalization-after-intent")?;
    for (slot, proof) in &journal.targets {
        let expected = &journal.inventory[slot];
        let fence = || {
            verify()?;
            remaining(&journal, &strict_store(candidate, engine)?)?;
            if let Some(proof) = proof {
                relay::verify_normalization(engine, *slot, expected, proof)?;
            }
            Ok(())
        };
        fence()?;
        let mut current = strict_store(candidate, engine)?;
        if current.slots.contains_key(slot) {
            let finish_partial = || match proof {
                Some(p) => relay::finish_normalization_removal(engine, *slot, expected, p),
                None => Ok(()),
            };
            stop_slot_fenced(
                candidate,
                engine,
                &mut current,
                *slot,
                &fence,
                &finish_partial,
            )?;
            fence()?;
            current.slots.remove(slot);
            save(candidate, &current)?;
            #[cfg(test)]
            super::super::super::fault_pause(
                root,
                &receipt.run,
                "bridge-normalization-after-removal",
            )?;
        }
        fence()?;
    }
    verify()?;
    journal.complete = true;
    remaining(&journal, &strict_store(candidate, engine)?)?;
    write(root, &journal)?;
    #[cfg(test)]
    super::super::super::fault_pause(root, &receipt.run, "bridge-normalization-complete")?;
    verify()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Journal, Store) {
        let (selection, store) = super::super::tests::live_selection();
        let original = super::super::tests::receipt_for_assignment(&selection, &store.slots[&0]);
        let journal = Journal {
            version: 1,
            owner: selection.owner,
            boot: selection.boot,
            authority: "a".repeat(64),
            original_sha256: hash(&original).unwrap(),
            original,
            inventory: store.slots.clone(),
            targets: BTreeMap::from([(
                0,
                Some(
                    serde_json::from_value(json!(
                        "relay-normalization-exited-v1 20 20 1:2 1:3 1:4 1:5 1:6"
                    ))
                    .unwrap(),
                ),
            )]),
            complete: false,
        };
        (journal, store)
    }
    #[test]
    fn normalization_binds_generation_boot_authority_and_never_launched_targets() {
        let (mut j, _) = fixture();
        validate(&j, &j.original, &j.owner, &j.boot, &j.authority).unwrap();
        for change in 0..5 {
            let (mut bad, _) = fixture();
            match change {
                0 => bad.authority = "b".repeat(64),
                1 => bad.boot = "other".into(),
                2 => bad.owner = "b".repeat(32),
                3 => bad.original_sha256 = "b".repeat(64),
                4 => bad.inventory.get_mut(&0).unwrap().container_id = "b".repeat(64),
                _ => unreachable!(),
            }
            assert!(validate(&bad, &j.original, &j.owner, &j.boot, &j.authority).is_err());
        }
        j.inventory.get_mut(&0).unwrap().phase = "reserved".into();
        j.inventory.get_mut(&0).unwrap().relay = None;
        j.targets.insert(0, None);
        validate(&j, &j.original, &j.owner, &j.boot, &j.authority).unwrap();
        j.inventory.get_mut(&0).unwrap().phase = "starting".into();
        assert!(validate(&j, &j.original, &j.owner, &j.boot, &j.authority).is_err());
    }
    #[test]
    fn normalization_retry_preserves_siblings_and_refuses_replacements_or_added_inventory() {
        let (j, mut store) = fixture();
        let mut sibling = store.slots[&0].clone();
        sibling.run = "9".repeat(32);
        sibling.reservation = "8".repeat(32);
        store.slots.insert(1, sibling.clone());
        for phase in ["running", "stopping", "stopped"] {
            store.slots.get_mut(&0).unwrap().phase = phase.into();
            remaining(&j, &store).unwrap();
        }
        for change in 0..5 {
            let (_, mut bad) = fixture();
            let a = bad.slots.get_mut(&0).unwrap();
            match change {
                0 => a.reservation = "b".repeat(32),
                1 => a.run = "9".repeat(32),
                2 => a.generation = "b".repeat(64),
                3 => a.relay.as_mut().unwrap().launch_serial += 1,
                4 => a.phase = "starting".into(),
                _ => unreachable!(),
            }
            assert!(remaining(&j, &bad).is_err());
        }
        store.slots.remove(&0);
        remaining(&j, &store).unwrap();
        assert_eq!(store.slots[&1], sibling);
        store.slots.insert(0, sibling);
        assert!(remaining(&j, &store).is_err());
        store.slots.remove(&0);
        let mut added = j.inventory[&0].clone();
        added.service = "added".into();
        store.slots.insert(2, added);
        assert!(remaining(&j, &store).is_err());
    }
    #[test]
    fn surviving_live_reservation_cannot_disappear_or_become_a_target_on_retry() {
        let (mut j, mut store) = fixture();
        j.targets.clear();
        remaining(&j, &store).unwrap();
        store.slots.get_mut(&0).unwrap().phase = "stopping".into();
        assert!(remaining(&j, &store).is_err());
        store.slots.clear();
        assert!(remaining(&j, &store).is_err());
        let (mut j, mut store) = fixture();
        j.complete = true;
        assert!(remaining(&j, &store).is_err());
        store.slots.clear();
        remaining(&j, &store).unwrap();
    }
}
