//! Offline, content-addressed preservation before freeing bounded journal retention slots.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
const LIMIT: u64 = 512 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    version: u32,
    owner: String,
    files: BTreeMap<String, Vec<u8>>,
}
fn failure() -> CandidateError {
    error(
        "bridge_recovery_export",
        "Recovery evidence is absent, changed, unsafe or incomplete; no unverified bytes were removed.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let before = file.metadata().map_err(state::io)?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.nlink() != 1
        || before.mode() & 0o077 != 0
        || before.len() > limit
    {
        return Err(failure());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    let after = fs::symlink_metadata(path).map_err(state::io)?;
    if bytes.len() as u64 != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.nlink() != 1
    {
        return Err(failure());
    }
    Ok(bytes)
}
fn collect(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, CandidateError> {
    state::check_private_directory(path)?;
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(path).map_err(state::io)?.take(3) {
        let entry = entry.map_err(state::io)?;
        let name = entry.file_name().into_string().map_err(|_| failure())?;
        let limit = match name.as_str() {
            "interrupted.pending" => 65536,
            "retention.json" => 4096,
            _ => return Err(failure()),
        };
        files.insert(name, read(&entry.path(), limit)?);
    }
    Ok(files)
}
fn validate(bundle: &Bundle, owner: &str) -> Result<(), CandidateError> {
    if bundle.version != 1 || bundle.owner != owner || bundle.files.len() != 2 {
        return Err(failure());
    }
    let bytes = bundle
        .files
        .get("interrupted.pending")
        .filter(|b| b.len() <= 65536)
        .ok_or_else(failure)?;
    let metadata = bundle
        .files
        .get("retention.json")
        .filter(|b| b.len() <= 4096)
        .ok_or_else(failure)?;
    let record: Value = serde_json::from_slice(metadata).map_err(|_| failure())?;
    if record["bytes"].as_u64() != Some(bytes.len() as u64)
        || record["sha256"].as_str() != Some(digest(bytes).as_str())
    {
        return Err(failure());
    }
    Ok(())
}
fn encode(owner: &str, files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, CandidateError> {
    let bundle = Bundle {
        version: 1,
        owner: owner.into(),
        files,
    };
    validate(&bundle, owner)?;
    let bytes = serde_json::to_vec(&bundle).map_err(|_| failure())?;
    if bytes.len() as u64 > LIMIT {
        return Err(failure());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8], owner: &str, expected: &str) -> Result<Bundle, CandidateError> {
    if digest(bytes) != expected {
        return Err(failure());
    }
    let bundle: Bundle = serde_json::from_slice(bytes).map_err(|_| failure())?;
    validate(&bundle, owner)?;
    Ok(bundle)
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    Ok(path.try_exists().map_err(state::io)? || path.is_symlink())
}
fn sync(path: &Path) -> Result<(), CandidateError> {
    fs::File::open(path)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
}
fn context(candidate: &Candidate) -> Result<(state::Lock, state::Owner), CandidateError> {
    state::Owner::load(candidate)?;
    let lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    Ok((lock, state::Owner::load(candidate)?))
}
fn describe(slot: u8, owner: &str, path: &Path) -> Result<Value, CandidateError> {
    let files = collect(path)?;
    if files.len() != 2 {
        return Ok(
            json!({"slot":slot,"partial":true,"sha256":null,"remaining_files":files.keys().collect::<Vec<_>>(),"recovery":"Retry export with the original expected digest; incomplete evidence is not new export authority."}),
        );
    }
    let bytes = encode(owner, files)?;
    Ok(json!({"slot":slot,"partial":false,"sha256":digest(&bytes),"export_bytes":bytes.len()}))
}
pub fn inspect_bridge_recovery(candidate: &Candidate) -> Result<Value, CandidateError> {
    let (_lock, owner) = context(candidate)?;
    let root = candidate.state_root.join("run/bridge-assignments");
    let mut records = Vec::new();
    if exists(&root)? {
        state::check_private_directory(&root)?;
        for slot in 1..=8 {
            let path = root.join(format!("reservation-recovery-{slot}"));
            if exists(&path)? {
                records.push(describe(slot, &owner.token, &path)?);
            }
        }
    }
    Ok(json!({"records":records,"scope":"pool-recovery-evidence","runtime_effects":false}))
}
pub fn export_bridge_recovery(
    candidate: &Candidate,
    slot: u8,
    expected: &str,
) -> Result<Value, CandidateError> {
    if !(1..=8).contains(&slot) || !hex(expected, 64) {
        return Err(failure());
    }
    let (_lock, owner) = context(candidate)?;
    let root = candidate.state_root.join("run/bridge-assignments");
    state::check_private_directory(&root)?;
    transfer(
        &root.join(format!("reservation-recovery-{slot}")),
        &candidate.state_root.join("exports/bridge-recovery"),
        &owner.token,
        expected,
    )
}
fn transfer(
    source: &Path,
    exports: &Path,
    owner: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    state::private_directory(exports)?;
    let target = exports.join(format!("{expected}.json"));
    let bytes = if exists(&target)? {
        read(&target, LIMIT)?
    } else {
        encode(owner, collect(source)?)?
    };
    let bundle = decode(&bytes, owner, expected)?;
    // Validate all remaining files before either publication or retirement. A partial prior
    // retirement is allowed only against the complete, verified export above.
    let remaining = if exists(source)? {
        collect(source)?
    } else {
        BTreeMap::new()
    };
    if remaining
        .iter()
        .any(|(name, bytes)| bundle.files.get(name) != Some(bytes))
    {
        return Err(failure());
    }
    let mut retained = None;
    if !exists(&target)? {
        if fs::read_dir(exports).map_err(state::io)?.take(128).count() >= 128 {
            return Err(error(
                "bridge_export_budget",
                "128 bridge export entries are retained; nothing was overwritten or removed.",
            ));
        }
        let pending = target.with_extension("pending");
        if exists(&pending)? && read(&pending, LIMIT)? != bytes {
            retained = journal::retain_file(
                exports,
                &format!("{expected}.pending"),
                "interrupted-export",
                LIMIT,
            )?;
        }
        if !exists(&pending)? {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&pending)
                .map_err(state::io)?;
            file.write_all(&bytes).map_err(state::io)?;
            file.sync_all().map_err(state::io)?;
        }
        if read(&pending, LIMIT)? != bytes {
            return Err(failure());
        }
        sync(&pending)?;
        fs::rename(&pending, &target).map_err(state::io)?;
        sync(exports)?;
    }
    if read(&target, LIMIT)? != bytes {
        return Err(failure());
    }
    // Also synchronize an existing export on retry: its prior directory sync may have failed.
    sync(&target)?;
    sync(exports)?;
    if exists(source)? {
        for (name, content) in remaining {
            let path = source.join(name);
            if read(&path, 65536)? != content {
                return Err(failure());
            }
            fs::remove_file(path).map_err(state::io)?;
        }
        fs::remove_dir(source).map_err(state::io)?;
        sync(source.parent().expect("record parent"))?;
    }
    Ok(
        json!({"export":target,"sha256":expected,"bytes":bytes.len(),"source_absent":true,"export_retained":true,"runtime_effects":false,"interrupted_export_retained":retained}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn fixture(root: &Path) -> (PathBuf, String) {
        let source = root.join("record");
        state::private_directory(&source).unwrap();
        let bytes = b"interrupted evidence";
        fs::write(source.join("interrupted.pending"), bytes).unwrap();
        fs::set_permissions(
            source.join("interrupted.pending"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        state::write(
            &source.join("retention.json"),
            &json!({"bytes":bytes.len(),"sha256":digest(bytes)}),
        )
        .unwrap();
        let hash = digest(&encode("owner", collect(&source).unwrap()).unwrap());
        (source, hash)
    }
    #[test]
    fn preservation_deduplication_and_partial_retirement_are_verified() {
        let f = super::super::tests::Fixture::new();
        let exports = f.0.join("exports");
        let (source, hash) = fixture(&f.0);
        transfer(&source, &exports, "owner", &hash).unwrap();
        assert!(!source.exists());
        transfer(&source, &exports, "owner", &hash).unwrap();
        let (source, second) = fixture(&f.0);
        assert_eq!(hash, second);
        fs::remove_file(source.join("retention.json")).unwrap();
        let partial = describe(1, "owner", &source).unwrap();
        assert_eq!(partial["partial"], true);
        assert!(partial["sha256"].is_null());
        assert_eq!(partial["remaining_files"], json!(["interrupted.pending"]));
        transfer(&source, &exports, "owner", &hash).unwrap();
        assert_eq!(fs::read_dir(&exports).unwrap().count(), 1);
        let (source, _) = fixture(&f.0);
        fs::write(source.join("interrupted.pending"), b"changed").unwrap();
        assert!(transfer(&source, &exports, "owner", &hash).is_err());
        assert!(source.join("interrupted.pending").exists());
    }
    #[test]
    fn unsafe_or_wrong_evidence_never_frees_a_slot() {
        let f = super::super::tests::Fixture::new();
        let (source, hash) = fixture(&f.0);
        let exports = f.0.join("exports");
        assert!(transfer(&source, &exports, "owner", &"0".repeat(64)).is_err());
        assert!(transfer(&source, &exports, "foreign", &hash).is_err());
        let file = source.join("interrupted.pending");
        let backup = f.0.join("original");
        fs::rename(&file, &backup).unwrap();
        symlink(&backup, &file).unwrap();
        assert!(transfer(&source, &exports, "owner", &hash).is_err());
        assert!(backup.exists());
    }
    #[test]
    fn capacity_blocks_new_exports_but_existing_verified_exports_can_retire_duplicates() {
        let f = super::super::tests::Fixture::new();
        let (source, hash) = fixture(&f.0);
        let exports = f.0.join("exports");
        transfer(&source, &exports, "owner", &hash).unwrap();
        for i in 0..127 {
            fs::write(exports.join(format!("occupied-{i}")), b"retained").unwrap();
        }
        let (source, _) = fixture(&f.0);
        let new_hash = digest(&encode("other-owner", collect(&source).unwrap()).unwrap());
        assert_eq!(
            transfer(&source, &exports, "other-owner", &new_hash)
                .unwrap_err()
                .code,
            "bridge_export_budget"
        );
        assert!(source.join("interrupted.pending").exists());
        transfer(&source, &exports, "owner", &hash).unwrap();
        assert_eq!(fs::read_dir(&exports).unwrap().count(), 128);
    }
    #[test]
    fn partial_export_is_preserved_and_complete_pending_export_resumes() {
        let f = super::super::tests::Fixture::new();
        let (source, hash) = fixture(&f.0);
        let exports = f.0.join("exports");
        state::private_directory(&exports).unwrap();
        let pending = exports.join(format!("{hash}.pending"));
        fs::write(&pending, b"partial").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let receipt = transfer(&source, &exports, "owner", &hash).unwrap();
        let retained = PathBuf::from(receipt["interrupted_export_retained"].as_str().unwrap());
        assert_eq!(
            fs::read(retained.join("interrupted.pending")).unwrap(),
            b"partial"
        );
        let (source, _) = fixture(&f.0);
        fs::rename(exports.join(format!("{hash}.json")), &pending).unwrap();
        transfer(&source, &exports, "owner", &hash).unwrap();
        assert!(!pending.exists());
    }
}
