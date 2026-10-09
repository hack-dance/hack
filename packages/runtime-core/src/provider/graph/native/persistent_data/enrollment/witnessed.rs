//! Witnessed enrollment is a separate owner wire, with no v1 migration. Expected
//! bytes are durable before original create and XATTR_CREATE. Pending or an uncertain
//! seed is never resumed. Retained reads only verify; they cannot repair a witness.

use super::*;
use crate::provider::graph::native::persistent_data::witnessed::{
    self, ExpectedWitness, RootIdentity,
};

/// Sealed original-effect transport, retaining the same continuously fenced guest
/// mutation lease through owner publication. A successful seed reply alone cannot
/// enroll data. All errors at this boundary are fixed and omit supplied values.
pub trait Transport: super::Transport {
    fn root(
        &mut self,
        volume: &Observation,
        deadline: Instant,
    ) -> Result<RootIdentity, CandidateError>;
    fn seed(&mut self, request: &SeedRequest, deadline: Instant) -> Result<(), CandidateError>;
    fn verify_witness(
        &mut self,
        volume: &Observation,
        root: RootIdentity,
        witness: &ExpectedWitness,
        deadline: Instant,
    ) -> Result<(), CandidateError>;
}
/// Issued only after this invocation's durable pending intent and captured sole
/// original create. Its fields cannot be reconstructed by an external caller.
pub struct SeedRequest {
    captured: Observation,
    root: RootIdentity,
    witness: ExpectedWitness,
    intent: String,
}
impl SeedRequest {
    pub fn captured(&self) -> &Observation {
        &self.captured
    }
    pub fn root(&self) -> RootIdentity {
        self.root
    }
    pub fn witness(&self) -> &ExpectedWitness {
        &self.witness
    }
    pub fn intent(&self) -> &str {
        &self.intent
    }
}
pub struct EnrollOptions<'a> {
    pub base: super::EnrollOptions<'a>,
    pub witness: &'a ExpectedWitness,
}
pub fn enroll_new<T: Transport>(
    options: EnrollOptions<'_>,
    transport: &mut T,
) -> Result<witnessed::Owner, CandidateError> {
    enroll(options, transport, &mut SystemSync)
}
pub fn read_retained<T: Transport>(
    options: ReadOptions<'_>,
    transport: &mut T,
) -> Result<witnessed::Owner, CandidateError> {
    let binding = snapshot(options.binding)?;
    let guard = Guard {
        deadline: options.deadline,
        cancelled: options.cancelled,
    };
    guard.check()?;
    let files = Files::existing(options.state_root, &binding)?;
    let record = RecordPin::read_validated(&files.slot.path.join("owner.json"), |bytes| {
        witnessed::decode(bytes).map(|_| ())
    })?;
    let owner = witnessed::decode(&record.bytes)?;
    if !matches!(owner.0.enrollment, witnessed::Enrollment::Enrolled { .. }) {
        return Err(refused());
    }
    fresh(&files, &record, &binding, &guard, transport)?;
    verify_current(&owner, &binding, &guard, transport)?;
    fresh(&files, &record, &binding, &guard, transport)?;
    Ok(owner)
}
pub struct BindingSelectionOptions<'a> {
    pub state_root: &'a Path,
    pub namespace: &'a str,
    pub storage: &'a str,
}
/// Read-only stable binding selection. Pending/staging/v1/foreign scope refuses;
/// the resulting binding still requires a separately acquired retained witness read.
pub fn existing_binding(
    options: BindingSelectionOptions<'_>,
) -> Result<Option<Binding>, CandidateError> {
    if !super::super::super::hex(options.namespace, 64)
        || !super::super::logical_name(options.storage)
    {
        return Err(refused());
    }
    let root = Directory::open(options.state_root)?;
    let path = root.path.join(slot_key(options.namespace, options.storage));
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            root.verify()?;
            return Ok(None);
        }
        Err(_) => return Err(refused()),
        Ok(_) => {}
    }
    let slot = Directory::open(&path)?;
    let lock = state::Lock::acquire_existing(&slot.path).map_err(|_| refused())?;
    let files = Files { root, slot, lock };
    files.verify(None)?;
    let record = RecordPin::read_validated(&files.slot.path.join("owner.json"), |bytes| {
        witnessed::decode(bytes).map(|_| ())
    })?;
    let owner = witnessed::decode(&record.bytes)?;
    if owner.0.binding.scope.namespace != options.namespace
        || owner.0.binding.scope.storage != options.storage
        || !matches!(owner.0.enrollment, witnessed::Enrollment::Enrolled { .. })
    {
        return Err(refused());
    }
    files.verify(Some(&record))?;
    Ok(Some(owner.0.binding.clone()))
}
fn encode(owner: &witnessed::Owner) -> Result<Vec<u8>, CandidateError> {
    let bytes = serde_json::to_vec(owner).map_err(|_| refused())?;
    witnessed::decode(&bytes)?;
    Ok(bytes)
}
fn verify_current<T: Transport>(
    owner: &witnessed::Owner,
    binding: &Binding,
    guard: &Guard<'_>,
    transport: &mut T,
) -> Result<(), CandidateError> {
    let witnessed::Enrollment::Enrolled {
        volume,
        root,
        witness,
    } = &owner.0.enrollment
    else {
        return Err(refused());
    };
    guard.check()?;
    transport
        .verify(binding, guard.deadline)
        .map_err(|_| refused())?;
    guard.check()?;
    let observed = transport
        .inspect(&volume.name, guard.deadline)
        .map_err(|_| refused())?
        .ok_or_else(refused)?;
    guard.check()?;
    let observed_root = transport
        .root(&observed, guard.deadline)
        .map_err(|_| refused())?;
    witnessed::matches(owner, binding, Some(&observed), observed_root)?;
    guard.check()?;
    transport
        .verify_witness(&observed, *root, witness, guard.deadline)
        .map_err(|_| refused())?;
    guard.check()?;
    let after = transport
        .inspect(&volume.name, guard.deadline)
        .map_err(|_| refused())?;
    witnessed::matches(owner, binding, after.as_ref(), observed_root)?;
    transport
        .verify(binding, guard.deadline)
        .map_err(|_| refused())?;
    guard.check()
}
fn enroll<T: Transport, S: Sync>(
    options: EnrollOptions<'_>,
    transport: &mut T,
    sync: &mut S,
) -> Result<witnessed::Owner, CandidateError> {
    let binding = snapshot(options.base.binding)?;
    let pending_owner = witnessed::pending(
        binding.clone(),
        options.base.intent.into(),
        options.witness.clone(),
    );
    let pending_bytes = encode(&pending_owner)?; // validate all inputs before any file or effect
    let guard = Guard {
        deadline: options.base.deadline,
        cancelled: options.base.cancelled,
    };
    guard.check()?;
    transport
        .verify(&binding, guard.deadline)
        .map_err(|_| refused())?;
    guard.check()?;
    let name = volume_name(&binding);
    if transport
        .inspect(&name, guard.deadline)
        .map_err(|_| refused())?
        .is_some()
    {
        return Err(refused());
    }
    guard.check()?;
    let files = Files::fresh(options.base.state_root, &binding, sync)?;
    let pending = RecordPin::create_bytes(
        &files.slot.path.join("owner.json"),
        pending_bytes,
        sync,
        Step::PendingFile,
    )?;
    sync.sync(&files.slot.file, Step::PendingDirectory)?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    if transport
        .inspect(&name, guard.deadline)
        .map_err(|_| refused())?
        .is_some()
    {
        return Err(refused());
    }
    fresh(&files, &pending, &binding, &guard, transport)?;
    let create = CreateRequest {
        binding: binding.clone(),
        name,
        intent: options.base.intent.into(),
    };
    let captured = transport
        .create_new(&create, guard.deadline)
        .map_err(|_| refused())?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    if captured.binding != binding
        || captured.volume.name != create.name
        || !super::super::volume_valid(&captured.volume)
    {
        return Err(refused());
    }
    let root = transport
        .root(&captured, guard.deadline)
        .map_err(|_| refused())?;
    let enrolled = witnessed::enrolled(
        binding.clone(),
        captured.volume.clone(),
        root,
        options.witness.clone(),
    );
    encode(&enrolled)?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    let observed = transport
        .inspect(&create.name, guard.deadline)
        .map_err(|_| refused())?;
    witnessed::matches(&enrolled, &binding, observed.as_ref(), root)?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    transport
        .seed(
            &SeedRequest {
                captured,
                root,
                witness: options.witness.clone(),
                intent: create.intent,
            },
            guard.deadline,
        )
        .map_err(|_| refused())?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    verify_current(&enrolled, &binding, &guard, transport)?;
    fresh(&files, &pending, &binding, &guard, transport)?;
    let staged = RecordPin::create_bytes(
        &files.slot.path.join("owner.next"),
        encode(&enrolled)?,
        sync,
        Step::EnrolledFile,
    )?;
    files.verify_record(&pending)?;
    staged.verify()?;
    verify_current(&enrolled, &binding, &guard, transport)?;
    files.verify_record(&pending)?;
    staged.verify()?;
    guard.check()?;
    fs::rename(&staged.path, &pending.path).map_err(|_| refused())?;
    let committed = staged.at(pending.path);
    files.verify(Some(&committed))?;
    sync.sync(&files.slot.file, Step::CommittedDirectory)?;
    verify_current(&enrolled, &binding, &guard, transport)?;
    fresh(&files, &committed, &binding, &guard, transport)?;
    Ok(enrolled)
}

#[cfg(test)]
mod tests;
