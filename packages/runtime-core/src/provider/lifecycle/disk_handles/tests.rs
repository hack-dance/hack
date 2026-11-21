use super::*;
use crate::provider::test_executable::{ISOLATED_HANG_GUARD, LOADED_HOST_SCAN_WAIT, run_isolated};
use std::cell::{Cell, RefCell};
use std::fs::{File, OpenOptions};
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;
use std::rc::Rc;

/// Real `lsof` scans in this test binary run one at a time across every test process
/// (isolated children included), and each scan's bound starts once it holds the turn.
/// Concurrent whole-host scans on a loaded host are what made these tests time out; a
/// lone scan stays far inside the bounds above. The lock is released explicitly, so a
/// copy of the descriptor in an unrelated fork cannot keep it held.
pub(super) struct ScanSerial(File);

impl ScanSerial {
    pub(super) fn acquire() -> Self {
        use std::os::fd::AsRawFd;
        let path = std::env::temp_dir()
            .join(format!("hack-runtime-core-lsof-scan-{}.lock", unsafe {
                libc::geteuid()
            }));
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .expect("open the test lsof scan lock");
        // SAFETY: the descriptor is live for this call.
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        Self(file)
    }

    pub(super) fn hold(self, running: process::Running) -> Serialized {
        Serialized {
            running,
            _serial: self,
        }
    }
}

impl Drop for ScanSerial {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the descriptor is live through this Drop call.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// A real `lsof` scan that keeps the serial turn until it completes or expires.
pub(super) struct Serialized {
    running: process::Running,
    _serial: ScanSerial,
}

impl Pending for Serialized {
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
        self.running.poll()
    }
    fn expire(&mut self) -> CandidateError {
        self.running.expire()
    }
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        self.running.wait(limit, clock)
    }
}

/// A clock that moves only when the code under test sleeps. It refuses to pass an hour,
/// so a wait that never expires fails the test instead of spinning. With an oversleep,
/// the first sleep that starts at or after `from` wakes at `until` instead, as a waiter
/// descheduled on a loaded host would.
#[derive(Default)]
struct FakeClock {
    now: Cell<Duration>,
    oversleep: Cell<Option<(Duration, Duration)>>,
}

const RUNAWAY: Duration = Duration::from_secs(3600);

impl FakeClock {
    fn oversleeping(from: Duration, until: Duration) -> Self {
        assert!(until > from);
        Self {
            now: Cell::default(),
            oversleep: Cell::new(Some((from, until))),
        }
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        self.now.get()
    }
    fn sleep(&self, duration: Duration) {
        let mut next = self.now.get() + duration;
        if let Some((from, until)) = self.oversleep.get()
            && self.now.get() >= from
        {
            self.oversleep.set(None);
            next = next.max(until);
        }
        assert!(next <= RUNAWAY, "the disk-handle wait never expired");
        self.now.set(next);
    }
}

/// What one fake scan reports and how long it takes on the fake clock.
#[derive(Clone, Copy)]
struct Outcome {
    /// `None`: the scan never finishes on its own.
    takes: Option<Duration>,
    /// The scan saw a process holding a disk.
    holder: bool,
    /// The scan could not answer for some process.
    unknown: bool,
}

impl Outcome {
    /// A scan that saw no holder and could answer for every process.
    fn no_holder(takes: Duration) -> Self {
        Self {
            takes: Some(takes),
            holder: false,
            unknown: false,
        }
    }
    fn hangs() -> Self {
        Self {
            takes: None,
            ..Self::no_holder(Duration::ZERO)
        }
    }
    fn found(self, disks: &[PathBuf]) -> Found {
        let holder = || Holder {
            pid: 4242,
            hold: Hold::Descriptor,
            disk: Some(disks[0].clone()),
            name: None,
        };
        Found {
            holders: self.holder.then(holder).into_iter().collect(),
            unknown: self
                .unknown
                .then(|| "process 4242: descriptor list: fake error".to_owned())
                .into_iter()
                .collect(),
        }
    }
}

