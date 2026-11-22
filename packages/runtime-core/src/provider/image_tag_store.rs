//! Durable mutable tag selections. A record authorizes a registry pin, never a guest
//! image or an unverified archive. Normal admission still checks the current registry policy.
use super::image_platform::{ImagePlatform, PlatformPolicy};
use super::image_policy::{ImagePolicy, ImageTagMode};
use super::image_reference::{ImageReference, NamedReference, normalize};
use super::registry_image::{self, ResolvedImage};
use super::state;
use crate::timings::{Step, measure};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TagRecord {
    version: u32,
    pub reference: String,
    pub registry: String,
    pub source_digest: String,
    pub resolved_at_unix_seconds: u64,
    selections: Vec<Selection>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TagSource {
    Registry,
    Recorded,
    Offline,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    policy: PlatformPolicy,
    platform: ImagePlatform,
    image_id: String,
}

pub(super) struct TagResolution {
    pub record: TagRecord,
    pub pinned_reference: String,
    pub platform: ImagePlatform,
    pub image_id: String,
    pub source: TagSource,
}

fn invalid() -> CandidateError {
    CandidateError::new("image_tag_record", "Invalid stored image tag resolution.")
}

fn offline_missing() -> CandidateError {
    CandidateError::new(
        "image_tag_offline_missing",
        "Registry unavailable and this image tag has no usable recorded resolution.",
    )
}

pub(super) fn epoch_seconds() -> Result<u64, CandidateError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| CandidateError::new("image_tag_clock", "Image tag clock is unavailable."))
}

fn pin(named: &NamedReference, digest: &str) -> String {
    format!("{}/{}@{digest}", named.domain, named.path)
}

fn tag(reference: &str, policy: &ImagePolicy) -> Result<NamedReference, CandidateError> {
    registry_image::tagged(reference, policy)?;
    match normalize(reference).map_err(|_| invalid())? {
        ImageReference::Named(named) => Ok(named),
        ImageReference::ImageId(_) => Err(invalid()),
    }
}

impl TagRecord {
    fn validate(&self, named: &NamedReference) -> Result<(), CandidateError> {
        if self.version != 1
            || self.reference != named.canonical()
            || self.registry != named.domain
            || named
                .digest
                .as_ref()
                .is_some_and(|digest| digest != &self.source_digest)
            || registry_image::pinned_syntax(&pin(named, &self.source_digest)).is_err()
            || !(1..=3).contains(&self.selections.len())
        {
            return Err(invalid());
        }
        for (i, selection) in self.selections.iter().enumerate() {
            if !matches!(
                normalize(&selection.image_id),
                Ok(ImageReference::ImageId(_))
            ) || !selection.policy.candidates().contains(&selection.platform)
                || self.selections[..i]
                    .iter()
                    .any(|prior| prior.policy == selection.policy)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }

    fn selection(&self, policy: PlatformPolicy) -> Option<&Selection> {
        self.selections.iter().find(|selection| {
            selection.policy == policy
                || (selection.platform == ImagePlatform::LinuxArm64
                    && policy.candidates().contains(&selection.platform))
                || (selection.platform == ImagePlatform::LinuxAmd64
                    && policy == PlatformPolicy::Amd64)
        })
    }

    fn fresh(&self, now: u64, ttl_seconds: u64) -> bool {
        now.checked_sub(self.resolved_at_unix_seconds)
            .is_some_and(|age| age < ttl_seconds)
    }

    fn resolution(
        self,
        named: &NamedReference,
        policy: PlatformPolicy,
        source: TagSource,
    ) -> Result<TagResolution, CandidateError> {
        let selection = self.selection(policy).ok_or_else(offline_missing)?;
        Ok(TagResolution {
            pinned_reference: pin(named, &self.source_digest),
            platform: selection.platform,
            image_id: selection.image_id.clone(),
            record: self,
            source,
        })
    }
}

fn read(path: &Path, named: &NamedReference) -> Result<Option<TagRecord>, CandidateError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let record: TagRecord = state::read_bounded(path, 4096)?;
            record.validate(named)?;
            Ok(Some(record))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(state::io(error)),
    }
}

