//! Explicit stopped-pool recovery for unlistened dependency socket paths.
//! A private socket inode is not a listener or a grant; normal startup never adopts it.
use super::DependencySocketIntent;
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
};

use crate::provider::{identity::ProcessIdentity, lifecycle, state};

const MAX_RECEIPTS: usize = 16;
const RECEIPT_LIMIT: u64 = 16 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "dependency_socket_recovery",
        "Stopped dependency socket ownership is uncertain; paths and data were retained.",
    )
}

fn digest<T: Serialize>(value: &T) -> Result<String, CandidateError> {
    let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Socket {
    slot: u8,
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u8,
    checkout: PathBuf,
    owner: String,
    boot: String,
    process: ProcessIdentity,
    home: (u64, u64),
    slots: u8,
    sockets: Vec<Socket>,
}

fn home(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm/home")
}

fn journal(candidate: &Candidate) -> PathBuf {
    candidate
        .state_root
        .join("run/smolvm/dependency-socket-recovery")
}

fn stopped(candidate: &Candidate) -> Result<(Selection, PathBuf), CandidateError> {
    let owner = state::Owner::load(candidate)?;
    let status = lifecycle::status(candidate)?;
    if !matches!(
        status.phase.as_str(),
        "stopped" | "stopped-before-engine" | "stopped-after-engine-failure" | "recovered-unclean"
    ) || status.process_alive != Some(false)
        || !status.persistent_disks_identified
    {
        return Err(refused());
    }
    let process = owner.process.ok_or_else(refused)?;
    let boot = owner.guest_boot_id.ok_or_else(refused)?;
    let slots = owner.dependency_sockets.ok_or_else(refused)?.slots;
    DependencySocketIntent::new(slots)?;
    let directory = home(candidate);
    state::check_private_directory(&directory)?;
    let metadata = fs::symlink_metadata(&directory).map_err(state::io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(refused());
    }
    // The canonical provider HOME is longer than macOS's AF_UNIX path limit.
    // Owner::load already verifies this exact private short alias and its target.
    let short_home = owner.short_home.clone();
    let alias_target = fs::metadata(&short_home).map_err(|_| refused())?;
    if alias_target.dev() != metadata.dev() || alias_target.ino() != metadata.ino() {
        return Err(refused());
    }
    Ok((
        Selection {
            version: 1,
            checkout: candidate.checkout.clone(),
            owner: owner.token,
            boot,
            process,
            home: (metadata.dev(), metadata.ino()),
            slots,
            sockets: Vec::new(),
        },
        short_home,
    ))
}

fn path(directory: &Path, slot: u8) -> PathBuf {
    directory.join(format!("dependency-{slot:02}.sock"))
}

fn observed(directory: &Path, slot: u8) -> Result<Option<Socket>, CandidateError> {
    let target = path(directory, slot);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(refused()),
    };
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.ino() == 0
    {
        return Err(refused());
    }
    match UnixStream::connect(&target) {
        Err(error) if error.raw_os_error() == Some(libc::ECONNREFUSED) => {}
        _ => return Err(refused()),
    }
    let again = fs::symlink_metadata(&target).map_err(|_| refused())?;
    if again.dev() != metadata.dev()
        || again.ino() != metadata.ino()
        || again.mode() != metadata.mode()
        || again.uid() != metadata.uid()
        || !again.file_type().is_socket()
    {
        return Err(refused());
    }
    Ok(Some(Socket {
        slot,
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

fn current(mut scope: Selection, directory: &Path) -> Result<Selection, CandidateError> {
    for slot in 0..scope.slots {
        if let Some(socket) = observed(directory, slot)? {
            scope.sockets.push(socket);
        }
    }
    Ok(scope)
}

fn read(path: &Path) -> Result<Selection, CandidateError> {
    state::read_bounded(path, RECEIPT_LIMIT)
}

fn matching(
    selection: &Selection,
    scope: &Selection,
    directory: &Path,
) -> Result<usize, CandidateError> {
    let mut base = selection.clone();
    base.sockets.clear();
    if &base != scope
        || selection.sockets.is_empty()
        || selection.sockets.len() > usize::from(scope.slots)
        || selection
            .sockets
            .iter()
            .any(|socket| socket.slot >= scope.slots)
        || selection
            .sockets
            .windows(2)
            .any(|pair| pair[0].slot >= pair[1].slot)
    {
        return Err(refused());
    }
    let mut remaining = 0;
    for slot in 0..scope.slots {
        let saved = selection.sockets.iter().find(|item| item.slot == slot);
        let actual = observed(directory, slot)?;
        match (saved, actual) {
            (Some(saved), Some(actual)) if *saved == actual => remaining += 1,
            (Some(_), None) | (None, None) => {}
            _ => return Err(refused()),
        }
    }
    Ok(remaining)
}

fn same_scope(selection: &Selection, scope: &Selection) -> bool {
    let mut base = selection.clone();
    base.sockets.clear();
    &base == scope
}

fn receipts(directory: &Path) -> Result<Vec<PathBuf>, CandidateError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(refused()),
    };
    state::check_private_directory(directory)?;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| refused())?;
        let name = entry.file_name().into_string().map_err(|_| refused())?;
        if name.strip_suffix(".pending").is_some_and(hex) {
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| refused())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o7777 != 0o600
                || metadata.nlink() != 1
            {
                return Err(refused());
            }
            // write() renames a fully synced pending receipt before the first unlink.
            // An interrupted pending write therefore cannot authorize deletion.
            continue;
        }
        if !name.strip_suffix(".json").is_some_and(hex) || paths.len() >= MAX_RECEIPTS {
            return Err(refused());
        }
        paths.push(entry.path());
    }
    Ok(paths)
}

