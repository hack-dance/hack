//! Compose-parity reconciliation of a stopped graph to a changed reviewed plan.
//!
//! A stopped, data-retaining graph has no compute left: restore has already
//! confirmed the absence of every recorded container and network. Reconciliation
//! therefore recreates all compute from the freshly reviewed plan, exactly as a
//! fresh admission would, and changes only how named data is selected:
//!
//! * a declared volume whose logical key this run already retains is reattached
//!   under its recorded name, after the caller's label/identity observation;
//! * a newly declared volume gets a fresh name in this run's namespace and is
//!   created through the ordinary exclusive-create path (never adoption);
//! * a retained volume the new plan no longer declares stays recorded and owned
//!   (Compose also keeps project volumes of removed declarations); explicit
//!   data removal still reaches it;
//! * containers and networks of removed services are dropped from the receipt only
//!   because their absence was confirmed before this projection;
//! * a dependency cache whose freshly resolved identity equals the recorded one is
//!   kept with its provenance. Its identity binds only the initializer's own
//!   definition, cache declaration, image and input files, so edits to other
//!   services keep it. A changed identity selects that identity's shared cache
//!   exactly as a fresh admission would (adopt by labels or create, then the
//!   initializer runs); the old cache is shared, never run-owned data, so only
//!   this run's reference to it is released. A retained run-owned volume is never
//!   reselected as a cache.
//!
//! Ownership never moves: run, owner, namespace and the ownership plan recorded on
//! every label are unchanged, so another instance's data cannot be selected.
//! Live source, a cache scope carried across a source-device rebind and pending
//! initializer cache-release effects keep their narrower dedicated proofs and are
//! not eligible here.
use super::*;
use crate::error::PlanChangeField;

fn refused(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    error("graph_plan_reconcile", message)
}

/// Run-owned data is never reselected as a shared, content-addressed cache.
fn cache_over_retained_data(service: &str) -> CandidateError {
    refused(
        "A retained named volume is now declared as a dependency cache; its data was not reselected as a shared cache.",
    )
    .with_plan_change(service, PlanChangeField::DependencyCacheVolume)
}

/// Retained named data is any recorded volume that may have been created. A
/// volume still `reserved` never received a create intent, so it holds no data.
pub(super) fn retained_volume(resource: &Resource) -> bool {
    resource.kind == Kind::Volume && resource.phase != "reserved"
}

fn volume_prefix(run: &str) -> String {
    format!("hkg-{run}-volume-")
}

fn active_volume_keys(plan: &project::PlanData) -> BTreeSet<String> {
    plan.services
        .values()
        .filter(|service| service.active)
        .flat_map(|service| service.mounts.iter())
        .filter(|mount| mount.kind == "volume")
        .map(|mount| mount.source.clone())
        .collect()
}

/// Whether the receipt uses machinery that has its own narrower proof.
fn eligible(receipt: &Receipt) -> bool {
    receipt.normalized_input.is_some()
        && receipt.initializer_cache_release.is_empty()
        && receipt
            .source
            .as_ref()
            .is_none_or(|binding| binding.cache_scope.is_none() && binding.live.is_none())
}

/// The ordinary strict replay derives run-owned volume names from the sorted
/// declared set (a dependency cache takes an index but keeps its content name).
/// Once a reconciliation reattached data out of that order, or retains data no
/// longer declared, only this projection can restore the graph again.
/// A cache with a writable consumer is scoped to this instance; a receipt recorded
/// before that scoping names a shared cache that may hold another worktree's
/// writes. Such graphs always take this path, which keeps the cache only when its
/// freshly resolved instance-scoped identity equals the recorded binding exactly.
fn ordinary_layout(receipt: &Receipt, plan: &project::PlanData) -> bool {
    let scoped = dependency_cache::instance_scoped_volumes(plan);
    if receipt.resources.values().any(|resource| {
        resource.kind == Kind::Volume && resource.cache.is_some() && scoped.contains(&resource.key)
    }) {
        return false;
    }
    let declared = active_volume_keys(plan);
    let recorded = receipt
        .resources
        .values()
        .filter(|resource| resource.kind == Kind::Volume)
        .map(|resource| (resource.key.clone(), resource))
        .collect::<BTreeMap<_, _>>();
    recorded.len() == declared.len()
        && declared.iter().enumerate().all(|(index, key)| {
            recorded.get(key).is_some_and(|resource| {
                resource.cache.is_some()
                    || resource.name == format!("{}{index}", volume_prefix(&receipt.run))
            })
        })
}

/// Selects reconciliation for a reviewed plan that the strict replay path cannot
/// restore. Unchanged reviews with the ordinary layout keep strict replay; live
/// source, a carried cache scope or a pending source-device rebind keep their
/// dedicated hostname/shared-source proofs.
pub(super) fn applies(
    receipt: &Receipt,
    plan_id: &str,
    plan: &project::PlanData,
    next: &NormalizedInputIdentity,
    source_rebind: bool,
) -> bool {
    !source_rebind
        && eligible(receipt)
        && !(receipt.plan_id == plan_id
            && receipt.normalized_input.as_ref() == Some(next)
            && ordinary_layout(receipt, plan))
}

/// Read-only proof of a reconciliation selection. Admission repeats it under the
/// provider lease and binds it to the exact retained generation before effects.
pub(super) struct Verified {
    run: String,
    owner: String,
    namespace: String,
    ownership_plan: String,
    previous: NormalizedInputIdentity,
    next: NormalizedInputIdentity,
}

