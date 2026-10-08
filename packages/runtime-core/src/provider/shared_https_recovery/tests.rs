use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    home: PathBuf,
    socket_parent: PathBuf,
    paths: Paths,
    journal: Journal,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
        let _ = fs::remove_dir_all(&self.socket_parent);
    }
}
fn private_dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn executable(path: &Path) -> String {
    fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    https_recovery::executable_hash(path).unwrap()
}
fn fixture(present_socket: bool) -> Fixture {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    let home = PathBuf::from(format!(
        "/private/tmp/hk-shared-recovery-test-{}-{nonce}-{sequence}",
        std::process::id()
    ));
    let socket_parent = PathBuf::from(format!(
        "/private/tmp/hk-https-leases-{}-{nonce}-{sequence}",
        std::process::id()
    ));
    private_dir(&home);
    let storage = home.join("native-https");
    private_dir(&storage);
    let source = storage.join("shared-owner");
    private_dir(&source);
    private_dir(&source.join("leases"));
    let ca_path = storage.join("data/caddy/pki/authorities/local/root.crt");
    private_dir(ca_path.parent().unwrap());
    private_file(&ca_path, b"fixture-ca-unchanged");
    let frontend = home.join("old-frontend");
    let runtime = home.join("old-runtime");
    let caddy = home.join("old-caddy");
    let frontend_sha = executable(&frontend);
    let runtime_sha = executable(&runtime);
    let caddy_sha = executable(&caddy);
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let generation = "a".repeat(32);
    let run = "b".repeat(32);
    let mut lease = Lease {
        version: 1,
        owner_generation: generation.clone(),
        lease_id: String::new(),
        owner: "c".repeat(32),
        run: run.clone(),
        attempt: "d".repeat(32),
        namespace: "e".repeat(64),
        plan_id: "f".repeat(64),
    };
    let config_value = serde_json::json!({
        "version":1,"ownerGeneration":generation,
        "binding": {
            "runtime":{"binary":runtime,"home":home},
            "frontend":{"binary":frontend,"sha256":frontend_sha},
            "runtimeSha256":runtime_sha,
            "pool":{"owner":lease.owner,"bootId":"11111111-1111-1111-1111-111111111111"},
            "caddyBinary":caddy,"caddySha256":caddy_sha,
            "httpsPort":port,"certificateNameLimit":256
        }
    });
    let config: Configuration = serde_json::from_value(config_value.clone()).unwrap();
    lease.lease_id = lease_id(&config, &lease).unwrap();
    private_file(
        &source.join("configuration.json"),
        serde_json::to_string(&config_value).unwrap().as_bytes(),
    );
    private_file(
        &source
            .join("leases")
            .join(format!("{}.json", lease.lease_id)),
        serde_json::to_string(&lease).unwrap().as_bytes(),
    );
    let socket_path = socket_parent.join("control.sock");
    let socket = if present_socket {
        private_dir(&socket_parent);
        let status = Command::new("/usr/bin/python3")
            .arg("-c")
            .arg("import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()")
            .arg(&socket_path)
            .status().unwrap();
        assert!(status.success());
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).unwrap();
        let m = fs::symlink_metadata(&socket_path).unwrap();
        SocketEvidence::Present {
            path: socket_path.clone(),
            parent: dir(&socket_parent).unwrap(),
            socket: inode(&m),
        }
    } else {
        SocketEvidence::Absent {
            path: socket_path.clone(),
        }
    };
    let (dev, ino) = match &socket {
        SocketEvidence::Present { socket, .. } => (socket.dev, socket.ino),
        SocketEvidence::Absent { .. } => (101, 202),
    };
    private_file(
        &source.join("endpoint.json"),
        serde_json::to_string(&serde_json::json!({
            "version":1,"ownerGeneration":generation,"socket":socket_path,"dev":dev,"ino":ino
        }))
        .unwrap()
        .as_bytes(),
    );
    let paths = Paths::new(&home, &generation, &lease.lease_id);
    private_dir(&paths.admission);
    private_file(&paths.admission.join("operation.lock"), b"lock");
    let journal = Journal {
        version: 1,
        run,
        owner_generation: generation,
        lease_id: lease.lease_id.clone(),
        old_boot: config.binding.pool.boot_id,
        current_boot: "22222222-2222-2222-2222-222222222222".into(),
        recovery_process: identity::observe(std::process::id() as i32).unwrap(),
        admission: dir(&paths.admission).unwrap(),
        admission_lock: inode(
            &fs::symlink_metadata(paths.admission.join("operation.lock")).unwrap(),
        ),
        root: dir(&source).unwrap(),
        leases: dir(&source.join("leases")).unwrap(),
        configuration: read_file(&source.join("configuration.json"), MAX_FILE, true)
            .unwrap()
            .1,
        endpoint: read_file(&source.join("endpoint.json"), MAX_FILE, true)
            .unwrap()
            .1,
        lease: read_file(
            &source
                .join("leases")
                .join(format!("{}.json", lease.lease_id)),
            MAX_FILE,
            true,
        )
        .unwrap()
        .1,
        socket,
        ca: read_file(&ca_path, MAX_FILE, false).unwrap().1,
    };
    write_new(&paths.intent, &journal, dir(&paths.storage).unwrap()).unwrap();
    Fixture {
        home,
        socket_parent,
        paths,
        journal,
    }
}

