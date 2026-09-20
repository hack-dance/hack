//! Explicit private-descriptor input; values never enter CLI output or durable receipts.
use super::private_deadline::Deadline;
use crate::{
    CandidateError,
    provider::environment::{MAX_ENVIRONMENT_KEYS, MAX_MANAGED_SERVICES, PendingEnvironment},
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, MapAccess, Visitor},
};
use std::{
    collections::BTreeMap,
    fmt,
    os::fd::OwnedFd,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const MAX_INPUT_BYTES: usize = 256 * 1024;

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
pub struct Managed {
    plan: String,
    run: String,
    values: Values,
    deadline: Instant,
}
impl Managed {
    pub fn values(&self) -> &Values {
        &self.values
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn remaining(&self) -> Result<Duration, CandidateError> {
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
                    if values.0.len() >= MAX_ENVIRONMENT_KEYS || values.0.contains_key(&key) {
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
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(refused());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| refused())?;
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
    finish(envelope.services, deadline, envelope.plan, envelope.run)
}
fn finish(
    mut services: Services,
    deadline: Instant,
    plan: String,
    run: String,
) -> Result<Managed, CandidateError> {
    for (service, values) in &services.0 {
        PendingEnvironment::until(service, &values.0, deadline).map_err(|_| refused())?;
    }
    let mut managed = Managed {
        plan,
        run,
        values: BTreeMap::new(),
        deadline,
    };
    for (service, values) in &mut services.0 {
        managed
            .values
            .insert(service.clone(), std::mem::take(&mut values.0));
    }
    managed.remaining()?;
    Ok(managed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Forwarded {
    version: u8,
    plan: String,
    run: String,
    deadline_nanos: u64,
    services: Services,
}

impl Managed {
    /// Encode only for an authenticated same-host, same-boot private transport.
    /// The absolute deadline subtracts transit time; it never starts a new lease.
    pub fn forward(&self, plan: &str, run: &str) -> Result<Zeroizing<Vec<u8>>, CandidateError> {
        if !cfg!(feature = "environment-launcher") || plan != self.plan || run != self.run {
            return Err(refused());
        }
        self.remaining()?;
        #[derive(Serialize)]
        struct Borrowed<'a> {
            version: u8,
            plan: &'a str,
            run: &'a str,
            deadline_nanos: u64,
            services: &'a Values,
        }
        let document = Borrowed {
            version: 1,
            plan,
            run,
            deadline_nanos: Deadline::from_instant(self.deadline)
                .map_err(|_| refused())?
                .nanos(),
            services: &self.values,
        };
        // Fixed storage prevents serializer growth from leaving prior secret copies.
        let mut bytes = Zeroizing::new(vec![0; MAX_INPUT_BYTES]);
        let used = {
            let mut cursor = std::io::Cursor::new(bytes.as_mut_slice());
            serde_json::to_writer(&mut cursor, &document).map_err(|_| refused())?;
            cursor.position() as usize
        };
        bytes.truncate(used);
        self.remaining()?;
        Ok(bytes)
    }
}
/// Decode after peer and operation authorization. The caller owns and erases raw
/// bytes; this function owns decoded values, including every rejection path.
pub fn receive_forwarded(
    bytes: &[u8],
    expected_plan: &str,
    run: &str,
) -> Result<Managed, CandidateError> {
    if !cfg!(feature = "environment-launcher") || bytes.len() > MAX_INPUT_BYTES {
        return Err(refused());
    }
    let envelope: Forwarded = serde_json::from_slice(bytes).map_err(|_| refused())?;
    if envelope.version != 1
        || !hex(&envelope.plan, 64)
        || envelope.plan != expected_plan
        || !hex(&envelope.run, 32)
        || envelope.run != run
        || envelope.services.0.is_empty()
    {
        return Err(refused());
    }
    let deadline = Deadline::from_nanos(envelope.deadline_nanos)
        .and_then(|deadline| deadline.to_instant())
        .map_err(|_| refused())?;
    finish(envelope.services, deadline, envelope.plan, envelope.run)
}

pub fn receive(fd: OwnedFd, expected_plan: &str, run: &str) -> Result<Managed, CandidateError> {
    if !cfg!(feature = "environment-launcher") {
        return Err(refused());
    }
    let started = Instant::now();
    let bytes = super::private_input::receive(fd, Duration::from_secs(5), MAX_INPUT_BYTES)
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
    fn multi_service_application_envelope_exceeds_old_limit_without_leaking_values() {
        let values: BTreeMap<String, String> = (0..128)
            .map(|n| (format!("APP_KEY_{n}"), "synthetic-value".repeat(4)))
            .collect();
        let services: BTreeMap<String, _> = (0..14)
            .map(|n| (format!("service{n}"), values.clone()))
            .collect();
        let mut input = document();
        input["services"] = json!(services);
        let bytes = serde_json::to_vec(&input).unwrap();
        assert!(bytes.len() > 65536 && bytes.len() < MAX_INPUT_BYTES);
        let managed = decode(&bytes, Instant::now()).unwrap();
        assert_eq!(managed.values(), &services);
        assert!(managed.remaining().unwrap() <= Duration::from_secs(120));
        input["services"]["service0"] = json!(
            (0..257)
                .map(|n| (format!("KEY_{n}"), "x".to_owned()))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&input).unwrap());
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn application_envelope_crosses_private_pipe_and_forwarding_boundaries() {
        use std::{io::Write, os::unix::net::UnixStream};
        let values: BTreeMap<String, String> = (0..128)
            .map(|n| (format!("KEY_{n}"), "x".repeat(80)))
            .collect();
        let mut input = document();
        input["services"] = json!(
            (0..10)
                .map(|n| (format!("service{n}"), values.clone()))
                .collect::<BTreeMap<_, _>>()
        );
        let bytes = serde_json::to_vec(&input).unwrap();
        assert!(bytes.len() > 65536);
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            writer
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            writer.write_all(&bytes).unwrap();
        });
        let managed = receive(reader.into(), &"a".repeat(64), &"b".repeat(32)).unwrap();
        worker.join().unwrap();
        let forwarded = managed.forward(&"a".repeat(64), &"b".repeat(32)).unwrap();
        assert!(forwarded.len() > 65536);
        let received = receive_forwarded(&forwarded, &"a".repeat(64), &"b".repeat(32)).unwrap();
        assert_eq!(received.values(), managed.values());
        assert!(received.deadline() <= managed.deadline());
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn forwarded_values_preserve_deadline_scope_and_reject_rebinding() {
        let managed = decode(
            &serde_json::to_vec(&document()).unwrap(),
            Instant::now() - Duration::from_secs(2),
        )
        .unwrap();
        let bytes = managed.forward(&"a".repeat(64), &"b".repeat(32)).unwrap();
        assert!(managed.forward(&"c".repeat(64), &"b".repeat(32)).is_err());
        assert!(managed.forward(&"a".repeat(64), &"c".repeat(32)).is_err());
        let received = receive_forwarded(&bytes, &"a".repeat(64), &"b".repeat(32)).unwrap();
        assert_eq!(received.values(), managed.values());
        assert!(received.deadline() <= managed.deadline());
        assert!(received.remaining().unwrap() <= Duration::from_secs(118));
        for (plan, run) in [
            ("c".repeat(64), "b".repeat(32)),
            ("a".repeat(64), "c".repeat(32)),
        ] {
            assert!(receive_forwarded(&bytes, &plan, &run).is_err());
        }
        let text = std::str::from_utf8(&bytes).unwrap();
        let duplicate = text.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
        assert!(receive_forwarded(duplicate.as_bytes(), &"a".repeat(64), &"b".repeat(32)).is_err());
        let mut expired: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        expired["deadline_nanos"] = json!(0);
        let failure = receive_forwarded(
            &serde_json::to_vec(&expired).unwrap(),
            &"a".repeat(64),
            &"b".repeat(32),
        )
        .err()
        .unwrap();
        assert_eq!(failure.code, "graph_environment_input");
        assert!(!failure.message.contains("synthetic-private-canary"));
    }
    #[test]
    #[cfg(feature = "environment-launcher")]
    fn forwarded_encoding_and_decoding_are_bounded() {
        let managed = Managed {
            plan: "a".repeat(64),
            run: "b".repeat(32),
            values: (0..32)
                .map(|n| {
                    (
                        format!("service{n}"),
                        BTreeMap::from([("TOKEN".into(), "x".repeat(9000))]),
                    )
                })
                .collect(),
            deadline: Instant::now() + Duration::from_secs(120),
        };
        assert!(managed.forward(&"a".repeat(64), &"b".repeat(32)).is_err());
        assert!(
            receive_forwarded(
                &vec![b' '; MAX_INPUT_BYTES + 1],
                &"a".repeat(64),
                &"b".repeat(32)
            )
            .is_err()
        );
    }
    #[test]
    #[cfg(not(feature = "environment-launcher"))]
    fn forwarded_delivery_stays_feature_gated() {
        let managed = decode(&serde_json::to_vec(&document()).unwrap(), Instant::now()).unwrap();
        assert!(managed.forward(&"a".repeat(64), &"b".repeat(32)).is_err());
        assert!(receive_forwarded(b"{}", &"a".repeat(64), &"b".repeat(32)).is_err());
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
                .map(|n| (format!("service{n}"), json!({"TOKEN":"x".repeat(9000)})))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&value).unwrap());
    }
    #[test]
    fn malformed_and_excessive_service_values_refuse() {
        for values in [
            json!({}),
            json!({"TOKEN":"bad\u{0}value"}),
            json!({"TOKEN":"x".repeat(32769)}),
            json!({"TOKEN":"\n".repeat(16384)}),
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
            (0..257)
                .map(|n| (format!("KEY{n}"), "value"))
                .collect::<BTreeMap<_, _>>()
        );
        rejected(&serde_json::to_vec(&changed).unwrap());
        rejected(&vec![b' '; MAX_INPUT_BYTES + 1]);
        rejected(b"{malformed synthetic-private-canary");
    }
}
