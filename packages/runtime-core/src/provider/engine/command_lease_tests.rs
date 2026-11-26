//! HACK-2669: a service command waits out a briefly held provider lease.
//!
//! A ready foreground owner takes the mutation lease for a moment once a second
//! (restart supervision of a routed service). `hack exec` used a nonblocking
//! acquisition, so it was refused `provider_busy` ("recorded holder: start")
//! whenever it arrived during one of those moments. No VM is involved here: the
//! pool record says running but retains no provider process, so after
//! acquisition the liveness check refuses `process_identity_unavailable`, which
//! shows the lease itself was acquired.
use super::*;
use crate::provider::lifecycle::COMMAND_LEASE_WAIT;
use crate::provider::{Profile, state};
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::mpsc;

/// The exact refusal of the first check after acquisition on this fixture.
pub(in crate::provider) const PAST_ACQUISITION: &str = "process_identity_unavailable";

pub(in crate::provider) struct Home {
    checkout: PathBuf,
    alias: Option<PathBuf>,
}

impl Drop for Home {
    fn drop(&mut self) {
        if let Some(alias) = &self.alias {
            if fs::read_link(alias).is_ok_and(|target| target.starts_with(&self.checkout)) {
                let _ = fs::remove_file(alias);
            }
        }
        let _ = fs::remove_dir_all(&self.checkout);
    }
}

pub(in crate::provider) fn running_pool() -> (Home, Candidate) {
    let mut bytes = [0_u8; 16];
    std::io::Read::read_exact(&mut fs::File::open("/dev/urandom").unwrap(), &mut bytes).unwrap();
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let checkout = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("hack-command-lease-{token}"));
    fs::DirBuilder::new().mode(0o700).create(&checkout).unwrap();
    let mut home = Home {
        checkout,
        alias: None,
    };
    let candidate = Candidate::discover(&home.checkout).unwrap();
    let mut owner =
        state::Owner::create(&candidate, Profile::Development, None, Default::default()).unwrap();
    home.alias = Some(owner.short_home.clone());
    owner.phase = "running".into();
    owner.guest_boot_id = Some("a1234567-1234-4123-8123-a12345678901".into());
    owner.save(&candidate).unwrap();
    (home, candidate)
}

/// Hold the provider lease on another thread, as the ready owner's supervision
/// tick does, until `release` is signalled or `hold` elapses.
pub(in crate::provider) fn hold_lease(
    candidate: &Candidate,
    hold: Duration,
) -> (mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let root = candidate.state_root.join("run/smolvm");
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let lock = state::Lock::acquire(&root).unwrap();
        held_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(hold);
        drop(lock);
    });
    held_rx.recv().unwrap();
    (release_tx, holder)
}

/// A check that passes until `after` has elapsed, then refuses with `code`, as an
/// owner's check does once a signal is pending.
pub(in crate::provider) fn refuses_after(
    after: Duration,
    code: &'static str,
) -> impl Fn() -> Result<(), CandidateError> {
    let started = Instant::now();
    move || {
        if started.elapsed() >= after {
            Err(CandidateError::new(code, "check refused"))
        } else {
            Ok(())
        }
    }
}

/// Assert the call waited for the holder, then got past acquisition exactly.
pub(in crate::provider) fn assert_waited_then_acquired(
    started: Instant,
    hold: Duration,
    error: &CandidateError,
) {
    assert!(
        started.elapsed() >= hold - Duration::from_millis(50),
        "returned before the holder released: {:?}",
        started.elapsed()
    );
    assert_eq!(error.code, PAST_ACQUISITION, "{}", error.message);
}

#[test]
fn a_service_command_waits_for_a_briefly_held_lease_instead_of_refusing() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(400);
    let (_release, holder) = hold_lease(&candidate, hold);

    // What exec did before: refused at once, naming the holder.
    let refused = Engine::connect(&candidate).err().unwrap();
    assert_eq!(refused.code, "provider_busy");
    assert!(
        refused.message.contains("recorded holder:"),
        "{}",
        refused.message
    );

    let started = Instant::now();
    let after = Engine::connect_command(&candidate, started + COMMAND_LEASE_WAIT, &|| Ok(()))
        .err()
        .unwrap();
    assert_waited_then_acquired(started, hold, &after);
    holder.join().unwrap();
}

