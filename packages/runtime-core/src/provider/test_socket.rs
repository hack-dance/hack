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

/// Lowest port [`unallocated_tcp_port`] picks from. Its range ends where the kernel's
/// ephemeral range starts, and it must stay a range the kernel never assigns by itself.
#[cfg(target_os = "macos")]
const UNALLOCATED_PORT_FLOOR: u16 = 20_000;

/// Return a TCP port that no wildcard or loopback socket holds now, chosen below the
/// kernel's ephemeral range, for a fixture that records a port and later needs it free.
///
/// Do not get such a port by binding port 0 and dropping the listener. The kernel hands
/// out the same range to every other port-0 bind and outgoing connection on the host, so
/// under parallel load another socket can take the port before the fixture needs it
/// (HACK-1457: a full HTTPS recovery fixture refused its own recorded port at load ~200).
/// The kernel never assigns a port below its ephemeral range by itself, so only an
/// explicit bind of the same number can take this one.
#[cfg(target_os = "macos")]
pub(super) fn unallocated_tcp_port() -> u16 {
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
    let mut first: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&first);
    // SAFETY: the name is NUL-terminated and the output is one live, correctly sized integer.
    let read = unsafe {
        libc::sysctlbyname(
            c"net.inet.ip.portrange.first".as_ptr(),
            (&raw mut first).cast(),
            &raw mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    let ceiling = u16::try_from(first).unwrap_or(0);
    assert!(
        read == 0 && length == std::mem::size_of_val(&first) && ceiling > UNALLOCATED_PORT_FLOOR,
        "E_TEST_EPHEMERAL_RANGE_UNKNOWN"
    );
    let span = u32::from(ceiling - UNALLOCATED_PORT_FLOOR);
    // Spread parallel fixtures over the range; the bind probes below decide.
    let seed = std::process::id()
        .wrapping_mul(7919)
        .wrapping_add(crate::next_test_scratch() as u32)
        .wrapping_add(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos(),
        );
    (0..span)
        .map(|step| UNALLOCATED_PORT_FLOOR + ((seed.wrapping_add(step) % span) as u16))
        .find(|&port| {
            // Without SO_REUSEADDR a wildcard bind fails if any socket holds the port.
            TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok()
                && TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).is_ok()
                && TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
                && TcpListener::bind((Ipv6Addr::LOCALHOST, port)).is_ok()
        })
        .expect("E_TEST_NO_UNALLOCATED_PORT")
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

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unallocated_port_is_free_and_outside_the_kernel_assigned_range() {
        use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
        let mut first: libc::c_int = 0;
        let mut length = std::mem::size_of_val(&first);
        // SAFETY: NUL-terminated name; one live, correctly sized output integer.
        assert_eq!(
            unsafe {
                libc::sysctlbyname(
                    c"net.inet.ip.portrange.first".as_ptr(),
                    (&raw mut first).cast(),
                    &raw mut length,
                    std::ptr::null_mut(),
                    0,
                )
            },
            0
        );
        for _ in 0..8 {
            let port = unallocated_tcp_port();
            assert!(
                (UNALLOCATED_PORT_FLOOR..u16::try_from(first).unwrap()).contains(&port),
                "E_TEST_PORT_IN_KERNEL_RANGE"
            );
            // Free on all four addresses that a later wildcard and loopback claim needs.
            let held = [
                TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)),
                TcpListener::bind((Ipv4Addr::LOCALHOST, port)),
            ];
            assert!(held.iter().all(Result::is_ok), "E_TEST_PORT_NOT_FREE");
            drop(held);
            let held = [
                TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)),
                TcpListener::bind((Ipv6Addr::LOCALHOST, port)),
            ];
            assert!(held.iter().all(Result::is_ok), "E_TEST_PORT_NOT_FREE");
        }
    }
}
