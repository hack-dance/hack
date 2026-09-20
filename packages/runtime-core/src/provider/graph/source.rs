//! Immutable publication baselines, with explicit acknowledged live directory bindings.
//! Replay verifies a fresh compatible acknowledgement but retains baseline cache identity.
use super::*;
use crate::project::{PlanData, snapshot::ContentRevision};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveBinding>,
    pub revision: String,
    pub archive_sha256: String,
    pub selection_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveBinding {
    pub workspace: super::super::source_sync::LiveWorkspace,
    pub contract: project::live_source::Contract,
}
impl SourceBinding {
    pub(super) fn valid(&self) -> bool {
        [&self.revision, &self.archive_sha256, &self.selection_sha256]
            .iter()
            .all(|v| hex(v, 64))
            && self.live.as_ref().is_none_or(|live| live.workspace.valid())
    }
}
pub(super) struct Inputs {
    /// Fresh replay review; cache bindings must still equal the retained resources.
    pub current_manifest: Option<ContentRevision>,
    pub manifest: ContentRevision,
    pub binding: SourceBinding,
    pub paths: BTreeMap<String, String>,
}

fn mounts(plan: &PlanData) -> impl Iterator<Item = &project::MountPlan> {
    plan.services
        .values()
        .filter(|s| s.active)
        .flat_map(|s| &s.mounts)
        .filter(|m| m.kind == "bind")
}

pub(super) fn requested(plan: &PlanData, revision: Option<&str>) -> Result<(), CandidateError> {
    if (mounts(plan).next().is_some()
        || plan
            .services
            .values()
            .any(|s| s.active && s.dependency_cache.is_some()))
        != revision.is_some()
        || revision.is_some_and(|r| !hex(r, 64))
    {
        return Err(error(
            "graph_source_required",
            "Read-only source mounts require an explicit 64-hex published source revision; cache declarations also require one; graphs without either must omit it.",
        ));
    }
    Ok(())
}

fn paths(
    plan: &PlanData,
    manifest: &ContentRevision,
) -> Result<BTreeMap<String, String>, CandidateError> {
    manifest.validate()?;
    if manifest.selection_sha256 != plan.source_selection.metadata_sha256 {
        return Err(error(
            "graph_source_selection",
            "Published source selection differs from the reviewed plan.",
        ));
    }
    manifest.verify_mountpoints(plan)?;
    manifest.verify_registry(plan)?;
    manifest.verify_generated(plan)?;
    let root = format!(
        "/storage/hack-source/{}/{}/tree",
        plan.namespace, manifest.revision
    );
    let mut paths = BTreeMap::new();
    for mount in mounts(plan) {
        if !mount.read_only
            || (mount.source != "."
                && manifest.entries.iter().any(|entry| {
                    entry.kind == "symlink" && entry.path.starts_with(&format!("{}/", mount.source))
                }))
            || (mount.source != "."
                && !manifest.entries.iter().any(|entry| {
                    entry.path == mount.source
                        && matches!(entry.kind.as_str(), "file" | "directory")
                }))
        {
            return Err(error(
                "graph_source_mount",
                "Source mounts must be read-only selected regular files or directories; excluded paths, symlink roots and subdirectories containing symlinks are refused.",
            ));
        }
        paths.insert(
            mount.source.clone(),
            if mount.source == "." {
                root.clone()
            } else {
                format!("{root}/{}", mount.source)
            },
        );
    }
    Ok(paths)
}