/// Read-only exact selection. A retained journal is returned after partial unlink so
/// the same explicit request can resume without guessing new inode identities.
pub fn inspect(candidate: &Candidate) -> Result<Value, CandidateError> {
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let (scope, directory) = stopped(candidate)?;
    for receipt in receipts(&journal(candidate))? {
        let selected = read(&receipt)?;
        let hash = digest(&selected)?;
        if receipt.file_name().and_then(|n| n.to_str()) != Some(&format!("{hash}.json")) {
            return Err(refused());
        }
        if same_scope(&selected, &scope) {
            let remaining = matching(&selected, &scope, &directory)?;
            if remaining > 0 {
                return Ok(
                    json!({"recoverable":true,"sha256":hash,"selected":selected.sockets.len(),"remaining":remaining,"resumable":true}),
                );
            }
        }
    }
    let selected = current(scope, &directory)?;
    if selected.sockets.is_empty() {
        return Ok(json!({"recoverable":false,"selected":0}));
    }
    Ok(
        json!({"recoverable":true,"sha256":digest(&selected)?,"selected":selected.sockets.len(),"remaining":selected.sockets.len(),"resumable":false}),
    )
}

/// Explicitly retire only selected unlistened socket inodes in one stopped pool.
/// The immutable receipt precedes the first unlink; retry accepts only exact remaining
/// inodes or already-absent paths. No application data, graph state or VM disk is removed.
pub fn recover(candidate: &Candidate, expected: &str) -> Result<Value, CandidateError> {
    if !hex(expected) {
        return Err(refused());
    }
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let (scope, directory) = stopped(candidate)?;
    let root = journal(candidate);
    let filename = root.join(format!("{expected}.json"));
    let saved = if filename.exists() || filename.is_symlink() {
        let value = read(&filename)?;
        if digest(&value)? != expected {
            return Err(refused());
        }
        value
    } else {
        let value = current(scope.clone(), &directory)?;
        if value.sockets.is_empty() || digest(&value)? != expected {
            return Err(refused());
        }
        if receipts(&root)?.len() >= MAX_RECEIPTS {
            return Err(refused());
        }
        state::private_directory(&root)?;
        let pending = filename.with_extension("pending");
        let abandoned = match fs::symlink_metadata(&pending) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(refused()),
        };
        if let Some(metadata) = abandoned {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o7777 != 0o600
                || metadata.nlink() != 1
            {
                return Err(refused());
            }
            fs::remove_file(&pending).map_err(state::io)?;
            File::open(&root)
                .and_then(|file| file.sync_all())
                .map_err(state::io)?;
        }
        state::write(&filename, &value)?;
        value
    };
    let remaining = matching(&saved, &scope, &directory)?;
    for socket in &saved.sockets {
        let target = path(&directory, socket.slot);
        if observed(&directory, socket.slot)?.as_ref() == Some(socket) {
            fs::remove_file(&target).map_err(state::io)?;
            File::open(&directory)
                .and_then(|file| file.sync_all())
                .map_err(state::io)?;
        }
    }
    if matching(&saved, &scope, &directory)? != 0 {
        return Err(refused());
    }
    Ok(
        json!({"recovered":true,"sha256":expected,"selected":saved.sockets.len(),"removed":remaining,"already_absent":saved.sockets.len()-remaining,"data_retained":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let base = if cfg!(target_os = "macos") {
                PathBuf::from("/private/tmp")
            } else {
                std::env::temp_dir()
            };
            let path = base.join(format!(
                "hkd-dr-{}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }

        fn bind(&self, slot: u8) -> UnixListener {
            let target = path(&self.0, slot);
            let listener = UnixListener::bind(&target).unwrap();
            fs::set_permissions(target, fs::Permissions::from_mode(0o600)).unwrap();
            listener
        }

        fn scope(&self, slots: u8) -> Selection {
            let metadata = fs::metadata(&self.0).unwrap();
            Selection {
                version: 1,
                checkout: self.0.clone(),
                owner: "0123456789abcdef0123456789abcdef".into(),
                boot: "boot-1".into(),
                process: ProcessIdentity {
                    pid: 42,
                    start_micros: 1,
                    uid: unsafe { libc::geteuid() },
                    executable: PathBuf::from("/bin/false"),
                },
                home: (metadata.dev(), metadata.ino()),
                slots,
                sockets: Vec::new(),
            }
        }
    }

    fn stale(target: &Path) {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::dependency_socket::recovery::tests::stale_socket_helper",
            ])
            .env("HACK_DEP_SOCKET_TEST_PATH", target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stale socket helper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[ignore = "subprocess-only stale socket fixture"]
    fn stale_socket_helper() {
        let Some(target) = std::env::var_os("HACK_DEP_SOCKET_TEST_PATH") else {
            return;
        };
        let listener = UnixListener::bind(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        drop(listener);
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn only_stale_private_unix_sockets_are_selected() {
        let fixture = Fixture::new();
        let listener = fixture.bind(0);
        assert!(observed(&fixture.0, 0).is_err());
        drop(listener);
        let target = path(&fixture.0, 0);
        fs::remove_file(&target).unwrap();
        stale(&target);
        assert!(observed(&fixture.0, 0).unwrap().is_some());

        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(observed(&fixture.0, 0).is_err());
        fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink("/tmp", &target).unwrap();
        assert!(observed(&fixture.0, 0).is_err());
    }

    #[test]
    fn partial_retry_accepts_absence_but_rejects_replacement() {
        let fixture = Fixture::new();
        stale(&path(&fixture.0, 0));
        stale(&path(&fixture.0, 1));
        let scope = fixture.scope(2);
        let selected = current(scope.clone(), &fixture.0).unwrap();
        assert_eq!(matching(&selected, &scope, &fixture.0).unwrap(), 2);

        fs::remove_file(path(&fixture.0, 0)).unwrap();
        assert_eq!(matching(&selected, &scope, &fixture.0).unwrap(), 1);
        fs::remove_file(path(&fixture.0, 1)).unwrap();
        stale(&path(&fixture.0, 1));
        assert!(matching(&selected, &scope, &fixture.0).is_err());
        assert!(!same_scope(
            &selected,
            &Selection {
                boot: "boot-2".into(),
                ..scope
            }
        ));
    }

    #[test]
    fn private_short_alias_reaches_a_socket_beyond_unix_path_limit() {
        let fixture = Fixture::new();
        let canonical = fixture.0.join("long-provider-home-".repeat(6));
        fs::create_dir(&canonical).unwrap();
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = fixture.0.join("short");
        std::os::unix::fs::symlink(&canonical, &alias).unwrap();
        let target = path(&alias, 0);
        stale(&target);

        assert!(observed(&canonical, 0).is_err());
        assert!(observed(&alias, 0).unwrap().is_some());
    }
}