/// Next-attempt resources. Newly declared volumes are `reserved`, so restore
/// creates them exclusively; every other volume is reattached retained data.
pub(super) struct Projection {
    pub resources: BTreeMap<String, Resource>,
}

/// Pure checks shared by compatibility preflight and restore admission. Callers
/// still observe every retained volume's labels and data identity themselves.
pub(super) fn prepare(
    plan: &project::PlanData,
    receipt: &Receipt,
    next: &NormalizedInputIdentity,
) -> Result<Verified, CandidateError> {
    let previous = receipt
        .normalized_input
        .clone()
        .ok_or_else(|| refused("Only normalized graphs can be reconciled."))?;
    if !eligible(receipt) {
        return Err(refused(
            "Live source, a carried cache scope and pending initializer cache release use their dedicated restore proofs.",
        ));
    }
    if !next.matches_plan(plan)
        || plan.namespace != receipt.namespace
        || next.namespace != receipt.namespace
        || !previous.valid(&receipt.namespace)
    {
        return Err(refused(
            "Reconciliation requires the same project instance and its reviewed input.",
        ));
    }
    if !matches!(
        receipt.phase.as_str(),
        "ready-observed" | "stopped-data-retained"
    ) {
        return Err(refused(
            "Reconciliation requires completed startup or acknowledged data retention.",
        ));
    }
    let prefix = volume_prefix(&receipt.run);
    for (key, resource) in &receipt.resources {
        if key != &format!("{}:{}", resource.kind.word(), resource.key) {
            return Err(refused("Retained resource keys are inconsistent."));
        }
        if resource.kind != Kind::Volume {
            continue;
        }
        let owned_name = resource.cache.as_ref().map_or_else(
            || {
                resource
                    .name
                    .strip_prefix(&prefix)
                    .is_some_and(|index| index.parse::<usize>().is_ok_and(|n| n < 64))
            },
            |cache| cache.valid() && resource.name == cache.name(),
        );
        if !owned_name || !matches!(resource.phase.as_str(), "created" | "reserved") {
            return Err(refused(
                "Retained data is not this run's settled owned volume; it was not reattached.",
            ));
        }
    }
    for (service, declared) in plan.services.iter().filter(|(_, service)| service.active) {
        if let Some(cache) = &declared.dependency_cache
            && receipt
                .resources
                .get(&format!("volume:{}", cache.volume))
                .is_some_and(|old| old.cache.is_none() && retained_volume(old))
        {
            return Err(cache_over_retained_data(service));
        }
    }
    Ok(Verified {
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        ownership_plan: receipt.plan_id.clone(),
        previous,
        next: next.clone(),
    })
}

impl Verified {
    fn matches_receipt(&self, receipt: &Receipt) -> bool {
        self.run == receipt.run
            && self.owner == receipt.owner
            && self.namespace == receipt.namespace
            && self.ownership_plan == receipt.plan_id
            && receipt.normalized_input.as_ref() == Some(&self.previous)
    }

    /// The fresh owner's selection must name this proof's reviewed input and the
    /// exact retained generation it observed; nothing else is re-derived.
    pub(super) fn verify_fresh(
        &self,
        receipt: &Receipt,
        fresh: &NormalizedInputIdentity,
        selected: &str,
        observed: &str,
    ) -> Result<(), CandidateError> {
        if !self.matches_receipt(receipt)
            || fresh != &self.next
            || !hex(selected, 64)
            || selected != observed
            || receipt.phase != "stopped-data-retained"
        {
            return Err(error(
                "graph_restore_refused",
                "Stopped restore selection or normalized input changed; no graph effects were started.",
            ));
        }
        Ok(())
    }

