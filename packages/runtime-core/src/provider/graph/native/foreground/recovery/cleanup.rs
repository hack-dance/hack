//! Explicit cleanup-only recovery under retained publication, operation and provider leases.
use super::*;
use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
};

struct Committed {
    intent: Intent,
    witness: Option<((u64, u64), Vec<u8>)>,
}
pub(super) struct Context<'a> {
    admitted: Admitted<'a>,
    committed: RefCell<Committed>,
}
impl<'a> Context<'a> {
    fn new(mut admitted: Admitted<'a>) -> Result<Self, CandidateError> {
        let intent = match admitted.intent.take() {
            Some(intent) => intent,
            None => Intent {
                version: 1,
                kind: IntentKind::NativeGraphLiveOwnerRecovery,
                run: admitted.run.into(),
                journal_parent: admitted.root_identity,
                original: admitted.original_bytes.clone(),
                receipt_sha256: admitted.receipt_sha256.clone(),
                publication: admitted.lease.selected().clone(),
                progress: Progress::Cleanup,
                receipt_progress: 0,
                resource_progress: resource_progress(&admitted.original)?,
            },
        };
        let witness = admitted.witness.take();
        Ok(Self {
            admitted,
            committed: RefCell::new(Committed { intent, witness }),
        })
    }
    fn verify(&self, pending: Option<((u64, u64), &[u8])>) -> Result<Receipt, CandidateError> {
        let admitted = &self.admitted;
        for path in admitted
            .root
            .ancestors()
            .take_while(|path| path.starts_with(&admitted.candidate.state_root))
        {
            state::check_private_directory(path).map_err(|_| refused())?;
        }
        if id(&admitted.root)? != admitted.root_identity
            || exists(&admitted.root.join("state.pending"))?
        {
            return Err(refused());
        }
        let pending_path = admitted.root.join("live-owner-recovery.pending");
        match pending {
            Some((identity, bytes))
                if id(&pending_path)? == identity
                    && native_input::read_file(&pending_path, LIMIT).map_err(|_| refused())?
                        == bytes => {}
            None if !exists(&pending_path)? => {}
            _ => return Err(refused()),
        }
        let committed = self.committed.borrow();
        let path = admitted.root.join(FILE);
        match &committed.witness {
            Some((identity, bytes))
                if id(&path)? == *identity
                    && native_input::read_file(&path, LIMIT).map_err(|_| refused())? == *bytes => {}
            None if !exists(&path)? => {}
            _ => return Err(refused()),
        }
        committed.intent.progress.verify(&admitted.lease)?;
        let (current, root, bytes) =
            journal::read_recovery(admitted.candidate, admitted.original.review())?;
        committed
            .intent
            .current(&root, &admitted.original, &current, &bytes)?;
        if committed.witness.is_none() && bytes != admitted.original_bytes {
            return Err(refused());
        }
        committed.intent.progress.verify(&admitted.lease)?;
        Ok(current)
    }
    fn publish(&self, next: Intent) -> Result<(), CandidateError> {
        let current = self.verify(None)?;
        next.current(
            &self.admitted.root,
            &self.admitted.original,
            &current,
            &journal::read_recovery(self.admitted.candidate, self.admitted.original.review())?.2,
        )?;
        let bytes = serde_json::to_vec_pretty(&next).map_err(|_| refused())?;
        if bytes.is_empty() || bytes.len() > LIMIT {
            return Err(refused());
        }
        let path = self.admitted.root.join(FILE);
        let pending = self.admitted.root.join("live-owner-recovery.pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pending)
            .map_err(|_| refused())?;
        let identity = (
            file.metadata().map_err(|_| refused())?.dev(),
            file.metadata().map_err(|_| refused())?.ino(),
        );
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| refused())?;
        self.verify(Some((identity, &bytes)))?;
        if self.committed.borrow().witness.is_some() {
            fs::rename(&pending, &path).map_err(|_| refused())?;
        } else {
            owner::exclusive_move(&pending, &path).map_err(|_| refused())?;
        }
        File::open(&self.admitted.root)
            .and_then(|file| file.sync_all())
            .map_err(|_| refused())?;
        if id(&path)? != identity
            || native_input::read_file(&path, LIMIT).map_err(|_| refused())? != bytes
        {
            return Err(refused());
        }
        *self.committed.borrow_mut() = Committed {
            intent: next,
            witness: Some((identity, bytes)),
        };
        self.verify(None)?;
        Ok(())
    }
    pub(super) fn guard(&self) -> Result<(), CandidateError> {
        let current = self.verify(None)?;
        let mut next = self.committed.borrow().intent.clone();
        let rank = receipt_progress(&current)?;
        let resources = resource_progress(&current)?;
        if next.receipt_progress != rank || next.resource_progress != resources {
            next.receipt_progress = rank;
            next.resource_progress = resources;
            self.publish(next)?;
        }
        Ok(())
    }
    fn advance(&self, progress: Progress) -> Result<(), CandidateError> {
        self.guard()?;
        let mut next = self.committed.borrow().intent.clone();
        if progress < next.progress {
            return Err(refused());
        }
        if progress > next.progress {
            next.progress = progress;
            self.publish(next)?;
        }
        Ok(())
    }
    fn finish(&self, snapshot: &runtime::Snapshot) -> Result<(), CandidateError> {
        self.finish_using(snapshot, &|_| Ok(()))
    }
    pub(super) fn finish_using(
        &self,
        snapshot: &runtime::Snapshot,
        checkpoint: &dyn Fn(Progress) -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        snapshot
            .receipt
            .check_binding(&self.admitted.original)
            .map_err(|_| refused())?;
        if snapshot.receipt.phase != Phase::Removed
            || snapshot
                .observations
                .keys()
                .ne(snapshot.receipt.readiness.keys())
            || snapshot.observations.values().any(Option::is_some)
        {
            return Err(refused());
        }
        if self.committed.borrow().intent.progress <= Progress::EnvironmentRetired {
            self.advance(Progress::EnvironmentRetired)?;
        }
        if self.committed.borrow().intent.progress <= Progress::SocketRetirementIntent {
            self.advance(Progress::SocketRetirementIntent)?;
            checkpoint(Progress::SocketRetirementIntent)?;
            self.admitted.lease.archive(true)?;
            self.advance(Progress::SocketRetired)?;
            checkpoint(Progress::SocketRetired)?;
        }
        if self.committed.borrow().intent.progress <= Progress::OwnerRetirementIntent {
            self.advance(Progress::OwnerRetirementIntent)?;
            checkpoint(Progress::OwnerRetirementIntent)?;
            self.admitted.lease.archive(false)?;
            self.advance(Progress::Complete)?;
        }
        self.guard()
    }
}

