use super::*;
use std::{
    cell::Cell,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::PermissionsExt, net::UnixListener},
    },
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = base.join(format!(
            "hk-qd-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn journal(&self) -> PathBuf {
        self.0.join("journal")
    }
    fn scope(&self) -> Scope {
        Scope {
            version: 1,
            quiescence_sha256: "a".repeat(64),
            slots: 2,
        }
    }
    fn bind(&self, slot: u8) -> UnixListener {
        let target = path(&self.0, slot);
        let listener = UnixListener::bind(&target).unwrap();
        fs::set_permissions(target, fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }
    fn stale(&self, slot: u8) {
        drop(self.unlistened(slot));
    }
    fn unlistened(&self, slot: u8) -> OwnedFd {
        // A stale fixture needs a bound stream inode, never a transient listener.
        // It stays unlistened even if a concurrent child inherits a descriptor.
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(fd >= 0);
        let socket = unsafe { OwnedFd::from_raw_fd(fd) };
        assert_eq!(
            unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
        let target = path(&self.0, slot);
        let bytes = target.as_os_str().as_bytes();
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        assert!(!bytes.contains(&0) && bytes.len() < address.sun_path.len());
        for (destination, byte) in address.sun_path.iter_mut().zip(bytes) {
            *destination = *byte as libc::c_char;
        }
        let length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
        #[cfg(target_vendor = "apple")]
        {
            address.sun_len = length.try_into().unwrap();
        }
        assert_eq!(
            unsafe {
                libc::bind(
                    socket.as_raw_fd(),
                    (&raw const address).cast(),
                    length.try_into().unwrap(),
                )
            },
            0
        );
        fs::set_permissions(target, fs::Permissions::from_mode(0o600)).unwrap();
        socket
    }
    fn selection(&self) -> Selection {
        super::super::recovery::observation_diagnostic::clear();
        current(self.scope(), &self.0).unwrap_or_else(|error| {
            panic!(
                "Synthetic quiescent selection refused: code={}; closed_first_observation={}",
                error.code,
                super::super::recovery::observation_diagnostic::take()
                    .map(|facts| serde_json::to_string(&facts).unwrap())
                    .unwrap_or_else(|| "null".into())
            )
        })
    }
    fn hash(&self) -> String {
        digest(&self.selection()).unwrap()
    }
    fn recover(&self, hash: &str) -> Result<Value, CandidateError> {
        recover_scope(&self.journal(), &self.scope(), &self.0, hash, || Ok(()))
    }
}

#[test]
fn stale_stream_inode_never_listens_even_while_an_owned_duplicate_survives() {
    let fixture = Fixture::new();
    let original = fixture.unlistened(0);
    let duplicate = original.try_clone().unwrap();
    drop(original);
    let selected = observed(&fixture.0, 0).unwrap().unwrap();
    let error = std::os::unix::net::UnixStream::connect(path(&fixture.0, 0)).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::ECONNREFUSED));
    assert!(path(&fixture.0, 0).exists());
    drop(duplicate);
    assert_eq!(observed(&fixture.0, 0).unwrap(), Some(selected));
}

#[test]
fn first_socket_refusal_records_closed_live_listener_facts_without_removal() {
    use super::super::recovery::observation_diagnostic as diagnostic;
    let fixture = Fixture::new();
    let listener = fixture.bind(0);
    diagnostic::clear();
    assert!(observed(&fixture.0, 0).is_err());
    let facts = diagnostic::take().unwrap();
    assert_eq!(facts["stage"], "socket-connect");
    assert!(facts["errno"].is_null());
    assert_eq!(facts["metadata"]["type"], "socket");
    assert_eq!(facts["metadata"]["mode"].as_u64().unwrap() & 0o7777, 0o600);
    assert_eq!(facts["metadata"]["nlink"], 1);
    assert!(facts["metadata"]["inode"].as_u64().unwrap() > 0);
    let text = serde_json::to_string(&facts).unwrap();
    assert!(text.len() < 512);
    assert!(!text.contains(fixture.0.to_str().unwrap()));
    assert!(path(&fixture.0, 0).exists());
    drop(listener);
    assert!(observed(&fixture.0, 0).unwrap().is_some());
}

