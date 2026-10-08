use super::Profile;
use super::process::{clean_command, run};
use crate::CandidateError;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

pub const FREE_MEMORY_FLOOR: u64 = 16 * 1024 * 1024 * 1024;
const RESEARCH_DISK_FLOOR_GIB: u64 = 100;
const DEVELOPMENT_HOST_DISK_RESERVE_GIB: u64 = 16;

/// The sysctl exports dispatch pressure masks, not XNU's internal pressure enum.
/// Unknown/missing observations never authorize allocation or live effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryPressureState {
    Normal,
    Warning,
    Critical,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MemoryPressure {
    pub memory_pressure_level: Option<u32>,
    pub memory_pressure_state: MemoryPressureState,
}

impl MemoryPressure {
    pub fn parse(text: &str) -> Self {
        Self::from_level(text.trim().parse().ok())
    }

    pub fn from_level(level: Option<u32>) -> Self {
        Self {
            memory_pressure_level: level,
            memory_pressure_state: match level {
                Some(1) => MemoryPressureState::Normal,
                Some(2) => MemoryPressureState::Warning,
                Some(4) => MemoryPressureState::Critical,
                _ => MemoryPressureState::Unknown,
            },
        }
    }

    fn admitted(self, profile: Profile) -> bool {
        self == Self::from_level(self.memory_pressure_level)
            && matches!(
                (profile, self.memory_pressure_state),
                (_, MemoryPressureState::Normal)
                    | (Profile::Development, MemoryPressureState::Warning)
            )
    }
}

fn thermal_normal(text: &str) -> bool {
    text.contains("No thermal warning level has been recorded")
        && text.contains("No performance warning level has been recorded")
}

fn disk_floor_bytes(profile: Profile) -> u64 {
    let gib = match profile {
        Profile::Research => RESEARCH_DISK_FLOOR_GIB,
        // Reserve the declared VM storage and overlay ceilings plus space for
        // host work. The research qualification floor is not a dev requirement.
        Profile::Development => {
            u64::from(profile.storage_gib() + profile.overlay_gib())
                + DEVELOPMENT_HOST_DISK_RESERVE_GIB
        }
    };
    gib * 1024 * 1024 * 1024
}

fn load_ceiling(profile: Profile) -> Option<f64> {
    match profile {
        Profile::Research => Some(8.0),
        // Load average includes unrelated host jobs and is not a safety signal
        // for an interactive development VM. Pressure and thermal checks remain.
        Profile::Development => None,
    }
}

#[derive(Debug, Serialize)]
pub struct Admission {
    pub profile: Profile,
    pub host_supported: bool,
    pub free_memory_bytes: Option<u64>,
    pub minimum_free_memory_bytes: u64,
    pub free_plus_file_cache_estimate_bytes: Option<u64>,
    pub memory_budget_basis: &'static str,
    #[serde(flatten)]
    pub memory_pressure: MemoryPressure,
    /// Compatibility only: true means literally normal, never an admitted warning.
    pub memory_pressure_normal: bool,
    pub disk_free_bytes: Option<u64>,
    pub minimum_disk_free_bytes: u64,
    pub disk_budget_basis: &'static str,
    pub one_minute_load: Option<f64>,
    pub load_ceiling: Option<f64>,
    pub thermal_normal: bool,
    pub swapouts: Option<u64>,
    pub admitted: bool,
    pub reasons: Vec<String>,
}