#[derive(Default)]
struct Record {
    disks: Vec<PathBuf>,
    expired: bool,
}

struct FakeProbe {
    clock: Rc<FakeClock>,
    outcome: Outcome,
    record: Rc<RefCell<Record>>,
}

struct FakeScan {
    clock: Rc<FakeClock>,
    started: Duration,
    outcome: Outcome,
    record: Rc<RefCell<Record>>,
}

impl HandleProbe for FakeProbe {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        self.record.borrow_mut().disks = disks.to_vec();
        Ok(Box::new(FakeScan {
            clock: self.clock.clone(),
            started: self.clock.now(),
            outcome: self.outcome,
            record: self.record.clone(),
        }))
    }
}

impl Pending<Found> for FakeScan {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        let done = self
            .outcome
            .takes
            .is_some_and(|takes| self.clock.now() - self.started >= takes);
        Ok(done.then(|| self.outcome.found(&self.record.borrow().disks)))
    }
    fn expire(&mut self) -> CandidateError {
        self.record.borrow_mut().expired = true;
        CandidateError::new("provider_timeout_uncertain", "fake scan expired")
    }
}

struct Run {
    result: Result<(), CandidateError>,
    elapsed: Duration,
    record: Record,
}

fn fake_scan(outcome: Outcome, wait: Duration) -> Run {
    fake_scan_on(FakeClock::default(), outcome, wait)
}

fn fake_scan_on(clock: FakeClock, outcome: Outcome, wait: Duration) -> Run {
    let clock = Rc::new(clock);
    let record = Rc::new(RefCell::new(Record::default()));
    let probe = FakeProbe {
        clock: clock.clone(),
        outcome,
        record: record.clone(),
    };
    let result = disks_closed(&probe, clock.as_ref(), &disks(Path::new("/pool")), wait);
    let elapsed = clock.now();
    drop(probe);
    Run {
        result,
        elapsed,
        record: Rc::try_unwrap(record).ok().unwrap().into_inner(),
    }
}

fn disks(directory: &Path) -> Vec<PathBuf> {
    vec![directory.join("storage.raw"), directory.join("overlay.raw")]
}

fn code(result: &Result<(), CandidateError>) -> &'static str {
    result.as_ref().err().map_or("ok", |error| error.code)
}

/// Both bounds outlast a scan several times slower than the slowest one measured, so a
/// realistic loaded host does not make `down` or a release check uncertain.
#[test]
fn both_bounds_outlast_a_slow_loaded_host_scan() {
    let slow = SLOWEST_MEASURED_SCAN * 4;
    for (name, wait) in [("stop", STOP_HANDLE_WAIT), ("release", RELEASE_HANDLE_WAIT)] {
        let run = fake_scan(Outcome::no_holder(slow), wait);
        assert_eq!(
            code(&run.result),
            "ok",
            "{name} bound refused a {slow:?} scan"
        );
        assert!(!run.record.expired, "{name} bound expired a completed scan");
        assert!(run.elapsed >= slow && run.elapsed < slow + process::POLL_INTERVAL * 2);
        assert_eq!(run.record.disks, disks(Path::new("/pool")));
    }
}

/// Both bounds are finite: a scan that never finishes is expired (told to stop) at the
/// bound and reported as uncertain, never as released, and well within a minute.
#[test]
fn both_bounds_expire_a_hung_scan_as_uncertain_at_the_bound() {
    for (name, wait) in [("stop", STOP_HANDLE_WAIT), ("release", RELEASE_HANDLE_WAIT)] {
        assert!(
            wait <= Duration::from_secs(45),
            "{name} bound {wait:?} is too long"
        );
        let run = fake_scan(Outcome::hangs(), wait);
        assert_eq!(code(&run.result), "provider_timeout_uncertain", "{name}");
        assert!(run.record.expired, "{name} bound did not expire the scan");
        assert!(
            run.elapsed >= wait && run.elapsed < wait + process::POLL_INTERVAL * 2,
            "{name} bound {wait:?} expired after {:?}",
            run.elapsed
        );
    }
}

