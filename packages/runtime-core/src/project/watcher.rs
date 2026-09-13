//! Native filesystem notifications coalesce into one bounded rescan signal.
//! They never carry source bytes and never fall back to periodic tree polling.
use super::{problem, source};
use crate::CandidateError;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError},
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
            let relevant = match event {
                Ok(event) => {
                    if event.need_rescan() {
                        fault.store(true, Ordering::Release);
                    }
                    event.need_rescan()
                        || event.paths.iter().any(|path| {
                            path.strip_prefix(&watched_root)
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
