//! Native runtime ownership journal. Compose v1 paths and codecs remain separate.
use super::*;
use serde::{Deserialize, Serialize};

const LIMIT: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Preparing,
    ReadyObserved,
    FailedRetained,
    StopIntent,
    Stopped,
    RemovalIntent,
    Removed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum InputKind {
    NativeGraphRuntime,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    service: String,
    observation: Observation,
}

/// Hash-only native provenance plus value-free resource ownership. No replay authority,
/// compiler request, argv, environment values or renewable timestamp is persisted.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    version: u32,
    kind: InputKind,
    pub(super) owner: String,
    pub(super) boot: String,
    pub(super) review: native_input::Review,
    pub(super) phase: Phase,
    pub(super) readiness: BTreeMap<String, Condition>,
    pub(super) resources: BTreeMap<String, Resource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) terminal: BTreeMap<String, super::super::shutdown::Terminal>,
}
impl Receipt {
    pub fn phase(&self) -> &Phase {
        &self.phase
    }
    pub fn review(&self) -> &native_input::Review {
        &self.review
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn resources(&self) -> &BTreeMap<String, Resource> {
        &self.resources
    }
    pub(super) fn preparing(
        config: &Configuration,
        owner: &str,
        boot: &str,
    ) -> Result<Self, CandidateError> {
        let receipt = Self {
            version: 2,
            kind: InputKind::NativeGraphRuntime,
            owner: owner.into(),
            boot: boot.into(),
            review: config.review.clone(),
            phase: Phase::Preparing,
            readiness: config
                .graph
                .services
                .iter()
                .map(|(name, service)| (name.clone(), service.ready))
                .collect(),
            resources: config.resources.clone(),
            failure: None,
            terminal: BTreeMap::new(),
        };
        receipt.validate(config.review.scope().run, owner)?;
        Ok(receipt)
    }
    pub(super) fn failed(&mut self, service: &str, observation: Observation) {
        self.failure = Some(Failure {
            service: service.into(),
            observation,
        });
    }
    pub(super) fn validate(&self, run: &str, owner: &str) -> Result<(), CandidateError> {
        let scope = self.review.scope();
        self.review.validate(scope).map_err(|_| refused())?;
        if self.version != 2
            || !hex(run, 32)
            || run != scope.run
            || !hex(owner, 32)
            || self.owner != owner
            || !crate::provider::environment_recovery::uuid(&self.boot)
            || self.readiness.len() > MAX_SERVICES
            || self.readiness.len() + 1 != self.resources.len()
            || self.terminal.len() > self.readiness.len()
            || self.failure.as_ref().is_some_and(|f| {
                !self.readiness.contains_key(&f.service) || !f.observation.failed()
            })
        {
            return Err(refused());
        }
        let network = self.resources.get("network:default").ok_or_else(refused)?;
        if network.kind != Kind::Network
            || network.key != "default"
            || network.name != format!("hkn-{run}-network-0")
            || network.image.is_some()
            || network.routing.is_some()
            || network.networks.is_some()
            || !network.outbound
            || network.cache.is_some()
            || network.cache_provenance.is_some()
            || network.id.as_ref().is_some_and(|id| !hex(id, 64))
            || ![
                "reserved",
                "create-intent",
                "created",
                "uncertain",
                "remove-intent",
                "removed",
            ]
            .contains(&network.phase.as_str())
            || (network.phase == "created" && network.id.is_none())
            || (network.phase == "reserved" && network.id.is_some())
        {
            return Err(refused());
        }
        let mut ids = BTreeSet::new();
        if let Some(id) = &network.id {
            ids.insert(id);
        }
        for (index, (name, _)) in self.readiness.iter().enumerate() {
            let key = format!("container:{name}");
            let resource = self.resources.get(&key).ok_or_else(refused)?;
            if resource.kind != Kind::Container
                || resource.key != *name
                || resource.name != format!("hkn-{run}-container-{index}")
                || resource
                    .image
                    .as_deref()
                    .is_none_or(|image| !image_id(image))
                || resource.routing.is_some()
                || resource.networks.as_ref() != Some(&vec!["default".to_owned()])
                || resource.outbound
                || resource.cache.is_some()
                || resource.cache_provenance.is_some()
                || resource
                    .id
                    .as_ref()
                    .is_some_and(|id| !hex(id, 64) || !ids.insert(id))
                || ![
                    "reserved",
                    "create-intent",
                    "created",
                    "start-intent",
                    "started",
                    "uncertain",
                    "stop-intent",
                    "stopped",
                    "remove-intent",
                    "removed",
                ]
                .contains(&resource.phase.as_str())
                || (["created", "start-intent", "started", "stopped"]
                    .contains(&resource.phase.as_str())
                    && resource.id.is_none())
                || (resource.phase == "reserved" && resource.id.is_some())
            {
                return Err(refused());
            }
        }
        // Reuse the same graph-name validation without reconstructing Compose intent.
        execution::Graph::from_services(
            self.readiness
                .iter()
                .map(|(name, ready)| {
                    (
                        name.clone(),
                        execution::Service {
                            dependencies: BTreeMap::new(),
                            ready: *ready,
                        },
                    )
                })
                .collect(),
        )
        .map_err(|_| refused())?;
        if self.phase == Phase::ReadyObserved
            && self.resources.values().any(|r| {
                r.phase
                    != if r.kind == Kind::Network {
                        "created"
                    } else {
                        "started"
                    }
                    || r.id.is_none()
            })
        {
            return Err(refused());
        }
        if self.phase == Phase::Removed && self.resources.values().any(|r| r.phase != "removed") {
            return Err(refused());
        }
        for (key, terminal) in &self.terminal {
            let resource = self.resources.get(key).ok_or_else(refused)?;
            if resource.kind != Kind::Container
                || resource.id.as_deref() != Some(terminal.id.as_str())
                || !hex(&terminal.id, 64)
            {
                return Err(refused());
            }
        }
        Ok(())
    }
}
fn refused() -> CandidateError {
    error(
        "native_graph_receipt",
        "Native runtime ownership requires its exact kind/version, owner, provenance and bounded journal; retained evidence was not repaired or adopted.",
    )
}
pub(super) fn directory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !hex(run, 32) {
        return Err(refused());
    }
    Ok(candidate.state_root.join("run/native-graphs").join(run))
}
pub(super) fn reserve(candidate: &Candidate, receipt: &Receipt) -> Result<PathBuf, CandidateError> {
    receipt.validate(receipt.review.scope().run, &receipt.owner)?;
    let root = directory(candidate, receipt.review.scope().run)?;
    state::private_directory(root.parent().ok_or_else(refused)?)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(|_| refused())?;
    fs::File::open(root.parent().ok_or_else(refused)?)
        .and_then(|f| f.sync_all())
        .map_err(state::io)?;
    save(&root, receipt)?;
    Ok(root)
}
pub(super) fn save(root: &std::path::Path, receipt: &Receipt) -> Result<(), CandidateError> {
    receipt.validate(receipt.review.scope().run, &receipt.owner)?;
    if serde_json::to_vec(receipt).map_err(|_| refused())?.len() > LIMIT {
        return Err(refused());
    }
    state::write(&root.join("state.json"), receipt)
}
pub(super) fn load(
    candidate: &Candidate,
    run: &str,
    owner: &str,
    boot: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let (receipt, root) = load_validated(candidate, run, Some(owner))?;
    if receipt.boot != boot {
        return Err(refused());
    }
    Ok((receipt, root))
}
/// Old boot history releases capacity only after strict same-owner removal validation.
pub(super) fn load_admission(
    candidate: &Candidate,
    run: &str,
    owner: &str,
    boot: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    if !crate::provider::environment_recovery::uuid(boot) {
        return Err(refused());
    }
    let (receipt, root) = load_validated(candidate, run, Some(owner))?;
    if receipt.boot != boot && receipt.phase != Phase::Removed {
        return Err(refused());
    }
    Ok((receipt, root))
}
/// Read only the exact native control membership. This does not grant guest effect
/// authority; runtime operations still independently require the real owner and boot.
#[cfg(target_os = "macos")]
pub(super) fn read_control(
    candidate: &Candidate,
    review: &native_input::Review,
) -> Result<Receipt, CandidateError> {
    review.validate(review.scope()).map_err(|_| refused())?;
    let (receipt, _) = load_validated(candidate, review.scope().run, None)?;
    if receipt.review != *review {
        return Err(refused());
    }
    Ok(receipt)
}
fn load_validated(
    candidate: &Candidate,
    run: &str,
    owner: Option<&str>,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let root = directory(candidate, run)?;
    for path in root
        .ancestors()
        .take_while(|path| path.starts_with(&candidate.state_root))
    {
        state::check_private_directory(path).map_err(|_| refused())?;
    }
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(refused()),
    }
    let bytes = native_input::read_file(&root.join("state.json"), LIMIT).map_err(|_| refused())?;
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    receipt.validate(run, owner.unwrap_or(&receipt.owner))?;
    Ok((receipt, root))
}
