//! Shared value-free error contract for host runtime and guest adapters.
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CandidateError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<String>,
}

impl CandidateError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause_code: None,
        }
    }

    pub fn with_cause_code(mut self, code: String) -> Self {
        self.cause_code = Some(code);
        self
    }
}
