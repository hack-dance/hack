//! Bounded scan for processes that still hold a pool's owned disks.
//!
//! A stop (`down`, `recover`, host-filesystem inspection) and a reserve release check both
//! look for processes that still hold the provider's disks. The scan was a
//! `lsof -n -P -t` child, which took 0.6 s of a quiet `down` and over 5 s on a loaded host.
//! On macOS it now runs in this process (`disk_handles/macos.rs`), with `lsof` as its
//! fallback; everywhere else it is still the `lsof` child.
//!
//! Scanning every process to learn whether a VM disk is held is a consequence of not owning
//! the VM process: a launcher of our own would hold an exclusive lock on each disk, and the
//! question would be one lock attempt. This scan is the fix for today's provider and should
//! not be built on further.
//!
//! # What the scan in this process is
//!
//! It inspects what the shipped `lsof` inspects for these files: file descriptors, file
//! ports (a descriptor in transit in a Mach message) and file mappings, the mappings
//! through the same kernel query with the same end condition, in every process this user
//! may inspect, matched by device and inode. It falls back to `lsof` whenever it cannot
//! trust itself. It does not prove that nothing maps a disk, and neither did `lsof`.
//!
//! What both methods share, because the kernel gives no more:
//!
//! * The process table is read while it changes. A process, descriptor or mapping that
//!   appears while the scan runs can be missed.
//! * Processes of other users and system processes answer `EPERM` and are not inspected.
//! * The mapping query answers `EINVAL` both at the end of a process's mappings and for a
//!   region whose file it cannot get, and each walk ends there (`macos::Inspector`).
//! * The kernel fills each list from a size it took before filling.
//!
//! # When `lsof` scans instead
//!
//! On macOS the mappings are read with a kernel query the SDK header does not declare. A
//! kernel that answered it with a slightly different meaning would make the scan miss a
//! holder. So the scan in this process answers only when its self-test passed (the query
//! reported a mapping the scan made of a file of its own, `macos::method`) and every list
//! and record it read was one it could use. In every other case the whole scan is run
//! again through the `lsof` child ([`Lsof`]), and its answer alone counts; no answer mixes
//! the two. That fallback is a safety property, not a convenience.
//!
//! On every other platform the scan is the `lsof` child. A scan of `/proc` was written and
//! removed: `/proc/<pid>/maps` names a mapped file by a path that may no longer lead to it
//! and by an inode that overlay filesystems report differently from `stat`. Telling
//! whether a mapping is the disk needs `/proc/<pid>/map_files`, whose links an unprivileged
//! process may not follow. Do not bring an in-process Linux scan back without it. The
//! `lsof` scan there differs from the one before this module scanned in process in four
//! ways: `lsof` is started by the scan's thread, not by the caller; the method is recorded
//! ([`last_scan`]); `/usr/bin/lsof` is tried when `/usr/sbin/lsof` is absent; and a scan
//! whose bound expires while it runs reports `provider_timeout_uncertain` with this
//! module's message, whatever the child was doing.
//!
//! [`last_scan`] records which method a recently finished scan of the pool used, and why
//! when it was `lsof`, in `disk-handle-scan.json` beside the owner record. The record
//! never decides anything: the answer is handed over first, the caller waits at most
//! [`RECORD_GRACE`] for the record, and nothing is written into the pool's directory once
//! the caller has returned.
//!
//! # What refuses
//!
//! A holder fails the scan as `stop_uncertain`. So does an `lsof` answer that is anything
//! but its silent "nothing found": a diagnostic, another exit status, a disk it cannot
//! read. A scan that cannot start fails as `provider_spawn_failed`. A scan that cannot
//! answer is never read as "nothing found".
//!
//! # Time bound
//!
//! The caller waits at most its bound ([`STOP_HANDLE_WAIT`], [`RELEASE_HANDLE_WAIT`]) for
//! the whole scan: choosing the method, the scan in this process, finding and starting
//! `lsof` and waiting for it all happen on the scan's thread, inside the bound. A scan that
//! does not answer in time fails as `provider_timeout_uncertain`: `down` then writes no
//! clean-stop marker and the next start falls back to the fresh disk budget. A scan whose
//! bound expires while it runs reports that code; an error that had already arrived when
//! the bound was looked at is reported as itself. Both refuse.
//!
//! The bound limits the wait, not the work. The scan's threads are told to stop. An `lsof`
//! child that is running, or that is started after the caller gave up, is stopped and
//! reaped by the scan's thread. The caller waits a moment more for that ([`REAP_GRACE`]),
//! which bounds its extra wait and not the reaping: a child slow to die is reaped by the
//! thread later, while the process lives. A thread blocked in a system call (a stuck
//! filesystem) outlives the timeout, and whatever it answers later is discarded. Both
//! bounds were set well above the slowest `lsof` scan measured on a loaded host and are
//! unchanged.
//! `scripts/measure-lsof-scan.ts` re-measures a host.
//!
//! Finding mappings is nearly all of the time: the kernel walks every memory region of
//! every process, for this scan as it does for `lsof`. The scan is faster than the `lsof`
//! child because it walks processes on several threads, not because it does less.
//!
//! The probe ([`HandleProbe`]) and the clock are injected, so tests drive both bounds with a
//! fake clock instead of the host's process table. Only the scan is replaceable; the result
//! is interpreted here the same way for every probe.
use crate::CandidateError;
use crate::provider::process::{self, Captured, Clock, Pending};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::Duration;

