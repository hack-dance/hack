//! The record on real files, with the boot session and both clocks supplied by the test.
//!
//! Every test of a miss asserts three things: the start is not refused, it sleeps the rest
//! of its own window, and its sample under the lease is the one a home without a record
//! takes ([`Run::took_the_path_without_a_record`]).
use super::super::pressure_tests::{GIB, TestClock, observation};
use super::super::{Leased, MemoryPressure, open, recheck_after_lease};
use super::*;
use crate::provider::process::Clock;
use std::cell::{Cell, RefCell};
use std::os::unix::fs::PermissionsExt;

const BOOT: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_BOOT: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/// When the start under test takes its first sample, on both test clocks.
const FIRST: Duration = Duration::from_secs(1000);
/// How long after its first sample the start holds the lease, unless a test says otherwise.
const LEASE: Duration = Duration::from_millis(100);
/// The swapout count the host shows unless a test says otherwise.
const COUNT: u64 = 42;

/// A provider root with its lease held, removed when the test ends.
struct Home {
    root: PathBuf,
    lease: state::Lock,
}

impl Home {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hkl-opening-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                crate::next_test_scratch()
            ));
        state::private_directory(&root).unwrap();
        let lease = state::Lock::acquire(&root).unwrap();
        Self { root, lease }
    }

    fn file(&self) -> PathBuf {
        path(&self.root)
    }

    /// A well-formed private record, written as the module writes it.
    fn holds(&self, boot: &str, at: Duration, swapouts: u64) {
        let _ = fs::remove_file(self.file());
        state::write(
            &self.file(),
            &Record {
                boot_session: boot.into(),
                monotonic_nanos: u64::try_from(at.as_nanos()).unwrap(),
                swapouts,
            },
        )
        .unwrap();
    }

    /// Arbitrary bytes at the record's path, private to this user.
    fn holds_bytes(&self, bytes: &[u8]) {
        let _ = fs::remove_file(self.file());
        fs::write(self.file(), bytes).unwrap();
        self.mode(0o600);
    }

    fn mode(&self, mode: u32) {
        fs::set_permissions(self.file(), fs::Permissions::from_mode(mode)).unwrap();
    }

    fn record(&self) -> Option<serde_json::Value> {
        fs::read(self.file())
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// The host as a test sets it. Its clock is the window clock: one time axis per test.
struct TestHost<'a> {
    boot: RefCell<Option<String>>,
    clock: &'a TestClock,
    clock_readable: Cell<bool>,
    boot_reads: Cell<u32>,
}

impl<'a> TestHost<'a> {
    fn on(clock: &'a TestClock) -> Self {
        Self {
            boot: RefCell::new(Some(BOOT.into())),
            clock,
            clock_readable: Cell::new(true),
            boot_reads: Cell::new(0),
        }
    }
}

impl Host for TestHost<'_> {
    fn boot_session(&self) -> Option<String> {
        self.boot_reads.set(self.boot_reads.get() + 1);
        self.boot.borrow().clone()
    }

    fn now(&self) -> Option<Duration> {
        self.clock_readable.get().then(|| self.clock.now())
    }
}

fn passing(swapouts: u64) -> Admission {
    let mut sample = observation(Profile::Development, Some(1), 10 * GIB);
    sample.swapouts = Some(swapouts);
    sample
}

/// One Development start: what it returned, when it asked the host for a sample, and how
/// long it slept.
struct Run {
    leased: Result<Leased, CandidateError>,
    asked: Vec<Duration>,
    slept: Duration,
    lease_at: Duration,
}

impl Run {
    /// The record replaced the wait: no sleep, one sample under the lease taken at once,
    /// and that sample shows `count`.
    fn reused(&self, count: u64) {
        let leased = self.leased.as_ref().unwrap();
        assert_eq!(leased.reused, Some(true));
        assert_eq!(self.slept, Duration::ZERO);
        assert_eq!(self.asked, [FIRST, self.lease_at]);
        assert_eq!(leased.samples.len(), 1);
        assert_eq!(leased.samples[0].swapouts, Some(count));
        assert_eq!(leased.sampled_at, Some(self.lease_at));
    }

    /// Not refused, slept the rest of its own window, and took exactly the sample a home
    /// without a record takes: one, a window after the first, with the first one's count.
    fn took_the_path_without_a_record(&self) {
        self.waited(&[FIRST, FIRST + DEVELOPMENT_WINDOW]);
    }

    /// As above, after one sample taken early for a reuse that then missed. That sample is
    /// not among the recorded ones.
    fn discarded_an_early_sample_and_waited(&self) {
        self.waited(&[FIRST, self.lease_at, FIRST + DEVELOPMENT_WINDOW]);
    }

