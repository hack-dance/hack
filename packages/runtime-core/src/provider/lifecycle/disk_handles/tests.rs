use super::*;
use crate::provider::test_executable::{ISOLATED_HANG_GUARD, LOADED_HOST_SCAN_WAIT, run_isolated};
use std::cell::{Cell, RefCell};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::rc::Rc;
use std::time::Instant;

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

/// One whole scan of this host, never stopped early.
fn host_scan(disks: &[PathBuf]) -> Found {
    scan(disks, &AtomicBool::new(false))
}

/// Every hold a scan saw, as `(pid, hold, disk)`.
fn holds(found: &Found) -> Vec<(i32, Hold, &Path)> {
    found
        .holders
        .iter()
        .map(|holder| {
            let disk = holder
                .disk
                .as_deref()
                .expect("an in-process hold names its disk");
            (holder.pid, holder.hold, disk)
        })
        .collect()
}

fn own_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap()
}

/// A child that holds whatever it was given as standard input, killed and reaped on drop.
struct Sleeper(Child);

impl Sleeper {
    fn holding(file: File) -> Self {
        // The command, and with it this process's copy of the descriptor, is dropped
        // when this statement ends: only the child holds the file afterwards.
        Self(
            Command::new("/bin/sleep")
                .arg("120")
                .stdin(Stdio::from(file))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    fn pid(&self) -> i32 {
        i32::try_from(self.0.id()).unwrap()
    }
    fn exit(mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}

impl Drop for Sleeper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The host scan finds a disk this process holds open, through the same interpretation
/// and the stop path's bound, and names this process as the holder.
#[test]
fn host_scan_finds_a_held_disk() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let _held = File::open(&disks[1]).unwrap();
    let result = disks_closed(
        &HostScan::unrecorded(),
        &process::MonotonicClock::new(),
        &disks,
        STOP_HANDLE_WAIT,
    );
    assert_eq!(code(&result), "stop_uncertain");
    let found = host_scan(&disks);
    assert!(
        holds(&found).contains(&(own_pid(), Hold::Descriptor, disks[1].as_path())),
        "{found:?}"
    );
    assert!(
        !holds(&found).iter().any(|(_, _, disk)| *disk == disks[0]),
        "{found:?}"
    );
}

/// The host scan proves closed disks closed within the stop path's bound. It runs alone in
/// a child process: in the shared test process an unrelated test's pre-exec fork can
/// briefly hold a copy of the disk descriptors this fixture just closed.
#[test]
fn host_scan_proves_closed_disks_closed() {
    isolated("host_scan_closed_disks_child");
}

#[test]
#[ignore = "isolated host-scan fixture launched by host_scan_proves_closed_disks_closed"]
fn host_scan_closed_disks_child() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let found = host_scan(&disks);
    assert!(
        found.holders.is_empty() && found.unknown.is_empty(),
        "{found:?}"
    );
    let result = disks_closed(
        &HostScan::unrecorded(),
        &process::MonotonicClock::new(),
        &disks,
        STOP_HANDLE_WAIT,
    );
    assert_eq!(code(&result), "ok", "{:?}", result.as_ref().err());
}

/// Run one ignored fixture of this module alone in a child test process, so its exact
/// holder lists cannot include another test's pre-exec fork.
fn isolated(fixture: &str) {
    run_isolated(
        &format!("provider::lifecycle::disk_handles::tests::{fixture}"),
        ISOLATED_HANG_GUARD,
    );
}

/// Another process that holds a disk open is found by the disk's device and inode and
/// reported with its pid, and is no longer found once it has exited.
#[test]
fn a_child_holding_a_disk_is_found_until_it_exits() {
    isolated("child_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_child_holding_a_disk_is_found_until_it_exits"]
fn child_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    assert_eq!(holds(&host_scan(&disks)), []);

    let child = Sleeper::holding(File::open(&disks[1]).unwrap());
    let found = host_scan(&disks);
    assert_eq!(
        holds(&found),
        [(child.pid(), Hold::Descriptor, disks[1].as_path())],
        "{found:?}"
    );
    assert_eq!(found.holders[0].name.as_deref(), Some(disks[1].as_path()));
    assert_eq!(found.unknown, [] as [String; 0]);
    let refused = disks_closed(
        &HostScan::unrecorded(),
        &process::MonotonicClock::new(),
        &disks,
        STOP_HANDLE_WAIT,
    );
    assert_eq!(code(&refused), "stop_uncertain");

    child.exit();
    let found = host_scan(&disks);
    assert!(
        found.holders.is_empty() && found.unknown.is_empty(),
        "{found:?}"
    );
}

/// A holder is found whatever name it opened the disk by: through a hard link, after that
/// link is renamed, and after it is removed. A path comparison would miss all three.
#[test]
fn a_disk_held_through_another_name_is_found() {
    isolated("other_name_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_disk_held_through_another_name_is_found"]
fn other_name_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let link = directory.path().join("linked.raw");
    std::fs::hard_link(&disks[0], &link).unwrap();
    let child = Sleeper::holding(File::open(&link).unwrap());
    let expected = [(child.pid(), Hold::Descriptor, disks[0].as_path())];

    let found = host_scan(&disks);
    assert_eq!(holds(&found), expected, "through a hard link: {found:?}");

    let moved = directory.path().join("moved.raw");
    std::fs::rename(&link, &moved).unwrap();
    let found = host_scan(&disks);
    assert_eq!(holds(&found), expected, "after a rename: {found:?}");

    std::fs::remove_file(&moved).unwrap();
    let found = host_scan(&disks);
    assert_eq!(holds(&found), expected, "after the link is gone: {found:?}");

    child.exit();
    assert_eq!(holds(&host_scan(&disks)), []);
}

/// A shared mapping of a disk, unmapped on drop.
pub(super) struct Mapping {
    address: *mut libc::c_void,
    length: usize,
}

impl Mapping {
    /// Map the start of `disk` and close the descriptor, so only the mapping holds it.
    pub(super) fn of(disk: &Path) -> Self {
        use std::os::fd::AsRawFd;
        let file = File::open(disk).unwrap();
        let length = 1 << 16;
        // SAFETY: a new read-only shared mapping of a live descriptor at an address the
        // kernel chooses; the file is longer than `length`.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        assert_ne!(address, libc::MAP_FAILED);
        Self { address, length }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: exactly the mapping `of` created; nothing else refers to it.
        unsafe { libc::munmap(self.address, self.length) };
    }
}

/// A process that mapped a disk and closed its descriptor still holds it, as it did for
/// `lsof`, until the mapping is gone.
#[test]
fn a_mapping_without_a_descriptor_is_found() {
    isolated("mapping_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_mapping_without_a_descriptor_is_found"]
fn mapping_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let mapping = Mapping::of(&disks[0]);
    let found = host_scan(&disks);
    assert_eq!(
        holds(&found),
        [(own_pid(), Hold::Mapping, disks[0].as_path())],
        "{found:?}"
    );
    assert_eq!(found.unknown, [] as [String; 0]);
    drop(mapping);
    assert_eq!(holds(&host_scan(&disks)), []);
}

/// A disk whose device and inode cannot be read fails the scan as unknown before any
/// process is inspected, as `lsof`'s status error for a missing file did.
#[test]
fn a_disk_that_cannot_be_identified_is_unknown() {
    let directory = Scratch::new();
    let mut disks = sparse_disks(directory.path());
    disks.push(directory.path().join("missing.raw"));
    let found = host_scan(&disks);
    assert!(found.holders.is_empty(), "{found:?}");
    assert_eq!(found.unknown.len(), 1, "{found:?}");
    let result = disks_closed(
        &HostScan::unrecorded(),
        &process::MonotonicClock::new(),
        &disks,
        STOP_HANDLE_WAIT,
    );
    assert_eq!(code(&result), "stop_uncertain");
}

/// A process that has exited answers as exited, which is "not holding", not unknown.
#[test]
fn an_exited_process_is_not_holding() {
    let directory = Scratch::new();
    let disks: Vec<Disk> = sparse_disks(directory.path())
        .iter()
        .map(|disk| Disk::identify(disk).unwrap())
        .collect();
    let mut child = Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    child.wait().unwrap();
    let mut holders = Vec::new();
    assert_eq!(
        host::Inspector::new().inspect(pid, &disks, &mut holders),
        Err(Ended::Exited)
    );
    assert!(holders.is_empty());
}

/// A scan told to stop reports that it did not finish; it never reports "no holder".
#[test]
fn a_stopped_scan_is_unknown() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let found = scan(&disks, &AtomicBool::new(true));
    assert!(found.holders.is_empty(), "{found:?}");
    assert!(!found.unknown.is_empty(), "{found:?}");
    let refused = fake_scan(
        Outcome {
            takes: Some(Duration::ZERO),
            holder: false,
            unknown: true,
        },
        STOP_HANDLE_WAIT,
    );
    assert_eq!(code(&refused.result), "stop_uncertain");
}