pub fn parse_free_memory(text: &str) -> Result<u64, CandidateError> {
    let page_size = text
        .split("page size of ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|v| *v > 0);
    let pages = text
        .lines()
        .find_map(|line| line.strip_prefix("Pages free:"))
        .and_then(|s| s.trim().trim_end_matches('.').parse::<u64>().ok());
    page_size
        .zip(pages)
        .and_then(|(a, b)| a.checked_mul(b))
        .ok_or_else(|| {
            CandidateError::new(
                "admission_unavailable",
                "Cannot parse vm_stat; refusing admission.",
            )
        })
}

/// An estimate, not guaranteed allocatable memory. Subtract speculative pages
/// from free first to avoid counting them again in external/file-backed pages.
/// Do not include active, inactive, compressed or purgeable totals separately.
pub fn parse_cache_headroom(text: &str) -> Result<u64, CandidateError> {
    let free = parse_free_memory(text)?;
    let size = text
        .split("page size of ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let pages = |label: &str| -> Result<u64, CandidateError> {
        text.lines()
            .find_map(|line| line.strip_prefix(label))
            .and_then(|s| s.trim().trim_end_matches('.').parse::<u64>().ok())
            .and_then(|n| n.checked_mul(size))
            .ok_or_else(|| {
                CandidateError::new(
                    "admission_unavailable",
                    "Cannot observe file-cache estimate.",
                )
            })
    };
    free.saturating_sub(pages("Pages speculative:")?)
        .checked_add(pages("File-backed pages:")?)
        .ok_or_else(|| {
            CandidateError::new("admission_unavailable", "File-cache estimate overflow.")
        })
}

#[derive(Debug, Serialize)]
pub struct OperatingSample {
    pub free_memory_bytes: u64,
    pub free_plus_file_cache_estimate_bytes: u64,
    #[serde(flatten)]
    pub memory_pressure: MemoryPressure,
    pub thermal_normal: bool,
    pub swapouts: u64,
}

pub fn operating_sample() -> Result<OperatingSample, CandidateError> {
    let text = run(
        &mut clean_command(Path::new("/usr/bin/vm_stat")),
        Duration::from_secs(3),
    )?;
    let pressure = run(
        clean_command(Path::new("/usr/sbin/sysctl"))
            .args(["-n", "kern.memorystatus_vm_pressure_level"]),
        Duration::from_secs(3),
    )?;
    let thermal = run(
        clean_command(Path::new("/usr/bin/pmset")).args(["-g", "therm"]),
        Duration::from_secs(3),
    )?;
    let swapouts = text
        .lines()
        .find_map(|line| line.strip_prefix("Swapouts:"))
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
        .ok_or_else(|| CandidateError::new("admission_unavailable", "Cannot observe swapouts."))?;
    Ok(OperatingSample {
        free_memory_bytes: parse_free_memory(&text)?,
        free_plus_file_cache_estimate_bytes: parse_cache_headroom(&text)?,
        memory_pressure: MemoryPressure::parse(&pressure),
        thermal_normal: thermal_normal(&thermal),
        swapouts,
    })
}

pub fn validate_operating(
    sample: &OperatingSample,
    baseline_swapouts: u64,
    footprint: u64,
    profile: Profile,
) -> Result<(), CandidateError> {
    let budget = profile.provider_memory_budget_bytes();
    // A provider can exceed the provisional guest-plus-overhead estimate while
    // the host remains healthy. Require matching additional host headroom for
    // that excess instead of permanently fencing an already-running graph.
    let excess_footprint = footprint.saturating_sub(budget);
    let headroom_floor = profile
        .operating_host_reserve_bytes(sample.memory_pressure.memory_pressure_state)
        .saturating_add(excess_footprint);
    let headroom_failed = sample.free_plus_file_cache_estimate_bytes < headroom_floor;
    let pressure_failed = !sample.memory_pressure.admitted(profile);
    let swap_failed = sample.swapouts != baseline_swapouts;
    let thermal_failed = !sample.thermal_normal;
    if headroom_failed || pressure_failed || swap_failed || thermal_failed {
        // Fixed labels and numeric observations only: callers can safely classify
        // the failed predicates without capturing provider output or environment.
        return Err(CandidateError::new(
            "runtime_pressure",
            format!(
                "{profile:?} effects paused: runtime_pressure headroom_failed={headroom_failed} pressure_failed={pressure_failed} swap_failed={swap_failed} thermal_failed={thermal_failed} pressure_state={:?} pressure_level={:?} headroom_bytes={} headroom_floor_bytes={headroom_floor} swapouts_baseline={baseline_swapouts} swapouts_current={} provider_footprint_bytes={footprint} provider_budget_bytes={budget} provider_excess_bytes={excess_footprint}. Inspect and stop owned capacity if pressure persists.",
                sample.memory_pressure.memory_pressure_state,
                sample.memory_pressure.memory_pressure_level,
                sample.free_plus_file_cache_estimate_bytes,
                sample.swapouts,
            ),
        ));
    }
    Ok(())
}

pub fn probe(path: &Path) -> Result<Admission, CandidateError> {
    probe_for(path, Profile::Research)
}

pub fn probe_for(path: &Path, profile: Profile) -> Result<Admission, CandidateError> {
    probe_with_disk_budget(path, profile, false)
}

/// Only the lifecycle's independently verified live development pool may use this budget.
pub(super) fn probe_owned_development(path: &Path) -> Result<Admission, CandidateError> {
    probe_with_disk_budget(path, Profile::Development, true)
}

fn disk_budget(profile: Profile, owned_live: bool) -> (u64, &'static str) {
    if profile == Profile::Development && owned_live {
        (
            DEVELOPMENT_HOST_DISK_RESERVE_GIB * 1024 * 1024 * 1024,
            "verified-live-owned-pool-host-reserve",
        )
    } else {
        (
            disk_floor_bytes(profile),
            if profile == Profile::Research {
                "research-floor"
            } else {
                "new-pool-storage-overlay-host-reserve"
            },
        )
    }
}

fn probe_with_disk_budget(
    path: &Path,
    profile: Profile,
    owned_live: bool,
) -> Result<Admission, CandidateError> {
    let supported = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let mut result = Admission {
        profile,
        host_supported: supported,
        free_memory_bytes: None,
        minimum_free_memory_bytes: profile.minimum_free_memory_bytes(),
        free_plus_file_cache_estimate_bytes: None,
        memory_budget_basis: if profile == Profile::Research {
            "raw-free-pages"
        } else {
            "free-plus-file-cache-estimate"
        },
        memory_pressure_normal: false,
        memory_pressure: MemoryPressure::from_level(None),
        disk_free_bytes: None,
        minimum_disk_free_bytes: disk_budget(profile, owned_live).0,
        disk_budget_basis: disk_budget(profile, owned_live).1,
        one_minute_load: None,
        load_ceiling: None,
        thermal_normal: false,
        swapouts: None,
        admitted: false,
        reasons: Vec::new(),
    };
    if !supported {
        result
            .reasons
            .push("WU02 provider requires Apple Silicon macOS.".into());
        return Ok(result);
    }
    let memory = run(
        &mut clean_command(Path::new("/usr/bin/vm_stat")),
        Duration::from_secs(3),
    )?;
    result.free_memory_bytes = Some(parse_free_memory(&memory)?);
    let pressure = run(
        clean_command(Path::new("/usr/sbin/sysctl"))
            .args(["-n", "kern.memorystatus_vm_pressure_level"]),
        Duration::from_secs(3),
    )?;
    result.memory_pressure = MemoryPressure::parse(&pressure);
    result.memory_pressure_normal =
        result.memory_pressure.memory_pressure_state == MemoryPressureState::Normal;
    let budget_memory = if profile == Profile::Development {
        let estimate = parse_cache_headroom(&memory)?;
        result.free_plus_file_cache_estimate_bytes = Some(estimate);
        estimate
    } else {
        result.free_memory_bytes.unwrap_or(0)
    };
    if budget_memory < result.minimum_free_memory_bytes {
        result
            .reasons
            .push(match profile {
                Profile::Research => "Free RAM is below the 16 GiB research floor.",
                Profile::Development => "Free-plus-file-cache estimate is below the 10 GiB experimental development budget (6 GiB guest plus 4 GiB overhead/reserve).",
            }.into());
    }
    if !result.memory_pressure.admitted(profile) {
        result
            .reasons
            .push("macOS memory pressure is not admitted for this profile.".into());
    }
    result.swapouts = memory
        .lines()
        .find_map(|line| line.strip_prefix("Swapouts:"))
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok());
    if result.swapouts.is_none() {
        return Err(CandidateError::new(
            "admission_unavailable",
            "Cannot observe swapouts.",
        ));
    }
    let mut loads = [0_f64; 3];
    // SAFETY: getloadavg can fill the three live f64 slots provided.
    if unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) } != 3 || !loads[0].is_finite() {
        return Err(CandidateError::new(
            "admission_unavailable",
            "Cannot observe host load.",
        ));
    }
    result.one_minute_load = Some(loads[0]);
    result.load_ceiling = load_ceiling(profile);
    if let Some(ceiling) = result.load_ceiling
        && loads[0] >= ceiling
    {
        result.reasons.push(format!(
            "Host load is at or above this profile's ceiling of {ceiling}."
        ));
    }
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| CandidateError::new("admission_unavailable", "Invalid disk probe path."))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: statvfs receives a terminated path and a correctly sized writable buffer.
    if unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(CandidateError::new(
            "admission_unavailable",
            "Cannot observe disk headroom.",
        ));
    }
    let stat = unsafe { stat.assume_init() };
    let available = (stat.f_bavail as u128) * (stat.f_frsize as u128);
    let available = u64::try_from(available)
        .map_err(|_| CandidateError::new("admission_unavailable", "Invalid disk headroom."))?;
    result.disk_free_bytes = Some(available);
    if available < result.minimum_disk_free_bytes {
        result.reasons.push(
            match profile {
                Profile::Research => "Free disk is below the 100 GiB research floor.",
                Profile::Development if owned_live => {
                    "Free disk is below the host reserve for the verified running development pool."
                }
                Profile::Development => {
                    "Free disk is below the development VM storage and host reserve budget."
                }
            }
            .into(),
        );
    }
    let thermal = run(
        clean_command(Path::new("/usr/bin/pmset")).args(["-g", "therm"]),
        Duration::from_secs(3),
    )?;
    result.thermal_normal = thermal_normal(&thermal);
    if !result.thermal_normal {
        result
            .reasons
            .push("Thermal/performance status is not confirmed normal.".into());
    }
    result.admitted = result.reasons.is_empty();
    Ok(result)
}