    fn waited(&self, asked: &[Duration]) {
        let leased = self
            .leased
            .as_ref()
            .unwrap_or_else(|error| panic!("a miss refused the start: {}", error.message));
        assert_eq!(leased.reused, Some(false));
        assert_eq!(self.slept, FIRST + DEVELOPMENT_WINDOW - self.lease_at);
        assert_eq!(self.asked, asked);
        assert_eq!(leased.samples.len(), 1);
        assert_eq!(leased.samples[0].swapouts, Some(COUNT));
    }
}

/// A start whose `n`th sample (its first is 0) is `samples(n)`, and which holds the lease
/// `lease` after its first sample. `prepare` runs when the first sample is taken, with
/// the clock at [`FIRST`]: it places the record and sets the host.
fn start_with(
    home: &Home,
    reuse: Reuse,
    lease: Duration,
    prepare: impl FnOnce(&Home, &TestHost<'_>),
    judge_as: impl FnOnce(&mut Opening<'_, TestHost<'_>>),
    samples: impl Fn(usize) -> Result<Admission, CandidateError>,
) -> Run {
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    prepare(home, &host);
    let asked = RefCell::new(Vec::new());
    let sample = || {
        asked.borrow_mut().push(clock.now());
        samples(asked.borrow().len() - 1)
    };
    let window = open(&sample().unwrap(), &clock).unwrap();
    clock.advance(lease);
    let mut opening = Opening::new(&home.root, &host, reuse);
    judge_as(&mut opening);
    let leased = recheck_after_lease(Profile::Development, Some(window), &clock, &opening, sample);
    Run {
        leased,
        asked: asked.take(),
        slept: clock.slept.borrow().iter().sum(),
        lease_at: FIRST + lease,
    }
}

/// A start on a host that always passes and always shows [`COUNT`].
fn start(home: &Home, prepare: impl FnOnce(&Home, &TestHost<'_>)) -> Run {
    start_with(
        home,
        Reuse::parse(None).unwrap(),
        LEASE,
        prepare,
        |_| {},
        |_| Ok(passing(COUNT)),
    )
}

/// A record every reuse condition accepts when the lease is held [`LEASE`] after [`FIRST`].
fn usable(home: &Home) {
    home.holds(BOOT, FIRST - Duration::from_secs(10), COUNT);
}

#[test]
fn a_same_boot_record_between_one_window_and_the_bound_old_replaces_the_wait() {
    let bound = Duration::from_secs(60);
    for age in [DEVELOPMENT_WINDOW, Duration::from_secs(10), bound] {
        let home = Home::new();
        let run = start(&home, |home, _| {
            home.holds(BOOT, FIRST + LEASE - age, COUNT);
        });
        run.reused(COUNT);
    }
    // A longer bound admits an older record, and a shorter one a younger record only.
    for (setting, age_secs, reused) in [("300", 300, true), ("5", 5, true), ("5", 6, false)] {
        let home = Home::new();
        let run = start_with(
            &home,
            Reuse::parse(Some(setting)).unwrap(),
            LEASE,
            |home, _| home.holds(BOOT, FIRST + LEASE - Duration::from_secs(age_secs), COUNT),
            |_| {},
            |_| Ok(passing(COUNT)),
        );
        if reused {
            run.reused(COUNT);
        } else {
            run.took_the_path_without_a_record();
        }
    }
}

#[test]
fn a_reused_start_still_takes_both_of_its_own_samples_and_each_must_pass() {
    let home = Home::new();
    let run = start(&home, |home, _| usable(home));
    // Two readings of the host by this start: the one that opened its window, and one
    // under the lease. The record supplied neither.
    assert_eq!(run.asked.len(), 2);
    run.reused(COUNT);
    // The sample under the lease is judged as it always was: one failing predicate and
    // the record no longer helps. The start waits and samples again, as without a record,
    // and that sample's verdict is the start's.
    for defect in 0..4 {
        let home = Home::new();
        let failing = |n: usize| {
            let mut sample = passing(COUNT);
            if n == 1 {
                match defect {
                    0 => sample.memory_pressure = MemoryPressure::from_level(Some(4)),
                    1 => sample.thermal_normal = false,
                    2 => sample.free_plus_file_cache_estimate_bytes = Some(10 * GIB - 1),
                    _ => {
                        sample.admitted = false;
                        sample.reasons.push("disk budget".into());
                    }
                }
            }
            Ok(sample)
        };
        let run = start_with(
            &home,
            Reuse::parse(None).unwrap(),
            LEASE,
            |home, _| usable(home),
            |_| {},
            failing,
        );
        run.discarded_an_early_sample_and_waited();
    }
    // A host that still fails after the window refuses, with the refusal a home without a
    // record gives.
    let home = Home::new();
    let run = start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |home, _| usable(home),
        |_| {},
        |n| {
            let mut sample = passing(COUNT);
            sample.thermal_normal = n == 0;
            Ok(sample)
        },
    );
    assert_eq!(run.leased.unwrap_err().code, "admission_rejected");
    assert_eq!(
        run.asked,
        [FIRST, FIRST + LEASE, FIRST + DEVELOPMENT_WINDOW]
    );
}

#[test]
fn a_sample_that_cannot_be_taken_early_is_taken_after_the_wait() {
    let home = Home::new();
    let run = start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |home, _| usable(home),
        |_| {},
        |n| {
            if n == 1 {
                Err(CandidateError::new("admission_unavailable", "fixture"))
            } else {
                Ok(passing(COUNT))
            }
        },
    );
    run.discarded_an_early_sample_and_waited();
}

