use super::super::tests::{Mapping, Scratch, sparse_disks, timed};
use super::super::{Found, scan_with};
use super::*;
use std::fs::File;
use std::sync::atomic::AtomicBool;

fn own_pid() -> i32 {
    // SAFETY: `getpid` has no preconditions.
    unsafe { libc::getpid() }
}

fn identified(directory: &Scratch) -> Vec<Disk> {
    sparse_disks(directory.path())
        .iter()
        .map(|disk| Disk::identify(disk).unwrap())
        .collect()
}

fn holds(holders: &[Holder]) -> Vec<(i32, Hold)> {
    holders
        .iter()
        .map(|holder| (holder.pid, holder.hold))
        .collect()
}

/// Each errno ends a process's inspection as the module header says: only an exited
/// process and one this user may not inspect are "not holding".
#[test]
fn an_errno_ends_a_process_as_documented() {
    assert_eq!(ended("descriptor list", libc::ESRCH), Ended::Exited);
    assert_eq!(ended("descriptor list", libc::EPERM), Ended::NotInspectable);
    for errno in [libc::EIO, libc::ENOMEM, libc::EINVAL, libc::EBADF] {
        assert!(matches!(ended("descriptor list", errno), Ended::Unknown(_)));
    }
}

/// An answer that is not exactly one record is unknown, never an empty answer.
#[test]
fn an_answer_of_another_size_is_unknown() {
    assert_eq!(whole::<Region>("mapping", size_of::<Region>()), Ok(()));
    for bytes in [0, size_of::<Region>() - 8, size_of::<Region>() + 8] {
        assert!(matches!(
            whole::<Region>("mapping", bytes),
            Err(Ended::Unknown(_))
        ));
    }
}

/// A full buffer is read again into a larger one; an answer that leaves room is whole.
/// A list that keeps filling its buffer ends as unknown at the limit.
#[test]
fn a_list_that_fills_its_buffer_is_read_again() {
    let mut reads = Vec::new();
    let mut records = vec![0 as c_int; 2];
    let listed = list("list", &mut records, |buffer| {
        reads.push(buffer.len());
        Ok(buffer.len().min(5))
    });
    assert_eq!(listed, Ok(5));
    assert_eq!(reads, [2, 4, 8]);

    let mut records = vec![0 as c_int; 1];
    let endless = list("list", &mut records, |buffer| Ok(buffer.len()));
    assert!(matches!(endless, Err(Ended::Unknown(_))));
    assert_eq!(records.len(), LIST_LIMIT);

    let mut records = vec![0 as c_int; 4];
    assert_eq!(
        list("list", &mut records, |_| Err(libc::ESRCH)),
        Err(Ended::Exited)
    );
}

/// A descriptor table larger than the buffer is not truncated: the disk this process
/// holds is found although the first read had room for a single descriptor.
#[test]
fn a_descriptor_table_larger_than_the_buffer_is_read_whole() {
    let directory = Scratch::new();
    let disks = identified(&directory);
    let _held = File::open(&disks[1].path).unwrap();
    let mut inspector = Inspector::sized(1);
    let mut holders = Vec::new();
    assert_eq!(inspector.inspect(own_pid(), &disks, &mut holders), Ok(()));
    assert!(
        holds(&holders).contains(&(own_pid(), Hold::Descriptor)),
        "{holders:?}"
    );
    assert!(inspector.descriptors.len() > 1);
}

/// Another user's process answers `EPERM`: it is not inspected and not counted as a
/// holder, the answer `lsof` gave when this user ran it.
#[test]
fn another_users_process_is_not_inspected() {
    // SAFETY: `geteuid` has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping: the superuser may inspect every process");
        return;
    }
    let directory = Scratch::new();
    let disks = identified(&directory);
    let mut holders = Vec::new();
    // Process 1 is launchd, which runs as the superuser.
    assert_eq!(
        Inspector::new().inspect(1, &disks, &mut holders),
        Err(Ended::NotInspectable)
    );
    assert!(holders.is_empty());
}

