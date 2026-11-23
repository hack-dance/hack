//! Guest/control readiness and exposed-socket binding are independent events.
//! A fake monotonic clock schedules real socket nodes in either order, without a VM.
use super::*;
use crate::provider::process::Clock;
use std::{
    cell::{Cell, RefCell},
    fs,
    os::unix::{
        fs::{MetadataExt, PermissionsExt, symlink},
        net::UnixListener,
    },
    path::PathBuf,
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    listeners: RefCell<Vec<UnixListener>>,
}
impl Fixture {
    fn new() -> Self {
        let root = crate::unique_test_root(&std::env::temp_dir(), "bridge-wait");
        // The provider's socket directory is owned and private; the wait requires it.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            listeners: RefCell::new(Vec::new()),
        }
    }
    fn path(&self, slot: u8) -> PathBuf {
        self.root.join(format!("bridge-{slot:02}.sock"))
    }
    fn bind(&self, slot: u8, mode: u32) {
        self.listeners
            .borrow_mut()
            .push(UnixListener::bind(self.path(slot)).unwrap());
        self.mode(slot, mode);
    }
    fn mode(&self, slot: u8, mode: u32) {
        fs::set_permissions(self.path(slot), fs::Permissions::from_mode(mode)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.listeners.get_mut().clear();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Scheduled<F> {
    elapsed: Cell<Duration>,
    step: RefCell<F>,
}
impl<F> Scheduled<F> {
    fn new(step: F) -> Self {
        Self {
            elapsed: Cell::new(Duration::ZERO),
            step: RefCell::new(step),
        }
    }
}
impl<F: FnMut(Duration)> Clock for Scheduled<F> {
    fn now(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, duration: Duration) {
        self.elapsed.set(self.elapsed.get() + duration);
        (self.step.borrow_mut())(self.elapsed.get());
    }
}
const BUDGET: Duration = Duration::from_millis(200);

#[test]
fn guest_ready_before_all_bridge_binds_waits_for_complete_private_identity() {
    let fixture = Fixture::new();
    let intent = BridgeIntent::new(2).unwrap();
    // The one-shot audit reproduces the old ordering failure: the provider
    // control channel is ready while its expose threads have not yet run.
    assert_eq!(
        verify_sockets(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            intent,
            &mut Vec::new()
        )
        .unwrap_err()
        .code,
        "bridge_socket_identity"
    );
    // The second socket is bound world-accessible, as the provider does once its file
    // sharing has cleared the process umask (HACK-2375): it is repaired, not waited for.
    let clock = Scheduled::new(|elapsed: Duration| match elapsed.as_millis() {
        50 => fixture.bind(0, 0o700),
        100 => fixture.bind(1, 0o777),
        _ => panic!("unexpected wait"),
    });
    wait_for_sockets_with(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        intent,
        || Ok(()),
        &clock,
        BUDGET,
    )
    .unwrap();
    assert_eq!(clock.now(), Duration::from_millis(100));
    assert_eq!(
        fs::symlink_metadata(fixture.path(1)).unwrap().mode() & 0o777,
        0o700
    );
    verify_sockets(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        intent,
        &mut Vec::new(),
    )
    .unwrap();
}

#[test]
fn private_sockets_ready_first_need_no_wait_but_still_verify_the_provider_twice() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o600);
    let clock = Scheduled::new(|_: Duration| panic!("already ready"));
    let checks = Cell::new(0);
    wait_for_sockets_with(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        BridgeIntent::new(1).unwrap(),
        || {
            checks.set(checks.get() + 1);
            Ok(())
        },
        &clock,
        BUDGET,
    )
    .unwrap();
    assert_eq!(checks.get(), 2);
    assert_eq!(clock.now(), Duration::ZERO);
}

#[test]
fn missing_sockets_expire_and_name_recovery() {
    {
        let fixture = Fixture::new();
        let clock = Scheduled::new(|_: Duration| {});
        let failure = wait_for_sockets_with(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            BridgeIntent::new(1).unwrap(),
            || Ok(()),
            &clock,
            BUDGET,
        )
        .unwrap_err();
        assert_eq!(failure.code, "bridge_socket_timeout");
        assert!(failure.message_fixed);
        assert!(failure.message.contains("runtime recover --json"));
        assert!(failure.message.contains("hack native recover"));
        assert_eq!(clock.now(), BUDGET);
        assert!(!fixture.path(0).exists());
    }
}

