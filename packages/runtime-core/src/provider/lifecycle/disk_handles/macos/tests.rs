use super::super::tests::{Scratch, host_lsof, isolated, sparse_disks};
use super::super::{HandleProbe, HostScan, Lsof, last_scan};
use super::*;
use crate::provider::process;
use crate::provider::test_executable::LOADED_HOST_SCAN_WAIT;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::AtomicI32;
use std::time::{Duration, Instant};

fn own_pid() -> i32 {
    // SAFETY: `getpid` has no preconditions.
    unsafe { libc::getpid() }
}

fn identified(disks: &[PathBuf]) -> Vec<Disk> {
    disks
        .iter()
        .map(|disk| Disk::identify(disk).unwrap())
        .collect()
}

/// One whole scan in this process, never stopped early, which must be able to answer.
fn host_scan(disks: &[PathBuf]) -> Found {
    let found = scan(disks, &AtomicBool::new(false)).expect("the scan in this process answers");
    assert!(found.unknown.is_empty(), "{found:?}");
    found
}

/// One whole `lsof` scan, bounded for a loaded host once it has its serial turn.
fn lsof_scan(lsof: &Path, disks: &[PathBuf]) -> Found {
    let mut scan = Lsof::at(lsof).start(disks).unwrap();
    let clock = process::MonotonicClock::new();
    process::wait_within(scan.as_mut(), LOADED_HOST_SCAN_WAIT, &clock).unwrap()
}

/// Every hold a scan saw, as `(pid, hold, disk)`.
fn holds(holders: &[Holder]) -> Vec<(i32, Hold, &Path)> {
    holders
        .iter()
        .map(|holder| {
            let disk = holder
                .disk
                .as_deref()
                .expect("an in-process hold names its disk");
            (holder.pid, holder.hold, disk)
        })
        .collect()
}

/// A shared mapping of a disk in this process, with its descriptor closed.
fn mapping(disk: &Path) -> Page {
    Page::of(&File::open(disk).unwrap()).unwrap()
}

const FIXTURES: &str = "macos::tests";

/// Run one ignored fixture of this module alone in a child test process, so its exact
/// holder lists cannot include another test's pre-exec fork.
fn alone(fixture: &str) {
    isolated(&format!("{FIXTURES}::{fixture}"));
}

/// Each errno ends a process's inspection as the scan documents: only an exited process
/// and one this user may not inspect are "not holding". Every other errno leaves the
/// scan to `lsof`, for the reason the caller gives.
#[test]
fn an_errno_ends_a_process_as_documented() {
    let why = Fallback::ScanIncomplete;
    assert_eq!(ended(libc::ESRCH, why), Ended::Exited);
    assert_eq!(ended(libc::EPERM, why), Ended::NotInspectable);
    for errno in [libc::EIO, libc::ENOMEM, libc::EINVAL, libc::EBADF] {
        assert_eq!(ended(errno, why), Ended::Incomplete(why));
        assert_eq!(
            ended(errno, Fallback::WalkIncomplete),
            Ended::Incomplete(Fallback::WalkIncomplete)
        );
    }
}

/// An answer that is not exactly one record, and a list whose bytes are not whole
/// records, are incomplete, never an empty or shorter answer.
#[test]
fn a_partial_record_is_incomplete() {
    let why = Fallback::WalkIncomplete;
    assert_eq!(whole::<Region>(size_of::<Region>(), why), Ok(()));
    for bytes in [0, size_of::<Region>() - 8, size_of::<Region>() + 8] {
        assert_eq!(whole::<Region>(bytes, why), Err(Ended::Incomplete(why)));
    }
    assert_eq!(records::<FilePort>(0), Ok(0));
    assert_eq!(records::<FilePort>(24), Ok(3));
    for bytes in [1, 7, 9, 28] {
        assert_eq!(
            records::<FilePort>(bytes),
            Err(Ended::Incomplete(Fallback::ScanIncomplete))
        );
    }
}

