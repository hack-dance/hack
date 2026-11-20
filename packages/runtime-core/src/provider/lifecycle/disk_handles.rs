//! Bounded scan for processes that still hold a pool's owned disks.
//!
//! A stop (`down`, `recover`, host-filesystem inspection) and a reserve release check both
//! prove the provider let its disks go by asking which processes hold them. The scan runs
//! in this process: it reads the host's process table through libproc on macOS
//! (`disk_handles/macos.rs`) and through `/proc` on Linux (`disk_handles/linux.rs`). It
//! replaces a `lsof -n -P -t` child, which took 0.6 s of a quiet `down` and over 5 s on a
//! loaded host, and it keeps that scan's contract. `lsof` remains the fallback (below).
//!
//! Scanning every process to learn whether a VM disk is held is a consequence of not owning
//! the VM process: a launcher of our own would hold an exclusive lock on each disk, and the
//! question would be one lock attempt. This scan is the fix for today's provider and should
//! not be built on further.
//!
//! # What the scan proves
//!
//! When the scan ran, no process that this user may inspect held any of the disks through
//! an open descriptor, a memory mapping or, on macOS, a file port (a descriptor in transit
//! in a Mach message). `lsof` reported the same three. A disk is matched by its device and
//! inode, so a holder is found whatever name it opened the file by (a hard link, or a name
//! the file has since lost). The scan covers its own process too.
//!
//! # Which scan runs
//!
//! On macOS the mappings are read with a kernel query the SDK header does not declare. A
//! kernel that answered it with a slightly different meaning would turn this proof into a
//! false "nothing holds the disks", so every scan first tests the exact property on a
//! file of its own (`macos::method`). Only a scan whose test passed runs in this process.
//! Any other scan is the `lsof` child, whole, exactly as before ([`Lsof`]): one method
//! answers for one scan, so no answer mixes two views of the process table. Linux reads
//! documented files and always scans in process.
//!
//! [`last_scan`] records which method the pool's last scan used, and why when it was
//! `lsof`, in `disk-handle-scan.json` beside the owner record.
//!
//! # What each case answers
//!
//! "Not holding" lets the scan continue and pass. "Unknown" fails the whole scan as
//! `stop_uncertain`: a scan that cannot answer is never read as "nothing holds the disks".
//!
//! * A process that exits during the scan (`ESRCH`, or a vanished `/proc/<pid>`): not
//!   holding. It can issue no further I/O of its own. `lsof` answered the same.
//! * A process this user may not inspect, which is another user's or a system process
//!   (`EPERM`, on Linux also `EACCES`): not holding. The proof covers only what the user
//!   may inspect. `lsof`, run by the same user, was refused by the same processes and
//!   reported nothing for them, so this limit is unchanged.
//! * A descriptor or file port that is closed, replaced or revoked between its listing and
//!   its inspection: not holding through that descriptor.
//! * A descriptor table that grows while it is read: the table is read into a buffer, and
//!   a full buffer is never trusted, because the kernel truncates without an error. It is
//!   read again into a larger one, with no separate size query to go stale. The process
//!   list is read the same way.
//! * Any other error, an answer of the wrong size, a table or mapping list past its limit,
//!   an unreadable line of `/proc/<pid>/maps`: unknown. This is at least as strict as the
//!   `lsof` scan, which fails on anything `lsof` writes to its error stream.
//! * A disk whose device and inode cannot be read: unknown. `lsof` prints a status error,
//!   which also fails the scan.
//! * A scan that cannot start fails as `provider_spawn_failed`, whichever method it is.
//!
//! # Time bound
//!
//! The scan's time grows with the process count, with the memory regions those processes
//! have and with CPU contention, and one call into a stuck filesystem can block. So it
//! runs on its own threads and the caller waits at most its bound ([`STOP_HANDLE_WAIT`],
//! [`RELEASE_HANDLE_WAIT`]). A scan that does not finish in time fails as
//! `provider_timeout_uncertain`: `down` then writes no clean-stop marker and the next start
//! falls back to the fresh disk budget. The threads are told to stop and each ends at its
//! next process; the late answer is discarded. An `lsof` child is signalled and reaped.
//! Both bounds were set well above the slowest `lsof` scan measured on a loaded host and
//! are unchanged. `scripts/measure-lsof-scan.ts` re-measures a host.
//!
//! Finding mappings is nearly all of the time: the kernel walks every memory region of
//! every process, for this scan as it does for `lsof`. Descriptors and file ports alone
//! take a small fraction of it. The scan is faster than the `lsof` child because it walks
//! processes on several threads ([`SCAN_THREADS`]), not because it does less.
//!
//! The probe ([`HandleProbe`]) and the clock are injected, so tests drive both bounds with a
//! fake clock instead of the host's process table. Only the scan is replaceable; the result
//! is interpreted here the same way for every probe.
use crate::CandidateError;
use crate::provider::process::{self, Captured, Clock, Pending};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::time::Duration;

