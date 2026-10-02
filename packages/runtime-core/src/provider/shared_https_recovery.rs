//! Explicit no-signal archival of one dead, prior-boot shared HTTPS owner.
//! The endpoint v1 record has no PID/birth; complete executable absence and a
//! refused exact socket are quiescence observations, never process adoption.
use super::{graph::HttpsArchiveGuard, https_recovery, identity, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
};

const HEX32: usize = 32;
const MAX_FILE: u64 = 16_384;
fn refused() -> CandidateError {
    CandidateError::new(
        "shared_https_previous_boot_recovery",
        "Exact previous-boot shared HTTPS ownership or quiescence is unproven; retained evidence was preserved.",
    )
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(refused()),
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inode {
    dev: u64,
    ino: u64,
}
fn inode(m: &fs::Metadata) -> Inode {
    Inode {
        dev: m.dev(),
        ino: m.ino(),
    }
}
fn dir(path: &Path) -> Result<Inode, CandidateError> {
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !m.is_dir()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o777 != 0o700
        || fs::canonicalize(path).map_err(|_| refused())? != path
    {
        return Err(refused());
    }
    Ok(inode(&m))
}
fn exact_entries(path: &Path, expected: &[&str]) -> Result<(), CandidateError> {
    let mut got = fs::read_dir(path)
        .map_err(|_| refused())?
        .map(|e| {
            e.map_err(|_| refused())
                .and_then(|e| e.file_name().into_string().map_err(|_| refused()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    got.sort();
    let mut want = expected.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    want.sort();
    if got != want {
        return Err(refused());
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePin {
    inode: Inode,
    sha256: String,
}
fn read_file(path: &Path, limit: u64, private: bool) -> Result<(Vec<u8>, FilePin), CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let before = file.metadata().map_err(|_| refused())?;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != unsafe { libc::geteuid() }
        || (private && before.mode() & 0o777 != 0o600)
        || (!private && before.mode() & 0o022 != 0)
        || before.len() == 0
        || before.len() > limit
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    let after = file.metadata().map_err(|_| refused())?;
    if bytes.len() as u64 != before.len()
        || inode(&before) != inode(&after)
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || fs::canonicalize(path).map_err(|_| refused())? != path
    {
        return Err(refused());
    }
    Ok((
        bytes.clone(),
        FilePin {
            inode: inode(&before),
            sha256: digest(&bytes),
        },
    ))
}
fn pinned_file(path: &Path, expected: &FilePin, private: bool) -> Result<Vec<u8>, CandidateError> {
    let (bytes, actual) = read_file(path, MAX_FILE, private)?;
    if actual != *expected {
        return Err(refused());
    }
    Ok(bytes)
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Runtime {
    binary: PathBuf,
    home: PathBuf,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binary {
    binary: PathBuf,
    sha256: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Pool {
    owner: String,
    boot_id: String,
}
#[derive(Clone, Debug, Deserialize)]
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
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Configuration {
    version: u8,
    owner_generation: String,
    binding: Binding,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Lease {
    version: u8,
    owner_generation: String,
    lease_id: String,
    owner: String,
    run: String,
    attempt: String,
    namespace: String,
    plan_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Endpoint {
    version: u8,
    owner_generation: String,
    socket: PathBuf,
    dev: u64,
    ino: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    run: String,
    owner_generation: String,
    lease_id: String,
    old_boot: String,
    current_boot: String,
    recovery_process: identity::ProcessIdentity,
    admission: Inode,
    admission_lock: Inode,
    root: Inode,
    leases: Inode,
    configuration: FilePin,
    endpoint: FilePin,
    lease: FilePin,
    socket: SocketEvidence,
    ca: FilePin,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
enum SocketEvidence {
    Present {
        path: PathBuf,
        parent: Inode,
        socket: Inode,
    },
    Absent {
        path: PathBuf,
    },
}
impl SocketEvidence {
    fn path(&self) -> &Path {
        match self {
            Self::Present { path, .. } | Self::Absent { path } => path,
        }
    }
}
struct Paths {
    storage: PathBuf,
    source: PathBuf,
    archive: PathBuf,
    intent: PathBuf,
    complete: PathBuf,
    admission: PathBuf,
}
impl Paths {
    fn new(home: &Path, generation: &str, lease_id: &str) -> Self {
        let storage = home.join("native-https");
        let stem = format!("{generation}-{lease_id}");
        Self {
            source: storage.join("shared-owner"),
            archive: storage.join(format!("archived-previous-boot-shared-owner-{stem}")),
            intent: storage.join(format!("previous-boot-shared-owner-{stem}.intent.json")),
            complete: storage.join(format!("previous-boot-shared-owner-{stem}.complete.json")),
            admission: storage.join("shared-owner-admission.lock"),
            storage,
        }
    }
}
fn selected<'a>(
    source: &'a Path,
    archive: &'a Path,
    expected: Inode,
    directory: bool,
) -> Result<&'a Path, CandidateError> {
    let path = match (absent(source)?, absent(archive)?) {
        (false, true) => source,
        (true, false) => archive,
        _ => return Err(refused()),
    };
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    if inode(&m) != expected
        || m.uid() != unsafe { libc::geteuid() }
        || if directory {
            !m.is_dir() || m.mode() & 0o777 != 0o700
        } else {
            !m.file_type().is_socket() || m.mode() & 0o777 != 0o600
        }
    {
        return Err(refused());
    }
    Ok(path)
}
fn socket_archive(path: &Path, journal: &Journal) -> Result<PathBuf, CandidateError> {
    if path.file_name().and_then(|n| n.to_str()) != Some("control.sock") {
        return Err(refused());
    }
    let archived = path.with_file_name(format!("s{}", &journal.lease_id[..8]));
    if archived.as_os_str().len() >= 100 {
        return Err(refused());
    }
    Ok(archived)
}
fn socket_dead(path: &Path) -> Result<(), CandidateError> {
    match UnixStream::connect(path) {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
        _ => Err(refused()),
    }
}
fn socket_parent(path: &Path) -> Result<&Path, CandidateError> {
    let parent = path.parent().ok_or_else(refused)?;
    if path.file_name().and_then(|s| s.to_str()) != Some("control.sock")
        || path.as_os_str().len() >= 100
        || parent.parent() != Some(Path::new("/private/tmp"))
        || parent
            .file_name()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.starts_with("hk-https-leases-"))
    {
        return Err(refused());
    }
    Ok(parent)
}
fn sync_dir(path: &Path, expected: Inode) -> Result<(), CandidateError> {
    if dir(path)? != expected {
        return Err(refused());
    }
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| refused())
}
#[cfg(target_os = "macos")]
fn rename_exclusive(from: &Path, to: &Path) -> Result<(), CandidateError> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| refused())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| refused())?;
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(refused());
    }
    Ok(())
}
fn write_new(path: &Path, value: &impl Serialize, parent: Inode) -> Result<(), CandidateError> {
    let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| refused())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| refused())?;
    sync_dir(path.parent().ok_or_else(refused)?, parent)
}
fn lease_id(config: &Configuration, lease: &Lease) -> Result<String, CandidateError> {
    let parts = serde_json::json!([
        "native-https-lease-v1",
        config.owner_generation,
        config.binding.pool.owner,
        lease.run,
        lease.attempt,
        lease.namespace,
        lease.plan_id,
    ]);
    let bytes = serde_json::to_vec(&parts).map_err(|_| refused())?;
    Ok(digest(&bytes)[..32].into())
}
fn validate_config(
    config: &Configuration,
    lease: &Lease,
    endpoint: &Endpoint,
    home: &Path,
    generation: &str,
    expected_lease: &str,
) -> Result<(), CandidateError> {
    if config.version != 1
        || lease.version != 1
        || endpoint.version != 1
        || config.owner_generation != generation
        || lease.owner_generation != generation
        || endpoint.owner_generation != generation
        || lease.lease_id != expected_lease
        || lease_id(config, lease)? != expected_lease
        || config.binding.runtime.home != home
        || config.binding.pool.owner != lease.owner
        || config.binding.https_port == 0
        || !(1..=4096).contains(&config.binding.certificate_name_limit)
        || !hex(&lease.run, HEX32)
        || !hex(&lease.attempt, HEX32)
        || !hex(&lease.owner, HEX32)
        || !hex(&lease.namespace, 64)
        || !hex(&lease.plan_id, 64)
        || !hex(&config.binding.runtime_sha256, 64)
        || !hex(&config.binding.frontend.sha256, 64)
        || !hex(&config.binding.caddy_sha256, 64)
        || [
            &config.binding.runtime.binary,
            &config.binding.frontend.binary,
            &config.binding.caddy_binary,
        ]
        .iter()
        .any(|p| !p.is_absolute())
    {
        return Err(refused());
    }
    Ok(())
}
fn selected_evidence(
    paths: &Paths,
    journal: &Journal,
) -> Result<(Configuration, Lease, Endpoint, Option<PathBuf>), CandidateError> {
    let root = selected(&paths.source, &paths.archive, journal.root, true)?;
    exact_entries(root, &["configuration.json", "endpoint.json", "leases"])?;
    if dir(&root.join("leases"))? != journal.leases {
        return Err(refused());
    }
    exact_entries(
        &root.join("leases"),
        &[&format!("{}.json", journal.lease_id)],
    )?;
    let config: Configuration = serde_json::from_slice(&pinned_file(
        &root.join("configuration.json"),
        &journal.configuration,
        true,
    )?)
    .map_err(|_| refused())?;
    let lease: Lease = serde_json::from_slice(&pinned_file(
        &root
            .join("leases")
            .join(format!("{}.json", journal.lease_id)),
        &journal.lease,
        true,
    )?)
    .map_err(|_| refused())?;
    let endpoint: Endpoint = serde_json::from_slice(&pinned_file(
        &root.join("endpoint.json"),
        &journal.endpoint,
        true,
    )?)
    .map_err(|_| refused())?;
    validate_config(
        &config,
        &lease,
        &endpoint,
        &config.binding.runtime.home,
        &journal.owner_generation,
        &journal.lease_id,
    )?;
    if endpoint.socket != journal.socket.path() {
        return Err(refused());
    }
    socket_parent(&endpoint.socket)?;
    let socket_parent = endpoint.socket.parent().ok_or_else(refused)?;
    let selected_socket = match &journal.socket {
        SocketEvidence::Present { parent, socket, .. } => {
            if endpoint.dev != socket.dev
                || endpoint.ino != socket.ino
                || dir(socket_parent)? != *parent
            {
                return Err(refused());
            }
            let retired_socket = socket_archive(&endpoint.socket, journal)?;
            let selected = selected(&endpoint.socket, &retired_socket, *socket, false)?;
            exact_entries(
                socket_parent,
                &[selected
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(refused)?],
            )?;
            Some(selected.to_path_buf())
        }
        SocketEvidence::Absent { .. } => {
            if !absent(socket_parent)? || !absent(&endpoint.socket)? {
                return Err(refused());
            }
            None
        }
    };
    let ca = paths
        .storage
        .join("data/caddy/pki/authorities/local/root.crt");
    pinned_file(&ca, &journal.ca, false)?;
    Ok((config, lease, endpoint, selected_socket))
}
fn prove_quiescence(config: &Configuration, socket: Option<&Path>) -> Result<(), CandidateError> {
    let self_binary =
        fs::canonicalize(std::env::current_exe().map_err(|_| refused())?).map_err(|_| refused())?;
    for (path, hash) in [
        (
            &config.binding.frontend.binary,
            &config.binding.frontend.sha256,
        ),
        (
            &config.binding.runtime.binary,
            &config.binding.runtime_sha256,
        ),
        (&config.binding.caddy_binary, &config.binding.caddy_sha256),
    ] {
        if https_recovery::executable_hash(path)? != *hash {
            return Err(refused());
        }
    }
    for binary in [
        &config.binding.frontend.binary,
        &config.binding.runtime.binary,
        &config.binding.caddy_binary,
    ] {
        if fs::canonicalize(binary).map_err(|_| refused())? == self_binary
            || identity::executable_running(binary)?
        {
            return Err(refused());
        }
    }
    if let Some(socket) = socket {
        socket_dead(socket)?;
    }
    Ok(())
}

pub struct ArchiveSelection<'a> {
    pub run: &'a str,
    pub owner_generation: &'a str,
    pub lease_id: &'a str,
    pub attempt: &'a str,
    pub owner: &'a str,
    pub namespace: &'a str,
    pub plan: &'a str,
}

fn acquire_admission(paths: &Paths) -> Result<(bool, Inode, state::Lock, Inode), CandidateError> {
    let fresh = match fs::DirBuilder::new().mode(0o700).create(&paths.admission) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(refused()),
    };
    let admission_id = dir(&paths.admission)?;
    // An existing empty admission can belong to a normal ensure. Never create
    // its lock or infer ownership from an older completed archive.
    if !fresh && absent(&paths.intent)? && absent(&paths.complete)? {
        return Err(refused());
    }
    let admission_lock = if fresh {
        state::Lock::acquire(&paths.admission)?
    } else {
        state::Lock::acquire_existing(&paths.admission)?
    };
    let lock_id = fs::symlink_metadata(paths.admission.join("operation.lock"))
        .map(|m| inode(&m))
        .map_err(|_| refused())?;
    Ok((fresh, admission_id, admission_lock, lock_id))
}