/// A scan that finishes just past the bound is still uncertain: a late "no holder" is
/// not accepted.
#[test]
fn a_scan_finishing_after_the_bound_is_uncertain() {
    for wait in [STOP_HANDLE_WAIT, RELEASE_HANDLE_WAIT] {
        let late = Outcome::no_holder(wait + process::POLL_INTERVAL * 3);
        let run = fake_scan(late, wait);
        assert_eq!(code(&run.result), "provider_timeout_uncertain");
        assert!(run.record.expired);
    }
}

/// A waiter that oversleeps across both the bound and the scan's completion finds a
/// finished scan only after the bound. That late "no holder" is refused as uncertain;
/// the scan already finished, so it is not expired.
#[test]
fn an_oversleep_across_the_bound_and_completion_refuses_the_late_result() {
    let ms = Duration::from_millis;
    for wait in [STOP_HANDLE_WAIT, RELEASE_HANDLE_WAIT] {
        let clock = FakeClock::oversleeping(wait - ms(10), wait + ms(50));
        let run = fake_scan_on(clock, Outcome::no_holder(wait + ms(20)), wait);
        assert_eq!(code(&run.result), "provider_timeout_uncertain");
        assert!(!run.record.expired, "a finished scan was expired");
        assert_eq!(run.elapsed, wait + ms(50));
    }
}

/// An oversleep that still wakes inside the bound accepts a scan that finished in it.
#[test]
fn an_oversleep_that_wakes_inside_the_bound_accepts_the_scan() {
    let ms = Duration::from_millis;
    for wait in [STOP_HANDLE_WAIT, RELEASE_HANDLE_WAIT] {
        let clock = FakeClock::oversleeping(wait - ms(60), wait - ms(20));
        let run = fake_scan_on(clock, Outcome::no_holder(wait - ms(30)), wait);
        assert_eq!(code(&run.result), "ok");
        assert_eq!(run.elapsed, wait - ms(20));
    }
}

/// The probe is replaceable but its answer is not trusted any less: only a scan that saw
/// no holder and could answer for every process proves the disks closed.
#[test]
fn only_a_scan_without_holder_or_unknown_proves_the_disks_closed() {
    let quick = Duration::from_millis(500);
    for (holder, unknown) in [(true, false), (false, true), (true, true)] {
        let outcome = Outcome {
            takes: Some(quick),
            holder,
            unknown,
        };
        let run = fake_scan(outcome, STOP_HANDLE_WAIT);
        assert_eq!(code(&run.result), "stop_uncertain", "{holder} {unknown}");
        assert!(run.result.unwrap_err().message_fixed);
        assert!(!run.record.expired);
    }
    assert_eq!(
        code(&fake_scan(Outcome::no_holder(quick), STOP_HANDLE_WAIT).result),
        "ok"
    );
}

/// A private scratch directory removed when the test ends.
pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn new() -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "hack-disk-handles-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        // Holders are reported under the name the kernel knows, which has no symlinks.
        Self(path.canonicalize().unwrap())
    }
    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn sparse_disks(directory: &Path) -> Vec<PathBuf> {
    let disks = disks(directory);
    for disk in &disks {
        File::create(disk).unwrap().set_len(1 << 30).unwrap();
    }
    disks
}

