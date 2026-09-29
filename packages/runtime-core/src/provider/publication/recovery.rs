//! Explicit pool-wide malformed-journal recovery, preserving bounded evidence first.
use super::*;
use base64::Engine as _;
use serde_json::{Value, json};
const LIMIT: u64 = 256 * 1024;
const COPIES: usize = 16;
#[derive(Serialize)]
struct Evidence<'a> {
    version: u32,
    owner: &'a str,
    committed_base64: Option<String>,
    pending_base64: String,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > limit
    {
        return Err(error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    let current = fs::symlink_metadata(path).map_err(state::io)?;
    if bytes.len() as u64 != m.len()
        || current.dev() != m.dev()
        || current.ino() != m.ino()
        || current.nlink() != 1
    {
        return Err(error());
    }
    Ok(bytes)
}
fn inputs(
    c: &Candidate,
    owner: &str,
) -> Result<(Vec<u8>, BTreeMap<String, Entry>), CandidateError> {
    state::check_private_directory(&root(c))?;
    let committed = root(c).join("state.json");
    let raw = if committed.exists() || committed.is_symlink() {
        Some(read(&committed, 65536)?)
    } else {
        None
    };
    let entries: BTreeMap<String, Entry> = raw
        .as_ref()
        .map(|bytes| serde_json::from_slice(bytes).map_err(|_| error()))
        .transpose()?
        .unwrap_or_default();
    validate(&entries, owner)?;
    let pending = read(&root(c).join("state.pending"), 65536)?;
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let evidence = serde_json::to_vec(&Evidence {
        version: 1,
        owner,
        committed_base64: raw.as_deref().map(encode),
        pending_base64: encode(&pending),
    })
    .map_err(|_| error())?;
    if evidence.len() as u64 > LIMIT {
        return Err(error());
    }
    Ok((evidence, entries))
}
fn preserve(directory: &Path, bytes: &[u8]) -> Result<PathBuf, CandidateError> {
    if bytes.len() as u64 > LIMIT {
        return Err(error());
    }
    state::private_directory(directory)?;
    let name = format!("{}.json", digest(bytes));
    let mut count = 0;
    let mut exists = false;
    for entry in fs::read_dir(directory).map_err(state::io)? {
        count += 1;
        if count > COPIES {
            return Err(error());
        }
        let entry = entry.map_err(state::io)?;
        let filename = entry.file_name().into_string().map_err(|_| error())?;
        if !filename.strip_suffix(".json").is_some_and(|s| hex(s, 64)) {
            return Err(error());
        }
        read(&entry.path(), LIMIT)?;
        exists |= filename == name;
    }
    if !exists && count >= COPIES {
        return Err(error());
    }
    let path = directory.join(name);
    let prefix = if exists {
        read(&path, LIMIT)?
    } else {
        Vec::new()
    };
    if !bytes.starts_with(&prefix) {
        return Err(error());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .create_new(!exists)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(state::io)?;
    file.write_all(&bytes[prefix.len()..]).map_err(state::io)?;
    file.sync_all().map_err(state::io)?;
    File::open(directory)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    if read(&path, LIMIT)? != bytes {
        return Err(error());
    }
    Ok(path)
}
fn no_staging(owner: &str) -> Result<(), CandidateError> {
    let prefix = format!("hkp-{}-{}-", unsafe { libc::geteuid() }, &owner[..12]);
    for entry in fs::read_dir("/private/tmp").map_err(state::io)? {
        if entry
            .map_err(state::io)?
            .file_name()
            .to_string_lossy()
            .starts_with(&prefix)
        {
            return Err(error());
        }
    }
    Ok(())
}
/// Offline inspection returns a fingerprint, never raw journal contents or control tokens.
pub fn inspect(c: &Candidate) -> Result<Value, CandidateError> {
    let _lock = state::Lock::acquire(&c.state_root.join("run/smolvm"))?;
    let owner = state::Owner::load(c)?;
    let pending = root(c).join("state.pending");
    if !pending.exists() && !pending.is_symlink() {
        return Ok(
            json!({"pending":false,"recorded_publications":load(c,&owner.token)?.len(),"scope":"all-host-publications-in-this-candidate"}),
        );
    }
    let (bytes, entries) = inputs(c, &owner.token)?;
    Ok(
        json!({"pending":true,"sha256":digest(&bytes),"evidence_bytes":bytes.len(),"recorded_publications":entries.len(),"scope":"all-host-publications-in-this-candidate","max_retained_copies":COPIES,"max_copy_bytes":LIMIT}),
    )
}
/// Explicitly stops all recorded host publications. No guest resources or app data are removed.
pub fn recover(c: &Candidate, expected: &str) -> Result<Value, CandidateError> {
    if !hex(expected, 64) {
        return Err(error());
    }
    let _lock = state::Lock::acquire(&c.state_root.join("run/smolvm"))?;
    let owner = state::Owner::load(c)?;
    let pending = root(c).join("state.pending");
    if !pending.exists() && !pending.is_symlink() {
        if !load(c, &owner.token)?.is_empty() {
            return Err(error());
        }
        no_staging(&owner.token)?;
        let store = root(c).join("recovery");
        state::check_private_directory(&store)?;
        let retained = store.join(format!("{expected}.json"));
        let evidence = read(&retained, LIMIT)?;
        let value: Value = serde_json::from_slice(&evidence).map_err(|_| error())?;
        if digest(&evidence) != expected || value["owner"] != owner.token || value["version"] != 1 {
            return Err(error());
        }
        return Ok(
            json!({"recovered":true,"already_recovered":true,"retained":retained,"sha256":expected,"startup_replayed":false,"guest_resources_removed":false}),
        );
    }
    let (bytes, entries) = inputs(c, &owner.token)?;
    if digest(&bytes) != expected {
        return Err(error());
    }
    let retained = preserve(&root(c).join("recovery"), &bytes)?;
    for entry in entries.values() {
        cleanup(entry)?;
    }
    // Unknown staging identity is never inferred from a name or a corrupt journal.
    no_staging(&owner.token)?;
    if inputs(c, &owner.token)?.0 != bytes || read(&retained, LIMIT)? != bytes {
        return Err(error());
    }
    fs::remove_file(root(c).join("state.pending")).map_err(state::io)?;
    File::open(root(c))
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    save(c, &BTreeMap::new())?;
    Ok(
        json!({"recovered":true,"retained":retained,"sha256":expected,"recorded_publications_retired":entries.len(),"startup_replayed":false,"guest_resources_removed":false}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn preservation_is_bounded_idempotent_and_resumes_only_exact_prefixes() {
        let dir = std::env::temp_dir().join(format!("hk-evidence-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let bytes = b"private bounded evidence";
        let target = dir.join(format!("{}.json", digest(bytes)));
        fs::write(&target, &bytes[..7]).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(preserve(&dir, bytes).unwrap(), target);
        assert_eq!(read(&target, LIMIT).unwrap(), bytes);
        assert_eq!(preserve(&dir, bytes).unwrap(), target);
        for index in 1..COPIES {
            preserve(&dir, format!("evidence-{index}").as_bytes()).unwrap();
        }
        assert!(preserve(&dir, b"one too many").is_err());
        assert_eq!(preserve(&dir, bytes).unwrap(), target);
        fs::write(&target, b"foreign").unwrap();
        assert!(preserve(&dir, bytes).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"foreign");
        fs::remove_dir_all(dir).unwrap();
    }
}
