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

/// Error text plus whether it was fixed at compile time. A `&'static str` literal
/// cannot carry a runtime value (a path, identifier, OS error or input text);
/// formatted or borrowed text can, so only literals are marked fixed.
pub struct ErrorMessage {
    text: String,
    fixed: bool,
}

impl From<&'static str> for ErrorMessage {
    fn from(text: &'static str) -> Self {
        Self {
            text: text.to_owned(),
            fixed: true,
        }
    }
}

impl From<String> for ErrorMessage {
    fn from(text: String) -> Self {
        Self { text, fixed: false }
    }
}

/// The container setting a private process wrapper could not run, named so a
/// refusal points at the Compose or image field to change. A closed vocabulary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessField {
    /// The selected process: Compose `entrypoint`/`command` or the image's.
    Entrypoint,
    /// The selected health check test.
    Healthcheck,
    /// The selected user (Compose `user` or the image's).
    User,
    /// Compose `stop_signal`.
    StopSignal,
    /// A mount target overlapping reserved wrapper paths.
    Mounts,
}

/// Value-free: admitted service names and closed fields only, never argv,
/// paths, users or other configuration values.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRefusal {
    pub service: String,
    pub field: ProcessField,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRefusalsDiagnostic {
    pub version: u8,
    pub refusals: Vec<ProcessRefusal>,
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

/// Value-free refusal locations, boxed together so every
/// `Result<_, CandidateError>` stays small; serialized flat as
/// `process_refusals` and `plan_change`.
#[derive(Debug, Default, Serialize)]
pub struct RefusalDiagnostics {
    /// Value-free durable interactive-session UUID, never argv or environment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Every service whose selected process a private wrapper refused, found in
    /// one pass before any runtime state is reserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_refusals: Option<ProcessRefusalsDiagnostic>,
    /// Value-free location of a refused retained-run edit; see [`PlanChangeDiagnostic`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_change: Option<PlanChangeDiagnostic>,
}

/// Closed diagnostic vocabulary for the read-only log follower. No stream bytes.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogFailurePhase {
    Admission,
    PeriodicCheck,
    FinalCheck,
    StatusLine,
    Headers,
    HttpFraming,
    FrameHeader,
    Payload,
    Timestamp,
}

#[derive(Debug, Serialize)]
pub struct CandidateError {
    pub code: &'static str,
    pub message: String,
    /// True only when `message` is a compile-time literal. Callers may show such a
    /// message to users; any other message may contain runtime values and must stay
    /// internal. Changing `message` after construction must clear this flag.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub message_fixed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_phase: Option<LogFailurePhase>,
    /// Admitted Compose service the error concerns, when one is known. It is a
    /// validated graph identifier, never an engine ID or a value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<Box<str>>,
    /// Boxed `str`, not `String`, to keep every `Result<_, CandidateError>` small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<Box<str>>,
    /// Boxed, like `startup_logs`, to keep every `Result<_, CandidateError>` small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_failures: Option<Box<StopFailuresDiagnostic>>,
    /// Transient application output for a failed foreground startup; see
    /// [`StartupLogTail`]. Never persist an error carrying it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_logs: Option<Box<StartupLogsDiagnostic>>,
    /// Process-wrapper refusals and plan-change locations; see [`RefusalDiagnostics`].
    #[serde(flatten)]
    pub refusals: Option<Box<RefusalDiagnostics>>,
}

impl CandidateError {
    pub fn with_session(mut self, session: &str) -> Self {
        if crate::provider::environment_recovery::uuid(session) {
            self.refusals.get_or_insert_default().session = Some(session.into());
        }
        self
    }
    pub fn session(&self) -> Option<&str> {
        self.refusals.as_ref()?.session.as_deref()
    }
    pub fn new(code: &'static str, message: impl Into<ErrorMessage>) -> Self {
        let message = message.into();
        Self {
            code,
            message: message.text,
            message_fixed: message.fixed,
            log_phase: None,
            service: None,
            cause_code: None,
            stop_failures: None,
            startup_logs: None,
            refusals: None,
        }
    }

    pub fn with_log_phase(mut self, phase: LogFailurePhase) -> Self {
        self.log_phase = Some(phase);
        self
    }

    /// Name the admitted service; anything that is not a plain service
    /// identifier is dropped rather than echoed.
    pub fn with_service(mut self, service: &str) -> Self {
        let valid = !service.is_empty()
            && service.len() <= 128
            && service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
        self.service = valid.then(|| service.into());
        self
    }

    /// Name the service and field of a refused retained-run edit.
    pub fn with_plan_change(mut self, service: &str, field: PlanChangeField) -> Self {
        self.refusals.get_or_insert_default().plan_change = Some(PlanChangeDiagnostic {
            version: 1,
            service: service.to_owned(),
            field,
        });
        self
    }

    /// Name every service and field a private process wrapper refused.
    pub fn with_process_refusals(mut self, refusals: Vec<ProcessRefusal>) -> Self {
        self.refusals.get_or_insert_default().process_refusals = Some(ProcessRefusalsDiagnostic {
            version: 1,
            refusals,
        });
        self
    }

    pub fn process_refusals(&self) -> Option<&ProcessRefusalsDiagnostic> {
        self.refusals.as_ref()?.process_refusals.as_ref()
    }

    pub fn plan_change(&self) -> Option<&PlanChangeDiagnostic> {
        self.refusals.as_ref()?.plan_change.as_ref()
    }

    pub fn with_cause_code(mut self, code: String) -> Self {
        self.cause_code = Some(code.into_boxed_str());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::CandidateError;

    #[test]
    fn only_literal_messages_are_marked_fixed() {
        let fixed =
            serde_json::to_value(CandidateError::new("graph_image", "Fixed text.")).unwrap();
        assert_eq!(fixed["message_fixed"], true);
        let path = "/private/value-canary";
        let formatted = serde_json::to_value(CandidateError::new(
            "provider_state",
            format!("{path} failed"),
        ))
        .unwrap();
        assert!(formatted.get("message_fixed").is_none());
        assert!(formatted.get("service").is_none());
    }

    #[test]
    fn only_plain_service_identifiers_are_named() {
        let named = CandidateError::new("graph_image", "Fixed text.").with_service("web-1.api_x");
        assert_eq!(named.service.as_deref(), Some("web-1.api_x"));
        // Large errors are boxed by convention; keep the shared error small.
        assert!(std::mem::size_of::<CandidateError>() <= 128);
        for invalid in ["", "../web", "web\n", "web=VALUE", &"a".repeat(129)] {
            let error = CandidateError::new("graph_image", "Fixed text.").with_service(invalid);
            assert!(error.service.is_none(), "{invalid:?}");
        }
    }

    #[test]
    fn refusal_diagnostics_serialize_flat_and_stay_small() {
        let plain =
            serde_json::to_value(CandidateError::new("graph_image", "Fixed text.")).unwrap();
        assert!(plain.get("process_refusals").is_none());
        assert!(plain.get("plan_change").is_none());
        let changed = serde_json::to_value(
            CandidateError::new("graph_plan_reconcile", "Fixed text.")
                .with_plan_change("deps", super::PlanChangeField::DependencyCacheVolume),
        )
        .unwrap();
        assert_eq!(
            changed["plan_change"],
            serde_json::json!({"version":1,"service":"deps","field":"dependency_cache_volume"})
        );
        assert!(changed.get("process_refusals").is_none());
        // Errors embedded with a boxed slice (stop batches) stay under clippy's
        // large-error bound only while the shared error is at most 104 bytes.
        assert!(std::mem::size_of::<CandidateError>() <= 104);
    }
}
