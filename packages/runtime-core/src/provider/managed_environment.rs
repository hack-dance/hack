//! Explicit private-descriptor input; values never enter CLI output or durable receipts.
use super::private_deadline::Deadline;
use crate::{
    CandidateError,
    provider::environment::{
        MAX_ENVIRONMENT_FILES, MAX_ENVIRONMENT_KEYS, MAX_MANAGED_SERVICES, ManagedFile,
        ManagedFiles, PendingEnvironment,
    },
};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::{SerializeMap, SerializeSeq, SerializeStruct},
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
#[derive(Clone, Copy)]
enum Scope<'a> {
    Application,
    OneOff(&'a str),
}
impl Scope<'_> {
    /// One-off delivery never carries file members until that path is qualified.
    fn accepts(self, services: &Services, files: Option<&FileServices>) -> bool {
        match self {
            Self::Application => !services.0.is_empty() || files.is_some(),
            Self::OneOff(service) => {
                files.is_none()
                    && super::environment::name(service)
                    && services.0.keys().all(|name| name == service)
            }
        }
    }
}
/// Version 1 carries values only. Version 2 additionally requires a nonempty `files`
/// map, so a v1-only receiver refuses file delivery instead of dropping it.
fn version_matches(version: u8, files: Option<&FileServices>) -> bool {
    match files {
        None => version == 1,
        Some(_) => version == 2,
    }
}
fn refused() -> CandidateError {
    CandidateError::new(
        "graph_environment_input",
        "Private graph environment input is invalid, expired, or unavailable; values omitted.",
    )
}
pub(super) fn remaining_until(deadline: Instant) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(refused)
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
    files: ManagedFiles,
    deadline: Instant,
}
impl Managed {
    pub fn values(&self) -> &Values {
        &self.values
    }
    /// Service-scoped private file members (envelope version 2); empty for version 1.
    pub fn files(&self) -> &ManagedFiles {
        &self.files
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn remaining(&self) -> Result<Duration, CandidateError> {
        remaining_until(self.deadline)
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
/// `{name, target, mode: "0400", content_b64}`; unknown or duplicate fields refuse.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFile {
    name: String,
    target: String,
    mode: String,
    content_b64: Secret,
}
fn decode_file<E: de::Error>(wire: WireFile) -> Result<ManagedFile, E> {
    use base64::Engine as _;
    let invalid = || E::custom("invalid file member");
    if wire.mode != "0400" {
        return Err(invalid());
    }
    let text = wire.content_b64.0.as_bytes();
    // Decode into fixed zeroized storage so no unerased partial copy is left behind.
    let mut bytes = Zeroizing::new(vec![0; text.len() / 4 * 3 + 3]);
    let used = base64::engine::general_purpose::STANDARD
        .decode_slice(text, bytes.as_mut_slice())
        .map_err(|_| invalid())?;
    bytes.truncate(used);
    ManagedFile::new(&wire.name, &wire.target, bytes).map_err(|_| invalid())
}
#[derive(Default)]
struct ServiceFiles(Vec<ManagedFile>);
impl<'de> Deserialize<'de> for ServiceFiles {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = ServiceFiles;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded nonempty file member list")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut files = ServiceFiles::default();
                while let Some(wire) = seq.next_element::<WireFile>()? {
                    if files.0.len() >= MAX_ENVIRONMENT_FILES {
                        return Err(de::Error::custom("invalid file members"));
                    }
                    files.0.push(decode_file(wire)?);
                }
                if files.0.is_empty() {
                    return Err(de::Error::custom("invalid file members"));
                }
                Ok(files)
            }
        }
        deserializer.deserialize_seq(Members)
    }
}
/// A present `files` map must be nonempty with unique, bounded service names.
struct FileServices(ManagedFiles);
impl<'de> Deserialize<'de> for FileServices {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = FileServices;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded nonempty unique service file map")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut files = ManagedFiles::new();
                while let Some((name, members)) = map.next_entry::<String, ServiceFiles>()? {
                    if files.len() >= MAX_MANAGED_SERVICES || files.contains_key(&name) {
                        return Err(de::Error::custom("invalid service file map"));
                    }
                    files.insert(name, members.0);
                }
                if files.is_empty() {
                    return Err(de::Error::custom("invalid service file map"));
                }
                Ok(FileServices(files))
            }
        }
        deserializer.deserialize_map(Entries)
    }
}
/// Serializes members with zeroized base64 text for authenticated forwarding only.
struct WireFiles<'a>(&'a ManagedFiles);
impl Serialize for WireFiles<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Members<'a>(&'a [ManagedFile]);
        struct Member<'a>(&'a ManagedFile);
        impl Serialize for Member<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use base64::Engine as _;
                let text = Zeroizing::new(
                    base64::engine::general_purpose::STANDARD.encode(self.0.content()),
                );
                let mut member = serializer.serialize_struct("WireFile", 4)?;
                member.serialize_field("name", self.0.name())?;
                member.serialize_field("target", self.0.target())?;
                member.serialize_field("mode", "0400")?;
                member.serialize_field("content_b64", text.as_str())?;
                member.end()
            }
        }
        impl Serialize for Members<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
                for file in self.0 {
                    seq.serialize_element(&Member(file))?;
                }
                seq.end()
            }
        }
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (service, files) in self.0 {
            map.serialize_entry(service, &Members(files))?;
        }
        map.end()
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
    #[serde(default)]
    files: Option<FileServices>,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn parse_scoped(
    bytes: &[u8],
    expected_plan: &str,
    run: &str,
    started: Instant,
    scope: Scope<'_>,
) -> Result<Managed, CandidateError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(refused());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| refused())?;
    if !version_matches(envelope.version, envelope.files.as_ref())
        || !hex(&envelope.plan, 64)
        || envelope.plan != expected_plan
        || !hex(&envelope.run, 32)
        || envelope.run != run
        || !(1..=300).contains(&envelope.lifetime_seconds)
        || !scope.accepts(&envelope.services, envelope.files.as_ref())
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
    finish(
        envelope.services,
        envelope.files,
        deadline,
        envelope.plan,
        envelope.run,
    )
}
fn finish(
    mut services: Services,
    files: Option<FileServices>,
    deadline: Instant,
    plan: String,
    run: String,
) -> Result<Managed, CandidateError> {
    let files = files.map(|files| files.0).unwrap_or_default();
    let empty = BTreeMap::new();
    let names: std::collections::BTreeSet<&String> =
        services.0.keys().chain(files.keys()).collect();
    if names.len() > MAX_MANAGED_SERVICES {
        return Err(refused());
    }
    for service in names {
        PendingEnvironment::until_with_files(
            service,
            services.0.get(service).map_or(&empty, |values| &values.0),
            files.get(service).map_or(&[], Vec::as_slice),
            deadline,
        )
        .map_err(|_| refused())?;
    }
    let mut managed = Managed {
        plan,
        run,
        values: BTreeMap::new(),
        files,
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
    #[serde(default)]
    files: Option<FileServices>,
}

impl Managed {
    pub(crate) fn validate_binding(&self, plan: &str, run: &str) -> Result<(), CandidateError> {
        if !cfg!(feature = "environment-launcher") || plan != self.plan || run != self.run {
            return Err(refused());
        }
        self.remaining()?;
        Ok(())
    }
    /// Encode only for an authenticated same-host, same-boot private transport.
    /// The absolute deadline subtracts transit time; it never starts a new lease.
    pub fn forward(&self, plan: &str, run: &str) -> Result<Zeroizing<Vec<u8>>, CandidateError> {
        self.validate_binding(plan, run)?;
        #[derive(Serialize)]
        struct Borrowed<'a> {
            version: u8,
            plan: &'a str,
            run: &'a str,
            deadline_nanos: u64,
            services: &'a Values,
            #[serde(skip_serializing_if = "Option::is_none")]
            files: Option<WireFiles<'a>>,
        }
        let files = (!self.files.is_empty()).then_some(WireFiles(&self.files));
        let document = Borrowed {
            version: if files.is_some() { 2 } else { 1 },
            plan,
            run,
            deadline_nanos: Deadline::from_instant(self.deadline)
                .map_err(|_| refused())?
                .nanos(),
            services: &self.values,
            files,
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
    receive_forwarded_scoped(bytes, expected_plan, run, Scope::Application)
}
/// One-off transport may explicitly carry no managed values. Nonempty input must
/// name only the selected service; ordinary graph delivery remains nonempty.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn receive_forwarded_for_one_off(
    bytes: &[u8],
    expected_plan: &str,
    run: &str,
    service: &str,
) -> Result<Managed, CandidateError> {
    receive_forwarded_scoped(bytes, expected_plan, run, Scope::OneOff(service))
}
fn receive_forwarded_scoped(
    bytes: &[u8],
    expected_plan: &str,
    run: &str,
    scope: Scope<'_>,
) -> Result<Managed, CandidateError> {
    if !cfg!(feature = "environment-launcher") || bytes.len() > MAX_INPUT_BYTES {
        return Err(refused());
    }
    let envelope: Forwarded = serde_json::from_slice(bytes).map_err(|_| refused())?;
    if !version_matches(envelope.version, envelope.files.as_ref())
        || !hex(&envelope.plan, 64)
        || envelope.plan != expected_plan
        || !hex(&envelope.run, 32)
        || envelope.run != run
        || !scope.accepts(&envelope.services, envelope.files.as_ref())
    {
        return Err(refused());
    }
    let deadline = Deadline::from_nanos(envelope.deadline_nanos)
        .and_then(|deadline| deadline.to_instant())
        .map_err(|_| refused())?;
    finish(
        envelope.services,
        envelope.files,
        deadline,
        envelope.plan,
        envelope.run,
    )
}

pub fn receive(fd: OwnedFd, expected_plan: &str, run: &str) -> Result<Managed, CandidateError> {
    receive_scoped(fd, expected_plan, run, Scope::Application)
}

/// Native private input has distinct provenance and cannot be forwarded as a Compose v1 envelope.
#[cfg(feature = "native-config-plan")]
pub struct NativeManaged(Managed);
#[cfg(feature = "native-config-plan")]
impl NativeManaged {
    pub fn values(&self) -> &Values {
        self.0.values()
    }
    pub fn deadline(&self) -> Instant {
        self.0.deadline()
    }
}
#[cfg(feature = "native-config-plan")]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum NativeKind {
    NativeGraphEnvironment,
}
#[cfg(feature = "native-config-plan")]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeEnvelope {
    version: u8,
    kind: NativeKind,
    review: String,
    run: String,
    lifetime_seconds: u64,
    services: Services,
}
#[cfg(feature = "native-config-plan")]
fn parse_native(
    bytes: &[u8],
    review: &str,
    run: &str,
    started: Instant,
) -> Result<NativeManaged, CandidateError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(refused());
    }
    let input: NativeEnvelope = serde_json::from_slice(bytes).map_err(|_| refused())?;
    if input.version != 2
        || !matches!(input.kind, NativeKind::NativeGraphEnvironment)
        || !hex(&input.review, 64)
        || input.review != review
        || !hex(&input.run, 32)
        || input.run != run
        || !(1..=300).contains(&input.lifetime_seconds)
        || !Scope::Application.accepts(&input.services, None)
    {
        return Err(refused());
    }
    let deadline = started
        .checked_add(Duration::from_secs(input.lifetime_seconds))
        .ok_or_else(refused)?;
    finish(input.services, None, deadline, input.review, input.run).map(NativeManaged)
}
/// Receive bounded private native values against their exact native review/run and original ingress clock.
#[cfg(feature = "native-config-plan")]
pub fn receive_native(
    fd: OwnedFd,
    review: &str,
    run: &str,
) -> Result<NativeManaged, CandidateError> {
    if !cfg!(feature = "environment-launcher") {
        return Err(refused());
    }
    let started = Instant::now();
    let bytes = super::private_input::receive(fd, Duration::from_secs(5), MAX_INPUT_BYTES)
        .map_err(|_| refused())?;
    parse_native(&bytes, review, run, started)
}
/// Receive an explicit, bounded one-off envelope, including `services: {}`.
/// Missing input, missing fields and empty per-service maps remain invalid.
pub fn receive_for_one_off(
    fd: OwnedFd,
    expected_plan: &str,
    run: &str,
    service: &str,
) -> Result<Managed, CandidateError> {
    receive_scoped(fd, expected_plan, run, Scope::OneOff(service))
}
fn receive_scoped(
    fd: OwnedFd,
    expected_plan: &str,
    run: &str,
    scope: Scope<'_>,
) -> Result<Managed, CandidateError> {
    if !cfg!(feature = "environment-launcher") {
        return Err(refused());
    }
    let started = Instant::now();
    let bytes = super::private_input::receive(fd, Duration::from_secs(5), MAX_INPUT_BYTES)
        .map_err(|_| refused())?;
    parse_scoped(&bytes, expected_plan, run, started, scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document() -> serde_json::Value {
        json!({"version":1,"plan":"a".repeat(64),"run":"b".repeat(32),"lifetime_seconds":120,"services":{"web":{"TOKEN":"synthetic-private-canary"}}})
    }
    #[cfg(feature = "native-config-plan")]
    #[test]
    fn native_private_wire_cannot_be_decoded_or_forwarded_as_compose_v1() {
        let native = json!({"version":2,"kind":"native-graph-environment","review":"a".repeat(64),"run":"b".repeat(32),"lifetime_seconds":120,"services":{"web":{"TOKEN":"synthetic-private-canary"}}});
        let bytes = serde_json::to_vec(&native).unwrap();
        let started = Instant::now();
        let managed = parse_native(&bytes, &"a".repeat(64), &"b".repeat(32), started).unwrap();
        assert_eq!(managed.values()["web"]["TOKEN"], "synthetic-private-canary");
        assert!(managed.deadline() <= started + Duration::from_secs(120));
        assert!(decode(&bytes, started).is_err());
        assert!(
            parse_native(
                &serde_json::to_vec(&document()).unwrap(),
                &"a".repeat(64),
                &"b".repeat(32),
                started
            )
            .is_err()
        );
        for (key, value) in [
            ("version", json!(1)),
            ("kind", json!("compose")),
            ("review", json!("c".repeat(64))),
            ("run", json!("c".repeat(32))),
            ("plan", json!("a".repeat(64))),
            ("lifetime_seconds", json!(301)),
            ("services", json!({"web":{}})),
        ] {
            let mut bad = native.clone();
            bad[key] = value;
            let error = parse_native(
                &serde_json::to_vec(&bad).unwrap(),
                &"a".repeat(64),
                &"b".repeat(32),
                started,
            )
            .err()
            .unwrap();
            assert!(!error.message.contains("synthetic-private-canary"));
        }
        assert!(
            parse_native(
                &bytes,
                &"a".repeat(64),
                &"b".repeat(32),
                started - Duration::from_secs(121)
            )
            .is_err()
        );
    }
    fn decode(bytes: &[u8], started: Instant) -> Result<Managed, CandidateError> {
        parse_scoped(
            bytes,
            &"a".repeat(64),
            &"b".repeat(32),
            started,
            Scope::Application,
        )
    }
    fn rejected(bytes: &[u8]) {
        let error = decode(bytes, Instant::now()).err().unwrap();
        assert_eq!(error.code, "graph_environment_input");
        assert!(!error.message.contains("synthetic-private-canary"));
    }
    #[test]
    #[cfg(feature = "environment-launcher")]
    fn explicit_empty_one_off_crosses_private_input_and_forwarding() {
        use std::{io::Write, os::unix::net::UnixStream};
        let mut input = document();
        input["services"] = json!({});
        let bytes = serde_json::to_vec(&input).unwrap();
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&bytes).unwrap();
        drop(writer);
        let managed =
            receive_for_one_off(reader.into(), &"a".repeat(64), &"b".repeat(32), "web").unwrap();
        assert!(managed.values().is_empty());
        let forwarded = managed.forward(&"a".repeat(64), &"b".repeat(32)).unwrap();
        let received =
            receive_forwarded_for_one_off(&forwarded, &"a".repeat(64), &"b".repeat(32), "web")
                .unwrap();
        assert!(received.values().is_empty());
        assert!(received.deadline() <= managed.deadline());
        rejected(&bytes);
        assert!(receive_forwarded(&forwarded, &"a".repeat(64), &"b".repeat(32)).is_err());
    }
    fn decode_one_off(bytes: &[u8], service: &str) -> Result<Managed, CandidateError> {
        parse_scoped(
            bytes,
            &"a".repeat(64),
            &"b".repeat(32),
            Instant::now(),
            Scope::OneOff(service),
        )
    }

    #[test]
    fn one_off_scope_preserves_selected_values_and_refuses_missing_or_other_services() {
        let bytes = serde_json::to_vec(&document()).unwrap();
        let managed = decode_one_off(&bytes, "web").unwrap();
        assert_eq!(managed.values()["web"]["TOKEN"], "synthetic-private-canary");
        assert!(decode_one_off(&bytes, "other").is_err());
        let mut empty = document();
        empty["services"] = json!({});
        assert!(decode_one_off(&serde_json::to_vec(&empty).unwrap(), "").is_err());
        let mut missing = document();
        missing.as_object_mut().unwrap().remove("services");
        assert!(decode_one_off(&serde_json::to_vec(&missing).unwrap(), "web").is_err());
        for services in [
            json!({"web": {}}),
            json!({"unknown": {"TOKEN": "synthetic-private-canary"}}),
            json!({"web": {"TOKEN": "synthetic-private-canary"}, "other": {"TOKEN": "value"}}),
        ] {
            let mut invalid = document();
            invalid["services"] = services;
            let error = decode_one_off(&serde_json::to_vec(&invalid).unwrap(), "web")
                .err()
                .unwrap();
            assert_eq!(error.code, "graph_environment_input");
            assert!(!error.message.contains("synthetic-private-canary"));
        }
    }

    #[test]
    fn empty_one_off_keeps_identity_deadline_and_encoding_refusals() {
        let mut input = document();
        input["services"] = json!({});
        for (key, value) in [
            ("version", json!(2)),
            ("plan", json!("c".repeat(64))),
            ("run", json!("c".repeat(32))),
            ("lifetime_seconds", json!(0)),
            ("lifetime_seconds", json!(301)),
            ("unknown", json!("synthetic-private-canary")),
        ] {
            let mut invalid = input.clone();
            invalid[key] = value;
            assert!(decode_one_off(&serde_json::to_vec(&invalid).unwrap(), "web").is_err());
        }
        let bytes = serde_json::to_vec(&input).unwrap();
        assert!(
            parse_scoped(
                &bytes,
                &"a".repeat(64),
                &"b".repeat(32),
                Instant::now() - Duration::from_secs(121),
                Scope::OneOff("web")
            )
            .is_err()
        );
        let duplicate = serde_json::to_string(&input).unwrap().replacen(
            "\"services\":{}",
            "\"services\":{},\"services\":{}",
            1,
        );
        for invalid in [
            b"".to_vec(),
            b"{".to_vec(),
            vec![b' '; MAX_INPUT_BYTES + 1],
            duplicate.into_bytes(),
        ] {
            assert!(decode_one_off(&invalid, "web").is_err());
        }
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn one_off_forwarding_keeps_populated_scope_binding_and_deadline_checks() {
        let plan = "a".repeat(64);
        let run = "b".repeat(32);
        for services in [
            json!({}),
            json!({"web": {"TOKEN": "synthetic-private-canary"}}),
        ] {
            let mut input = document();
            input["services"] = services;
            let managed = decode_one_off(&serde_json::to_vec(&input).unwrap(), "web").unwrap();
            let bytes = managed.forward(&plan, &run).unwrap();
            let received = receive_forwarded_for_one_off(&bytes, &plan, &run, "web").unwrap();
            assert_eq!(received.values(), managed.values());
            assert!(received.deadline() <= managed.deadline());
            assert!(receive_forwarded_for_one_off(&bytes, &"c".repeat(64), &run, "web").is_err());
            assert!(receive_forwarded_for_one_off(&bytes, &plan, &"c".repeat(32), "web").is_err());
            let mut forwarded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            for (key, value) in [
                ("deadline_nanos", json!(0)),
                ("deadline_nanos", json!(u64::MAX)),
                ("services", json!({"other":{"TOKEN":"synthetic"}})),
            ] {
                let mut invalid = forwarded.clone();
                invalid[key] = value;
                assert!(
                    receive_forwarded_for_one_off(
                        &serde_json::to_vec(&invalid).unwrap(),
                        &plan,
                        &run,
                        "web"
                    )
                    .is_err()
                );
            }
            forwarded.as_object_mut().unwrap().remove("services");
            assert!(
                receive_forwarded_for_one_off(
                    &serde_json::to_vec(&forwarded).unwrap(),
                    &plan,
                    &run,
                    "web"
                )
                .is_err()
            );
        }
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn one_off_private_input_requires_nonempty_bytes_and_eof() {
        use std::{io::Write, os::unix::net::UnixStream};
        let (reader, writer) = UnixStream::pair().unwrap();
        drop(writer);
        assert!(
            receive_for_one_off(reader.into(), &"a".repeat(64), &"b".repeat(32), "web").is_err()
        );
        let mut input = document();
        input["services"] = json!({});
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        // Holding the writer open must time out, not admit a complete-looking prefix.
        assert!(
            receive_for_one_off(reader.into(), &"a".repeat(64), &"b".repeat(32), "web").is_err()
        );
        drop(writer);
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
            files: ManagedFiles::new(),
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
        use std::{io::Write, os::unix::net::UnixStream};
        let managed = decode(&serde_json::to_vec(&document()).unwrap(), Instant::now()).unwrap();
        assert!(managed.forward(&"a".repeat(64), &"b".repeat(32)).is_err());
        assert!(receive_forwarded(b"{}", &"a".repeat(64), &"b".repeat(32)).is_err());
        let mut input = document();
        input["services"] = json!({});
        let bytes = serde_json::to_vec(&input).unwrap();
        let managed = decode_one_off(&bytes, "web").unwrap();
        let forwarded = json!({
            "version": 1,
            "plan": "a".repeat(64),
            "run": "b".repeat(32),
            "deadline_nanos": Deadline::from_instant(managed.deadline()).unwrap().nanos(),
            "services": {},
        });
        assert!(
            receive_forwarded_for_one_off(
                &serde_json::to_vec(&forwarded).unwrap(),
                &"a".repeat(64),
                &"b".repeat(32),
                "web"
            )
            .is_err()
        );
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&bytes).unwrap();
        drop(writer);
        assert!(
            receive_for_one_off(reader.into(), &"a".repeat(64), &"b".repeat(32), "web").is_err()
        );
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
    fn file_document() -> serde_json::Value {
        // base64 of {"k":"synthetic-file-canary"}
        let mut value = document();
        value["version"] = json!(2);
        value["files"] = json!({
            "web": [{"name":"credential.json","target":"/config/credential.json","mode":"0400","content_b64":"eyJrIjoic3ludGhldGljLWZpbGUtY2FuYXJ5In0="}],
            "proxy": [{"name":"adc.json","target":"/config/adc.json","mode":"0400","content_b64":"eyJrIjoic3ludGhldGljLWZpbGUtY2FuYXJ5In0="}],
        });
        value
    }
    fn file_rejected(value: &serde_json::Value) {
        let error = decode(&serde_json::to_vec(value).unwrap(), Instant::now())
            .err()
            .unwrap();
        assert_eq!(error.code, "graph_environment_input");
        assert!(!error.message.contains("synthetic"));
    }
    #[test]
    fn version_two_delivers_file_members_including_files_only_services() {
        let managed = decode(
            &serde_json::to_vec(&file_document()).unwrap(),
            Instant::now(),
        )
        .unwrap();
        assert_eq!(managed.values()["web"]["TOKEN"], "synthetic-private-canary");
        assert!(!managed.values().contains_key("proxy"));
        let web = &managed.files()["web"][0];
        assert_eq!(web.name(), "credential.json");
        assert_eq!(web.target(), "/config/credential.json");
        assert_eq!(web.content(), br#"{"k":"synthetic-file-canary"}"#);
        assert_eq!(managed.files()["proxy"][0].target(), "/config/adc.json");
        let mut only = file_document();
        only["services"] = json!({});
        let managed = decode(&serde_json::to_vec(&only).unwrap(), Instant::now()).unwrap();
        assert!(managed.values().is_empty());
        assert_eq!(managed.files().len(), 2);
    }
    #[test]
    fn file_members_require_version_two_and_exact_member_shape() {
        let mut v1 = file_document();
        v1["version"] = json!(1);
        file_rejected(&v1);
        let mut v2 = document();
        v2["version"] = json!(2);
        file_rejected(&v2);
        let member = file_document()["files"]["web"][0].clone();
        for (key, value) in [
            ("mode", json!("0444")),
            ("mode", json!(256)),
            ("content_b64", json!("not base64!")),
            ("content_b64", json!("")),
            (
                "content_b64",
                json!("eyJrIjoic3ludGhldGljLWZpbGUtY2FuYXJ5In0"),
            ),
            ("name", json!("../escape")),
            ("target", json!("/run/hack-environment.json")),
            ("target", json!("relative")),
            ("unknown", json!("synthetic")),
        ] {
            let mut changed = file_document();
            let mut bad = member.clone();
            bad[key] = value;
            changed["files"]["web"] = json!([bad]);
            file_rejected(&changed);
        }
        let mut missing = file_document();
        missing["files"]["web"][0]
            .as_object_mut()
            .unwrap()
            .remove("mode");
        file_rejected(&missing);
        for files in [
            json!({}),
            json!({"web": []}),
            json!({"web": (0..5).map(|n| { let mut m = member.clone(); m["name"] = json!(format!("f{n}")); m["target"] = json!(format!("/config/f{n}")); m }).collect::<Vec<_>>()}),
            json!({"web": [member.clone(), member.clone()]}),
            json!({"unknown service!": [member.clone()]}),
            json!({"web": {"credential.json": member.clone()}}),
        ] {
            let mut changed = file_document();
            changed["files"] = files;
            file_rejected(&changed);
        }
        let text = serde_json::to_string(&file_document()).unwrap();
        let duplicate = text.replacen("\"files\":", "\"files\":{},\"files\":", 1);
        rejected(duplicate.as_bytes());
        let duplicate_field = text.replacen(
            "\"mode\":\"0400\"",
            "\"mode\":\"0400\",\"mode\":\"0400\"",
            1,
        );
        rejected(duplicate_field.as_bytes());
        let mut oversized = file_document();
        oversized["files"]["web"][0]["content_b64"] = json!(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            vec![b'x'; super::super::environment::MAX_ENVIRONMENT_FILE_BYTES + 1]
        ));
        file_rejected(&oversized);
    }
    #[test]
    fn one_off_scope_refuses_file_members() {
        let mut value = file_document();
        value["files"] = json!({"web": value["files"]["web"].clone()});
        assert!(
            decode_one_off(&serde_json::to_vec(&value).unwrap(), "web")
                .err()
                .is_some_and(|error| error.code == "graph_environment_input")
        );
    }
    #[test]
    #[cfg(feature = "environment-launcher")]
    fn forwarded_file_members_round_trip_as_version_two_only() {
        let plan = "a".repeat(64);
        let run = "b".repeat(32);
        let managed = decode(
            &serde_json::to_vec(&file_document()).unwrap(),
            Instant::now(),
        )
        .unwrap();
        let bytes = managed.forward(&plan, &run).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(wire["version"], 2);
        assert_eq!(wire["files"]["web"][0]["mode"], "0400");
        let received = receive_forwarded(&bytes, &plan, &run).unwrap();
        assert_eq!(received.values(), managed.values());
        for (service, files) in managed.files() {
            let other = &received.files()[service];
            assert_eq!(files.len(), other.len());
            for (left, right) in files.iter().zip(other) {
                assert_eq!(left.name(), right.name());
                assert_eq!(left.target(), right.target());
                assert_eq!(left.content(), right.content());
            }
        }
        let mut downgraded = wire.clone();
        downgraded["version"] = json!(1);
        assert!(receive_forwarded(&serde_json::to_vec(&downgraded).unwrap(), &plan, &run).is_err());
        assert!(receive_forwarded_for_one_off(&bytes, &plan, &run, "web").is_err());
        let plain = decode(&serde_json::to_vec(&document()).unwrap(), Instant::now()).unwrap();
        let wire: serde_json::Value =
            serde_json::from_slice(&plain.forward(&plan, &run).unwrap()).unwrap();
        assert_eq!(wire["version"], 1);
        assert!(wire.get("files").is_none());
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