#[test]
fn first_socket_refusal_precedes_later_facts_and_clear_starts_a_fresh_observation() {
    use super::super::recovery::observation_diagnostic as diagnostic;
    let fixture = Fixture::new();
    let listener = fixture.bind(0);
    fs::set_permissions(path(&fixture.0, 0), fs::Permissions::from_mode(0o644)).unwrap();
    diagnostic::clear();
    assert!(observed(&fixture.0, 0).is_err());
    diagnostic::record(diagnostic::Stage::MetadataRead, None, Some(libc::EACCES));
    let first = diagnostic::take().unwrap();
    assert_eq!(first["stage"], "socket-metadata");
    assert_eq!(first["metadata"]["mode"].as_u64().unwrap() & 0o7777, 0o644);
    assert!(first["errno"].is_null());
    diagnostic::clear();
    assert!(diagnostic::take().is_none());
    diagnostic::record(diagnostic::Stage::MetadataRead, None, Some(libc::EACCES));
    assert_eq!(
        diagnostic::take().unwrap(),
        json!({"stage":"metadata-read","errno":libc::EACCES,"metadata":null})
    );
    assert!(path(&fixture.0, 0).exists());
    drop(listener);
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn selected_recovery_journals_before_unlink_and_is_idempotent() {
    let fixture = Fixture::new();
    fixture.stale(0);
    fixture.stale(1);
    fs::write(fixture.0.join("retained-data"), b"unchanged").unwrap();
    let hash = fixture.hash();
    assert_eq!(fixture.recover(&hash).unwrap()["removed"], 2);
    let receipt = fixture.journal().join(format!("{hash}.json"));
    let bytes = fs::read(&receipt).unwrap();
    let retry = fixture.recover(&hash).unwrap();
    assert_eq!(retry["removed"], 0);
    assert_eq!(retry["already_absent"], 2);
    assert_eq!(fs::read(receipt).unwrap(), bytes);
    assert_eq!(
        fs::read(fixture.0.join("retained-data")).unwrap(),
        b"unchanged"
    );
    assert_eq!(
        inspect_scope(&fixture.journal(), &fixture.scope(), &fixture.0).unwrap()["recoverable"],
        false
    );
}

#[test]
fn proof_drift_between_unlinks_stops_and_resumes_only_exact_remaining_inodes() {
    let fixture = Fixture::new();
    fixture.stale(0);
    fixture.stale(1);
    let hash = fixture.hash();
    let calls = Cell::new(0);
    let result = recover_scope(
        &fixture.journal(),
        &fixture.scope(),
        &fixture.0,
        &hash,
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 4 {
                Err(refused())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    assert!(!path(&fixture.0, 0).exists());
    assert!(path(&fixture.0, 1).exists());
    let selected = inspect_scope(&fixture.journal(), &fixture.scope(), &fixture.0).unwrap();
    assert_eq!(selected["sha256"], hash);
    assert_eq!(selected["remaining"], 1);
    assert_eq!(selected["resumable"], true);
    assert_eq!(fixture.recover(&hash).unwrap()["removed"], 1);
}

#[test]
fn owner_graph_boot_or_volume_proof_drift_refuses_before_any_effect() {
    let fixture = Fixture::new();
    fixture.stale(0);
    let hash = fixture.hash();
    let selected = fixture.selection();
    let changed = Scope {
        quiescence_sha256: "b".repeat(64),
        ..fixture.scope()
    };
    assert!(recover_scope(&fixture.journal(), &changed, &fixture.0, &hash, || Ok(())).is_err());
    assert!(
        recover_scope(
            &fixture.journal(),
            &fixture.scope(),
            &fixture.0,
            &hash,
            || Err(refused())
        )
        .is_err()
    );
    assert_eq!(fixture.selection(), selected);
    assert!(!fixture.journal().exists());
}

#[test]
fn live_listener_and_foreign_replacement_are_never_removed() {
    let fixture = Fixture::new();
    let listener = fixture.bind(0);
    assert!(current(fixture.scope(), &fixture.0).is_err());
    drop(listener);
    let hash = fixture.hash();
    fs::rename(path(&fixture.0, 0), fixture.0.join("original.sock")).unwrap();
    fixture.stale(0);
    assert!(fixture.recover(&hash).is_err());
    assert!(path(&fixture.0, 0).exists());
    fs::remove_file(path(&fixture.0, 0)).unwrap();
    fs::write(path(&fixture.0, 0), b"foreign").unwrap();
    assert!(fixture.recover(&hash).is_err());
    assert_eq!(fs::read(path(&fixture.0, 0)).unwrap(), b"foreign");
}

#[test]
fn an_unselected_socket_or_pending_journal_blocks_retry() {
    let fixture = Fixture::new();
    fixture.stale(0);
    let hash = fixture.hash();
    state::private_directory(&fixture.journal()).unwrap();
    state::write(
        &fixture.journal().join(format!("{hash}.json")),
        &fixture.selection(),
    )
    .unwrap();
    fixture.stale(1);
    assert!(fixture.recover(&hash).is_err());
    assert!(path(&fixture.0, 0).exists());
    assert!(path(&fixture.0, 1).exists());
    fs::remove_file(path(&fixture.0, 1)).unwrap();
    let pending = fixture
        .journal()
        .join(format!("{}.pending", "c".repeat(64)));
    fs::write(&pending, b"uncommitted").unwrap();
    assert!(fixture.recover(&hash).is_err());
    assert_eq!(fs::read(pending).unwrap(), b"uncommitted");
    assert!(path(&fixture.0, 0).exists());
}

#[test]
fn malformed_selection_and_stopped_pool_schema_cannot_authorize_live_recovery() {
    let fixture = Fixture::new();
    fixture.stale(0);
    let selected = fixture.selection();
    for sockets in [
        vec![selected.sockets[0].clone(), selected.sockets[0].clone()],
        vec![],
    ] {
        assert!(
            matching(
                &Selection {
                    sockets,
                    ..selected.clone()
                },
                &fixture.scope(),
                &fixture.0
            )
            .is_err()
        );
    }
    assert!(
        serde_json::from_value::<Selection>(
            json!({"version":1,"owner":"a","boot":"b","sockets":[]})
        )
        .is_err()
    );
    assert!(fixture.recover("not-a-sha256").is_err());
    assert!(fixture.recover(&"0".repeat(64)).is_err());
    assert!(path(&fixture.0, 0).exists());
}
