//! Canonical records and checksums for detecting incomplete or misplaced writes.

use super::key::digest_text;
use super::{InputDigest, MissReason, Result, StepClass, StepKey, Store, disk, invalid};
use crate::canonical_digest::{self, Digest, STEP_RECORD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;

const VERSION: u8 = 1;
/// A record holds a handful of digests and identifiers; anything larger is torn.
pub(super) const MAX_RECORD_BYTES: u64 = 64 * 1024;
/// The largest time a record may carry: 2^53 - 1, the TypeScript safe integer.
const MAX_SAFE_MILLIS: u64 = (1 << 53) - 1;
const FIELDS: [&str; 11] = [
    "check",
    "class",
    "epoch",
    "inputs",
    "key",
    "observedAt",
    "output",
    "producedBy",
    "step",
    "stepVersion",
    "v",
];

/// True when `value` is an object with exactly these field names.
fn has_fields(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.len() == names.len() && names.iter().all(|name| fields.contains_key(*name))
    })
}

/// A step's value-free output identity and optional storage reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    #[serde(with = "digest_text")]
    pub digest: Digest,
    #[serde(rename = "ref")]
    pub reference: Option<OutputRef>,
}

/// Where the output bytes can be read.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputRef {
    Cas,
}

/// Value-free identifiers for the build and run that observed the effect.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProducedBy {
    pub build: String,
    pub run: String,
}

/// A cache record whose on-disk checksum was verified or that this handle just wrote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    v: u8,
    pub step: String,
    pub step_version: u32,
    pub class: StepClass,
    #[serde(with = "digest_text")]
    pub key: Digest,
    pub inputs: BTreeMap<String, InputDigest>,
    pub epoch: Option<String>,
    pub output: Output,
    pub observed_at: u64,
    pub produced_by: ProducedBy,
}

impl Record {
    pub(super) fn decode(bytes: &[u8], key: &StepKey) -> std::result::Result<Self, MissReason> {
        let mut value: Value = serde_json::from_slice(bytes).map_err(|_| MissReason::TornRecord)?;
        // Writers in both languages emit canonical bytes only. Requiring them here
        // makes Rust and TypeScript accept exactly the same records (no other number
        // spelling, field order or whitespace).
        if canonical_digest::canonical_json(&value).ok().as_deref() != Some(bytes) {
            return Err(MissReason::TornRecord);
        }
        match value.get("v") {
            Some(version) if version.as_u64() == Some(u64::from(VERSION)) => {}
            Some(_) => return Err(MissReason::VersionChanged),
            None => return Err(MissReason::TornRecord),
        }
        // Exactly these fields, none missing: a missing optional field is torn in
        // both languages rather than read as null in one of them.
        if !has_fields(&value, &FIELDS)
            || !has_fields(&value["output"], &["digest", "ref"])
            || !has_fields(&value["producedBy"], &["build", "run"])
        {
            return Err(MissReason::TornRecord);
        }
        let check = value
            .as_object_mut()
            .and_then(|fields| fields.remove("check"))
            .and_then(|check| digest_text::parse(check.as_str()?))
            .ok_or(MissReason::TornRecord)?;
        if canonical_digest::digest(STEP_RECORD, &value).ok() != Some(check) {
            return Err(MissReason::TornRecord);
        }
        let record: Self = serde_json::from_value(value).map_err(|_| MissReason::TornRecord)?;
        if record.key != key.digest()
            || record.step != key.step
            || record.step_version != key.step_version
            || record.class != key.class
            || record.inputs != key.inputs
            || record.epoch != key.epoch
            || record.produced_by.build != key.build
            || !super::key::valid_identifier(&record.produced_by.run)
            // The TypeScript twin reads numbers as doubles: a time above 2^53 - 1
            // is torn in both languages rather than accepted in one of them.
            || record.observed_at > MAX_SAFE_MILLIS
        {
            return Err(MissReason::TornRecord);
        }
        Ok(record)
    }

    pub(super) fn encode(&self) -> Result<Vec<u8>> {
        let failure = |_| invalid("Cannot encode the step record.");
        let mut value = serde_json::to_value(self).map_err(failure)?;
        let check = canonical_digest::digest(STEP_RECORD, &value)
            .map_err(|_| invalid("Cannot check the step record."))?;
        value["check"] = Value::String(check.to_string());
        canonical_digest::canonical_json(&value)
            .map_err(|_| invalid("Cannot encode the step record."))
    }
}

impl Store {
    /// Publish a record. Call only after observing the effect (rule 1).
    /// For CAS steps, call only after `put_cas` returned the output digest.
    /// The run identifier must be value-free.
    pub fn record(&self, key: &StepKey, output: Output, run: &str) -> Result<Record> {
        if !super::key::valid_identifier(run) {
            return Err(invalid("Invalid step run identifier."));
        }
        if key.class == StepClass::Cas && output.reference != Some(OutputRef::Cas) {
            return Err(invalid("CAS step lacks a CAS output reference."));
        }
        let record = Record {
            v: VERSION,
            step: key.step.clone(),
            step_version: key.step_version,
            class: key.class,
            key: key.digest(),
            inputs: key.inputs.clone(),
            epoch: key.epoch.clone(),
            output,
            observed_at: disk::unix_millis()?,
            produced_by: ProducedBy {
                build: key.build.clone(),
                run: run.to_owned(),
            },
        };
        let shard = self.record_shard(key);
        disk::create_directory(&shard)?;
        let path = shard.join(format!("{:x}.json", crate::Hex(key.digest().0)));
        let bytes = record.encode()?;
        // A record the reader would call torn is never written.
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(invalid("Step record exceeds the step store limit."));
        }
        disk::publish(&self.root, &path, &bytes)?;
        Ok(record)
    }

    pub(super) fn read_record(
        &self,
        key: &StepKey,
    ) -> Result<std::result::Result<(Record, File), MissReason>> {
        let path = self
            .record_shard(key)
            .join(format!("{:x}.json", crate::Hex(key.digest().0)));
        let Some(mut file) = self.read_file(&path)? else {
            return Ok(Err(MissReason::NoRecord));
        };
        let decoded = match disk::read_limited(&mut file, MAX_RECORD_BYTES)? {
            Some(bytes) => Record::decode(&bytes, key),
            None => Err(MissReason::TornRecord),
        };
        match decoded {
            Ok(record) => Ok(Ok((record, file))),
            Err(reason) => {
                // Best effort: the record is a miss either way.
                let _ = disk::remove_current(&file, &path);
                Ok(Err(reason))
            }
        }
    }

    fn record_shard(&self, key: &StepKey) -> PathBuf {
        let digest = key.digest();
        self.root
            .join("records")
            .join(&key.step)
            .join(format!("{:x}", crate::Hex(&digest.0[..1])))
    }
}