fn record_directory(candidate: &Candidate, reference: &str) -> std::path::PathBuf {
    let key = format!("{:x}", crate::Hex(Sha256::digest(reference.as_bytes())));
    candidate.state_root.join("artifacts/image-tags").join(key)
}

#[derive(Serialize)]
pub struct TagStatus {
    #[serde(flatten)]
    pub record: TagRecord,
    pub aliases: Vec<String>,
}

/// Read only the named project's resolutions and require no running guest.
pub fn status(
    candidate: &Candidate,
    references: &[&str],
) -> Result<Vec<TagStatus>, CandidateError> {
    use std::collections::{BTreeMap, btree_map::Entry};

    let mut statuses = BTreeMap::<String, Option<TagStatus>>::new();
    for reference in references {
        let named = match normalize(reference) {
            Ok(ImageReference::Named(named)) if named.digest.is_none() => named,
            _ => continue,
        };
        let canonical = named.canonical();
        match statuses.entry(canonical.clone()) {
            Entry::Occupied(mut entry) => {
                if let Some(status) = entry.get_mut() {
                    status.aliases.push((*reference).into());
                }
            }
            Entry::Vacant(entry) => {
                let path = record_directory(candidate, &canonical).join("resolution.json");
                crate::reject_aliased_state(path.parent().ok_or_else(invalid)?)?;
                entry.insert(read(&path, &named)?.map(|record| TagStatus {
                    record,
                    aliases: vec![(*reference).into()],
                }));
            }
        }
    }
    Ok(statuses.into_values().flatten().collect())
}

/// Observe already-loaded tag selections without contacting a registry or
/// migrating any receipt. Used only for the missing-resolution diagnostic.
pub fn present(candidate: &Candidate, references: &[&str]) -> Result<Vec<String>, CandidateError> {
    let observer = super::engine::Observer::connect(candidate)?;
    observer.info()?;
    let mut observed = std::collections::BTreeMap::new();
    let mut loaded = Vec::new();
    for status in status(candidate, references)? {
        for selection in &status.record.selections {
            let key = (selection.image_id.as_str(), selection.platform.name());
            let key = (key.0.to_owned(), key.1);
            let present = match observed.get(&key) {
                Some(present) => *present,
                None => {
                    let present = super::image_load::observe_image(
                        &observer,
                        &selection.image_id,
                        selection.platform,
                    )?;
                    observed.insert(key, present);
                    present
                }
            };
            if present {
                loaded.push(status.record.reference);
                break;
            }
        }
    }
    Ok(loaded)
}

pub(super) fn recorded_pin(
    candidate: &Candidate,
    reference: &str,
    platform: PlatformPolicy,
) -> Result<Option<(ImagePlatform, String)>, CandidateError> {
    let named = match normalize(reference).map_err(|_| invalid())? {
        ImageReference::Named(named) if named.digest.is_some() => named,
        _ => return Err(invalid()),
    };
    let root = record_directory(candidate, &named.canonical());
    crate::reject_aliased_state(&root)?;
    Ok(
        read(&root.join("resolution.json"), &named)?.and_then(|entry| {
            entry
                .selection(platform)
                .map(|selection| (selection.platform, selection.image_id.clone()))
        }),
    )
}

pub(super) fn remember_pin(
    candidate: &Candidate,
    reference: &str,
    platform: PlatformPolicy,
    selected: ImagePlatform,
    image_id: &str,
    at: u64,
) -> Result<(), CandidateError> {
    let named = match normalize(reference).map_err(|_| invalid())? {
        ImageReference::Named(named) if named.digest.is_some() => named,
        _ => return Err(invalid()),
    };
    let canonical = named.canonical();
    let root = record_directory(candidate, &canonical);
    let lock = state::Lock::acquire(&root)?;
    let path = root.join("resolution.json");
    let mut entry = read(&path, &named)?.unwrap_or_else(|| TagRecord {
        version: 1,
        reference: canonical,
        registry: named.domain.clone(),
        source_digest: named.digest.clone().unwrap_or_default(),
        resolved_at_unix_seconds: at,
        selections: Vec::new(),
    });
    if let Some(previous) = entry.selection(platform) {
        if previous.platform != selected || previous.image_id != image_id {
            return Err(invalid());
        }
        return Ok(());
    }
    entry.selections.push(Selection {
        policy: platform,
        platform: selected,
        image_id: image_id.into(),
    });
    write_record(&entry, &named, &lock, &root, &path)
}

