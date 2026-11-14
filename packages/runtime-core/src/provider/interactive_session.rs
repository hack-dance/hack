//! Value-free write-ahead interactive intents. They authorize no replay. Even a
//! validated Engine exit retires a known exec; surviving descendants belong to
//! the user. EOF alone and a changed VM boot are never cleanup proof.
use super::{engine::log_follow::valid_timestamp, environment_recovery, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const LIMIT: usize = 1024;
pub fn valid_session(value: &str) -> bool {
    environment_recovery::uuid(value)
}
fn changed() -> CandidateError {
    CandidateError::new(
        "session_store_changed",
        "Interactive session evidence changed during observation; retry hack exec-sessions. Nothing was cleared or replayed.",
    )
}
fn refused() -> CandidateError {
    CandidateError::new(
        "session_receipt_refused",
        "Interactive session evidence is unsafe, incomplete or changed; no start was replayed and all evidence was retained.",
    )
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    Authored,
    Adopted,
}

/// Exact admitted incarnation. Contains identifiers only, never argv, paths or
/// environment values. The frontend already owns the project-down remedy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub backend: Backend,
    pub namespace: String,
    pub run: String,
    pub owner: String,
    pub boot: String,
    pub container: String,
    pub generation: String,
    pub service: String,
}
impl Binding {
    pub fn valid(&self) -> bool {
        hex(&self.namespace, 64)
            && hex(&self.run, 32)
            && hex(&self.owner, 32)
            && environment_recovery::uuid(&self.boot)
            && hex(&self.container, 64)
            && valid_timestamp(&self.generation)
            && !self.service.is_empty()
            && self.service.len() <= 128
            && self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    version: u8,
    pub session: String,
    pub binding: Binding,
    pub exec: Option<String>,
}
impl Receipt {
    pub fn valid(&self) -> bool {
        self.version == 1
            && environment_recovery::uuid(&self.session)
            && self.binding.valid()
            && self.exec.as_deref().is_none_or(|id| hex(id, 64))
    }
}

struct Store {
    root: PathBuf,
    identity: (u64, u64),
    lock: Option<state::Lock>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoppedBoot {
    owner: String,
    boot: String,
}
impl StoppedBoot {
    fn name(&self) -> Result<String, CandidateError> {
        if !hex(&self.owner, 32) || !environment_recovery::uuid(&self.boot) {
            return Err(refused());
        }
        Ok(format!("stopped-{}-{}.json", self.owner, self.boot))
    }
    fn covers(&self, binding: &Binding) -> bool {
        self.owner == binding.owner && self.boot == binding.boot
    }
}
type Snapshot = (Vec<Receipt>, Vec<StoppedBoot>);
impl Store {
    /// No creation, lease, pending-file pruning or other writes.
    fn observe(candidate: &Candidate) -> Result<Option<Self>, CandidateError> {
        let root = candidate.state_root.join("run/exec-sessions");
        let metadata = match fs::symlink_metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(refused()),
            Ok(metadata) => metadata,
        };
        let store = Self {
            root,
            identity: (metadata.dev(), metadata.ino()),
            lock: None,
        };
        store.check()?;
        Ok(Some(store))
    }
    fn retire(&self, receipt: &Receipt) -> Result<bool, CandidateError> {
        if self.lock.is_none() {
            return Err(refused());
        }
        let current = self.list()?;
        match current.iter().find(|r| r.session == receipt.session) {
            None => return Ok(false), // Another exact-proof reconciliation won.
            Some(found) if found != receipt => return Err(refused()),
            Some(_) => (),
        }
        self.check()?;
        if receipt.exec.is_some() {
            fs::remove_file(self.path(&receipt.session, true)).map_err(|_| refused())?;
            File::open(&self.root)
                .and_then(|f| f.sync_all())
                .map_err(|_| refused())?;
        }
        // A crash between these removals retains an intent requiring absence or
        // a stopped boot. Never infer completion from a missing exec record.
        fs::remove_file(self.path(&receipt.session, false)).map_err(|_| refused())?;
        File::open(&self.root)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())?;
        self.check()?;
        Ok(true)
    }
    fn open(candidate: &Candidate, create: bool) -> Result<Option<Self>, CandidateError> {
        let root = candidate.state_root.join("run/exec-sessions");
        if !create {
            match fs::symlink_metadata(&root) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(refused()),
                Ok(_) => (),
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let lock = loop {
            let attempt = if create {
                state::Lock::acquire(&root)
            } else {
                state::Lock::acquire_existing(&root)
            };
            match attempt {
                Ok(lock) => break lock,
                Err(error) if error.code == "provider_busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) if error.code == "provider_busy" => {
                    return Err(CandidateError::new(
                        "session_receipt_busy",
                        "Another interactive admission is updating session evidence; nothing was replayed.",
                    ));
                }
                Err(_) => return Err(refused()),
            }
        };
        let metadata = fs::symlink_metadata(&root).map_err(|_| refused())?;
        let value = Self {
            root,
            identity: (metadata.dev(), metadata.ino()),
            lock: Some(lock),
        };
        value.check()?;
        if create {
            // Persist newly created directory entries as well as their contents.
            for parent in value.root.ancestors().skip(1) {
                File::open(parent)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| refused())?;
                if parent == candidate.state_root.parent().ok_or_else(refused)? {
                    break;
                }
            }
        }
        Ok(Some(value))
    }
    fn check(&self) -> Result<(), CandidateError> {
        if let Some(lock) = &self.lock {
            lock.verify_path(&self.root).map_err(|_| refused())?;
        } else {
            state::check_private_directory(&self.root).map_err(|_| refused())?;
        }
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != self.identity {
            return Err(refused());
        }
        Ok(())
    }
    fn path(&self, session: &str, exec: bool) -> PathBuf {
        self.root.join(format!(
            "{session}.{}.json",
            if exec { "exec" } else { "intent" }
        ))
    }
    fn write(&self, receipt: &Receipt) -> Result<(), CandidateError> {
        if !receipt.valid() {
            return Err(refused());
        }
        self.check()?;
        let path = self.path(&receipt.session, receipt.exec.is_some());
        let absent = || {
            self.check()?;
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(refused()),
            }
        };
        absent()?;
        state::write_before_rename(&path, receipt, &absent).map_err(|_| refused())
    }
    fn snapshot(&self) -> Result<Snapshot, CandidateError> {
        if self.lock.is_some() {
            return self.snapshot_once();
        }
        self.observe_snapshot(&mut || self.snapshot_once())
    }
    // Coarse-timestamp filesystems can still yield a stale/refused presentation;
    // these stamps never grant mutation or absence authority.
    fn stamp(&self) -> Result<(i64, i64, i64, i64), CandidateError> {
        self.check()?;
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        Ok((
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ))
    }
    fn observe_snapshot(
        &self,
        read: &mut dyn FnMut() -> Result<Snapshot, CandidateError>,
    ) -> Result<Snapshot, CandidateError> {
        for _ in 0..3 {
            let before = self.stamp()?;
            let snapshot = read();
            let after = self.stamp()?;
            if before == after
                && !snapshot
                    .as_ref()
                    .is_err_and(|e| e.code == "session_store_changed")
            {
                return snapshot;
            }
        }
        Err(changed())
    }
    fn entry_error(&self, error: std::io::Error) -> CandidateError {
        if self.lock.is_none() && error.kind() == std::io::ErrorKind::NotFound {
            changed()
        } else {
            refused()
        }
    }
    fn read_record<T: serde::de::DeserializeOwned>(
        &self,
        path: &Path,
    ) -> Result<T, CandidateError> {
        state::read_bounded(path, 4096).map_err(|_| {
            // read_bounded redacts I/O errors. Only a proven vanished entry is
            // transitional; malformed, aliased or inaccessible final files refuse.
            match fs::symlink_metadata(path) {
                Err(error) => self.entry_error(error),
                Ok(_) => refused(),
            }
        })
    }
    fn snapshot_once(&self) -> Result<Snapshot, CandidateError> {
        self.check()?;
        let mut intents = BTreeMap::new();
        let mut execs = BTreeMap::new();
        let mut stopped = Vec::new();
        for (index, entry) in fs::read_dir(&self.root).map_err(|_| refused())?.enumerate() {
            if index > LIMIT * 4 {
                return Err(refused());
            }
            let entry = entry.map_err(|_| refused())?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(refused)?;
            if name == "operation.lock" {
                continue;
            }
            if name.starts_with("stopped-") && name.ends_with(".json") {
                let proof: StoppedBoot = self.read_record(&entry.path())?;
                if proof.name()? != name {
                    return Err(refused());
                }
                stopped.push(proof);
                continue;
            }
            if let Some(base) = name.strip_suffix(".pending") {
                let receipt_name = base.rsplit_once('.').is_some_and(|(session, kind)| {
                    environment_recovery::uuid(session) && ["intent", "exec"].contains(&kind)
                });
                let proof_name = base.strip_prefix("stopped-").is_some_and(|value| {
                    value.is_ascii()
                        && value.len() == 69
                        && hex(&value[..32], 32)
                        && value.as_bytes()[32] == b'-'
                        && environment_recovery::uuid(&value[33..])
                });
                if !receipt_name && !proof_name {
                    return Err(refused());
                }
                let metadata =
                    fs::symlink_metadata(entry.path()).map_err(|e| self.entry_error(e))?;
                // These are our unpublished value-free writes. No effect may
                // follow until the final rename and directory fsync return.
                if !metadata.is_file()
                    || metadata.nlink() != 1
                    || metadata.mode() & 0o7777 != 0o600
                    || metadata.uid() != unsafe { libc::geteuid() }
                {
                    return Err(refused());
                }
                // Observation never deletes unpublished evidence. Mutation
                // paths prune these files under the lock before publishing.
                continue;
            }
            let receipt: Receipt = self.read_record(&entry.path())?;
            if !receipt.valid()
                || entry.path() != self.path(&receipt.session, receipt.exec.is_some())
            {
                return Err(refused());
            }
            let map = if receipt.exec.is_some() {
                &mut execs
            } else {
                &mut intents
            };
            if map.insert(receipt.session.clone(), receipt).is_some() {
                return Err(refused());
            }
        }
        if intents.len() > LIMIT {
            return Err(refused());
        }
        for (session, execution) in execs {
            let intent = intents.get_mut(&session).ok_or_else(refused)?;
            if intent.binding != execution.binding {
                return Err(refused());
            }
            *intent = execution;
        }
        self.check()?;
        Ok((intents.into_values().collect(), stopped))
    }
    fn list(&self) -> Result<Vec<Receipt>, CandidateError> {
        Ok(self.snapshot()?.0)
    }
    fn prune_pending(&self) -> Result<(), CandidateError> {
        self.snapshot()?; // Validate every name and file before mutation.
        for entry in fs::read_dir(&self.root).map_err(|_| refused())? {
            let entry = entry.map_err(|_| refused())?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|s| s.ends_with(".pending"))
            {
                self.check()?;
                fs::remove_file(entry.path()).map_err(|_| refused())?;
            }
        }
        File::open(&self.root)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())
    }
}

