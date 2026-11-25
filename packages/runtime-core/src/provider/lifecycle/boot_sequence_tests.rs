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
            crate::provider::PoolLayout::Legacy,
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
                    crate::provider::PoolLayout::Legacy,
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
        crate::provider::PoolLayout::Legacy,
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
    let engine = position("engine_ping(|| socket(candidate, owner, \"docker.sock\"))?;");
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

#[test]
fn memory_peak_starts_like_the_memory_return_step_and_never_fails_boot() {
    let calls = RefCell::new(Vec::new());
    start_memory_peak(
        &memory_return_owner(Some("boot-1")),
        |script, args, background| {
            calls.borrow_mut().push((
                script.contains("memory-peak-v1"),
                args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
                background,
            ));
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
    start_memory_peak(&memory_return_owner(None), |_, _, _| {
        panic!("no guest call without a boot identity")
    });
    // It is started between the memory return step and the running phase.
    let source = include_str!("../lifecycle.rs");
    let position = |needle: &str| source.find(needle).expect(needle);
    let memory_return = position("start_memory_return(owner, |script, args, background| {");
    let peak = position("start_memory_peak(owner, |script, args, background| {");
    let running = peak
        + source[peak..]
            .find("phase(candidate, owner, \"running\")?;")
            .expect("running phase after the peak step");
    assert!(memory_return < peak && peak < running);
    assert_eq!(
        source[memory_return..running]
            .matches("phase(candidate, owner,")
            .count(),
        0
    );
}

const PEAK_LINE: &str = "memory-peak-v1 peak_kib=3343816 samples=42 total_kib=6087220 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n";

fn peak_scratch(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "hack-peak-down-{name}-{}-{}",
        std::process::id(),
        crate::next_test_scratch()
    ));
    state::private_directory(&root).unwrap();
    root
}

fn running_owner(boot: Option<&str>) -> Owner {
    let mut owner = memory_return_owner(boot);
    owner.phase = "running".into();
    owner
}

fn uninitialized_status(root: &std::path::Path) -> RuntimeStatus {
    let candidate = Candidate {
        protocol_version: 1,
        version: "test",
        channel: "test",
        checkpoint: "test",
        checkout: root.join("checkout"),
        executable: root.join("executable"),
        state_root: root.join("state"),
        host_os: "macos",
        host_arch: "aarch64",
        runtime_execution_supported: true,
        runtime_lifecycle_qualified: false,
    };
    status(&candidate).unwrap()
}

#[test]
fn down_reads_the_memory_peak_of_a_running_guest_once_with_a_two_second_deadline() {
    let root = peak_scratch("reads");
    let calls = RefCell::new(Vec::new());
    let before = Instant::now();
    let boot = read_memory_peak(
        &root,
        &running_owner(Some("boot-1")),
        |script, args, deadline| {
            calls.borrow_mut().push((
                script == guest_memory_peak::READ_SCRIPT,
                args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
                deadline,
            ));
            Ok(PEAK_LINE.into())
        },
    )
    .unwrap();
    let calls = calls.into_inner();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].0);
    assert_eq!(calls[0].1, ["fixture-token", "boot-1"]);
    // The deadline handed to the guest call is two seconds from the call, not later.
    assert!(calls[0].2 >= before + guest_memory_peak::READ_BUDGET);
    assert!(calls[0].2 <= Instant::now() + guest_memory_peak::READ_BUDGET);
    assert_eq!(guest_memory_peak::READ_BUDGET, Duration::from_secs(2));
    assert_eq!(boot.boot_id, "boot-1");
    assert_eq!(
        boot.guest_memory_mib,
        running_owner(None).profile.memory_mib()
    );
    assert_eq!(boot.cpus, running_owner(None).profile.cpus());
    assert_eq!(boot.reading.peak_kib, 3_343_816);
    assert_eq!(boot.reading.full_stall_us, Some(40_211));
    // Reading writes nothing.
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_memory_peak_that_cannot_be_read_is_no_reading_and_makes_no_guest_call_when_not_running() {
    let root = peak_scratch("unread");
    // A guest that does not answer, and output that is not the sampler's line.
    assert!(
        read_memory_peak(&root, &running_owner(Some("boot-1")), |_, _, _| {
            Err(CandidateError::new("agent_protocol_uncertain", "fixture"))
        })
        .is_none()
    );
    for output in ["", "unexpected\n", "memory-peak-v1 peak_kib=1\n"] {
        assert!(
            read_memory_peak(&root, &running_owner(Some("boot-1")), |_, _, _| {
                Ok(output.into())
            })
            .is_none()
        );
    }
    // No guest call for a pool that is not running or has no verified boot.
    let mut stopping = running_owner(Some("boot-1"));
    stopping.phase = "stopping".into();
    for owner in [stopping, running_owner(None)] {
        assert!(
            read_memory_peak(&root, &owner, |_, _, _| {
                panic!("no guest call outside a running, identified boot")
            })
            .is_none()
        );
    }
    let _ = fs::remove_dir_all(&root);
}