/// A list read is whole only when it leaves the margin unused. A read that comes back
/// within the margin of its buffer is repeated into a larger one, and a list that never
/// settles is incomplete at the limit.
#[test]
fn a_list_is_read_again_until_it_leaves_a_margin() {
    let mut reads = Vec::new();
    let mut entries = vec![0 as c_int; LIST_MARGIN * 2];
    // 40 entries fit a buffer of 64, but leave fewer than the margin of 32 unused.
    let listed = list(&mut entries, |buffer| {
        reads.push(buffer.len());
        Ok(buffer.len().min(40))
    });
    assert_eq!(listed, Ok(40));
    assert_eq!(reads, [LIST_MARGIN * 2, LIST_MARGIN * 4]);

    let mut small = vec![0 as c_int; 1];
    assert_eq!(list(&mut small, |_| Ok(3)), Ok(3));
    assert_eq!(small.len(), LIST_MARGIN * 2);

    let mut endless = vec![0 as c_int; 1];
    assert_eq!(
        list(&mut endless, |buffer| Ok(buffer.len())),
        Err(Ended::Incomplete(Fallback::ScanIncomplete))
    );
    assert_eq!(endless.len(), LIST_LIMIT);

    let mut gone = vec![0 as c_int; 4];
    assert_eq!(list(&mut gone, |_| Err(Ended::Exited)), Err(Ended::Exited));
}

/// A descriptor table larger than the first buffer is not truncated: the disk this
/// process opened last is found although the first read could not hold the table.
#[test]
fn a_descriptor_table_larger_than_the_buffer_is_read_whole() {
    let directory = Scratch::new();
    let disks = identified(&sparse_disks(directory.path()));
    let fill: Vec<File> = (0..LIST_MARGIN * 3)
        .map(|_| File::open("/dev/null").unwrap())
        .collect();
    let _held = File::open(&disks[1].path).unwrap();
    let mut inspector = Inspector::new(file_backed_region);
    inspector.descriptors = vec![libc::proc_fdinfo::empty(); 1];
    let mut holders = Vec::new();
    assert_eq!(inspector.inspect(own_pid(), &disks, &mut holders), Ok(()));
    assert!(
        holds(&holders).contains(&(own_pid(), Hold::Descriptor, disks[1].path.as_path())),
        "{holders:?}"
    );
    assert!(inspector.descriptors.len() >= fill.len() + LIST_MARGIN);
}

/// Another user's process answers `EPERM`: it is not inspected and not counted as a
/// holder, the answer `lsof` gives when this user runs it.
#[test]
fn another_users_process_is_not_inspected() {
    // SAFETY: `geteuid` has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping: the superuser may inspect every process");
        return;
    }
    let directory = Scratch::new();
    let disks = identified(&sparse_disks(directory.path()));
    let mut holders = Vec::new();
    // Process 1 is launchd, which runs as the superuser.
    assert_eq!(
        Inspector::new(file_backed_region).inspect(1, &disks, &mut holders),
        Err(Ended::NotInspectable)
    );
    assert!(holders.is_empty());
}

/// A process that has exited answers as exited, which is "not holding", not incomplete.
#[test]
fn an_exited_process_is_not_holding() {
    let directory = Scratch::new();
    let disks = identified(&sparse_disks(directory.path()));
    let mut child = Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    child.wait().unwrap();
    let mut holders = Vec::new();
    assert_eq!(
        Inspector::new(file_backed_region).inspect(pid, &disks, &mut holders),
        Err(Ended::Exited)
    );
    assert!(holders.is_empty());
}

/// This kernel passes the self-test, so scans on this host run in this process.
///
/// This test is meant to fail on a kernel that does not: production is then still
/// correct, because every scan falls back to the `lsof` child, but each stop is slower
/// and somebody should know that the runner's kernel changed what the queries report.
#[test]
fn this_kernel_passes_the_mapping_self_test() {
    alone("self_test_fixture");
}

