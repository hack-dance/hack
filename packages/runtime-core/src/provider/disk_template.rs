//! Integrity of the expanded disk templates SmolVM clones into new machines.
//!
//! SmolVM seeds each new machine's `storage.raw` and `overlay.raw` from the plain
//! `$HOME/.smolvm/{storage,overlay}-template.ext4` files. When they are absent it expands
//! them itself from the adjacent `*.ext4.zst` (copied and digest-checked by
//! `lifecycle::prepare_rootfs`) and reuses the expanded files for every later create. The
//! compressed inputs were verified, but the expanded files that SmolVM actually clones were
//! not, so a corrupt, stale or replaced template would have been copied silently into new
//! disks. This module verifies the expanded content against digests derived from the pinned
//! SmolVM archive ([`super::artifact::ARCHIVE_SHA256`]).
//!
//! Contract:
//! - Integrity comes only from [`content_digest`], a SHA-256 over file content. Holes and
//!   all-zero blocks are elided so the value does not depend on how sparse the file is, but
//!   any changed byte, logical length or block size changes it.
//! - File type, link count, owner, mode and size are ownership and sanity checks that run
//!   first; they are not integrity checks.
//! - Verification never repairs, adopts, moves or deletes anything. A mismatch refuses the
//!   create with `disk_template_untrusted`; SmolVM re-expands a template from the verified
//!   compressed input once the refused file is removed.
//! - Templates matter only when a machine is created, so only the create path verifies them.
//! - Threat model: accidental corruption, interrupted or partial writers and foreign
//!   replacement. A same-user process that swaps content between this check and SmolVM's
//!   clone is out of scope; such a process could equally rewrite the machine disks.
use super::state::io;
use crate::CandidateError;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

/// An expanded template as SmolVM produces it from the pinned archive's `<name>.zst`.
pub(super) struct PinnedTemplate {
    pub name: &'static str,
    pub logical_len: u64,
    pub content_sha256: &'static str,
}

/// Expanded templates of SmolVM 1.14.3 (`ARCHIVE_SHA256` d0c962a0…).
///
/// Derivation: the archive's `storage-template.ext4.zst` (SHA-256 02e08ba0…) and
/// `overlay-template.ext4.zst` (25c0fcb3…) were decoded with an independent zstd decoder
/// and hashed with the [`content_digest`] definition. SmolVM 1.14.3's own expansion of the
/// same inputs produces the same values (`pinned_expansion_matches`, run manually).
/// Re-derive these values whenever the SmolVM archive pin changes;
/// `pinned_templates_track_the_smolvm_archive_pin` fails until then.
pub(super) const PINNED: [PinnedTemplate; 2] = [
    PinnedTemplate {
        name: "storage-template.ext4",
        logical_len: 21_474_836_480,
        content_sha256: "9be5724c9955fda1fbb79518e53de4841ace72424f57f5fc02be1375ab03ca6e",
    },
    PinnedTemplate {
        name: "overlay-template.ext4",
        logical_len: 10_737_418_240,
        content_sha256: "4ba471578185f5ccb967647416b613dcee6fc409fdef2f8b1bea8fbb18e3b37e",
    },
];

const DOMAIN: &[u8] = b"hack.disk-template.content.v1\0";
const BLOCK: u64 = 4096;
/// Bound on bytes read while hashing. A SmolVM expansion of the pinned templates allocates
/// roughly 20 MiB per file; a file whose allocated extents exceed this is refused rather
/// than read, so a dense or foreign file cannot make verification unbounded.
const MAX_ALLOCATED_READ: u64 = 256 * 1024 * 1024;
/// Remedy once SmolVM has already created a machine from the refused template. The caller
/// leaves the create phase unfinished, as for a failed create, so nothing is adopted.
const AFTER_CREATE: &str =
    "No file was changed. The machine SmolVM created was not adopted and needs manual recovery.";

/// When the create path verifies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    /// Before `machine create`: verify templates SmolVM would reuse. Missing ones are
    /// allowed because SmolVM expands them from the verified compressed input during create.
    BeforeCreate,
    /// After `machine create`: every template must exist in the verified directory, which
    /// also shows that SmolVM did not clone from a fallback expansion location.
    AfterCreate,
}

/// Verify the expanded templates in `dir` (the provider `$HOME/.smolvm`) for `stage`.
pub(super) fn verify_expanded(dir: &Path, stage: Stage) -> Result<(), CandidateError> {
    verify_with(dir, stage, &PINNED, MAX_ALLOCATED_READ)
}

