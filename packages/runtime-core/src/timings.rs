//! Opt-in span observations. Writers use reviewed constants; readers are additive.
mod collector;
mod transport;
pub use collector::{Collector, Config, Parent, Sink, Span, TimeSource, observe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub use transport::{REQUEST_PREFIX, enable_argument, exit, requested_fd, shutdown};

pub const SCHEMA: &str = "hack.timings/1";
pub const RECORD_LIMIT: usize = 2048;
pub const MAX_NUMBER: u64 = (1 << 53) - 1;
pub const LINE_LIMIT: usize = 16 * 1024;

macro_rules! steps {
    ($($variant:ident => $name:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug)]
        pub enum Step { $($variant),* }
        impl Step { pub const fn name(self) -> &'static str { match self { $(Self::$variant => $name),* } } }
    };
}
steps! {
    ProcessStartup => "process.startup",
    ProjectStatus => "project.status", PlanCompile => "plan.compile",
    RuntimeRequest => "runtime.request", RuntimeDispatch => "runtime.dispatch",
    VmAdmissionWait => "vm.admission.wait", VmStartupLease => "vm.startup.lease",
    VmReleaseVerify => "vm.release.verify",
    VmEnsure => "vm.ensure", VmReattach => "vm.reattach", VmBoot => "vm.boot", VmStop => "vm.stop",
    StartObserve => "start.observe", StartDecide => "start.decide", StartWaveRecord => "start.wave.record",
    ContainerCreate => "container.create", ContainerRemove => "container.remove",
    ContainerReady => "container.ready", ContainerPublish => "container.publish", SpecDigest => "spec.digest",
    GraphOwnerInput => "graph.owner.input", GraphOwnerConfigure => "graph.owner.configure",
    GraphOwnerStartup => "graph.owner.startup", GraphReadyCommit => "graph.ready.commit",
    GraphPublishSeed => "graph.publish.seed", GraphPublishReserve => "graph.publish.reserve",
    GraphPublishRelays => "graph.publish.relays", GraphPublishAwait => "graph.publish.await",
    ContainersStarted => "containers.started", ServicesReady => "services.ready",
    ContainerStart => "container.start", ContainerStop => "container.stop",
    ContainerExec => "container.exec", ContainerRun => "container.run", ContainerInspect => "container.inspect",
    ImageEnsure => "image.ensure", ImageCache => "image.cache", ImageTagRecord => "image.tag.record",
    ImageEnginePreflight => "image.engine.preflight", ImageTagResolve => "image.tag.resolve",
    ImagePinVerify => "image.pin.verify",
    ImageCacheInventory => "image.cache.inventory",
    ImageArchiveDigest => "image.archive.digest", ImageImportConnect => "image.import.connect",
    ImageInspect => "image.inspect",
    Truncated => "timings.truncated",
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Error,
    Cancelled,
    Incomplete,
    Skipped,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Cli,
    Runtime,
    Owner,
    Guest,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Clock {
    Host,
    Guest,
    #[serde(other)]
    Unknown,
}

/// Existing runtime error code, never an error message.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(transparent)]
pub struct Code(&'static str);
impl Code {
    pub fn from_error(error: &crate::error::CandidateError) -> Option<Self> {
        valid_name(error.code).then_some(Self(error.code))
    }
}

/// Stable stored-result miss codes. A hit omits miss_reason.
#[derive(Clone, Copy, Debug)]
#[repr(u8)]
pub enum MissReason {
    NoRecord = 1,
    InputsChanged = 2,
    EpochChanged = 3,
    ObservationFailed = 4,
    DoNotCache = 5,
    TornRecord = 6,
    VersionChanged = 7,
}
impl Serialize for MissReason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}
/// JavaScript-safe bit mask; bit meanings belong to the producing step.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(transparent)]
pub struct InputsChangedMask(u64);
impl InputsChangedMask {
    pub fn new(bits: u64) -> Option<Self> {
        (bits <= MAX_NUMBER).then_some(Self(bits))
    }
}
macro_rules! attributes {
    ($($name:ident: $kind:ty),* $(,)?) => {
        /// Reviewed numeric/boolean writer keys. Omitted fields carry no value.
        #[derive(Clone, Debug, Default, Serialize)]
        pub struct Attrs { $(#[serde(skip_serializing_if="Option::is_none")] pub $name: Option<$kind>),* }
    };
}
attributes! {
    service_index:u64, image_index:u64, attempt:u64, registry_requests:u64, engine_requests:u64, dropped:u64,
    services:u64, wave:u64, syncs:u64, waited_on_index:u64, generation:u64,
    waited_on_cap:bool, blocked:bool, service_index_stable:bool, anchor_fresh:bool,
    admission_reused:bool,
    reason_spec:bool, reason_unhealthy:bool, reason_exited:bool, reason_dead:bool,
    reason_missing:bool, reason_forced:bool, reason_migrated:bool, reason_managed_env:bool,
    changed_image:bool, changed_command:bool, changed_env:bool, changed_managed_env:bool,
    changed_mounts:bool, changed_networks:bool, changed_limits:bool, changed_healthcheck:bool,
    changed_probe:bool, changed_ports:bool, changed_labels:bool, changed_platform:bool, changed_other:bool,
    miss_reason:MissReason, inputs_changed_mask:InputsChangedMask,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Attr {
    Number(serde_json::Number),
    Boolean(bool),
}

/// Additive reader contract. Unknown fields are ignored, step names stay opaque.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Record {
    pub schema: String,
    pub trace: String,
    pub span: String,
    pub parent: Option<String>,
    pub proc: Role,
    pub clock: Clock,
    pub origin_unix_us: u64,
    pub origin_mono_us: u64,
    pub step: String,
    pub start_us: u64,
    pub dur_us: u64,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default)]
    pub attrs: BTreeMap<String, Attr>,
}
#[derive(Deserialize)]
#[serde(remote = "Record")]
struct RecordRead {
    schema: String,
    trace: String,
    span: String,
    parent: Option<String>,
    proc: Role,
    clock: Clock,
    origin_unix_us: u64,
    origin_mono_us: u64,
    step: String,
    start_us: u64,
    dur_us: u64,
    outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(default)]
    attrs: BTreeMap<String, Attr>,
}
impl<'de> Deserialize<'de> for Record {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("expected timing object"))?;
        if !object
            .get("step")
            .ok_or_else(|| serde::de::Error::custom("missing timing step"))?
            .as_str()
            .is_some_and(valid_name)
        {
            return Err(serde::de::Error::custom("invalid timing step"));
        }
        if object
            .get("code")
            .is_some_and(|v| !v.as_str().is_some_and(valid_name))
        {
            object.remove("code");
        }
        if let Some(attrs) = object
            .get_mut("attrs")
            .and_then(serde_json::Value::as_object_mut)
        {
            attrs.retain(|key, value| {
                valid_name(key)
                    && match value {
                        serde_json::Value::Bool(_) => true,
                        serde_json::Value::Number(n) => n
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && n.abs() <= MAX_NUMBER as f64),
                        _ => false,
                    }
            });
        }
        if object.get("outcome").and_then(serde_json::Value::as_str) != Some("ok") {
            object.remove("cached");
        }
        let record = RecordRead::deserialize(value).map_err(serde::de::Error::custom)?;
        if !record.valid() {
            return Err(serde::de::Error::custom("invalid timing record"));
        }
        Ok(record)
    }
}