pub(super) fn resolve(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<TagResolution, CandidateError> {
    resolve_with(
        candidate,
        reference,
        policy,
        platform,
        epoch_seconds,
        |reference, pinned| {
            if pinned {
                registry_image::resolve_pinned(reference, policy, platform)
            } else {
                registry_image::resolve_with(reference, policy, platform)
            }
        },
    )
}

fn resolve_with(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    now: impl Fn() -> Result<u64, CandidateError>,
    lookup: impl FnOnce(&str, bool) -> Result<ResolvedImage, CandidateError>,
) -> Result<TagResolution, CandidateError> {
    let named = tag(reference, policy)?;
    let canonical = named.canonical();
    let root = record_directory(candidate, &canonical);
    let lock = state::Lock::acquire(&root)?;
    let path = root.join("resolution.json");
    let previous = measure(Step::ImageTagRecord, None, |_| read(&path, &named))?;
    let offline = || {
        previous.clone().ok_or_else(offline_missing)?.resolution(
            &named,
            platform,
            TagSource::Offline,
        )
    };
    if policy.tag_mode == ImageTagMode::Offline {
        return offline();
    }

    let opened_at = now()?;
    let fresh = previous.as_ref().filter(|entry| {
        policy.tag_mode == ImageTagMode::Normal && entry.fresh(opened_at, policy.tag_ttl_seconds)
    });
    if let Some(entry) = fresh
        && entry.selection(platform).is_some()
    {
        return entry
            .clone()
            .resolution(&named, platform, TagSource::Recorded);
    }

    let resolved = match fresh {
        Some(entry) => lookup(&pin(&named, &entry.source_digest), true),
        None => lookup(&canonical, false),
    };
    let resolved = match resolved {
        Ok(value) => value,
        Err(error) if registry_image::permits_recorded_fallback(&error) => {
            return offline();
        }
        Err(error) => return Err(error),
    };

    let mut entry = TagRecord {
        version: 1,
        reference: canonical,
        registry: named.domain.clone(),
        resolved_at_unix_seconds: if let Some(record) = fresh {
            record.resolved_at_unix_seconds
        } else {
            now()?
        },
        selections: previous
            .filter(|record| record.source_digest == resolved.source_digest)
            .map(|record| record.selections)
            .unwrap_or_default(),
        source_digest: resolved.source_digest.clone(),
    };
    entry
        .selections
        .retain(|selection| selection.policy != platform);
    let selection = selected(&resolved, platform)?;
    remember_pin(
        candidate,
        &resolved.pinned_reference,
        platform,
        selection.platform,
        &selection.image_id,
        entry.resolved_at_unix_seconds,
    )?;
    entry.selections.push(selection);
    write_record(&entry, &named, &lock, &root, &path)?;
    entry.resolution(&named, platform, TagSource::Registry)
}

fn write_record(
    entry: &TagRecord,
    named: &NamedReference,
    lock: &state::Lock,
    root: &Path,
    path: &Path,
) -> Result<(), CandidateError> {
    entry.validate(named)?;
    lock.verify_path(root)?;
    discard_pending(path)?;
    state::write_before_rename(path, entry, &|| lock.verify_path(root))
}

fn discard_pending(path: &Path) -> Result<(), CandidateError> {
    use std::os::unix::fs::MetadataExt;

    let pending = path.with_extension("pending");
    let metadata = match std::fs::symlink_metadata(&pending) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(state::io(error)),
    };
    // A prior writer may crash before rename. Its temporary file is not a
    // resolution. Lock ownership and the file's private shape fence cleanup.
    // SAFETY: geteuid takes no arguments and has no caller preconditions.
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(invalid());
    }
    std::fs::remove_file(pending).map_err(state::io)
}