#[test]
fn a_missing_record_is_the_start_without_one() {
    let home = Home::new();
    start(&home, |_, _| {}).took_the_path_without_a_record();
}

#[test]
fn an_unreadable_record_is_the_start_without_one() {
    let home = Home::new();
    start(&home, |home, _| {
        usable(home);
        home.mode(0o000);
    })
    .took_the_path_without_a_record();
}

#[test]
fn an_unparsable_record_is_the_start_without_one() {
    for bytes in [
        &b""[..],
        b"not json",
        b"[]",
        b"null",
        br#"{"boot_session":"0f8fad5b-d9cb-469f-a165-70867728950e","monotonic_nanos":990"#,
        // Larger than any record this module writes.
        &[b' '; 2048],
    ] {
        let home = Home::new();
        start(&home, |home, _| home.holds_bytes(bytes)).took_the_path_without_a_record();
    }
}

#[test]
fn a_record_with_unknown_missing_or_mistyped_fields_is_the_start_without_one() {
    let at = u64::try_from((FIRST - Duration::from_secs(10)).as_nanos()).unwrap();
    for text in [
        // A fourth field, known or not.
        format!(
            r#"{{"boot_session":"{BOOT}","monotonic_nanos":{at},"swapouts":{COUNT},"version":1}}"#
        ),
        format!(
            r#"{{"boot_session":"{BOOT}","monotonic_nanos":{at},"swapouts":{COUNT},"profile":"development"}}"#
        ),
        // One of the three missing.
        format!(r#"{{"boot_session":"{BOOT}","monotonic_nanos":{at}}}"#),
        format!(r#"{{"monotonic_nanos":{at},"swapouts":{COUNT}}}"#),
        format!(r#"{{"boot_session":"{BOOT}","swapouts":{COUNT}}}"#),
        // The right names with other types.
        format!(r#"{{"boot_session":"{BOOT}","monotonic_nanos":"{at}","swapouts":{COUNT}}}"#),
        format!(r#"{{"boot_session":"{BOOT}","monotonic_nanos":{at},"swapouts":-1}}"#),
        format!(r#"{{"boot_session":"{BOOT}","monotonic_nanos":{at}.5,"swapouts":{COUNT}}}"#),
        // A boot session that is not a canonical lowercase UUID.
        format!(
            r#"{{"boot_session":"{}","monotonic_nanos":{at},"swapouts":{COUNT}}}"#,
            BOOT.to_ascii_uppercase()
        ),
        format!(
            r#"{{"boot_session":"00000000-0000-0000-0000-000000000000","monotonic_nanos":{at},"swapouts":{COUNT}}}"#
        ),
        format!(r#"{{"boot_session":"","monotonic_nanos":{at},"swapouts":{COUNT}}}"#),
    ] {
        let home = Home::new();
        start(&home, |home, _| home.holds_bytes(text.as_bytes())).took_the_path_without_a_record();
    }
}

#[test]
fn a_record_that_is_not_a_regular_file_is_the_start_without_one() {
    // A link to a record that every other condition accepts: it is not followed.
    let home = Home::new();
    start(&home, |home, _| {
        usable(home);
        let elsewhere = home.root.join("elsewhere.json");
        fs::rename(home.file(), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.file()).unwrap();
    })
    .took_the_path_without_a_record();
    // A link to nothing.
    let home = Home::new();
    start(&home, |home, _| {
        std::os::unix::fs::symlink(home.root.join("absent"), home.file()).unwrap();
    })
    .took_the_path_without_a_record();
    // A directory.
    let home = Home::new();
    start(&home, |home, _| fs::create_dir(home.file()).unwrap()).took_the_path_without_a_record();
    // A named pipe with no writer: the read does not wait for one.
    let home = Home::new();
    start(&home, |home, _| {
        let name = std::ffi::CString::new(home.file().as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: mkfifo receives a terminated path and retains no pointer.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    })
    .took_the_path_without_a_record();
    // A file with a second name.
    let home = Home::new();
    start(&home, |home, _| {
        usable(home);
        fs::hard_link(home.file(), home.root.join("second-name.json")).unwrap();
    })
    .took_the_path_without_a_record();
}

#[test]
fn a_record_not_owned_by_this_user_is_the_start_without_one() {
    let home = Home::new();
    // The same file, read by a start whose user is not the file's owner.
    start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |home, _| usable(home),
        |opening| opening.user += 1,
        |_| Ok(passing(COUNT)),
    )
    .took_the_path_without_a_record();
    // And it was the owner alone that made it a miss.
    start(&home, |_, _| {}).reused(COUNT);
}

#[test]
fn a_group_or_world_accessible_record_is_the_start_without_one() {
    for mode in [0o640, 0o620, 0o604, 0o602, 0o610, 0o601, 0o644, 0o666] {
        let home = Home::new();
        start(&home, |home, _| {
            usable(home);
            home.mode(mode);
        })
        .took_the_path_without_a_record();
    }
    // Owner-only modes are the ones accepted.
    for mode in [0o600, 0o400] {
        let home = Home::new();
        start(&home, |home, _| {
            usable(home);
            home.mode(mode);
        })
        .reused(COUNT);
    }
}

#[test]
fn a_record_from_another_boot_session_is_the_start_without_one() {
    let home = Home::new();
    start(&home, |home, _| {
        home.holds(OTHER_BOOT, FIRST - Duration::from_secs(10), COUNT);
    })
    .took_the_path_without_a_record();
    // The same record after a reboot: this boot's session is the other one.
    let home = Home::new();
    start(&home, |home, host| {
        usable(home);
        *host.boot.borrow_mut() = Some(OTHER_BOOT.into());
    })
    .took_the_path_without_a_record();
}

#[test]
fn a_boot_session_that_cannot_be_read_is_the_start_without_a_record() {
    let home = Home::new();
    start(&home, |home, host| {
        usable(home);
        *host.boot.borrow_mut() = None;
    })
    .took_the_path_without_a_record();
}

#[test]
fn a_record_younger_than_the_window_is_the_start_without_one() {
    for at in [
        // One millisecond short of a window when the lease is held.
        FIRST + LEASE - DEVELOPMENT_WINDOW + Duration::from_millis(1),
        // Written just before this start's first sample, as by a stop that just ended.
        FIRST - Duration::from_millis(1),
        // Stamped later than now.
        FIRST + Duration::from_secs(3600),
    ] {
        let home = Home::new();
        start(&home, |home, _| home.holds(BOOT, at, COUNT)).took_the_path_without_a_record();
    }
}

#[test]
fn a_record_older_than_the_bound_is_the_start_without_one() {
    for age in [
        Duration::from_secs(60) + Duration::from_nanos(1),
        Duration::from_secs(600),
    ] {
        let home = Home::new();
        start(&home, |home, _| {
            home.holds(BOOT, FIRST + LEASE - age, COUNT)
        })
        .took_the_path_without_a_record();
    }
}

#[test]
fn a_clock_that_cannot_be_read_is_the_start_without_a_record() {
    let home = Home::new();
    let run = start(&home, |home, host| {
        usable(home);
        host.clock_readable.set(false);
    });
    run.took_the_path_without_a_record();
    // Nor is there a time to record this start's sample with.
    assert_eq!(run.leased.unwrap().sampled_at, None);
}

#[test]
fn a_swapout_count_that_differs_from_the_record_is_the_start_without_one() {
    // The host shows 42 throughout; the record says otherwise. The sample taken early for
    // the reuse is discarded, and the one taken after the wait is the start's sample.
    for recorded in [COUNT - 1, COUNT + 1, 0] {
        let home = Home::new();
        start(&home, |home, _| {
            home.holds(BOOT, FIRST - Duration::from_secs(10), recorded);
        })
        .discarded_an_early_sample_and_waited();
    }
    // The sample after the wait is chained to the start's own first sample, not to the
    // record: a host that swapped out since that first sample is refused as it is on a
    // home without a record, in the same words, although its count now equals the
    // record's.
    let swapped = |n: usize| Ok(passing(if n == 0 { COUNT } else { COUNT + 1 }));
    let home = Home::new();
    let with_record = start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |home, _| home.holds(BOOT, FIRST - Duration::from_secs(10), COUNT + 1),
        |_| {},
        swapped,
    );
    let home = Home::new();
    let without = start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |_, _| {},
        |_| {},
        swapped,
    );
    let (with_record, without) = (with_record.leased.unwrap_err(), without.leased.unwrap_err());
    assert_eq!(with_record.message, "Swapouts changed during admission.");
    assert_eq!(
        (with_record.code, with_record.message),
        (without.code, without.message)
    );
}

#[test]
fn reuse_turned_off_reads_no_record() {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    usable(&home);
    let off = Opening::new(&home.root, &host, Reuse::parse(Some("0")).unwrap());
    assert_eq!(off.judge(), Err(Miss::Off));
    assert_eq!(host.boot_reads.get(), 0);
    let run = start_with(
        &home,
        Reuse::parse(Some("0")).unwrap(),
        LEASE,
        |_, _| {},
        |_| {},
        |_| Ok(passing(COUNT)),
    );
    run.took_the_path_without_a_record();
}

#[test]
fn a_start_with_no_wait_left_does_not_ask_for_the_record() {
    for lease in [DEVELOPMENT_WINDOW, Duration::from_secs(4)] {
        let home = Home::new();
        let clock = TestClock::at(FIRST);
        let host = TestHost::on(&clock);
        usable(&home);
        let window = open(&passing(COUNT), &clock).unwrap();
        clock.advance(lease);
        let opening = Opening::new(&home.root, &host, Reuse::parse(None).unwrap());
        let leased =
            recheck_after_lease(Profile::Development, Some(window), &clock, &opening, || {
                Ok(passing(COUNT))
            })
            .unwrap();
        assert_eq!(leased.reused, Some(false));
        assert_eq!(host.boot_reads.get(), 0);
        assert!(clock.slept.borrow().is_empty());
    }
}

#[test]
fn research_neither_reads_nor_writes_a_record() {
    struct Untouched;
    impl Earlier for Untouched {
        fn usable(&self) -> Option<Recorded> {
            panic!("Research asked for the record")
        }
        fn now(&self) -> Option<Duration> {
            panic!("Research asked for the record's clock")
        }
        fn in_age(&self, _: &Recorded, _: Duration) -> bool {
            panic!("Research asked for the record's age")
        }
    }
    let clock = TestClock::at(FIRST);
    let leased = recheck_after_lease(Profile::Research, None, &clock, &Untouched, || {
        panic!("Research takes no sample under the lease")
    })
    .unwrap();
    assert!(leased.samples.is_empty());
    assert_eq!((leased.reused, leased.sampled_at), (None, None));
    // The stop of a Research pool takes no sample and writes nothing.
    let home = Home::new();
    let host = TestHost::on(&clock);
    assert!(!record_at_stop(
        &home.root,
        &home.lease,
        &host,
        Profile::Research,
        || panic!("the stop of a Research pool sampled the host")
    ));
    assert_eq!(home.record(), None);
    // A Research sample is never recorded, whoever offers it.
    let research = observation(Profile::Research, Some(1), 16 * GIB);
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &research,
        Some(FIRST)
    ));
    assert_eq!(home.record(), None);
}

/// The weakening reuse adds, stated as the sibling test states the two-sample one
/// (`a_dip_between_the_two_development_samples_is_not_seen`): a host that fails and
/// recovers between the recorded sample and this start's samples is admitted. Without a
/// record the start's two samples are at least a window apart. With one they are as close
/// as the start's own checks, here 100 ms, and the evidence that the host held for a window
/// is the recorded sample, here 50 seconds old. The host below fails at every moment of
/// those 50 seconds except the three at which it is read.
///
/// What still refuses such a stretch is a swapout in it, because that count is cumulative
/// and the sample under the lease must show the record's
/// (`a_swapout_count_that_differs_from_the_record_is_the_start_without_one`). The bound
/// limits how long the unseen stretch can be; it does not make it seen.
#[test]
fn a_dip_between_the_record_and_the_leased_sample_is_not_seen() {
    let recorded_at = FIRST - Duration::from_secs(50);
    let leased_at = FIRST + LEASE;
    // What a sampler would return if it were asked at `at`.
    let host_at = |at: Duration| {
        let read = [recorded_at, FIRST, leased_at].contains(&at);
        let failing = recorded_at < at && at < leased_at && !read;
        observation(
            Profile::Development,
            Some(if failing { 4 } else { 1 }),
            10 * GIB,
        )
    };
    for inside in [
        recorded_at + Duration::from_millis(1),
        FIRST - Duration::from_secs(25),
        FIRST - Duration::from_millis(1),
        FIRST + Duration::from_millis(1),
        leased_at - Duration::from_millis(1),
    ] {
        assert!(
            check(Profile::Development, &host_at(inside), Some(COUNT)).is_err(),
            "a sample at {inside:?} would refuse"
        );
    }
    let home = Home::new();
    let clock = TestClock::at(recorded_at);
    let host = TestHost::on(&clock);
    // The earlier passing sample, recorded by this module's writer.
    assert!(record(
        &home.root,
        &home.lease,
        &host,
        &host_at(clock.now()),
        host.now()
    ));
    clock.advance(FIRST - recorded_at);
    let asked = RefCell::new(Vec::new());
    let sample = || {
        asked.borrow_mut().push(clock.now());
        Ok(host_at(clock.now()))
    };
    let window = open(&sample().unwrap(), &clock).unwrap();
    clock.advance(LEASE);
    let opening = Opening::new(&home.root, &host, Reuse::parse(None).unwrap());
    let leased =
        recheck_after_lease(Profile::Development, Some(window), &clock, &opening, sample).unwrap();
    assert_eq!(leased.reused, Some(true));
    assert_eq!(*asked.borrow(), [FIRST, leased_at]);
    assert!(clock.slept.borrow().is_empty());
}

#[test]
fn the_record_holds_exactly_three_fields_and_only_this_user_can_read_it() {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    assert!(record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT),
        host.now()
    ));
    assert_eq!(
        home.record().unwrap(),
        serde_json::json!({
            "boot_session": BOOT,
            "monotonic_nanos": 1_000_000_000_000_u64,
            "swapouts": COUNT,
        })
    );
    let metadata = fs::symlink_metadata(home.file()).unwrap();
    assert!(metadata.file_type().is_file());
    assert_eq!(metadata.mode() & 0o7777, 0o600);
    assert_eq!(metadata.nlink(), 1);
    assert_eq!(home.file().file_name().unwrap(), "admission-opening.json");
    // The write left no pending file behind.
    assert!(!home.file().with_extension("pending").exists());
    // A later sample replaces it whole.
    clock.advance(Duration::from_secs(7));
    assert!(record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT + 3),
        host.now()
    ));
    assert_eq!(home.record().unwrap()["swapouts"], COUNT + 3);
    assert_eq!(
        home.record().unwrap()["monotonic_nanos"],
        1_007_000_000_000_u64
    );
    assert_eq!(
        fs::symlink_metadata(home.file()).unwrap().mode() & 0o7777,
        0o600
    );
}