#[test]
fn a_bounded_command_lease_wait_still_refuses_a_holder_that_keeps_it() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));

    let started = Instant::now();
    let deadline = started + Duration::from_millis(300);
    let refused = Engine::connect_command(&candidate, deadline, &|| Ok(()))
        .err()
        .unwrap();
    assert_eq!(refused.code, "provider_busy");
    // The last refusal is kept, so the holder is still named.
    assert!(
        refused.message.contains("recorded holder:"),
        "{}",
        refused.message
    );
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(started.elapsed() < Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// Review finding: an owner waiting on another command's lease must still see
/// its signals. The caller's check runs before every attempt, so a refusal ends
/// the wait within one backoff step, not after `COMMAND_LEASE_WAIT`.
#[test]
fn a_caller_check_ends_the_command_lease_wait_early() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));

    let started = Instant::now();
    let check = refuses_after(Duration::from_millis(200), "signal_pending");
    let refused = Engine::connect_command(&candidate, started + COMMAND_LEASE_WAIT, &check)
        .err()
        .unwrap();
    assert_eq!(refused.code, "signal_pending", "{}", refused.message);
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the check did not end the wait: {:?}",
        started.elapsed()
    );
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// The authored owner-side commands pass their guard into the wait too, and the
/// wait counts against their fixed budget.
#[test]
fn an_authored_command_wait_runs_its_guard_and_stays_inside_its_budget() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));

    let started = Instant::now();
    let guard = refuses_after(Duration::from_millis(200), "signal_pending");
    let refused =
        Engine::connect_command_until(&candidate, started + Duration::from_secs(30), &guard)
            .err()
            .unwrap();
    assert_eq!(refused.code, "signal_pending", "{}", refused.message);
    assert!(started.elapsed() < Duration::from_secs(2));

    // A budget shorter than COMMAND_LEASE_WAIT bounds the wait.
    let started = Instant::now();
    let refused =
        Engine::connect_command_until(&candidate, started + Duration::from_millis(300), &|| Ok(()))
            .err()
            .unwrap();
    assert_eq!(refused.code, "provider_busy", "{}", refused.message);
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(started.elapsed() < Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();

    // Released: the same call acquires and reaches the liveness check.
    let hold = Duration::from_millis(400);
    let (_release, holder) = hold_lease(&candidate, hold);
    let started = Instant::now();
    let after =
        Engine::connect_command_until(&candidate, started + Duration::from_secs(30), &|| Ok(()))
            .err()
            .unwrap();
    assert_waited_then_acquired(started, hold, &after);
    holder.join().unwrap();
}

/// The call site that carried the bug: compose finite `hack exec`.
#[test]
fn service_exec_waits_for_a_briefly_held_lease() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(400);
    let (_release, holder) = hold_lease(&candidate, hold);
    let argv = vec!["true".to_owned()];
    let started = Instant::now();
    let after = crate::provider::graph::service_exec(
        &candidate,
        crate::provider::graph::ServiceExecOptions {
            run: &"a".repeat(32),
            service: "web",
            expected_container: &"b".repeat(64),
            expected_boot: "a1234567-1234-4123-8123-a12345678901",
            expected_generation: &"c".repeat(64),
            argv: &argv,
            workdir: None,
            timeout: Duration::from_secs(5),
        },
    )
    .err()
    .unwrap();
    assert_waited_then_acquired(started, hold, &after);
    holder.join().unwrap();
}

/// The other call site: the dependency refresh `hack exec` and `hack run` send
/// first, on the requesting side.
#[test]
fn the_dependency_refresh_request_waits_for_a_briefly_held_lease() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(400);
    let (_release, holder) = hold_lease(&candidate, hold);
    let started = Instant::now();
    let after = crate::provider::graph::foreground::refresh_dependencies_request(
        &candidate,
        &"a".repeat(32),
    )
    .err()
    .unwrap();
    assert_waited_then_acquired(started, hold, &after);
    holder.join().unwrap();
}

