//! macOS: the scan in this process, through libproc, the interface `lsof` itself uses.
//!
//! For each process: its descriptor table (`PROC_PIDLISTFDS`, then the file status of each
//! file descriptor), its file ports (`PROC_PIDLISTFILEPORTS`) and its file-backed memory
//! regions. libproc answers for this user's processes only; another user's process answers
//! `EPERM`.
//!
//! This inspects what the shipped `lsof` inspects for the same files, through the same
//! kernel calls. In particular the memory regions are read with the query `lsof` uses,
//! which the SDK header does not declare (`PROC_PIDREGIONPATHINFO2`), with the same end
//! condition (see [`Inspector::mappings`]). [`method`] tests that query before every scan,
//! and a scan that fails the test or meets anything it cannot read is left to `lsof`,
//! whole. Like `lsof`, it does not prove that nothing maps a disk.
use super::{Fallback, Found, Hold, Holder, Method};
use libc::c_int;
use std::ffi::OsString;
use std::mem::{size_of, size_of_val};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// From `<sys/proc_info.h>`; libc 0.2 declares the calls but not these flavors.
/// `proc_pidfdinfo`: a file descriptor's status, without its name.
const PROC_PIDFDVNODEINFO: c_int = 1;
/// `proc_pidfdinfo`: a file descriptor's status and name.
const PROC_PIDFDVNODEPATHINFO: c_int = 2;
/// `proc_pidinfo`: the list of file ports.
const PROC_PIDLISTFILEPORTS: c_int = 14;
/// `proc_pidfileportinfo`: a file port's status and name.
const PROC_PIDFILEPORTVNODEPATHINFO: c_int = 2;
/// `proc_pidinfo`: the next file-backed memory region at or above an address, with its
/// file. The kernel skips every other region itself. Apple's libproc
/// (`proc_listpidspath`) and the shipped `lsof` walk mappings with it, but the SDK header
/// does not declare it, so no scan uses it untested ([`method`]).
const PROC_PIDREGIONPATHINFO2: c_int = 22;

/// Entries a descriptor, file-port or process list may reach before the scan gives up.
const LIST_LIMIT: usize = 1 << 20;
/// Room a list read must leave unused to be taken as whole (see [`list`]).
const LIST_MARGIN: usize = 32;
/// File-backed memory regions of one process the walk reads before it gives the scan to
/// `lsof`. The shipped `lsof` stops silently after 10,000 of them; this walk goes on to
/// thirteen times that, so it can only find more. The cost is bounded: at the 10 to 25
/// microseconds a call measured here, a process that reaches the limit takes 1.3 to 3.3 s.
const REGION_LIMIT: usize = 1 << 17;

/// The most threads one scan uses; it uses half the host's cores up to this. Most of a scan
/// is kernel time spent walking each process's memory regions, and several threads walk
/// different processes side by side. On an 18-core host with about 1,560 processes one
/// thread took about 1.0 s, four 0.38 s and eight 0.23 s (medians).
const SCAN_THREADS: usize = 8;

/// One owned disk as the scan matches it: by device and inode, never by name.
#[derive(Clone, Debug)]
struct Disk {
    /// The disk as the caller named it.
    path: PathBuf,
    /// The name the kernel gives the disk, without symbolic links.
    real: PathBuf,
    device: u64,
    inode: u64,
}

impl Disk {
    fn identify(path: &Path) -> std::io::Result<Self> {
        let status = std::fs::metadata(path)?;
        Ok(Self {
            path: path.to_owned(),
            real: std::fs::canonicalize(path)?,
            device: status.dev(),
            inode: status.ino(),
        })
    }
}

/// Why the inspection of one process ended before all of it was read.
#[derive(Debug, PartialEq, Eq)]
enum Ended {
    /// The process exited: it holds nothing and can issue no further I/O of its own.
    Exited,
    /// This user may not inspect the process: not a holder this scan, or `lsof` run by
    /// this user, can see.
    NotInspectable,
    /// The scan in this process cannot answer; `lsof` must, for the reason given.
    Incomplete(Fallback),
}

/// A C record the kernel fills. Any byte pattern, all zero included, must be a valid value.
///
/// # Safety
///
/// The type is `repr(C)` plain data without padding the reader depends on, pointers or
/// niches, laid out exactly as the header declares it.
unsafe trait Record: Copy {
    fn empty() -> Self {
        // SAFETY: the implementor guarantees that all-zero bytes are a valid value.
        unsafe { std::mem::zeroed() }
    }
}

