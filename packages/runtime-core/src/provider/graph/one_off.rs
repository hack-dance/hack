//! Durable one-off admission. A reservation is written before any container effect;
//! an existing or interrupted reservation is recovery evidence, never permission to replay.
//! This journal does not itself authorize effects: callers must hold both graph
//! owner authority and the Engine lease, and verify observed removal before Removed.
use super::*;
use sha2::{Digest, Sha256};

#[cfg(any(target_os = "macos", test))]
mod config;
pub mod normalization;
#[cfg(target_os = "macos")]
pub mod runtime;

const FILE: &str = "one-off.json";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobIntent {
    pub version: u8,
    pub job: String,
    pub run: String,
    pub owner: String,
    pub plan: String,
    pub boot: String,
    pub generation: String,
    pub service: String,
    pub container_name: String,
    pub config_sha256: String,
    #[serde(default)]
    pub original_environment_attached: bool,
    pub phase: JobPhase,
    pub container_id: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobPhase {
    Reserved,
    CreateIntent,
    Created,
    StartIntent,
    Started,
    CleanupIntent,
    Removed,
}
fn refused() -> CandidateError {
    error(
        "graph_one_off_journal",
        "One-off admission requires exact current graph ownership and an unused job reservation; interrupted effects require cleanup, never replay.",
    )
}
impl JobIntent {
    /// The caller holds the foreground authority and Engine lease. Config must be
    /// the public compiled template; private values are delivered separately.
    pub fn reserve(
        root: &std::path::Path,
        receipt: &Receipt,
        selection: &ServiceSelection,
        job: &str,
        container_name: &str,
        config: &Value,
    ) -> Result<Self, CandidateError> {
        if receipt.phase != "ready-observed"
            || receipt.run != selection.run
            || receipt.owner != selection.owner
            || receipt.plan_id != selection.plan
            || receipt.namespace != selection.namespace
            || service_exec_generation(receipt)? != selection.generation
            || !hex(job, 32)
            || selection.boot.is_empty()
            || selection.boot.len() > 128
            || !container_name
                .strip_prefix(&format!("hkg-{}-container-", receipt.run))
                .is_some_and(|v| {
                    !v.is_empty() && v.len() <= 2 && v.bytes().all(|b| b.is_ascii_digit())
                })
            || receipt.resources.values().any(|r| r.name == container_name)
        {
            return Err(refused());
        }
        let resource = receipt
            .resources
            .get(&format!("container:{}", selection.service))
            .ok_or_else(refused)?;
        if resource.kind != Kind::Container
            || resource.key != selection.service
            || resource.id.as_deref() != Some(selection.container.as_str())
        {
            return Err(refused());
        }
        for name in [FILE, "one-off.pending", "state.pending"] {
            match fs::symlink_metadata(root.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(refused()),
            }
        }
        let intent = Self {
            version: 1,
            job: job.into(),
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            plan: receipt.plan_id.clone(),
            boot: selection.boot.clone(),
            generation: selection.generation.clone(),
            service: selection.service.clone(),
            container_name: container_name.into(),
            config_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(config).map_err(|_| refused())?)
            ),
            original_environment_attached: receipt.environment_attached,
            phase: JobPhase::Reserved,
            container_id: None,
        };
        state::write(&root.join(FILE), &intent)?;
        Ok(intent)
    }
    /// Record an effect intent before sending it. Create/start intents deliberately
    /// have no edge back to their prior phase: a lost response cannot cause replay.
    pub fn advance(
        &mut self,
        root: &std::path::Path,
        next: JobPhase,
        id: Option<&str>,
    ) -> Result<(), CandidateError> {
        match fs::symlink_metadata(root.join("one-off.pending")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
        let current: Self = state::read(&root.join(FILE))?;
        if serde_json::to_value(&current).map_err(|_| refused())?
            != serde_json::to_value(&*self).map_err(|_| refused())?
        {
            return Err(refused());
        }
        let allowed = matches!(
            (self.phase, next),
            (JobPhase::Reserved, JobPhase::CreateIntent)
                | (JobPhase::CreateIntent, JobPhase::Created)
                | (JobPhase::Created, JobPhase::StartIntent)
                | (JobPhase::StartIntent, JobPhase::Started)
                | (JobPhase::CleanupIntent, JobPhase::Removed)
        ) || (next == JobPhase::CleanupIntent && self.phase != JobPhase::Removed);
        if !allowed
            || id.is_some_and(|v| !hex(v, 64))
            || (next == JobPhase::Created && id.is_none())
            || self
                .container_id
                .as_deref()
                .is_some_and(|old| id.is_some_and(|new| old != new))
        {
            return Err(refused());
        }
        let mut next_intent = self.clone();
        next_intent.phase = next;
        if let Some(id) = id {
            next_intent.container_id = Some(id.into());
        }
        state::write(&root.join(FILE), &next_intent)?;
        *self = next_intent;
        Ok(())
    }
}
/// Validate an interrupted job against its original parent generation. Pending
/// bytes never supply identity or effect authority; callers may retain them only
/// after this published selection and foreground ownership have been checked.
pub(super) fn recovery_selection(
    root: &std::path::Path,
    receipt: &Receipt,
    boot: &str,
) -> Result<String, CandidateError> {
    let intent: JobIntent = state::read(&root.join(FILE))?;
    if intent.version != 1
        || !hex(&intent.job, 32)
        || intent.run != receipt.run
        || intent.owner != receipt.owner
        || intent.plan != receipt.plan_id
        || intent.boot != boot
        || !hex(&intent.config_sha256, 64)
        || !hex(&intent.generation, 64)
        || intent
            .container_id
            .as_deref()
            .is_some_and(|id| !hex(id, 64))
        || !matches!(receipt.phase.as_str(), "restoring" | "ready-observed")
    {
        return Err(refused());
    }
    let service = format!("job-{}", intent.job);
    let key = format!("container:{service}");
    let mut parent = receipt.clone();
    if let Some(resource) = parent.resources.remove(&key) {
        if receipt.phase != "restoring"
            || resource.kind != Kind::Container
            || resource.key != service
            || resource.name != intent.container_name
            || resource.routing.is_some()
            || resource.cache.is_some()
            || intent
                .container_id
                .as_ref()
                .is_some_and(|id| resource.id.as_ref() != Some(id))
        {
            return Err(refused());
        }
    } else if receipt.phase != "ready-observed"
        || !matches!(
            intent.phase,
            JobPhase::Reserved | JobPhase::CleanupIntent | JobPhase::Removed
        )
    {
        return Err(refused());
    }
    parent.readiness.remove(&service);
    if let Some(startup) = parent.relay_startup.as_mut() {
        startup.services.remove(&service);
    }
    parent.environment_attached = intent.original_environment_attached;
    parent.phase = "ready-observed".into();
    if service_exec_generation(&parent)? != intent.generation
        || !parent
            .resources
            .contains_key(&format!("container:{}", intent.service))
        || parent
            .resources
            .values()
            .any(|resource| resource.name == intent.container_name)
    {
        return Err(refused());
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&intent).map_err(|_| refused())?)
    ))
}

