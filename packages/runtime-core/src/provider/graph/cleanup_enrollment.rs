//! Durable graph enrollment survives coordinator rollover and blocks unsafe retention.
use super::*;
use std::path::{Component, Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Pending,
    Confirmed,
    Dormant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayCleanup {
    pub(crate) version: u8,
    pub(crate) runtime: [u8; 16],
    pub(crate) boot: [u8; 16],
    pub(crate) operation: [u8; 16],
    pub(crate) effect: [u8; 32],
    pub(crate) control_root: PathBuf,
    pub(crate) phase: Phase,
}
impl RelayCleanup {
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn control_root(&self) -> &Path {
        &self.control_root
    }
    pub(crate) fn valid(&self) -> bool {
        self.version == 1
            && self.runtime != [0; 16]
            && self.boot != [0; 16]
            && self.operation != [0; 16]
            && self.effect != [0; 32]
            && self.control_root.is_absolute()
            && self.control_root.as_os_str().len() <= 4096
            && self
                .control_root
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn new(
        control_root: &Path,
        selection: &super::super::relay_owner::lifecycle_intent::Selection,
    ) -> Result<Self, CandidateError> {
        let marker = Self {
            version: 1,
            runtime: selection.context.runtime,
            boot: selection.context.boot,
            operation: selection.operation,
            effect: selection.effect,
            control_root: control_root.into(),
            phase: Phase::Pending,
        };
        if !marker.valid() {
            return Err(refused());
        }
        Ok(marker)
    }
    /// Recovery selection only; callers must use the enrolled API, which revalidates
    /// the durable graph and coordinator before any effect can be admitted.
    #[cfg(target_os = "macos")]
    pub fn selection(&self) -> super::super::relay_owner::lifecycle_intent::Selection {
        super::super::relay_owner::lifecycle_intent::Selection {
            context: super::super::relay_owner::Context {
                runtime: self.runtime,
                boot: self.boot,
            },
            operation: self.operation,
            effect: self.effect,
        }
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn matches(
        &self,
        control_root: &Path,
        selection: &super::super::relay_owner::lifecycle_intent::Selection,
    ) -> bool {
        self.valid()
            && self.control_root == control_root
            && self.runtime == selection.context.runtime
            && self.boot == selection.context.boot
            && self.operation == selection.operation
            && self.effect == selection.effect
    }
}
fn refused() -> CandidateError {
    error(
        "graph_relay_enrollment",
        "Graph relay enrollment requires explicit recovery or confirmed acknowledgement before this operation.",
    )
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn legacy(root: &Path) -> Result<bool, CandidateError> {
    state::check_private_directory(root)?;
    if exists(&root.join("state.pending"))? {
        return Err(refused());
    }
    Ok(exists(&root.join("relay-cleanup-bridges.json"))?
        || exists(&root.join("relay-cleanup-bridges.pending"))?)
}
pub(super) fn ordinary_mutation(root: &Path, receipt: &Receipt) -> Result<(), CandidateError> {
    let legacy = legacy(root)?;
    if receipt.relay_cleanup.is_some() || receipt.relay_startup.is_some() || legacy {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn retention(root: &Path, receipt: &Receipt) -> Result<(), CandidateError> {
    #[cfg(target_os = "macos")]
    if super::dead_owner_cleanup::retained(root, receipt)? {
        return Ok(());
    }
    retention_receipt(receipt, legacy(root)?)
}
/// Also used on the bounded exported receipt before resumed prune effects.
pub(super) fn retention_receipt(receipt: &Receipt, legacy: bool) -> Result<(), CandidateError> {
    initializer_cache::require_resolved(receipt)?;
    match &receipt.relay_cleanup {
        None if !legacy && receipt.relay_startup.is_none() => Ok(()),
        Some(marker) if marker.valid() && marker.phase == Phase::Confirmed => {
            #[cfg(target_os = "macos")]
            {
                host_relay::require_acknowledged_enrollment(receipt)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(refused())
            }
        }
        _ => Err(refused()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::graph::tests::Fixture;
    use std::os::unix::fs::symlink;
    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"removed","readiness":{},"resources":{}})).unwrap()
    }
    fn marker() -> RelayCleanup {
        RelayCleanup {
            version: 1,
            runtime: [1; 16],
            boot: [2; 16],
            operation: [3; 16],
            effect: [4; 32],
            control_root: PathBuf::from("/private/owned/control"),
            phase: Phase::Pending,
        }
    }
    #[test]
    fn legacy_ordinary_graphs_remain_allowed_but_enrollment_blocks_mutations() {
        let fixture = Fixture::new();
        let mut receipt = receipt();
        assert!(ordinary_mutation(&fixture.0, &receipt).is_ok());
        assert!(retention(&fixture.0, &receipt).is_ok());
        assert!(
            serde_json::to_value(&receipt)
                .unwrap()
                .get("relay_cleanup")
                .is_none()
        );
        for phase in [Phase::Pending, Phase::Confirmed, Phase::Dormant] {
            let mut marker = marker();
            marker.phase = phase;
            receipt.relay_cleanup = Some(marker);
            assert_eq!(
                ordinary_mutation(&fixture.0, &receipt).unwrap_err().code,
                "graph_relay_enrollment"
            );
            if phase != Phase::Confirmed {
                assert!(retention(&fixture.0, &receipt).is_err());
            }
        }
    }
    #[test]
    fn legacy_selection_and_uncertain_journals_refuse_without_changing_files() {
        let fixture = Fixture::new();
        let receipt = receipt();
        let selection = fixture.0.join("relay-cleanup-bridges.json");
        fs::write(&selection, b"legacy-selection").unwrap();
        assert!(ordinary_mutation(&fixture.0, &receipt).is_err());
        assert!(retention(&fixture.0, &receipt).is_err());
        assert!(retention_receipt(&receipt, true).is_err());
        assert_eq!(fs::read(&selection).unwrap(), b"legacy-selection");
        fs::remove_file(&selection).unwrap();
        let pending = fixture.0.join("state.pending");
        symlink(fixture.0.join("missing"), &pending).unwrap();
        assert!(ordinary_mutation(&fixture.0, &receipt).is_err());
        assert!(retention(&fixture.0, &receipt).is_err());
        assert!(pending.is_symlink());
    }
    #[test]
    fn marker_validation_is_strict_and_unknown_fields_refuse() {
        let value = marker();
        assert!(value.valid());
        let mut changed = value.clone();
        changed.operation = [0; 16];
        assert!(!changed.valid());
        changed = value.clone();
        changed.control_root = "relative".into();
        assert!(!changed.valid());
        changed = value.clone();
        changed.control_root = "/private/../other".into();
        assert!(!changed.valid());
        let mut encoded = serde_json::to_value(value).unwrap();
        encoded["extra"] = json!(true);
        assert!(serde_json::from_value::<RelayCleanup>(encoded).is_err());
    }
}