/// The real scan is expired at its bound like any other: with no time at all it ends as
/// `provider_timeout_uncertain`, whether or not its thread had already answered.
#[test]
fn the_host_scan_past_its_bound_is_uncertain() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let result = disks_closed(
        &HostScan::unrecorded(),
        &process::MonotonicClock::new(),
        &disks,
        Duration::ZERO,
    );
    assert_eq!(code(&result), "provider_timeout_uncertain");
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
        Ok(Box::new(Listing(Answered(Some(listed)))))
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
fn host_lsof() -> Option<PathBuf> {
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

/// One whole `lsof` scan, bounded for a loaded host once it has its serial turn.
fn lsof_scan(lsof: &Path, disks: &[PathBuf]) -> Found {
    let mut scan = Lsof::at(lsof).start(disks).unwrap();
    let clock = process::MonotonicClock::new();
    process::wait_within(scan.as_mut(), LOADED_HOST_SCAN_WAIT, &clock).unwrap()
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
    isolated("host_lsof_closed_disks_child");
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

/// A scan with a pool records the method it used beside the owner record; on this host
/// that is the method the self-test chose.
#[test]
fn a_host_scan_records_its_method_in_the_pool() {
    let pool = Scratch::new();
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let _held = File::open(&disks[0]).unwrap();
    assert_eq!(last_scan::read(pool.path()), None);
    let result = disks_closed(
        &HostScan::recording(pool.path()),
        &process::MonotonicClock::new(),
        &disks,
        LOADED_HOST_SCAN_WAIT,
    );
    // The scan refused, and its method is recorded all the same.
    assert_eq!(code(&result), "stop_uncertain");
    assert_eq!(last_scan::read(pool.path()), Some(host::method()));
}

const HOLD: &str = "HACK_TEST_DISK_HOLD";
const HOLD_FILE: &str = "HACK_TEST_DISK_HOLD_FILE";
const HOLDING: &str = "disk-holder: holding";
const CANNOT_HOLD: &str = "disk-holder: cannot hold";

/// Turn `file` into a file port and close its descriptor, so only the port holds the
/// file. `None` when this host does not export `fileport_makeport`: the call is in the
/// system library but in no SDK header, so it is looked up at run time instead of linked.
#[cfg(target_os = "macos")]
fn file_port(file: File) -> Option<u32> {
    use std::os::fd::AsRawFd;
    type MakePort = unsafe extern "C" fn(libc::c_int, *mut u32) -> libc::c_int;
    // SAFETY: a lookup of a NUL-terminated name in the images already loaded.
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"fileport_makeport".as_ptr()) };
    if symbol.is_null() {
        return None;
    }
    // SAFETY: the system library's `int fileport_makeport(int, mach_port_t *)`.
    let make_port = unsafe { std::mem::transmute::<*mut libc::c_void, MakePort>(symbol) };
    let mut port = 0_u32;
    // SAFETY: a live descriptor and a valid place for the port name.
    let made = unsafe { make_port(file.as_raw_fd(), &mut port) };
    (made == 0 && port != 0).then_some(port)
}

