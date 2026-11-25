//! Observe allocation requests only during a single-threaded decode.
use hack_vm_protocol::{Handle, MAX_FRAME, Request, Response, read_frame, write_frame};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! { static PEAK:Cell<Option<(usize,usize)>>=const {Cell::new(None)}; }
struct Observe;
fn record(n: usize) {
    PEAK.with(|p| {
        if let Some(prev) = p.get() {
            p.set(Some((prev.0.max(n), prev.1 + n)));
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
    let handle = Handle {
        boot: "12345678-0000-4000-a000-000000000001".into(),
        incarnation: "12345678-0000-4000-a000-000000000002".into(),
        id: "a".repeat(32),
    };
    let mut start = Vec::new();
    write_frame(
        &mut start,
        1,
        true,
        &Request::Start {
            handle,
            argv: vec!["a".repeat(4000); 7],
            env: (0..120)
                .map(|i| (format!("N{i}"), "v".repeat(16)))
                .collect(),
            cwd: "/".into(),
            stdin: vec![255; 32768],
        },
    )
    .unwrap();
    let mut output = Vec::new();
    write_frame(
        &mut output,
        2,
        false,
        &Response::Output {
            start_offset: 999,
            bytes: vec![255; 32768],
            eof: false,
            truncated: true,
        },
    )
    .unwrap();
    for i in 0..2048 {
        let mut frame = if i % 2 == 0 {
            start.clone()
        } else {
            output.clone()
        };
        if i > 1 {
            let pos = next() as usize % frame.len();
            frame[pos] ^= 1 + (next() % 255) as u8;
        }
        PEAK.set(Some((0, 0)));
        let ok = if i % 2 == 0 {
            read_frame::<Request>(&frame[..]).is_ok()
        } else {
            read_frame::<Response>(&frame[..]).is_ok()
        };
        let (largest, total) = PEAK.replace(None).unwrap();
        assert!(largest <= MAX_FRAME && total <= 3 * MAX_FRAME);
        if i < 2 {
            assert!(ok && total > frame.len());
        }
    }
    // Oversized declared payloads must fail before any heap allocation.
    PEAK.set(Some((0, 0)));
    let result = read_frame::<Request>(&u32::MAX.to_be_bytes()[..]);
    assert_eq!(PEAK.replace(None), Some((0, 0)));
    assert!(result.is_err());
}
