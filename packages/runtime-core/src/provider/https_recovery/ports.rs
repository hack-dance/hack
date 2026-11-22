//! Claims of the shared HTTPS port held across HTTPS recovery effects.
use super::{CandidateError, refused};
use std::{net::IpAddr, os::fd::OwnedFd};

/// One local address a guard claims: the IP and, for IPv6, its scope id (the
/// interface index of a link-local address; 0 otherwise).
type Local = (IpAddr, u32);

/// Which kind of address a guard claims; test diagnostics name it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Address {
    Wildcard,
    Loopback,
    Interface,
}

pub(in crate::provider) fn port_absent(port: u16) -> Result<Vec<OwnedFd>, CandidateError> {
    // A Caddy that just stopped leaves its connections in TIME_WAIT (about 30 s on
    // macOS), and a bind without address reuse fails meanwhile (HACK-2550). A reuse
    // bind succeeds over TIME_WAIT. Without SO_REUSEPORT it still fails on any address
    // another socket holds exactly, but macOS lets a same-user reuse bind of the
    // wildcard succeed beside a listener on one specific address. So the reuse claim
    // also binds every local address exactly (`reuse_claim`). Any failure falls back
    // to the strict claim, which the caller retries for a bounded time.
    #[cfg(target_os = "macos")]
    if let Ok(guards) = reuse_claim(port, local_addresses) {
        return Ok(guards);
    }
    claim(port, false)
}

/// The wildcard and loopback guards, IPv4 and IPv6. `reuse` sets SO_REUSEADDR on the
/// wildcard guards; the loopback guards always set it, so they can be bound beside
/// the wildcard ones. No guard ever sets SO_REUSEPORT.
pub(super) fn claim(port: u16, reuse: bool) -> Result<Vec<OwnedFd>, CandidateError> {
    [
        (IpAddr::from([0_u8; 4]), Address::Wildcard),
        (IpAddr::from([0_u8; 16]), Address::Wildcard),
        (IpAddr::from([127, 0, 0, 1]), Address::Loopback),
        (
            IpAddr::from(std::net::Ipv6Addr::LOCALHOST),
            Address::Loopback,
        ),
    ]
    .into_iter()
    .map(|(ip, kind)| {
        bind(
            (ip, 0),
            port,
            kind,
            reuse || kind != Address::Wildcard,
            false,
        )
    })
    .collect()
}

/// The reuse claim: wildcard and loopback, then each interface address that
/// `enumerate` lists, each bound exactly with SO_REUSEADDR. A listener of another
/// process on any of them, with or without SO_REUSEADDR, makes that bind fail; so
/// does one with SO_REUSEPORT, because the guard does not set it. The addresses are
/// listed again after binding: an address that appeared or went away meanwhile, or
/// a list that cannot be read, refuses. An address the kernel will not bind now
/// (`EADDRNOTAVAIL`: an IPv6 address still tentative, duplicated or detached) is
/// skipped: no socket can bind it now, so no listener can start on it while the
/// claim is held. A listener that bound it before it became unusable is the residual.
/// The claim holds one socket per address for the archive's duration, so the number
/// of descriptors is bounded by the host's interface addresses (VPN and container
/// interfaces included), plus the four wildcard and loopback guards.
#[cfg(target_os = "macos")]
pub(super) fn reuse_claim(
    port: u16,
    mut enumerate: impl FnMut() -> Option<std::collections::BTreeSet<Local>>,
) -> Result<Vec<OwnedFd>, CandidateError> {
    let before = enumerate().ok_or_else(refused)?;
    let mut guards = claim(port, true)?;
    for &local in &before {
        match bind_errno(local, port, Address::Interface, true, false) {
            Ok(guard) => guards.push(guard),
            Err(Some(libc::EADDRNOTAVAIL)) => {}
            Err(_) => return Err(refused()),
        }
    }
    if enumerate().as_ref() != Some(&before) {
        return Err(refused());
    }
    Ok(guards)
}

/// Every IPv4 and IPv6 address of this host's interfaces (`getifaddrs`), except the
/// unspecified and the two loopback addresses `claim` binds; `None` if unreadable.
#[cfg(target_os = "macos")]
pub(super) fn local_addresses() -> Option<std::collections::BTreeSet<Local>> {
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs writes one list head into the live pointer; it is freed below.
    if unsafe { libc::getifaddrs(&raw mut list) } != 0 {
        return None;
    }
    let mut found = std::collections::BTreeSet::new();
    let mut entry = list;
    while !entry.is_null() {
        // SAFETY: entry is a node of the list getifaddrs returned, not yet freed.
        let address = unsafe { (*entry).ifa_addr };
        // SAFETY: a non-null ifa_addr points to a sockaddr of its own family's size.
        let local = match (!address.is_null()).then(|| i32::from(unsafe { (*address).sa_family })) {
            Some(libc::AF_INET) => {
                let v4 = unsafe { &*address.cast::<libc::sockaddr_in>() };
                Some((IpAddr::from(v4.sin_addr.s_addr.to_ne_bytes()), 0))
            }
            Some(libc::AF_INET6) => {
                let v6 = unsafe { &*address.cast::<libc::sockaddr_in6>() };
                let mut bytes = v6.sin6_addr.s6_addr;
                let mut scope = v6.sin6_scope_id;
                // The kernel may embed a link-local address's interface index in
                // bytes 2 and 3 (KAME); a bind takes it as the scope id instead.
                if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 && (bytes[2], bytes[3]) != (0, 0) {
                    if scope == 0 {
                        scope = u32::from(u16::from_be_bytes([bytes[2], bytes[3]]));
                    }
                    (bytes[2], bytes[3]) = (0, 0);
                }
                Some((IpAddr::from(bytes), scope))
            }
            _ => None,
        };
        if let Some((ip, scope)) = local
            && !ip.is_unspecified()
            && ip != IpAddr::from([127, 0, 0, 1])
            && ip != IpAddr::from(std::net::Ipv6Addr::LOCALHOST)
        {
            found.insert((ip, scope));
        }
        // SAFETY: as above; the next pointer is null at the end of the list.
        entry = unsafe { (*entry).ifa_next };
    }
    // SAFETY: list is the head getifaddrs returned; nothing refers to it afterwards.
    unsafe { libc::freeifaddrs(list) };
    Some(found)
}