#[test]
fn only_a_sample_that_passes_every_predicate_on_its_own_is_recorded() {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    for defect in 0..7 {
        let mut sample = passing(COUNT);
        match defect {
            0 => sample.free_plus_file_cache_estimate_bytes = Some(10 * GIB - 1),
            1 => sample.memory_pressure = MemoryPressure::from_level(Some(4)),
            2 => sample.swapouts = None,
            3 => sample.thermal_normal = false,
            4 => sample.host_supported = false,
            5 => sample.profile = Profile::Research,
            _ => {
                sample.admitted = false;
                sample.reasons.push("disk budget".into());
            }
        }
        assert!(
            !record(&home.root, &home.lease, &host, &sample, host.now()),
            "{defect}"
        );
        assert_eq!(home.record(), None, "{defect}");
    }
    // A failing sample leaves an earlier record as it was.
    usable(&home);
    let before = home.record();
    let mut failing = passing(COUNT + 1);
    failing.thermal_normal = false;
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &failing,
        host.now()
    ));
    assert_eq!(home.record(), before);
    // So does a passing sample with no time or no boot session to bind it to.
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT + 1),
        None
    ));
    *host.boot.borrow_mut() = None;
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT + 1),
        host.now()
    ));
    *host.boot.borrow_mut() = Some("not-a-session".into());
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT + 1),
        host.now()
    ));
    assert_eq!(home.record(), before);
}

