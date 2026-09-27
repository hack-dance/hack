//! Foreground owner reactor. Its publication identifies this process, not thread
//! liveness; callers must retain this handle and check it before releasing apps.
use super::{
    Acknowledgement, Context, Grant, GraphScope, OwnerLimits, RelayOwner, RetireRequest, Target,
    publication::{ControlListener, PinnedEndpoint},
    refused,
};
use crate::{
    CandidateError,
    provider::{host_endpoint::HostEndpoint, relay_loop::Limits, state},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    os::{
        fd::{AsFd, BorrowedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const BUDGET: Duration = Duration::from_secs(5);
type Reply<T> = SyncSender<Result<T, CandidateError>>;
enum Command {
    Register(
        GraphScope,
        [u8; 32],
        u8,
        HostEndpoint,
        Arc<AtomicBool>,
        Reply<Grant>,
    ),
    Retire(Target, Reply<Acknowledgement>),
    RetireBindings(GraphScope, Vec<[u8; 32]>, Reply<Acknowledgement>),
    BeginRebind(
        GraphScope,
        u8,
        [u8; 32],
        Arc<AtomicBool>,
        Reply<FenceIdentity>,
    ),
    Replace(
        SlotFence,
        [u8; 32],
        HostEndpoint,
        Arc<AtomicBool>,
        Reply<Grant>,
    ),
    Complete(Vec<SlotFence>, Arc<AtomicBool>, Reply<()>),
    Abort(SlotFence, Reply<()>),
    Check(Reply<()>),
}

#[derive(Clone, PartialEq, Eq)]
struct FenceIdentity {
    owner: [u8; 16],
    scope: GraphScope,
    slot: u8,
    operation: [u8; 16],
}
struct FenceToken {
    identity: FenceIdentity,
    canceled: Arc<AtomicBool>,
    wake: Arc<UnixStream>,
}
impl Drop for FenceToken {
    fn drop(&mut self) {
        self.canceled.store(true, Ordering::Release);
        wake(&self.wake);
    }
}
/// Opaque owner-local replacement fence. Dropping the last clone cancels a pending
/// replacement; completed replacements remain live until an explicit abort or a
/// newer operation. This token carries no credentials and cannot be deserialized.
#[derive(Clone)]
pub(crate) struct SlotFence(Arc<FenceToken>);
#[derive(Clone, Copy, PartialEq, Eq)]
enum RebindPhase {
    Pending,
    Complete,
    Aborted,
}
struct Rebind {
    identity: FenceIdentity,
    canceled: Arc<AtomicBool>,
    old_generation: [u8; 32],
    expected_count: usize,
    phase: RebindPhase,
    completed_targets: Vec<Target>,
    completion_cancel: Option<Arc<AtomicBool>>,
}

/// Coalesced authenticated endpoint failure, scoped to the currently registered
/// generation. Stale callbacks cannot dirty a later replacement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DirtySlot {
    pub(crate) slot: u8,
    pub(crate) generation: [u8; 32],
}
#[derive(Default)]
struct DirtyState {
    generations: [Option<[u8; 32]>; 32],
    pending: BTreeMap<u8, [u8; 32]>,
}
struct Notifications {
    state: Mutex<DirtyState>,
    wake: UnixStream,
}
impl Notifications {
    fn select(&self, slot: u8, generation: Option<[u8; 32]>) -> Result<(), CandidateError> {
        let mut state = self.state.lock().map_err(|_| refused())?;
        if state.generations[usize::from(slot)] != generation {
            state.pending.remove(&slot);
            state.generations[usize::from(slot)] = generation;
        }
        Ok(())
    }
    fn notify(&self, slot: u8, generation: [u8; 32]) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generations[usize::from(slot)] != Some(generation)
            || state.pending.insert(slot, generation).is_some()
        {
            return;
        }
        wake(&self.wake);
    }
    fn endpoint(
        self: &Arc<Self>,
        slot: u8,
        generation: [u8; 32],
        endpoint: HostEndpoint,
    ) -> HostEndpoint {
        let notifications = Arc::clone(self);
        endpoint
            .with_identity_notification(Arc::new(move || notifications.notify(slot, generation)))
    }
}
/// Paths selected under the Engine lease; canonical_parent is the verified VM home.
pub(crate) struct ManagedSlot {
    pub(crate) slot: u8,
    pub(crate) path: PathBuf,
    pub(crate) canonical_parent: PathBuf,
}
#[derive(PartialEq, Eq)]
struct Provenance {
    parent: (u64, u64),
    alias: (u64, u64, u32, u32),
    target: Option<PathBuf>,
}
fn provenance(path: &Path, canonical: &Path) -> Result<Provenance, CandidateError> {
    state::check_private_directory(canonical).map_err(|_| refused())?;
    let parent = path.parent().ok_or_else(refused)?;
    if !canonical.is_absolute() || fs::canonicalize(parent).map_err(|_| refused())? != canonical {
        return Err(refused());
    }
    let real = fs::symlink_metadata(canonical).map_err(|_| refused())?;
    let alias = fs::symlink_metadata(parent).map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or effects.
    if !real.is_dir()
        || alias.uid() != unsafe { libc::geteuid() }
        || (!alias.is_dir() && !alias.file_type().is_symlink())
    {
        return Err(refused());
    }
    let target = if alias.file_type().is_symlink() {
        Some(fs::read_link(parent).map_err(|_| refused())?)
    } else {
        None
    };
    Ok(Provenance {
        parent: (real.dev(), real.ino()),
        alias: (alias.dev(), alias.ino(), alias.uid(), alias.mode()),
        target,
    })
}
struct Slot {
    number: u8,
    path: PathBuf,
    id: (u64, u64),
    canonical_parent: PathBuf,
    provenance: Provenance,
    listener: UnixListener,
    targets: Vec<(Target, Arc<AtomicBool>)>,
    endpoint_generation: Option<[u8; 32]>,
    rebind: Option<Rebind>,
}
impl Slot {
    fn bind(input: ManagedSlot) -> Result<Self, CandidateError> {
        let ManagedSlot {
            slot: number,
            path,
            canonical_parent,
        } = input;
        let original = provenance(&path, &canonical_parent)?;
        if !path.is_absolute() || number >= 32 {
            return Err(refused());
        }
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
        let listener = UnixListener::bind(&path).map_err(|_| refused())?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        let slot = Self {
            number,
            path,
            id: (metadata.dev(), metadata.ino()),
            listener,
            canonical_parent,
            provenance: original,
            targets: Vec::new(),
            endpoint_generation: None,
            rebind: None,
        };
        if provenance(&slot.path, &slot.canonical_parent)? != slot.provenance {
            return Err(refused());
        }
        fs::set_permissions(&slot.path, fs::Permissions::from_mode(0o600))
            .map_err(|_| refused())?;
        slot.listener.set_nonblocking(true).map_err(|_| refused())?;
        slot.verify()?;
        Ok(slot)
    }
    fn verify(&self) -> Result<(), CandidateError> {
        if provenance(&self.path, &self.canonical_parent)? != self.provenance {
            return Err(refused());
        }
        let m = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        // SAFETY: geteuid has no pointer arguments or effects.
        if !m.file_type().is_socket()
            || (m.dev(), m.ino()) != self.id
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o7777 != 0o600
        {
            return Err(refused());
        }
        Ok(())
    }
    fn accepts(&self) -> bool {
        self.rebind
            .as_ref()
            .is_none_or(|state| state.phase == RebindPhase::Complete)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        if self.verify().is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}
struct Preamble {
    stream: UnixStream,
    slot: u8,
    deadline: Instant,
    bytes: [u8; crate::provider::relay_auth::CLIENT_HELLO_BYTES],
    used: usize,
}
impl Preamble {
    fn progress(&mut self, readable: bool) -> Result<(), CandidateError> {
        if Instant::now() >= self.deadline {
            return Err(refused());
        }
        if readable {
            match self.stream.read(&mut self.bytes[self.used..]) {
                Ok(0) => return Err(refused()),
                Ok(n) => self.used += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(refused()),
            }
        }
        Ok(())
    }
}
struct Reactor {
    // Declaration order is intentional: revoke and close flows before discovery.
    owner: RelayOwner,
    control: ControlListener,
    slots: Vec<Slot>,
    preambles: Vec<Preamble>,
    wake: UnixStream,
    commands: Receiver<Command>,
    stop: Arc<AtomicBool>,
    notifications: Arc<Notifications>,
}
fn retire(owner: &mut RelayOwner, target: Target) -> Result<Acknowledgement, CandidateError> {
    retire_targets(owner, vec![target])
}
fn retire_targets(
    owner: &mut RelayOwner,
    targets: Vec<Target>,
) -> Result<Acknowledgement, CandidateError> {
    let mut operation = [0; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut operation))
        .map_err(|_| refused())?;
    owner.retire(&RetireRequest {
        version: 1,
        owner: owner.incarnation(),
        operation,
        targets,
    })
}
impl Reactor {
    fn retire_bindings(
        &mut self,
        scope: GraphScope,
        services: Vec<[u8; 32]>,
    ) -> Result<Acknowledgement, CandidateError> {
        if !self.owner.matches_context(scope.context)
            || services.is_empty()
            || services.len() > crate::provider::relay_auth::MAX_LOGICAL_BINDINGS
            || services.iter().collect::<BTreeSet<_>>().len() != services.len()
        {
            return Err(refused());
        }
        let targets = services
            .into_iter()
            .map(|service| {
                self.owner
                    .entries
                    .get(&service)
                    .filter(|entry| entry.graph == Some(scope.id))
                    .map(|entry| entry.target.clone())
                    .ok_or_else(refused)
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Validate the complete scoped batch before synchronous revocation. Retain
        // retired registrations for cleanup acknowledgements; never re-arm them.
        retire_targets(&mut self.owner, targets)
    }
    fn begin_rebind(
        &mut self,
        scope: GraphScope,
        number: u8,
        expected: [u8; 32],
        canceled: Arc<AtomicBool>,
    ) -> Result<FenceIdentity, CandidateError> {
        if canceled.load(Ordering::Acquire) || expected == [0; 32] {
            return Err(refused());
        }
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| slot.number == number)
            .ok_or_else(refused)?;
        slot.verify()?;
        let retry_count = match &slot.rebind {
            Some(previous)
                if previous.phase == RebindPhase::Aborted
                    && previous.identity.scope == scope
                    && previous.old_generation == expected =>
            {
                Some(previous.expected_count)
            }
            Some(previous) if previous.phase != RebindPhase::Complete => return Err(refused()),
            _ => None,
        };
        if retry_count.is_none() && slot.endpoint_generation != Some(expected) {
            return Err(refused());
        }
        let mut operation = [0; 16];
        fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut operation))
            .map_err(|_| refused())?;
        let targets: Vec<_> = slot
            .targets
            .iter()
            .map(|(target, _)| target.clone())
            .collect();
        if retry_count.is_none()
            && !targets.iter().any(|target| {
                self.owner
                    .entries
                    .get(&target.service)
                    .is_some_and(|entry| !entry.retired)
            })
        {
            return Err(refused());
        }
        let active = self.owner.retire_replacement(scope, operation, &targets)?;
        let expected_count = retry_count.unwrap_or(active);
        if expected_count == 0 {
            return Err(refused());
        }
        let identity = FenceIdentity {
            owner: self.owner.incarnation(),
            scope,
            slot: number,
            operation,
        };
        slot.targets.clear();
        slot.endpoint_generation = None;
        slot.rebind = Some(Rebind {
            identity: identity.clone(),
            canceled,
            old_generation: expected,
            expected_count,
            phase: RebindPhase::Pending,
            completed_targets: Vec::new(),
            completion_cancel: None,
        });
        self.preambles.retain(|pending| pending.slot != number);
        self.notifications.select(number, None)?;
        Ok(identity)
    }

    fn replacement(
        &mut self,
        fence: &SlotFence,
        service: [u8; 32],
        endpoint: HostEndpoint,
        canceled: Arc<AtomicBool>,
    ) -> Result<Grant, CandidateError> {
        let identity = &fence.0.identity;
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| slot.number == identity.slot)
            .ok_or_else(refused)?;
        slot.verify()?;
        let state = slot.rebind.as_ref().ok_or_else(refused)?;
        if identity.owner != self.owner.incarnation()
            || state.identity != *identity
            || state.phase != RebindPhase::Pending
            || state.canceled.load(Ordering::Acquire)
            || canceled.load(Ordering::Acquire)
            || slot.targets.len() >= state.expected_count
        {
            return Err(refused());
        }
        let generation = endpoint.generation()?;
        if generation == state.old_generation
            || slot
                .endpoint_generation
                .is_some_and(|selected| selected != generation)
        {
            return Err(refused());
        }
        let endpoint = self
            .notifications
            .endpoint(identity.slot, generation, endpoint);
        let grant = self
            .owner
            .register_graph(identity.scope, service, endpoint)?;
        slot.endpoint_generation = Some(generation);
        slot.targets.push((grant.target.clone(), canceled));
        self.notifications.select(identity.slot, Some(generation))?;
        Ok(grant)
    }

    fn validate_completion(
        &self,
        fence: &SlotFence,
        canceled: &AtomicBool,
    ) -> Result<(usize, Vec<Target>), CandidateError> {
        let identity = &fence.0.identity;
        let index = self
            .slots
            .iter()
            .position(|slot| slot.number == identity.slot)
            .ok_or_else(refused)?;
        let slot = &self.slots[index];
        slot.verify()?;
        let state = slot.rebind.as_ref().ok_or_else(refused)?;
        if identity.owner != self.owner.incarnation()
            || state.identity != *identity
            || state.phase == RebindPhase::Aborted
            || state.canceled.load(Ordering::Acquire)
            || canceled.load(Ordering::Acquire)
            || slot.targets.len() != state.expected_count
        {
            return Err(refused());
        }
        let generation = slot.endpoint_generation.ok_or_else(refused)?;
        for (target, canceled) in &slot.targets {
            let entry = self
                .owner
                .entries
                .get(&target.service)
                .ok_or_else(refused)?;
            if canceled.load(Ordering::Acquire)
                || entry.target != *target
                || entry.retired
                || entry.graph != Some(identity.scope.id)
                || entry.endpoint.generation()? != generation
            {
                return Err(refused());
            }
        }
        let targets = slot
            .targets
            .iter()
            .map(|(target, _)| target.clone())
            .collect();
        Ok((index, targets))
    }

    fn complete_rebinds(
        &mut self,
        fences: &[SlotFence],
        canceled: Arc<AtomicBool>,
    ) -> Result<(), CandidateError> {
        let scope = fences.first().ok_or_else(refused)?.0.identity.scope;
        if fences.len() > 32 {
            return Err(refused());
        }
        let _registration = self
            .owner
            .control_root
            .as_ref()
            .map(|root| super::lifecycle_intent::registration_for_replacement(root))
            .transpose()?;
        let mut slots = BTreeSet::new();
        let mut prepared = Vec::with_capacity(fences.len());
        for fence in fences {
            if fence.0.identity.scope != scope || !slots.insert(fence.0.identity.slot) {
                return Err(refused());
            }
            prepared.push(self.validate_completion(fence, &canceled)?);
        }
        // All lookups, native checks, allocation and lifecycle admission precede
        // the first phase change. The reactor cannot admit between these writes.
        if canceled.load(Ordering::Acquire) {
            return Err(refused());
        }
        for (index, targets) in prepared {
            let state = self.slots[index]
                .rebind
                .as_mut()
                .expect("validated slot fence");
            state.completed_targets = targets;
            state.phase = RebindPhase::Complete;
            state.completion_cancel = Some(Arc::clone(&canceled));
        }
        Ok(())
    }

    fn abort_rebind(&mut self, identity: &FenceIdentity) -> Result<(), CandidateError> {
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| slot.number == identity.slot)
            .ok_or_else(refused)?;
        let state = slot.rebind.as_mut().ok_or_else(refused)?;
        if identity.owner != self.owner.incarnation() || state.identity != *identity {
            return Err(refused());
        }
        let targets: Vec<_> = slot
            .targets
            .iter()
            .map(|(target, _)| target.clone())
            .collect();
        if state.phase == RebindPhase::Complete && targets != state.completed_targets {
            return Err(refused());
        }
        // Fence before any fallible retirement. An unresolved cleanup intent may
        // retain registration evidence, but cannot leave replacement admission open.
        state.phase = RebindPhase::Aborted;
        slot.endpoint_generation = None;
        self.preambles
            .retain(|pending| pending.slot != identity.slot);
        let notification = self.notifications.select(identity.slot, None);
        match self
            .owner
            .retire_replacement(identity.scope, identity.operation, &targets)
        {
            Ok(_) => {
                slot.targets.clear();
                notification
            }
            Err(error) => {
                if !targets.is_empty() {
                    self.owner.retire(&RetireRequest {
                        version: 1,
                        owner: identity.owner,
                        operation: identity.operation,
                        targets,
                    })?;
                }
                Err(error)
            }
        }
    }

    fn run(&mut self) -> Result<(), CandidateError> {
        while !self.stop.load(Ordering::Acquire) {
            for _ in 0..32 {
                let command = match self.commands.try_recv() {
                    Ok(c) => c,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                };
                match command {
                    Command::Register(scope, service, number, endpoint, canceled, reply) => {
                        let result = (|| {
                            if canceled.load(Ordering::Acquire) {
                                return Err(refused());
                            }
                            let slot = self
                                .slots
                                .iter_mut()
                                .find(|s| s.number == number)
                                .ok_or_else(refused)?;
                            slot.verify()?;
                            if !slot.accepts() {
                                return Err(refused());
                            }
                            let generation = endpoint.generation()?;
                            if slot
                                .endpoint_generation
                                .is_some_and(|old| old != generation)
                            {
                                return Err(refused());
                            }
                            let endpoint =
                                self.notifications.endpoint(number, generation, endpoint);
                            let grant = self.owner.register_graph(scope, service, endpoint)?;
                            slot.endpoint_generation = Some(generation);
                            slot.targets
                                .push((grant.target.clone(), Arc::clone(&canceled)));
                            self.notifications.select(number, Some(generation))?;
                            Ok(grant)
                        })();
                        if let Err(
                            mpsc::TrySendError::Disconnected(Ok(grant))
                            | mpsc::TrySendError::Full(Ok(grant)),
                        ) = reply.try_send(result)
                        {
                            retire(&mut self.owner, grant.target)?;
                        }
                    }
                    Command::Retire(target, reply) => {
                        let result = retire(&mut self.owner, target);
                        let _ = reply.try_send(result);
                    }
                    Command::RetireBindings(scope, services, reply) => {
                        let result = self.retire_bindings(scope, services);
                        let _ = reply.try_send(result);
                    }
                    Command::BeginRebind(scope, slot, expected, canceled, reply) => {
                        let result = self.begin_rebind(scope, slot, expected, canceled);
                        if let Err(
                            mpsc::TrySendError::Disconnected(Ok(identity))
                            | mpsc::TrySendError::Full(Ok(identity)),
                        ) = reply.try_send(result)
                        {
                            let _ = self.abort_rebind(&identity);
                        }
                    }
                    Command::Replace(fence, service, endpoint, canceled, reply) => {
                        let result = self.replacement(&fence, service, endpoint, canceled);
                        if let Err(
                            mpsc::TrySendError::Disconnected(Ok(_))
                            | mpsc::TrySendError::Full(Ok(_)),
                        ) = reply.try_send(result)
                        {
                            let _ = self.abort_rebind(&fence.0.identity);
                        }
                    }
                    Command::Complete(fences, canceled, reply) => {
                        let result = self.complete_rebinds(&fences, Arc::clone(&canceled));
                        let abandoned = matches!(
                            reply.try_send(result),
                            Err(mpsc::TrySendError::Disconnected(Ok(()))
                                | mpsc::TrySendError::Full(Ok(())))
                        );
                        if abandoned || canceled.load(Ordering::Acquire) {
                            for fence in &fences {
                                let _ = self.abort_rebind(&fence.0.identity);
                            }
                        }
                    }
                    Command::Abort(fence, reply) => {
                        let _ = reply.try_send(self.abort_rebind(&fence.0.identity));
                    }
                    Command::Check(reply) => {
                        let _ = reply.try_send(Ok(()));
                    }
                }
            }
            let abandoned: Vec<_> = self
                .slots
                .iter()
                .filter_map(|slot| slot.rebind.as_ref())
                .filter(|state| {
                    (state.phase == RebindPhase::Pending && state.canceled.load(Ordering::Acquire))
                        || (state.phase == RebindPhase::Complete
                            && state
                                .completion_cancel
                                .as_ref()
                                .is_some_and(|cancel| cancel.load(Ordering::Acquire)))
                })
                .map(|state| state.identity.clone())
                .collect();
            for identity in abandoned {
                let _ = self.abort_rebind(&identity);
            }
            for slot in &mut self.slots {
                for (target, canceled) in &slot.targets {
                    if canceled.swap(false, Ordering::AcqRel) {
                        retire(&mut self.owner, target.clone())?;
                    }
                }
            }
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            let control_enabled = self.owner.control_connections() < 32;
            let flow_enabled = self.owner.connections() + self.preambles.len() < 64;
            let mut fds = vec![self.wake.as_fd()];
            if control_enabled {
                fds.push(self.control.as_fd());
            }
            if flow_enabled {
                fds.extend(self.slots.iter().map(|s| s.listener.as_fd()));
            }
            let preamble_offset = fds.len();
            fds.extend(self.preambles.iter().map(|p| p.stream.as_fd()));
            let wait = self
                .preambles
                .iter()
                .map(|p| p.deadline.saturating_duration_since(Instant::now()))
                .min()
                .unwrap_or(Duration::from_secs(60));
            let ready = self.owner.tick_with_wakeups(wait, &fds)?;
            drop(fds);
            if ready[0] != 0 {
                let mut bytes = [0; 128];
                // Bound drain work. Remaining queued bytes keep the next poll readable.
                for _ in 0..8 {
                    match self.wake.read(&mut bytes) {
                        Ok(0) => return Ok(()),
                        Ok(_) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => return Err(refused()),
                    }
                }
            }
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            if control_enabled && ready[1] != 0 {
                let _ = self.control.accept(&mut self.owner, BUDGET);
            }
            for index in (0..self.preambles.len()).rev() {
                let p = &mut self.preambles[index];
                let failed = p.progress(ready[preamble_offset + index] != 0).is_err();
                if failed || p.used == p.bytes.len() {
                    let p = self.preambles.swap_remove(index);
                    if !failed {
                        let slot = self
                            .slots
                            .iter()
                            .find(|s| s.number == p.slot)
                            .ok_or_else(refused)?;
                        slot.verify()?;
                        let targets: Vec<_> = slot.targets.iter().map(|(t, _)| t.clone()).collect();
                        let _ = self
                            .owner
                            .admit_shared(&targets, p.stream, p.deadline, &p.bytes);
                    }
                }
            }
            let offset = 1 + usize::from(control_enabled);
            if flow_enabled {
                for (slot, flags) in self.slots.iter().zip(&ready[offset..]) {
                    if *flags == 0 || self.stop.load(Ordering::Acquire) {
                        continue;
                    }
                    slot.verify()?;
                    match slot.listener.accept() {
                        Ok((stream, _)) => {
                            if self.owner.connections() + self.preambles.len() < 64 {
                                stream.set_nonblocking(true).map_err(|_| refused())?;
                                if !slot.accepts() {
                                    continue;
                                }
                                self.preambles.push(Preamble {
                                    stream,
                                    slot: slot.number,
                                    deadline: Instant::now() + BUDGET,
                                    bytes: [0; crate::provider::relay_auth::CLIENT_HELLO_BYTES],
                                    used: 0,
                                });
                            }
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => return Err(refused()),
                    }
                }
            }
        }
        Ok(())
    }
}
/// Owned foreground reactor; dropping synchronously revokes all grants and joins.
/// This does not survive CLI exit or certify guest/process cleanup.
pub(crate) struct ManagedOwner {
    endpoint: PinnedEndpoint,
    commands: SyncSender<Command>,
    wake: Arc<UnixStream>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<(), CandidateError>>>,
    notification: UnixStream,
    notifications: Arc<Notifications>,
}
struct Pending {
    canceled: Arc<AtomicBool>,
    wake: Arc<UnixStream>,
    armed: bool,
}
fn wake(mut stream: &UnixStream) {
    loop {
        match stream.write(&[1]) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            _ => break, // EAGAIN already means the read side is awake; closed means exit.
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.armed {
            self.canceled.store(true, Ordering::Release);
            wake(&self.wake);
        }
    }
}
impl ManagedOwner {
    pub(crate) fn start(
        context: Context,
        control_root: &Path,
        slots: Vec<ManagedSlot>,
    ) -> Result<Self, CandidateError> {
        if slots.len() > 32 {
            return Err(refused());
        }
        let mut numbers = BTreeSet::new();
        let mut paths = BTreeSet::new();
        if slots
            .iter()
            .any(|slot| !numbers.insert(slot.slot) || !paths.insert(slot.path.clone()))
        {
            return Err(refused());
        }
        let slots = slots
            .into_iter()
            .map(Slot::bind)
            .collect::<Result<Vec<_>, _>>()?;
        let mut owner = RelayOwner::new(
            context,
            OwnerLimits {
                // Retain old grants for cleanup: 72 initial plus 72 restored fit.
                // Exhaustion refuses; this is not an unbounded restore history.
                registrations: 256,
                controls: 32,
                relay: Limits {
                    max_flows: 64,
                    connect_timeout: BUDGET,
                    idle_timeout: Duration::from_secs(30),
                },
            },
        )?;
        let control = ControlListener::bind(control_root, &mut owner)?;
        let endpoint = control.endpoint();
        let (read, write) = UnixStream::pair().map_err(|_| refused())?;
        read.set_nonblocking(true).map_err(|_| refused())?;
        write.set_nonblocking(true).map_err(|_| refused())?;
        let (commands, receiver) = mpsc::sync_channel(32);
        let stop = Arc::new(AtomicBool::new(false));
        let (notification, notification_write) = UnixStream::pair().map_err(|_| refused())?;
        notification.set_nonblocking(true).map_err(|_| refused())?;
        notification_write
            .set_nonblocking(true)
            .map_err(|_| refused())?;
        let notifications = Arc::new(Notifications {
            state: Mutex::new(DirtyState::default()),
            wake: notification_write,
        });
        let mut reactor = Reactor {
            owner,
            control,
            slots,
            preambles: Vec::new(),
            wake: read,
            commands: receiver,
            stop: Arc::clone(&stop),
            notifications: Arc::clone(&notifications),
        };
        let worker = thread::Builder::new()
            .name("hack-relay-owner".into())
            .spawn(move || reactor.run())
            .map_err(|_| refused())?;
        Ok(Self {
            endpoint,
            commands,
            wake: Arc::new(write),
            stop,
            worker: Some(worker),
            notification,
            notifications,
        })
    }
    pub(crate) fn endpoint(&self) -> PinnedEndpoint {
        self.endpoint.clone()
    }
    /// Borrowed read descriptor for foreground kqueue. No timer or process scan is
    /// needed; readiness is produced only by authenticated native identity failure.
    pub(crate) fn notification_fd(&self) -> BorrowedFd<'_> {
        self.notification.as_fd()
    }
    pub(crate) fn dirty_slots(&self) -> Result<Vec<DirtySlot>, CandidateError> {
        let mut stream = &self.notification;
        let mut bytes = [0; 128];
        for _ in 0..8 {
            match stream.read(&mut bytes) {
                Ok(0) => return Err(refused()),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(refused()),
            }
        }
        let mut state = self.notifications.state.lock().map_err(|_| refused())?;
        Ok(std::mem::take(&mut state.pending)
            .into_iter()
            .filter(|(slot, generation)| state.generations[usize::from(*slot)] == Some(*generation))
            .map(|(slot, generation)| DirtySlot { slot, generation })
            .collect())
    }
    /// Consume coalesced notices, never probe endpoints. Stale wake bytes alone do
    /// not count as current drift; old-generation callbacks are discarded.
    pub(crate) fn drain_notifications(&self) -> Result<bool, CandidateError> {
        self.dirty_slots().map(|slots| !slots.is_empty())
    }
    fn send(&self, command: Command) -> Result<(), CandidateError> {
        if self.stop.load(Ordering::Acquire) || self.worker.as_ref().is_none_or(|w| w.is_finished())
        {
            return Err(refused());
        }
        self.commands.try_send(command).map_err(|_| refused())?;
        wake(&self.wake);
        Ok(())
    }
    pub(crate) fn register(
        &self,
        scope: GraphScope,
        service: [u8; 32],
        slot: u8,
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        let mut pending = Pending {
            canceled: Arc::new(AtomicBool::new(false)),
            wake: Arc::clone(&self.wake),
            armed: true,
        };
        self.send(Command::Register(
            scope,
            service,
            slot,
            endpoint,
            Arc::clone(&pending.canceled),
            reply,
        ))?;
        let result = receiver.recv_timeout(BUDGET).map_err(|_| refused())?;
        if result.is_ok() {
            pending.armed = false;
        }
        result
    }
    pub(crate) fn retire(&self, target: Target) -> Result<Acknowledgement, CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::Retire(target, reply))?;
        receiver.recv_timeout(BUDGET).map_err(|_| refused())?
    }
    /// Revoke an exact original graph's named bindings as one reactor batch.
    /// Reply loss is uncertain retirement; callers must retain intent and clean up.
    pub(crate) fn retire_bindings(
        &self,
        scope: GraphScope,
        services: &[[u8; 32]],
    ) -> Result<Acknowledgement, CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::RetireBindings(scope, services.to_vec(), reply))?;
        receiver.recv_timeout(BUDGET).map_err(|_| refused())?
    }
    /// Caller holds the VM mutation lease and has selected the complete slot under
    /// its original executable/port/supervisor policy. Begin closes existing streams
    /// and fences accepts; it does not migrate or replay application bytes.
    pub(crate) fn begin_rebind(
        &self,
        scope: GraphScope,
        slot: u8,
        expected_generation: [u8; 32],
    ) -> Result<SlotFence, CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        let mut pending = Pending {
            canceled: Arc::new(AtomicBool::new(false)),
            wake: Arc::clone(&self.wake),
            armed: true,
        };
        self.send(Command::BeginRebind(
            scope,
            slot,
            expected_generation,
            Arc::clone(&pending.canceled),
            reply,
        ))?;
        let identity = receiver.recv_timeout(BUDGET).map_err(|_| refused())??;
        pending.armed = false;
        Ok(SlotFence(Arc::new(FenceToken {
            identity,
            canceled: Arc::clone(&pending.canceled),
            wake: Arc::clone(&self.wake),
        })))
    }
    /// Fresh capability stays inaccessible to guest admission until completion.
    /// Abandoned registration replies cancel the replacement. Selector/lineage
    /// authorization remains the graph caller's responsibility at the effect boundary.
    pub(crate) fn register_replacement(
        &self,
        fence: &SlotFence,
        service: [u8; 32],
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        let mut pending = Pending {
            canceled: Arc::new(AtomicBool::new(false)),
            wake: Arc::clone(&self.wake),
            armed: true,
        };
        self.send(Command::Replace(
            fence.clone(),
            service,
            endpoint,
            Arc::clone(&pending.canceled),
            reply,
        ))?;
        let result = receiver.recv_timeout(BUDGET).map_err(|_| refused())?;
        if result.is_ok() {
            pending.armed = false;
        }
        result
    }
    /// Call only after the graph caller's durable receipt commit and all guest
    /// listeners are ready. A lost acknowledgement is uncertain; explicitly abort
    /// this fence or reconcile the durable operation, never replay user payload.
    pub(crate) fn complete_rebind(&self, fence: &SlotFence) -> Result<(), CandidateError> {
        self.send_completion(std::slice::from_ref(fence))
    }
    /// Activate a same-graph replacement batch in one reactor turn. Every slot is
    /// validated before any admission opens; cancellation/lost replies refence and
    /// retire the entire batch. Caller must commit the complete receipt first.
    pub(crate) fn complete_rebinds(&self, fences: &[SlotFence]) -> Result<(), CandidateError> {
        if let [fence] = fences {
            return self.complete_rebind(fence);
        }
        self.send_completion(fences)
    }
    fn send_completion(&self, fences: &[SlotFence]) -> Result<(), CandidateError> {
        if fences.is_empty() || fences.len() > 32 {
            return Err(refused());
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let mut pending = Pending {
            canceled: Arc::new(AtomicBool::new(false)),
            wake: Arc::clone(&self.wake),
            armed: true,
        };
        self.send(Command::Complete(
            fences.to_vec(),
            Arc::clone(&pending.canceled),
            reply,
        ))?;
        let result = receiver.recv_timeout(BUDGET).map_err(|_| refused())?;
        if result.is_ok() {
            pending.armed = false;
        }
        result
    }
    /// Explicit abort also supports a just-completed fence for multi-slot commit
    /// failure, provided no newer targets/operation intervened. No old grant revives.
    /// The slot stays closed; a fresh begin may retry the same old receipt generation.
    pub(crate) fn abort_rebind(&self, fence: &SlotFence) -> Result<(), CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::Abort(fence.clone(), reply))?;
        receiver.recv_timeout(BUDGET).map_err(|_| refused())?
    }
    pub(crate) fn verify_alive(&self) -> Result<(), CandidateError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::Check(reply))?;
        receiver.recv_timeout(BUDGET).map_err(|_| refused())?
    }
}
impl Drop for ManagedOwner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        wake(&self.wake);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, sync::atomic::AtomicU64, time::Instant};
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = fs::canonicalize("/tmp").unwrap().join(format!(
                "hrmanaged-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn context() -> Context {
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        }
    }
    #[test]
    fn control_only_owner_has_real_lifecycle_without_transport_slots() {
        let root = Root::new();
        let managed = ManagedOwner::start(context(), &root.0, Vec::new()).unwrap();
        managed.verify_alive().unwrap();
        assert!(ManagedOwner::start(context(), &root.0, Vec::new()).is_err());
        managed.verify_alive().unwrap();
        drop(managed);
    }
    #[test]
    fn managed_registration_retirement_and_idle_shutdown() {
        let root = Root::new();
        let socket = root.0.join("slot.sock");
        let managed = ManagedOwner::start(
            context(),
            &root.0,
            vec![ManagedSlot {
                slot: 0,
                path: socket.clone(),
                canonical_parent: root.0.clone(),
            }],
        )
        .unwrap();
        managed.verify_alive().unwrap();
        let backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = || {
            HostEndpoint::capture(
                std::process::id() as i32,
                backend.local_addr().unwrap().port(),
            )
            .unwrap()
        };
        let graph = GraphScope::new(context(), [3; 32]).unwrap();
        let grant = managed.register(graph, [4; 32], 0, endpoint()).unwrap();
        let second = managed.register(graph, [5; 32], 0, endpoint()).unwrap();
        assert_ne!(grant.target, second.target);
        for selected in [&grant, &second] {
            let mut transport = UnixStream::connect(&socket).unwrap();
            transport
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            transport
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let (client, hello) = selected.credential.begin().unwrap();
            transport.write_all(&hello[..11]).unwrap();
            managed.verify_alive().unwrap();
            transport.write_all(&hello[11..]).unwrap();
            let mut challenge = [0; 64];
            transport.read_exact(&mut challenge).unwrap();
            let (finish, proof) = client.answer(&challenge).unwrap();
            transport.write_all(&proof).unwrap();
            let mut acceptance = [0; 32];
            transport.read_exact(&mut acceptance).unwrap();
            finish.accept(&acceptance).unwrap();
        }

        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let foreign = HostEndpoint::capture(
            std::process::id() as i32,
            other.local_addr().unwrap().port(),
        )
        .unwrap();
        assert!(managed.register(graph, [6; 32], 0, foreign).is_err());
        assert_eq!(
            managed.endpoint().incarnation(),
            PinnedEndpoint::load(&root.0, context())
                .unwrap()
                .incarnation()
        );
        managed.retire(grant.target).unwrap();
        let started = Instant::now();
        drop(managed);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!socket.exists());
    }
    #[test]
    fn managed_refuses_existing_socket_and_preserves_replacement() {
        let root = Root::new();
        let path = root.0.join("slot.sock");
        let existing = UnixListener::bind(&path).unwrap();
        assert!(
            ManagedOwner::start(
                context(),
                &root.0,
                vec![ManagedSlot {
                    slot: 0,
                    path: path.clone(),
                    canonical_parent: root.0.clone()
                }]
            )
            .is_err()
        );
        assert!(path.exists());
        drop(existing);
        fs::remove_file(&path).unwrap();
        let managed = ManagedOwner::start(
            context(),
            &root.0,
            vec![ManagedSlot {
                slot: 0,
                path: path.clone(),
                canonical_parent: root.0.clone(),
            }],
        )
        .unwrap();
        fs::remove_file(&path).unwrap();
        let replacement = UnixListener::bind(&path).unwrap();
        let id = fs::symlink_metadata(&path).unwrap().ino();
        drop(managed);
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), id);
        drop(replacement);
    }
    #[test]
    fn managed_alias_replacement_preserves_old_socket() {
        let root = Root::new();
        let home = root.0.join("home");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = root.0.join("alias");
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        let managed = ManagedOwner::start(
            context(),
            &root.0,
            vec![ManagedSlot {
                slot: 0,
                path: alias.join("slot.sock"),
                canonical_parent: home.clone(),
            }],
        )
        .unwrap();
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&root.0, &alias).unwrap();
        drop(managed);
        assert!(home.join("slot.sock").exists());
        assert_eq!(fs::read_link(alias).unwrap(), root.0);
    }
    #[test]
    fn multiple_wakeups_preserve_order_without_consuming_bytes() {
        let mut owner = RelayOwner::new(
            context(),
            OwnerLimits {
                registrations: 1,
                controls: 1,
                relay: Limits {
                    max_flows: 1,
                    connect_timeout: BUDGET,
                    idle_timeout: Duration::from_secs(30),
                },
            },
        )
        .unwrap();
        let (mut a, mut write_a) = UnixStream::pair().unwrap();
        let (b, _write_b) = UnixStream::pair().unwrap();
        write_a.write_all(&[42]).unwrap();
        let ready = owner
            .tick_with_wakeups(Duration::ZERO, &[b.as_fd(), a.as_fd()])
            .unwrap();
        assert_eq!(ready[0], 0);
        assert_ne!(ready[1] & libc::POLLIN, 0);
        let mut byte = [0];
        a.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [42]);
    }
    #[test]
    fn split_preamble_retains_accept_deadline() {
        let (stream, mut client) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut pending = Preamble {
            stream,
            slot: 0,
            deadline,
            bytes: [0; 136],
            used: 0,
        };
        client.write_all(&[7; 8]).unwrap();
        pending.progress(true).unwrap();
        assert_eq!(pending.used, 8);
        pending.progress(true).unwrap();
        assert_eq!(pending.used, 8);
        assert_eq!(pending.deadline, deadline);
        pending.deadline = Instant::now();
        client.write_all(&[7; 128]).unwrap();
        assert!(pending.progress(true).is_err());
        assert_eq!(pending.used, 8);
    }

    struct Fixture {
        owner: ManagedOwner,
        sockets: Vec<PathBuf>,
        _root: Root,
    }
    fn fixture(count: u8) -> Fixture {
        let root = Root::new();
        let sockets: Vec<_> = (0..count)
            .map(|slot| root.0.join(format!("slot-{slot}.sock")))
            .collect();
        let slots = sockets
            .iter()
            .enumerate()
            .map(|(slot, path)| ManagedSlot {
                slot: slot as u8,
                path: path.clone(),
                canonical_parent: root.0.clone(),
            })
            .collect();
        Fixture {
            owner: ManagedOwner::start(context(), &root.0, slots).unwrap(),
            sockets,
            _root: root,
        }
    }
    fn captured(listener: &TcpListener) -> HostEndpoint {
        HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr().unwrap().port(),
        )
        .unwrap()
    }
    fn authenticate(
        path: &Path,
        credential: &super::super::super::relay_auth::Credential,
    ) -> Result<UnixStream, CandidateError> {
        let mut stream = UnixStream::connect(path).map_err(|_| refused())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (client, hello) = credential.begin()?;
        stream.write_all(&hello).map_err(|_| refused())?;
        let mut challenge = [0; 64];
        stream.read_exact(&mut challenge).map_err(|_| refused())?;
        let (finish, proof) = client.answer(&challenge)?;
        stream.write_all(&proof).map_err(|_| refused())?;
        let mut acceptance = [0; 32];
        stream.read_exact(&mut acceptance).map_err(|_| refused())?;
        finish.accept(&acceptance)?;
        Ok(stream)
    }
    fn closed(stream: &mut UnixStream) {
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            result => panic!("retirement left a transport open: {result:?}"),
        }
    }
    #[test]
    fn completed_bindings_retire_as_exact_scoped_batch_and_are_never_replaced() {
        let fixture = fixture(2);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let foreign = GraphScope::new(context(), [8; 32]).unwrap();
        let old = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = captured(&old);
        let expected = endpoint.generation().unwrap();
        let active = fixture
            .owner
            .register(scope, [4; 32], 0, endpoint.clone())
            .unwrap();
        let completed = fixture
            .owner
            .register(scope, [5; 32], 0, endpoint.clone())
            .unwrap();
        let completed_other_slot = fixture
            .owner
            .register(scope, [6; 32], 1, endpoint.clone())
            .unwrap();
        let unrelated = fixture
            .owner
            .register(foreign, [9; 32], 1, endpoint)
            .unwrap();
        let mut stream = authenticate(&fixture.sockets[0], &completed.credential).unwrap();
        for identities in [
            vec![],
            vec![[5; 32], [5; 32]],
            vec![[5; 32], [9; 32]],
            vec![[5; 32], [42; 32]],
        ] {
            assert!(fixture.owner.retire_bindings(scope, &identities).is_err());
            assert!(authenticate(&fixture.sockets[0], &completed.credential).is_ok());
        }
        fixture
            .owner
            .retire_bindings(scope, &[[5; 32], [6; 32]])
            .unwrap();
        closed(&mut stream);
        assert!(authenticate(&fixture.sockets[0], &completed.credential).is_err());
        assert!(authenticate(&fixture.sockets[1], &completed_other_slot.credential).is_err());
        assert!(authenticate(&fixture.sockets[1], &unrelated.credential).is_ok());
        let fence = fixture.owner.begin_rebind(scope, 0, expected).unwrap();
        let next = TcpListener::bind("127.0.0.1:0").unwrap();
        let fresh = fixture
            .owner
            .register_replacement(&fence, [4; 32], captured(&next))
            .unwrap();
        // Only the running sibling contributes to the fresh grant count.
        fixture.owner.complete_rebind(&fence).unwrap();
        assert!(authenticate(&fixture.sockets[0], &active.credential).is_err());
        assert!(authenticate(&fixture.sockets[0], &completed.credential).is_err());
        assert!(authenticate(&fixture.sockets[0], &fresh.credential).is_ok());
        let second = fixture
            .owner
            .begin_rebind(scope, 0, captured(&next).generation().unwrap())
            .unwrap();
        let last = TcpListener::bind("127.0.0.1:0").unwrap();
        let latest = fixture
            .owner
            .register_replacement(&second, [4; 32], captured(&last))
            .unwrap();
        fixture.owner.complete_rebind(&second).unwrap();
        assert!(authenticate(&fixture.sockets[0], &completed.credential).is_err());
        assert!(authenticate(&fixture.sockets[0], &latest.credential).is_ok());
    }
    #[test]
    fn completed_only_retirement_reply_loss_leaves_all_credentials_revoked() {
        let fixture = fixture(1);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = captured(&backend);
        let generation = endpoint.generation().unwrap();
        let first = fixture
            .owner
            .register(scope, [4; 32], 0, endpoint.clone())
            .unwrap();
        let second = fixture.owner.register(scope, [5; 32], 0, endpoint).unwrap();
        let (reply, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        fixture
            .owner
            .send(Command::RetireBindings(
                scope,
                vec![[4; 32], [5; 32]],
                reply,
            ))
            .unwrap();
        fixture.owner.verify_alive().unwrap();
        assert!(authenticate(&fixture.sockets[0], &first.credential).is_err());
        assert!(authenticate(&fixture.sockets[0], &second.credential).is_err());
        assert!(fixture.owner.begin_rebind(scope, 0, generation).is_err());
    }
    #[test]
    fn shared_slot_rebind_drains_prehello_and_opens_only_complete_fresh_grants() {
        let fixture = fixture(2);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let other_scope = GraphScope::new(context(), [8; 32]).unwrap();
        let old_backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let original_address = old_backend.local_addr().unwrap();
        let unrelated_backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let old_endpoint = captured(&old_backend);
        let expected = old_endpoint.generation().unwrap();
        let first = fixture
            .owner
            .register(scope, [4; 32], 0, old_endpoint.clone())
            .unwrap();
        let second = fixture
            .owner
            .register(scope, [5; 32], 0, old_endpoint.clone())
            .unwrap();
        let unrelated = fixture
            .owner
            .register(other_scope, [9; 32], 1, captured(&unrelated_backend))
            .unwrap();
        let mut first_stream = authenticate(&fixture.sockets[0], &first.credential).unwrap();
        let mut second_stream = authenticate(&fixture.sockets[0], &second.credential).unwrap();
        let mut surviving = authenticate(&fixture.sockets[1], &unrelated.credential).unwrap();
        let mut prehello = UnixStream::connect(&fixture.sockets[0]).unwrap();
        prehello
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        prehello.write_all(&[7; 8]).unwrap();
        assert!(fixture.owner.begin_rebind(scope, 0, [42; 32]).is_err());
        assert!(authenticate(&fixture.sockets[0], &first.credential).is_ok());
        let fence = fixture.owner.begin_rebind(scope, 0, expected).unwrap();
        closed(&mut first_stream);
        closed(&mut second_stream);
        closed(&mut prehello);
        assert!(
            fixture
                .owner
                .register_replacement(&fence, [4; 32], old_endpoint)
                .is_err()
        );
        drop(old_backend);
        let deadline = Instant::now() + Duration::from_secs(1);
        let next_backend = loop {
            match TcpListener::bind(original_address) {
                Ok(listener) => break listener,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(error) => panic!("same-port replacement did not bind: {error}"),
            }
        };
        next_backend.set_nonblocking(true).unwrap();
        let replacement = captured(&next_backend);
        assert_ne!(replacement.generation().unwrap(), expected);
        let fresh_first = fixture
            .owner
            .register_replacement(&fence, [4; 32], replacement.clone())
            .unwrap();
        assert!(fixture.owner.complete_rebind(&fence).is_err());
        assert!(authenticate(&fixture.sockets[0], &fresh_first.credential).is_err());
        assert!(
            fixture
                .owner
                .register_replacement(&fence, [5; 32], captured(&unrelated_backend))
                .is_err()
        );
        let fresh_second = fixture
            .owner
            .register_replacement(&fence, [5; 32], replacement)
            .unwrap();
        fixture.owner.complete_rebind(&fence).unwrap();
        assert_ne!(fresh_first.target, first.target);
        assert!(authenticate(&fixture.sockets[0], &first.credential).is_err());
        assert!(
            next_backend
                .accept()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        );
        let mut fresh_stream = authenticate(&fixture.sockets[0], &fresh_first.credential).unwrap();
        assert!(authenticate(&fixture.sockets[0], &fresh_second.credential).is_ok());
        surviving
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        assert!(surviving.read(&mut [0]).is_err_and(|error| matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        )));
        fixture.owner.abort_rebind(&fence).unwrap();
        closed(&mut fresh_stream);
        assert!(authenticate(&fixture.sockets[0], &fresh_first.credential).is_err());
        assert!(authenticate(&fixture.sockets[1], &unrelated.credential).is_ok());
        fixture.owner.abort_rebind(&fence).unwrap();
    }

    #[test]
    fn foreign_slot_membership_and_unresolved_cleanup_refuse_before_retirement() {
        let fixture = fixture(1);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let foreign = GraphScope::new(context(), [8; 32]).unwrap();
        let backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = captured(&backend);
        let expected = endpoint.generation().unwrap();
        let first = fixture
            .owner
            .register(scope, [4; 32], 0, endpoint.clone())
            .unwrap();
        let second = fixture
            .owner
            .register(foreign, [5; 32], 0, endpoint)
            .unwrap();
        assert!(fixture.owner.begin_rebind(scope, 0, expected).is_err());
        assert!(authenticate(&fixture.sockets[0], &first.credential).is_ok());
        assert!(authenticate(&fixture.sockets[0], &second.credential).is_ok());
        let isolated = self::fixture(1);
        let grant = isolated
            .owner
            .register(scope, [4; 32], 0, captured(&backend))
            .unwrap();
        let intent = super::super::lifecycle_intent::Coordinator::begin(
            &isolated.owner.endpoint(),
            super::super::lifecycle_intent::Mutation {
                effect: [6; 32],
                targets: vec![grant.target],
            },
        )
        .unwrap();
        drop(intent);
        assert!(isolated.owner.begin_rebind(scope, 0, expected).is_err());
        assert!(authenticate(&isolated.sockets[0], &grant.credential).is_ok());
    }

    #[test]
    fn repeated_rebind_compacts_exact_fences_without_resurrecting_credentials() {
        let fixture = fixture(1);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let backends = [
            TcpListener::bind("127.0.0.1:0").unwrap(),
            TcpListener::bind("127.0.0.1:0").unwrap(),
        ];
        let endpoints = [captured(&backends[0]), captured(&backends[1])];
        let generations = [
            endpoints[0].generation().unwrap(),
            endpoints[1].generation().unwrap(),
        ];
        let first = fixture
            .owner
            .register(scope, [4; 32], 0, endpoints[0].clone())
            .unwrap();
        let mut last_target = first.target.clone();
        let mut historical = None;
        let mut latest = None;
        for index in 0..300 {
            let previous = index % 2;
            let next = 1 - previous;
            let fence = fixture
                .owner
                .begin_rebind(scope, 0, generations[previous])
                .unwrap();
            let grant = fixture
                .owner
                .register_replacement(&fence, [4; 32], endpoints[next].clone())
                .unwrap();
            assert_ne!(grant.target, last_target);
            fixture.owner.complete_rebind(&fence).unwrap();
            if index == 0 {
                historical = Some(fence.clone());
            }
            last_target = grant.target.clone();
            latest = Some(grant);
        }
        assert_ne!(last_target, first.target);
        assert!(authenticate(&fixture.sockets[0], &first.credential).is_err());
        let stale = historical.unwrap();
        assert!(fixture.owner.abort_rebind(&stale).is_err());
        assert!(fixture.owner.complete_rebind(&stale).is_err());
        assert!(authenticate(&fixture.sockets[0], &latest.unwrap().credential).is_ok());
        fixture.owner.verify_alive().unwrap();
    }

    #[test]
    fn abandoned_fence_and_completion_reply_leave_replacement_closed() {
        let fixture = fixture(1);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let old = TcpListener::bind("127.0.0.1:0").unwrap();
        let new = TcpListener::bind("127.0.0.1:0").unwrap();
        let expected = captured(&old).generation().unwrap();
        fixture
            .owner
            .register(scope, [4; 32], 0, captured(&old))
            .unwrap();
        let fence = fixture.owner.begin_rebind(scope, 0, expected).unwrap();
        let grant = fixture
            .owner
            .register_replacement(&fence, [4; 32], captured(&new))
            .unwrap();
        let (reply, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        fixture
            .owner
            .send(Command::Complete(
                vec![fence.clone()],
                Arc::new(AtomicBool::new(false)),
                reply,
            ))
            .unwrap();
        fixture.owner.verify_alive().unwrap();
        assert!(authenticate(&fixture.sockets[0], &grant.credential).is_err());
        fixture.owner.abort_rebind(&fence).unwrap();
        let retry = fixture.owner.begin_rebind(scope, 0, expected).unwrap();
        let fresh = fixture
            .owner
            .register_replacement(&retry, [4; 32], captured(&new))
            .unwrap();
        let canceled = Arc::clone(&retry.0.canceled);
        drop(retry);
        assert!(canceled.load(Ordering::Acquire));
        fixture.owner.verify_alive().unwrap();
        assert!(authenticate(&fixture.sockets[0], &fresh.credential).is_err());
        assert!(
            fixture
                .owner
                .register(scope, [8; 32], 0, captured(&new))
                .is_err()
        );
    }

    #[test]
    fn batch_completion_validates_every_slot_before_activation_and_lost_reply_aborts_all() {
        let fixture = fixture(2);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let old = [
            TcpListener::bind("127.0.0.1:0").unwrap(),
            TcpListener::bind("127.0.0.1:0").unwrap(),
        ];
        let new = [
            TcpListener::bind("127.0.0.1:0").unwrap(),
            TcpListener::bind("127.0.0.1:0").unwrap(),
        ];
        let old_endpoints = [captured(&old[0]), captured(&old[1])];
        let new_endpoints = [captured(&new[0]), captured(&new[1])];
        let mut fences = Vec::new();
        for slot in 0..2 {
            fixture
                .owner
                .register(
                    scope,
                    [4 + slot; 32],
                    slot,
                    old_endpoints[usize::from(slot)].clone(),
                )
                .unwrap();
            fences.push(
                fixture
                    .owner
                    .begin_rebind(
                        scope,
                        slot,
                        old_endpoints[usize::from(slot)].generation().unwrap(),
                    )
                    .unwrap(),
            );
        }
        let first = fixture
            .owner
            .register_replacement(&fences[0], [4; 32], new_endpoints[0].clone())
            .unwrap();
        assert!(
            fixture.owner.complete_rebinds(&fences).is_err(),
            "second slot has no complete replacement"
        );
        assert!(
            authenticate(&fixture.sockets[0], &first.credential).is_err(),
            "failed second validation must not open the first slot"
        );
        assert!(
            fixture
                .owner
                .complete_rebinds(&[fences[0].clone(), fences[0].clone()])
                .is_err()
        );
        let second = fixture
            .owner
            .register_replacement(&fences[1], [5; 32], new_endpoints[1].clone())
            .unwrap();
        fixture.owner.complete_rebinds(&fences).unwrap();
        let mut first_stream = authenticate(&fixture.sockets[0], &first.credential).unwrap();
        let mut second_stream = authenticate(&fixture.sockets[1], &second.credential).unwrap();

        let mut retry = Vec::new();
        let mut fresh = Vec::new();
        for slot in 0..2 {
            let fence = fixture
                .owner
                .begin_rebind(
                    scope,
                    slot,
                    new_endpoints[usize::from(slot)].generation().unwrap(),
                )
                .unwrap();
            fresh.push(
                fixture
                    .owner
                    .register_replacement(
                        &fence,
                        [4 + slot; 32],
                        old_endpoints[usize::from(slot)].clone(),
                    )
                    .unwrap(),
            );
            retry.push(fence);
        }
        closed(&mut first_stream);
        closed(&mut second_stream);
        let (reply, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        fixture
            .owner
            .send(Command::Complete(
                retry.clone(),
                Arc::new(AtomicBool::new(false)),
                reply,
            ))
            .unwrap();
        fixture.owner.verify_alive().unwrap();
        for slot in 0..2 {
            assert!(authenticate(&fixture.sockets[slot], &fresh[slot].credential).is_err());
            fixture.owner.abort_rebind(&retry[slot]).unwrap();
        }
    }

    #[test]
    fn canceled_batch_cannot_open_any_slot() {
        let fixture = fixture(2);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let old = TcpListener::bind("127.0.0.1:0").unwrap();
        let new = TcpListener::bind("127.0.0.1:0").unwrap();
        let old_endpoint = captured(&old);
        let mut fences = Vec::new();
        let mut grants = Vec::new();
        for slot in 0..2 {
            fixture
                .owner
                .register(scope, [4 + slot; 32], slot, old_endpoint.clone())
                .unwrap();
            let fence = fixture
                .owner
                .begin_rebind(scope, slot, old_endpoint.generation().unwrap())
                .unwrap();
            grants.push(
                fixture
                    .owner
                    .register_replacement(&fence, [4 + slot; 32], captured(&new))
                    .unwrap(),
            );
            fences.push(fence);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        fixture
            .owner
            .send(Command::Complete(
                fences.clone(),
                Arc::new(AtomicBool::new(true)),
                reply,
            ))
            .unwrap();
        assert!(receiver.recv_timeout(BUDGET).unwrap().is_err());
        for slot in 0..2 {
            assert!(authenticate(&fixture.sockets[slot], &grants[slot].credential).is_err());
            fixture.owner.abort_rebind(&fences[slot]).unwrap();
        }
    }

    #[test]
    fn only_authenticated_identity_failure_wakes_and_old_epoch_cannot_dirty_new() {
        let fixture = fixture(1);
        let scope = GraphScope::new(context(), [3; 32]).unwrap();
        let old = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = captured(&old);
        let generation = endpoint.generation().unwrap();
        let grant = fixture
            .owner
            .register(scope, [4; 32], 0, endpoint.clone())
            .unwrap();
        assert!(!fixture.owner.drain_notifications().unwrap());
        drop(old);
        assert!(endpoint.fingerprint().is_err());
        let mut invalid = UnixStream::connect(&fixture.sockets[0]).unwrap();
        invalid
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        invalid.write_all(&[0; 136]).unwrap();
        closed(&mut invalid);
        assert!(!fixture.owner.drain_notifications().unwrap());
        let _ = authenticate(&fixture.sockets[0], &grant.credential).unwrap();
        let mut poll = libc::pollfd {
            fd: std::os::fd::AsRawFd::as_raw_fd(&fixture.owner.notification_fd()),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll receives exactly one initialized descriptor entry.
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 2000) }, 1);
        assert_eq!(
            fixture.owner.dirty_slots().unwrap(),
            vec![DirtySlot {
                slot: 0,
                generation
            }]
        );
        assert!(!fixture.owner.drain_notifications().unwrap());
        let new = TcpListener::bind("127.0.0.1:0").unwrap();
        let fence = fixture.owner.begin_rebind(scope, 0, generation).unwrap();
        fixture
            .owner
            .register_replacement(&fence, [4; 32], captured(&new))
            .unwrap();
        fixture.owner.complete_rebind(&fence).unwrap();
        fixture.owner.notifications.notify(0, generation);
        assert!(!fixture.owner.drain_notifications().unwrap());
    }
}
