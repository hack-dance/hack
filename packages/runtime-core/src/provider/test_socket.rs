use std::{
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

/// Bind a stream socket inode at `path` without ever listening on it, for fixtures that need
/// a stale (closed) socket pathname.
///
/// Do not make a stale socket by binding a `UnixListener` and dropping it: in the shared
/// parallel test process an unrelated test's pre-exec fork (`process::clean_command`) holds a
/// copy of every descriptor open at the fork until it execs, and its copy of the listener keeps
/// accepting, so a liveness check correctly reports the socket as live. A socket that never
/// listens refuses every connection, whichever process holds a copy. The descriptor is
/// close-on-exec; drop it when the fixture no longer needs it.
pub(super) fn bound_unlistened(path: &Path) -> OwnedFd {
    // SAFETY: plain socket creation; the result is checked before ownership is taken.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    assert!(fd >= 0, "socket: {}", std::io::Error::last_os_error());
    // SAFETY: `fd` is a fresh descriptor owned by nothing else.
    let socket = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: `socket` is an open descriptor owned by this function.
    assert_eq!(
        unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
        0
    );
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: `sockaddr_un` is plain old data; all-zero is a valid initial value.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    assert!(!bytes.contains(&0) && bytes.len() < address.sun_path.len());
    for (destination, byte) in address.sun_path.iter_mut().zip(bytes) {
        *destination = *byte as libc::c_char;
    }
    let length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    #[cfg(target_vendor = "apple")]
    {
        address.sun_len = length.try_into().unwrap();
    }
    // SAFETY: `address` is a valid NUL-terminated `sockaddr_un` of `length` bytes.
    let bound = unsafe {
        libc::bind(
            socket.as_raw_fd(),
            (&raw const address).cast(),
            length.try_into().unwrap(),
        )
    };
    assert_eq!(bound, 0, "bind: {}", std::io::Error::last_os_error());
    socket
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{fs::FileTypeExt, net::UnixStream};

    #[test]
    fn an_inherited_copy_of_an_unlistened_socket_still_refuses_connections() {
        let root = std::env::temp_dir().join(format!(
            "hack-test-socket-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("stale.sock");
        let socket = bound_unlistened(&path);
        // Model an unrelated fork's copy: it outlives the fixture's own descriptor.
        let copy = socket.try_clone().unwrap();
        drop(socket);
        let error = UnixStream::connect(&path).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ECONNREFUSED));
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_socket()
        );
        drop(copy);
        std::fs::remove_dir_all(root).unwrap();
    }
}
