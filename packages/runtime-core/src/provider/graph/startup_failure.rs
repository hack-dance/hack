//! Value-free historical failure evidence, independent of container retention.
use super::{Kind, Receipt, error, hex};
use crate::{
    CandidateError,
    project::execution::{Condition, Observation},
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub service: String,
    pub container: String,
    pub observation: Observation,
}
impl Failure {
    pub(super) fn valid(&self, receipt: &Receipt) -> bool {
        !self.service.is_empty()
            && self.service.len() <= 128
            && self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && hex(&self.container, 64)
            && (self.observation.failed()
                || (self.observation == Observation::Exited { code: 0 }
                    && matches!(
                        receipt.readiness.get(&self.service),
                        Some(Condition::Started | Condition::Healthy)
                    )))
            && receipt
                .resources
                .get(&format!("container:{}", self.service))
                .is_some_and(|resource| resource.kind == Kind::Container)
    }
}
/// Why a start failed after it reported `started-observed`, when its frontend may
/// be gone: the error code, the failed service when known, and when (Unix seconds).
/// Value-free. Kept in its own run-directory file ([`AFTER_STARTED`]), not in the
/// receipt, which an older runtime parses strictly; the owner's own cleanup keeps
/// it, and an explicit cleanup or the next start removes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AfterStarted {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub at: u64,
}
impl AfterStarted {
    pub(super) fn valid(&self) -> bool {
        (1..=64).contains(&self.code.len())
            && self
                .code
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'_')
            && self.service.as_ref().is_none_or(|service| {
                (1..=128).contains(&service.len())
                    && service
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            })
    }
}
/// The [`AfterStarted`] file, next to `state.json`.
pub(super) const AFTER_STARTED: &str = "failed-after-started.json";
/// `state::write`'s temporary for [`AFTER_STARTED`].
const AFTER_STARTED_PENDING: &str = "failed-after-started.pending";
/// Record `failure` for a receipt still in `started-observed`; call before the
/// failed phase replaces it. The recorded startup failure names the service first.
/// Diagnostic only: a failed write never obstructs the failure's own handling.
pub(super) fn record_after_started(root: &Path, receipt: &Receipt, failure: &CandidateError) {
    // A stop (signal or `hack down`) is not a failure.
    if receipt.phase != super::STARTED_OBSERVED || failure.code == "graph_cancelled" {
        return;
    }
    let service = (receipt.startup_failure.as_ref().map(|f| f.service.as_str()))
        .or(failure.service.as_deref())
        .map(str::to_owned);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let recorded = AfterStarted {
        code: failure.code.into(),
        service,
        at,
    };
    if recorded.valid() {
        // An interrupted earlier write may have left the temporary behind.
        let _ = remove(&root.join(AFTER_STARTED_PENDING))
            .and_then(|_| super::state::write(&root.join(AFTER_STARTED), &recorded));
    }
}
/// The recorded failure after started, for lease-free status. A missing, unsafe,
/// oversized or invalid file reads as none; it is never an error.
pub(super) fn after_started(root: &Path) -> Option<AfterStarted> {
    super::state::read_bounded::<AfterStarted>(&root.join(AFTER_STARTED), 4096)
        .ok()
        .filter(AfterStarted::valid)
}
/// Remove the record (and a leftover temporary). Called by a new start once it
/// supersedes the previous one, and by an explicit cleanup; never by the owner's
/// own cleanup after a failure, which keeps it.
/// True when there was a record.
pub(super) fn clear_after_started(root: &Path) -> Result<bool, CandidateError> {
    let cleared = remove(&root.join(AFTER_STARTED))?;
    remove(&root.join(AFTER_STARTED_PENDING))?;
    Ok(cleared)
}
/// `graph clear-failure-after-started`, which `hack down` calls for a run it finds
/// already stopped: only a stopped run with data retained, or a removed one, with a
/// committed journal. The caller holds the provider lease, so no start races it.
/// Idempotent; a refusal removes nothing, and a removal error is an error.
pub(super) fn clear_stopped(root: &Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    let pending = root.join("state.pending");
    if !["stopped-data-retained", "removed"].contains(&receipt.phase.as_str())
        || pending.exists()
        || pending.is_symlink()
    {
        return Err(error(
            "graph_failure_record_not_stopped",
            "The graph is not stopped (or its journal is uncertain); the failure record was kept.",
        ));
    }
    clear_after_started(root)
}
fn remove(path: &Path) -> Result<bool, CandidateError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(super::state::io(error)),
    }
}
pub(super) fn record(
    receipt: &mut Receipt,
    service: &str,
    observation: Observation,
) -> Result<(), CandidateError> {
    let failure = Failure {
        service: service.into(),
        container: receipt
            .resources
            .get(&format!("container:{service}"))
            .and_then(|resource| resource.id.clone())
            .ok_or_else(refused)?,
        observation,
    };
    if !failure.valid(receipt) {
        return Err(refused());
    }
    receipt.startup_failure = Some(failure);
    Ok(())
}
/// Fold in pre-stop evidence only for the same container, keeping the first
/// recorded failure. False is diagnostic only; it must not obstruct cleanup.
#[cfg(any(target_os = "macos", test))]
pub(super) fn capture_for_cleanup(receipt: &mut Receipt, failure: Failure) -> bool {
    if receipt.startup_failure.is_some() {
        return true;
    }
    if !failure.valid(receipt)
        || receipt
            .resources
            .get(&format!("container:{}", failure.service))
            .and_then(|resource| resource.id.as_deref())
            != Some(failure.container.as_str())
    {
        return false;
    }
    receipt.startup_failure = Some(failure);
    true
}