pub(super) fn prepare(
    candidate: &Candidate,
    engine: &Engine<'_>,
    plan: &PlanData,
    revision: Option<&str>,
    live: bool,
) -> Result<Option<Inputs>, CandidateError> {
    requested(plan, revision)?;
    let Some(revision) = revision else {
        if live {
            return Err(error(
                "graph_live_source",
                "Live source requires a published baseline.",
            ));
        }
        return Ok(None);
    };
    let (publication, mut inputs) = published_inputs(candidate, plan, revision)?;
    super::super::source_transfer::verify_published(engine.guest(), &publication)?;
    if live {
        if mounts(plan).next().is_none()
            || mounts(plan).any(|mount| {
                mount.source != "."
                    && !inputs
                        .manifest
                        .entries
                        .iter()
                        .any(|entry| entry.path == mount.source && entry.kind == "directory")
            })
        {
            return Err(error(
                "graph_live_source",
                "Live source permits only stable directory bind roots.",
            ));
        }
        let contract = project::live_source::Contract::from_plan(plan, &inputs.manifest)?;
        let workspace = super::super::source_sync::admit_live(
            engine.guest(),
            &plan.namespace,
            &plan.source,
            &inputs.manifest,
        )?;
        for (source, path) in &mut inputs.paths {
            let root = format!("/storage/hack-workspaces/{}/tree", plan.namespace);
            *path = if source == "." {
                root
            } else {
                format!("{root}/{source}")
            };
        }
        inputs.binding.live = Some(LiveBinding {
            workspace,
            contract,
        });
    }
    Ok(Some(inputs))
}

/// Replay retains immutable cache input identity while validating a fresh live
/// review and acknowledgement under the existing provider lease.
pub(super) fn prepare_replay(
    engine: &Engine<'_>,
    inputs: &project::inputs::ExecutionInputs,
    receipt: &Receipt,
    revision: Option<&str>,
    live: bool,
    non_secret_values: &BTreeMap<String, String>,
) -> Result<Option<Inputs>, CandidateError> {
    let retained = receipt
        .source
        .as_ref()
        .and_then(|source| source.live.as_ref());
    if !live || retained.is_none() {
        if live || retained.is_some() || inputs.review.plan_id != receipt.plan_id {
            return Err(error(
                "graph_source_changed",
                "Replay source mode or immutable review changed.",
            ));
        }
        let source = prepare(
            engine.guest().candidate(),
            engine,
            &inputs.review.plan,
            revision,
            false,
        )?;
        unchanged(&source, receipt)?;
        return Ok(source);
    }
    if !non_secret_values.is_empty() {
        return Err(error(
            "graph_live_source",
            "Live source cannot bind external execution substitutions.",
        ));
    }
    let binding = receipt
        .source
        .as_ref()
        .ok_or_else(|| error("graph_live_source", "Missing retained baseline."))?;
    if revision != Some(binding.revision.as_str()) {
        return Err(error(
            "graph_source_changed",
            "Replay must retain its immutable source baseline.",
        ));
    }
    let publication = super::super::source_transfer::load(
        engine.guest().candidate(),
        &receipt.namespace,
        &binding.revision,
    )?;
    super::super::source_transfer::verify_published(engine.guest(), &publication)?;
    let current = project::snapshot::capture_plan(&inputs.review.plan)?;
    let mut source = replay_inputs(
        &inputs.review.plan,
        receipt,
        &publication,
        current.receipt(),
    )?;
    let observed = super::super::source_sync::admit_live(
        engine.guest(),
        &receipt.namespace,
        &inputs.review.plan.source,
        current.receipt(),
    )?;
    if source
        .binding
        .live
        .as_ref()
        .is_none_or(|live| live.workspace != observed)
    {
        return Err(error(
            "graph_live_source",
            "Replay workspace incarnation or inode changed.",
        ));
    }
    // Always retain baseline manifest; the current snapshot is admission evidence.
    source.manifest = publication.manifest;
    Ok(Some(source))
}

fn replay_inputs(
    plan: &PlanData,
    receipt: &Receipt,
    publication: &super::super::source_transfer::Publication,
    current: &ContentRevision,
) -> Result<Inputs, CandidateError> {
    let binding = receipt
        .source
        .as_ref()
        .ok_or_else(|| error("graph_live_source", "Missing source binding."))?;
    let live = binding
        .live
        .as_ref()
        .ok_or_else(|| error("graph_live_source", "Missing live binding."))?;
    if !binding.valid()
        || receipt.namespace != plan.namespace
        || publication.namespace != receipt.namespace
        || publication.provider_incarnation != receipt.owner
        || publication.archive_sha256 != binding.archive_sha256
        || publication.manifest.revision != binding.revision
        || publication.manifest.selection_sha256 != binding.selection_sha256
        || live.workspace.namespace != receipt.namespace
        || live.workspace.provider_incarnation != receipt.owner
    {
        return Err(error(
            "graph_source_changed",
            "Replay baseline ownership differs.",
        ));
    }
    publication.manifest.validate()?;
    live.contract.verify(plan, current)?;
    let mut selected = paths(plan, current)?;
    for (source, path) in &mut selected {
        if source != "."
            && !current
                .entries
                .iter()
                .any(|entry| entry.path == *source && entry.kind == "directory")
        {
            return Err(error(
                "graph_live_source",
                "Replay requires stable directory roots.",
            ));
        }
        let root = format!("/storage/hack-workspaces/{}/tree", receipt.namespace);
        *path = if source == "." {
            root
        } else {
            format!("{root}/{source}")
        };
    }
    Ok(Inputs {
        current_manifest: Some(current.clone()),
        binding: binding.clone(),
        manifest: publication.manifest.clone(),
        paths: selected,
    })
}

