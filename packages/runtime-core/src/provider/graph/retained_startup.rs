//! Offline eligibility for one explicit retained-runtime start. This is not a
//! volume observation or restore generation; live restore selection stays mandatory.
use super::*;
use crate::provider::{identity, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
use std::path::Path;

fn refused() -> CandidateError {
    error(
        "graph_retained_startup",
        "Retained startup requires an unchanged clean owned runtime, retired foreground owner and acknowledged graph cleanup.",
    )
}

/// A remaining foreground publication blocks retained startup. Name the next
/// step when its recorded owner is classified; the classification grants nothing.
fn published_owner_refused(candidate: &Candidate, run: &str) -> CandidateError {
    use foreground::transport::{PublishedOwner, published_owner};
    match published_owner(candidate, run) {
        Ok(PublishedOwner::Running) => error(
            "graph_foreground_owner_running",
            "Another hack up or hack restart of this run is still running, in a terminal or detached (-d). Run hack down to stop it (or press Ctrl-C if it runs in your terminal), then start the project again.",
        ),
        Ok(PublishedOwner::Exited) if exited_ready(candidate, run) => error(
            "graph_foreground_owner_exited",
            "The previous foreground owner of this run exited while its services were running and did not retire its publication. Run hack down --recover to stop the orphaned services with data retained, then hack up.",
        ),
        Ok(PublishedOwner::Exited) if exited_unadmitted_retained(candidate, run) => error(
            "graph_foreground_owner_exited_unadmitted",
            "The previous foreground owner of this run exited before its restore was admitted and did not retire its publication. Data is retained. Run hack down --recover to retire that attempt, then hack up.",
        ),
        // HACK-2714: a start that failed (or was still preparing) when its owner died
        // is retired by `hack down --recover`, in its own boot or a later one.
        Ok(PublishedOwner::Exited) if exited_unconfirmed_start(candidate, run) => error(
            "graph_foreground_owner_exited_unadmitted",
            "The previous foreground owner of this run exited before its services were ready and did not retire its publication. Data is retained. Run hack down --recover to retire that attempt, then hack up.",
        ),
        Ok(PublishedOwner::Exited) => error(
            "graph_foreground_owner_exited_unadmitted",
            "The previous foreground owner of this run exited before its start was confirmed and did not retire its publication. Data is retained, but no supported command can prove and retire that attempt yet; keep the native home unchanged for inspection.",
        ),
        // HACK-2572: an owner that is ending reads this way for a moment: its process
        // has exited but is not yet reaped (alive to `kill 0`, unobservable), or its
        // publication changed between the two reads. The caller may wait and read again.
        Ok(PublishedOwner::Uncertain | PublishedOwner::Absent) => error(
            "graph_foreground_owner_uncertain",
            "The previous foreground owner of this run is ending or its publication cannot be classified yet; nothing was changed. Run hack up again once it has ended; hack ps --json shows its state.",
        ),
        Err(_) => refused(),
    }
}
/// A ready graph, or a same-boot dead-owner recovery of one that was interrupted:
/// both are stopped by `hack down --recover`.
fn exited_ready(candidate: &Candidate, run: &str) -> bool {
    Owner::load(candidate)
        .ok()
        .and_then(|owner| load_at(directory(candidate, run).ok()?, run, &owner.token).ok())
        .is_some_and(|(receipt, root)| {
            ["ready-observed", super::STARTED_OBSERVED].contains(&receipt.phase.as_str())
                || super::live_owner_cleanup::resumable_selection(candidate, &root, &receipt, true)
                    .is_ok_and(|selected| selected.is_some())
        })
}

/// The receipt is still the acknowledged retained stop the dead owner started
/// from: `hack down --recover` can prove and retire that attempt. Presentation
/// only; the recovery revalidates everything itself.
fn exited_unadmitted_retained(candidate: &Candidate, run: &str) -> bool {
    Owner::load(candidate)
        .ok()
        .and_then(|owner| load_at(directory(candidate, run).ok()?, run, &owner.token).ok())
        .is_some_and(|(receipt, _)| receipt.phase == "stopped-data-retained")
}

/// A start the cross-boot dead-owner recovery admits (`failed-retained`,
/// `preparing` or `restoring`, with a settled relay startup). Presentation only,
/// as above.
fn exited_unconfirmed_start(candidate: &Candidate, run: &str) -> bool {
    Owner::load(candidate)
        .ok()
        .and_then(|owner| load_at(directory(candidate, run).ok()?, run, &owner.token).ok())
        .is_some_and(|(receipt, _)| super::dead_owner_cleanup::unconfirmed_start(&receipt))
}

fn lost_removal_pending() -> CandidateError {
    error(
        "graph_lost_removal_pending",
        "An earlier hack down --recover removed containers a lost VM had brought back and ended before it confirmed that the removal reached the guest disk, so this stop is not durable yet. Data is retained. Run hack down --recover to finish it, then hack up.",
    )
}

fn no_file(root: &Path, name: &str) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join(name)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}

/// Offline eligibility of a retained start, except the foreground publication:
/// a clean unchanged owned runtime and an acknowledged retained stop of `run`.
///
/// The pool record is read without a lease here. Every caller that acts on the result
/// holds the startup lease (`Guard::verify`, `preflight`) or only presents it; a pool
/// that a concurrent start is booting holds that lease, so a leased read never sees it
/// mid-boot (`booting`, or the `owner.pending` of a record write) (HACK-2732).
pub(in crate::provider::graph) fn checked(
    candidate: &Candidate,
    run: &str,
) -> Result<(Owner, Receipt), CandidateError> {
    no_file(&candidate.state_root.join("run/smolvm"), "owner.pending")?;
    // A lost-removal repair whose storage barrier has not confirmed (HACK-2719):
    // `hack down --recover` finishes it before the stop counts as retained.
    if let Ok(root) = directory(candidate, run) {
        no_file(&root, super::LOST_REMOVAL_REPAIR).map_err(|_| lost_removal_pending())?;
    }
    let owner = Owner::load(candidate)?;
    if owner.phase == "failed-boot-stopped" {
        return Err(error(
            "graph_retained_startup",
            "The runtime's last boot failed and was stopped; run hack native recover (runtime recover --json with the executor) first, then hack up. The retained data is untouched.",
        ));
    }
    let clean = matches!(owner.phase.as_str(), "running" | "stopped") && has_boot_id(&owner);
    if !owner.created
        || owner.profile != super::super::Profile::Development
        || owner.storage.is_none()
        || owner.overlay.is_none()
        || !(clean || after_engine_loss(&owner) || after_guestless_boot(&owner))
    {
        return Err(refused());
    }
    match (&owner.process, owner.phase == "running") {
        (Some(process), running) => {
            if !identity::provider_gone(process)? != running {
                return Err(refused());
            }
        }
        // A later boot that failed before recording its provider leaves none recorded.
        (None, false) if after_guestless_boot(&owner) => {}
        _ => return Err(refused()),
    }
    if owner.phase == "running" {
        lifecycle::verify_live(candidate, &owner)?;
    }
    lifecycle::verify_disks(candidate, &owner)?;
    lifecycle::verify_retained_rootfs(candidate, &owner)?;
    super::super::network_update::require_complete(candidate)?;
    super::super::share_update::require_complete(candidate)?;
    verify_owner_registry(candidate, &owner)?;
    let (receipt, root) = load_at(directory(candidate, run)?, run, &owner.token)?;
    if receipt.phase != "stopped-data-retained"
        || receipt.normalized_input.is_none()
        || receipt
            .resources
            .values()
            .any(|resource| match resource.kind {
                Kind::Volume => resource.phase != "created" && resource.phase != "released",
                _ => resource.phase != "absent",
            })
    {
        return Err(refused());
    }
    for name in [
        "state.pending",
        "one-off.json",
        "one-off.pending",
        "retired-data-removal.json",
        "retired-data-removal.pending",
    ] {
        no_file(&root, name)?;
    }
    startup::require_dependency_rebind_complete(&root, &receipt)?;
    cleanup_enrollment::retention(&root, &receipt)?;
    Ok((owner, receipt))
}