/// Exact original selectors are independently re-admitted; no source replay,
/// environment acquisition, startup, reboot or data removal is available.
pub struct Options<'a> {
    pub run: &'a str,
    pub expect_receipt: &'a str,
    pub expect_owner: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum ResultKind {
    NativeGraphLiveOwnerRecovered,
}
#[derive(Serialize)]
pub struct Outcome {
    version: u8,
    kind: ResultKind,
    run: String,
    same_boot: bool,
    publication_retired: bool,
    receipt: Receipt,
}
pub fn recover(candidate: &Candidate, options: Options<'_>) -> Result<Outcome, CandidateError> {
    recover_using(candidate, options, |context, environment_retired| {
        runtime::cleanup_recovery(
            candidate,
            context.admitted.run,
            &context.admitted.original,
            &|| context.guard(),
            environment_retired,
            &|snapshot| context.finish(snapshot),
        )
    })
}
pub(super) fn recover_using(
    candidate: &Candidate,
    options: Options<'_>,
    cleanup: impl FnOnce(&Context<'_>, bool) -> Result<Receipt, CandidateError>,
) -> Result<Outcome, CandidateError> {
    let context = Context::new(admit(candidate, options.run)?)?;
    if !super::super::super::super::hex(options.expect_receipt, 64)
        || !super::super::super::super::hex(options.expect_owner, 64)
        || context.admitted.receipt_sha256 != options.expect_receipt
        || context.admitted.lease.selected().fingerprint() != options.expect_owner
    {
        return Err(refused());
    }
    if context.committed.borrow().witness.is_none() {
        let intent = context.committed.borrow().intent.clone();
        context.publish(intent)?;
    }
    let environment_retired =
        context.committed.borrow().intent.progress >= Progress::EnvironmentRetired;
    let receipt = cleanup(&context, environment_retired)?;
    context.guard()?;
    let current = context.verify(None)?;
    if context.committed.borrow().intent.progress != Progress::Complete
        || receipt.phase != Phase::Removed
        || serde_json::to_vec(&receipt).map_err(|_| refused())?
            != serde_json::to_vec(&current).map_err(|_| refused())?
    {
        return Err(refused());
    }
    Ok(Outcome {
        version: 1,
        kind: ResultKind::NativeGraphLiveOwnerRecovered,
        run: options.run.into(),
        same_boot: true,
        publication_retired: true,
        receipt,
    })
}
