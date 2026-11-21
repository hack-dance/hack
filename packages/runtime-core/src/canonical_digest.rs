//! Domain-separated SHA-256 over canonical JSON.
//!
//! One encoder for every identity Hack derives from structured inputs: the
//! container specification digest and stored step keys. The TypeScript twin
//! reads the same vector file (`canonical_digest_vectors.json`); a vector that
//! passes in one language and fails in the other is a bug in one of them.
//!
//! Preimage: `domain || 0x00 || canonical_json(value)`, digest written
//! `sha256:<64 lowercase hex>`. A domain is `hack.<name>/<version>`; a new use
//! adds a constant and never reuses an existing domain.
//!
//! Canonical JSON:
//! - no insignificant whitespace; arrays keep their order;
//! - object keys sorted by Unicode code point (UTF-8 byte order);
//! - numbers are identified by value and must be integers: every i64 and u64
//!   integer is written exactly in decimal; a float with an integral value
//!   within +-(2^53 - 1) is written as that integer (`1.0` and `1e3` are `1`
//!   and `1000`, `-0` is `0`), as a JavaScript encoder sees them; fractions
//!   and larger floats (not exact) are refused, so no float formatting is ever
//!   hashed. A twin in a language whose JSON numbers are doubles must parse
//!   vectors beyond +-(2^53 - 1) losslessly (big integers);
//! - strings are UTF-8 with exactly these escapes: `\"`, `\\`, `\b`, `\f`,
//!   `\n`, `\r`, `\t`, and `\u00xx` (lowercase hex) for every other code
//!   point below U+0020. Everything else, including `/` and non-ASCII, is
//!   written as is.
//!
//! The encoder is pure: no clock, no environment, no graph dependency.
use crate::CandidateError;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::fmt;

/// A digest domain, validated when it is declared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Domain(&'static str);

impl Domain {
    /// Panics at compile time (in a `const`) for a malformed domain.
    pub const fn new(name: &'static str) -> Self {
        assert!(valid_domain(name.as_bytes()), "invalid digest domain");
        Self(name)
    }
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// The container specification digest (`io.hack-local.spec`).
pub const CONTAINER_SPEC: Domain = Domain::new("hack.container-spec/1");
/// Stored step keys.
pub const STEP: Domain = Domain::new("hack.step/1");
/// Integrity checks for stored step records.
pub const STEP_RECORD: Domain = Domain::new("hack.step-record/1");

const fn valid_domain(bytes: &[u8]) -> bool {
    const PREFIX: &[u8] = b"hack.";
    if bytes.len() <= PREFIX.len() || bytes.len() > 64 {
        return false;
    }
    let mut i = 0;
    while i < PREFIX.len() {
        if bytes[i] != PREFIX[i] {
            return false;
        }
        i += 1;
    }
    let name_start = i;
    while i < bytes.len()
        && (bytes[i].is_ascii_lowercase() || bytes[i].is_ascii_digit() || bytes[i] == b'-')
    {
        i += 1;
    }
    if i == name_start || i >= bytes.len() || bytes[i] != b'/' {
        return false;
    }
    i += 1;
    if i >= bytes.len() || !matches!(bytes[i], b'1'..=b'9') {
        return false;
    }
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            return false;
        }
        i += 1;
    }
    true
}

/// A SHA-256 digest; displays as `sha256:<hex>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest(pub [u8; 32]);

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{:x}", crate::Hex(self.0))
    }
}

const MAX_SAFE: i64 = (1 << 53) - 1;

fn refused(message: &'static str) -> CandidateError {
    CandidateError::new("canonical_value", message)
}

/// The canonical bytes of `value`.
pub fn canonical_json(value: &Value) -> Result<Vec<u8>, CandidateError> {
    let mut out = Vec::new();
    write(value, &mut out)?;
    Ok(out)
}

/// SHA-256 of `domain || 0x00 || canonical_json(value)`.
pub fn digest(domain: Domain, value: &Value) -> Result<Digest, CandidateError> {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(canonical_json(value)?);
    Ok(Digest(hasher.finalize().into()))
}

fn write(value: &Value, out: &mut Vec<u8>) -> Result<(), CandidateError> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(number) => {
            let text = if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else {
                let float = number.as_f64().unwrap_or(f64::NAN);
                if float.fract() != 0.0 || float.abs() > MAX_SAFE as f64 {
                    return Err(refused(
                        "Canonical numbers are integers; a float must be an exact integer value.",
                    ));
                }
                // Exact: integral and within the range a double holds exactly.
                (float as i64).to_string()
            };
            out.extend_from_slice(text.as_bytes());
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write(item, out)?;
            }
            out.push(b']');
        }
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            // `str` ordering is UTF-8 byte order, which is code point order.
            keys.sort_unstable();
            out.push(b'{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string(key, out);
                out.push(b':');
                write(&fields[key], out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

fn write_string(text: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for ch in text.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes());
            }
            c => {
                let mut buffer = [0; 4];
                out.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vectors {
        schema: String,
        #[allow(dead_code)]
        note: String,
        vectors: Vec<Vector>,
        refused: Vec<Refused>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vector {
        name: String,
        domain: String,
        /// Exact JSON text: numbers are identified by value, not spelling.
        input_text: String,
        canonical: String,
        sha256: String,
        /// Integers beyond +-(2^53 - 1): a double-based twin parses losslessly.
        #[serde(default)]
        #[allow(dead_code)]
        lossless_parse: bool,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Refused {
        name: String,
        /// Raw JSON text, so numbers keep the form the vector states.
        input: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("canonical_digest_vectors.json")).unwrap()
    }
    fn domain(name: &str) -> Domain {
        match name {
            "hack.container-spec/1" => CONTAINER_SPEC,
            "hack.step/1" => STEP,
            "hack.test-vector/1" => Domain::new("hack.test-vector/1"),
            other => panic!("vector names an undeclared domain {other}"),
        }
    }

    #[test]
    fn shared_vectors_match_canonical_bytes_and_digest() {
        let file = vectors();
        assert_eq!(file.schema, "hack.canonical-digest-vectors/1");
        assert!(file.vectors.len() >= 15);
        for vector in &file.vectors {
            let input: Value = serde_json::from_str(&vector.input_text).unwrap();
            let bytes = canonical_json(&input).unwrap();
            assert_eq!(
                String::from_utf8(bytes).unwrap(),
                vector.canonical,
                "{}",
                vector.name
            );
            assert_eq!(
                digest(domain(&vector.domain), &input).unwrap().to_string(),
                vector.sha256,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn shared_refusals_are_refused() {
        for case in vectors().refused {
            let value: Value = serde_json::from_str(&case.input).unwrap();
            let failure = canonical_json(&value).unwrap_err();
            assert_eq!(failure.code, "canonical_value", "{}", case.name);
        }
    }

    #[test]
    fn domains_separate_equal_values() {
        let value = serde_json::json!({"a": 1});
        assert_ne!(
            digest(CONTAINER_SPEC, &value).unwrap(),
            digest(STEP, &value).unwrap()
        );
    }

    #[test]
    fn malformed_domains_are_refused() {
        for name in [
            "hack./1",
            "hack.x",
            "hack.x/",
            "hack.x/0",
            "hack.x/1a",
            "hack.X/1",
            "hack.a b/1",
            "other.x/1",
            "hack.x/1/2",
        ] {
            assert!(!valid_domain(name.as_bytes()), "{name}");
        }
        assert!(valid_domain(b"hack.container-spec/12"));
    }
}
