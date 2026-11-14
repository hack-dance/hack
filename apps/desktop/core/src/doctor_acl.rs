//! Read-only ACL preflight. Unknown ACL metadata is never treated as trusted.
use std::path::Path;

#[cfg(target_os = "macos")]
pub(crate) fn controlled(path: &Path) -> bool {
    use libc::{c_char, c_int, c_void};
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };
    unsafe extern "C" {
        fn acl_get_file(path: *const c_char, kind: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, selector: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
        fn acl_get_permset(entry: *mut c_void, perms: *mut *mut c_void) -> c_int;
        fn acl_get_perm_np(perms: *mut c_void, permission: c_int) -> c_int;
        fn acl_free(acl: *mut c_void) -> c_int;
    }
    fn witness(path: &Path) -> Option<([u64; 9], [u64; 9])> {
        fn key(m: std::fs::Metadata) -> [u64; 9] {
            [
                m.dev(),
                m.ino(),
                u64::from(m.mode()),
                u64::from(m.uid()),
                u64::from(m.gid()),
                m.mtime() as u64,
                m.mtime_nsec() as u64,
                m.ctime() as u64,
                m.ctime_nsec() as u64,
            ]
        }
        Some((
            key(std::fs::symlink_metadata(path).ok()?),
            key(std::fs::metadata(path).ok()?),
        ))
    }
    let Some(before) = witness(path) else {
        return false;
    };
    let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // Darwin Libc acl_file.c/filesec.c: NULL/ENOENT can mean no ACL.
    // Observe existing link and target identity before/after to distinguish
    // missing/changed paths. No read permission or descriptor open is required.
    // Same-user/root ABA changes are outside this observational boundary.
    // SAFETY: name is NUL-terminated; ACL handles stay owned by this call.
    unsafe {
        *libc::__error() = 0;
        let acl = acl_get_file(name.as_ptr(), 0x100);
        if acl.is_null() {
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
                && witness(path) == Some(before);
        }
        let mut entry = std::ptr::null_mut();
        let mut selector = 0;
        let safe = loop {
            match acl_get_entry(acl, selector, &mut entry) {
                0 => {}
                -1 if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) => {
                    break true;
                }
                _ => break false,
            }
            selector = -1;
            let mut tag = 0;
            if acl_get_tag_type(entry, &mut tag) != 0 {
                break false;
            }
            if tag == 2 {
                continue;
            }
            if tag != 1 {
                break false;
            }
            let mut perms = std::ptr::null_mut();
            if acl_get_permset(entry, &mut perms) != 0 {
                break false;
            }
            let rights = [
                1 << 2,
                1 << 4,
                1 << 5,
                1 << 6,
                1 << 8,
                1 << 10,
                1 << 12,
                1 << 13,
            ];
            if rights
                .iter()
                .any(|right| acl_get_perm_np(perms, *right) != 0)
            {
                break false;
            }
        };
        acl_free(acl);
        safe && witness(path) == Some(before)
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn controlled(path: &Path) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // Linux access ACLs are conservatively refused, including read-only ACLs.
    // SAFETY: both names are NUL-terminated; a zero-size query writes no bytes.
    let size = unsafe {
        libc::getxattr(
            path.as_ptr(),
            c"system.posix_acl_access".as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    size == 0
        || (size < 0
            && matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ENODATA | libc::ENOTSUP)
            ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn controlled(_: &Path) -> bool {
    false
}
