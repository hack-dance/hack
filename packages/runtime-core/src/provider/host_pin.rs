//! Exact device-number translation for explicitly selected pre-reboot host pins.
//! This is never used by ordinary ownership, source replay, or guest observations.
use super::identity::{self, ProcessIdentity};
use crate::CandidateError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeviceRebind {
    pub old: u64,
    pub current: u64,
}

impl DeviceRebind {
    pub fn matches(self, recorded: (u64, u64), observed: (u64, u64)) -> bool {
        self.old != self.current
            && recorded.0 == self.old
            && observed.0 == self.current
            && recorded.1 != 0
            && recorded.1 == observed.1
    }

    pub fn definitely_dead_before_boot(
        self,
        process: &ProcessIdentity,
        host_boot_micros: u64,
    ) -> Result<(), CandidateError> {
        if host_boot_micros == 0
            || process.start_micros == 0
            || process.start_micros >= host_boot_micros
            || identity::alive(process.pid)?
        {
            return Err(CandidateError::new(
                "host_pin_recovery",
                "Legacy host pin owner is not proved dead before this host boot.",
            ));
        }
        Ok(())
    }
}
