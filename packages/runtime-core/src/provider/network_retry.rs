//! Retry only before a response body is consumed. Callers retain their outer deadline.
use std::time::Duration;

pub(super) const ATTEMPTS: usize = 3;
pub(super) const HEADER_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn backoff(attempt: usize) -> Duration {
    Duration::from_millis(250 * attempt as u64)
}

/// Only for body-less GET send failures, before any response is returned.
/// Reqwest classifies accept-then-close/reset as request errors, not connect errors.
pub(super) fn transient(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request()
}
