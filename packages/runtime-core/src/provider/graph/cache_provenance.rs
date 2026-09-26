//! Historical evidence only: this does not authorize reclamation or prove cache contents.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    CreatedHere,
    Adopted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolumeIdentity {
    created_at: String,
    directory: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Completion {
    container: String,
    started_at: String,
    finished_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheProvenance {
    version: u8,
    origin: Origin,
    boot: String,
    identity: VolumeIdentity,
    initializers: BTreeSet<String>,
    completed: BTreeMap<String, Completion>,
}
fn refused() -> CandidateError {
    error(
        "graph_cache_provenance",
        "Cache provenance identity or completion differs.",
    )
}
fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
impl CacheProvenance {
    pub(super) fn valid(&self, receipt: &Receipt, resource: &Resource) -> bool {
        self.version == 1
            && resource.kind == Kind::Volume
            && resource.cache.is_some()
            && bounded(&self.boot)
            && bounded(&self.identity.created_at)
            && super::volume_subpaths::valid_identity(&self.identity.directory)
            && self.initializers.len() <= MAX_SERVICES
            && self
                .initializers
                .iter()
                .all(|name| receipt.resources.contains_key(&format!("container:{name}")))
            && (self.origin == Origin::CreatedHere || self.completed.is_empty())
            && self.completed.iter().all(|(name, c)| {
                self.initializers.contains(name)
                    && hex(&c.container, 64)
                    && bounded(&c.started_at)
                    && bounded(&c.finished_at)
            })
    }
    pub(super) fn needs_completion(&self, service: &str) -> bool {
        self.origin == Origin::CreatedHere
            && self.initializers.contains(service)
            && !self.completed.contains_key(service)
    }
    pub(super) fn release_binding(
        &self,
        service: &str,
        resource: &Resource,
        volume: &Resource,
        boot: &str,
    ) -> Option<initializer_cache::Binding> {
        let completed = self.completed.get(service)?;
        if self.origin != Origin::CreatedHere
            || self.boot != boot
            || resource.id.as_ref() != Some(&completed.container)
        {
            return None;
        }
        Some(initializer_cache::Binding {
            boot: self.boot.clone(),
            container: completed.container.clone(),
            started_at: completed.started_at.clone(),
            finished_at: completed.finished_at.clone(),
            volume: volume.name.clone(),
            cache_fingerprint: volume.cache.as_ref()?.fingerprint.clone(),
        })
    }
    fn complete(
        &mut self,
        service: &str,
        resource: &Resource,
        value: &Value,
    ) -> Result<(), CandidateError> {
        if !self.needs_completion(service) {
            return Ok(());
        }
        let state = &value["State"];
        let id = value["Id"]
            .as_str()
            .filter(|v| hex(v, 64))
            .ok_or_else(refused)?;
        if resource.id.as_deref() != Some(id)
            || state["Status"] != "exited"
            || state["Running"] != false
            || state["Paused"] != false
            || state["Restarting"] != false
            || state["Dead"] != false
            || state["OOMKilled"] != false
            || state["ExitCode"] != 0
            || state["Pid"] != 0
        {
            return Err(refused());
        }
        let timestamp = |key: &str| {
            state[key]
                .as_str()
                .filter(|v| bounded(v) && !v.starts_with("0001-"))
                .map(str::to_owned)
                .ok_or_else(refused)
        };
        let completion = Completion {
            container: id.into(),
            started_at: timestamp("StartedAt")?,
            finished_at: timestamp("FinishedAt")?,
        };
        self.completed.insert(service.into(), completion);
        Ok(())
    }
}
fn identity(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<VolumeIdentity, CandidateError> {
    let before = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
    let created_at = before["CreatedAt"]
        .as_str()
        .filter(|s| bounded(s))
        .ok_or_else(refused)?
        .to_owned();
    let directory = super::volume_subpaths::directory_identity(engine, resource, &before)?;
    if inspect_resource(engine, receipt, resource)?.as_ref() != Some(&before) {
        return Err(refused());
    }
    Ok(VolumeIdentity {
        created_at,
        directory,
    })
}
pub(super) fn capture(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
    created: bool,
    initializers: BTreeSet<String>,
) -> Result<CacheProvenance, CandidateError> {
    Ok(CacheProvenance {
        version: 1,
        origin: if created {
            Origin::CreatedHere
        } else {
            Origin::Adopted
        },
        boot: engine.guest().boot_id().into(),
        identity: identity(engine, receipt, resource)?,
        initializers,
        completed: BTreeMap::new(),
    })
}
pub(super) fn verify(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<(), CandidateError> {
    if let Some(provenance) = &resource.cache_provenance {
        check_identity(&provenance.identity, &identity(engine, receipt, resource)?)?;
    }
    Ok(())
}
fn check_identity(
    expected: &VolumeIdentity,
    observed: &VolumeIdentity,
) -> Result<(), CandidateError> {
    if expected != observed {
        return Err(refused());
    }
    Ok(())
}
impl Session<'_, '_> {
    pub(super) fn capture_cache_provenance(
        &mut self,
        key: &str,
        created: bool,
    ) -> Result<(), CandidateError> {
        let resource = &self.receipt.resources[key];
        if resource.cache.is_none() || resource.cache_provenance.is_some() {
            return Ok(());
        }
        let initializers = self
            .cache_initializers
            .iter()
            .filter(|(_, volume)| *volume == &resource.key)
            .map(|(service, _)| service.clone())
            .collect();
        let provenance = capture(&self.engine, &self.receipt, resource, created, initializers)?;
        self.receipt
            .resources
            .get_mut(key)
            .expect("selected resource")
            .cache_provenance = Some(provenance);
        self.save()
    }

    pub(super) fn record_cache_completion(&mut self, service: &str) -> Result<(), CandidateError> {
        if !self.fresh_cache_completion {
            return Ok(());
        }
        let keys: Vec<_> = self
            .receipt
            .resources
            .iter()
            .filter(|(_, r)| {
                r.cache_provenance
                    .as_ref()
                    .is_some_and(|p| p.needs_completion(service))
            })
            .map(|(k, _)| k.clone())
            .collect();
        if keys.is_empty() {
            return self.release_initializer_cache(service);
        }
        let resource = self.receipt.resources[&format!("container:{service}")].clone();
        let value =
            inspect_resource(&self.engine, &self.receipt, &resource)?.ok_or_else(refused)?;
        self.verify_config(service, &value)?;
        for key in keys {
            let volume = &self.receipt.resources[&key];
            verify(&self.engine, &self.receipt, volume)?;
            let mut provenance = volume.cache_provenance.clone().ok_or_else(refused)?;
            if provenance.boot != self.engine.guest().boot_id() {
                return Err(refused());
            }
            provenance.complete(service, &resource, &value)?;
            self.receipt
                .resources
                .get_mut(&key)
                .expect("selected resource")
                .cache_provenance = Some(provenance);
        }
        self.save()?;
        self.release_initializer_cache(service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provenance(origin: Origin) -> CacheProvenance {
        CacheProvenance {
            version: 1,
            origin,
            boot: "boot".into(),
            identity: VolumeIdentity {
                created_at: "2026-09-18T00:00:00Z".into(),
                directory: "1:2".into(),
            },
            initializers: BTreeSet::from(["deps".into()]),
            completed: BTreeMap::new(),
        }
    }
    fn container() -> Resource {
        Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: "deps".into(),
            name: "owned".into(),
            id: Some("a".repeat(64)),
            image: Some(format!("sha256:{}", "b".repeat(64))),
            phase: "started".into(),
        }
    }
    fn terminal() -> Value {
        json!({"Id":"a".repeat(64),"State":{"Status":"exited","Running":false,"Paused":false,"Restarting":false,"Dead":false,"OOMKilled":false,"ExitCode":0,"Pid":0,"StartedAt":"2026-09-18T00:00:00Z","FinishedAt":"2026-09-18T00:00:01Z"}})
    }
    #[test]
    fn first_completion_is_durable_and_never_renewed_by_restart() {
        let mut p = provenance(Origin::CreatedHere);
        p.complete("deps", &container(), &terminal()).unwrap();
        let saved = serde_json::to_vec(&p).unwrap();
        let mut restored: CacheProvenance = serde_json::from_slice(&saved).unwrap();
        let mut restarted = terminal();
        restarted["State"]["StartedAt"] = json!("2026-09-19T00:00:00Z");
        restored.complete("deps", &container(), &restarted).unwrap();
        assert_eq!(serde_json::to_vec(&restored).unwrap(), saved);
        assert!(!restored.needs_completion("deps"));
    }
    #[test]
    fn adopted_and_legacy_or_interrupted_receipts_cannot_gain_fresh_evidence() {
        let mut p = provenance(Origin::Adopted);
        p.complete("deps", &container(), &terminal()).unwrap();
        assert!(p.completed.is_empty());
        let mut old = serde_json::to_value(container()).unwrap();
        old.as_object_mut().unwrap().remove("cache_provenance");
        for phase in ["created", "create-intent"] {
            old["phase"] = json!(phase);
            let resource: Resource = serde_json::from_value(old.clone()).unwrap();
            assert!(resource.cache_provenance.is_none());
        }
    }
    #[test]
    fn completion_rejects_failure_oom_foreign_and_nonterminal_states() {
        for (key, value) in [
            ("ExitCode", json!(1)),
            ("OOMKilled", json!(true)),
            ("Running", json!(true)),
            ("Pid", json!(42)),
            ("StartedAt", json!("0001-01-01T00:00:00Z")),
            ("FinishedAt", json!(null)),
        ] {
            let mut observed = terminal();
            observed["State"][key] = value;
            let mut p = provenance(Origin::CreatedHere);
            assert!(p.complete("deps", &container(), &observed).is_err());
            assert!(p.completed.is_empty());
        }
        let mut observed = terminal();
        observed["Id"] = json!("c".repeat(64));
        assert!(
            provenance(Origin::CreatedHere)
                .complete("deps", &container(), &observed)
                .is_err()
        );
    }
    #[test]
    fn volume_incarnation_includes_creation_time_and_inode() {
        let original = provenance(Origin::CreatedHere).identity;
        let mut replacement = original.clone();
        replacement.created_at.push('1');
        assert!(check_identity(&original, &replacement).is_err());
        replacement = original.clone();
        replacement.directory = "1:3".into();
        assert!(check_identity(&original, &replacement).is_err());
        for malformed in ["", "1", "1:../2", "1:2:3", "1:0\n"] {
            assert!(!super::super::volume_subpaths::valid_identity(malformed));
        }
    }
    #[test]
    fn receipt_loader_rejects_malformed_provenance_but_accepts_legacy() {
        let root = super::super::tests::Fixture::new();
        let run = "a".repeat(32);
        let mut service = container();
        service.name = format!("hkg-{run}-container-0");
        service.networks = Some(vec![]);
        let cache = dependency_cache::CacheBinding {
            scope: "b".repeat(64),
            fingerprint: "c".repeat(64),
            image: format!("sha256:{}", "d".repeat(64)),
        };
        let volume = Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: Some(cache.clone()),
            cache_provenance: None,
            kind: Kind::Volume,
            key: "data".into(),
            name: cache.name(),
            id: None,
            image: None,
            phase: "created".into(),
        };
        let mut receipt = Receipt {
            normalized_input: None,
            relay_startup: None,
            relay_cleanup: None,
            probes: BTreeMap::new(),
            version: 1,
            run: run.clone(),
            owner: "b".repeat(32),
            namespace: "c".repeat(64),
            plan_id: "d".repeat(64),
            phase: "ready-observed".into(),
            environment_attached: false,
            startup_failure: None,
            initializer_cache_release: BTreeMap::new(),
            source: None,
            readiness: BTreeMap::from([("deps".into(), Condition::Completed)]),
            resources: BTreeMap::from([
                ("container:deps".into(), service),
                ("volume:data".into(), volume),
            ]),
        };
        state::write(&root.0.join("state.json"), &receipt).unwrap();
        assert!(load_at(root.0.clone(), &run, &receipt.owner).is_ok());
        receipt
            .resources
            .get_mut("volume:data")
            .unwrap()
            .cache_provenance = Some(provenance(Origin::CreatedHere));
        state::write(&root.0.join("state.json"), &receipt).unwrap();
        assert!(load_at(root.0.clone(), &run, &receipt.owner).is_ok());
        receipt
            .resources
            .get_mut("volume:data")
            .unwrap()
            .cache_provenance
            .as_mut()
            .unwrap()
            .identity
            .directory = "../foreign".into();
        state::write(&root.0.join("state.json"), &receipt).unwrap();
        assert!(load_at(root.0.clone(), &run, &receipt.owner).is_err());
    }
}
