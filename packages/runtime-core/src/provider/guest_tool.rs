//! One pinned guest artifact and the existing graph startup upload protocol.
//! Caller-supplied digest/provenance is required; no artifact lookup or build occurs.
use crate::CandidateError;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[cfg(feature = "native-config-plan")]
mod lifetime;
#[cfg(feature = "native-config-plan")]
pub(in crate::provider) use lifetime::Lifetime;

pub(in crate::provider) struct Artifact {
    path: PathBuf,
    file: File,
    bytes: Vec<u8>,
    digest: String,
    metadata: fs::Metadata,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "guest_tool_artifact",
        "Guest tool artifact identity changed; values omitted.",
    )
}
impl Artifact {
    pub(in crate::provider) fn read(path: &Path, digest: &str) -> Result<Self, CandidateError> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| refused())?;
        let m = file.metadata().map_err(|_| refused())?;
        // SAFETY: geteuid has no arguments or retained pointers.
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o022 != 0
            || m.len() > 2 * 1024 * 1024
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() as u64 != m.len()
            || format!("{:x}", Sha256::digest(&bytes)) != digest
            || bytes.get(..6) != Some(b"\x7fELF\x02\x01")
            || bytes.get(18..20) != Some(&[183, 0])
        {
            return Err(refused());
        }
        let artifact = Self {
            path: path.into(),
            file,
            bytes,
            digest: digest.into(),
            metadata: m,
        };
        artifact.verify()?;
        Ok(artifact)
    }
    pub(in crate::provider) fn verify(&self) -> Result<(), CandidateError> {
        let fd = self.file.metadata().map_err(|_| refused())?;
        let path = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        let original = &self.metadata;
        if (
            fd.dev(),
            fd.ino(),
            fd.uid(),
            fd.mode(),
            fd.len(),
            fd.nlink(),
        ) != (
            original.dev(),
            original.ino(),
            original.uid(),
            original.mode(),
            original.len(),
            original.nlink(),
        ) || !path.is_file()
            || fd.dev() != path.dev()
            || fd.ino() != path.ino()
            || fd.uid() != path.uid()
            || fd.mode() != path.mode()
            || fd.nlink() != 1
            || fd.len() != self.bytes.len() as u64
            || path.len() != fd.len()
        {
            return Err(refused());
        }
        use std::io::{Seek, SeekFrom};
        let mut file = &self.file;
        file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes != self.bytes || format!("{:x}", Sha256::digest(&bytes)) != self.digest {
            return Err(refused());
        }
        let after = self.file.metadata().map_err(|_| refused())?;
        let path = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        if !path.is_file()
            || (
                after.dev(),
                after.ino(),
                after.len(),
                after.uid(),
                after.mode(),
                after.nlink(),
            ) != (
                fd.dev(),
                fd.ino(),
                fd.len(),
                fd.uid(),
                fd.mode(),
                fd.nlink(),
            )
            || (path.dev(), path.ino(), path.len(), path.mode())
                != (fd.dev(), fd.ino(), fd.len(), fd.mode())
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(in crate::provider) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn digest(&self) -> &str {
        &self.digest
    }
}

pub(in crate::provider) const PREPARE: &str = r#"
umask 077
base=/storage/hack-graph-startup
test ! -L "$base"
if test ! -e "$base"; then mkdir -m 700 "$base"; fi
test "$(stat -c %u:%g:%a "$base")" = 0:0:700
root="$base/$1"
test ! -e "$root"; test ! -L "$root"
mkdir -m 700 "$root"
printf '%s\n' "$2" > "$root/owner"
chmod 444 "$root/owner"
: > "$root/helper.pending"
stat -c %d:%i "$root"
"#;
pub(in crate::provider) const APPEND: &str = r#"
root="/storage/hack-graph-startup/$1"
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/helper.pending"; test -f "$root/helper.pending"
test "$(stat -c %u:%g:%h:%s "$root/helper.pending")" = "0:0:1:$2"
base64 -d >> "$root/helper.pending"
"#;
pub(in crate::provider) const PUBLISH: &str = r#"
root="/storage/hack-graph-startup/$1"
test ! -L "$root"; test ! -L "$root/helper.pending"
test -f "$root/helper.pending"; test "$(stat -c %u:%g:%h "$root/helper.pending")" = 0:0:1
test "$(sha256sum "$root/helper.pending" | cut -d' ' -f1)" = "$2"
test ! -e "$root/helper"; test ! -L "$root/helper"
chmod 555 "$root/helper.pending"; mv "$root/helper.pending" "$root/helper"
sync -f "$root"
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    #[test]
    fn pinned_artifact_refuses_path_replacement_and_mode_or_byte_drift() {
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let path = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "guest-artifact-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        let fixture = Fixture(path);
        let path = fixture.0.join("guest-tool");
        let mut bytes = vec![0_u8; 32];
        bytes[..6].copy_from_slice(b"\x7fELF\x02\x01");
        bytes[18..20].copy_from_slice(&[183, 0]);
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let artifact = Artifact::read(&path, &digest).unwrap();
        assert!(artifact.verify().is_ok());
        for mode in [0o620, 0o602, 0o666] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            let error = Artifact::read(&path, &digest).err().unwrap();
            assert_eq!(error.code, "guest_tool_artifact");
            assert_eq!(
                error.message,
                "Guest tool artifact identity changed; values omitted."
            );
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = fixture.0.join("linked");
        fs::hard_link(&path, &linked).unwrap();
        assert!(Artifact::read(&path, &digest).is_err());
        fs::remove_file(linked).unwrap();
        let symlink = fixture.0.join("symlink");
        std::os::unix::fs::symlink(&path, &symlink).unwrap();
        assert!(Artifact::read(&symlink, &digest).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(artifact.verify().is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(&path, fixture.0.join("original")).unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(artifact.verify().is_err());
        let current = Artifact::read(&path, &digest).unwrap();
        bytes[31] = 1;
        fs::write(&path, &bytes).unwrap();
        assert!(current.verify().is_err());
        assert!(Artifact::read(&path, &digest).is_err());
    }
}
