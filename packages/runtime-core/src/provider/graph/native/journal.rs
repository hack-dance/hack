//! Native runtime ownership journal. Compose v1 paths and codecs remain separate.
use super::*;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

/// Hash-only compiler provenance plus public source/resource ownership metadata.
/// No replay authority, source contents, compiler request, argv, environment values
/// or renewable timestamp is persisted.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) topology: Option<crate::project::native::NetworkTopology>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source: Option<source::Binding>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) data: BTreeMap<String, persistent_data::engine::Reference>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) data_mounts: BTreeMap<String, Vec<crate::project::native::StorageMount>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) data_tool: Option<persistent_data::tool::Reference>,
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
    topology: Option<crate::project::native::NetworkTopology>,
    #[serde(default, deserialize_with = "present_map")]
    source: Option<source::Binding>,
    #[serde(default, deserialize_with = "present_map")]
    data: Option<BTreeMap<String, persistent_data::engine::Reference>>,
    #[serde(default, deserialize_with = "present_map")]
    data_mounts: Option<BTreeMap<String, Vec<crate::project::native::StorageMount>>>,
    #[serde(default, deserialize_with = "present_map")]
    data_tool: Option<persistent_data::tool::Reference>,
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
        let storage_fields =
            wire.data.is_some() || wire.data_mounts.is_some() || wire.data_tool.is_some();
        let valid = match wire.version {
            2 => wire.source.is_none() && !storage_fields && wire.topology.is_none(),
            3 => wire.source.is_some() && !storage_fields && wire.topology.is_none(),
            4 => {
                wire.source.is_none()
                    && wire.data.is_some()
                    && wire.data_mounts.is_some()
                    && wire.topology.is_none()
            }
            5 => wire.source.is_none() && !storage_fields && wire.topology.is_some(),
            _ => false,
        };
        if !valid {
            return Err("Native receipt source/storage fields do not match its wire version.");
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
            topology: wire.topology,
            source: wire.source,
            data: wire.data.unwrap_or_default(),
            data_mounts: wire.data_mounts.unwrap_or_default(),
            data_tool: wire.data_tool,
            failure: wire.failure,
            terminal: wire.terminal,
        })
    }
}
impl Receipt {
    /// Mutable phases and terminal evidence may advance; admitted identity cannot.
    pub(super) fn check_binding(&self, expected: &Self) -> Result<(), CandidateError> {
        self.validate(expected.review.scope().run, &expected.owner)?;
        if self.version != expected.version
            || self.review != expected.review
            || self.source != expected.source
            || self.boot != expected.boot
            || self.readiness != expected.readiness
            || self.topology != expected.topology
            || self.data != expected.data
            || self.data_mounts != expected.data_mounts
            || self.data_tool != expected.data_tool
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
    pub(in crate::provider::graph::native) fn persistent(&self) -> bool {
        self.version == 4
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
        self.require_recovery_settled()?;
        if self.phase != Phase::ReadyObserved
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
    /// Cleanup admission, never readiness evidence. A missing ID is settled only
    /// for a never-created or already-removed resource; every pending effect
    /// remains a refusal. The cleanup backend rechecks exact ownership/absence.
    #[cfg(any(target_os = "macos", test))]
    pub(super) fn require_recovery_settled(&self) -> Result<(), CandidateError> {
        self.validate(self.review.scope().run, &self.owner)?;
        // Source/topology recovery remains separate. Storage recovery may stop
        // compute only with complete saved verifier and independently enrolled
        // references; cleanup re-proves owner2/root/xattr before its effects.
        let storage = self.version == 4
            && self
                .data_tool
                .as_ref()
                .is_some_and(|tool| tool.root.is_some() && tool.helper.is_some())
            && self.data.values().all(|reference| reference.enrolled());
        if !(self.version == 2 || storage)
            || self.phase == Phase::Preparing
            || (self.phase == Phase::ReadyObserved && self.failure.is_some())
            || self.resources.values().any(|resource| {
                if self.phase == Phase::Removed && resource.phase != "removed" {
                    return true;
                }
                if resource.id.is_none() {
                    return !matches!(resource.phase.as_str(), "reserved" | "removed");
                }
                match resource.kind {
                    Kind::Container => !matches!(
                        resource.phase.as_str(),
                        "created" | "started" | "stopped" | "removed"
                    ),
                    Kind::Network => !matches!(
                        resource.phase.as_str(),
                        "created" | "remove-intent" | "removed"
                    ),
                    Kind::Volume => true,
                }
            })
        {
            return Err(refused());
        }
        Ok(())
    }
    /// Cleanup admission of a receipt of an ended pool boot (HACK-2715), never readiness
    /// evidence. Any validated phase, including a start caught mid-way: the guest that
    /// held its pending effects stopped, so none can still land. The cleanup observes each
    /// member by recorded id or exact name and refuses a present one with no recorded id.
    /// Only graph2 receipts reach it ([`ended_boot_recoverable`]).
    #[cfg(any(target_os = "macos", test))]
    pub(super) fn require_ended_boot_settled(&self) -> Result<(), CandidateError> {
        self.validate(self.review.scope().run, &self.owner)?;
        if self.version != 2 {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn preparing(
        config: &Configuration,
        owner: &str,
        boot: &str,
    ) -> Result<Self, CandidateError> {
        if (config.source.is_some() && !config.storage.is_empty())
            || (config.topology.is_some()
                && (config.source.is_some() || !config.storage.is_empty()))
        {
            return Err(refused());
        }
        let receipt = Self {
            version: if config.topology.is_some() {
                5
            } else if config.source.is_some() {
                3
            } else if config.storage.is_empty() {
                2
            } else {
                4
            },
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
            topology: config.topology.clone(),
            source: config.source.clone(),
            data: config.data.clone(),
            data_mounts: config.data_mounts.clone(),
            data_tool: None,
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
        let network_count = if self.version == 5 { 2 } else { 1 };
        if ![2, 3, 4, 5].contains(&self.version)
            || (self.version == 3) != self.source.is_some()
            || (self.version == 5) != self.topology.is_some()
            || !hex(run, 32)
            || run != scope.run
            || !hex(owner, 32)
            || self.owner != owner
            || !crate::provider::environment_recovery::uuid(&self.boot)
            || self.readiness.len() > MAX_SERVICES
            || self.readiness.len() + network_count != self.resources.len()
            || self.terminal.len() > self.readiness.len()
            || self.failure.as_ref().is_some_and(|f| {
                !self.readiness.contains_key(&f.service) || !f.observation.failed()
            })
        {
            return Err(refused());
        }
        if let Some(source) = &self.source {
            source.validate(&self.readiness).map_err(|_| refused())?;
        }
        self.validate_data()?;
        let policies = self.topology.as_ref().map_or_else(
            || BTreeMap::from([("default".to_owned(), false)]),
            |topology| topology.networks.clone(),
        );
        if self.version == 5
            && (policies.len() != 2
                || policies.values().filter(|internal| **internal).count() != 1
                || policies.keys().any(|key| {
                    !valid_network_name(key) || matches!(key.as_str(), "default" | "ingress")
                }))
        {
            return Err(refused());
        }
        let mut ids = BTreeSet::new();
        for (index, (key, internal)) in policies.iter().enumerate() {
            let network = self
                .resources
                .get(&format!("network:{key}"))
                .ok_or_else(refused)?;
            if network.kind != Kind::Network
                || network.key != *key
                || network.name != format!("hkn-{run}-network-{index}")
                || network.image.is_some()
                || network.routing.is_some()
                || !network.loopback_ports.is_empty()
                || network.networks.is_some()
                || network.outbound == *internal
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
            if let Some(id) = &network.id {
                if !ids.insert(id) {
                    return Err(refused());
                }
            }
        }
        let mut used = BTreeSet::new();
        let mut aliases = BTreeSet::new();
        if let Some(topology) = &self.topology {
            if topology.attachments.keys().ne(self.readiness.keys()) {
                return Err(refused());
            }
            for selected in topology.attachments.values() {
                if selected.is_empty() || selected.keys().any(|key| !policies.contains_key(key)) {
                    return Err(refused());
                }
                for (key, names) in selected {
                    used.insert(key);
                    if names.windows(2).any(|pair| pair[0] >= pair[1]) {
                        return Err(refused());
                    }
                    for alias in names {
                        if !valid_network_name(alias)
                            || self.readiness.contains_key(alias)
                            || !aliases.insert((key, alias))
                        {
                            return Err(refused());
                        }
                    }
                }
            }
            if used.into_iter().ne(policies.keys()) {
                return Err(refused());
            }
        }
        for (index, (name, _)) in self.readiness.iter().enumerate() {
            let key = format!("container:{name}");
            let resource = self.resources.get(&key).ok_or_else(refused)?;
            let expected_networks = self.topology.as_ref().map_or_else(
                || vec!["default".to_owned()],
                |topology| topology.attachments[name].keys().cloned().collect(),
            );
            if resource.kind != Kind::Container
                || resource.key != *name
                || resource.name != format!("hkn-{run}-container-{index}")
                || resource
                    .image
                    .as_deref()
                    .is_none_or(|image| !image_id(image))
                || resource.routing.is_some()
                || !resource.loopback_ports.is_empty()
                || resource.networks.as_ref() != Some(&expected_networks)
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
        if self.version != 4 {
            return if self.data.is_empty()
                && self.data_mounts.is_empty()
                && self.data_tool.is_none()
            {
                Ok(())
            } else {
                Err(refused())
            };
        }
        if self.data.is_empty() || self.data_mounts.is_empty() {
            return Err(refused());
        }
        if let Some(tool) = &self.data_tool {
            tool.validate()?;
            if (self.phase == Phase::ReadyObserved
                || self
                    .resources
                    .values()
                    .any(|resource| resource.kind == Kind::Container && resource.id.is_some()))
                && tool.helper.is_none()
            {
                return Err(refused());
            }
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
fn valid_network_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().skip(1).all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'-' | b'_' | b'.')
        })
}
/// Stable refusal for a run that never reserved native runtime state.
#[cfg(target_os = "macos")]
pub(super) fn unreserved() -> CandidateError {
    error(
        "native_graph_unreserved",
        "Native runtime state for this run was never reserved: its journal is absent and no foreground owner is published. This point-in-time observation does not prove that no consumer can still start; no state was created, repaired or adopted.",
    )
}
/// True only when this run's journal directory is exactly absent beneath private
/// existing ancestors. A present, partial or unreadable path returns false so the
/// ordinary receipt validation still owns it. Read-only; nothing is created.
pub(super) fn absent(candidate: &Candidate, run: &str) -> Result<bool, CandidateError> {
    directory_absent(candidate, &directory(candidate, run)?)
}

pub(super) fn directory_absent(candidate: &Candidate, root: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Ok(false),
    }
    for path in root
        .ancestors()
        .skip(1)
        .take_while(|path| path.starts_with(&candidate.state_root))
    {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => state::check_private_directory(path).map_err(|_| refused())?,
            Err(_) => return Err(refused()),
        }
    }
    Ok(fs::symlink_metadata(root).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound))
}
pub(super) fn directory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !hex(run, 32) {
        return Err(refused());
    }
    Ok(candidate.state_root.join("run/native-graphs").join(run))
}
pub(super) fn reserve(candidate: &Candidate, receipt: &Receipt) -> Result<PathBuf, CandidateError> {
    receipt.validate(receipt.review.scope().run, &receipt.owner)?;
    let run = receipt.review.scope().run;
    let root = directory(candidate, run)?;
    if !directory_absent(candidate, &super::archive::directory(candidate, run)?)? {
        return Err(refused());
    }
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
/// Which boot of this pool a receipt belongs to, against the pool's current boot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReceiptBoot {
    /// The receipt's containers belong to the current boot.
    Current,
    /// The receipt belongs to an earlier boot of this pool owner, which has ended: the
    /// pool runs one guest boot at a time, so any other boot of the same owner stopped
    /// (`runtime down --force`, a crash or a host reboot). Nothing of that boot can
    /// still run its effects; its containers, if still present, are stopped in the
    /// engine's persisted state (HACK-2715).
    Ended,
}
/// Strict same-owner read of one run's journal in any boot of this pool, saying which
/// boot it belongs to. The current boot id must be a valid guest boot id. The owner,
/// wire schema, private ancestors and no staging file are checked as for every load.
pub(super) fn load_any_boot(
    candidate: &Candidate,
    run: &str,
    owner: &str,
    boot: &str,
) -> Result<(Receipt, PathBuf, ReceiptBoot), CandidateError> {
    if !crate::provider::environment_recovery::uuid(boot) {
        return Err(refused());
    }
    let (receipt, root) = load_validated(candidate, run, Some(owner))?;
    let which = if receipt.boot == boot {
        ReceiptBoot::Current
    } else {
        ReceiptBoot::Ended
    };
    Ok((receipt, root, which))
}
/// Whether a receipt of an ended boot may be recovered in the current boot (HACK-2715):
/// only a graph2 receipt (no persistent data, live source or custom topology) with no
/// managed environment allocation. Persistent data references and environment
/// allocations are bound to the guest boot that made them, and no guest rollover of
/// either exists, so such a run of an ended boot is refused with its data and evidence
/// kept. Source and topology recovery are outside the recovery proof in any boot
/// (`require_recovery_settled`). `lifecycle::pool_users::after_forced_stop` names the
/// same rule to the user before `runtime down --force`.
pub(super) fn ended_boot_recoverable(
    candidate: &Candidate,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if receipt.version != 2
        || receipt.source.is_some()
        || receipt.topology.is_some()
        || !receipt.data.is_empty()
        || receipt.data_tool.is_some()
        || crate::provider::native_environment::retained_runs(candidate)?
            .contains(receipt.review.scope().run)
    {
        return Err(error(
            "native_graph_ended_boot_unsupported",
            "This native run belongs to a pool boot that has ended (runtime down --force, a crash or a host reboot), and it keeps persistent data, a live source, a custom network topology or a managed environment, which recovery from an ended boot does not support; its containers, data and evidence are kept.",
        ));
    }
    Ok(())
}
/// Which boot a receipt belongs to, read from the pool's own record without a lock and
/// without a running pool (HACK-2715). `Ended` only on positive evidence: the record is
/// this receipt's pool owner and says the pool is not running, or running another boot,
/// or still says running this boot while the provider it records is proven gone (a
/// crash or a kill, HACK-2579 `process-exited`; review round 2). An absent or
/// unreadable record, or a record of another owner, proves nothing and
/// returns `Current`, so the caller keeps the strict same-boot rules. Callers that act
/// on the run re-check the boot against the connected engine before any effect.
pub(super) fn pool_boot(candidate: &Candidate, receipt: &Receipt) -> ReceiptBoot {
    boot_of(candidate, &receipt.owner, &receipt.boot)
}
/// [`pool_boot`] for a pool owner token and guest boot id: `Ended` only on positive
/// evidence that the pool record of this owner is not running that boot, or that the
/// provider it records is gone.
pub(super) fn boot_of(candidate: &Candidate, owner: &str, boot: &str) -> ReceiptBoot {
    let Ok(pool) =
        state::read::<serde_json::Value>(&candidate.state_root.join("run/smolvm/owner.json"))
    else {
        return ReceiptBoot::Current;
    };
    boot_in(&pool, owner, boot)
}
fn boot_in(pool: &serde_json::Value, owner: &str, boot: &str) -> ReceiptBoot {
    if pool["token"].as_str() != Some(owner) {
        return ReceiptBoot::Current;
    }
    if pool["phase"] == "running" && pool["guest_boot_id"].as_str() == Some(boot) {
        // A provider that died under the pool (a crash, or a kill) leaves its record
        // `running` (HACK-2579 `process-exited`). Its guest is gone with it, so its boot
        // has ended too: positive evidence only, when the recorded provider identity
        // proves the process gone (HACK-2715 review round 2, Codex P2).
        if recorded_provider_gone(pool) {
            return ReceiptBoot::Ended;
        }
        ReceiptBoot::Current
    } else {
        ReceiptBoot::Ended
    }
}
/// Whether the pool record names a provider process that is proven gone (exited, a
/// zombie, or a reused pid); an absent or unreadable identity proves nothing.
fn recorded_provider_gone(pool: &serde_json::Value) -> bool {
    serde_json::from_value::<crate::provider::identity::ProcessIdentity>(pool["process"].clone())
        .is_ok_and(|process| crate::provider::identity::provider_gone(&process).unwrap_or(false))
}
/// The pool owner token and guest boot id of a pool recorded running, read without a
/// lock; `None` otherwise. A foreground owner records it when it starts, to notice later
/// that its boot ended under it ([`boot_of`]).
#[cfg(target_os = "macos")]
pub(super) fn running_boot(candidate: &Candidate) -> Option<(String, String)> {
    let pool =
        state::read::<serde_json::Value>(&candidate.state_root.join("run/smolvm/owner.json"))
            .ok()?;
    if pool["phase"] != "running" {
        return None;
    }
    Some((
        pool["token"].as_str()?.to_owned(),
        pool["guest_boot_id"].as_str()?.to_owned(),
    ))
}
/// What `graph native boot` reports for one run (HACK-2715): its phase, whether its
/// receipt belongs to an ended pool boot ([`pool_boot`]), and whether its own owner's
/// stop or its dead-owner recovery can clear it from that ended boot
/// ([`ended_boot_recoverable`]). Read-only and lock-free; it grants nothing. A frontend
/// uses it to start a stopped pool only for a run that the started pool can then clear.
#[derive(Serialize)]
pub struct BootCheck {
    version: u8,
    kind: BootCheckKind,
    run: String,
    phase: Phase,
    ended_boot: bool,
    ended_boot_recoverable: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum BootCheckKind {
    NativeGraphBoot,
}
pub fn boot_check(candidate: &Candidate, run: &str) -> Result<BootCheck, CandidateError> {
    let (receipt, _) = load_validated(candidate, run, None)?;
    let ended_boot = pool_boot(candidate, &receipt) == ReceiptBoot::Ended;
    Ok(BootCheck {
        version: 1,
        kind: BootCheckKind::NativeGraphBoot,
        run: run.into(),
        ended_boot_recoverable: ended_boot && ended_boot_recoverable(candidate, &receipt).is_ok(),
        phase: receipt.phase,
        ended_boot,
    })
}
/// The journal a cleanup acts on: one of the current boot, or (with `ended_boot`) one of
/// an ended boot of this pool owner that [`ended_boot_recoverable`] admits. Only the
/// run's own owner (its bound receipt) and the explicit dead-owner recovery pass
/// `ended_boot`; every other load stays same-boot ([`load`]).
pub(super) fn load_for_recovery(
    candidate: &Candidate,
    run: &str,
    owner: &str,
    boot: &str,
    ended_boot: bool,
) -> Result<(Receipt, PathBuf, ReceiptBoot), CandidateError> {
    if !ended_boot {
        let (receipt, root) = load(candidate, run, owner, boot)?;
        return Ok((receipt, root, ReceiptBoot::Current));
    }
    let (receipt, root, which) = load_any_boot(candidate, run, owner, boot)?;
    if which == ReceiptBoot::Ended {
        ended_boot_recoverable(candidate, &receipt)?;
    }
    Ok((receipt, root, which))
}
/// The strict same-boot rule admission used before HACK-2715: old boot history releases
/// capacity only after strict same-owner removal validation. Admission and the storage
/// checks now read any boot ([`load_any_boot`]); tests keep this as the old oracle.
#[cfg(test)]
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
/// Strict same-owner read of one run's journal, independent of the current boot:
/// private ancestors, no pending staging file, the exact wire schema and owner.
pub(super) fn load_owned(
    candidate: &Candidate,
    run: &str,
    owner: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    load_validated(candidate, run, Some(owner))
}
fn load_validated(
    candidate: &Candidate,
    run: &str,
    owner: Option<&str>,
) -> Result<(Receipt, PathBuf), CandidateError> {
    load_at(candidate, run, owner, directory(candidate, run)?)
}

pub(super) fn load_at(
    candidate: &Candidate,
    run: &str,
    owner: Option<&str>,
    root: PathBuf,
) -> Result<(Receipt, PathBuf), CandidateError> {
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

#[cfg(all(test, target_os = "macos"))]
mod pool_boot_tests {
    use super::*;
    use serde_json::json;

    /// HACK-2715 review round 2 (Codex P2): a provider that died under a running pool
    /// leaves its record `running`, and its boot has ended with it. Only a recorded
    /// identity proven gone says so; a live provider, an absent or unreadable identity,
    /// or another owner's record proves nothing.
    #[test]
    fn a_provider_that_died_under_a_running_pool_ends_its_boot() {
        let record = |process: serde_json::Value| json!({"token": "owner", "phase": "running", "guest_boot_id": "boot", "process": process});
        let live = crate::provider::identity::observe(std::process::id() as i32).unwrap();
        let live = serde_json::to_value(&live).unwrap();
        assert_eq!(
            boot_in(&record(live.clone()), "owner", "boot"),
            ReceiptBoot::Current
        );
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let gone = crate::provider::identity::observe(child.id() as i32).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let gone = serde_json::to_value(&gone).unwrap();
        assert_eq!(
            boot_in(&record(gone.clone()), "owner", "boot"),
            ReceiptBoot::Ended
        );
        for (pool, owner) in [
            (
                json!({"token": "owner", "phase": "running", "guest_boot_id": "boot"}),
                "owner",
            ),
            (record(json!({"pid": "unreadable"})), "owner"),
            (record(gone.clone()), "another owner"),
        ] {
            assert_eq!(
                boot_in(&pool, owner, "boot"),
                ReceiptBoot::Current,
                "{pool}"
            );
        }
        let mut stopped = record(live);
        stopped["phase"] = json!("recovered-unclean");
        assert_eq!(boot_in(&stopped, "owner", "boot"), ReceiptBoot::Ended);
        assert_eq!(
            boot_in(&record(gone), "owner", "another boot"),
            ReceiptBoot::Ended
        );
    }
}
