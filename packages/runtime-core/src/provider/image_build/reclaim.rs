//! `runtime reclaim-build-images`: remove superseded Hack-built images and trim cache.
//!
//! An image is removed only when every one of these holds; anything else is retained
//! and reported:
//!
//! - it carries exactly this pool's build ownership labels (kind, owner digest of the
//!   current incarnation, a namespace and a build key) and no other reserved labels;
//! - no build receipt of any namespace names it as its verified image;
//! - no retained graph state (`run/graphs`, `run/native-graphs`, `run/graph-archive`)
//!   mentions its content ID anywhere, whatever the graph's phase or branch;
//! - the engine agrees to remove it without force, which it refuses while any
//!   container, running or stopped, uses the image.
//!
//! The operation runs under the provider lease and refuses while a build is admitted,
//! so no build can adopt an image between the reference scan and the removal. If the
//! reference scan cannot read every retained graph record safely, nothing is removed.
//! BuildKit cache is then pruned to the build cache budget; that never removes images.
use super::{
    BuildPool, CACHE_BUDGET, LivePool, Phase, RESERVED_LABEL_PREFIXES, Receipt, builds_root, hex64,
    image_id, owner_label, refusal, require_no_active_build,
};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_SCAN_FILE: u64 = 16 * 1024 * 1024;
const MAX_BUILD_IMAGES: usize = 4096;

/// Why an owned-looking image was kept.
#[derive(Debug, Serialize, Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum Retained {
    /// Its labels are not exactly this pool's build ownership labels.
    NotOwned,
    /// A build receipt names it as a key's current image.
    Current,
    /// Retained graph state references it.
    Referenced,
    /// The engine refused removal (in use by a container) or the outcome is unknown.
    EngineRefused,
}

#[derive(Debug, Serialize)]
pub struct ReclaimReport {
    pub removed: Vec<String>,
    pub retained: BTreeMap<String, Retained>,
    /// Build cache bytes reclaimed; `None` when the prune failed (images unaffected).
    pub cache_reclaimed_bytes: Option<u64>,
}

/// Engine effects reclamation needs beyond a build pool.
pub(super) trait ReclaimPool: BuildPool {
    /// Images labeled `io.hack-local.kind=build-image`, as the engine lists them.
    fn build_images(&self, lease: &Self::Lease) -> Result<Vec<Value>, CandidateError>;
    /// Remove one image by content ID without force. `Ok(false)` when the engine refuses.
    fn remove(&self, lease: &Self::Lease, image: &str) -> Result<bool, CandidateError>;
}

fn unprovable() -> CandidateError {
    refusal(
        "native_build_reclaim_unprovable",
        "Retained graph state could not be read completely; no build image was removed.",
    )
}

/// Every `sha256:<64 hex>` token in the bytes.
fn image_tokens(bytes: &[u8], into: &mut BTreeSet<String>) {
    const PREFIX: &[u8] = b"sha256:";
    let mut index = 0;
    while let Some(offset) = bytes[index..]
        .windows(PREFIX.len())
        .position(|window| window == PREFIX)
    {
        let start = index + offset + PREFIX.len();
        if let Some(hex) = bytes.get(start..start + 64)
            && let Ok(hex) = std::str::from_utf8(hex)
            && hex64(hex)
            && !bytes.get(start + 64).is_some_and(|b| b.is_ascii_hexdigit())
        {
            into.insert(format!("sha256:{hex}"));
        }
        index = start;
    }
}

/// Collect every image ID retained graph state mentions. Symlinks, special files,
/// unreadable entries or exceeded bounds refuse: reclamation needs a complete scan.
pub(super) fn referenced_images(candidate: &Candidate) -> Result<BTreeSet<String>, CandidateError> {
    let mut found = BTreeSet::new();
    let mut entries = 0;
    for name in ["run/graphs", "run/native-graphs", "run/graph-archive"] {
        let root = candidate.state_root.join(name);
        match fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(unprovable()),
            Ok(metadata) if !metadata.is_dir() => return Err(unprovable()),
            Ok(_) => {}
        }
        scan_directory(&root, 0, &mut entries, &mut found)?;
    }
    Ok(found)
}

