//! Grow an owned stopped pool. A provider record commit may precede the
//! owner receipt, but neither side may boot until the journal is retired.
use super::{
    BridgeIntent, DependencySocketIntent, bridge, config_audit, dependency_socket, lifecycle,
    network_update, share_update,
    state::{self, Owner},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

const JOURNAL: &str = "socket-update.json";

fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm")
}

fn refused() -> CandidateError {
    CandidateError::new(
        "pool_socket_update",
        "The pool socket update could not be verified. Retry the same startup request.",
    )
}

fn present(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}

pub(super) fn require_complete(candidate: &Candidate) -> Result<(), CandidateError> {
    if pending(candidate)? {
        return Err(refused());
    }
    Ok(())
}

pub(super) fn pending(candidate: &Candidate) -> Result<bool, CandidateError> {
    let pool = root(candidate);
    Ok(present(&pool.join(JOURNAL))? || present(&pool.join("socket-update.pending"))?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capacity {
    bridges: Option<BridgeIntent>,
    dependencies: Option<DependencySocketIntent>,
}

impl Capacity {
    fn of(owner: &Owner) -> Self {
        Self {
            bridges: owner.application_bridge,
            dependencies: owner.dependency_sockets,
        }
    }

    pub(super) fn apply(self, owner: &mut Owner) {
        owner.application_bridge = self.bridges;
        owner.dependency_sockets = self.dependencies;
    }
}

/// Exact requests are checked against the current counts. Only minima can
/// cause growth, and one direction cannot consume the other's recorded slots.
pub(super) fn target(
    owner: &Owner,
    bridges: bridge::Request,
    dependencies: dependency_socket::Request,
) -> Result<Capacity, CandidateError> {
    let mut target = Capacity::of(owner);
    match bridges {
        bridge::Request::Minimum(required) if bridges.check(target.bridges).is_err() => {
            target.bridges = Some(required);
        }
        _ => bridges.check(target.bridges)?,
    }
    match dependencies {
        dependency_socket::Request::Minimum(required)
            if dependencies.check(target.dependencies).is_err() =>
        {
            target.dependencies = Some(required);
        }
        _ => dependencies.check(target.dependencies)?,
    }
    dependency_socket::check_capacity(target.bridges, target.dependencies)?;
    Ok(target)
}

pub(super) fn changed(owner: &Owner, target: Capacity) -> bool {
    Capacity::of(owner) != target
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    target: Capacity,
    database_identity: (u64, u64),
    owner_before: Value,
    owner_after: Value,
    record_before: Value,
    record_after: Value,
}

fn owner_value(owner: &Owner) -> Result<Value, CandidateError> {
    serde_json::to_value(owner).map_err(|_| refused())
}

fn plan(
    owner: &Owner,
    record: Value,
    target: Capacity,
    database_identity: (u64, u64),
) -> Result<Journal, CandidateError> {
    let before = Capacity::of(owner);
    let bridges = |capacity: Capacity| capacity.bridges.map_or(0, |intent| intent.slots);
    let dependencies = |capacity: Capacity| capacity.dependencies.map_or(0, |intent| intent.slots);
    if before == target
        || bridges(target) < bridges(before)
        || dependencies(target) < dependencies(before)
    {
        return Err(refused());
    }
    dependency_socket::check_capacity(target.bridges, target.dependencies)?;
    let mut after = owner.clone();
    target.apply(&mut after);
    let mut record_after = record.clone();
    record_after["published_sockets"] = config_audit::socket_mappings(
        target.bridges,
        target
            .dependencies
            .map(|intent| (intent, owner.short_home.as_path())),
    )?;
    Ok(Journal {
        version: 1,
        target,
        database_identity,
        owner_before: owner_value(owner)?,
        owner_after: owner_value(&after)?,
        record_before: record,
        record_after,
    })
}

fn validate(
    journal: &Journal,
    owner: &Value,
    record: &Value,
) -> Result<(Owner, Owner), CandidateError> {
    if journal.version != 1
        || (owner != &journal.owner_before && owner != &journal.owner_after)
        || (record != &journal.record_before && record != &journal.record_after)
        || (owner == &journal.owner_after && record == &journal.record_before)
    {
        return Err(refused());
    }
    let before: Owner =
        serde_json::from_value(journal.owner_before.clone()).map_err(|_| refused())?;
    let after: Owner =
        serde_json::from_value(journal.owner_after.clone()).map_err(|_| refused())?;
    let expected = plan(
        &before,
        journal.record_before.clone(),
        journal.target,
        journal.database_identity,
    )?;
    if expected.owner_after != journal.owner_after || expected.record_after != journal.record_after
    {
        return Err(refused());
    }
    Ok((before, after))
}

/// Call after the idle stop, if one was needed. Recheck the exact selected
/// owner under the lease before making any write.
pub(super) fn update(
    candidate: &Candidate,
    selected: &Owner,
    target: Capacity,
) -> Result<Owner, CandidateError> {
    let pool = root(candidate);
    reject_aliased_state(&pool)?;
    let _lease = lifecycle::startup_lease(&pool, lifecycle::STARTUP_LEASE_WAIT)?;
    network_update::require_complete(candidate)?;
    share_update::require_complete(candidate)?;
    let owner = Owner::load(candidate)?;
    let current = owner_value(&owner)?;
    if current != owner_value(selected)? {
        return Err(refused());
    }
    let _vm_lock = network_update::stopped_with(candidate, &owner, refused)?;
    let database = network_update::database(candidate);
    let record = config_audit::read_database(&database, &owner.machine)?;
    network_update::verify_record_process_with(&owner, &record, refused)?;
    let path = pool.join(JOURNAL);
    let journal = if present(&path)? {
        network_update::file_identity_with(&path, refused)?;
        state::read::<Journal>(&path)?
    } else {
        config_audit::verify_value(candidate, &owner, &record)?;
        // The provider CAS starts only after the journal rename. With the
        // original record still verified, an interrupted first write has
        // no authority and can be retried.
        let staged = path.with_extension("pending");
        if present(&staged)? {
            network_update::file_identity_with(&staged, refused)?;
            fs::remove_file(staged).map_err(|_| refused())?;
            File::open(&pool)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| refused())?;
        }
        if !changed(&owner, target) {
            return Ok(owner);
        }
        let journal = plan(
            &owner,
            record.clone(),
            target,
            network_update::file_identity_with(&database, refused)?,
        )?;
        state::write(&path, &journal)?;
        journal
    };
    let (before, after) = validate(&journal, &current, &record)?;
    if journal.target != target {
        return Err(refused());
    }
    config_audit::verify_value(candidate, &before, &journal.record_before)?;
    config_audit::verify_value(candidate, &after, &journal.record_after)?;
    lifecycle::verify_disks(candidate, &owner)?;
    super::graph::initialize_resize_registry(candidate, &before, &after)?;
    network_update::apply_record(
        &database,
        &owner.machine,
        journal.database_identity,
        &journal.record_before,
        &journal.record_after,
        refused,
    )?;
    config_audit::verify_value(
        candidate,
        &after,
        &config_audit::read_database(&database, &owner.machine)?,
    )?;
    lifecycle::verify_disks(candidate, &owner)?;
    let staging = pool.join("owner.pending");
    if present(&staging)? {
        network_update::file_identity_with(&staging, refused)?;
        let expected = serde_json::to_vec_pretty(&after).map_err(|_| refused())?;
        let bytes = fs::read(&staging).map_err(|_| refused())?;
        // A crash during the write can leave a prefix of the intended
        // receipt. A different receipt has no authority in this transaction.
        if !expected.starts_with(&bytes) {
            let staged: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            if staged != journal.owner_after {
                return Err(refused());
            }
        }
        fs::remove_file(staging).map_err(|_| refused())?;
    }
    if owner_value(&Owner::load(candidate)?)? != current {
        return Err(refused());
    }
    if current != journal.owner_after {
        after.save(candidate)?;
    }
    let saved = Owner::load(candidate)?;
    config_audit::verify(candidate, &saved)?;
    fs::remove_file(path).map_err(|_| refused())?;
    File::open(pool)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| refused())?;
    Ok(saved)
}