#[test]
#[ignore = "isolated fixture launched by this_kernel_passes_the_mapping_self_test"]
fn self_test_fixture() {
    let method = method();
    assert_eq!(
        method,
        Method::InProcess,
        "this kernel does not pass the disk-holder scan's self-test ({method:?}): the \
         undeclared region query PROC_PIDREGIONPATHINFO2 or the declared reference count \
         no longer reports what the scan relies on. Production is unaffected in \
         correctness: every scan on such a kernel falls back to the lsof child and records \
         that reason in disk-handle-scan.json. This test fails so that the change is seen; \
         it is not a product failure"
    );
}

/// A flavor number no kernel answers.
const UNKNOWN_FLAVOR: c_int = 9_999;

/// Each way the queries could stop meaning what the scan needs sends the scan to `lsof`
/// with its own reason: no answer, a partial answer, an answer naming another file, and
/// a test that could not be set up at all. The test leaves nothing behind either way.
#[test]
fn a_query_that_does_not_report_the_test_mapping_is_not_trusted() {
    alone("untrusted_query_fixture");
}

#[test]
#[ignore = "isolated fixture launched by a_query_that_does_not_report_the_test_mapping_is_not_trusted"]
fn untrusted_query_fixture() {
    let directory = Scratch::new();
    let probe = Probe::map(directory.path()).unwrap();
    let file = probe.file.path.clone();
    assert!(file.is_file());
    assert_eq!(probe.found_by(PROC_PIDREGIONPATHINFO2), Ok(()));
    assert_eq!(
        probe.found_by(UNKNOWN_FLAVOR),
        Err(Fallback::QueryUnanswered)
    );
    // The declared query for a region without its file answers with a shorter record.
    assert_eq!(
        probe.found_by(PROC_PIDREGIONINFO),
        Err(Fallback::SelfTestFailed)
    );
    drop(probe);
    assert!(!file.exists());

    // The same mapping, expected under another identity: what the test would see if the
    // kernel reported the region with a different file.
    let mut other_inode = Probe::map(directory.path()).unwrap();
    other_inode.file.inode += 1;
    assert_eq!(
        other_inode.found_by(PROC_PIDREGIONPATHINFO2),
        Err(Fallback::SelfTestFailed)
    );
    drop(other_inode);
    let mut other_device = Probe::map(directory.path()).unwrap();
    other_device.file.device += 1;
    assert_eq!(
        other_device.found_by(PROC_PIDREGIONPATHINFO2),
        Err(Fallback::SelfTestFailed)
    );
    drop(other_device);

    assert!(Probe::map(&directory.path().join("missing")).is_none());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

/// The declared query counts the mappings of a file: a page alone, one more for each
/// other mapping, and the page alone again once the others are gone. An open descriptor
/// is not a mapping and does not count.
#[test]
fn the_declared_query_counts_other_mappings_of_a_file() {
    alone("declared_count_fixture");
}

#[test]
#[ignore = "isolated fixture launched by the_declared_query_counts_other_mappings_of_a_file"]
fn declared_count_fixture() {
    let directory = Scratch::new();
    let paths = sparse_disks(directory.path());
    let disks = identified(&paths);
    assert!(mapped_only_here(&disks));
    let descriptor = File::open(&paths[0]).unwrap();
    assert!(mapped_only_here(&disks));
    let other = mapping(&paths[1]);
    assert_eq!(other.references(), Some(ALONE));
    assert!(!mapped_only_here(&disks));
    assert!(mapped_only_here(&disks[..1]));
    drop(other);
    assert!(mapped_only_here(&disks));
    drop(descriptor);

    // A disk that is no longer the file that was identified cannot be vouched for.
    let mut replaced = disks.clone();
    replaced[0].inode += 1;
    assert!(!mapped_only_here(&replaced));
    std::fs::remove_file(&paths[1]).unwrap();
    assert!(!mapped_only_here(&disks));
}

/// The host scan finds a disk this process holds open and names this process.
#[test]
fn host_scan_finds_a_held_disk() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let _held = File::open(&disks[1]).unwrap();
    let found = host_scan(&disks);
    assert!(
        holds(&found.holders).contains(&(own_pid(), Hold::Descriptor, disks[1].as_path())),
        "{found:?}"
    );
    assert!(
        !holds(&found.holders)
            .iter()
            .any(|(_, _, disk)| *disk == disks[0]),
        "{found:?}"
    );
}

