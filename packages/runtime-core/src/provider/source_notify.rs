//! Host file changes under a shared project directory, forwarded to the guest's file-watch
//! hook by Hack itself (`HACK_NATIVE_HOT_RELOAD=watcher`).
//!
//! The pinned provider can do this, but only after reading every shared entry before the guest
//! starts (see `hot_reload`). The guest kernel's hook does not need that baseline: one event
//! for a path fires the file-watch event on the guest inode and refreshes the guest's cached
//! copy of it. So a small process per running project subscribes to the system's file events
//! for the project's share and forwards each change; the provider's own watcher stays off and
//! no pool boot waits for a scan.
//!
//! This file is the part with no effects: which host events matter, how a burst is bounded,
//! and which guest events each change becomes.
//!
//! Every change is forwarded by its own name, because a watcher on one file is not woken by
//! an event on the file's directory. Bounds, so an install of thousands of files on the host
//! can neither flood the guest nor hold up a later source edit for long:
//! - at most [`INGRESS_LIMIT`] notifications wait at any time; one more sets an overflow mark;
//! - changes are gathered for [`BATCH_WINDOW`], at most [`MAX_BATCH_NOTIFICATIONS`] at a time,
//!   and repeats of one path inside a batch are merged;
//! - a batch reaches the guest in requests of at most [`MAX_GUEST_EVENTS`] events and
//!   [`MAX_REQUEST_BYTES`] encoded bytes, one request in flight, on one kept connection.
//!
//! Changes are announced only as "something changed under the share" (an event on the share
//! root) in two cases: after an overflow, for everything that was waiting; and when a watcher
//! starts, for whatever changed while none was running. No change is ever turned into
//! silence.
//!
//! Only paths inside the share are named. The guest follows links when it resolves a path,
//! so a link is never named (its directory is, instead), and nothing is named below a
//! directory that is itself reached through a link.

use super::identity::{self, ProcessIdentity};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How long changes are gathered before they are sent together.
pub const BATCH_WINDOW: Duration = Duration::from_millis(50);
/// The most guest events one request may carry (the provider's own watcher uses the same).
pub const MAX_GUEST_EVENTS: usize = 256;
/// The most system notifications one batch takes from the queue; the rest wait for the next.
pub const MAX_BATCH_NOTIFICATIONS: usize = 8192;
/// The most encoded bytes of events one request may carry (the agent's frame is 64 KiB).
pub const MAX_REQUEST_BYTES: usize = 48 * 1024;
/// The most notifications that may wait to be forwarded. One more is not queued: it sets the
/// overflow mark, and everything waiting is then replaced by one event on the share root.
pub const INGRESS_LIMIT: usize = 40_960;
/// How often a failed request is tried again on a new connection to the same pool.
const DELIVERY_ATTEMPTS: usize = 3;
/// How long one batch may take to reach the guest.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
/// How often an idle watcher checks that it should still run.
const IDLE_POLL: Duration = Duration::from_millis(250);
/// How often an idle watcher verifies that the pool is still the one it started with.
const ALIVE_INTERVAL: Duration = Duration::from_secs(5);
/// Where the provider's agent mounts each share before binding it for containers.
const STAGING_ROOT: &str = "/run/smolvm/virtiofs";

/// The guest kernel's event bits (`include/linux/fsnotify_backend.h`), as the hook takes them.
pub mod mask {
    pub const MODIFY: u32 = 0x0000_0002;
    pub const ATTRIB: u32 = 0x0000_0004;
    pub const CLOSE_WRITE: u32 = 0x0000_0008;
    pub const CREATE: u32 = 0x0000_0100;
    pub const DELETE: u32 = 0x0000_0200;
    pub const ISDIR: u32 = 0x4000_0000;
}

/// What happened to one path under the share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The path exists now and did not before (also the new name of a rename).
    Created,
    /// The path's content or metadata changed.
    Changed,
    /// The path is gone (also the old name of a rename).
    Removed,
    /// Something under this directory changed and the details are not known.
    Rescan,
}

/// One change, by its path relative to the share root (empty for the root itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEvent {
    pub relative: PathBuf,
    pub kind: Kind,
    pub directory: bool,
}

impl HostEvent {
    /// "Something changed somewhere under the share": sent when a watcher starts or restarts
    /// and when the system reports that it dropped events.
    pub fn root_rescan() -> Self {
        Self {
            relative: PathBuf::new(),
            kind: Kind::Rescan,
            directory: true,
        }
    }
}

/// One line for the guest hook: a guest path and its event bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestEvent {
    pub path: String,
    pub mask: u32,
}

/// Changes that are never forwarded: Git's own bookkeeping. Everything else is, dependency
/// and build directories included, because a service may watch them.
pub fn ignored(relative: &Path) -> bool {
    relative
        .components()
        .any(|part| matches!(part, Component::Normal(name) if name == ".git"))
}

/// A relative path the hook can take: plain components, valid UTF-8, no control character
/// (the hook is line-based, and control characters grow when encoded).
fn sendable(relative: &Path) -> bool {
    relative.components().all(|part| match part {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|text| !text.chars().any(char::is_control)),
        _ => false,
    })
}

fn parent(relative: &Path) -> PathBuf {
    relative.parent().map(Path::to_path_buf).unwrap_or_default()
}

fn rescan(directory: PathBuf) -> HostEvent {
    HostEvent {
        relative: directory,
        kind: Kind::Rescan,
        directory: true,
    }
}

