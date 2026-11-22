//! Step identities contain only digests and value-free metadata.

use super::{Result, invalid};
use crate::canonical_digest::{self, Digest, STEP};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// Maximum input count, so a key and its metadata can fit in one record.
pub(super) const MAX_STEP_INPUTS: usize = 256;

/// The identity of a runtime build, embedded in the executable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Build(String);

impl Build {
    /// The running image's version and build-input hash.
    pub fn current() -> Result<Self> {
        Self::validated(format!(
            "{}+{}:{}",
            crate::CANDIDATE_VERSION,
            env!("CARGO_PKG_VERSION"),
            env!("HACK_RUNTIME_BUILD_ID")
        ))
    }

    #[cfg(test)]
    pub(super) fn named(name: &str) -> Result<Self> {
        Self::validated(name.to_owned())
    }

    fn validated(name: String) -> Result<Self> {
        if !valid_identifier(&name) {
            return Err(invalid("Invalid step build identifier."));
        }
        Ok(Self(name))
    }
}

/// Which evidence a lookup needs to reuse a step.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepClass {
    Cas,
    Slot,
    Boot,
    FileIdentity,
}

/// A step input's digest. Use a keyed digest for identities derived from secrets.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct InputDigest(#[serde(with = "digest_text")] pub Digest);

/// A canonical step identity and the value-free fields needed to write its record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepKey {
    pub(super) step: String,
    pub(super) step_version: u32,
    pub(super) class: StepClass,
    pub(super) inputs: BTreeMap<String, InputDigest>,
    pub(super) epoch: Option<String>,
    pub(super) build: String,
    digest: Digest,
}

impl StepKey {
    /// Derive a key from validated names, input digests and value-free epoch and build identifiers.
    pub fn new(
        step: &str,
        step_version: u32,
        class: StepClass,
        inputs: &BTreeMap<String, InputDigest>,
        epoch: Option<&str>,
        build: &Build,
    ) -> Result<Self> {
        if inputs.len() > MAX_STEP_INPUTS {
            return Err(invalid("Too many step inputs."));
        }
        if !valid_name(step) || !inputs.keys().all(|name| valid_name(name)) {
            return Err(invalid("Invalid step or input name."));
        }
        if !epoch.is_none_or(valid_identifier) {
            return Err(invalid("Invalid step epoch identifier."));
        }
        let identity = json!({
            "step": step,
            "stepVersion": step_version,
            "class": class,
            "inputs": inputs,
            "epoch": epoch,
            "build": build.0,
        });
        let digest = canonical_digest::digest(STEP, &identity)
            .map_err(|_| invalid("Cannot encode the step key."))?;
        Ok(Self {
            step: step.to_owned(),
            step_version,
            class,
            inputs: inputs.clone(),
            epoch: epoch.map(str::to_owned),
            build: build.0.clone(),
            digest,
        })
    }

    /// The digest used for record addressing.
    pub fn digest(&self) -> Digest {
        self.digest
    }
}

/// A value-free identifier stored in plain text (build, boot epoch, run): 1 to 128
/// bytes of ASCII letters, digits and `.`, `_`, `:`, `+`, `-`. It cannot carry a
/// path, a space-separated value or arbitrary text.
pub(super) fn valid_identifier(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
        })
}

fn valid_name(name: &str) -> bool {
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let mut bytes = name.bytes();
    name.len() <= 64
        && bytes.next().is_some_and(alphanumeric)
        && bytes.all(|byte| alphanumeric(byte) || matches!(byte, b'.' | b'-'))
}

pub(super) mod digest_text {
    use crate::canonical_digest::Digest;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(digest: &Digest, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(digest)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Digest, D::Error> {
        let text = String::deserialize(deserializer)?;
        parse(&text).ok_or_else(|| serde::de::Error::custom("Invalid SHA-256 digest."))
    }

    pub(in crate::store) fn parse(text: &str) -> Option<Digest> {
        let hex = text.strip_prefix("sha256:")?.as_bytes();
        if hex.len() != 64 {
            return None;
        }
        let mut bytes = [0; 32];
        for (byte, pair) in bytes.iter_mut().zip(hex.chunks_exact(2)) {
            *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
        }
        Some(Digest(bytes))
    }

    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }
}
