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
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    os::{
        fd::AsFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
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
    Check(Reply<()>),
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
}
fn retire(owner: &mut RelayOwner, target: Target) -> Result<Acknowledgement, CandidateError> {
    let mut operation = [0; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut operation))
        .map_err(|_| refused())?;
    owner.retire(&RetireRequest {
        version: 1,
        owner: owner.incarnation(),
        operation,
        targets: vec![target],
    })
}
impl Reactor {
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
                            let generation = endpoint.generation()?;
                            if slot
                                .endpoint_generation
                                .is_some_and(|old| old != generation)
                            {
                                return Err(refused());
                            }
                            let grant = self.owner.register_graph(scope, service, endpoint)?;
                            slot.endpoint_generation = Some(generation);
                            slot.targets
                                .push((grant.target.clone(), Arc::clone(&canceled)));
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
                    Command::Check(reply) => {
                        let _ = reply.try_send(Ok(()));
                    }
                }
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
        let mut reactor = Reactor {
            owner,
            control,
            slots,
            preambles: Vec::new(),
            wake: read,
            commands: receiver,
            stop: Arc::clone(&stop),
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
        })
    }
    pub(crate) fn endpoint(&self) -> PinnedEndpoint {
        self.endpoint.clone()
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
}
