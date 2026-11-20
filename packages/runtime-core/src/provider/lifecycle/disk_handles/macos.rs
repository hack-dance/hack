//! macOS: the scan in this process, through libproc, the interface `lsof` itself uses.
//!
//! For each process: its descriptor table (`PROC_PIDLISTFDS`, then the file status of each
//! file descriptor), its file ports (`PROC_PIDLISTFILEPORTS`) and its file-backed memory
//! regions. libproc answers for this user's processes only; another user's process answers
//! `EPERM`.
//!
//! The memory regions are read with a query the SDK header does not declare
//! (`PROC_PIDREGIONPATHINFO2`). The shipped `lsof` reads them with the same query and takes
//! its first `EINVAL` as the end of a process's mappings. This scan trusts the query less:
//! [`method`] tests it before every scan, and [`mapped_only_here`] has the declared region
//! query confirm what the walks found. A scan that fails either is left to `lsof`, whole.
use super::{Fallback, Found, Hold, Holder, Method};
use libc::c_int;
use std::ffi::OsString;
use std::fs::File;
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
/// `proc_pidinfo`: the memory region at or above an address, of any kind, without its
/// file. Declared in the SDK header.
const PROC_PIDREGIONINFO: c_int = 7;
/// `proc_pidinfo`: the list of file ports.
const PROC_PIDLISTFILEPORTS: c_int = 14;
/// `proc_pidfileportinfo`: a file port's status and name.
const PROC_PIDFILEPORTVNODEPATHINFO: c_int = 2;
/// `proc_pidinfo`: the next file-backed memory region at or above an address, with its
/// file. The kernel skips every other region itself. Apple's libproc
/// (`proc_listpidspath`) and the shipped `lsof` walk mappings with it, but the SDK header
/// does not declare it, so no scan uses it untested ([`method`]).
const PROC_PIDREGIONPATHINFO2: c_int = 22;

// From `<sys/mman.h>` and `<mach/vm_inherit.h>`; libc 0.2 declares neither.
unsafe extern "C" {
    fn minherit(address: *mut libc::c_void, length: usize, inheritance: c_int) -> c_int;
}
/// `minherit`: the pages are absent from a forked child.
const VM_INHERIT_NONE: c_int = 2;

/// Entries a descriptor, file-port or process list may reach before the scan gives up.
const LIST_LIMIT: usize = 1 << 20;
/// Room a list read must leave unused to be taken as whole (see [`list`]).
const LIST_MARGIN: usize = 32;
/// File-backed memory regions of one process the scan walks before it gives up.
const REGION_LIMIT: usize = 1 << 22;
/// What the declared region query counts on a file mapped by one page and nothing else:
/// the file's own pager and that page.
const ALONE: u32 = 2;

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

/// `struct proc_regioninfo`, of which the reference count of the region's memory object
/// and the region's address and size are read.
#[repr(C)]
#[derive(Clone, Copy)]
struct RegionInfo {
    _attributes: [u32; 13],
    references: u32,
    _counts: [u32; 6],
    address: u64,
    size: u64,
}

/// `struct proc_regionwithpathinfo`: the region, then the mapped file and its name.
#[repr(C)]
#[derive(Clone, Copy)]
struct Region {
    info: RegionInfo,
    file: libc::vnode_info_path,
}

// The sizes `<sys/proc_info.h>` gives these records. The kernel refuses a smaller buffer
// and writes exactly its own size, which every read of a single record checks.
const _: () = {
    assert!(size_of::<libc::proc_fdinfo>() == 8);
    assert!(size_of::<FilePort>() == 8);
    assert!(size_of::<DescriptorFile>() == 176);
    assert!(size_of::<NamedDescriptorFile>() == 1200);
    assert!(size_of::<RegionInfo>() == 96);
    assert!(std::mem::offset_of!(RegionInfo, references) == 52);
    assert!(size_of::<Region>() == 1272);
};

// SAFETY: each is plain integer data in the header's layout.
unsafe impl Record for c_int {}
unsafe impl Record for libc::proc_fdinfo {}
unsafe impl Record for FilePort {}
unsafe impl Record for DescriptorFile {}
unsafe impl Record for NamedDescriptorFile {}
unsafe impl Record for RegionInfo {}
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