pub(super) fn retain_interrupted_cleanup(root: &std::path::Path) -> Result<(), CandidateError> {
    journal::retain_file(root, "one-off.pending", "one-off-recovery", 16 * 1024)?;
    Ok(())
}

/// Mirror only the enrolled transient container's effect boundary. Ordinary
/// services, including user services with a job-like name, are unaffected.
pub(super) fn record_effect(
    root: &std::path::Path,
    key: &str,
    resource: &Resource,
) -> Result<(), CandidateError> {
    if !key.starts_with("container:job-") {
        return Ok(());
    }
    match fs::symlink_metadata(root.join(FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(state::io(e)),
        Ok(_) => {}
    }
    let mut intent: JobIntent = state::read(&root.join(FILE))?;
    if key != format!("container:job-{}", intent.job) {
        return Ok(());
    }
    if resource.name != intent.container_name || resource.kind != Kind::Container {
        return Err(refused());
    }
    let phase = match resource.phase.as_str() {
        "create-intent" => JobPhase::CreateIntent,
        "created" => JobPhase::Created,
        "start-intent" => JobPhase::StartIntent,
        "started" => JobPhase::Started,
        _ => return Ok(()),
    };
    intent.advance(root, phase, resource.id.as_deref())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    fn admitted() -> (super::super::tests::Fixture, JobIntent) {
        let fixture = super::super::tests::Fixture::new();
        state::private_directory(&fixture.0).unwrap();
        let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{"container:task":{"kind":"container","key":"task","name":"owned-task","id":"e".repeat(64),"phase":"started","image":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}})).unwrap();
        let selection = ServiceSelection {
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            namespace: receipt.namespace.clone(),
            plan: receipt.plan_id.clone(),
            service: "task".into(),
            container: "e".repeat(64),
            boot: "boot".into(),
            generation: service_exec_generation(&receipt).unwrap(),
        };
        let job = "f".repeat(32);
        let intent = JobIntent::reserve(
            &fixture.0,
            &receipt,
            &selection,
            &job,
            &format!("hkg-{}-container-31", receipt.run),
            &json!({"Cmd":["synthetic-sensitive-argument"]}),
        )
        .unwrap();
        assert!(
            !fs::read_to_string(fixture.0.join(FILE))
                .unwrap()
                .contains("synthetic-sensitive")
        );
        assert!(
            JobIntent::reserve(
                &fixture.0,
                &receipt,
                &selection,
                &job,
                &format!("hkg-{}-container-31", receipt.run),
                &json!({})
            )
            .is_err()
        );
        (fixture, intent)
    }
    pub(in crate::provider::graph) fn interrupted()
    -> (super::super::tests::Fixture, Receipt, JobIntent) {
        let (fixture, intent) = admitted();
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{"container:task":{"kind":"container","key":"task","name":"owned-task","id":"e".repeat(64),"phase":"started","image":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}})).unwrap();
        let service = format!("job-{}", intent.job);
        let mut resource = receipt.resources["container:task"].clone();
        resource.key = service.clone();
        resource.name = intent.container_name.clone();
        resource.id = None;
        resource.phase = "reserved".into();
        receipt
            .resources
            .insert(format!("container:{service}"), resource);
        receipt.readiness.insert(service, Condition::Started);
        receipt.phase = "restoring".into();
        (fixture, receipt, intent)
    }
    #[test]
    fn recovery_requires_exact_original_parent_and_job_boot() {
        let (fixture, receipt, intent) = interrupted();
        assert!(recovery_selection(&fixture.0, &receipt, "boot").is_ok());
        assert!(recovery_selection(&fixture.0, &receipt, "other-boot").is_err());
        let mut changed = receipt.clone();
        changed.resources.get_mut("container:task").unwrap().id = Some("9".repeat(64));
        assert!(recovery_selection(&fixture.0, &changed, "boot").is_err());
        let mut changed = receipt.clone();
        changed
            .resources
            .get_mut(&format!("container:job-{}", intent.job))
            .unwrap()
            .name = "different".into();
        assert!(recovery_selection(&fixture.0, &changed, "boot").is_err());
        let mut changed = receipt.clone();
        changed
            .resources
            .remove(&format!("container:job-{}", intent.job));
        assert!(recovery_selection(&fixture.0, &changed, "boot").is_err());
        fs::remove_file(fixture.0.join(FILE)).unwrap();
        assert!(recovery_selection(&fixture.0, &receipt, "boot").is_err());
    }
    #[test]
    fn recovery_retains_partial_job_journal_without_using_it_as_authority() {
        use std::os::unix::fs::PermissionsExt;
        let (fixture, receipt, _) = interrupted();
        let pending = fixture.0.join("one-off.pending");
        fs::write(&pending, b"{partial-untrusted").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let selection = recovery_selection(&fixture.0, &receipt, "boot").unwrap();
        retain_interrupted_cleanup(&fixture.0).unwrap();
        assert_eq!(
            fs::read(fixture.0.join("one-off-recovery-1/interrupted.pending")).unwrap(),
            b"{partial-untrusted"
        );
        assert_eq!(
            recovery_selection(&fixture.0, &receipt, "boot").unwrap(),
            selection
        );
        let mut intent: JobIntent = state::read(&fixture.0.join(FILE)).unwrap();
        intent
            .advance(&fixture.0, JobPhase::CleanupIntent, None)
            .unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::CreateIntent, None)
                .is_err()
        );
    }
    #[test]
    fn lost_create_or_start_response_never_replays() {
        let (fixture, mut intent) = admitted();
        intent
            .advance(&fixture.0, JobPhase::CreateIntent, None)
            .unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::CreateIntent, None)
                .is_err()
        );
        intent
            .advance(&fixture.0, JobPhase::Created, Some(&"1".repeat(64)))
            .unwrap();
        intent
            .advance(&fixture.0, JobPhase::StartIntent, None)
            .unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::StartIntent, None)
                .is_err()
        );
        intent
            .advance(&fixture.0, JobPhase::CleanupIntent, None)
            .unwrap();
        intent.advance(&fixture.0, JobPhase::Removed, None).unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::CreateIntent, None)
                .is_err()
        );
    }
    #[test]
    fn interrupted_journal_write_refuses_before_transition() {
        let (fixture, mut intent) = admitted();
        fs::write(fixture.0.join("one-off.pending"), b"partial").unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::CreateIntent, None)
                .is_err()
        );
        assert_eq!(intent.phase, JobPhase::Reserved);
    }
    #[test]
    fn stale_writer_and_replacement_id_refuse() {
        let (fixture, mut intent) = admitted();
        let mut stale = intent.clone();
        intent
            .advance(&fixture.0, JobPhase::CreateIntent, None)
            .unwrap();
        assert!(
            stale
                .advance(&fixture.0, JobPhase::CleanupIntent, None)
                .is_err()
        );
        intent
            .advance(&fixture.0, JobPhase::Created, Some(&"1".repeat(64)))
            .unwrap();
        assert!(
            intent
                .advance(&fixture.0, JobPhase::StartIntent, Some(&"2".repeat(64)))
                .is_err()
        );
    }
}
