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
        // The provider's socket directory is owned and private; the wait requires it.
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
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
            |_, _| {
                // Deleting the production wait now fails this assertion: the
                // scheduled bind has not occurred when audit runs immediately.
                super::super::bridge::verify_sockets(
                    &directory,
                    super::super::bridge::BridgeIntent::new(1)?,
                    &mut Vec::new(),
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
        |_, _| panic!("no audit"),
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
    assert!(failure.message.contains("hack native recover"));
    assert!(!failure.message.contains("private transport detail"));
}

fn memory_return_owner(boot: Option<&str>) -> Owner {
    serde_json::from_value(serde_json::json!({
        "version":1,"checkout":"/fixture","token":"fixture-token","machine":"fixture",
        "short_home":"/fixture","created":true,"phase":"initializing","process":null,
        "storage":null,"overlay":null,"guest_boot_id":boot,
        "daemon_pid":null,"daemon_start":null,"rootfs_digest":null
    }))
    .unwrap()
}

#[test]
fn memory_return_starts_in_the_background_with_the_guest_identity_and_never_fails_boot() {
    let calls = RefCell::new(Vec::new());
    start_memory_return(
        &memory_return_owner(Some("boot-1")),
        |script, args, background| {
            calls.borrow_mut().push((
                script.contains("memory-return-v1"),
                args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
                background,
            ));
            // The guest refusing, or the agent being unreachable, is not a boot failure.
            Err(CandidateError::new("guest_protocol", "fixture"))
        },
    );
    assert_eq!(
        calls.into_inner(),
        [(
            true,
            vec![String::from("fixture-token"), String::from("boot-1")],
            true
        )]
    );
    // Without a verified boot identity there is nothing to bind the job to: it is not started.
    start_memory_return(&memory_return_owner(None), |_, _, _| {
        panic!("no guest call without a boot identity")
    });
}

#[test]
fn memory_return_is_started_after_the_engine_answers_and_before_the_running_phase() {
    let source = include_str!("../lifecycle.rs");
    let position = |needle: &str| {
        source
            .find(needle)
            .unwrap_or_else(|| panic!("missing {needle}"))
    };
    let engine = position("engine_ping(&socket(candidate, owner, \"docker.sock\")?)?;");
    let build_network = position("include_str!(\"guest-build-network.sh\")");
    let memory = position("start_memory_return(owner, |script, args, background| {");
    let running = memory
        + source[memory..]
            .find("phase(candidate, owner, \"running\")?;")
            .expect("running phase after the memory step");
    assert!(engine < build_network && build_network < memory && memory < running);
    // Nothing else is recorded between the step and the running phase.
    assert_eq!(
        source[memory..running]
            .matches("phase(candidate, owner,")
            .count(),
        0
    );
}
