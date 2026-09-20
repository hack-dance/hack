//! Retry only explicit pre-effect lease contention; each attempt reconstructs review.
use hack_runtime_core::CandidateError;
use std::time::{Duration, Instant};

pub(crate) enum Attempt<T> {
    Busy,
    Complete(T),
}

pub(crate) fn run<T>(
    deadline: Option<Instant>,
    attempt: impl FnMut() -> Result<Attempt<T>, CandidateError>,
) -> Result<T, CandidateError> {
    retry(deadline, attempt, Instant::now, std::thread::sleep)
}

fn retry<T>(
    deadline: Option<Instant>,
    mut attempt: impl FnMut() -> Result<Attempt<T>, CandidateError>,
    clock: impl Fn() -> Instant,
    mut sleep: impl FnMut(Duration),
) -> Result<T, CandidateError> {
    let mut backoff = Duration::from_millis(50);
    loop {
        if deadline.is_some_and(|end| clock() >= end) {
            return Err(CandidateError::new(
                "source_watch_deadline",
                "Watch deadline expired before the observed source update was acknowledged.",
            ));
        }
        match attempt()? {
            Attempt::Complete(value) => return Ok(value),
            Attempt::Busy => {
                let delay = deadline.map_or(backoff, |end| {
                    backoff.min(end.saturating_duration_since(clock()))
                });
                sleep(delay);
                backoff = (backoff * 2).min(Duration::from_secs(1));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    #[test]
    fn contention_recaptures_latest_input_and_backs_off_within_deadline() {
        let now = Cell::new(Instant::now());
        let end = now.get() + Duration::from_secs(10);
        let current = Cell::new(0);
        let captures = RefCell::new(Vec::new());
        let delays = RefCell::new(Vec::new());
        let result = retry(
            Some(end),
            || {
                let freshly_captured = current.get();
                captures.borrow_mut().push(freshly_captured);
                if freshly_captured < 6 {
                    Ok(Attempt::Busy)
                } else {
                    Ok(Attempt::Complete(freshly_captured))
                }
            },
            || now.get(),
            |delay| {
                delays.borrow_mut().push(delay);
                now.set(now.get() + delay);
                current.set(current.get() + 1);
            },
        )
        .unwrap();
        assert_eq!(result, 6);
        assert_eq!(*captures.borrow(), vec![0, 1, 2, 3, 4, 5, 6]);
        assert_eq!(delays.borrow()[0], Duration::from_millis(50));
        assert!(delays.borrow().iter().all(|d| *d <= Duration::from_secs(1)));
    }
    #[test]
    fn deadline_stops_contention_and_errors_are_never_retried() {
        let now = Cell::new(Instant::now());
        let end = now.get() + Duration::from_millis(75);
        let attempts = Cell::new(0);
        let result = retry::<()>(
            Some(end),
            || {
                attempts.set(attempts.get() + 1);
                Ok(Attempt::Busy)
            },
            || now.get(),
            |delay| now.set(now.get() + delay),
        )
        .unwrap_err();
        assert_eq!(result.code, "source_watch_deadline");
        assert_eq!(attempts.get(), 2);
        assert_eq!(now.get(), end);
        for code in [
            "provider_busy",
            "source_sync",
            "live_source_contract",
            "source_changed",
            "runtime_changed",
        ] {
            let attempts = Cell::new(0);
            let result = retry::<()>(
                None,
                || {
                    attempts.set(attempts.get() + 1);
                    Err(CandidateError::new(code, "refused"))
                },
                Instant::now,
                |_| panic!("unsafe retry"),
            );
            assert_eq!(result.unwrap_err().code, code);
            assert_eq!(attempts.get(), 1);
        }
    }
}
