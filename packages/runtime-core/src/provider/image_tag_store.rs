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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolved_at_unix_seconds: Option<u64>,
}

pub(super) struct TagResolution {
    pub record: TagRecord,
    pub pinned_reference: String,
    pub platform: ImagePlatform,
    pub proof_policy: PlatformPolicy,
    pub image_id: String,
    pub source_digest: String,
    pub resolved_at_unix_seconds: u64,
    pub source: TagSource,
    pending: Option<PendingPublication>,
    pub fallback_reason: Option<String>,
    pub previous_loaded: Option<Box<TagResolution>>,
}

struct PendingPublication {
    named: NamedReference,
    lock: state::Lock,
    root: std::path::PathBuf,
    path: std::path::PathBuf,
}

impl TagResolution {
    pub fn confirm<T>(
        &mut self,
        verify: impl FnOnce(&Self) -> Result<T, CandidateError>,
    ) -> Result<T, CandidateError> {
        let output = verify(self)?;
        self.publish()?;
        Ok(output)
    }

    fn publish(&mut self) -> Result<(), CandidateError> {
        if let Some(pending) = self.pending.take() {
            write_record(
                &self.record,
                &pending.named,
                &pending.lock,
                &pending.root,
                &pending.path,
            )?;
        }
        Ok(())
    }
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
                || selection.source_digest.is_some() != selection.resolved_at_unix_seconds.is_some()
                || selection.source_digest.as_ref().is_some_and(|digest| {
                    registry_image::pinned_syntax(&pin(named, digest)).is_err()
                })
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
        self.selections
            .iter()
            .find(|selection| selection.policy == policy)
    }

    fn selection_identity<'a>(&'a self, selected: &'a Selection) -> (&'a str, u64) {
        (
            selected
                .source_digest
                .as_deref()
                .unwrap_or(&self.source_digest),
            selected
                .resolved_at_unix_seconds
                .unwrap_or(self.resolved_at_unix_seconds),
        )
    }

    fn resolution(
        self,
        named: &NamedReference,
        policy: PlatformPolicy,
        source: TagSource,
    ) -> Result<TagResolution, CandidateError> {
        let selection = self.selection(policy).ok_or_else(offline_missing)?;
        let (source_digest, resolved_at_unix_seconds) = self.selection_identity(selection);
        Ok(TagResolution {
            pinned_reference: pin(named, source_digest),
            source_digest: source_digest.into(),
            resolved_at_unix_seconds,
            platform: selection.platform,
            proof_policy: selection.policy,
            image_id: selection.image_id.clone(),
            record: self,
            source,
            pending: None,
            fallback_reason: None,
            previous_loaded: None,
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

fn service_pins(candidate: &Candidate) -> std::path::PathBuf {
    candidate.state_root.join("artifacts/service-image-pins")
}

/// Immutable service inputs have no mutable tag record. Record the verified ID
/// under the shared fence before returning it to the caller. The pin store grows by
/// one empty directory per immutable service image. Eviction owns removal (HACK-2569).
pub(super) fn protect_service_image(candidate: &Candidate, id: &str) -> Result<(), CandidateError> {
    if !matches!(normalize(id), Ok(ImageReference::ImageId(_))) {
        return Err(invalid());
    }
    state::private_directory(&service_pins(candidate).join(id))
}

/// Current selections are retained even after their registry freshness expires.
pub(super) fn protected_image_ids(
    candidate: &Candidate,
) -> Result<std::collections::BTreeSet<String>, CandidateError> {
    let root = candidate.state_root.join("artifacts/image-tags");
    crate::reject_aliased_state(&root)?;
    let mut ids = std::collections::BTreeSet::new();
    let pins = service_pins(candidate);
    crate::reject_aliased_state(&pins)?;
    if pins.try_exists().map_err(state::io)? {
        for entry in std::fs::read_dir(&pins).map_err(state::io)? {
            let entry = entry.map_err(state::io)?;
            let id = entry.file_name().into_string().map_err(|_| invalid())?;
            if !matches!(normalize(&id), Ok(ImageReference::ImageId(_))) {
                return Err(invalid());
            }
            state::check_private_directory(&entry.path())?;
            ids.insert(id);
        }
    }
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(error) => return Err(state::io(error)),
    };
    for entry in entries {
        let directory = entry.map_err(state::io)?.path();
        crate::reject_aliased_state(&directory)?;
        let path = directory.join("resolution.json");
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(state::io(error)),
            Ok(_) => {}
        }
        let record: TagRecord = state::read_bounded(&path, 4096)?;
        let ImageReference::Named(named) = normalize(&record.reference).map_err(|_| invalid())?
        else {
            return Err(invalid());
        };
        record.validate(&named)?;
        if record_directory(candidate, &record.reference) != directory {
            return Err(invalid());
        }
        ids.extend(
            record
                .selections
                .into_iter()
                .map(|selection| selection.image_id),
        );
    }
    Ok(ids)
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
            let named = match normalize(&status.record.reference).map_err(|_| invalid())? {
                ImageReference::Named(named) => named,
                _ => return Err(invalid()),
            };
            let pin = pin(&named, status.record.selection_identity(selection).0);
            let Some(proof) =
                super::image_ensure::recorded_proof(candidate, &pin, selection.policy)?
            else {
                continue;
            };
            let (platform, config) = proof.verified_config(&pin, selection.policy)?;
            if platform != selection.platform || config != selection.image_id {
                return Err(invalid());
            }
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

pub(super) fn resolve(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    observer: Option<&super::engine::Observer>,
) -> Result<TagResolution, CandidateError> {
    resolve_pending(
        candidate,
        reference,
        policy,
        platform,
        epoch_seconds,
        |previous| {
            let Some((previous, observer)) = previous.zip(observer) else {
                return Ok(false);
            };
            let Some(proof) = super::image_ensure::recorded_proof(
                candidate,
                &previous.pinned_reference,
                previous.proof_policy,
            )?
            else {
                return Ok(false);
            };
            let (selected, config) = proof.verified_config(&previous.pinned_reference, platform)?;
            if selected != previous.platform || config != previous.image_id {
                return Err(invalid());
            }
            super::image_load::observe_image(observer, &config, selected)
        },
        |reference, pinned, short| {
            let policy = &ImagePolicy {
                short_tag_refresh: short,
                ..policy.clone()
            };
            if pinned {
                registry_image::resolve_pinned(reference, policy, platform)
            } else {
                registry_image::resolve_with(reference, policy, platform)
            }
        },
    )
}

#[cfg(test)]
fn resolve_with(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    now: impl Fn() -> Result<u64, CandidateError>,
    lookup: impl FnOnce(&str, bool) -> Result<ResolvedImage, CandidateError>,
) -> Result<TagResolution, CandidateError> {
    let mut result = resolve_pending(
        candidate,
        reference,
        policy,
        platform,
        now,
        |previous| Ok(previous.is_some()),
        |reference, pinned, _| lookup(reference, pinned),
    )?;
    result.publish()?;
    Ok(result)
}

pub(super) fn fallback_reason(error: &CandidateError) -> String {
    error
        .cause_code
        .as_deref()
        .unwrap_or("registry_refresh_failed")
        .into()
}

fn resolve_pending(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    now: impl Fn() -> Result<u64, CandidateError>,
    loaded: impl FnOnce(Option<&TagResolution>) -> Result<bool, CandidateError>,
    lookup: impl FnOnce(&str, bool, bool) -> Result<ResolvedImage, CandidateError>,
) -> Result<TagResolution, CandidateError> {
    let named = tag(reference, policy)?;
    let canonical = named.canonical();
    let root = record_directory(candidate, &canonical);
    let path = root.join("resolution.json");
    crate::reject_aliased_state(&root)?;
    let read_record = || measure(Step::ImageTagRecord, None, |_| read(&path, &named));
    let previous = read_record()?;
    let command_pin = policy.command_image_pin.as_deref();
    if policy.tag_mode == ImageTagMode::Offline {
        let resolution = previous.ok_or_else(offline_missing)?.resolution(
            &named,
            platform,
            TagSource::Offline,
        )?;
        if command_pin.is_some_and(|pin| resolution.pinned_reference != pin) {
            return Err(offline_missing());
        }
        return Ok(resolution);
    }
    let opened_at = now()?;
    let is_fresh = |at: u64, resolved_at| {
        policy.tag_mode == ImageTagMode::Normal
            && at
                .checked_sub(resolved_at)
                .is_some_and(|age| age < policy.tag_ttl_seconds)
    };
    let matching = |entry: &TagRecord, at| {
        entry.selection(platform).is_some_and(|selection| {
            let (digest, resolved_at) = entry.selection_identity(selection);
            match command_pin {
                Some(expected) => pin(&named, digest) == expected,
                None => is_fresh(at, resolved_at),
            }
        })
    };
    if let Some(entry) = previous.filter(|entry| matching(entry, opened_at)) {
        return entry.resolution(&named, platform, TagSource::Recorded);
    }

    // Atomic publication lets established readers avoid the writer's lock.
    // Recheck under the writer lock so an automatic refresh can reuse a
    // resolution another process just published.
    let lock = match state::Lock::acquire(&root) {
        Err(error) if error.code == "provider_busy" && policy.retention_root.is_none() => {
            let lock = policy
                .image_wait(std::time::Duration::from_secs(590))
                .and_then(|wait| {
                    state::wait_for_image_lock(wait, &canonical, || {
                        state::Lock::acquire_existing(&root)
                    })
                });
            lock.map_err(|error| {
                if error.code == "provider_busy" {
                    CandidateError::new(
                        "image_tag_download_busy",
                        "Another start is downloading this image.",
                    )
                } else {
                    error
                }
            })?
        }
        result => result?,
    };
    let previous = read_record()?;
    let checked_at = now()?;
    if let Some(entry) = previous
        .as_ref()
        .filter(|entry| matching(entry, checked_at))
    {
        return entry
            .clone()
            .resolution(&named, platform, TagSource::Recorded);
    }
    let fresh = previous.as_ref().and_then(|entry| match command_pin {
        Some(expected) => entry
            .selections
            .iter()
            .map(|selection| entry.selection_identity(selection))
            .filter(|(digest, _)| pin(&named, digest) == expected)
            .max_by_key(|(_, time)| *time),
        None if entry.selection(platform).is_none()
            && is_fresh(checked_at, entry.resolved_at_unix_seconds) =>
        {
            Some((entry.source_digest.as_str(), entry.resolved_at_unix_seconds))
        }
        None => None,
    });
    if command_pin.is_some() && fresh.is_none() {
        return Err(CandidateError::new(
            "image_tag_selection_changed",
            "The tag resolution changed during this command.",
        ));
    }
    let mut fallback = previous.as_ref().and_then(|entry| {
        entry
            .clone()
            .resolution(&named, platform, TagSource::Offline)
            .ok()
            .filter(|tag| command_pin.is_none_or(|pin| tag.pinned_reference == pin))
    });
    let use_fallback = policy.tag_mode == ImageTagMode::Normal && loaded(fallback.as_ref())?;
    let resolved = measure(Step::ImageTagResolve, None, |_| match fresh {
        Some((digest, _)) => lookup(&pin(&named, digest), true, use_fallback),
        None => lookup(&canonical, false, use_fallback),
    });
    let resolved = match resolved {
        Ok(value) => value,
        Err(error) if use_fallback => {
            let mut fallback = fallback.take().ok_or_else(offline_missing)?;
            fallback.fallback_reason = Some(fallback_reason(&error));
            return Ok(fallback);
        }
        Err(error)
            if policy.tag_mode == ImageTagMode::Normal
                && (error.cause_code.as_deref().is_some_and(|code| {
                    code.starts_with("registry_http_")
                        || matches!(
                            code,
                            "registry_unreachable"
                                | "registry_headers_stalled"
                                | "registry_body_stalled"
                        )
                })) =>
        {
            return Err(offline_missing().with_cause_code(fallback_reason(&error)));
        }
        Err(error) => return Err(error),
    };

    let resolved_at = match fresh {
        Some((_, time)) => time,
        None => now()?,
    };
    let mut selections = previous.map_or_else(Vec::new, |mut record| {
        for selection in &mut record.selections {
            selection
                .source_digest
                .get_or_insert_with(|| record.source_digest.clone());
            selection
                .resolved_at_unix_seconds
                .get_or_insert(record.resolved_at_unix_seconds);
        }
        record.selections
    });
    selections.retain(|selection| selection.policy != platform);
    let selection = Selection {
        source_digest: Some(resolved.source_digest.clone()),
        resolved_at_unix_seconds: Some(resolved_at),
        ..selected(&resolved, platform)?
    };
    let mut entry = TagRecord {
        version: 1,
        reference: canonical,
        registry: named.domain.clone(),
        resolved_at_unix_seconds: resolved_at,
        selections,
        source_digest: resolved.source_digest.clone(),
    };
    super::image_ensure::publish_proof(
        candidate,
        &resolved.pinned_reference,
        platform,
        &resolved.proof,
    )?;
    entry.selections.push(selection);
    let mut resolution = entry.resolution(&named, platform, TagSource::Registry)?;
    resolution.previous_loaded = fallback.filter(|_| use_fallback).map(Box::new);
    resolution.pending = Some(PendingPublication {
        named,
        lock,
        root,
        path,
    });
    Ok(resolution)
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
        source_digest: None,
        resolved_at_unix_seconds: None,
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
            proof: registry_image::test_manifest_resolution().proof,
            pinned_reference: format!("docker.io/fixture/image@{source_digest}"),
            source_digest,
            manifest_digest: digest('c'),
            image_id: digest('d'),
            platform: "linux/arm64",
        }
    }

    #[test]
    fn keeper_retention_collects_current_tag_selections_and_immutable_service_ids() {
        let f = Fixture::new();
        protect_service_image(&f.0, &digest('e')).unwrap();
        let policy = ImagePolicy::default();
        resolve_pending(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(1),
            |_| Ok(false),
            |_, _, _| Ok(result('a')),
        )
        .unwrap()
        .publish()
        .unwrap();
        assert_eq!(
            protected_image_ids(&f.0).unwrap(),
            [digest('d'), digest('e')].into_iter().collect()
        );
    }

    #[test]
    fn unconfirmed_refresh_does_not_replace_the_published_record() {
        let f = Fixture::new();
        let policy = ImagePolicy {
            tag_ttl_seconds: 0,
            ..ImagePolicy::default()
        };
        let pending = |at, answer| {
            resolve_pending(
                &f.0,
                TAG,
                &policy,
                PlatformPolicy::Native,
                || Ok(at),
                |_| Ok(false),
                |_, _, _| Ok(result(answer)),
            )
            .unwrap()
        };
        pending(1, 'a').publish().unwrap();
        let mut unconfirmed = pending(2, 'b');
        let failed = unconfirmed.confirm(|_| {
            assert_eq!(
                status(&f.0, &[TAG]).unwrap()[0].record.source_digest,
                digest('a')
            );
            Err::<(), _>(CandidateError::new("fixture", "Guest load failed."))
        });
        assert!(failed.is_err());
        drop(unconfirmed);
        assert_eq!(
            status(&f.0, &[TAG]).unwrap()[0].record.source_digest,
            digest('a')
        );
        pending(3, 'c').publish().unwrap();
        assert_eq!(
            status(&f.0, &[TAG]).unwrap()[0].record.source_digest,
            digest('c')
        );
    }

    #[test]
    fn a_second_platform_keeps_its_tag_selection_when_the_first_moves() {
        let f = Fixture::new();
        let policy = ImagePolicy::default();
        let first = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Native,
            || Ok(1),
            |_, _| Ok(result('a')),
        )
        .unwrap();
        let additional = ImagePolicy {
            command_image_pin: Some(first.pinned_reference),
            tag_mode: ImageTagMode::Refresh,
            ..policy.clone()
        };
        resolve_with(
            &f.0,
            TAG,
            &additional,
            PlatformPolicy::Amd64,
            || Ok(2),
            |pin, pinned| {
                assert!(pinned);
                assert!(pin.ends_with(&digest('a')));
                Ok(ResolvedImage {
                    platform: "linux/amd64",
                    ..result('a')
                })
            },
        )
        .unwrap();
        let refresh = ImagePolicy {
            tag_mode: ImageTagMode::Refresh,
            ..policy.clone()
        };
        resolve_with(
            &f.0,
            TAG,
            &refresh,
            PlatformPolicy::Native,
            || Ok(3),
            |_, pinned| {
                assert!(!pinned);
                Ok(result('b'))
            },
        )
        .unwrap();

        let preferred = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Amd64,
            || Ok(4),
            |_, _| panic!("fresh AMD64 policy must not contact the registry"),
        )
        .unwrap();
        assert_eq!(preferred.platform, ImagePlatform::LinuxAmd64);
        assert_eq!(preferred.source_digest, digest('a'));
        assert_eq!(preferred.resolved_at_unix_seconds, 1);
        let offline = ImagePolicy {
            tag_mode: ImageTagMode::Offline,
            ..policy
        };
        let native = resolve_with(
            &f.0,
            TAG,
            &offline,
            PlatformPolicy::Native,
            || Ok(4),
            |_, _| panic!("offline native policy must not contact the registry"),
        )
        .unwrap();
        assert_eq!(native.source_digest, digest('b'));
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
    fn refresh_failures_keep_the_loaded_selection_and_identify_the_reason() {
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
        for (make_error, reason) in [
            (
                (|| {
                    CandidateError::new("registry_image_not_found", "Fixture tag not found.")
                        .with_cause_code("registry_http_404".into())
                }) as fn() -> CandidateError,
                "registry_http_404",
            ),
            (
                || {
                    CandidateError::new(
                        "registry_image",
                        "Registry object digest or size mismatch.",
                    )
                    .with_cause_code("registry_digest_mismatch".into())
                },
                "registry_digest_mismatch",
            ),
        ] {
            let fallback = resolve_with(
                &f.0,
                TAG,
                &policy,
                PlatformPolicy::Native,
                || Ok(u64::MAX),
                |_, _| Err(make_error()),
            )
            .unwrap();
            assert_eq!(fallback.source, TagSource::Offline);
            assert_eq!(fallback.fallback_reason.as_deref(), Some(reason));
            let refresh = ImagePolicy {
                tag_mode: ImageTagMode::Refresh,
                ..policy.clone()
            };
            let refused = resolve_with(
                &f.0,
                TAG,
                &refresh,
                PlatformPolicy::Native,
                || Ok(u64::MAX),
                |_, _| Err(make_error()),
            )
            .err()
            .unwrap();
            assert_ne!(refused.code, "image_tag_offline_missing");
        }
        let wrong_platform = resolve_with(
            &f.0,
            TAG,
            &policy,
            PlatformPolicy::Amd64,
            || Ok(1),
            |_, pinned| {
                assert!(pinned);
                Err(offline())
            },
        )
        .err()
        .unwrap();
        assert_eq!(wrong_platform.code, "image_tag_offline_missing");

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
                    } else if serial == 3 {
                        ("404 Not Found", "")
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
                resolve_with(
                    &f.0,
                    reference,
                    policy,
                    PlatformPolicy::Native,
                    epoch_seconds,
                    |reference, pinned| {
                        if pinned {
                            registry_image::resolve_pinned(
                                reference,
                                policy,
                                PlatformPolicy::Native,
                            )
                        } else {
                            registry_image::resolve_with(reference, policy, PlatformPolicy::Native)
                        }
                    },
                )
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
        let named = tag(&reference, &policy).unwrap();
        let refresh_lock =
            state::Lock::acquire(&record_directory(&f.0, &named.canonical())).unwrap();
        for _ in 0..20 {
            let (cached, requests) = lookup(&reference, &policy);
            let cached = cached.unwrap();
            assert_eq!(cached.image_id, first.image_id);
            let proof = super::super::image_ensure::recorded_proof(
                &f.0,
                &cached.pinned_reference,
                cached.proof_policy,
            )
            .unwrap()
            .unwrap();
            let (_, verified_config) = proof
                .verified_config(&cached.pinned_reference, PlatformPolicy::Native)
                .unwrap();
            assert_eq!(verified_config, cached.image_id);
            let observed = super::super::image_load::tests::confirm_verified_tag_in_test_guest(
                &f.0,
                &cached.pinned_reference,
                &cached.image_id,
            )
            .unwrap();
            assert_eq!(observed, first.image_id);
            assert_eq!(requests, 0);
        }
        drop(refresh_lock);
        assert_eq!(request_count.load(Ordering::SeqCst), before);
        policy.tag_ttl_seconds = 0;
        let (fallback, requests) = lookup(&reference, &policy);
        assert_eq!(fallback.unwrap().source, TagSource::Offline);
        assert_eq!(requests, 1);
        let missing = format!("{address}/fixture/image:missing");
        let (refused, requests) = lookup(&missing, &policy);
        assert_eq!(refused.err().unwrap().code, "image_tag_offline_missing");
        assert_eq!(requests, 1);
        version.store(3, Ordering::SeqCst);
        let (removed, requests) = lookup(&reference, &policy);
        let removed = removed.unwrap();
        assert_eq!(removed.image_id, first.image_id);
        assert_eq!(
            removed.fallback_reason.as_deref(),
            Some("registry_http_404")
        );
        assert_eq!(requests, 1);
        policy.tag_mode = ImageTagMode::Refresh;
        let (removed, requests) = lookup(&reference, &policy);
        assert_eq!(removed.err().unwrap().code, "registry_image_not_found");
        assert_eq!(requests, 1);
        version.store(1, Ordering::SeqCst);
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
