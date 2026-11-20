//! Observe allocation requests only during a single-threaded decode.
use hack_vm_protocol::{MAX_FRAME, Request, Response, read_frame};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! { static PEAK:Cell<Option<usize>>=const {Cell::new(None)}; }
struct Observe;
fn record(n: usize) {
    PEAK.with(|p| {
        if let Some(prev) = p.get() {
            p.set(Some(prev.max(n)));
        }
    })
}
// SAFETY: all allocations delegate unchanged to the system allocator.
unsafe impl GlobalAlloc for Observe {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        record(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        record(n);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static ALLOC: Observe = Observe;
#[test]
fn arbitrary_frames_never_panic_or_allocate_over_the_frame_limit() {
    let mut seed = 42u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    for i in 0..8192 {
        let len = (next() % 1024) as usize;
        let mut frame = vec![0; len + 4];
        let prefix = if i % 4 == 0 { next() } else { len as u32 };
        frame[..4].copy_from_slice(&prefix.to_be_bytes());
        for b in &mut frame[4..] {
            *b = next() as u8;
        }
        if len >= 2 && i % 2 == 0 {
            frame[4] = 1 + (next() % 2) as u8;
            frame[5] = 1 + (next() % 15) as u8;
        }
        PEAK.set(Some(0));
        let _ = read_frame::<Request>(&frame[..]);
        let _ = read_frame::<Response>(&frame[..]);
        let peak = PEAK.replace(None).unwrap();
        assert!(peak <= MAX_FRAME);
    }
}
