//! Bounded scan for processes that still hold a pool's owned disks.
//!
//! A stop (`down`, `recover`, host-filesystem inspection) and a reserve release check both
//! prove the provider let its disks go by asking which processes hold them. On macOS the
//! scan runs in this process and reads the host's process table through libproc
//! (`disk_handles/macos.rs`). It replaces a `lsof -n -P -t` child, which took 0.6 s of a
//! quiet `down` and over 5 s on a loaded host, and it keeps that scan's contract. `lsof`
//! remains the fallback on macOS and the only scan everywhere else (below).
//!
//! Scanning every process to learn whether a VM disk is held is a consequence of not owning
//! the VM process: a launcher of our own would hold an exclusive lock on each disk, and the
//! question would be one lock attempt. This scan is the fix for today's provider and should
//! not be built on further.
//!
//! # What a scan establishes
//!
//! A scan that passes saw, in every process this user may inspect, no open descriptor, no
//! memory mapping and, on macOS, no file port (a descriptor in transit in a Mach message)
//! on any of the disks. `lsof` reports the same three. A disk is matched by its device and
//! inode, so a holder is found whatever name it opened the file by.
//!
//! That is an observation, not an atomic proof, with either method:
//!
//! * The process table is read while it changes. A process, descriptor or mapping that
//!   appears while the scan runs can be missed, as it can by `lsof`.
//! * Processes of other users and system processes answer `EPERM` and are not inspected.
//!   `lsof`, run by the same user, is refused by the same processes.
//! * The kernel fills each list from a size it took before filling. A list is read again
//!   until its answer leaves a margin (see `macos::list`), which narrows that window and
//!   does not close it.
//!
//! # Which scan runs
//!
//! On macOS the mappings are read with a kernel query the SDK header does not declare, the
//! same one the shipped `lsof` uses. A kernel that answered it with a slightly different
//! meaning would turn a pass into a false "nothing holds the disks". So a scan in this
//! process answers only when three things hold; otherwise the whole scan is run again
//! through the `lsof` child, exactly as before ([`Lsof`]), and its answer alone counts. No
//! answer mixes the two.
//!
//! * The self-test passed: the query reported a mapping the scan made of a file of its own
//!   (`macos::method`).
//! * Every list and record it read was whole (`scan_incomplete` otherwise).
//! * The mapping walks can be shown complete. The undeclared query answers `EINVAL` both at
//!   the end of a process's mappings and for a region whose file it cannot get, so the
//!   walks alone never show it. The declared region query decides: asked about a page the
//!   scan maps of each disk, it must report that nothing else maps that disk
//!   (`walk_incomplete` otherwise; see `macos::mapped_only_here`).
//!
//! On every other platform the scan is the `lsof` child (`not_built_for_this_platform`).
//! A scan of `/proc` was written and removed: `/proc/<pid>/maps` names a mapped file by a
//! path that may no longer lead to it and by an inode that overlay filesystems report
//! differently from `stat`. Telling whether a mapping is the disk needs
//! `/proc/<pid>/map_files`, whose links an unprivileged process may not follow. Do not
//! bring an in-process Linux scan back without it.
//!
//! [`last_scan`] records which method the pool's last scan used, and why when it was
//! `lsof`, in `disk-handle-scan.json` beside the owner record.
//!
//! # What refuses
//!
//! A holder fails the scan as `stop_uncertain`. So does an `lsof` answer that is anything
//! but its silent "nothing found": a diagnostic, another exit status, a disk it cannot
//! read. A scan that cannot start fails as `provider_spawn_failed`. A scan that cannot
//! answer is never read as "nothing holds the disks".
//!
//! # Time bound
//!
//! The caller waits at most its bound ([`STOP_HANDLE_WAIT`], [`RELEASE_HANDLE_WAIT`]) for
//! the whole scan: choosing the method, the scan in this process, recording the method and
//! the `lsof` child if one is needed all happen inside it. A scan that does not answer in
//! time fails as `provider_timeout_uncertain`: `down` then writes no clean-stop marker and
//! the next start falls back to the fresh disk budget.
//!
//! The bound limits the wait, not the work. The scan's threads are told to stop and each
//! ends at its next process, but a thread blocked in a system call (a stuck filesystem)
//! outlives the timeout; whatever it answers later is discarded. An `lsof` child is
//! signalled and reaped. Both bounds were set well above the slowest `lsof` scan measured
//! on a loaded host and are unchanged. `scripts/measure-lsof-scan.ts` re-measures a host.
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
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
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
    /// A list or record the scan read was partial, did not settle or failed.
    ScanIncomplete,
    /// The mapping walks could not be shown complete.
    WalkIncomplete,
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