/// Qualification admission retains the research envelope: three samples, 15 seconds apart.
/// This time is distinct from provider boot latency and will be revisited before general use.
pub fn qualification(path: &Path) -> Result<Vec<Admission>, CandidateError> {
    sample_for(path, Profile::Research)
}

pub fn sample_for(path: &Path, profile: Profile) -> Result<Vec<Admission>, CandidateError> {
    sample_with(profile, || probe_for(path, profile))
}

pub(super) fn sample_with(
    profile: Profile,
    observe: impl FnMut() -> Result<Admission, CandidateError>,
) -> Result<Vec<Admission>, CandidateError> {
    sample_checked(profile, None, observe, std::thread::sleep)
}

/// The initial observation and a lease wait cannot hide a swapout counter change.
pub(super) fn sample_after(
    profile: Profile,
    baseline_swapouts: Option<u64>,
    observe: impl FnMut() -> Result<Admission, CandidateError>,
) -> Result<Vec<Admission>, CandidateError> {
    let baseline = baseline_swapouts.ok_or_else(|| {
        CandidateError::new(
            "admission_unavailable",
            "Cannot observe the swapout baseline.",
        )
    })?;
    sample_checked(profile, Some(baseline), observe, std::thread::sleep)
}

/// Development revalidates a full window after obtaining the startup lease,
/// before creating an owner, disks, provider capacity, or any aliases.
pub(super) fn recheck_after_lease(
    profile: Profile,
    samples: &[Admission],
    observe: impl FnMut() -> Result<Admission, CandidateError>,
) -> Result<Vec<Admission>, CandidateError> {
    if profile == Profile::Research {
        return Ok(Vec::new());
    }
    sample_after(
        profile,
        samples.last().and_then(|sample| sample.swapouts),
        observe,
    )
}