#[test]
fn unsafe_type_alias_and_link_count_refuse_even_when_an_earlier_slot_is_missing() {
    for kind in ["file", "symlink", "hardlink"] {
        let fixture = Fixture::new();
        match kind {
            "file" => fs::write(fixture.path(1), b"foreign").unwrap(),
            "symlink" => symlink(fixture.root.join("outside"), fixture.path(1)).unwrap(),
            "hardlink" => {
                fixture.bind(1, 0o700);
                fs::hard_link(fixture.path(1), fixture.root.join("another-link")).unwrap();
            }
            _ => unreachable!(),
        }
        let before = fs::symlink_metadata(fixture.path(1)).unwrap();
        let clock = Scheduled::new(|_: Duration| panic!("unsafe identity must not be retried"));
        let failure = wait_for_sockets_with(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            BridgeIntent::new(2).unwrap(),
            || Ok(()),
            &clock,
            BUDGET,
        )
        .unwrap_err();
        assert_eq!(failure.code, "bridge_socket_identity");
        assert!(failure.message_fixed);
        assert!(failure.message.contains("runtime recover --json"));
        let after = fs::symlink_metadata(fixture.path(1)).unwrap();
        assert_eq!(
            (before.dev(), before.ino(), before.mode(), before.nlink()),
            (after.dev(), after.ino(), after.mode(), after.nlink())
        );
        assert_eq!(clock.now(), Duration::ZERO);
    }
}

#[test]
fn another_owner_is_not_pending_private_or_repaired() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o777);
    let directory = private_directory(&fixture.root).unwrap();
    let name = std::ffi::CString::new("bridge-00.sock").unwrap();
    let mut stat = entry(&directory, &name).unwrap().unwrap();
    stat.st_uid = stat.st_uid.wrapping_add(1);
    assert_eq!(
        private_socket(&directory, &name, stat).unwrap_err().code,
        "bridge_socket_identity"
    );
    // Refused before any repair: the socket keeps its mode.
    assert_eq!(
        fs::symlink_metadata(fixture.path(0)).unwrap().mode() & 0o777,
        0o777
    );
}

#[test]
fn an_entry_replaced_after_inspection_is_refused_before_any_mode_change() {
    // Review of #991: a replacement between the inspection and the repair must not be
    // changed. Each case swaps the inspected 0777 socket for something else at the same name.
    for replacement in ["file", "socket", "symlink"] {
        let fixture = Fixture::new();
        fixture.bind(0, 0o777);
        let directory = private_directory(&fixture.root).unwrap();
        let name = std::ffi::CString::new("bridge-00.sock").unwrap();
        let inspected = entry(&directory, &name).unwrap().unwrap();
        fixture.listeners.borrow_mut().clear();
        fs::remove_file(fixture.path(0)).unwrap();
        let target = fixture.root.join("target");
        match replacement {
            "file" => {
                fs::write(fixture.path(0), b"replacement").unwrap();
                fs::set_permissions(fixture.path(0), fs::Permissions::from_mode(0o444)).unwrap();
            }
            "socket" => fixture.bind(0, 0o777),
            _ => {
                fs::write(&target, b"target").unwrap();
                fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
                symlink(&target, fixture.path(0)).unwrap();
            }
        }
        let replaced = fs::symlink_metadata(fixture.path(0)).unwrap();
        let before = replaced.mode();
        // A file system may give the replacement socket the inode just freed. It is then the
        // same device and inode, our socket in our private directory, indistinguishable from
        // the one inspected, and repairing it is the intended outcome.
        let current = entry(&directory, &name).unwrap().unwrap();
        if replacement == "socket"
            && (current.st_dev, current.st_ino) == (inspected.st_dev, inspected.st_ino)
        {
            assert_eq!(
                private_socket(&directory, &name, inspected).unwrap(),
                Mode::Repaired
            );
            assert_eq!(
                fs::symlink_metadata(fixture.path(0)).unwrap().mode() & 0o777,
                0o700
            );
            continue;
        }
        assert_eq!(
            private_socket(&directory, &name, inspected)
                .unwrap_err()
                .code,
            "bridge_socket_identity",
            "{replacement}"
        );
        assert_eq!(
            fs::symlink_metadata(fixture.path(0)).unwrap().mode(),
            before,
            "{replacement}: nothing changed"
        );
        if replacement == "symlink" {
            assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o444);
        }
    }
}

