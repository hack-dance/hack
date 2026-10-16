//! Pinned guest-only networking dependencies, installed before Docker discovers capabilities.
use super::{source_sync, state};
use crate::{Candidate, CandidateError};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
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