pub(super) mod last_scan;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "linux")]
use linux as host;
#[cfg(target_os = "macos")]
use macos as host;

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

/// One owned disk as the scan matches it: by device and inode, never by name.
#[derive(Clone, Debug)]
struct Disk {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Disk {
    fn identify(path: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path)?;
        Ok(Self {
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

/// How one scan reads the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum Method {
    /// The scan in this process.
    InProcess,
    /// The `lsof` child, because this scan could not trust the scan in this process.
    Lsof(Fallback),
}

/// Why a scan was left to `lsof`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum Fallback {
    /// The kernel did not answer the mapping query at all.
    QueryUnanswered,
    /// The kernel answered the mapping query, but not with the mapping the test made.
    SelfTestFailed,
    /// The test could not make its own file and mapping, so the query was not tested.
    SelfTestUnavailable,
}

/// How a process holds a disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Hold {
    /// An open file descriptor.
    Descriptor,
    /// A descriptor in transit in a Mach message (macOS only).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    FilePort,
    /// A memory mapping, with or without a descriptor.
    Mapping,
    /// `lsof` listed the process. Asked for process ids only, it does not say how.
    Listed,
}

/// One process holding one disk in one way.
#[derive(Debug)]
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

impl Holder {
    /// Record that `pid` holds `disk`, once for each way it holds it. `name` is asked for
    /// only when the hold is new.
    fn record(
        holders: &mut Vec<Holder>,
        pid: i32,
        hold: Hold,
        disk: &Disk,
        name: impl FnOnce() -> Option<PathBuf>,
    ) {
        let known = holders.iter().any(|holder| {
            holder.pid == pid && holder.hold == hold && holder.disk.as_ref() == Some(&disk.path)
        });
        if !known {
            holders.push(Holder {
                pid,
                hold,
                disk: Some(disk.path.clone()),
                name: name(),
            });
        }
    }
}

/// What one finished scan established.
#[derive(Debug, Default)]
pub(super) struct Found {
    /// Every hold the scan saw.
    pub(super) holders: Vec<Holder>,
    /// Every reason the scan could not answer for a disk or a process. One entry is enough
    /// to make the scan unable to prove the disks closed.
    pub(super) unknown: Vec<String>,
}

/// Why the inspection of one process ended before all of it was read.
#[derive(Debug, PartialEq, Eq)]
enum Ended {
    /// The process exited: not holding.
    Exited,
    /// This user may not inspect the process: not holding, as far as this user can prove.
    NotInspectable,
    /// The scan cannot answer for this process.
    Unknown(String),
}

/// Starts one scan for processes that hold any of the given disks.
pub(super) trait HandleProbe {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError>;
}

/// The scan of this host: in this process when this scan may trust it, else through
/// `lsof` (see the module header).
pub(super) struct HostScan<'a> {
    /// The pool's state directory, where the method each scan used is recorded.
    record: Option<&'a Path>,
}

impl<'a> HostScan<'a> {
    /// A scan that records its method in `pool`, the directory of the pool's owner record.
    pub(super) fn recording(pool: &'a Path) -> Self {
        Self { record: Some(pool) }
    }

    /// A scan that records nothing, for fixtures without a pool.
    #[cfg(test)]
    fn unrecorded() -> Self {
        Self { record: None }
    }
}

impl HandleProbe for HostScan<'_> {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        let method = host::method();
        if let Some(pool) = self.record {
            last_scan::record(pool, method);
        }
        match method {
            Method::InProcess => InProcess.start(disks),
            Method::Lsof(_) => Lsof::host()?.start(disks),
        }
    }
}

/// The scan in this process, on its own threads. [`HostScan`] decides when it may run.
struct InProcess;

impl HandleProbe for InProcess {
    fn start(&self, disks: &[PathBuf]) -> Result<Box<dyn Pending<Found>>, CandidateError> {
        let stop = Arc::new(AtomicBool::new(false));
        let (answer, finished) = mpsc::channel();
        let (disks, stopped) = (disks.to_vec(), stop.clone());
        std::thread::Builder::new()
            .name("disk-handle-scan".into())
            .spawn(move || {
                // The receiver is gone once the wait expired or failed; the answer is then
                // late and nobody may use it.
                let _ = answer.send(scan(&disks, &stopped));
            })
            .map_err(|error| CandidateError::new("provider_spawn_failed", error.to_string()))?;
        Ok(Box::new(Scanning {
            finished,
            found: None,
            lost: false,
            stop,
        }))
    }
}