fn sample_checked(
    profile: Profile,
    mut baseline_swapouts: Option<u64>,
    mut observe: impl FnMut() -> Result<Admission, CandidateError>,
    mut pause: impl FnMut(Duration),
) -> Result<Vec<Admission>, CandidateError> {
    let mut samples: Vec<Admission> = Vec::new();
    for index in 0..3 {
        let sample = observe()?;
        let headroom = match profile {
            Profile::Research => sample.free_memory_bytes,
            Profile::Development => sample.free_plus_file_cache_estimate_bytes,
        };
        // `admitted` remains a report field, not authority to reinterpret a
        // legacy normal-only boolean or ignore an incomplete typed observation.
        if !sample.admitted
            || !sample.host_supported
            || sample.profile != profile
            || !sample.memory_pressure.admitted(profile)
            || !sample.thermal_normal
            || sample.swapouts.is_none()
            || headroom.is_none_or(|bytes| bytes < profile.minimum_free_memory_bytes())
        {
            return Err(CandidateError::new(
                "admission_rejected",
                if sample.reasons.is_empty() {
                    "A required startup resource observation is not admitted.".into()
                } else {
                    sample.reasons.join(" ")
                },
            ));
        }
        if baseline_swapouts.is_some() && baseline_swapouts != sample.swapouts {
            return Err(CandidateError::new(
                "admission_rejected",
                "Swapouts changed during admission.",
            ));
        }
        baseline_swapouts = sample.swapouts;
        samples.push(sample);
        if index < 2 {
            pause(Duration::from_secs(if profile == Profile::Research {
                15
            } else {
                1
            }));
        }
    }
    Ok(samples)
}