/// An `lsof` answer as a finished child would report it.
fn answer(code: i32, stdout: &[u8], stderr: &[u8]) -> Captured {
    Captured {
        status: ExitStatus::from_raw(code << 8),
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

/// A finished `lsof` child with a fixed answer.
struct Answered(Option<Captured>);

impl Pending for Answered {
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
        Ok(self.0.take())
    }
    fn expire(&mut self) -> CandidateError {
        CandidateError::new("provider_timeout_uncertain", "fake lsof expired")
    }
}

/// A probe whose `lsof` child has already answered.
struct AnsweredProbe(i32, &'static [u8], &'static [u8]);

impl HandleProbe for AnsweredProbe {
    fn start(&self, _disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        let listed = answer(self.0, self.1, self.2);
        Ok(Box::new(Listing::of(Answered(Some(listed)))))
    }
}

/// The `lsof` scan is trusted no more than before: only exit 1 with no output proves the
/// disks closed. A listed holder, a diagnostic and any other status all refuse.
#[test]
fn only_a_silent_no_holder_answer_from_lsof_proves_the_disks_closed() {
    let answers: [(i32, &[u8], &[u8]); 7] = [
        (0, b"4242\n", b""),
        (1, b"4242\n", b""),
        (1, b"", b"lsof: WARNING: can't stat()\n"),
        (0, b"", b""),
        (2, b"", b""),
        (0, b"4242\nnot a process id\n", b""),
        (0, b"\xff\n", b""),
    ];
    let clock = process::MonotonicClock::new();
    let pool = disks(Path::new("/pool"));
    for (status, stdout, stderr) in answers {
        let probe = AnsweredProbe(status, stdout, stderr);
        let result = disks_closed(&probe, &clock, &pool, STOP_HANDLE_WAIT);
        assert_eq!(code(&result), "stop_uncertain", "{status} {stdout:?}");
    }
    let silent = AnsweredProbe(1, b"", b"");
    let result = disks_closed(&silent, &clock, &pool, STOP_HANDLE_WAIT);
    assert_eq!(code(&result), "ok");
}

/// What `lsof` printed is read as process ids only when all of it is process ids from a
/// successful run; everything else is unknown as well.
#[test]
fn an_lsof_listing_is_read_as_its_process_ids() {
    let pids = |found: &Found| found.holders.iter().map(|h| h.pid).collect::<Vec<_>>();
    let listed = Found::listed(&answer(0, b"4242\n77\n", b""));
    assert_eq!(pids(&listed), [4242, 77]);
    assert!(listed.unknown.is_empty());
    assert!(listed.holders.iter().all(|h| h.hold == Hold::Listed));

    // Some named disk has no holder: `lsof` still lists the others' and exits 1.
    let partly = Found::listed(&answer(1, b"4242\n", b""));
    assert_eq!(pids(&partly), [4242]);
    assert!(partly.unknown.is_empty());

    let nothing = Found::listed(&answer(1, b"", b""));
    assert!(nothing.holders.is_empty() && nothing.unknown.is_empty());

    for status in [0, 2] {
        let silent = Found::listed(&answer(status, b"", b""));
        assert!(silent.holders.is_empty());
        assert_eq!(silent.unknown.len(), 1, "{status}");
    }
    let failed = Found::listed(&answer(2, b"4242\n", b""));
    assert_eq!(pids(&failed), [4242]);
    assert_eq!(failed.unknown.len(), 1);

    let warned = Found::listed(&answer(0, b"4242\n", b"lsof: WARNING\n"));
    assert_eq!(pids(&warned), [4242]);
    assert_eq!(warned.unknown.len(), 1);

    let garbled = Found::listed(&answer(0, b"4242\nPID\n", b""));
    assert!(garbled.holders.is_empty());
    assert_eq!(garbled.unknown.len(), 1);
}

/// The host `lsof` this test binary can run, from the locations the fallback tries. macOS
/// must have it.
pub(super) fn host_lsof() -> Option<PathBuf> {
    let found = LSOF
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file());
    assert!(
        found.is_some() || !cfg!(target_os = "macos"),
        "macOS hosts must provide lsof"
    );
    if found.is_none() {
        println!("skipping: no lsof on this host");
    }
    found
}