#[test]
fn an_interrupted_write_does_not_block_the_next_record() {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    let pending = home.file().with_extension("pending");
    // A writer that died between creating its pending file and renaming it.
    fs::write(&pending, b"{").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT),
        host.now()
    ));
    assert!(!pending.exists());
    assert_eq!(home.record().unwrap()["swapouts"], COUNT);
    // A pending path that is not a private file of this user is left alone, and the write
    // fails quietly: the earlier record stays.
    let target = home.root.join("kept");
    fs::write(&target, b"kept").unwrap();
    std::os::unix::fs::symlink(&target, &pending).unwrap();
    assert!(!record(
        &home.root,
        &home.lease,
        &host,
        &passing(COUNT + 1),
        host.now()
    ));
    assert_eq!(fs::read(&target).unwrap(), b"kept");
    assert!(fs::symlink_metadata(&pending).unwrap().is_symlink());
    assert_eq!(home.record().unwrap()["swapouts"], COUNT);
}

#[test]
fn a_stop_records_a_passing_sample_and_a_failing_one_changes_nothing() {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    // Passes: recorded with the time of the sample.
    assert!(record_at_stop(
        &home.root,
        &home.lease,
        &host,
        Profile::Development,
        || Ok(passing(COUNT))
    ));
    let written = home.record().unwrap();
    assert_eq!(written["swapouts"], COUNT);
    assert_eq!(written["monotonic_nanos"], 1_000_000_000_000_u64);
    // Fails a predicate: nothing is written, and the earlier record stays.
    clock.advance(Duration::from_secs(5));
    let mut failing = passing(COUNT + 1);
    failing.memory_pressure = MemoryPressure::from_level(Some(4));
    assert!(!record_at_stop(
        &home.root,
        &home.lease,
        &host,
        Profile::Development,
        || Ok(failing)
    ));
    assert_eq!(home.record().unwrap(), written);
    // Cannot be taken: nothing is written, and the stop is told nothing went wrong.
    assert!(!record_at_stop(
        &home.root,
        &home.lease,
        &host,
        Profile::Development,
        || Err(CandidateError::new("admission_unavailable", "fixture"))
    ));
    assert_eq!(home.record().unwrap(), written);
    // On a home with no record, a failing stop sample leaves none.
    let empty = Home::new();
    assert!(!record_at_stop(
        &empty.root,
        &empty.lease,
        &host,
        Profile::Development,
        || Err(CandidateError::new("admission_unavailable", "fixture"))
    ));
    assert_eq!(empty.record(), None);
    // The start that follows the stop a window later reuses what the stop recorded.
    let home = Home::new();
    let run = start_with(
        &home,
        Reuse::parse(None).unwrap(),
        LEASE,
        |home, host| {
            host.clock.now.set(FIRST - Duration::from_secs(2));
            assert!(record_at_stop(
                &home.root,
                &home.lease,
                host,
                Profile::Development,
                || Ok(passing(COUNT))
            ));
            host.clock.now.set(FIRST);
        },
        |_| {},
        |_| Ok(passing(COUNT)),
    );
    run.reused(COUNT);
}

