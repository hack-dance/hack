//! Bounded YAML decoding into JSON values. Parser errors never echo source snippets.
use crate::CandidateError;
use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, fmt, rc::Rc};

pub const MAX_BYTES: usize = 256 * 1024;
const MAX_NODES: usize = 20_000;
const MAX_DEPTH: usize = 48;

struct Seed {
    nodes: Rc<Cell<usize>>,
    scalar_bytes: Rc<Cell<usize>>,
    depth: usize,
}
impl Seed {
    fn child(&self) -> Self {
        Self {
            nodes: self.nodes.clone(),
            scalar_bytes: self.scalar_bytes.clone(),
            depth: self.depth + 1,
        }
    }
    fn charge<E: Error>(&self, bytes: usize) -> Result<(), E> {
        let total = self
            .scalar_bytes
            .get()
            .checked_add(bytes)
            .filter(|v| *v <= 2 * 1024 * 1024)
            .ok_or_else(|| E::custom("Expanded scalar budget exceeded"))?;
        self.scalar_bytes.set(total);
        Ok(())
    }
}
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        let nodes = self.nodes.get() + 1;
        if nodes > MAX_NODES || self.depth > MAX_DEPTH {
            return Err(D::Error::custom("YAML budget exceeded"));
        }
        self.nodes.set(nodes);
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a bounded Compose value")
    }
    fn visit_unit<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_u64<E: Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_f64<E: Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("Non-finite number"))
    }
    fn visit_str<E: Error>(self, value: &str) -> Result<Value, E> {
        self.charge::<E>(value.len())?;
        if value.len() > MAX_BYTES {
            return Err(E::custom("Scalar budget exceeded"));
        }
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E: Error>(self, value: String) -> Result<Value, E> {
        self.visit_str(&value)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(value) = values.next_element_seed(self.child())? {
            result.push(value);
        }
        Ok(Value::Array(result))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut values: A) -> Result<Value, A::Error> {
        let mut result = Map::new();
        while let Some(key) = values.next_key::<String>()? {
            self.charge::<A::Error>(key.len())?;
            if key.len() > 256 || result.contains_key(&key) {
                return Err(A::Error::custom("Invalid or duplicate mapping key"));
            }
            result.insert(key, values.next_value_seed(self.child())?);
        }
        Ok(Value::Object(result))
    }
}

pub fn parse(bytes: &[u8]) -> Result<Value, CandidateError> {
    let invalid = || {
        CandidateError::new(
            "invalid_compose_yaml",
            "Compose must be one bounded YAML document with unique keys, finite scalars and no custom tags.",
        )
    };
    if bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut documents = serde_yaml_ng::Deserializer::from_str(text);
    let document = documents.next().ok_or_else(invalid)?;
    let mut value = Seed {
        nodes: Rc::new(Cell::new(0)),
        scalar_bytes: Rc::new(Cell::new(0)),
        depth: 0,
    }
    .deserialize(document)
    .map_err(|_| invalid())?;
    if documents.next().is_some() {
        return Err(invalid());
    }
    merge_mappings(&mut value)?;
    Ok(value)
}

/// Aliases were expanded and budgeted during decoding. Move merge entries instead
/// of cloning them, so normalization cannot expand the retained node/byte budget.
fn merge_mappings(value: &mut Value) -> Result<(), CandidateError> {
    match value {
        Value::Array(values) => {
            for value in values {
                merge_mappings(value)?;
            }
        }
        Value::Object(map) => {
            for value in map.values_mut() {
                merge_mappings(value)?;
            }
            if let Some(merge) = map.remove("<<") {
                let sources = match merge {
                    Value::Object(m) => vec![Value::Object(m)],
                    Value::Array(v) => v,
                    _ => return Err(invalid_merge()),
                };
                let mut inherited = Map::new();
                for source in sources {
                    let Value::Object(source) = source else {
                        return Err(invalid_merge());
                    };
                    for (key, value) in source {
                        inherited.entry(key).or_insert(value);
                    }
                }
                inherited.extend(std::mem::take(map));
                *map = inherited;
            }
        }
        _ => {}
    }
    Ok(())
}
fn invalid_merge() -> CandidateError {
    CandidateError::new(
        "invalid_compose_merge",
        "YAML merges require a mapping or sequence of mappings; values are omitted.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_keys_multiple_documents_tags_and_alias_expansion_are_bounded() {
        for text in [
            "a: 1\na: 2",
            "a: 1\n---\nb: 2",
            "a: !secret value",
            "a: .nan",
        ] {
            let error = parse(text.as_bytes()).unwrap_err();
            assert_eq!(error.code, "invalid_compose_yaml");
            assert!(!error.message.contains("secret"));
        }
        let deep = format!("{}0{}", "[".repeat(100), "]".repeat(100));
        assert!(parse(deep.as_bytes()).is_err());
        let mut bomb = "a: &a [x,x,x,x,x,x,x,x,x,x]\n".to_owned();
        let mut prior = 'a';
        for next in ['b', 'c', 'd', 'e', 'f'] {
            bomb.push_str(&format!(
                "{next}: &{next} [{}]\n",
                vec![format!("*{prior}"); 10].join(",")
            ));
            prior = next;
        }
        assert!(parse(bomb.as_bytes()).is_err());
    }
    #[test]
    fn large_scalar_aliases_share_the_expanded_byte_budget() {
        let scalar = "x".repeat(128 * 1024);
        let small = format!("a: &a {scalar}\nb: [*a, *a]\n");
        assert!(parse(small.as_bytes()).is_ok());
        let expanded = format!("a: &a {scalar}\nb: [{}]\n", vec!["*a"; 20].join(","));
        assert!(expanded.len() < MAX_BYTES);
        assert_eq!(
            parse(expanded.as_bytes()).unwrap_err().code,
            "invalid_compose_yaml"
        );
    }
    #[test]
    fn merge_precedence_and_nested_defaults_are_preserved() {
        let value = parse(
            b"first: &a {VALUE: first, ONLY_A: a}
second: &b {VALUE: second, ONLY_B: b}
result:
  <<: [*a, *b]
  VALUE: explicit
inherited: {<<: [*a, *b]}
nested:
  <<: {<<: *a, EXTRA: x}
",
        )
        .unwrap();
        assert_eq!(value["result"]["VALUE"], "explicit");
        assert_eq!(value["result"]["ONLY_A"], "a");
        assert_eq!(value["result"]["ONLY_B"], "b");
        assert_eq!(value["inherited"]["VALUE"], "first");
        assert_eq!(value["nested"]["EXTRA"], "x");
        assert!(value["result"].get("<<").is_none());
        for bytes in [
            b"a: {<<: invalid}".as_slice(),
            b"a: {<<: [1, {}]}",
            b"a: &a {<<: *a}",
        ] {
            assert!(parse(bytes).is_err());
        }
    }
    #[test]
    fn ordinary_anchors_and_quoted_strings_are_preserved() {
        let value = parse(b"a: &a [one, 'false']\nb: *a\n").unwrap();
        assert_eq!(value["a"], value["b"]);
        assert_eq!(value["a"][1], "false");
    }
}