/// Run one ignored fixture under this module (`tests::<name>`, `macos::tests::<name>`)
/// alone in a child test process, so that nothing else in the test process can hold or map
/// what the fixture scans for.
pub(super) fn isolated(fixture: &str) {
    run_isolated(
        &format!("provider::lifecycle::disk_handles::{fixture}"),
        ISOLATED_HANG_GUARD,
    );
}

/// The fallback finds the same `lsof` the tests found, and refuses when there is none.
#[test]
fn the_fallback_resolves_lsof_from_its_known_locations() {
    match host_lsof() {
        Some(lsof) => assert_eq!(Lsof::host().unwrap().executable, lsof),
        None => assert_eq!(Lsof::host().err().unwrap().code, "provider_spawn_failed"),
    }
}

/// The real `lsof` still finds a disk this process holds open, through the same
/// interpretation and the stop path's bound.
#[test]
fn host_lsof_finds_a_held_disk() {
    let Some(lsof) = host_lsof() else { return };
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let _held = File::open(&disks[1]).unwrap();
    let result = disks_closed(
        &Lsof::at(&lsof),
        &process::MonotonicClock::new(),
        &disks,
        LOADED_HOST_SCAN_WAIT,
    );
    assert_eq!(code(&result), "stop_uncertain");
}

/// The real `lsof` proves closed disks closed. It runs alone in a child process: in the
/// shared test process an unrelated test's pre-exec fork can briefly hold a copy of the
/// disk descriptors this fixture just closed.
#[test]
fn host_lsof_proves_closed_disks_closed() {
    if host_lsof().is_none() {
        return;
    }
    isolated("tests::host_lsof_closed_disks_child");
}

#[test]
#[ignore = "isolated real-lsof fixture launched by host_lsof_proves_closed_disks_closed"]
fn host_lsof_closed_disks_child() {
    let lsof = host_lsof().expect("parent checked for lsof");
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let result = disks_closed(
        &Lsof::at(&lsof),
        &process::MonotonicClock::new(),
        &disks,
        LOADED_HOST_SCAN_WAIT,
    );
    assert_eq!(code(&result), "ok", "{:?}", result.as_ref().err());
}

/// An `lsof` child that counts how often it is expired. Its poll fails, answers or finds
/// the child still running, as the test sets it.
struct Counted {
    polls: Result<Option<()>, ()>,
    expired: Rc<Cell<u32>>,
}

impl Pending for Counted {
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
        match self.polls {
            Ok(answered) => Ok(answered.map(|()| answer(1, b"", b""))),
            Err(()) => Err(CandidateError::new(
                "provider_wait_failed",
                "fake wait failed",
            )),
        }
    }
    fn expire(&mut self) -> CandidateError {
        self.expired.set(self.expired.get() + 1);
        CandidateError::new("provider_timeout_uncertain", "fake lsof expired")
    }
}

/// An `lsof` child never loses its owner without being stopped and reaped: a wrapper
/// dropped after a failed poll, or while the child still runs (an owner that unwinds),
/// expires the child. One that answered, or that was already expired, is left alone.
#[test]
fn an_lsof_child_dropped_unsettled_is_expired() {
    let expirations = |polls: Result<Option<()>, ()>, also_expire: bool| {
        let expired = Rc::new(Cell::new(0));
        let mut listing = Listing::of(Counted {
            polls,
            expired: expired.clone(),
        });
        let polled = listing.poll();
        assert_eq!(polled.is_err(), polls.is_err());
        if also_expire {
            let _ = listing.expire();
        }
        drop(listing);
        expired.get()
    };
    assert_eq!(expirations(Err(()), false), 1, "after a failed poll");
    assert_eq!(expirations(Ok(None), false), 1, "while the child runs");
    assert_eq!(expirations(Ok(None), true), 1, "expired once, not twice");
    assert_eq!(expirations(Ok(Some(())), false), 0, "after it answered");
}