/// One batch: ignored paths dropped and repeats of one path merged. The order of first
/// appearance is kept, and every remaining change keeps its own name.
pub fn coalesce(events: Vec<HostEvent>) -> Vec<HostEvent> {
    // A name the hook cannot take is reported through its directory instead.
    let events = events.into_iter().filter_map(|event| {
        if ignored(&event.relative) {
            None
        } else if sendable(&event.relative) {
            Some(event)
        } else {
            let mut directory = parent(&event.relative);
            while !sendable(&directory) {
                directory = parent(&directory);
            }
            (!ignored(&directory)).then(|| rescan(directory))
        }
    });
    // The last kind wins, except that a change to a path created in this batch is still a
    // creation.
    let mut order: Vec<PathBuf> = Vec::new();
    let mut latest: BTreeMap<PathBuf, HostEvent> = BTreeMap::new();
    for event in events {
        match latest.get_mut(&event.relative) {
            None => {
                order.push(event.relative.clone());
                latest.insert(event.relative.clone(), event);
            }
            Some(known) => {
                if !(known.kind == Kind::Created && event.kind == Kind::Changed) {
                    known.kind = event.kind;
                }
                known.directory = known.directory || event.directory;
            }
        }
    }
    order
        .into_iter()
        .map(|path| latest.remove(&path).expect("merged event"))
        .collect()
}

/// The guest events for a batch. `base` is the share's own mount in the guest.
pub fn guest_events(base: &str, events: &[HostEvent]) -> Vec<GuestEvent> {
    let join = |relative: &Path| {
        let mut path = base.trim_end_matches('/').to_owned();
        for part in relative.components() {
            path.push('/');
            path.push_str(&part.as_os_str().to_string_lossy());
        }
        path
    };
    let folder = |directory: bool| if directory { mask::ISDIR } else { 0 };
    let written = |directory: bool| if directory { 0 } else { mask::CLOSE_WRITE };
    let mut lines = Vec::new();
    for event in events {
        let path = join(&event.relative);
        match event.kind {
            Kind::Created => lines.push(GuestEvent {
                path,
                mask: mask::MODIFY
                    | mask::ATTRIB
                    | mask::CREATE
                    | written(event.directory)
                    | folder(event.directory),
            }),
            Kind::Changed => lines.push(GuestEvent {
                path,
                mask: mask::MODIFY
                    | mask::ATTRIB
                    | written(event.directory)
                    | folder(event.directory),
            }),
            Kind::Removed => {
                lines.push(GuestEvent {
                    path,
                    mask: mask::DELETE | folder(event.directory),
                });
                lines.push(GuestEvent {
                    path: join(&parent(&event.relative)),
                    mask: mask::MODIFY | mask::ISDIR,
                });
            }
            Kind::Rescan => lines.push(GuestEvent {
                path,
                mask: mask::MODIFY | mask::ISDIR,
            }),
        }
    }
    lines
}

/// What a path is on the host now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    Directory,
    Link,
    Other,
}

/// What the file system says about a path now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    /// `None`: nothing is there.
    pub entry: Option<Entry>,
    /// The nearest directory above the path that exists and is reached through no link,
    /// relative to the share root. `None` when a link lies on the way.
    pub anchor: Option<PathBuf>,
}

/// Looks at `path` (under the canonical `root`) without following a link at the path itself.
pub fn probe(root: &Path, path: &Path) -> Seen {
    let entry = std::fs::symlink_metadata(path).ok().map(|metadata| {
        if metadata.file_type().is_symlink() {
            Entry::Link
        } else if metadata.is_dir() {
            Entry::Directory
        } else {
            Entry::Other
        }
    });
    if path == root {
        return Seen {
            entry,
            anchor: Some(PathBuf::new()),
        };
    }
    let mut above = path.parent();
    let anchor = loop {
        let Some(directory) = above.filter(|directory| directory.starts_with(root)) else {
            break None;
        };
        match std::fs::canonicalize(directory) {
            Ok(real) if real == directory => {
                break directory.strip_prefix(root).ok().map(Path::to_path_buf);
            }
            // A link on the way: nothing below it is named.
            Ok(_) => break None,
            // Gone (or unreadable): look further up.
            Err(_) => above = directory.parent(),
        }
    };
    Seen { entry, anchor }
}

/// The changes one system notification stands for. The system's kinds are hints: a rename
/// reports each name without saying which is which, and several changes to one path can
/// arrive merged. So what the path is now decides: present means created or changed, absent
/// means removed. A link, and anything the guest could only reach through a link or through
/// a directory that is gone, is reported through the nearest real directory above it.
pub fn from_notification(
    root: &Path,
    event: &notify::Event,
    probe: impl Fn(&Path) -> Seen,
) -> Vec<HostEvent> {
    use notify::EventKind;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    if event.need_rescan() {
        return vec![HostEvent::root_rescan()];
    }
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    let mut changes = Vec::new();
    for path in &event.paths {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let seen = probe(path);
        let Some(anchor) = seen.anchor else {
            changes.push(HostEvent::root_rescan());
            continue;
        };
        if anchor != parent(relative) {
            // The path's own directory is gone: its nearest real ancestor changed.
            changes.push(rescan(anchor));
            continue;
        }
        let was_folder = matches!(
            event.kind,
            EventKind::Remove(RemoveKind::Folder) | EventKind::Create(CreateKind::Folder)
        );
        let (kind, directory) = match (seen.entry, event.kind) {
            // A link is never named: the guest would follow it. So is a removed entry the
            // system did not call a file or a folder, which may have been one.
            (Some(Entry::Link), _) | (None, EventKind::Remove(RemoveKind::Other)) => {
                changes.push(rescan(anchor));
                continue;
            }
            (None, _) => (Kind::Removed, was_folder),
            (Some(entry), EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))) => {
                (Kind::Created, entry == Entry::Directory)
            }
            (Some(entry), _) => (Kind::Changed, entry == Entry::Directory),
        };
        changes.push(HostEvent {
            relative: relative.to_path_buf(),
            kind,
            directory,
        });
    }
    changes
}

