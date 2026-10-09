//! Receipt4 tool installation under the original provider lease. It uses the same
//! artifact/upload boundary as relay startup, but requires no host dependency or
//! authored Compose. No ordinary caller is enabled until persistence qualification.
//! Ambiguous transport retains intent. Saved admission never uploads or repairs;
//! retirement consumes an issued handle and refuses every retained data dependency.
use super::super::{Phase, Receipt, journal};
use super::*;
use crate::{
    Candidate,
    provider::{engine::Engine, guest_tool, storage_root_witness as helper},
};
use base64::Engine as _;
use std::{path::Path, time::Instant};

mod intent;
pub(in crate::provider::graph::native) mod lifecycle;
mod saved;

pub(in crate::provider::graph::native) fn require_idle(root: &Path) -> Result<(), CandidateError> {
    intent::absent(root)
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct Identity {
    pub device: u64,
    pub inode: u64,
    pub helper_device: u64,
    pub helper_inode: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct Reference {
    pub version: u8,
    pub artifact: String,
    pub bytes: u64,
    pub root: Option<DirectoryIdentity>,
    pub helper: Option<DirectoryIdentity>,
}
impl std::fmt::Debug for Reference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PersistentWitnessTool")
    }
}
impl Reference {
    pub(in crate::provider::graph::native) fn validate(&self) -> Result<(), CandidateError> {
        if self.version != 1
            || !super::super::super::hex(&self.artifact, 64)
            || self.bytes == 0
            || self.bytes > 2 * 1024 * 1024
            || self.root.as_ref().is_some_and(|r| r.inode == 0)
            || self
                .helper
                .as_ref()
                .is_some_and(|h| h.inode == 0 || self.root.is_none())
        {
            return Err(refused());
        }
        Ok(())
    }
}
pub(in crate::provider::graph::native) struct Installed {
    run: String,
    owner: String,
    guest: GuestIdentity,
    reference: Reference,
    saved: saved::Saved,
    lifetime: guest_tool::Lifetime,
}
/// Pins the current target receipt even when a different same-lease run supplies
/// the verifier. Anticipated phases may not change its material binding.
pub(in crate::provider::graph::native) struct ReceiptAdmission(saved::Saved);
impl ReceiptAdmission {
    pub(in crate::provider::graph::native) fn capture(
        candidate: &Candidate,
        receipt: &Receipt,
    ) -> Result<Self, CandidateError> {
        let saved = saved::Saved::capture(candidate, receipt.review.scope().run)?;
        saved.receipt()?.check_binding(receipt)?;
        saved.verify()?;
        Ok(Self(saved))
    }
    pub(in crate::provider::graph::native) fn verify(&self) -> Result<(), CandidateError> {
        self.0.verify()
    }
}
fn refused() -> CandidateError {
    super::enrollment::refused()
}
fn check(
    engine: &Engine<'_>,
    deadline: Instant,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    fresh().map_err(|_| refused())?;
    engine.guest().verify().map_err(|_| refused())?;
    if Instant::now() >= deadline {
        return Err(refused());
    }
    Ok(())
}
fn identity(text: &str) -> Result<Identity, CandidateError> {
    let parts: Vec<_> = text
        .strip_suffix('\n')
        .ok_or_else(refused)?
        .split(':')
        .collect();
    if parts.len() != 4 {
        return Err(refused());
    }
    let number = |value: &str| -> Result<u64, CandidateError> {
        if value.is_empty()
            || value.len() > 20
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(refused());
        }
        value.parse().map_err(|_| refused())
    };
    let root = Identity {
        device: number(parts[0])?,
        inode: number(parts[1])?,
        helper_device: number(parts[2])?,
        helper_inode: number(parts[3])?,
    };
    if root.inode == 0 || root.helper_inode == 0 {
        return Err(refused());
    }
    Ok(root)
}
pub(in crate::provider::graph::native) struct InstallOptions<'a, 'guest> {
    pub candidate: &'a Candidate,
    pub engine: &'a Engine<'guest>,
    pub receipt: &'a mut Receipt,
    pub root: &'a Path,
    pub artifact: &'a Path,
    pub digest: &'a str,
    pub deadline: Instant,
    pub fresh: &'a dyn Fn() -> Result<(), CandidateError>,
}
pub(in crate::provider::graph::native) fn install(
    opts: InstallOptions<'_, '_>,
) -> Result<Installed, CandidateError> {
    let InstallOptions {
        candidate,
        engine,
        receipt,
        root,
        artifact,
        digest,
        deadline,
        fresh,
    } = opts;
    if !receipt.persistent()
        || receipt.phase != Phase::Preparing
        || receipt.data_tool.is_some()
        || journal::directory(candidate, receipt.review.scope().run)? != root
    {
        return Err(refused());
    }
    engine
        .tool_lifetime()
        .check(engine.tool_lifetime(), receipt.review.scope().run)?;
    check(engine, deadline, fresh)?;
    let guest = engine
        .guest()
        .persistent_identity()
        .map_err(|_| refused())?;
    if receipt.owner != guest.owner
        || receipt.boot != guest.boot_id
        || receipt
            .data
            .values()
            .any(|data| data.guest_identity() != &guest)
    {
        return Err(refused());
    }
    let (saved, saved_root) = journal::load(
        candidate,
        receipt.review.scope().run,
        &receipt.owner,
        &receipt.boot,
    )?;
    if saved_root != root
        || serde_json::to_vec(&saved).map_err(|_| refused())?
            != serde_json::to_vec(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let artifact = guest_tool::Artifact::read(artifact, digest).map_err(|_| refused())?;
    let reference = Reference {
        version: 1,
        artifact: artifact.digest().into(),
        bytes: artifact.bytes().len() as u64,
        root: None,
        helper: None,
    };
    reference.validate()?;
    receipt.data_tool = Some(reference.clone());
    journal::save(root, receipt)?; // durable intent before any guest installation effect
    let mut admission = ReceiptAdmission::capture(candidate, receipt)?;
    check(engine, deadline, fresh)?;
    artifact.verify().map_err(|_| refused())?;
    admission.verify()?;
    let transport = intent::Intent::begin(root)?;
    check(engine, deadline, fresh)?;
    admission.verify()?;
    transport.verify()?;
    let run = receipt.review.scope().run.to_owned();
    let owner = receipt.owner.clone();
    let prepared = engine
        .guest()
        .execute_input_until(guest_tool::PREPARE, &[&run, &owner], None, deadline, true)
        .map_err(|_| refused())?;
    check(engine, deadline, fresh)?;
    let root_parts: Vec<_> = prepared
        .strip_suffix('\n')
        .ok_or_else(refused)?
        .split(':')
        .collect();
    if root_parts.len() != 2 {
        return Err(refused());
    }
    // Capture the exact original directory before any chunk. No matching later root is adopted.
    let number = |value: &str| -> Result<u64, CandidateError> {
        if value.is_empty()
            || value.len() > 20
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(refused());
        }
        value.parse().map_err(|_| refused())
    };
    let captured = DirectoryIdentity {
        device: number(root_parts[0])?,
        inode: number(root_parts[1])?,
    };
    if captured.inode == 0 {
        return Err(refused());
    }
    let mut reference = reference;
    reference.root = Some(DirectoryIdentity {
        device: captured.device,
        inode: captured.inode,
    });
    receipt.data_tool = Some(reference.clone());
    journal::save(root, receipt)?;
    admission = ReceiptAdmission::capture(candidate, receipt)?;
    for (index, chunk) in artifact.bytes().chunks(24 * 1024).enumerate() {
        check(engine, deadline, fresh)?;
        artifact.verify().map_err(|_| refused())?;
        admission.verify()?;
        transport.verify()?;
        let script = format!(
            "test \"$(stat -c %d:%i /storage/hack-graph-startup/$1)\" = \"$3\"\n{}",
            guest_tool::APPEND
        );
        engine
            .guest()
            .execute_input_until(
                &script,
                &[
                    &run,
                    &(index * 24 * 1024).to_string(),
                    &format!("{}:{}", captured.device, captured.inode),
                ],
                Some(&base64::engine::general_purpose::STANDARD.encode(chunk)),
                deadline,
                true,
            )
            .map_err(|_| refused())?;
        check(engine, deadline, fresh)?;
    }
    artifact.verify().map_err(|_| refused())?;
    check(engine, deadline, fresh)?;
    admission.verify()?;
    transport.verify()?;
    let script = format!(
        "test \"$(stat -c %d:%i /storage/hack-graph-startup/$1)\" = \"$3\"\n{}",
        guest_tool::PUBLISH
    );
    engine
        .guest()
        .execute_input_until(
            &script,
            &[
                &run,
                digest,
                &format!("{}:{}", captured.device, captured.inode),
            ],
            None,
            deadline,
            true,
        )
        .map_err(|_| refused())?;
    check(engine, deadline, fresh)?;
    admission.verify()?;
    transport.verify()?;
    let observed = engine
        .guest()
        .execute_until(
            INSPECT,
            &[&run, &owner, digest, &reference.bytes.to_string()],
            deadline,
        )
        .map_err(|_| refused())?;
    check(engine, deadline, fresh)?;
    admission.verify()?;
    let actual = identity(&observed)?;
    if (actual.device, actual.inode) != (captured.device, captured.inode) {
        return Err(refused());
    }
    // Every installation child has returned a completed response and the final
    // identity matched. Failure before here retains the durable transport fence.
    transport.complete()?;
    reference.root = Some(DirectoryIdentity {
        device: actual.device,
        inode: actual.inode,
    });
    reference.helper = Some(DirectoryIdentity {
        device: actual.helper_device,
        inode: actual.helper_inode,
    });
    receipt.data_tool = Some(reference.clone());
    journal::save(root, receipt)?;
    check(engine, deadline, fresh)?;
    artifact.verify().map_err(|_| refused())?;
    let saved = saved::Saved::capture(candidate, &run)?;
    if serde_json::to_vec(&saved.receipt()?).map_err(|_| refused())?
        != serde_json::to_vec(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let installed = Installed {
        run,
        owner,
        guest,
        reference,
        saved,
        lifetime: engine.tool_lifetime().clone(),
    };
    installed.verify(engine, deadline, fresh)?;
    Ok(installed)
}
impl Installed {
    fn verify(
        &self,
        engine: &Engine<'_>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        lifecycle::verify(
            self,
            &mut lifecycle::Live {
                engine,
                deadline,
                fresh,
            },
        )
    }
    fn identity_string(&self) -> Result<String, CandidateError> {
        let root = self.reference.root.as_ref().ok_or_else(refused)?;
        let helper = self.reference.helper.as_ref().ok_or_else(refused)?;
        Ok(format!(
            "{}:{}:{}:{}",
            root.device, root.inode, helper.device, helper.inode
        ))
    }
    pub(in crate::provider::graph::native) fn invoke(
        &self,
        engine: &Engine<'_>,
        request: helper::Request,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<helper::Observation, CandidateError> {
        lifecycle::invoke(
            self,
            &mut lifecycle::Live {
                engine,
                deadline,
                fresh,
            },
            request,
        )
    }
}
const INSPECT: &str = r#"
base=/storage/hack-graph-startup
root="$base/$1"
test ! -L "$base"; test "$(stat -c %u:%g:%a "$base")" = 0:0:700
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/owner"; test "$(stat -c %u:%g:%a:%h:%s "$root/owner")" = 0:0:444:1:33
test "$(cat "$root/owner")" = "$2"
test ! -e "$root/helper.pending"; test ! -L "$root/helper.pending"
test ! -L "$root/helper"; test -f "$root/helper"
test "$(stat -c %u:%g:%a:%h:%s "$root/helper")" = "0:0:555:1:$4"
test "$(sha256sum "$root/helper" | cut -d' ' -f1)" = "$3"
printf '%s:%s\n' "$(stat -c %d:%i "$root")" "$(stat -c %d:%i "$root/helper")"
"#;
const INVOKE: &str = r#"
base=/storage/hack-graph-startup
root="$base/$1"
test ! -L "$base"; test "$(stat -c %u:%g:%a "$base")" = 0:0:700
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/owner"; test "$(stat -c %u:%g:%a:%h:%s "$root/owner")" = 0:0:444:1:33
test "$(cat "$root/owner")" = "$2"
test ! -L "$root/helper"; test -f "$root/helper"
test "$(stat -c %u:%g:%a:%h:%s "$root/helper")" = "0:0:555:1:$4"
test "$(sha256sum "$root/helper" | cut -d' ' -f1)" = "$3"
test "$(stat -c %d:%i "$root"):$(stat -c %d:%i "$root/helper")" = "$5"
exec "$root/helper" --storage-root-witness
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_tool_is_closed_and_original_root_and_helper_are_distinct_observations() {
        let reference = Reference {
            version: 1,
            artifact: "a".repeat(64),
            bytes: 8192,
            root: None,
            helper: None,
        };
        assert!(reference.validate().is_ok());
        let mut wrong = reference.clone();
        wrong.helper = Some(DirectoryIdentity {
            device: 0,
            inode: 2,
        });
        assert!(wrong.validate().is_err());
        let mut valid = reference.clone();
        valid.root = Some(DirectoryIdentity {
            device: 0,
            inode: 1,
        });
        valid.helper = Some(DirectoryIdentity {
            device: 0,
            inode: 2,
        });
        assert!(valid.validate().is_ok());
        for text in [
            "0:0:0:2\n",
            "0:1:0:0\n",
            "00:1:0:2\n",
            "0:1:0:2\nextra\n",
            "0:1:0:2",
        ] {
            assert!(identity(text).is_err());
        }
        let actual = identity("0:1:0:2\n").unwrap();
        assert_eq!((actual.inode, actual.helper_inode), (1, 2));
        let mut unknown = serde_json::to_value(valid).unwrap();
        unknown["secret"] = serde_json::json!("private-canary");
        assert!(serde_json::from_value::<Reference>(unknown).is_err());
    }
}