#[test]
fn the_bound_setting_is_whole_seconds_up_to_ten_minutes_and_anything_else_is_refused() {
    assert_eq!(Reuse::parse(None).unwrap(), Reuse(Duration::from_secs(60)));
    assert_eq!(
        Reuse::parse(Some("")).unwrap(),
        Reuse(Duration::from_secs(60))
    );
    for (text, seconds) in [
        ("0", 0),
        ("1", 1),
        ("60", 60),
        ("0060", 60),
        ("599", 599),
        ("600", 600),
        ("000600", 600),
    ] {
        assert_eq!(
            Reuse::parse(Some(text)).unwrap(),
            Reuse(Duration::from_secs(seconds)),
            "{text}"
        );
    }
    // A value above the maximum is refused with the range in the message, never clamped.
    for text in [
        "on", "off", "auto", "60s", "1.5", "-1", "+1", " 60", "60 ", "1e3", "0x10", "601", "3600",
        "999999", "1000000", "\u{fffd}", "٦٠",
    ] {
        let error = Reuse::parse(Some(text)).unwrap_err();
        assert_eq!(error.code, "admission_reuse_setting", "{text:?}");
        assert!(error.message.contains(SETTING), "{text:?}");
        assert!(error.message.contains("from 0 to 600"), "{text:?}");
    }
}