fn verify_with(
    dir: &Path,
    stage: Stage,
    pinned: &[PinnedTemplate],
    max_read: u64,
) -> Result<(), CandidateError> {
    for template in pinned {
        let path = dir.join(template.name);
        let before = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if stage == Stage::AfterCreate {
                    return Err(CandidateError::new(
                        "disk_template_untrusted",
                        format!(
                            "Expanded disk template {} is missing after create; SmolVM did not clone a verifiable template. {AFTER_CREATE}",
                            template.name
                        ),
                    ));
                }
                continue;
            }
            Err(error) => return Err(io(error)),
        };
        let refuse = |reason: &str| {
            let remedy = match stage {
                Stage::BeforeCreate => {
                    "No file was changed; remove it so SmolVM re-expands it from the verified compressed template."
                }
                Stage::AfterCreate => AFTER_CREATE,
            };
            CandidateError::new(
                "disk_template_untrusted",
                format!(
                    "Expanded disk template {} {reason}. {remedy}",
                    template.name
                ),
            )
        };
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if !before.file_type().is_file() {
            return Err(refuse("is not a regular file"));
        }
        if before.nlink() != 1 {
            return Err(refuse("is hard-linked"));
        }
        if before.uid() != euid {
            return Err(refuse("is not owned by the candidate user"));
        }
        if before.mode() & 0o022 != 0 {
            return Err(refuse("is group- or world-writable"));
        }
        if before.len() != template.logical_len {
            return Err(refuse("has an unexpected size"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(io)?;
        let opened = file.metadata().map_err(io)?;
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return Err(refuse("changed while it was being verified"));
        }
        match content_digest(&file, template.logical_len, max_read)? {
            Some(digest) if digest == template.content_sha256 => {}
            Some(_) => return Err(refuse("content differs from the pinned SmolVM template")),
            None => {
                return Err(refuse(
                    "has more allocated data than a SmolVM expansion; it was not read",
                ));
            }
        }
    }
    Ok(())
}