fn has_boot_id(owner: &Owner) -> bool {
    !owner.guest_boot_id.as_deref().is_none_or(str::is_empty)
}

/// Stopped phases a later boot can leave after it failed before it recorded a guest boot id
/// (HACK-2376), once `runtime recover` has run where needed. `stopped` is the phase a start
/// writes when its boot admission refuses before anything boots: that start never calls
/// `begin_boot`, so the boot ids stay as the failed boot left them.
const AFTER_GUESTLESS_BOOT: [&str; 4] = [
    "recovered-unclean",
    "stopped-before-engine",
    "stopped-after-engine-failure",
    "stopped",
];

/// A pool whose later boot failed before it recorded a guest boot id (HACK-2376): the boot id
/// is empty and the previous one is still the boot the retained run was stopped in, because
/// `Owner::begin_boot` keeps it when the boot it superseded recorded none.
///
/// The boundary this relies on is the managed engine, not the guest. The VM and the guest's
/// setup may already have run in that boot (for example a bridge socket timeout comes after
/// `machine start`), but the engine is started only after the boot id is saved
/// (`lifecycle::guest-daemon.sh` follows `owner.guest_boot_id = Some(..)` and its save). So no
/// engine ran since the clean retained stop: no container, network or volume of the run was
/// created, started or written by the engine, and restore still checks the volumes' recorded
/// identities and the containers' and networks' absence. An unclean stop of that guest leaves
/// the storage file system to its journal, as after any unclean stop. A boot that recorded
/// its boot id (and so may have started the engine) is [`after_engine_loss`] instead.
fn after_guestless_boot(owner: &Owner) -> bool {
    AFTER_GUESTLESS_BOOT.contains(&owner.phase.as_str())
        && owner.guest_boot_id.is_none()
        && !owner
            .previous_guest_boot_id
            .as_deref()
            .is_none_or(str::is_empty)
}

/// Unclean stopped phases of a boot that recorded its guest boot id: `runtime recover` after
/// the provider exited or the guest stopped answering (`recovered-unclean`), or a boot whose
/// engine failed to start (`stopped-after-engine-failure`).
const AFTER_ENGINE_LOSS: [&str; 2] = ["recovered-unclean", "stopped-after-engine-failure"];

/// A pool whose provider ended uncleanly in a boot that recorded its guest boot id, so its
/// engine may have run (HACK-2730). The common case: `hack down` stopped the run with its data
/// retained while the pool kept running, then the provider died (killed, crashed, or the
/// machine restarted) before the pool went idle, and `runtime recover` recorded the pool
/// `recovered-unclean` with that boot's id. The receipt is still the acknowledged retained
/// stop, which [`checked`] requires: the engine acknowledged removing every container and
/// network of the run, and a later engine changes the run's resources only through this
/// run's own graph operations, which leave that receipt (or a pending journal beside it,
/// also refused) first. So what an engine did after the stop did not touch this run.
///
/// The receipt does not prove that the removal is durable. A cleanup now flushes the guest
/// disk before it records the removal (HACK-2719), but a receipt written by an older build,
/// or a lost-removal repair that ended before its storage barrier, does not carry that
/// proof: the provider may have died before the removal reached the disk, and the next boot
/// can list the run's containers again, stopped. [`checked`] refuses the unfinished repair
/// (`graph_lost_removal_pending`). Otherwise the boot goes ahead, and the live checks after
/// it (restore, and the CLI's confirmation of the resumed graph) find the containers
/// present and refuse; the CLI names `hack down --recover`, which removes them again on
/// the running pool with data kept, then `hack up`. Anything the engine did not finish
/// writing is left to the storage journal, as after any unclean stop, and restore still
/// checks the volumes' recorded identities.
///
/// The recorded provider must be present and proven gone ([`checked`]): a record without one
/// is not this shape. The guard's other identity checks (disks, rootfs, token, registry)
/// apply as for a clean stop.
fn after_engine_loss(owner: &Owner) -> bool {
    AFTER_ENGINE_LOSS.contains(&owner.phase.as_str())
        && has_boot_id(owner)
        && owner.process.is_some()
}

/// What only a replacement of this run's pool changes: the owner token and machine, HOME
/// alias, disks, root files, profile, socket layout, and this run's own project share (the
/// pool's entry for the root the receipt's shared source names, or none). A replacement
/// owner, token, disk or root file, or a changed or removed share of this run, differs here.
///
/// Left out, so that a change to them with the same receipt is [`pool_changed`]: the phase,
/// the provider process, the boot ids, the engine's identity, the clean-stop marker and the
/// per-boot settings (`reclamation`, `hot_reload`), which `Owner::begin_boot` and a stop
/// rewrite; and what another project's commands may change on the same pool: its own
/// project shares, the network intent, the bridge and dependency socket capacity and the
/// translation setting. The selection taken again then binds them, and `runtime up` still
/// checks this start's own request against them under the lease (`StartRequest::check`).
fn stable_identity<'a>(owner: &'a Owner, receipt: &'a Receipt) -> impl serde::Serialize + 'a {
    let own_share = receipt
        .source
        .as_ref()
        .and_then(|source| source.shared.as_ref())
        .map(|share| owner.project_share_for(&share.project));
    (
        (
            &owner.version,
            &owner.checkout,
            &owner.token,
            &owner.machine,
            &owner.short_home,
            &owner.created,
            &owner.storage,
            &owner.overlay,
            &owner.rootfs_digest,
        ),
        (&owner.profile, &owner.socket_layout, own_share),
    )
}

fn digest(value: &impl serde::Serialize) -> Result<String, CandidateError> {
    let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    Ok(format!("{:x}", crate::Hex(Sha256::digest(bytes))))
}

