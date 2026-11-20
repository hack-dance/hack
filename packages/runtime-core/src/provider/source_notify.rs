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
//! - changes are gathered for [`BATCH_WINDOW`], at most [`MAX_BATCH_NOTIFICATIONS`] at a time,
//!   and repeats of one path inside a batch are merged;
//! - a batch reaches the guest in requests of at most [`MAX_GUEST_EVENTS`] events and
//!   [`MAX_BATCH_PATH_BYTES`] bytes of paths, one request in flight;
//! - only when more than [`FLOOD_LIMIT`] notifications are still waiting behind a full batch
//!   is everything waiting replaced by one "something changed under the share" event. That is
//!   the single lossy case; no change is ever turned into silence.

use crate::{Candidate, CandidateError};
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
/// The most bytes of guest paths one request may carry (the agent's frame is 64 KiB).
pub const MAX_BATCH_PATH_BYTES: usize = 32 * 1024;
/// Notifications waiting behind a full batch beyond which the backlog is given up: they are
/// replaced by one event on the share root.
pub const FLOOD_LIMIT: usize = 32_768;
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

/// A relative path the hook can take: plain components, valid UTF-8, no line break.
fn sendable(relative: &Path) -> bool {
    relative.components().all(|part| match part {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|text| !text.contains(['\n', '\r', '\0'])),
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

/// What the file system says about a path now: `Some(true)` a directory, `Some(false)`
/// anything else that exists, `None` nothing there.
pub fn probe(path: &Path) -> Option<bool> {
    std::fs::symlink_metadata(path)
        .ok()
        .map(|metadata| metadata.is_dir())
}

/// The changes one system notification stands for. The system's kinds are hints: a rename
/// reports each name without saying which is which, and several changes to one path can
/// arrive merged. So what the path is now decides: present means created or changed, absent
/// means removed.
pub fn from_notification(
    root: &Path,
    event: &notify::Event,
    probe: impl Fn(&Path) -> Option<bool>,
) -> Vec<HostEvent> {
    use notify::EventKind;
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
        let was_folder = matches!(
            event.kind,
            EventKind::Remove(notify::event::RemoveKind::Folder)
                | EventKind::Create(notify::event::CreateKind::Folder)
        );
        let (kind, directory) = match (probe(path), event.kind) {
            (None, _) => (Kind::Removed, was_folder),
            (Some(directory), EventKind::Create(_))
            | (Some(directory), EventKind::Modify(notify::event::ModifyKind::Name(_))) => {
                (Kind::Created, directory)
            }
            (Some(directory), _) => (Kind::Changed, directory),
        };
        changes.push(HostEvent {
            relative: relative.to_path_buf(),
            kind,
            directory,
        });
    }
    changes
}

/// A batch as the requests that carry it: each within the event and path-byte bounds, in
/// order, nothing dropped.
pub fn requests(base: &str, events: Vec<HostEvent>) -> Vec<Vec<GuestEvent>> {
    let mut requests: Vec<Vec<GuestEvent>> = Vec::new();
    let mut bytes = 0;
    for line in guest_events(base, &coalesce(events)) {
        let full = requests.last().is_none_or(|request| {
            request.len() >= MAX_GUEST_EVENTS || bytes + line.path.len() > MAX_BATCH_PATH_BYTES
        });
        if full {
            requests.push(Vec::new());
            bytes = 0;
        }
        bytes += line.path.len();
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
/// guest path is right: unless the guest reports the hook present and exactly that one event
/// fired, nothing else is ever sent (no event goes to a guessed path) and the caller learns
/// why. A watcher that starts again after a failure therefore tells the guest "something
/// changed under the share" before any path event.
///
/// `deliver` returns how many events fired and whether the hook exists; `alive` is called on
/// an idle watcher every few seconds and ends it when the pool is no longer the same.
pub fn forward(
    root: &Path,
    base: &str,
    changes: &Receiver<notify::Result<notify::Event>>,
    stop: &AtomicBool,
    mut deliver: impl FnMut(&[GuestEvent]) -> Result<(u32, bool), CandidateError>,
    mut alive: impl FnMut() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    match deliver(&guest_events(base, &[HostEvent::root_rescan()]))? {
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
    // Notifications taken off the queue while measuring a backlog, in arrival order.
    let mut carried: std::collections::VecDeque<notify::Result<notify::Event>> =
        std::collections::VecDeque::new();
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let first = match carried.pop_front() {
            Some(notification) => notification,
            None => match changes.recv_timeout(IDLE_POLL) {
                Ok(notification) => notification,
                Err(RecvTimeoutError::Timeout) => {
                    if verified.elapsed() >= ALIVE_INTERVAL {
                        alive()?;
                        verified = Instant::now();
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            },
        };
        // Gather what arrives inside the window; a burst beyond the cap waits its turn.
        let mut notifications = vec![first];
        let window = Instant::now() + BATCH_WINDOW;
        while notifications.len() < MAX_BATCH_NOTIFICATIONS {
            if let Some(notification) = carried.pop_front() {
                notifications.push(notification);
                continue;
            }
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
        if notifications.len() == MAX_BATCH_NOTIFICATIONS {
            // A full batch: how much is still waiting? Past the limit the backlog is given
            // up and replaced by one event on the share root.
            while carried.len() <= FLOOD_LIMIT {
                match changes.try_recv() {
                    Ok(notification) => carried.push_back(notification),
                    Err(_) => break,
                }
            }
            if carried.len() > FLOOD_LIMIT {
                carried.clear();
                while changes.try_recv().is_ok() {}
                notifications.clear();
                host.push(HostEvent::root_rescan());
            }
        }
        for notification in &notifications {
            match notification {
                Ok(event) => host.extend(from_notification(root, event, probe)),
                // The system could not say what changed: something did.
                Err(_) => host.push(HostEvent::root_rescan()),
            }
        }
        for request in requests(base, host) {
            deliver(&request)?;
            verified = Instant::now();
        }
    }
}

/// The long-running command behind `runtime source-notify`: watches `project`, which must be
/// one of this pool's shares, and forwards its changes until the pool changes, the process is
/// stopped or, with `until_stdin_closes`, its parent closes its input (or exits).
pub fn watch(
    candidate: &Candidate,
    project: &Path,
    until_stdin_closes: bool,
) -> Result<(), CandidateError> {
    use notify::Watcher;
    let failed = |message: &'static str| CandidateError::new("source_notify", message);
    let root = project
        .canonicalize()
        .map_err(|_| failed("Cannot resolve the project directory."))?;
    let guest = super::lifecycle::ObservedGuest::connect(candidate)?;
    let position = guest
        .share_position(&root)
        .ok_or_else(|| failed("This pool does not share that project directory."))?;
    // `ObservedGuest::connect` audited the provider's recorded mounts: the engine first, then
    // the shares in receipt order. The agent names each mount by that position.
    let base = format!("{STAGING_ROOT}/smolvm{}", position + 1);
    let (sender, changes) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |notification| {
        let _ = sender.send(notification);
    })
    .map_err(|_| failed("The system's file events are unavailable."))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|_| failed("Cannot watch the project directory."))?;
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
    forward(
        &root,
        &base,
        &changes,
        &stop,
        |lines| {
            let fired = guest.notify_files(lines, DELIVERY_TIMEOUT)?;
            if std::env::var_os("HACK_LOCAL_SOURCE_NOTIFY_TRACE").is_some() {
                eprintln!("source-notify: {} events, {} fired", lines.len(), fired.0);
            }
            Ok(fired)
        },
        || guest.verify(),
    )
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
            assert!(
                request.iter().map(|line| line.path.len()).sum::<usize>() <= MAX_BATCH_PATH_BYTES
            );
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
            assert!(
                request.iter().map(|line| line.path.len()).sum::<usize>() <= MAX_BATCH_PATH_BYTES
            );
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
        let present = |_: &Path| Some(false);
        let folder = |_: &Path| Some(true);
        let absent = |_: &Path| None;
        let one = |event: &Event, probe: &dyn Fn(&Path) -> Option<bool>| {
            from_notification(root, event, probe)
        };
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
    fn probe_reports_what_is_there_without_following_links() {
        let root = std::env::temp_dir().join(format!(
            "hack-source-notify-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::fs::write(root.join("file"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("dir"), root.join("link")).unwrap();
        assert_eq!(probe(&root.join("dir")), Some(true));
        assert_eq!(probe(&root.join("file")), Some(false));
        // A link is an entry of its own, not the directory it points at.
        assert_eq!(probe(&root.join("link")), Some(false));
        assert_eq!(probe(&root.join("absent")), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn notification(path: &str) -> notify::Result<Event> {
        Ok(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(PathBuf::from(path)),
        )
    }

    /// Runs `forward` over prepared notifications with a recording guest.
    fn run(
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
            Path::new("/project"),
            BASE,
            &changes,
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
        let (result, sent) = run(vec![notification("/project/src/a.ts")], Ok((1, true)));
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
        // The root event did not fire: the path is not the share. Nothing goes to a guess.
        for (answer, text) in [
            ((0, true), "mount was not found"),
            ((2, true), "mount was not found"),
            ((0, false), "no file-watch hook"),
            ((1, false), "no file-watch hook"),
        ] {
            let (result, sent) = run(vec![notification("/project/src/a.ts")], Ok(answer));
            let error = result.unwrap_err();
            assert_eq!(error.code, "source_notify_unavailable", "{answer:?}");
            assert!(error.message.contains(text), "{}", error.message);
            assert!(error.message_fixed);
            assert_eq!(sent.len(), 1, "{answer:?}");
        }
        // A refused request ends the watcher with that refusal, again after one attempt.
        let (result, sent) = run(vec![notification("/project/a")], Err("runtime_changed"));
        assert_eq!(result.unwrap_err().code, "runtime_changed");
        assert_eq!(sent.len(), 1);
    }

    #[test]
    fn a_burst_then_an_edit_reaches_the_guest_by_name_within_two_batches() {
        let mut notifications: Vec<notify::Result<Event>> = (0..10_000)
            .map(|n| notification(&format!("/project/node_modules/p{}/f{n}.js", n % 100)))
            .collect();
        notifications.push(Err(notify::Error::generic("dropped")));
        notifications.push(notification("/project/src/app.ts"));
        let (result, sent) = run(notifications, Ok((1, true)));
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
    fn a_flood_past_the_limit_becomes_one_root_event_and_later_changes_are_named_again() {
        let flood = MAX_BATCH_NOTIFICATIONS + FLOOD_LIMIT + 10;
        let (sender, changes) = std::sync::mpsc::channel();
        for n in 0..flood {
            sender
                .send(notification(&format!("/project/build/out{n}.o")))
                .unwrap();
        }
        let sent = std::cell::RefCell::new(Vec::<Vec<GuestEvent>>::new());
        let stop = AtomicBool::new(false);
        let later = std::cell::Cell::new(Some(sender));
        forward(
            Path::new("/project"),
            BASE,
            &changes,
            &stop,
            |lines| {
                sent.borrow_mut().push(lines.to_vec());
                // After the flood is answered, one more change arrives and the queue closes.
                if sent.borrow().len() == 2 {
                    if let Some(sender) = later.take() {
                        sender.send(notification("/project/src/app.ts")).unwrap();
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
        // Opening event; the whole flood as one root event; then the later edit by name.
        assert_eq!(
            sent.len(),
            3,
            "{:?}",
            sent.iter().map(Vec::len).collect::<Vec<_>>()
        );
        assert_eq!(sent[0], root);
        assert_eq!(sent[1], root);
        assert_eq!(sent[2][0].path, format!("{BASE}/src/app.ts"));
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
            &stop,
            |_| Ok((1, true)),
            || Err(CandidateError::new("runtime_changed", "changed")),
        )
        .unwrap_err();
        assert_eq!(error.code, "runtime_changed");
        assert!(started.elapsed() >= ALIVE_INTERVAL);
    }
}
