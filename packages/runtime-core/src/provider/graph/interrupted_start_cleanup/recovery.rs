//! A fresh journal for one interrupted cleanup. A pending step is never sent
//! again: only independently observed terminal or absent state advances it.
use super::*;
use crate::provider::relay_owner::lifecycle_intent::Coordinator;

fn stale_generation() -> CandidateError {
    error(
        "graph_interrupted_start_cleanup_stale",
        "Completed interrupted cleanup evidence belongs to an earlier resource generation; no old cleanup effect was replayed.",
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Journal {
    pub(super) version: u8,
    pub(super) selection: Selection,
    pub(super) selection_sha256: String,
    pub(super) original: Receipt,
    pub(super) steps: Vec<Step>,
    pub(super) cursor: usize,
    pub(super) pending: bool,
    pub(super) graph_complete: bool,
    pub(super) publisher_retired: bool,
    pub(super) reservation_released: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Step {
    Stop(String),
    Delete(String),
    Startup,
    Probe(String),
    Environment(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StopDecision {
    AlreadyTerminal,
    IssueOneStop,
}

pub(super) fn stop_decision(
    resource: &Resource,
    observed: &Value,
    pending: bool,
) -> Result<StopDecision, CandidateError> {
    let prepared = shutdown::prepare(resource, observed)?;
    if prepared.id != resource.id.as_deref().ok_or_else(refused)? {
        return Err(refused());
    }
    if pending {
        shutdown::terminal(resource, observed, true)?;
        Ok(StopDecision::AlreadyTerminal)
    } else if prepared.running {
        Ok(StopDecision::IssueOneStop)
    } else {
        shutdown::terminal(resource, observed, false)?;
        Ok(StopDecision::AlreadyTerminal)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Acknowledgement {
    Confirm,
    Complete,
}

pub(super) fn acknowledgement(
    marker: cleanup_enrollment::Phase,
    coordinator: Phase,
    pending: bool,
    selected: bool,
) -> Result<Acknowledgement, CandidateError> {
    if !selected {
        return Err(refused());
    }
    match (marker, coordinator, pending) {
        (cleanup_enrollment::Phase::Pending, Phase::EffectStarted, true)
        | (cleanup_enrollment::Phase::Pending, Phase::Confirmed, true)
        | (cleanup_enrollment::Phase::Confirmed, Phase::Confirmed, true) => {
            Ok(Acknowledgement::Confirm)
        }
        (cleanup_enrollment::Phase::Confirmed, Phase::Confirmed, false) => {
            Ok(Acknowledgement::Complete)
        }
        _ => Err(refused()),
    }
}

pub(super) fn steps(receipt: &Receipt, slots: &[String]) -> Result<Vec<Step>, CandidateError> {
    if receipt.resources.len() > MAX_SERVICES + MAX_NETWORKS + MAX_SERVICES * 8
        || receipt.probes.len() > MAX_SERVICES
    {
        return Err(refused());
    }
    let mut result = Vec::new();
    for (key, resource) in &receipt.resources {
        if resource.kind == Kind::Container && resource.id.is_some() {
            result.push(Step::Stop(key.clone()));
        }
    }
    for kind in [Kind::Container, Kind::Network] {
        for (key, resource) in &receipt.resources {
            if resource.kind == kind {
                result.push(Step::Delete(key.clone()));
            }
        }
    }
    result.push(Step::Startup);
    for name in receipt.probes.keys() {
        result.push(Step::Probe(name.clone()));
    }
    for slot in slots {
        result.push(Step::Environment(slot.clone()));
    }
    Ok(result)
}

impl Journal {
    fn new(proof: &Proof<'_>) -> Result<Self, CandidateError> {
        Ok(Self {
            version: 1,
            selection: proof.selected.clone(),
            selection_sha256: proof.selected.digest()?,
            original: proof.original.clone(),
            steps: steps(&proof.original, &proof.environment.slots())?,
            cursor: 0,
            pending: false,
            graph_complete: false,
            publisher_retired: false,
            reservation_released: false,
        })
    }
    pub(super) fn validate_basic(&self, run: &str, expected: &str) -> Result<(), CandidateError> {
        if self.version != 1
            || self.selection.version != 1
            || self.selection.run != run
            || self.original.run != run
            || self.original.owner != self.selection.owner
            || self.selection.digest()? != self.selection_sha256
            || self.selection_sha256 != expected
            || self.cursor > self.steps.len()
            || (self.graph_complete && (self.cursor != self.steps.len() || self.pending))
            || (self.publisher_retired && !self.graph_complete)
            || (self.reservation_released && !self.publisher_retired)
            || !self
                .original
                .resources
                .get(&self.selection.failed_key)
                .is_some_and(|resource| {
                    resource.kind == Kind::Container
                        && resource.phase == "uncertain"
                        && resource.id.as_deref() == Some(self.selection.failed_id.as_str())
                })
            || digest(&serde_json::to_vec_pretty(&self.original).map_err(|_| refused())?)
                != self.selection.receipt_sha256
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn validate_phase(&self, current: &Receipt) -> Result<(), CandidateError> {
        match current.phase.as_str() {
            "cleanup-intent" if !self.graph_complete => Ok(()),
            "stopped-data-retained" if self.cursor == self.steps.len() && !self.pending => Ok(()),
            _ => Err(refused()),
        }
    }
    fn write(&self, root: &Path) -> Result<(), CandidateError> {
        state::write(&root.join(JOURNAL), self)
    }
}

pub(super) fn validate_retry(proof: &Proof<'_>, journal: &Journal) -> Result<(), CandidateError> {
    journal.validate_basic(&proof.selected.run, &proof.selected.digest()?)?;
    journal.validate_phase(&proof.current)?;
    if journal.selection != proof.selected
        || journal.steps != steps(&proof.original, &proof.environment.slots())?
        || journal.original.run != proof.original.run
        || dead_owner_cleanup::immutable(&journal.original)?
            != dead_owner_cleanup::immutable(&proof.original)?
    {
        return Err(refused());
    }
    Ok(())
}

fn fence(
    proof: &Proof<'_>,
    coordinator: &Coordinator,
    journal: &Journal,
) -> Result<(), CandidateError> {
    proof.verify()?;
    journal.validate_basic(&proof.selected.run, &proof.selected.digest()?)?;
    let current = super::journal(&proof.root)?.ok_or_else(refused)?;
    if serde_json::to_value(&current).map_err(|_| refused())?
        != serde_json::to_value(journal).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let marker = proof.current.relay_cleanup.as_ref().ok_or_else(refused)?;
    let graph = host_relay::graph_scope(marker.selection().context, &proof.selected.run)?;
    coordinator.verify_selected_effect(
        &marker.selection(),
        graph,
        proof.relay_owner,
        proof.owner.process(),
        proof.relay_publication,
        &proof.selected.coordinator_identity_sha256,
    )?;
    if digest(&host_pin_recovery::read_raw(
        &marker.control_root.join("relay-lifecycle/state.json"),
        128 * 1024,
    )?) != proof.selected.coordinator_sha256
    {
        return Err(refused());
    }
    Ok(())
}

fn absent(proof: &Proof<'_>, resource: &Resource) -> Result<bool, CandidateError> {
    if inspect_resource(&proof.engine, &proof.current, resource)?.is_some() {
        return Ok(false);
    }
    let mut by_name = resource.clone();
    by_name.id = None;
    Ok(inspect_resource(&proof.engine, &proof.current, &by_name)?.is_none())
}

fn advance_stop(
    proof: &Proof<'_>,
    coordinator: &Coordinator,
    journal: &mut Journal,
    key: &str,
) -> Result<(), CandidateError> {
    let resource = proof.original.resources.get(key).ok_or_else(refused)?;
    let value = inspect_resource(&proof.engine, &proof.current, resource)?.ok_or_else(refused)?;
    if key == proof.selected.failed_key {
        failed_created(resource, &value)?;
    }
    if stop_decision(resource, &value, journal.pending)? == StopDecision::IssueOneStop {
        let prepared = shutdown::prepare(resource, &value)?;
        journal.pending = true;
        journal.write(&proof.root)?;
        fence(proof, coordinator, journal)?;
        proof
            .engine
            .stop_containers(&[(prepared.id.clone(), u64::from(prepared.grace_seconds))])?;
        let latest =
            inspect_resource(&proof.engine, &proof.current, resource)?.ok_or_else(refused)?;
        shutdown::terminal(resource, &latest, true)?;
    }
    journal.cursor += 1;
    journal.pending = false;
    journal.write(&proof.root)
}

fn advance_delete(
    proof: &Proof<'_>,
    coordinator: &Coordinator,
    journal: &mut Journal,
    key: &str,
) -> Result<(), CandidateError> {
    let resource = proof.original.resources.get(key).ok_or_else(refused)?;
    if resource.kind != Kind::Container && resource.kind != Kind::Network {
        return Err(refused());
    }
    if journal.pending || resource.id.is_none() {
        if !absent(proof, resource)? {
            return Err(refused());
        }
    } else {
        let value =
            inspect_resource(&proof.engine, &proof.current, resource)?.ok_or_else(refused)?;
        let id = value["Id"]
            .as_str()
            .filter(|id| Some(*id) == resource.id.as_deref())
            .ok_or_else(refused)?;
        if resource.kind == Kind::Container {
            shutdown::terminal(resource, &value, false)?;
        }
        journal.pending = true;
        journal.write(&proof.root)?;
        fence(proof, coordinator, journal)?;
        proof.engine.request(
            Method::DELETE,
            &format!(
                "/v1.53/{}/{id}{}",
                resource.kind.collection(),
                if resource.kind == Kind::Container {
                    "?v=true"
                } else {
                    ""
                }
            ),
            None,
        )?;
        if !absent(proof, resource)? {
            return Err(refused());
        }
    }
    journal.cursor += 1;
    journal.pending = false;
    journal.write(&proof.root)
}

fn advance_other(
    proof: &Proof<'_>,
    coordinator: &Coordinator,
    journal: &mut Journal,
    step: &Step,
) -> Result<(), CandidateError> {
    let verify = || -> Result<(), CandidateError> {
        match step {
            Step::Startup => startup::verify_cleanup(&proof.engine, &proof.current),
            Step::Probe(name) => probes::verify_one_absent(&proof.engine, &proof.current, name),
            Step::Environment(slot) => {
                super::super::super::environment_recovery::verify_graph_slot_retired(
                    proof.engine.guest(),
                    &proof.environment,
                    slot,
                )
            }
            _ => Err(refused()),
        }
    };
    if journal.pending {
        verify()?;
    } else if verify().is_err() {
        journal.pending = true;
        journal.write(&proof.root)?;
        fence(proof, coordinator, journal)?;
        match step {
            Step::Startup => startup::cleanup_guest(&proof.engine, &proof.current, true)?,
            Step::Probe(name) => probes::retire_one(&proof.engine, &proof.current, name)?,
            Step::Environment(slot) => super::super::super::environment_recovery::retire(
                proof.candidate,
                proof.engine.guest(),
                slot,
                None,
            )?,
            _ => return Err(refused()),
        }
        verify()?;
    }
    journal.cursor += 1;
    journal.pending = false;
    journal.write(&proof.root)
}

fn complete_graph(proof: &Proof<'_>, journal: &mut Journal) -> Result<(), CandidateError> {
    if journal.cursor != journal.steps.len() || journal.pending {
        return Err(refused());
    }
    let mut cleaned = proof.current.clone();
    for resource in cleaned.resources.values_mut() {
        match resource.kind {
            Kind::Volume => {
                if resource.cache.is_some() {
                    return Err(refused());
                }
                if resource.phase != "created" {
                    return Err(refused());
                }
            }
            _ => resource.phase = "absent".into(),
        }
    }
    for probe in cleaned.probes.values_mut() {
        probe.phase = "retired".into();
    }
    cleaned.phase = "stopped-data-retained".into();
    for resource in proof
        .original
        .resources
        .values()
        .filter(|r| r.kind != Kind::Volume)
    {
        if !absent(proof, resource)? {
            return Err(refused());
        }
    }
    startup::verify_cleanup(&proof.engine, &cleaned)?;
    probes::verify_cleanup(&proof.engine, &cleaned)?;
    environment::verify_cleanup(
        proof.candidate,
        &proof.engine,
        &cleaned,
        &proof.root,
        &proof.environment,
    )?;
    state::write(&proof.root.join("state.json"), &cleaned)?;
    host_relay::inspect_cleanup(
        proof.candidate,
        &proof.engine,
        &cleaned,
        false,
        &proof.environment,
        &proof.bridges,
    )?;
    journal.graph_complete = true;
    journal.write(&proof.root)
}

pub(super) fn recover(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    let root = directory(candidate, run)?;
    if let Some(existing) = journal(&root)? {
        existing.validate_basic(run, expected)?;
        if existing.graph_complete {
            return finish(candidate, run, &existing);
        }
    }
    let proof = select(candidate, run)?;
    if proof.selected.digest()? != expected {
        return Err(refused());
    }
    let mut journal = match journal(&proof.root)? {
        Some(existing) => {
            validate_retry(&proof, &existing)?;
            existing
        }
        None => {
            let created = Journal::new(&proof)?;
            created.write(&proof.root)?;
            created
        }
    };
    let marker = proof.current.relay_cleanup.as_ref().ok_or_else(refused)?;
    let coordinator = Coordinator::resume(&marker.control_root, marker.selection())?;
    fence(&proof, &coordinator, &journal)?;
    while journal.cursor < journal.steps.len() {
        fence(&proof, &coordinator, &journal)?;
        let step = journal.steps[journal.cursor].clone();
        match &step {
            Step::Stop(key) => advance_stop(&proof, &coordinator, &mut journal, key)?,
            Step::Delete(key) => advance_delete(&proof, &coordinator, &mut journal, key)?,
            _ => advance_other(&proof, &coordinator, &mut journal, &step)?,
        }
    }
    if !journal.graph_complete {
        fence(&proof, &coordinator, &journal)?;
        complete_graph(&proof, &mut journal)?;
    }
    drop(coordinator);
    drop(proof);
    finish(candidate, run, &journal)
}

fn validate_finished<'a>(
    candidate: &'a Candidate,
    run: &str,
    record: &Journal,
) -> Result<(Engine<'a>, Receipt, PathBuf, bool, dead::CleanupWitness), CandidateError> {
    record.validate_basic(run, &record.selection_sha256)?;
    if !record.graph_complete {
        return Err(refused());
    }
    let selection = &record.selection;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    if receipt.phase != "stopped-data-retained" {
        return Err(stale_generation());
    }
    no_pending(&root)?;
    let persisted = journal(&root)?.ok_or_else(refused)?;
    if serde_json::to_value(&persisted).map_err(|_| refused())?
        != serde_json::to_value(record).map_err(|_| refused())?
        || receipt.phase != "stopped-data-retained"
        || receipt.owner != selection.owner
        || engine.guest().boot_id() != selection.boot
    {
        return Err(refused());
    }
    let mut expected_receipt = record.original.clone();
    expected_receipt.phase = "stopped-data-retained".into();
    for resource in expected_receipt.resources.values_mut() {
        if resource.kind != Kind::Volume {
            resource.phase = "absent".into();
        }
    }
    for probe in expected_receipt.probes.values_mut() {
        probe.phase = "retired".into();
    }
    expected_receipt
        .relay_cleanup
        .as_mut()
        .ok_or_else(refused)?
        .phase = receipt.relay_cleanup.as_ref().ok_or_else(refused)?.phase;
    if serde_json::to_value(&receipt).map_err(|_| refused())?
        != serde_json::to_value(&expected_receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let inventory = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    if record.steps != steps(&record.original, &inventory.slots())?
        || digest(&serde_json::to_vec(&inventory).map_err(|_| refused())?)
            != selection.environment_sha256
    {
        return Err(refused());
    }
    let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
    let original_marker = record.original.relay_cleanup.as_ref().ok_or_else(refused)?;
    if !marker.valid()
        || marker.runtime != original_marker.runtime
        || marker.boot != original_marker.boot
        || marker.operation != original_marker.operation
        || marker.effect != original_marker.effect
        || marker.control_root != original_marker.control_root
    {
        return Err(refused());
    }
    let context = host_relay::context(&selection.owner, &selection.boot)?;
    let inspected = Inspection::load(&marker.control_root, context)?;
    let relay = dead::CleanupWitness::acquire(&marker.control_root, context, &inspected.process)?;
    if inspected.graph != Some(host_relay::graph_scope(context, run)?)
        || inspected.selection.context != marker.selection().context
        || inspected.selection.operation != marker.operation
        || inspected.selection.effect != marker.effect
        || inspected.recovery_fingerprint != selection.coordinator_identity_sha256
        || inspected.owner == [0; 16]
        || inspected.publication == [0; 32]
        || relay.selection_sha256()? != selection.relay_sha256
        || relay
            .present_identity()
            .is_some_and(|(relay_owner, relay_publication)| {
                inspected.owner != relay_owner || inspected.publication != relay_publication
            })
        || digest(&host_pin_recovery::read_raw(
            &root.join("relay-cleanup-bridges.json"),
            65536,
        )?) != selection.bridge_sha256
    {
        return Err(refused());
    }
    if marker.phase == cleanup_enrollment::Phase::Pending
        && inspected.phase == Phase::EffectStarted
        && digest(&host_pin_recovery::read_raw(
            &marker.control_root.join("relay-lifecycle/state.json"),
            128 * 1024,
        )?) != selection.coordinator_sha256
    {
        return Err(refused());
    }
    let status = acknowledgement(
        marker.phase,
        inspected.phase,
        inspected.acknowledgement_pending,
        inspected.selection_observed,
    )?;
    if record.publisher_retired && status != Acknowledgement::Complete {
        return Err(refused());
    }
    let bridges = bridges::cleanup::read(&engine, &receipt, &root)?;
    host_relay::inspect_cleanup(candidate, &engine, &receipt, false, &inventory, &bridges)?;
    Ok((
        engine,
        receipt,
        root,
        status == Acknowledgement::Confirm,
        relay,
    ))
}

pub(super) fn inspect_completed(
    candidate: &Candidate,
    run: &str,
    record: &Journal,
) -> Result<Value, CandidateError> {
    let (_engine, _receipt, _root, _needs_confirmation, _relay) =
        validate_finished(candidate, run, record)?;
    Ok(
        json!({"run":run,"phase":"stopped-data-retained","eligible":true,
        "selection_sha256":record.selection_sha256,"data_retained":true,"same_boot":true}),
    )
}

fn finish(candidate: &Candidate, run: &str, record: &Journal) -> Result<Value, CandidateError> {
    let (engine, mut receipt, root, needs_confirmation, relay) =
        validate_finished(candidate, run, record)?;
    let selection = &record.selection;
    if needs_confirmation {
        let marker = receipt.relay_cleanup.as_ref().ok_or_else(refused)?;
        let control_root = marker.control_root.clone();
        let selected = marker.selection();
        relay.verify()?;
        drop(relay);
        drop(engine);
        receipt = host_relay::confirm_relay_cleanup_selected(
            candidate,
            run,
            false,
            &control_root,
            selected,
            &selection.coordinator_identity_sha256,
            &selection.relay_sha256,
        )?;
    } else {
        if receipt.relay_cleanup.as_ref().ok_or_else(refused)?.phase
            != cleanup_enrollment::Phase::Confirmed
        {
            return Err(refused());
        }
        drop(relay);
        drop(engine);
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (current, current_root) = load(candidate, &engine, run)?;
    if current_root != root
        || serde_json::to_value(&current).map_err(|_| refused())?
            != serde_json::to_value(&receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let environment = environment::cleanup_inventory(candidate, &engine, &current, &root)?;
    let bridges = bridges::cleanup::read(&engine, &current, &root)?;
    host_relay::inspect_cleanup(candidate, &engine, &current, false, &environment, &bridges)?;
    startup::archive_dependency_rebind_after_cleanup(
        &root,
        &record.original,
        &current,
        &selection.boot,
    )?;
    let receipt_sha256 = digest(&host_pin_recovery::read_raw(
        &root.join("state.json"),
        LIMIT,
    )?);
    drop(engine);
    let publisher = acknowledged_publisher::AcknowledgedPublisherSelection {
        run,
        owner: &selection.owner,
        receipt_sha256: &receipt_sha256,
        publisher_sha256: &selection.foreground_sha256,
    };
    acknowledged_publisher::retire(candidate, publisher)?;
    let mut progress = record.clone();
    if !progress.publisher_retired {
        verify_journal_exact(&root, &progress)?;
        progress.publisher_retired = true;
        progress.write(&root)?;
    }
    let publisher = acknowledged_publisher::AcknowledgedPublisherSelection {
        run,
        owner: &selection.owner,
        receipt_sha256: &receipt_sha256,
        publisher_sha256: &selection.foreground_sha256,
    };
    acknowledged_publisher::release_dependencies(
        candidate,
        publisher,
        &selection.reservation_sha256,
    )?;
    if !progress.reservation_released {
        verify_journal_exact(&root, &progress)?;
        progress.reservation_released = true;
        progress.write(&root)?;
    }
    Ok(
        json!({"run":run,"phase":"stopped-data-retained","recovered":true,
        "data_retained":true,"same_boot":true,"publisher_retired":true,"reservation_released":true}),
    )
}

fn verify_journal_exact(root: &Path, expected: &Journal) -> Result<(), CandidateError> {
    let observed = super::journal(root)?.ok_or_else(refused)?;
    if serde_json::to_value(observed).map_err(|_| refused())?
        != serde_json::to_value(expected).map_err(|_| refused())?
    {
        return Err(refused());
    }
    Ok(())
}
