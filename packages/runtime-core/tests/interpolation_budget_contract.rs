//! Nested Compose default words are bounded by the expanded-input budget while
//! they are built, not only after the outer expression returns. This binary
//! holds a single test because it measures process-wide peak heap use.
use hack_runtime_core::{
    Candidate,
    project::{self, PlanOptions, inputs},
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

struct Peak;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
impl Peak {
    fn grow(bytes: usize) {
        let now = CURRENT.fetch_add(bytes, Ordering::SeqCst) + bytes;
        PEAK.fetch_max(now, Ordering::SeqCst);
    }
    fn reset() -> usize {
        let now = CURRENT.load(Ordering::SeqCst);
        PEAK.store(now, Ordering::SeqCst);
        now
    }
}
// SAFETY: every call is forwarded unchanged to the system allocator; only
// atomic counters are updated, which never allocate.
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            Self::grow(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        CURRENT.fetch_sub(layout.size(), Ordering::SeqCst);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            if size >= layout.size() {
                Self::grow(size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - size, Ordering::SeqCst);
            }
        }
        moved
    }
}
#[global_allocator]
static ALLOCATOR: Peak = Peak;

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new(compose: &str) -> Self {
        let mut bytes = [0; 16];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-budget-{token}"));
        fs::create_dir(&root).unwrap();
        let project = root.join("project");
        let checkout = root.join("candidate");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&checkout).unwrap();
        fs::write(project.join("compose.yaml"), compose).unwrap();
        Self {
            root,
            project,
            candidate: Candidate::discover(&checkout).unwrap(),
        }
    }
    /// Compile with `values`, returning the error code and the peak heap growth
    /// observed during compilation.
    fn compile(&self, values: &BTreeMap<String, String>) -> (Option<String>, usize) {
        let options = PlanOptions {
            branch: None,
            project: &self.project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let review = project::plan(&self.candidate, options).unwrap();
        let options = PlanOptions {
            branch: None,
            project: &self.project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let baseline = Peak::reset();
        let result = inputs::compile(&self.candidate, options, &review.plan_id, values);
        let peak = PEAK.load(Ordering::SeqCst) - baseline;
        (result.err().map(|error| error.code.to_owned()), peak)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn nested_default_words_refuse_before_building_past_the_budget() {
    const MIB: usize = 1024 * 1024;
    let values: BTreeMap<String, String> = [("B".to_owned(), "x".repeat(600 * 1024))]
        .into_iter()
        .collect();
    // One level: 64 copies of a 600 KiB value would build ~37.5 MiB before the
    // top-level charge refused it.
    let repeated = "${B}".repeat(64);
    let fixture = Fixture::new(&format!(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${{A:-{repeated}}}']\n"
    ));
    let (code, peak) = fixture.compile(&values);
    assert_eq!(code.as_deref(), Some("execution_input_budget"));
    assert!(peak < 8 * MIB, "single-level word peaked at {peak} bytes");
    // Repeated nesting multiplies per level (64 * 8 * 8 copies, ~2.3 GiB here,
    // from a 17 KiB file) unless each intermediate word is bounded as built.
    let inner = format!("${{C:-{repeated}}}").repeat(8);
    let middle = format!("${{D:-{inner}}}").repeat(8);
    let fixture = Fixture::new(&format!(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${{A:-{middle}}}']\n"
    ));
    let (code, peak) = fixture.compile(&values);
    assert_eq!(code.as_deref(), Some("execution_input_budget"));
    assert!(peak < 8 * MIB, "nested word peaked at {peak} bytes");
}
