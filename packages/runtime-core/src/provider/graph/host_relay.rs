//! Short-lived graph selection for outbound host relays, under the VM mutation lease.
use super::*;
use crate::provider::{
    host_endpoint::HostEndpoint,
    relay_owner::{Context, Grant, GraphScope, RelayOwner},
};
use sha2::{Digest, Sha256};

fn refused() -> CandidateError {
    error(
        "graph_relay_identity",
        "Relay service is not a current, ready owned graph generation.",
    )
}
pub(super) fn context(owner: &str, boot: &str) -> Result<Context, CandidateError> {
    if !hex(owner, 32)
        || boot.is_empty()
        || boot.len() > 128
        || boot.bytes().any(|b| b.is_ascii_control())
    {
        return Err(refused());
    }
    let digest = |domain: &[u8], value: &str| {
        let mut hash = Sha256::new();
        hash.update(domain);
        hash.update(value.as_bytes());
        let full = hash.finalize();
        let mut id = [0; 16];
        id.copy_from_slice(&full[..16]);
        id
    };
    let context = Context {
        runtime: digest(b"Hack graph relay runtime v1\0", owner),
        boot: digest(b"Hack graph relay boot v1\0", boot),
    };
    if context.runtime == [0; 16] || context.boot == [0; 16] {
        return Err(refused());
    }
    Ok(context)
}
/// Explicit enrolled-owner cleanup. Enrollment is durable before admission and blocks
/// ordinary mutation until the enrolled workflow retires and confirms the graph.
/// Environment and probe inventories are bound before effects and independently
/// checked after cleanup; missing or changed allocations refuse confirmation.
pub fn cleanup_with_relay(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
    endpoint: &crate::provider::relay_owner::publication::PinnedEndpoint,
) -> Result<Receipt, CandidateError> {
    cleanup_with_relay_expected(candidate, run, remove_data, endpoint, None)
}
pub(super) fn cleanup_with_relay_expected(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
    endpoint: &crate::provider::relay_owner::publication::PinnedEndpoint,
    expected_generation: Option<(&str, std::time::Instant)>,
) -> Result<Receipt, CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::Coordinator;
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = load(candidate, &engine, run)?;
    // Compare under the same mutation lease that performs cleanup. A stale client
    // cannot stop the newer execution between observation and retirement.
    if let Some((expected, deadline)) = expected_generation {
        super::foreground::redelivery::check_generation(&receipt, expected)?;
        super::check_environment_deadline(deadline)?;
    }
    cleanup_preflight(&engine, &receipt, &root, remove_data)?;
    if receipt
        .relay_startup
        .as_ref()
        .is_some_and(|startup| startup.control_root != endpoint.runtime_root())
    {
        return Err(refused());
    }
    if let Some(marker) = &receipt.relay_cleanup {
        if marker.control_root != endpoint.runtime_root() {
            return Err(error(
                "graph_relay_enrollment",
                "Cleanup must use the graph's enrolled relay owner; no mutation was performed.",
            ));
        }
        match marker.phase {
            cleanup_enrollment::Phase::Pending => return Err(refused()),
            cleanup_enrollment::Phase::Confirmed => require_acknowledged_enrollment(&receipt)?,
            cleanup_enrollment::Phase::Dormant => {}
        }
    }
    let scope = graph_scope(context(&receipt.owner, engine.guest().boot_id())?, run)?;
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    let bridge_selection = bridges::cleanup::capture(candidate, &engine, &receipt)?;
    let effect = cleanup_effect(
        &receipt,
        engine.guest().boot_id(),
        remove_data,
        &(&environment, &bridge_selection),
    )?;
    if let Some((_, deadline)) = expected_generation {
        super::check_environment_deadline(deadline)?;
    }
    let mut coordinator =
        Coordinator::begin_graph_enrolled(endpoint, scope, effect, None, |selection| {
            receipt.relay_cleanup = Some(cleanup_enrollment::RelayCleanup::new(
                endpoint.runtime_root(),
                &selection,
            )?);
            state::write(&root.join("state.json"), &receipt)?;
            #[cfg(test)]
            fault_pause(&root, run, "relay-before-admission")?;
            Ok(())
        })?;
    #[cfg(test)]
    fault_pause(&root, run, "relay-before-selection")?;
    bridges::cleanup::persist(&root, &bridge_selection)?;
    coordinator.prepare_graph(endpoint, Duration::from_secs(5))?;
    let mut cleaned = coordinator.execute(effect, || {
        if let Some((_, deadline)) = expected_generation {
            super::check_environment_deadline(deadline)?;
        }
        cleanup_owned(candidate, &engine, receipt, &root, remove_data)
    })?;
    #[cfg(test)]
    fault_pause(&root, run, "relay-after-effect")?;
    coordinator.confirm(effect, || {
        inspect_cleanup(
            candidate,
            &engine,
            &cleaned,
            remove_data,
            &environment,
            &bridge_selection,
        )
    })?;
    finish_confirmation(&mut coordinator, &mut cleaned, &root)?;
    Ok(cleaned)
}