fn verify_admission(
    paths: &Paths,
    admission_id: Inode,
    lock_id: Inode,
    lock: &state::Lock,
) -> Result<(), CandidateError> {
    if dir(&paths.admission)? != admission_id || lock.identity()? != (lock_id.dev, lock_id.ino) {
        return Err(refused());
    }
    exact_entries(&paths.admission, &["operation.lock"])?;
    let m = fs::symlink_metadata(paths.admission.join("operation.lock")).map_err(|_| refused())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o777 != 0o600
        || inode(&m) != lock_id
    {
        return Err(refused());
    }
    Ok(())
}

fn verify_recovery_process(journal: &Journal) -> Result<(), CandidateError> {
    if journal.recovery_process.pid == std::process::id() as i32 {
        if identity::observe(journal.recovery_process.pid)? != journal.recovery_process {
            return Err(refused());
        }
    } else if identity::alive(journal.recovery_process.pid)? {
        return Err(refused());
    }
    Ok(())
}

fn verify_journal_admission(
    journal: &Journal,
    fresh: bool,
    complete: bool,
    admission_id: Inode,
    lock_id: Inode,
) -> Result<(), CandidateError> {
    // An incomplete intent can resume only behind its original retained barrier.
    // A completed exact archive may be replayed behind a newly created barrier.
    if (fresh && !complete)
        || ((!complete || !fresh)
            && (journal.admission != admission_id || journal.admission_lock != lock_id))
    {
        return Err(refused());
    }
    Ok(())
}

