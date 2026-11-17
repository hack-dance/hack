//! A byte-bounded queue between one producer thread and one consumer.
//!
//! The bound is on pending bytes, not messages. A producer that would exceed
//! it blocks until the consumer drains (backpressure, which reaches the
//! child through the pipe or PTY it writes to) or closes the queue
//! (cancellation). The consumer never blocks unless it asks to.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
struct State {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    high_water: usize,
    /// The producer finished: `Ok` at end of input, `Err` on a read failure.
    finished: Option<Result<(), String>>,
    /// The consumer went away.
    closed: bool,
}

#[derive(Debug)]
pub(crate) struct ByteQueue {
    state: Mutex<State>,
    space: Condvar,
    data: Condvar,
    cap: usize,
}

/// What a drain returned. `end` is set once, when the producer has finished
/// and every byte has been handed over.
#[derive(Debug, Default)]
pub(crate) struct Drained {
    pub bytes: Vec<u8>,
    pub end: Option<Result<(), String>>,
}

impl ByteQueue {
    pub fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::default(),
            space: Condvar::new(),
            data: Condvar::new(),
            cap: cap.max(1),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Producer: add a chunk, blocking while the queue is full. Returns
    /// `false` when the consumer closed the queue; the producer must stop.
    /// A chunk larger than the bound is accepted only into an empty queue.
    pub fn push(&self, chunk: Vec<u8>) -> bool {
        if chunk.is_empty() {
            return !self.lock().closed;
        }
        let mut s = self.lock();
        while !s.closed && s.bytes > 0 && s.bytes + chunk.len() > self.cap {
            s = self.space.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        if s.closed {
            return false;
        }
        s.bytes += chunk.len();
        s.high_water = s.high_water.max(s.bytes);
        s.chunks.push_back(chunk);
        drop(s);
        self.data.notify_all();
        true
    }

    /// Producer: no more data will come.
    pub fn finish(&self, end: Result<(), String>) {
        let mut s = self.lock();
        if s.finished.is_none() {
            s.finished = Some(end);
        }
        drop(s);
        self.data.notify_all();
    }

    /// Consumer: take whole chunks until at least `max_bytes` are taken or
    /// the queue is empty. Never blocks.
    pub fn drain(&self, max_bytes: usize) -> Drained {
        let mut out = Drained::default();
        let mut s = self.lock();
        while out.bytes.len() < max_bytes {
            let Some(chunk) = s.chunks.pop_front() else {
                break;
            };
            s.bytes -= chunk.len();
            out.bytes.extend_from_slice(&chunk);
        }
        if s.chunks.is_empty() {
            out.end = s.finished.clone();
        }
        drop(s);
        if !out.bytes.is_empty() {
            self.space.notify_all();
        }
        out
    }

    /// Consumer: wait until there is data or the producer finished, or
    /// `timeout` passes. Returns whether a drain would return something.
    pub fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut s = self.lock();
        loop {
            if !s.chunks.is_empty() || s.finished.is_some() {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            s = self
                .data
                .wait_timeout(s, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Consumer: stop. A blocked or later `push` returns `false`.
    pub fn close(&self) {
        let mut s = self.lock();
        s.closed = true;
        s.chunks.clear();
        s.bytes = 0;
        drop(s);
        self.space.notify_all();
    }

    pub fn pending_bytes(&self) -> usize {
        self.lock().bytes
    }

    /// The most bytes ever pending at once.
    pub fn high_water(&self) -> usize {
        self.lock().high_water
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[test]
    fn a_fast_producer_with_a_stalled_consumer_stays_under_the_bound() {
        const CAP: usize = 256 * 1024;
        let q = ByteQueue::new(CAP);
        let pushed = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let producer = {
            let (q, pushed, stopped) = (q.clone(), pushed.clone(), stopped.clone());
            std::thread::spawn(move || {
                // 64 MiB if nothing stopped it.
                for _ in 0..1024 {
                    if !q.push(vec![7u8; 64 * 1024]) {
                        stopped.store(true, Ordering::SeqCst);
                        return;
                    }
                    pushed.fetch_add(64 * 1024, Ordering::SeqCst);
                }
            })
        };
        // The consumer stalls. The producer fills the queue and blocks.
        let start = Instant::now();
        while q.pending_bytes() < CAP && start.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(q.pending_bytes(), CAP, "full, and no further");
        assert_eq!(
            pushed.load(Ordering::SeqCst),
            CAP,
            "the producer is blocked"
        );
        assert!(!producer.is_finished());
        // Draining lets it continue, still under the bound.
        assert_eq!(q.drain(CAP).bytes.len(), CAP);
        let start = Instant::now();
        while pushed.load(Ordering::SeqCst) < 2 * CAP && start.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(q.high_water() <= CAP, "high water {}", q.high_water());
        // Closing cancels the blocked producer.
        q.close();
        producer.join().unwrap();
        assert!(stopped.load(Ordering::SeqCst), "push reported the close");
        assert!(q.high_water() <= CAP);
    }

    #[test]
    fn the_end_is_reported_only_after_the_last_byte() {
        let q = ByteQueue::new(1024);
        assert!(q.push(b"abc".to_vec()));
        q.finish(Ok(()));
        assert!(q.wait(Duration::ZERO));
        // Whole chunks are handed over, so one byte asked gives the chunk.
        let d = q.drain(1);
        assert_eq!(d.bytes, b"abc");
        assert_eq!(d.end, Some(Ok(())), "empty and finished");
        let q = ByteQueue::new(1024);
        q.push(b"ab".to_vec());
        q.push(b"cd".to_vec());
        q.finish(Err("boom".into()));
        let d = q.drain(1);
        assert_eq!((d.bytes.as_slice(), d.end), (&b"ab"[..], None));
        let d = q.drain(10);
        assert_eq!(d.bytes, b"cd");
        assert_eq!(d.end, Some(Err("boom".into())));
    }
}