fn scan_directory(
    directory: &Path,
    depth: usize,
    entries: &mut usize,
    found: &mut BTreeSet<String>,
) -> Result<(), CandidateError> {
    if depth > MAX_SCAN_DEPTH {
        return Err(unprovable());
    }
    for entry in fs::read_dir(directory).map_err(|_| unprovable())? {
        *entries += 1;
        if *entries > MAX_SCAN_ENTRIES {
            return Err(unprovable());
        }
        let path = entry.map_err(|_| unprovable())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| unprovable())?;
        if metadata.is_dir() {
            scan_directory(&path, depth + 1, entries, found)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_SCAN_FILE {
                return Err(unprovable());
            }
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&path)
                .map_err(|_| unprovable())?;
            let opened = file.metadata().map_err(|_| unprovable())?;
            if !opened.is_file() || (opened.dev(), opened.ino()) != (metadata.dev(), metadata.ino())
            {
                return Err(unprovable());
            }
            let mut bytes = Vec::new();
            file.take(MAX_SCAN_FILE + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| unprovable())?;
            if bytes.len() as u64 > MAX_SCAN_FILE {
                return Err(unprovable());
            }
            image_tokens(&bytes, found);
        } else if !metadata.file_type().is_socket() {
            // Sockets carry no records; anything else is unexpected in graph state.
            return Err(unprovable());
        }
    }
    Ok(())
}

/// Image IDs that build receipts of every namespace record as verified.
fn current_images(candidate: &Candidate) -> Result<BTreeSet<String>, CandidateError> {
    let root = builds_root(candidate);
    let mut current = BTreeSet::new();
    let namespaces = match fs::read_dir(&root) {
        Ok(namespaces) => namespaces,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(current),
        Err(_) => return Err(unprovable()),
    };
    for namespace in namespaces {
        let namespace = namespace.map_err(|_| unprovable())?.path();
        let name = namespace.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let metadata = fs::symlink_metadata(&namespace).map_err(|_| unprovable())?;
        if name == "active.lock" && metadata.is_file() {
            continue;
        }
        if !hex64(name) || !metadata.is_dir() {
            return Err(unprovable());
        }
        for entry in fs::read_dir(&namespace).map_err(|_| unprovable())? {
            let path = entry.map_err(|_| unprovable())?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let receipt: Receipt =
                crate::provider::state::read_bounded(&path, super::MAX_RECEIPT_BYTES)
                    .map_err(|_| unprovable())?;
            if receipt.phase == Phase::ContentIdVerified
                && let Some(id) = receipt.image_id
            {
                current.insert(id);
            }
        }
    }
    Ok(current)
}

/// Whether listed labels are exactly this pool's build ownership labels.
fn owned_by(labels: &Value, owner: &str) -> bool {
    let Some(labels) = labels.as_object() else {
        return false;
    };
    let text = |key: &str| labels.get(key).and_then(Value::as_str);
    let reserved_extra = labels.keys().any(|key| {
        RESERVED_LABEL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
            && ![
                "io.hack-local.build-key",
                "io.hack-local.kind",
                "io.hack-local.namespace",
                "io.hack-local.owner",
            ]
            .contains(&key.as_str())
    });
    text("io.hack-local.kind") == Some(super::KIND)
        && text("io.hack-local.owner") == Some(owner)
        && text("io.hack-local.namespace").is_some_and(hex64)
        && text("io.hack-local.build-key").is_some_and(hex64)
        && !reserved_extra
}

/// The removal decision for each listed image, before any engine effect.
pub(super) fn plan(
    images: &[Value],
    owner: &str,
    current: &BTreeSet<String>,
    referenced: &BTreeSet<String>,
) -> Result<(Vec<String>, BTreeMap<String, Retained>), CandidateError> {
    if images.len() > MAX_BUILD_IMAGES {
        return Err(refusal(
            "native_build_reclaim_bounds",
            "Too many build images to reclaim in one operation; nothing was removed.",
        ));
    }
    let mut remove = Vec::new();
    let mut retained = BTreeMap::new();
    for image in images {
        let id = image["Id"]
            .as_str()
            .filter(|id| image_id(id))
            .ok_or_else(|| {
                refusal(
                    "engine_protocol",
                    "The engine listed a build image without a content ID.",
                )
            })?
            .to_owned();
        let reason = if !owned_by(&image["Labels"], owner) {
            Some(Retained::NotOwned)
        } else if current.contains(&id) {
            Some(Retained::Current)
        } else if referenced.contains(&id) {
            Some(Retained::Referenced)
        } else {
            None
        };
        match reason {
            Some(reason) => {
                retained.insert(id, reason);
            }
            None => remove.push(id),
        }
    }
    remove.sort();
    remove.dedup();
    Ok((remove, retained))
}

pub(super) fn run<P: ReclaimPool>(
    candidate: &Candidate,
    pool: &P,
) -> Result<ReclaimReport, CandidateError> {
    let (lease, identity) = pool.lease()?;
    require_no_active_build(candidate)?;
    // Under the lease no build can start, adopt or write a receipt.
    let current = current_images(candidate)?;
    let referenced = referenced_images(candidate)?;
    let images = pool.build_images(&lease)?;
    let (candidates, mut retained) = plan(
        &images,
        &owner_label(&identity.incarnation),
        &current,
        &referenced,
    )?;
    let mut removed = Vec::new();
    for id in candidates {
        match pool.remove(&lease, &id) {
            Ok(true) => removed.push(id),
            Ok(false) | Err(_) => {
                retained.insert(id, Retained::EngineRefused);
            }
        }
    }
    let cache_reclaimed_bytes = pool.prune_cache(&lease, CACHE_BUDGET).ok();
    Ok(ReclaimReport {
        removed,
        retained,
        cache_reclaimed_bytes,
    })
}