/// Only a newly fsynced intent can be advanced to an exec ID. Loading receipts
/// returns data, never this capability. A crashed create/start is never replayed.
pub struct Intent {
    receipt: Receipt,
}
impl Intent {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    /// Only live admission may withdraw a definitely undispatched intent.
    /// Loading records never recreates this capability.
    pub fn withdraw(self, candidate: &Candidate) -> Result<(), CandidateError> {
        let store = Store::open(candidate, false)?.ok_or_else(refused)?;
        if self.receipt.exec.is_some() || !store.list()?.contains(&self.receipt) {
            return Err(refused());
        }
        store.check()?;
        fs::remove_file(store.path(&self.receipt.session, false)).map_err(|_| refused())?;
        File::open(&store.root)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())
    }
    pub fn record_exec(
        mut self,
        candidate: &Candidate,
        exec: &str,
    ) -> Result<Receipt, CandidateError> {
        if !hex(exec, 64) {
            return Err(refused());
        }
        let store = Store::open(candidate, false)?.ok_or_else(refused)?;
        if !store.list()?.iter().any(|r| r == &self.receipt) {
            return Err(refused());
        }
        self.receipt.exec = Some(exec.into());
        store.write(&self.receipt)?;
        Ok(self.receipt)
    }
}

pub fn admit(
    candidate: &Candidate,
    binding: Binding,
    session: &str,
) -> Result<Intent, CandidateError> {
    if !binding.valid() || !environment_recovery::uuid(session) {
        return Err(refused());
    }
    let store = Store::open(candidate, true)?.ok_or_else(refused)?;
    store.prune_pending()?;
    if store.list()?.len() >= LIMIT {
        return Err(CandidateError::new(
            "session_receipt_limit",
            "The native home has 1024 retained interactive sessions. List with hack exec-sessions; try hack exec-sessions --reconcile to clear proven exits, or hack down for the affected project.",
        ));
    }
    let receipt = Receipt {
        version: 1,
        session: session.into(),
        binding,
        exec: None,
    };
    store.write(&receipt)?;
    Ok(Intent { receipt })
}
pub fn retained(candidate: &Candidate) -> Result<Vec<Receipt>, CandidateError> {
    Store::observe(candidate)?.map_or(Ok(Vec::new()), |s| s.list())
}