/// The host scan shows closed disks closed, through the stop path's bound. It runs alone
/// in a child process: in the shared test process an unrelated test's pre-exec fork can
/// briefly hold a copy of the disk descriptors this fixture just closed.
#[test]
fn host_scan_shows_closed_disks_closed() {
    alone("host_scan_closed_disks_child");
}

#[test]
#[ignore = "isolated host-scan fixture launched by host_scan_shows_closed_disks_closed"]
fn host_scan_closed_disks_child() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let pool = Scratch::new();
    assert!(host_scan(&disks).holders.is_empty());
    let result = super::super::disks_closed(
        &HostScan::recording(pool.path()),
        &process::MonotonicClock::new(),
        &disks,
        super::super::STOP_HANDLE_WAIT,
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(last_scan::read(pool.path()), Some(Method::InProcess));
}

/// A child that holds whatever it was given as standard input, killed and reaped on drop.
struct Sleeper(Child);

impl Sleeper {
    fn holding(file: File) -> Self {
        // The command, and with it this process's copy of the descriptor, is dropped
        // when this statement ends: only the child holds the file afterwards.
        Self(
            Command::new("/bin/sleep")
                .arg("120")
                .stdin(Stdio::from(file))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    fn pid(&self) -> i32 {
        i32::try_from(self.0.id()).unwrap()
    }
    fn exit(mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}

impl Drop for Sleeper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Another process that holds a disk open is found by the disk's device and inode and
/// reported with its pid, and is no longer found once it has exited.
#[test]
fn a_child_holding_a_disk_is_found_until_it_exits() {
    alone("child_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_child_holding_a_disk_is_found_until_it_exits"]
fn child_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    assert_eq!(holds(&host_scan(&disks).holders), []);

    let child = Sleeper::holding(File::open(&disks[1]).unwrap());
    let found = host_scan(&disks);
    assert_eq!(
        holds(&found.holders),
        [(child.pid(), Hold::Descriptor, disks[1].as_path())],
        "{found:?}"
    );
    assert_eq!(found.holders[0].name.as_deref(), Some(disks[1].as_path()));

    child.exit();
    assert_eq!(holds(&host_scan(&disks).holders), []);
}

/// A holder is found whatever name it opened the disk by: through a hard link, after that
/// link is renamed, and after it is removed. A path comparison would miss all three.
#[test]
fn a_disk_held_through_another_name_is_found() {
    alone("other_name_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_disk_held_through_another_name_is_found"]
fn other_name_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let link = directory.path().join("linked.raw");
    std::fs::hard_link(&disks[0], &link).unwrap();
    let child = Sleeper::holding(File::open(&link).unwrap());
    let expected = [(child.pid(), Hold::Descriptor, disks[0].as_path())];

    let found = host_scan(&disks);
    assert_eq!(
        holds(&found.holders),
        expected,
        "through a hard link: {found:?}"
    );

    let moved = directory.path().join("moved.raw");
    std::fs::rename(&link, &moved).unwrap();
    let found = host_scan(&disks);
    assert_eq!(holds(&found.holders), expected, "after a rename: {found:?}");

    std::fs::remove_file(&moved).unwrap();
    let found = host_scan(&disks);
    assert_eq!(
        holds(&found.holders),
        expected,
        "after the link is gone: {found:?}"
    );

    child.exit();
    assert_eq!(holds(&host_scan(&disks).holders), []);
}

/// A process that mapped a disk and closed its descriptor still holds it, as it does for
/// `lsof`, until the mapping is gone.
#[test]
fn a_mapping_without_a_descriptor_is_found() {
    alone("mapping_holder_fixture");
}

#[test]
#[ignore = "isolated host-scan fixture launched by a_mapping_without_a_descriptor_is_found"]
fn mapping_holder_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let held = mapping(&disks[0]);
    let found = host_scan(&disks);
    assert_eq!(
        holds(&found.holders),
        [(own_pid(), Hold::Mapping, disks[0].as_path())],
        "{found:?}"
    );
    drop(held);
    assert_eq!(holds(&host_scan(&disks).holders), []);
}

/// A disk whose device and inode cannot be read leaves the scan to `lsof`, whose status
/// error for the missing file refuses the stop as it always did.
#[test]
fn a_disk_that_cannot_be_identified_is_left_to_lsof() {
    let directory = Scratch::new();
    let mut disks = sparse_disks(directory.path());
    disks.push(directory.path().join("missing.raw"));
    let left = scan(&disks, &AtomicBool::new(false));
    assert_eq!(left.err(), Some(Fallback::ScanIncomplete));
    let pool = Scratch::new();
    let result = super::super::disks_closed(
        &HostScan::recording(pool.path()),
        &process::MonotonicClock::new(),
        &disks,
        LOADED_HOST_SCAN_WAIT,
    );
    assert_eq!(result.err().map(|error| error.code), Some("stop_uncertain"));
    assert_eq!(
        last_scan::read(pool.path()),
        Some(Method::Lsof(Fallback::ScanIncomplete))
    );
}

/// A scan told to stop reports that it did not finish; it never reports "no holder".
#[test]
fn a_stopped_scan_is_unknown() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let found = scan(&disks, &AtomicBool::new(true)).unwrap();
    assert!(found.holders.is_empty(), "{found:?}");
    assert!(!found.unknown.is_empty(), "{found:?}");
}

const HOLD: &str = "HACK_TEST_DISK_HOLD";
const HOLD_FILE: &str = "HACK_TEST_DISK_HOLD_FILE";
const HOLDING: &str = "disk-holder: holding";
const CANNOT_HOLD: &str = "disk-holder: cannot hold";

/// Turn `file` into a file port and close its descriptor, so only the port holds the
/// file. `None` when this host does not export `fileport_makeport`: the call is in the
/// system library but in no SDK header, so it is looked up at run time instead of linked.
fn file_port(file: File) -> Option<u32> {
    use std::os::fd::AsRawFd;
    type MakePort = unsafe extern "C" fn(libc::c_int, *mut u32) -> libc::c_int;
    // SAFETY: a lookup of a NUL-terminated name in the images already loaded.
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"fileport_makeport".as_ptr()) };
    if symbol.is_null() {
        return None;
    }
    // SAFETY: the system library's `int fileport_makeport(int, mach_port_t *)`.
    let make_port = unsafe { std::mem::transmute::<*mut libc::c_void, MakePort>(symbol) };
    let mut port = 0_u32;
    // SAFETY: a live descriptor and a valid place for the port name.
    let made = unsafe { make_port(file.as_raw_fd(), &mut port) };
    (made == 0 && port != 0).then_some(port)
}