fn peak_boot() -> guest_memory_peak::Boot {
    guest_memory_peak::Boot {
        boot_id: "boot-1".into(),
        guest_memory_mib: 6144,
        cpus: 4,
        reading: guest_memory_peak::parse(PEAK_LINE).unwrap(),
        graphs: Vec::new(),
    }
}

#[test]
fn a_reading_is_kept_only_after_a_successful_stop_and_never_changes_its_result() {
    let root = peak_scratch("keeps");
    let record = root.join("guest-memory-peaks.json");
    let whole = |result: &Result<RuntimeStatus, CandidateError>| match result {
        Ok(status) => serde_json::to_string(status).unwrap(),
        Err(error) => format!("{error:?}"),
    };
    // A failed stop is returned whole and records nothing.
    let mut failed: Result<RuntimeStatus, CandidateError> =
        Err(CandidateError::new("engine_quiesce_stalled", "fixture"));
    let before = whole(&failed);
    keep_memory_peak(&root, Some(peak_boot()), &mut failed);
    assert_eq!(whole(&failed), before);
    assert!(!record.exists());
    // No reading: a successful stop is returned whole.
    let mut stopped = Ok(uninitialized_status(&root));
    let before = whole(&stopped);
    keep_memory_peak(&root, None, &mut stopped);
    assert_eq!(whole(&stopped), before);
    assert!(!record.exists());
    // A record that cannot be written (no such directory) leaves the result whole.
    let missing = root.join("absent");
    keep_memory_peak(&missing, Some(peak_boot()), &mut stopped);
    assert_eq!(whole(&stopped), before);
    assert!(!missing.exists());
    // A reading after a successful stop is recorded, and the only change to the status is
    // the record it now reports.
    keep_memory_peak(&root, Some(peak_boot()), &mut stopped);
    let mut expected: serde_json::Value = serde_json::from_str(&before).unwrap();
    assert!(expected.get("guest_memory_peaks").is_none());
    expected["guest_memory_peaks"] = serde_json::to_value(vec![peak_boot()]).unwrap();
    assert_eq!(serde_json::to_value(stopped.unwrap()).unwrap(), expected);
    assert_eq!(guest_memory_peak::history(&root), Some(vec![peak_boot()]));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn down_reads_the_memory_peak_before_the_stop_and_keeps_it_only_after() {
    let source = include_str!("../lifecycle.rs");
    let down = source.find("pub fn down(candidate: &Candidate)").unwrap();
    let wrapper = &source[down..down + source[down..].find("\n}\n").unwrap()];
    assert!(wrapper.contains("crate::timings::Step::VmStop"));
    assert!(wrapper.contains("down_observed(candidate, None)"));
    let down = source
        .find("fn down_observed(\n    candidate: &Candidate,")
        .unwrap();
    let body = &source[down..down + source[down..].find("\n}\n").unwrap()];
    let live = body.find("verify_live(candidate, &owner)?;").unwrap();
    let read = body.find("read_memory_peak(").unwrap();
    let stop = body.find("guest_stop(candidate, &mut owner)").unwrap();
    let keep = body.find("keep_memory_peak(").unwrap();
    assert!(live < read && read < stop && stop < keep);
    // HACK-2535: the idle check runs under the lease before any effect, and again right
    // before the guest stops. In that mode the host-side releases follow the second
    // check, so a refusal at either check has changed nothing.
    let build = body.find("require_no_active_build(candidate)?;").unwrap();
    let first = body.find("idle()?;").unwrap();
    let second = body.rfind("idle()?;").unwrap();
    let defined = body.find("hostname_authority::managed::stop(").unwrap();
    let released = body.rfind("release(&owner)?;").unwrap();
    assert!(build < first && first < defined && first < second);
    assert!(read < second && second < released && released < stop);
    assert_eq!(body.matches("release(&owner)?;").count(), 3);
    // The record is written from one place, after every stop path in `down`.
    assert!(body[keep..].find("stop_silent_guest").is_none());
    assert_eq!(source.matches("guest_memory_peak::record(").count(), 1);
    let keeper = source.find("fn keep_memory_peak(").unwrap();
    assert!(
        source[keeper..]
            .find("guest_memory_peak::record(")
            .is_some()
    );
}
