//! Durable intent and single-use effect admission. Callers must hold the actual VM
//! mutation lease, derive complete targets/effect identity and verify real outcomes.
//! Owner-death fallback is deliberately absent; file cleanup is not retirement proof.
use super::{
    Context, GraphScope, RetireRequest, SelectionRequest, Target, publication::PinnedEndpoint,
};
use crate::{
    CandidateError,
    provider::{
        identity::{self, ProcessIdentity},
        state,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const LIMIT: usize = 128 * 1024;
fn refused() -> CandidateError {
    CandidateError::new(
        "relay_lifecycle_uncertain",
        "Relay lifecycle intent is incomplete, changed or uncertain; no effect was replayed.",
    )
}
fn nonce() -> Result<[u8; 16], CandidateError> {
    let mut bytes = [0; 16];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| refused())?;
    if bytes == [0; 16] {
        return Err(refused());
    }
    Ok(bytes)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Intent,
    EffectStarted,
    Confirmed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    parent: (u64, u64),
    runtime: [u8; 16],
    boot: [u8; 16],
    owner: [u8; 16],
    process: ProcessIdentity,
    publication: [u8; 32],
    operation: [u8; 16],
    effect: [u8; 32],
    targets: Vec<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<[u8; 32]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selected: Option<[u8; 16]>,
    phase: Phase,
    attempt: Option<[u8; 16]>,
    observation: Option<[u8; 32]>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    ack_required: bool,
}
impl Record {
    fn validate(&self, parent: (u64, u64)) -> Result<(), CandidateError> {
        if ![1, 2].contains(&self.version)
            || self.owner == [0; 16]
            || self.operation == [0; 16]
            || self.parent != parent
            || self.runtime == [0; 16]
            || self.boot == [0; 16]
            || self.publication == [0; 32]
            || self.effect == [0; 32]
            || (self.ack_required && self.graph.is_none())
        {
            return Err(refused());
        }
        match (self.version, self.graph, self.selected) {
            (1, None, None) => {
                self.request(self.operation).encode()?;
            }
            (2, Some(graph), selected) if graph != [0; 32] => {
                if selected == Some([0; 16])
                    || (selected.is_none()
                        && (!self.targets.is_empty() || self.phase != Phase::Intent))
                {
                    return Err(refused());
                }
                if !self.targets.is_empty() {
                    self.request(self.operation).encode()?;
                }
            }
            _ => return Err(refused()),
        }
        if !self.process.executable.is_absolute() {
            return Err(refused());
        }
        // SAFETY: geteuid has no pointer arguments. Shape is not a death proof.
        identity::verify(
            &self.process,
            &self.process,
            &self.process.executable,
            unsafe { libc::geteuid() },
        )
        .map_err(|_| refused())?;
        let valid = match self.phase {
            Phase::Intent => self.attempt.is_none() && self.observation.is_none(),
            Phase::EffectStarted => {
                self.attempt.is_some_and(|n| n != [0; 16]) && self.observation.is_none()
            }
            Phase::Confirmed => {
                self.attempt.is_some_and(|n| n != [0; 16])
                    && self.observation.is_some_and(|n| n != [0; 32])
            }
        };
        if !valid {
            return Err(refused());
        }
        Ok(())
    }
    fn request(&self, operation: [u8; 16]) -> RetireRequest {
        RetireRequest {
            version: 1,
            owner: self.owner,
            operation,
            targets: self.targets.clone(),
        }
    }
}
struct Snapshot {
    record: Record,
    bytes: Vec<u8>,
    identity: (u64, u64),
}
struct Store {
    directory: PathBuf,
    parent: (u64, u64),
    _lock: state::Lock,
}
impl Store {
    fn open(root: &Path) -> Result<Self, CandidateError> {
        state::check_private_directory(root).map_err(|_| refused())?;
        let directory = root.join("relay-lifecycle");
        let lock = state::Lock::acquire(&directory).map_err(|_| refused())?;
        Self::with_lock(directory, lock)
    }
    fn existing(root: &Path) -> Result<Self, CandidateError> {
        state::check_private_directory(root).map_err(|_| refused())?;
        let directory = root.join("relay-lifecycle");
        let lock = state::Lock::acquire_existing(&directory).map_err(|_| refused())?;
        Self::with_lock(directory, lock)
    }
    fn with_lock(directory: PathBuf, lock: state::Lock) -> Result<Self, CandidateError> {
        let m = fs::metadata(&directory).map_err(|_| refused())?;
        let store = Self {
            directory,
            parent: (m.dev(), m.ino()),
            _lock: lock,
        };
        store.verify_parent()?;
        Ok(store)
    }
    fn verify_parent(&self) -> Result<(), CandidateError> {
        state::check_private_directory(&self.directory).map_err(|_| refused())?;
        let m = fs::metadata(&self.directory).map_err(|_| refused())?;
        if (m.dev(), m.ino()) != self.parent {
            return Err(refused());
        }
        match fs::symlink_metadata(self.directory.join("state.pending")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(refused()),
        }
    }
    fn read(&self) -> Result<Option<Snapshot>, CandidateError> {
        self.verify_parent()?;
        let path = self.directory.join("state.json");
        let mut file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !path.is_symlink() => {
                return Ok(None);
            }
            Err(_) => return Err(refused()),
        };
        let m = file.metadata().map_err(|_| refused())?;
        // SAFETY: geteuid has no pointer arguments.
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o077 != 0
            || m.len() > LIMIT as u64
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() > LIMIT {
            return Err(refused());
        }
        let current = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if (m.dev(), m.ino()) != (current.dev(), current.ino()) {
            return Err(refused());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        record.validate(self.parent)?;
        Ok(Some(Snapshot {
            record,
            bytes,
            identity: (m.dev(), m.ino()),
        }))
    }
    fn verify(&self, expected: &Snapshot) -> Result<(), CandidateError> {
        let current = self.read()?.ok_or_else(refused)?;
        if current.identity != expected.identity || current.bytes != expected.bytes {
            return Err(refused());
        }
        Ok(())
    }
    fn write(&self, record: Record) -> Result<Snapshot, CandidateError> {
        self.verify_parent()?;
        record.validate(self.parent)?;
        let bytes = serde_json::to_vec(&record).map_err(|_| refused())?;
        if bytes.len() > LIMIT {
            return Err(refused());
        }
        let pending = self.directory.join("state.pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pending)
            .map_err(|_| refused())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| refused())?;
        fs::rename(&pending, self.directory.join("state.json")).map_err(|_| refused())?;
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())?;
        let snapshot = self.read()?.ok_or_else(refused)?;
        if snapshot.bytes != bytes {
            return Err(refused());
        }
        Ok(snapshot)
    }
}
pub(super) struct Registration {
    _store: Store,
}
pub(super) fn registration(root: &Path) -> Result<Registration, CandidateError> {
    let store = Store::open(root)?;
    if store
        .read()?
        .is_some_and(|s| s.record.phase != Phase::Confirmed)
    {
        return Err(refused());
    }
    Ok(Registration { _store: store })
}
pub(super) fn bind_owner(root: &Path, has_grants: bool) -> Result<(), CandidateError> {
    let store = Store::open(root)?;
    if has_grants
        && store
            .read()?
            .is_some_and(|s| s.record.phase != Phase::Confirmed)
    {
        return Err(refused());
    }
    // Even an empty restarted owner must refuse malformed/interrupted intent.
    store.read()?;
    Ok(())
}