#[cfg(not(target_os = "macos"))]
fn file_port(_file: File) -> Option<u32> {
    None
}

/// The process the cross-check fixtures launch: it holds one file in one way, says so, and
/// exits when its standard input closes. It does nothing in an ordinary `--ignored` run.
#[test]
#[ignore = "holder process launched by the cross-check fixtures"]
fn disk_holder_process() {
    let (Some(how), Some(file)) = (std::env::var_os(HOLD), std::env::var_os(HOLD_FILE)) else {
        return;
    };
    let file = PathBuf::from(file);
    let held: Option<Box<dyn std::any::Any>> = match how.to_str() {
        Some("descriptor") => Some(Box::new(File::open(&file).unwrap())),
        Some("mapping") => Some(Box::new(Mapping::of(&file))),
        Some("file-port") => file_port(File::open(&file).unwrap())
            .map(|port| Box::new(port) as Box<dyn std::any::Any>),
        _ => panic!("unknown hold {how:?}"),
    };
    println!("{}", if held.is_some() { HOLDING } else { CANNOT_HOLD });
    let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
    drop(held);
}

/// A running [`disk_holder_process`], released and reaped on drop.
struct DiskHolder {
    child: Child,
    release: Option<ChildStdin>,
    /// Kept open so the process can still print when it exits.
    output: BufReader<std::process::ChildStdout>,
}

