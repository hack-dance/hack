use super::*;
use std::cell::{Cell, RefCell};

pub(super) const GIB: u64 = 1024 * 1024 * 1024;

pub(super) fn observation(profile: Profile, level: Option<u32>, headroom: u64) -> Admission {
    let pressure = MemoryPressure::from_level(level);
    Admission {
        profile,
        host_supported: true,
        free_memory_bytes: Some(headroom),
        minimum_free_memory_bytes: profile.minimum_free_memory_bytes(),
        free_plus_file_cache_estimate_bytes: Some(headroom),
        memory_budget_basis: "fixture",
        memory_pressure: pressure,
        memory_pressure_normal: pressure.memory_pressure_state == MemoryPressureState::Normal,
        disk_free_bytes: Some(disk_floor_bytes(profile)),
        minimum_disk_free_bytes: disk_floor_bytes(profile),
        disk_budget_basis: "fixture",
        one_minute_load: Some(0.0),
        load_ceiling: load_ceiling(profile),
        thermal_normal: true,
        swapouts: Some(42),
        admitted: true,
        reasons: Vec::new(),
        retained_reserve_refusal: None,
    }
}

fn operating(level: Option<u32>, headroom: u64) -> OperatingSample {
    OperatingSample {
        free_memory_bytes: 0,
        free_plus_file_cache_estimate_bytes: headroom,
        memory_pressure: MemoryPressure::from_level(level),
        thermal_normal: true,
        swapouts: 42,
    }
}

#[test]
fn exported_dispatch_masks_are_distinct_from_internal_xnu_enum_and_fail_closed() {
    for (text, level, state) in [
        ("1\n", Some(1), MemoryPressureState::Normal),
        ("2", Some(2), MemoryPressureState::Warning),
        ("4", Some(4), MemoryPressureState::Critical),
        ("0", Some(0), MemoryPressureState::Unknown),
        ("3", Some(3), MemoryPressureState::Unknown),
        ("8", Some(8), MemoryPressureState::Unknown),
        ("4294967295", Some(u32::MAX), MemoryPressureState::Unknown),
        ("4294967296", None, MemoryPressureState::Unknown),
        ("-1", None, MemoryPressureState::Unknown),
        ("", None, MemoryPressureState::Unknown),
        ("normal", None, MemoryPressureState::Unknown),
        ("1 2", None, MemoryPressureState::Unknown),
    ] {
        let pressure = MemoryPressure::parse(text);
        assert_eq!(pressure.memory_pressure_level, level);
        assert_eq!(pressure.memory_pressure_state, state);
    }
    let inconsistent = MemoryPressure {
        memory_pressure_level: Some(4),
        memory_pressure_state: MemoryPressureState::Normal,
    };
    assert!(!inconsistent.admitted(Profile::Development));
}

#[test]
fn startup_windows_keep_profile_floors_and_distinguish_warning_from_normal() {
    assert_eq!(Profile::Development.minimum_free_memory_bytes(), 10 * GIB);
    assert_eq!(Profile::Research.minimum_free_memory_bytes(), 16 * GIB);
    for (profile, level, headroom, accepted) in [
        (Profile::Development, Some(1), 10 * GIB, true),
        (Profile::Development, Some(2), 10 * GIB, true),
        (Profile::Development, Some(2), 10 * GIB - 1, false),
        (Profile::Development, Some(4), 128 * GIB, false),
        (Profile::Development, None, 128 * GIB, false),
        (Profile::Development, Some(3), 128 * GIB, false),
        (Profile::Research, Some(1), 16 * GIB, true),
        (Profile::Research, Some(1), 16 * GIB - 1, false),
        (Profile::Research, Some(2), 128 * GIB, false),
        (Profile::Research, Some(4), 128 * GIB, false),
    ] {
        let pauses = Cell::new(0);
        let result = sample_checked(
            profile,
            Some(42),
            || Ok(observation(profile, level, headroom)),
            |duration| {
                assert_eq!(
                    duration,
                    Duration::from_secs(if profile == Profile::Research { 15 } else { 1 })
                );
                pauses.set(pauses.get() + 1);
            },
        );
        assert_eq!(
            result.is_ok(),
            accepted,
            "{profile:?}, {level:?}, {headroom}"
        );
        assert_eq!(pauses.get(), if accepted { 2 } else { 0 });
    }
}

