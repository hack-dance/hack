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
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binary: Option<BinaryStage>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BinaryStage {
    device: u64,
    inode: u64,
    ready: bool,
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
    validate(&entries, owner)?;
    Ok(entries)
}
fn validate(entries: &BTreeMap<String, Entry>, owner: &str) -> Result<(), CandidateError> {
    if !hex(owner, 32) || entries.len() > 32 {
        return Err(error());
    }
    let mut ports = std::collections::BTreeSet::new();
    let mut slots = std::collections::BTreeSet::new();
    for (key, e) in entries {
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
            || e.directory.is_some_and(|(_, inode)| inode == 0)
            || e.binary
                .as_ref()
                .is_some_and(|b| b.inode == 0 || e.directory.is_none())
            || e.process.executable != directory(e).join("publisher")
        {
            return Err(error());
        }
    }
    Ok(())
}
/// Recover only complete, single-step publications while holding the provider lock.
/// This runs on cleanup paths; startup never replays a pending journal.
fn recover_pending(c: &Candidate, owner: &str) -> Result<(), CandidateError> {
    let root = root(c);
    let pending = root.join("state.pending");
    if !pending.exists() && !pending.is_symlink() {
        return Ok(());
    }
    state::check_private_directory(&root)?;
    let path = root.join("state.json");
    let before: BTreeMap<String, Entry> = if path.exists() || path.is_symlink() {
        state::read_bounded(&path, 65536)?
    } else {
        BTreeMap::new()
    };
    let after: BTreeMap<String, Entry> = state::read_bounded(&pending, 65536)?;
    validate(&before, owner)?;
    validate(&after, owner)?;
    let keys = before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let changed = keys
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .collect::<Vec<_>>();
    if changed.len() > 1 {
        return Err(error());
    }
    if let Some(key) = changed.first() {
        let old = before.get(*key);
        let new = after.get(*key);
        let entry = new.or(old).expect("changed entry");
        if identity::alive(entry.process.pid)? {
            return Err(error());
        }
        match (old, new) {
            (None, Some(e)) => {
                if e.directory.is_some()
                    || e.binary.is_some()
                    || directory(e).exists()
                    || directory(e).is_symlink()
                {
                    return Err(error());
                }
            }
            (Some(e), None) => {
                if directory(e).exists() || directory(e).is_symlink() {
                    return Err(error());
                }
            }
            (Some(old), Some(new)) => {
                let mut expected = old.clone();
                let allowed = match (&old.directory, &new.directory, &old.binary, &new.binary) {
                    (None, Some(_), None, None) => {
                        expected.directory = new.directory;
                        true
                    }
                    (Some(a), Some(b), None, Some(stage)) if a == b && !stage.ready => {
                        expected.binary = new.binary.clone();
                        true
                    }
                    (Some(a), Some(b), Some(x), Some(y))
                        if a == b
                            && !x.ready
                            && y.ready
                            && x.device == y.device
                            && x.inode == y.inode =>
                    {
                        expected.binary = new.binary.clone();
                        true
                    }
                    _ => false,
                };
                if !allowed || expected != *new {
                    return Err(error());
                }
                verify_directory(new)?;
            }
            _ => return Err(error()),
        }
    }
    // read_bounded checked the private regular file; open again without following aliases
    // and sync before completing the same rename used by the original writer.
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&pending)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    fs::rename(&pending, &path).map_err(state::io)?;
    File::open(root)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
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
fn retire_control(e: &Entry) -> Result<(), CandidateError> {
    let dir = directory(e);
    let control = dir.join("control");
    let receipt = dir.join("control.identity");
    let present = |p: &Path| p.exists() || p.is_symlink();
    if !present(&receipt) {
        return if present(&control) {
            Err(error())
        } else {
            Ok(())
        };
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&receipt)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != e.process.uid
        || m.mode() & 0o077 != 0
        || m.len() > 256
    {
        return Err(error());
    }
    let mut bytes = Vec::new();
    file.take(257).read_to_end(&mut bytes).map_err(state::io)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| error())?;
    let fields = text.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(error());
    }
    let device = fields[2].parse::<u64>().map_err(|_| error())?;
    let inode = fields[3].parse::<u64>().map_err(|_| error())?;
    if inode == 0 || text != format!("HKPC1 {} {device} {inode} {}\n", e.process.pid, e.token) {
        return Err(error());
    }
    if present(&control) {
        let socket = fs::symlink_metadata(&control).map_err(state::io)?;
        if !socket.file_type().is_socket()
            || socket.uid() != e.process.uid
            || socket.mode() & 0o077 != 0
            || socket.nlink() != 1
            || socket.dev() != device
            || socket.ino() != inode
        {
            return Err(error());
        }
        fs::remove_file(control).map_err(state::io)?;
    }
    let current = fs::symlink_metadata(&receipt).map_err(state::io)?;
    if current.dev() != m.dev() || current.ino() != m.ino() {
        return Err(error());
    }
    fs::remove_file(receipt).map_err(state::io)?;
    File::open(dir)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
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
    let staging = e.binary.as_ref().is_some_and(|b| !b.ready);
    if staging
        && ["control", "control.identity"].iter().any(|name| {
            let path = dir.join(name);
            path.exists() || path.is_symlink()
        })
    {
        return Err(error());
    }
    // Validate the complete directory before deleting any staged resource.
    for entry in fs::read_dir(&dir).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        if entry.file_name() == "control" || entry.file_name() == "control.identity" {
            continue;
        }
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
        if e.binary
            .as_ref()
            .is_some_and(|b| b.device != m.dev() || b.inode != m.ino())
        {
            return Err(error());
        }
        if bytes.len() > 512 * 1024
            || (!staging && format!("{:x}", Sha256::digest(bytes)) != e.digest)
        {
            return Err(error());
        }
    }
    retire_control(e)?;
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
    recover_pending(c, owner)?;
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
        binary: None,
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
    let metadata = file.metadata().map_err(state::io)?;
    File::open(&dir)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    e.binary = Some(BinaryStage {
        device: metadata.dev(),
        inode: metadata.ino(),
        ready: false,
    });
    entries.insert(e.reservation.clone(), e.clone());
    save(c, &entries)?;
    file.write_all(bytes).map_err(state::io)?;
    file.sync_all().map_err(state::io)?;
    File::open(&dir)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    drop(file);
    e.binary.as_mut().expect("recorded staged file").ready = true;
    entries.insert(e.reservation.clone(), e.clone());
    save(c, &entries)?;
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
            binary: None,
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
    fn stale_control_requires_matching_native_receipt_and_preserves_replacements() {
        use std::os::unix::net::UnixDatagram;
        for mismatch in ["none", "token", "replacement", "missing"] {
            let (c, mut e) = fixture();
            let dir = directory(&e);
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            let m = fs::metadata(&dir).unwrap();
            e.directory = Some((m.dev(), m.ino()));
            let control = dir.join("control");
            let socket = UnixDatagram::bind(&control).unwrap();
            fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
            let original = fs::symlink_metadata(&control).unwrap();
            let receipt = dir.join("control.identity");
            let token = if mismatch == "token" {
                "f".repeat(32)
            } else {
                e.token.clone()
            };
            if mismatch != "missing" {
                fs::write(
                    &receipt,
                    format!(
                        "HKPC1 {} {} {} {token}\n",
                        e.process.pid,
                        original.dev(),
                        original.ino()
                    ),
                )
                .unwrap();
                fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let replacement = if mismatch == "replacement" {
                fs::remove_file(&control).unwrap();
                let other = UnixDatagram::bind(&control).unwrap();
                fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
                assert_ne!(
                    original.ino(),
                    fs::symlink_metadata(&control).unwrap().ino()
                );
                Some(other)
            } else {
                None
            };
            if mismatch == "none" {
                cleanup(&e).unwrap();
                assert!(!dir.exists());
            } else {
                assert!(cleanup(&e).is_err());
                assert!(control.exists());
                fs::remove_dir_all(&dir).unwrap();
            }
            drop(replacement);
            drop(socket);
            fs::remove_dir_all(c.checkout).unwrap();
        }
    }
    #[test]
    fn incomplete_helper_cleanup_requires_recorded_inode_and_pre_exec_phase() {
        for variant in ["staging", "ready", "replaced", "legacy", "control"] {
            let (c, mut e) = fixture();
            let dir = directory(&e);
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            let m = fs::metadata(&dir).unwrap();
            e.directory = Some((m.dev(), m.ino()));
            fs::write(&e.process.executable, b"partial helper bytes").unwrap();
            fs::set_permissions(&e.process.executable, fs::Permissions::from_mode(0o700)).unwrap();
            let m = fs::metadata(&e.process.executable).unwrap();
            if variant != "legacy" {
                e.binary = Some(BinaryStage {
                    device: m.dev(),
                    inode: m.ino() + u64::from(variant == "replaced"),
                    ready: variant == "ready",
                });
            }
            if variant == "control" {
                fs::write(dir.join("control.identity"), b"unexpected").unwrap();
            }
            let entries = BTreeMap::from([(e.reservation.clone(), e.clone())]);
            save(&c, &entries).unwrap();
            if variant == "staging" {
                release(&c, &e.owner, None).unwrap();
                assert!(!dir.exists());
                assert!(load(&c, &e.owner).unwrap().is_empty());
            } else {
                assert!(release(&c, &e.owner, None).is_err());
                assert_eq!(
                    fs::read(&e.process.executable).unwrap(),
                    b"partial helper bytes"
                );
                assert!(load(&c, &e.owner).unwrap().contains_key(&e.reservation));
                fs::remove_dir_all(dir).unwrap();
            }
            fs::remove_dir_all(c.checkout).unwrap();
        }
    }
    fn pending(c: &Candidate, entries: &BTreeMap<String, Entry>) {
        let path = root(c).join("state.pending");
        fs::write(&path, serde_json::to_vec(entries).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn cleanup_recovers_complete_single_step_journals_without_launching() {
        for phase in [
            "initial",
            "directory",
            "binary",
            "ready",
            "removed",
            "identical",
        ] {
            let (c, mut e) = fixture();
            let dir = directory(&e);
            let mut before = BTreeMap::new();
            let mut after = BTreeMap::new();
            if phase != "initial" {
                if ["binary", "ready", "removed"].contains(&phase) {
                    fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
                    let m = fs::metadata(&dir).unwrap();
                    e.directory = Some((m.dev(), m.ino()));
                }
                if ["ready", "removed"].contains(&phase) {
                    fs::write(&e.process.executable, b"fixture").unwrap();
                    fs::set_permissions(&e.process.executable, fs::Permissions::from_mode(0o700))
                        .unwrap();
                    let m = fs::metadata(&e.process.executable).unwrap();
                    e.binary = Some(BinaryStage {
                        device: m.dev(),
                        inode: m.ino(),
                        ready: false,
                    });
                }
                before.insert(e.reservation.clone(), e.clone());
            }
            match phase {
                "directory" => {
                    fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
                    let m = fs::metadata(&dir).unwrap();
                    e.directory = Some((m.dev(), m.ino()));
                }
                "binary" => {
                    fs::write(&e.process.executable, b"partial").unwrap();
                    fs::set_permissions(&e.process.executable, fs::Permissions::from_mode(0o700))
                        .unwrap();
                    let m = fs::metadata(&e.process.executable).unwrap();
                    e.binary = Some(BinaryStage {
                        device: m.dev(),
                        inode: m.ino(),
                        ready: false,
                    });
                }
                "ready" => {
                    e.binary.as_mut().unwrap().ready = true;
                }
                "removed" => {
                    fs::remove_dir_all(&dir).unwrap();
                }
                _ => {}
            }
            if phase != "removed" {
                after.insert(e.reservation.clone(), e.clone());
            }
            save(&c, &before).unwrap();
            pending(&c, &after);
            assert!(load(&c, &e.owner).is_err()); // Startup remains fail-closed.
            release(&c, &e.owner, None).unwrap();
            assert!(!dir.exists());
            assert!(!root(&c).join("state.pending").exists());
            assert!(load(&c, &e.owner).unwrap().is_empty());
            fs::remove_dir_all(c.checkout).unwrap();
        }
    }
    #[test]
    fn journal_recovery_refuses_immutable_changes_live_launchers_and_early_retirement() {
        for variant in [
            "token",
            "pid",
            "live",
            "remove-owned",
            "regress",
            "multiple",
        ] {
            let (c, mut e) = fixture();
            let dir = directory(&e);
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            let m = fs::metadata(&dir).unwrap();
            e.directory = Some((m.dev(), m.ino()));
            if variant == "live" {
                e.process = identity::observe(std::process::id() as i32).unwrap();
                e.process.executable = dir.join("publisher");
            }
            if variant == "regress" {
                e.binary = Some(BinaryStage {
                    device: m.dev(),
                    inode: m.ino(),
                    ready: true,
                });
            }
            let before = BTreeMap::from([(e.reservation.clone(), e.clone())]);
            let mut after = before.clone();
            let entry = after.get_mut(&e.reservation).unwrap();
            match variant {
                "token" => entry.token = "f".repeat(32),
                "pid" => entry.process.start_micros += 1,
                "live" => {
                    entry.binary = Some(BinaryStage {
                        device: m.dev(),
                        inode: m.ino(),
                        ready: false,
                    })
                }
                "remove-owned" => {
                    after.clear();
                }
                "regress" => entry.binary.as_mut().unwrap().ready = false,
                "multiple" => {
                    after.clear();
                    let mut other = e.clone();
                    other.reservation = "f".repeat(32);
                    other.process.executable = directory(&other).join("publisher");
                    other.directory = None;
                    after.insert(other.reservation.clone(), other);
                }
                _ => unreachable!(),
            }
            save(&c, &before).unwrap();
            pending(&c, &after);
            let original = fs::read(root(&c).join("state.json")).unwrap();
            let pending_bytes = fs::read(root(&c).join("state.pending")).unwrap();
            assert!(release(&c, &e.owner, None).is_err());
            assert_eq!(fs::read(root(&c).join("state.json")).unwrap(), original);
            assert_eq!(
                fs::read(root(&c).join("state.pending")).unwrap(),
                pending_bytes
            );
            assert!(dir.exists());
            fs::remove_dir_all(dir).unwrap();
            fs::remove_dir_all(c.checkout).unwrap();
        }
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
        fs::set_permissions(
            root(&c).join("state.pending"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(release(&c, &e.owner, None).is_err());
        assert!(root(&c).join("state.json").exists());
        fs::remove_dir_all(c.checkout).unwrap();
    }
}