impl DiskHolder {
    /// `None` when this host cannot hold a file that way.
    fn holding(how: &str, file: &Path) -> Option<Self> {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "--nocapture", "--test-threads=1"])
            .arg("provider::lifecycle::disk_handles::tests::disk_holder_process")
            .env(HOLD, how)
            .env(HOLD_FILE, file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let release = child.stdin.take();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut holder = Self {
            child,
            release,
            output,
        };
        let mut line = String::new();
        loop {
            line.clear();
            let read = holder.output.read_line(&mut line).unwrap();
            assert_ne!(read, 0, "the disk holder exited without holding by {how}");
            if line.contains(HOLDING) {
                return Some(holder);
            }
            if line.contains(CANNOT_HOLD) {
                holder.exit();
                return None;
            }
        }
    }
    fn pid(&self) -> i32 {
        i32::try_from(self.child.id()).unwrap()
    }
    /// Close its standard input and wait for it to exit.
    fn exit(&mut self) {
        drop(self.release.take());
        self.child.wait().unwrap();
    }
}

impl Drop for DiskHolder {
    fn drop(&mut self) {
        drop(self.release.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The scan in this process and the `lsof` scan give the same answer about one process
/// that holds a disk in one way: the same holder while it holds, and none after it exits.
/// This is the check that fails first if an OS update changes what the undeclared region
/// query or the other libproc calls report.
fn both_scans_agree(how: &str) {
    let Some(lsof) = host_lsof() else { return };
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let Some(mut holder) = DiskHolder::holding(how, &disks[0]) else {
        println!("skipping: this host cannot hold a file by {how}");
        return;
    };
    let pids = |found: &Found| -> Vec<i32> {
        let mut pids: Vec<i32> = found.holders.iter().map(|held| held.pid).collect();
        pids.dedup();
        pids
    };

    let in_process = host_scan(&disks);
    let listed = lsof_scan(&lsof, &disks);
    assert_eq!(
        pids(&in_process),
        [holder.pid()],
        "in process: {in_process:?}"
    );
    assert_eq!(pids(&listed), [holder.pid()], "lsof: {listed:?}");
    assert!(in_process.unknown.is_empty(), "{in_process:?}");
    assert!(listed.unknown.is_empty(), "{listed:?}");
    let expected = match how {
        "descriptor" => Hold::Descriptor,
        "file-port" => Hold::FilePort,
        _ => Hold::Mapping,
    };
    assert_eq!(
        holds(&in_process),
        [(holder.pid(), expected, disks[0].as_path())],
        "{in_process:?}"
    );

    holder.exit();
    let in_process = host_scan(&disks);
    let listed = lsof_scan(&lsof, &disks);
    assert!(
        in_process.holders.is_empty() && in_process.unknown.is_empty(),
        "in process after exit: {in_process:?}"
    );
    assert!(
        listed.holders.is_empty() && listed.unknown.is_empty(),
        "lsof after exit: {listed:?}"
    );
}

#[test]
fn both_scans_agree_on_a_descriptor_holder() {
    isolated("agree_on_a_descriptor_fixture");
}

#[test]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_descriptor_holder"]
fn agree_on_a_descriptor_fixture() {
    both_scans_agree("descriptor");
}

#[test]
fn both_scans_agree_on_a_mapping_only_holder() {
    isolated("agree_on_a_mapping_fixture");
}

#[test]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_mapping_only_holder"]
fn agree_on_a_mapping_fixture() {
    both_scans_agree("mapping");
}

#[test]
#[cfg(target_os = "macos")]
fn both_scans_agree_on_a_file_port_holder() {
    isolated("agree_on_a_file_port_fixture");
}

#[test]
#[cfg(target_os = "macos")]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_file_port_holder"]
fn agree_on_a_file_port_fixture() {
    both_scans_agree("file-port");
}

fn spread(mut samples: Vec<Duration>) -> String {
    samples.sort();
    format!(
        "min {:.1} ms, median {:.1} ms, max {:.1} ms over {} runs",
        samples[0].as_secs_f64() * 1e3,
        samples[samples.len() / 2].as_secs_f64() * 1e3,
        samples[samples.len() - 1].as_secs_f64() * 1e3,
        samples.len()
    )
}

/// Time `runs` calls of `scan`, which must each prove the disks closed.
pub(super) fn timed(runs: usize, mut scan: impl FnMut()) -> Vec<Duration> {
    (0..runs)
        .map(|_| {
            let started = Instant::now();
            scan();
            started.elapsed()
        })
        .collect()
}

/// Prints this host's scan time beside the `lsof` child it falls back to, over the same
/// two unheld files. Run it alone:
/// `cargo test --lib -- --ignored --nocapture --exact
/// provider::lifecycle::disk_handles::tests::host_scan_timing_against_lsof`.
#[test]
#[ignore = "timing report for a quiet host; run alone with --ignored --nocapture"]
fn host_scan_timing_against_lsof() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let processes = host::processes().unwrap().len();
    println!("disk-handle scan timing on a host with {processes} processes");
    let chosen = timed(200, || assert_eq!(host::method(), Method::InProcess));
    println!("  choosing the method:     {}", spread(chosen));
    let scans = timed(20, || {
        let found = host_scan(&disks);
        assert!(
            found.holders.is_empty() && found.unknown.is_empty(),
            "{found:?}"
        );
    });
    println!("  scan in this process:    {}", spread(scans));
    let bounded = timed(20, || {
        let clock = process::MonotonicClock::new();
        disks_closed(&HostScan::unrecorded(), &clock, &disks, STOP_HANDLE_WAIT).unwrap();
    });
    println!("  through disks_closed:    {}", spread(bounded));
    let Some(lsof) = host_lsof() else {
        println!("  lsof: not installed on this host");
        return;
    };
    let children = timed(5, || {
        let listed = process::capture(
            process::clean_command(&lsof)
                .args(["-n", "-P", "-t", "--"])
                .args(&disks),
            Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(listed.status.code(), Some(1));
        assert!(listed.stdout.is_empty() && listed.stderr.is_empty());
    });
    println!("  lsof child, the fallback: {}", spread(children));
}

/// One scan over two unheld files, timed. `scripts/measure-lsof-scan.ts` runs this fixture
/// to measure a host under load and reads the line it prints.
#[test]
#[ignore = "one timed scan for scripts/measure-lsof-scan.ts"]
fn one_timed_host_scan() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let started = Instant::now();
    let found = host_scan(&disks);
    let seconds = started.elapsed().as_secs_f64();
    assert!(
        found.holders.is_empty() && found.unknown.is_empty(),
        "{found:?}"
    );
    println!("disk_handle_scan_seconds={seconds:.6}");
}