/// Caller has observed normal stream closure and validated this exact exec's
/// exit against the same container generation, owner and boot.
#[cfg(any(target_os = "macos", test))]
pub(in crate::provider) fn retire_completed(
    candidate: &Candidate,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if receipt.exec.is_none() {
        return Err(refused());
    }
    Store::open(candidate, false)?
        .ok_or_else(refused)?
        .retire(receipt)?;
    Ok(())
}

pub(crate) enum RetirementProof {
    Unknown,
    ContainerAbsent,
    ExecExitedValidated,
    BootStopped,
}

/// Called only while lifecycle holds the released VM's lock, after process,
/// disk-handle and socket absence are proven. Persist before changing the owner
/// phase: a crash or subsequent boot cannot erase the cleanup proof.
#[cfg(target_os = "macos")]
pub(crate) fn after_boot_stopped(candidate: &Candidate, owner: &state::Owner) {
    let result = (|| {
        let Some(boot) = &owner.guest_boot_id else {
            return Ok(());
        };
        let Some(store) = Store::open(candidate, false)? else {
            return Ok(());
        };
        store.prune_pending()?;
        let (receipts, _) = store.snapshot()?;
        let proof = StoppedBoot {
            owner: owner.token.clone(),
            boot: boot.clone(),
        };
        if !receipts.iter().any(|r| proof.covers(&r.binding)) {
            return Ok(());
        }
        state::write_before_rename(&store.root.join(proof.name()?), &proof, &|| store.check())?;
        drop(store);
        reconcile(candidate, &|_| Ok(RetirementProof::Unknown))?;
        Ok::<_, CandidateError>(())
    })();
    if result.is_err() {
        cleanup_warning();
    }
}