/// Diagnostics must not abort cleanup when the frontend's stderr pipe is gone.
#[cfg(target_os = "macos")]
pub(super) fn unrecorded() {
    write_unrecorded(&mut std::io::stderr());
}
#[cfg(any(target_os = "macos", test))]
fn write_unrecorded(output: &mut impl std::io::Write) {
    let _ = writeln!(
        output,
        "startup_failure_unrecorded: listener failure evidence could not be retained before cleanup."
    );
}
#[cfg(any(target_os = "macos", test))]
pub(super) fn preserve_listener_error(
    root: &Path,
    receipt: &mut Receipt,
    service: &str,
    observation: Observation,
    error: CandidateError,
) -> CandidateError {
    match record(receipt, service, observation)
        .and_then(|()| super::state::write(&root.join("state.json"), receipt))
    {
        Ok(()) => error,
        Err(diagnostic) => error.with_cause_code(diagnostic.code.into()),
    }
}
fn refused() -> CandidateError {
    error(
        "graph_receipt",
        "Startup failure identity cannot be confirmed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn started_receipt() -> Receipt {
        serde_json::from_value(serde_json::json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"started-observed","started_from":"preparing",
            "readiness":{"web":"healthy"},"resources":{"container:web":{"key":"web","kind":"container",
            "name":format!("hkg-{}-container-0", "a".repeat(32)),"id":"e".repeat(64),"phase":"started",
            "image":format!("sha256:{}", "f".repeat(64))}}}))
        .unwrap()
    }
    fn private_root() -> (super::super::tests::Fixture, std::path::PathBuf) {
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("run");
        super::super::state::private_directory(&root).unwrap();
        (fixture, root)
    }
    #[test]
    fn a_failure_after_started_is_recorded_beside_the_receipt_not_in_it() {
        let (_fixture, root) = private_root();
        let mut receipt = started_receipt();
        record_after_started(
            &root,
            &receipt,
            &CandidateError::new("graph_cancelled", "stopped"),
        );
        assert_eq!(after_started(&root), None);
        record(&mut receipt, "web", Observation::Exited { code: 3 }).unwrap();
        record_after_started(
            &root,
            &receipt,
            &CandidateError::new("graph_service_failed", "x"),
        );
        let recorded = after_started(&root).unwrap();
        assert_eq!(recorded.code, "graph_service_failed");
        assert_eq!(recorded.service.as_deref(), Some("web"));
        assert!(recorded.at > 0);
        // The receipt an older runtime parses strictly carries no new field.
        let json = serde_json::to_value(&receipt).unwrap();
        assert!(json.get("failed_after_started").is_none());
        // Failed, then the owner's own cleanup: still there, and only once.
        receipt.set_phase("failed-retained");
        record_after_started(&root, &receipt, &CandidateError::new("graph_timeout", "x"));
        receipt.set_phase("stopped-data-retained");
        assert_eq!(after_started(&root).as_ref(), Some(&recorded));
        assert!(!root.join(AFTER_STARTED_PENDING).exists());
        // Without a recorded service the error's own service is used.
        let mut timed_out = started_receipt();
        timed_out.startup_failure = None;
        record_after_started(
            &root,
            &timed_out,
            &CandidateError::new("graph_timeout", "x"),
        );
        assert_eq!(after_started(&root).unwrap().service, None);
        timed_out.startup_failure = None;
        let invalid = AfterStarted {
            code: "Not value-free".into(),
            service: None,
            at: 1,
        };
        assert!(!invalid.valid());
    }
    #[test]
    fn an_invalid_or_oversized_record_reads_as_none() {
        let (_fixture, root) = private_root();
        let path = root.join(AFTER_STARTED);
        for bytes in [
            b"not json".to_vec(),
            br#"{"code":"Not value-free","at":1}"#.to_vec(),
            br#"{"code":"graph_timeout","at":1,"extra":true}"#.to_vec(),
            format!(
                r#"{{"code":"graph_timeout","at":1,"service":"{}"}}"#,
                " ".repeat(8192)
            )
            .into_bytes(),
        ] {
            let _ = std::fs::remove_file(&path);
            std::fs::write(&path, bytes).unwrap();
            std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
                .unwrap();
            assert_eq!(after_started(&root), None);
        }
        // A file other users may write is not evidence either.
        std::fs::write(&path, br#"{"code":"graph_timeout","at":1}"#).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o644))
            .unwrap();
        assert_eq!(after_started(&root), None);
    }
    #[test]
    fn clearing_removes_the_record_and_a_leftover_temporary() {
        let (_fixture, root) = private_root();
        clear_after_started(&root).unwrap();
        let mut receipt = started_receipt();
        record(&mut receipt, "web", Observation::Exited { code: 3 }).unwrap();
        // A write interrupted before its rename left the temporary behind.
        std::fs::write(root.join(AFTER_STARTED_PENDING), b"interrupted").unwrap();
        record_after_started(&root, &receipt, &CandidateError::new("graph_timeout", "x"));
        assert!(after_started(&root).is_some());
        std::fs::write(root.join(AFTER_STARTED_PENDING), b"interrupted").unwrap();
        clear_after_started(&root).unwrap();
        assert_eq!(after_started(&root), None);
        assert!(!root.join(AFTER_STARTED).exists());
        assert!(!root.join(AFTER_STARTED_PENDING).exists());
    }
    #[test]
    fn clearing_a_stopped_run_refuses_any_other_phase_and_is_idempotent() {
        let (_fixture, root) = private_root();
        let mut receipt = started_receipt();
        record(&mut receipt, "web", Observation::Exited { code: 3 }).unwrap();
        record_after_started(&root, &receipt, &CandidateError::new("graph_timeout", "x"));
        for phase in [
            "preparing",
            "restoring",
            "restarting",
            "started-observed",
            "ready-observed",
            "failed-retained",
            "cleanup-intent",
        ] {
            receipt.set_phase(phase);
            let refused = clear_stopped(&root, &receipt).unwrap_err();
            assert_eq!(refused.code, "graph_failure_record_not_stopped", "{phase}");
            assert!(after_started(&root).is_some(), "{phase}");
        }
        receipt.set_phase("stopped-data-retained");
        std::fs::write(root.join("state.pending"), b"uncertain").unwrap();
        assert!(clear_stopped(&root, &receipt).is_err());
        assert!(after_started(&root).is_some());
        std::fs::remove_file(root.join("state.pending")).unwrap();
        assert!(clear_stopped(&root, &receipt).unwrap());
        assert_eq!(after_started(&root), None);
        assert!(!clear_stopped(&root, &receipt).unwrap());
        receipt.set_phase("removed");
        assert!(!clear_stopped(&root, &receipt).unwrap());
    }
    /// Wiring guard. Cleanup and the start paths need an owned VM, so their effects are
    /// proven natively; this fails if a removal is dropped or moved into the cleanup the
    /// owner shares with its own failure handling.
    #[test]
    fn explicit_cleanup_and_the_next_start_remove_the_record_but_owner_cleanup_keeps_it() {
        fn body<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
            let from = source.find(start).expect("function start");
            let to = from + source[from..].find(end).expect("function end");
            &source[from..to]
        }
        let module = include_str!("mod.rs");
        for (start, end) in [
            ("pub fn cleanup(", "pub fn remove_retained_data("),
            (
                "pub fn remove_retained_data(",
                "pub(super) fn explicit_cleanup_done(",
            ),
        ] {
            let explicit = body(module, start, end);
            let committed = explicit.find("cleanup_owned(").expect("cleanup effect");
            let removed = explicit
                .find("explicit_cleanup_done(&root)")
                .expect("explicit cleanup removes the record");
            assert!(committed < removed, "{start}");
        }
        let shared = body(
            module,
            "fn cleanup_owned(",
            "pub(super) fn startup_compatible(",
        );
        assert!(!shared.contains("explicit_cleanup_done"));
        assert!(!shared.contains("clear_after_started"));
        let foreground = include_str!("foreground.rs");
        let request = body(
            foreground,
            "if let Some(remove_data) = request.remove_data {",
            "let status = ",
        );
        assert!(request.contains("super::explicit_cleanup_done(&root)"));
        assert_eq!(foreground.matches("explicit_cleanup_done").count(), 1);
        let retained = include_str!("foreground/retained_data.rs");
        assert!(retained.contains("graph::explicit_cleanup_done(&root)"));
        for source in [
            include_str!("host_relay.rs"),
            include_str!("foreground/publishers.rs"),
        ] {
            assert!(!source.contains("explicit_cleanup_done"));
            assert!(!source.contains("clear_after_started"));
        }
        // The next start clears it once its receipt supersedes the previous one.
        let restart = body(module, "receipt.set_phase(\"restarting\");", "mod tests;");
        assert!(
            restart.find("session.save()?;").unwrap()
                < restart.find("clear_after_started(&session.root)").unwrap()
        );
        let restore = body(
            include_str!("restore.rs"),
            "fn restore_inputs(",
            "fn retain_restore_failure(",
        );
        let prepared = restore.find("driver.prepare(").unwrap();
        let cleared = restore.find("clear_after_started(&session.root)").unwrap();
        let allocated = restore.find("session.create_resources(true)").unwrap();
        assert!(prepared < cleared && cleared < allocated);
        let one_off = include_str!("one_off/runtime.rs");
        assert!(
            one_off.find("receipt.set_phase(\"restoring\");").unwrap()
                < one_off.find("clear_after_started(&root)").unwrap()
        );
    }
    use serde_json::json;

    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"preparing","readiness":{"redis":"started"},"resources":{"container:redis":{"key":"redis","kind":"container","name":format!("hkg-{}-container-0", "a".repeat(32)),"id":"e".repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))}}})).unwrap()
    }
    #[test]
    fn lost_diagnostic_pipe_does_not_abort_cleanup_evidence_handling() {
        use std::os::unix::net::UnixStream;
        let (mut writer, reader) = UnixStream::pair().unwrap();
        drop(reader);
        write_unrecorded(&mut writer);
        let mut cleaned = receipt();
        record(&mut cleaned, "redis", Observation::Exited { code: 7 }).unwrap();
        cleaned.phase = "stopped-data-retained".into();
        cleaned.resources.get_mut("container:redis").unwrap().id = None;
        let root = super::super::tests::Fixture::new();
        crate::provider::state::write(&root.0.join("state.json"), &cleaned).unwrap();
        assert!(super::super::load_at(root.0.clone(), &cleaned.run, &cleaned.owner).is_ok());
    }
    #[test]
    fn cleanup_capture_keeps_first_failure_and_refuses_replaced_container_without_writing() {
        let mut original = receipt();
        record(&mut original, "redis", Observation::Exited { code: 7 }).unwrap();
        let first = original.startup_failure.clone().unwrap();
        let mut later = first.clone();
        later.observation = Observation::Exited { code: 8 };
        assert!(capture_for_cleanup(&mut original, later));
        assert_eq!(original.startup_failure, Some(first.clone()));
        let mut replaced = receipt();
        replaced.resources.get_mut("container:redis").unwrap().id = Some("9".repeat(64));
        let bytes = serde_json::to_vec(&replaced).unwrap();
        assert!(!capture_for_cleanup(&mut replaced, first.clone()));
        assert_eq!(serde_json::to_vec(&replaced).unwrap(), bytes);
        let mut current = receipt();
        assert!(capture_for_cleanup(&mut current, first.clone()));
        assert!(capture_for_cleanup(&mut current, first.clone()));
        assert_eq!(current.startup_failure, Some(first));
    }
    #[test]
    fn failure_survives_cleanup_and_legacy_receipts_remain_readable() {
        let mut receipt = receipt();
        assert!(receipt.startup_failure.is_none());
        record(&mut receipt, "redis", Observation::Exited { code: 10 }).unwrap();
        receipt.phase = "stopped-data-retained".into();
        receipt.resources.get_mut("container:redis").unwrap().id = None;
        let retained: Receipt =
            serde_json::from_slice(&serde_json::to_vec(&receipt).unwrap()).unwrap();
        let failure = retained.startup_failure.as_ref().unwrap();
        assert!(failure.valid(&retained));
        assert_eq!(failure.container, "e".repeat(64));
        assert_eq!(failure.observation, Observation::Exited { code: 10 });
        let root = super::super::tests::Fixture::new();
        crate::provider::state::write(&root.0.join("state.json"), &retained).unwrap();
        assert!(super::super::load_at(root.0.clone(), &retained.run, &retained.owner).is_ok());
        let mut invalid = retained.clone();
        invalid.startup_failure.as_mut().unwrap().service = "foreign".into();
        crate::provider::state::write(&root.0.join("state.json"), &invalid).unwrap();
        assert!(super::super::load_at(root.0.clone(), &invalid.run, &invalid.owner).is_err());
    }
    #[test]
    fn only_failed_owned_service_observations_are_recorded() {
        let mut receipt = receipt();
        assert!(record(&mut receipt, "redis", Observation::Created).is_err());
        assert!(record(&mut receipt, "foreign", Observation::Dead).is_err());
        receipt.resources.get_mut("container:redis").unwrap().id = Some("invalid".into());
        assert!(record(&mut receipt, "redis", Observation::Dead).is_err());
        assert!(receipt.startup_failure.is_none());
    }
    #[test]
    fn required_listener_zero_exit_survives_cleanup() {
        for condition in [Condition::Started, Condition::Healthy] {
            let mut receipt = receipt();
            receipt.readiness.insert("redis".into(), condition);
            record(&mut receipt, "redis", Observation::Exited { code: 0 }).unwrap();
            receipt.phase = "stopped-data-retained".into();
            receipt.resources.get_mut("container:redis").unwrap().id = None;
            let root = super::super::tests::Fixture::new();
            crate::provider::state::write(&root.0.join("state.json"), &receipt).unwrap();
            let (retained, _) =
                super::super::load_at(root.0.clone(), &receipt.run, &receipt.owner).unwrap();
            let failure = retained.startup_failure.as_ref().unwrap();
            assert_eq!(failure.service, "redis");
            assert_eq!(failure.container, "e".repeat(64));
            assert_eq!(failure.observation, Observation::Exited { code: 0 });
        }
    }
    #[test]
    fn successful_completion_is_not_startup_failure_evidence() {
        let mut receipt = receipt();
        receipt
            .readiness
            .insert("redis".into(), Condition::Completed);
        assert!(record(&mut receipt, "redis", Observation::Exited { code: 0 }).is_err());
        receipt.readiness.clear();
        assert!(record(&mut receipt, "redis", Observation::Exited { code: 0 }).is_err());
        assert!(receipt.startup_failure.is_none());
    }
    #[test]
    fn failed_evidence_write_preserves_original_error_and_pending_bytes() {
        let root = super::super::tests::Fixture::new();
        let pending = root.0.join("state.pending");
        std::fs::write(&pending, b"retained pending evidence").unwrap();
        let mut receipt = receipt();
        let error = preserve_listener_error(
            &root.0,
            &mut receipt,
            "redis",
            Observation::Exited { code: 0 },
            CandidateError::new("graph_startup_listener_unexpected_exit", "Startup failed."),
        );
        assert_eq!(error.code, "graph_startup_listener_unexpected_exit");
        assert_eq!(error.cause_code.as_deref(), Some("provider_state"));
        assert_eq!(error.message, "Startup failed.");
        assert_eq!(
            std::fs::read(&pending).unwrap(),
            b"retained pending evidence"
        );
        assert!(!root.0.join("state.json").exists());
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("state.pending")
        );
    }
}