#[test]
fn world_accessible_owned_sockets_in_a_private_directory_are_repaired_to_private() {
    // HACK-2375: a mix of private and 0777 sockets, as the provider leaves them after its
    // file sharing clears the process umask partway through its bind loop.
    let fixture = Fixture::new();
    for slot in 0..4 {
        fixture.bind(slot, if slot == 1 { 0o700 } else { 0o777 });
    }
    let before: Vec<_> = (0..4)
        .map(|slot| fs::symlink_metadata(fixture.path(slot)).unwrap().ino())
        .collect();
    verify_sockets(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        BridgeIntent::new(4).unwrap(),
        &mut Vec::new(),
    )
    .unwrap();
    for slot in 0..4 {
        let after = fs::symlink_metadata(fixture.path(slot)).unwrap();
        assert_eq!(after.mode() & 0o777, 0o700, "slot {slot}");
        assert_eq!(
            after.ino(),
            before[slot as usize],
            "slot {slot} kept its inode"
        );
    }
}

#[test]
fn lease_free_observation_refuses_a_world_accessible_socket_and_changes_nothing() {
    // Review of #991: observation holds no mutation lease, so it never repairs.
    let fixture = Fixture::new();
    fixture.bind(0, 0o700);
    fixture.bind(1, 0o777);
    let intent = BridgeIntent::new(2).unwrap();
    assert_eq!(
        observe_sockets(crate::provider::PoolLayout::Legacy, &fixture.root, intent)
            .unwrap_err()
            .code,
        "bridge_socket_identity"
    );
    assert_eq!(
        fs::symlink_metadata(fixture.path(1)).unwrap().mode() & 0o777,
        0o777
    );
    // A leased audit repairs it, after which observation passes.
    verify_sockets(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        intent,
        &mut Vec::new(),
    )
    .unwrap();
    observe_sockets(crate::provider::PoolLayout::Legacy, &fixture.root, intent).unwrap();
}

#[test]
fn a_socket_directory_that_is_not_private_and_owned_refuses_without_repair() {
    for kind in ["group-readable", "symlink"] {
        let fixture = Fixture::new();
        fixture.bind(0, 0o777);
        let directory = match kind {
            "group-readable" => {
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o750)).unwrap();
                fixture.root.clone()
            }
            _ => {
                let link = fixture.root.join("link");
                symlink(&fixture.root, &link).unwrap();
                link
            }
        };
        assert_eq!(
            verify_sockets(
                crate::provider::PoolLayout::Legacy,
                &directory,
                BridgeIntent::new(1).unwrap(),
                &mut Vec::new()
            )
            .unwrap_err()
            .code,
            "bridge_socket_directory",
            "{kind}"
        );
        assert_eq!(
            fs::symlink_metadata(fixture.path(0)).unwrap().mode() & 0o777,
            0o777,
            "{kind}: nothing repaired"
        );
        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn provider_sockets_are_repaired_when_present_and_refused_when_not_sockets() {
    let fixture = Fixture::new();
    // Absent: left for the code that connects to them.
    let repairs = |root: &std::path::Path| {
        let mut repaired = Vec::new();
        secure_provider_sockets(root, &mut repaired).map(|()| repaired)
    };
    assert!(repairs(&fixture.root).unwrap().is_empty());
    let agent = fixture.root.join("agent.sock");
    let _listener = UnixListener::bind(&agent).unwrap();
    fs::set_permissions(&agent, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(repairs(&fixture.root).unwrap(), ["agent.sock"]);
    assert_eq!(fs::symlink_metadata(&agent).unwrap().mode() & 0o777, 0o700);
    // A second audit finds it private and reports nothing.
    assert!(repairs(&fixture.root).unwrap().is_empty());
    fs::write(fixture.root.join("docker.sock"), b"not a socket").unwrap();
    assert_eq!(
        repairs(&fixture.root).unwrap_err().code,
        "bridge_socket_identity"
    );
}

#[test]
fn every_other_provider_socket_is_repaired_and_reported_and_a_non_socket_is_left_alone() {
    let fixture = Fixture::new();
    let mut listeners = Vec::new();
    // The pinned provider's other sockets, world-accessible as after the umask race.
    for name in OTHER_PROVIDER_SOCKETS {
        let path = fixture.root.join(name);
        listeners.push(UnixListener::bind(&path).unwrap());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
    }
    let mut repaired = Vec::new();
    secure_provider_sockets(&fixture.root, &mut repaired).unwrap();
    repaired.sort();
    let mut expected = OTHER_PROVIDER_SOCKETS.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(repaired, expected);
    for name in OTHER_PROVIDER_SOCKETS {
        let mode = fs::symlink_metadata(fixture.root.join(name))
            .unwrap()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "{name}");
    }
    // Native never connects to these: an entry that is not a socket is neither changed nor
    // a reason to refuse the boot.
    drop(listeners);
    let file = fixture.root.join("port-forward.sock");
    fs::remove_file(&file).unwrap();
    fs::write(&file, b"not a socket").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let mut repaired = Vec::new();
    secure_provider_sockets(&fixture.root, &mut repaired).unwrap();
    assert!(repaired.is_empty());
    assert_eq!(fs::symlink_metadata(&file).unwrap().mode() & 0o777, 0o644);
}