/// Resume only a pre-effect intent after fresh evidence matches its original effect.
/// Interrupted selection bytes are retained, never promoted as authority. Retirement
/// requires a fresh owner exchange; EffectStarted is never executed a second time.
pub fn resume_relay_cleanup(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
    control_root: &std::path::Path,
    selection: crate::provider::relay_owner::lifecycle_intent::Selection,
    endpoint: &crate::provider::relay_owner::publication::PinnedEndpoint,
) -> Result<Receipt, CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::{Coordinator, Phase};
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    cleanup_preflight(&engine, &receipt, &root, remove_data)?;
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    if marker.phase != cleanup_enrollment::Phase::Pending
        || !marker.matches(control_root, &selection)
        || control_root != endpoint.runtime_root()
    {
        return Err(refused());
    }
    let expected = context(&receipt.owner, engine.guest().boot_id())?;
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    let bridge_selection = bridges::cleanup::capture(candidate, &engine, &receipt)?;
    let effect = cleanup_effect(
        &receipt,
        engine.guest().boot_id(),
        remove_data,
        &(&environment, &bridge_selection),
    )?;
    if selection.context.runtime != expected.runtime
        || selection.context.boot != expected.boot
        || selection.effect != effect
    {
        return Err(refused());
    }
    let mut coordinator = match Coordinator::resume(control_root, marker.selection()) {
        Ok(coordinator) => coordinator,
        Err(_) => Coordinator::begin_graph_enrolled(
            endpoint,
            graph_scope(expected, run)?,
            effect,
            Some(marker.operation),
            |_| Ok(()),
        )?,
    };
    if coordinator.phase() != Phase::Intent {
        return Err(refused());
    }
    #[cfg(test)]
    fault_pause(&root, run, "relay-before-selection")?;
    bridges::cleanup::recover_persist(&root, &bridge_selection)?;
    coordinator.prepare_graph(endpoint, Duration::from_secs(5))?;
    let mut cleaned = coordinator.execute(effect, || {
        cleanup_owned(candidate, &engine, receipt, &root, remove_data)
    })?;
    #[cfg(test)]
    fault_pause(&root, run, "relay-after-effect")?;
    coordinator.confirm(effect, || {
        inspect_cleanup(
            candidate,
            &engine,
            &cleaned,
            remove_data,
            &environment,
            &bridge_selection,
        )
    })?;
    finish_confirmation(&mut coordinator, &mut cleaned, &root)?;
    Ok(cleaned)
}

/// Confirm an interrupted enrolled cleanup only if its full supported effect is
/// independently visible. This never repeats deletion, retirement or other effects.
/// The selection must come from explicit lifecycle-intent inspection.
pub fn confirm_relay_cleanup(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
    control_root: &std::path::Path,
    selection: crate::provider::relay_owner::lifecycle_intent::Selection,
) -> Result<Receipt, CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::{Coordinator, Phase};
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = archive::load_confirmation(candidate, &engine, run)?;
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    if !marker.matches(control_root, &selection)
        || marker.phase == cleanup_enrollment::Phase::Dormant
    {
        return Err(refused());
    }
    let expected = context(&receipt.owner, engine.guest().boot_id())?;
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    let bridge_selection = bridges::cleanup::read(&engine, &receipt, &root)?;
    let effect = cleanup_effect(
        &receipt,
        engine.guest().boot_id(),
        remove_data,
        &(&environment, &bridge_selection),
    )?;
    if selection.context.runtime != expected.runtime
        || selection.context.boot != expected.boot
        || selection.effect != effect
    {
        return Err(refused());
    }
    let mut coordinator = Coordinator::resume(control_root, selection)?;
    let inspect = || {
        inspect_cleanup(
            candidate,
            &engine,
            &receipt,
            remove_data,
            &environment,
            &bridge_selection,
        )
    };
    match coordinator.phase() {
        Phase::EffectStarted => coordinator.confirm(effect, inspect)?,
        Phase::Confirmed if coordinator.acknowledgement_pending() => {
            inspect()?;
        }
        _ => return Err(refused()),
    }
    finish_confirmation(&mut coordinator, &mut receipt, &root)?;
    Ok(receipt)
}