/// What one event adds to a request once encoded: the path with its escapes (control
/// characters never reach here), the mask and the punctuation around them.
fn encoded_bytes(line: &GuestEvent) -> usize {
    line.path.len()
        + line
            .path
            .bytes()
            .filter(|byte| matches!(byte, b'"' | b'\\'))
            .count()
        + 40
}

/// A batch as the requests that carry it: each within the event and encoded-byte bounds, in
/// order, nothing dropped.
pub fn requests(base: &str, events: Vec<HostEvent>) -> Vec<Vec<GuestEvent>> {
    let mut requests: Vec<Vec<GuestEvent>> = Vec::new();
    let mut bytes = 0;
    for line in guest_events(base, &coalesce(events)) {
        let size = encoded_bytes(&line);
        let full = requests.last().is_none_or(|request| {
            request.len() >= MAX_GUEST_EVENTS || bytes + size > MAX_REQUEST_BYTES
        });
        if full {
            requests.push(Vec::new());
            bytes = 0;
        }
        bytes += size;
        requests.last_mut().expect("open request").push(line);
    }
    requests
}

fn unavailable(message: &'static str) -> CandidateError {
    CandidateError::new("source_notify_unavailable", message)
}

/// Forwards changes until the queue closes or `stop` is set.
///
/// It opens with one event on the share root, and that event is also the check that the
/// guest path exists: unless the guest reports the hook present and exactly that one event
/// fired, nothing else is ever sent and the caller learns why. A watcher that starts again
/// therefore tells the guest "something changed under the share" before any path event.
///
/// `overflow` is set by whoever fills the queue when a notification did not fit; everything
/// waiting is then dropped and one event on the share root is sent in its place.
/// `deliver` returns how many events fired and whether the hook exists; an error from it ends
/// the watcher. `alive` is called on an idle watcher every few seconds and ends it when the
/// pool or the project directory is no longer the same.
pub fn forward(
    root: &Path,
    base: &str,
    changes: &Receiver<notify::Result<notify::Event>>,
    overflow: &AtomicBool,
    stop: &AtomicBool,
    mut deliver: impl FnMut(&[GuestEvent]) -> Result<(u32, bool), CandidateError>,
    mut alive: impl FnMut() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let root_event = guest_events(base, &[HostEvent::root_rescan()]);
    match deliver(&root_event)? {
        (1, true) => {}
        (_, false) => {
            return Err(unavailable(
                "This guest has no file-watch hook; host file changes cannot be forwarded.",
            ));
        }
        _ => {
            return Err(unavailable(
                "The share's mount was not found in the guest; no file change was forwarded.",
            ));
        }
    }
    let mut verified = Instant::now();
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if overflow.swap(false, Ordering::AcqRel) {
            // More arrived than may wait. What is queued now is given up (at most the
            // queue's capacity, so this ends) and announced as one event on the root.
            for _ in 0..INGRESS_LIMIT {
                if changes.try_recv().is_err() {
                    break;
                }
            }
            deliver(&root_event)?;
            verified = Instant::now();
            continue;
        }
        let first = match changes.recv_timeout(IDLE_POLL) {
            Ok(notification) => notification,
            Err(RecvTimeoutError::Timeout) => {
                if verified.elapsed() >= ALIVE_INTERVAL {
                    alive()?;
                    verified = Instant::now();
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        // Gather what arrives inside the window; a burst beyond the cap waits its turn.
        let mut notifications = vec![first];
        let window = Instant::now() + BATCH_WINDOW;
        while notifications.len() < MAX_BATCH_NOTIFICATIONS {
            let remaining = window.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match changes.recv_timeout(remaining) {
                Ok(notification) => notifications.push(notification),
                Err(_) => break,
            }
        }
        let mut host = Vec::new();
        for notification in &notifications {
            match notification {
                Ok(event) => host.extend(from_notification(root, event, |path| probe(root, path))),
                // The system could not say what changed: something did.
                Err(_) => host.push(HostEvent::root_rescan()),
            }
        }
        for request in requests(base, host) {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            deliver(&request)?;
            verified = Instant::now();
        }
    }
}

/// What `runtime status` says about one project's watcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatcherStatus {
    pub project: PathBuf,
    /// False once the recorded process is gone: until a watcher runs again the project has
    /// no hot reload (edits reach services after up to about 5 seconds, watchers do not fire).
    pub running: bool,
}

/// A running watcher's own note, so status can tell a live watcher from a dead one.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    project: PathBuf,
    process: ProcessIdentity,
}

/// The most watcher notes status reads (a pool shares at most eight projects).
const MAX_RECORDS: usize = 64;

fn records(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/source-notify")
}

fn record_path(candidate: &Candidate, project: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = format!(
        "{:x}",
        Sha256::digest(project.as_os_str().as_encoded_bytes())
    );
    records(candidate).join(format!("{}.json", &digest[..32]))
}

/// Notes that this process forwards changes for `project`. Advisory: a failure to write it
/// costs only the status line, never the forwarding.
fn announce(candidate: &Candidate, project: &Path) -> Option<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let process = identity::observe(i32::try_from(std::process::id()).ok()?).ok()?;
    let directory = records(candidate);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .ok()?;
    let path = record_path(candidate, project);
    let pending = path.with_extension(format!("{}.new", process.pid));
    let bytes = serde_json::to_vec(&Record {
        version: 1,
        project: project.to_path_buf(),
        process,
    })
    .ok()?;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .and_then(|mut file| file.write_all(&bytes))
        .and_then(|()| std::fs::rename(&pending, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&pending);
        return None;
    }
    Some(path)
}

