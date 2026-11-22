//! MacOS wildcard and loopback claims held across HTTPS recovery effects.
use super::{CandidateError, refused};

pub(in crate::provider) fn port_absent(
    port: u16,
) -> Result<Vec<std::os::fd::OwnedFd>, CandidateError> {
    // A Caddy that just stopped leaves its connections in TIME_WAIT (about 30 s on
    // macOS), and a bind without address reuse fails meanwhile (HACK-2550). A reuse
    // bind succeeds over TIME_WAIT but not over a live wildcard or loopback listener;
    // the kernel's listener list then covers a listener on any other address. Any
    // doubt falls back to the strict claim below.
    #[cfg(target_os = "macos")]
    if let Ok(guards) = claim(port, true) {
        if listeners_are_only_ours(port) {
            return Ok(guards);
        }
    }
    claim(port, false)
}
pub(super) fn claim(port: u16, reuse: bool) -> Result<Vec<std::os::fd::OwnedFd>, CandidateError> {
    let mut guards = Vec::from(bind_pair(port, true, reuse)?);
    // macOS permits a later SO_REUSEADDR loopback bind beside a wildcard listener.
    // Reserve the actual local HTTPS path too; neither guard enables SO_REUSEPORT.
    guards.extend(bind_pair(port, false, reuse)?);
    Ok(guards)
}

/// The kernel's TCP listeners on `port` are exactly this process's four guards (the
/// IPv4 and IPv6 wildcard and loopback claims just bound), read from
/// `/usr/sbin/netstat -an -p tcp` with a clean environment and a time bound. An
/// unreadable list, an unparsable row, a missing guard or any other listener: false.
#[cfg(target_os = "macos")]
fn listeners_are_only_ours(port: u16) -> bool {
    let Ok(output) = crate::provider::process::capture(
        crate::provider::process::clean_command(std::path::Path::new("/usr/sbin/netstat"))
            .args(["-an", "-p", "tcp"]),
        std::time::Duration::from_secs(5),
    ) else {
        return false;
    };
    output.status.success()
        && std::str::from_utf8(&output.stdout)
            .ok()
            .and_then(|text| listeners(text, port))
            .is_some_and(|mut found| {
                found.sort();
                found
                    == [
                        ("tcp4", "*"),
                        ("tcp4", "127.0.0.1"),
                        ("tcp6", "*"),
                        ("tcp6", "::1"),
                    ]
            })
}

/// The `(protocol, address)` of each `LISTEN` row on `port` in macOS `netstat -an -p
/// tcp` output; `None` for output without its header or with a row that cannot be
/// parsed (every row must have six fields and a `<address>.<port>` local column).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn listeners(text: &str, port: u16) -> Option<Vec<(&str, &str)>> {
    let mut lines = text.lines();
    lines.by_ref().find(|line| line.starts_with("Proto"))?;
    let mut found = Vec::new();
    for line in lines.filter(|line| !line.trim().is_empty()) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (proto, local) = match fields.as_slice() {
            [proto, _, _, local, _, _] | [proto, _, _, local, _] => (*proto, *local),
            _ => return None,
        };
        let (address, local_port) = local.rsplit_once('.')?;
        if fields.last() != Some(&"LISTEN") || local_port != port.to_string() {
            continue;
        }
        if !proto.starts_with("tcp") {
            return None;
        }
        found.push((proto, address));
    }
    Some(found)
}
fn bind_pair(
    port: u16,
    wildcard: bool,
    reuse: bool,
) -> Result<[std::os::fd::OwnedFd; 2], CandidateError> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    macro_rules! failure {
        ($stage:ident, $family:expr) => {{
            #[cfg(all(test, target_os = "macos"))]
            observation_diagnostic::record(
                observation_diagnostic::Stage::$stage,
                wildcard,
                $family,
                std::io::Error::last_os_error().raw_os_error(),
            );
            refused()
        }};
    }
    let make = |family| {
        // SAFETY: socket takes scalar constants; a successful new descriptor is uniquely owned below.
        let fd = unsafe { libc::socket(family, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(failure!(Socket, family));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: fd is owned; fcntl uses only scalar arguments and does not retain pointers.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(failure!(Cloexec, family));
        }
        Ok(fd)
    };
    let v4 = make(libc::AF_INET)?;
    let v6 = make(libc::AF_INET6)?;
    let only: libc::c_int = 1;
    // SAFETY: only points to one live integer of the declared size. No address reuse is enabled.
    if unsafe {
        libc::setsockopt(
            v6.as_raw_fd(),
            libc::IPPROTO_IPV6,
            libc::IPV6_V6ONLY,
            (&only as *const libc::c_int).cast(),
            std::mem::size_of_val(&only) as libc::socklen_t,
        )
    } != 0
    {
        return Err(failure!(Ipv6Only, libc::AF_INET6));
    }
    if !wildcard || reuse {
        for (fd, _family) in [(&v4, libc::AF_INET), (&v6, libc::AF_INET6)] {
            // SAFETY: only is a live integer; this permits our specific loopback guard beside the wildcard guard.
            // SO_REUSEPORT is never enabled, so another listener cannot share this exact address.
            if unsafe {
                libc::setsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_REUSEADDR,
                    (&only as *const libc::c_int).cast(),
                    std::mem::size_of_val(&only) as libc::socklen_t,
                )
            } != 0
            {
                return Err(failure!(ReuseAddress, _family));
            }
        }
    }
    let mut address4: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address4.sin_family = libc::AF_INET as _;
    address4.sin_port = port.to_be();
    let mut address6: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
    address6.sin6_family = libc::AF_INET6 as _;
    address6.sin6_port = port.to_be();
    if !wildcard {
        address4.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        address6.sin6_addr.s6_addr[15] = 1;
    }
    #[cfg(target_os = "macos")]
    {
        address4.sin_len = std::mem::size_of_val(&address4) as u8;
        address6.sin6_len = std::mem::size_of_val(&address6) as u8;
    }
    // SAFETY: both zero-initialized wildcard addresses have the matching family and live sized storage.
    if unsafe {
        libc::bind(
            v4.as_raw_fd(),
            (&address4 as *const libc::sockaddr_in).cast(),
            std::mem::size_of_val(&address4) as libc::socklen_t,
        )
    } != 0
    {
        return Err(failure!(Bind, libc::AF_INET));
    }
    if unsafe {
        libc::bind(
            v6.as_raw_fd(),
            (&address6 as *const libc::sockaddr_in6).cast(),
            std::mem::size_of_val(&address6) as libc::socklen_t,
        )
    } != 0
    {
        return Err(failure!(Bind, libc::AF_INET6));
    }
    // SAFETY: both descriptors are owned bound TCP sockets; listen retains the exact address claim.
    for (fd, _family) in [(&v4, libc::AF_INET), (&v6, libc::AF_INET6)] {
        if unsafe { libc::listen(fd.as_raw_fd(), 1) } != 0 {
            return Err(failure!(Listen, _family));
        }
    }
    // Retain these listeners across archival; never accept a connection.
    Ok([v4, v6])
}