#[test]
fn incomplete_or_unsafe_samples_cannot_be_authorized_by_admitted_or_legacy_booleans() {
    for defect in 0..6 {
        let mut sample = observation(Profile::Development, Some(2), 10 * GIB);
        match defect {
            0 => sample.thermal_normal = false,
            1 => sample.swapouts = None,
            2 => sample.free_plus_file_cache_estimate_bytes = None,
            3 => sample.profile = Profile::Research,
            4 => sample.host_supported = false,
            _ => {
                // Old reports have no typed observation. A normal-only boolean
                // cannot be interpreted as authority for the new warning policy.
                sample.memory_pressure = MemoryPressure::from_level(None);
                sample.memory_pressure_normal = true;
            }
        }
        let mut sample = Some(sample);
        assert!(
            sample_checked(
                Profile::Development,
                Some(42),
                || Ok(sample.take().unwrap()),
                |_| { panic!("unsafe initial observation must stop before another sample") }
            )
            .is_err()
        );
    }
}

#[test]
fn swapouts_must_be_observed_and_unchanged_across_the_full_window() {
    for swaps in [Some(43), Some(41), None] {
        let mut calls = 0;
        let result = sample_checked(
            Profile::Development,
            Some(42),
            || {
                calls += 1;
                let mut sample = observation(Profile::Development, Some(2), 10 * GIB);
                if calls == 2 {
                    sample.swapouts = swaps;
                }
                Ok(sample)
            },
            |_| {},
        );
        assert!(matches!(result, Err(error) if error.code == "admission_rejected"));
        assert_eq!(calls, 2);
    }
}

/// A clock tests move by hand. `sleep` advances it by the full request, except that the
/// first `early_wakes` sleeps return after half of it.
pub(super) struct TestClock {
    pub(super) now: Cell<Duration>,
    pub(super) slept: RefCell<Vec<Duration>>,
    early_wakes: Cell<u32>,
}

impl TestClock {
    pub(super) fn at(now: Duration) -> Self {
        Self {
            now: Cell::new(now),
            slept: RefCell::new(Vec::new()),
            early_wakes: Cell::new(0),
        }
    }

    pub(super) fn advance(&self, by: Duration) {
        self.now.set(self.now.get() + by);
    }
}

impl Clock for TestClock {
    fn now(&self) -> Duration {
        self.now.get()
    }

    fn sleep(&self, duration: Duration) {
        self.slept.borrow_mut().push(duration);
        if self.early_wakes.get() > 0 {
            self.early_wakes.set(self.early_wakes.get() - 1);
            self.advance(duration / 2);
        } else {
            self.advance(duration);
        }
    }
}

const START: Duration = Duration::from_secs(5);

fn opened(clock: &TestClock, level: Option<u32>) -> Opened {
    open(&observation(Profile::Development, level, 10 * GIB), clock).unwrap()
}

/// A home with no recorded earlier sample.
struct NoRecord;

impl Earlier for NoRecord {
    fn usable(&self) -> Option<u64> {
        None
    }

    fn now(&self) -> Option<Duration> {
        None
    }
}

/// The sample under the lease on a home with no record: the path every start took before
/// records existed, and the one every miss still takes (`opening::tests`).
fn recheck_without_record(
    profile: Profile,
    opened: Option<Opened>,
    clock: &TestClock,
    observe: impl FnMut() -> Result<Admission, CandidateError>,
) -> Result<Vec<Admission>, CandidateError> {
    let leased = recheck_after_lease(profile, opened, clock, &NoRecord, observe)?;
    assert_eq!(
        leased.reused,
        (profile == Profile::Development).then_some(false)
    );
    Ok(leased.samples)
}

#[test]
fn the_first_development_sample_must_pass_every_predicate_to_open_the_window() {
    let clock = TestClock::at(START);
    for defect in 0..8 {
        let mut sample = observation(Profile::Development, Some(2), 10 * GIB);
        match defect {
            0 => sample.free_plus_file_cache_estimate_bytes = Some(10 * GIB - 1),
            1 => sample.memory_pressure = MemoryPressure::from_level(Some(4)),
            2 => sample.memory_pressure = MemoryPressure::from_level(None),
            3 => sample.swapouts = None,
            4 => sample.thermal_normal = false,
            5 => sample.profile = Profile::Research,
            6 => sample.host_supported = false,
            _ => {
                sample.admitted = false;
                sample.reasons.push("disk budget".into());
            }
        }
        assert!(
            matches!(open(&sample, &clock), Err(error) if error.code == "admission_rejected"),
            "{defect}"
        );
    }
    assert!(
        open(
            &observation(Profile::Development, Some(1), 10 * GIB),
            &clock
        )
        .is_ok()
    );
}

