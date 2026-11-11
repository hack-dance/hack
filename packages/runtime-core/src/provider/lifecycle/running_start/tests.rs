use super::*;
use crate::provider::{NetworkIntent, Profile};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// A candidate home with prepared SmolVM and engine trees under the executor's real pins,
/// a guest rootfs copy and a running-pool receipt. The provider process is synthetic: the
/// tree checks never consult it except as the witness key.
struct Home {
    directory: PathBuf,
    candidate: Candidate,
    owner: Owner,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn tree(path: &Path, files: &[(&str, &[u8])]) {
    fs::create_dir_all(path).unwrap();
    for (name, bytes) in files {
        let file = path.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
}

fn record(candidate: &Candidate, name: &str, version: &str, archive: &str, tree: &Path) {
    let path = candidate.state_root.join("providers").join(name);
    let _ = fs::remove_file(&path);
    state::write(
        &path,
        &artifact::Artifact {
            version: version.into(),
            archive_sha256: archive.into(),
            tree_sha256: artifact::rootfs_digest(tree, None).unwrap(),
        },
    )
    .unwrap();
}

fn process(pid: i32) -> identity::ProcessIdentity {
    identity::ProcessIdentity {
        pid,
        start_micros: 1_700_000_000_000_000,
        uid: unsafe { libc::geteuid() },
        executable: PathBuf::from("/fixture/smolvm-bin"),
    }
}

impl Home {
    fn new(name: &str) -> Self {
        let directory = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            &format!("hack-running-start-{name}"),
        );
        let candidate = Candidate::discover(&directory).unwrap();
        state::private_directory(&candidate.state_root.join("providers")).unwrap();
        state::private_directory(&root(&candidate)).unwrap();
        tree(
            &artifact::root(&candidate),
            &[("smolvm-bin", b"provider"), ("lib/libkrun.dylib", b"vmm")],
        );
        tree(
            &artifact::engine_root(&candidate),
            &[("dockerd", b"engine"), ("runc", b"runtime")],
        );
        record(
            &candidate,
            "smolvm.json",
            artifact::VERSION,
            artifact::ARCHIVE_SHA256,
            &artifact::root(&candidate),
        );
        record(
            &candidate,
            "docker.json",
            artifact::ENGINE_VERSION,
            artifact::ENGINE_SHA256,
            &artifact::engine_root(&candidate),
        );
        let mut owner: Owner = serde_json::from_value(json!({
            "version": 1, "checkout": "/fixture", "token": "fixture", "machine": "hack-fixture",
            "short_home": "/fixture-home", "created": true, "phase": "running",
            "process": process(4242), "storage": null, "overlay": null,
            "guest_boot_id": "11111111-1111-1111-1111-111111111111",
            "daemon_pid": null, "daemon_start": null, "rootfs_digest": null
        }))
        .unwrap();
        owner.checkout = candidate.checkout.clone();
        let rootfs = root(&candidate).join("rootfs");
        tree(
            &rootfs,
            &[
                ("sbin/init", b"init"),
                ("usr/local/bin/smolvm-agent", b"agent"),
            ],
        );
        let marker = rootfs_marker(&owner).unwrap();
        owner.rootfs_digest = Some(artifact::rootfs_digest(&rootfs, Some(&marker)).unwrap());
        Self {
            directory,
            candidate,
            owner,
        }
    }

    fn check(&self) -> Result<(), CandidateError> {
        let lease = state::Lock::acquire(&root(&self.candidate)).unwrap();
        verify_trees(&self.candidate, &self.owner, &lease)
    }

    /// Content proofs the check ran: zero means the cheap witness path was taken.
    fn proofs(&self) -> Result<usize, CandidateError> {
        let before = tree_witness::content_proofs();
        self.check()?;
        Ok(tree_witness::content_proofs() - before)
    }

    fn witness(&self) -> Option<tree_witness::Proven> {
        tree_witness::witnessed(
            &self.candidate,
            self.owner.process.as_ref().unwrap(),
            tree_witness::SMOLVM,
        )
    }

    /// Rewrite the SmolVM record's content anchor, as drift or a stale record would.
    fn rewrite_smolvm_anchor(&self) {
        let path = self.candidate.state_root.join("providers/smolvm.json");
        let mut artifact: artifact::Artifact = state::read(&path).unwrap();
        artifact.tree_sha256 = "0".repeat(64);
        fs::remove_file(&path).unwrap();
        state::write(&path, &artifact).unwrap();
    }
}

#[test]
fn a_running_pool_without_a_witness_proves_its_trees_by_content_and_records_one() {
    let home = Home::new("first");
    assert!(home.witness().is_none());
    // SmolVM, engine and rootfs are each proven by content once.
    assert_eq!(home.proofs().unwrap(), 3);
    assert_eq!(
        home.witness().unwrap().metadata,
        artifact::tree_metadata(&home.candidate, &artifact::SMOLVM).unwrap()
    );
    // Later commands of the same provider hash nothing.
    assert_eq!(home.proofs().unwrap(), 0);
    assert_eq!(home.proofs().unwrap(), 0);
}

#[test]
fn a_witness_of_another_provider_process_is_never_trusted() {
    let mut home = Home::new("other-process");
    home.check().unwrap();
    // A new boot has another provider identity: every tree is proven by content again.
    home.owner.process = Some(process(4343));
    assert_eq!(home.proofs().unwrap(), 3);
}

#[test]
fn a_rewritten_content_anchor_sends_the_tree_back_to_a_content_proof() {
    let home = Home::new("anchor");
    home.check().unwrap();
    home.rewrite_smolvm_anchor();
    assert_eq!(home.check().unwrap_err().code, "artifact_digest_mismatch");

    let mut home = Home::new("rootfs-anchor");
    home.check().unwrap();
    home.owner.rootfs_digest = Some("0".repeat(64));
    assert_eq!(home.check().unwrap_err().code, "artifact_digest_mismatch");
}

#[test]
fn a_changed_tree_file_is_caught_by_the_cheap_check_and_proven_by_content() {
    for (label, path) in [
        ("provider", PathBuf::from("lib/libkrun.dylib")),
        ("engine", PathBuf::from("runc")),
    ] {
        let home = Home::new("changed");
        home.check().unwrap();
        let root = if label == "provider" {
            artifact::root(&home.candidate)
        } else {
            artifact::engine_root(&home.candidate)
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join(&path), b"tampered").unwrap();
        assert_eq!(
            home.check().unwrap_err().code,
            "artifact_digest_mismatch",
            "{label}"
        );
    }
    let home = Home::new("rootfs-changed");
    home.check().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(
        root(&home.candidate).join("rootfs/usr/local/bin/smolvm-agent"),
        b"tampered",
    )
    .unwrap();
    assert_eq!(home.check().unwrap_err().code, "artifact_digest_mismatch");
}

#[test]
fn a_metadata_only_change_is_proven_again_and_refreshes_the_witness() {
    let home = Home::new("touched");
    home.check().unwrap();
    let before = home.witness().unwrap();
    let binary = artifact::root(&home.candidate).join("smolvm-bin");
    let mode = fs::metadata(&binary).unwrap().permissions();
    // Coarse ctime clocks need a tick for the change to be visible.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&binary, mode).unwrap();
    // Same bytes and mode, new ctime: only the SmolVM tree is proven again, and passes.
    assert_eq!(home.proofs().unwrap(), 1);
    let after = home.witness().unwrap();
    assert_ne!(after.metadata, before.metadata);
    assert_eq!(after.content, before.content);
    assert_eq!(home.proofs().unwrap(), 0);
}

#[test]
fn a_record_for_another_pin_is_refused_even_with_a_witness() {
    let home = Home::new("pin");
    home.check().unwrap();
    record(
        &home.candidate,
        "smolvm.json",
        "0.9.0",
        artifact::ARCHIVE_SHA256,
        &artifact::root(&home.candidate),
    );
    assert_eq!(home.check().unwrap_err().code, "provider_pin_changed");
}

#[test]
fn the_request_is_checked_against_the_receipt_the_fast_path_holds() {
    let home = Home::new("request");
    let none = StartRequest {
        bridges: super::super::super::bridge::Request::Exact(None),
        network: None,
        dependencies: super::super::super::dependency_socket::Request::Exact(None),
        project_share: None,
        amd64_emulation: false,
    };
    none.check(&home.owner).unwrap();
    // A pool that runs without x86_64 translation refuses a translation request, as the
    // general path does; a pool that runs with it accepts one.
    let translated = StartRequest {
        amd64_emulation: true,
        ..none
    };
    assert_eq!(
        translated.check(&home.owner).unwrap_err().code,
        "amd64_emulation_restart_required"
    );
    let mut owner = home.owner.clone();
    owner.amd64_emulation = true;
    translated.check(&owner).unwrap();
    // A network intent other than the pool's is refused, never applied.
    let internet = NetworkIntent::Internet;
    let other_network = StartRequest {
        network: Some(&internet),
        ..none
    };
    assert!(other_network.check(&home.owner).is_err());
}

#[test]
fn only_a_running_created_pool_of_the_requested_profile_takes_the_fast_path() {
    let home = Home::new("select");
    // No receipt: the general path initializes a pool.
    assert!(
        select(&home.candidate, Profile::Development)
            .unwrap()
            .is_none()
    );
    let mut base = home.owner.clone();
    let disk = identity::DiskIdentity {
        device: 1,
        inode: 1,
        bytes: 4 * 1024 * 1024 * 1024,
        uuid: "00000000-0000-0000-0000-000000000000".into(),
    };
    base.storage = Some(disk.clone());
    base.overlay = Some(disk);
    assert!(eligible(&base, base.profile));
    type Change = fn(&mut Owner);
    let cases: [(&str, Change); 7] = [
        ("stopped", |owner| owner.phase = "stopped".into()),
        ("recovered-unclean", |owner| {
            owner.phase = "recovered-unclean".into()
        }),
        ("booting", |owner| owner.phase = "booting".into()),
        ("not created", |owner| owner.created = false),
        ("no provider", |owner| owner.process = None),
        ("no storage disk", |owner| owner.storage = None),
        ("no overlay disk", |owner| owner.overlay = None),
    ];
    for (label, change) in cases {
        let mut owner = base.clone();
        change(&mut owner);
        assert!(!eligible(&owner, owner.profile), "{label}");
    }
    // A running pool of another profile is the general path's profile conflict.
    base.profile = Profile::Development;
    assert!(!eligible(&base, Profile::Research));
}

/// The live-provider half of selection needs a real process identity (macOS).
#[cfg(target_os = "macos")]
mod live {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use std::process::{Child, Command};

