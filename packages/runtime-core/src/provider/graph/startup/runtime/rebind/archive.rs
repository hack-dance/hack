//! Archival is permitted only after exactly owned cleanup has proved container
//! absence. Preserved bytes are evidence, never authority to replay a rebind.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    version: u8,
    run: String,
    owner: String,
    boot: String,
    original_generation: String,
    cleaned_generation: String,
    artifacts: BTreeMap<String, String>,
    complete: bool,
}

fn bytes(path: &Path) -> Result<Option<Vec<u8>>, CandidateError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path.is_symlink() => {
            return Ok(None);
        }
        Err(error) => return Err(state::io(error)),
    };
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 1024 * 1024
    {
        return Err(rejected());
    }
    let mut value = Vec::new();
    (&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut value)
        .map_err(state::io)?;
    let current = fs::symlink_metadata(path).map_err(state::io)?;
    if value.len() as u64 != metadata.len()
        || metadata.dev() != current.dev()
        || metadata.ino() != current.ino()
        || current.nlink() != 1
    {
        return Err(rejected());
    }
    file.sync_all().map_err(state::io)?;
    Ok(Some(value))
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn sync(root: &Path) -> Result<(), CandidateError> {
    File::open(root)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
}

/// Caller retains the provider/dead-owner lease and has verified exactly owned
/// container/helper absence. Neither a phase label nor this proof removes a VM
/// resource or authorizes future endpoint selection.
pub(in crate::provider::graph::startup::runtime) fn after_cleanup(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
) -> Result<(), CandidateError> {
    after_cleanup_fenced(root, original, cleaned, boot, &|| Ok(()))
}

/// A completed prior-boot journal must match the selected original ready
/// generation before first archival admission. A durable proof alone permits
/// exact rename recovery after the active journal has already moved.
#[cfg(any(target_os = "macos", test))]
pub(in crate::provider::graph::startup::runtime) fn retired_completed(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    verify()?;
    let generation = service_exec_generation(original)?;
    let proof = root.join(format!("dependency-rebind-history-{generation}/proof.json"));
    let journal_root = if bytes(&root.join(JOURNAL))?.is_some() {
        root.to_owned()
    } else {
        proof.parent().ok_or_else(rejected)?.to_owned()
    };
    let journal = existing(&journal_root, original)?.ok_or_else(rejected)?;
    if journal.phase != "completed"
        || journal.boot != boot
        || journal.completed_generation.as_deref() != Some(generation.as_str())
    {
        return Err(rejected());
    }
    if bytes(&proof)?.is_none() {
        require_complete(root, original)?;
    }
    after_cleanup_fenced(root, original, cleaned, boot, verify)
}

fn after_cleanup_fenced(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    verify()?;
    state::check_private_directory(root)?;
    if boot.is_empty()
        || original.run != cleaned.run
        || original.owner != cleaned.owner
        || original.namespace != cleaned.namespace
        || original.plan_id != cleaned.plan_id
        || !matches!(cleaned.phase.as_str(), "stopped-data-retained" | "removed")
        || original.resources.len() != cleaned.resources.len()
        || original.resources.iter().any(|(key, prior)| {
            cleaned.resources.get(key).is_none_or(|current| {
                prior.kind != current.kind
                    || prior.id != current.id
                    || prior.name != current.name
                    || (current.kind != Kind::Volume && current.phase != "absent")
                    || (cleaned.phase == "removed" && current.phase != "absent")
            })
        })
    {
        return Err(rejected());
    }
    if let Some(journal) = existing(root, original)? {
        if journal.boot != boot {
            return Err(rejected());
        }
    }
    let generation = service_exec_generation(original)?;
    let cleaned_generation = service_exec_generation(cleaned)?;
    let history = root.join(format!("dependency-rebind-history-{generation}"));
    let names = [JOURNAL, "dependency-rebind.pending"];
    let mut active = BTreeMap::new();
    for name in names {
        if let Some(value) = bytes(&root.join(name))? {
            active.insert(name.to_string(), digest(&value));
        }
    }
    if active.is_empty() && !history.try_exists().map_err(state::io)? {
        return Ok(());
    }
    state::private_directory(&history)?;
    // A partial proof write is preserved before the same exact owned cleanup
    // reconstructs it. It is never interpreted as a capability or state receipt.
    verify()?;
    crate::provider::graph::journal::retain_file(
        &history,
        "proof.pending",
        "proof-recovery",
        1024 * 1024,
    )?;
    let proof_path = history.join("proof.json");
    let mut proof = if bytes(&proof_path)?.is_some() {
        let proof: Proof = state::read(&proof_path)?;
        if proof.version != 1
            || proof.run != original.run
            || proof.owner != original.owner
            || proof.boot != boot
            || proof.original_generation != generation
            || proof.cleaned_generation != cleaned_generation
            || proof.artifacts.is_empty()
            || proof.artifacts.len() > 2
            || proof
                .artifacts
                .iter()
                .any(|(name, hash)| !names.contains(&name.as_str()) || !hex(hash, 64))
            || active
                .iter()
                .any(|(name, hash)| proof.artifacts.get(name) != Some(hash))
        {
            return Err(rejected());
        }
        proof
    } else {
        if active.is_empty() {
            return Err(rejected());
        }
        let proof = Proof {
            version: 1,
            run: original.run.clone(),
            owner: original.owner.clone(),
            boot: boot.into(),
            original_generation: generation,
            cleaned_generation,
            artifacts: active,
            complete: false,
        };
        verify()?;
        state::write(&proof_path, &proof)?;
        proof
    };
    // Validate the entire retained set before moving any file. This also allows
    // a crash after either rename to resume archival without replaying effects.
    for (name, expected) in &proof.artifacts {
        let source = bytes(&root.join(name))?;
        let destination = bytes(&history.join(name))?;
        match (source, destination) {
            (Some(value), None) if !proof.complete && digest(&value) == *expected => {}
            (None, Some(value)) if digest(&value) == *expected => {}
            _ => return Err(rejected()),
        }
    }
    for name in proof.artifacts.keys() {
        if let Some(value) = bytes(&root.join(name))? {
            if digest(&value) != proof.artifacts[name] {
                return Err(rejected());
            }
            verify()?;
            if bytes(&root.join(name))?.as_deref() != Some(value.as_slice()) {
                return Err(rejected());
            }
            fs::rename(root.join(name), history.join(name)).map_err(state::io)?;
            sync(&history)?;
            sync(root)?;
        }
    }
    if !proof.complete {
        proof.complete = true;
        verify()?;
        state::write(&proof_path, &proof)?;
    }
    verify()
}