fn finish_confirmation(
    coordinator: &mut crate::provider::relay_owner::lifecycle_intent::Coordinator,
    receipt: &mut Receipt,
    root: &std::path::Path,
) -> Result<(), CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::Phase;
    if coordinator.phase() != Phase::Confirmed || !coordinator.acknowledgement_pending() {
        return Err(refused());
    }
    #[cfg(test)]
    fault_pause(root, &receipt.run, "relay-before-confirmed-receipt")?;
    let marker = receipt.relay_cleanup.as_mut().ok_or_else(refused)?;
    if marker.operation != coordinator.operation() {
        return Err(refused());
    }
    marker.phase = cleanup_enrollment::Phase::Confirmed;
    state::write(&root.join("state.json"), receipt)?;
    #[cfg(test)]
    fault_pause(root, &receipt.run, "relay-before-ack")?;
    coordinator.acknowledge()
}

/// Retention requires the caller acknowledgement to be durable. A later operation
/// proves the prior acknowledgement because enrolled confirmation bars rollover.
pub(super) fn require_acknowledged_enrollment(receipt: &Receipt) -> Result<(), CandidateError> {
    use crate::provider::relay_owner::lifecycle_intent::{Inspection, Phase};
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    if !marker.valid() || marker.phase != cleanup_enrollment::Phase::Confirmed {
        return Err(refused());
    }
    let selected = marker.selection();
    let current = Inspection::load(&marker.control_root, selected.context)?;
    if current.selection.operation != selected.operation {
        return Ok(());
    }
    if current.selection.effect != selected.effect
        || current.phase != Phase::Confirmed
        || current.acknowledgement_pending
    {
        return Err(error(
            "graph_relay_enrollment",
            "Cleanup acknowledgement is incomplete; preserve enrollment evidence.",
        ));
    }
    Ok(())
}

fn cleanup_preflight(
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &std::path::Path,
    remove_data: bool,
) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            return Err(error(
                "graph_journal_uncertain",
                "Reconcile the graph journal before enrolled cleanup.",
            ));
        }
    }
    for resource in receipt
        .resources
        .values()
        .filter(|r| r.kind == Kind::Volume)
    {
        let present = inspect_resource(engine, receipt, resource)?.is_some();
        require_retained_volume(resource, present, remove_data)?;
    }
    Ok(())
}

fn require_retained_volume(
    resource: &Resource,
    present: bool,
    remove_data: bool,
) -> Result<(), CandidateError> {
    if resource.kind != Kind::Volume || remove_data {
        return Ok(());
    }
    match resource.phase.as_str() {
        "created" if !present => Err(error(
            "graph_data_missing",
            "Previously created persistent graph data is missing; cleanup is not confirmed.",
        )),
        "created" | "reserved" | "create-intent" | "absent" => Ok(()),
        _ => Err(refused()),
    }
}
fn cleanup_effect(
    receipt: &Receipt,
    boot: &str,
    remove_data: bool,
    environment: &impl Serialize,
) -> Result<[u8; 32], CandidateError> {
    context(&receipt.owner, boot)?;
    let resources = receipt
        .resources
        .iter()
        .map(|(key, resource)| {
            json!([
                key,
                resource.kind,
                resource.name,
                resource.id,
                resource.image
            ])
        })
        .collect::<Vec<_>>();
    let mut effect = json!([
        "hack-graph-relay-cleanup-v3",
        receipt.owner,
        boot,
        receipt.run,
        receipt.namespace,
        receipt.plan_id,
        remove_data,
        resources,
        receipt.environment_attached,
        environment,
        probes::cleanup_identity(receipt)?
    ]);
    if let Some(startup) = receipt.relay_startup.as_ref().filter(|startup| {
        startup.services.values().any(|service| {
            service
                .bindings
                .values()
                .any(|binding| !binding.aliases.is_empty())
        })
    }) {
        let mut routes = Vec::new();
        for (service_name, service) in &startup.services {
            for (binding_name, binding) in &service.bindings {
                let address = dependency_address(binding.slot, &binding.aliases)?;
                routes.push(json!([
                    service_name,
                    service.generation,
                    binding_name,
                    binding.slot,
                    address,
                    binding.port,
                    binding.aliases
                ]));
            }
        }
        effect[0] = json!("hack-graph-relay-cleanup-v4");
        effect
            .as_array_mut()
            .ok_or_else(refused)?
            .push(json!(routes));
    }
    let outbound = receipt
        .resources
        .iter()
        .filter(|(_, r)| r.outbound)
        .map(|(key, r)| json!([key, r.name, r.outbound]))
        .collect::<Vec<_>>();
    if !outbound.is_empty() {
        effect = json!(["hack-graph-relay-cleanup-network-v1", effect, outbound]);
    }
    let caches = receipt
        .resources
        .iter()
        .filter_map(|(key, resource)| resource.cache.as_ref().map(|cache| json!([key, cache])))
        .collect::<Vec<_>>();
    if !caches.is_empty() {
        // Retain the exact legacy v3/v4 effect inside the new domain; cacheless
        // receipt bytes remain unchanged. Phase is excluded so release can confirm.
        effect = json!(["hack-graph-relay-cleanup-cache-v1", effect, caches]);
    }
    let bytes = serde_json::to_vec(&effect).map_err(|_| refused())?;
    Ok(Sha256::digest(bytes).into())
}
fn cleanup_requires_absence(
    resource: &Resource,
    remove_data: bool,
) -> Result<bool, CandidateError> {
    if remove_data && let Some(cache) = &resource.cache {
        if resource.kind != Kind::Volume
            || resource.phase != "released"
            || !cache.valid()
            || resource.name != cache.name()
        {
            return Err(refused());
        }
        // inspect_resource still independently verifies exact cache ownership if present.
        // A released graph reference is not authority to require/delete shared storage.
        return Ok(false);
    }
    Ok(resource.kind != Kind::Volume || remove_data)
}