#[test]
fn verification_and_the_boot_wait_report_the_bridge_sockets_they_repaired() {
    let fixture = Fixture::new();
    let intent = BridgeIntent::new(3).unwrap();
    fixture.bind(0, 0o700);
    fixture.bind(1, 0o777);
    fixture.bind(2, 0o770);
    let mut repaired = Vec::new();
    verify_sockets(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        intent,
        &mut repaired,
    )
    .unwrap();
    assert_eq!(repaired, ["bridge-01.sock", "bridge-02.sock"]);
    let mut again = Vec::new();
    verify_sockets(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        intent,
        &mut again,
    )
    .unwrap();
    assert!(again.is_empty());
    // A repair is kept when a later socket of the same observation refuses.
    let fixture = Fixture::new();
    fixture.bind(0, 0o777);
    fs::write(fixture.path(1), b"not a socket").unwrap();
    let mut repaired = Vec::new();
    assert_eq!(
        verify_sockets(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            BridgeIntent::new(2).unwrap(),
            &mut repaired
        )
        .unwrap_err()
        .code,
        "bridge_socket_identity"
    );
    assert_eq!(repaired, ["bridge-00.sock"]);
    let fixture = Fixture::new();
    fs::write(fixture.root.join("agent.sock"), b"not a socket").unwrap();
    let forward = fixture.root.join("port-forward.sock");
    let _forward = UnixListener::bind(&forward).unwrap();
    fs::set_permissions(&forward, fs::Permissions::from_mode(0o777)).unwrap();
    let mut repaired = Vec::new();
    assert!(secure_provider_sockets(&fixture.root, &mut repaired).is_err());
    assert!(
        repaired.is_empty(),
        "agent.sock is checked first and refuses before any repair"
    );
    let fixture = Fixture::new();
    fixture.bind(0, 0o777);
    let clock = Scheduled::new(|_: Duration| panic!("all sockets are present"));
    assert_eq!(
        wait_for_sockets_with(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            BridgeIntent::new(1).unwrap(),
            || Ok(()),
            &clock,
            Duration::from_secs(1),
        )
        .unwrap(),
        ["bridge-00.sock"]
    );
}