/// `struct proc_fileportinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
struct FilePort {
    name: u32,
    kind: u32,
}

/// `struct vnode_fdinfo`: `struct proc_fileinfo` (24 bytes, not read here), then the file.
#[repr(C)]
#[derive(Clone, Copy)]
struct DescriptorFile {
    _descriptor: [u64; 3],
    file: libc::vnode_info,
}

/// `struct vnode_fdinfowithpath`: `struct proc_fileinfo`, then the file and its name.
#[repr(C)]
#[derive(Clone, Copy)]
struct NamedDescriptorFile {
    _descriptor: [u64; 3],
    file: libc::vnode_info_path,
}

/// `struct proc_regionwithpathinfo`: `struct proc_regioninfo`, of which only the trailing
/// address and size are read, then the mapped file and its name.
#[repr(C)]
#[derive(Clone, Copy)]
struct Region {
    _attributes: [u64; 10],
    address: u64,
    size: u64,
    file: libc::vnode_info_path,
}

// The sizes `<sys/proc_info.h>` gives these records. The kernel refuses a smaller buffer
// and writes exactly its own size, which every read of a single record checks.
const _: () = {
    assert!(size_of::<libc::proc_fdinfo>() == 8);
    assert!(size_of::<FilePort>() == 8);
    assert!(size_of::<DescriptorFile>() == 176);
    assert!(size_of::<NamedDescriptorFile>() == 1200);
    assert!(size_of::<Region>() == 1272);
};

// SAFETY: each is plain integer data in the header's layout.
unsafe impl Record for c_int {}
unsafe impl Record for libc::proc_fdinfo {}
unsafe impl Record for FilePort {}
unsafe impl Record for DescriptorFile {}
unsafe impl Record for NamedDescriptorFile {}
unsafe impl Record for Region {}

/// One libproc call: the count it returns, or the errno of a refused call. libproc returns
/// zero both for an empty answer and for an error, so errno is cleared first.
fn answer(call: impl FnOnce() -> c_int) -> Result<usize, c_int> {
    // SAFETY: `__error` returns this thread's errno location.
    unsafe { *libc::__error() = 0 };
    let returned = call();
    // SAFETY: as above.
    let errno = unsafe { *libc::__error() };
    match usize::try_from(returned) {
        Ok(count) if count > 0 => Ok(count),
        Ok(_) if errno == 0 => Ok(0),
        Ok(_) => Err(errno),
        Err(_) if errno == 0 => Err(libc::EIO),
        Err(_) => Err(errno),
    }
}

/// The byte length of a buffer as libproc takes it.
fn length<T>(records: &[T]) -> Result<c_int, c_int> {
    c_int::try_from(size_of_val(records)).map_err(|_| libc::EOVERFLOW)
}

/// `proc_pidinfo` into `records`: the bytes written.
fn process_info<T: Record>(
    pid: c_int,
    flavor: c_int,
    argument: u64,
    records: &mut [T],
) -> Result<usize, c_int> {
    let bytes = length(records)?;
    // SAFETY: the buffer is `bytes` writable bytes of records that accept any bytes.
    answer(|| unsafe {
        libc::proc_pidinfo(pid, flavor, argument, records.as_mut_ptr().cast(), bytes)
    })
}

/// `proc_pidfdinfo` into `record`: the bytes written.
fn descriptor_info<T: Record>(
    pid: c_int,
    descriptor: c_int,
    flavor: c_int,
    record: &mut T,
) -> Result<usize, c_int> {
    let records = std::slice::from_mut(record);
    let bytes = length(records)?;
    // SAFETY: as in `process_info`.
    answer(|| unsafe {
        libc::proc_pidfdinfo(pid, descriptor, flavor, records.as_mut_ptr().cast(), bytes)
    })
}

/// `proc_pidfileportinfo` into `record`: the bytes written.
fn file_port_info<T: Record>(
    pid: c_int,
    port: u32,
    flavor: c_int,
    record: &mut T,
) -> Result<usize, c_int> {
    let records = std::slice::from_mut(record);
    let bytes = length(records)?;
    // SAFETY: as in `process_info`.
    answer(|| unsafe {
        libc::proc_pidfileportinfo(pid, port, flavor, records.as_mut_ptr().cast(), bytes)
    })
}

/// The undeclared query for the first file-backed region of `pid` at or above `cursor`.
/// A scan asks through a [`RegionQuery`] so a test can put another answer in its place.
fn file_backed_region(pid: c_int, cursor: u64, region: &mut Region) -> Result<usize, c_int> {
    process_info(
        pid,
        PROC_PIDREGIONPATHINFO2,
        cursor,
        std::slice::from_mut(region),
    )
}