fn selected(resolved: &ResolvedImage, policy: PlatformPolicy) -> Result<Selection, CandidateError> {
    let platform = policy
        .candidates()
        .iter()
        .copied()
        .find(|platform| platform.name() == resolved.platform)
        .ok_or_else(invalid)?;
    Ok(Selection {
        policy,
        platform,
        image_id: resolved.image_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG: &str = "fixture/image:test";

    struct Fixture(Candidate);

    impl Fixture {
        fn new() -> Self {
            Self(
                Candidate::discover(&crate::unique_test_root(&std::env::temp_dir(), "image-tag"))
                    .unwrap(),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0.checkout).unwrap();
        }
    }

    fn digest(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn result(byte: char) -> ResolvedImage {
        let source_digest = digest(byte);
        ResolvedImage {
            pinned_reference: format!("docker.io/fixture/image@{source_digest}"),
            source_digest,
            manifest_digest: digest('c'),
            image_id: digest('d'),
            platform: "linux/arm64",
        }
    }

    #[test]
    fn aliases_use_one_fresh_record_and_refresh_replaces_expired_selection() {
        let f = Fixture::new();
        let mut policy = ImagePolicy {
            tag_ttl_seconds: 10,
            ..ImagePolicy::default()
        };
        let select = |reference: &str, policy: &ImagePolicy, at, answer| {
            resolve_with(
                &f.0,
                reference,
                policy,
                PlatformPolicy::Native,
                || Ok(at),
                |_, pinned| {
                    assert!(!pinned);
                    Ok(result(answer))
                },
            )
            .unwrap()
        };
        assert_eq!(select(TAG, &policy, 20, 'a').source, TagSource::Registry);
        let fresh = resolve_with(
            &f.0,
            "docker.io/fixture/image:test",
            &policy,
            PlatformPolicy::Native,
            || Ok(29),
            |_, _| panic!("fresh tag must not resolve again"),
        )
        .unwrap();
        assert_eq!(fresh.source, TagSource::Recorded);
        assert_eq!(fresh.record.resolved_at_unix_seconds, 20);
        assert_eq!(fresh.record.source_digest, digest('a'));
        assert_eq!(
            select(TAG, &policy, 30, 'b').record.source_digest,
            digest('b')
        );

        policy.tag_mode = ImageTagMode::Refresh;
        assert_eq!(
            select(TAG, &policy, 31, 'c').record.source_digest,
            digest('c')
        );
        let statuses = status(&f.0, &[TAG, "docker.io/fixture/image:test"]).unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].record.resolved_at_unix_seconds, 31);
    }

    #[test]
    fn registry_unavailability_reuses_expired_record_but_integrity_failure_does_not() {
        let f = Fixture::new();
        let mut policy = ImagePolicy::default();
        let offline = || {
            CandidateError::new("registry_image", "Offline fixture.")
                .with_cause_code("registry_unreachable".into())
        };
        let early = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(1),
            |_, _| Err(offline()),
        )
        .err()
        .unwrap();
        assert_eq!(early.code, "image_tag_offline_missing");

        resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(1),
            |_, _| Ok(result('a')),
        )
        .unwrap();
        let late = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(u64::MAX),
            |_, _| Err(offline()),
        )
        .unwrap();
        assert_eq!(late.source, TagSource::Offline);
        assert_eq!(late.record.resolved_at_unix_seconds, 1);
        let refused = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(u64::MAX),
            |_, _| {
                Err(CandidateError::new(
                    "registry_image",
                    "Registry object digest or size mismatch.",
                ))
            },
        )
        .err()
        .unwrap();
        assert_eq!(refused.message, "Registry object digest or size mismatch.");

        policy.tag_mode = ImageTagMode::Offline;
        let explicit = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || panic!("explicit offline needs no clock"),
            |_, _| panic!("explicit offline must never touch the registry"),
        )
        .unwrap();
        assert_eq!(explicit.source, TagSource::Offline);
        assert_eq!(explicit.record.source_digest, digest('a'));
    }
    #[test]
    fn live_registry_moves_and_refuses_while_fresh_tags_send_zero_requests() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stopping = Arc::new(AtomicBool::new(false));
        let request_count = Arc::new(AtomicUsize::new(0));
        let version = Arc::new(AtomicUsize::new(0));
        let worker = std::thread::spawn({
            let stopping = Arc::clone(&stopping);
            let request_count = Arc::clone(&request_count);
            let version = Arc::clone(&version);
            move || {
                for socket in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut socket = socket.unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut line = String::new();
                    let mut reader = BufReader::new(&socket);
                    reader.read_line(&mut line).unwrap();
                    let request = line.split_whitespace().nth(1).unwrap().to_owned();
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    request_count.fetch_add(1, Ordering::SeqCst);
                    let serial = version.load(Ordering::SeqCst);
                    let config =
                        format!(r#"{{"architecture":"arm64","os":"linux","fixture":{serial}}}"#);
                    let id = format!("sha256:{:x}", crate::Hex(Sha256::digest(config.as_bytes())));
                    let manifest = serde_json::json!({
                        "schemaVersion": 2,
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "config": {
                            "mediaType": "application/vnd.oci.image.config.v1+json",
                            "digest": id,
                            "size": config.len(),
                        },
                        "layers": [{
                            "mediaType": "application/vnd.oci.image.layer.v1.tar",
                            "digest": digest('e'),
                            "size": 1,
                        }],
                    })
                    .to_string();
                    let (status, bytes) = if serial == 2 {
                        ("429 Too Many Requests", "")
                    } else if request.contains("/manifests/") {
                        ("200 OK", manifest.as_str())
                    } else {
                        assert!(request.ends_with(&id));
                        ("200 OK", config.as_str())
                    };
                    write!(socket, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}", bytes.len()).unwrap();
                }
            }
        });

        let f = Fixture::new();
        let reference = format!("{address}/fixture/image:stable");
        let allowed = format!("http://{address}");
        let mut policy = ImagePolicy::from_flags(&["--allow-local-registry", &allowed]).unwrap();
        let lookup = |reference: &str, policy: &ImagePolicy| {
            registry_image::count_requests(|| {
                resolve(&f.0, reference, policy, PlatformPolicy::Native)
            })
        };
        let (first, first_requests) = lookup(&reference, &policy);
        let first = first.unwrap();
        assert_eq!(first_requests, 2);
        version.store(1, Ordering::SeqCst);
        let alias = format!("{address}/fixture/image:also-stable");
        let (second_ref, second_requests) = lookup(&alias, &policy);
        assert_eq!(second_requests, 2);
        version.store(2, Ordering::SeqCst);
        let before = request_count.load(Ordering::SeqCst);
        for _ in 0..20 {
            let (cached, requests) = lookup(&reference, &policy);
            let cached = cached.unwrap();
            assert_eq!(cached.image_id, first.image_id);
            let observed = super::super::image_load::tests::confirm_verified_tag_in_test_guest(
                &f.0,
                &cached.pinned_reference,
                &cached.image_id,
            )
            .unwrap();
            assert_eq!(observed, first.image_id);
            assert_eq!(requests, 0);
        }
        assert_eq!(request_count.load(Ordering::SeqCst), before);
        policy.tag_ttl_seconds = 0;
        let (fallback, requests) = lookup(&reference, &policy);
        assert_eq!(fallback.unwrap().source, TagSource::Offline);
        assert_eq!(requests, 1);
        let missing = format!("{address}/fixture/image:missing");
        let (refused, requests) = lookup(&missing, &policy);
        assert_eq!(refused.err().unwrap().code, "image_tag_offline_missing");
        assert_eq!(requests, 1);
        version.store(1, Ordering::SeqCst);
        policy.tag_mode = ImageTagMode::Refresh;
        let (moved, requests) = lookup(&reference, &policy);
        let moved = moved.unwrap();
        assert_ne!(moved.image_id, first.image_id);
        assert_eq!(moved.image_id, second_ref.unwrap().image_id);
        assert_eq!(requests, 2);

        stopping.store(true, Ordering::SeqCst);
        TcpStream::connect(address).unwrap();
        worker.join().unwrap();
    }
}