/// HACK-2669 rows 1, 3 and 4, HACK-2708 and HACK-2709: the reads the shared
/// HTTPS owner makes to admit and release a run's lease take the provider lease
/// with one attempt each, so a command (or the ready owner's restart tick)
/// holding it at that moment refused them at once. The owner now waits these
/// refusals out; they are pre-admission `provider_busy` refusals naming the
/// holder, the only refusal it retries.
#[test]
fn the_shared_https_owner_reads_refuse_provider_busy_at_once_naming_the_holder() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));
    let started = Instant::now();
    for refused in [
        crate::provider::publication::inspect_claims(&candidate)
            .err()
            .unwrap(),
        crate::provider::graph::inspect_bridges(&candidate, &"a".repeat(32))
            .err()
            .unwrap(),
    ] {
        assert_eq!(refused.code, "provider_busy", "{}", refused.message);
        assert!(
            refused.message.contains("recorded holder:"),
            "{}",
            refused.message
        );
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// Hold the provider lease on another thread recorded as a project stop, as another
/// project's live owner does for its whole graph stop (HACK-2724), until `release`
/// is signalled or `hold` elapses.
pub(in crate::provider) fn hold_lease_as_project_stop(
    candidate: &Candidate,
    hold: Duration,
) -> (mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let root = candidate.state_root.join("run/smolvm");
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let _stop = state::RecordProjectStop::begin();
        let lock = state::Lock::acquire(&root).unwrap();
        held_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(hold);
        drop(lock);
    });
    held_rx.recv().unwrap();
    (release_tx, holder)
}

/// The closed refusal of a wait whose holder is another project's stop; the CLI
/// reads the holder from it.
pub(in crate::provider) const PROJECT_STOP_REFUSAL: &str =
    "Provider lease acquisition refused; recorded holder: project stop; no operation was admitted.";

/// Scaling down the test's stop leaves the lease backoff capped at 50 ms. Allow
/// ten such intervals for scheduling, unlocking and observing the release.
pub(in crate::provider) const PROJECT_STOP_POLL_SLACK: Duration = Duration::from_millis(500);

/// HACK-2729: the requesting process of `hack exec` (its dependency refresh and the
/// exec) waits as long as a start does, which covers another project's stop; the
/// owner-side waits, which run on an owner's only loop thread, keep 15 s.
#[test]
fn the_requesting_side_of_exec_waits_as_long_as_a_start_and_the_owner_side_keeps_its_bound() {
    use crate::provider::lifecycle::{COMMAND_REQUEST_LEASE_WAIT, START_LEASE_WAIT};
    // One bound, defined by the start's: the 30 s stop grace limit plus 5 s.
    assert_eq!(COMMAND_REQUEST_LEASE_WAIT, START_LEASE_WAIT);
    assert!(COMMAND_REQUEST_LEASE_WAIT >= Duration::from_secs(30) + Duration::from_secs(5));
    assert_eq!(COMMAND_LEASE_WAIT, Duration::from_secs(15));

    let now = Instant::now();
    let far = now + Duration::from_secs(200);
    assert_eq!(
        command_lease_deadline(now, far, COMMAND_REQUEST_LEASE_WAIT),
        now + Duration::from_secs(35)
    );
    assert_eq!(
        command_lease_deadline(now, far, COMMAND_LEASE_WAIT),
        now + Duration::from_secs(15)
    );
    // A caller's earlier deadline still bounds either wait.
    let near = now + Duration::from_secs(2);
    assert_eq!(
        command_lease_deadline(now, near, COMMAND_REQUEST_LEASE_WAIT),
        near
    );
    assert_eq!(command_lease_deadline(now, near, COMMAND_LEASE_WAIT), near);
}

/// HACK-2729: the scaled owner-side bound of 300 ms refuses a 600 ms project
/// stop with the exact message the CLI reads. The requester waits out the stop
/// with enough slack for polling and proceeds to the post-acquisition check.
#[test]
fn a_requested_command_waits_out_a_project_stop_that_the_owner_bound_refuses() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(600);
    let (_release, holder) = hold_lease_as_project_stop(&candidate, hold);

    let started = Instant::now();
    let refused =
        Engine::connect_command(&candidate, started + Duration::from_millis(300), &|| Ok(()))
            .err()
            .unwrap();
    assert_eq!(refused.code, "provider_busy");
    assert_eq!(refused.message, PROJECT_STOP_REFUSAL);
    assert!(started.elapsed() < hold);

    let after = Engine::connect_command_request(
        &candidate,
        started + hold + PROJECT_STOP_POLL_SLACK,
        &|| Ok(()),
    )
    .err()
    .unwrap();
    assert_waited_then_acquired(started, hold, &after);
    holder.join().unwrap();
}