type RegionQuery = fn(c_int, u64, &mut Region) -> Result<usize, c_int>;

/// How an errno from a call about one process ends that process's inspection: the two
/// that mean "not a holder this scan may see", or the scan cannot answer.
fn ended(errno: c_int) -> Ended {
    match errno {
        libc::ESRCH => Ended::Exited,
        libc::EPERM => Ended::NotInspectable,
        _ => Ended::Incomplete(Fallback::ScanIncomplete),
    }
}

/// Require one whole record: the kernel writes exactly the size it gives the record.
fn whole<T>(bytes: usize) -> Result<(), Ended> {
    if bytes == size_of::<T>() {
        Ok(())
    } else {
        Err(Ended::Incomplete(Fallback::ScanIncomplete))
    }
}

/// The number of whole records in `bytes`. A partial record is not a shorter list.
fn records<T>(bytes: usize) -> Result<usize, Ended> {
    if bytes % size_of::<T>() == 0 {
        Ok(bytes / size_of::<T>())
    } else {
        Err(Ended::Incomplete(Fallback::ScanIncomplete))
    }
}

/// Read a kernel list into `records` and return its length.
///
/// The kernel fills what fits and reports no truncation. It also takes the list's size
/// before it fills its own buffer, so a list that grew in between comes back cut at the
/// old size even when the caller had room for more. Neither can be seen in one answer. So
/// a read is accepted only when it leaves [`LIST_MARGIN`] entries unused, a margin against
/// truncation, and is repeated into a larger buffer until it does; a list that never
/// settles is [`Fallback::ScanIncomplete`]. The margin does not make the read atomic or
/// show the list whole: an entry added while the kernel fills the buffer can still be
/// missed, by this scan as by `lsof`.
fn list<T: Record>(
    records: &mut Vec<T>,
    mut read: impl FnMut(&mut [T]) -> Result<usize, Ended>,
) -> Result<usize, Ended> {
    if records.len() < LIST_MARGIN * 2 {
        records.resize(LIST_MARGIN * 2, T::empty());
    }
    loop {
        let entries = read(records.as_mut_slice())?;
        if entries + LIST_MARGIN <= records.len() {
            return Ok(entries);
        }
        if records.len() >= LIST_LIMIT {
            return Err(Ended::Incomplete(Fallback::ScanIncomplete));
        }
        records.resize(records.len() * 2, T::empty());
    }
}

/// The disk a file's status names. `vst_dev` is the 32-bit `st_dev` that `stat` widened.
fn matching<'a>(disks: &'a [Disk], file: &libc::vinfo_stat) -> Option<&'a Disk> {
    disks
        .iter()
        .find(|disk| disk.device as u32 == file.vst_dev && disk.inode == file.vst_ino)
}

/// The name the kernel reports with a file, if any.
fn name(file: &libc::vnode_info_path) -> Option<PathBuf> {
    let bytes: Vec<u8> = file
        .vip_path
        .as_flattened()
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    (!bytes.is_empty()).then(|| PathBuf::from(OsString::from_vec(bytes)))
}

/// Record that `pid` holds `disk`, once for each way it holds it. `name` is asked for only
/// when the hold is new.
fn hold(
    holders: &mut Vec<Holder>,
    pid: i32,
    hold: Hold,
    disk: &Disk,
    name: impl FnOnce() -> Option<PathBuf>,
) {
    let known = holders.iter().any(|holder| {
        holder.pid == pid && holder.hold == hold && holder.disk.as_ref() == Some(&disk.path)
    });
    if !known {
        holders.push(Holder {
            pid,
            hold,
            disk: Some(disk.path.clone()),
            name: name(),
        });
    }
}

/// Whether this scan may run in this process, tested on the property the scan relies on.
///
/// A process that mapped a disk and closed its descriptor is the holder `lsof` finds and
/// the one the undeclared region query must find. A kernel that stopped answering the
/// query would be noticed at once, but one that answered with a slightly different meaning
/// would report no such holder. So the test makes that very case in this process: a file
/// of its own, one page of it mapped shared, its descriptor closed. It then requires the
/// query, asked at the page's address, to report that region with that file's device and
/// inode, and the walk a scan makes to find it.
///
/// What this establishes is narrow. The flavor exists and reports the device and inode of
/// an ordinary shared file mapping, on this kernel, now. It does not establish coverage of
/// every kind of mapping: XNU skips submaps (the shared library cache) in this query, for
/// this scan as for `lsof`, and regions backed by other pagers are not tested here.
pub(super) fn method() -> Method {
    let tested = Probe::map(&std::env::temp_dir())
        .ok_or(Fallback::SelfTestUnavailable)
        .and_then(|probe| probe.found_by(PROC_PIDREGIONPATHINFO2));
    match tested {
        Ok(()) => Method::InProcess,
        Err(why) => Method::Lsof(why),
    }
}

