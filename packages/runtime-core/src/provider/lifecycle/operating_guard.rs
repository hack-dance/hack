use super::super::{Profile, admission};
use crate::CandidateError;
use std::cell::Cell;
use std::time::{Duration, Instant};

/// A live Development connection carries its observed swapout baseline across
/// effects. Failed observations never refresh the last successful check.
pub(super) struct OperatingGuard {
    swapouts: u64,
    last: Cell<Instant>,
}

impl OperatingGuard {
    pub(super) fn connect(
        profile: Profile,
        observe: impl FnOnce() -> Result<(admission::OperatingSample, u64), CandidateError>,
    ) -> Result<Self, CandidateError> {
        let (sample, footprint) = observe()?;
        admission::validate_operating(&sample, sample.swapouts, footprint, profile)?;
        Ok(Self {
            swapouts: sample.swapouts,
            last: Cell::new(Instant::now()),
        })
    }

    pub(super) fn before_effect(
        &self,
        profile: Profile,
        observe: impl FnOnce() -> Result<(admission::OperatingSample, u64), CandidateError>,
    ) -> Result<(), CandidateError> {
        self.check_at(Instant::now(), profile, observe)
    }

    fn check_at(
        &self,
        now: Instant,
        profile: Profile,
        observe: impl FnOnce() -> Result<(admission::OperatingSample, u64), CandidateError>,
    ) -> Result<(), CandidateError> {
        if now.duration_since(self.last.get()) >= Duration::from_secs(2) {
            let (sample, footprint) = observe()?;
            admission::validate_operating(&sample, self.swapouts, footprint, profile)?;
            self.last.set(Instant::now());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn fixture(swapouts: u64, last: Instant) -> Self {
        Self {
            swapouts,
            last: Cell::new(last),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use admission::{MemoryPressure, OperatingSample};

    const GIB: u64 = 1024 * 1024 * 1024;

    fn observation(
        level: Option<u32>,
        headroom: u64,
        swapouts: u64,
        thermal: bool,
    ) -> OperatingSample {
        OperatingSample {
            free_memory_bytes: 0,
            free_plus_file_cache_estimate_bytes: headroom,
            memory_pressure: MemoryPressure::from_level(level),
            thermal_normal: thermal,
            swapouts,
        }
    }

    #[test]
    fn connection_checks_warning_reserve_critical_unknown_and_thermal_before_authority() {
        for (level, headroom, thermal, admitted) in [
            (Some(1), 2 * GIB, true, true),
            (Some(2), 4 * GIB, true, true),
            (Some(2), 4 * GIB - 1, true, false),
            (Some(4), 100 * GIB, true, false),
            (None, 100 * GIB, true, false),
            (Some(2), 100 * GIB, false, false),
        ] {
            let connected = OperatingGuard::connect(Profile::Development, || {
                Ok((observation(level, headroom, 42, thermal), 8 * GIB))
            });
            assert_eq!(
                connected.is_ok(),
                admitted,
                "{level:?}, {headroom}, {thermal}"
            );
        }
    }

    #[test]
    fn effect_checks_block_mutation_and_keep_the_failed_guard_due() {
        for (level, headroom, swapouts, thermal, footprint) in [
            (Some(2), 4 * GIB - 1, 42, true, 8 * GIB),
            (Some(2), 4 * GIB, 42, true, 8 * GIB + 1),
            (Some(4), 100 * GIB, 42, true, 8 * GIB),
            (None, 100 * GIB, 42, true, 8 * GIB),
            (Some(1), 100 * GIB, 43, true, 8 * GIB),
            (Some(1), 100 * GIB, 41, true, 8 * GIB),
            (Some(1), 100 * GIB, 42, false, 8 * GIB),
        ] {
            let last = Instant::now() - Duration::from_secs(3);
            let guard = OperatingGuard::fixture(42, last);
            let mutation = Cell::new(false);
            let refused = guard
                .before_effect(Profile::Development, || {
                    Ok((observation(level, headroom, swapouts, thermal), footprint))
                })
                .map(|()| mutation.set(true));
            assert!(matches!(refused, Err(error) if error.code == "runtime_pressure"));
            assert!(!mutation.get());
            assert_eq!(guard.last.get(), last);
            let rechecks = Cell::new(0);
            guard
                .before_effect(Profile::Development, || {
                    rechecks.set(rechecks.get() + 1);
                    Ok((observation(Some(2), 5 * GIB, 42, true), 9 * GIB))
                })
                .unwrap();
            assert_eq!(rechecks.get(), 1);
            assert!(guard.last.get() > last);
        }
    }

    #[test]
    fn healthy_effect_uses_the_bounded_check_interval_and_retains_the_baseline() {
        let guard = OperatingGuard::connect(Profile::Development, || {
            Ok((observation(Some(1), 2 * GIB, 42, true), 8 * GIB))
        })
        .unwrap();
        guard
            .check_at(
                guard.last.get() + Duration::from_secs(1),
                Profile::Development,
                || panic!("fresh guard must not repeat a host probe"),
            )
            .unwrap();
        guard
            .check_at(
                guard.last.get() + Duration::from_secs(2),
                Profile::Development,
                || Ok((observation(Some(2), 4 * GIB, 42, true), 8 * GIB)),
            )
            .unwrap();
        assert_eq!(guard.swapouts, 42);
    }
}
