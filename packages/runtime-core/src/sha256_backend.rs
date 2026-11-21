//! Which SHA-256 implementation this process runs: the CPU's instructions or software.
//!
//! `sha2 0.11.1` decides in `src/sha256.rs`. With no backend flag (see `sha256_guard`) it
//! compiles the hardware backend and the software one for aarch64 and x86_64, and on the
//! first block asks `cpufeatures` whether the CPU has the instructions: `sha2` on aarch64
//! (always present on Apple Silicon; `AT_HWCAP` on Linux), `sha` and `sse4.1` on x86_64
//! (CPUID). A CPU without them hashes in software with the same result. The tokens below
//! are declared exactly as `sha2` declares its own, against the same `cpufeatures` crate, so
//! [`hardware`] answers what `sha2` answers.
use serde::Serialize;

#[cfg(target_arch = "aarch64")]
cpufeatures::new!(cpu_sha256, "sha2");
#[cfg(target_arch = "x86_64")]
cpufeatures::new!(cpu_sha256, "sha", "sse4.1");

/// `true` when `sha2` hashes SHA-256 with the CPU's instructions in this process.
pub fn hardware() -> bool {
    #[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
    {
        cpu_sha256::get()
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        false
    }
}

/// The `hashing` member of `runtime status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Report {
    /// `hardware` or `software`.
    pub sha256: &'static str,
}

/// What this process hashes with. Detection runs once; later calls read one atomic.
pub fn report() -> Report {
    Report {
        sha256: if hardware() { "hardware" } else { "software" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CPU's own answer, from the standard library's detection, which shares no code
    /// with `cpufeatures`.
    fn cpu_has_sha256() -> bool {
        #[cfg(target_arch = "aarch64")]
        {
            std::arch::is_aarch64_feature_detected!("sha2")
        }
        #[cfg(target_arch = "x86_64")]
        {
            std::arch::is_x86_feature_detected!("sha")
                && std::arch::is_x86_feature_detected!("sse4.1")
        }
        #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
        {
            false
        }
    }

    /// Software hashing cannot come back unnoticed: on a CPU with SHA-256 instructions the
    /// build must select them. The build half is `sha256_guard` (no forced software backend);
    /// this is the run half. Every Apple Silicon Mac has the instructions.
    #[test]
    fn a_cpu_with_sha256_instructions_hashes_with_them() {
        if cfg!(all(target_arch = "aarch64", target_vendor = "apple")) {
            assert!(
                cpu_has_sha256(),
                "Apple Silicon always has SHA-256 instructions"
            );
        }
        if cpu_has_sha256() {
            assert!(
                hardware(),
                "this CPU has SHA-256 instructions and sha2 would hash in software"
            );
            assert_eq!(report().sha256, "hardware");
        } else {
            assert_eq!(
                report().sha256,
                if hardware() { "hardware" } else { "software" }
            );
        }
        assert_eq!(
            serde_json::to_string(&report()).unwrap(),
            format!(r#"{{"sha256":"{}"}}"#, report().sha256)
        );
    }

    /// The guard and the formatter that `config-compiler` carries are the same text as here.
    #[test]
    fn the_config_compiler_carries_the_same_guard_and_formatter() {
        assert_eq!(
            include_str!("sha256_guard.rs"),
            include_str!("../../config-compiler/src/sha256_guard.rs")
        );
        assert_eq!(
            include_str!("hex.rs"),
            include_str!("../../config-compiler/src/hex.rs")
        );
    }
}