#[cfg(test)]
mod pressure_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_admission_uses_vm_capacity_instead_of_research_host_floors() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(disk_floor_bytes(Profile::Research), 100 * GIB);
        assert_eq!(disk_floor_bytes(Profile::Development), 58 * GIB);
        assert_eq!(disk_budget(Profile::Development, true).0, 16 * GIB);
        assert_eq!(disk_budget(Profile::Research, true).0, 100 * GIB);
        assert_eq!(disk_budget(Profile::Development, false).0, 58 * GIB);
        assert_eq!(load_ceiling(Profile::Research), Some(8.0));
        assert_eq!(load_ceiling(Profile::Development), None);
    }

    #[test]
    fn operating_diagnostics_identify_each_failed_predicate_and_observations() {
        let floor = 2 * 1024 * 1024 * 1024;
        let budget = 8 * 1024 * 1024 * 1024;
        for (headroom, normal, swapouts, footprint, flags) in [
            (
                floor - 1,
                true,
                42,
                budget,
                "headroom_failed=true pressure_failed=false swap_failed=false",
            ),
            (
                floor,
                false,
                42,
                budget,
                "headroom_failed=false pressure_failed=true swap_failed=false",
            ),
            (
                floor,
                true,
                43,
                budget,
                "headroom_failed=false pressure_failed=false swap_failed=true",
            ),
            (
                floor,
                true,
                41,
                budget,
                "headroom_failed=false pressure_failed=false swap_failed=true",
            ),
            (
                floor,
                true,
                42,
                budget + 1,
                "headroom_failed=true pressure_failed=false swap_failed=false",
            ),
            (
                0,
                false,
                u64::MAX,
                u64::MAX,
                "headroom_failed=true pressure_failed=true swap_failed=true",
            ),
        ] {
            let sample = OperatingSample {
                free_memory_bytes: 0,
                free_plus_file_cache_estimate_bytes: headroom,
                memory_pressure: MemoryPressure::from_level(Some(if normal { 1 } else { 4 })),
                thermal_normal: true,
                swapouts,
            };
            let error =
                validate_operating(&sample, 42, footprint, Profile::Development).unwrap_err();
            assert_eq!(error.code, "runtime_pressure");
            let expected_excess = footprint.saturating_sub(budget);
            let expected_floor = floor.saturating_add(expected_excess);
            assert_eq!(
                error.message,
                format!(
                    "Development effects paused: runtime_pressure {flags} thermal_failed=false pressure_state={:?} pressure_level={:?} headroom_bytes={headroom} headroom_floor_bytes={expected_floor} swapouts_baseline=42 swapouts_current={swapouts} provider_footprint_bytes={footprint} provider_budget_bytes=8589934592 provider_excess_bytes={expected_excess}. Inspect and stop owned capacity if pressure persists.",
                    sample.memory_pressure.memory_pressure_state,
                    sample.memory_pressure.memory_pressure_level,
                )
            );
        }
    }

    #[test]
    fn operating_boundaries_remain_inclusive_for_both_profiles() {
        for profile in [Profile::Research, Profile::Development] {
            let budget = (u64::from(profile.memory_mib()) + 2048) * 1024 * 1024;
            let mut sample = OperatingSample {
                free_memory_bytes: 0,
                free_plus_file_cache_estimate_bytes: 2 * 1024 * 1024 * 1024,
                memory_pressure: MemoryPressure::from_level(Some(1)),
                thermal_normal: true,
                swapouts: u64::MAX,
            };
            assert!(validate_operating(&sample, u64::MAX, budget, profile).is_ok());
            assert!(validate_operating(&sample, u64::MAX, budget + 1, profile).is_err());
            sample.free_plus_file_cache_estimate_bytes += 1;
            assert!(validate_operating(&sample, u64::MAX, budget + 1, profile).is_ok());
            sample.free_plus_file_cache_estimate_bytes -= 2;
            assert!(validate_operating(&sample, u64::MAX, 0, profile).is_err());
        }
    }

    #[test]
    fn development_headroom_scales_with_provider_excess_and_checks_live_reserve() {
        assert_eq!(
            Profile::Research.minimum_free_memory_bytes(),
            FREE_MEMORY_FLOOR
        );
        let mut sample = OperatingSample {
            free_memory_bytes: 0,
            free_plus_file_cache_estimate_bytes: 6 * 1024 * 1024 * 1024,
            memory_pressure: MemoryPressure::from_level(Some(1)),
            thermal_normal: true,
            swapouts: 42,
        };
        // The guest can consume its admitted allocation without needing a second full reservation.
        assert!(
            validate_operating(&sample, 42, 7 * 1024 * 1024 * 1024, Profile::Development).is_ok()
        );
        assert!(
            validate_operating(&sample, 42, 9 * 1024 * 1024 * 1024, Profile::Development).is_ok()
        );
        assert!(
            validate_operating(&sample, 42, 13 * 1024 * 1024 * 1024, Profile::Development).is_err()
        );
        sample.free_plus_file_cache_estimate_bytes = 30 * 1024 * 1024 * 1024;
        assert!(validate_operating(&sample, 42, 9_966_855_840, Profile::Development).is_ok());
        sample.swapouts += 1;
        assert!(validate_operating(&sample, 42, 0, Profile::Development).is_err());
        sample.swapouts = 42;
        sample.free_plus_file_cache_estimate_bytes = 1024 * 1024 * 1024;
        assert!(validate_operating(&sample, 42, 0, Profile::Development).is_err());
        sample.free_plus_file_cache_estimate_bytes = 6 * 1024 * 1024 * 1024;
        sample.memory_pressure = MemoryPressure::from_level(Some(4));
        assert!(validate_operating(&sample, 42, 0, Profile::Development).is_err());
    }
    #[test]
    fn cache_estimate_excludes_active_and_avoids_speculative_overlap() {
        let text = "(page size of 4096 bytes)\nPages free: 12.\nPages speculative: 10.\nFile-backed pages: 100.\nPages active: 99999.\n";
        assert_eq!(parse_cache_headroom(text).unwrap(), 102 * 4096);
        assert!(parse_cache_headroom("(page size of 4096 bytes)\nPages free: 12.").is_err());
    }
    #[test]
    fn parses_actual_page_size_and_only_free_pages() {
        assert_eq!(parse_free_memory("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 12.\nPages inactive: 999999.\n").unwrap(), 49152);
        assert_eq!(
            parse_free_memory("(page size of 16384 bytes)\nPages free: 12.\n").unwrap(),
            196608
        );
    }
    #[test]
    fn malformed_or_overflowing_memory_is_not_admitted() {
        for text in [
            "",
            "(page size of 0 bytes)\nPages free: 12.",
            "(page size of 16384 bytes)\nPages free: 18446744073709551615.",
        ] {
            assert!(parse_free_memory(text).is_err());
        }
    }
}
