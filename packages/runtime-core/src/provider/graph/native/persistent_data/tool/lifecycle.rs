//! Re-admit exact saved tools; consume an issued handle for dependency-free retirement.
use super::*;
use crate::provider::{graph::storage_inventory, state};
use std::{fs, os::unix::fs::MetadataExt};
use zeroize::{Zeroize, Zeroizing};

pub(in crate::provider::graph::native) struct ReopenOptions<'a, 'guest> {
    pub candidate: &'a Candidate,
    pub engine: &'a Engine<'guest>,
    pub receipt: &'a Receipt,
    pub root: &'a Path,
    pub deadline: Instant,
    pub fresh: &'a dyn Fn() -> Result<(), CandidateError>,
}
/// Read-only admission, including Removed receipt4 data references. Incomplete
/// installation and a changed receipt incarnation refuse without upload or repair.
pub(in crate::provider::graph::native) fn reopen(
    options: ReopenOptions<'_, '_>,
) -> Result<Installed, CandidateError> {
    let ReopenOptions {
        candidate,
        engine,
        receipt,
        root,
        deadline,
        fresh,
    } = options;
    if journal::directory(candidate, receipt.review.scope().run)? != root {
        return Err(refused());
    }
    reopen_with(
        candidate,
        receipt,
        &mut Live {
            engine,
            deadline,
            fresh,
        },
    )
}