/// A host scan whose choice of method and whose `lsof` are the given stand-ins.
fn host_scan_with(
    decide: Decide,
    locate: impl Fn() -> Result<Lsof, CandidateError> + Send + Sync + 'static,
) -> HostScan {
    HostScan {
        decide,
        locate: Arc::new(locate),
    }
}

fn left_to_lsof(_: &[PathBuf], _: &AtomicBool) -> Result<Found, Fallback> {
    Err(Fallback::ScanIncomplete)
}

/// Gives the scan to `lsof` only once the caller has given up.
fn left_to_lsof_too_late(_: &[PathBuf], stop: &AtomicBool) -> Result<Found, Fallback> {
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(1));
    }
    Err(Fallback::ScanIncomplete)
}

/// A stand-in `lsof` that says it started, by writing its process id beside itself, and
/// then does `then`.
fn standing_in_for_lsof(directory: &Path, then: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let (script, started) = (directory.join("lsof"), directory.join("lsof.pid"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho $$ > \"$0.pid\"\n{then}\n"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    (script, started)
}

/// The process id a stand-in `lsof` wrote, once it has started.
fn started_child(started: &Path) -> i32 {
    let begun = std::time::Instant::now();
    loop {
        let pid = std::fs::read_to_string(started)
            .ok()
            .and_then(|pid| pid.trim().parse::<i32>().ok());
        if let Some(pid) = pid {
            return pid;
        }
        assert!(begun.elapsed() < ISOLATED_HANG_GUARD, "lsof never started");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Whether a child of this test process still exists, running or as a zombie.
fn exists(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether this test's own child still exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Every entry under `directory`, by its path from there.
fn entries(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![directory.to_owned()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path.clone());
            }
            found.push(path.strip_prefix(directory).unwrap().to_owned());
        }
    }
    found.sort();
    found
}

/// A scan leaves the pool's directory exactly as it found it: it creates, renames and
/// removes nothing there, while it runs or after it has answered. So a pool directory may
/// be removed or set aside the moment a scan returns.
#[test]
fn a_scan_leaves_the_pool_directory_as_it_found_it() {
    if host_lsof().is_none() {
        return;
    }
    let pool = Scratch::new();
    let data = pool.path().join("run/smolvm/data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(pool.path().join("run/smolvm/owner.json"), b"{}").unwrap();
    let disks = sparse_disks(&data);
    let before = entries(pool.path());
    assert_eq!(before.len(), 6);
    let scans = [
        (HostScan::host(), true),
        (HostScan::host(), false),
        // And through the fallback, whatever this platform's own scan is.
        (host_scan_with(left_to_lsof, Lsof::host), true),
    ];
    for (probe, held) in scans {
        let _held = held.then(|| File::open(&disks[0]).unwrap());
        let result = disks_closed(
            &probe,
            &process::MonotonicClock::new(),
            &disks,
            LOADED_HOST_SCAN_WAIT,
        );
        assert!(!held || code(&result) == "stop_uncertain", "{result:?}");
        assert_eq!(entries(pool.path()), before);
        // Nothing trails the answer either.
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(entries(pool.path()), before);
    }
}

/// `runtime status` reports the method a scan started now would use, computed by the
/// scan's own self-test: the scan in this process on macOS, `lsof` with its reason
/// everywhere else. Each method and reason has its documented name.
#[test]
fn status_reports_the_method_a_scan_would_use_now() {
    let json = |report: MethodReport| serde_json::to_string(&report).unwrap();
    let now = method_now();
    assert_eq!(now, method().into());
    if cfg!(target_os = "macos") {
        // Fails with the self-test on a kernel that no longer passes it; see the macOS
        // test `this_kernel_passes_the_mapping_self_test` for what that means.
        assert_eq!(json(now), r#"{"method":"in-process"}"#);
    } else {
        assert_eq!(
            json(now),
            r#"{"method":"lsof","reason":"not_built_for_this_platform"}"#
        );
    }
    let reasons = [
        (
            Fallback::NotBuiltForThisPlatform,
            "not_built_for_this_platform",
        ),
        (Fallback::QueryUnanswered, "query_unanswered"),
        (Fallback::SelfTestFailed, "self_test_failed"),
        (Fallback::SelfTestUnavailable, "self_test_unavailable"),
    ];
    for (reason, name) in reasons {
        assert_eq!(
            json(Method::Lsof(reason).into()),
            format!(r#"{{"method":"lsof","reason":"{name}"}}"#)
        );
    }
    assert_eq!(json(Method::InProcess.into()), r#"{"method":"in-process"}"#);
}

/// A host scan that must be left to `lsof` is: the `lsof` child answers, and what it
/// lists is the result.
#[test]
fn a_scan_left_to_lsof_is_answered_by_lsof() {
    if host_lsof().is_none() {
        return;
    }
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let _held = File::open(&disks[1]).unwrap();
    let probe = host_scan_with(left_to_lsof, Lsof::host);
    let mut scan = probe.start(&disks).unwrap();
    let clock = process::MonotonicClock::new();
    let found = process::wait_within(scan.as_mut(), LOADED_HOST_SCAN_WAIT, &clock).unwrap();
    let own = i32::try_from(std::process::id()).unwrap();
    assert!(
        found
            .holders
            .iter()
            .any(|held| held.pid == own && held.hold == Hold::Listed),
        "{found:?}"
    );
}

/// A fallback that cannot be started refuses as `provider_spawn_failed`.
#[test]
fn an_lsof_that_cannot_be_started_refuses() {
    let directory = Scratch::new();
    let missing = directory.path().join("no-lsof-here");
    let unfound = || Err(CandidateError::new("provider_spawn_failed", "no lsof"));
    let unstartable = move || Ok(Lsof::at(&missing));
    for probe in [
        host_scan_with(left_to_lsof, unfound),
        host_scan_with(left_to_lsof, unstartable),
    ] {
        let result = disks_closed(
            &probe,
            &process::MonotonicClock::new(),
            &disks(Path::new("/pool")),
            LOADED_HOST_SCAN_WAIT,
        );
        assert_eq!(code(&result), "provider_spawn_failed");
    }
}

/// Starting a host scan does none of its work: the method is chosen and the scan made on
/// the scan's thread, inside the caller's bound. A choice that does not return in time
/// ends as a timeout at the bound instead of hanging the stop, and no `lsof` is looked
/// for on behalf of a caller that has already given up.
#[test]
fn a_fallback_due_after_the_bound_starts_no_lsof() {
    let looked = Arc::new(AtomicBool::new(false));
    let seen = looked.clone();
    let probe = host_scan_with(left_to_lsof_too_late, move || {
        seen.store(true, Ordering::Relaxed);
        Lsof::host()
    });
    let started = std::time::Instant::now();
    let result = disks_closed(
        &probe,
        &process::MonotonicClock::new(),
        &disks(Path::new("/pool")),
        Duration::from_millis(200),
    );
    assert_eq!(code(&result), "provider_timeout_uncertain");
    assert!(started.elapsed() < Duration::from_secs(20));
    std::thread::sleep(Duration::from_millis(100));
    assert!(!looked.load(Ordering::Relaxed), "lsof was looked for");
}

/// A lookup of `lsof` that outlasts the caller's bound does not stretch the caller's wait,
/// and the child is not started once the lookup returns.
#[test]
fn an_lsof_lookup_that_outlasts_the_bound_starts_no_child() {
    let directory = Scratch::new();
    let (script, child_started) = standing_in_for_lsof(directory.path(), "exec /bin/sleep 600");
    let probe = host_scan_with(left_to_lsof, move || {
        std::thread::sleep(Duration::from_millis(600));
        Ok(Lsof::at(&script))
    });
    let started = std::time::Instant::now();
    let result = disks_closed(
        &probe,
        &process::MonotonicClock::new(),
        &disks(Path::new("/pool")),
        Duration::from_millis(100),
    );
    assert_eq!(code(&result), "provider_timeout_uncertain");
    // The bound, then the moment the caller gives the thread to stop; not the lookup.
    assert!(started.elapsed() < Duration::from_millis(100) + REAP_GRACE * 2);
    std::thread::sleep(Duration::from_millis(900));
    assert!(!child_started.exists(), "a child was started for nobody");
}

/// An `lsof` child that is running when the caller's bound expires is killed and reaped
/// by the thread that started it. A child whose start straddles the expiry takes the same
/// path: the thread looks before its first wait.
#[test]
fn an_lsof_child_running_at_the_bound_is_killed_and_reaped() {
    let directory = Scratch::new();
    let (script, child_started) = standing_in_for_lsof(directory.path(), "exec /bin/sleep 600");
    let probe = host_scan_with(left_to_lsof, move || Ok(Lsof::at(&script)));
    let mut scan = probe.start(&disks(Path::new("/pool"))).unwrap();
    // Wait for the child itself, so the bound certainly expires while it runs.
    assert!(scan.poll().unwrap().is_none());
    let child = started_child(&child_started);
    assert!(exists(child));
    assert_eq!(scan.expire().code, "provider_timeout_uncertain");
    // Gone, not a zombie: reaped by the thread within the moment `expire` gave it.
    let started = std::time::Instant::now();
    while exists(child) {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the child outlived the scan"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// An answer the caller finds only after its bound is refused as late, and nothing is
/// left behind by it: the scan's thread sends its answer last, after the `lsof` child that
/// produced it has exited and been reaped. No cancellation is needed on that path because
/// nothing is running any more.
#[test]
fn a_late_answer_leaves_nothing_running() {
    let directory = Scratch::new();
    // Says it started, then answers "nothing found" as `lsof` does.
    let (script, child_started) = standing_in_for_lsof(directory.path(), "exit 1");
    let probe = host_scan_with(left_to_lsof, move || Ok(Lsof::at(&script)));
    let mut scan = probe.start(&disks(Path::new("/pool"))).unwrap();
    // A caller that oversleeps past its bound: the answer is there before it looks.
    let child = started_child(&child_started);
    let begun = std::time::Instant::now();
    while exists(child) {
        assert!(begun.elapsed() < ISOLATED_HANG_GUARD, "lsof never ended");
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(100));
    let clock = process::MonotonicClock::new();
    let late = process::wait_within(scan.as_mut(), Duration::ZERO, &clock);
    assert_eq!(late.err().unwrap().code, "provider_timeout_uncertain");
    drop(scan);
    assert!(!exists(child), "the child was not reaped");
}

/// A scan whose thread dies without an answer is refused, never read as "no holder".
#[test]
fn a_scan_thread_that_panics_is_refused() {
    fn panics(_: &[PathBuf], _: &AtomicBool) -> Result<Found, Fallback> {
        panic!("the scan thread panics on purpose");
    }
    let result = disks_closed(
        &host_scan_with(panics, Lsof::host),
        &process::MonotonicClock::new(),
        &disks(Path::new("/pool")),
        LOADED_HOST_SCAN_WAIT,
    );
    assert_eq!(code(&result), "stop_uncertain");
}

/// The real host scan is expired at its bound like any other: with no time at all it ends
/// as `provider_timeout_uncertain`, whether or not its thread had already answered.
#[test]
fn the_host_scan_past_its_bound_is_uncertain() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let result = disks_closed(
        &HostScan::host(),
        &process::MonotonicClock::new(),
        &disks,
        Duration::ZERO,
    );
    assert_eq!(code(&result), "provider_timeout_uncertain");
}
