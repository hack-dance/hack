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
            "Another foreground hack up or hack restart still owns this run. Stop it with Ctrl-C in its terminal, or run hack down, then start the project again.",
        ),
        Ok(PublishedOwner::Exited) if exited_ready(candidate, run) => error(
            "graph_foreground_owner_exited",
            "The previous foreground owner of this run exited while its services were running and did not retire its publication. Run hack down --recover to stop the orphaned services with data retained, then hack up.",
        ),
        Ok(PublishedOwner::Exited) if exited_unadmitted_retained(candidate, run) => error(
            "graph_foreground_owner_exited_unadmitted",
            "The previous foreground owner of this run exited before its restore was admitted and did not retire its publication. Data is retained. Run hack down --recover to retire that attempt, then hack up.",
        ),
        Ok(PublishedOwner::Exited) => error(
            "graph_foreground_owner_exited_unadmitted",
            "The previous foreground owner of this run exited before its start was confirmed and did not retire its publication. Data is retained, but no supported command can prove and retire that attempt yet; keep the native home unchanged for inspection.",
        ),
        _ => refused(),
    }
}
/// A ready graph, or a same-boot dead-owner recovery of one that was interrupted:
/// both are stopped by `hack down --recover`.
fn exited_ready(candidate: &Candidate, run: &str) -> bool {
    Owner::load(candidate)
        .ok()
        .and_then(|owner| load_at(directory(candidate, run).ok()?, run, &owner.token).ok())
        .is_some_and(|(receipt, root)| {
            receipt.phase == "ready-observed"
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

fn no_file(root: &Path, name: &str) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join(name)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}

/// Offline eligibility of a retained start, except the foreground publication:
/// a clean unchanged owned runtime and an acknowledged retained stop of `run`.
pub(in crate::provider::graph) fn checked(
    candidate: &Candidate,
    run: &str,
) -> Result<(Owner, Receipt), CandidateError> {
    no_file(&candidate.state_root.join("run/smolvm"), "owner.pending")?;
    let owner = Owner::load(candidate)?;
    if !owner.created
        || owner.profile != super::super::Profile::Development
        || owner.storage.is_none()
        || owner.overlay.is_none()
        || owner.guest_boot_id.as_deref().is_none_or(str::is_empty)
        || !matches!(owner.phase.as_str(), "running" | "stopped")
    {
        return Err(refused());
    }
    let process = owner.process.as_ref().ok_or_else(refused)?;
    if identity::alive(process.pid)? != (owner.phase == "running") {
        return Err(refused());
    }
    if owner.phase == "running" {
        lifecycle::verify_live(candidate, &owner)?;
    }
    lifecycle::verify_disks(candidate, &owner)?;
    lifecycle::verify_retained_rootfs(candidate, &owner)?;
    super::super::network_update::require_complete(candidate)?;
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

fn selection(owner: &Owner, receipt: &Receipt) -> Result<String, CandidateError> {
    let bytes =
        serde_json::to_vec(&("hack-retained-startup-v1", owner, receipt)).map_err(|_| refused())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Holds publication retirement across the provider's boot-effect boundary.
/// Acquisition never creates absent ownership state or repairs stale publications.
pub(in crate::provider) struct Guard {
    run: String,
    selection: String,
    retired: foreground::transport::Retired,
}
impl Guard {
    pub(in crate::provider) fn acquire(
        candidate: &Candidate,
        run: &str,
        expected: Option<&str>,
    ) -> Result<Self, CandidateError> {
        let retired = foreground::transport::Retired::acquire(candidate, run)?
            .ok_or_else(|| published_owner_refused(candidate, run))?;
        let (owner, receipt) = checked(candidate, run)?;
        let selected = selection(&owner, &receipt)?;
        if expected.is_some_and(|value| !hex(value, 64) || value != selected) {
            return Err(refused());
        }
        let guard = Self {
            run: run.into(),
            selection: selected,
            retired,
        };
        guard.verify(candidate)?;
        Ok(guard)
    }
    pub(in crate::provider) fn verify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        self.retired.verify()?;
        let (owner, receipt) = checked(candidate, &self.run)?;
        if selection(&owner, &receipt)? != self.selection {
            return Err(refused());
        }
        self.retired.verify()
    }
}

/// Eligibility only: no guest connection, live resource observations, environment
/// values or restore authority are returned. An absent/uncertain owner refuses.
pub fn preflight(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let guard = Guard::acquire(candidate, run, None)?;
    // Eligibility is read-only: wait out a brief holder such as the inspection behind
    // `hack ps`, as runtime startup does, rather than failing the `up` that asked.
    let _lease = state::Lock::acquire_existing_waiting(
        &candidate.state_root.join("run/smolvm"),
        lifecycle::STARTUP_LEASE_WAIT,
    )?;
    guard.verify(candidate)?;
    let (owner, receipt) = checked(candidate, run)?;
    Ok(
        json!({"version":1,"run":receipt.run,"owner":receipt.owner,"namespace":receipt.namespace,
        "plan":receipt.plan_id,"runtime_phase":owner.phase,"selection":guard.selection,
        "live_resources_verified":false}),
    )
}

#[cfg(test)]
pub(in crate::provider::graph) mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A stopped clean owned runtime with one acknowledged retained run whose
    /// previous foreground publication was retired.
    pub(in crate::provider::graph) struct Fixture {
        pub(in crate::provider::graph) root: super::super::tests::Fixture,
        pub(in crate::provider::graph) candidate: Candidate,
        pub(in crate::provider::graph) run: String,
        aliases: Vec<PathBuf>,
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
            let publication = foreground::transport::root(&candidate, &run).unwrap();
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
                Sha256::digest(self.root.0.as_os_str().as_encoded_bytes())
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
    fn uncertain_graph_or_owned_runtime_refuses_offline_preflight() {
        for mutation in [
            "dirty",
            "compute",
            "phase",
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
                "phase" => {
                    owner.phase = "recovered-unclean".into();
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

    #[test]
    fn preflight_selection_and_held_guard_refuse_a_valid_replacement_owner_before_up() {
        let mut fixture = Fixture::new();
        let value = preflight(&fixture.candidate, &fixture.run).unwrap();
        let selected = value["selection"].as_str().unwrap();
        let guard = Guard::acquire(&fixture.candidate, &fixture.run, Some(selected)).unwrap();
        guard.verify(&fixture.candidate).unwrap();
        fixture.replace_owner();
        assert!(guard.verify(&fixture.candidate).is_err());
        drop(guard);
        let replacement = preflight(&fixture.candidate, &fixture.run).unwrap();
        assert_ne!(replacement["selection"], value["selection"]);
        let before = fs::read(fixture.candidate.state_root.join("run/smolvm/owner.json")).unwrap();
        let error = lifecycle::up_with_retained_project_share(
            &fixture.candidate,
            super::super::super::Profile::Development,
            None,
            None,
            None,
            None,
            (&fixture.run, selected),
        )
        .unwrap_err();
        assert_eq!(error.code, "graph_retained_startup");
        assert_eq!(
            fs::read(fixture.candidate.state_root.join("run/smolvm/owner.json")).unwrap(),
            before
        );
        assert!(
            !fixture
                .candidate
                .state_root
                .join("run/smolvm/admission.json")
                .exists()
        );
    }

    #[test]
    fn same_mapping_owner_does_not_allow_changed_process_identity_at_effect_boundary() {
        let fixture = Fixture::new();
        let selected = preflight(&fixture.candidate, &fixture.run).unwrap();
        let mut owner = Owner::load(&fixture.candidate).unwrap();
        let token = owner.token.clone();
        owner.process.as_mut().unwrap().start_micros += 1;
        owner.save(&fixture.candidate).unwrap();
        let now = preflight(&fixture.candidate, &fixture.run).unwrap();
        assert_eq!(now["owner"], token);
        assert_eq!(now["plan"], selected["plan"]);
        assert_ne!(now["selection"], selected["selection"]);
        let failure = lifecycle::up_with_retained_project_share(
            &fixture.candidate,
            super::super::super::Profile::Development,
            None,
            None,
            None,
            None,
            (&fixture.run, selected["selection"].as_str().unwrap()),
        )
        .unwrap_err();
        assert_eq!(failure.code, "graph_retained_startup");
        assert!(
            !fixture
                .candidate
                .state_root
                .join("run/smolvm/admission.json")
                .exists()
        );
    }
}