    /// Project freshly prepared compute onto this run's retained data. Labels keep
    /// the ownership plan; mounts are rewritten from prepared to final volume names.
    pub(super) fn project(
        &self,
        prepared: &mut config::Prepared,
        receipt: &Receipt,
    ) -> Result<Projection, CandidateError> {
        if !self.matches_receipt(receipt) || prepared.namespace != receipt.namespace {
            return Err(refused("Reconciliation ownership changed."));
        }
        config::retain_recorded_legacy_caches(prepared, receipt);
        let prefix = volume_prefix(&receipt.run);
        // Run-owned retained data. Dependency caches are shared, content-addressed
        // volumes selected separately below; they are never reattached as data.
        let retained = receipt
            .resources
            .iter()
            .filter(|(_, resource)| retained_volume(resource) && resource.cache.is_none())
            .collect::<BTreeMap<_, _>>();
        let mut used = retained
            .values()
            .map(|resource| resource.name.clone())
            .collect::<BTreeSet<_>>();
        let mut renamed = BTreeMap::new();
        let mut resources = BTreeMap::new();
        for (key, resource) in &prepared.resources {
            if resource.kind != Kind::Volume {
                resources.insert(key.clone(), resource.clone());
                continue;
            }
            let selected = if let Some(cache) = &resource.cache {
                if retained.contains_key(key) {
                    let service = prepared
                        .cache_initializers
                        .iter()
                        .find(|(_, volume)| *volume == &resource.key)
                        .map_or(resource.key.as_str(), |(service, _)| service.as_str());
                    return Err(cache_over_retained_data(service));
                }
                match receipt.resources.get(key) {
                    // Same identity: keep the cache and its provenance fence.
                    Some(old)
                        if old.cache.as_ref() == Some(cache)
                            && old.name == resource.name
                            && matches!(old.phase.as_str(), "created" | "reserved") =>
                    {
                        let mut kept = old.clone();
                        if let Some(provenance) = kept.cache_provenance.as_mut() {
                            provenance.retain_initializers(|service| {
                                prepared
                                    .resources
                                    .contains_key(&format!("container:{service}"))
                            });
                        }
                        kept
                    }
                    // New or changed identity: fresh-admission selection of the
                    // shared cache; the recorded reference (if any) is released.
                    _ => Resource {
                        id: None,
                        cache_provenance: None,
                        phase: "reserved".into(),
                        ..resource.clone()
                    },
                }
            } else if let Some(old) = retained.get(key) {
                if old.key != resource.key || old.disposable_caches != resource.disposable_caches {
                    return Err(refused(
                        "A retained volume's disposable-cache declaration changed; it was not reattached.",
                    ));
                }
                (*old).clone()
            } else {
                let name = (0..64)
                    .map(|index| format!("{prefix}{index}"))
                    .find(|name| !used.contains(name))
                    .ok_or_else(|| refused("No owned volume name is available."))?;
                used.insert(name.clone());
                Resource {
                    name,
                    id: None,
                    phase: "reserved".into(),
                    ..resource.clone()
                }
            };
            if renamed
                .insert(resource.name.clone(), selected.name.clone())
                .is_some()
            {
                return Err(refused("Prepared volume names are not unique."));
            }
            resources.insert(key.clone(), selected);
        }
        // Retained data a changed plan no longer declares stays owned and recorded.
        // A dependency cache is not run-owned data: an undeclared one is released.
        for (key, resource) in &retained {
            resources
                .entry((*key).clone())
                .or_insert_with(|| (*resource).clone());
        }
        if !resource_counts_fit(&resources) || !network_bindings_valid(&resources) {
            return Err(error(
                "graph_budget",
                "Reconciled graph exceeds eight retained and declared volumes; remove unused data explicitly.",
            ));
        }
        for (name, config) in &mut prepared.configs {
            let resource = resources
                .get(&format!("container:{name}"))
                .ok_or_else(|| refused("Reconciled container identity is missing."))?;
            if config["Labels"]
                != labels(
                    &receipt.owner,
                    &receipt.run,
                    &receipt.namespace,
                    &prepared.plan_id,
                    resource,
                )
            {
                return Err(refused("Reconciled labels differ from expected ownership."));
            }
            config["Labels"] = labels(
                &receipt.owner,
                &receipt.run,
                &receipt.namespace,
                &receipt.plan_id,
                resource,
            );
            if let Some(mounts) = config["HostConfig"]["Mounts"].as_array_mut() {
                for mount in mounts.iter_mut().filter(|m| m["Type"] == "volume") {
                    let source = mount["Source"]
                        .as_str()
                        .and_then(|name| renamed.get(name))
                        .ok_or_else(|| refused("A mount names an unknown volume."))?;
                    mount["Source"] = json!(source);
                }
            }
        }
        prepared.plan_id = receipt.plan_id.clone();
        // Later admission checks read the same projected bindings as the receipt.
        prepared.resources = resources.clone();
        Ok(Projection { resources })
    }

    /// Replace in-memory next-attempt state after history retention; the fresh
    /// owner's admission persists it. Ownership identity is never changed.
    pub(super) fn apply(
        &self,
        receipt: &mut Receipt,
        projection: Projection,
        readiness: &BTreeMap<String, Condition>,
        source: Option<SourceBinding>,
    ) -> Result<(), CandidateError> {
        if !self.matches_receipt(receipt) || receipt.phase != "stopped-data-retained" {
            return Err(refused("Reconciliation ownership changed."));
        }
        receipt.normalized_input = Some(self.next.clone());
        receipt.readiness = readiness.clone();
        receipt.source = source;
        receipt.resources = projection.resources;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::DirBuilderExt, path::Path};

    const RUN: &str = "abababababababababababababababab";

    struct Project {
        _fixture: super::super::tests::Fixture,
        candidate: Candidate,
        root: std::path::PathBuf,
    }

    impl Project {
        fn new() -> Self {
            let fixture = super::super::tests::Fixture::new();
            let root = fixture.0.join("project");
            fs::create_dir(&root).unwrap();
            let candidate = Candidate::discover(&fixture.0).unwrap();
            Self {
                _fixture: fixture,
                candidate,
                root,
            }
        }

        fn review(&self, document: Value) -> (project::PlanReport, NormalizedInputIdentity) {
            let bytes = serde_json::to_vec(&document).unwrap();
            fs::write(self.root.join("compose.yaml"), &bytes).unwrap();
            let report = project::plan(
                &self.candidate,
                project::PlanOptions {
                    branch: None,
                    project: &self.root,
                    compose_file: Path::new("compose.yaml"),
                    profiles: &[],
                },
            )
            .unwrap();
            let identity = NormalizedInputIdentity {
                namespace: report.plan.namespace.clone(),
                original_compose_sha256: report
                    .plan
                    .original_compose_sha256
                    .clone()
                    .unwrap_or_else(|| report.plan.compose_sha256.clone()),
                normalized_compose_sha256: report.plan.compose_sha256.clone(),
            };
            (report, identity)
        }