/// A scan running on its threads. Dropping it tells them to stop.
struct Scanning {
    finished: Receiver<Found>,
    /// The answer, once [`Pending::wait`] received it and until the next poll takes it.
    found: Option<Found>,
    /// The scan ended without an answer, which only a panic in it does.
    lost: bool,
    stop: Arc<AtomicBool>,
}

impl Pending<Found> for Scanning {
    fn poll(&mut self) -> Result<Option<Found>, CandidateError> {
        if self.found.is_none() && !self.lost {
            match self.finished.try_recv() {
                Ok(found) => self.found = Some(found),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => self.lost = true,
            }
        }
        match self.found.take() {
            Some(found) => Ok(Some(found)),
            None if self.lost => Err(cannot_inspect()),
            None => Ok(None),
        }
    }

    fn expire(&mut self) -> CandidateError {
        self.stop.store(true, Ordering::Relaxed);
        CandidateError::new(
            "provider_timeout_uncertain",
            "Disk-handle scan timed out. Owned disks may still be held; inspect before retry.",
        )
    }

    /// Block until the scan answers, for at most `limit`.
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        if self.found.is_some() || self.lost {
            return;
        }
        let started = clock.now();
        match self.finished.recv_timeout(limit) {
            Ok(found) => self.found = Some(found),
            Err(RecvTimeoutError::Disconnected) => self.lost = true,
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

/// The host's `lsof`, with a clean environment: the scan before this module scanned in
/// process, and the fallback since.
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

/// The most threads one scan uses; it uses half the host's cores up to this. Most of a scan
/// is kernel time spent walking each process's memory regions, and several threads walk
/// different processes side by side. On an 18-core host with about 1,560 processes one
/// thread took about 1.0 s, four 0.38 s and eight 0.23 s (medians).
const SCAN_THREADS: usize = 8;

/// Inspect every process once for a hold on any of `paths`. `stop` ends the scan early, as
/// unknown.
fn scan(paths: &[PathBuf], stop: &AtomicBool) -> Found {
    scan_with(&host::Inspector::new, SCAN_THREADS, paths, stop)
}

/// [`scan`] on at most `threads` threads and at most half the host's cores, this thread
/// included, each with its own `inspector`.
fn scan_with(
    inspector: &(dyn Fn() -> host::Inspector + Sync),
    threads: usize,
    paths: &[PathBuf],
    stop: &AtomicBool,
) -> Found {
    let mut found = Found::default();
    let mut disks = Vec::with_capacity(paths.len());
    for path in paths {
        match Disk::identify(path) {
            Ok(disk) => disks.push(disk),
            Err(error) => found.unknown.push(format!("owned disk identity: {error}")),
        }
    }
    if !found.unknown.is_empty() {
        return found;
    }
    let processes = match host::processes() {
        Ok(processes) => processes,
        Err(why) => {
            found.unknown.push(why);
            return found;
        }
    };
    // Each thread takes the next process nobody has taken, so one large process does not
    // hold up a whole share of the list.
    let next = AtomicUsize::new(0);
    let inspect = || {
        let mut inspector = inspector();
        let mut found = Found::default();
        while let Some(pid) = processes.get(next.fetch_add(1, Ordering::Relaxed)) {
            if stop.load(Ordering::Relaxed) {
                found.unknown.push("scan stopped at its bound".into());
                break;
            }
            match inspector.inspect(*pid, &disks, &mut found.holders) {
                Ok(()) | Err(Ended::Exited | Ended::NotInspectable) => {}
                Err(Ended::Unknown(why)) => found.unknown.push(format!("process {pid}: {why}")),
            }
        }
        found
    };
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let helpers = (cores / 2)
        .min(threads)
        .min(processes.len())
        .saturating_sub(1);
    let parts = std::thread::scope(|scope| {
        // A helper that cannot start is not needed: the threads that did start share the
        // whole list.
        let helpers: Vec<_> = (0..helpers)
            .filter_map(|_| {
                std::thread::Builder::new()
                    .name("disk-handle-scan".into())
                    .spawn_scoped(scope, inspect)
                    .ok()
            })
            .collect();
        let mut parts = vec![Some(inspect())];
        parts.extend(helpers.into_iter().map(|helper| helper.join().ok()));
        parts
    });
    for part in parts {
        match part {
            Some(part) => {
                found.holders.extend(part.holders);
                found.unknown.extend(part.unknown);
            }
            // A helper panicked: the processes it had taken were not all inspected.
            None => found.unknown.push("a scan thread failed".into()),
        }
    }
    found.holders.sort_by_key(|holder| holder.pid);
    found
}

/// Prove no process holds any of `disks`, waiting at most `wait` on `clock` for the scan.
/// Only a scan that saw no holder and could answer for every disk and process it may
/// inspect proves it. A holder or an unknown fails as `stop_uncertain`, and a scan that
/// does not finish in time fails as `provider_timeout_uncertain`.
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
