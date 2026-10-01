//! Explicit archival of a quiescent legacy HTTPS owner and an unpublished shared owner.
//! No process is signaled, CA data is untouched, and every moved inode remains in history.
use super::{hostname_authority, identity, state};
use crate::{Candidate, CandidateError};
use base64::Engine as _;
mod ports;
use ports::port_absent;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "https_recovery_refused",
        "HTTPS recovery could not prove quiescence and exact evidence; retained state was preserved.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Inode {
    dev: u64,
    ino: u64,
}
fn inode(path: &Path) -> Result<Inode, CandidateError> {
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    if m.uid() != unsafe { libc::geteuid() } || m.file_type().is_symlink() {
        return Err(refused());
    }
    Ok(Inode {
        dev: m.dev(),
        ino: m.ino(),
    })
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(refused()),
    }
}
fn private_directory(path: &Path) -> Result<Inode, CandidateError> {
    let id = inode(path)?;
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !m.is_dir()
        || m.mode() & 0o777 != 0o700
        || fs::canonicalize(path).map_err(|_| refused())? != path
    {
        return Err(refused());
    }
    Ok(id)
}
fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    read_file(path, limit, true)
}
fn certificate(path: &Path) -> Result<Vec<u8>, CandidateError> {
    read_file(path, 65_536, false)
}
fn read_file(path: &Path, limit: u64, private: bool) -> Result<Vec<u8>, CandidateError> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let m = f.metadata().map_err(|_| refused())?;
    if !m.is_file()
        || m.nlink() != 1
        || (private && m.mode() & 0o777 != 0o600)
        || (!private && m.mode() & 0o022 != 0)
        || m.uid() != unsafe { libc::geteuid() }
        || m.len() == 0
        || m.len() > limit
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    (&mut f)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    let after = f.metadata().map_err(|_| refused())?;
    if bytes.len() as u64 != m.len()
        || m.mtime() != after.mtime()
        || m.ctime() != after.ctime()
        || m.mtime_nsec() != after.mtime_nsec()
        || m.ctime_nsec() != after.ctime_nsec()
        || fs::canonicalize(path).map_err(|_| refused())? != path
        || inode(path)?
            != (Inode {
                dev: m.dev(),
                ino: m.ino(),
            })
    {
        return Err(refused());
    }
    Ok(bytes)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    version: u8,
    listener: Listener,
    caddy_sha256: String,
    ca_sha256: String,
    authority: Authority,
    lock: Inode,
    owner: Challenge,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Listener {
    pid: i32,
    start_micros: u64,
    uid: u32,
    executable: PathBuf,
    port: u16,
    fingerprint: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authority {
    pid: i32,
    socket: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Challenge {
    public_key: String,
    dev: u64,
    ino: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Configuration {
    version: u8,
    owner_generation: String,
    binding: Binding,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Binding {
    runtime: Runtime,
    frontend: Binary,
    runtime_sha256: String,
    pool: Pool,
    caddy_binary: PathBuf,
    caddy_sha256: String,
    https_port: u16,
    certificate_name_limit: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    binary: PathBuf,
    home: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binary {
    binary: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Pool {
    owner: String,
    boot_id: String,
}
fn valid_hex(value: &str, limit: usize) -> bool {
    value.len() == limit
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    name: String,
    id: Inode,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    home: PathBuf,
    parent: Inode,
    owner_sha256: String,
    configuration_sha256: String,
    frontend_pid: i32,
    legacy_device_rebind: Option<LegacyDeviceRebind>,
    ca: Inode,
    ca_file_sha256: String,
    configuration: Inode,
    leases: Inode,
    entries: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyDeviceRebind {
    run: String,
    witness_sha256: String,
    socket: Inode,
    lock: Inode,
}
impl LegacyDeviceRebind {
    fn parse(value: &str) -> Result<Self, CandidateError> {
        let parts: Vec<_> = value.split(':').collect();
        if parts.len() != 6 || !valid_hex(parts[0], 32) || !valid_hash(parts[1]) {
            return Err(refused());
        }
        let number = |part: &str| {
            part.parse::<u64>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(refused)
        };
        Ok(Self {
            run: parts[0].into(),
            witness_sha256: parts[1].into(),
            socket: Inode {
                dev: number(parts[2])?,
                ino: number(parts[3])?,
            },
            lock: Inode {
                dev: number(parts[4])?,
                ino: number(parts[5])?,
            },
        })
    }
    fn matches(&self, receipt: &Receipt, old: u64, current: u64) -> bool {
        old != current
            && receipt.owner.dev == old
            && receipt.lock.dev == old
            && self.socket.dev == current
            && self.lock.dev == current
            && self.socket.ino == receipt.owner.ino
            && self.lock.ino == receipt.lock.ino
    }
}
fn selected(root: &Path, entry: &Entry, suffix: &str) -> Result<PathBuf, CandidateError> {
    let source = root.join(&entry.name);
    let archived = destination(root, &entry.name, suffix);
    match (absent(&source)?, absent(&archived)?) {
        (false, true) if inode(&source)? == entry.id => Ok(source),
        (true, false) if inode(&archived)? == entry.id => Ok(archived),
        _ => Err(refused()),
    }
}
fn destination(root: &Path, name: &str, suffix: &str) -> PathBuf {
    // The archived socket must still be probeable within sockaddr_un's path bound.
    // A short-name collision refuses; the full journal and exact inode remain authority.
    if name == "owner.sock" {
        root.join(format!("s{}", &suffix[..8]))
    } else {
        root.join(format!("{name}.retired-{suffix}"))
    }
}
fn names(path: &Path) -> Result<Vec<String>, CandidateError> {
    let mut names = fs::read_dir(path)
        .map_err(|_| refused())?
        .map(|e| {
            e.map_err(|_| refused())
                .and_then(|e| e.file_name().into_string().map_err(|_| refused()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}
fn observe(
    root: &Path,
    suffix: &str,
    journal: &Journal,
) -> Result<(Receipt, Configuration, PathBuf), CandidateError> {
    if private_directory(root)? != journal.parent
        || journal
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>()
            != [
                "owner.sock",
                "active-owner.json",
                "shared-owner",
                "owner.lock",
            ]
    {
        return Err(refused());
    }
    let paths = journal
        .entries
        .iter()
        .map(|e| selected(root, e, suffix))
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = bounded(&paths[1], 4096)?;
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if digest(&bytes) != journal.owner_sha256
        || receipt.version != 1
        || receipt.listener.pid <= 1
        || receipt.authority.pid <= 1
        || receipt.listener.start_micros == 0
        || receipt.listener.port == 0
        || receipt.listener.uid != unsafe { libc::geteuid() }
        || !receipt.listener.executable.is_absolute()
        || !receipt.authority.socket.is_absolute()
        || !valid_hash(&receipt.listener.fingerprint)
        || !valid_hash(&receipt.caddy_sha256)
        || !valid_hash(&receipt.ca_sha256)
        || !valid_hash(&receipt.authority.sha256)
        || receipt.owner.public_key.is_empty()
    {
        return Err(refused());
    }
    let socket = fs::symlink_metadata(&paths[0]).map_err(|_| refused())?;
    let socket_id = journal.entries[0].id;
    let lock_id = private_directory(&paths[3])?;
    let exact = socket_id
        == (Inode {
            dev: receipt.owner.dev,
            ino: receipt.owner.ino,
        })
        && lock_id == receipt.lock;
    let explicitly_selected = journal.legacy_device_rebind.as_ref().is_some_and(|s| {
        s.socket == socket_id
            && s.lock == lock_id
            && s.matches(&receipt, receipt.owner.dev, socket_id.dev)
    });
    if !socket.file_type().is_socket()
        || socket.mode() & 0o777 != 0o600
        || !(exact && journal.legacy_device_rebind.is_none() || explicitly_selected)
        || !names(&paths[3])?.is_empty()
    {
        return Err(refused());
    }
    private_directory(&paths[2])?;
    if names(&paths[2])? != ["configuration.json", "leases"] {
        return Err(refused());
    }
    if private_directory(&paths[2].join("leases"))? != journal.leases
        || inode(&paths[2].join("configuration.json"))? != journal.configuration
        || inode(&root.join("data/caddy/pki/authorities/local/root.crt"))? != journal.ca
        || digest(&certificate(
            &root.join("data/caddy/pki/authorities/local/root.crt"),
        )?) != journal.ca_file_sha256
    {
        return Err(refused());
    }
    if !names(&paths[2].join("leases"))?.is_empty() {
        return Err(refused());
    }
    let config_bytes = bounded(&paths[2].join("configuration.json"), 16384)?;
    if digest(&config_bytes) != journal.configuration_sha256 {
        return Err(refused());
    }
    let config: Configuration = serde_json::from_slice(&config_bytes).map_err(|_| refused())?;
    if config.version != 1
        || config.binding.runtime.home != journal.home
        || config.binding.https_port != receipt.listener.port
        || !valid_hex(&config.owner_generation, 32)
        || !valid_hex(&config.binding.pool.owner, 32)
        || !valid_hash(&config.binding.runtime_sha256)
        || !valid_hash(&config.binding.frontend.sha256)
        || !valid_hash(&config.binding.caddy_sha256)
        || config.binding.caddy_sha256 != receipt.caddy_sha256
        || config.binding.caddy_binary != receipt.listener.executable
        || !(1..=4096).contains(&config.binding.certificate_name_limit)
        || [
            &config.binding.runtime.home,
            &config.binding.runtime.binary,
            &config.binding.frontend.binary,
            &config.binding.caddy_binary,
        ]
        .iter()
        .any(|p| !p.is_absolute() || p.as_os_str().len() >= 4096)
    {
        return Err(refused());
    }
    let generation = &config.owner_generation;
    if !absent(&root.join("released-leases"))? {
        private_directory(&root.join("released-leases"))?;
    }
    if !absent(&root.join("released-leases").join(generation))? {
        return Err(refused());
    }
    Ok((receipt, config, paths[0].clone()))
}
#[cfg(target_os = "macos")]
fn rename_exclusive(source: &Path, destination: &Path) -> Result<(), CandidateError> {
    let source = CString::new(source.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
    let destination =
        CString::new(destination.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
    // SAFETY: both C strings remain valid for this call. RENAME_EXCL never overwrites a destination.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(refused());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn rename_exclusive(_source: &Path, _destination: &Path) -> Result<(), CandidateError> {
    Err(refused())
}
fn sync_directory(path: &Path, expected: &Inode) -> Result<(), CandidateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    if !m.is_dir()
        || (Inode {
            dev: m.dev(),
            ino: m.ino(),
        }) != *expected
    {
        return Err(refused());
    }
    file.sync_all().map_err(|_| refused())
}
fn archive_under<F, T>(root: &Path, journal: &Journal, verify: F) -> Result<(), CandidateError>
where
    F: Fn(&Receipt, &Configuration, &Path) -> Result<T, CandidateError>,
{
    let suffix = digest(&serde_json::to_vec(journal).map_err(|_| refused())?);
    for entry in &journal.entries {
        let (receipt, config, socket) = observe(root, &suffix, journal)?;
        let _guard = verify(&receipt, &config, &socket)?;
        // External observations can take time: recheck every selected entry and parent before effect.
        observe(root, &suffix, journal)?;
        let source = selected(root, entry, &suffix)?;
        if source == root.join(&entry.name) {
            rename_exclusive(&source, &destination(root, &entry.name, &suffix))?;
            sync_directory(root, &journal.parent)?;
        }
    }
    let (receipt, config, socket) = observe(root, &suffix, journal)?;
    verify(&receipt, &config, &socket)?;
    Ok(())
}
/** Compare DER bytes of the previously validated retained PEM; this does not install trust. */
fn ca_hash(path: &Path) -> Result<String, CandidateError> {
    let bytes = certificate(path)?;
    let pem = std::str::from_utf8(&bytes).map_err(|_| refused())?.trim();
    let body = pem
        .strip_prefix("-----BEGIN CERTIFICATE-----")
        .and_then(|p| p.strip_suffix("-----END CERTIFICATE-----"))
        .ok_or_else(refused)?;
    let encoded: Vec<u8> = body
        .bytes()
        .filter(|b| *b != b'\r' && *b != b'\n')
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| refused())?;
    if der.is_empty() {
        return Err(refused());
    }
    Ok(digest(&der))
}

fn executable_hash(binary: &Path) -> Result<String, CandidateError> {
    if fs::canonicalize(binary).map_err(|_| refused())? != binary {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(binary)
        .map_err(|_| refused())?;
    let before = file.metadata().map_err(|_| refused())?;
    if !before.is_file()
        || before.mode() & 0o022 != 0
        || before.mode() & 0o111 == 0
        || before.len() > 512 * 1024 * 1024
    {
        return Err(refused());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| refused())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|_| refused())?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || inode(binary)?
            != (Inode {
                dev: before.dev(),
                ino: before.ino(),
            })
    {
        return Err(refused());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn socket_absent(socket: &Path) -> Result<(), CandidateError> {
    match UnixStream::connect(socket) {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
        _ => Err(refused()),
    }
}

/// Archive only exact dead legacy HTTPS evidence and a selected unpublished shared-owner generation.
/// Repeated calls resume by inode; occupied targets and any live/uncertain effects refuse.
pub fn recover(
    candidate: &Candidate,
    owner_hash: &str,
    config_hash: &str,
    frontend_pid: i32,
) -> Result<serde_json::Value, CandidateError> {
    recover_selected(candidate, owner_hash, config_hash, frontend_pid, None)
}

/// Explicit legacy migration only; original host-volume continuity remains unproven.
pub fn recover_legacy_device_rebind(
    candidate: &Candidate,
    owner_hash: &str,
    config_hash: &str,
    frontend_pid: i32,
    selection: &str,
) -> Result<serde_json::Value, CandidateError> {
    recover_selected(
        candidate,
        owner_hash,
        config_hash,
        frontend_pid,
        Some(LegacyDeviceRebind::parse(selection)?),
    )
}

fn recover_selected(
    candidate: &Candidate,
    owner_hash: &str,
    config_hash: &str,
    frontend_pid: i32,
    legacy_device_rebind: Option<LegacyDeviceRebind>,
) -> Result<serde_json::Value, CandidateError> {
    if !cfg!(target_os = "macos")
        || !valid_hash(owner_hash)
        || !valid_hash(config_hash)
        || frontend_pid <= 1
    {
        return Err(refused());
    }
    let _lock = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm"))?;
    let home_pin = private_directory(&candidate.checkout)?;
    let operation_pin = _lock.identity()?;
    let root = candidate.checkout.join("native-https");
    let parent = private_directory(&root)?;
    let journal_path = root.join(format!("recovery-{owner_hash}-{config_hash}.json"));
    let journal = if absent(&journal_path)? {
        Journal {
            version: 1,
            home: candidate.checkout.clone(),
            parent,
            owner_sha256: owner_hash.into(),
            configuration_sha256: config_hash.into(),
            frontend_pid,
            legacy_device_rebind: legacy_device_rebind.clone(),
            ca: inode(&root.join("data/caddy/pki/authorities/local/root.crt"))?,
            ca_file_sha256: digest(&certificate(
                &root.join("data/caddy/pki/authorities/local/root.crt"),
            )?),
            configuration: inode(&root.join("shared-owner/configuration.json"))?,
            leases: private_directory(&root.join("shared-owner/leases"))?,
            entries: [
                "owner.sock",
                "active-owner.json",
                "shared-owner",
                "owner.lock",
            ]
            .iter()
            .map(|name| {
                Ok(Entry {
                    name: (*name).into(),
                    id: inode(&root.join(name))?,
                })
            })
            .collect::<Result<_, CandidateError>>()?,
        }
    } else {
        serde_json::from_slice::<Journal>(&bounded(&journal_path, 16384)?).map_err(|_| refused())?
    };
    if journal.version != 1
        || journal.home != candidate.checkout
        || journal.parent != parent
        || journal.owner_sha256 != owner_hash
        || journal.configuration_sha256 != config_hash
        || journal.frontend_pid != frontend_pid
        || journal.legacy_device_rebind != legacy_device_rebind
    {
        return Err(refused());
    }
    let verify = |receipt: &Receipt, config: &Configuration, socket: &Path| {
        let operation = inode(&candidate.state_root.join("run/smolvm/operation.lock"))?;
        if private_directory(&candidate.checkout)? != home_pin
            || (operation.dev, operation.ino) != operation_pin
        {
            return Err(refused());
        }
        if identity::alive(frontend_pid)?
            || identity::alive(receipt.listener.pid)?
            || identity::alive(receipt.authority.pid)?
        {
            return Err(refused());
        }
        for (binary, hash) in [
            (
                &config.binding.frontend.binary,
                &config.binding.frontend.sha256,
            ),
            (
                &config.binding.runtime.binary,
                &config.binding.runtime_sha256,
            ),
        ] {
            if identity::executable_running(binary)? || executable_hash(binary)? != *hash {
                return Err(refused());
            }
        }
        let pool = state::Owner::load(candidate)?;
        let authority = hostname_authority::managed::inspect(candidate)?;
        if config.binding.pool.owner != pool.token
            || pool.guest_boot_id.as_deref() != Some(config.binding.pool.boot_id.as_str())
            || authority["authority"]["present"] != false
            || authority["socket"].as_str() != receipt.authority.socket.to_str()
        {
            return Err(refused());
        }
        #[cfg(target_os = "macos")]
        if let Some(selection) = &journal.legacy_device_rebind {
            let (old, current) =
                super::graph::https_devices(candidate, &selection.run, &selection.witness_sha256)?;
            if !selection.matches(receipt, old, current) {
                return Err(refused());
            }
        }
        if ca_hash(&root.join("data/caddy/pki/authorities/local/root.crt"))? != receipt.ca_sha256 {
            return Err(refused());
        }
        socket_absent(socket)?;
        // Wildcard probes cover IPv4 and IPv6 listeners, unlike a loopback-only probe.
        port_absent(receipt.listener.port)
    };
    let suffix = digest(&serde_json::to_vec(&journal).map_err(|_| refused())?);
    let (receipt, config, socket) = observe(&root, &suffix, &journal)?;
    verify(&receipt, &config, &socket)?;
    if absent(&journal_path)? {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&journal_path)
            .map_err(|_| refused())?;
        file.write_all(&serde_json::to_vec(&journal).map_err(|_| refused())?)
            .map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        sync_directory(&root, &journal.parent)?;
    }
    let journal_pin = inode(&journal_path)?;
    let journal_bytes = serde_json::to_vec(&journal).map_err(|_| refused())?;
    archive_under(&root, &journal, |receipt, config, socket| {
        if inode(&journal_path)? != journal_pin || bounded(&journal_path, 16384)? != journal_bytes {
            return Err(refused());
        }
        verify(receipt, config, socket)
    })?;
    Ok(
        serde_json::json!({"https_evidence_archived":true,"owner_sha256":owner_hash,"configuration_sha256":config_hash,"entries":journal.entries.len(),"ca_preserved":true,"processes_signaled":0,"qualification":if journal.legacy_device_rebind.is_some(){"explicit-legacy-device-migration-original-volume-continuity-unproven"}else{"exact-recorded-device-and-inode"}}),
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