/// The selection a retained start is bound to: 64 hex digits, the first 32 of a digest of
/// the pool's [`stable_identity`] and the receipt, then the first 32 of a digest of the whole
/// pool record and the receipt. Any change to either refuses the start. Only a change to
/// the pool record outside its stable identity, with the same receipt, is
/// [`pool_changed`]: another start booted (or stopped) this same pool in between.
fn selection(owner: &Owner, receipt: &Receipt) -> Result<String, CandidateError> {
    let stable = digest(&(
        "hack-retained-startup-stable-v2",
        stable_identity(owner, receipt),
        receipt,
    ))?;
    let whole = digest(&("hack-retained-startup-v2", owner, receipt))?;
    Ok(format!("{}{}", &stable[..32], &whole[..32]))
}

/// The retained start's selection is stale only because the same pool booted or stopped, or
/// another project changed it, since it was taken (HACK-2732). The CLI takes the selection
/// again and retries once; the sentence is what a user sees when that retry meets another
/// change too, so it names the command to repeat.
fn pool_changed() -> CandidateError {
    error(
        "graph_retained_pool_changed",
        "Another project started, stopped or changed the native pool after this start checked its retained run; the run, its data and the pool's identity are unchanged and nothing was started. Retry hack up (or hack up -d).",
    )
}

/// Holds publication retirement across the provider's boot-effect boundary.
/// Acquisition never creates absent ownership state or repairs stale publications.
///
/// Eligibility and the selection are compared only under the startup lease
/// ([`Guard::verify`]): a concurrent start holds that lease for its whole boot, so a
/// pool it is booting is waited out, not refused (HACK-2732).
pub(in crate::provider) struct Guard {
    run: String,
    selection: String,
    retired: foreground::transport::Retired,
}
impl Guard {
    /// Retire the publication now, then check eligibility once under a brief startup
    /// lease, so a stale or ineligible selection refuses before any admission work.
    pub(in crate::provider) fn acquire(
        candidate: &Candidate,
        run: &str,
        expected: &str,
    ) -> Result<Self, CandidateError> {
        if !hex(expected, 64) {
            return Err(refused());
        }
        let retired = foreground::transport::Retired::acquire(candidate, run)?
            .ok_or_else(|| published_owner_refused(candidate, run))?;
        let guard = Self {
            run: run.into(),
            selection: expected.into(),
            retired,
        };
        // The pool's existing lease only: a retained start needs an owned pool, so a
        // missing lock file refuses here instead of being created.
        let lease = state::Lock::acquire_existing_waiting(
            &candidate.state_root.join("run/smolvm"),
            lifecycle::START_LEASE_WAIT,
        )?;
        guard.verify(candidate, &lease)?;
        Ok(guard)
    }
    /// Recheck eligibility and the exact selection under `lease`, the startup lease of
    /// this pool that the caller holds.
    pub(in crate::provider) fn verify(
        &self,
        candidate: &Candidate,
        lease: &state::Lock,
    ) -> Result<(), CandidateError> {
        lease.verify_path(&candidate.state_root.join("run/smolvm"))?;
        self.retired.verify()?;
        let (owner, receipt) = checked(candidate, &self.run)?;
        let selected = selection(&owner, &receipt)?;
        if selected != self.selection {
            return Err(if selected[..32] == self.selection[..32] {
                pool_changed()
            } else {
                refused()
            });
        }
        self.retired.verify()
    }
}

/// Eligibility only: no guest connection, live resource observations, environment
/// values or restore authority are returned. An absent/uncertain owner refuses.
pub fn preflight(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let retired = foreground::transport::Retired::acquire(candidate, run)?
        .ok_or_else(|| published_owner_refused(candidate, run))?;
    // Eligibility is read-only, but read under the lease: wait out a holder such as the
    // inspection behind `hack ps`, another project's stop (HACK-2724) or another start's
    // boot (HACK-2732), as runtime startup does, rather than failing the `up` that asked.
    let pool = candidate.state_root.join("run/smolvm");
    let lease = state::Lock::acquire_existing_waiting(&pool, lifecycle::START_LEASE_WAIT)?;
    lease.verify_path(&pool)?;
    retired.verify()?;
    let (owner, receipt) = checked(candidate, run)?;
    let selected = selection(&owner, &receipt)?;
    retired.verify()?;
    Ok(
        json!({"version":1,"run":receipt.run,"owner":receipt.owner,"namespace":receipt.namespace,
        "plan":receipt.plan_id,"runtime_phase":owner.phase,"selection":selected,
        "live_resources_verified":false}),
    )
}

#[cfg(test)]
pub(in crate::provider::graph) mod tests {
    use super::*;
    use crate::owned_tmp_root::OwnedTmpRoot;
    use std::os::unix::fs::symlink;