pub(super) mod last_scan;
#[cfg(target_os = "macos")]
mod macos;

/// Slowest single disk-handle scan measured on a loaded host so far, with the `lsof` child:
/// macOS at about 1,850 processes and load 30–80 took 5.4–6.5 s. Linux at about 890
/// processes, load about 120 and 16 scans at once took up to 5.3 s. The scan in this
/// process is faster, so the bounds below keep at least that margin for either method.
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

/// Where a host installs `lsof`, in the order tried: macOS and some Linux distributions,
/// then the Linux distributions that keep it out of `sbin`.
const LSOF: [&str; 2] = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/// How one scan read the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum Method {
    /// The scan in this process.
    InProcess,
    /// The `lsof` child, for the reason given.
    Lsof(Fallback),
}

/// Why a scan was left to `lsof`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum Fallback {
    /// This platform has no scan in this process (see the module header).
    NotBuiltForThisPlatform,
    /// The kernel did not answer the mapping query at all.
    QueryUnanswered,
    /// The kernel answered the self-test's queries, but not with what the test made.
    SelfTestFailed,
    /// The test could not make its own file and mapping, so the queries were not tested.
    SelfTestUnavailable,
    /// Something the scan read was partial, did not settle, failed or passed a limit.
    ScanIncomplete,
}

/// How a process holds a disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum Hold {
    /// An open file descriptor.
    Descriptor,
    /// A descriptor in transit in a Mach message.
    FilePort,
    /// A memory mapping, with or without a descriptor.
    Mapping,
    /// `lsof` listed the process. Asked for process ids only, it does not say how.
    Listed,
}

/// One process holding one disk in one way. Only the scan in this process reads the
/// fields outside tests; an `lsof` listing refuses whatever it lists.
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) struct Holder {
    pub(super) pid: i32,
    pub(super) hold: Hold,
    /// The disk as the caller named it; `None` from `lsof`, which lists a process once for
    /// all the disks it was asked about.
    pub(super) disk: Option<PathBuf>,
    /// The name the kernel reports for the held file, when it reports one. A diagnostic
    /// for tests and the timing fixture only, never matched: with hard links it can be
    /// either name, and the refusal a holder causes carries a fixed message.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) name: Option<PathBuf>,
}