/// One listening TCP guard on `local` and `port`: close-on-exec, IPv6-only for IPv6,
/// SO_REUSEADDR when `reuse_address`. Production never sets `reuse_port`; tests use
/// it to build the competing listeners the claim must refuse.
pub(super) fn bind(
    local: Local,
    port: u16,
    kind: Address,
    reuse_address: bool,
    reuse_port: bool,
) -> Result<OwnedFd, CandidateError> {
    bind_errno(local, port, kind, reuse_address, reuse_port).map_err(|_| refused())
}

/// [`bind`], refusing with the failed call's errno.
fn bind_errno(
    (ip, scope): Local,
    port: u16,
    kind: Address,
    reuse_address: bool,
    reuse_port: bool,
) -> Result<OwnedFd, Option<i32>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let family = if ip.is_ipv4() {
        libc::AF_INET
    } else {
        libc::AF_INET6
    };
    macro_rules! failure {
        ($stage:ident) => {{
            let errno = std::io::Error::last_os_error().raw_os_error();
            #[cfg(all(test, target_os = "macos"))]
            observation_diagnostic::record(
                observation_diagnostic::Stage::$stage,
                kind,
                family,
                errno,
            );
            let _ = kind;
            errno
        }};
    }
    // SAFETY: socket takes scalar constants; a successful new descriptor is uniquely owned below.
    let raw = unsafe { libc::socket(family, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(failure!(Socket));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: fd is owned; fcntl uses only scalar arguments and does not retain pointers.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(failure!(Cloexec));
    }
    let on: libc::c_int = 1;
    let set = |level, option| {
        // SAFETY: on points to one live integer of the declared size.
        let status = unsafe {
            libc::setsockopt(
                fd.as_raw_fd(),
                level,
                option,
                (&raw const on).cast(),
                std::mem::size_of_val(&on) as libc::socklen_t,
            )
        };
        status == 0
    };
    if family == libc::AF_INET6 && !set(libc::IPPROTO_IPV6, libc::IPV6_V6ONLY) {
        return Err(failure!(Ipv6Only));
    }
    if reuse_address && !set(libc::SOL_SOCKET, libc::SO_REUSEADDR) {
        return Err(failure!(ReuseAddress));
    }
    if reuse_port && !set(libc::SOL_SOCKET, libc::SO_REUSEPORT) {
        return Err(failure!(ReuseAddress));
    }
    // SAFETY: zeroed sockaddr structures are valid; each is filled for its own family
    // and passed with its own size.
    let bound = unsafe {
        match ip {
            IpAddr::V4(v4) => {
                let mut address: libc::sockaddr_in = std::mem::zeroed();
                address.sin_family = libc::AF_INET as _;
                address.sin_port = port.to_be();
                address.sin_addr.s_addr = u32::from_ne_bytes(v4.octets());
                #[cfg(target_os = "macos")]
                {
                    address.sin_len = std::mem::size_of_val(&address) as u8;
                }
                libc::bind(
                    fd.as_raw_fd(),
                    (&raw const address).cast(),
                    std::mem::size_of_val(&address) as libc::socklen_t,
                )
            }
            IpAddr::V6(v6) => {
                let mut address: libc::sockaddr_in6 = std::mem::zeroed();
                address.sin6_family = libc::AF_INET6 as _;
                address.sin6_port = port.to_be();
                address.sin6_addr.s6_addr = v6.octets();
                address.sin6_scope_id = scope;
                #[cfg(target_os = "macos")]
                {
                    address.sin6_len = std::mem::size_of_val(&address) as u8;
                }
                libc::bind(
                    fd.as_raw_fd(),
                    (&raw const address).cast(),
                    std::mem::size_of_val(&address) as libc::socklen_t,
                )
            }
        }
    };
    if bound != 0 {
        return Err(failure!(Bind));
    }
    // SAFETY: fd is an owned bound TCP socket; listen retains the exact address claim.
    if unsafe { libc::listen(fd.as_raw_fd(), 1) } != 0 {
        return Err(failure!(Listen));
    }
    // Retained across archival; never accepts a connection.
    Ok(fd)
}

// Test-only first-refusal facts distinguish bind contention from a failed socket
// prerequisite. No port, address, descriptor or production diagnostic is exposed.
#[cfg(all(test, target_os = "macos"))]
pub(super) mod observation_diagnostic {
    use std::cell::RefCell;

    pub(in crate::provider::https_recovery) use super::Address;
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
        pub address: Address,
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
        address: Address,
        family: i32,
        errno: Option<i32>,
    ) {
        FIRST.with(|first| {
            let mut first = first.borrow_mut();
            if first.is_none() {
                *first = Some(Facts {
                    stage,
                    address,
                    family,
                    errno,
                });
            }
        });
    }
}