/// The self-test's own file with one page of it mapped in this process and its descriptor
/// closed: the only mapping this module ever makes. Dropping it unmaps the page and removes
/// the file.
struct Probe {
    address: *mut libc::c_void,
    length: usize,
    file: Disk,
}

impl Probe {
    /// `None` when the file or the mapping cannot be made in `directory`.
    fn map(directory: &Path) -> Option<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        // SAFETY: `sysconf` has no preconditions.
        let length = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
        let path = directory.join(format!(
            ".hack-disk-scan-probe.{}.{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        // An existing file at that name is not this call's: the exclusive create fails
        // and nothing is removed.
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .ok()?;
        let mapped = opened.metadata().ok().and_then(|status| {
            // SAFETY: a new read-only shared mapping of one page of a live descriptor at
            // an address the kernel chooses. The page is never read, so the empty file
            // behind it is safe.
            let address = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    length,
                    libc::PROT_READ,
                    libc::MAP_SHARED,
                    opened.as_raw_fd(),
                    0,
                )
            };
            (address != libc::MAP_FAILED).then(|| Self {
                address,
                length,
                file: Disk {
                    path: path.clone(),
                    real: path.clone(),
                    device: status.dev(),
                    inode: status.ino(),
                },
            })
        });
        if mapped.is_none() {
            let _ = std::fs::remove_file(&path);
        }
        // From here only the page holds the file: the descriptor closes with `opened`.
        mapped
    }

    /// Require `flavor`, asked about this process, to report the probe's page with the
    /// probe's file, and the scan's own walk to find it.
    fn found_by(&self, flavor: c_int) -> Result<(), Fallback> {
        // SAFETY: `getpid` has no preconditions.
        let pid = unsafe { libc::getpid() };
        let address = self.address as u64;
        let mut region = Region::empty();
        match process_info(pid, flavor, address, std::slice::from_mut(&mut region)) {
            Ok(bytes) if bytes == size_of::<Region>() => {}
            // A partial record is an answer, but not one this build can read.
            Ok(_) => return Err(Fallback::SelfTestFailed),
            Err(_) => return Err(Fallback::QueryUnanswered),
        }
        let covers = region.address <= address && address - region.address < region.size;
        let disks = std::slice::from_ref(&self.file);
        if !covers || matching(disks, &region.file.vip_vi.vi_stat).is_none() {
            return Err(Fallback::SelfTestFailed);
        }
        let mut holders = Vec::new();
        let walked = Inspector::new(file_backed_region).mappings(pid, disks, &mut holders);
        let found = holders.len() == 1 && holders[0].pid == pid && holders[0].hold == Hold::Mapping;
        if walked != Ok(()) || !found {
            return Err(Fallback::SelfTestFailed);
        }
        Ok(())
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        // SAFETY: exactly the mapping `map` created; nothing else refers to it.
        unsafe { libc::munmap(self.address, self.length) };
        let _ = std::fs::remove_file(&self.file.path);
    }
}

/// Every process on the host, zombies included (they answer as exited).
fn processes() -> Result<Vec<i32>, Fallback> {
    let mut pids: Vec<c_int> = vec![0; 4096];
    let listed = list(&mut pids, |pids| {
        let incomplete = |_| Ended::Incomplete(Fallback::ScanIncomplete);
        let bytes = length(pids).map_err(incomplete)?;
        // SAFETY: the buffer is `bytes` writable bytes of integers. Unlike the other calls,
        // this one returns a count of entries.
        answer(|| unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) })
            .map_err(incomplete)
    });
    match listed {
        Ok(count) if count > 0 => {
            pids.truncate(count);
            // Process 0 is the kernel itself, which holds no descriptor table.
            pids.retain(|pid| *pid > 0);
            Ok(pids)
        }
        _ => Err(Fallback::ScanIncomplete),
    }
}

/// Reads one process at a time, reusing its list buffers across processes.
struct Inspector {
    descriptors: Vec<libc::proc_fdinfo>,
    ports: Vec<FilePort>,
    regions: RegionQuery,
}

