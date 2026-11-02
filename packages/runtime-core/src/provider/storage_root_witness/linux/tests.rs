//! Real private-filesystem controls only. No Docker/provider paths are touched.
use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, symlink},
    path::{Component, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
struct Private {
    root: PathBuf,
    data: PathBuf,
}
impl Private {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-root-witness-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let data = root.join("_data");
        fs::DirBuilder::new().mode(0o700).create(&data).unwrap();
        Self { root, data }
    }
    fn directory(&self) -> Result<Directory, CandidateError> {
        let components = self
            .data
            .components()
            .filter_map(|part| match part {
                Component::RootDir => None,
                Component::Normal(part) => Some(part.to_str().unwrap()),
                _ => panic!("Canonical private fixture path required"),
            })
            .collect::<Vec<_>>();
        open_components(&components)
    }
    fn request(&self, mode: &str, root: Root) -> Request {
        let bytes = format!(
            "{MAGIC}\n{mode}\nhkp-{}-{}-database\n{}\n{}\n{}\n{}\nuser.hack.storage.{}\n{}\n",
            "a".repeat(64),
            "b".repeat(32),
            root.device,
            root.inode,
            root.uid,
            root.gid,
            "c".repeat(64),
            "01".repeat(32)
        );
        Request::parse(bytes.as_bytes()).unwrap()
    }
}
impl Drop for Private {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Kernel for &Private {
    type Directory = Directory;
    fn open(&mut self, volume: &str) -> Result<Directory, CandidateError> {
        if !volume_valid(volume) {
            return Err(refused());
        }
        self.directory()
    }
    fn check(&mut self, held: &Directory) -> Result<Root, CandidateError> {
        Linux.check(held)
    }
    fn effective_identity(&self) -> (u32, u32) {
        Linux.effective_identity()
    }
    fn create(&mut self, held: &Directory, witness: &Witness) -> Result<(), CandidateError> {
        Linux.create(held, witness)
    }
    fn sync(&mut self, held: &Directory) -> Result<(), CandidateError> {
        Linux.sync(held)
    }
    fn read(&mut self, held: &Directory, witness: &Witness) -> Result<[u8; 32], CandidateError> {
        Linux.read(held, witness)
    }
    fn close(&mut self, held: Directory) -> Result<(), CandidateError> {
        Linux.close(held)
    }
}
fn observed(fixture: &Private) -> Root {
    let held = fixture.directory().unwrap();
    let value = Linux.check(&held).unwrap();
    close(held).unwrap();
    value
}
#[test]
fn real_xattr_create_is_exclusive_fsynced_and_retained_reads_do_not_repair() {
    let fixture = Private::new();
    let root = observed(&fixture);
    assert!(run(fixture.request("verify", root), &mut &fixture).is_err());
    assert_eq!(
        run(fixture.request("seed", root), &mut &fixture)
            .unwrap()
            .encode(),
        "seeded\n"
    );
    let before = fs::symlink_metadata(&fixture.data).unwrap();
    assert_eq!(
        run(fixture.request("verify", root), &mut &fixture)
            .unwrap()
            .encode(),
        "verified\n"
    );
    assert!(run(fixture.request("seed", root), &mut &fixture).is_err());
    let after = fs::symlink_metadata(&fixture.data).unwrap();
    assert_eq!(
        (
            before.ino(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec()
        ),
        (
            after.ino(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec()
        )
    );
    let held = fixture.directory().unwrap();
    let witness = Witness::parse(
        &format!("user.hack.storage.{}", "c".repeat(64)),
        &"01".repeat(32),
    )
    .unwrap();
    let name = name(&witness).unwrap();
    let changed = [2_u8; 32];
    // SAFETY: only this private fixture's retained FD/name and exact32-byte buffer.
    assert_eq!(
        unsafe {
            libc::fsetxattr(
                selected(&held).unwrap().as_raw_fd(),
                name.as_ptr(),
                changed.as_ptr().cast(),
                changed.len(),
                libc::XATTR_REPLACE,
            )
        },
        0
    );
    selected(&held).unwrap().sync_all().unwrap();
    assert!(run(fixture.request("verify", root), &mut &fixture).is_err());
    // SAFETY: removes only the xattr seeded on this exact owned private root FD.
    assert_eq!(
        unsafe { libc::fremovexattr(selected(&held).unwrap().as_raw_fd(), name.as_ptr()) },
        0
    );
    assert!(run(fixture.request("verify", root), &mut &fixture).is_err());
    close(held).unwrap();
}
#[test]
fn retained_fd_path_replacement_and_symlinks_refuse_without_seeding_the_new_root() {
    let fixture = Private::new();
    let root = observed(&fixture);
    run(fixture.request("seed", root), &mut &fixture).unwrap();
    let held = fixture.directory().unwrap();
    let original = fixture.root.join("original");
    fs::rename(&fixture.data, &original).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&fixture.data)
        .unwrap();
    assert!(Linux.check(&held).is_err());
    assert!(run(fixture.request("verify", root), &mut &fixture).is_err());
    let new_root = observed(&fixture);
    assert!(run(fixture.request("verify", new_root), &mut &fixture).is_err());
    fs::remove_dir(&fixture.data).unwrap();
    symlink(&original, &fixture.data).unwrap();
    assert!(fixture.directory().is_err());
    let witness = Witness::parse(
        &format!("user.hack.storage.{}", "c".repeat(64)),
        &"01".repeat(32),
    )
    .unwrap();
    assert_eq!(Linux.read(&held, &witness).unwrap(), [1; 32]);
    close(held).unwrap();
}
