//! Canonical records and checksums for detecting incomplete or misplaced writes.

use super::key::digest_text;
use super::{InputDigest, MissReason, Result, StepClass, StepKey, Store, disk, invalid, io_error};
use crate::canonical_digest::{self, Digest, STEP_RECORD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

const VERSION: u8 = 1;

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
    fn decode(bytes: &[u8], key: &StepKey) -> std::result::Result<Self, MissReason> {
        let mut value: Value = serde_json::from_slice(bytes).map_err(|_| MissReason::TornRecord)?;
        match value.get("v") {
            Some(version) if version.as_u64() == Some(u64::from(VERSION)) => {}
            Some(_) => return Err(MissReason::VersionChanged),
            None => return Err(MissReason::TornRecord),
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
        {
            return Err(MissReason::TornRecord);
        }
        Ok(record)
    }

    fn encode(&self) -> Result<Vec<u8>> {
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
        disk::publish(&self.root, &path, &record.encode()?)?;
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
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_error)?;
        match Record::decode(&bytes, key) {
            Ok(record) => Ok(Ok((record, file))),
            Err(reason) => {
                disk::remove_current(&file, &path)?;
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
