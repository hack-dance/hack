//! Closed witnessed owner assertion. Version 1 remains metadata-only and is never
//! upgraded here. Version 2 binds a private expected root witness before creation.
//! Decode/compare cannot supply original-create, durable commit or helper authority.
//! Whole-root copies retaining the xattr remain outside this continuity guarantee.

use super::{Binding, Observation, VolumeIdentity, binding_valid, volume_valid};
use crate::CandidateError;
use crate::provider::storage_root_witness::{Request, Root};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedWitness {
    pub name: String,
    pub value: String,
}
impl Drop for ExpectedWitness {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}
impl ExpectedWitness {
    pub(super) fn valid(&self, volume: &str, root: Root) -> bool {
        Request::bound(volume, false, root, &self.name, &self.value).is_ok()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootIdentity {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
}
impl From<RootIdentity> for Root {
    fn from(root: RootIdentity) -> Self {
        Self {
            device: root.device,
            inode: root.inode,
            uid: root.uid,
            gid: root.gid,
        }
    }
}
impl From<Root> for RootIdentity {
    fn from(root: Root) -> Self {
        Self {
            device: root.device,
            inode: root.inode,
            uid: root.uid,
            gid: root.gid,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Enrollment {
    Pending {
        intent: String,
        volume_name: String,
        witness: ExpectedWitness,
    },
    Enrolled {
        volume: VolumeIdentity,
        root: RootIdentity,
        witness: ExpectedWitness,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    NativePersistentDataWitnessOwner,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    version: u8,
    kind: Kind,
    pub(super) binding: Binding,
    pub(super) enrollment: Enrollment,
}
#[derive(Clone, Serialize)]
#[serde(transparent)]
pub struct Owner(pub(super) Record);

fn refused() -> CandidateError {
    super::refused()
}
pub fn decode(bytes: &[u8]) -> Result<Owner, CandidateError> {
    if bytes.is_empty() || bytes.len() > super::LIMIT {
        return Err(refused());
    }
    let record: Record = serde_json::from_slice(bytes).map_err(|_| refused())?;
    let name = super::enrollment::volume_name(&record.binding);
    let valid = match &record.enrollment {
        Enrollment::Pending {
            intent,
            volume_name,
            witness,
        } => {
            super::super::super::hex(intent, 32)
                && volume_name == &name
                && witness.valid(
                    &name,
                    Root {
                        device: 0,
                        inode: 1,
                        uid: 0,
                        gid: 0,
                    },
                )
        }
        Enrollment::Enrolled {
            volume,
            root,
            witness,
        } => {
            volume_valid(volume)
                && volume.name == name
                && root.inode != 0
                && (root.device, root.inode) == (volume.directory.device, volume.directory.inode)
                && witness.valid(&name, (*root).into())
        }
    };
    if record.version != 2 || !binding_valid(&record.binding) || !valid {
        return Err(refused());
    }
    Ok(Owner(record))
}
pub(super) fn pending(binding: Binding, intent: String, witness: ExpectedWitness) -> Owner {
    Owner(Record {
        version: 2,
        kind: Kind::NativePersistentDataWitnessOwner,
        enrollment: Enrollment::Pending {
            volume_name: super::enrollment::volume_name(&binding),
            intent,
            witness,
        },
        binding,
    })
}
pub(super) fn enrolled(
    binding: Binding,
    volume: VolumeIdentity,
    root: RootIdentity,
    witness: ExpectedWitness,
) -> Owner {
    Owner(Record {
        version: 2,
        kind: Kind::NativePersistentDataWitnessOwner,
        binding,
        enrollment: Enrollment::Enrolled {
            volume,
            root,
            witness,
        },
    })
}
pub(super) fn matches(
    owner: &Owner,
    binding: &Binding,
    observed: Option<&Observation>,
    root: RootIdentity,
) -> Result<(), CandidateError> {
    let Enrollment::Enrolled {
        volume,
        root: expected,
        ..
    } = &owner.0.enrollment
    else {
        return Err(refused());
    };
    let observed = observed.ok_or_else(refused)?;
    if !binding_valid(binding)
        || observed.binding != *binding
        || owner.0.binding != *binding
        || observed.volume != *volume
        || *expected != root
    {
        return Err(refused());
    }
    // Validate the constructed assertion as strictly as a serialized one.
    decode(&serde_json::to_vec(owner).map_err(|_| refused())?)?;
    Ok(())
}