/// What one finished scan established.
#[derive(Debug, Default)]
pub(super) struct Found {
    /// Every hold the scan saw.
    pub(super) holders: Vec<Holder>,
    /// Every reason the scan could not answer. One entry is enough to make the scan unable
    /// to show the disks closed.
    pub(super) unknown: Vec<String>,
}

/// Starts one scan for processes that hold any of the given disks.
pub(super) trait HandleProbe {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError>;
}

/// The scan in this process, or the reason the `lsof` child must scan instead. `stop` ends
/// it early, as unknown.
type Decide = fn(&[PathBuf], &AtomicBool) -> Result<Found, Fallback>;

/// The scan this platform builds: the self-test, then the scan it allows.
#[cfg(target_os = "macos")]
fn decide(disks: &[PathBuf], stop: &AtomicBool) -> Result<Found, Fallback> {
    match macos::method() {
        Method::InProcess => macos::scan(disks, stop),
        Method::Lsof(why) => Err(why),
    }
}

/// This platform builds no scan in this process: every scan is the `lsof` child.
#[cfg(not(target_os = "macos"))]
fn decide(_disks: &[PathBuf], _stop: &AtomicBool) -> Result<Found, Fallback> {
    Err(Fallback::NotBuiltForThisPlatform)
}

/// Finds the `lsof` to run. A test puts another in its place.
type Locate = Arc<dyn Fn() -> Result<Lsof, CandidateError> + Send + Sync>;

/// Writes the record of what a scan ran, unless the flag says the caller has returned. A
/// test puts another in its place.
type Recorder = Arc<dyn Fn(&Path, last_scan::Turn, Method, &AtomicBool) + Send + Sync>;

/// How long a caller that has its answer waits for the scan's thread to finish recording
/// before it returns and the thread may no longer write. This is the most a record can
/// add to a stop, and it adds nothing when the record is up to date or written at once,
/// which ends the wait. A stop never waits longer and never fails for it.
const RECORD_GRACE: Duration = Duration::from_millis(100);

/// How long a caller whose bound expired waits for the scan's thread to stop. It bounds
/// the caller's extra wait, not the reaping: it is long enough for the thread to kill and
/// reap an `lsof` child in the ordinary case, and a child that takes longer to die (stuck
/// in uninterruptible I/O) is reaped by the thread later, while this process lives.
const REAP_GRACE: Duration = Duration::from_millis(250);

/// How often the scan's thread looks whether its caller gave up while `lsof` runs.
const STOP_CHECK: Duration = Duration::from_millis(20);

/// The scan of this host: in this process when this scan may trust it, else through
/// `lsof` (see the module header).
pub(super) struct HostScan<'a> {
    /// The pool's state directory, where the method each scan used is recorded.
    record: Option<&'a Path>,
    decide: Decide,
    locate: Locate,
    recorder: Recorder,
}

impl<'a> HostScan<'a> {
    /// A scan that records its method in `pool`, the directory of the pool's owner record.
    pub(super) fn recording(pool: &'a Path) -> Self {
        Self {
            record: Some(pool),
            decide,
            locate: Arc::new(Lsof::host),
            recorder: Arc::new(last_scan::record),
        }
    }
}

impl HandleProbe for HostScan<'_> {
    /// Nothing that can block runs here: the caller's bound starts only once this returns,
    /// so the whole scan is left to its thread.
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        let stop = Arc::new(AtomicBool::new(false));
        let gone = Arc::new(AtomicBool::new(false));
        let (answer, answered) = mpsc::channel();
        let work = Work {
            disks: disks.to_vec(),
            pool: self.record.map(Path::to_owned),
            turn: last_scan::Turn::next(),
            decide: self.decide,
            locate: self.locate.clone(),
            recorder: self.recorder.clone(),
            stop: stop.clone(),
            gone: gone.clone(),
            answer,
        };
        std::thread::Builder::new()
            .name("disk-handle-scan".into())
            .spawn(move || work.run())
            .map_err(|error| CandidateError::new("provider_spawn_failed", error.to_string()))?;
        Ok(Box::new(Scanning {
            answered,
            early: None,
            finished: false,
            stop,
            gone,
        }))
    }
}