        fn prepared(
            &self,
            document: Value,
        ) -> (
            project::PlanReport,
            NormalizedInputIdentity,
            config::Prepared,
        ) {
            self.prepared_with(document, false)
        }

        /// Dependency-cache graphs resolve their identities from a reviewed
        /// source snapshot, as a fresh admission's publication supplies it.
        fn prepared_with(
            &self,
            document: Value,
            cached: bool,
        ) -> (
            project::PlanReport,
            NormalizedInputIdentity,
            config::Prepared,
        ) {
            let (report, identity) = self.review(document);
            let inputs = project::inputs::compile(
                &self.candidate,
                project::PlanOptions {
                    branch: None,
                    project: &self.root,
                    compose_file: Path::new("compose.yaml"),
                    profiles: &[],
                },
                &report.plan_id,
                &BTreeMap::new(),
            )
            .unwrap();
            let readiness = report
                .plan
                .services
                .iter()
                .filter(|(_, service)| service.active)
                .map(|(name, service)| {
                    let goal = if service.dependency_cache.is_some() {
                        Condition::Completed
                    } else {
                        Condition::Started
                    };
                    (name.clone(), goal)
                })
                .collect();
            let source = cached.then(|| {
                let snapshot = project::snapshot::capture_plan(&report.plan).unwrap();
                let manifest = snapshot.receipt().clone();
                source::Inputs {
                    current_manifest: None,
                    binding: SourceBinding {
                        cache_scope: None,
                        shared: None,
                        shared_contract: None,
                        live: None,
                        revision: manifest.revision.clone(),
                        archive_sha256: "6".repeat(64),
                        selection_sha256: manifest.selection_sha256.clone(),
                    },
                    manifest,
                    paths: BTreeMap::new(),
                }
            });
            let prepared =
                config::prepare(inputs, &readiness, RUN, &"b".repeat(32), source.as_ref()).unwrap();
            (report, identity, prepared)
        }
    }

    fn added(projection: &Projection) -> BTreeSet<String> {
        projection
            .resources
            .iter()
            .filter(|(_, resource)| resource.kind == Kind::Volume && !retained_volume(resource))
            .map(|(key, _)| key.clone())
            .collect()
    }

    fn same(left: &Resource, right: &Resource) -> bool {
        serde_json::to_value(left).unwrap() == serde_json::to_value(right).unwrap()
    }

    fn image(tag: char) -> String {
        format!("sha256:{}", tag.to_string().repeat(64))
    }

    fn service(command: &str, tag: char, volumes: &[&str]) -> Value {
        json!({
            "image": image(tag),
            "network_mode": "none",
            "entrypoint": ["/bin/app"],
            "command": [command],
            "volumes": volumes.iter().map(|v| format!("{v}:/data/{v}")).collect::<Vec<_>>(),
        })
    }

    fn compose(services: Value, volumes: &[&str]) -> Value {
        json!({
            "services": services,
            "volumes": volumes.iter().map(|v| (v.to_string(), json!({}))).collect::<serde_json::Map<_, _>>(),
        })
    }

    /// Stopped receipt exactly as the first admission of `document` recorded it:
    /// containers confirmed absent, volumes created under the ownership plan.
    fn stopped(prepared: &config::Prepared, identity: &NormalizedInputIdentity) -> Receipt {
        let mut resources = prepared.resources.clone();
        for resource in resources.values_mut() {
            resource.phase = if resource.kind == Kind::Volume {
                "created"
            } else {
                "absent"
            }
            .into();
        }
        Receipt {
            startup_failure: None,
            normalized_input: Some(identity.clone()),
            relay_startup: None,
            relay_cleanup: None,
            probes: BTreeMap::new(),
            version: 1,
            run: RUN.into(),
            owner: "b".repeat(32),
            namespace: prepared.namespace.clone(),
            plan_id: prepared.plan_id.clone(),
            phase: "stopped-data-retained".into(),
            environment_attached: false,
            initializer_cache_release: BTreeMap::new(),
            source: None,
            readiness: BTreeMap::new(),
            resources,
        }
    }