impl Record {
    pub fn valid(&self) -> bool {
        self.schema == SCHEMA
            && valid_name(&self.step)
            && self.code.as_ref().is_none_or(|code| valid_name(code))
            && self.attrs.keys().all(|key| valid_name(key))
            && valid_id(&self.trace, 32)
            && valid_id(&self.span, 16)
            && self
                .parent
                .as_ref()
                .is_none_or(|id| valid_id(id, 16) && id != &self.span)
            && self.origin_unix_us <= MAX_NUMBER
            && self.origin_mono_us <= MAX_NUMBER
            && self
                .start_us
                .checked_add(self.dur_us)
                .is_some_and(|end| end <= MAX_NUMBER)
            && (self.cached.is_none() || (self.cached == Some(true) && self.outcome == Outcome::Ok))
            && self.attrs.values().all(|value| match value {
                Attr::Number(n) => n
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= MAX_NUMBER as f64),
                Attr::Boolean(_) => true,
            })
    }
    /// Host placement is independent of record arrival, process startup or IDs.
    /// Guest and fresh-fallback anchors require the parent's observed spawn/exit interval instead.
    pub fn host_start_us(&self, parent_origin_mono_us: u64) -> Option<i64> {
        if !self.valid()
            || self.clock != Clock::Host
            || self.attrs.get("anchor_fresh") == Some(&Attr::Boolean(true))
        {
            return None;
        }
        let offset = i128::from(self.origin_mono_us) + i128::from(self.start_us)
            - i128::from(parent_origin_mono_us);
        (offset.abs() <= i128::from(MAX_NUMBER)).then_some(offset as i64)
    }
    pub fn parse_line(line: &str) -> Option<Self> {
        if line.len() > LINE_LIMIT {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}
/// Bounded safe identifiers: unknown names remain opaque, never paths or messages.
pub fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    let mut parts = name.split('.');
    let first = parts.next().unwrap_or_default();
    first.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && std::iter::once(first).chain(parts).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        })
}
pub(crate) fn valid_id(id: &str, len: usize) -> bool {
    id.len() == len
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && id.bytes().any(|c| c != b'0')
}