/// Content digest of the first `len` bytes of `file`:
/// `SHA-256(DOMAIN || u64le(BLOCK) || u64le(len) || for each BLOCK-sized block containing a
/// non-zero byte: u64le(index) || block bytes)`; the final block may be shorter than BLOCK.
///
/// Only data extents are read (`SEEK_DATA`/`SEEK_HOLE`), because holes read as zero. Returns
/// `None` once more than `max_read` bytes would be read.
fn content_digest(file: &File, len: u64, max_read: u64) -> Result<Option<String>, CandidateError> {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(BLOCK.to_le_bytes());
    hasher.update(len.to_le_bytes());
    let mut block = vec![0u8; BLOCK as usize];
    let mut next_block = 0u64;
    let mut read = 0u64;
    let mut offset = 0u64;
    while offset < len {
        let Some((start, end)) = next_data(file, offset, len)? else {
            break;
        };
        let first = (start / BLOCK).max(next_block);
        let last = (end - 1) / BLOCK;
        for index in first..=last {
            let at = index * BLOCK;
            let size = (len - at).min(BLOCK) as usize;
            read += size as u64;
            if read > max_read {
                return Ok(None);
            }
            let bytes = &mut block[..size];
            file.read_exact_at(bytes, at).map_err(io)?;
            if bytes.iter().any(|&byte| byte != 0) {
                hasher.update(index.to_le_bytes());
                hasher.update(&*bytes);
            }
        }
        next_block = last + 1;
        offset = next_block.saturating_mul(BLOCK);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

/// The next data extent at or after `offset`, clamped to `len`, or `None` when only holes
/// remain. A filesystem without `SEEK_DATA` support reports the rest of the file as data,
/// which is correct but reads every byte (and so meets the `max_read` bound sooner).
fn next_data(file: &File, offset: u64, len: u64) -> Result<Option<(u64, u64)>, CandidateError> {
    let fd = file.as_raw_fd();
    let seek = |position: u64, whence: libc::c_int| {
        let position = libc::off_t::try_from(position).map_err(|_| {
            CandidateError::new("disk_template_untrusted", "Template offset overflow.")
        })?;
        // SAFETY: `fd` stays open for this call because `file` is borrowed. lseek only moves
        // this descriptor's offset; content reads use positional `read_exact_at`, so no
        // other reader depends on that offset.
        Ok::<_, CandidateError>(unsafe { libc::lseek(fd, position, whence) })
    };
    let start = seek(offset, libc::SEEK_DATA)?;
    if start < 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENXIO) => Ok(None),
            Some(libc::EINVAL | libc::ENOTSUP) => Ok(Some((offset, len))),
            _ => Err(io(error)),
        };
    }
    let start = start as u64;
    if start >= len {
        return Ok(None);
    }
    let end = seek(start, libc::SEEK_HOLE)?;
    if end < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    // Guarantee progress even if a filesystem reports an empty extent.
    Ok(Some((start, (end as u64).clamp(start + 1, len))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    type Setup = fn(&Fixture);
    impl Fixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "hack-disk-template-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
        /// Write a sparse file: only `extents` are written, the rest stays a hole.
        fn sparse(&self, name: &str, len: u64, extents: &[(u64, &[u8])]) -> PathBuf {
            let path = self.0.join(name);
            let mut file = File::create(&path).unwrap();
            for (at, bytes) in extents {
                file.write_all_at(bytes, *at).unwrap();
            }
            file.set_len(len).unwrap();
            file.flush().unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Reference definition over the full byte content, independent of file layout.
    fn reference(content: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN);
        hasher.update(BLOCK.to_le_bytes());
        hasher.update((content.len() as u64).to_le_bytes());
        for (index, chunk) in content.chunks(BLOCK as usize).enumerate() {
            if chunk.iter().any(|&byte| byte != 0) {
                hasher.update((index as u64).to_le_bytes());
                hasher.update(chunk);
            }
        }
        format!("{:x}", hasher.finalize())
    }

    fn digest_of(path: &Path) -> String {
        let file = File::open(path).unwrap();
        let len = file.metadata().unwrap().len();
        content_digest(&file, len, u64::MAX).unwrap().unwrap()
    }

    fn pinned_for(name: &'static str, content: &[u8]) -> PinnedTemplate {
        PinnedTemplate {
            name,
            logical_len: content.len() as u64,
            content_sha256: Box::leak(reference(content).into_boxed_str()),
        }
    }

    const LEN: u64 = 3 * 1024 * 1024 + 1000;

    fn content_with(extents: &[(u64, &[u8])]) -> Vec<u8> {
        let mut content = vec![0u8; LEN as usize];
        for (at, bytes) in extents {
            content[*at as usize..*at as usize + bytes.len()].copy_from_slice(bytes);
        }
        content
    }

    #[test]
    fn extent_digest_matches_full_content_reference_for_any_layout() {
        let fixture = Fixture::new("layout");
        let extents: &[(u64, &[u8])] = &[
            (0, b"superblock"),
            (
                4096 * 7 + 13,
                b"unaligned write across a block boundary ..................",
            ),
            (2 * 1024 * 1024, &[0u8; 8192]),
            (LEN - 3, b"end"),
        ];
        let content = content_with(extents);
        let sparse = fixture.sparse("sparse", LEN, extents);
        let dense = fixture.sparse("dense", LEN, &[(0, &content)]);
        assert_eq!(digest_of(&sparse), reference(&content));
        assert_eq!(digest_of(&dense), reference(&content));
    }

    #[test]
    fn digest_changes_for_any_content_or_length_change() {
        let fixture = Fixture::new("change");
        let base = fixture.sparse("base", LEN, &[(4096, b"data")]);
        let flipped = fixture.sparse("flipped", LEN, &[(4096, b"dbta")]);
        let hole_written = fixture.sparse("hole", LEN, &[(4096, b"data"), (2_000_000, b"x")]);
        let longer = fixture.sparse("longer", LEN + BLOCK, &[(4096, b"data")]);
        let digests = [&base, &flipped, &hole_written, &longer].map(|path| digest_of(path));
        for (i, left) in digests.iter().enumerate() {
            for right in &digests[i + 1..] {
                assert_ne!(left, right);
            }
        }
    }

    #[test]
    fn verified_template_is_reused_and_metadata_changes_are_not_integrity() {
        let fixture = Fixture::new("reuse");
        let extents: &[(u64, &[u8])] = &[(0, b"ext4"), (8192, b"journal")];
        let path = fixture.sparse("storage-template.ext4", LEN, extents);
        let pinned = [pinned_for("storage-template.ext4", &content_with(extents))];
        verify_with(&fixture.0, Stage::BeforeCreate, &pinned, MAX_ALLOCATED_READ).unwrap();
        // A later create reuses the same file; touching it changes metadata, not content.
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH)
            .unwrap();
        verify_with(&fixture.0, Stage::AfterCreate, &pinned, MAX_ALLOCATED_READ).unwrap();
    }

    #[test]
    fn corrupt_template_is_refused_and_left_untouched() {
        let fixture = Fixture::new("corrupt");
        let good: &[(u64, &[u8])] = &[(0, b"ext4"), (8192, b"journal")];
        let pinned = [pinned_for("storage-template.ext4", &content_with(good))];
        let path = fixture.sparse(
            "storage-template.ext4",
            LEN,
            &[(0, b"ext4"), (8192, b"journaL")],
        );
        let before = (
            fs::read(&path).unwrap(),
            fs::metadata(&path).unwrap().modified().unwrap(),
        );
        for (stage, remedy) in [
            (Stage::BeforeCreate, "re-expands it"),
            (Stage::AfterCreate, "not adopted and needs manual recovery"),
        ] {
            let error = verify_with(&fixture.0, stage, &pinned, MAX_ALLOCATED_READ).unwrap_err();
            assert_eq!(error.code, "disk_template_untrusted");
            assert!(
                error.message.contains("content differs") && error.message.contains(remedy),
                "{}",
                error.message
            );
        }
        assert_eq!(
            before,
            (
                fs::read(&path).unwrap(),
                fs::metadata(&path).unwrap().modified().unwrap()
            )
        );
        let entries: Vec<_> = fs::read_dir(&fixture.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, ["storage-template.ext4"]);
    }

    #[test]
    fn shape_and_ownership_refusals_happen_before_hashing() {
        let content = content_with(&[(0, b"ext4")]);
        let pinned = [pinned_for("storage-template.ext4", &content)];
        // A zero read bound would refuse any hashed file with the allocation message, so
        // each expected message proves the refusal came before hashing.
        let cases: [(&str, Setup); 4] = [
            ("is not a regular file", |f| {
                let target = f.sparse("elsewhere", LEN, &[(0, b"ext4")]);
                std::os::unix::fs::symlink(target, f.0.join("storage-template.ext4")).unwrap();
            }),
            ("is hard-linked", |f| {
                let path = f.sparse("storage-template.ext4", LEN, &[(0, b"ext4")]);
                fs::hard_link(path, f.0.join("second-link")).unwrap();
            }),
            ("is group- or world-writable", |f| {
                let path = f.sparse("storage-template.ext4", LEN, &[(0, b"ext4")]);
                fs::set_permissions(path, fs::Permissions::from_mode(0o666)).unwrap();
            }),
            ("has an unexpected size", |f| {
                f.sparse("storage-template.ext4", LEN - 1, &[(0, b"ext4")]);
            }),
        ];
        for (expected, setup) in cases {
            let fixture = Fixture::new("shape");
            setup(&fixture);
            let error = verify_with(&fixture.0, Stage::BeforeCreate, &pinned, 0).unwrap_err();
            assert_eq!(error.code, "disk_template_untrusted");
            assert!(
                error.message.contains(expected),
                "{expected}: {}",
                error.message
            );
        }
    }

    #[test]
    fn interrupted_expansion_is_neither_adopted_nor_removed() {
        let fixture = Fixture::new("interrupted");
        let content = content_with(&[(0, b"ext4")]);
        let pinned = [pinned_for("storage-template.ext4", &content)];
        // SmolVM expands into `<stem>.partial` and renames only on success; after an
        // interruption only the compressed input and the scratch file can remain.
        let partial = fixture.sparse("storage-template.partial", LEN / 2, &[(0, b"ext4")]);
        fixture.sparse("storage-template.ext4.zst", 16, &[(0, b"compressed")]);
        verify_with(&fixture.0, Stage::BeforeCreate, &pinned, MAX_ALLOCATED_READ).unwrap();
        let error =
            verify_with(&fixture.0, Stage::AfterCreate, &pinned, MAX_ALLOCATED_READ).unwrap_err();
        assert_eq!(error.code, "disk_template_untrusted");
        assert!(
            error.message.contains("missing after create") && error.message.contains("not adopted"),
            "{}",
            error.message
        );
        assert!(partial.exists());
    }

    #[test]
    fn allocated_data_beyond_the_bound_is_refused_without_reading_it() {
        let fixture = Fixture::new("bound");
        let content = content_with(&[(0, &[1u8; 64 * 1024])]);
        let pinned = [pinned_for("storage-template.ext4", &content)];
        fixture.sparse("storage-template.ext4", LEN, &[(0, &[1u8; 64 * 1024])]);
        let error = verify_with(&fixture.0, Stage::BeforeCreate, &pinned, 32 * 1024).unwrap_err();
        assert!(
            error.message.contains("more allocated data"),
            "{}",
            error.message
        );
        verify_with(&fixture.0, Stage::BeforeCreate, &pinned, MAX_ALLOCATED_READ).unwrap();
    }

    #[test]
    fn pinned_templates_track_the_smolvm_archive_pin() {
        // The archive `PINNED` was derived from. A stale pin would refuse every create; fail
        // here instead, where the fix is named.
        assert_eq!(
            "d0c962a017fe07a1b58c1437b16e6a2320c00d8a7cae739882103b871ef7af0f",
            super::super::artifact::ARCHIVE_SHA256,
            "SmolVM archive pin changed: re-derive disk_template::PINNED"
        );
    }

    /// Manual: point `HACK_LOCAL_EXPANDED_TEMPLATE_DIR` at a `.smolvm` directory in which
    /// SmolVM 1.14.3 expanded the pinned archive's templates.
    #[test]
    #[ignore = "Manual: requires templates expanded by pinned SmolVM 1.14.3"]
    fn pinned_expansion_matches() {
        let dir =
            std::env::var("HACK_LOCAL_EXPANDED_TEMPLATE_DIR").expect("expanded template directory");
        verify_expanded(Path::new(&dir), Stage::AfterCreate).unwrap();
    }
}
