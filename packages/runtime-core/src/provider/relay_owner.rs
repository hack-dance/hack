//! Owner-side capability registry and retirement barrier. Private control transport,
//! durable lifecycle intent and authoritative graph/boot selection remain external.
use super::{
    host_endpoint::HostEndpoint,
    relay_auth::{Authority, Binding, Credential},
    relay_loop::{Interest, Limits, RelayLoop, Stats},
};
use crate::CandidateError;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    os::{fd::BorrowedFd, unix::net::UnixStream},
    time::{Duration, Instant},
};
mod control;
pub mod lifecycle_intent;
pub(crate) mod managed;
pub mod publication;
pub mod transport;
pub use control::{Acknowledgement, GraphSelection, RetireRequest, SelectionRequest, Target};
fn refused() -> CandidateError {
    CandidateError::new(
        "relay_owner_refused",
        "Relay owner, target generation or request is invalid.",
    )
}
#[derive(Clone, Copy)]
pub struct Context {
    pub runtime: [u8; 16],
    pub boot: [u8; 16],
}
pub struct OwnerLimits {
    pub registrations: usize,
    pub controls: usize,
    pub relay: Limits,
}
#[derive(Default, Debug)]
pub struct ControlStats {
    pub admitted: u64,
    pub rejected: u64,
    pub completed: u64,
    pub failed: u64,
    pub timed_out: u64,
    pub peak_active: usize,
}
/// Credential contains secret material and deliberately supports neither Debug nor Serialize.
pub struct Grant {
    pub target: Target,
    pub credential: Credential,
}
/// Owner-local graph selection, derived by the graph boundary from verified identity.
/// It is not mutation authority and must be reselected under the runtime mutation lease.
#[derive(Clone, Copy)]
pub struct GraphScope {
    context: Context,
    id: [u8; 32],
}
impl GraphScope {
    pub(super) fn new(context: Context, id: [u8; 32]) -> Result<Self, CandidateError> {
        if context.runtime == [0; 16] || context.boot == [0; 16] || id == [0; 32] {
            return Err(refused());
        }
        Ok(Self { context, id })
    }
}
struct Registration {
    target: Target,
    graph: Option<[u8; 32]>,
    endpoint: HostEndpoint,
    authority: Authority,
    retired: bool,
}
/// Single-owner state; this type spawns no threads, binds no socket and persists no key.
/// Drop revokes all authorities before owned transports and registry state are released.
pub struct RelayOwner {
    context: Context,
    incarnation: [u8; 16],
    capacity: usize,
    serial: u64,
    entries: BTreeMap<[u8; 32], Registration>,
    relay: RelayLoop,
    controls: Vec<transport::ServerExchange>,
    control_capacity: usize,
    control_stats: ControlStats,
    control_root: Option<std::path::PathBuf>,
}
impl RelayOwner {
    pub fn new(context: Context, limits: OwnerLimits) -> Result<Self, CandidateError> {
        if context.runtime == [0; 16]
            || context.boot == [0; 16]
            || !(1..=256).contains(&limits.registrations)
            || !(1..=64).contains(&limits.controls)
        {
            return Err(refused());
        }
        let relay = RelayLoop::new(limits.relay)?;
        let mut incarnation = [0; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut incarnation))
            .map_err(|_| refused())?;
        if incarnation == [0; 16] {
            return Err(refused());
        }
        Ok(Self {
            context,
            incarnation,
            capacity: limits.registrations,
            serial: 0,
            entries: BTreeMap::new(),
            relay,
            controls: Vec::new(),
            control_capacity: limits.controls,
            control_stats: ControlStats::default(),
            control_root: None,
        })
    }
    pub(super) fn matches_context(&self, context: Context) -> bool {
        self.context.runtime == context.runtime && self.context.boot == context.boot
    }
    pub fn incarnation(&self) -> [u8; 16] {
        self.incarnation
    }
    pub fn connections(&self) -> usize {
        self.relay.connections()
    }
    pub fn stats(&self) -> &Stats {
        self.relay.stats()
    }
    pub fn control_stats(&self) -> &ControlStats {
        &self.control_stats
    }
    pub fn control_connections(&self) -> usize {
        self.controls.len()
    }
    /// Accept only a stream already selected through a verified private listener.
    /// Expected coordinator identity is trusted caller input, never request JSON.
    /// Refusal drops the supplied stream without displacing an admitted exchange.
    pub fn admit_control(
        &mut self,
        stream: UnixStream,
        coordinator: &super::identity::ProcessIdentity,
        budget: Duration,
    ) -> Result<(), CandidateError> {
        if self.controls.len() >= self.control_capacity {
            self.control_stats.rejected += 1;
            return Err(refused());
        }
        match transport::ServerExchange::new(stream, coordinator, budget) {
            Ok(exchange) => {
                self.controls.push(exchange);
                self.control_stats.admitted += 1;
                self.control_stats.peak_active =
                    self.control_stats.peak_active.max(self.controls.len());
                Ok(())
            }
            Err(error) => {
                self.control_stats.rejected += 1;
                Err(error)
            }
        }
    }
    /// Trusted caller supplies a validated graph service generation, including its
    /// run/container identity. No raw control request may call this to choose a target.
    /// Retired service entries remain fenced; replacement needs lifecycle confirmation.
    pub fn register(
        &mut self,
        service: [u8; 32],
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        self.register_selected(None, service, endpoint)
    }
    pub(super) fn register_graph(
        &mut self,
        graph: GraphScope,
        service: [u8; 32],
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        if !self.matches_context(graph.context) {
            return Err(refused());
        }
        self.register_selected(Some(graph.id), service, endpoint)
    }
    /// Complete retained target set for one graph, including retired/older generations.
    /// Refuse unscoped entries because their graph membership cannot be established.
    /// Callers must serialize selection and intent against registration using the real
    /// VM mutation lease; this snapshot alone grants no retirement/effect authority.
    pub fn targets_for_graph(&self, graph: GraphScope) -> Result<Vec<Target>, CandidateError> {
        if !self.matches_context(graph.context)
            || self.entries.values().any(|entry| entry.graph.is_none())
        {
            return Err(refused());
        }
        Ok(self
            .entries
            .values()
            .filter(|entry| entry.graph == Some(graph.id))
            .map(|entry| entry.target.clone())
            .collect())
    }
    fn register_selected(
        &mut self,
        graph: Option<[u8; 32]>,
        service: [u8; 32],
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        let _registration = self
            .control_root
            .as_ref()
            .map(|root| lifecycle_intent::registration(root))
            .transpose()?;
        if service == [0; 32]
            || self.entries.contains_key(&service)
            || self.entries.len() >= self.capacity
        {
            return Err(refused());
        }
        let serial = self.serial.checked_add(1).ok_or_else(refused)?;
        let binding = Binding {
            owner: self.context.runtime,
            boot: self.context.boot,
            endpoint: endpoint.generation()?,
            service,
        };
        let credential = Credential::generate(binding)?;
        let authority = Authority::new(&credential);
        let mut digest = Sha256::new();
        digest.update(b"Hack relay registration v1\0");
        digest.update(self.incarnation);
        digest.update(binding.owner);
        digest.update(binding.boot);
        digest.update(binding.endpoint);
        digest.update(binding.service);
        digest.update(serial.to_be_bytes());
        let target = Target {
            service,
            generation: digest.finalize().into(),
        };
        self.entries.insert(
            service,
            Registration {
                target: target.clone(),
                graph,
                endpoint,
                authority,
                retired: false,
            },
        );
        self.serial = serial;
        Ok(Grant { target, credential })
    }
    fn bind_control_root(&mut self, root: &std::path::Path) -> Result<(), CandidateError> {
        if self
            .control_root
            .as_ref()
            .is_some_and(|existing| existing != root)
        {
            return Err(refused());
        }
        lifecycle_intent::bind_owner(root, !self.entries.is_empty())?;
        self.control_root = Some(root.to_owned());
        Ok(())
    }
    /// Takes transport ownership on both success and refusal. Scope cannot be selected
    /// from an unauthenticated hello; only the owner-selected registration is used.
    pub fn admit(
        &mut self,
        target: &Target,
        transport: UnixStream,
        budget: Duration,
    ) -> Result<u64, CandidateError> {
        let entry = self
            .entries
            .get(&target.service)
            .filter(|entry| entry.target == *target && !entry.retired)
            .ok_or_else(refused)?;
        self.relay
            .admit(transport, &entry.endpoint, &entry.authority, budget)
    }
    /// Select only among targets registered for this verified listener. The hint
    /// grants no authority: challenge/proof/acceptance still precede upstream I/O.
    fn admit_shared(
        &mut self,
        targets: &[Target],
        transport: UnixStream,
        deadline: Instant,
        hello: &[u8],
    ) -> Result<u64, CandidateError> {
        let entry = targets
            .iter()
            .filter_map(|target| {
                self.entries
                    .get(&target.service)
                    .filter(|entry| entry.target == *target && !entry.retired)
            })
            .find(|entry| entry.authority.matches_hello(hello))
            .ok_or_else(refused)?;
        self.relay.admit_hello(
            transport,
            &entry.endpoint,
            &entry.authority,
            deadline,
            hello,
        )
    }
    pub fn tick(&mut self, max_wait: Duration) -> Result<(), CandidateError> {
        self.poll_tick(max_wait, &[]).map(|_| ())
    }
    /// Poll an external listener/owner-lifetime descriptor with relay/control traffic.
    /// The caller handles its readiness and must stop polling a readable full listener
    /// until capacity is available. This method never reads or owns the supplied FD.
    pub fn tick_with_wakeup(
        &mut self,
        max_wait: Duration,
        wake: BorrowedFd<'_>,
    ) -> Result<bool, CandidateError> {
        self.poll_tick(max_wait, &[wake]).map(|ready| ready[0] != 0)
    }
    /// Borrowed external descriptors, returned in input order; never read or owned.
    pub(crate) fn tick_with_wakeups(
        &mut self,
        max_wait: Duration,
        wake: &[BorrowedFd<'_>],
    ) -> Result<Vec<i16>, CandidateError> {
        self.poll_tick(max_wait, wake)
    }
    fn poll_tick(
        &mut self,
        max_wait: Duration,
        wake: &[BorrowedFd<'_>],
    ) -> Result<Vec<i16>, CandidateError> {
        if max_wait > Duration::from_secs(60) {
            return Err(refused());
        }
        let now = Instant::now();
        let mut wait = max_wait;
        let mut interests = Vec::with_capacity(self.controls.len() + wake.len());
        for exchange in &self.controls {
            wait = wait.min(exchange.deadline().saturating_duration_since(now));
            let (fd, events) = exchange.interest().ok_or_else(refused)?;
            interests.push(Interest { fd, events });
        }
        for fd in wake {
            interests.push(Interest {
                fd: *fd,
                events: libc::POLLIN,
            });
        }
        let result = self.relay.poll_tick(wait, &interests);
        drop(interests);
        let ready = match result {
            Ok(ready) => ready,
            Err(error) => {
                self.control_stats.failed += self.controls.len() as u64;
                self.controls.clear();
                return Err(error);
            }
        };
        let woke = ready[self.controls.len()..].to_vec();
        // Move the vector, preserving its allocation, so progress can retire owner
        // capabilities without aliasing a mutable borrow of the exchange collection.
        let mut controls = std::mem::take(&mut self.controls);
        let mut index = 0;
        controls.retain_mut(|exchange| {
            let active = ready[index] != 0 || Instant::now() >= exchange.deadline();
            index += 1;
            if !active {
                return true;
            }
            match exchange.progress(self) {
                Ok(false) => true,
                Ok(true) => {
                    self.control_stats.completed += 1;
                    false
                }
                Err(_) => {
                    if Instant::now() >= exchange.deadline() {
                        self.control_stats.timed_out += 1;
                    } else {
                        self.control_stats.failed += 1;
                    }
                    false
                }
            }
        });
        self.controls = controls;
        Ok(woke)
    }
    /// Validate the entire batch before its first effect. No fallible lookup or I/O
    /// admission remains after validation. Lost replies can be regenerated from fenced
    /// state without retaining an unbounded history of request/reply bodies.
    pub fn retire(&mut self, request: &RetireRequest) -> Result<Acknowledgement, CandidateError> {
        let acknowledgement = Acknowledgement::for_request(request)?;
        if request.owner != self.incarnation {
            return Err(refused());
        }
        for target in &request.targets {
            if !self
                .entries
                .get(&target.service)
                .is_some_and(|entry| entry.target == *target)
            {
                return Err(refused());
            }
        }
        for target in &request.targets {
            // Validated above; this single-owner map cannot change during the batch.
            let entry = self
                .entries
                .get_mut(&target.service)
                .expect("validated retirement target");
            self.relay.retire_authority(&entry.authority);
            entry.retired = true;
        }
        Ok(acknowledgement)
    }
}
impl Drop for RelayOwner {
    fn drop(&mut self) {
        for entry in self.entries.values() {
            self.relay.retire_authority(&entry.authority);
        }
    }
}
#[cfg(test)]
mod tests;