/// The process the cross-check fixtures launch: it holds one file in one way, says so, and
/// exits when its standard input closes. It does nothing in an ordinary `--ignored` run.
#[test]
#[ignore = "holder process launched by the cross-check fixtures"]
fn disk_holder_process() {
    let (Some(how), Some(file)) = (std::env::var_os(HOLD), std::env::var_os(HOLD_FILE)) else {
        return;
    };
    let file = PathBuf::from(file);
    let held: Option<Box<dyn std::any::Any>> = match how.to_str() {
        Some("descriptor") => Some(Box::new(File::open(&file).unwrap())),
        Some("mapping") => Some(Box::new(mapping(&file))),
        Some("file-port") => file_port(File::open(&file).unwrap())
            .map(|port| Box::new(port) as Box<dyn std::any::Any>),
        _ => panic!("unknown hold {how:?}"),
    };
    println!("{}", if held.is_some() { HOLDING } else { CANNOT_HOLD });
    let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
    drop(held);
}

/// A running [`disk_holder_process`], released and reaped on drop.
struct DiskHolder {
    child: Child,
    release: Option<ChildStdin>,
    /// Kept open so the process can still print when it exits.
    output: BufReader<std::process::ChildStdout>,
}

impl DiskHolder {
    /// `None` when this host cannot hold a file that way.
    fn holding(how: &str, file: &Path) -> Option<Self> {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "--nocapture", "--test-threads=1"])
            .arg(format!(
                "provider::lifecycle::disk_handles::{FIXTURES}::disk_holder_process"
            ))
            .env(HOLD, how)
            .env(HOLD_FILE, file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let release = child.stdin.take();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut holder = Self {
            child,
            release,
            output,
        };
        let mut line = String::new();
        loop {
            line.clear();
            let read = holder.output.read_line(&mut line).unwrap();
            assert_ne!(read, 0, "the disk holder exited without holding by {how}");
            if line.contains(HOLDING) {
                return Some(holder);
            }
            if line.contains(CANNOT_HOLD) {
                holder.exit();
                return None;
            }
        }
    }
    fn pid(&self) -> i32 {
        i32::try_from(self.child.id()).unwrap()
    }
    /// Close its standard input and wait for it to exit.
    fn exit(&mut self) {
        drop(self.release.take());
        self.child.wait().unwrap();
    }
}

