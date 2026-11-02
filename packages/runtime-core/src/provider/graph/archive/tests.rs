use super::*;
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
};

struct Fixture(Candidate);
impl Fixture {
    fn new() -> Self {
        let mut bytes = [0; 16];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-archive-confirm-{token}"));
        state::private_directory(&root).unwrap();
        Self(Candidate::discover(&root).unwrap())
    }
    fn receipt(&self, root: &std::path::Path, phase: &str) {
        state::private_directory(root).unwrap();
        let run = "a".repeat(32);
        state::write(&root.join("state.json"), &json!({
            "version":1,"run":run,"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":phase,"readiness":{},"resources":{"volume:data":{
                "kind":"volume","key":"data","name":format!("hkg-{run}-volume-0"),"id":null,"image":null,"phase":"absent"
            }}
        })).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0.checkout).unwrap();
    }
}

#[test]
fn confirmation_requires_one_location_and_preserves_archived_receipt() {
    let fixture = Fixture::new();
    let run = "a".repeat(32);
    let active = directory(&fixture.0, &run).unwrap();
    let archived = path(&fixture.0, &run).unwrap();
    assert!(confirmation_root(&fixture.0, &run).is_err());
    fixture.receipt(&active, "removed");
    assert_eq!(
        confirmation_root(&fixture.0, &run).unwrap(),
        (active.clone(), false)
    );
    fixture.receipt(&archived, "removed");
    assert!(confirmation_root(&fixture.0, &run).is_err());
    fs::remove_dir_all(&active).unwrap();
    let file = archived.join("state.json");
    let before = fs::read(&file).unwrap();
    let metadata = fs::metadata(&file).unwrap();
    let (receipt, selected) = read_confirmation(&fixture.0, &run, &"b".repeat(32)).unwrap();
    assert_eq!(receipt.phase, "removed");
    assert_eq!(selected, archived);
    assert_eq!(fs::read(&file).unwrap(), before);
    let after = fs::metadata(&file).unwrap();
    assert_eq!(
        (metadata.ino(), metadata.mtime(), metadata.mtime_nsec()),
        (after.ino(), after.mtime(), after.mtime_nsec())
    );
    assert!(read_confirmation(&fixture.0, &run, &"e".repeat(32)).is_err());
    fs::write(archived.join("state.pending"), b"incomplete").unwrap();
    assert!(read_confirmation(&fixture.0, &run, &"b".repeat(32)).is_err());
}

#[test]
fn confirmation_rejects_alias_non_directory_and_nonterminal_archive() {
    let fixture = Fixture::new();
    let run = "a".repeat(32);
    let active = directory(&fixture.0, &run).unwrap();
    let archived = path(&fixture.0, &run).unwrap();
    fixture.receipt(&archived, "stopped-data-retained");
    assert!(read_confirmation(&fixture.0, &run, &"b".repeat(32)).is_err());
    state::private_directory(active.parent().unwrap()).unwrap();
    symlink(&archived, &active).unwrap();
    assert!(confirmation_root(&fixture.0, &run).is_err());
    fs::remove_file(&active).unwrap();
    fs::write(&active, b"not a directory").unwrap();
    assert!(confirmation_root(&fixture.0, &run).is_err());
}

#[test]
fn archived_reconciliation_reads_committed_enrollment_without_promoting_pending() {
    let fixture = Fixture::new();
    let run = "a".repeat(32);
    let owner = "b".repeat(32);
    let active = directory(&fixture.0, &run).unwrap();
    let archived = path(&fixture.0, &run).unwrap();
    fixture.receipt(&archived, "removed");
    assert!(read_reconciliation(&fixture.0, &run, &owner).is_err());
    let file = archived.join("state.json");
    let mut receipt: Receipt = state::read(&file).unwrap();
    receipt.relay_cleanup = Some(cleanup_enrollment::RelayCleanup {
        version: 1,
        runtime: [1; 16],
        boot: [2; 16],
        operation: [3; 16],
        effect: [4; 32],
        control_root: fixture.0.checkout.clone(),
        phase: cleanup_enrollment::Phase::Pending,
    });
    state::write(&file, &receipt).unwrap();
    let pending = archived.join("state.pending");
    fs::write(&pending, b"truncated-not-json").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    let before = fs::read(&file).unwrap();
    let metadata = fs::metadata(&file).unwrap();
    let (loaded, selected) = read_reconciliation(&fixture.0, &run, &owner).unwrap();
    assert_eq!(selected, archived);
    assert_eq!(loaded.phase, "removed");
    assert_eq!(loaded.relay_cleanup, receipt.relay_cleanup);
    assert!(read_confirmation(&fixture.0, &run, &owner).is_err());
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(fs::read(&pending).unwrap(), b"truncated-not-json");
    let after = fs::metadata(&file).unwrap();
    assert_eq!(
        (metadata.ino(), metadata.mtime(), metadata.mtime_nsec()),
        (after.ino(), after.mtime(), after.mtime_nsec())
    );
    assert!(read_reconciliation(&fixture.0, &run, &"e".repeat(32)).is_err());
    fixture.receipt(&active, "removed");
    assert!(read_reconciliation(&fixture.0, &run, &owner).is_err());
    fs::remove_dir_all(&active).unwrap();
    let retained = journal::retain(&archived).unwrap().unwrap();
    assert_eq!(
        fs::read(retained.join("interrupted.pending")).unwrap(),
        b"truncated-not-json"
    );
    receipt.phase = "stopped-data-retained".into();
    state::write(&file, &receipt).unwrap();
    assert!(read_reconciliation(&fixture.0, &run, &owner).is_err());
}
