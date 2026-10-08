use super::*;
use std::cell::Cell;

const GIB: u64 = 1024 * 1024 * 1024;

fn observation(profile: Profile, level: Option<u32>, headroom: u64) -> Admission {
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

#[test]
fn post_lease_window_blocks_allocation_when_prelease_admission_goes_stale() {
    let prelease = [observation(Profile::Development, Some(2), 10 * GIB)];
    for defect in 0..7 {
        let allocated = Cell::new(false);
        let calls = Cell::new(0);
        let checked = recheck_after_lease(Profile::Development, &prelease, || {
            calls.set(calls.get() + 1);
            let mut sample = observation(Profile::Development, Some(2), 10 * GIB);
            match defect {
                0 => sample.free_plus_file_cache_estimate_bytes = Some(10 * GIB - 1),
                1 => sample.memory_pressure = MemoryPressure::from_level(Some(4)),
                2 => sample.memory_pressure = MemoryPressure::from_level(None),
                3 => sample.swapouts = Some(43),
                4 => sample.swapouts = Some(41),
                5 => sample.thermal_normal = false,
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
    assert!(recheck_after_lease(Profile::Development, &[], || panic!("missing baseline")).is_err());
    assert!(
        recheck_after_lease(Profile::Research, &[], || panic!(
            "research timing unchanged"
        ))
        .unwrap()
        .is_empty()
    );
}

#[test]
fn healthy_post_lease_warning_is_resampled_before_allocation() {
    let prelease = [observation(Profile::Development, Some(1), 10 * GIB)];
    let calls = Cell::new(0);
    let samples = recheck_after_lease(Profile::Development, &prelease, || {
        calls.set(calls.get() + 1);
        Ok(observation(Profile::Development, Some(2), 10 * GIB))
    })
    .unwrap();
    assert_eq!(calls.get(), 3);
    assert_eq!(samples.len(), 3);
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