/// The scan of this host: in this process when this scan may trust it, else through
/// `lsof` (see the module header).
pub(super) struct HostScan<'a> {
    /// The pool's state directory, where the method each scan used is recorded.
    record: Option<&'a Path>,
    decide: Decide,
}

impl<'a> HostScan<'a> {
    /// A scan that records its method in `pool`, the directory of the pool's owner record.
    pub(super) fn recording(pool: &'a Path) -> Self {
        Self {
            record: Some(pool),
            decide,
        }
    }
}

impl HandleProbe for HostScan<'_> {
    /// Nothing that can block runs here: the caller's bound starts only once this returns,
    /// so the self-test, the scan and the record are all left to the thread.
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        let stop = Arc::new(AtomicBool::new(false));
        let (answer, decided) = mpsc::channel();
        let (decide, stopped) = (self.decide, stop.clone());
        let (scanned, pool) = (disks.to_vec(), self.record.map(Path::to_owned));
        std::thread::Builder::new()
            .name("disk-handle-scan".into())
            .spawn(move || {
                let found = decide(&scanned, &stopped);
                let method = match &found {
                    Ok(_) => Method::InProcess,
                    Err(why) => Method::Lsof(*why),
                };
                // Best-effort and inside the bound: a stop never waits on it unbounded.
                if let Some(pool) = &pool {
                    last_scan::record(pool, method);
                }
                // The receiver is gone once the wait expired or failed; the answer is then
                // late and nobody may use it.
                let _ = answer.send(found.ok());
            })
            .map_err(|error| CandidateError::new("provider_spawn_failed", error.to_string()))?;
        Ok(Box::new(Scanning {
            disks: disks.to_vec(),
            stop,
            state: State::Deciding {
                decided,
                answered: None,
            },
        }))
    }
}

/// A host scan under way. Dropping it tells its threads to stop.
struct Scanning {
    disks: Vec<PathBuf>,
    stop: Arc<AtomicBool>,
    state: State,
}

enum State {
    /// The thread is choosing the method and, if it may, scanning in this process. It
    /// sends what it found, or `None` when `lsof` must scan instead.
    Deciding {
        decided: Receiver<Option<Found>>,
        /// What it sent, once [`Pending::wait`] received it and until the next poll.
        answered: Option<Option<Found>>,
    },
    /// The `lsof` child scans.
    Listing(Box<dyn Pending<Found>>),
}

impl Pending<Found> for Scanning {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        let decision = match &mut self.state {
            State::Listing(listing) => return listing.poll(),
            State::Deciding { decided, answered } => match answered.take() {
                Some(decision) => decision,
                None => match decided.try_recv() {
                    Ok(decision) => decision,
                    Err(TryRecvError::Empty) => return Ok(None),
                    // The thread ended without an answer, which only a panic in it does.
                    Err(TryRecvError::Disconnected) => return Err(cannot_inspect()),
                },
            },
        };
        match decision {
            Some(found) => Ok(Some(found)),
            None => {
                let mut listing = Lsof::host()?.start(&self.disks)?;
                let polled = listing.poll();
                self.state = State::Listing(listing);
                polled
            }
        }
    }

    fn expire(&mut self) -> CandidateError {
        match &mut self.state {
            State::Listing(listing) => listing.expire(),
            State::Deciding { .. } => {
                self.stop.store(true, Ordering::Relaxed);
                CandidateError::new(
                    "provider_timeout_uncertain",
                    "Disk-handle scan timed out. Owned disks may still be held; inspect before \
                     retry.",
                )
            }
        }
    }

    /// Block until the thread answers or the `lsof` child changes, for at most `limit`.
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        let (decided, answered) = match &mut self.state {
            State::Listing(listing) => return listing.wait(limit, clock),
            State::Deciding { decided, answered } => (decided, answered),
        };
        if answered.is_some() {
            return;
        }
        let started = clock.now();
        match decided.recv_timeout(limit) {
            Ok(decision) => *answered = Some(decision),
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
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The host's `lsof`, with a clean environment: the only scan before one ran in this
/// process, the fallback on macOS since, and still the only scan elsewhere.
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
        Ok(Box::new(Listing(running)))
    }
}

/// An `lsof -t` child whose exit and output are read as what a scan found.
struct Listing<Child>(Child);

impl<Child: Pending> Pending<Found> for Listing<Child> {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        Ok(self.0.poll()?.map(|listed| Found::listed(&listed)))
    }
    fn expire(&mut self) -> CandidateError {
        self.0.expire()
    }
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        self.0.wait(limit, clock);
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
