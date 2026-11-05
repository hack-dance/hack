//! Shared value-free error contract for host runtime and guest adapters.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Boxed: rarely present, and it keeps every `Result<_, CandidateError>` small.
    pub stop_failures: Option<Box<StopFailuresDiagnostic>>,
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