impl ReclaimPool for LivePool<'_> {
    fn build_images(&self, lease: &Self::Lease) -> Result<Vec<Value>, CandidateError> {
        // `{"label":["io.hack-local.kind=build-image"]}`, percent-encoded.
        let value = lease.request(
            reqwest::Method::GET,
            "/v1.53/images/json?all=true&filters=%7B%22label%22%3A%5B%22io.hack-local.kind%3Dbuild-image%22%5D%7D",
            None,
        )?;
        value
            .as_array()
            .cloned()
            .ok_or_else(|| refusal("engine_protocol", "The engine image list is not an array."))
    }
    fn remove(&self, lease: &Self::Lease, image: &str) -> Result<bool, CandidateError> {
        match lease.request(
            reqwest::Method::DELETE,
            &format!("/v1.53/images/{image}?force=false&noprune=false"),
            None,
        ) {
            Ok(_) => Ok(true),
            Err(error) if error.code == "engine_not_found" => Ok(true),
            Err(error) if error.code == "engine_rejected" => Ok(false),
            Err(error) => Err(error),
        }
    }
}

/// `runtime reclaim-build-images`: see the module documentation.
pub fn reclaim_build_images(candidate: &Candidate) -> Result<ReclaimReport, CandidateError> {
    run(candidate, &LivePool { candidate })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn image(id: &str, owner: &str) -> Value {
        serde_json::json!({"Id": id, "Labels": {
            "io.hack-local.kind": "build-image",
            "io.hack-local.owner": owner,
            "io.hack-local.namespace": "1".repeat(64),
            "io.hack-local.build-key": "2".repeat(64),
        }})
    }

    #[test]
    fn only_unreferenced_superseded_images_of_this_pool_are_removal_candidates() {
        let owner = owner_label("pool");
        let mut forged = image(D, &owner);
        forged["Labels"]["io.hack-local.graph"] = "x".into();
        let images = [
            image(A, &owner),
            image(B, &owner),
            image(C, &owner),
            forged,
            image(
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                &owner_label("other-pool"),
            ),
        ];
        let current = BTreeSet::from([B.to_owned()]);
        let referenced = BTreeSet::from([C.to_owned()]);
        let (remove, retained) = plan(&images, &owner, &current, &referenced).unwrap();
        assert_eq!(remove, vec![A.to_owned()]);
        assert_eq!(retained[B], Retained::Current);
        assert_eq!(retained[C], Retained::Referenced);
        assert_eq!(retained[D], Retained::NotOwned);
        assert_eq!(retained.len(), 4);
        assert!(
            plan(
                &[serde_json::json!({"Id": "bad"})],
                &owner,
                &current,
                &referenced
            )
            .is_err()
        );
    }

    #[test]
    fn image_tokens_find_exact_content_ids_only() {
        let mut found = BTreeSet::new();
        image_tokens(
            format!("{{\"image\":\"{A}\"}} x{B}f sha256:short {C}").as_bytes(),
            &mut found,
        );
        // B is followed by another hex digit, so it is not an exact ID.
        assert_eq!(found, BTreeSet::from([A.to_owned(), C.to_owned()]));
    }

    #[test]
    fn retained_graph_state_is_scanned_completely_or_not_at_all() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = crate::test_root::private_test_root(&tmp, "hack-build-reclaim");
        let checkout = root.join("checkout");
        crate::provider::state::private_directory(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        assert!(referenced_images(&candidate).unwrap().is_empty());
        let run = candidate.state_root.join("run/native-graphs/r1/nested");
        crate::provider::state::private_directory(&run).unwrap();
        fs::write(run.join("receipt.json"), format!("{{\"image\":\"{A}\"}}")).unwrap();
        let archive = candidate.state_root.join("run/graph-archive");
        crate::provider::state::private_directory(&archive).unwrap();
        fs::write(archive.join("old.json"), format!("[\"{B}\"]")).unwrap();
        assert_eq!(
            referenced_images(&candidate).unwrap(),
            BTreeSet::from([A.to_owned(), B.to_owned()])
        );
        std::os::unix::fs::symlink(run.join("receipt.json"), archive.join("alias")).unwrap();
        assert_eq!(
            referenced_images(&candidate).unwrap_err().code,
            "native_build_reclaim_unprovable"
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
