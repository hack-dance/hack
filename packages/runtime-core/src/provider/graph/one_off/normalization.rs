//! A stopped-receipt projection is authorized only by an immutable, completed
//! cleanup proof. This journal preserves both receipts for proof readers and
//! interrupted normalization; it never authorizes container or volume deletion.
use super::*;

const FILE: &str = "one-off-normalization.json";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Prepared,
    EnvironmentArchived,
    ReceiptPublished,
    JournalArchived,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Normalization {
    pub version: u8,
    pub recovery_sha256: String,
    pub job: JobIntent,
    pub before: Receipt,
    pub after: Receipt,
    pub phase: Phase,
}
fn equal(a: &impl Serialize, b: &impl Serialize) -> Result<bool, CandidateError> {
    Ok(serde_json::to_value(a).map_err(|_| refused())?
        == serde_json::to_value(b).map_err(|_| refused())?)
}
fn projection(before: &Receipt, job: &JobIntent) -> Result<Receipt, CandidateError> {
    if before.phase != "stopped-data-retained"
        || before.run != job.run
        || before.owner != job.owner
        || before.plan_id != job.plan
        || !hex(&job.job, 32)
        || job.version != 1
    {
        return Err(refused());
    }
    let mut after = before.clone();
    let service = format!("job-{}", job.job);
    let resource = after
        .resources
        .remove(&format!("container:{service}"))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Container
        || resource.key != service
        || resource.name != job.container_name
        || resource.phase != "absent"
        || resource.routing.is_some()
        || resource.cache.is_some()
        || job
            .container_id
            .as_ref()
            .is_some_and(|id| resource.id.as_ref() != Some(id))
    {
        return Err(refused());
    }
    after.readiness.remove(&service);
    if let Some(startup) = after.relay_startup.as_mut() {
        startup.services.remove(&service);
    }
    after.environment_attached = job.original_environment_attached;
    Ok(after)
}
impl Normalization {
    /// Caller must first verify the completed recovery proof and actual transient
    /// resource absence under its Engine lease. Pending bytes are evidence only.
    pub fn prepare(
        root: &std::path::Path,
        before: &Receipt,
        job: &JobIntent,
        recovery_sha256: &str,
    ) -> Result<Self, CandidateError> {
        if !hex(recovery_sha256, 64) {
            return Err(refused());
        }
        let next = Self {
            version: 1,
            recovery_sha256: recovery_sha256.into(),
            job: job.clone(),
            before: before.clone(),
            after: projection(before, job)?,
            phase: Phase::Prepared,
        };
        let current: Receipt = state::read(&root.join("state.json"))?;
        if !equal(&current, before)? {
            return Err(refused());
        }
        match fs::symlink_metadata(root.join(FILE)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
        journal::retain_file(
            root,
            "one-off-normalization.pending",
            "one-off-normalization-recovery",
            2 * 1024 * 1024,
        )?;
        state::write(&root.join(FILE), &next)?;
        Ok(next)
    }
    /// Validate a retry against the same completed proof and exact before/after
    /// receipt. A changed parent binding or unrelated phase is never projected.
    pub fn load(root: &std::path::Path, recovery_sha256: &str) -> Result<Self, CandidateError> {
        let selected = Self::read(root, recovery_sha256)?;
        let current: Receipt = state::read(&root.join("state.json"))?;
        let before = equal(&current, &selected.before)?;
        let after = equal(&current, &selected.after)?;
        if match selected.phase {
            Phase::Prepared => !before,
            Phase::EnvironmentArchived => !before && !after,
            Phase::ReceiptPublished | Phase::JournalArchived | Phase::Complete => !after,
        } {
            return Err(refused());
        }
        Ok(selected)
    }
    pub fn read(root: &std::path::Path, recovery_sha256: &str) -> Result<Self, CandidateError> {
        let selected: Self = state::read(&root.join(FILE))?;
        if selected.version != 1
            || !hex(recovery_sha256, 64)
            || selected.recovery_sha256 != recovery_sha256
            || !equal(
                &selected.after,
                &projection(&selected.before, &selected.job)?,
            )?
        {
            return Err(refused());
        }
        Ok(selected)
    }
    /// Publish the pinned projection after allocation archival. Interrupted bytes
    /// are retained; neither partial bytes nor a changed parent can select output.
    pub fn publish_receipt(&mut self, root: &std::path::Path) -> Result<(), CandidateError> {
        if self.phase != Phase::EnvironmentArchived
            || !equal(self, &Self::load(root, &self.recovery_sha256)?)?
        {
            return Err(refused());
        }
        journal::retain(root)?;
        let receipt: Receipt = state::read(&root.join("state.json"))?;
        if !equal(&receipt, &self.after)? {
            state::write(&root.join("state.json"), &self.after)?;
        }
        self.advance(root, Phase::ReceiptPublished)
    }
    /// Advance only after the named effect was observed. In particular,
    /// ReceiptPublished requires the complete projected receipt on disk.
    pub fn advance(&mut self, root: &std::path::Path, phase: Phase) -> Result<(), CandidateError> {
        let current = Self::load(root, &self.recovery_sha256)?;
        if !equal(self, &current)?
            || !matches!(
                (&self.phase, &phase),
                (Phase::Prepared, Phase::EnvironmentArchived)
                    | (Phase::EnvironmentArchived, Phase::ReceiptPublished)
                    | (Phase::ReceiptPublished, Phase::JournalArchived)
                    | (Phase::JournalArchived, Phase::Complete)
            )
        {
            return Err(refused());
        }
        if phase == Phase::ReceiptPublished {
            let receipt: Receipt = state::read(&root.join("state.json"))?;
            if !equal(&receipt, &self.after)? {
                return Err(refused());
            }
        }
        journal::retain_file(
            root,
            "one-off-normalization.pending",
            "one-off-normalization-recovery",
            2 * 1024 * 1024,
        )?;
        let mut next = self.clone();
        next.phase = phase;
        state::write(&root.join(FILE), &next)?;
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (super::super::super::tests::Fixture, Receipt, JobIntent) {
        let (fixture, mut receipt, job) = super::super::tests::interrupted();
        receipt.phase = "stopped-data-retained".into();
        for resource in receipt.resources.values_mut() {
            resource.phase = "absent".into();
        }
        receipt.resources.insert("volume:data".into(), serde_json::from_value(json!({"kind":"volume","key":"data","name":"retained-user-data","id":null,"phase":"created","image":null})).unwrap());
        state::write(&fixture.0.join("state.json"), &receipt).unwrap();
        (fixture, receipt, job)
    }
    #[test]
    fn journal_preserves_parent_and_resumes_receipt_publication_window() {
        let (fixture, before, job) = fixture();
        let proof = "1".repeat(64);
        let mut intent = Normalization::prepare(&fixture.0, &before, &job, &proof).unwrap();
        assert!(equal(&intent.before, &before).unwrap());
        assert!(
            equal(
                &intent.after.resources["container:task"],
                &before.resources["container:task"]
            )
            .unwrap()
        );
        assert_eq!(intent.after.resources.len() + 1, before.resources.len());
        assert!(
            equal(
                &intent.after.resources["volume:data"],
                &before.resources["volume:data"]
            )
            .unwrap()
        );
        assert!(intent.advance(&fixture.0, Phase::Complete).is_err());
        intent
            .advance(&fixture.0, Phase::EnvironmentArchived)
            .unwrap();
        assert!(intent.advance(&fixture.0, Phase::ReceiptPublished).is_err());
        state::write(&fixture.0.join("state.json"), &intent.after).unwrap();
        let mut retry = Normalization::load(&fixture.0, &proof).unwrap();
        retry.advance(&fixture.0, Phase::ReceiptPublished).unwrap();
        retry.advance(&fixture.0, Phase::JournalArchived).unwrap();
        retry.advance(&fixture.0, Phase::Complete).unwrap();
        assert!(Normalization::load(&fixture.0, &proof).is_ok());
        assert!(Normalization::load(&fixture.0, &"2".repeat(64)).is_err());
    }
    #[test]
    fn changed_parent_or_unremoved_job_refuses_without_rewriting_receipt() {
        let (fixture, before, mut job) = fixture();
        let proof = "1".repeat(64);
        let mut running = before.clone();
        running
            .resources
            .get_mut(&format!("container:job-{}", job.job))
            .unwrap()
            .phase = "started".into();
        state::write(&fixture.0.join("state.json"), &running).unwrap();
        assert!(Normalization::prepare(&fixture.0, &running, &job, &proof).is_err());
        state::write(&fixture.0.join("state.json"), &before).unwrap();
        job.container_name = "foreign".into();
        assert!(Normalization::prepare(&fixture.0, &before, &job, &proof).is_err());
        let (_, _, original_job) = self::fixture();
        let intent = Normalization::prepare(&fixture.0, &before, &original_job, &proof).unwrap();
        let mut changed = intent.before.clone();
        changed.resources.get_mut("container:task").unwrap().id = Some("9".repeat(64));
        state::write(&fixture.0.join("state.json"), &changed).unwrap();
        assert!(Normalization::load(&fixture.0, &proof).is_err());
    }
}
