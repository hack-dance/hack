use super::*;
use crate::provider::{NetworkIntent, Profile, ProjectShareIntent};
use std::{fs::File, os::fd::AsRawFd, path::PathBuf, process::Command};

struct Pool {
    candidate: Candidate,
    owner: Owner,
    directory: PathBuf,
    boot: u64,
}
impl Pool {
    fn new() -> Self {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut process = identity::observe(child.id() as i32).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let boot = process.start_micros + 1;
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hack-device-recovery-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        state::private_directory(&directory).unwrap();
        let candidate = Candidate::discover(&directory).unwrap();
        let operation = state::Lock::acquire(&root(&candidate)).unwrap();
        let project = directory.join("app");
        state::private_directory(&project).unwrap();
        fs::write(project.join("package.json"), b"{}").unwrap();
        let share = ProjectShareIntent::approve(&project, true).unwrap();
        let mut owner = Owner::create_with_project_share(
            &candidate,
            Profile::Development,
            None,
            NetworkIntent::Isolated,
            None,
            Some(share),
        )
        .unwrap();
        let data = owner.real_data_dir(&candidate).unwrap();
        state::private_directory(&data).unwrap();
        for (name, tag) in [("storage.raw", 1u8), ("overlay.raw", 2)] {
            let mut bytes = vec![0; 4096];
            bytes[1080..1082].copy_from_slice(&[0x53, 0xef]);
            bytes[1128..1144].fill(tag);
            bytes[2048..2059].copy_from_slice(b"data-marker");
            fs::write(data.join(name), bytes).unwrap();
        }
        fs::write(data.join("name"), &owner.machine).unwrap();
        fs::write(data.join("vm.lock"), b"").unwrap();
        process.executable = binary(&candidate);
        owner.process = Some(process);
        owner.created = true;
        owner.phase = "running".into();
        let mut storage = identity::disk(&data.join("storage.raw")).unwrap();
        let mut overlay = identity::disk(&data.join("overlay.raw")).unwrap();
        let old = storage.device + 1;
        storage.device = old;
        overlay.device = old;
        owner.storage = Some(storage);
        owner.overlay = Some(overlay);
        owner.project_share.as_mut().unwrap().device = old;
        owner.save(&candidate).unwrap();
        fs::remove_file(&owner.short_home).unwrap();
        drop(operation);
        Self {
            candidate,
            owner,
            directory,
            boot,
        }
    }
    fn data(&self) -> PathBuf {
        self.owner.real_data_dir(&self.candidate).unwrap()
    }
    fn selected(&self) -> Inspection {
        selection(&self.candidate, &self.owner, self.boot)
            .unwrap()
            .0
    }
    fn receipt(&self) -> Vec<u8> {
        fs::read(root(&self.candidate).join("owner.json")).unwrap()
    }
    fn apply(&self, hash: &str) -> Result<Inspection, CandidateError> {
        recover_with_boot(&self.candidate, hash, || Ok(self.boot))
    }
    fn unchanged(&self, before: &[u8]) {
        assert_eq!(self.receipt(), before);
        assert!(self.owner.short_home.symlink_metadata().is_err());
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.owner.short_home);
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn migration_changes_only_devices_and_keeps_alias_graph_history_and_data() {
    let pool = Pool::new();
    let old = pool.receipt();
    let storage = fs::read(pool.data().join("storage.raw")).unwrap();
    let overlay = fs::read(pool.data().join("overlay.raw")).unwrap();
    let history = pool.directory.join("historical-graph.json");
    fs::write(&history, b"historical-source-binding").unwrap();
    let inspected = pool.selected();
    pool.unchanged(&old);
    let result = pool.apply(&inspected.selection_sha256).unwrap();
    assert_eq!(result, inspected);
    let mut expected = pool.owner.clone();
    expected.storage.as_mut().unwrap().device = inspected.new_device;
    expected.overlay.as_mut().unwrap().device = inspected.new_device;
    expected.project_share.as_mut().unwrap().device = inspected.new_device;
    assert_eq!(
        Owner::load_for_short_home_recovery(&pool.candidate).unwrap(),
        expected
    );
    assert!(pool.owner.short_home.symlink_metadata().is_err());
    assert_eq!(fs::read(history).unwrap(), b"historical-source-binding");
    assert_eq!(fs::read(pool.data().join("storage.raw")).unwrap(), storage);
    assert_eq!(fs::read(pool.data().join("overlay.raw")).unwrap(), overlay);
    assert!(pool.apply(&inspected.selection_sha256).is_err());
    // Ordinary recovery still owns HOME restoration and the recovered phase.
    let recovered = crate::provider::recover(&pool.candidate).unwrap();
    assert_eq!(recovered.phase, "recovered-unclean");
    assert_eq!(recovered.process_alive, Some(false));
    assert_eq!(fs::read(pool.data().join("storage.raw")).unwrap(), storage);
}

#[test]
fn disk_and_share_changes_beyond_common_device_refuse_without_writes() {
    for case in 0..7 {
        let mut pool = Pool::new();
        let observed_device = identity::disk(&pool.data().join("storage.raw"))
            .unwrap()
            .device;
        let disk = pool.owner.storage.as_mut().unwrap();
        match case {
            0 => disk.inode += 1,
            1 => disk.bytes += 1,
            2 => disk.uuid.push('0'),
            3 => disk.device = observed_device,
            4 => pool.owner.overlay.as_mut().unwrap().device += 1,
            5 => pool.owner.project_share.as_mut().unwrap().inode += 1,
            _ => pool.owner.project_share.as_mut().unwrap().device += 1,
        }
        pool.owner.save(&pool.candidate).unwrap();
        let before = pool.receipt();
        assert!(pool.apply(&"a".repeat(64)).is_err());
        pool.unchanged(&before);
    }
}

#[test]
fn stale_owner_or_host_boot_selection_refuses() {
    let mut pool = Pool::new();
    let selection = pool.selected();
    assert!(pool.apply(&"a".repeat(64)).is_err());
    pool.owner.phase = "stopped".into();
    pool.owner.save(&pool.candidate).unwrap();
    let before = pool.receipt();
    assert!(pool.apply(&selection.selection_sha256).is_err());
    pool.unchanged(&before);
    let selected = pool.selected();
    assert!(
        recover_with_boot(&pool.candidate, &selected.selection_sha256, || Ok(pool
            .boot
            + 1))
        .is_err()
    );
    pool.unchanged(&before);
}

#[test]
fn same_boot_live_reused_pid_and_unknown_identity_refuse() {
    for case in 0..4 {
        let mut pool = Pool::new();
        if case == 0 {
            pool.boot = pool.owner.process.as_ref().unwrap().start_micros;
        }
        if case == 1 || case == 2 {
            let p = pool.owner.process.as_mut().unwrap();
            p.pid = std::process::id() as i32;
            if case == 1 {
                p.start_micros = identity::observe(p.pid).unwrap().start_micros;
            }
        }
        if case == 3 {
            pool.owner.process = None;
        }
        pool.owner.save(&pool.candidate).unwrap();
        let before = pool.receipt();
        assert!(pool.apply(&"a".repeat(64)).is_err());
        pool.unchanged(&before);
    }
}

#[test]
fn held_operation_vm_lock_and_disk_handles_refuse() {
    for case in 0..3 {
        let pool = Pool::new();
        let selected = pool.selected();
        let before = pool.receipt();
        let _operation =
            (case == 0).then(|| state::Lock::acquire_existing(&root(&pool.candidate)).unwrap());
        let file = if case == 1 {
            Some(File::open(pool.data().join("vm.lock")).unwrap())
        } else if case == 2 {
            Some(File::open(pool.data().join("storage.raw")).unwrap())
        } else {
            None
        };
        if case == 1 {
            assert_eq!(
                unsafe {
                    libc::flock(
                        file.as_ref().unwrap().as_raw_fd(),
                        libc::LOCK_EX | libc::LOCK_NB,
                    )
                },
                0
            );
        }
        assert!(pool.apply(&selected.selection_sha256).is_err());
        pool.unchanged(&before);
    }
}

#[test]
fn pending_foreign_updates_and_prepared_pools_are_preserved() {
    for name in [
        "owner.pending",
        "network-update.json",
        "network-update.pending",
        "prepared-base.json",
        "prepared-base.json.pending",
    ] {
        let pool = Pool::new();
        let selected = pool.selected();
        let before = pool.receipt();
        let path = root(&pool.candidate).join(name);
        fs::write(&path, b"foreign-or-interrupted").unwrap();
        assert!(pool.apply(&selected.selection_sha256).is_err());
        pool.unchanged(&before);
        assert_eq!(fs::read(path).unwrap(), b"foreign-or-interrupted");
    }
}

#[test]
fn foreign_alias_and_source_substitution_refuse() {
    for case in 0..2 {
        let pool = Pool::new();
        let selected = pool.selected();
        let before = pool.receipt();
        if case == 0 {
            fs::write(&pool.owner.short_home, b"foreign").unwrap();
        } else {
            let project = &pool.owner.project_share.as_ref().unwrap().project;
            fs::rename(project, pool.directory.join("preserved-app")).unwrap();
            state::private_directory(project).unwrap();
            fs::write(project.join("package.json"), b"{}").unwrap();
        }
        assert!(pool.apply(&selected.selection_sha256).is_err());
        assert_eq!(pool.receipt(), before);
        if case == 0 {
            assert_eq!(fs::read(&pool.owner.short_home).unwrap(), b"foreign");
        }
    }
}

#[test]
fn final_recheck_rejects_identity_change_before_publication() {
    let pool = Pool::new();
    let selected = pool.selected();
    let before = pool.receipt();
    let called = std::cell::Cell::new(false);
    let result = recover_with_boot(&pool.candidate, &selected.selection_sha256, || {
        if called.replace(true) {
            fs::write(pool.data().join("storage.raw"), b"changed").unwrap();
        }
        Ok(pool.boot)
    });
    assert!(result.is_err());
    pool.unchanged(&before);
    assert_eq!(
        fs::read(pool.data().join("storage.raw")).unwrap(),
        b"changed"
    );
}
