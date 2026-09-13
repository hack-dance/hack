//! Native filesystem notifications coalesce into one bounded rescan signal.
//! They never carry source bytes and never fall back to periodic tree polling.
use super::{problem, source};
use crate::CandidateError;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
};
use std::time::{Duration, Instant};

pub struct SourceWatcher {
    _watcher: RecommendedWatcher,
    changes: Receiver<()>,
    must_reconcile: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy)]
pub struct Change {
    pub reconcile_required: bool,
}

fn signal_change(
    event: notify::Result<Event>,
    watched_root: &Path,
    fault: &AtomicBool,
    sender: &SyncSender<()>,
) {
    let relevant = match event {
        Ok(event) => {
            if event.need_rescan() {
                fault.store(true, Ordering::Release);
            }
            event.need_rescan()
                || event.paths.iter().any(|path| {
                    path.strip_prefix(watched_root)
                        .is_ok_and(|relative| !source::excluded(relative))
                })
        }
        Err(_) => {
            fault.store(true, Ordering::Release);
            true
        }
    };
    if relevant {
        // A full slot already promises a fresh inventory; coalescing does not lose paths.
        let _ = sender.try_send(());
    }
}

impl SourceWatcher {
    pub fn new(project: &Path) -> Result<Self, CandidateError> {
        let root = project
            .canonicalize()
            .map_err(|_| problem("source_watch", "Cannot resolve the source watch root."))?;
        let (sender, changes) = mpsc::sync_channel(1);
        let must_reconcile = Arc::new(AtomicBool::new(false));
        let fault = must_reconcile.clone();
        let watched_root = root.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            signal_change(event, &watched_root, &fault, &sender);
        })
        .map_err(|_| {
            problem(
                "source_watch",
                "Native filesystem notification setup failed.",
            )
        })?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|_| {
                problem(
                    "source_watch",
                    "Cannot establish the native source watcher.",
                )
            })?;
        // Watching the parent makes root rename/removal observable as well.
        if let Some(parent) = root.parent() {
            watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .map_err(|_| problem("source_watch", "Cannot observe source-root replacement."))?;
        }
        Ok(Self {
            _watcher: watcher,
            changes,
            must_reconcile,
        })
    }

    pub fn wait(&self, timeout: Duration) -> Result<Option<Change>, CandidateError> {
        match self.changes.recv_timeout(timeout) {
            Ok(()) => {}
            Err(RecvTimeoutError::Timeout) => return Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(problem(
                    "source_watch",
                    "Native source watcher disconnected.",
                ));
            }
        }
        // Settle editor rename/write bursts, bounded even under a continuously busy producer.
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self
                .changes
                .recv_timeout(remaining.min(Duration::from_millis(40)))
            {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(problem(
                        "source_watch",
                        "Native source watcher disconnected.",
                    ));
                }
            }
        }
        Ok(Some(Change {
            reconcile_required: self.must_reconcile.swap(false, Ordering::AcqRel),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{EventKind, event::Flag};

    #[test]
    fn overflow_and_errors_survive_a_full_notification_slot() {
        let root = Path::new("/source");
        let (sender, changes) = mpsc::sync_channel(1);
        let fault = AtomicBool::new(false);
        let event = || Event::new(EventKind::Any).add_path(root.join("changed.txt"));
        for _ in 0..100_000 {
            signal_change(Ok(event()), root, &fault, &sender);
        }
        assert!(!fault.load(Ordering::Acquire));
        signal_change(
            Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)),
            root,
            &fault,
            &sender,
        );
        assert!(fault.swap(false, Ordering::AcqRel));
        changes.try_recv().unwrap();
        assert!(matches!(changes.try_recv(), Err(mpsc::TryRecvError::Empty)));
        signal_change(Ok(event()), root, &fault, &sender);
        signal_change(
            Err(notify::Error::generic("injected watcher error")),
            root,
            &fault,
            &sender,
        );
        assert!(fault.swap(false, Ordering::AcqRel));
        changes.try_recv().unwrap();
        assert!(matches!(changes.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    #[test]
    fn excluded_changes_are_quiet_but_pathless_rescan_wakes_the_consumer() {
        let root = Path::new("/source");
        let (sender, changes) = mpsc::sync_channel(1);
        let fault = AtomicBool::new(false);
        for path in [
            root.join("node_modules/ignored"),
            Path::new("/other/file").into(),
        ] {
            signal_change(
                Ok(Event::new(EventKind::Any).add_path(path)),
                root,
                &fault,
                &sender,
            );
        }
        assert!(matches!(changes.try_recv(), Err(mpsc::TryRecvError::Empty)));
        signal_change(
            Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)),
            root,
            &fault,
            &sender,
        );
        changes.try_recv().unwrap();
        assert!(fault.load(Ordering::Acquire));
    }
}