/// How an errno from a call about one process ends that process's inspection. `otherwise`
/// is the reason `lsof` must scan when the errno is neither of the two that mean "not a
/// holder this scan may see".
fn ended(errno: c_int, otherwise: Fallback) -> Ended {
    match errno {
        libc::ESRCH => Ended::Exited,
        libc::EPERM => Ended::NotInspectable,
        _ => Ended::Incomplete(otherwise),
    }
}

/// Require one whole record: the kernel writes exactly the size it gives the record.
fn whole<T>(bytes: usize, otherwise: Fallback) -> Result<(), Ended> {
    if bytes == size_of::<T>() {
        Ok(())
    } else {
        Err(Ended::Incomplete(otherwise))
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
/// old size even when the caller had room for more. Neither can be seen in one answer. A
/// read is therefore taken as whole only when it leaves [`LIST_MARGIN`] entries unused,
/// and is repeated into a larger buffer until it does; a list that never settles is
/// [`Fallback::ScanIncomplete`]. This narrows the window and does not make the read
/// atomic: an entry added while the kernel fills the buffer can still be missed, by this
/// scan as by `lsof`.
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

/// One page of a file, mapped shared and read-only in this process with no descriptor
/// kept. Dropping it unmaps the page.
struct Page {
    address: *mut libc::c_void,
    length: usize,
}

impl Page {
    /// `None` when the page cannot be mapped.
    fn of(file: &File) -> Option<Self> {
        use std::os::fd::AsRawFd;
        // SAFETY: `sysconf` has no preconditions.
        let length = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
        // SAFETY: a new read-only shared mapping of one page of a live descriptor at an
        // address the kernel chooses. The page is never read, so a shorter file is safe.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return None;
        }
        // A child this process forks meanwhile must not inherit the page: it would count
        // as another mapping of the file until the child executes its program.
        // SAFETY: exactly the page mapped above.
        unsafe { minherit(address, length, VM_INHERIT_NONE) };
        Some(Self { address, length })
    }

    /// What the declared region query counts as references to the memory object of the
    /// file this page maps: [`ALONE`] when nothing else maps the file, and one more for
    /// each other mapping of it in any process, shared or private. `None` when the query
    /// does not answer for this page.
    ///
    /// This is XNU's own bookkeeping, not a documented contract, which is why [`method`]
    /// tests it before every scan. It has one known slack: while the object is being paged
    /// (a mapper writing through its mapping and syncing it), the kernel reports one
    /// reference fewer for some of the time. An open descriptor does not count.
    fn references(&self) -> Option<u32> {
        // SAFETY: `getpid` has no preconditions.
        let pid = unsafe { libc::getpid() };
        let address = self.address as u64;
        let mut region = RegionInfo::empty();
        let bytes = process_info(
            pid,
            PROC_PIDREGIONINFO,
            address,
            std::slice::from_mut(&mut region),
        )
        .ok()?;
        let covers = region.address <= address && address - region.address < region.size;
        (bytes == size_of::<RegionInfo>() && covers).then_some(region.references)
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        // SAFETY: exactly the mapping `of` created; nothing else refers to it.
        unsafe { libc::munmap(self.address, self.length) };
    }
}

/// Whether the declared region query shows that nothing but this call maps any of `disks`.
///
/// The mapping walks cannot show that they were complete (see [`Inspector::mappings`]). This
/// asks the kernel from the other side: it maps one page of each disk, reads the reference
/// count of the disk's memory object with the declared query and unmaps the page. Any
/// mapping the walks missed, in any process of any user, holds a reference, so a count
/// above [`ALONE`] means the walks were not complete. So does a disk that cannot be opened,
/// is no longer the file that was identified, or cannot be mapped or asked about.
fn mapped_only_here(disks: &[Disk]) -> bool {
    disks.iter().all(|disk| {
        let Ok(file) = File::open(&disk.path) else {
            return false;
        };
        let same = file
            .metadata()
            .is_ok_and(|status| status.dev() == disk.device && status.ino() == disk.inode);
        let page = Page::of(&file);
        // The descriptor is closed before the count is read, so only the page is this
        // call's.
        drop(file);
        same && page.is_some_and(|page| page.references() == Some(ALONE))
    })
}

/// Whether this scan may run in this process, tested on the properties the scan relies on.
///
/// A process that mapped a disk and closed its descriptor is the holder `lsof` finds and
/// the one the undeclared region query must find. A kernel that stopped answering the
/// query would be noticed at once, but one that answered with a slightly different meaning
/// would report no such holder and turn a pass into a false "nothing holds the disks". So
/// the test makes that very case in this process: a file of its own, one page of it mapped
/// shared, its descriptor closed. It then requires:
///
/// * the undeclared query, asked at the page's address, to report that region with that
///   file's device and inode;
/// * the walk a scan makes to find it;
/// * the declared query to count the page as the file's only mapping, to count a second
///   mapping of the file, and to stop counting it once it is unmapped.
///
/// What this establishes is narrow. The flavor exists and reports the device and inode of
/// an ordinary shared file mapping, and the declared count moves with mappings, on this
/// kernel, now. It does not establish coverage of every kind of mapping: XNU skips submaps
/// (the shared library cache) in both region queries, as it does for `lsof`, and regions
/// backed by other pagers are not tested here.
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
/// closed. Dropping it unmaps the page and removes the file.
struct Probe {
    page: Page,
    file: Disk,
}

impl Probe {
    /// `None` when the file or the mapping cannot be made in `directory`.
    fn map(directory: &Path) -> Option<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
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
        let made = (|| {
            let status = opened.metadata().ok()?;
            opened.set_len(1).ok()?;
            Some(Self {
                page: Page::of(&opened)?,
                file: Disk {
                    path: path.clone(),
                    real: path.clone(),
                    device: status.dev(),
                    inode: status.ino(),
                },
            })
        })();
        if made.is_none() {
            let _ = std::fs::remove_file(&path);
        }
        // From here only the page holds the file: the descriptor closes with `opened`.
        made
    }

    /// Require `flavor`, asked about this process, to report the probe's page with the
    /// probe's file, the scan's own walk to find it, and the declared query to count the
    /// file's mappings.
    fn found_by(&self, flavor: c_int) -> Result<(), Fallback> {
        // SAFETY: `getpid` has no preconditions.
        let pid = unsafe { libc::getpid() };
        let address = self.page.address as u64;
        let mut region = Region::empty();
        match process_info(pid, flavor, address, std::slice::from_mut(&mut region)) {
            Ok(bytes) if bytes == size_of::<Region>() => {}
            // A partial record is an answer, but not one this build can read.
            Ok(_) => return Err(Fallback::SelfTestFailed),
            Err(_) => return Err(Fallback::QueryUnanswered),
        }
        let covers =
            region.info.address <= address && address - region.info.address < region.info.size;
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
        self.counted().ok_or(Fallback::SelfTestFailed)
    }

    /// The declared query counts this file's mappings: the page alone, then a second
    /// mapping, then the page alone again.
    fn counted(&self) -> Option<()> {
        let count = |expected: u32| (self.page.references() == Some(expected)).then_some(());
        count(ALONE)?;
        let second = Page::of(&File::open(&self.file.path).ok()?)?;
        count(ALONE + 1)?;
        (second.references() == Some(ALONE + 1)).then_some(())?;
        drop(second);
        count(ALONE)
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
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
        let incomplete = Fallback::ScanIncomplete;
        let count = list(&mut self.descriptors, |table| {
            let bytes = process_info(pid, libc::PROC_PIDLISTFDS, 0, table)
                .map_err(|errno| ended(errno, incomplete))?;
            records::<libc::proc_fdinfo>(bytes)
        })?;
        for listed in &self.descriptors[..count] {
            if listed.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut open = DescriptorFile::empty();
            match descriptor_info(pid, listed.proc_fd, PROC_PIDFDVNODEINFO, &mut open) {
                Ok(bytes) => whole::<DescriptorFile>(bytes, incomplete)?,
                // Closed, or replaced by another kind of file, since it was listed
                // (`EBADF`); or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EBADF | libc::ENOENT) => continue,
                Err(errno) => return Err(ended(errno, incomplete)),
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
        let incomplete = Fallback::ScanIncomplete;
        let count = list(&mut self.ports, |ports| {
            let bytes = process_info(pid, PROC_PIDLISTFILEPORTS, 0, ports)
                .map_err(|errno| ended(errno, incomplete))?;
            records::<FilePort>(bytes)
        })?;
        for listed in &self.ports[..count] {
            if listed.kind != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut sent = NamedDescriptorFile::empty();
            match file_port_info(pid, listed.name, PROC_PIDFILEPORTVNODEPATHINFO, &mut sent) {
                Ok(bytes) => whole::<NamedDescriptorFile>(bytes, incomplete)?,
                // Released since it was listed (`EINVAL`), carrying another kind of file
                // now (`ENOTSUP`), or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EINVAL | libc::ENOTSUP | libc::ENOENT) => continue,
                Err(errno) => return Err(ended(errno, incomplete)),
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
        let incomplete = Fallback::WalkIncomplete;
        let mut cursor = 0_u64;
        let mut asked_again = false;
        for _ in 0..REGION_LIMIT {
            let mut region = Region::empty();
            match (self.regions)(pid, cursor, &mut region) {
                Ok(bytes) => whole::<Region>(bytes, incomplete)?,
                // XNU answers this undeclared query with `EINVAL` both when the process
                // has no further file-backed region and when it cannot get the vnode of the
                // next one (`proc_pidregionpathinfo2`: `vnode_getwithvid` fails for a vnode
                // that is being reclaimed). So `EINVAL` alone never shows that the walk was
                // complete, and this walk does not claim it. It asks once more, which gets
                // past a region whose reclaim has finished, and then stops here without a
                // verdict. The declared region query decides: `mapped_only_here` must show
                // that nothing but the scan maps each disk, and a scan whose walks cannot
                // be shown complete that way is sent whole to `lsof`
                // (`Fallback::WalkIncomplete`). That check and that fallback are a safety
                // property. Do not remove either as an optimization.
                //
                // The declared query cannot decide here, region by region. It reports
                // regions of every kind, and following it from this cursor to the end of
                // each address space measured 2.5 million calls and 7.7 s for one scan of a
                // host with 1,300 processes, ten times the `lsof` child.
                Err(libc::EINVAL) if !asked_again => {
                    asked_again = true;
                    continue;
                }
                Err(libc::EINVAL) => return Ok(()),
                Err(errno) => return Err(ended(errno, incomplete)),
            }
            asked_again = false;
            let file = &region.file.vip_vi.vi_stat;
            // The kernel reads the file's status as this process, and reports the region
            // without one when this process may not read it (a file another program
            // keeps private; hosts have dozens mapped). A disk is a file this process
            // has just read the status of, so such a region is not one, unless the kernel
            // names it as one: then the status failed for another reason and the walk
            // cannot tell.
            if file.vst_dev == 0 && file.vst_ino == 0 {
                let named = name(&region.file);
                if disks
                    .iter()
                    .any(|disk| named.as_deref() == Some(&disk.real))
                {
                    return Err(Ended::Incomplete(incomplete));
                }
            }
            if let Some(disk) = matching(disks, file) {
                hold(holders, pid, Hold::Mapping, disk, || name(&region.file));
            }
            cursor = match region.info.address.checked_add(region.info.size) {
                Some(next) if next > cursor => next,
                _ => return Err(Ended::Incomplete(incomplete)),
            };
        }
        Err(Ended::Incomplete(incomplete))
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
    // Taken before the walks as well as after them, so a mapping that is being paged
    // during one reading (see `Page::references`) still has two more to show up in.
    let unmapped_before = mapped_only_here(&disks);
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
    // A holder is an answer by itself. "No holder" is one only once the declared query
    // shows the mapping walks were complete (see `Inspector::mappings`).
    if found.holders.is_empty()
        && !(unmapped_before && mapped_only_here(&disks) && mapped_only_here(&disks))
    {
        return Err(Fallback::WalkIncomplete);
    }
    Ok(found)
}

#[cfg(test)]
mod tests;
