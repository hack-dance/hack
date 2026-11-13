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
        Self {
            root: crate::unique_test_root(&std::env::temp_dir(), "bridge-wait"),
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
        verify_sockets(&fixture.root, intent).unwrap_err().code,
        "bridge_socket_identity"
    );
    let clock = Scheduled::new(|elapsed: Duration| match elapsed.as_millis() {
        50 => fixture.bind(0, 0o700),
        100 => fixture.bind(1, 0o777),
        150 => fixture.mode(1, 0o700),
        _ => panic!("unexpected wait"),
    });
    wait_for_sockets_with(&fixture.root, intent, || Ok(()), &clock, BUDGET).unwrap();
    assert_eq!(clock.now(), Duration::from_millis(150));
    verify_sockets(&fixture.root, intent).unwrap();
}

#[test]
fn private_sockets_ready_first_need_no_wait_but_still_verify_the_provider_twice() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o600);
    let clock = Scheduled::new(|_: Duration| panic!("already ready"));
    let checks = Cell::new(0);
    wait_for_sockets_with(
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
fn missing_or_never_private_sockets_expire_without_changing_them_and_name_recovery() {
    for present in [false, true] {
        let fixture = Fixture::new();
        if present {
            fixture.bind(0, 0o777);
        }
        let clock = Scheduled::new(|_: Duration| {});
        let failure = wait_for_sockets_with(
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
        assert!(
            failure
                .message
                .contains("identical --candidate-root argument")
        );
        assert_eq!(clock.now(), BUDGET);
        if present {
            assert_eq!(
                fs::symlink_metadata(fixture.path(0)).unwrap().mode() & 0o777,
                0o777
            );
        } else {
            assert!(!fixture.path(0).exists());
        }
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
fn another_owner_is_not_pending_or_private() {
    let fixture = Fixture::new();
    fixture.bind(0, 0o700);
    let metadata = fs::symlink_metadata(fixture.path(0)).unwrap();
    assert!(private_socket(&metadata, metadata.uid()).unwrap());
    assert_eq!(
        private_socket(&metadata, metadata.uid().wrapping_add(1))
            .unwrap_err()
            .code,
        "bridge_socket_identity"
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
        assert!(
            failure
                .message
                .contains("identical --candidate-root argument")
        );
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
}
