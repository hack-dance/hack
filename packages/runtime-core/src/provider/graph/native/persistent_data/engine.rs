//! Production adapter under the existing provider mutation lease. This is cooperative
//! exclusive creation, not an exclusive Docker endpoint. Every supported Engine creator
//! holds the same original lock; direct same-user socket/guest writers are not serialized.
//! No volume deletion, adoption, pending replay or guest rollover is implemented here.

use super::{enrollment, *};
use crate::{Candidate, provider::engine::Engine};
use reqwest::Method;
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Read, sync::atomic::AtomicBool, time::Instant};

pub(in crate::provider::graph::native) mod witnessed;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum State {
    Reserved { intent: String },
    Enrolled { volume: VolumeIdentity },
}
/// Journal assertion only. The private durable owner and fresh guest/volume proof are
/// independently required before use. Stable storage never becomes a run-owned Resource.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct Reference {
    binding: Binding,
    state: State,
}
impl std::fmt::Debug for Reference {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PersistentDataReference")
    }
}
impl Reference {
    pub(super) fn guest_identity(&self) -> &GuestIdentity {
        &self.binding.guest
    }
    pub(in crate::provider::graph::native) fn name(&self) -> String {
        enrollment::volume_name(&self.binding)
    }
    pub(in crate::provider::graph::native) fn enrolled(&self) -> bool {
        matches!(self.state, State::Enrolled { .. })
    }
    pub(in crate::provider::graph::native) fn validate(
        &self,
        namespace: &str,
        logical: &str,
        owner: &str,
        boot: &str,
    ) -> Result<(), CandidateError> {
        if !binding_valid(&self.binding)
            || self.binding.scope.namespace != namespace
            || self.binding.scope.storage != logical
            || self.binding.guest.owner != owner
            || self.binding.guest.boot_id != boot
        {
            return Err(refused());
        }
        match &self.state {
            State::Reserved { intent } if super::super::super::hex(intent, 32) => Ok(()),
            State::Enrolled { volume } if volume_valid(volume) && volume.name == self.name() => {
                Ok(())
            }
            _ => Err(refused()),
        }
    }
    pub(in crate::provider::graph::native) fn mountpoint(&self) -> String {
        format!("/var/lib/docker/volumes/{}/_data", self.name())
    }
}
fn nonce() -> Result<String, CandidateError> {
    let mut bytes = [0_u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| refused())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Captured before provider admission; this is a caller-pinned candidate artifact,
/// not a catalog lookup or a claim that its ABI has been qualified on this host.
pub struct StorageTool(crate::provider::guest_tool::Artifact);
impl StorageTool {
    pub fn read(path: &std::path::Path, digest: &str) -> Result<Self, CandidateError> {
        crate::provider::guest_tool::Artifact::read(path, digest).map(Self)
    }
    pub(in crate::provider::graph::native) fn verify(&self) -> Result<(), CandidateError> {
        self.0.verify()
    }
    pub(in crate::provider::graph::native) fn install(
        &self,
        options: super::tool::InstallOptions<'_, '_>,
    ) -> Result<super::tool::Installed, CandidateError> {
        self.verify()?;
        if options.artifact != self.0.path() || options.digest != self.0.digest() {
            return Err(refused());
        }
        super::tool::install(options)
    }
    pub(in crate::provider::graph::native) fn path(&self) -> &std::path::Path {
        self.0.path()
    }
    pub(in crate::provider::graph::native) fn digest(&self) -> &str {
        self.0.digest()
    }
}

pub(in crate::provider::graph::native) struct Adapter<'a, 'guest> {
    engine: &'a Engine<'guest>,
    tool: Option<&'a super::tool::Installed>,
    fresh: &'a dyn Fn() -> Result<(), CandidateError>,
}
impl<'a, 'guest> Adapter<'a, 'guest> {
    fn new(
        engine: &'a Engine<'guest>,
        tool: Option<&'a super::tool::Installed>,
        fresh: &'a dyn Fn() -> Result<(), CandidateError>,
    ) -> Self {
        Self {
            engine,
            tool,
            fresh,
        }
    }
    fn check(&self, deadline: Instant) -> Result<(), CandidateError> {
        (self.fresh)()?;
        self.engine.guest().verify()?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        Ok(())
    }
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        deadline: Instant,
    ) -> Result<Value, CandidateError> {
        self.check(deadline)?;
        let result = self.engine.request_until(method, path, body, deadline);
        self.check(deadline)?;
        result
    }
    fn observe(
        &self,
        binding: &Binding,
        name: &str,
        value: &Value,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        let mountpoint = format!("/var/lib/docker/volumes/{name}/_data");
        if value["Name"] != name
            || value["Driver"] != "local"
            || value["Scope"] != "local"
            || !(value["Options"].is_null()
                || value["Options"]
                    .as_object()
                    .is_some_and(|options| options.is_empty()))
            || value["Mountpoint"] != mountpoint
            || value["Labels"] != labels(binding)
        {
            return Err(refused());
        }
        let created_at = value["CreatedAt"].as_str().ok_or_else(refused)?.to_owned();
        self.check(deadline)?;
        // Directory observation uses the same saved helper and durable transport
        // fence as witness reads. An ambiguous metadata read cannot be retried
        // through a fresh provider lease while its guest command is unqualified.
        let identity = self.tool.ok_or_else(refused)?.invoke(
            self.engine,
            crate::provider::storage_root_witness::Request::root(name)?,
            deadline,
            self.fresh,
        );
        self.check(deadline)?;
        let crate::provider::storage_root_witness::Observation::Root(root) = identity? else {
            return Err(refused());
        };
        let volume = VolumeIdentity {
            name: name.into(),
            created_at,
            directory: DirectoryIdentity {
                device: root.device,
                inode: root.inode,
            },
        };
        if !volume_valid(&volume) {
            return Err(refused());
        }
        Ok(Observation {
            binding: binding.clone(),
            volume,
        })
    }
}
impl enrollment::sealed::Transport for Adapter<'_, '_> {}
impl enrollment::Transport for Adapter<'_, '_> {
    fn verify(&mut self, expected: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        self.check(deadline)?;
        if !binding_valid(expected) || self.engine.guest().persistent_identity()? != expected.guest
        {
            return Err(refused());
        }
        self.check(deadline)
    }
    fn inspect(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        // Name carries no authority. Only the closed persistent labels select a binding,
        // subsequently compared to the independent expected durable owner by enrollment.
        if !volume_name_valid(name) {
            return Err(refused());
        }
        let value = match self.request(
            Method::GET,
            &format!("/v1.53/volumes/{name}"),
            None,
            deadline,
        ) {
            Err(error) if error.code == "engine_not_found" => return Ok(None),
            result => result?,
        };
        let labels = value["Labels"].as_object().ok_or_else(refused)?;
        let string = |key: &str| {
            labels
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(refused)
        };
        let binding = Binding {
            scope: Scope {
                namespace: string("io.hack-local.namespace")?,
                storage: string("io.hack-local.storage")?,
                owner: string("io.hack-local.data-owner")?,
            },
            guest: self.engine.guest().persistent_identity()?,
            policy: Policy {
                driver: Local::Local,
                scope: Local::Local,
                options: NoOptions {},
            },
        };
        if !binding_valid(&binding) || enrollment::volume_name(&binding) != name {
            return Err(refused());
        }
        let observed = self.observe(&binding, name, &value, deadline)?;
        let after = self.request(
            Method::GET,
            &format!("/v1.53/volumes/{name}"),
            None,
            deadline,
        )?;
        let confirmed = self.observe(&binding, name, &after, deadline)?;
        if confirmed != observed {
            return Err(refused());
        }
        Ok(Some(observed))
    }
    fn create_new(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        create_original(self, request, deadline)
    }
}
trait Creation {
    fn fence(&mut self, binding: &Binding, deadline: Instant) -> Result<(), CandidateError>;
    fn find(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError>;
    fn post(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError>;
}
impl Creation for Adapter<'_, '_> {
    fn fence(&mut self, binding: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        enrollment::Transport::verify(self, binding, deadline)
    }
    fn find(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        enrollment::Transport::inspect(self, name, deadline)
    }
    fn post(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        let value = self.request(Method::POST, "/v1.53/volumes/create", Some(&json!({"Name":request.name(),"Driver":"local","DriverOpts":{},"Labels":labels(request.binding())})), deadline)?;
        self.observe(request.binding(), request.name(), &value, deadline)
    }
}
/// Same production sequence exercised by lock-owning stand-ins. No caller can issue
/// this sealed transport or turn a returned idempotent endpoint row into authority.
fn create_original<C: Creation>(
    owner: &mut C,
    request: &enrollment::CreateRequest,
    deadline: Instant,
) -> Result<Observation, CandidateError> {
    owner.fence(request.binding(), deadline)?;
    if owner.find(request.name(), deadline)?.is_some() {
        return Err(refused());
    }
    owner.fence(request.binding(), deadline)?;
    let captured = owner.post(request, deadline)?;
    let current = owner.find(request.name(), deadline)?.ok_or_else(refused)?;
    if current != captured {
        return Err(refused());
    }
    owner.fence(request.binding(), deadline)?;
    Ok(captured)
}
fn labels(binding: &Binding) -> Value {
    json!({"io.hack-local.kind":"native-persistent-data","io.hack-local.namespace":binding.scope.namespace,"io.hack-local.storage":binding.scope.storage,"io.hack-local.data-owner":binding.scope.owner,"io.hack-local.provider-owner":binding.guest.owner})
}
/// Select owner2 metadata without creating volumes or asserting content continuity.
pub(in crate::provider::graph::native) fn select_witnessed(
    candidate: &Candidate,
    engine: &Engine<'_>,
    namespace: &str,
    names: &std::collections::BTreeSet<String>,
    deadline: Instant,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<BTreeMap<String, Reference>, CandidateError> {
    let mut references = BTreeMap::new();
    if names.is_empty() {
        return Ok(references);
    }
    let guest = engine.guest().persistent_identity()?;
    let inventory =
        Adapter::new(engine, None, fresh).request(Method::GET, "/v1.53/volumes", None, deadline)?;
    let volumes = inventory["Volumes"].as_array().ok_or_else(refused)?;
    if !inventory["Warnings"].is_null()
        && !inventory["Warnings"]
            .as_array()
            .is_some_and(|warnings| warnings.is_empty())
    {
        return Err(refused());
    }
    let mut volume_names = std::collections::BTreeSet::new();
    for volume in volumes {
        let name = volume["Name"]
            .as_str()
            .filter(|name| volume_name_valid(name))
            .ok_or_else(refused)?;
        if !volume_names.insert(name) {
            return Err(refused());
        }
    }
    for name in names {
        fresh()?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        let selected_owner = enrollment::witnessed::selected_owner(
            enrollment::witnessed::BindingSelectionOptions {
                state_root: &candidate.state_root,
                namespace,
                storage: name,
            },
        )?;
        let existing = selected_owner.as_ref().map(|owner| owner.0.binding.clone());
        let retained = existing.is_some();
        let binding = match existing {
            Some(binding) => binding,
            None => Binding {
                scope: Scope {
                    namespace: namespace.into(),
                    storage: name.clone(),
                    owner: nonce()?,
                },
                guest: guest.clone(),
                policy: Policy {
                    driver: Local::Local,
                    scope: Local::Local,
                    options: NoOptions {},
                },
            },
        };
        if binding.guest != guest {
            return Err(refused());
        }
        let prefix = format!("hkp-{namespace}-");
        let selected_name = enrollment::volume_name(&binding);
        for physical in &volume_names {
            if let Some(suffix) = physical.strip_prefix(&prefix) {
                let (owner, logical) = suffix.split_once('-').ok_or_else(refused)?;
                if !super::super::super::hex(owner, 32) || !logical_name(logical) {
                    return Err(refused());
                }
                if logical == name && (!retained || *physical != selected_name) {
                    return Err(refused());
                }
            }
        }
        let state = if let Some(owner) = selected_owner {
            // Selection alone grants no mount. The installed verifier is admitted
            // after the run reservation, before the first volume/workload effect.
            let super::witnessed::Enrollment::Enrolled { volume, .. } = &owner.0.enrollment else {
                return Err(refused());
            };
            State::Enrolled {
                volume: volume.clone(),
            }
        } else {
            State::Reserved { intent: nonce()? }
        };
        references.insert(name.clone(), Reference { binding, state });
    }
    fresh()?;
    Ok(references)
}

#[cfg(test)]
mod tests;