impl Inspector {
    fn new(regions: RegionQuery) -> Self {
        Self {
            descriptors: vec![libc::proc_fdinfo::empty(); 1024],
            ports: vec![FilePort::empty(); LIST_MARGIN * 2],
            regions,
        }
    }

    /// Record every hold `pid` has on `disks`.
    fn inspect(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        self.descriptors(pid, disks, holders)?;
        self.file_ports(pid, disks, holders)?;
        self.mappings(pid, disks, holders)
    }

    fn descriptors(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        let count = list(&mut self.descriptors, |table| {
            let bytes = process_info(pid, libc::PROC_PIDLISTFDS, 0, table).map_err(ended)?;
            records::<libc::proc_fdinfo>(bytes)
        })?;
        for listed in &self.descriptors[..count] {
            if listed.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut open = DescriptorFile::empty();
            match descriptor_info(pid, listed.proc_fd, PROC_PIDFDVNODEINFO, &mut open) {
                Ok(bytes) => whole::<DescriptorFile>(bytes)?,
                // Closed, or replaced by another kind of file, since it was listed
                // (`EBADF`); or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EBADF | libc::ENOENT) => continue,
                Err(errno) => return Err(ended(errno)),
            }
            if let Some(disk) = matching(disks, &open.file.vi_stat) {
                hold(holders, pid, Hold::Descriptor, disk, || {
                    // The name is a second call, made only for a holder and never required.
                    let mut named = NamedDescriptorFile::empty();
                    descriptor_info(pid, listed.proc_fd, PROC_PIDFDVNODEPATHINFO, &mut named)
                        .ok()
                        .and_then(|_| name(&named.file))
                });
            }
        }
        Ok(())
    }

    fn file_ports(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        let count = list(&mut self.ports, |ports| {
            let bytes = process_info(pid, PROC_PIDLISTFILEPORTS, 0, ports).map_err(ended)?;
            records::<FilePort>(bytes)
        })?;
        for listed in &self.ports[..count] {
            if listed.kind != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut sent = NamedDescriptorFile::empty();
            match file_port_info(pid, listed.name, PROC_PIDFILEPORTVNODEPATHINFO, &mut sent) {
                Ok(bytes) => whole::<NamedDescriptorFile>(bytes)?,
                // Released since it was listed (`EINVAL`), carrying another kind of file
                // now (`ENOTSUP`), or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EINVAL | libc::ENOTSUP | libc::ENOENT) => continue,
                Err(errno) => return Err(ended(errno)),
            }
            if let Some(disk) = matching(disks, &sent.file.vip_vi.vi_stat) {
                hold(holders, pid, Hold::FilePort, disk, || name(&sent.file));
            }
        }
        Ok(())
    }

    /// Walk the process's file-backed memory regions upward from address zero. Each answer
    /// is the first such region at or above the cursor.
    fn mappings(&self, pid: i32, disks: &[Disk], holders: &mut Vec<Holder>) -> Result<(), Ended> {
        let mut cursor = 0_u64;
        let mut asked_again = false;
        for _ in 0..REGION_LIMIT {
            let mut region = Region::empty();
            match (self.regions)(pid, cursor, &mut region) {
                Ok(bytes) => whole::<Region>(bytes)?,
                // XNU answers this undeclared query with `EINVAL` when the process has no
                // further file-backed region, and also for a region whose vnode it cannot
                // get (`proc_pidregionpathinfo2`: `vnode_getwithvid` fails while a vnode is
                // reclaimed). The two cannot be told apart from here.
                //
                // The shipped `lsof` ends its walk there too. That was established on lsof
                // 4.91 as shipped with macOS 26.5 by disassembling its `proc_pidinfo` call
                // sites: it asks for flavor `0x16` (this query) with a 1,272-byte record,
                // leaves the loop on any non-positive return, and never asks for the
                // declared flavor 8. This walk matches it, and asks once more first, which
                // can only find more: a region whose reclaim has finished is passed.
                //
                // Neither walk proves that nothing maps a disk. Following the declared
                // query region by region from here would show the end of the address
                // space, and was measured at about 2.5 million calls and 7.7 s for one
                // scan, ten times the `lsof` child, which is why it is not done.
                //
                // What this scan adds to `lsof` is only that it distrusts itself: a failed
                // self-test, and anything here that is not one of the answers above, send
                // the whole scan to `lsof`. That fallback is a safety property. Do not
                // remove it as an optimization.
                Err(libc::EINVAL) if !asked_again => {
                    asked_again = true;
                    continue;
                }
                Err(libc::EINVAL) => return Ok(()),
                Err(errno) => return Err(ended(errno)),
            }
            asked_again = false;
            let file = &region.file.vip_vi.vi_stat;
            // The kernel reads the file's status as this process, and reports the region
            // without one when this process may not read it (a file another program
            // keeps private; hosts have dozens mapped). `lsof` cannot match such a region
            // either. A disk is a file this process has just read the status of, so the
            // region is not one, unless the kernel names it as one: then the status
            // failed for another reason and the walk cannot tell.
            if file.vst_dev == 0 && file.vst_ino == 0 {
                let named = name(&region.file);
                if disks
                    .iter()
                    .any(|disk| named.as_deref() == Some(&disk.real))
                {
                    return Err(Ended::Incomplete(Fallback::ScanIncomplete));
                }
            }
            if let Some(disk) = matching(disks, file) {
                hold(holders, pid, Hold::Mapping, disk, || name(&region.file));
            }
            cursor = match region.address.checked_add(region.size) {
                Some(next) if next > cursor => next,
                _ => return Err(Ended::Incomplete(Fallback::ScanIncomplete)),
            };
        }
        Err(Ended::Incomplete(Fallback::ScanIncomplete))
    }
}

