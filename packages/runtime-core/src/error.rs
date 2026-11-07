//! Shared error contract for host runtime and guest adapters. Every field is
//! value-free except the transient `startup_logs` of a foreground startup failure
//! reply, which is application output and is never persisted.
use serde::{Deserialize, Serialize};

/// Value-free stop detail. Service names are admitted graph identifiers, never
/// engine IDs; stages are a closed vocabulary rather than transport messages.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopFailureStage {
    ConnectTimeout,
    Connect,
    Timeout,
    Response,
    Worker,
    Transport,
    Deadline,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StopFailureDiagnostic {
    pub service: String,
    pub stage: StopFailureStage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StopFailuresDiagnostic {
    pub version: u8,
    pub failures: Vec<StopFailureDiagnostic>,
}

/// Bounded application output of one failed service, captured before startup
/// cleanup removes its container. It may contain managed values, so it is a
/// transient part of the foreground failure reply only: never journaled, written
/// to a receipt or copied into persisted failure evidence. Consumers must redact
/// managed values before display. Each stream holds whole lines only.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StartupLogTail {
    pub service: String,
    pub stdout: String,
    pub stderr: String,
    /// Some of the requested tail lines were omitted to stay within the byte bound.
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StartupLogsDiagnostic {
    pub version: u8,
    pub services: Vec<StartupLogTail>,
}

/// Closed vocabulary for the Compose field of a retained-run edit that cannot be
/// applied in place.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanChangeField {
    /// A retained run-owned named volume is now declared as a dependency cache.
    DependencyCacheVolume,
    /// Routed hostnames changed together with something only reconciliation applies.
    Hostnames,
}

/// Value-free location of a refused retained-run edit. The service is an
/// admitted Compose identifier, never a value, path or engine ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PlanChangeDiagnostic {
    pub version: u8,
    pub service: String,
    pub field: PlanChangeField,
}

#[derive(Debug, Serialize)]
pub struct CandidateError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<String>,
    /// Boxed, like `startup_logs`, to keep every `Result<_, CandidateError>` small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_failures: Option<Box<StopFailuresDiagnostic>>,
    /// Transient application output for a failed foreground startup; see
    /// [`StartupLogTail`]. Never persist an error carrying it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_logs: Option<Box<StartupLogsDiagnostic>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_change: Option<Box<PlanChangeDiagnostic>>,
}

impl CandidateError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause_code: None,
            stop_failures: None,
            startup_logs: None,
            plan_change: None,
        }
    }

    /// Name the service and field of a refused retained-run edit.
    pub fn with_plan_change(mut self, service: &str, field: PlanChangeField) -> Self {
        self.plan_change = Some(Box::new(PlanChangeDiagnostic {
            version: 1,
            service: service.to_owned(),
            field,
        }));
        self
    }

    pub fn with_cause_code(mut self, code: String) -> Self {
        self.cause_code = Some(code);
        self
    }
}