    fn mounts(prepared: &config::Prepared, service: &str) -> Vec<String> {
        prepared.configs[service]["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["Source"].as_str().unwrap().to_owned())
            .collect()
    }

    fn reconcile(
        project: &Project,
        receipt: &Receipt,
        next: Value,
    ) -> (config::Prepared, Projection) {
        let (report, identity, mut prepared) = project.prepared(next);
        assert!(applies(
            receipt,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
        let proof = prepare(&report.plan, receipt, &identity).unwrap();
        let projection = proof.project(&mut prepared, receipt).unwrap();
        assert_eq!(
            prepared.plan_id, receipt.plan_id,
            "ownership plan is retained"
        );
        assert_eq!(prepared.resources.len(), projection.resources.len());
        for (key, resource) in &projection.resources {
            assert!(
                same(resource, &prepared.resources[key]),
                "{key} is projected"
            );
        }
        for (name, config) in &prepared.configs {
            assert_eq!(
                config["Labels"]["io.hack-local.plan"], receipt.plan_id,
                "{name} keeps ownership labels"
            );
            assert_eq!(config["Labels"]["io.hack-local.graph"], RUN);
        }
        let mut applied = receipt.clone();
        let snapshot = Projection {
            resources: projection.resources.clone(),
        };
        proof
            .apply(&mut applied, snapshot, &BTreeMap::new(), None)
            .unwrap();
        assert_eq!(applied.normalized_input.as_ref(), Some(&identity));
        assert_eq!(applied.plan_id, receipt.plan_id);
        assert_eq!(applied.run, receipt.run);
        (prepared, projection)
    }

    fn base(project: &Project) -> (Receipt, config::Prepared) {
        let (report, identity, prepared) = project.prepared(compose(
            json!({"db": service("serve", 'a', &["data"]), "web": service("web", 'a', &[])}),
            &["data"],
        ));
        let receipt = stopped(&prepared, &identity);
        assert!(!applies(
            &receipt,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
        (receipt, prepared)
    }

    #[test]
    fn changed_command_image_and_environment_reattach_the_same_volume() {
        let project = Project::new();
        let (receipt, original) = base(&project);
        let data = receipt.resources["volume:data"].name.clone();
        let mut command = service("serve --changed", 'a', &["data"]);
        let mut environment = service("serve", 'a', &["data"]);
        environment["environment"] = json!({"MODE": "changed"});
        for db in [
            command.take(),
            service("serve", 'c', &["data"]),
            environment,
        ] {
            let (prepared, projection) = reconcile(
                &project,
                &receipt,
                compose(
                    json!({"db": db, "web": service("web", 'a', &[])}),
                    &["data"],
                ),
            );
            assert!(added(&projection).is_empty());
            assert!(same(
                &projection.resources["volume:data"],
                &receipt.resources["volume:data"]
            ));
            assert_eq!(mounts(&prepared, "db"), vec![data.clone()]);
            assert_eq!(
                projection.resources["container:db"].phase, "reserved",
                "changed compute is recreated"
            );
        }
        assert_eq!(mounts(&original, "db"), vec![data]);
    }

    #[test]
    fn added_and_removed_services_recreate_compute_and_keep_data() {
        let project = Project::new();
        let (receipt, _) = base(&project);
        let (_, added) = reconcile(
            &project,
            &receipt,
            compose(
                json!({
                    "db": service("serve", 'a', &["data"]),
                    "web": service("web", 'a', &[]),
                    "worker": service("work", 'a', &[]),
                }),
                &["data"],
            ),
        );
        assert!(added.resources.contains_key("container:worker"));
        let (_, removed) = reconcile(
            &project,
            &receipt,
            compose(json!({"db": service("serve", 'a', &["data"])}), &["data"]),
        );
        assert!(!removed.resources.contains_key("container:web"));
        assert!(same(
            &removed.resources["volume:data"],
            &receipt.resources["volume:data"]
        ));
    }

    #[test]
    fn changed_volume_set_reattaches_by_key_creates_fresh_names_and_keeps_orphans() {
        let project = Project::new();
        let (receipt, _) = base(&project);
        let retained = receipt.resources["volume:data"].clone();
        // `cache` sorts first, so ordinary indexing would have reused data's name.
        let (prepared, projection) = reconcile(
            &project,
            &receipt,
            compose(
                json!({"db": service("serve", 'a', &["cache", "data"])}),
                &["cache", "data"],
            ),
        );
        assert!(same(&projection.resources["volume:data"], &retained));
        let fresh = &projection.resources["volume:cache"];
        assert_ne!(fresh.name, retained.name);
        assert!(fresh.name.starts_with(&volume_prefix(RUN)));
        assert_eq!(fresh.phase, "reserved");
        assert_eq!(
            added(&projection),
            BTreeSet::from(["volume:cache".to_owned()])
        );
        assert_eq!(
            mounts(&prepared, "db"),
            vec![fresh.name.clone(), retained.name.clone()]
        );
        // Dropping the declaration keeps the retained data recorded and unmounted.
        let (prepared, projection) = reconcile(
            &project,
            &receipt,
            compose(json!({"db": service("serve", 'a', &[])}), &[]),
        );
        assert!(same(&projection.resources["volume:data"], &retained));
        assert!(mounts(&prepared, "db").is_empty());
        // A later reconciled receipt without the ordinary layout stays on this path.
        let mut later = receipt.clone();
        later.resources = projection.resources;
        let (report, identity) =
            project.review(compose(json!({"db": service("serve", 'a', &[])}), &[]));
        later.normalized_input = Some(identity.clone());
        later.plan_id = report.plan_id.clone();
        assert!(applies(
            &later,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
    }

    #[test]
    fn another_instance_or_foreign_data_is_never_reattached() {
        let project = Project::new();
        let (receipt, _) = base(&project);
        let next = compose(
            json!({"db": service("serve --changed", 'a', &["data"])}),
            &["data"],
        );
        let (report, identity, _) = project.prepared(next.clone());
        // Another project instance: same keys, different namespace.
        let mut other = receipt.clone();
        other.namespace = "9".repeat(64);
        if let Some(previous) = other.normalized_input.as_mut() {
            previous.namespace = other.namespace.clone();
        }
        assert_eq!(
            prepare(&report.plan, &other, &identity).err().unwrap().code,
            "graph_plan_reconcile"
        );
        // A recorded volume name outside this run's owned names.
        let mut foreign = receipt.clone();
        foreign.resources.get_mut("volume:data").unwrap().name =
            format!("hkg-{}-volume-0", "c".repeat(32));
        assert_eq!(
            prepare(&report.plan, &foreign, &identity)
                .err()
                .unwrap()
                .code,
            "graph_plan_reconcile"
        );
        // Uncertain creation is never treated as settled data.
        let mut uncertain = receipt.clone();
        uncertain.resources.get_mut("volume:data").unwrap().phase = "create-intent".into();
        assert!(prepare(&report.plan, &uncertain, &identity).is_err());
        // A proof is bound to its receipt's ownership and cannot be replayed elsewhere.
        let (_, _, mut prepared) = project.prepared(next);
        let proof = prepare(&report.plan, &receipt, &identity).unwrap();
        let mut moved = receipt.clone();
        moved.owner = "d".repeat(32);
        assert!(proof.project(&mut prepared, &moved).is_err());
        assert!(
            proof
                .verify_fresh(&moved, &identity, &"1".repeat(64), &"1".repeat(64))
                .is_err()
        );
        assert!(
            proof
                .verify_fresh(&receipt, &identity, &"1".repeat(64), &"2".repeat(64))
                .is_err()
        );
        proof
            .verify_fresh(&receipt, &identity, &"1".repeat(64), &"1".repeat(64))
            .unwrap();
    }

    #[test]
    fn caches_live_source_and_rebind_keep_their_dedicated_paths() {
        let project = Project::new();
        let (receipt, _) = base(&project);
        let (report, identity) = project.review(compose(
            json!({"db": service("serve --changed", 'a', &["data"])}),
            &["data"],
        ));
        assert!(!applies(
            &receipt,
            &report.plan_id,
            &report.plan,
            &identity,
            true
        ));
        let mut cached = receipt.clone();
        cached
            .initializer_cache_release
            .insert("db".into(), initializer_cache::Record::selected());
        assert!(!applies(
            &cached,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
        assert!(prepare(&report.plan, &cached, &identity).is_err());
        let mut legacy = receipt;
        legacy.normalized_input = None;
        assert!(!applies(
            &legacy,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
    }

    #[test]
    fn restore_selection_binds_settled_data_and_never_adopts_a_reserved_name() {
        let project = Project::new();
        let (receipt, _) = base(&project);
        let (_, projection) = reconcile(
            &project,
            &receipt,
            compose(
                json!({"db": service("serve", 'a', &["cache", "data"])}),
                &["cache", "data"],
            ),
        );
        let mut next = receipt.clone();
        next.resources = projection.resources;
        let present = |_: &Resource| {
            Ok(Some(
                json!({"inspected": {"Name": "x"}, "directory": "1:2"}),
            ))
        };
        let selected = super::super::restore::observed_volumes_with(&next, |resource| {
            if retained_volume(resource) {
                present(resource)
            } else {
                Ok(None)
            }
        })
        .unwrap();
        assert_eq!(selected.keys().collect::<Vec<_>>(), vec!["volume:data"]);
        let adopted = super::super::restore::observed_volumes_with(&next, present).unwrap_err();
        assert_eq!(adopted.code, "graph_resource_exists");
        let missing =
            super::super::restore::observed_volumes_with(&next, |_| Ok(None)).unwrap_err();
        assert_eq!(missing.code, "graph_data_missing");
    }

    /// An initializer populating a dependency cache, beside an app that mounts
    /// the cache read-write (so the cache is instance-scoped) and its own data.
    fn cached(marker: &str, installer: &str) -> Value {
        cached_with(marker, installer, "deps:/deps")
    }

    /// The same graph whose app only reads the cache, so the cache is shared.
    fn cached_shared(marker: &str, installer: &str) -> Value {
        cached_with(marker, installer, "deps:/deps:ro")
    }

    fn cached_with(marker: &str, installer: &str, consumer: &str) -> Value {
        json!({
            "services": {
                "deps": {
                    "image": image('a'),
                    "network_mode": "none",
                    "entrypoint": [installer],
                    "volumes": ["deps:/deps"],
                    "labels": {
                        "hack.dependencies.bootstrap": "true",
                        "hack.dependencies.cache-volume": "deps",
                        "hack.dependencies.lockfiles": "lock.txt",
                    },
                },
                "app": {
                    "image": image('a'),
                    "network_mode": "none",
                    "entrypoint": ["/bin/app"],
                    "environment": {"MARKER": marker},
                    "volumes": [consumer, "data:/data"],
                },
            },
            "volumes": {"deps": {}, "data": {}},
        })
    }

    fn cached_project() -> (Project, Receipt, config::Prepared) {
        cached_project_with(cached("one", "/bin/install"))
    }

    fn cached_project_with(document: Value) -> (Project, Receipt, config::Prepared) {
        let project = Project::new();
        fs::write(project.root.join("lock.txt"), "v1").unwrap();
        let shared = document["services"]["app"]["volumes"][0] == "deps:/deps:ro";
        let (report, identity, prepared) = project.prepared_with(document, true);
        let mut receipt = stopped(&prepared, &identity);
        // A completed first admission recorded the cache's provenance fence.
        let provenance: cache_provenance::CacheProvenance = serde_json::from_value(json!({
            "version": 1, "origin": "created_here", "boot": "boot",
            "identity": {"created_at": "2026-11-06T00:00:00Z", "directory": "1:2"},
            "initializers": ["deps"], "completed": {},
        }))
        .unwrap();
        receipt
            .resources
            .get_mut("volume:deps")
            .unwrap()
            .cache_provenance = Some(provenance);
        assert!(receipt.resources["volume:deps"].cache.is_some());
        // A shared cache keeps strict replay; an instance-scoped one always
        // re-proves its identity through reconciliation.
        assert_eq!(
            applies(&receipt, &report.plan_id, &report.plan, &identity, false),
            !shared
        );
        (project, receipt, prepared)
    }

    fn reconcile_cached(
        project: &Project,
        receipt: &Receipt,
        next: Value,
    ) -> (config::Prepared, Projection) {
        let (report, identity, mut prepared) = project.prepared_with(next, true);
        assert!(applies(
            receipt,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
        let proof = prepare(&report.plan, receipt, &identity).unwrap();
        let projection = proof.project(&mut prepared, receipt).unwrap();
        let mut applied = receipt.clone();
        let snapshot = Projection {
            resources: projection.resources.clone(),
        };
        let readiness = projection
            .resources
            .values()
            .filter(|resource| resource.kind == Kind::Container)
            .map(|resource| (resource.key.clone(), Condition::Started))
            .collect();
        proof
            .apply(&mut applied, snapshot, &readiness, None)
            .unwrap();
        // The reconciled receipt still loads: every cache name and provenance is valid.
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join(RUN);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        state::write(&root.join("state.json"), &applied).unwrap();
        super::super::load_at(root, RUN, &applied.owner).unwrap();
        (prepared, projection)
    }

    #[test]
    fn env_edit_to_another_service_reconciles_and_keeps_the_dependency_cache() {
        let (project, receipt, original) = cached_project();
        let cache = receipt.resources["volume:deps"].clone();
        let (prepared, projection) =
            reconcile_cached(&project, &receipt, cached("two", "/bin/install"));
        // The same shared cache, with its provenance, and the same run-owned data.
        assert!(same(&projection.resources["volume:deps"], &cache));
        assert!(same(
            &projection.resources["volume:data"],
            &receipt.resources["volume:data"]
        ));
        assert!(added(&projection).is_empty());
        assert_eq!(mounts(&prepared, "deps"), mounts(&original, "deps"));
        assert_eq!(mounts(&prepared, "app"), mounts(&original, "app"));
        assert_eq!(projection.resources["container:app"].phase, "reserved");
    }

    #[test]
    fn changed_cache_inputs_select_a_fresh_cache_and_keep_run_data() {
        let (project, receipt, _) = cached_project();
        let old = receipt.resources["volume:deps"].clone();
        // The initializer's own definition is a cache input.
        let (prepared, projection) =
            reconcile_cached(&project, &receipt, cached("one", "/bin/install-v2"));
        let fresh = &projection.resources["volume:deps"];
        assert_ne!(fresh.cache, old.cache);
        assert_ne!(fresh.name, old.name);
        assert_eq!(fresh.name, fresh.cache.as_ref().unwrap().name());
        assert_eq!(fresh.phase, "reserved");
        assert!(fresh.cache_provenance.is_none());
        assert!(mounts(&prepared, "app").contains(&fresh.name));
        assert!(!mounts(&prepared, "app").contains(&old.name));
        assert!(same(
            &projection.resources["volume:data"],
            &receipt.resources["volume:data"]
        ));
        // So is a lockfile's content.
        fs::write(project.root.join("lock.txt"), "v2").unwrap();
        let (_, projection) = reconcile_cached(&project, &receipt, cached("two", "/bin/install"));
        let rebuilt = &projection.resources["volume:deps"];
        assert_ne!(rebuilt.cache, old.cache);
        assert_eq!(rebuilt.phase, "reserved");
    }

    #[test]
    fn adding_a_cache_writer_selects_a_fresh_cache() {
        let (project, receipt, _) = cached_project();
        let old = receipt.resources["volume:deps"].clone();
        // A new service that mounts the shared cache read-write can change what
        // every run sharing it reuses, so it is part of the cache identity.
        let mut next = cached("one", "/bin/install");
        next["services"]["worker"] = json!({
            "image": image('a'),
            "network_mode": "none",
            "entrypoint": ["/bin/worker"],
            "volumes": ["deps:/deps"],
        });
        let (_, projection) = reconcile_cached(&project, &receipt, next);
        let fresh = &projection.resources["volume:deps"];
        assert_ne!(fresh.cache, old.cache);
        assert_eq!(fresh.phase, "reserved");
        assert!(same(
            &projection.resources["volume:data"],
            &receipt.resources["volume:data"]
        ));
    }

    #[test]
    fn retained_run_data_is_never_reselected_as_a_dependency_cache() {
        let project = Project::new();
        fs::write(project.root.join("lock.txt"), "v1").unwrap();
        let mut plain = cached("one", "/bin/install");
        plain["services"]["deps"]
            .as_object_mut()
            .unwrap()
            .remove("labels");
        let (_, identity, prepared) = project.prepared(plain);
        let receipt = stopped(&prepared, &identity);
        assert!(receipt.resources["volume:deps"].cache.is_none());
        let (report, identity, mut next) =
            project.prepared_with(cached("one", "/bin/install"), true);
        let failure = prepare(&report.plan, &receipt, &identity).err().unwrap();
        assert_eq!(failure.code, "graph_plan_reconcile");
        let change = failure.plan_change().unwrap();
        assert_eq!(change.service, "deps");
        assert_eq!(change.field, PlanChangeField::DependencyCacheVolume);
        // Admission repeats the check on the projection itself.
        let proof = Verified {
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            namespace: receipt.namespace.clone(),
            ownership_plan: receipt.plan_id.clone(),
            previous: receipt.normalized_input.clone().unwrap(),
            next: identity,
        };
        let failure = proof.project(&mut next, &receipt).err().unwrap();
        assert_eq!(failure.plan_change().unwrap().service, "deps");
    }

    #[test]
    fn dropping_a_cache_declaration_releases_the_reference_and_creates_run_data() {
        let (project, receipt, _) = cached_project();
        let mut plain = cached("one", "/bin/install");
        plain["services"]["deps"]
            .as_object_mut()
            .unwrap()
            .remove("labels");
        let (report, identity, mut prepared) = project.prepared(plain);
        let proof = prepare(&report.plan, &receipt, &identity).unwrap();
        let projection = proof.project(&mut prepared, &receipt).unwrap();
        let deps = &projection.resources["volume:deps"];
        assert!(deps.cache.is_none());
        assert_eq!(deps.phase, "reserved");
        assert!(deps.name.starts_with(&volume_prefix(RUN)));
        assert_ne!(deps.name, receipt.resources["volume:data"].name);
    }

    #[test]
    fn legacy_cache_identity_is_kept_only_while_its_inputs_still_match() {
        let (project, mut receipt, original) =
            cached_project_with(cached_shared("one", "/bin/install"));
        let legacy = original.legacy_caches["deps"].clone();
        assert_ne!(
            Some(&legacy),
            original.resources["volume:deps"].cache.as_ref()
        );
        let deps = receipt.resources.get_mut("volume:deps").unwrap();
        deps.cache = Some(legacy.clone());
        deps.name = legacy.name();
        // Unchanged review: strict replay keeps the recorded legacy cache.
        let (report, identity, mut prepared) =
            project.prepared_with(cached_shared("one", "/bin/install"), true);
        // The review's source metadata is fresh; the receipt is that admission's.
        receipt.plan_id = report.plan_id.clone();
        assert!(!applies(
            &receipt,
            &report.plan_id,
            &report.plan,
            &identity,
            false
        ));
        config::retain_replay_ownership(&mut prepared, &receipt).unwrap();
        assert_eq!(prepared.resources["volume:deps"].name, legacy.name());
        assert!(mounts(&prepared, "app").contains(&legacy.name()));
        // An edit changes the legacy whole-document identity: the current one is
        // selected once, after which edits elsewhere keep it.
        let (_, projection) =
            reconcile_cached(&project, &receipt, cached_shared("two", "/bin/install"));
        let fresh = &projection.resources["volume:deps"];
        assert_ne!(fresh.name, legacy.name());
        assert_eq!(fresh.cache, original.resources["volume:deps"].cache);
        assert_eq!(fresh.phase, "reserved");
    }

    #[test]
    fn an_earlier_shared_cache_with_a_writable_consumer_moves_to_this_instance() {
        let (project, mut receipt, original) = cached_project();
        // No earlier identity is ever matched for a writable consumer.
        assert!(!original.legacy_caches.contains_key("deps"));
        let scoped = original.resources["volume:deps"].cache.clone().unwrap();
        // A receipt from an earlier build names a cache shared across worktrees.
        let shared = dependency_cache::CacheBinding {
            scope: dependency_cache::scope(&project.root).unwrap(),
            fingerprint: "c".repeat(64),
            image: scoped.image.clone(),
        };
        assert_ne!(shared.scope, scoped.scope);
        let deps = receipt.resources.get_mut("volume:deps").unwrap();
        deps.cache = Some(shared.clone());
        deps.name = shared.name();
        // Even the unchanged review re-proves identity and selects this
        // instance's cache once; the shared one is never mounted again.
        let (prepared, projection) =
            reconcile_cached(&project, &receipt, cached("one", "/bin/install"));
        let fresh = &projection.resources["volume:deps"];
        assert_eq!(fresh.cache.as_ref(), Some(&scoped));
        assert_eq!(fresh.phase, "reserved");
        assert!(!mounts(&prepared, "app").contains(&shared.name()));
    }

    #[test]
    fn reserved_shared_caches_may_exist_but_reserved_run_names_may_not() {
        let (project, receipt, _) = cached_project();
        let (_, projection) =
            reconcile_cached(&project, &receipt, cached("one", "/bin/install-v2"));
        let mut next = receipt.clone();
        next.resources = projection.resources;
        let present = |_: &Resource| {
            Ok(Some(
                json!({"inspected": {"Name": "x"}, "directory": "1:2"}),
            ))
        };
        // The fresh cache may already exist as another graph's shared cache.
        let selected = super::super::restore::observed_volumes_with(&next, present).unwrap();
        assert!(!selected.contains_key("volume:deps"));
        assert!(selected.contains_key("volume:data"));
        let mut owned = next.clone();
        let data = owned.resources.get_mut("volume:data").unwrap();
        data.phase = "reserved".into();
        assert_eq!(
            super::super::restore::observed_volumes_with(&owned, present)
                .unwrap_err()
                .code,
            "graph_resource_exists"
        );
    }
}