#[test]
fn the_running_host_names_its_boot_and_reads_a_clock() {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return;
    }
    let session = System.boot_session().expect("a boot session");
    assert!(canonical_session(&session), "{session}");
    assert_eq!(System.boot_session(), Some(session));
    let (first, second) = (System.now().unwrap(), System.now().unwrap());
    assert!(second >= first);
    assert!(!first.is_zero());
}

/// What `runtime down` pays for its sample: the host probe and one record write. Run with
/// `--ignored --nocapture`. It runs the same three host commands every admission sample
/// runs, and starts no VM.
#[test]
#[ignore = "bench: prints the time of the sample and record a stop takes"]
fn bench_the_sample_and_record_of_a_stop() {
    fn time(label: &str, mut work: impl FnMut()) {
        const RUNS: usize = 21;
        work();
        let mut samples: Vec<Duration> = (0..RUNS)
            .map(|_| {
                let started = std::time::Instant::now();
                work();
                started.elapsed()
            })
            .collect();
        samples.sort();
        println!(
            "{label}: median {:?}, min {:?}, max {:?} over {RUNS} runs",
            samples[RUNS / 2],
            samples[0],
            samples[RUNS - 1],
        );
    }
    let home = Home::new();
    let checkout = std::env::temp_dir();
    time("host sample (vm_stat, sysctl, pmset)", || {
        std::hint::black_box(super::super::probe_for(&checkout, Profile::Development).unwrap());
    });
    time(
        "record write (boot session, clock, atomic private file)",
        || {
            std::hint::black_box(record(
                &home.root,
                &home.lease,
                &System,
                &passing(COUNT),
                System.now(),
            ));
        },
    );
    time("record read and judgement", || {
        let opening = Opening::new(&home.root, &System, Reuse::parse(None).unwrap());
        std::hint::black_box(opening.judge().err());
    });
    time("sample and record, as a stop runs them", || {
        std::hint::black_box(record_at_stop(
            &home.root,
            &home.lease,
            &System,
            Profile::Development,
            || super::super::probe_for(&checkout, Profile::Development),
        ));
    });
}