// Host receipt selection does not require a mutable workspace acknowledgement.
// Its caller must hold the Engine lease and verify guest identity/content before use.
fn published_inputs(
    candidate: &Candidate,
    plan: &PlanData,
    revision: &str,
) -> Result<(super::super::source_transfer::Publication, Inputs), CandidateError> {
    let publication = super::super::source_transfer::load(candidate, &plan.namespace, revision)?;
    let paths = paths(plan, &publication.manifest)?;
    let inputs = Inputs {
        current_manifest: None,
        manifest: publication.manifest.clone(),
        binding: SourceBinding {
            live: None,
            revision: revision.into(),
            archive_sha256: publication.archive_sha256.clone(),
            selection_sha256: publication.manifest.selection_sha256.clone(),
        },
        paths,
    };
    Ok((publication, inputs))
}

pub(super) fn unchanged(source: &Option<Inputs>, receipt: &Receipt) -> Result<(), CandidateError> {
    if source.as_ref().map(|s| &s.binding) != receipt.source.as_ref() {
        return Err(error(
            "graph_source_changed",
            "Restart and restore must retain the exact accepted source publication.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, path::Path};

    #[test]
    fn live_replay_retains_cache_baseline_and_ownership_after_compatible_edits() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        fs::write(fixture.0.join("compose.yaml"), format!("services:\n  deps:\n    image: sha256:{}\n    read_only: true\n    network_mode: none\n    entrypoint: ['/bin/true']\n    volumes: ['.:/app:ro', 'deps:/app/node_modules']\n    labels:\n      hack.dependencies.cache-volume: deps\nvolumes:\n  deps: {{}}\n", "a".repeat(64))).unwrap();
        fs::write(fixture.0.join("bun.lock"), "pinned lock").unwrap();
        fs::write(fixture.0.join("app.js"), "initial").unwrap();
        let options = || PlanOptions {
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let initial = project::plan(&candidate, options()).unwrap();
        let baseline = project::snapshot::capture_plan(&initial.plan).unwrap();
        let owner = "b".repeat(32);
        let run = "c".repeat(32);
        let goals = BTreeMap::from([("deps".into(), Condition::Completed)]);
        let publication = super::super::super::source_transfer::Publication {
            checkout: candidate.checkout.clone(),
            namespace: initial.plan.namespace.clone(),
            provider_incarnation: owner.clone(),
            manifest: baseline.receipt().clone(),
            archive_sha256: "d".repeat(64),
        };
        let binding = SourceBinding {
            revision: baseline.receipt().revision.clone(),
            archive_sha256: publication.archive_sha256.clone(),
            selection_sha256: baseline.receipt().selection_sha256.clone(),
            live: Some(LiveBinding {
                workspace: super::super::super::source_sync::LiveWorkspace {
                    namespace: initial.plan.namespace.clone(),
                    provider_incarnation: owner.clone(),
                    tree_inode: 11,
                },
                contract: project::live_source::Contract::from_plan(
                    &initial.plan,
                    baseline.receipt(),
                )
                .unwrap(),
            }),
        };
        let baseline_inputs = Inputs {
            current_manifest: None,
            binding: binding.clone(),
            manifest: baseline.receipt().clone(),
            paths: paths(&initial.plan, baseline.receipt()).unwrap(),
        };
        let executable =
            project::inputs::compile(&candidate, options(), &initial.plan_id, &BTreeMap::new())
                .unwrap();
        let prepared =
            config::prepare(executable, &goals, &run, &owner, Some(&baseline_inputs)).unwrap();
        let receipt = Receipt {
            normalized_input: None,
            version: 1,
            run,
            owner,
            namespace: initial.plan.namespace.clone(),
            plan_id: initial.plan_id.clone(),
            phase: "stopped-data-retained".into(),
            source: Some(binding),
            readiness: goals.clone(),
            resources: prepared.resources,
            relay_startup: None,
            relay_cleanup: None,
            probes: BTreeMap::new(),
            environment_attached: false,
            initializer_cache_release: BTreeMap::new(),
        };
        fs::write(fixture.0.join("app.js"), "compatible changed source").unwrap();
        let current = project::plan(&candidate, options()).unwrap();
        assert_ne!(current.plan_id, initial.plan_id);
        assert!(
            project::snapshot::capture_plan(&initial.plan).is_err(),
            "stale review must refuse"
        );
        let snapshot = project::snapshot::capture_plan(&current.plan).unwrap();
        let source =
            replay_inputs(&current.plan, &receipt, &publication, snapshot.receipt()).unwrap();
        assert_eq!(source.manifest.revision, baseline.receipt().revision);
        assert_ne!(source.manifest.revision, snapshot.receipt().revision);
        assert!(source.paths["."].starts_with("/storage/hack-workspaces/"));
        let executable =
            project::inputs::compile(&candidate, options(), &current.plan_id, &BTreeMap::new())
                .unwrap();
        let mut prepared = config::prepare(
            executable,
            &goals,
            &receipt.run,
            &receipt.owner,
            Some(&source),
        )
        .unwrap();
        assert_eq!(
            prepared.resources["volume:deps"].cache,
            receipt.resources["volume:deps"].cache
        );
        assert_eq!(
            prepared.configs["deps"]["Labels"]["io.hack-local.plan"],
            current.plan_id
        );
        config::retain_replay_ownership(&mut prepared, &receipt).unwrap();
        assert_eq!(prepared.plan_id, receipt.plan_id);
        assert_eq!(
            prepared.configs["deps"]["Labels"]["io.hack-local.plan"],
            receipt.plan_id
        );
        prepared.configs.get_mut("deps").unwrap()["Labels"]["io.hack-local.owner"] =
            json!("foreign");
        assert!(config::retain_replay_ownership(&mut prepared, &receipt).is_err());
        let mut foreign = receipt.clone();
        foreign.owner = "f".repeat(32);
        assert!(replay_inputs(&current.plan, &foreign, &publication, snapshot.receipt()).is_err());
        fs::write(fixture.0.join("bun.lock"), "incompatible lock").unwrap();
        let changed = project::plan(&candidate, options()).unwrap();
        let snapshot = project::snapshot::capture_plan(&changed.plan).unwrap();
        assert!(replay_inputs(&changed.plan, &receipt, &publication, snapshot.receipt()).is_err());
    }

    #[test]
    fn live_consumers_pin_retained_graphs_and_refuse_uncertain_or_foreign_records() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        fs::write(fixture.0.join("compose.yaml"), format!("services:\n  web:\n    image: sha256:{}\n    network_mode: none\n    volumes: ['.:/app:ro']\n", "a".repeat(64))).unwrap();
        let review = project::plan(
            &candidate,
            PlanOptions {
                project: &fixture.0,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let manifest = project::snapshot::capture(
            &fixture.0,
            &BTreeSet::new(),
            &review.plan.source_selection.metadata_sha256,
        )
        .unwrap()
        .receipt()
        .clone();
        let contract = project::live_source::Contract::from_plan(&review.plan, &manifest).unwrap();
        let run = "b".repeat(32);
        let owner = "c".repeat(32);
        let mut receipt = Receipt {
            normalized_input: None,
            version: 1,
            run: run.clone(),
            owner: owner.clone(),
            namespace: review.plan.namespace.clone(),
            plan_id: review.plan_id,
            phase: "ready-observed".into(),
            environment_attached: false,
            initializer_cache_release: BTreeMap::new(),
            relay_startup: None,
            relay_cleanup: None,
            probes: BTreeMap::new(),
            source: Some(SourceBinding {
                revision: manifest.revision,
                archive_sha256: "d".repeat(64),
                selection_sha256: manifest.selection_sha256,
                live: Some(LiveBinding {
                    workspace: super::super::super::source_sync::LiveWorkspace {
                        namespace: review.plan.namespace.clone(),
                        provider_incarnation: owner.clone(),
                        tree_inode: 7,
                    },
                    contract: contract.clone(),
                }),
            }),
            readiness: BTreeMap::from([("web".into(), Condition::Started)]),
            resources: BTreeMap::from([(
                "container:web".into(),
                Resource {
                    kind: Kind::Container,
                    key: "web".into(),
                    name: format!("hkg-{run}-container-0"),
                    id: None,
                    image: Some(format!("sha256:{}", "a".repeat(64))),
                    phase: "reserved".into(),
                    routing: None,
                    networks: Some(vec![]),
                    outbound: false,
                    cache: None,
                    cache_provenance: None,
                },
            )]),
        };
        let root = super::super::directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        let check = |contract| {
            super::super::check_live_source_records(
                &candidate,
                &owner,
                &review.plan.namespace,
                Some(7),
                contract,
            )
        };
        for phase in [
            "ready-observed",
            "stopped-data-retained",
            "preparing",
            "failed-retained",
        ] {
            receipt.phase = phase.into();
            state::write(&root.join("state.json"), &receipt).unwrap();
            check(Some(&contract)).unwrap();
            assert!(check(None).is_err());
        }
        fs::write(root.join("state.pending"), "partial").unwrap();
        assert!(check(Some(&contract)).is_err());
        fs::remove_file(root.join("state.pending")).unwrap();
        assert!(
            super::super::check_live_source_records(
                &candidate,
                &owner,
                &review.plan.namespace,
                Some(8),
                Some(&contract)
            )
            .is_err()
        );
        receipt.phase = "removed".into();
        state::write(&root.join("state.json"), &receipt).unwrap();
        assert!(check(None).is_err());
        receipt.resources.get_mut("container:web").unwrap().phase = "absent".into();
        state::write(&root.join("state.json"), &receipt).unwrap();
        check(None).unwrap();
        receipt.owner = "f".repeat(32);
        state::write(&root.join("state.json"), &receipt).unwrap();
        assert!(check(Some(&contract)).is_err());
        fs::write(root.join("state.json"), "corrupt").unwrap();
        assert!(check(Some(&contract)).is_err());
    }

    #[test]
    fn selected_mounts_are_bound_to_manifest_and_read_only_config() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        fs::create_dir(fixture.0.join("app")).unwrap();
        fs::write(fixture.0.join("app/main.js"), "console.log('source')").unwrap();
        fs::write(fixture.0.join(".env"), "EXCLUDED=fixture").unwrap();
        std::os::unix::fs::symlink("main.js", fixture.0.join("app/link.js")).unwrap();
        let document = json!({"services":{"web":{"image":format!("sha256:{}", "a".repeat(64)),"read_only":true,"network_mode":"none","volumes":[".:/app:ro"],"entrypoint":["/usr/local/bin/bun","/app/app/main.js"]}}});
        fs::write(
            fixture.0.join("compose.yaml"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let options = || PlanOptions {
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let review = project::plan(&candidate, options()).unwrap();
        let snapshot = project::snapshot::capture(
            &fixture.0,
            &BTreeSet::new(),
            &review.plan.source_selection.metadata_sha256,
        )
        .unwrap();
        let manifest = snapshot.receipt();
        let paths = super::paths(&review.plan, manifest).unwrap();
        assert!(paths["."].ends_with(&format!("/{}/tree", manifest.revision)));
        assert!(requested(&review.plan, None).is_err());
        assert!(requested(&review.plan, Some("invalid")).is_err());
        requested(&review.plan, Some(&manifest.revision)).unwrap();
        let source = Inputs {
            current_manifest: None,
            manifest: manifest.clone(),
            binding: SourceBinding {
                live: None,
                revision: manifest.revision.clone(),
                archive_sha256: "b".repeat(64),
                selection_sha256: manifest.selection_sha256.clone(),
            },
            paths,
        };
        let inputs =
            project::inputs::compile(&candidate, options(), &review.plan_id, &BTreeMap::new())
                .unwrap();
        let prepared = config::prepare(
            inputs,
            &BTreeMap::from([("web".into(), Condition::Started)]),
            &"a".repeat(32),
            &"b".repeat(32),
            Some(&source),
        )
        .unwrap();
        assert_eq!(
            prepared.configs["web"]["HostConfig"]["Mounts"][0],
            json!({"Type":"bind","Source":source.paths["."],"Target":"/app","ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}})
        );
        for name in [".env", "app/link.js", "app", "../escape"] {
            let mut plan = review.plan.clone();
            plan.services.get_mut("web").unwrap().mounts[0].source = name.into();
            assert_eq!(
                super::paths(&plan, manifest).unwrap_err().code,
                "graph_source_mount"
            );
        }
        let mut plan = review.plan.clone();
        plan.services.get_mut("web").unwrap().mounts[0].source = "app/main.js".into();
        assert!(super::paths(&plan, manifest).is_ok());
        plan.services.get_mut("web").unwrap().mounts[0].read_only = false;
        assert!(super::paths(&plan, manifest).is_err());
        plan.source_selection.metadata_sha256 = "c".repeat(64);
        assert_eq!(
            super::paths(&plan, manifest).unwrap_err().code,
            "graph_source_selection"
        );
        assert!(!candidate.state_root.exists());
        let publication = super::super::super::source_transfer::Publication {
            checkout: candidate.checkout.clone(),
            namespace: review.plan.namespace.clone(),
            provider_incarnation: "a".repeat(32),
            manifest: manifest.clone(),
            archive_sha256: "b".repeat(64),
        };
        let directory = candidate
            .state_root
            .join("run/source-publications")
            .join(&review.plan.namespace);
        state::private_directory(&directory).unwrap();
        let receipt_path = directory.join(format!("{}.json", manifest.revision));
        state::write(&receipt_path, &publication).unwrap();
        let (_, selected) = published_inputs(&candidate, &review.plan, &manifest.revision).unwrap();
        assert_eq!(selected.binding.revision, manifest.revision);
        assert_eq!(selected.binding.selection_sha256, manifest.selection_sha256);
        assert!(!candidate.state_root.join("run/source-sync").exists());
        assert!(published_inputs(&candidate, &review.plan, &"f".repeat(64)).is_err());
        let mut changed = review.plan.clone();
        changed.source_selection.metadata_sha256 = "f".repeat(64);
        assert!(published_inputs(&candidate, &changed, &manifest.revision).is_err());
        let mut foreign = publication;
        foreign.checkout = fixture.0.clone();
        state::write(&receipt_path, &foreign).unwrap();
        assert!(published_inputs(&candidate, &review.plan, &manifest.revision).is_err());
    }

    #[test]
    fn source_receipts_preserve_legacy_bytes_and_refuse_changed_binding() {
        let value = json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}});
        let mut receipt: Receipt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&receipt).unwrap(), value);
        let binding = SourceBinding {
            live: None,
            revision: "a".repeat(64),
            archive_sha256: "b".repeat(64),
            selection_sha256: "c".repeat(64),
        };
        let mut source = Some(Inputs {
            current_manifest: None,
            manifest: ContentRevision {
                schema_version: 1,
                revision: "a".repeat(64),
                selection_sha256: "b".repeat(64),
                total_bytes: 0,
                entries: vec![],
            },
            binding: binding.clone(),
            paths: BTreeMap::new(),
        });
        assert!(unchanged(&source, &receipt).is_err());
        receipt.source = Some(binding);
        unchanged(&source, &receipt).unwrap();
        assert!(unchanged(&None, &receipt).is_err());
        source.as_mut().unwrap().binding.archive_sha256 = "d".repeat(64);
        assert!(unchanged(&source, &receipt).is_err());
        let decoded: Receipt =
            serde_json::from_value(serde_json::to_value(&receipt).unwrap()).unwrap();
        assert_eq!(decoded.source, receipt.source);
    }
}
