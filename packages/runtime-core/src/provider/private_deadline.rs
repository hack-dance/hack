//! Ephemeral deadlines shared by processes on the same host and boot. These values
//! are not portable timestamps and must not be persisted as renewal authority.
use crate::CandidateError;
use std::time::{Duration, Instant};

const MAX_NANOS: u64 = 300_000_000_000;
// Match std::time::Instant's clock, including sleep behavior and clock rate.
// https://doc.rust-lang.org/src/std/sys/time/unix.rs.html
#[cfg(target_vendor = "apple")]
const CLOCK: libc::clockid_t = libc::CLOCK_UPTIME_RAW;
#[cfg(not(target_vendor = "apple"))]
const CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;

/// An absolute host monotonic deadline for bounded private-input delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadline(u64);

fn refused() -> CandidateError {
    CandidateError::new(
        "private_deadline_refused",
        "Private delivery deadline expired or exceeded its budget.",
    )
}

fn remaining(deadline: u64, now: u64) -> Result<u64, CandidateError> {
    deadline
        .checked_sub(now)
        .filter(|left| *left > 0 && *left <= MAX_NANOS)
        .ok_or_else(refused)
}

fn absolute(now: u64, duration: Duration) -> Result<u64, CandidateError> {
    let nanos = u64::try_from(duration.as_nanos()).map_err(|_| refused())?;
    if nanos == 0 || nanos > MAX_NANOS {
        return Err(refused());
    }
    now.checked_add(nanos).ok_or_else(refused)
}

fn clock() -> Result<u64, CandidateError> {
    let mut value = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: value is a live, writable timespec; the selected clock requires no
    // additional resources and writes only that structure on success.
    if unsafe { libc::clock_gettime(CLOCK, &mut value) } != 0 {
        return Err(refused());
    }
    let seconds = u64::try_from(value.tv_sec).map_err(|_| refused())?;
    let nanos = u64::try_from(value.tv_nsec).map_err(|_| refused())?;
    if nanos >= 1_000_000_000 {
        return Err(refused());
    }
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|seconds| seconds.checked_add(nanos))
        .ok_or_else(refused)
}

impl Deadline {
    /// Samples the destination clock first, so conversion can shorten but never
    /// renew the supplied deadline. Expired and over-budget inputs refuse.
    pub fn from_instant(deadline: Instant) -> Result<Self, CandidateError> {
        let monotonic_before = clock()?;
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let value = absolute(monotonic_before, left)?;
        Self::from_nanos(value)
    }

    /// Validates an absolute same-host, same-boot monotonic timestamp on ingress.
    pub fn from_nanos(value: u64) -> Result<Self, CandidateError> {
        remaining(value, clock()?)?;
        Ok(Self(value))
    }

    pub fn nanos(&self) -> u64 {
        self.0
    }

    /// Revalidates expiry and samples Instant first, ensuring elapsed conversion
    /// time is deducted rather than added to the receiver's delivery budget.
    pub fn to_instant(&self) -> Result<Instant, CandidateError> {
        let instant_before = Instant::now();
        let left = remaining(self.0, clock()?)?;
        instant_before
            .checked_add(Duration::from_nanos(left))
            .ok_or_else(refused)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic_refuses_expiry_budget_and_overflow() {
        for deadline in [0, 9, 10, MAX_NANOS + 11, u64::MAX] {
            assert!(remaining(deadline, 10).is_err());
        }
        assert_eq!(remaining(MAX_NANOS + 10, 10).unwrap(), MAX_NANOS);
        assert!(absolute(0, Duration::ZERO).is_err());
        assert!(absolute(0, Duration::from_secs(301)).is_err());
        assert!(absolute(u64::MAX, Duration::from_nanos(1)).is_err());
        assert!(absolute(0, Duration::MAX).is_err());
    }

    #[test]
    fn paired_samples_deduct_conversion_delay() {
        // Source deadline is 1100; the earlier destination sample is 100,
        // followed 7ns later by a source-clock sample at 1007.
        let encoded = absolute(100, Duration::from_nanos(1100 - 1007)).unwrap();
        assert_eq!(encoded, 193);
        // Receiver samples Instant at offset 140, then monotonic at 145.
        let decoded = 140 + remaining(encoded, 145).unwrap();
        assert_eq!(decoded, 188);
        assert!(decoded < 200); // Original deadline in the destination epoch.
    }

    #[test]
    fn live_roundtrip_never_extends_original_deadline() {
        let original = Instant::now() + Duration::from_secs(120);
        let encoded = Deadline::from_instant(original).unwrap();
        let received = Deadline::from_nanos(encoded.nanos()).unwrap();
        assert!(received.to_instant().unwrap() <= original);
        assert!(Deadline::from_nanos(0).is_err());
        assert!(Deadline::from_nanos(u64::MAX).is_err());
        assert!(Deadline::from_instant(Instant::now() - Duration::from_secs(1)).is_err());
        assert!(Deadline::from_instant(Instant::now() + Duration::from_secs(301)).is_err());
    }
}