/// Removes this process's note, and only this process's: a later watcher for the same
/// project may have written its own at the same path.
fn retract(path: &Path) {
    let ours = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
        .is_some_and(|record| {
            i32::try_from(std::process::id())
                .ok()
                .and_then(|pid| identity::observe(pid).ok())
                .is_some_and(|own| {
                    own.pid == record.process.pid && own.start_micros == record.process.start_micros
                })
        });
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

fn running(process: &ProcessIdentity) -> bool {
    identity::observe(process.pid).is_ok_and(|now| {
        now.start_micros == process.start_micros && now.executable == process.executable
    })
}

/// The watchers this home has notes for, and whether each is still that same process.
/// Unreadable notes are skipped: status never fails because of them.
pub fn watchers(candidate: &Candidate) -> Vec<WatcherStatus> {
    let Ok(entries) = std::fs::read_dir(records(candidate)) else {
        return Vec::new();
    };
    let mut found: Vec<WatcherStatus> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|kind| kind == "json"))
        .take(MAX_RECORDS)
        .filter_map(|entry| {
            let bytes = std::fs::read(entry.path()).ok()?;
            let record: Record = serde_json::from_slice(&bytes).ok()?;
            (record.version == 1).then(|| WatcherStatus {
                running: running(&record.process),
                project: record.project,
            })
        })
        .collect();
    found.sort_by(|left, right| left.project.cmp(&right.project));
    found
}