fn inspect_cleanup(
    candidate: &Candidate,
    engine: &Engine<'_>,
    expected: &Receipt,
    remove_data: bool,
    environment: &super::super::environment_recovery::GraphInventory,
    bridge_selection: &bridges::cleanup::Selection,
) -> Result<[u8; 32], CandidateError> {
    let (receipt, root) = archive::load_confirmation(candidate, engine, &expected.run)?;
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(refused()),
    }
    if receipt.phase
        != if remove_data {
            "removed"
        } else {
            "stopped-data-retained"
        }
        || cleanup_effect(
            &receipt,
            engine.guest().boot_id(),
            remove_data,
            &(environment, bridge_selection),
        )? != cleanup_effect(
            expected,
            engine.guest().boot_id(),
            remove_data,
            &(environment, bridge_selection),
        )?
    {
        return Err(refused());
    }
    let mut observations = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        let value = inspect_resource(engine, &receipt, resource)?;
        if cleanup_requires_absence(resource, remove_data)? {
            if value.is_some() {
                return Err(refused());
            }
            // A missing immutable ID does not prove its reserved name is unused.
            // Replacements are refused, never adopted or removed by confirmation.
            let mut by_name = resource.clone();
            by_name.id = None;
            if inspect_resource(engine, &receipt, &by_name)?.is_some() {
                return Err(refused());
            }
        }
        require_retained_volume(resource, value.is_some(), remove_data)?;
        observations.insert(key, value);
    }
    if &bridges::cleanup::read(engine, &receipt, &root)? != bridge_selection {
        return Err(refused());
    }
    bridges::cleanup::verify(candidate, engine, &receipt, bridge_selection)?;
    environment::verify_cleanup(candidate, engine, &receipt, &root, environment)?;
    probes::verify_cleanup(engine, &receipt)?;
    startup::verify_cleanup(engine, &receipt)?;
    engine.guest().verify()?;
    let bytes = serde_json::to_vec(&json!([
        "hack-graph-relay-cleanup-observation-v3",
        receipt,
        observations,
        bridge_selection,
        environment
    ]))
    .map_err(|_| refused())?;
    Ok(Sha256::digest(bytes).into())
}

fn generation(
    receipt: &Receipt,
    boot: &str,
    resource: &Resource,
    value: &Value,
) -> Result<[u8; 32], CandidateError> {
    if receipt.phase != "ready-observed" || resource.phase != "started" {
        return Err(refused());
    }
    inspected_generation(receipt, boot, resource, value)
}
pub(super) fn inspected_generation(
    receipt: &Receipt,
    boot: &str,
    resource: &Resource,
    value: &Value,
) -> Result<[u8; 32], CandidateError> {
    context(&receipt.owner, boot)?;
    if resource.kind != Kind::Container
        || resource.id.as_deref() != value["Id"].as_str()
        || !resource.id.as_deref().is_some_and(|id| hex(id, 64))
        || resource.image.as_deref() != value["Image"].as_str()
        || value["State"]["Running"] != true
        || value["State"]["Dead"] == true
        || value["State"]["OOMKilled"] == true
    {
        return Err(refused());
    }
    let started = value["State"]["StartedAt"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && !s.starts_with("0001-")
                && !s.bytes().any(|b| b.is_ascii_control())
        })
        .ok_or_else(refused)?;
    let encoded = serde_json::to_vec(&json!([
        "hack-graph-host-relay-v1",
        receipt.owner,
        boot,
        receipt.run,
        receipt.namespace,
        receipt.plan_id,
        resource.key,
        resource.id,
        resource.image,
        started
    ]))
    .map_err(|_| refused())?;
    let generation: [u8; 32] = Sha256::digest(encoded).into();
    if generation == [0; 32] {
        return Err(refused());
    }
    Ok(generation)
}