/// This kernel passes the mapping self-test, so scans on this host run in this process. A
/// failure here means the undeclared region query changed and every scan now falls back to
/// `lsof`: correct, but slower, and worth knowing before a user's stop shows it.
#[test]
fn this_kernel_passes_the_mapping_self_test() {
    assert_eq!(method(), Method::InProcess);
}

/// The self-test leaves nothing behind: its file is removed and its page unmapped, pass
/// or fail.
#[test]
fn the_self_test_removes_its_file() {
    let directory = Scratch::new();
    let probe = Probe::map(directory.path()).unwrap();
    let file = probe.file.path.clone();
    assert!(file.is_file());
    assert_eq!(probe.found_by(PROC_PIDREGIONPATHINFO2), Ok(()));
    assert_eq!(
        probe.found_by(UNKNOWN_FLAVOR),
        Err(Fallback::QueryUnanswered)
    );
    drop(probe);
    assert!(!file.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

/// A flavor number no kernel answers.
const UNKNOWN_FLAVOR: c_int = 9_999;
/// `PROC_PIDREGIONINFO`: answers for the region with a shorter record and no file.
const REGION_WITHOUT_FILE: c_int = 7;

/// Each way the query could stop meaning what the scan needs sends the scan to `lsof`
/// with its own reason: no answer, a partial answer, an answer naming another file, and
/// a test that could not be set up at all.
#[test]
fn a_query_that_does_not_report_the_test_mapping_is_not_trusted() {
    let directory = Scratch::new();
    let probe = Probe::map(directory.path()).unwrap();
    assert_eq!(
        probe.found_by(UNKNOWN_FLAVOR),
        Err(Fallback::QueryUnanswered)
    );
    assert_eq!(
        probe.found_by(REGION_WITHOUT_FILE),
        Err(Fallback::SelfTestFailed)
    );

    // The same mapping, expected under another identity: what the test would see if the
    // kernel reported the region with a different file.
    let mut other_inode = Probe::map(directory.path()).unwrap();
    other_inode.file.inode += 1;
    assert_eq!(
        other_inode.found_by(PROC_PIDREGIONPATHINFO2),
        Err(Fallback::SelfTestFailed)
    );
    let mut other_device = Probe::map(directory.path()).unwrap();
    other_device.file.device += 1;
    assert_eq!(
        other_device.found_by(PROC_PIDREGIONPATHINFO2),
        Err(Fallback::SelfTestFailed)
    );

    assert!(Probe::map(&directory.path().join("missing")).is_none());
}

/// The scan's walk finds a mapping this process holds without a descriptor.
#[test]
fn the_region_walk_finds_a_mapping() {
    let directory = Scratch::new();
    let disks = identified(&directory);
    let _mapping = Mapping::of(&disks[0].path);
    let mut holders = Vec::new();
    assert_eq!(Inspector::mappings(own_pid(), &disks, &mut holders), Ok(()));
    assert_eq!(holds(&holders), [(own_pid(), Hold::Mapping)], "{holders:?}");
    assert_eq!(holders[0].disk.as_deref(), Some(disks[0].path.as_path()));
}

/// Prints what the self-test adds to each scan and the scan's time on one to eight
/// threads. Run it alone with `--ignored --nocapture`.
#[test]
#[ignore = "timing report for a quiet host; run alone with --ignored --nocapture"]
fn self_test_and_thread_timing() {
    let report = |what: &str, mut samples: Vec<std::time::Duration>| {
        samples.sort();
        println!(
            "  {what}: min {:.3} ms, median {:.3} ms, max {:.3} ms over {} runs",
            samples[0].as_secs_f64() * 1e3,
            samples[samples.len() / 2].as_secs_f64() * 1e3,
            samples[samples.len() - 1].as_secs_f64() * 1e3,
            samples.len()
        );
    };
    report(
        "mapping self-test",
        timed(200, || assert_eq!(method(), Method::InProcess)),
    );
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let clean = |found: Found| {
        assert!(
            found.holders.is_empty() && found.unknown.is_empty(),
            "{found:?}"
        );
    };
    for threads in [1, 2, 4, 8] {
        let samples = timed(10, || {
            clean(scan_with(
                &Inspector::new,
                threads,
                &disks,
                &AtomicBool::new(false),
            ));
        });
        report(&format!("scan on {threads} threads"), samples);
    }
}
