//! Pinned guest-only networking dependencies, installed before Docker discovers capabilities.
use super::{source_sync, state};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

const PACKAGES: [(&str, &str); 4] = [
    (
        "iptables-1.8.10-r3.apk",
        "31ab6343f1f3d0fbbf290c4dcf0430b2d08e8073e516e13530dfab25b097d467",
    ),
    (
        "libmnl-1.0.5-r2.apk",
        "d15e6313880bdd14959f42c1556b4a810ef4894992ae9f73b148126f0cc6021d",
    ),
    (
        "libnftnl-1.2.6-r0.apk",
        "ec1c2b02869fc65bcf7a1105e3a7ac5df1bd9a8bd8b399cb6cf650dd3112c021",
    ),
    (
        "libxtables-1.8.10-r3.apk",
        "f0accefde240ece6722479b46cb014d7d2f745af7d796e8eec3ced53571e1088",
    ),
];
fn error(message: &str) -> CandidateError {
    CandidateError::new("network_tools", message)
}
fn read_archive(path: &Path, expected: &str) -> Result<Vec<u8>, CandidateError> {
    state::check_private_directory(path.parent().expect("archive parent"))?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 2 * 1024 * 1024
    {
        return Err(error(
            "Expected a private, singly linked networking archive under 2 MiB.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 != metadata.len() || format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(error("Networking archive size or pinned digest mismatch."));
    }
    Ok(bytes)
}

#[derive(Debug, Serialize)]
pub struct Preparation {
    pub status: &'static str,
    pub package_count: usize,
    pub identity: String,
}

/// Validate the entire pinned input set before mutation, then publish one complete
/// private directory under the same operation lock used by runtime lifecycle work.
/// Interrupted staging is retained and refused; existing installs are never repaired in place.
pub(super) fn prepare(
    candidate: &Candidate,
    directory: &Path,
) -> Result<Preparation, CandidateError> {
    prepare_packages(candidate, directory, &PACKAGES)
}

fn prepare_packages(
    candidate: &Candidate,
    directory: &Path,
    packages: &[(&str, &str)],
) -> Result<Preparation, CandidateError> {
    let archives = packages
        .iter()
        .map(|(name, hash)| read_archive(&directory.join(name), hash))
        .collect::<Result<Vec<_>, _>>()?;
    let identity = format!(
        "{:x}",
        Sha256::digest(packages.iter().map(|(_, hash)| *hash).collect::<String>())
    );
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers)?;
    let target = providers.join("network-tools");
    match target.symlink_metadata() {
        Ok(_) => {
            for (name, hash) in packages {
                read_archive(&target.join(name), hash)?;
            }
            return Ok(Preparation {
                status: "reused",
                package_count: packages.len(),
                identity,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    let staging = providers.join("network-tools-installing");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| error(&format!("Cannot create network-tools staging: {e}")))?;
    for ((name, _), bytes) in packages.iter().zip(archives) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(staging.join(name))
            .map_err(|e| error(&format!("Cannot create staged archive: {e}")))?;
        file.write_all(&bytes).map_err(state::io)?;
        file.sync_all().map_err(state::io)?;
    }
    for (name, hash) in packages {
        read_archive(&staging.join(name), hash)?;
    }
    File::open(&staging)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)?;
    fs::rename(&staging, &target)
        .map_err(|e| error(&format!("Cannot publish network-tools directory: {e}")))?;
    File::open(&providers)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)?;
    Ok(Preparation {
        status: "installed",
        package_count: packages.len(),
        identity,
    })
}

/// Refuse missing or invalid setup before VM creation/start; guest provisioning rechecks bytes.
pub(super) fn verify(candidate: &Candidate) -> Result<(), CandidateError> {
    for (name, hash) in PACKAGES {
        read_archive(&candidate.state_root.join("providers/network-tools").join(name), hash)
            .map_err(|_| error("Pinned network tools are missing or invalid. Run runtime prepare-network-tools --directory <private-pinned-apk-directory> before runtime up."))?;
    }
    Ok(())
}

pub(super) fn provision(
    candidate: &Candidate,
    owner: &str,
    execute: &mut impl FnMut(&str, &[&str], Option<&str>) -> Result<String, CandidateError>,
) -> Result<(), CandidateError> {
    // Validate every host input before changing guest state, including on reuse.
    let archives = PACKAGES
        .iter()
        .map(|(name, hash)| {
            read_archive(
                &candidate
                    .state_root
                    .join("providers/network-tools")
                    .join(name),
                hash,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let identity = format!(
        "{:x}",
        Sha256::digest(PACKAGES.iter().map(|(_, hash)| *hash).collect::<String>())
    );
    let result = execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "check"],
        None,
    )?;
    if result.trim() == "ready" {
        return Ok(());
    }
    if result.trim() != "absent" {
        return Err(error("Unexpected networking provisioning state."));
    }
    let stage = execute(
        "umask 077; mktemp -d /run/hack-local/network-tools.XXXXXXXX",
        &[],
        None,
    )?;
    let stage = stage.trim();
    if !stage.starts_with("/run/hack-local/network-tools.")
        || !stage
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-._".contains(&b))
    {
        return Err(error("Invalid networking staging path."));
    }
    for ((name, hash), bytes) in PACKAGES.iter().zip(archives) {
        let target = format!("{stage}/{name}");
        execute("(set -C; : > \"$1\")", &[&target], None)?;
        source_sync::upload_with(execute, &target, &bytes)?;
        execute(
            "test \"$(sha256sum \"$1\" | cut -d ' ' -f 1)\" = \"$2\"; apk verify \"$1\" >/dev/null",
            &[&target, hash],
            None,
        )?;
    }
    execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "install", stage],
        None,
    )?;
    let result = execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "check"],
        None,
    )?;
    if result.trim() != "ready" {
        return Err(error("Networking installation was not verified."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-network-prepare-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn candidate(&self) -> Candidate {
            let root = self.0.join("candidate");
            state::private_directory(&root).unwrap();
            Candidate::discover(&root).unwrap()
        }
        fn inputs(&self) -> std::path::PathBuf {
            let root = self.0.join("input");
            state::private_directory(&root).unwrap();
            for name in ["first.apk", "second.apk"] {
                fs::write(root.join(name), b"fixture").unwrap();
                fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o600)).unwrap();
            }
            root
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn missing_or_corrupt_inputs_do_not_create_candidate_state() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str()), ("second.apk", hash.as_str())];
        fs::remove_file(input.join("second.apk")).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!candidate.state_root.exists());
        fs::write(input.join("second.apk"), b"corrupt").unwrap();
        fs::set_permissions(input.join("second.apk"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!candidate.state_root.exists());
        // The public entrypoint cannot accept arbitrary test pins.
        assert!(prepare(&candidate, &input).is_err());
        let missing = verify(&candidate).unwrap_err();
        assert_eq!(missing.code, "network_tools");
        assert!(missing.message.contains("prepare-network-tools"));
        assert!(!candidate.state_root.exists());
    }

    #[test]
    fn complete_install_is_atomic_reusable_and_corruption_is_not_overwritten() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str()), ("second.apk", hash.as_str())];
        assert_eq!(
            prepare_packages(&candidate, &input, &pins).unwrap().status,
            "installed"
        );
        let target = candidate.state_root.join("providers/network-tools");
        let inode = target.metadata().unwrap().ino();
        assert!(
            !candidate
                .state_root
                .join("providers/network-tools-installing")
                .exists()
        );
        assert_eq!(
            prepare_packages(&candidate, &input, &pins).unwrap().status,
            "reused"
        );
        assert_eq!(target.metadata().unwrap().ino(), inode);
        fs::write(target.join("first.apk"), b"corrupt").unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert_eq!(fs::read(target.join("first.apk")).unwrap(), b"corrupt");
    }

    #[test]
    fn interrupted_staging_and_foreign_target_are_retained_and_refused() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str())];
        let providers = candidate.state_root.join("providers");
        let staging = providers.join("network-tools-installing");
        state::private_directory(&staging).unwrap();
        fs::write(staging.join("evidence"), "retain").unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!providers.join("network-tools").exists());
        assert_eq!(
            fs::read_to_string(staging.join("evidence")).unwrap(),
            "retain"
        );
        symlink(&input, providers.join("network-tools")).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(
            providers
                .join("network-tools")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn archives_reject_corruption_aliases_and_public_files() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-network-tools-{}-{}",
            std::process::id(),
            crate::node::now()
        ));
        state::private_directory(&root).unwrap();
        let path = root.join("archive.apk");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        assert_eq!(read_archive(&path, &hash).unwrap(), b"fixture");
        assert!(read_archive(&path, "wrong").is_err());
        let alias = root.join("alias");
        symlink(&path, &alias).unwrap();
        assert!(read_archive(&alias, &hash).is_err());
        std::fs::remove_file(&alias).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(read_archive(&path, &hash).is_err());
        std::fs::remove_file(alias).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_archive(&path, &hash).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