    const GIB: u64 = 1024 * 1024 * 1024;

    struct Live {
        home: Home,
        child: Child,
        alias: PathBuf,
    }

    impl Drop for Live {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if fs::read_link(&self.alias).ok() == Some(root(&self.home.candidate).join("home")) {
                let _ = fs::remove_file(&self.alias);
            }
        }
    }

    fn disk(path: &Path, gib: u64, tag: u8) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.set_len(gib * GIB).unwrap();
        file.seek(SeekFrom::Start(1080)).unwrap();
        file.write_all(&[0x53, 0xef]).unwrap();
        file.seek(SeekFrom::Start(1128)).unwrap();
        file.write_all(&[tag; 16]).unwrap();
    }

    fn running(name: &str) -> Live {
        let home = Home::new(name);
        let binary = artifact::root(&home.candidate).join("smolvm-bin");
        fs::remove_file(&binary).unwrap();
        crate::provider::test_executable::sleeping_executable(&binary);
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let mut owner = Owner::create(
            &home.candidate,
            Profile::Development,
            None,
            NetworkIntent::Isolated,
        )
        .unwrap();
        let alias = owner.short_home.clone();
        let data = owner.real_data_dir(&home.candidate).unwrap();
        state::private_directory(&data).unwrap();
        disk(&data.join("storage.raw"), 32, 1);
        disk(&data.join("overlay.raw"), 10, 2);
        fs::write(data.join("name"), &owner.machine).unwrap();
        let child = Command::new(&binary).arg("120").spawn().unwrap();
        let observed = identity::observe(child.id() as i32).unwrap();
        fs::write(
            data.join("agent.pid"),
            format!("{}\n{}\n", observed.pid, observed.start_micros),
        )
        .unwrap();
        owner.process = Some(observed);
        owner.created = true;
        owner.phase = "running".into();
        owner.guest_boot_id = Some("11111111-1111-1111-1111-111111111111".into());
        owner.storage = Some(identity::disk(&data.join("storage.raw")).unwrap());
        owner.overlay = Some(identity::disk(&data.join("overlay.raw")).unwrap());
        owner.save(&home.candidate).unwrap();
        Live { home, child, alias }
    }

    #[test]
    fn a_live_owned_running_pool_takes_the_fast_path() {
        let live = running("live");
        let selected = select(&live.home.candidate, Profile::Development)
            .unwrap()
            .expect("running pool selected");
        assert_eq!(selected.owner, Owner::load(&live.home.candidate).unwrap());
    }

    #[test]
    fn a_running_pool_whose_provider_belongs_to_another_home_is_refused() {
        let live = running("another-home");
        let other = running("other-home");
        // This home's receipt names the other home's provider: same machine shape, wrong tree.
        let mut owner = Owner::load(&live.home.candidate).unwrap();
        owner.process = Owner::load(&other.home.candidate).unwrap().process;
        owner.save(&live.home.candidate).unwrap();
        assert!(select(&live.home.candidate, Profile::Development).is_err());
    }

    #[test]
    fn a_dead_provider_or_replaced_disk_is_refused() {
        let mut live = running("dead");
        let _ = live.child.kill();
        let _ = live.child.wait();
        assert!(select(&live.home.candidate, Profile::Development).is_err());

        let live = running("disk");
        let data = Owner::load(&live.home.candidate)
            .unwrap()
            .real_data_dir(&live.home.candidate)
            .unwrap();
        fs::remove_file(data.join("storage.raw")).unwrap();
        disk(&data.join("storage.raw"), 32, 9);
        assert!(select(&live.home.candidate, Profile::Development).is_err());
    }

    #[test]
    fn a_resumed_pool_changed_before_the_lease_is_refused() {
        let live = running("changed");
        let selected = select(&live.home.candidate, Profile::Development)
            .unwrap()
            .unwrap();
        let mut owner = Owner::load(&live.home.candidate).unwrap();
        owner.guest_boot_id = Some("22222222-2222-2222-2222-222222222222".into());
        owner.save(&live.home.candidate).unwrap();
        assert_eq!(
            resume(&live.home.candidate, selected, &no_request(), || Ok(()))
                .unwrap_err()
                .code,
            "runtime_changed"
        );
    }

    fn no_request() -> StartRequest<'static> {
        StartRequest {
            bridges: super::super::super::super::bridge::Request::Exact(None),
            network: None,
            dependencies: super::super::super::super::dependency_socket::Request::Exact(None),
            project_share: None,
            amd64_emulation: false,
        }
    }

    #[test]
    fn a_request_the_running_pool_cannot_serve_is_refused_under_the_lease() {
        let live = running("request");
        let selected = select(&live.home.candidate, Profile::Development)
            .unwrap()
            .unwrap();
        let request = StartRequest {
            amd64_emulation: true,
            ..no_request()
        };
        assert_eq!(
            resume(&live.home.candidate, selected, &request, || Ok(()))
                .unwrap_err()
                .code,
            "amd64_emulation_restart_required"
        );
    }
}