/// Read the pool's actual reservations for a capacity refusal. A live graph
/// can block an idle stop even when it holds neither kind of socket.
pub fn socket_usage(candidate: &Candidate) -> Result<Value, CandidateError> {
    let pool = root(candidate);
    reject_aliased_state(&pool)?;
    let _lease = state::Lock::acquire(&pool)?;
    require_complete(candidate)?;
    let owner = Owner::load(candidate)?;
    let bridges = super::graph::bridges::socket_counts(candidate, &owner)?;
    #[cfg(target_os = "macos")]
    let dependencies = super::graph::dependency_slots::socket_counts(candidate, &owner)?;
    #[cfg(not(target_os = "macos"))]
    let dependencies = std::collections::BTreeMap::<String, usize>::new();
    let live = lifecycle::live_socket_pool_runs(candidate)?;
    let runs = bridges
        .keys()
        .chain(dependencies.keys())
        .chain(live.iter())
        .collect::<std::collections::BTreeSet<_>>();
    let reservations = runs
        .into_iter()
        .map(|run| {
            serde_json::json!({
                "run": run,
                "bridges": bridges.get(run).copied().unwrap_or_default(),
                "dependencies": dependencies.get(run).copied().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "bridges": owner.application_bridge.map_or(0, |intent| intent.slots),
        "dependencies": owner.dependency_sockets.map_or(0, |intent| intent.slots),
        "reservations": reservations,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner(bridges: u8, dependencies: u8) -> Owner {
        serde_json::from_value(json!({
            "version":1,"checkout":"/fixture","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","machine":"fixture",
            "short_home":"/fixture","created":true,"phase":"stopped","process":null,
            "storage":null,"overlay":null,"guest_boot_id":null,"daemon_pid":null,"daemon_start":null,
            "rootfs_digest":null,"profile":"development","network":"internet",
            "application_bridge": BridgeIntent::new(bridges).ok(),
            "dependency_sockets": DependencySocketIntent::new(dependencies).ok(),
        }))
        .unwrap()
    }

    #[test]
    fn minimum_grows_without_taking_the_other_direction_or_changing_exact_requests() {
        let owner = owner(1, 8);
        let bridges = |n| bridge::Request::Minimum(BridgeIntent::new(n).unwrap());
        let dependencies = dependency_socket::Request::Exact(None);
        let grown = target(&owner, bridges(24), dependencies).unwrap();
        assert_eq!(grown.bridges.unwrap().slots, 24);
        assert_eq!(grown.dependencies.unwrap().slots, 8);
        assert!(target(&owner, bridges(25), dependencies).is_err());
        assert!(target(&owner, BridgeIntent::new(2).ok().into(), dependencies).is_err());
        assert!(!changed(
            &owner,
            target(&owner, bridges(1), dependencies).unwrap()
        ));
    }

    #[test]
    fn replay_accepts_only_ordered_durable_pairs_and_the_exact_planned_delta() {
        let owner = owner(0, 0);
        let target = target(
            &owner,
            bridge::Request::Minimum(BridgeIntent::new(2).unwrap()),
            dependency_socket::Request::Minimum(DependencySocketIntent::new(1).unwrap()),
        )
        .unwrap();
        let mut journal = plan(
            &owner,
            json!({"published_sockets":[],"network":"internet"}),
            target,
            (1, 2),
        )
        .unwrap();
        for (owner, record) in [
            (&journal.owner_before, &journal.record_before),
            (&journal.owner_before, &journal.record_after),
            (&journal.owner_after, &journal.record_after),
        ] {
            assert!(validate(&journal, owner, record).is_ok());
        }
        assert!(validate(&journal, &journal.owner_after, &journal.record_before).is_err());
        assert_eq!(
            journal.record_after["published_sockets"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        journal.record_after["network"] = json!("isolated");
        assert!(validate(&journal, &journal.owner_before, &journal.record_after).is_err());
    }
}
