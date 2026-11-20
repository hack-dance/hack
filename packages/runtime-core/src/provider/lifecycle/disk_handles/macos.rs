//! macOS: holds read through libproc, the interface `lsof` itself uses.
//!
//! For each process: its descriptor table (`PROC_PIDLISTFDS`, then the file status of each
//! file descriptor), its file ports (`PROC_PIDLISTFILEPORTS`) and its file-backed memory
//! regions. libproc answers for this user's processes only; another user's process answers
//! `EPERM`.
//!
//! Every list call fills what fits its buffer and reports no truncation, so a list is
//! read again into a larger buffer until the answer leaves room ([`list`]).
//!
//! The memory regions are read with a query the SDK header does not declare. [`method`]
//! tests it before every scan and leaves the scan to `lsof` when the test does not pass.
use super::{Disk, Ended, Fallback, Hold, Holder, Method};
use libc::c_int;
use std::ffi::OsString;
use std::mem::{size_of, size_of_val};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

// From `<sys/proc_info.h>`; libc 0.2 declares the calls but not these flavors.
/// `proc_pidfdinfo`: a file descriptor's status, without its name.
const PROC_PIDFDVNODEINFO: c_int = 1;
/// `proc_pidfdinfo`: a file descriptor's status and name.
const PROC_PIDFDVNODEPATHINFO: c_int = 2;
/// `proc_pidinfo`: the list of file ports.
const PROC_PIDLISTFILEPORTS: c_int = 14;
/// `proc_pidfileportinfo`: a file port's status and name.
const PROC_PIDFILEPORTVNODEPATHINFO: c_int = 2;
/// `proc_pidinfo`: the next file-backed memory region at or above an address. The kernel
/// skips every other region itself, which makes a scan some thirty times faster than with
/// the declared query for every region (`PROC_PIDREGIONPATHINFO`). Apple's own libproc
/// walks mappings with it (`proc_listpidspath`), but the SDK header does not declare it,
/// so no scan uses it untested ([`method`]).
const PROC_PIDREGIONPATHINFO2: c_int = 22;

/// Entries a descriptor, file-port or process list may reach before the scan gives up.
const LIST_LIMIT: usize = 1 << 20;
/// Memory regions of one process the scan walks before it gives up.
const REGION_LIMIT: usize = 1 << 22;

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
// and writes exactly its own size, which every read checks.
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

/// How an errno from a call about one process ends that process's inspection.
fn ended(what: &str, errno: c_int) -> Ended {
    match errno {
        libc::ESRCH => Ended::Exited,
        libc::EPERM => Ended::NotInspectable,
        _ => Ended::Unknown(format!(
            "{what}: {}",
            std::io::Error::from_raw_os_error(errno)
        )),
    }
}

/// Require one whole record: the kernel writes exactly the size it gives the record.
fn whole<T>(what: &str, bytes: usize) -> Result<(), Ended> {
    if bytes == size_of::<T>() {
        return Ok(());
    }
    Err(Ended::Unknown(format!(
        "{what}: answer of {bytes} bytes for a record of {}",
        size_of::<T>()
    )))
}

