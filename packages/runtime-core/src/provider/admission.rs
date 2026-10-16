use super::Profile;
use super::process::{clean_command, run};
use crate::CandidateError;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

pub const FREE_MEMORY_FLOOR: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct Admission {
    pub profile: Profile,
    pub host_supported: bool,
    pub free_memory_bytes: Option<u64>,
    pub minimum_free_memory_bytes: u64,
    pub free_plus_file_cache_estimate_bytes: Option<u64>,
    pub memory_budget_basis: &'static str,
    pub memory_pressure_normal: bool,
    pub disk_free_bytes: Option<u64>,
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
    pub memory_pressure_normal: bool,
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
    let swapouts = text
        .lines()
        .find_map(|line| line.strip_prefix("Swapouts:"))
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
        .ok_or_else(|| CandidateError::new("admission_unavailable", "Cannot observe swapouts."))?;
    Ok(OperatingSample {
        free_memory_bytes: parse_free_memory(&text)?,
        free_plus_file_cache_estimate_bytes: parse_cache_headroom(&text)?,
        memory_pressure_normal: pressure.trim() == "1",
        swapouts,
    })
}

pub fn validate_operating(
    sample: &OperatingSample,
    baseline_swapouts: u64,
    footprint: u64,
    profile: Profile,
) -> Result<(), CandidateError> {
    let budget = (u64::from(profile.memory_mib()) + 2048) * 1024 * 1024;
    if sample.free_plus_file_cache_estimate_bytes < 2 * 1024 * 1024 * 1024
        || !sample.memory_pressure_normal
        || sample.swapouts != baseline_swapouts
        || footprint > budget
    {
        return Err(CandidateError::new(
            "runtime_pressure",
            "Development effects paused: host reserve, pressure, swap stability or provider-footprint budget failed. Inspect and stop owned capacity if pressure persists.",
        ));
    }
    Ok(())
}

pub fn probe(path: &Path) -> Result<Admission, CandidateError> {
    probe_for(path, Profile::Research)
}

pub fn probe_for(path: &Path, profile: Profile) -> Result<Admission, CandidateError> {
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
        disk_free_bytes: None,
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
    result.memory_pressure_normal = pressure.trim() == "1";
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
    if !result.memory_pressure_normal {
        result
            .reasons
            .push("macOS memory pressure is not normal.".into());
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
    let load_ceiling = match profile {
        Profile::Research => 8.0,
        Profile::Development => std::thread::available_parallelism()
            .map_err(|_| {
                CandidateError::new("admission_unavailable", "Cannot observe CPU capacity.")
            })?
            .get() as f64,
    };
    result.load_ceiling = Some(load_ceiling);
    if loads[0] >= load_ceiling {
        result.reasons.push(format!(
            "Host load is at or above this profile's ceiling of {load_ceiling}."
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
    if available < 100 * 1024 * 1024 * 1024 {
        result
            .reasons
            .push("Free disk is below the 100 GiB research floor.".into());
    }
    let thermal = run(
        clean_command(Path::new("/usr/bin/pmset")).args(["-g", "therm"]),
        Duration::from_secs(3),
    )?;
    result.thermal_normal = thermal.contains("No thermal warning level has been recorded")
        && thermal.contains("No performance warning level has been recorded");
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
    let mut samples: Vec<Admission> = Vec::new();
    for index in 0..3 {
        let sample = probe_for(path, profile)?;
        if !sample.admitted {
            return Err(CandidateError::new(
                "admission_rejected",
                sample.reasons.join(" "),
            ));
        }
        if samples
            .first()
            .is_some_and(|first| first.swapouts != sample.swapouts)
        {
            return Err(CandidateError::new(
                "admission_rejected",
                "Swapouts increased during admission.",
            ));
        }
        samples.push(sample);
        if index < 2 {
            std::thread::sleep(Duration::from_secs(if profile == Profile::Research {
                15
            } else {
                1
            }));
        }
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_budget_keeps_research_separate_and_checks_live_reserve() {
        assert_eq!(
            Profile::Research.minimum_free_memory_bytes(),
            FREE_MEMORY_FLOOR
        );
        let mut sample = OperatingSample {
            free_memory_bytes: 0,
            free_plus_file_cache_estimate_bytes: 6 * 1024 * 1024 * 1024,
            memory_pressure_normal: true,
            swapouts: 42,
        };
        // The guest can consume its admitted allocation without needing a second full reservation.
        assert!(
            validate_operating(&sample, 42, 7 * 1024 * 1024 * 1024, Profile::Development).is_ok()
        );
        assert!(
            validate_operating(&sample, 42, 9 * 1024 * 1024 * 1024, Profile::Development).is_err()
        );
        sample.swapouts += 1;
        assert!(validate_operating(&sample, 42, 0, Profile::Development).is_err());
        sample.swapouts = 42;
        sample.free_plus_file_cache_estimate_bytes = 1024 * 1024 * 1024;
        assert!(validate_operating(&sample, 42, 0, Profile::Development).is_err());
        sample.free_plus_file_cache_estimate_bytes = 6 * 1024 * 1024 * 1024;
        sample.memory_pressure_normal = false;
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