#[cfg(target_os = "macos")]
fn cleanup_warning() {
    cleanup_notice(format_args!(
        "session_cleanup_uncertain: interactive receipts were retained; container cleanup was not rolled back. Retry hack down for this project and instance."
    ));
}

#[cfg(target_os = "macos")]
fn cleanup_notice(message: std::fmt::Arguments<'_>) {
    use std::io::Write;
    // The foreground reader may already be gone. Diagnostics must not turn
    // successfully completed cleanup into a panic on a broken stderr pipe.
    let _ = writeln!(std::io::stderr().lock(), "{message}");
}

/// Exact validated exit, same-boot absence or a clean-stop receipt retires a
/// session. A new boot cannot establish absence in an earlier boot's Engine.
#[cfg(target_os = "macos")]
pub fn reconcile_observed(candidate: &Candidate) -> Result<usize, CandidateError> {
    if retained(candidate)?.is_empty() {
        return Ok(0);
    }
    let owner = state::Owner::load(candidate)?;
    let observer = super::engine::Observer::connect(candidate);
    let deadline = Instant::now() + Duration::from_secs(2);
    reconcile(candidate, &|receipt| {
        let binding = &receipt.binding;
        if binding.owner != owner.token {
            return Ok(RetirementProof::Unknown);
        }
        if owner.phase == "stopped"
            && owner
                .clean_stop
                .as_ref()
                .is_some_and(|stop| stop.guest_boot_id == binding.boot)
        {
            return Ok(RetirementProof::BootStopped);
        }
        let observer = observer.as_ref().map_err(|_| refused())?;
        if Instant::now() >= deadline {
            return Ok(RetirementProof::Unknown);
        }
        if observer.incarnation() != binding.owner || observer.guest().boot_id()? != binding.boot {
            return Ok(RetirementProof::Unknown);
        }
        match observer.get_until(
            &format!("/v1.53/containers/{}/json", binding.container),
            deadline,
        ) {
            Err(error) if error.code == "engine_not_found" => Ok(RetirementProof::ContainerAbsent),
            Ok(_) if receipt.exec.is_some() => {
                match observer.interactive_finished(receipt, deadline) {
                    Ok(Some(_)) => Ok(RetirementProof::ExecExitedValidated),
                    _ => Ok(RetirementProof::Unknown),
                }
            }
            Ok(_) => Ok(RetirementProof::Unknown),
            Err(error) => Err(error),
        }
    })
}