/// Read a whole kernel list into `records` and return its length. The kernel fills what
/// fits and reports no truncation, so a full buffer is never trusted: the list is read
/// again into a larger one. This also covers a list that grows while it is read.
fn list<T: Record>(
    what: &str,
    records: &mut Vec<T>,
    mut read: impl FnMut(&mut [T]) -> Result<usize, c_int>,
) -> Result<usize, Ended> {
    if records.is_empty() {
        records.push(T::empty());
    }
    loop {
        let entries = read(records.as_mut_slice()).map_err(|errno| ended(what, errno))?;
        if entries < records.len() {
            return Ok(entries);
        }
        if records.len() >= LIST_LIMIT {
            return Err(Ended::Unknown(format!(
                "{what}: more than {LIST_LIMIT} entries"
            )));
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

/// Whether this scan may read mappings in this process, tested on the exact property the
/// scan relies on.
///
/// A process that mapped a disk and closed its descriptor is the holder `lsof` finds and
/// the one the undeclared region query must find. A kernel that stopped answering the
/// query would be noticed at once, but one that answered with a slightly different meaning
/// would report no such holder and turn the proof into a false "nothing holds the disks".
/// So the test makes that very case in this process: a file of its own, one page of it
/// mapped, its descriptor closed. The query must then report that mapping with that
/// file's device and inode, both when asked for the mapping's address and through the walk
/// a scan makes. Any other answer leaves this scan to `lsof`.
pub(super) fn method() -> Method {
    let tested = Probe::map(&std::env::temp_dir())
        .ok_or(Fallback::SelfTestUnavailable)
        .and_then(|probe| probe.found_by(PROC_PIDREGIONPATHINFO2));
    match tested {
        Ok(()) => Method::InProcess,
        Err(why) => Method::Lsof(why),
    }
}

/// The self-test's own file: one page of it mapped in this process and its descriptor
/// closed. Dropping it unmaps the page and removes the file.
struct Probe {
    address: *mut libc::c_void,
    length: usize,
    file: Disk,
}

impl Probe {
    /// `None` when the file or the mapping cannot be made in `directory`.
    fn map(directory: &Path) -> Option<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        /// Removes the file unless the probe took it over.
        struct Created(Option<PathBuf>);
        impl Drop for Created {
            fn drop(&mut self) {
                if let Some(path) = &self.0 {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        // SAFETY: `sysconf` has no preconditions.
        let length = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
        let path = directory.join(format!(
            ".hack-disk-scan-probe.{}.{}",
            std::process::id(),
            SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .ok()?;
        let mut created = Created(Some(path));
        opened.set_len(u64::try_from(length).ok()?).ok()?;
        let status = opened.metadata().ok()?;
        // SAFETY: a new read-only shared mapping of one page of a live descriptor at an
        // address the kernel chooses; the file is one page long.
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
        if address == libc::MAP_FAILED {
            return None;
        }
        // From here only the mapping holds the file: the descriptor closes with `opened`.
        Some(Self {
            address,
            length,
            file: Disk {
                path: created.0.take()?,
                device: status.dev(),
                inode: status.ino(),
            },
        })
    }

    /// Require `flavor`, asked about this process, to report the probe's mapping with the
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
        let walked = Inspector::mappings(pid, disks, &mut holders);
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

/// Every process on the host, zombies included (they answer as exited). `Err` says why the
/// list could not be read.
pub(super) fn processes() -> Result<Vec<i32>, String> {
    let mut pids: Vec<c_int> = vec![0; 4096];
    let listed = list("process list", &mut pids, |pids| {
        let bytes = length(pids)?;
        // SAFETY: the buffer is `bytes` writable bytes of integers. Unlike the other calls,
        // this one returns a count of entries.
        answer(|| unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) })
    });
    match listed {
        Ok(0) => Err("process list: empty".into()),
        Ok(count) => {
            pids.truncate(count);
            // Process 0 is the kernel itself, which holds no descriptor table.
            pids.retain(|pid| *pid > 0);
            Ok(pids)
        }
        Err(Ended::Unknown(why)) => Err(why),
        Err(refused) => Err(format!("process list: {refused:?}")),
    }
}

/// Reads one process at a time, reusing its list buffers across processes.
pub(super) struct Inspector {
    descriptors: Vec<libc::proc_fdinfo>,
    ports: Vec<FilePort>,
}

impl Inspector {
    pub(super) fn new() -> Self {
        Self::sized(1024)
    }

    /// An inspector whose descriptor list starts at `entries` entries.
    fn sized(entries: usize) -> Self {
        Self {
            descriptors: vec![libc::proc_fdinfo::empty(); entries],
            ports: vec![FilePort::empty(); entries.min(64)],
        }
    }

    /// Record every hold `pid` has on `disks`.
    pub(super) fn inspect(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        self.descriptors(pid, disks, holders)?;
        self.file_ports(pid, disks, holders)?;
        Self::mappings(pid, disks, holders)
    }

    fn descriptors(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        let count = list("descriptor list", &mut self.descriptors, |table| {
            let bytes = process_info(pid, libc::PROC_PIDLISTFDS, 0, table)?;
            Ok(bytes / size_of::<libc::proc_fdinfo>())
        })?;
        for listed in &self.descriptors[..count] {
            if listed.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut open = DescriptorFile::empty();
            match descriptor_info(pid, listed.proc_fd, PROC_PIDFDVNODEINFO, &mut open) {
                Ok(bytes) => whole::<DescriptorFile>("descriptor", bytes)?,
                // Closed, or replaced by another kind of file, since it was listed
                // (`EBADF`); or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EBADF | libc::ENOENT) => continue,
                Err(errno) => return Err(ended("descriptor", errno)),
            }
            if let Some(disk) = matching(disks, &open.file.vi_stat) {
                Holder::record(holders, pid, Hold::Descriptor, disk, || {
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
        let count = list("file port list", &mut self.ports, |ports| {
            let bytes = process_info(pid, PROC_PIDLISTFILEPORTS, 0, ports)?;
            Ok(bytes / size_of::<FilePort>())
        })?;
        for listed in &self.ports[..count] {
            if listed.kind != libc::PROX_FDTYPE_VNODE as u32 {
                continue;
            }
            let mut sent = NamedDescriptorFile::empty();
            match file_port_info(pid, listed.name, PROC_PIDFILEPORTVNODEPATHINFO, &mut sent) {
                Ok(bytes) => whole::<NamedDescriptorFile>("file port", bytes)?,
                // Released since it was listed (`EINVAL`), carrying another kind of file
                // now (`ENOTSUP`), or its file was revoked (`ENOENT`). Not a hold.
                Err(libc::EINVAL | libc::ENOTSUP | libc::ENOENT) => continue,
                Err(errno) => return Err(ended("file port", errno)),
            }
            if let Some(disk) = matching(disks, &sent.file.vip_vi.vi_stat) {
                Holder::record(holders, pid, Hold::FilePort, disk, || name(&sent.file));
            }
        }
        Ok(())
    }

    /// Walk the process's file-backed memory regions upward from address zero. Each answer
    /// is the first such region at or above the cursor, and `EINVAL` means there is none.
    fn mappings(pid: i32, disks: &[Disk], holders: &mut Vec<Holder>) -> Result<(), Ended> {
        let mut cursor = 0_u64;
        let mut asked_again = false;
        for _ in 0..REGION_LIMIT {
            let mut region = Region::empty();
            let answered = process_info(
                pid,
                PROC_PIDREGIONPATHINFO2,
                cursor,
                std::slice::from_mut(&mut region),
            );
            match answered {
                Ok(bytes) => whole::<Region>("mapping", bytes)?,
                // The query also answers `EINVAL` for a region whose file is being
                // reclaimed at that instant (a forced unmount). Once reclaimed, the region
                // is no longer file-backed, so asking once more passes it: only a second
                // `EINVAL` at the same cursor is the end of the list.
                Err(libc::EINVAL) if !asked_again => {
                    asked_again = true;
                    continue;
                }
                Err(libc::EINVAL) => return Ok(()),
                Err(errno) => return Err(ended("mapping", errno)),
            }
            asked_again = false;
            if let Some(disk) = matching(disks, &region.file.vip_vi.vi_stat) {
                Holder::record(holders, pid, Hold::Mapping, disk, || name(&region.file));
            }
            cursor = match region.address.checked_add(region.size) {
                Some(next) if next > cursor => next,
                _ => return Err(Ended::Unknown("mapping: the list did not advance".into())),
            };
        }
        Err(Ended::Unknown(format!(
            "mapping: more than {REGION_LIMIT} regions"
        )))
    }
}

#[cfg(test)]
mod tests;
