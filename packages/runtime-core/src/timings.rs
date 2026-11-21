//! Opt-in span observations. Writers use reviewed constants; readers are additive.
mod collector;
mod transport;
pub use collector::{Collector, Config, Parent, Sink, Span, TimeSource, observe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub use transport::{REQUEST_PREFIX, enable_argument, exit, shutdown};

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
    CommandTotal => "command.total", CliDispatch => "cli.dispatch",
    ProcessStartup => "process.startup", ProjectDiscover => "project.discover",
    ProjectStatus => "project.status", PlanCompile => "plan.compile", EnvResolve => "env.resolve",
    RuntimeRequest => "runtime.request", RuntimeDispatch => "runtime.dispatch",
    VmEnsure => "vm.ensure", VmReattach => "vm.reattach", VmBoot => "vm.boot", VmStop => "vm.stop",
    StartObserve => "start.observe", StartDecide => "start.decide", StartWaveRecord => "start.wave.record",
    ContainerCreate => "container.create", ContainerRemove => "container.remove",
    ContainerReady => "container.ready", ContainerPublish => "container.publish", SpecDigest => "spec.digest",
    ContainerStart => "container.start", ContainerStop => "container.stop",
    ContainerExec => "container.exec", ContainerRun => "container.run", ContainerInspect => "container.inspect",
    ComposeUp => "compose.up", ComposeDown => "compose.down", ComposeRestart => "compose.restart",
    ComposeExec => "compose.exec", ComposeRun => "compose.run", ComposePs => "compose.ps",
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
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Cli,
    Runtime,
    Owner,
    Guest,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Clock {
    Host,
    Guest,
}

/// Writer error vocabulary; never accepts a message or arbitrary string.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    EngineRejected,
    EngineNotFound,
    InvalidArguments,
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
    service_index:u64, attempt:u64, engine_requests:u64, dropped:u64,
    services:u64, wave:u64, syncs:u64, waited_on_index:u64, generation:u64,
    waited_on_cap:bool, blocked:bool,
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
impl Record {
    pub fn valid(&self) -> bool {
        self.schema == SCHEMA
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
    /// Guest spans require the parent's observed spawn/exit interval instead.
    pub fn host_start_us(&self, parent_origin_mono_us: u64) -> Option<i64> {
        if !self.valid() || self.clock != Clock::Host {
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
        let record: Self = serde_json::from_str(line).ok()?;
        record.valid().then_some(record)
    }
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