/// The long-running command behind `runtime source-notify`: watches `project`, which must be
/// one of this pool's shares, and forwards its changes until the pool or the directory
/// changes, the process is stopped or, with `until_stdin_closes`, its parent closes its input
/// (or exits).
pub fn watch(
    candidate: &Candidate,
    project: &Path,
    until_stdin_closes: bool,
) -> Result<(), CandidateError> {
    use notify::Watcher;
    use std::os::unix::fs::MetadataExt;
    let failed = |message: &'static str| CandidateError::new("source_notify", message);
    let root = project
        .canonicalize()
        .map_err(|_| failed("Cannot resolve the project directory."))?;
    let guest = super::lifecycle::ObservedGuest::connect(candidate)?;
    let (position, device, inode) = guest
        .share(&root)
        .ok_or_else(|| failed("This pool does not share that project directory."))?;
    // The directory at this path must be the one the pool mounted, now and for as long as
    // the watcher runs: a directory moved into its place is not what the guest sees.
    let same_directory = || {
        std::fs::symlink_metadata(&root)
            .is_ok_and(|now| now.is_dir() && now.dev() == device && now.ino() == inode)
            .then_some(())
            .ok_or_else(|| failed("The project directory is not the one this pool shares."))
    };
    same_directory()?;
    // `ObservedGuest::connect` audited the provider's recorded mounts: the engine first, then
    // the shares in receipt order. The agent names each mount by that position.
    let base = format!("{STAGING_ROOT}/smolvm{}", position + 1);
    let (sender, changes) = std::sync::mpsc::sync_channel(INGRESS_LIMIT);
    let overflow = std::sync::Arc::new(AtomicBool::new(false));
    let overflowed = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |notification| {
        // Never blocks the system's callback: what does not fit sets the mark instead.
        if sender.try_send(notification).is_err() {
            overflowed.store(true, Ordering::Release);
        }
    })
    .map_err(|_| failed("The system's file events are unavailable."))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|_| failed("Cannot watch the project directory."))?;
    same_directory()?;
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    if until_stdin_closes {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("source-notify-stdin".into())
            .spawn(move || {
                let mut sink = [0_u8; 64];
                let mut input = std::io::stdin().lock();
                while matches!(std::io::Read::read(&mut input, &mut sink), Ok(count) if count > 0) {
                }
                stop.store(true, Ordering::Release);
            })
            .map_err(|_| failed("Cannot observe the parent process."))?;
    }
    // Written once the opening event has fired, removed when this process ends cleanly.
    let note = std::cell::RefCell::new(None::<PathBuf>);
    let announced = std::cell::Cell::new(false);
    let trace = std::env::var_os("HACK_LOCAL_SOURCE_NOTIFY_TRACE").is_some();
    let mut channel = guest.notify_channel()?;
    let result = forward(
        &root,
        &base,
        &changes,
        &overflow,
        &stop,
        |lines| {
            // A request that fails for a passing reason (a busy agent, a dropped connection)
            // is tried again on a new connection, which is bound to the same pool or
            // refused. A pool that changed is never retried.
            let mut attempt = 1;
            let fired = loop {
                match guest.notify_files(&mut channel, lines, DELIVERY_TIMEOUT) {
                    Ok(fired) => break fired,
                    Err(error)
                        if attempt < DELIVERY_ATTEMPTS
                            && error.code == "agent_protocol_uncertain" =>
                    {
                        attempt += 1;
                        std::thread::sleep(Duration::from_millis(200));
                        channel = guest.notify_channel()?;
                    }
                    Err(error) => return Err(error),
                }
            };
            if !announced.replace(true) && fired == (1, true) {
                *note.borrow_mut() = announce(candidate, &root);
                use std::io::Write;
                // One line for the parent: forwarding has begun. A parent that is gone is
                // noticed through its closed input, not here.
                let _ = writeln!(std::io::stdout(), "source-notify: forwarding");
                let _ = std::io::stdout().flush();
            }
            if trace {
                eprintln!("source-notify: {} events, {} fired", lines.len(), fired.0);
            }
            Ok(fired)
        },
        || {
            same_directory()?;
            guest.verify()
        },
    );
    if let Some(path) = note.into_inner() {
        retract(&path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
    use notify::{Event, EventKind};

    fn change(path: &str, kind: Kind) -> HostEvent {
        HostEvent {
            relative: PathBuf::from(path),
            kind,
            directory: false,
        }
    }
    const BASE: &str = "/run/smolvm/virtiofs/smolvm1";

    #[test]
    fn each_change_becomes_the_guest_events_a_watcher_expects() {
        let lines = guest_events(
            BASE,
            &[
                change("src/app.ts", Kind::Changed),
                change("src/new.ts", Kind::Created),
                change("src/old.ts", Kind::Removed),
                HostEvent {
                    relative: "src/lib".into(),
                    kind: Kind::Created,
                    directory: true,
                },
                HostEvent {
                    relative: "gone".into(),
                    kind: Kind::Removed,
                    directory: true,
                },
                HostEvent::root_rescan(),
            ],
        );
        let line = |path: &str, mask: u32| GuestEvent {
            path: format!("{BASE}{path}"),
            mask,
        };
        assert_eq!(
            lines,
            vec![
                // An edit: modified, attributes, and closed after writing.
                line("/src/app.ts", 0x2 | 0x4 | 0x8),
                line("/src/new.ts", 0x2 | 0x4 | 0x8 | 0x100),
                // A removal names the entry and wakes its directory.
                line("/src/old.ts", 0x200),
                line("/src", 0x2 | 0x4000_0000),
                line("/src/lib", 0x2 | 0x4 | 0x100 | 0x4000_0000),
                line("/gone", 0x200 | 0x4000_0000),
                line("", 0x2 | 0x4000_0000),
                // The share root itself.
                line("", 0x2 | 0x4000_0000),
            ]
        );
        // A trailing slash on the base changes nothing.
        assert_eq!(
            guest_events("/base/", &[change("a", Kind::Changed)])[0].path,
            "/base/a"
        );
    }

    #[test]
    fn git_bookkeeping_is_never_forwarded_and_dependencies_are() {
        for path in [".git/index", ".git", "packages/x/.git/HEAD"] {
            assert!(ignored(Path::new(path)), "{path}");
        }
        for path in [
            "node_modules/pkg/index.js",
            "dist/app.js",
            ".next/cache/x",
            ".gitignore",
            "src/.github/x",
        ] {
            assert!(!ignored(Path::new(path)), "{path}");
        }
        assert_eq!(
            coalesce(vec![
                change(".git/index", Kind::Changed),
                change("src/a.ts", Kind::Changed),
            ]),
            vec![change("src/a.ts", Kind::Changed)]
        );
    }

    #[test]
    fn repeats_of_one_path_merge_and_keep_what_matters() {
        let merged = coalesce(vec![
            change("a", Kind::Created),
            change("b", Kind::Changed),
            change("a", Kind::Changed),
            change("b", Kind::Removed),
            change("c", Kind::Removed),
            change("c", Kind::Created),
        ]);
        assert_eq!(
            merged,
            vec![
                // Created and then written in the same batch is still a creation.
                change("a", Kind::Created),
                change("b", Kind::Removed),
                // Removed and created again exists now.
                change("c", Kind::Created),
            ]
        );
    }

    #[test]
    fn every_change_keeps_its_own_name_however_many_share_a_directory() {
        // 300 files changed in one directory (a branch switch): each one is named, because
        // a watcher on one of those files is not woken by an event on the directory.
        let events: Vec<HostEvent> = (0..300)
            .map(|n| change(&format!("src/f{n}.ts"), Kind::Changed))
            .collect();
        let sent = requests(BASE, events);
        assert_eq!(sent.iter().map(Vec::len).collect::<Vec<_>>(), vec![256, 44]);
        let paths: Vec<&str> = sent
            .iter()
            .flatten()
            .map(|line| line.path.as_str())
            .collect();
        for n in 0..300 {
            assert!(
                paths.contains(&format!("{BASE}/src/f{n}.ts").as_str()),
                "{n}"
            );
        }
        assert!(requests(BASE, vec![change(".git/index", Kind::Changed)]).is_empty());
    }

    #[test]
    fn an_install_burst_is_carried_in_bounded_requests_in_order() {
        // 10,000 files written by an install on the host, then one source edit.
        let mut burst: Vec<HostEvent> = (0..10_000)
            .map(|n| change(&format!("node_modules/p{}/f{n}.js", n % 100), Kind::Created))
            .collect();
        burst.push(change("src/app.ts", Kind::Changed));
        let sent = requests(BASE, burst);
        assert_eq!(sent.len(), 10_001_usize.div_ceil(MAX_GUEST_EVENTS));
        for request in &sent {
            assert!(request.len() <= MAX_GUEST_EVENTS);
            assert!(request.iter().map(encoded_bytes).sum::<usize>() <= MAX_REQUEST_BYTES);
        }
        assert_eq!(sent.iter().map(Vec::len).sum::<usize>(), 10_001);
        // The edit that came last is the last line, by name.
        assert_eq!(
            sent.last().unwrap().last().unwrap(),
            &GuestEvent {
                path: format!("{BASE}/src/app.ts"),
                mask: 0x2 | 0x4 | 0x8,
            }
        );
    }

    #[test]
    fn long_paths_split_requests_by_bytes_as_well_as_by_count() {
        let deep = "d".repeat(200);
        let events: Vec<HostEvent> = (0..200)
            .map(|n| change(&format!("src/{deep}/{deep}{n}/x.ts"), Kind::Changed))
            .collect();
        let sent = requests(BASE, events);
        assert!(sent.len() > 1);
        assert_eq!(sent.iter().map(Vec::len).sum::<usize>(), 200);
        for request in &sent {
            assert!(request.iter().map(encoded_bytes).sum::<usize>() <= MAX_REQUEST_BYTES);
        }
    }

    #[test]
    fn a_name_the_hook_cannot_take_is_reported_through_its_directory() {
        use std::os::unix::ffi::OsStrExt;
        let broken = PathBuf::from("src").join(std::ffi::OsStr::from_bytes(b"bad\nname.ts"));
        let invalid = PathBuf::from("src").join(std::ffi::OsStr::from_bytes(b"\xff.ts"));
        let bounded = coalesce(vec![
            HostEvent {
                relative: broken,
                kind: Kind::Changed,
                directory: false,
            },
            HostEvent {
                relative: invalid,
                kind: Kind::Created,
                directory: false,
            },
        ]);
        assert_eq!(bounded, vec![rescan("src".into())]);
        for line in guest_events(BASE, &bounded) {
            assert!(!line.path.contains('\n'));
        }
    }

    /// A probe answer for a path whose own directory is real.
    fn seen(path: &Path, entry: Option<Entry>) -> Seen {
        Seen {
            entry,
            anchor: Some(
                path.strip_prefix("/project")
                    .ok()
                    .and_then(Path::parent)
                    .map(Path::to_path_buf)
                    .unwrap_or_default(),
            ),
        }
    }

    #[test]
    fn what_the_path_is_now_decides_what_a_notification_means() {
        let root = Path::new("/project");
        let event = |kind: EventKind, paths: &[&str]| {
            let mut event = Event::new(kind);
            for path in paths {
                event = event.add_path(PathBuf::from(path));
            }
            event
        };
        let present = |path: &Path| seen(path, Some(Entry::Other));
        let folder = |path: &Path| seen(path, Some(Entry::Directory));
        let absent = |path: &Path| seen(path, None);
        let one =
            |event: &Event, probe: &dyn Fn(&Path) -> Seen| from_notification(root, event, probe);
        let created = event(EventKind::Create(CreateKind::File), &["/project/src/a.ts"]);
        assert_eq!(
            one(&created, &present),
            vec![change("src/a.ts", Kind::Created)]
        );
        // Created and already gone again: a removal, never a creation of nothing.
        assert_eq!(
            one(&created, &absent),
            vec![change("src/a.ts", Kind::Removed)]
        );
        let written = event(
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            &["/project/src/a.ts"],
        );
        assert_eq!(
            one(&written, &present),
            vec![change("src/a.ts", Kind::Changed)]
        );
        // A rename reports each name; presence tells old from new.
        let renamed = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            &["/project/src/a.ts"],
        );
        assert_eq!(
            one(&renamed, &present),
            vec![change("src/a.ts", Kind::Created)]
        );
        assert_eq!(
            one(&renamed, &absent),
            vec![change("src/a.ts", Kind::Removed)]
        );
        let removed_folder = event(EventKind::Remove(RemoveKind::Folder), &["/project/old"]);
        assert_eq!(
            one(&removed_folder, &absent),
            vec![HostEvent {
                relative: "old".into(),
                kind: Kind::Removed,
                directory: true
            }]
        );
        let new_folder = event(EventKind::Create(CreateKind::Any), &["/project/lib"]);
        assert_eq!(
            one(&new_folder, &folder),
            vec![HostEvent {
                relative: "lib".into(),
                kind: Kind::Created,
                directory: true
            }]
        );
        // Reads are not changes; paths outside the share are not ours.
        let read = event(
            EventKind::Access(notify::event::AccessKind::Read),
            &["/project/src/a.ts"],
        );
        assert!(one(&read, &present).is_empty());
        let outside = event(EventKind::Create(CreateKind::File), &["/elsewhere/a.ts"]);
        assert!(one(&outside, &present).is_empty());
        // "Events were dropped" is a root-level event, never silence.
        let dropped = event(EventKind::Other, &["/project"]).set_flag(notify::event::Flag::Rescan);
        assert_eq!(one(&dropped, &present), vec![HostEvent::root_rescan()]);
        // The root itself changing is an event on the root.
        let root_changed = event(EventKind::Modify(ModifyKind::Any), &["/project"]);
        assert_eq!(
            one(&root_changed, &folder),
            vec![HostEvent {
                relative: PathBuf::new(),
                kind: Kind::Changed,
                directory: true
            }]
        );
    }

    #[test]
    fn a_link_and_anything_reached_through_one_is_never_named() {
        let root = Path::new("/project");
        let changed = |path: &str| {
            Event::new(EventKind::Modify(ModifyKind::Any)).add_path(PathBuf::from(path))
        };
        // A link in the share: the guest would follow it out of the share, so its directory
        // is reported instead.
        let link = |path: &Path| seen(path, Some(Entry::Link));
        assert_eq!(
            from_notification(root, &changed("/project/src/link"), link),
            vec![rescan("src".into())]
        );
        // A removed entry the system did not call a file or a folder may have been a link.
        let gone = |path: &Path| seen(path, None);
        let removed = Event::new(EventKind::Remove(RemoveKind::Other))
            .add_path(PathBuf::from("/project/src/link"));
        assert_eq!(
            from_notification(root, &removed, gone),
            vec![rescan("src".into())]
        );
        // A path below a directory that is itself a link: nothing below it is named.
        let through_link = |_: &Path| Seen {
            entry: Some(Entry::Other),
            anchor: None,
        };
        assert_eq!(
            from_notification(root, &changed("/project/linked/x.ts"), through_link),
            vec![HostEvent::root_rescan()]
        );
        // A path whose own directory is gone (a removed tree): the nearest real directory
        // above it is what changed.
        let parent_gone = |_: &Path| Seen {
            entry: None,
            anchor: Some("build".into()),
        };
        assert_eq!(
            from_notification(root, &changed("/project/build/out/deep/x.o"), parent_gone),
            vec![rescan("build".into())]
        );
    }

    #[test]
    fn probe_sees_links_and_the_nearest_real_directory() {
        let root = std::env::temp_dir().join(format!(
            "hack-source-notify-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("dir/sub")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("dir/file"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("dir"), root.join("link")).unwrap();
        let at = |path: &str| probe(&root, &root.join(path));
        assert_eq!(
            at("dir"),
            Seen {
                entry: Some(Entry::Directory),
                anchor: Some(PathBuf::new())
            }
        );
        assert_eq!(
            at("dir/file"),
            Seen {
                entry: Some(Entry::Other),
                anchor: Some("dir".into())
            }
        );
        // A link is an entry of its own, not the directory it points at.
        assert_eq!(at("link").entry, Some(Entry::Link));
        // Below a link: no anchor, so nothing is named.
        assert_eq!(at("link/file").anchor, None);
        // Gone, with its directory gone too: the nearest directory that still exists.
        assert_eq!(
            at("dir/removed/deep/x"),
            Seen {
                entry: None,
                anchor: Some("dir".into())
            }
        );
        assert_eq!(at("absent").entry, None);
        // The root itself.
        assert_eq!(
            probe(&root, &root),
            Seen {
                entry: Some(Entry::Directory),
                anchor: Some(PathBuf::new())
            }
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A real project directory, removed again when the test ends.
    struct Project(PathBuf);
    impl std::ops::Deref for Project {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A real, canonical project directory: `forward` looks at the file system.
    fn project() -> Project {
        let root = std::env::temp_dir().join(format!(
            "hack-source-notify-forward-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for package in 0..100 {
            std::fs::create_dir_all(root.join(format!("node_modules/p{package}"))).unwrap();
        }
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join("src/app.ts"), b"x").unwrap();
        Project(root.canonicalize().unwrap())
    }

    fn notification(path: &Path) -> notify::Result<Event> {
        Ok(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(path.to_path_buf()),
        )
    }

    /// Runs `forward` over prepared notifications with a recording guest.
    fn run(
        root: &Path,
        notifications: Vec<notify::Result<Event>>,
        opening: Result<(u32, bool), &'static str>,
    ) -> (Result<(), CandidateError>, Vec<Vec<GuestEvent>>) {
        let (sender, changes) = std::sync::mpsc::channel();
        for notification in notifications {
            sender.send(notification).unwrap();
        }
        drop(sender);
        let sent = std::cell::RefCell::new(Vec::new());
        let result = forward(
            root,
            BASE,
            &changes,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
            |lines| {
                let first = sent.borrow().is_empty();
                sent.borrow_mut().push(lines.to_vec());
                if first {
                    return opening.map_err(|code| CandidateError::new(code, "refused"));
                }
                Ok((lines.len() as u32, true))
            },
            || Ok(()),
        );
        (result, sent.into_inner())
    }

    #[test]
    fn a_watcher_opens_with_the_root_event_before_any_path_event() {
        let root = project();
        let (result, sent) = run(
            &root,
            vec![notification(&root.join("src/a.ts"))],
            Ok((1, true)),
        );
        result.unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[0],
            vec![GuestEvent {
                path: BASE.into(),
                mask: 0x2 | 0x4000_0000
            }]
        );
        // The file is absent on this host, so the change reads as a removal: by name, after
        // the root event, never before it.
        assert_eq!(sent[1][0].path, format!("{BASE}/src/a.ts"));
    }

    #[test]
    fn a_failed_opening_check_sends_nothing_else_and_says_why() {
        let root = project();
        // The root event did not fire: the path is not the share. Nothing goes to a guess.
        for (answer, text) in [
            ((0, true), "mount was not found"),
            ((2, true), "mount was not found"),
            ((0, false), "no file-watch hook"),
            ((1, false), "no file-watch hook"),
        ] {
            let (result, sent) = run(
                &root,
                vec![notification(&root.join("src/a.ts"))],
                Ok(answer),
            );
            let error = result.unwrap_err();
            assert_eq!(error.code, "source_notify_unavailable", "{answer:?}");
            assert!(error.message.contains(text), "{}", error.message);
            assert!(error.message_fixed);
            assert_eq!(sent.len(), 1, "{answer:?}");
        }
        // A refused request ends the watcher with that refusal, again after one attempt.
        let (result, sent) = run(
            &root,
            vec![notification(&root.join("a"))],
            Err("runtime_changed"),
        );
        assert_eq!(result.unwrap_err().code, "runtime_changed");
        assert_eq!(sent.len(), 1);
    }

    #[test]
    fn a_burst_then_an_edit_reaches_the_guest_by_name_within_two_batches() {
        let root = project();
        let mut notifications: Vec<notify::Result<Event>> = (0..10_000)
            .map(|n| notification(&root.join(format!("node_modules/p{}/f{n}.js", n % 100))))
            .collect();
        notifications.push(Err(notify::Error::generic("dropped")));
        notifications.push(notification(&root.join("src/app.ts")));
        let (result, sent) = run(&root, notifications, Ok((1, true)));
        result.unwrap();
        for request in &sent {
            assert!(request.len() <= MAX_GUEST_EVENTS, "{}", request.len());
        }
        let all: Vec<&GuestEvent> = sent.iter().skip(1).flatten().collect();
        // Nothing was given up: every one of the 10,000 files is named (each is absent on
        // this host, so it reads as a removal: its own line and its directory's).
        let named = |path: String| all.iter().any(|line| line.path == path);
        for n in [0, 4_999, 8_191, 8_192, 9_999] {
            assert!(
                named(format!("{BASE}/node_modules/p{}/f{n}.js", n % 100)),
                "{n}"
            );
        }
        // 10,002 notifications are two batches (8,192 and the rest); the edit is in the
        // second, by name, and is the last thing sent.
        assert!(named(format!("{BASE}/src/app.ts")));
        assert!(
            sent.last()
                .unwrap()
                .iter()
                .any(|line| line.path == format!("{BASE}/src/app.ts"))
        );
        // The notification the system could not describe became an event on the share root.
        assert!(named(BASE.to_owned()));
    }

    #[test]
    fn an_overflow_becomes_one_root_event_and_later_changes_are_named_again() {
        let root = project();
        let (sender, changes) = std::sync::mpsc::sync_channel(64);
        // The queue filled and one more notification did not fit.
        for n in 0..64 {
            sender
                .try_send(notification(&root.join(format!("build/out{n}.o"))))
                .unwrap();
        }
        assert!(
            sender
                .try_send(notification(&root.join("build/lost.o")))
                .is_err()
        );
        let overflow = AtomicBool::new(true);
        let sent = std::cell::RefCell::new(Vec::<Vec<GuestEvent>>::new());
        let later = std::cell::Cell::new(Some(sender));
        forward(
            &root,
            BASE,
            &changes,
            &overflow,
            &AtomicBool::new(false),
            |lines| {
                sent.borrow_mut().push(lines.to_vec());
                // After the overflow is answered, one more change arrives and the queue closes.
                if sent.borrow().len() == 2 {
                    if let Some(sender) = later.take() {
                        sender.send(notification(&root.join("src/app.ts"))).unwrap();
                    }
                }
                Ok((lines.len() as u32, true))
            },
            || Ok(()),
        )
        .unwrap();
        let sent = sent.into_inner();
        let root = vec![GuestEvent {
            path: BASE.into(),
            mask: 0x2 | 0x4000_0000,
        }];
        // Opening event; everything that was waiting as one root event; then the later edit
        // by name.
        assert_eq!(
            sent.len(),
            3,
            "{:?}",
            sent.iter().map(Vec::len).collect::<Vec<_>>()
        );
        assert_eq!(sent[0], root);
        assert_eq!(sent[1], root);
        assert_eq!(sent[2][0].path, format!("{BASE}/src/app.ts"));
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[test]
    fn a_request_that_fails_ends_the_watcher_with_that_failure() {
        let root = project();
        let (sender, changes) = std::sync::mpsc::channel();
        for n in 0..600 {
            sender
                .send(notification(&root.join(format!("src/f{n}.ts"))))
                .unwrap();
        }
        drop(sender);
        let calls = std::cell::Cell::new(0);
        let error = forward(
            &root,
            BASE,
            &changes,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
            |lines| {
                calls.set(calls.get() + 1);
                // The opening event and the first request succeed; the second request fails.
                if calls.get() == 3 {
                    return Err(CandidateError::new("agent_protocol_uncertain", "timeout"));
                }
                Ok((lines.len() as u32, true))
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, "agent_protocol_uncertain");
        // Nothing further was attempted after the failure: the caller restarts the watcher,
        // which opens with the root event.
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn encoded_size_bounds_a_request_whatever_the_names_hold() {
        // Names full of characters that double when encoded.
        let quoted = "\"\\".repeat(100);
        let events: Vec<HostEvent> = (0..256)
            .map(|n| change(&format!("src/{quoted}{n}.ts"), Kind::Changed))
            .collect();
        let sent = requests(BASE, events);
        assert!(sent.len() > 1);
        for request in &sent {
            let encoded = serde_json::to_vec(
                &request
                    .iter()
                    .map(|line| serde_json::json!({"path": line.path, "mask": line.mask}))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            assert!(encoded.len() <= MAX_REQUEST_BYTES, "{}", encoded.len());
        }
        // A control character in a name is never sent: its directory is reported instead.
        let control = coalesce(vec![change("src/a\u{1}b.ts", Kind::Changed)]);
        assert_eq!(control, vec![rescan("src".into())]);
    }

    #[test]
    fn a_stopped_or_idle_watcher_ends_or_verifies() {
        let (_sender, changes) = std::sync::mpsc::channel::<notify::Result<Event>>();
        // Stop is honoured without any change arriving.
        let stop = AtomicBool::new(true);
        forward(
            Path::new("/project"),
            BASE,
            &changes,
            &AtomicBool::new(false),
            &stop,
            |_| Ok((1, true)),
            || panic!("a stopped watcher verifies nothing"),
        )
        .unwrap();
        // A pool that is no longer the same ends an idle watcher with that reason.
        let stop = AtomicBool::new(false);
        let started = Instant::now();
        let error = forward(
            Path::new("/project"),
            BASE,
            &changes,
            &AtomicBool::new(false),
            &stop,
            |_| Ok((1, true)),
            || Err(CandidateError::new("runtime_changed", "changed")),
        )
        .unwrap_err();
        assert_eq!(error.code, "runtime_changed");
        assert!(started.elapsed() >= ALIVE_INTERVAL);
    }

    #[test]
    fn status_tells_a_live_watcher_from_a_dead_one() {
        let home = std::env::temp_dir().join(format!(
            "hack-source-notify-status-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        candidate.state_root = home.clone();
        assert_eq!(watchers(&candidate), Vec::new());
        // This test process announces itself: it is running.
        let live = Path::new("/project/live");
        let note = announce(&candidate, live).expect("note written");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&note).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A note whose process is gone (the same pid with another start time): not running.
        let mut dead: Record = serde_json::from_slice(&std::fs::read(&note).unwrap()).unwrap();
        dead.project = PathBuf::from("/project/dead");
        dead.process.start_micros += 1;
        std::fs::write(
            record_path(&candidate, &dead.project),
            serde_json::to_vec(&dead).unwrap(),
        )
        .unwrap();
        // Anything unreadable is skipped, never an error.
        std::fs::write(records(&candidate).join("junk.json"), b"not json").unwrap();
        std::fs::write(records(&candidate).join("other.txt"), b"ignored").unwrap();
        assert_eq!(
            watchers(&candidate),
            vec![
                WatcherStatus {
                    project: "/project/dead".into(),
                    running: false
                },
                WatcherStatus {
                    project: live.into(),
                    running: true
                },
            ]
        );
        // A watcher removes only its own note: one a later watcher wrote is left alone.
        let other = record_path(&candidate, &dead.project);
        retract(&other);
        assert!(other.exists(), "another process's note must stay");
        retract(&note);
        assert!(!note.exists());
        std::fs::remove_dir_all(&home).unwrap();
    }
}
