//! Host-only validation for the shared value-free stop diagnostic wire types.
//! Guest adapters include error.rs but do not own container stop effects.
use crate::error::{CandidateError, StopFailuresDiagnostic};
use std::collections::BTreeSet;

impl StopFailuresDiagnostic {
    pub(crate) fn valid(&self) -> bool {
        let mut names = BTreeSet::new();
        self.version == 1
            && (1..=32).contains(&self.failures.len())
            && self.failures.iter().all(|failure| {
                let name = failure.service.as_bytes();
                (1..=128).contains(&name.len())
                    && name[0].is_ascii_alphanumeric()
                    && name[1..].iter().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                    })
                    && names.insert(&failure.service)
            })
    }
}

impl CandidateError {
    pub(crate) fn with_stop_failures(mut self, detail: StopFailuresDiagnostic) -> Self {
        if detail.valid() {
            self.stop_failures = Some(detail);
        }
        self
    }
}