/// An explicit current-branch native operation. A stale helper is never signaled,
/// its exact socket is retired by same-filesystem rename, and CA data is not changed.
pub fn archive(
    candidate: &Candidate,
    selection: ArchiveSelection<'_>,
) -> Result<serde_json::Value, CandidateError> {
    let ArchiveSelection {
        run,
        owner_generation: generation,
        lease_id,
        attempt,
        owner,
        namespace,
        plan,
    } = selection;
    if !hex(run, HEX32)
        || !hex(generation, HEX32)
        || !hex(lease_id, HEX32)
        || !hex(attempt, HEX32)
        || !hex(owner, HEX32)
        || !hex(namespace, 64)
        || !hex(plan, 64)
        || !cfg!(target_os = "macos")
    {
        return Err(refused());
    }
    let home = &candidate.checkout;
    let paths = Paths::new(home, generation, lease_id);
    let storage_id = dir(&paths.storage)?;
    let (fresh, admission_id, admission_lock, lock_id) = acquire_admission(&paths)?;
    verify_admission(&paths, admission_id, lock_id, &admission_lock)?;
    let mut intent_written = !absent(&paths.intent)?;
    let result = (|| {
        let journal: Journal = if intent_written {
            let (bytes, _) = read_file(&paths.intent, MAX_FILE, true)?;
            let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            if journal.version != 1
                || journal.run != run
                || journal.owner_generation != generation
                || journal.lease_id != lease_id
            {
                return Err(refused());
            }
            verify_journal_admission(
                &journal,
                fresh,
                !absent(&paths.complete)?,
                admission_id,
                lock_id,
            )?;
            // flock excludes a still-running predecessor; matching PID requires
            // matching birth, UID, and executable to exclude a reused process.
            verify_recovery_process(&journal)?;
            journal
        } else {
            if !fresh || !absent(&paths.complete)? || !absent(&paths.archive)? {
                return Err(refused());
            }
            let root = dir(&paths.source)?;
            exact_entries(
                &paths.source,
                &["configuration.json", "endpoint.json", "leases"],
            )?;
            let (config_bytes, configuration) =
                read_file(&paths.source.join("configuration.json"), MAX_FILE, true)?;
            let config: Configuration =
                serde_json::from_slice(&config_bytes).map_err(|_| refused())?;
            let leases_path = paths.source.join("leases");
            let leases = dir(&leases_path)?;
            exact_entries(&leases_path, &[&format!("{lease_id}.json")])?;
            let (lease_bytes, lease_pin) = read_file(
                &leases_path.join(format!("{lease_id}.json")),
                MAX_FILE,
                true,
            )?;
            let lease: Lease = serde_json::from_slice(&lease_bytes).map_err(|_| refused())?;
            let (endpoint_bytes, endpoint_pin) =
                read_file(&paths.source.join("endpoint.json"), MAX_FILE, true)?;
            let endpoint: Endpoint =
                serde_json::from_slice(&endpoint_bytes).map_err(|_| refused())?;
            validate_config(&config, &lease, &endpoint, home, generation, lease_id)?;
            if lease.run != run {
                return Err(refused());
            }
            let parent = socket_parent(&endpoint.socket)?;
            let socket = match (absent(parent)?, absent(&endpoint.socket)?) {
                (true, true) => SocketEvidence::Absent {
                    path: endpoint.socket,
                },
                (false, false) => {
                    let parent_id = dir(parent)?;
                    exact_entries(parent, &["control.sock"])?;
                    let socket_m = fs::symlink_metadata(&endpoint.socket).map_err(|_| refused())?;
                    if !socket_m.file_type().is_socket()
                        || socket_m.mode() & 0o777 != 0o600
                        || socket_m.uid() != unsafe { libc::geteuid() }
                        || socket_m.dev() != endpoint.dev
                        || socket_m.ino() != endpoint.ino
                    {
                        return Err(refused());
                    }
                    SocketEvidence::Present {
                        path: endpoint.socket,
                        parent: parent_id,
                        socket: inode(&socket_m),
                    }
                }
                _ => return Err(refused()),
            };
            let (_, ca) = read_file(
                &paths
                    .storage
                    .join("data/caddy/pki/authorities/local/root.crt"),
                MAX_FILE,
                false,
            )?;
            Journal {
                version: 1,
                run: run.into(),
                owner_generation: generation.into(),
                lease_id: lease_id.into(),
                old_boot: config.binding.pool.boot_id,
                current_boot: String::new(),
                recovery_process: identity::observe(std::process::id() as i32)?,
                admission: admission_id,
                admission_lock: lock_id,
                root,
                leases,
                configuration,
                endpoint: endpoint_pin,
                lease: lease_pin,
                socket,
                ca,
            }
        };
        let (config, lease, _, socket) = selected_evidence(&paths, &journal)?;
        if config.binding.runtime.home != *home
            || lease.run != run
            || lease.owner != owner
            || lease.attempt != attempt
            || lease.namespace != namespace
            || lease.plan_id != plan
            || lease.owner != config.binding.pool.owner
            || journal.old_boot != config.binding.pool.boot_id
        {
            return Err(refused());
        }
        let graph = HttpsArchiveGuard::acquire(
            candidate,
            run,
            &lease.owner,
            &lease.namespace,
            &lease.plan_id,
            &journal.old_boot,
        )?;
        if !journal.current_boot.is_empty() && journal.current_boot != graph.current_boot() {
            return Err(refused());
        }
        prove_quiescence(&config, socket.as_deref())?;
        let _ports = https_recovery::port_absent(config.binding.https_port)?;
        if !intent_written {
            let current = Journal {
                current_boot: graph.current_boot().into(),
                ..journal
            };
            graph.verify(candidate)?;
            selected_evidence(&paths, &current)?;
            verify_admission(&paths, admission_id, lock_id, &admission_lock)?;
            // Create-new/fsync may fail after publication. Keep the admission
            // barrier until a selected resume can prove the exact journal.
            intent_written = true;
            write_new(&paths.intent, &current, storage_id)?;
            run_archive(&paths, &current, storage_id, &mut || {
                verify_admission(&paths, admission_id, lock_id, &admission_lock)?;
                graph.verify(candidate)
            })?;
        } else {
            run_archive(&paths, &journal, storage_id, &mut || {
                verify_admission(&paths, admission_id, lock_id, &admission_lock)?;
                graph.verify(candidate)
            })?;
        }
        Ok(
            serde_json::json!({"archived":true,"run":run,"owner_generation":generation,"lease_id":lease_id,"data_retained":true,"processes_signaled":0}),
        )
    })();
    if result.is_ok() || !intent_written {
        // A completed archive may unblock normal admission. Before intent,
        // exact owned lock cleanup is safe; after uncertain effect it is not.
        let lock_path = paths.admission.join("operation.lock");
        if result.is_ok() {
            verify_admission(&paths, admission_id, lock_id, &admission_lock)?;
        }
        if verify_admission(&paths, admission_id, lock_id, &admission_lock).is_ok() {
            fs::remove_file(&lock_path).map_err(|_| refused())?;
            fs::remove_dir(&paths.admission).map_err(|_| refused())?;
            sync_dir(&paths.storage, storage_id)?;
        }
    }
    drop(admission_lock);
    result
}
fn run_archive(
    paths: &Paths,
    journal: &Journal,
    storage_id: Inode,
    verify_graph: &mut impl FnMut() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let intent_bytes = pinned_intent(paths, journal)?;
    if absent(&paths.complete)? {
        let (config, _, _, socket) = selected_evidence(paths, journal)?;
        prove_quiescence(&config, socket.as_deref())?;
        verify_graph()?;
        if let (SocketEvidence::Present { path, parent, .. }, Some(selected)) =
            (&journal.socket, socket.as_ref())
        {
            if selected == path {
                rename_exclusive(selected, &socket_archive(selected, journal)?)?;
                sync_dir(selected.parent().ok_or_else(refused)?, *parent)?;
            }
        }
        let (config, _, _, socket) = selected_evidence(paths, journal)?;
        prove_quiescence(&config, socket.as_deref())?;
        verify_graph()?;
        if !absent(&paths.source)? {
            rename_exclusive(&paths.source, &paths.archive)?;
            sync_dir(&paths.storage, storage_id)?;
        }
        let (config, _, _, socket) = selected_evidence(paths, journal)?;
        prove_quiescence(&config, socket.as_deref())?;
        verify_graph()?;
        let complete = serde_json::json!({"version":1,"intent_sha256":digest(&intent_bytes),"run":journal.run,
            "owner_generation":journal.owner_generation,"lease_id":journal.lease_id,
            "old_boot":journal.old_boot,"current_boot":journal.current_boot});
        write_new(&paths.complete, &complete, storage_id)?;
    } else {
        let (bytes, _) = read_file(&paths.complete, MAX_FILE, true)?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if value
            != serde_json::json!({"version":1,"intent_sha256":digest(&intent_bytes),"run":journal.run,
            "owner_generation":journal.owner_generation,"lease_id":journal.lease_id,
            "old_boot":journal.old_boot,"current_boot":journal.current_boot})
        {
            return Err(refused());
        }
    }
    if !absent(&paths.source)? || !absent(journal.socket.path())? {
        return Err(refused());
    }
    let (config, _, _, socket) = selected_evidence(paths, journal)?;
    prove_quiescence(&config, socket.as_deref())?;
    verify_graph()
}
fn pinned_intent(paths: &Paths, journal: &Journal) -> Result<Vec<u8>, CandidateError> {
    let (bytes, _) = read_file(&paths.intent, MAX_FILE, true)?;
    let parsed: Journal = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if serde_json::to_vec(&parsed).map_err(|_| refused())?
        != serde_json::to_vec(journal).map_err(|_| refused())?
    {
        return Err(refused());
    }
    Ok(bytes)
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
