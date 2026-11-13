//! The production fresh-boot sequence drives the real socket waiter before
//! audit/adoption. Host template/process/disk effects are injected, not qualified.
use super::*;
use std::{
    cell::{Cell, RefCell},
    os::unix::{fs::PermissionsExt, net::UnixListener},
};

struct Clock<'a> {
    elapsed: Cell<Duration>,
    on_sleep: RefCell<Box<dyn FnMut() + 'a>>,
}
impl process::Clock for Clock<'_> {
    fn now(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, duration: Duration) {
        self.elapsed.set(self.elapsed.get() + duration);
        (self.on_sleep.borrow_mut())();
    }
}

#[test]
fn fresh_boot_waits_before_audit_and_never_adopts_failed_socket_readiness() {
    for mode in [
        "delayed",
        "missing",
        "unsafe",
        "provider-before",
        "provider-after",
    ] {
        let directory = crate::unique_test_root(&std::env::temp_dir(), "boot-bridge");
        let path = directory.join("bridge-00.sock");
        if mode == "unsafe" {
            fs::write(&path, b"foreign").unwrap();
        }
        let listener = RefCell::new(None);
        let clock = Clock {
            elapsed: Cell::new(Duration::ZERO),
            on_sleep: RefCell::new(Box::new(|| {
                if mode == "delayed" && listener.borrow().is_none() {
                    *listener.borrow_mut() = Some(UnixListener::bind(&path).unwrap());
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                }
            })),
        };
        let events = RefCell::new(Vec::new());
        let checks = Cell::new(0);
        let mut adopted = false;
        let result = finish_boot_with(
            &mut adopted,
            |_| {
                events.borrow_mut().push("templates");
                Ok(Some((
                    directory.clone(),
                    super::super::bridge::BridgeIntent::new(1)?,
                )))
            },
            |_| {
                checks.set(checks.get() + 1);
                let lose = (mode == "provider-before" && checks.get() == 1)
                    || (mode == "provider-after" && checks.get() == 2);
                if lose {
                    Err(CandidateError::new(
                        "process_identity_mismatch",
                        "private detail",
                    ))
                } else {
                    Ok(())
                }
            },
            |_| {
                // Deleting the production wait now fails this assertion: the
                // scheduled bind has not occurred when audit runs immediately.
                super::super::bridge::verify_sockets(
                    &directory,
                    super::super::bridge::BridgeIntent::new(1)?,
                )?;
                events.borrow_mut().push("audit");
                Ok(())
            },
            |adopted| {
                *adopted = true;
                events.borrow_mut().push("adopt");
                Ok(())
            },
            &clock,
        );
        if mode == "delayed" {
            result.unwrap();
            assert!(adopted);
            assert_eq!(clock.elapsed.get(), Duration::from_millis(50));
            assert_eq!(*events.borrow(), ["templates", "audit", "adopt"]);
        } else {
            let failure = result.unwrap_err();
            assert!(!adopted);
            assert_eq!(*events.borrow(), ["templates"]);
            let code = match mode {
                "missing" => "bridge_socket_timeout",
                "unsafe" => "bridge_socket_identity",
                _ => "process_identity_mismatch",
            };
            assert_eq!(failure.code, code);
            assert!(failure.message_fixed);
            assert!(failure.message.contains("runtime recover --json"));
        }
        drop(clock);
        drop(listener.into_inner());
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn template_refusal_cannot_reach_socket_observation_audit_or_adoption() {
    let clock = Clock {
        elapsed: Cell::new(Duration::ZERO),
        on_sleep: RefCell::new(Box::new(|| panic!("no wait"))),
    };
    let failure = finish_boot_with(
        &mut (),
        |_| Err(CandidateError::new("disk_template_untrusted", "fixture")),
        |_| panic!("no socket observation"),
        |_| panic!("no audit"),
        |_| -> Result<(), CandidateError> { panic!("no adoption") },
        &clock,
    )
    .unwrap_err();
    assert_eq!(failure.code, "disk_template_untrusted");
}

#[test]
fn failed_boot_stop_preserves_its_code_and_the_recovery_command() {
    let failure = failed_boot_stop_error(CandidateError::new(
        "process_identity_unavailable",
        String::from("private transport detail"),
    ));
    assert_eq!(failure.code, "process_identity_unavailable");
    assert!(failure.message_fixed);
    assert!(failure.message.contains("runtime recover --json"));
    assert!(
        failure
            .message
            .contains("identical --candidate-root argument")
    );
    assert!(!failure.message.contains("private transport detail"));
}