// Test-only first-refusal facts distinguish bind contention from a failed socket
// prerequisite. No port, address, descriptor or production diagnostic is exposed.
#[cfg(all(test, target_os = "macos"))]
pub(super) mod observation_diagnostic {
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(in crate::provider::https_recovery) enum Stage {
        Socket,
        Cloexec,
        Ipv6Only,
        ReuseAddress,
        Bind,
        Listen,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(in crate::provider::https_recovery) struct Facts {
        pub stage: Stage,
        pub wildcard: bool,
        pub family: i32,
        pub errno: Option<i32>,
    }
    thread_local! {
        static FIRST: RefCell<Option<Facts>> = const { RefCell::new(None) };
    }
    pub(in crate::provider::https_recovery) fn clear() {
        FIRST.with(|first| *first.borrow_mut() = None);
    }
    pub(in crate::provider::https_recovery) fn take() -> Option<Facts> {
        FIRST.with(|first| first.borrow_mut().take())
    }
    pub(in crate::provider::https_recovery) fn record(
        stage: Stage,
        wildcard: bool,
        family: i32,
        errno: Option<i32>,
    ) {
        FIRST.with(|first| {
            let mut first = first.borrow_mut();
            if first.is_none() {
                *first = Some(Facts {
                    stage,
                    wildcard,
                    family,
                    errno,
                });
            }
        });
    }
}

#[cfg(test)]
mod listener_list_tests {
    use super::listeners;

    const HEADER: &str = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n";

    fn ours() -> String {
        format!(
            "{HEADER}tcp4       0      0  127.0.0.1.8443         *.*                    LISTEN\ntcp4       0      0  *.8443                 *.*                    LISTEN\ntcp6       0      0  ::1.8443               *.*                    LISTEN\ntcp6       0      0  *.8443                 *.*                    LISTEN\n"
        )
    }

    #[test]
    fn time_wait_rows_and_other_ports_are_not_listeners() {
        let text = format!(
            "{}tcp4       0      0  127.0.0.1.8443         127.0.0.1.51234        TIME_WAIT\ntcp4       0      0  10.0.0.5.51234         17.0.0.1.8443          ESTABLISHED\ntcp4       0      0  *.9443                 *.*                    LISTEN\n",
            ours()
        );
        let mut found = listeners(&text, 8443).unwrap();
        found.sort();
        assert_eq!(
            found,
            [
                ("tcp4", "*"),
                ("tcp4", "127.0.0.1"),
                ("tcp6", "*"),
                ("tcp6", "::1")
            ]
        );
    }

    #[test]
    fn a_listener_on_a_specific_or_dual_stack_address_is_reported() {
        for extra in [
            "tcp4       0      0  192.168.1.20.8443      *.*                    LISTEN\n",
            "tcp46      0      0  *.8443                 *.*                    LISTEN\n",
        ] {
            let text = format!("{}{extra}", ours());
            let found = listeners(&text, 8443).unwrap();
            assert_eq!(found.len(), 5, "{extra}");
        }
    }

    #[test]
    fn output_without_a_header_or_with_a_torn_row_is_unreadable() {
        assert!(listeners("", 8443).is_none());
        assert!(listeners("tcp4 0 0 *.8443 *.* LISTEN\n", 8443).is_none());
        assert!(listeners(&format!("{HEADER}tcp4 0 0\n"), 8443).is_none());
        assert!(listeners(&format!("{HEADER}tcp4 0 0 nodot *.* LISTEN\n"), 8443).is_none());
    }
}
