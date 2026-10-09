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
    #[serde(deserialize_with = "decode_failure_observation")]
    observation: Observation,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum WireObservation {
    Created {},
    Running { health: execution::Health },
    Exited { code: i64 },
    Dead {},
}
impl From<WireObservation> for Observation {
    fn from(value: WireObservation) -> Self {
        match value {
            WireObservation::Created {} => Self::Created,
            WireObservation::Running { health } => Self::Running { health },
            WireObservation::Exited { code } => Self::Exited { code },
            WireObservation::Dead {} => Self::Dead,
        }
    }
}
fn decode_failure_observation<'de, D: serde::Deserializer<'de>>(
    reader: D,
) -> Result<Observation, D::Error> {
    WireObservation::deserialize(reader).map(Into::into)
}

/// Hash-only native provenance plus value-free resource ownership. No replay authority,
/// compiler request, argv, environment values or renewable timestamp is persisted.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "ReceiptWire")]
pub struct Receipt {
    version: u32,
    kind: InputKind,
    pub(super) owner: String,
    pub(super) boot: String,
    pub(super) review: native_input::Review,
    pub(super) phase: Phase,
    pub(super) readiness: BTreeMap<String, Condition>,
    pub(super) resources: BTreeMap<String, Resource>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) data: BTreeMap<String, persistent_data::engine::Reference>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) data_mounts: BTreeMap<String, Vec<crate::project::native::StorageMount>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) terminal: BTreeMap<String, super::super::shutdown::Terminal>,
}

// Presence is a wire-version boundary: an explicit empty storage field must not
// become indistinguishable from an absent graph2 field. Present null also refuses.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptWire {
    version: u32,
    kind: InputKind,
    owner: String,
    boot: String,
    review: native_input::Review,
    phase: Phase,
    readiness: BTreeMap<String, Condition>,
    resources: BTreeMap<String, Resource>,
    #[serde(default, deserialize_with = "present_map")]
    data: Option<BTreeMap<String, persistent_data::engine::Reference>>,
    #[serde(default, deserialize_with = "present_map")]
    data_mounts: Option<BTreeMap<String, Vec<crate::project::native::StorageMount>>>,
    #[serde(default)]
    failure: Option<Failure>,
    #[serde(default)]
    terminal: BTreeMap<String, super::super::shutdown::Terminal>,
}
fn present_map<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    reader: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(reader).map(Some)
}
impl TryFrom<ReceiptWire> for Receipt {
    type Error = &'static str;
    fn try_from(wire: ReceiptWire) -> Result<Self, Self::Error> {
        if (wire.version == 2 && (wire.data.is_some() || wire.data_mounts.is_some()))
            || (wire.version == 4 && (wire.data.is_none() || wire.data_mounts.is_none()))
        {
            return Err("Native receipt storage fields do not match its wire version.");
        }
        Ok(Self {
            version: wire.version,
            kind: wire.kind,
            owner: wire.owner,
            boot: wire.boot,
            review: wire.review,
            phase: wire.phase,
            readiness: wire.readiness,
            resources: wire.resources,
            data: wire.data.unwrap_or_default(),
            data_mounts: wire.data_mounts.unwrap_or_default(),
            failure: wire.failure,
            terminal: wire.terminal,
        })
    }
}
impl Receipt {
    /// Mutable phases and terminal evidence may advance; admitted identity cannot.
    pub(super) fn check_binding(&self, expected: &Self) -> Result<(), CandidateError> {
        self.validate(expected.review.scope().run, &expected.owner)?;
        if self.review != expected.review
            || self.boot != expected.boot
            || self.readiness != expected.readiness
            || self.data != expected.data
            || self.data_mounts != expected.data_mounts
            || self.resources.keys().ne(expected.resources.keys())
            || self.resources.iter().any(|(key, resource)| {
                let prior = &expected.resources[key];
                resource.kind != prior.kind
                    || resource.key != prior.key
                    || resource.name != prior.name
                    || resource.id != prior.id
                    || resource.image != prior.image
                    || resource.networks != prior.networks
                    || resource.outbound != prior.outbound
            })
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn phase(&self) -> &Phase {
        &self.phase
    }
    pub fn review(&self) -> &native_input::Review {
        &self.review
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    #[cfg(target_os = "macos")]
    pub(in crate::provider) fn boot(&self) -> &str {
        &self.boot
    }
    pub fn resources(&self) -> &BTreeMap<String, Resource> {
        &self.resources
    }
    #[cfg(target_os = "macos")]
    pub(super) fn require_recovery_ready(&self) -> Result<(), CandidateError> {
        self.validate(self.review.scope().run, &self.owner)?;
        if self.version != 2
            || self.phase != Phase::ReadyObserved
            || self.failure.is_some()
            || self
                .resources
                .values()
                .any(|resource| resource.id.is_none())
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn preparing(
        config: &Configuration,
        owner: &str,
        boot: &str,
    ) -> Result<Self, CandidateError> {
        let receipt = Self {
            version: if config.storage.is_empty() { 2 } else { 4 },
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
            data: config.data.clone(),
            data_mounts: config.data_mounts.clone(),
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
        if ![2, 4].contains(&self.version)
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
        self.validate_data()?;
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

    fn validate_data(&self) -> Result<(), CandidateError> {
        if self.version == 2 {
            return if self.data.is_empty() && self.data_mounts.is_empty() {
                Ok(())
            } else {
                Err(refused())
            };
        }
        if self.data.is_empty() || self.data_mounts.is_empty() {
            return Err(refused());
        }
        let mut used = BTreeSet::new();
        for (service, mounts) in &self.data_mounts {
            if !self.readiness.contains_key(service) || mounts.is_empty() {
                return Err(refused());
            }
            let mut targets = BTreeSet::new();
            for mount in mounts {
                if !self.data.contains_key(&mount.storage)
                    || !targets.insert(&mount.target)
                    || !mount.target.starts_with('/')
                    || mount.target.contains(['\0', '\\'])
                    || mount
                        .target
                        .split('/')
                        .skip(1)
                        .any(|part| part == "." || part == ".." || part.is_empty())
                {
                    return Err(refused());
                }
                used.insert(&mount.storage);
            }
        }
        if used.into_iter().ne(self.data.keys()) {
            return Err(refused());
        }
        for (logical, data) in &self.data {
            data.validate(
                self.review.scope().namespace,
                logical,
                &self.owner,
                &self.boot,
            )
            .map_err(|_| refused())?;
            if (self.phase == Phase::ReadyObserved
                || self
                    .resources
                    .values()
                    .any(|resource| resource.kind == Kind::Container && resource.id.is_some()))
                && !data.enrolled()
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
/// Retain original bytes for explicit recovery selectors without reconstructing
/// a digest from another wire projection. Pending state remains a refusal.
#[cfg(target_os = "macos")]
pub(super) fn read_recovery(
    candidate: &Candidate,
    review: &native_input::Review,
) -> Result<(Receipt, PathBuf, String), CandidateError> {
    use std::os::unix::fs::MetadataExt;
    let receipt = read_control(candidate, review)?;
    let root = directory(candidate, review.scope().run)?;
    let path = root.join("state.json");
    let before = fs::symlink_metadata(&path).map_err(|_| refused())?;
    let bytes = native_input::read_file(&path, LIMIT)?;
    let after = fs::symlink_metadata(&path).map_err(|_| refused())?;
    let current: Receipt = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino())
        || serde_json::to_vec(&current).map_err(|_| refused())?
            != serde_json::to_vec(&receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    Ok((
        receipt,
        root,
        String::from_utf8(bytes).map_err(|_| refused())?,
    ))
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