/// Bookkeeping never prevents the container cleanup that resolves uncertainty.
#[cfg(target_os = "macos")]
pub(crate) fn after_cleanup(candidate: &Candidate, run: &str) {
    let _ = reconcile_observed(candidate);
    match retained(candidate) {
        Ok(records) => {
            for line in cleanup_report(&records, run) {
                cleanup_notice(format_args!("{line}"));
            }
        }
        Err(_) => cleanup_warning(),
    }
}

#[cfg(any(target_os = "macos", test))]
fn cleanup_report(records: &[Receipt], run: &str) -> Vec<String> {
    let selected: Vec<_> = records.iter().filter(|r| r.binding.run == run).collect();
    let mut lines = Vec::new();
    if !selected.is_empty() {
        lines.push(format!(
            "session_cleanup_uncertain: {} interactive session receipts remain for this run; run hack exec-sessions --reconcile, or retry hack down for this project and instance.",
            selected.len()
        ));
        for record in &selected {
            lines.push(format!(
                "session {} run {} service {}",
                record.session, record.binding.run, record.binding.service
            ));
        }
    }
    let other = records.len() - selected.len();
    if other > 0 {
        lines.push(format!(
            "{other} interactive session receipts belong to other runs; use hack exec-sessions to inspect them."
        ));
    }
    lines
}