// Private ports exercise the same sequencing as the original OwnedGuest transport.
// Neither a decoded reference nor a caller-provided callback can issue a handle.
pub(super) trait Port {
    fn lifetime(&self) -> &guest_tool::Lifetime;
    fn check(&mut self, guest: &GuestIdentity) -> Result<(), CandidateError>;
    fn inspect(&mut self, installed: &Installed) -> Result<String, CandidateError>;
    fn invoke(
        &mut self,
        installed: &Installed,
        input: &str,
        seed: bool,
    ) -> Result<String, CandidateError>;
    fn remove(&mut self, installed: &Installed) -> Result<String, CandidateError>;
}
pub(super) struct Live<'a, 'guest> {
    pub engine: &'a Engine<'guest>,
    pub deadline: Instant,
    pub fresh: &'a dyn Fn() -> Result<(), CandidateError>,
}
impl Port for Live<'_, '_> {
    fn lifetime(&self) -> &guest_tool::Lifetime {
        self.engine.tool_lifetime()
    }
    fn check(&mut self, guest: &GuestIdentity) -> Result<(), CandidateError> {
        check(self.engine, self.deadline, self.fresh)?;
        if self
            .engine
            .guest()
            .persistent_identity()
            .map_err(|_| refused())?
            != *guest
        {
            return Err(refused());
        }
        Ok(())
    }
    fn inspect(&mut self, installed: &Installed) -> Result<String, CandidateError> {
        self.engine
            .guest()
            .execute_until(
                INSPECT,
                &[
                    &installed.run,
                    &installed.owner,
                    &installed.reference.artifact,
                    &installed.reference.bytes.to_string(),
                ],
                self.deadline,
            )
            .map_err(|_| refused())
    }
    fn remove(&mut self, installed: &Installed) -> Result<String, CandidateError> {
        let script = format!(
            "{INSPECT}\ntest \"$(stat -c %d:%i \"$root\"):$(stat -c %d:%i \"$root/helper\")\" = \"$5\"\n{REMOVE}"
        );
        let bytes = installed.reference.bytes.to_string();
        let identity = installed.identity_string()?;
        self.engine
            .guest()
            .execute_input_until(
                &script,
                &[
                    &installed.run,
                    &installed.owner,
                    &installed.reference.artifact,
                    &bytes,
                    &identity,
                ],
                None,
                self.deadline,
                false,
            )
            .map_err(|_| refused())
    }
    fn invoke(
        &mut self,
        installed: &Installed,
        input: &str,
        seed: bool,
    ) -> Result<String, CandidateError> {
        self.engine
            .guest()
            .execute_input_until(
                INVOKE,
                &[
                    &installed.run,
                    &installed.owner,
                    &installed.reference.artifact,
                    &installed.reference.bytes.to_string(),
                    &installed.identity_string()?,
                ],
                Some(input),
                self.deadline,
                seed,
            )
            .map_err(|_| refused())
    }
}
fn reopen_with(
    candidate: &Candidate,
    receipt: &Receipt,
    port: &mut impl Port,
) -> Result<Installed, CandidateError> {
    if !receipt.persistent() {
        return Err(refused());
    }
    receipt
        .validate(receipt.review.scope().run, &receipt.owner)
        .map_err(|_| refused())?;
    let reference = receipt.data_tool.as_ref().ok_or_else(refused)?.clone();
    reference.validate()?;
    if reference.root.is_none() || reference.helper.is_none() {
        return Err(refused());
    }
    let saved = saved::Saved::capture(candidate, receipt.review.scope().run)?;
    let current = saved.receipt()?;
    if serde_json::to_vec(&current).map_err(|_| refused())?
        != serde_json::to_vec(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let guest = receipt
        .data
        .values()
        .next()
        .ok_or_else(refused)?
        .guest_identity()
        .clone();
    if receipt
        .data
        .values()
        .any(|data| data.guest_identity() != &guest)
        || guest.owner != receipt.owner
        || guest.boot_id != receipt.boot
    {
        return Err(refused());
    }
    let installed = Installed {
        run: receipt.review.scope().run.into(),
        owner: receipt.owner.clone(),
        guest,
        reference,
        saved,
        lifetime: port.lifetime().clone(),
    };
    verify(&installed, port)?;
    Ok(installed)
}
pub(super) fn verify(installed: &Installed, port: &mut impl Port) -> Result<(), CandidateError> {
    let admitted = installed.lifetime.enter(port.lifetime(), &installed.run)?;
    installed.reference.validate()?;
    installed.saved.verify()?;
    observe(installed, port)?;
    installed.saved.verify()?;
    port.check(&installed.guest)?;
    installed.saved.verify()?;
    installed.lifetime.check(port.lifetime(), &installed.run)?;
    admitted.complete();
    Ok(())
}
pub(super) fn invoke(
    installed: &Installed,
    port: &mut impl Port,
    request: helper::Request,
) -> Result<helper::Observation, CandidateError> {
    let admitted = installed.lifetime.enter(port.lifetime(), &installed.run)?;
    verify(installed, port)?;
    let seed = request.is_seed();
    let mut input = Zeroizing::new(String::from_utf8(request.encode()).map_err(|_| refused())?);
    port.check(&installed.guest)?;
    // This is the final caller callback before transport, including a seed.
    installed.saved.verify()?;
    installed.lifetime.check(port.lifetime(), &installed.run)?;
    let result = port.invoke(installed, &input, seed);
    input.zeroize();
    let output = result.map_err(|_| {
        installed.lifetime.uncertain(&installed.run);
        refused()
    })?;
    port.check(&installed.guest)?;
    verify(installed, port)?;
    let observation = helper::Observation::decode(output.as_bytes()).map_err(|_| {
        installed.lifetime.uncertain(&installed.run);
        refused()
    })?;
    admitted.complete();
    Ok(observation)
}
fn observe(installed: &Installed, port: &mut impl Port) -> Result<(), CandidateError> {
    installed.lifetime.check(port.lifetime(), &installed.run)?;
    port.check(&installed.guest)?;
    let output = port.inspect(installed).map_err(|_| {
        installed.lifetime.uncertain(&installed.run);
        refused()
    })?;
    port.check(&installed.guest)?;
    if identity(&output)? != identity(&format!("{}\n", installed.identity_string()?))? {
        return Err(refused());
    }
    Ok(())
}

impl Installed {
    /// Consumes original admission. All canonical receipts (even Removed) retain
    /// their data-proof dependency. No current caller removes/archives that proof,
    /// so ordinary workload removal cannot make its helper eligible for retirement.
    /// A failed/ambiguous removal is never retried or followed by competing cleanup.
    pub(in crate::provider::graph::native) fn retire(
        self,
        candidate: &Candidate,
        engine: &Engine<'_>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        retire_with(
            self,
            candidate,
            &mut Live {
                engine,
                deadline,
                fresh,
            },
        )
    }
}
fn retire_with(
    installed: Installed,
    candidate: &Candidate,
    port: &mut impl Port,
) -> Result<(), CandidateError> {
    // Canonical scope must be the same one that issued this non-cloneable handle.
    if journal::directory(candidate, &installed.run)? != installed.saved.root() {
        return Err(refused());
    }
    let inventory = Inventory::capture(candidate, &installed)?;
    {
        let admitted = installed.lifetime.enter(port.lifetime(), &installed.run)?;
        observe(&installed, port)?;
        admitted.complete();
    }
    inventory.verify(candidate, &installed)?;
    port.check(&installed.guest)?;
    // A caller freshness callback cannot publish a new dependency after the last
    // inventory read. The live remove independently rechecks OwnedGuest's lease.
    inventory.verify(candidate, &installed)?;
    installed.lifetime.retire(port.lifetime(), &installed.run)?;
    let reply = port.remove(&installed)?; // unknown result consumes authority; no follow-up
    if reply != format!("{}\nretired\n", installed.identity_string()?) {
        return Err(refused());
    }
    port.check(&installed.guest)?;
    inventory.verify(candidate, &installed)
}
#[derive(PartialEq, Eq)]
struct Inventory {
    parent: (u64, u64),
    receipts: Vec<saved::Saved>,
}
impl Inventory {
    fn capture(candidate: &Candidate, installed: &Installed) -> Result<Self, CandidateError> {
        installed.saved.parents()?;
        let parent = candidate.state_root.join("run/native-graphs");
        state::check_private_directory(&parent).map_err(|_| refused())?;
        let metadata = fs::symlink_metadata(&parent).map_err(|_| refused())?;
        let mut receipts = Vec::new();
        for run in storage_inventory::runs(&parent).map_err(|_| refused())? {
            if run == installed.run {
                return Err(refused());
            }
            let saved = saved::Saved::capture(candidate, &run)?;
            let receipt = saved.receipt()?;
            if receipt.data_tool.as_ref().is_some_and(|tool| {
                tool.root.is_none()
                    || tool.helper.is_none()
                    || tool.root == installed.reference.root
                    || tool.helper == installed.reference.helper
            }) {
                return Err(refused());
            }
            receipts.push(saved);
        }
        Ok(Self {
            parent: (metadata.dev(), metadata.ino()),
            receipts,
        })
    }
    fn verify(&self, candidate: &Candidate, installed: &Installed) -> Result<(), CandidateError> {
        if *self != Self::capture(candidate, installed)? {
            return Err(refused());
        }
        Ok(())
    }
}
// No recursive deletion, glob cleanup, base-directory removal or retry. Unknown
// entries refuse before unlink. Partial failure retains the original host evidence.
const REMOVE: &str = r#"
test "$(find "$root" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2
rm -- "$root/helper"
rm -- "$root/owner"
rmdir -- "$root"
sync -f "$base"
test ! -e "$root"; test ! -L "$root"
printf 'retired\n'
"#;

#[cfg(test)]
mod tests;