#[test]
fn a_fast_start_still_waits_out_the_admission_window_and_a_slow_one_does_not_pause() {
    for (elapsed_ms, slept) in [
        (0, vec![Duration::from_secs(1)]),
        (200, vec![Duration::from_millis(800)]),
        (999, vec![Duration::from_millis(1)]),
        (1000, vec![]),
        (3000, vec![]),
    ] {
        let clock = TestClock::at(START);
        let window = opened(&clock, Some(1));
        clock.advance(Duration::from_millis(elapsed_ms));
        let samples = recheck_without_record(Profile::Development, Some(window), &clock, || {
            // The sample under the lease never starts inside the window.
            assert!(clock.now() - START >= DEVELOPMENT_WINDOW, "{elapsed_ms}");
            Ok(observation(Profile::Development, Some(1), 10 * GIB))
        })
        .unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(*clock.slept.borrow(), slept, "{elapsed_ms}");
    }
}

#[test]
fn an_early_wake_does_not_shorten_the_admission_window() {
    let clock = TestClock::at(START);
    let window = opened(&clock, Some(1));
    clock.early_wakes.set(2);
    recheck_without_record(Profile::Development, Some(window), &clock, || {
        assert!(clock.now() - START >= DEVELOPMENT_WINDOW);
        Ok(observation(Profile::Development, Some(1), 10 * GIB))
    })
    .unwrap();
    assert_eq!(
        *clock.slept.borrow(),
        [
            Duration::from_secs(1),
            Duration::from_millis(500),
            Duration::from_millis(250)
        ]
    );
}

#[test]
fn post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale() {
    for defect in 0..8 {
        let clock = TestClock::at(START);
        let window = opened(&clock, Some(2));
        // The window has already passed: a refusal is never a matter of timing.
        clock.advance(Duration::from_secs(2));
        let allocated = Cell::new(false);
        let calls = Cell::new(0);
        let checked = recheck_without_record(Profile::Development, Some(window), &clock, || {
            calls.set(calls.get() + 1);
            let mut sample = observation(Profile::Development, Some(2), 10 * GIB);
            match defect {
                0 => sample.free_plus_file_cache_estimate_bytes = Some(10 * GIB - 1),
                1 => sample.memory_pressure = MemoryPressure::from_level(Some(4)),
                2 => sample.memory_pressure = MemoryPressure::from_level(None),
                3 => sample.swapouts = Some(43),
                4 => sample.swapouts = Some(41),
                5 => sample.swapouts = None,
                6 => sample.thermal_normal = false,
                _ => {
                    sample.admitted = false;
                    sample.reasons.push("disk budget".into());
                }
            }
            Ok(sample)
        })
        .map(|_| allocated.set(true));
        assert!(matches!(checked, Err(error) if error.code == "admission_rejected"));
        assert!(!allocated.get());
        assert_eq!(calls.get(), 1);
    }
    let clock = TestClock::at(START);
    assert!(
        recheck_without_record(Profile::Development, None, &clock, || panic!(
            "missing baseline"
        ))
        .is_err()
    );
    assert!(
        recheck_without_record(Profile::Research, None, &clock, || panic!(
            "research timing unchanged"
        ))
        .unwrap()
        .is_empty()
    );
    assert!(clock.slept.borrow().is_empty());
}

#[test]
fn a_swapout_change_between_the_chained_samples_refuses_whatever_the_wait() {
    for elapsed_ms in [0, 1000, 60_000] {
        for swaps in [43, 41] {
            let clock = TestClock::at(START);
            let window = opened(&clock, Some(1));
            clock.advance(Duration::from_millis(elapsed_ms));
            let error = recheck_without_record(Profile::Development, Some(window), &clock, || {
                let mut sample = observation(Profile::Development, Some(1), 10 * GIB);
                sample.swapouts = Some(swaps);
                Ok(sample)
            })
            .unwrap_err();
            assert_eq!(error.code, "admission_rejected");
            assert_eq!(error.message, "Swapouts changed during admission.");
        }
    }
}

