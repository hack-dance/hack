//! Explicit, once-only guest page/dentry cache release. Package files are untouched.
use super::*;
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Selected,
    Pending,
    Released,
    SkippedBusy,
    SkippedIneligible,
    AbortedBootChange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub boot: String,
    pub container: String,
    pub started_at: String,
    pub finished_at: String,
    pub volume: String,
    pub cache_fingerprint: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_millis: Option<u64>,
}
fn refused() -> CandidateError {
    error(
        "graph_cache_release",
        "Initializer cache release requires certain quiescent ownership; pending effects are never replayed.",
    )
}
impl Record {
    pub(super) fn selected() -> Self {
        Self {
            phase: Phase::Selected,
            binding: None,
            elapsed_millis: None,
        }
    }
    fn valid(&self) -> bool {
        let binding = self.binding.as_ref().is_some_and(|b| {
            hex(&b.container, 64)
                && hex(&b.cache_fingerprint, 64)
                && [
                    b.boot.as_str(),
                    b.started_at.as_str(),
                    b.finished_at.as_str(),
                    b.volume.as_str(),
                ]
                .iter()
                .all(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        });
        match self.phase {
            Phase::Selected | Phase::SkippedIneligible => {
                self.binding.is_none() && self.elapsed_millis.is_none()
            }
            Phase::Pending | Phase::SkippedBusy | Phase::AbortedBootChange => {
                binding && self.elapsed_millis.is_none()
            }
            Phase::Released => binding && self.elapsed_millis.is_some(),
        }
    }
}
pub(super) fn validate_selection(
    selected: &BTreeSet<String>,
    initializers: &BTreeMap<String, String>,
) -> Result<(), CandidateError> {
    if selected.len() > MAX_SERVICES || selected.iter().any(|name| !initializers.contains_key(name))
    {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn validate_receipt(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt.initializer_cache_release.len() > MAX_SERVICES
        || receipt
            .initializer_cache_release
            .iter()
            .any(|(service, record)| {
                !record.valid()
                    || receipt.readiness.get(service) != Some(&Condition::Completed)
                    || !receipt
                        .resources
                        .contains_key(&format!("container:{service}"))
            })
    {
        return Err(refused());
    }
    Ok(())
}
/// Pending remains a pool admission fence even if graph cleanup later succeeds.
pub(super) fn require_resolved(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt
        .initializer_cache_release
        .values()
        .any(|r| r.phase == Phase::Pending)
    {
        return Err(refused());
    }
    Ok(())
}
/// Explicit reconciliation after an independently verified different guest boot.
/// The old effect cannot survive; this records abandonment, never completion/replay.
pub(super) fn abort_after_boot_change(
    receipt: &mut Receipt,
    boot: &str,
) -> Result<bool, CandidateError> {
    if receipt
        .initializer_cache_release
        .values()
        .any(|r| r.phase == Phase::Pending && r.binding.as_ref().is_none_or(|b| b.boot == boot))
    {
        return Err(refused());
    }
    let mut changed = false;
    for record in receipt.initializer_cache_release.values_mut() {
        if record.phase == Phase::Pending {
            record.phase = Phase::AbortedBootChange;
            changed = true;
        }
    }
    Ok(changed)
}
fn inventory_busy(rows: &Value, initializer: &str) -> Result<bool, CandidateError> {
    let rows = rows
        .as_array()
        .filter(|r| r.len() <= 128)
        .ok_or_else(refused)?;
    let mut ids = BTreeSet::new();
    let mut busy = false;
    let mut found = false;
    for row in rows {
        let id = row["Id"]
            .as_str()
            .filter(|id| hex(id, 64))
            .ok_or_else(refused)?;
        if !ids.insert(id) {
            return Err(refused());
        }
        let state = row["State"].as_str().ok_or_else(refused)?;
        if ![
            "created",
            "running",
            "paused",
            "restarting",
            "removing",
            "exited",
            "dead",
        ]
        .contains(&state)
        {
            return Err(refused());
        }
        if id == initializer {
            if state != "exited" {
                return Err(refused());
            }
            found = true;
        } else {
            busy = true;
        }
    }
    if !found {
        return Err(refused());
    }
    Ok(busy)
}
fn quiescent(
    engine: &Engine<'_>,
    receipt: &Receipt,
    initializer: &str,
) -> Result<bool, CandidateError> {
    let candidate = engine.guest().candidate();
    let mut busy = false;
    for run in storage_inventory::runs(&candidate.state_root.join("run/graphs"))? {
        if run == receipt.run {
            continue;
        }
        let (other, root) = load(candidate, engine, &run)?;
        match fs::symlink_metadata(root.join("state.pending")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
        require_resolved(&other)?;
        if !["removed", "stopped-data-retained", "ready-observed"].contains(&other.phase.as_str()) {
            return Err(refused());
        }
        // Conservatively skip other live graphs even when all their processes have
        // just exited. Unknown foreign containers are also never treated as quiescent.
        busy |= other.phase == "ready-observed";
        for resource in other
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            if inspect_resource(engine, &other, resource)?.is_some() {
                busy = true;
            }
        }
    }
    busy |= inventory_busy(
        &engine.request(
            Method::GET,
            "/v1.53/containers/json?all=true&limit=129",
            None,
        )?,
        initializer,
    )?;
    Ok(!busy)
}
// Only the effect boundary is substituted in tests; ordering and durable transitions
// remain the same production orchestration, including re-entry refusal.
trait Release {
    fn receipt(&mut self) -> &mut Receipt;
    fn fresh(&self) -> bool;
    fn binding(&self, service: &str) -> Result<Option<Binding>, CandidateError>;
    fn idle(&self, binding: &Binding) -> Result<bool, CandidateError>;
    fn save(&mut self) -> Result<(), CandidateError>;
    fn checkpoint(&mut self, point: &str) -> Result<(), CandidateError>;
    fn effect(&mut self) -> Result<(), CandidateError>;
}
fn release(action: &mut impl Release, service: &str) -> Result<(), CandidateError> {
    require_resolved(action.receipt())?;
    if !action.fresh()
        || action
            .receipt()
            .initializer_cache_release
            .get(service)
            .is_none_or(|r| r.phase != Phase::Selected)
    {
        return Ok(());
    }
    // Includes binding/inventory validation and intent persistence; the final
    // acknowledgement write necessarily follows this recorded duration.
    let start = Instant::now();
    action.checkpoint("before-validation")?;
    let Some(binding) = action.binding(service)? else {
        action
            .receipt()
            .initializer_cache_release
            .get_mut(service)
            .expect("selected")
            .phase = Phase::SkippedIneligible;
        return action.save();
    };
    let idle = action.idle(&binding)?;
    let record = action
        .receipt()
        .initializer_cache_release
        .get_mut(service)
        .expect("selected");
    record.binding = Some(binding);
    record.phase = if idle {
        Phase::Pending
    } else {
        Phase::SkippedBusy
    };
    action.save()?;
    if !idle {
        return Ok(());
    }
    action.checkpoint("cache-release-intent")?;
    action.effect()?;
    action.checkpoint("cache-release-effect")?;
    let record = action
        .receipt()
        .initializer_cache_release
        .get_mut(service)
        .expect("selected");
    record.phase = Phase::Released;
    record.elapsed_millis = Some(
        start
            .elapsed()
            .as_millis()
            .try_into()
            .map_err(|_| refused())?,
    );
    action.save()
}
impl Session<'_, '_> {
    pub(super) fn release_initializer_cache(
        &mut self,
        service: &str,
    ) -> Result<(), CandidateError> {
        release(self, service)
    }
}
impl Release for Session<'_, '_> {
    fn receipt(&mut self) -> &mut Receipt {
        &mut self.receipt
    }
    fn fresh(&self) -> bool {
        self.fresh_cache_completion
    }
    fn binding(&self, service: &str) -> Result<Option<Binding>, CandidateError> {
        let volume_key = self
            .cache_initializers
            .get(service)
            .map(|v| format!("volume:{v}"))
            .ok_or_else(refused)?;
        let volume = &self.receipt.resources[&volume_key];
        let resource = &self.receipt.resources[&format!("container:{service}")];
        let binding = volume.cache_provenance.as_ref().and_then(|p| {
            p.release_binding(service, resource, volume, self.engine.guest().boot_id())
        });
        let Some(binding) = binding else {
            return Ok(None);
        };
        let observed =
            inspect_resource(&self.engine, &self.receipt, resource)?.ok_or_else(refused)?;
        self.verify_config(service, &observed)?;
        if observed["State"]["Status"] != "exited"
            || observed["State"]["Running"] != false
            || observed["State"]["Paused"] != false
            || observed["State"]["Restarting"] != false
            || observed["State"]["Dead"] != false
            || observed["State"]["Pid"] != 0
            || observed["State"]["OOMKilled"] != false
            || observed["State"]["ExitCode"] != 0
            || observed["State"]["StartedAt"] != binding.started_at
            || observed["State"]["FinishedAt"] != binding.finished_at
        {
            return Err(refused());
        }
        cache_provenance::verify(&self.engine, &self.receipt, volume)?;
        Ok(Some(binding))
    }
    fn idle(&self, binding: &Binding) -> Result<bool, CandidateError> {
        quiescent(&self.engine, &self.receipt, &binding.container)
    }
    fn save(&mut self) -> Result<(), CandidateError> {
        Session::save(self)
    }
    fn checkpoint(&mut self, point: &str) -> Result<(), CandidateError> {
        #[cfg(test)]
        if point != "before-validation" {
            self.fault_pause(point)?;
        }
        if point != "cache-release-effect" {
            self.check_cancelled()?;
        }
        Ok(())
    }
    fn effect(&mut self) -> Result<(), CandidateError> {
        self.engine.guest().release_guest_cache()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            boot: "boot".into(),
            container: "a".repeat(64),
            started_at: "2026-09-18T00:00:00Z".into(),
            finished_at: "2026-09-18T00:00:01Z".into(),
            volume: "cache".into(),
            cache_fingerprint: "b".repeat(64),
        }
    }
    fn receipt(record: Record) -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"preparing","readiness":{},"resources":{},"initializer_cache_release":{"deps":record}})).unwrap()
    }
    #[test]
    fn complete_inventory_distinguishes_busy_from_uncertain() {
        let id = "a".repeat(64);
        let own = json!({"Id":id,"State":"exited"});
        assert!(!inventory_busy(&json!([own]), &id).unwrap());
        for state in [
            "running",
            "paused",
            "restarting",
            "exited",
            "created",
            "dead",
            "removing",
        ] {
            assert!(
                inventory_busy(&json!([own,{"Id":"b".repeat(64),"State":state}]), &id).unwrap()
            );
        }
        for rows in [
            json!([]),
            json!([own, own]),
            json!([{"Id":id,"State":"running"}]),
            json!([own,{"Id":"foreign","State":"running"}]),
            json!([own,{"Id":"b".repeat(64),"State":"unknown"}]),
            json!({}),
        ] {
            assert!(inventory_busy(&rows, &id).is_err());
        }
    }
    #[test]
    fn interrupted_effect_remains_fenced_after_cleanup_and_roundtrip() {
        let mut record = Record::selected();
        record.phase = Phase::Pending;
        record.binding = Some(binding());
        let mut receipt = receipt(record);
        for phase in [
            "preparing",
            "failed-retained",
            "stopped-data-retained",
            "removed",
        ] {
            receipt.phase = phase.into();
            let recovered: Receipt =
                serde_json::from_slice(&serde_json::to_vec(&receipt).unwrap()).unwrap();
            assert!(require_resolved(&recovered).is_err());
        }
        let record = receipt.initializer_cache_release.get_mut("deps").unwrap();
        record.phase = Phase::Released;
        record.elapsed_millis = Some(7);
        assert!(require_resolved(&receipt).is_ok());
    }
    #[test]
    fn selection_requires_reviewed_bootstrap_and_preserves_default_off() {
        let initializers = BTreeMap::from([("deps".into(), "modules".into())]);
        assert!(validate_selection(&BTreeSet::new(), &initializers).is_ok());
        assert!(validate_selection(&BTreeSet::from(["deps".into()]), &initializers).is_ok());
        assert!(validate_selection(&BTreeSet::from(["web".into()]), &initializers).is_err());
        let mut record = Record::selected();
        assert!(record.valid());
        record.phase = Phase::Released;
        assert!(!record.valid());
        record.binding = Some(binding());
        assert!(!record.valid());
        record.elapsed_millis = Some(8);
        assert!(record.valid());
        record.phase = Phase::SkippedBusy;
        assert!(!record.valid());
    }
    #[test]
    fn explicit_reconciliation_aborts_only_a_different_verified_boot() {
        let mut record = Record::selected();
        record.phase = Phase::Pending;
        record.binding = Some(binding());
        let mut receipt = receipt(record);
        let before = serde_json::to_value(&receipt).unwrap();
        assert!(abort_after_boot_change(&mut receipt, "boot").is_err());
        assert_eq!(serde_json::to_value(&receipt).unwrap(), before);
        assert!(abort_after_boot_change(&mut receipt, "new-boot").unwrap());
        assert_eq!(
            receipt.initializer_cache_release["deps"].phase,
            Phase::AbortedBootChange
        );
        assert!(
            receipt.initializer_cache_release["deps"]
                .elapsed_millis
                .is_none()
        );
        assert!(require_resolved(&receipt).is_ok());
        assert!(!abort_after_boot_change(&mut receipt, "another-boot").unwrap());
    }
    // Real private journal writes/reloads; only verified Engine observations and
    // the guest RPC are substituted. This does not simulate native process death.
    struct Action {
        root: super::super::tests::Fixture,
        receipt: Receipt,
        rows: Value,
        fresh: bool,
        eligible: bool,
        fault: &'static str,
        effects: usize,
    }
    impl Action {
        fn new() -> Self {
            let root = super::super::tests::Fixture::new();
            let mut receipt = receipt(Record::selected());
            receipt
                .readiness
                .insert("deps".into(), Condition::Completed);
            receipt.resources.insert("container:deps".into(), serde_json::from_value(json!({
                "kind":"container", "key":"deps", "name":format!("hkg-{}-container-0",receipt.run),
                "id":"a".repeat(64), "image":format!("sha256:{}","b".repeat(64)),
                "phase":"started", "networks":[]
            })).unwrap());
            state::write(&root.0.join("state.json"), &receipt).unwrap();
            Self {
                root,
                receipt,
                rows: json!([{"Id":"a".repeat(64),"State":"exited"}]),
                fresh: true,
                eligible: true,
                fault: "",
                effects: 0,
            }
        }
        fn reload(&mut self) {
            self.receipt = load_at(self.root.0.clone(), &self.receipt.run, &self.receipt.owner)
                .unwrap()
                .0;
        }
        fn phase(&self) -> Phase {
            self.receipt.initializer_cache_release["deps"].phase.clone()
        }
    }
    impl Release for Action {
        fn receipt(&mut self) -> &mut Receipt {
            &mut self.receipt
        }
        fn fresh(&self) -> bool {
            self.fresh
        }
        fn binding(&self, _: &str) -> Result<Option<Binding>, CandidateError> {
            if self.fault == "stale-binding" {
                return Err(refused());
            }
            Ok(self.eligible.then(binding))
        }
        fn idle(&self, binding: &Binding) -> Result<bool, CandidateError> {
            inventory_busy(&self.rows, &binding.container).map(|busy| !busy)
        }
        fn save(&mut self) -> Result<(), CandidateError> {
            if self.fault == "ack-save" && self.phase() == Phase::Released {
                return Err(refused());
            }
            state::write(&self.root.0.join("state.json"), &self.receipt)
        }
        fn checkpoint(&mut self, point: &str) -> Result<(), CandidateError> {
            if self.fault == point {
                return Err(refused());
            }
            Ok(())
        }
        fn effect(&mut self) -> Result<(), CandidateError> {
            // Prove intent precedes the actual effect, not merely final serialization.
            let durable = load_at(self.root.0.clone(), &self.receipt.run, &self.receipt.owner)?.0;
            assert_eq!(
                durable.initializer_cache_release["deps"].phase,
                Phase::Pending
            );
            self.effects += 1;
            if self.fault == "timeout" {
                return Err(error("guest_agent", "Cache release deadline expired."));
            }
            Ok(())
        }
    }
    #[test]
    fn orchestration_releases_once_and_preserves_history_on_reentry() {
        let mut action = Action::new();
        release(&mut action, "deps").unwrap();
        action.reload();
        assert_eq!(action.phase(), Phase::Released);
        let history = action.receipt.initializer_cache_release.clone();
        release(&mut action, "deps").unwrap();
        action.fresh = false;
        release(&mut action, "deps").unwrap();
        action.reload();
        assert_eq!(action.effects, 1);
        assert_eq!(action.receipt.initializer_cache_release, history);
        let mut adopted = Action::new();
        adopted.eligible = false;
        release(&mut adopted, "deps").unwrap();
        adopted.reload();
        assert_eq!(adopted.phase(), Phase::SkippedIneligible);
        assert_eq!(adopted.effects, 0);
    }
    #[test]
    fn orchestration_busy_and_uncertain_observations_never_call_effect() {
        for state in ["running", "paused", "restarting", "exited"] {
            let mut action = Action::new();
            action
                .rows
                .as_array_mut()
                .unwrap()
                .push(json!({"Id":"b".repeat(64),"State":state}));
            release(&mut action, "deps").unwrap();
            action.reload();
            assert_eq!(action.phase(), Phase::SkippedBusy);
            assert_eq!(action.effects, 0);
        }
        for rows in [
            json!([]),
            json!({}),
            json!([{"Id":"a".repeat(64),"State":"unknown"}]),
        ] {
            let mut action = Action::new();
            action.rows = rows;
            assert!(release(&mut action, "deps").is_err());
            action.reload();
            assert_eq!(action.phase(), Phase::Selected);
            assert_eq!(action.effects, 0);
        }
        let mut action = Action::new();
        action.fault = "stale-binding";
        assert!(release(&mut action, "deps").is_err());
        action.reload();
        assert_eq!(action.phase(), Phase::Selected);
        assert_eq!(action.effects, 0);
    }
    #[test]
    fn orchestration_interruption_timeout_and_ack_failure_fence_replay() {
        for (fault, effects) in [
            ("cache-release-intent", 0),
            ("cache-release-effect", 1),
            ("timeout", 1),
            ("ack-save", 1),
        ] {
            let mut action = Action::new();
            action.fault = fault;
            assert!(release(&mut action, "deps").is_err(), "{fault}");
            action.reload();
            assert_eq!(action.phase(), Phase::Pending, "{fault}");
            assert_eq!(action.effects, effects);
            action.fault = "";
            // Same guard used by admission before accepting any later graph.
            assert!(require_resolved(&action.receipt).is_err());
            assert!(abort_after_boot_change(&mut action.receipt, "boot").is_err());
            assert!(release(&mut action, "deps").is_err());
            assert_eq!(action.effects, effects);
            assert!(abort_after_boot_change(&mut action.receipt, "new-boot").unwrap());
            action.save().unwrap();
            action.reload();
            assert_eq!(action.phase(), Phase::AbortedBootChange);
            assert!(require_resolved(&action.receipt).is_ok());
            release(&mut action, "deps").unwrap();
            assert_eq!(action.effects, effects);
            assert!(
                action.receipt.initializer_cache_release["deps"]
                    .elapsed_millis
                    .is_none()
            );
        }
    }
}
