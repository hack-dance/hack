//! Installed tool + original Engine lease transport. A helper observation never
//! grants durable promotion by itself.
use super::*;
use crate::provider::graph::native::persistent_data::{
    tool::Installed,
    witnessed::{ExpectedWitness, RootIdentity},
};
use crate::provider::storage_root_witness::{Observation as Reply, Request};
use enrollment::Transport as _;

pub(in crate::provider::graph::native) fn enroll(
    candidate: &Candidate,
    engine: &Engine<'_>,
    tool: &Installed,
    reference: &mut Reference,
    deadline: Instant,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let State::Reserved { intent } = &reference.state else {
        return verify(candidate, engine, tool, reference, deadline, fresh);
    };
    let witness = ExpectedWitness {
        name: format!("user.hack.storage.{}{}", nonce()?, nonce()?),
        value: format!("{}{}", nonce()?, nonce()?),
    };
    let owner = enrollment::witnessed::enroll_new(
        enrollment::witnessed::EnrollOptions {
            base: enrollment::EnrollOptions {
                state_root: &candidate.state_root,
                binding: &reference.binding,
                intent,
                deadline,
                cancelled: &AtomicBool::new(false),
            },
            witness: &witness,
        },
        &mut WitnessAdapter::new(engine, tool, fresh),
    )?;
    let super::super::witnessed::Enrollment::Enrolled { volume, .. } = &owner.0.enrollment else {
        return Err(refused());
    };
    reference.state = State::Enrolled {
        volume: volume.clone(),
    };
    Ok(())
}
pub(in crate::provider::graph::native) fn verify(
    candidate: &Candidate,
    engine: &Engine<'_>,
    tool: &Installed,
    reference: &Reference,
    deadline: Instant,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let State::Enrolled { volume } = &reference.state else {
        return Err(refused());
    };
    let owner = enrollment::witnessed::read_retained(
        enrollment::ReadOptions {
            state_root: &candidate.state_root,
            binding: &reference.binding,
            deadline,
            cancelled: &AtomicBool::new(false),
        },
        &mut WitnessAdapter::new(engine, tool, fresh),
    )?;
    let super::super::witnessed::Enrollment::Enrolled {
        volume: current, ..
    } = &owner.0.enrollment
    else {
        return Err(refused());
    };
    if current != volume {
        return Err(refused());
    }
    Ok(())
}

pub(in crate::provider::graph::native) struct WitnessAdapter<'a, 'guest> {
    base: Adapter<'a, 'guest>,
    tool: &'a Installed,
}
impl<'a, 'guest> WitnessAdapter<'a, 'guest> {
    pub(in crate::provider::graph::native) fn new(
        engine: &'a Engine<'guest>,
        tool: &'a Installed,
        fresh: &'a dyn Fn() -> Result<(), CandidateError>,
    ) -> Self {
        Self {
            base: Adapter::new(engine, fresh),
            tool,
        }
    }
    fn exact(&mut self, captured: &Observation, deadline: Instant) -> Result<(), CandidateError> {
        self.base.verify(&captured.binding, deadline)?;
        if self.base.inspect(&captured.volume.name, deadline)?.as_ref() != Some(captured) {
            return Err(refused());
        }
        self.base.check(deadline)
    }
    fn invoke(&self, request: Request, deadline: Instant) -> Result<Reply, CandidateError> {
        self.tool
            .invoke(self.base.engine, request, deadline, self.base.fresh)
    }
}
impl enrollment::sealed::Transport for WitnessAdapter<'_, '_> {}
impl enrollment::Transport for WitnessAdapter<'_, '_> {
    fn verify(&mut self, expected: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        self.base.verify(expected, deadline)
    }
    fn inspect(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        self.base.inspect(name, deadline)
    }
    fn create_new(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        self.base.create_new(request, deadline)
    }
}
impl enrollment::witnessed::Transport for WitnessAdapter<'_, '_> {
    fn root(
        &mut self,
        volume: &Observation,
        deadline: Instant,
    ) -> Result<RootIdentity, CandidateError> {
        self.exact(volume, deadline)?;
        let Reply::Root(root) = self.invoke(Request::root(&volume.volume.name)?, deadline)? else {
            return Err(refused());
        };
        if (root.device, root.inode)
            != (
                volume.volume.directory.device,
                volume.volume.directory.inode,
            )
        {
            return Err(refused());
        }
        self.exact(volume, deadline)?;
        Ok(root.into())
    }
    fn seed(
        &mut self,
        request: &enrollment::witnessed::SeedRequest,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        let observed = request.captured();
        self.exact(observed, deadline)?;
        let witness = request.witness();
        let reply = self.invoke(
            Request::bound(
                &observed.volume.name,
                true,
                request.root().into(),
                &witness.name,
                &witness.value,
            )?,
            deadline,
        )?;
        if !matches!(reply, Reply::Seeded) {
            return Err(refused());
        }
        self.exact(observed, deadline)
    }
    fn verify_witness(
        &mut self,
        volume: &Observation,
        root: RootIdentity,
        witness: &ExpectedWitness,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        self.exact(volume, deadline)?;
        let reply = self.invoke(
            Request::bound(
                &volume.volume.name,
                false,
                root.into(),
                &witness.name,
                &witness.value,
            )?,
            deadline,
        )?;
        if !matches!(reply, Reply::Verified) {
            return Err(refused());
        }
        self.exact(volume, deadline)
    }
}