#[test]
fn provider_loss_before_or_after_observation_is_not_readiness_or_retry_authority() {
    for fail_on in [1, 2] {
        let fixture = Fixture::new();
        fixture.bind(0, 0o700);
        let checks = Cell::new(0);
        let clock = Scheduled::new(|_: Duration| panic!("provider loss must not be retried"));
        let failure = wait_for_sockets_with(
            crate::provider::PoolLayout::Legacy,
            &fixture.root,
            BridgeIntent::new(1).unwrap(),
            || {
                checks.set(checks.get() + 1);
                if checks.get() == fail_on {
                    Err(CandidateError::new(
                        "process_identity_mismatch",
                        "Provider changed.",
                    ))
                } else {
                    Ok(())
                }
            },
            &clock,
            BUDGET,
        )
        .unwrap_err();
        assert_eq!(failure.code, "process_identity_mismatch");
        assert!(failure.message_fixed);
        assert!(failure.message.contains("runtime recover --json"));
        assert!(failure.message.contains("hack native recover"));
        assert!(!failure.message.contains("Provider changed."));
        assert_eq!(checks.get(), fail_on);
        assert_eq!(clock.now(), Duration::ZERO);
    }
}

#[test]
fn readiness_observed_after_the_deadline_never_counts_as_success() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o700);
    let clock = Scheduled::new(|_: Duration| panic!("no sleep needed"));
    let checks = Cell::new(0);
    let failure = wait_for_sockets_with(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        BridgeIntent::new(1).unwrap(),
        || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                clock.elapsed.set(BUDGET);
            }
            Ok(())
        },
        &clock,
        BUDGET,
    )
    .unwrap_err();
    assert_eq!(failure.code, "bridge_socket_timeout");
    assert!(failure.refusals.and_then(|r| r.bridge_sockets).is_none());
}

#[test]
fn the_boot_budget_grows_with_the_slot_count() {
    assert_eq!(
        boot_socket_budget(BridgeIntent::new(1).unwrap()),
        Duration::from_secs(11)
    );
    // HACK-2341: a 10-slot pool missed the former flat 10 s on a fresh home.
    assert_eq!(
        boot_socket_budget(BridgeIntent::new(10).unwrap()),
        Duration::from_secs(20)
    );
    assert_eq!(
        boot_socket_budget(BridgeIntent::new(32).unwrap()),
        Duration::from_secs(42)
    );
}

#[test]
fn a_timeout_reports_how_many_sockets_were_missing_or_not_private() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o700);
    // A world-accessible socket is repaired, so only the missing one is pending.
    fixture.bind(1, 0o777);
    let clock = Scheduled::new(|_: Duration| {});
    let failure = wait_for_sockets_with(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        BridgeIntent::new(3).unwrap(),
        || Ok(()),
        &clock,
        Duration::from_secs(13),
    )
    .unwrap_err();
    assert_eq!(failure.code, "bridge_socket_timeout");
    assert!(failure.message_fixed);
    let wire = serde_json::to_value(&failure).unwrap();
    assert_eq!(
        wire["bridge_sockets"],
        serde_json::json!({"version":1,"expected":3,"missing":1,"not_private":0,"budget_seconds":13})
    );
    // Counts only: no socket path reaches the diagnostic.
    assert!(!wire.to_string().contains("bridge-0"));
    // A deadline that passed before any observation carries no counts.
    let late = Scheduled::new(|_: Duration| {});
    late.elapsed.set(Duration::from_secs(1));
    let none = wait_for_sockets_with(
        crate::provider::PoolLayout::Legacy,
        &fixture.root,
        BridgeIntent::new(3).unwrap(),
        || {
            late.elapsed.set(Duration::from_secs(5));
            Ok(())
        },
        &late,
        Duration::ZERO,
    )
    .unwrap_err();
    assert!(
        serde_json::to_value(&none)
            .unwrap()
            .get("bridge_sockets")
            .is_none()
    );
}

#[test]
fn compact_bridge_observation_does_not_fall_back_to_the_legacy_socket() {
    let fixture = Fixture::new();
    let intent = BridgeIntent::new(1).unwrap();
    let mut repaired = Vec::new();
    fixture.bind(0, 0o700);
    assert!(
        verify_sockets(
            crate::provider::PoolLayout::CompactV1,
            &fixture.root,
            intent,
            &mut repaired
        )
        .is_err()
    );
    let _compact = std::os::unix::net::UnixListener::bind(fixture.root.join("00")).unwrap();
    verify_sockets(
        crate::provider::PoolLayout::CompactV1,
        &fixture.root,
        intent,
        &mut repaired,
    )
    .unwrap();
}
