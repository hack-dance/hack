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

#[derive(Debug, Serialize)]
pub struct CandidateError {
    pub code: &'static str,
    pub message: String,
    /// True only when `message` is a compile-time literal. Callers may show such a
    /// message to users; any other message may contain runtime values and must stay
    /// internal. Changing `message` after construction must clear this flag.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub message_fixed: bool,
    /// Admitted Compose service the error concerns, when one is known. It is a
    /// validated graph identifier, never an engine ID or a value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<String>,
    /// Boxed, like `startup_logs`, to keep every `Result<_, CandidateError>` small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_failures: Option<Box<StopFailuresDiagnostic>>,
    /// Transient application output for a failed foreground startup; see
    /// [`StartupLogTail`]. Never persist an error carrying it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_logs: Option<Box<StartupLogsDiagnostic>>,
    /// Every service whose selected process a private wrapper refused, found in
    /// one pass before any runtime state is reserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_refusals: Option<Box<ProcessRefusalsDiagnostic>>,
}

impl CandidateError {
    pub fn new(code: &'static str, message: impl Into<ErrorMessage>) -> Self {
        let message = message.into();
        Self {
            code,
            message: message.text,
            message_fixed: message.fixed,
            service: None,
            cause_code: None,
            stop_failures: None,
            startup_logs: None,
            process_refusals: None,
        }
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

    pub fn with_cause_code(mut self, code: String) -> Self {
        self.cause_code = Some(code);
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
}