/// Disabled observation has no collector, clock, descriptor or output.
pub fn measure<T, E>(
    step: Step,
    parent: Option<Parent>,
    action: impl FnOnce(Option<Parent>) -> Result<T, E>,
) -> Result<T, E> {
    let context = parent.clone().or_else(collector::current);
    let collector = context
        .as_ref()
        .map(|p| p.collector.clone())
        .or_else(|| transport::installed().cloned());
    observe(collector.as_ref(), step, parent, action)
}

/// As [`measure`], for work that reports reviewed attributes on its own span. Disabled
/// observation hands the work attributes that nothing reads.
pub fn measure_attributed<T, E>(
    step: Step,
    parent: Option<Parent>,
    action: impl FnOnce(Option<Parent>, &mut Attrs) -> Result<T, E>,
) -> Result<T, E> {
    let context = parent.clone().or_else(collector::current);
    let collector = context
        .as_ref()
        .map(|p| p.collector.clone())
        .or_else(|| transport::installed().cloned());
    collector::observe_attributed(collector.as_ref(), step, parent, action, |_| None)
}

/// Dispatch observation includes the runtime's existing fixed error code.
pub fn measure_candidate<T>(
    step: Step,
    parent: Option<Parent>,
    action: impl FnOnce(Option<Parent>) -> Result<T, crate::error::CandidateError>,
) -> Result<T, crate::error::CandidateError> {
    let context = parent.clone().or_else(collector::current);
    let collector = context
        .as_ref()
        .map(|p| p.collector.clone())
        .or_else(|| transport::installed().cloned());
    collector::observe_with_code(collector.as_ref(), step, parent, action, Code::from_error)
}

/// Manual/async observation: capture `Span::parent` for nested work and finish
/// with typed attributes and cache status. Disabled observation returns no span.
pub fn start(step: Step, parent: Option<Parent>) -> Option<Span> {
    let context = parent.clone().or_else(collector::current);
    let collector = context
        .as_ref()
        .map(|p| p.collector.clone())
        .or_else(|| transport::installed().cloned())?;
    collector.start(step, parent)
}

#[cfg(test)]
mod tests;