/// One host scan as its thread runs it.
struct Work {
    disks: Vec<PathBuf>,
    pool: Option<PathBuf>,
    turn: last_scan::Turn,
    decide: Decide,
    locate: Locate,
    recorder: Recorder,
    /// Set once the caller gave up: start nothing more, and stop what runs.
    stop: Arc<AtomicBool>,
    /// Set once the caller has returned: write nothing more into the pool's directory.
    gone: Arc<AtomicBool>,
    answer: Sender<Result<Found, CandidateError>>,
}

impl Work {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn run(self) {
        // What actually ran, and what it answered. Nothing ran when `lsof` was needed and
        // could not be started.
        let (ran, result) = match (self.decide)(&self.disks, &self.stop) {
            Ok(found) => (Some(Method::InProcess), Ok(found)),
            Err(why) => match self.listed() {
                Listed::Answered(result) => (Some(Method::Lsof(why)), result),
                Listed::NotStarted(why_not) => (None, Err(why_not)),
                // There is nobody to answer and nothing to record.
                Listed::GivenUp => return,
            },
        };
        // The caller gets the answer first: the record never decides a stop. "Delivered"
        // means queued for a caller that is still there; it may yet refuse the answer as
        // late. The caller then waits a moment for this thread to end ([`RECORD_GRACE`]),
        // which it does when `self`, and with it the sending end, is dropped below; after
        // that the recorder finds the caller gone and writes nothing.
        let delivered = self.answer.send(result).is_ok();
        if let (Some(pool), Some(method)) = (&self.pool, ran)
            && delivered
            && !self.stopped()
        {
            (self.recorder)(pool, self.turn, method, &self.gone);
        }
    }

    /// Run the whole scan through the `lsof` child.
    ///
    /// The child is found, started, waited for and, if the caller gives up, killed and
    /// reaped here, on the scan's thread. So a slow lookup or spawn cannot stretch the
    /// caller's wait, and a child started after the caller gave up (it can give up
    /// between the last look and the spawn) is stopped and reaped by this thread. The
    /// child is owned by `child` below until it has answered: a failed poll and an
    /// unwinding thread both drop it, which stops and reaps it ([`Listing`]).
    fn listed(&self) -> Listed {
        if self.stopped() {
            return Listed::GivenUp;
        }
        let lsof = match (self.locate)() {
            Ok(lsof) => lsof,
            Err(missing) => return Listed::NotStarted(missing),
        };
        if self.stopped() {
            return Listed::GivenUp;
        }
        let mut child = match lsof.start(&self.disks) {
            Ok(child) => child,
            Err(refused) => return Listed::NotStarted(refused),
        };
        let clock = process::MonotonicClock::new();
        loop {
            // Looked at before the first wait as well: a child whose start outlasted the
            // caller's bound is killed and reaped at once.
            if self.stopped() {
                let _ = child.expire();
                return Listed::GivenUp;
            }
            match child.poll() {
                Ok(Some(found)) => return Listed::Answered(Ok(found)),
                Ok(None) => child.wait(STOP_CHECK, &clock),
                Err(lost) => return Listed::Answered(Err(lost)),
            }
        }
    }
}

/// How running a scan through `lsof` ended.
enum Listed {
    /// The child was started and this is its answer, or how waiting for it failed.
    Answered(Result<Found, CandidateError>),
    /// `lsof` could not be found or started.
    NotStarted(CandidateError),
    /// The caller gave up; no child was started, or the one started was killed and reaped.
    GivenUp,
}

