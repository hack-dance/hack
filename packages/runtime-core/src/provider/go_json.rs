//! JSON objects read the way the engine's Go `encoding/json` reads them.
//!
//! Image configurations come from registries and archives, and the engine and BuildKit
//! decode them into Go structs. Go matches an object key to a struct field by exact
//! name or, failing that, case-insensitively (`bytes.EqualFold`), and when several keys
//! match one field the last one wins. A plain lookup of the canonical key can therefore
//! see a different value than the engine acts on, for example `{"onbuild": [...]}` or
//! `{"architecture": "arm64", "Architecture": "amd64"}`.
//!
//! [`GoJson`] keeps every member, duplicates included, and [`GoJson::field`] returns the
//! one member a Go field would receive. More than one candidate member is ambiguous and
//! refuses, so a check here never passes a document the engine would read differently.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

/// A JSON document with every object member kept, in order.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum GoJson {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<GoJson>),
    Object(Vec<(String, GoJson)>),
}

/// More than one member of an object names the same Go struct field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Ambiguous;

/// Whether `key` names the Go field `name`, as `bytes.EqualFold` decides for the ASCII
/// field names Hack inspects. Besides ASCII case, Unicode simple case folding maps only
/// U+017F (long s) to `s` and U+212A (Kelvin sign) to `k` among ASCII letters.
pub(super) fn names_field(key: &str, name: &str) -> bool {
    let mut key = key.chars();
    for expected in name.chars() {
        let Some(actual) = key.next() else {
            return false;
        };
        let folded = match actual {
            '\u{17f}' => 's',
            '\u{212a}' => 'k',
            other if other.is_ascii() => other.to_ascii_lowercase(),
            _ => return false,
        };
        if folded != expected.to_ascii_lowercase() {
            return false;
        }
    }
    key.next().is_none()
}

impl GoJson {
    pub(super) fn parse(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    /// The member a Go struct field named `name` receives: `None` when no key names it
    /// (or this is not an object), [`Ambiguous`] when more than one does.
    pub(super) fn field(&self, name: &str) -> Result<Option<&GoJson>, Ambiguous> {
        let Self::Object(members) = self else {
            return Ok(None);
        };
        let mut found = None;
        for (key, value) in members {
            if names_field(key, name) {
                if found.is_some() {
                    return Err(Ambiguous);
                }
                found = Some(value);
            }
        }
        Ok(found)
    }

    /// The same document as a [`Value`]. Duplicate keys collapse (last wins), so use
    /// this only for a member [`GoJson::field`] already selected unambiguously.
    pub(super) fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(*value),
            Self::Number(value) => Value::Number(value.clone()),
            Self::String(value) => Value::String(value.clone()),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
            Self::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect::<Map<_, _>>(),
            ),
        }
    }
}

impl<'de> Deserialize<'de> for GoJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Document;
        impl<'de> Visitor<'de> for Document {
            type Value = GoJson;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E: de::Error>(self) -> Result<GoJson, E> {
                Ok(GoJson::Null)
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<GoJson, E> {
                Ok(GoJson::Bool(value))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<GoJson, E> {
                Ok(GoJson::Number(value.into()))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<GoJson, E> {
                Ok(GoJson::Number(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<GoJson, E> {
                serde_json::Number::from_f64(value)
                    .map(GoJson::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<GoJson, E> {
                Ok(GoJson::String(value.to_owned()))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<GoJson, E> {
                Ok(GoJson::String(value))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<GoJson, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(GoJson::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<GoJson, A::Error> {
                let mut members = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, GoJson>()? {
                    members.push((key, value));
                }
                Ok(GoJson::Object(members))
            }
        }
        deserializer.deserialize_any(Document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_names_fold_like_go_and_duplicates_are_ambiguous() {
        for key in ["OnBuild", "onbuild", "ONBUILD", "oNbUiLd"] {
            assert!(names_field(key, "OnBuild"), "{key}");
        }
        for key in ["OnBuilds", "OnBuil", "On_Build", "ÖnBuild", ""] {
            assert!(!names_field(key, "OnBuild"), "{key}");
        }
        // Unicode simple folding reaches these two ASCII letters.
        assert!(names_field("o\u{17f}", "os"));
        assert!(names_field("\u{212a}ind", "kind"));
        let document = GoJson::parse(br#"{"a": 1, "os": "linux", "OS": "windows"}"#).unwrap();
        assert_eq!(document.field("os"), Err(Ambiguous));
        let exact = GoJson::parse(br#"{"os": "linux", "os": "linux"}"#).unwrap();
        assert_eq!(exact.field("os"), Err(Ambiguous));
        assert_eq!(
            document.field("a").unwrap().map(GoJson::to_value),
            Some(serde_json::json!(1))
        );
        assert_eq!(document.field("missing"), Ok(None));
        assert_eq!(GoJson::parse(b"[1]").unwrap().field("a"), Ok(None));
    }
}