/// Inspect every process once for a hold on any of `paths`: what was found, or why `lsof`
/// must scan instead. `stop` ends the scan early, as unknown.
pub(super) fn scan(paths: &[PathBuf], stop: &AtomicBool) -> Result<Found, Fallback> {
    scan_with(file_backed_region, SCAN_THREADS, paths, stop)
}

/// What one thread of a scan established.
#[derive(Default)]
struct Part {
    holders: Vec<Holder>,
    incomplete: Option<Fallback>,
    stopped: bool,
}

/// [`scan`] asking `regions` for mappings, on at most `threads` threads and at most half
/// the host's cores, this thread included.
fn scan_with(
    regions: RegionQuery,
    threads: usize,
    paths: &[PathBuf],
    stop: &AtomicBool,
) -> Result<Found, Fallback> {
    let disks = paths
        .iter()
        .map(|path| Disk::identify(path))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Fallback::ScanIncomplete)?;
    let processes = processes()?;
    // Each thread takes the next process nobody has taken, so one large process does not
    // hold up a whole share of the list.
    let next = AtomicUsize::new(0);
    let inspect = || {
        let mut inspector = Inspector::new(regions);
        let mut part = Part::default();
        while let Some(pid) = processes.get(next.fetch_add(1, Ordering::Relaxed)) {
            if stop.load(Ordering::Relaxed) {
                part.stopped = true;
                break;
            }
            match inspector.inspect(*pid, &disks, &mut part.holders) {
                Ok(()) | Err(Ended::Exited | Ended::NotInspectable) => {}
                Err(Ended::Incomplete(why)) => {
                    part.incomplete.get_or_insert(why);
                }
            }
        }
        part
    };
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let helpers = (cores / 2)
        .min(threads)
        .min(processes.len())
        .saturating_sub(1);
    let parts = std::thread::scope(|scope| {
        // A helper that cannot start is not needed: the threads that did start share the
        // whole list.
        let helpers: Vec<_> = (0..helpers)
            .filter_map(|_| {
                std::thread::Builder::new()
                    .name("disk-handle-scan".into())
                    .spawn_scoped(scope, inspect)
                    .ok()
            })
            .collect();
        let mut parts = vec![Some(inspect())];
        parts.extend(helpers.into_iter().map(|helper| helper.join().ok()));
        parts
    });
    let mut found = Found::default();
    let (mut incomplete, mut stopped) = (None, false);
    for part in parts {
        // A helper that panicked did not inspect all the processes it had taken.
        let part = part.unwrap_or(Part {
            incomplete: Some(Fallback::ScanIncomplete),
            ..Part::default()
        });
        found.holders.extend(part.holders);
        incomplete = incomplete.or(part.incomplete);
        stopped |= part.stopped;
    }
    found.holders.sort_by_key(|holder| holder.pid);
    if stopped {
        // Nobody waits for a stopped scan; it must still not read as "nothing found".
        found.unknown.push("scan stopped at its bound".into());
        return Ok(found);
    }
    if let Some(why) = incomplete {
        return Err(why);
    }
    Ok(found)
}

#[cfg(test)]
mod tests;