/// A short-lived verified service selection holding the actual runtime mutation lease.
/// Registration consumes it and releases the lease before the relay reactor runs.
/// This is not private
/// guest provisioning or retirement-hook integration; no daemon is started here.
pub struct HostRelayService<'a> {
    engine: Engine<'a>,
    candidate: &'a Candidate,
    run: String,
    service: String,
    context: Context,
    generation: [u8; 32],
    scope: GraphScope,
}
impl<'a> HostRelayService<'a> {
    pub fn observe(
        candidate: &'a Candidate,
        run: &str,
        service: &str,
    ) -> Result<Self, CandidateError> {
        let engine = Engine::connect(candidate)?;
        let (context, generation) = select(candidate, &engine, run, service)?;
        Ok(Self {
            engine,
            candidate,
            run: run.into(),
            service: service.into(),
            context,
            generation,
            scope: graph_scope(context, run)?,
        })
    }
    pub fn context(&self) -> Context {
        self.context
    }
    /// Recheck graph/container evidence immediately before creating a grant. The
    /// owner must use the exact verified runtime/boot scope; host identity is checked
    /// again by RelayOwner::register. No caller-supplied service digest is accepted.
    pub fn register(
        self,
        owner: &mut RelayOwner,
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        self.register_binding(owner, "default", endpoint)
    }
    pub fn scope(&self) -> GraphScope {
        self.scope
    }
    /// Register one named host dependency. Names distinguish grants, not routes or
    /// secrets; provisioning must bind them to reviewed configuration separately.
    pub fn register_binding(
        self,
        owner: &mut RelayOwner,
        binding: &str,
        endpoint: HostEndpoint,
    ) -> Result<Grant, CandidateError> {
        let identity = binding_identity(self.generation, binding)?;
        let (context, generation) = select(self.candidate, &self.engine, &self.run, &self.service)?;
        if !owner.matches_context(context)
            || context.runtime != self.context.runtime
            || context.boot != self.context.boot
            || generation != self.generation
        {
            return Err(refused());
        }
        self.engine.guest().verify()?;
        owner.register_graph(self.scope, identity, endpoint)
    }
}
pub(super) fn graph_scope(context: Context, run: &str) -> Result<GraphScope, CandidateError> {
    if !hex(run, 32) {
        return Err(refused());
    }
    let mut hash = Sha256::new();
    hash.update(b"Hack graph relay scope v1\0");
    hash.update(context.runtime);
    hash.update(run.as_bytes());
    GraphScope::new(context, hash.finalize().into())
}
pub(super) fn binding_identity(
    service: [u8; 32],
    binding: &str,
) -> Result<[u8; 32], CandidateError> {
    if binding.is_empty()
        || binding.len() > 128
        || !binding
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err(refused());
    }
    let mut hash = Sha256::new();
    hash.update(b"Hack graph relay dependency v1\0");
    hash.update(service);
    hash.update(binding.as_bytes());
    Ok(hash.finalize().into())
}

/// Bind named listener routes to the grant while preserving legacy aliasless identities.
pub(super) fn named_binding_identity(
    service: [u8; 32],
    name: &str,
    binding: &startup::Binding,
) -> Result<[u8; 32], CandidateError> {
    let legacy = binding_identity(service, name)?;
    if binding.aliases.is_empty() {
        return Ok(legacy);
    }
    if binding.port == 0 {
        return Err(refused());
    }
    let address = dependency_address(binding.slot, &binding.aliases)?;
    let bytes = serde_json::to_vec(&json!([
        "hack-graph-relay-named-dependency-v1",
        legacy,
        binding.slot,
        address,
        binding.port,
        binding.aliases,
    ]))
    .map_err(|_| refused())?;
    Ok(Sha256::digest(bytes).into())
}

