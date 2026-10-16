//! Explicit private-descriptor input; values never enter CLI output or durable receipts.
use hack_runtime_core::{
    CandidateError,
    provider::environment::{MAX_MANAGED_SERVICES, PendingEnvironment},
};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, Visitor},
};
use std::{
    collections::BTreeMap,
    fmt,
    os::fd::OwnedFd,
    time::{Duration, Instant},
};
use zeroize::Zeroize;

type Values = BTreeMap<String, BTreeMap<String, String>>;
fn refused() -> CandidateError {
    CandidateError::new(
        "graph_environment_input",
        "Private graph environment input is invalid, expired, or unavailable; values omitted.",
    )
}
fn erase(values: &mut BTreeMap<String, String>) {
    for value in values.values_mut() {
        value.zeroize();
    }
}

/// Owned secrets with a deadline anchored before descriptor consumption.
/// Deliberately neither Debug nor Serialize.
pub(super) struct Managed {
    values: Values,
    deadline: Instant,
}
impl Managed {
    pub(super) fn values(&self) -> &Values {
        &self.values
    }
    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }
    pub(super) fn remaining(&self) -> Result<Duration, CandidateError> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(refused)
    }
}
impl Drop for Managed {
    fn drop(&mut self) {
        for values in self.values.values_mut() {
            erase(values);
        }
    }
}
struct Secret(String);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;
        impl Visitor<'_> for Text {
            type Value = Secret;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_str<E: de::Error>(self, text: &str) -> Result<Secret, E> {
                Ok(Secret(text.to_owned()))
            }
            fn visit_string<E: de::Error>(self, text: String) -> Result<Secret, E> {
                Ok(Secret(text))
            }
        }
        deserializer.deserialize_string(Text)
    }
}
#[derive(Default)]
struct ServiceValues(BTreeMap<String, String>);
impl Drop for ServiceValues {
    fn drop(&mut self) {
        erase(&mut self.0);
    }
}
impl<'de> Deserialize<'de> for ServiceValues {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = ServiceValues;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded unique key map")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = ServiceValues::default();
                while let Some((key, mut value)) = map.next_entry::<String, Secret>()? {
                    if values.0.len() >= 64 || values.0.contains_key(&key) {
                        return Err(de::Error::custom("invalid environment map"));
                    }
                    values.0.insert(key, std::mem::take(&mut value.0));
                }
                Ok(values)
            }
        }
        deserializer.deserialize_map(Entries)
    }
}
#[derive(Default)]
struct Services(BTreeMap<String, ServiceValues>);
impl<'de> Deserialize<'de> for Services {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = Services;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded unique service map")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Services::default();
                while let Some((name, service)) = map.next_entry::<String, ServiceValues>()? {
                    if values.0.len() >= MAX_MANAGED_SERVICES || values.0.contains_key(&name) {
                        return Err(de::Error::custom("invalid service map"));
                    }
                    values.0.insert(name, service);
                }
                Ok(values)
            }
        }
        deserializer.deserialize_map(Entries)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    plan: String,
    run: String,
    lifetime_seconds: u64,
    services: Services,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn parse(
    bytes: &[u8],
    expected_plan: &str,
    run: &str,
    started: Instant,
) -> Result<Managed, CandidateError> {
    if bytes.len() > 65536 {
        return Err(refused());
    }
    let mut envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| refused())?;
    if envelope.version != 1
        || !hex(&envelope.plan, 64)
        || envelope.plan != expected_plan
        || !hex(&envelope.run, 32)
        || envelope.run != run
        || !(1..=300).contains(&envelope.lifetime_seconds)
        || envelope.services.0.is_empty()
    {
        return Err(refused());
    }
    let deadline = started
        .checked_add(Duration::from_secs(envelope.lifetime_seconds))
        .ok_or_else(refused)?;
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(refused)?;
    for (service, values) in &envelope.services.0 {
        // Reuse the delivery boundary's service/key/NUL/encoded-size contract.
        PendingEnvironment::until(service, &values.0, deadline).map_err(|_| refused())?;
    }
    let mut managed = Managed {
        values: BTreeMap::new(),
        deadline,
    };
    for (service, values) in &mut envelope.services.0 {
        managed
            .values
            .insert(service.clone(), std::mem::take(&mut values.0));
    }
    managed.remaining()?;
    Ok(managed)
}
pub(super) fn receive(
    fd: OwnedFd,
    expected_plan: &str,
    run: &str,
) -> Result<Managed, CandidateError> {
    if !cfg!(feature = "environment-launcher") {
        return Err(refused());
    }
    let started = Instant::now();
    let bytes =
        hack_runtime_core::provider::private_input::receive(fd, Duration::from_secs(5), 65536)
            .map_err(|_| refused())?;
    parse(&bytes, expected_plan, run, started)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document() -> serde_json::Value {
        json!({"version":1,"plan":"a".repeat(64),"run":"b".repeat(32),"lifetime_seconds":120,"services":{"web":{"TOKEN":"synthetic-private-canary"}}})
    }
    fn decode(bytes: &[u8], started: Instant) -> Result<Managed, CandidateError> {
        parse(bytes, &"a".repeat(64), &"b".repeat(32), started)
    }
    fn rejected(bytes: &[u8]) {
        let error = decode(bytes, Instant::now()).err().unwrap();
        assert_eq!(error.code, "graph_environment_input");
        assert!(!error.message.contains("synthetic-private-canary"));
    }
    #[test]
    fn private_values_keep_original_deadline_and_exact_service_scope() {
        let started = Instant::now() - Duration::from_secs(2);
        let value = decode(&serde_json::to_vec(&document()).unwrap(), started).unwrap();
        assert_eq!(value.values()["web"]["TOKEN"], "synthetic-private-canary");
        assert_eq!(value.deadline(), started + Duration::from_secs(120));
        assert!(value.remaining().unwrap() <= Duration::from_secs(118));
        assert!(
            decode(
                &serde_json::to_vec(&document()).unwrap(),
                Instant::now() - Duration::from_secs(121)
            )
            .is_err()
        );
    }
    #[test]
    fn unknown_duplicate_and_wrong_identity_fields_refuse_without_values() {
        let text = serde_json::to_string(&document()).unwrap();
        for changed in [
            text.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
            text.replacen("\"web\":", "\"web\":{},\"web\":", 1),
            text.replacen(
                "\"TOKEN\":",
                "\"TOKEN\":\"synthetic-private-canary\",\"TOKEN\":",
                1,
            ),
            text.replacen(
                "\"version\":1",
                "\"unknown\":\"synthetic-private-canary\",\"version\":1",
                1,
            ),
        ] {
            rejected(changed.as_bytes());
        }
        for (key, value) in [
            ("plan", json!("c".repeat(64))),
            ("run", json!("c".repeat(32))),
            ("plan", json!("A".repeat(64))),
            ("version", json!(2)),
            ("lifetime_seconds", json!(0)),
            ("lifetime_seconds", json!(301)),
            ("services", json!({})),
        ] {
            let mut changed = document();
            changed[key] = value;
            rejected(&serde_json::to_vec(&changed).unwrap());
        }
    }
    #[test]
    fn twelve_and_thirty_two_services_fit_without_expanding_payload_budgets() {
        for count in [12, 32] {
            let mut value = document();
            value["services"] = json!(
                (0..count)
                    .map(|n| (
                        format!("service{n}"),
                        json!({"TOKEN":"synthetic-private-canary"})
                    ))
                    .collect::<BTreeMap<_, _>>()
            );
            let encoded = serde_json::to_vec(&value).unwrap();
            assert_eq!(
                decode(&encoded, Instant::now()).unwrap().values().len(),
                count
            );
        }
        let mut value = document();
        value["services"] = json!(
            (0..32)
                .map(|n| (format!("service{n}"), json!({"TOKEN":"x".repeat(2500)})))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&value).unwrap());
    }
    #[test]
    fn malformed_and_excessive_service_values_refuse() {
        for values in [
            json!({}),
            json!({"TOKEN":"bad\u{0}value"}),
            json!({"TOKEN":"x".repeat(8193)}),
            json!({"TOKEN":"\n".repeat(4100)}),
            json!({"BAD-KEY":"value"}),
            json!({"TOKEN":42}),
        ] {
            let mut changed = document();
            changed["services"]["web"] = values;
            rejected(&serde_json::to_vec(&changed).unwrap());
        }
        let mut changed = document();
        changed["services"] = json!(
            (0..33)
                .map(|n| (format!("service{n}"), json!({"TOKEN":"value"})))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&changed).unwrap());
        changed = document();
        changed["services"]["web"] = json!(
            (0..65)
                .map(|n| (format!("KEY{n}"), "value"))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&changed).unwrap());
        rejected(&vec![b' '; 65537]);
        rejected(b"{malformed synthetic-private-canary");
    }
}