#[test]
fn real_subprocess_socket_and_absent_parent_archive_preserve_exact_bytes_and_inodes() {
    for present_socket in [false, true] {
        let f = fixture(present_socket);
        let old_lease = fs::read(
            f.paths
                .source
                .join("leases")
                .join(format!("{}.json", f.journal.lease_id)),
        )
        .unwrap();
        let old_ca = fs::read(
            f.home
                .join("native-https/data/caddy/pki/authorities/local/root.crt"),
        )
        .unwrap();
        run_archive(
            &f.paths,
            &f.journal,
            dir(&f.paths.storage).unwrap(),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(absent(&f.paths.source).unwrap());
        assert!(!absent(&f.paths.archive).unwrap());
        assert!(!absent(&f.paths.complete).unwrap());
        let (_, _, _, selected_socket) = selected_evidence(&f.paths, &f.journal).unwrap();
        assert_eq!(selected_socket.is_some(), present_socket);
        assert_eq!(dir(&f.paths.archive).unwrap(), f.journal.root);
        assert_eq!(
            fs::read(
                f.paths
                    .archive
                    .join("leases")
                    .join(format!("{}.json", f.journal.lease_id))
            )
            .unwrap(),
            old_lease
        );
        assert_eq!(
            fs::read(
                f.home
                    .join("native-https/data/caddy/pki/authorities/local/root.crt")
            )
            .unwrap(),
            old_ca
        );
        run_archive(
            &f.paths,
            &f.journal,
            dir(&f.paths.storage).unwrap(),
            &mut || Ok(()),
        )
        .unwrap();
    }
}

#[test]
fn interrupted_owner_move_requires_same_selection_and_retains_barrier_for_resume() {
    let f = fixture(false);
    let mut checks = 0;
    assert!(
        run_archive(
            &f.paths,
            &f.journal,
            dir(&f.paths.storage).unwrap(),
            &mut || {
                checks += 1;
                if checks == 3 { Err(refused()) } else { Ok(()) }
            }
        )
        .is_err()
    );
    assert!(absent(&f.paths.source).unwrap());
    assert!(!absent(&f.paths.archive).unwrap());
    assert!(absent(&f.paths.complete).unwrap());
    assert!(!absent(&f.paths.admission).unwrap());
    let mut stale = f.journal.clone();
    stale.current_boot = "33333333-3333-3333-3333-333333333333".into();
    assert!(
        run_archive(
            &f.paths,
            &stale,
            dir(&f.paths.storage).unwrap(),
            &mut || Ok(())
        )
        .is_err()
    );
    assert!(absent(&f.paths.complete).unwrap());
    run_archive(
        &f.paths,
        &f.journal,
        dir(&f.paths.storage).unwrap(),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(!absent(&f.paths.complete).unwrap());
}

#[test]
fn missing_graph_proof_or_partial_socket_never_archives_owner() {
    let f = fixture(false);
    assert!(
        run_archive(
            &f.paths,
            &f.journal,
            dir(&f.paths.storage).unwrap(),
            &mut || Err(refused())
        )
        .is_err()
    );
    assert!(!absent(&f.paths.source).unwrap());
    assert!(absent(&f.paths.archive).unwrap());
    assert!(absent(&f.paths.complete).unwrap());
    private_dir(&f.socket_parent);
    assert!(selected_evidence(&f.paths, &f.journal).is_err());
    assert!(!absent(&f.paths.source).unwrap());
}

#[test]
fn admission_is_private_and_completed_history_cannot_claim_a_foreign_empty_lock() {
    let f = fixture(false);
    fs::remove_file(f.paths.admission.join("operation.lock")).unwrap();
    fs::remove_dir(&f.paths.admission).unwrap();
    let (fresh, admission_id, lock, lock_id) = acquire_admission(&f.paths).unwrap();
    assert!(fresh);
    assert_eq!(dir(&f.paths.admission).unwrap(), admission_id);
    verify_admission(&f.paths, admission_id, lock_id, &lock).unwrap();
    drop(lock);

    private_file(&f.paths.complete, b"old completed archive");
    fs::remove_file(f.paths.admission.join("operation.lock")).unwrap();
    assert!(acquire_admission(&f.paths).is_err());
    assert!(absent(&f.paths.admission.join("operation.lock")).unwrap());
    assert!(!absent(&f.paths.complete).unwrap());
}

#[test]
fn incomplete_intent_cannot_resume_behind_a_recreated_admission() {
    let f = fixture(false);
    fs::remove_file(f.paths.admission.join("operation.lock")).unwrap();
    fs::remove_dir(&f.paths.admission).unwrap();
    let (fresh, admission_id, lock, lock_id) = acquire_admission(&f.paths).unwrap();
    assert!(fresh);
    assert!(verify_journal_admission(&f.journal, fresh, false, admission_id, lock_id).is_err());
    let mut recycled = f.journal.clone();
    recycled.admission = admission_id;
    recycled.admission_lock = lock_id;
    assert!(verify_journal_admission(&recycled, fresh, false, admission_id, lock_id).is_err());
    assert!(absent(&f.paths.archive).unwrap());
    assert!(!absent(&f.paths.source).unwrap());
    // Completed replay can use a new barrier, but only after its separate
    // exact completion, graph, and owner checks in archive().
    verify_journal_admission(&f.journal, fresh, true, admission_id, lock_id).unwrap();
    drop(lock);
}

#[test]
fn same_pid_with_different_birth_refuses_recovery() {
    let f = fixture(false);
    verify_recovery_process(&f.journal).unwrap();
    let mut reused = f.journal.clone();
    reused.recovery_process.start_micros += 1;
    assert!(verify_recovery_process(&reused).is_err());
}

#[test]
fn live_pinned_executable_refuses_quiescence() {
    let f = fixture(false);
    let (bytes, _) = read_file(&f.paths.source.join("configuration.json"), MAX_FILE, true).unwrap();
    let mut config: Configuration = serde_json::from_slice(&bytes).unwrap();
    config.binding.caddy_binary = f.home.join("live-caddy");
    // A copied Apple platform executable can be killed before the scan. Use an
    // owned fixture whose lifetime is witnessed independently of quiescence.
    let source = f.home.join("live-caddy.c");
    fs::write(
        &source,
        b"#include <unistd.h>\nint main(void) { sleep(10); return 0; }\n",
    )
    .unwrap();
    assert!(
        Command::new("cc")
            .args(["-Wall", "-Wextra", "-Werror"])
            .arg(&source)
            .arg("-o")
            .arg(&config.binding.caddy_binary)
            .status()
            .unwrap()
            .success()
    );
    fs::set_permissions(
        &config.binding.caddy_binary,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    config.binding.caddy_sha256 =
        https_recovery::executable_hash(&config.binding.caddy_binary).unwrap();
    let mut child = Command::new(&config.binding.caddy_binary)
        .arg("10")
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let mut live_before = false;
    while std::time::Instant::now() < deadline && child.try_wait().unwrap().is_none() {
        if identity::observe(child.id() as i32).is_ok_and(|observed| {
            observed.executable == config.binding.caddy_binary && observed.start_micros > 0
        }) {
            live_before = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let refusal = prove_quiescence(&config, None);
    let live_after = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(live_before, "owned executable did not become observable");
    assert!(live_after, "owned executable exited during quiescence");
    assert!(refusal.is_err());
}

#[test]
fn replaced_admission_refuses_before_archive_effect() {
    let f = fixture(false);
    let lock = state::Lock::acquire_existing(&f.paths.admission).unwrap();
    let original = dir(&f.paths.admission).unwrap();
    let lock_id = inode(&fs::symlink_metadata(f.paths.admission.join("operation.lock")).unwrap());
    let moved = f.paths.storage.join("replaced-admission-evidence");
    let mut replaced = false;
    let result = run_archive(
        &f.paths,
        &f.journal,
        dir(&f.paths.storage).unwrap(),
        &mut || {
            if !replaced {
                fs::rename(&f.paths.admission, &moved).unwrap();
                private_dir(&f.paths.admission);
                private_file(&f.paths.admission.join("operation.lock"), b"foreign");
                replaced = true;
            }
            verify_admission(&f.paths, original, lock_id, &lock)
        },
    );
    assert!(result.is_err());
    assert!(!absent(&f.paths.source).unwrap());
    assert!(absent(&f.paths.archive).unwrap());
    assert!(absent(&f.paths.complete).unwrap());
    assert_eq!(
        fs::read(f.paths.admission.join("operation.lock")).unwrap(),
        b"foreign"
    );
}

#[test]
fn completed_replay_refuses_when_a_new_shared_owner_has_published() {
    let f = fixture(false);
    run_archive(
        &f.paths,
        &f.journal,
        dir(&f.paths.storage).unwrap(),
        &mut || Ok(()),
    )
    .unwrap();
    let old_archive = dir(&f.paths.archive).unwrap();
    private_dir(&f.paths.source);
    private_file(&f.paths.source.join("new-owner"), b"another app");
    assert!(
        run_archive(
            &f.paths,
            &f.journal,
            dir(&f.paths.storage).unwrap(),
            &mut || Ok(())
        )
        .is_err()
    );
    assert_eq!(dir(&f.paths.archive).unwrap(), old_archive);
    assert_eq!(
        fs::read(f.paths.source.join("new-owner")).unwrap(),
        b"another app"
    );
}