impl Drop for DiskHolder {
    fn drop(&mut self) {
        drop(self.release.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pids(found: &Found) -> Vec<i32> {
    let mut pids: Vec<i32> = found.holders.iter().map(|held| held.pid).collect();
    pids.dedup();
    pids
}

/// The scan in this process and the `lsof` scan give the same answer about one process
/// that holds a disk in one way: the same holder while it holds, and none after it exits.
/// This is the check that fails first if an OS update changes what the undeclared region
/// query or the other libproc calls report.
fn both_scans_agree(how: &str) {
    let lsof = host_lsof().expect("macOS installs lsof");
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let Some(mut holder) = DiskHolder::holding(how, &disks[0]) else {
        println!("skipping: this host cannot hold a file by {how}");
        return;
    };

    let in_process = host_scan(&disks);
    let listed = lsof_scan(&lsof, &disks);
    assert_eq!(pids(&listed), [holder.pid()], "lsof: {listed:?}");
    assert!(listed.unknown.is_empty(), "{listed:?}");
    let expected = match how {
        "descriptor" => Hold::Descriptor,
        "file-port" => Hold::FilePort,
        _ => Hold::Mapping,
    };
    assert_eq!(
        holds(&in_process.holders),
        [(holder.pid(), expected, disks[0].as_path())],
        "in process: {in_process:?}"
    );

    holder.exit();
    let in_process = host_scan(&disks);
    let listed = lsof_scan(&lsof, &disks);
    assert!(
        in_process.holders.is_empty(),
        "in process after exit: {in_process:?}"
    );
    assert!(
        listed.holders.is_empty() && listed.unknown.is_empty(),
        "lsof after exit: {listed:?}"
    );
}

#[test]
fn both_scans_agree_on_a_descriptor_holder() {
    alone("agree_on_a_descriptor_fixture");
}

#[test]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_descriptor_holder"]
fn agree_on_a_descriptor_fixture() {
    both_scans_agree("descriptor");
}

#[test]
fn both_scans_agree_on_a_mapping_only_holder() {
    alone("agree_on_a_mapping_fixture");
}

#[test]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_mapping_only_holder"]
fn agree_on_a_mapping_fixture() {
    both_scans_agree("mapping");
}

#[test]
fn both_scans_agree_on_a_file_port_holder() {
    alone("agree_on_a_file_port_fixture");
}

#[test]
#[ignore = "isolated cross-check fixture launched by both_scans_agree_on_a_file_port_holder"]
fn agree_on_a_file_port_fixture() {
    both_scans_agree("file-port");
}

/// The process whose mapping walk the stand-in queries below interfere with.
static INTERFERED: AtomicI32 = AtomicI32::new(0);
/// How many answers [`unresolved_once`] has still to refuse.
static REFUSALS: AtomicI32 = AtomicI32::new(0);

/// The real query, except that it answers `EINVAL` for every region of one process: what
/// a scan sees when a region below a disk mapping never resolves to its file.
fn never_resolved(pid: c_int, cursor: u64, region: &mut Region) -> Result<usize, c_int> {
    if pid == INTERFERED.load(Ordering::Relaxed) {
        return Err(libc::EINVAL);
    }
    file_backed_region(pid, cursor, region)
}

/// The real query, except that it answers `EINVAL` once for one process: what a scan sees
/// when a region's file is reclaimed while the walk passes it.
fn unresolved_once(pid: c_int, cursor: u64, region: &mut Region) -> Result<usize, c_int> {
    if pid == INTERFERED.load(Ordering::Relaxed) && REFUSALS.fetch_sub(1, Ordering::Relaxed) > 0 {
        return Err(libc::EINVAL);
    }
    file_backed_region(pid, cursor, region)
}

/// A region the path query cannot resolve, below a mapping of the disk in another
/// process, must not hide that holder.
///
/// No test can make XNU keep such a region, so the walk is driven through a stand-in
/// query that answers `EINVAL` where the real one would report the holder's regions. The
/// walk then ends short of the disk mapping, as the reviewer's case has it. The declared
/// query still counts that mapping, so the scan in this process does not answer "no
/// holder": it is left whole to `lsof`, which names the holder.
#[test]
fn a_walk_cut_short_below_a_disk_mapping_does_not_hide_the_holder() {
    alone("cut_short_walk_fixture");
}

#[test]
#[ignore = "isolated fixture launched by a_walk_cut_short_below_a_disk_mapping_does_not_hide_the_holder"]
fn cut_short_walk_fixture() {
    fn cut_short(paths: &[PathBuf], stop: &AtomicBool) -> Result<Found, Fallback> {
        scan_with(never_resolved, SCAN_THREADS, paths, stop)
    }
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let mut holder = DiskHolder::holding("mapping", &disks[0]).unwrap();
    INTERFERED.store(holder.pid(), Ordering::Relaxed);

    // The walk alone sees nothing: the holder's regions are all refused.
    let mut holders = Vec::new();
    let walked =
        Inspector::new(never_resolved).mappings(holder.pid(), &identified(&disks), &mut holders);
    assert_eq!(walked, Ok(()));
    assert!(holders.is_empty());
    // The scan does not take that for an answer.
    assert_eq!(
        cut_short(&disks, &AtomicBool::new(false)).err(),
        Some(Fallback::WalkIncomplete)
    );

    // And the host scan, with that walk, is answered by `lsof`, which names the holder.
    let pool = Scratch::new();
    let probe = HostScan {
        record: Some(pool.path()),
        decide: cut_short,
    };
    let mut scan = probe.start(&disks).unwrap();
    let clock = process::MonotonicClock::new();
    let found = process::wait_within(scan.as_mut(), LOADED_HOST_SCAN_WAIT, &clock).unwrap();
    assert_eq!(pids(&found), [holder.pid()], "{found:?}");
    assert!(found.holders.iter().all(|held| held.hold == Hold::Listed));
    assert_eq!(
        last_scan::read(pool.path()),
        Some(Method::Lsof(Fallback::WalkIncomplete))
    );

    // Once the holder is gone the same cut-short walk is vouched for again.
    holder.exit();
    let found = cut_short(&disks, &AtomicBool::new(false)).unwrap();
    assert!(found.holders.is_empty() && found.unknown.is_empty());
}

/// A region the path query cannot resolve once, because its file was being reclaimed, is
/// passed when the query is asked again: the walk goes on and names the holder above it.
#[test]
fn a_region_unresolved_once_does_not_end_the_walk() {
    alone("unresolved_once_fixture");
}

#[test]
#[ignore = "isolated fixture launched by a_region_unresolved_once_does_not_end_the_walk"]
fn unresolved_once_fixture() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let holder = DiskHolder::holding("mapping", &disks[0]).unwrap();
    INTERFERED.store(holder.pid(), Ordering::Relaxed);
    REFUSALS.store(1, Ordering::Relaxed);
    let found = scan_with(
        unresolved_once,
        SCAN_THREADS,
        &disks,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        holds(&found.holders),
        [(holder.pid(), Hold::Mapping, disks[0].as_path())],
        "{found:?}"
    );
    assert!(
        REFUSALS.load(Ordering::Relaxed) <= 0,
        "the stand-in query was not asked"
    );
}

fn spread(mut samples: Vec<Duration>) -> String {
    samples.sort();
    format!(
        "min {:.3} ms, median {:.3} ms, max {:.3} ms over {} runs",
        samples[0].as_secs_f64() * 1e3,
        samples[samples.len() / 2].as_secs_f64() * 1e3,
        samples[samples.len() - 1].as_secs_f64() * 1e3,
        samples.len()
    )
}

/// Time `runs` calls of `scan`.
fn timed(runs: usize, mut scan: impl FnMut()) -> Vec<Duration> {
    (0..runs)
        .map(|_| {
            let started = Instant::now();
            scan();
            started.elapsed()
        })
        .collect()
}

/// Prints this host's scan time beside the `lsof` child it falls back to, over the same
/// two unheld files, with what the self-test and the declared check add and the scan's
/// time on one to eight threads. Run it alone:
/// `cargo test --lib -- --ignored --nocapture --exact
/// provider::lifecycle::disk_handles::macos::tests::host_scan_timing_against_lsof`.
#[test]
#[ignore = "timing report for a quiet host; run alone with --ignored --nocapture"]
fn host_scan_timing_against_lsof() {
    let directory = Scratch::new();
    let paths = sparse_disks(directory.path());
    let disks = identified(&paths);
    let pool = Scratch::new();
    println!(
        "disk-handle scan timing on a host with {} processes",
        processes().unwrap().len()
    );
    let chosen = timed(200, || assert_eq!(method(), Method::InProcess));
    println!("  self-test:                {}", spread(chosen));
    let vouched = timed(200, || assert!(mapped_only_here(&disks)));
    println!("  declared mapping check:   {}", spread(vouched));
    let scans = timed(20, || assert!(host_scan(&paths).holders.is_empty()));
    println!("  scan in this process:     {}", spread(scans));
    let bounded = timed(20, || {
        let clock = process::MonotonicClock::new();
        let probe = HostScan::recording(pool.path());
        super::super::disks_closed(&probe, &clock, &paths, super::super::STOP_HANDLE_WAIT).unwrap();
    });
    println!("  through disks_closed:     {}", spread(bounded));
    assert_eq!(last_scan::read(pool.path()), Some(Method::InProcess));
    let lsof = host_lsof().expect("macOS installs lsof");
    let children = timed(5, || {
        let listed = process::capture(
            process::clean_command(&lsof)
                .args(["-n", "-P", "-t", "--"])
                .args(&paths),
            Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(listed.status.code(), Some(1));
        assert!(listed.stdout.is_empty() && listed.stderr.is_empty());
    });
    println!("  lsof child, the fallback: {}", spread(children));
    for threads in [1, 2, 4, 8] {
        let samples = timed(5, || {
            let found = scan_with(file_backed_region, threads, &paths, &AtomicBool::new(false));
            assert!(found.unwrap().holders.is_empty());
        });
        println!("  scan on {threads} threads:        {}", spread(samples));
    }
}

/// One scan over two unheld files, timed. `scripts/measure-lsof-scan.ts` runs this fixture
/// to measure a host under load and reads the line it prints.
#[test]
#[ignore = "one timed scan for scripts/measure-lsof-scan.ts"]
fn one_timed_host_scan() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let started = Instant::now();
    let found = host_scan(&disks);
    let seconds = started.elapsed().as_secs_f64();
    assert!(found.holders.is_empty(), "{found:?}");
    println!("disk_handle_scan_seconds={seconds:.6}");
}
