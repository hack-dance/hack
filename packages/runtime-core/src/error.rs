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

/// Only the public reviewed port of an unhealthy inferred probe. No path,
/// response, other configuration or application output crosses this boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RouteProbeDiagnostic {
    pub version: u8,
    pub port: u16,
}

/// Network authority and bounded attempt count only; never a URL, token or response.
/// Version 1 carries `host` and `attempts`; version 2 adds a closed `reason` (and the
/// HTTP `status` for [`NetworkFailureReason::HttpStatus`]).
#[derive(Debug, Serialize)]
pub struct NetworkRequestDiagnostic {
    pub version: u8,
    pub host: String,
    pub attempts: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NetworkFailureReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Why the last attempt of a registry layer download failed. A closed vocabulary: it
/// never carries transport text, a URL or response bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkFailureReason {
    /// The attempt's time limit passed while the body was still arriving.
    Timeout,
    /// The connection ended before the descriptor's size had arrived.
    ShortRead,
    /// Every byte arrived but they did not hash to the descriptor's digest.
    DigestMismatch,
    /// The registry announced or sent a size other than the descriptor's.
    SizeMismatch,
    /// The registry answered with a status other than success.
    HttpStatus,
    /// The acquisition's own deadline left no time for another attempt.
    Deadline,
}

/// One state path that is not what the runtime requires, relative to the candidate
/// state root (`.hack-local/...`), or only its final name when it lies outside it.
#[derive(Debug, Serialize)]
pub struct StateComponentDiagnostic {
    pub version: u8,
    pub path: String,
}

/// Value-free refusal locations, boxed together so every
/// `Result<_, CandidateError>` stays small; serialized flat as
/// `process_refusals`, `plan_change` and `route_probe`.
#[derive(Debug, Default, Serialize)]
pub struct RefusalDiagnostics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_request: Option<NetworkRequestDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_component: Option<StateComponentDiagnostic>,
    /// File-only explanations. Every sentence and field is a compile-time literal;
    /// only validated service names come from the project. Never contains values.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub configuration_refusals: Vec<ConfigurationRefusal>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_probe: Option<RouteProbeDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConfigurationRefusal {
    pub text_fixed: bool,
    pub service: Option<Box<str>>,
    pub field: &'static str,
    pub message: &'static str,
    pub fix: &'static str,
}

impl ConfigurationRefusal {
    pub fn new(field: &'static str, message: &'static str, fix: &'static str) -> Self {
        Self {
            text_fixed: true,
            service: None,
            field,
            message,
            fix,
        }
    }

    pub fn with_service(mut self, service: &str) -> Self {
        self.service = CandidateError::new("configuration", "Configuration refusal.")
            .with_service(service)
            .service;
        self
    }
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
    /// Carry only a parsed network host, excluding userinfo, query and path.
    pub fn with_network_request(self, host: &str, attempts: usize) -> Self {
        self.network_request(host, attempts, None)
    }

    /// [`Self::with_network_request`] plus why the last attempt failed (version 2).
    /// `status` is kept only for [`NetworkFailureReason::HttpStatus`] and a valid code.
    pub fn with_network_failure(
        self,
        host: &str,
        attempts: usize,
        reason: NetworkFailureReason,
        status: Option<u16>,
    ) -> Self {
        let status = status.filter(|code| {
            reason == NetworkFailureReason::HttpStatus && (100..=599).contains(code)
        });
        self.network_request(host, attempts, Some((reason, status)))
    }

    fn network_request(
        mut self,
        host: &str,
        attempts: usize,
        failure: Option<(NetworkFailureReason, Option<u16>)>,
    ) -> Self {
        if !host.is_empty()
            && host.len() <= 253
            && attempts <= 3
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-:[]".contains(&b))
        {
            self.refusals.get_or_insert_default().network_request =
                Some(NetworkRequestDiagnostic {
                    version: if failure.is_some() { 2 } else { 1 },
                    host: host.to_owned(),
                    attempts,
                    reason: failure.map(|(reason, _)| reason),
                    status: failure.and_then(|(_, status)| status),
                });
        }
        self
    }

    /// Carry one state path, relative to the state root (see [`StateComponentDiagnostic`]).
    /// A label outside the bounded path grammar is dropped, never escaped.
    pub fn with_state_component(mut self, path: &str) -> Self {
        if !path.is_empty()
            && path.len() <= 240
            && !path.starts_with('/')
            && !path.split('/').any(|part| part.is_empty() || part == "..")
            && path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
        {
            self.refusals.get_or_insert_default().state_component =
                Some(StateComponentDiagnostic {
                    version: 1,
                    path: path.to_owned(),
                });
        }
        self
    }

    pub fn with_configuration_refusals(mut self, mut findings: Vec<ConfigurationRefusal>) -> Self {
        // Malformed lists can repeat the same field thousands of times. Keep
        // every distinct explanation, not one copy per authored value. This
        // also bounds current producers below the CLI's shared 1 MiB error
        // envelope, including planning and startup consumers.
        let mut seen = std::collections::BTreeSet::new();
        findings.retain(|item| seen.insert((item.service.clone(), item.field, item.message)));
        self.refusals
            .get_or_insert_with(Default::default)
            .configuration_refusals = findings;
        self
    }
    pub fn with_session(mut self, session: &str) -> Self {
        // This file is also compiled by the guest, which has no host provider.
        if session.len() == 36
            && session.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
                }
            })
        {
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

    pub fn with_route_probe(mut self, port: u16) -> Self {
        self.refusals.get_or_insert_default().route_probe =
            Some(RouteProbeDiagnostic { version: 1, port });
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
