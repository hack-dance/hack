use serde::{Deserialize, Serialize};

/// Research retains the frozen comparison envelope. Development is a separately
/// labelled experimental allocation; it cannot supply benchmark qualification.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Profile {
    #[default]
    Research,
    Development,
}

impl Profile {
    pub const fn memory_mib(self) -> u32 {
        match self {
            Self::Research => 2048,
            Self::Development => 6144,
        }
    }
    pub fn cpus(self) -> u32 {
        match self {
            Self::Research => 2,
            Self::Development => 4,
        }
    }
    pub fn storage_gib(self) -> u32 {
        match self {
            Self::Research => 4,
            Self::Development => 32,
        }
    }
    pub fn overlay_gib(self) -> u32 {
        match self {
            Self::Research => 4,
            Self::Development => 10,
        }
    }
    pub fn minimum_free_memory_bytes(self) -> u64 {
        match self {
            Self::Research => super::admission::FREE_MEMORY_FLOOR,
            // Guest allocation plus a provisional 2 GiB provider-overhead allowance
            // and 2 GiB left for interactive host work. The allowance is not a measurement.
            Self::Development => (u64::from(self.memory_mib()) + 4096) * 1024 * 1024,
        }
    }
    pub fn qualification(self) -> &'static str {
        match self {
            Self::Research => "WU02-live-qualification-pending",
            Self::Development => "experimental-development-not-benchmark-qualified",
        }
    }
}