pub struct Mutation {
    pub effect: [u8; 32],
    pub targets: Vec<Target>,
}
pub struct Selection {
    pub context: Context,
    pub operation: [u8; 16],
    pub effect: [u8; 32],
}
/// Validated non-secret recovery selection. Inspection does not retire capabilities
/// or authorize an effect; resume rechecks selection under its own lock.
pub struct Inspection {
    pub selection: Selection,
    pub phase: Phase,
    pub targets: Vec<Target>,
    pub graph: Option<GraphScope>,
    pub selection_observed: bool,
    pub acknowledgement_pending: bool,
}
impl Inspection {
    /// Requires an existing journal and lock; never initializes absent runtime state.
    /// Refuses concurrent writers and incomplete writes instead of returning old state.
    pub fn load(root: &Path, context: Context) -> Result<Self, CandidateError> {
        let store = Store::existing(root)?;
        let snapshot = store.read()?.ok_or_else(refused)?;
        let record = &snapshot.record;
        if record.runtime != context.runtime || record.boot != context.boot {
            return Err(refused());
        }
        Ok(Self {
            selection: Selection {
                context,
                operation: record.operation,
                effect: record.effect,
            },
            phase: record.phase,
            targets: record.targets.clone(),
            graph: record
                .graph
                .map(|id| GraphScope::new(context, id))
                .transpose()?,
            selection_observed: record.selected.is_some(),
            acknowledgement_pending: record.ack_required,
        })
    }
}
struct FreshRetirement {
    endpoint: PinnedEndpoint,
    attempt: [u8; 16],
}
/// One bounded current record, one coordinator lock and non-serializable live proof.
/// Recovery of EffectStarted can observe/confirm but cannot invoke the effect again.
pub struct Coordinator {
    store: Store,
    snapshot: Snapshot,
    retired: Option<FreshRetirement>,
}
impl Coordinator {
    pub fn begin(endpoint: &PinnedEndpoint, mutation: Mutation) -> Result<Self, CandidateError> {
        Self::begin_selected(endpoint, mutation, None, None, false, |_| Ok(()))
    }
    /// Persist graph intent before querying; callers must hold the runtime mutation lease.
    pub fn begin_graph(
        endpoint: &PinnedEndpoint,
        graph: GraphScope,
        effect: [u8; 32],
    ) -> Result<Self, CandidateError> {
        let context = endpoint.context();
        if context.runtime != graph.context.runtime || context.boot != graph.context.boot {
            return Err(refused());
        }
        Self::begin_selected(
            endpoint,
            Mutation {
                effect,
                targets: Vec::new(),
            },
            Some(graph.id),
            None,
            false,
            |_| Ok(()),
        )
    }
    /// Persist graph enrollment while holding the coordinator lock, before publishing
    /// Intent. The callback must durably record the supplied selection under the VM
    /// lease. Its failure leaves the prior coordinator record unchanged. After effect
    /// confirmation, caller metadata must be confirmed before acknowledge permits rollover.
    pub fn begin_graph_enrolled(
        endpoint: &PinnedEndpoint,
        graph: GraphScope,
        effect: [u8; 32],
        operation: Option<[u8; 16]>,
        persist: impl FnOnce(Selection) -> Result<(), CandidateError>,
    ) -> Result<Self, CandidateError> {
        let context = endpoint.context();
        if context.runtime != graph.context.runtime || context.boot != graph.context.boot {
            return Err(refused());
        }
        Self::begin_selected(
            endpoint,
            Mutation {
                effect,
                targets: Vec::new(),
            },
            Some(graph.id),
            operation,
            true,
            persist,
        )
    }
    fn begin_selected(
        endpoint: &PinnedEndpoint,
        mut mutation: Mutation,
        graph: Option<[u8; 32]>,
        operation: Option<[u8; 16]>,
        ack_required: bool,
        persist: impl FnOnce(Selection) -> Result<(), CandidateError>,
    ) -> Result<Self, CandidateError> {
        let store = Store::open(endpoint.runtime_root())?;
        endpoint.verify_current()?;
        let previous = store.read()?;
        if previous.as_ref().is_some_and(|s| {
            s.record.phase != Phase::Confirmed
                || s.record.ack_required
                || operation == Some(s.record.operation)
        }) {
            return Err(refused());
        }
        mutation.targets.sort_unstable_by_key(|t| t.service);
        let context = endpoint.context();
        let record = Record {
            version: if graph.is_some() { 2 } else { 1 },
            parent: store.parent,
            runtime: context.runtime,
            boot: context.boot,
            owner: endpoint.incarnation(),
            process: endpoint.process().clone(),
            publication: endpoint.fingerprint(),
            operation: match operation {
                Some(value) => value,
                None => nonce()?,
            },
            effect: mutation.effect,
            targets: mutation.targets,
            graph,
            selected: None,
            phase: Phase::Intent,
            attempt: None,
            observation: None,
            ack_required,
        };
        record.validate(store.parent)?;
        persist(Selection {
            context,
            operation: record.operation,
            effect: record.effect,
        })?;
        endpoint.verify_current()?;
        match previous {
            Some(ref snapshot) => store.verify(snapshot)?,
            None if store.read()?.is_some() => return Err(refused()),
            None => {}
        }
        let snapshot = store.write(record)?;
        Ok(Self {
            store,
            snapshot,
            retired: None,
        })
    }
    pub fn resume(root: &Path, selection: Selection) -> Result<Self, CandidateError> {
        let store = Store::open(root)?;
        let snapshot = store.read()?.ok_or_else(refused)?;
        let record = &snapshot.record;
        if record.runtime != selection.context.runtime
            || record.boot != selection.context.boot
            || record.operation != selection.operation
            || record.effect != selection.effect
        {
            return Err(refused());
        }
        Ok(Self {
            store,
            snapshot,
            retired: None,
        })
    }
    pub fn operation(&self) -> [u8; 16] {
        self.snapshot.record.operation
    }
    pub fn phase(&self) -> Phase {
        self.snapshot.record.phase
    }
    pub fn acknowledgement_pending(&self) -> bool {
        self.snapshot.record.ack_required
    }
    /// Acknowledge durable caller confirmation before allowing the single coordinator
    /// record to roll over. This does not inspect caller metadata; the caller must
    /// hold the VM lease and first persist its matching confirmed enrollment marker.
    pub fn acknowledge(&mut self) -> Result<(), CandidateError> {
        self.store.verify(&self.snapshot)?;
        if self.phase() != Phase::Confirmed {
            return Err(refused());
        }
        if self.snapshot.record.ack_required {
            let mut record = self.snapshot.record.clone();
            record.ack_required = false;
            self.snapshot = self.store.write(record)?;
        }
        Ok(())
    }
    /// A fresh exchange is mandatory even after coordinator recovery. An old on-disk
    /// attempt identifier is audit data only. Failure discards any earlier live proof.
    pub fn retire(
        &mut self,
        endpoint: &PinnedEndpoint,
        budget: Duration,
    ) -> Result<(), CandidateError> {
        self.retired = None;
        if self.snapshot.record.graph.is_some()
            || budget.is_zero()
            || budget > Duration::from_secs(5)
        {
            return Err(refused());
        }
        self.retire_targets(endpoint, Instant::now() + budget)
    }
    fn retire_targets(
        &mut self,
        endpoint: &PinnedEndpoint,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        self.retired = None;
        self.store.verify(&self.snapshot)?;
        let record = &self.snapshot.record;
        if record.phase != Phase::Intent
            || endpoint.fingerprint() != record.publication
            || endpoint.incarnation() != record.owner
            || endpoint.process() != &record.process
        {
            return Err(refused());
        }
        let attempt = nonce()?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let mut client = endpoint.connect(record.request(attempt), remaining)?;
        loop {
            if client.progress()?.is_some() {
                break;
            }
            wait(client.interest().ok_or_else(refused)?, deadline)?;
        }
        self.store.verify(&self.snapshot)?;
        endpoint.verify_current()?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        self.retired = Some(FreshRetirement {
            endpoint: endpoint.clone(),
            attempt,
        });
        Ok(())
    }
    /// Obtain a fresh complete graph selection, then retire it or prove it empty.
    /// One total deadline covers both exchanges. Persisted selection is audit data;
    /// recovery reselects and never reconstructs live authority from it.
    pub fn prepare_graph(
        &mut self,
        endpoint: &PinnedEndpoint,
        budget: Duration,
    ) -> Result<(), CandidateError> {
        self.retired = None;
        self.store.verify(&self.snapshot)?;
        let record = &self.snapshot.record;
        if record.phase != Phase::Intent
            || endpoint.fingerprint() != record.publication
            || endpoint.incarnation() != record.owner
            || endpoint.process() != &record.process
            || budget.is_zero()
            || budget > Duration::from_secs(5)
        {
            return Err(refused());
        }
        let scope = GraphScope::new(
            Context {
                runtime: record.runtime,
                boot: record.boot,
            },
            record.graph.ok_or_else(refused)?,
        )?;
        let attempt = nonce()?;
        let deadline = Instant::now() + budget;
        let request = SelectionRequest::new(record.owner, attempt, scope)?;
        let mut client = endpoint.select(request, budget)?;
        let selected = loop {
            if let Some(selected) = client.progress()? {
                break selected;
            }
            wait(client.interest().ok_or_else(refused)?, deadline)?;
        };
        self.store.verify(&self.snapshot)?;
        endpoint.verify_current()?;
        let mut targets = selected.targets().to_vec();
        targets.sort_unstable_by_key(|target| target.service);
        if self.snapshot.record.selected.is_some() && self.snapshot.record.targets != targets {
            return Err(refused());
        }
        if self.snapshot.record.selected.is_none() {
            let mut record = self.snapshot.record.clone();
            record.targets = targets;
            record.selected = Some(attempt);
            self.snapshot = self.store.write(record)?;
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        if remaining.is_zero() {
            return Err(refused());
        }
        if self.snapshot.record.targets.is_empty() {
            self.retired = Some(FreshRetirement {
                endpoint: endpoint.clone(),
                attempt,
            });
            Ok(())
        } else {
            self.retire_targets(endpoint, deadline)
        }
    }
    /// Persist EffectStarted before invoking exactly one caller effect. Errors or
    /// panics leave uncertainty durable; a recovered coordinator cannot replay it.
    pub fn execute<T>(
        &mut self,
        effect: [u8; 32],
        run: impl FnOnce() -> Result<T, CandidateError>,
    ) -> Result<T, CandidateError> {
        let proof = self.retired.take().ok_or_else(refused)?;
        self.store.verify(&self.snapshot)?;
        if self.phase() != Phase::Intent || effect != self.snapshot.record.effect {
            return Err(refused());
        }
        proof.endpoint.verify_current()?;
        let mut record = self.snapshot.record.clone();
        record.phase = Phase::EffectStarted;
        record.attempt = Some(proof.attempt);
        self.snapshot = self.store.write(record)?;
        run()
    }
    /// The inspector must observe the actual effect under the runtime mutation lease
    /// and return a nonzero digest of that evidence. This method does not perform the
    /// graph/VM inspection itself and never runs the original mutation on recovery.
    pub fn confirm(
        &mut self,
        effect: [u8; 32],
        inspect: impl FnOnce() -> Result<[u8; 32], CandidateError>,
    ) -> Result<(), CandidateError> {
        self.store.verify(&self.snapshot)?;
        if self.phase() != Phase::EffectStarted || effect != self.snapshot.record.effect {
            return Err(refused());
        }
        let observation = inspect()?;
        if observation == [0; 32] {
            return Err(refused());
        }
        self.store.verify(&self.snapshot)?;
        let mut record = self.snapshot.record.clone();
        record.phase = Phase::Confirmed;
        record.observation = Some(observation);
        self.snapshot = self.store.write(record)?;
        Ok(())
    }
}

fn wait(
    (fd, events): (std::os::fd::BorrowedFd<'_>, i16),
    deadline: Instant,
) -> Result<(), CandidateError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(refused)?;
    let mut interest = libc::pollfd {
        fd: fd.as_raw_fd(),
        events,
        revents: 0,
    };
    // SAFETY: one initialized poll record borrows a live stream. No pointer is retained;
    // the wait remains bounded by the exchange's original monotonic deadline.
    let result = unsafe {
        libc::poll(
            &mut interest,
            1,
            remaining
                .as_nanos()
                .div_ceil(1_000_000)
                .min(i32::MAX as u128) as i32,
        )
    };
    if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