/// Caller supplies exact absence or established stopped-boot proof for each
/// binding. Both must cover its boot and owner, never a new-boot 404. This helper
/// performs no Engine effects and does not turn malformed receipts into absence.
pub(crate) fn reconcile(
    candidate: &Candidate,
    proof: &dyn Fn(&Receipt) -> Result<RetirementProof, CandidateError>,
) -> Result<usize, CandidateError> {
    let Some(store) = Store::open(candidate, false)? else {
        return Ok(0);
    };
    store.prune_pending()?;
    let (receipts, stopped) = store.snapshot()?;
    drop(store);
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut count = 0;
    for receipt in receipts {
        if Instant::now() >= deadline {
            break;
        }
        if !stopped.iter().any(|p| p.covers(&receipt.binding))
            && matches!(proof(&receipt)?, RetirementProof::Unknown)
        {
            continue;
        }
        // Engine observation runs with no journal lock held. Revalidate after
        // reacquiring it, so another admission/down can progress meanwhile.
        let Some(store) = Store::open(candidate, false)? else {
            continue;
        };
        let current = store.list()?;
        if !current.contains(&receipt) {
            continue;
        }
        store.retire(&receipt)?;
        count += 1;
    }
    // Keep a stopped-boot proof across partial reconciliation. Remove it only
    // after every bound receipt has gone; admission to that boot is fenced by
    // lifecycle's VM lock and the admission freshness checks.
    if !stopped.is_empty() {
        if let Some(store) = Store::open(candidate, false)? {
            let current = store.list()?;
            for stop in stopped {
                if !current.iter().any(|r| stop.covers(&r.binding)) {
                    store.check()?;
                    match fs::remove_file(store.root.join(stop.name()?)) {
                        Ok(()) => (),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                        Err(_) => return Err(refused()),
                    }
                }
            }
            File::open(&store.root)
                .and_then(|f| f.sync_all())
                .map_err(|_| refused())?;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn admit(candidate: &Candidate, binding: Binding) -> Result<Intent, CandidateError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        super::admit(
            candidate,
            binding,
            &format!(
                "00000000-0000-4000-8000-{:012x}",
                NEXT.fetch_add(1, Ordering::Relaxed)
            ),
        )
    }
    fn fixture() -> (PathBuf, Candidate, Binding) {
        let root = crate::private_test_root(&std::env::temp_dir(), "interactive-session");
        let candidate = Candidate::discover(&root).unwrap();
        let binding = Binding {
            backend: Backend::Authored,
            namespace: "a".repeat(64),
            run: "b".repeat(32),
            owner: "c".repeat(32),
            boot: "00000000-0000-4000-8000-000000000001".into(),
            container: "d".repeat(64),
            generation: "2026-11-12T01:02:03.123456789Z".into(),
            service: "web".into(),
        };
        (root, candidate, binding)
    }
    #[test]
    fn create_and_start_crash_windows_retain_evidence_without_replay() {
        let (root, candidate, binding) = fixture();
        let intent = admit(&candidate, binding.clone()).unwrap();
        assert_eq!(
            retained(&candidate).unwrap(),
            vec![intent.receipt().clone()]
        );
        drop(intent); // Crash before create or before recording its response.
        let second = admit(&candidate, binding.clone()).unwrap();
        let receipt = second.record_exec(&candidate, &"e".repeat(64)).unwrap();
        assert_eq!(retained(&candidate).unwrap().len(), 2);
        assert!(retained(&candidate).unwrap().contains(&receipt));
        assert_eq!(
            reconcile(&candidate, &|_| Ok(RetirementProof::Unknown)).unwrap(),
            0
        ); // EOF alone is not proof.
        assert_eq!(
            reconcile(&candidate, &|b| {
                assert_eq!(&b.binding, &binding);
                Ok(RetirementProof::ContainerAbsent)
            })
            .unwrap(),
            2
        );
        assert!(retained(&candidate).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn terminal_restores_before_busy_retirement_and_preserves_known_exit() {
        use super::super::graph::interactive_exec::finish;
        let (root, candidate, binding) = fixture();
        let receipt = admit(&candidate, binding)
            .unwrap()
            .record_exec(&candidate, &"e".repeat(64))
            .unwrap();
        let locked = Store::open(&candidate, false).unwrap().unwrap();
        for exit in [0, 7] {
            let restored = std::cell::Cell::new(false);
            let completion = finish(
                &receipt.session,
                Ok(exit),
                || {
                    restored.set(true);
                    Ok(())
                },
                || {
                    assert!(restored.get(), "store wait began with a raw terminal");
                    let error = retire_completed(&candidate, &receipt).unwrap_err();
                    assert_eq!(error.code, "session_receipt_busy");
                    Err(error)
                },
            )
            .unwrap();
            assert_eq!(completion.exit_code, exit);
            assert!(completion.retained);
            assert_eq!(retained(&candidate).unwrap(), vec![receipt.clone()]);
        }
        drop(locked);
        retire_completed(&candidate, &receipt).unwrap();
        assert!(retained(&candidate).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_restore_and_unknown_exit_stay_scoped_and_never_retire() {
        use super::super::graph::interactive_exec::finish;
        let session = "00000000-0000-4000-8000-000000000001";
        let error = finish(
            session,
            Ok(0),
            || {
                Err(CandidateError::new(
                    "interactive_terminal_restore_failed",
                    "restore",
                ))
            },
            || panic!("failed restoration must preserve the receipt"),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "interactive_terminal_restore_failed");
        assert_eq!(error.session(), Some(session));
        let restored = std::cell::Cell::new(false);
        let error = finish(
            session,
            Err(CandidateError::new("session_cleanup_uncertain", "unknown")),
            || {
                restored.set(true);
                Ok(())
            },
            || panic!("unknown exit is not retirement proof"),
        )
        .err()
        .unwrap();
        assert!(restored.get());
        assert_eq!(error.code, "session_cleanup_uncertain");
        assert_eq!(error.session(), Some(session));
    }

    #[test]
    fn cleanup_names_only_the_selected_run_and_counts_unrelated_receipts() {
        let (root, candidate, binding) = fixture();
        let selected = admit(&candidate, binding.clone()).unwrap();
        let mut unrelated = binding.clone();
        unrelated.run = "f".repeat(32);
        unrelated.namespace = "e".repeat(64);
        unrelated.service = "unrelated-private-service".into();
        let other = admit(&candidate, unrelated).unwrap();
        let records = retained(&candidate).unwrap();
        let report = cleanup_report(&records, &binding.run).join("\n");
        assert!(report.contains(&selected.receipt.session));
        assert!(report.contains(&binding.run));
        assert!(report.contains("service web"));
        assert!(report.contains("1 interactive session receipts belong to other runs"));
        for value in [
            &other.receipt.session,
            &other.receipt.binding.run,
            &other.receipt.binding.namespace,
            &other.receipt.binding.service,
        ] {
            assert!(!report.contains(value));
        }
        retire_completed(
            &candidate,
            &selected.record_exec(&candidate, &"e".repeat(64)).unwrap(),
        )
        .unwrap();
        let report = cleanup_report(&retained(&candidate).unwrap(), &binding.run).join("\n");
        assert!(!report.contains("session_cleanup_uncertain"));
        assert!(!report.contains(&other.receipt.session));
        assert!(report.contains("hack exec-sessions"));
        assert_eq!(retained(&candidate).unwrap(), vec![other.receipt]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_receipt_retirement_is_exact_and_does_not_accumulate() {
        let (root, candidate, binding) = fixture();
        let unknown = admit(&candidate, binding.clone()).unwrap();
        let receipt = admit(&candidate, binding.clone())
            .unwrap()
            .record_exec(&candidate, &"e".repeat(64))
            .unwrap();
        let mut changed = receipt.clone();
        changed.exec = Some("f".repeat(64));
        assert!(retire_completed(&candidate, &changed).is_err());
        assert!(retire_completed(&candidate, unknown.receipt()).is_err());
        retire_completed(&candidate, &receipt).unwrap();
        retire_completed(&candidate, &receipt).unwrap(); // Concurrent reconciliation is idempotent.
        assert_eq!(retained(&candidate).unwrap(), vec![unknown.receipt.clone()]);
        for _ in 0..8 {
            let receipt = admit(&candidate, binding.clone())
                .unwrap()
                .record_exec(&candidate, &"e".repeat(64))
                .unwrap();
            retire_completed(&candidate, &receipt).unwrap();
        }
        assert_eq!(retained(&candidate).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_never_takes_mutation_lock_and_duplicate_id_never_overwrites() {
        let (root, candidate, binding) = fixture();
        let intent = admit(&candidate, binding.clone()).unwrap();
        assert!(super::admit(&candidate, binding, &intent.receipt.session).is_err());
        let store = Store::open(&candidate, false).unwrap().unwrap();
        let before = fs::metadata(&store.root).unwrap().mtime_nsec();
        assert_eq!(retained(&candidate).unwrap(), vec![intent.receipt.clone()]);
        assert_eq!(fs::metadata(&store.root).unwrap().mtime_nsec(), before);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn observation_retries_renames_and_retirement_but_never_masks_corruption() {
        let (root, candidate, binding) = fixture();
        let intent = admit(&candidate, binding).unwrap();
        let store = Store::observe(&candidate).unwrap().unwrap();
        let receipt = intent.receipt.clone();
        let mut intent = Some(intent);
        let mut reads = 0;
        let snapshot = store
            .observe_snapshot(&mut || {
                reads += 1;
                if let Some(intent) = intent.take() {
                    intent.withdraw(&candidate).unwrap();
                    return store
                        .read_record::<Receipt>(&store.path(&receipt.session, false))
                        .map(|r| (vec![r], vec![]));
                }
                store.snapshot_once()
            })
            .unwrap();
        assert_eq!(reads, 2);
        assert!(snapshot.0.is_empty());
        let mut reads = 0;
        let error = store
            .observe_snapshot(&mut || {
                reads += 1;
                Err(changed())
            })
            .unwrap_err();
        assert_eq!(reads, 3);
        assert_eq!(error.code, "session_store_changed");
        let error = store.observe_snapshot(&mut || Err(refused())).unwrap_err();
        assert_eq!(error.code, "session_receipt_refused");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_reconciliation_can_clear_a_proven_exit_without_container_removal() {
        let (root, candidate, binding) = fixture();
        admit(&candidate, binding)
            .unwrap()
            .record_exec(&candidate, &"e".repeat(64))
            .unwrap();
        assert_eq!(
            reconcile(&candidate, &|receipt| {
                assert!(receipt.exec.is_some());
                Ok(RetirementProof::ExecExitedValidated)
            })
            .unwrap(),
            1
        );
        assert!(retained(&candidate).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_or_foreign_evidence_refuses_without_deletion() {
        let (root, candidate, binding) = fixture();
        let intent = admit(&candidate, binding.clone()).unwrap();
        let path = candidate
            .state_root
            .join("run/exec-sessions")
            .join(format!("{}.intent.json", intent.receipt.session));
        fs::write(&path, b"{").unwrap();
        assert_eq!(
            admit(&candidate, binding).err().unwrap().code,
            "session_receipt_refused"
        );
        assert!(reconcile(&candidate, &|_| Ok(RetirementProof::BootStopped)).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn observation_alone_does_not_create_state() {
        let (root, candidate, _) = fixture();
        assert!(retained(&candidate).unwrap().is_empty());
        assert_eq!(
            reconcile(&candidate, &|_| panic!("no receipts")).unwrap(),
            0
        );
        assert!(!candidate.state_root.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn known_undispatched_admission_can_withdraw_its_own_intent() {
        let (root, candidate, binding) = fixture();
        let first = admit(&candidate, binding.clone()).unwrap();
        let second = admit(&candidate, binding).unwrap();
        let retained_id = second.receipt().session.clone();
        first.withdraw(&candidate).unwrap();
        let receipts = retained(&candidate).unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].session, retained_id);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn full_home_names_capacity_without_discarding_existing_sessions() {
        let (root, candidate, binding) = fixture();
        let store = Store::open(&candidate, true).unwrap().unwrap();
        for index in 0..LIMIT {
            store
                .write(&Receipt {
                    version: 1,
                    session: format!("00000000-0000-4000-8000-{index:012x}"),
                    binding: binding.clone(),
                    exec: None,
                })
                .unwrap();
        }
        drop(store);
        let error = admit(&candidate, binding).err().unwrap();
        assert_eq!(error.code, "session_receipt_limit");
        assert!(error.message.to_string().contains("hack down"));
        assert_eq!(retained(&candidate).unwrap().len(), LIMIT);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unpublished_writes_are_observed_without_mutation_and_pruned_before_admission() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let (root, candidate, binding) = fixture();
        let intent = admit(&candidate, binding.clone()).unwrap();
        let store = Store::open(&candidate, false).unwrap().unwrap();
        let path = store
            .path(&intent.receipt.session, true)
            .with_extension("pending");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(b"{torn").unwrap();
        file.sync_all().unwrap();
        drop(store);
        assert_eq!(retained(&candidate).unwrap(), vec![intent.receipt.clone()]);
        assert_eq!(fs::read(&path).unwrap(), b"{torn");
        admit(&candidate, binding).unwrap();
        assert!(!path.exists());
        assert_eq!(retained(&candidate).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stopped_boot_proof_survives_owner_replacement_and_is_exact() {
        let (root, candidate, binding) = fixture();
        admit(&candidate, binding.clone())
            .unwrap()
            .record_exec(&candidate, &"e".repeat(64))
            .unwrap();
        let mut later = binding.clone();
        later.boot = "00000000-0000-4000-8000-000000000002".into();
        admit(&candidate, later.clone()).unwrap();
        let mut foreign = binding.clone();
        foreign.owner = "f".repeat(32);
        admit(&candidate, foreign).unwrap();
        let store = Store::open(&candidate, false).unwrap().unwrap();
        let proof = StoppedBoot {
            owner: binding.owner,
            boot: binding.boot,
        };
        let path = store.root.join(proof.name().unwrap());
        state::write_before_rename(&path, &proof, &|| store.check()).unwrap();
        drop(store); // Crash after proof publication, before receipt retirement.
        assert_eq!(
            reconcile(&candidate, &|_| Ok(RetirementProof::Unknown)).unwrap(),
            1
        );
        let remaining = retained(&candidate).unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|r| r.binding == later));
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn observation_releases_lock_and_revalidates_before_retirement() {
        let (root, candidate, binding) = fixture();
        let intent = std::cell::RefCell::new(Some(admit(&candidate, binding).unwrap()));
        assert_eq!(
            reconcile(&candidate, &|_| {
                intent
                    .borrow_mut()
                    .take()
                    .unwrap()
                    .record_exec(&candidate, &"e".repeat(64))
                    .unwrap();
                Ok(RetirementProof::ContainerAbsent)
            })
            .unwrap(),
            0
        );
        assert!(retained(&candidate).unwrap()[0].exec.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