#[test]
fn a_record_written_as_a_list_of_its_three_values_is_a_miss() {
    // The derived decoder would read these positions as the three fields.
    for bytes in [
        format!(
            r#"["{BOOT}",{},{COUNT}]"#,
            (FIRST - Duration::from_secs(10)).as_nanos()
        ),
        format!(
            "  \n[\"{BOOT}\", {}, {COUNT}]\n",
            (FIRST - Duration::from_secs(10)).as_nanos()
        ),
    ] {
        let home = Home::new();
        let run = start(&home, |home, _| home.holds_bytes(bytes.as_bytes()));
        run.took_the_path_without_a_record();
    }
    // The same values as an object are a record: the list is what is refused.
    let home = Home::new();
    let run = start(&home, |home, _| {
        home.holds_bytes(
            format!(
                r#"{{"boot_session":"{BOOT}","monotonic_nanos":{},"swapouts":{COUNT}}}"#,
                (FIRST - Duration::from_secs(10)).as_nanos()
            )
            .as_bytes(),
        );
    });
    run.reused(COUNT);
}

/// A start whose sample under the lease takes `sampling` to come back, on a home whose
/// record is `age` old when the lease is taken. Returns the start's outcome, the times
/// it asked the host for a sample, and how long it slept.
fn start_with_a_slow_sample(
    age: Duration,
    sampling: Duration,
    clock_readable_after: bool,
) -> (Result<Leased, CandidateError>, Vec<Duration>, Duration) {
    let home = Home::new();
    let clock = TestClock::at(FIRST);
    let host = TestHost::on(&clock);
    home.holds(BOOT, FIRST + LEASE - age, COUNT);
    let asked = RefCell::new(Vec::new());
    let window = open(&passing(COUNT), &clock).unwrap();
    clock.advance(LEASE);
    let opening = Opening::new(&home.root, &host, Reuse::parse(None).unwrap());
    let leased = recheck_after_lease(Profile::Development, Some(window), &clock, &opening, || {
        asked.borrow_mut().push(clock.now());
        if asked.borrow().len() == 1 {
            // The first sample under the lease is the one taken for a reuse.
            clock.advance(sampling);
            host.clock_readable.set(clock_readable_after);
        }
        Ok(passing(COUNT))
    });
    (leased, asked.take(), clock.slept.borrow().iter().sum())
}

#[test]
fn a_record_that_passes_the_bound_while_the_sample_is_taken_does_not_replace_the_wait() {
    let bound = Duration::from_secs(60);
    // Inside the bound when it was read and when the sample came back: reused.
    let (leased, asked, slept) = start_with_a_slow_sample(
        bound - Duration::from_millis(300),
        Duration::from_millis(200),
        true,
    );
    let leased = leased.unwrap();
    assert_eq!(leased.reused, Some(true));
    assert_eq!(asked, [FIRST + LEASE]);
    assert_eq!(slept, Duration::ZERO);
    assert_eq!(
        leased.sampled_at,
        Some(FIRST + LEASE + Duration::from_millis(200))
    );
    // Inside the bound when it was read, past it when the sample came back (a slow probe
    // or a host that slept): the early sample is discarded and the start takes the path
    // without a record. It is not refused.
    let sampling = Duration::from_millis(200);
    let (leased, asked, slept) =
        start_with_a_slow_sample(bound - Duration::from_millis(100), sampling, true);
    let leased =
        leased.unwrap_or_else(|error| panic!("a miss refused the start: {}", error.message));
    assert_eq!(leased.reused, Some(false));
    assert_eq!(asked, [FIRST + LEASE, FIRST + DEVELOPMENT_WINDOW]);
    assert_eq!(slept, DEVELOPMENT_WINDOW - LEASE - sampling);
    assert_eq!(leased.samples.len(), 1);
    assert_eq!(leased.samples[0].swapouts, Some(COUNT));
    // A host sleep of an hour inside the probe is the same miss, and nothing is left to wait.
    let (leased, asked, slept) =
        start_with_a_slow_sample(Duration::from_secs(10), Duration::from_secs(3600), true);
    let leased = leased.unwrap();
    assert_eq!(leased.reused, Some(false));
    assert_eq!(
        asked,
        [FIRST + LEASE, FIRST + LEASE + Duration::from_secs(3600)]
    );
    assert_eq!(slept, Duration::ZERO);
}

#[test]
fn a_clock_that_cannot_be_read_once_the_sample_exists_does_not_replace_the_wait() {
    let sampling = Duration::from_millis(50);
    let (leased, asked, slept) = start_with_a_slow_sample(Duration::from_secs(10), sampling, false);
    let leased =
        leased.unwrap_or_else(|error| panic!("a miss refused the start: {}", error.message));
    assert_eq!(leased.reused, Some(false));
    assert_eq!(asked, [FIRST + LEASE, FIRST + DEVELOPMENT_WINDOW]);
    assert_eq!(slept, DEVELOPMENT_WINDOW - LEASE - sampling);
    // No time to record the sample with: the caller writes no record for it.
    assert_eq!(leased.sampled_at, None);
}
