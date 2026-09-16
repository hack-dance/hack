//! Foreground host publications. Intent precedes staging/exec; cleanup never adopts unknown files.
use super::{identity, publisher, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    owner: String,
    run: String,
    reservation: String,
    slot: u8,
    port: u16,
    token: String,
    process: identity::ProcessIdentity,
    digest: String,
    directory: Option<(u64, u64)>,
}
fn error() -> CandidateError {
    CandidateError::new(
        "publisher_intent",
        "Publication ownership or cleanup is uncertain; retain intent and files.",
    )
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn directory(e: &Entry) -> PathBuf {
    PathBuf::from(format!(
        "/private/tmp/hkp-{}-{}-{}",
        e.process.uid,
        &e.owner[..12],
        e.reservation
    ))
}
fn root(c: &Candidate) -> PathBuf {
    c.state_root.join("run/publications")
}
fn load(c: &Candidate, owner: &str) -> Result<BTreeMap<String, Entry>, CandidateError> {
    let root = root(c);
    if !root.exists() && !root.is_symlink() {
        return Ok(BTreeMap::new());
    }
    state::check_private_directory(&root)?;
    if root.join("state.pending").exists() || root.join("state.pending").is_symlink() {
        return Err(error());
    }
    let path = root.join("state.json");
    let entries: BTreeMap<String, Entry> = if path.exists() || path.is_symlink() {
        state::read_bounded(&path, 65536)?
    } else {
        BTreeMap::new()
    };
    if entries.len() > 32 {
        return Err(error());
    }
    let mut ports = std::collections::BTreeSet::new();
    let mut slots = std::collections::BTreeSet::new();
    for (key, e) in &entries {
        if !hex(owner, 32)
            || e.owner != owner
            || key != &e.reservation
            || !hex(&e.reservation, 32)
            || !hex(&e.run, 32)
            || !hex(&e.token, 32)
            || !hex(&e.digest, 64)
            || e.slot >= 32
            || e.port == 0
            || !ports.insert(e.port)
            || !slots.insert(e.slot)
            || e.process.pid <= 1
            || e.process.start_micros == 0
            || e.process.uid != unsafe { libc::geteuid() }
            || e.process.executable != directory(e).join("publisher")
        {
            return Err(error());
        }
    }
    Ok(entries)
}
fn save(c: &Candidate, entries: &BTreeMap<String, Entry>) -> Result<(), CandidateError> {
    state::private_directory(&root(c))?;
    state::write(&root(c).join("state.json"), entries)
}
fn verify_directory(e: &Entry) -> Result<bool, CandidateError> {
    let dir = directory(e);
    if !dir.exists() && !dir.is_symlink() {
        return Ok(false);
    }
    state::check_private_directory(&dir)?;
    let m = fs::symlink_metadata(&dir).map_err(state::io)?;
    if !m.is_dir() || Some((m.dev(), m.ino())) != e.directory {
        return Err(error());
    }
    Ok(true)
}
fn cleanup(e: &Entry) -> Result<(), CandidateError> {
    publisher::stop(publisher::StopOptions {
        process: &e.process,
        binary: &e.process.executable,
        control: &directory(e).join("control"),
        token: &e.token,
    })?;
    if !verify_directory(e)? {
        return Ok(());
    }
    let dir = directory(e);
    // A surviving socket after process absence has no retained inode proof. Preserve it.
    for entry in fs::read_dir(&dir).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        if entry.file_name() != "publisher" {
            return Err(error());
        }
        let path = entry.path();
        let m = fs::symlink_metadata(&path).map_err(state::io)?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != e.process.uid
            || m.mode() & 0o077 != 0
            || m.len() > 512 * 1024
        {
            return Err(error());
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(state::io)?;
        let opened = file.metadata().map_err(state::io)?;
        if opened.dev() != m.dev() || opened.ino() != m.ino() {
            return Err(error());
        }
        let mut bytes = Vec::new();
        file.take(512 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(state::io)?;
        if bytes.len() > 512 * 1024 || format!("{:x}", Sha256::digest(bytes)) != e.digest {
            return Err(error());
        }
    }
    let binary = dir.join("publisher");
    if binary.exists() {
        fs::remove_file(binary).map_err(state::io)?;
    }
    fs::remove_dir(&dir).map_err(state::io)?;
    File::open("/private/tmp")
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
}
/// Caller holds the provider operation lock. Stop host listeners before guest resources.
pub(super) fn release(
    c: &Candidate,
    owner: &str,
    selected: Option<(&str, &str)>,
) -> Result<(), CandidateError> {
    let mut entries = load(c, owner)?;
    if selected.is_some_and(|(run, res)| entries.get(res).is_some_and(|e| e.run != run)) {
        return Err(error());
    }
    let keys = entries
        .iter()
        .filter(|(_, e)| selected.is_none_or(|(run, res)| e.run == run && e.reservation == res))
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    for key in keys {
        cleanup(&entries[&key])?;
        entries.remove(&key);
        save(c, &entries)?;
    }
    Ok(())
}
pub fn unpublish(c: &Candidate, run: &str, reservation: &str) -> Result<(), CandidateError> {
    if !hex(run, 32) || !hex(reservation, 32) {
        return Err(error());
    }
    let _lock = state::Lock::acquire(&c.state_root.join("run/smolvm"))?;
    let owner = state::Owner::load(c)?;
    release(c, &owner.token, Some((run, reservation)))
}

pub(super) struct Launch<'a> {
    pub owner: &'a str,
    pub run: &'a str,
    pub reservation: &'a str,
    pub slot: u8,
    pub port: u16,
    pub upstream: &'a Path,
}
#[cfg(feature = "native-stream-relay")]
fn payload() -> Result<&'static [u8], CandidateError> {
    Ok(include_bytes!(concat!(
        env!("OUT_DIR"),
        "/stream-relay-host"
    )))
}
#[cfg(not(feature = "native-stream-relay"))]
fn payload() -> Result<&'static [u8], CandidateError> {
    Err(CandidateError::new(
        "bridge_unavailable",
        "Publication requires a native-stream-relay build.",
    ))
}
/// The caller must retain its operation lock until exec closes inherited descriptors.
pub(super) fn launch(c: &Candidate, options: Launch<'_>) -> Result<(), CandidateError> {
    let bytes = payload()?;
    if !hex(options.owner, 32)
        || !hex(options.run, 32)
        || !hex(options.reservation, 32)
        || options.slot >= 32
        || options.port == 0
        || bytes.len() > 512 * 1024
    {
        return Err(error());
    }
    let mut entries = load(c, options.owner)?;
    if entries.len() >= 32
        || entries.contains_key(options.reservation)
        || entries
            .values()
            .any(|e| e.port == options.port || e.slot == options.slot)
    {
        return Err(error());
    }
    let mut random = [0u8; 16];
    File::open("/dev/urandom")
        .map_err(state::io)?
        .read_exact(&mut random)
        .map_err(state::io)?;
    let token = random.iter().map(|b| format!("{b:02x}")).collect();
    let process = identity::observe(std::process::id() as i32)?;
    let mut e = Entry {
        owner: options.owner.into(),
        run: options.run.into(),
        reservation: options.reservation.into(),
        slot: options.slot,
        port: options.port,
        token,
        process,
        digest: format!("{:x}", Sha256::digest(bytes)),
        directory: None,
    };
    let dir = directory(&e);
    e.process.executable = dir.join("publisher");
    if dir.exists() || dir.is_symlink() {
        return Err(error());
    }
    entries.insert(e.reservation.clone(), e.clone());
    save(c, &entries)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(state::io)?;
    File::open("/private/tmp")
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    let m = fs::symlink_metadata(&dir).map_err(state::io)?;
    e.directory = Some((m.dev(), m.ino()));
    entries.insert(e.reservation.clone(), e.clone());
    save(c, &entries)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&e.process.executable)
        .map_err(state::io)?;
    file.write_all(bytes).map_err(state::io)?;
    file.sync_all().map_err(state::io)?;
    File::open(&dir)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    drop(file);
    let failure = std::process::Command::new(&e.process.executable)
        .env_clear()
        .args(["--publish", &e.port.to_string()])
        .arg(options.upstream)
        .args([&e.reservation, "60000", "--control"])
        .arg(dir.join("control"))
        .arg(&e.token)
        .exec();
    Err(state::io(failure))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> (Candidate, Entry) {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let base = PathBuf::from(format!(
            "/private/tmp/hkpub-test-{}-{serial}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        let candidate = Candidate::discover(&base).unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let process = identity::observe(child.id() as i32).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let mut e = Entry {
            owner: "a".repeat(32),
            run: "b".repeat(32),
            reservation: format!("{:016x}{serial:016x}", std::process::id()),
            slot: 0,
            port: 3000,
            token: "c".repeat(32),
            process,
            digest: format!("{:x}", Sha256::digest(b"fixture")),
            directory: None,
        };
        e.process.executable = directory(&e).join("publisher");
        (candidate, e)
    }
    #[test]
    fn absent_prelaunch_process_retires_intent_but_unknown_directory_does_not() {
        let (c, mut e) = fixture();
        let mut entries = BTreeMap::from([(e.reservation.clone(), e.clone())]);
        save(&c, &entries).unwrap();
        fs::create_dir(directory(&e)).unwrap();
        fs::set_permissions(directory(&e), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(release(&c, &e.owner, None).is_err());
        assert!(load(&c, &e.owner).unwrap().contains_key(&e.reservation));
        let m = fs::metadata(directory(&e)).unwrap();
        e.directory = Some((m.dev(), m.ino()));
        entries.insert(e.reservation.clone(), e.clone());
        save(&c, &entries).unwrap();
        fs::write(directory(&e).join("foreign"), b"preserve").unwrap();
        assert!(release(&c, &e.owner, None).is_err());
        assert_eq!(
            fs::read(directory(&e).join("foreign")).unwrap(),
            b"preserve"
        );
        fs::remove_file(directory(&e).join("foreign")).unwrap();
        fs::write(&e.process.executable, b"fixture").unwrap();
        fs::set_permissions(&e.process.executable, fs::Permissions::from_mode(0o700)).unwrap();
        release(&c, &e.owner, None).unwrap();
        assert!(!directory(&e).exists());
        assert!(load(&c, &e.owner).unwrap().is_empty());
        fs::remove_dir_all(c.checkout).unwrap();
    }
    #[test]
    fn store_rejects_foreign_owner_rebound_path_and_pending_journal() {
        let (c, e) = fixture();
        let mut entries = BTreeMap::from([(e.reservation.clone(), e.clone())]);
        save(&c, &entries).unwrap();
        assert!(load(&c, &"d".repeat(32)).is_err());
        for duplicate_port in [true, false] {
            let mut second = e.clone();
            second.reservation = "f".repeat(32);
            second.process.executable = directory(&second).join("publisher");
            if duplicate_port {
                second.slot = 1;
            } else {
                second.port += 1;
            }
            entries.insert(second.reservation.clone(), second.clone());
            save(&c, &entries).unwrap();
            assert!(load(&c, &e.owner).is_err());
            entries.remove(&second.reservation);
        }

        entries.get_mut(&e.reservation).unwrap().process.executable = PathBuf::from("/bin/sleep");
        save(&c, &entries).unwrap();
        assert!(load(&c, &e.owner).is_err());
        entries.insert(e.reservation.clone(), e.clone());
        save(&c, &entries).unwrap();
        fs::write(root(&c).join("state.pending"), b"partial").unwrap();
        assert!(release(&c, &e.owner, None).is_err());
        assert!(root(&c).join("state.json").exists());
        fs::remove_dir_all(c.checkout).unwrap();
    }
}