fn select(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
    service: &str,
) -> Result<(Context, [u8; 32]), CandidateError> {
    let (receipt, root) = load(candidate, engine, run)?;
    // Any interrupted graph transition must be reconciled, not adopted as a grant.
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(refused()),
    }
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    let value = inspect_resource(engine, &receipt, resource)?.ok_or_else(refused)?;
    let boot = engine.guest().boot_id();
    let generation = generation(&receipt, boot, resource, &value)?;
    engine.guest().verify()?;
    Ok((context(&receipt.owner, boot)?, generation))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Receipt, Resource, Value) {
        let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
        let resource = Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: "web".into(),
            name: "owned-web".into(),
            id: Some("e".repeat(64)),
            image: Some(format!("sha256:{}", "f".repeat(64))),
            phase: "started".into(),
        };
        let value = json!({"Id":resource.id,"Image":resource.image,"State":{"Running":true,"StartedAt":"2026-09-17T00:00:00Z"}});
        (receipt, resource, value)
    }
    #[test]
    fn retained_container_restart_and_new_boot_invalidate_service_identity() {
        let (receipt, resource, mut value) = fixture();
        let first = generation(&receipt, "boot-1", &resource, &value).unwrap();
        value["State"]["StartedAt"] = json!("2026-09-17T00:01:00Z");
        assert_ne!(
            first,
            generation(&receipt, "boot-1", &resource, &value).unwrap()
        );
        assert_ne!(
            generation(&receipt, "boot-1", &resource, &value).unwrap(),
            generation(&receipt, "boot-2", &resource, &value).unwrap()
        );
    }
    #[test]
    fn different_graph_service_and_container_cannot_share_identity() {
        let (mut receipt, mut resource, mut value) = fixture();
        let first = generation(&receipt, "boot", &resource, &value).unwrap();
        receipt.run = "9".repeat(32);
        let second = generation(&receipt, "boot", &resource, &value).unwrap();
        assert_ne!(first, second);
        resource.key = "worker".into();
        let third = generation(&receipt, "boot", &resource, &value).unwrap();
        assert_ne!(second, third);
        resource.id = Some("8".repeat(64));
        value["Id"] = json!(resource.id);
        assert_ne!(
            third,
            generation(&receipt, "boot", &resource, &value).unwrap()
        );
    }
    #[test]
    fn uncertain_or_stopped_service_cannot_create_identity() {
        let (receipt, resource, value) = fixture();
        for state in [
            json!({"Running":false,"StartedAt":"2026-09-17T00:00:00Z"}),
            json!({"Running":true,"StartedAt":"0001-01-01T00:00:00Z"}),
            json!({"Running":true,"StartedAt":"2026-09-17T00:00:00Z","Dead":true}),
            json!({"Running":true,"StartedAt":"2026-09-17T00:00:00Z","OOMKilled":true}),
        ] {
            let mut changed = value.clone();
            changed["State"] = state;
            assert!(generation(&receipt, "boot", &resource, &changed).is_err());
        }
        let mut changed = value.clone();
        changed["Id"] = json!("9".repeat(64));
        assert!(generation(&receipt, "boot", &resource, &changed).is_err());
        let mut changed = receipt.clone();
        changed.phase = "restarting".into();
        assert!(generation(&changed, "boot", &resource, &value).is_err());
        let mut changed = resource.clone();
        changed.phase = "start-intent".into();
        assert!(generation(&receipt, "boot", &changed, &value).is_err());
    }
    #[test]
    fn named_dependencies_and_service_restarts_have_distinct_bindings() {
        let first = binding_identity([1; 32], "search.internal").unwrap();
        assert_ne!(
            first,
            binding_identity([1; 32], "database.internal").unwrap()
        );
        assert_ne!(first, binding_identity([2; 32], "search.internal").unwrap());
        for invalid in [
            "",
            "search INTERNAL",
            "Search",
            "../secret/value",
            "secret\n",
            &"a".repeat(129),
        ] {
            assert!(binding_identity([1; 32], invalid).is_err());
        }
    }
    #[test]
    fn cleanup_identity_binds_data_policy_plan_runtime_and_boot() {
        let (mut receipt, _, _) = fixture();
        let baseline = cleanup_effect(&receipt, "boot-1", false, &json!([])).unwrap();
        assert_ne!(
            baseline,
            cleanup_effect(&receipt, "boot-1", true, &json!([])).unwrap()
        );
        assert_ne!(
            baseline,
            cleanup_effect(&receipt, "boot-2", false, &json!([])).unwrap()
        );
        receipt.plan_id = "1".repeat(64);
        assert_ne!(
            baseline,
            cleanup_effect(&receipt, "boot-1", false, &json!([])).unwrap()
        );
        receipt.plan_id = "d".repeat(64);
        receipt.owner = "2".repeat(32);
        assert_ne!(
            baseline,
            cleanup_effect(&receipt, "boot-1", false, &json!([])).unwrap()
        );
    }

    #[test]
    fn cleanup_identity_binds_environment_inventory_and_marker() {
        let (mut receipt, _, _) = fixture();
        let before = cleanup_effect(&receipt, "boot", false, &json!(["allocation-a"])).unwrap();
        assert_ne!(
            before,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
        receipt.environment_attached = true;
        assert_ne!(
            before,
            cleanup_effect(&receipt, "boot", false, &json!(["allocation-a"])).unwrap()
        );
    }

    #[test]
    fn cleanup_identity_preserves_retirement_but_rejects_changed_or_missing_probe() {
        let (mut receipt, resource, _) = fixture();
        receipt.resources.insert("container:web".into(), resource);
        receipt.probes.insert(
            "web".into(),
            probes::Probe {
                config: super::super::super::http_probe::HttpProbe {
                    port: 8080,
                    path: "/".into(),
                    interval_ms: 1000,
                    timeout_ms: 100,
                    retries: 1,
                    start_period_ms: 0,
                },
                allocation: "1".repeat(32),
                generation: "2".repeat(32),
                binary: format!("/storage/hack-native-http-probe/{}", "3".repeat(64)),
                uid: 0,
                gid: 0,
                exec_id: None,
                started_ms: 0,
                phase: "reserved".into(),
            },
        );
        let before = cleanup_effect(&receipt, "boot", false, &json!([])).unwrap();
        receipt.probes.get_mut("web").unwrap().phase = "retired".into();
        assert_eq!(
            before,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
        receipt.probes.get_mut("web").unwrap().generation = "4".repeat(32);
        assert_ne!(
            before,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
        receipt.probes.clear();
        assert_ne!(
            before,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
    }

    fn startup_fixture(aliases: Vec<String>) -> startup::Startup {
        startup::Startup {
            control_only: false,
            guest_root: None,
            control_root: "/private/tmp/owned-fixture".into(),
            artifact: "a".repeat(64),
            services: BTreeMap::from([(
                "web".into(),
                startup::Service {
                    generation: "b".repeat(32),
                    bindings: BTreeMap::from([(
                        "search".into(),
                        startup::Binding {
                            slot: 0,
                            port: 443,
                            aliases,
                            process: None,
                        },
                    )]),
                    phase: startup::Phase::Prepared,
                    started_at: None,
                },
            )]),
        }
    }
    #[test]
    fn named_grant_identity_binds_alias_slot_address_and_port() {
        let startup = startup_fixture(vec!["search.example".into()]);
        let binding = &startup.services["web"].bindings["search"];
        let before = named_binding_identity([1; 32], "search", binding).unwrap();
        for changed in [
            startup::Binding {
                aliases: vec!["other.example".into()],
                ..binding.clone()
            },
            startup::Binding {
                slot: 1,
                ..binding.clone()
            },
            startup::Binding {
                port: 8443,
                ..binding.clone()
            },
        ] {
            assert_ne!(
                before,
                named_binding_identity([1; 32], "search", &changed).unwrap()
            );
        }
        let legacy = startup::Binding {
            aliases: vec![],
            ..binding.clone()
        };
        assert_eq!(
            named_binding_identity([1; 32], "search", &legacy).unwrap(),
            binding_identity([1; 32], "search").unwrap()
        );
    }
    #[test]
    fn named_cleanup_evidence_rejects_changed_routes_but_preserves_legacy_digest() {
        let (mut receipt, _, _) = fixture();
        let legacy = cleanup_effect(&receipt, "boot", false, &json!([])).unwrap();
        receipt.relay_startup = Some(startup_fixture(vec![]));
        assert_eq!(
            legacy,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
        receipt.relay_startup = Some(startup_fixture(vec!["search.example".into()]));
        let named = cleanup_effect(&receipt, "boot", false, &json!([])).unwrap();
        assert_ne!(legacy, named);
        for field in ["aliases", "slot", "port", "generation", "missing"] {
            let mut changed = receipt.clone();
            let service = changed
                .relay_startup
                .as_mut()
                .unwrap()
                .services
                .get_mut("web")
                .unwrap();
            let binding = service.bindings.get_mut("search").unwrap();
            match field {
                "aliases" => binding.aliases = vec!["other.example".into()],
                "slot" => binding.slot = 1,
                "port" => binding.port = 8443,
                "generation" => service.generation = "c".repeat(32),
                _ => service.bindings.clear(),
            }
            assert_ne!(
                named,
                cleanup_effect(&changed, "boot", false, &json!([])).unwrap()
            );
        }
        let startup = receipt.relay_startup.as_mut().unwrap();
        startup.guest_root = Some((1, 2));
        startup.services.get_mut("web").unwrap().phase = startup::Phase::Released;
        assert_eq!(
            named,
            cleanup_effect(&receipt, "boot", false, &json!([])).unwrap()
        );
    }

    #[test]
    fn enrolled_cleanup_releases_shared_cache_and_binds_full_cache_identity() {
        let (mut receipt, mut resource, _) = fixture();
        resource.kind = Kind::Volume;
        resource.id = None;
        resource.image = None;
        resource.phase = "created".into();
        let cache = dependency_cache::CacheBinding {
            scope: "1".repeat(64),
            fingerprint: "2".repeat(64),
            image: format!("sha256:{}", "3".repeat(64)),
        };
        resource.name = cache.name();
        // Legacy effect must differ even when resource name already has cache-like shape.
        receipt
            .resources
            .insert("volume:web".into(), resource.clone());
        let legacy = cleanup_effect(&receipt, "boot", true, &json!([])).unwrap();
        resource.cache = Some(cache);
        receipt
            .resources
            .insert("volume:web".into(), resource.clone());
        let initial = cleanup_effect(&receipt, "boot", true, &json!([])).unwrap();
        assert_ne!(legacy, initial);
        assert!(cleanup_requires_absence(&resource, true).is_err());
        assert!(!cleanup_requires_absence(&resource, false).unwrap());
        resource.phase = "released".into();
        assert!(!cleanup_requires_absence(&resource, true).unwrap());
        receipt
            .resources
            .insert("volume:web".into(), resource.clone());
        assert_eq!(
            initial,
            cleanup_effect(&receipt, "boot", true, &json!([])).unwrap()
        );
        for field in ["scope", "fingerprint", "image"] {
            let mut changed = receipt.clone();
            let cache = changed
                .resources
                .get_mut("volume:web")
                .unwrap()
                .cache
                .as_mut()
                .unwrap();
            match field {
                "scope" => cache.scope = "4".repeat(64),
                "fingerprint" => cache.fingerprint = "5".repeat(64),
                _ => cache.image = format!("sha256:{}", "6".repeat(64)),
            }
            assert_ne!(
                initial,
                cleanup_effect(&changed, "boot", true, &json!([])).unwrap()
            );
        }
        resource.cache = None;
        assert!(cleanup_requires_absence(&resource, true).unwrap());
    }

    #[test]
    fn enrolled_cleanup_cannot_confirm_missing_created_data() {
        let (_, mut resource, _) = fixture();
        resource.kind = Kind::Volume;
        resource.phase = "created".into();
        assert!(require_retained_volume(&resource, false, false).is_err());
        assert!(require_retained_volume(&resource, true, false).is_ok());
        assert!(require_retained_volume(&resource, false, true).is_ok());
        for phase in ["reserved", "create-intent", "absent"] {
            resource.phase = phase.into();
            assert!(require_retained_volume(&resource, false, false).is_ok());
        }
        for phase in ["uncertain", "started", "restart-reserved"] {
            resource.phase = phase.into();
            assert!(require_retained_volume(&resource, false, false).is_err());
        }
    }

    #[test]
    fn owner_scope_is_domain_separated_and_boot_specific() {
        let one = context(&"a".repeat(32), "boot-1").unwrap();
        let two = context(&"a".repeat(32), "boot-2").unwrap();
        assert_eq!(one.runtime, two.runtime);
        assert_ne!(one.boot, two.boot);
        let owner = RelayOwner::new(
            one,
            crate::provider::relay_owner::OwnerLimits {
                registrations: 1,
                controls: 1,
                relay: crate::provider::relay_loop::Limits {
                    max_flows: 1,
                    connect_timeout: Duration::from_secs(1),
                    idle_timeout: Duration::from_secs(1),
                },
            },
        )
        .unwrap();
        assert!(owner.matches_context(one));
        assert!(!owner.matches_context(two));
        assert_ne!(
            one.runtime,
            context(&"b".repeat(32), "boot-1").unwrap().runtime
        );
        assert!(context("bad", "boot").is_err());
        assert!(context(&"a".repeat(32), "").is_err());
    }
}

#[cfg(test)]
mod live_tests;
