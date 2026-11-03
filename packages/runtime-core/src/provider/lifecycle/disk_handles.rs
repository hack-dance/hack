//! Bounded scan for open handles on a pool's owned disks.
//!
//! A stop (`down`, `recover`, host-filesystem inspection) and a reserve release check both
//! prove the provider let its disks go by asking `lsof` which processes hold them. `lsof`
//! walks every process's descriptors, so its time grows with the process count and with CPU
//! contention. A scan that does not finish within its bound fails as
//! `provider_timeout_uncertain`: `down` then writes no clean-stop marker and the next start
//! falls back to the fresh disk budget. Both bounds therefore sit well above the slowest scan
//! measured on a loaded host, and stay finite so a stuck `lsof` cannot hang a lifecycle
//! operation. `scripts/measure-lsof-scan.ts` re-measures a host.
//!
//! The probe ([`HandleProbe`]) and the clock are injected, so tests drive both bounds with a
//! fake clock instead of the host's `lsof`. Only the scan is replaceable; the result is
//! interpreted here the same way for every probe.
use crate::CandidateError;
use crate::provider::process::{self, Clock, Pending};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Slowest single disk-handle scan measured on a loaded host so far: macOS at about 1,850
/// processes and load 30–80 took 5.4–6.5 s. Linux at about 890 processes, load about 120 and
/// 16 scans at once took up to 5.3 s. Larger macOS process counts are still to be measured.
#[cfg(test)]
const SLOWEST_MEASURED_SCAN: Duration = Duration::from_millis(6_500);

/// How long `down`, `recover` and other stop paths wait for the disk-handle scan. It was
/// 5 s, below the scans measured above, so an ordinary `down` on a loaded host could end
/// uncertain and lose its clean-stop marker. 30 s keeps more than four times the slowest
/// measured scan. With `down`'s other bounded waits (15 s for the guest's shutdown
/// acknowledgement, 10 s for the provider to exit) a stop still ends within about a minute.
pub(super) const STOP_HANDLE_WAIT: Duration = Duration::from_secs(30);

/// How long a reserve release check waits for the disk-handle scan. Only a start that needs
/// the host reserve runs it, under the startup lease; a scan that still does not finish
/// refuses the reserve and the start keeps the fresh budget.
pub(super) const RELEASE_HANDLE_WAIT: Duration = Duration::from_secs(30);

/// The fixed host `lsof` the scan runs on both platforms.
const LSOF: &str = "/usr/sbin/lsof";

/// Starts one scan for processes that hold any of the given disks open.
pub(super) trait HandleProbe {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending>, CandidateError>;
}

/// The host's `lsof`, with a clean environment.
pub(super) struct Lsof<'a> {
    executable: &'a Path,
}

impl Lsof<'static> {
    pub(super) fn host() -> Self {
        Self {
            executable: Path::new(LSOF),
        }
    }
}

impl<'a> Lsof<'a> {
    /// An `lsof` at another path, for tests on hosts that install it elsewhere.
    #[cfg(test)]
    pub(super) fn at(executable: &'a Path) -> Self {
        Self { executable }
    }
}

impl HandleProbe for Lsof<'_> {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending>, CandidateError> {
        #[cfg(test)]
        let serial = tests::ScanSerial::acquire();
        let running = process::spawn(
            process::clean_command(self.executable)
                .args(["-n", "-P", "-t", "--"])
                .args(disks),
        )?;
        #[cfg(test)]
        let running = serial.hold(running);
        Ok(Box::new(running))
    }
}

