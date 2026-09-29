//! Scoped normalized hostname transition, reverified under the provider lease.
//! A proof never permits changing compute, data, source selection or ownership.
use super::*;

fn refused() -> CandidateError {
    error(
        "graph_hostname_change",
        "Retained hostname change requires its original literal-preserving contract and unchanged graph bindings; values omitted.",
    )
}

pub(super) struct Verified {
    pub source: source::Inputs,
    previous: NormalizedInputIdentity,
    next: NormalizedInputIdentity,
    run: String,
    owner: String,
    namespace: String,
    ownership_plan: String,
    routes: BTreeMap<String, project::RoutingPlan>,
}

fn selected_routes(
    plan: &project::PlanData,
    receipt: &Receipt,
) -> Result<BTreeMap<String, project::RoutingPlan>, CandidateError> {
    let mut names = BTreeSet::new();
    let routes = plan
        .services
        .iter()
        .filter(|(_, service)| service.active)
        .filter_map(|(name, service)| {
            service
                .routing
                .as_ref()
                .map(|route| (name.clone(), route.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let prior = receipt
        .resources
        .values()
        .filter_map(|resource| {
            resource
                .routing
                .as_ref()
                .map(|route| (resource.key.clone(), route))
        })
        .collect::<BTreeMap<_, _>>();
    if routes.is_empty()
        || routes.len() != prior.len()
        || !routes.iter().all(|(service, route)| {
            prior.get(service).is_some_and(|old| old.port == route.port)
                && routes::valid_intent(route)
                && route
                    .hostnames
                    .iter()
                    .all(|name| names.insert(name.clone()))
        })
        || routes
            .iter()
            .all(|(service, route)| prior.get(service).is_some_and(|old| *old == route))
    {
        return Err(refused());
    }
    Ok(routes)
}

/// Identical normalized input remains on the ordinary strict replay path.
/// Changed input can be admitted only through a fresh proof of literal-preserving
/// hashes plus the retained source/cache/mount contract. Nothing is persisted here.
pub(super) fn prepare(
    engine: &Engine<'_>,
    plan: &project::PlanData,
    receipt: &Receipt,
    next: &NormalizedInputIdentity,
) -> Result<Option<Verified>, CandidateError> {
    let previous = receipt.normalized_input.as_ref().ok_or_else(refused)?;
    if !next.matches_plan(plan) || plan.namespace != receipt.namespace {
        return Err(refused());
    }
    if previous == next {
        return Ok(None);
    }
    let routes = selected_routes(plan, receipt)?;
    let binding = receipt.source.as_ref().ok_or_else(refused)?;
    let cached = plan
        .services
        .values()
        .any(|service| service.active && service.dependency_cache.is_some());
    let source = source::prepare_shared_hostnames(
        engine,
        plan,
        receipt,
        cached.then_some(binding.revision.as_str()),
    )?;
    super::super::publication::check_hostname_change(
        engine.guest().candidate(),
        &receipt.owner,
        &receipt.run,
        &routes
            .values()
            .flat_map(|route| route.hostnames.iter().cloned())
            .collect(),
    )?;
    Ok(Some(Verified {
        source,
        previous: previous.clone(),
        next: next.clone(),
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        ownership_plan: receipt.plan_id.clone(),
        routes,
    }))
}

impl Verified {
    fn matches_receipt(&self, receipt: &Receipt) -> bool {
        self.run == receipt.run
            && self.owner == receipt.owner
            && self.namespace == receipt.namespace
            && self.ownership_plan == receipt.plan_id
            && receipt.normalized_input.as_ref() == Some(&self.previous)
    }

    pub(super) fn matches_fresh(&self, receipt: &Receipt, next: &NormalizedInputIdentity) -> bool {
        self.matches_receipt(receipt) && next == &self.next
    }

    /// Keep the generic resource comparator strict. Only this proof may project
    /// reviewed hostnames back to retained names before checking every binding.
    pub(super) fn matches_resources(
        &self,
        resources: &BTreeMap<String, Resource>,
        receipt: &Receipt,
    ) -> bool {
        if !self.matches_receipt(receipt) {
            return false;
        }
        let mut projected = resources.clone();
        for (key, resource) in &mut projected {
            if let Some(route) = resource.routing.as_ref() {
                if self.routes.get(&resource.key) != Some(route) {
                    return false;
                }
                resource.routing = receipt
                    .resources
                    .get(key)
                    .and_then(|old| old.routing.clone());
            }
        }
        same_resource_bindings(&projected, &receipt.resources)
    }

    /// Change only in-memory next-attempt state after history retention. The
    /// existing fresh-driver admission writes provenance and route intent together.
    pub(super) fn apply(&self, receipt: &mut Receipt) -> Result<(), CandidateError> {
        if !self.matches_receipt(receipt) || receipt.phase != "stopped-data-retained" {
            return Err(refused());
        }
        receipt.normalized_input = Some(self.next.clone());
        receipt.source = Some(self.source.binding.clone());
        for resource in receipt.resources.values_mut() {
            if let Some(route) = self.routes.get(&resource.key) {
                resource.routing = Some(route.clone());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::path::Path;

    /// Pure next-attempt fixture: no engine, process, listener or VM is created.
    pub(in crate::provider::graph) fn transition()
    -> (super::super::tests::Fixture, Receipt, Verified) {
        let fixture = super::super::tests::Fixture::new();
        let project = fixture.0.join("project");
        fs::create_dir(&project).unwrap();
        let bytes = b"services: {web: {image: alpine, volumes: ['.:/app:ro']}}";
        fs::write(project.join("compose.yaml"), bytes).unwrap();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let plan = project::plan(
            &candidate,
            project::PlanOptions {
                branch: None,
                project: &project,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let snapshot = project::snapshot::capture_plan(&plan.plan).unwrap();
        let previous = NormalizedInputIdentity {
            namespace: plan.plan.namespace.clone(),
            original_compose_sha256: "e".repeat(64),
            normalized_compose_sha256: "f".repeat(64),
        };
        let next = NormalizedInputIdentity {
            normalized_compose_sha256: "9".repeat(64),
            ..previous.clone()
        };
        let old_route = project::RoutingPlan {
            hostnames: vec!["web.hack".into()],
            port: 3000,
        };
        let new_route = project::RoutingPlan {
            hostnames: vec!["web.hack".into(), "web.v5.hack.gy".into()],
            port: 3000,
        };
        let binding = source::SourceBinding {
            shared: None,
            shared_contract: Some(
                project::live_source::Contract::from_plan(&plan.plan, snapshot.receipt()).unwrap(),
            ),
            live: None,
            revision: snapshot.receipt().revision.clone(),
            archive_sha256: "6".repeat(64),
            selection_sha256: snapshot.receipt().selection_sha256.clone(),
        };
        let resource = |key: &str, kind, routing| Resource {
            routing,
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind,
            key: key.into(),
            name: format!("owned-{key}"),
            id: None,
            image: None,
            phase: "absent".into(),
        };
        let mut volume = resource("data", Kind::Volume, None);
        volume.id = Some("retained-volume-id".into());
        volume.phase = "present".into();
        let receipt:Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":previous.namespace,"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"normalized_input":previous,"source":binding,"resources":{}})).unwrap();
        let mut receipt = receipt;
        receipt.resources = BTreeMap::from([
            (
                "container:web".into(),
                resource("web", Kind::Container, Some(old_route)),
            ),
            ("volume:data".into(), volume),
        ]);
        let verified = Verified {
            source: source::Inputs {
                current_manifest: Some(snapshot.receipt().clone()),
                manifest: snapshot.receipt().clone(),
                binding,
                paths: BTreeMap::new(),
            },
            previous,
            next,
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            namespace: receipt.namespace.clone(),
            ownership_plan: receipt.plan_id.clone(),
            routes: BTreeMap::from([("web".into(), new_route)]),
        };
        (fixture, receipt, verified)
    }

    #[test]
    fn scoped_resource_projection_keeps_generic_comparison_strict() {
        let (_fixture, receipt, proof) = transition();
        let mut resources = receipt.resources.clone();
        resources.get_mut("container:web").unwrap().routing = proof.routes.get("web").cloned();
        assert!(!same_resource_bindings(&resources, &receipt.resources));
        assert!(proof.matches_resources(&resources, &receipt));
        for field in [
            "image",
            "name",
            "outbound",
            "port",
            "extra-host",
            "missing-volume",
        ] {
            let mut changed = resources.clone();
            match field {
                "image" => {
                    changed.get_mut("container:web").unwrap().image =
                        Some(format!("sha256:{}", "7".repeat(64)))
                }
                "name" => changed.get_mut("volume:data").unwrap().name = "other-data".into(),
                "outbound" => changed.get_mut("container:web").unwrap().outbound = true,
                "port" => {
                    changed
                        .get_mut("container:web")
                        .unwrap()
                        .routing
                        .as_mut()
                        .unwrap()
                        .port = 3001
                }
                "extra-host" => changed
                    .get_mut("container:web")
                    .unwrap()
                    .routing
                    .as_mut()
                    .unwrap()
                    .hostnames
                    .push("unreviewed.hack".into()),
                _ => {
                    changed.remove("volume:data");
                }
            }
            assert!(
                !proof.matches_resources(&changed, &receipt),
                "accepted {field}"
            );
        }
    }

    #[test]
    fn next_receipt_changes_routes_and_provenance_together_preserving_ownership_and_data() {
        let (fixture, receipt, proof) = transition();
        let mut next = receipt.clone();
        proof.apply(&mut next).unwrap();
        assert_eq!(next.run, receipt.run);
        assert_eq!(next.owner, receipt.owner);
        assert_eq!(next.plan_id, receipt.plan_id);
        assert_eq!(
            next.resources["volume:data"].id,
            receipt.resources["volume:data"].id
        );
        assert_eq!(
            next.resources["container:web"].routing,
            proof.routes.get("web").cloned()
        );
        assert_eq!(next.normalized_input.as_ref(), Some(&proof.next));
        let path = fixture.0.join("next-state.json");
        state::write(&path, &next).unwrap();
        let saved: Receipt = state::read(&path).unwrap();
        assert_eq!(saved.normalized_input, next.normalized_input);
        assert_eq!(
            saved.resources["container:web"].routing,
            next.resources["container:web"].routing
        );
        assert!(proof.apply(&mut next).is_err());
        for field in ["owner", "run", "phase", "provenance"] {
            let mut stale = receipt.clone();
            match field {
                "owner" => stale.owner = "c".repeat(32),
                "run" => stale.run = "c".repeat(32),
                "phase" => stale.phase = "ready-observed".into(),
                _ => stale.normalized_input = None,
            }
            assert!(proof.apply(&mut stale).is_err());
        }
    }
}
