use super::super::tests::{Scratch, sparse_disks};
use super::*;

fn mapped(major: u32, minor: u32, inode: u64, name: &str) -> Mapped<'_> {
    Mapped {
        major,
        minor,
        inode,
        name: name.as_bytes(),
    }
}

/// Lines of `/proc/<pid>/maps` are read by their fixed leading fields; the name is the
/// rest of the line, spaces included.
#[test]
fn a_maps_line_is_read_by_its_fields() {
    let lines: [(&str, Mapped<'_>); 5] = [
        (
            "7f1c2a400000-7f1c2a600000 r--s 00000000 fd:01 5505034                    /pool/storage.raw",
            mapped(0xfd, 1, 5_505_034, "/pool/storage.raw"),
        ),
        (
            "55d0c8a00000-55d0c8a21000 rw-p 00000000 00:00 0                          [heap]",
            mapped(0, 0, 0, "[heap]"),
        ),
        (
            "7f1c2a800000-7f1c2a900000 rw-p 00000000 00:00 0 ",
            mapped(0, 0, 0, ""),
        ),
        (
            "7f1c2a800000-7f1c2a900000 rw-p 00000000 00:00 0",
            mapped(0, 0, 0, ""),
        ),
        (
            "7f1c2aa00000-7f1c2ab00000 r--s 00001000 103:02 77 /a dir/disk two.raw (deleted)",
            mapped(0x103, 2, 77, "/a dir/disk two.raw (deleted)"),
        ),
    ];
    for (line, expected) in lines {
        assert_eq!(Mapped::parse(line.as_bytes()), Some(expected), "{line}");
    }
}

/// A line that is not in the format is not skipped: the caller reports it as unknown.
#[test]
fn an_unreadable_maps_line_is_refused() {
    for line in [
        "",
        "7f1c2a400000-7f1c2a600000 r--s",
        "7f1c2a400000-7f1c2a600000 r--s 00000000 fd01 5505034 /pool/storage.raw",
        "7f1c2a400000-7f1c2a600000 r--s 00000000 fd:zz 5505034 /pool/storage.raw",
        "7f1c2a400000-7f1c2a600000 r--s 00000000 fd:01 inode /pool/storage.raw",
    ] {
        assert_eq!(Mapped::parse(line.as_bytes()), None, "{line}");
    }
}

/// Each error ends a process's inspection as the module header says: only an exited
/// process and one this user may not inspect are "not holding".
#[test]
fn an_error_ends_a_process_as_documented() {
    let error = io::Error::from_raw_os_error;
    for errno in [libc::ENOENT, libc::ESRCH] {
        assert_eq!(ended("descriptor list", &error(errno)), Ended::Exited);
    }
    for errno in [libc::EACCES, libc::EPERM] {
        assert_eq!(
            ended("descriptor list", &error(errno)),
            Ended::NotInspectable
        );
    }
    for errno in [libc::EIO, libc::ENOMEM, libc::EMFILE] {
        assert!(matches!(
            ended("descriptor list", &error(errno)),
            Ended::Unknown(_)
        ));
    }
}

/// A mapping on the disk's own device with its inode number is the disk. With the same
/// inode number on another device, the mapped name decides: the disk's own name is the
/// disk, another file is not, and a name that cannot be read is unknown.
#[test]
fn a_mapping_with_a_disks_inode_number_is_settled_by_device_or_name() {
    let directory = Scratch::new();
    let disks = sparse_disks(directory.path());
    let disk = Disk::identify(&disks[0]).unwrap();
    let pid = i32::try_from(std::process::id()).unwrap();
    let device = disk.device as libc::dev_t;
    let (major, minor) = (libc::major(device), libc::minor(device));
    let name = |path: &std::path::Path| path.to_str().unwrap().to_owned();

    let same_device = mapped(major, minor, disk.inode, "");
    assert_eq!(maps_disk(pid, &same_device, &disk), Ok(true));

    let (own_name, other_name) = (name(&disks[0]), name(&disks[1]));
    let by_own_name = mapped(major, minor + 1, disk.inode, &own_name);
    assert_eq!(maps_disk(pid, &by_own_name, &disk), Ok(true));
    let by_other_name = mapped(major, minor + 1, disk.inode, &other_name);
    assert_eq!(maps_disk(pid, &by_other_name, &disk), Ok(false));

    let gone = format!("{own_name} (deleted)");
    let unreadable = mapped(major, minor + 1, disk.inode, &gone);
    assert!(matches!(
        maps_disk(pid, &unreadable, &disk),
        Err(Ended::Unknown(_))
    ));
}

/// Another user's process answers `EACCES`: it is not inspected and not counted as a
/// holder, the answer `lsof` gave when this user ran it.
#[test]
fn another_users_process_is_not_inspected() {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: `geteuid` has no preconditions.
    let user = unsafe { libc::geteuid() };
    let init_owner = std::fs::metadata("/proc/1").map(|init| init.uid());
    if user == 0 || init_owner.as_ref().ok() == Some(&user) {
        eprintln!("skipping: this user may inspect process 1");
        return;
    }
    let directory = Scratch::new();
    let disks: Vec<Disk> = sparse_disks(directory.path())
        .iter()
        .map(|disk| Disk::identify(disk).unwrap())
        .collect();
    let mut holders = Vec::new();
    assert_eq!(
        Inspector::new().inspect(1, &disks, &mut holders),
        Err(Ended::NotInspectable)
    );
    assert!(holders.is_empty());
}