/// The documented weakening of admitting Development on two samples: a host that fails and
/// recovers between them is admitted. Here the host fails at every moment strictly between
/// the sample that opens the window and the one under the lease, and passes again when that
/// second sample is taken. The earlier code took five more samples around four fixed
/// one-second pauses and refused when any one of them failed.
///
/// What still refuses such a stretch is a swapout in it, because that count is cumulative:
/// `a_swapout_change_between_the_chained_samples_refuses_whatever_the_wait`. Two starts that
/// pass together on a host with room for one are not a sampling question; their guard is a
/// host-wide admission reservation, tracked separately, not more samples.
///
/// Every sampler call and its clock time is asserted. A sample added inside the window, or
/// a window shorter than one second, would read the failing host and fail this test.
#[test]
fn a_dip_between_the_two_development_samples_is_not_seen() {
    // When the lease is held and when the second sample is due, both after the first sample.
    for (lease_ms, second_ms) in [
        (0, 1000),
        (100, 1000),
        (999, 1000),
        (1000, 1000),
        (4000, 4000),
    ] {
        let clock = TestClock::at(START);
        let second_at = START + Duration::from_millis(second_ms);
        // What a sampler would return if it were asked at `at`.
        let host = |at: Duration| {
            let failing = START < at && at < second_at;
            observation(
                Profile::Development,
                Some(if failing { 4 } else { 1 }),
                10 * GIB,
            )
        };
        for inside in [
            START + Duration::from_millis(1),
            START + Duration::from_millis(second_ms / 2),
            second_at - Duration::from_millis(1),
        ] {
            assert!(
                matches!(
                    check(Profile::Development, &host(inside), Some(42)),
                    Err(error) if error.code == "admission_rejected"
                ),
                "a sample at {inside:?} would refuse ({lease_ms})"
            );
        }
        let asked = RefCell::new(Vec::new());
        let sample = || {
            asked.borrow_mut().push(clock.now());
            host(clock.now())
        };
        let window = open(&sample(), &clock).unwrap();
        clock.advance(Duration::from_millis(lease_ms));
        let samples =
            recheck_without_record(Profile::Development, Some(window), &clock, || Ok(sample()))
                .unwrap_or_else(|error| panic!("{lease_ms}: {}", error.message));
        assert_eq!(samples.len(), 1, "{lease_ms}");
        // Exactly two readings: the one that opened the window, and one no sooner than a
        // second later. Nothing asked the host in between.
        assert_eq!(*asked.borrow(), [START, second_at], "{lease_ms}");
        assert!(second_at - START >= Duration::from_secs(1));
        assert_eq!(
            clock.slept.borrow().iter().sum::<Duration>(),
            Duration::from_millis(second_ms - lease_ms),
            "{lease_ms}"
        );
    }
}

#[test]
fn healthy_post_lease_warning_is_resampled_before_allocation() {
    let clock = TestClock::at(START);
    let window = opened(&clock, Some(1));
    let calls = Cell::new(0);
    let samples = recheck_without_record(Profile::Development, Some(window), &clock, || {
        calls.set(calls.get() + 1);
        Ok(observation(Profile::Development, Some(2), 10 * GIB))
    })
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(samples.len(), 1);
    assert!(
        samples
            .iter()
            .all(|sample| !sample.memory_pressure_normal && sample.swapouts == Some(42))
    );
}

#[test]
fn warning_operating_reserve_adds_measured_excess_without_a_provider_cap() {
    let budget = Profile::Development.provider_memory_budget_bytes();
    for footprint in [0, budget, budget + 1, 20 * GIB, 100 * GIB] {
        let floor = 4 * GIB + footprint.saturating_sub(budget);
        assert!(
            validate_operating(
                &operating(Some(2), floor),
                42,
                footprint,
                Profile::Development
            )
            .is_ok()
        );
        assert!(
            validate_operating(
                &operating(Some(2), floor - 1),
                42,
                footprint,
                Profile::Development
            )
            .is_err()
        );
    }
    assert!(validate_operating(&operating(Some(2), 128 * GIB), 42, 0, Profile::Research).is_err());
    let mut hot = operating(Some(2), 128 * GIB);
    hot.thermal_normal = false;
    let error = validate_operating(&hot, 42, 0, Profile::Development).unwrap_err();
    assert!(error.message.contains("thermal_failed=true"));
}

#[test]
fn additive_reports_keep_legacy_normal_boolean_literal_and_numeric_state_explicit() {
    for (level, state, normal) in [
        (Some(1), "normal", true),
        (Some(2), "warning", false),
        (Some(4), "critical", false),
        (None, "unknown", false),
    ] {
        let report =
            serde_json::to_value(observation(Profile::Development, level, 10 * GIB)).unwrap();
        assert_eq!(
            report["memory_pressure_level"],
            serde_json::to_value(level).unwrap()
        );
        assert_eq!(report["memory_pressure_state"], state);
        assert_eq!(report["memory_pressure_normal"], normal);
        assert!(report.get("memory_pressure").is_none());
    }
}

#[test]
fn thermal_observation_requires_both_unchanged_normal_markers() {
    let normal = "No thermal warning level has been recorded\nNo performance warning level has been recorded\n";
    assert!(thermal_normal(normal));
    for text in [
        "",
        "Thermal Warning Level = 1",
        "No thermal warning level has been recorded",
        "No performance warning level has been recorded",
    ] {
        assert!(!thermal_normal(text));
    }
}