/// A host scan under way, as its caller waits for it.
struct Scanning {
    answered: Receiver<Result<Found, CandidateError>>,
    /// The answer, once [`Pending::wait`] received it and until the next poll takes it.
    early: Option<Result<Found, CandidateError>>,
    /// The caller has its answer or has given up.
    finished: bool,
    stop: Arc<AtomicBool>,
    /// Set when this value is dropped: the caller is returning.
    gone: Arc<AtomicBool>,
}

impl Pending<Found> for Scanning {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        let answer = match self.early.take() {
            Some(answer) => answer,
            None => match self.answered.try_recv() {
                Ok(answer) => answer,
                Err(TryRecvError::Empty) => return Ok(None),
                // The thread ended without an answer, which only a panic in it does.
                Err(TryRecvError::Disconnected) => Err(cannot_inspect()),
            },
        };
        self.finished = true;
        answer.map(Some)
    }

    fn expire(&mut self) -> CandidateError {
        self.finished = true;
        self.stop.store(true, Ordering::Relaxed);
        self.gone.store(true, Ordering::Relaxed);
        // Give the thread a moment to kill and reap an `lsof` child before this returns.
        // It ends by answering or by dropping its end; neither is used.
        let _ = self.answered.recv_timeout(REAP_GRACE);
        CandidateError::new(
            "provider_timeout_uncertain",
            "Disk-handle scan timed out. Owned disks may still be held; inspect before retry.",
        )
    }

    /// Block until the thread answers, for at most `limit`.
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        if self.early.is_some() {
            return;
        }
        let started = clock.now();
        match self.answered.recv_timeout(limit) {
            Ok(answer) => self.early = Some(answer),
            // The next poll reports the lost thread.
            Err(RecvTimeoutError::Disconnected) => {}
            Err(RecvTimeoutError::Timeout) => {
                // Nothing changed for `limit` of real time. A clock that is not real time has
                // not seen that wait: pass it on, so the caller's bound still expires.
                let unseen = limit.saturating_sub(clock.now().saturating_sub(started));
                if !unseen.is_zero() {
                    clock.sleep(unseen);
                }
            }
        }
    }
}

impl Drop for Scanning {
    /// The caller is returning. One that leaves without its answer stops the scan. One
    /// that has its answer lets the thread finish recording what ran, for at most
    /// [`RECORD_GRACE`]: the thread ends, and drops its end of the channel, as soon as it
    /// has recorded or has nothing to record. Either way the thread is then told the caller
    /// is gone, and it writes nothing into the pool's directory after that. So a pool
    /// directory that is removed or set aside right after a scan does not get a late file.
    fn drop(&mut self) {
        if !self.finished {
            self.stop.store(true, Ordering::Relaxed);
        } else if !self.gone.load(Ordering::Relaxed) {
            // The answer was taken, so the only thing left to arrive is the thread's end.
            let _ = self.answered.recv_timeout(RECORD_GRACE);
        }
        self.gone.store(true, Ordering::Relaxed);
    }
}

/// The host's `lsof`, with a clean environment: the only scan before one ran in this
/// process, the fallback on macOS since, and still the scan everywhere else.
pub(super) struct Lsof {
    executable: PathBuf,
}

impl Lsof {
    /// The `lsof` this host installs, from its known locations ([`LSOF`]).
    fn host() -> Result<Self, CandidateError> {
        LSOF.into_iter()
            .map(Path::new)
            .find(|path| path.is_file())
            .map(Self::at)
            .ok_or_else(|| {
                CandidateError::new(
                    "provider_spawn_failed",
                    "The disk-handle scan must run through lsof, which this host does not install.",
                )
            })
    }

    fn at(executable: &Path) -> Self {
        Self {
            executable: executable.to_owned(),
        }
    }
}

impl HandleProbe for Lsof {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        #[cfg(test)]
        let serial = tests::ScanSerial::acquire();
        let running = process::spawn(
            process::clean_command(&self.executable)
                .args(["-n", "-P", "-t", "--"])
                .args(disks),
        )?;
        #[cfg(test)]
        let running = serial.hold(running);
        Ok(Box::new(Listing::of(running)))
    }
}

