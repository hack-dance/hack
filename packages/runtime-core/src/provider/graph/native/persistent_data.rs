//! Inactive, data-only persistent-volume identity codec for the private native candidate.
//!
//! A decoded enrolled record is an assertion to compare, not proof of durable enrollment,
//! freshness, or permission to create, adopt, start, repair or delete anything. No runtime
//! generation, graph run, plan, dependency-cache completion or application data is encoded.
//! Future enrollment must own its commit point and obtain the original identities itself.

use crate::CandidateError;
use serde::{Deserialize, Serialize};

pub use crate::provider::identity::DiskIdentity;

const LIMIT: usize = 4096;

fn refused() -> CandidateError {
    CandidateError::new(
        "native_persistent_data_identity",
        "Persistent data enrollment is incomplete, malformed or changed; no data effects were authorized.",
    )
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub namespace: String,
    pub storage: String,
    pub owner: String,
}

/// Conservative same-guest fence. A different boot or backing disk requires a future
/// separately owned handoff; this codec never infers that two guests share the same data.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuestIdentity {
    pub owner: String,
    pub boot_id: String,
    pub storage: DiskIdentity,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Local {
    Local,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoOptions {}

/// Only the existing default local-volume policy is representable. Unknown driver,
/// scope or options refuse rather than importing provider/cache semantics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub driver: Local,
    pub scope: Local,
    pub options: NoOptions,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub scope: Scope,
    pub guest: GuestIdentity,
    pub policy: Policy,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryIdentity {
    pub device: u64,
    pub inode: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolumeIdentity {
    pub name: String,
    pub created_at: String,
    pub directory: DirectoryIdentity,
}

/// Complete already-acquired observation. Constructing or deserializing this object
/// does not establish that an engine or guest actually supplied these facts.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub binding: Binding,
    pub volume: VolumeIdentity,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    NativePersistentDataOwner,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Enrollment {
    Pending { intent: String, volume_name: String },
    Enrolled { volume: VolumeIdentity },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    kind: Kind,
    binding: Binding,
    enrollment: Enrollment,
}

/// Closed validated record; no public constructor/promoter or effect capability.
#[derive(Clone, Serialize)]
#[serde(transparent)]
pub struct Owner(Record);

/// Decode only, with the byte bound applied before deserialization allocations.
/// Duplicate/unknown fields, missing/null values and unsupported versions refuse.
pub fn decode(bytes: &[u8]) -> Result<Owner, CandidateError> {
    if bytes.is_empty() || bytes.len() > LIMIT {
        return Err(refused());
    }
    let record: Record = serde_json::from_slice(bytes).map_err(|_| refused())?;
    let enrollment_valid = match &record.enrollment {
        Enrollment::Pending {
            intent,
            volume_name,
        } => super::super::hex(intent, 32) && volume_name_valid(volume_name),
        Enrollment::Enrolled { volume } => volume_valid(volume),
    };
    if record.version != 1 || !binding_valid(&record.binding) || !enrollment_valid {
        return Err(refused());
    }
    Ok(Owner(record))
}

pub struct CompareOptions<'a> {
    pub record: &'a Owner,
    pub expected: &'a Binding,
    pub observed: Option<&'a Observation>,
}

/// Pure equality fence independent of any caller's runtime-generation reference.
/// Pending enrollment never matches, including an otherwise exact current observation.
/// Success is not durable-record, observation freshness, lease or execution authority.
pub fn compare(options: CompareOptions<'_>) -> Result<(), CandidateError> {
    let Enrollment::Enrolled { volume } = &options.record.0.enrollment else {
        return Err(refused());
    };
    let observed = options.observed.ok_or_else(refused)?;
    if !binding_valid(options.expected)
        || !binding_valid(&observed.binding)
        || !volume_valid(&observed.volume)
        || options.record.0.binding != *options.expected
        || observed.binding != *options.expected
        || observed.volume != *volume
    {
        return Err(refused());
    }
    Ok(())
}

fn binding_valid(binding: &Binding) -> bool {
    let guest = &binding.guest;
    let disk = &guest.storage;
    super::super::hex(&binding.scope.namespace, 64)
        && super::super::hex(&binding.scope.owner, 32)
        && logical_name(&binding.scope.storage)
        && super::super::hex(&guest.owner, 32)
        && uuid(&guest.boot_id)
        && disk.inode > 0
        && disk.bytes > 0
        && uuid(&disk.uuid)
}
fn logical_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_' | b'.'))
        })
}
fn volume_name_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'-' | b'_' | b'.'))
        })
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
fn volume_valid(volume: &VolumeIdentity) -> bool {
    volume_name_valid(&volume.name) && volume.directory.inode > 0 && timestamp(&volume.created_at)
}

// Closed UTC RFC3339Nano spelling. Equality retains the supplied engine bytes;
// alternate spellings are not silently normalized into a replacement's birth.
fn timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(20..=30).contains(&bytes.len())
        || bytes.last() != Some(&b'Z')
        || [4, 7].iter().any(|index| bytes[*index] != b'-')
        || bytes[10] != b'T'
        || [13, 16].iter().any(|index| bytes[*index] != b':')
        || !(bytes.len() == 20 || (bytes.len() >= 22 && bytes[19] == b'.'))
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![4, 7, 10, 13, 16, bytes.len() - 1].contains(&index)
                && !(index == 19 && bytes.len() > 20)
                && !byte.is_ascii_digit()
        })
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0_u32, |n, b| n * 10 + u32::from(*b - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    let zero_birth = year == 1
        && month == 1
        && day == 1
        && number(11, 13) == 0
        && number(14, 16) == 0
        && number(17, 19) == 0
        && (bytes.len() == 20 || bytes[20..bytes.len() - 1].iter().all(|b| *b == b'0'));
    year > 0
        && !zero_birth
        && day > 0
        && day <= days
        && number(11, 13) < 24
        && number(14, 16) < 60
        && number(17, 19) < 60
}

#[cfg(test)]
mod tests;
