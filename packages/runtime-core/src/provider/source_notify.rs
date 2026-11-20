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
//! Bounds, so an install of thousands of files on the host can neither flood the guest nor
//! delay a later source edit:
//! - changes are gathered for [`BATCH_WINDOW`] and sent as one batch, one batch in flight;
//! - more than [`MAX_PER_DIRECTORY`] changes directly under one directory in a batch become
//!   one "this directory changed" event;
//! - a batch that would still exceed [`MAX_GUEST_EVENTS`] guest events becomes one "this
//!   directory changed" event on the common parent of everything in it.
//!
//! A watcher that re-lists a directory on such an event misses nothing; no change is ever
//! turned into silence.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// How long changes are gathered before they are sent together.
pub const BATCH_WINDOW: Duration = Duration::from_millis(50);
/// The most guest events one batch may carry (the provider's own watcher uses the same).
pub const MAX_GUEST_EVENTS: usize = 256;
/// The most changes directly under one directory a batch reports one by one.
pub const MAX_PER_DIRECTORY: usize = 64;

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

/// How many guest events a change becomes (a removal also wakes its parent directory).
fn weight(event: &HostEvent) -> usize {
    if event.kind == Kind::Removed { 2 } else { 1 }
}

/// The longest directory every path lies under.
fn common_parent(events: &[HostEvent]) -> PathBuf {
    let mut common: Option<PathBuf> = None;
    for event in events {
        let directory = if event.kind == Kind::Rescan {
            event.relative.clone()
        } else {
            parent(&event.relative)
        };
        common = Some(match common {
            None => directory,
            Some(current) => current
                .components()
                .zip(directory.components())
                .take_while(|(left, right)| left == right)
                .map(|(part, _)| part.as_os_str())
                .collect(),
        });
    }
    common.unwrap_or_default()
}

/// One batch, bounded: ignored paths dropped, repeats of a path merged, a crowded directory
/// reduced to one event, and the whole reduced to one event when it is still too large.
/// The order of first appearance is kept.
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
    // Merge repeats of one path: the last kind wins, except that a change to a path created
    // in this batch is still a creation.
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
    // A crowded directory becomes one event.
    let mut crowd: BTreeMap<PathBuf, usize> = BTreeMap::new();
    for path in &order {
        if latest[path].kind != Kind::Rescan {
            *crowd.entry(parent(path)).or_default() += 1;
        }
    }
    let mut merged: Vec<HostEvent> = Vec::new();
    let mut reported: Vec<PathBuf> = Vec::new();
    for path in order {
        let event = latest.remove(&path).expect("merged event");
        let directory = parent(&path);
        let collapsed = event.kind != Kind::Rescan
            && crowd.get(&directory).copied().unwrap_or(0) > MAX_PER_DIRECTORY;
        let event = if collapsed { rescan(directory) } else { event };
        if event.kind == Kind::Rescan {
            if reported.contains(&event.relative) {
                continue;
            }
            reported.push(event.relative.clone());
        }
        merged.push(event);
    }
    if merged.iter().map(weight).sum::<usize>() > MAX_GUEST_EVENTS {
        return vec![rescan(common_parent(&merged))];
    }
    merged
}

/// The guest events for one bounded batch. `base` is the share's own mount in the guest.
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
    fn a_crowded_directory_becomes_one_event_and_others_keep_their_own() {
        let mut events: Vec<HostEvent> = (0..=MAX_PER_DIRECTORY)
            .map(|n| change(&format!("node_modules/pkg/f{n}.js"), Kind::Created))
            .collect();
        events.push(change("src/app.ts", Kind::Changed));
        events
            .extend((0..MAX_PER_DIRECTORY).map(|n| change(&format!("lib/f{n}.js"), Kind::Changed)));
        let bounded = coalesce(events);
        // 65 under one directory collapse; exactly 64 under another do not.
        assert_eq!(bounded.len(), 1 + 1 + MAX_PER_DIRECTORY);
        assert_eq!(bounded[0], rescan("node_modules/pkg".into()));
        assert_eq!(bounded[1], change("src/app.ts", Kind::Changed));
        assert!(bounded[2..].iter().all(|event| event.kind == Kind::Changed));
    }

    #[test]
    fn a_batch_that_is_still_too_large_becomes_one_event_on_the_common_parent() {
        // 300 directories with one change each: no directory is crowded, the batch is.
        let wide: Vec<HostEvent> = (0..300)
            .map(|n| change(&format!("node_modules/p{n}/index.js"), Kind::Created))
            .collect();
        assert_eq!(coalesce(wide), vec![rescan("node_modules".into())]);
        // Removals count twice: 129 of them are 258 guest events.
        let removals: Vec<HostEvent> = (0..129)
            .map(|n| change(&format!("a/d{n}/x"), Kind::Removed))
            .collect();
        assert_eq!(coalesce(removals), vec![rescan("a".into())]);
        // Unrelated corners of the tree share only the root.
        let spread: Vec<HostEvent> = (0..300)
            .map(|n| change(&format!("d{n}/x"), Kind::Changed))
            .collect();
        assert_eq!(coalesce(spread), vec![HostEvent::root_rescan()]);
        // At the bound exactly, nothing collapses.
        let exact: Vec<HostEvent> = (0..MAX_GUEST_EVENTS)
            .map(|n| change(&format!("d{n}/x"), Kind::Changed))
            .collect();
        assert_eq!(coalesce(exact).len(), MAX_GUEST_EVENTS);
    }

    #[test]
    fn an_install_burst_stays_bounded_and_a_later_edit_is_its_own_small_batch() {
        // 10,000 files written by an install on the host, in 100 packages.
        let burst: Vec<HostEvent> = (0..10_000)
            .map(|n| change(&format!("node_modules/p{}/f{n}.js", n % 100), Kind::Created))
            .collect();
        let first = coalesce(burst);
        let lines = guest_events(BASE, &first);
        assert!(lines.len() <= MAX_GUEST_EVENTS, "{}", lines.len());
        // 100 crowded directories: one event each, under the bound, nothing lost to silence.
        assert_eq!(first.len(), 100);
        assert!(first.iter().all(|event| event.kind == Kind::Rescan));
        // The source edit that arrives next is delivered by name in the next batch.
        let second = coalesce(vec![change("src/app.ts", Kind::Changed)]);
        assert_eq!(
            guest_events(BASE, &second),
            vec![GuestEvent {
                path: format!("{BASE}/src/app.ts"),
                mask: 0x2 | 0x4 | 0x8,
            }]
        );
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
}