/// An `lsof -t` child whose exit and output are read as what a scan found.
///
/// The child has an owner for as long as this value lives. Dropping it before the child
/// has answered or been expired stops and reaps the child: that covers a poll that failed
/// and an owner that unwinds, neither of which may leave `lsof` running or unreaped.
struct Listing<Child: Pending> {
    child: Child,
    /// The child has answered or has been expired; nothing is left to stop or reap.
    settled: bool,
}

impl<Child: Pending> Listing<Child> {
    fn of(child: Child) -> Self {
        Self {
            child,
            settled: false,
        }
    }
}

impl<Child: Pending> Pending<Found> for Listing<Child> {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        let listed = self.child.poll()?;
        self.settled |= listed.is_some();
        Ok(listed.map(|listed| Found::listed(&listed)))
    }
    fn expire(&mut self) -> CandidateError {
        self.settled = true;
        self.child.expire()
    }
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        self.child.wait(limit, clock);
    }
}

impl<Child: Pending> Drop for Listing<Child> {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.child.expire();
        }
    }
}

impl Found {
    /// What `lsof -n -P -t -- <disks>` reported. It exits 1 with no output when it finds no
    /// holder, and that alone is "nothing found". When it finds holders it prints one
    /// process id a line, and exits 0 if every disk has one and 1 if some disk has none.
    /// Anything else (a diagnostic, another status, output that is not process ids) is
    /// unknown, so it never reads as "nothing holds the disks".
    fn listed(listed: &Captured) -> Self {
        let status = listed.status.code();
        if status == Some(1) && listed.stdout.is_empty() && listed.stderr.is_empty() {
            return Self::default();
        }
        // One process id a line; `None` when any line is something else.
        let pids: Option<Vec<i32>> = std::str::from_utf8(&listed.stdout)
            .ok()
            .and_then(|output| output.lines().map(|line| line.parse().ok()).collect());
        let holders_only = matches!(status, Some(0 | 1))
            && listed.stderr.is_empty()
            && pids.as_ref().is_some_and(|pids| !pids.is_empty());
        let unknown = (!holders_only).then(|| {
            format!(
                "lsof exited {} with {} bytes of output and {} of diagnostics",
                listed.status,
                listed.stdout.len(),
                listed.stderr.len()
            )
        });
        Self {
            holders: pids
                .unwrap_or_default()
                .into_iter()
                .map(|pid| Holder {
                    pid,
                    hold: Hold::Listed,
                    disk: None,
                    name: None,
                })
                .collect(),
            unknown: unknown.into_iter().collect(),
        }
    }
}

/// Show that no process holds any of `disks`, waiting at most `wait` on `clock` for the
/// scan. Only a scan that saw no holder and could answer passes. A holder or an unknown
/// fails as `stop_uncertain`, and a scan that does not finish in time fails as
/// `provider_timeout_uncertain`.
pub(super) fn disks_closed(
    probe: &dyn HandleProbe,
    clock: &dyn Clock,
    disks: &[PathBuf],
    wait: Duration,
) -> Result<(), CandidateError> {
    let mut scan = probe.start(disks)?;
    let found = process::wait_within(scan.as_mut(), wait, clock)?;
    if !found.holders.is_empty() {
        return Err(CandidateError::new(
            "stop_uncertain",
            "Cannot confirm that all handles to owned disks are closed.",
        ));
    }
    if !found.unknown.is_empty() {
        return Err(cannot_inspect());
    }
    Ok(())
}

fn cannot_inspect() -> CandidateError {
    CandidateError::new(
        "stop_uncertain",
        "Cannot inspect the host's processes for handles to owned disks.",
    )
}

#[cfg(test)]
mod tests;