/// HACK-2729: a stop that outlasts the requesting side's bound is still refused
/// within it, with the holder named, as the raw `provider_busy` that admitted
/// nothing.
#[test]
fn a_requested_command_refuses_a_stop_past_its_bound_naming_it() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease_as_project_stop(&candidate, Duration::from_secs(30));
    let started = Instant::now();
    let refused =
        Engine::connect_command_request(&candidate, started + Duration::from_millis(300), &|| {
            Ok(())
        })
        .err()
        .unwrap();
    assert_eq!(refused.code, "provider_busy");
    assert_eq!(refused.message, PROJECT_STOP_REFUSAL);
    assert!(refused.cause_code.is_none());
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(started.elapsed() < Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// HACK-2739: the requesting process of an authored `hack exec` waits for a
/// free lease before it sends anything to its owner. It outlasts a project stop
/// held for 600 ms, releases the lease and returns. The next holder can acquire
/// it immediately.
#[test]
fn the_authored_exec_request_waits_out_a_project_stop_and_releases_the_lease() {
    use crate::provider::lifecycle::await_free_command_lease;
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(600);
    let (_release, holder) = hold_lease_as_project_stop(&candidate, hold);
    let started = Instant::now();
    await_free_command_lease(&candidate, started + hold + PROJECT_STOP_POLL_SLACK).unwrap();
    assert!(
        started.elapsed() >= hold - Duration::from_millis(50),
        "returned before the stop released: {:?}",
        started.elapsed()
    );
    holder.join().unwrap();
    // Released: the next holder acquires at once.
    drop(state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
}

/// HACK-2739: a stop past the requesting side's bound is refused within it with
/// the raw, uncaused `provider_busy` that names the stop. That is the refusal the
/// CLI reports as "nothing ran".
#[test]
fn the_authored_exec_request_refuses_a_stop_past_its_bound_naming_it() {
    use crate::provider::lifecycle::await_free_command_lease;
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease_as_project_stop(&candidate, Duration::from_secs(30));
    let started = Instant::now();
    let deadline = started + Duration::from_millis(300);
    let refused = await_free_command_lease(&candidate, deadline)
        .err()
        .unwrap();
    assert_eq!(refused.code, "provider_busy");
    assert_eq!(refused.message, PROJECT_STOP_REFUSAL);
    assert!(refused.cause_code.is_none());
    assert!(Instant::now() >= deadline);
    assert!(started.elapsed() < Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// HACK-2739, the normal path: with nothing holding the lease the wait is one
/// lock attempt. On a home with no pool it returns at once and creates nothing,
/// so the owner's answer says what it said before.
#[test]
fn the_authored_exec_request_wait_is_one_attempt_when_free_and_inert_without_a_pool() {
    use crate::provider::lifecycle::{COMMAND_REQUEST_LEASE_WAIT, await_free_command_lease};
    let (_home, candidate) = running_pool();
    let started = Instant::now();
    for _ in 0..100 {
        await_free_command_lease(&candidate, Instant::now() + COMMAND_REQUEST_LEASE_WAIT).unwrap();
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "100 uncontended waits took {:?}",
        started.elapsed()
    );

    let mut bytes = [0_u8; 16];
    std::io::Read::read_exact(&mut fs::File::open("/dev/urandom").unwrap(), &mut bytes).unwrap();
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let checkout = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("hack-command-lease-empty-{token}"));
    fs::DirBuilder::new().mode(0o700).create(&checkout).unwrap();
    let _empty_home = Home {
        checkout: checkout.clone(),
        alias: None,
    };
    let empty = Candidate::discover(&checkout).unwrap();
    let started = Instant::now();
    await_free_command_lease(&empty, started + COMMAND_REQUEST_LEASE_WAIT).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!empty.state_root.join("run/smolvm/operation.lock").exists());
}

/// HACK-2739, the call site: `native::foreground::exec`, the requesting side of an
/// authored `hack exec`, waits out the stop before it loads the owner's pin. This
/// fixture has no owner, so it then refuses with something other than
/// `provider_busy`. Before the fix it went straight to the owner.
#[cfg(feature = "native-config-plan")]
#[test]
fn the_authored_exec_requester_waits_before_it_contacts_the_owner() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(600);
    let (_release, holder) = hold_lease_as_project_stop(&candidate, hold);
    let started = Instant::now();
    let after = crate::provider::graph::native::foreground::exec(
        &candidate,
        &"a".repeat(32),
        "web",
        &["true".to_owned()],
        None,
    )
    .err()
    .unwrap();
    assert!(
        started.elapsed() >= hold - Duration::from_millis(50),
        "contacted the owner before the stop released: {:?} ({})",
        started.elapsed(),
        after.code
    );
    assert_ne!(after.code, "provider_busy", "{}", after.message);
    holder.join().unwrap();
}