    /// A stopped clean owned runtime with one acknowledged retained run whose
    /// previous foreground publication was retired.
    ///
    /// Dropping it removes the runtime-home aliases first, then (as fields drop) the
    /// checkout and this run's foreground owner root.
    pub(in crate::provider::graph) struct Fixture {
        pub(in crate::provider::graph) root: super::super::tests::Fixture,
        pub(in crate::provider::graph) candidate: Candidate,
        pub(in crate::provider::graph) run: String,
        aliases: Vec<PathBuf>,
        /// Held only for its `Drop`.
        _publication: OwnedTmpRoot,
    }
    impl Fixture {
        pub(in crate::provider::graph) fn new() -> Self {
            let root = super::super::tests::Fixture::new();
            let candidate = Candidate::discover(&root.0).unwrap();
            let mut owner = Owner::create(
                &candidate,
                super::super::super::Profile::Development,
                None,
                super::super::super::NetworkIntent::Isolated,
            )
            .unwrap();
            let alias = owner.short_home.clone();
            drop(state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
            let data = owner.real_data_dir(&candidate).unwrap();
            state::private_directory(&data).unwrap();
            for name in ["storage.raw", "overlay.raw"] {
                let mut bytes = vec![0; 4096];
                bytes[1080..1082].copy_from_slice(&[0x53, 0xef]);
                bytes[1128..1144].copy_from_slice(&[7; 16]);
                fs::write(data.join(name), bytes).unwrap();
            }
            fs::write(data.join("name"), &owner.machine).unwrap();
            owner.storage = Some(identity::disk(&data.join("storage.raw")).unwrap());
            owner.overlay = Some(identity::disk(&data.join("overlay.raw")).unwrap());
            let runtime = candidate.state_root.join("run/smolvm");
            let rootfs = runtime.join("rootfs");
            state::private_directory(&rootfs).unwrap();
            fs::write(rootfs.join("public-base"), b"synthetic pinned base").unwrap();
            owner.rootfs_digest =
                Some(crate::provider::artifact::rootfs_digest(&rootfs, None).unwrap());
            let templates = runtime.join("home/.smolvm");
            state::private_directory(&templates).unwrap();
            let artifacts = crate::provider::artifact::root(&candidate);
            state::private_directory(&artifacts).unwrap();
            for name in ["storage-template.ext4.zst", "overlay-template.ext4.zst"] {
                fs::write(templates.join(name), b"synthetic template").unwrap();
                fs::write(artifacts.join(name), b"synthetic template").unwrap();
            }
            owner.created = true;
            owner.phase = "stopped".into();
            owner.guest_boot_id = Some("11111111-1111-1111-1111-111111111111".into());
            owner.process = Some(identity::ProcessIdentity {
                pid: 2_000_000,
                start_micros: 1,
                uid: unsafe { libc::geteuid() },
                executable: PathBuf::from("/fixture/provider"),
            });
            owner.save(&candidate).unwrap();
            let run = "a".repeat(32);
            let publication =
                OwnedTmpRoot::new(foreground::transport::root(&candidate, &run).unwrap());
            state::private_directory(&publication).unwrap();
            drop(state::Lock::acquire(&publication).unwrap());
            let graph = directory(&candidate, &run).unwrap();
            state::private_directory(&graph).unwrap();
            let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":run,"owner":owner.token,
                "namespace":"b".repeat(64),"plan_id":"c".repeat(64),"phase":"stopped-data-retained",
                "normalized_input":{"namespace":"b".repeat(64),"original_compose_sha256":"d".repeat(64),"normalized_compose_sha256":"e".repeat(64)},
                "readiness":{"web":"started"},"resources":{
                    "container:web":{"kind":"container","key":"web","name":format!("hkg-{run}-container-0"),"id":"f".repeat(64),"image":format!("sha256:{}", "f".repeat(64)),"phase":"absent"},
                    "volume:data":{"kind":"volume","key":"data","name":format!("hkg-{run}-volume-0"),"id":null,"image":null,"phase":"created"}
                }})).unwrap();
            state::write(&graph.join("state.json"), &receipt).unwrap();
            Self {
                root,
                candidate,
                run,
                aliases: vec![alias],
                _publication: publication,
            }
        }
        pub(in crate::provider::graph) fn graph(&self) -> PathBuf {
            directory(&self.candidate, &self.run).unwrap()
        }
        pub(in crate::provider::graph) fn receipt(&self) -> Receipt {
            state::read(&self.graph().join("state.json")).unwrap()
        }
        fn replace_owner(&mut self) {
            let mut owner = Owner::load(&self.candidate).unwrap();
            // Unique token for the fixture avoids aliasing any global/runtime state.
            let unique = format!(
                "{:x}",
                crate::Hex(Sha256::digest(self.root.0.as_os_str().as_encoded_bytes()))
            );
            owner.token = unique[..32].into();
            owner.machine = format!("hack-{}", &owner.token[..12]);
            owner.short_home =
                Path::new("/private/tmp").join(format!("hkl-{}", &owner.token[..12]));
            symlink(
                self.candidate.state_root.join("run/smolvm/home"),
                &owner.short_home,
            )
            .unwrap();
            self.aliases.push(owner.short_home.clone());
            let data = owner.real_data_dir(&self.candidate).unwrap();
            state::private_directory(&data).unwrap();
            let old = Owner::load(&self.candidate)
                .unwrap()
                .real_data_dir(&self.candidate)
                .unwrap();
            for name in ["storage.raw", "overlay.raw"] {
                fs::copy(old.join(name), data.join(name)).unwrap();
            }
            owner.storage = Some(identity::disk(&data.join("storage.raw")).unwrap());
            owner.overlay = Some(identity::disk(&data.join("overlay.raw")).unwrap());
            fs::write(data.join("name"), &owner.machine).unwrap();
            owner.save(&self.candidate).unwrap();
            let mut receipt = self.receipt();
            receipt.owner = owner.token;
            state::write(&self.graph().join("state.json"), &receipt).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for alias in &self.aliases {
                let _ = fs::remove_file(alias);
            }
        }
    }

    #[test]
    fn a_running_pools_rootfs_witness_skips_the_content_proof_only_while_it_holds() {
        use crate::provider::{artifact, tree_witness};
        // Qualified filesystem at the statfs boundary (the runner's temp volume may not be).
        tree_witness::fake_filesystem_type(Some("apfs"));
        let fixture = Fixture::new();
        let candidate = &fixture.candidate;
        let mut owner = Owner::load(candidate).unwrap();
        let rootfs = candidate.state_root.join("run/smolvm/rootfs");
        // Retained witnesses require both prepared provider trees as well as the rootfs.
        // This fixture otherwise has SmolVM's templates and a synthetic guest base,
        // but no engine tree.
        let provider_trees = [
            artifact::tree_root(candidate, &artifact::SMOLVM),
            artifact::tree_root(candidate, &artifact::ENGINE),
        ];
        for tree in &provider_trees {
            state::private_directory(tree).unwrap();
            fs::write(tree.join("fixture"), b"synthetic provider").unwrap();
        }
        assert!(lifecycle::witness_qualified(candidate));
        let marker = lifecycle::rootfs_marker(&owner).unwrap();
        let proofs = |owner: &Owner| {
            let before = tree_witness::content_proofs();
            let result = lifecycle::verify_retained_rootfs(candidate, owner);
            (result, tree_witness::content_proofs() - before)
        };
        // Stopped, or running without a witness: proven by content.
        assert_eq!(proofs(&owner).1, 1);
        owner.phase = "running".into();
        let (result, count) = proofs(&owner);
        result.unwrap();
        assert_eq!(count, 1);
        // A witness of this provider for this rootfs and pin: nothing is hashed.
        let lease = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        tree_witness::record(
            candidate,
            &lease,
            owner.process.as_ref().unwrap(),
            std::collections::BTreeMap::from([(
                tree_witness::ROOTFS.to_owned(),
                tree_witness::Proven {
                    metadata: tree_witness::metadata_digest(&rootfs, Some(&marker)).unwrap(),
                    content: owner.rootfs_digest.clone().unwrap(),
                },
            )]),
        )
        .unwrap();
        drop(lease);
        let (result, count) = proofs(&owner);
        result.unwrap();
        assert_eq!(count, 0);
        // Missing SmolVM templates refuse before the rootfs check. A missing engine
        // tree disables its witness and requires a content proof of the unchanged rootfs.
        for (tree, expected, expected_proofs) in [
            (&provider_trees[0], Err("provider_state"), 0),
            (&provider_trees[1], Ok(()), 1),
        ] {
            let held = tree.with_extension("held");
            fs::rename(tree, &held).unwrap();
            assert!(!lifecycle::witness_qualified(candidate));
            let (result, count) = proofs(&owner);
            assert_eq!(result.map_err(|error| error.code), expected);
            assert_eq!(count, expected_proofs);
            fs::rename(held, tree).unwrap();
            let (result, count) = proofs(&owner);
            result.unwrap();
            assert_eq!(count, 0);
        }
        // A stopped pool never uses the witness.
        let mut stopped = owner.clone();
        stopped.phase = "stopped".into();
        assert_eq!(proofs(&stopped).1, 1);
        // Another pin, or a changed file, goes back to the content proof, which refuses.
        let mut repinned = owner.clone();
        repinned.rootfs_digest = Some("0".repeat(64));
        let (result, count) = proofs(&repinned);
        assert_eq!(
            (result.unwrap_err().code, count),
            ("artifact_digest_mismatch", 1)
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(rootfs.join("public-base"), b"changed base!!!!!!!!!").unwrap();
        let (result, count) = proofs(&owner);
        assert_eq!(
            (result.unwrap_err().code, count),
            ("artifact_digest_mismatch", 1)
        );
    }
    #[test]
    fn stopped_preflight_returns_only_eligibility_without_guest_or_state_effects() {
        let fixture = Fixture::new();
        let owner_path = fixture.candidate.state_root.join("run/smolvm/owner.json");
        let before = fs::read(&owner_path).unwrap();
        let receipt = fs::read(fixture.graph().join("state.json")).unwrap();
        let value = preflight(&fixture.candidate, &fixture.run).unwrap();
        assert_eq!(value["runtime_phase"], "stopped");
        assert_eq!(value["live_resources_verified"], false);
        assert!(value.get("observations").is_none());
        assert!(value.get("generation").is_none());
        assert_eq!(fs::read(owner_path).unwrap(), before);
        assert_eq!(
            fs::read(fixture.graph().join("state.json")).unwrap(),
            receipt
        );
        assert!(hex(value["selection"].as_str().unwrap(), 64));
    }
    #[test]
    fn a_later_boot_that_never_started_a_guest_keeps_the_retained_run_startable() {
        // The shape of both kept homes in HACK-2376: the retained run was stopped cleanly in
        // boot P; a later boot failed before it recorded a guest boot id, so before the engine.
        let after_failed_boot = |owner: &mut Owner, phase: &str| {
            owner.phase = phase.into();
            owner.previous_guest_boot_id = owner.guest_boot_id.take();
        };
        for (phase, keep_process) in [
            ("recovered-unclean", true),
            ("stopped-before-engine", false),
            ("stopped-after-engine-failure", true),
            // A later start refused at boot admission, after one of the above.
            ("stopped", false),
            ("stopped", true),
        ] {
            let fixture = Fixture::new();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            after_failed_boot(&mut owner, phase);
            if !keep_process {
                owner.process = None;
            }
            owner.save(&fixture.candidate).unwrap();
            let value = preflight(&fixture.candidate, &fixture.run).unwrap();
            assert_eq!(value["runtime_phase"], phase, "{phase}");
            assert!(hex(value["selection"].as_str().unwrap(), 64), "{phase}");
        }
        // Still refused: the failed boot not yet recovered, no previous boot, and a live
        // recorded provider. A failed boot that recorded its boot id (so may have started
        // the engine) is the engine-loss shape, accepted only with its provider recorded
        // and gone (`a_provider_lost_after_a_retained_stop_keeps_the_run_startable`).
        for case in ["failed-boot-stopped", "no-previous", "live-pid"] {
            let fixture = Fixture::new();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            after_failed_boot(&mut owner, "recovered-unclean");
            match case {
                "failed-boot-stopped" => owner.phase = "failed-boot-stopped".into(),
                "no-previous" => owner.previous_guest_boot_id = None,
                _ => {
                    owner.process = Some(identity::observe(std::process::id() as i32).unwrap());
                }
            }
            owner.save(&fixture.candidate).unwrap();
            let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
            assert_eq!(error.code, "graph_retained_startup", "{case}");
            if case == "failed-boot-stopped" {
                assert!(
                    error.message.contains("hack native recover"),
                    "{}",
                    error.message
                );
            }
        }
    }

    #[test]
    fn uncertain_graph_or_owned_runtime_refuses_offline_preflight() {
        for mutation in [
            "dirty",
            "compute",
            "booting",
            "engine-loss-no-process",
            "ack",
            "owner",
            "disk",
            "pending-job",
            "absent-owner",
            "owner-pending",
            "rootfs-pin",
            "rootfs-missing",
            "template-missing",
            "live-pid",
        ] {
            let fixture = Fixture::new();
            let selected = preflight(&fixture.candidate, &fixture.run).unwrap();
            let mut receipt = fixture.receipt();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            match mutation {
                "dirty" => fs::write(fixture.graph().join("state.pending"), b"pending").unwrap(),
                "compute" => {
                    receipt.resources.get_mut("container:web").unwrap().phase = "started".into();
                }
                // A pool that is booting is never retained-startable: a concurrent start
                // holds the lease across its boot, so this is a boot that did not finish.
                "booting" => {
                    owner.phase = "booting".into();
                    owner.save(&fixture.candidate).unwrap();
                }
                // An unclean stop of a boot with its id but no recorded provider.
                "engine-loss-no-process" => {
                    owner.phase = "recovered-unclean".into();
                    owner.process = None;
                    owner.save(&fixture.candidate).unwrap();
                }
                "ack" => {
                    receipt.relay_cleanup = Some(serde_json::from_value(json!({"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/fixture","phase":"pending"})).unwrap());
                }
                "owner" => {
                    receipt.owner = "8".repeat(32);
                }
                "disk" => fs::write(
                    owner
                        .real_data_dir(&fixture.candidate)
                        .unwrap()
                        .join("storage.raw"),
                    b"replacement",
                )
                .unwrap(),
                "pending-job" => {
                    fs::write(fixture.graph().join("one-off.json"), b"pending").unwrap()
                }
                "absent-owner" => {
                    fs::remove_file(fixture.candidate.state_root.join("run/smolvm/owner.json"))
                        .unwrap()
                }
                "owner-pending" => fs::write(
                    fixture
                        .candidate
                        .state_root
                        .join("run/smolvm/owner.pending"),
                    b"pending",
                )
                .unwrap(),
                "rootfs-pin" => {
                    owner.rootfs_digest = None;
                    owner.save(&fixture.candidate).unwrap();
                }
                "rootfs-missing" => {
                    fs::remove_dir_all(fixture.candidate.state_root.join("run/smolvm/rootfs"))
                        .unwrap()
                }
                "template-missing" => fs::remove_file(
                    fixture
                        .candidate
                        .state_root
                        .join("run/smolvm")
                        .join("home")
                        .join(".smolvm/storage-template.ext4.zst"),
                )
                .unwrap(),
                "live-pid" => {
                    owner.process = Some(identity::observe(std::process::id() as i32).unwrap());
                    owner.save(&fixture.candidate).unwrap();
                }
                _ => unreachable!(),
            }
            if mutation != "dirty" {
                state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
            }
            assert!(
                preflight(&fixture.candidate, &fixture.run).is_err(),
                "{mutation}"
            );
            assert!(
                lifecycle::up_with_retained_project_share(
                    &fixture.candidate,
                    super::super::super::Profile::Development,
                    None,
                    None,
                    None,
                    None,
                    (&fixture.run, selected["selection"].as_str().unwrap())
                )
                .is_err(),
                "{mutation}"
            );
            assert!(
                !fixture
                    .candidate
                    .state_root
                    .join("run/smolvm/admission.json")
                    .exists()
            );
            if mutation == "rootfs-missing" {
                assert!(
                    !fixture
                        .candidate
                        .state_root
                        .join("run/smolvm/rootfs")
                        .exists()
                );
            }
            if mutation == "template-missing" {
                assert!(
                    !fixture
                        .candidate
                        .state_root
                        .join("run/smolvm")
                        .join("home")
                        .join(".smolvm/storage-template.ext4.zst")
                        .exists()
                );
            }
        }
    }
    #[test]
    fn occupied_or_missing_retirement_publication_refuses() {
        for name in ["owner.json", "control.sock", "operation.lock"] {
            let fixture = Fixture::new();
            // owner-root: path-only
            let root = foreground::transport::root(&fixture.candidate, &fixture.run).unwrap();
            if name == "operation.lock" {
                fs::remove_file(root.join(name)).unwrap();
            } else {
                fs::write(root.join(name), b"occupied").unwrap();
            }
            assert!(
                preflight(&fixture.candidate, &fixture.run).is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn a_remaining_publication_names_its_owner_state_without_effects() {
        let state = |fixture: &Fixture| {
            let owner = fixture.candidate.state_root.join("run/smolvm/owner.json");
            (
                fs::read(owner).unwrap(),
                fs::read(fixture.graph().join("state.json")).unwrap(),
            )
        };
        let refusal = |fixture: &Fixture| {
            let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
            assert!(
                !fixture
                    .candidate
                    .state_root
                    .join("run/smolvm/admission.json")
                    .exists()
            );
            error.code
        };
        // A live foreground owner (this process) still holds the run.
        let fixture = Fixture::new();
        let live =
            foreground::transport::fixture_live_publication(&fixture.candidate, &fixture.run);
        let before = state(&fixture);
        assert_eq!(refusal(&fixture), "graph_foreground_owner_running");
        assert_eq!(state(&fixture), before);
        drop(live);
        // An owner that exited before its restore was admitted: the receipt is the
        // unchanged stopped one, so the refusal names `hack down --recover`.
        let fixture = Fixture::new();
        foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
        let before = state(&fixture);
        let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
        assert_eq!(error.code, "graph_foreground_owner_exited_unadmitted");
        assert!(error.message.contains("hack down --recover"));
        assert_eq!(state(&fixture), before);
        // An exited owner whose receipt left the retained stop (it was admitted and
        // then failed) is still named, but no recovery is claimed for it.
        let fixture = Fixture::new();
        let mut receipt = fixture.receipt();
        receipt.phase = "failed-retained".into();
        state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
        foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
        let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
        assert_eq!(error.code, "graph_foreground_owner_exited_unadmitted");
        assert!(!error.message.contains("hack down --recover"));
        // HACK-2714: the same failed start with a settled relay startup is what the
        // cross-boot dead-owner recovery retires, so the refusal names it, then up.
        let fixture = Fixture::new();
        let mut receipt = fixture.receipt();
        receipt.phase = "failed-retained".into();
        receipt.relay_startup = Some(
            serde_json::from_value(json!({"control_only":true,"guest_root":null,
                "control_root":"/private/owned","artifact":"e".repeat(64),"services":{}}))
            .unwrap(),
        );
        state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
        foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
        let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
        assert_eq!(error.code, "graph_foreground_owner_exited_unadmitted");
        assert!(error.message.contains("hack down --recover"));
        assert!(error.message.contains("then hack up"));
        // An owner that is ending (a publication that cannot be classified for a
        // moment) has its own code, which a caller may wait on.
        let fixture = Fixture::new();
        foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
        let owner = fixture._publication.join("owner.json");
        fs::write(&owner, b"{").unwrap();
        let before = state(&fixture);
        assert_eq!(refusal(&fixture), "graph_foreground_owner_uncertain");
        assert_eq!(state(&fixture), before);
        // An owner that exited while its graph was ready names `hack down --recover`.
        let fixture = Fixture::new();
        let mut receipt = fixture.receipt();
        receipt.phase = "ready-observed".into();
        state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
        foreground::transport::fixture_exited_publication(&fixture.candidate, &fixture.run);
        let before = state(&fixture);
        let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
        assert_eq!(error.code, "graph_foreground_owner_exited");
        assert!(error.message.contains("hack down --recover"));
        assert_eq!(state(&fixture), before);
    }

    #[test]
    fn an_unfinished_lost_removal_repair_refuses_up_naming_down_recover() {
        // Round-3 review of #1273: its own code and the command that finishes it.
        let fixture = Fixture::new();
        state::write(
            &fixture.graph().join(super::super::LOST_REMOVAL_REPAIR),
            &json!({"version":1}),
        )
        .unwrap();
        let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
        assert_eq!(error.code, "graph_lost_removal_pending");
        assert!(error.message.contains("hack down --recover"));
        assert!(error.message.contains("then hack up"));
        std::fs::remove_file(fixture.graph().join(super::super::LOST_REMOVAL_REPAIR)).unwrap();
        preflight(&fixture.candidate, &fixture.run).unwrap();
    }

    #[test]
    fn preflight_waits_out_a_brief_provider_lease_holder() {
        let fixture = Fixture::new();
        let held = state::Lock::acquire_existing(&fixture.candidate.state_root.join("run/smolvm"))
            .unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            drop(held);
        });
        let started = std::time::Instant::now();
        let value = preflight(&fixture.candidate, &fixture.run).unwrap();
        worker.join().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        assert_eq!(value["runtime_phase"], "stopped");
    }

    /// The startup lease of the fixture's pool, as a start holds it.
    fn lease(fixture: &Fixture) -> state::Lock {
        lifecycle::startup_lease(
            &fixture.candidate.state_root.join("run/smolvm"),
            lifecycle::START_LEASE_WAIT,
        )
        .unwrap()
    }

    fn start_with(fixture: &Fixture, selection: &str) -> CandidateError {
        lifecycle::up_with_retained_project_share(
            &fixture.candidate,
            super::super::super::Profile::Development,
            None,
            None,
            None,
            None,
            (&fixture.run, selection),
        )
        .unwrap_err()
    }

    fn no_admission(fixture: &Fixture) -> bool {
        !fixture
            .candidate
            .state_root
            .join("run/smolvm/admission.json")
            .exists()
    }

    /// What another start's boot of the same pool leaves in its record: a new boot,
    /// provider and engine, and no clean-stop marker of the boot the selection saw.
    /// Nothing in the pool's stable identity changes.
    fn peer_boot(owner: &mut Owner, phase: &str) {
        owner.begin_boot();
        owner.guest_boot_id = Some("33333333-3333-3333-3333-333333333333".into());
        owner.daemon_pid = Some(42);
        owner.daemon_start = Some(7);
        let process = owner.process.as_mut().unwrap();
        process.pid += 1;
        process.start_micros += 1;
        owner.phase = phase.into();
    }

    #[test]
    fn preflight_selection_and_held_guard_refuse_a_valid_replacement_owner_before_up() {
        let mut fixture = Fixture::new();
        let value = preflight(&fixture.candidate, &fixture.run).unwrap();
        let selected = value["selection"].as_str().unwrap();
        let guard = Guard::acquire(&fixture.candidate, &fixture.run, selected).unwrap();
        let held = lease(&fixture);
        guard.verify(&fixture.candidate, &held).unwrap();
        fixture.replace_owner();
        // A replaced owner is not a changed pool: its token, machine and disks differ.
        assert_eq!(
            guard.verify(&fixture.candidate, &held).unwrap_err().code,
            "graph_retained_startup"
        );
        drop(held);
        drop(guard);
        let replacement = preflight(&fixture.candidate, &fixture.run).unwrap();
        assert_ne!(replacement["selection"], value["selection"]);
        let before = fs::read(fixture.candidate.state_root.join("run/smolvm/owner.json")).unwrap();
        assert_eq!(
            start_with(&fixture, selected).code,
            "graph_retained_startup"
        );
        assert_eq!(
            fs::read(fixture.candidate.state_root.join("run/smolvm/owner.json")).unwrap(),
            before
        );
        assert!(no_admission(&fixture));
    }

    #[test]
    fn a_changed_process_identity_at_the_effect_boundary_refuses_as_a_changed_pool() {
        // The selection still binds the whole pool record: a provider identity that
        // changed since the preflight refuses the start. With the same token, disks and
        // receipt that refusal is `graph_retained_pool_changed`, so the caller takes the
        // selection again instead of stopping (HACK-2732).
        let fixture = Fixture::new();
        let selected = preflight(&fixture.candidate, &fixture.run).unwrap();
        let selected = selected["selection"].as_str().unwrap().to_owned();
        let mut owner = Owner::load(&fixture.candidate).unwrap();
        let token = owner.token.clone();
        owner.process.as_mut().unwrap().start_micros += 1;
        owner.save(&fixture.candidate).unwrap();
        let now = preflight(&fixture.candidate, &fixture.run).unwrap();
        assert_eq!(now["owner"], token);
        let now = now["selection"].as_str().unwrap();
        assert_ne!(now, selected);
        assert_eq!(now[..32], selected[..32]);
        let failure = start_with(&fixture, &selected);
        assert_eq!(failure.code, "graph_retained_pool_changed");
        assert!(no_admission(&fixture));
    }

    #[test]
    fn a_start_selected_before_a_peer_boot_refuses_as_a_changed_pool_and_its_new_selection_holds() {
        for phase in [
            "stopped",
            "recovered-unclean",
            "stopped-after-engine-failure",
        ] {
            let fixture = Fixture::new();
            let before = preflight(&fixture.candidate, &fixture.run).unwrap();
            let before = before["selection"].as_str().unwrap().to_owned();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            peer_boot(&mut owner, phase);
            owner.save(&fixture.candidate).unwrap();
            let error = Guard::acquire(&fixture.candidate, &fixture.run, &before)
                .err()
                .unwrap();
            assert_eq!(error.code, "graph_retained_pool_changed", "{phase}");
            assert_eq!(
                start_with(&fixture, &before).code,
                "graph_retained_pool_changed"
            );
            assert!(no_admission(&fixture), "{phase}");
            let after = preflight(&fixture.candidate, &fixture.run).unwrap();
            let after = after["selection"].as_str().unwrap();
            assert_eq!(after[..32], before[..32], "{phase}");
            let guard = Guard::acquire(&fixture.candidate, &fixture.run, after).unwrap();
            guard.verify(&fixture.candidate, &lease(&fixture)).unwrap();
        }
    }

    /// An approved unfiltered share of `project` in the owner's layout.
    fn share(owner: &Owner, project: &str) -> super::super::super::ProjectShareIntent {
        let digest = format!("{:x}", crate::Hex(Sha256::digest(project.as_bytes())));
        super::super::super::ProjectShareIntent {
            project: PathBuf::from(project),
            guest_path: owner.socket_layout.project(&digest),
            device: 1,
            inode: 2,
            unfiltered_source: true,
        }
    }

    /// Make the fixture's run a shared-source run of the pool's primary share.
    fn share_run(fixture: &Fixture) {
        let mut owner = Owner::load(&fixture.candidate).unwrap();
        let own = share(&owner, "/fixture/project-a");
        owner.project_share = Some(own.clone());
        owner.save(&fixture.candidate).unwrap();
        let mut receipt = fixture.receipt();
        receipt.source = Some(super::super::source::SourceBinding {
            cache_scope: None,
            shared: Some(own),
            shared_contract: None,
            live: None,
            revision: "1".repeat(64),
            archive_sha256: "2".repeat(64),
            selection_sha256: "3".repeat(64),
        });
        state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
    }

    #[test]
    fn a_peer_projects_pool_change_is_a_changed_pool_that_a_new_selection_accepts() {
        // Another project's commands may change the shared pool without touching this
        // run: add its own project share (which stops an idle pool), change the network
        // intent or enable translation. The retained start selects again and retries
        // instead of refusing; its own request is still checked against the pool under
        // the lease. (Bridge capacity is not a peer change: an existing pool keeps its
        // exact durable capacity, and a change needs the bridge registry rewritten.)
        for case in ["peer-share", "network", "emulation"] {
            let fixture = Fixture::new();
            share_run(&fixture);
            let before = preflight(&fixture.candidate, &fixture.run).unwrap();
            let before = before["selection"].as_str().unwrap().to_owned();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            peer_boot(&mut owner, "stopped");
            match case {
                "peer-share" => {
                    let peer = share(&owner, "/fixture/project-b");
                    owner.additional_project_shares.push(peer);
                }
                "network" => owner.network = super::super::super::NetworkIntent::Internet,
                _ => owner.amd64_emulation = true,
            }
            owner.save(&fixture.candidate).unwrap();
            let error = Guard::acquire(&fixture.candidate, &fixture.run, &before)
                .err()
                .unwrap();
            assert_eq!(error.code, "graph_retained_pool_changed", "{case}");
            let after = preflight(&fixture.candidate, &fixture.run).unwrap();
            let after = after["selection"].as_str().unwrap();
            assert_eq!(after[..32], before[..32], "{case}");
            let guard = Guard::acquire(&fixture.candidate, &fixture.run, after).unwrap();
            guard.verify(&fixture.candidate, &lease(&fixture)).unwrap();
        }
    }

    #[test]
    fn a_changed_identity_of_this_runs_pool_still_refuses_and_is_never_a_changed_pool() {
        for case in [
            "own-share",
            "own-share-removed",
            "disk",
            "rootfs",
            "receipt",
            "token",
        ] {
            let mut fixture = Fixture::new();
            share_run(&fixture);
            let before = preflight(&fixture.candidate, &fixture.run).unwrap();
            let before = before["selection"].as_str().unwrap().to_owned();
            if case == "token" {
                // A valid replacement owner (token, machine, HOME alias and disks).
                fixture.replace_owner();
            }
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            peer_boot(&mut owner, "stopped");
            match case {
                // This run's own share now names another directory identity.
                "own-share" => owner.project_share.as_mut().unwrap().inode += 1,
                "own-share-removed" => {
                    // The run's root is no longer the pool's share; another one is.
                    owner.project_share = Some(share(&owner, "/fixture/project-b"));
                }
                // A replaced storage disk whose record was updated to match it.
                "disk" => {
                    let data = owner.real_data_dir(&fixture.candidate).unwrap();
                    let path = data.join("storage.raw");
                    let bytes = fs::read(&path).unwrap();
                    fs::remove_file(&path).unwrap();
                    fs::write(&path, bytes).unwrap();
                    owner.storage = Some(identity::disk(&path).unwrap());
                }
                // Changed root files whose recorded digest was updated to match them.
                "rootfs" => {
                    let rootfs = fixture.candidate.state_root.join("run/smolvm/rootfs");
                    fs::write(rootfs.join("public-base"), b"another pinned base").unwrap();
                    owner.rootfs_digest =
                        Some(crate::provider::artifact::rootfs_digest(&rootfs, None).unwrap());
                }
                "receipt" => {
                    let mut receipt = fixture.receipt();
                    receipt.plan_id = "9".repeat(64);
                    state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
                }
                _ => {}
            }
            owner.save(&fixture.candidate).unwrap();
            // Where the current state is eligible, only the selection binds the change.
            if let Ok(after) = preflight(&fixture.candidate, &fixture.run) {
                assert_ne!(
                    after["selection"].as_str().unwrap()[..32],
                    before[..32],
                    "{case}"
                );
            }
            let error = Guard::acquire(&fixture.candidate, &fixture.run, &before)
                .err()
                .unwrap();
            assert_eq!(error.code, "graph_retained_startup", "{case}");
            assert_eq!(
                start_with(&fixture, &before).code,
                "graph_retained_startup",
                "{case}"
            );
            assert!(no_admission(&fixture), "{case}");
        }
    }

    #[test]
    fn preflight_and_the_guard_wait_out_a_peer_boot_instead_of_refusing_it() {
        // HACK-2732: another project's start holds the startup lease for its whole boot,
        // with the pool record `booting` and, while it writes the record, `owner.pending`.
        // Unleased, that state refuses. Under the lease it is never seen: the read waits
        // for the boot to end and then checks what it left.
        for check in ["preflight", "guard"] {
            let fixture = Fixture::new();
            let selected = preflight(&fixture.candidate, &fixture.run).unwrap();
            let selected = selected["selection"].as_str().unwrap().to_owned();
            let held = lease(&fixture);
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            let pending = fixture
                .candidate
                .state_root
                .join("run/smolvm/owner.pending");
            peer_boot(&mut owner, "booting");
            owner.save(&fixture.candidate).unwrap();
            fs::write(&pending, b"{}").unwrap();
            // The old order: eligibility read before the lease refuses the peer's boot.
            assert_eq!(
                checked(&fixture.candidate, &fixture.run).unwrap_err().code,
                "graph_retained_startup"
            );
            fs::remove_file(&pending).unwrap();
            assert_eq!(
                checked(&fixture.candidate, &fixture.run).unwrap_err().code,
                "graph_retained_startup"
            );
            let candidate = &fixture.candidate;
            let started = std::time::Instant::now();
            std::thread::scope(|scope| {
                scope.spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    // The peer's boot stopped again (a refused boot admission records
                    // `stopped`), then released the lease.
                    owner.phase = "stopped".into();
                    owner.save(candidate).unwrap();
                    drop(held);
                });
                if check == "preflight" {
                    let value = preflight(candidate, &fixture.run).unwrap();
                    assert_eq!(value["runtime_phase"], "stopped");
                    let now = value["selection"].as_str().unwrap();
                    assert_eq!(now[..32], selected[..32]);
                    assert_ne!(now, selected);
                } else {
                    let error = Guard::acquire(candidate, &fixture.run, &selected)
                        .err()
                        .unwrap();
                    assert_eq!(error.code, "graph_retained_pool_changed");
                }
            });
            assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        }
    }

    #[test]
    fn a_provider_lost_after_a_retained_stop_keeps_the_run_startable() {
        // HACK-2730: `hack down` stopped the run with data retained while the pool kept
        // running; the provider then died, and `runtime recover` recorded the pool
        // `recovered-unclean` with that boot's id and its dead provider. A boot whose engine
        // failed after recording its id leaves `stopped-after-engine-failure` the same way.
        let lost = |owner: &mut Owner, phase: &str, later_boot: bool| {
            if later_boot {
                owner.begin_boot();
                owner.guest_boot_id = Some("22222222-2222-2222-2222-222222222222".into());
            }
            owner.phase = phase.into();
        };
        for phase in ["recovered-unclean", "stopped-after-engine-failure"] {
            for later_boot in [false, true] {
                let fixture = Fixture::new();
                let mut owner = Owner::load(&fixture.candidate).unwrap();
                lost(&mut owner, phase, later_boot);
                owner.save(&fixture.candidate).unwrap();
                let value = preflight(&fixture.candidate, &fixture.run).unwrap();
                assert_eq!(value["runtime_phase"], phase, "{phase} {later_boot}");
                let selected = value["selection"].as_str().unwrap();
                let guard = Guard::acquire(&fixture.candidate, &fixture.run, selected).unwrap();
                guard.verify(&fixture.candidate, &lease(&fixture)).unwrap();
            }
        }
        // Still refused: a live recorded provider, no recorded provider, a receipt that left
        // the retained stop (a restore in progress, a dirty receipt, a pending one-off), a
        // pending owner update, a pending share update, a boot that failed and was not yet
        // recovered, and an unclean stop with no boot id and no earlier boot.
        for case in [
            "live-pid",
            "no-process",
            "restoring",
            "state-pending",
            "one-off-pending",
            "owner-pending",
            "share-update-pending",
            "failed-boot-stopped",
            "no-boot",
        ] {
            let fixture = Fixture::new();
            let mut owner = Owner::load(&fixture.candidate).unwrap();
            lost(&mut owner, "recovered-unclean", false);
            let pool = fixture.candidate.state_root.join("run/smolvm");
            match case {
                "live-pid" => {
                    owner.process = Some(identity::observe(std::process::id() as i32).unwrap());
                }
                "no-process" => owner.process = None,
                "restoring" => {
                    let mut receipt = fixture.receipt();
                    receipt.phase = "restoring".into();
                    state::write(&fixture.graph().join("state.json"), &receipt).unwrap();
                }
                "state-pending" => {
                    fs::write(fixture.graph().join("state.pending"), b"pending").unwrap()
                }
                "one-off-pending" => {
                    fs::write(fixture.graph().join("one-off.pending"), b"pending").unwrap()
                }
                "owner-pending" => {}
                "share-update-pending" => {
                    fs::write(pool.join("share-update.pending"), b"pending").unwrap()
                }
                "failed-boot-stopped" => owner.phase = "failed-boot-stopped".into(),
                _ => {
                    owner.guest_boot_id = None;
                    owner.previous_guest_boot_id = None;
                }
            }
            owner.save(&fixture.candidate).unwrap();
            if case == "owner-pending" {
                fs::write(pool.join("owner.pending"), b"pending").unwrap();
            }
            let error = preflight(&fixture.candidate, &fixture.run).unwrap_err();
            let expected = if case == "share-update-pending" {
                "project_share_update"
            } else {
                "graph_retained_startup"
            };
            assert_eq!(error.code, expected, "{case}");
        }
    }
}