/// Prove no process holds any of `disks` open, waiting at most `wait` on `clock` for the
/// scan. `lsof` exits 1 with no output when it finds no holder; anything else (a listed
/// holder, a diagnostic, another status) fails as `stop_uncertain`, and a scan that does not
/// finish in time fails as `provider_timeout_uncertain`.
pub(super) fn disks_closed(
    probe: &dyn HandleProbe,
    clock: &dyn Clock,
    disks: &[PathBuf],
    wait: Duration,
) -> Result<(), CandidateError> {
    let mut scan = probe.start(disks)?;
    let handles = process::wait_within(scan.as_mut(), wait, clock)?;
    if handles.status.code() != Some(1) || !handles.stdout.is_empty() || !handles.stderr.is_empty()
    {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Cannot confirm that all handles to owned disks are closed.",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::provider::process::Captured;
    use std::cell::{Cell, RefCell};
    use std::fs::{File, OpenOptions};
    use std::os::unix::process::ExitStatusExt;
    use std::rc::Rc;

    /// Real `lsof` scans in this test binary run one at a time across every test process
    /// (isolated children included), and each scan's bound starts once it holds the turn.
    /// Concurrent whole-host scans on a loaded host are what made these tests time out; a
    /// lone scan stays far inside the bounds above. The lock is released explicitly, so a
    /// copy of the descriptor in an unrelated fork cannot keep it held.
    pub(in crate::provider::lifecycle) struct ScanSerial(File);

    impl ScanSerial {
        pub(in crate::provider::lifecycle) fn acquire() -> Self {
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

    /// A real scan that keeps the serial turn until it completes or expires.
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
    #[derive(Clone)]
    struct Outcome {
        /// `None`: the scan never finishes on its own.
        takes: Option<Duration>,
        code: i32,
        stdout: &'static [u8],
        stderr: &'static [u8],
    }

    impl Outcome {
        /// `lsof`'s answer when no process holds the disks.
        fn no_holder(takes: Duration) -> Self {
            Self {
                takes: Some(takes),
                code: 1,
                stdout: b"",
                stderr: b"",
            }
        }
        fn hangs() -> Self {
            Self {
                takes: None,
                ..Self::no_holder(Duration::ZERO)
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
        fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending>, CandidateError> {
            self.record.borrow_mut().disks = disks.to_vec();
            Ok(Box::new(FakeScan {
                clock: self.clock.clone(),
                started: self.clock.now(),
                outcome: self.outcome.clone(),
                record: self.record.clone(),
            }))
        }
    }

    impl Pending for FakeScan {
        fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
            let done = self
                .outcome
                .takes
                .is_some_and(|takes| self.clock.now() - self.started >= takes);
            Ok(done.then(|| Captured {
                status: std::process::ExitStatus::from_raw(self.outcome.code << 8),
                stdout: self.outcome.stdout.to_vec(),
                stderr: self.outcome.stderr.to_vec(),
            }))
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

    fn scan(outcome: Outcome, wait: Duration) -> Run {
        scan_on(FakeClock::default(), outcome, wait)
    }

    fn scan_on(clock: FakeClock, outcome: Outcome, wait: Duration) -> Run {
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
            let run = scan(Outcome::no_holder(slow), wait);
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

    /// Both bounds are finite: a scan that never finishes is expired (its child signalled)
    /// at the bound and reported as uncertain, never as released, and well within a minute.
    #[test]
    fn both_bounds_expire_a_hung_scan_as_uncertain_at_the_bound() {
        for (name, wait) in [("stop", STOP_HANDLE_WAIT), ("release", RELEASE_HANDLE_WAIT)] {
            assert!(
                wait <= Duration::from_secs(45),
                "{name} bound {wait:?} is too long"
            );
            let run = scan(Outcome::hangs(), wait);
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
            let run = scan(late, wait);
            assert_eq!(code(&run.result), "provider_timeout_uncertain");
            assert!(run.record.expired);
        }
    }

    /// A waiter that oversleeps across both the bound and the scan's completion finds a
    /// finished scan only after the bound. That late "no holder" is refused as uncertain;
    /// the scan already finished, so it is not expired (nothing is signalled).
    #[test]
    fn an_oversleep_across_the_bound_and_completion_refuses_the_late_result() {
        let ms = Duration::from_millis;
        for wait in [STOP_HANDLE_WAIT, RELEASE_HANDLE_WAIT] {
            let clock = FakeClock::oversleeping(wait - ms(10), wait + ms(50));
            let run = scan_on(clock, Outcome::no_holder(wait + ms(20)), wait);
            assert_eq!(code(&run.result), "provider_timeout_uncertain");
            assert!(!run.record.expired, "a finished scan was signalled");
            assert_eq!(run.elapsed, wait + ms(50));
        }
    }

    /// An oversleep that still wakes inside the bound accepts a scan that finished in it.
    #[test]
    fn an_oversleep_that_wakes_inside_the_bound_accepts_the_scan() {
        let ms = Duration::from_millis;
        for wait in [STOP_HANDLE_WAIT, RELEASE_HANDLE_WAIT] {
            let clock = FakeClock::oversleeping(wait - ms(60), wait - ms(20));
            let run = scan_on(clock, Outcome::no_holder(wait - ms(30)), wait);
            assert_eq!(code(&run.result), "ok");
            assert_eq!(run.elapsed, wait - ms(20));
        }
    }

    /// The probe is replaceable but its answer is not trusted any less: only exit 1 with no
    /// output proves the disks closed.
    #[test]
    fn only_a_silent_no_holder_answer_proves_the_disks_closed() {
        let quick = Duration::from_millis(500);
        let answers = [
            (0, &b"4242\n"[..], &b""[..]),
            (1, b"4242\n", b""),
            (1, b"", b"lsof: WARNING: can't stat()\n"),
            (0, b"", b""),
            (2, b"", b""),
        ];
        for (code_value, stdout, stderr) in answers {
            let outcome = Outcome {
                takes: Some(quick),
                code: code_value,
                stdout,
                stderr,
            };
            let run = scan(outcome, STOP_HANDLE_WAIT);
            assert_eq!(code(&run.result), "stop_uncertain");
            assert!(!run.record.expired);
        }
        assert_eq!(
            code(&scan(Outcome::no_holder(quick), STOP_HANDLE_WAIT).result),
            "ok"
        );
    }

    /// The host `lsof` this test binary can run: the fixed production path, or the usual
    /// Linux location where `/usr/sbin` is a separate directory. macOS must have it.
    fn host_lsof() -> Option<PathBuf> {
        let found = ["/usr/sbin/lsof", "/usr/bin/lsof"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file());
        assert!(
            found.is_some() || !cfg!(target_os = "macos"),
            "macOS hosts must provide {LSOF}"
        );
        if found.is_none() {
            eprintln!("skipping: no lsof on this host");
        }
        found
    }

    /// A private scratch directory removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
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
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sparse_disks(directory: &Path) -> Vec<PathBuf> {
        let disks = disks(directory);
        for disk in &disks {
            File::create(disk).unwrap().set_len(1 << 30).unwrap();
        }
        disks
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
            STOP_HANDLE_WAIT,
        );
        assert_eq!(code(&result), "stop_uncertain");
    }

    /// The real `lsof` proves closed disks closed within the stop path's bound. It runs
    /// alone in a child process: in the shared test process an unrelated test's pre-exec
    /// fork can briefly hold a copy of the disk descriptors this fixture just closed.
    #[test]
    fn host_lsof_proves_closed_disks_closed() {
        use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
        if host_lsof().is_none() {
            return;
        }
        run_isolated(
            "provider::lifecycle::disk_handles::tests::host_lsof_closed_disks_child",
            ISOLATED_HANG_GUARD,
        );
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
            STOP_HANDLE_WAIT,
        );
        assert_eq!(code(&result), "ok", "{:?}", result.as_ref().err());
    }
}
