use super::*;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// fd:trace:parent:spawn_mono_us:role; all values are explicitly handed over.
pub const REQUEST_PREFIX: &str = "--internal-timings=";
static INSTALLED: OnceLock<Arc<Collector>> = OnceLock::new();
pub(crate) fn installed() -> Option<&'static Arc<Collector>> {
    INSTALLED.get()
}
#[cfg(target_os = "macos")]
fn host_clock() -> libc::clockid_t {
    libc::CLOCK_UPTIME_RAW
}
#[cfg(not(target_os = "macos"))]
fn host_clock() -> libc::clockid_t {
    libc::CLOCK_MONOTONIC
}

// Seal before any context/type validation. Never touch the standard streams.
fn seal(fd: i32) -> bool {
    if fd < 3 {
        return false;
    }
    // SAFETY: scalar descriptor operations; no ownership is claimed here.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags >= 0 && libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) >= 0 {
            true
        } else {
            libc::close(fd);
            false
        }
    }
}

fn datagram_limit(fd: i32) -> Option<usize> {
    let mut size: libc::c_int = 0;
    let mut len = std::mem::size_of_val(&size) as libc::socklen_t;
    // SAFETY: writable scalar output with its exact size.
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&mut size as *mut libc::c_int).cast(),
            &mut len,
        )
    } != 0
    {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let mut maximum: libc::c_int = 0;
        let mut len = std::mem::size_of_val(&maximum);
        // SAFETY: constant NUL-terminated name, writable scalar output, no new value.
        if unsafe {
            libc::sysctlbyname(
                c"net.local.dgram.maxdgram".as_ptr(),
                (&mut maximum as *mut libc::c_int).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return None;
        }
        usize::try_from(size.min(maximum))
            .ok()
            .map(|n| n.min(LINE_LIMIT))
    }
    #[cfg(not(target_os = "macos"))]
    {
        usize::try_from(size)
            .ok()?
            .checked_sub(32)
            .map(|n| n.min(LINE_LIMIT))
    }
}

struct HostTime;
impl TimeSource for HostTime {
    fn sample(&self) -> Option<(u64, u64)> {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes exactly one live timespec and retains no pointer.
        if unsafe { libc::clock_gettime(host_clock(), &mut time) } != 0 {
            return None;
        }
        let mono = u64::try_from(time.tv_sec)
            .ok()?
            .checked_mul(1_000_000)?
            .checked_add(u64::try_from(time.tv_nsec).ok()? / 1000)?;
        let unix = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_micros(),
        )
        .ok()?;
        Some((unix, mono))
    }
}
struct FdSink {
    fd: OwnedFd,
    limit: usize,
}
impl FdSink {
    fn take(fd: i32) -> Option<Self> {
        if !seal(fd) {
            return None;
        }
        // SAFETY: the internal argument transfers this extra descriptor exactly once.
        // Owning it now closes it on every subsequent rejection path.
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stat is writable, fstat initializes it only on success; fd is not consumed here.
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: successful fstat initialized every field read below.
        let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
        let limit = if kind == libc::S_IFIFO {
            // SAFETY: scalar query on the explicitly handed-over descriptor.
            let size = unsafe { libc::fpathconf(fd, libc::_PC_PIPE_BUF) };
            if size < 512 {
                return None;
            }
            (size as usize).min(LINE_LIMIT)
        } else if kind == libc::S_IFSOCK {
            let mut kind: libc::c_int = 0;
            let mut len = std::mem::size_of_val(&kind) as libc::socklen_t;
            // SAFETY: both output pointers have the declared writable lengths.
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut kind as *mut libc::c_int).cast(),
                    &mut len,
                )
            } != 0
                || kind != libc::SOCK_DGRAM
            {
                return None;
            }
            datagram_limit(fd)?
        } else {
            return None;
        };
        // SAFETY: these fcntl/fpathconf operations take scalar arguments on the validated descriptor.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || descriptor_flags < 0 || flags & libc::O_ACCMODE == libc::O_RDONLY {
            return None;
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            || unsafe { libc::fcntl(fd, libc::F_SETFD, descriptor_flags | libc::FD_CLOEXEC) } < 0
        {
            return None;
        }
        // SAFETY: the internal argument transfers this exact descriptor to the collector once.
        // CLOEXEC prevents accidental inheritance; explicitly launched children get their own pipe.
        Some(Self { fd: owned, limit })
    }
}
impl Sink for FdSink {
    fn atomic_limit(&self) -> usize {
        self.limit
    }
    fn write_line(&self, line: &[u8]) -> bool {
        if line.len() > self.limit {
            return false;
        }
        // SAFETY: bytes stay live through this one nonblocking write. For a bounded pipe write or
        // one Unix datagram, the kernel accepts the complete record atomically or none.
        unsafe {
            libc::write(self.fd.as_raw_fd(), line.as_ptr().cast(), line.len())
                == line.len() as isize
        }
    }
}

/// The descriptor a reserved leading timings argument names, whether or not
/// the collector accepted it: it is the collector's, or already closed, and no
/// other part of the process may claim that number.
pub fn requested_fd(argument: &str) -> Option<i32> {
    argument
        .strip_prefix(REQUEST_PREFIX)?
        .split(':')
        .next()?
        .parse()
        .ok()
}

/// Invalid/unavailable diagnostics never change the product command's result.
/// Only a reserved leading argument is consumed; stderr remains untouched.
pub fn enable_argument(argument: &str) -> bool {
    let Some(value) = argument.strip_prefix(REQUEST_PREFIX) else {
        return false;
    };
    let parts: Vec<_> = value.split(':').collect();
    let Some(fd) = parts.first().and_then(|value| value.parse::<i32>().ok()) else {
        return false;
    };
    if !seal(fd) {
        return false;
    }
    // An already-installed sink may own this same number: do not claim it twice.
    if installed().is_some() {
        return false;
    }
    let Some(sink) = FdSink::take(fd) else {
        return false;
    };
    if !(5..=6).contains(&parts.len()) || !valid_id(parts[1], 32) || !valid_id(parts[2], 16) {
        return false;
    }
    let Ok(spawn) = parts[3].parse::<u64>() else {
        return false;
    };
    let role = match parts[4] {
        "cli" => Role::Cli,
        "runtime" => Role::Runtime,
        "owner" => Role::Owner,
        "guest" => Role::Guest,
        _ => return false,
    };
    let service_index_stable = match parts.get(5).copied() {
        None | Some("positions") => false,
        Some("slots") => true,
        _ => return false,
    };
    let config = Config {
        trace: parts[1].into(),
        parent: Some(parts[2].into()),
        role,
        clock: if role == Role::Guest {
            Clock::Guest
        } else {
            Clock::Host
        },
        spawn_mono_us: Some(spawn),
        service_index_stable,
    };
    let Some(collector) = Collector::new(config, Arc::new(HostTime), Arc::new(sink)) else {
        return false;
    };
    INSTALLED.set(collector).is_ok()
}
pub fn shutdown() {
    if let Some(collector) = installed() {
        collector.shutdown(None);
    }
}
/// Preserve the existing exit code while flushing known dispatch and incomplete work.
pub fn exit(code: i32) -> ! {
    if let Some(collector) = installed() {
        collector.shutdown(Some(code));
    }
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::IntoRawFd;
    #[test]
    fn rejected_context_and_descriptor_types_close_the_transferred_fd() {
        // Other libtest threads can reuse a closed descriptor before F_GETFD.
        crate::provider::run_isolated(
            "timings::transport::tests::rejected_descriptor_child",
            crate::provider::ISOLATED_HANG_GUARD,
        );
    }

    #[test]
    #[ignore = "isolated child launched by rejected_context_and_descriptor_types_close_the_transferred_fd"]
    fn rejected_descriptor_child() {
        let (sender, _receiver) = std::os::unix::net::UnixDatagram::pair().unwrap();
        let fd = sender.into_raw_fd();
        // SAFETY: scalar operation on this test's owned descriptor.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, 0) }, 0);
        assert!(!enable_argument(&format!("{REQUEST_PREFIX}{fd}:invalid")));
        // SAFETY: read-only query; rejection must have closed our transferred descriptor.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        let (stream, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = stream.into_raw_fd();
        assert!(FdSink::take(fd).is_none());
        // SAFETY: read-only query of the rejected descriptor.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        assert!(!seal(2));
    }
    #[test]
    fn datagram_keeps_the_full_approved_attribute_set_atomic() {
        let (sender, receiver) = std::os::unix::net::UnixDatagram::pair().unwrap();
        receiver
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let requested: libc::c_int = 256 * 1024;
        // SAFETY: the option points to a live scalar of the declared size on our socket.
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    receiver.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_RCVBUF,
                    (&requested as *const libc::c_int).cast(),
                    std::mem::size_of_val(&requested) as libc::socklen_t,
                )
            },
            0
        );
        let mut actual: libc::c_int = 0;
        let mut len = std::mem::size_of_val(&actual) as libc::socklen_t;
        // SAFETY: writable scalar output of the declared size on our socket.
        assert_eq!(
            unsafe {
                libc::getsockopt(
                    receiver.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_RCVBUF,
                    (&mut actual as *mut libc::c_int).cast(),
                    &mut len,
                )
            },
            0
        );
        assert!(actual >= 64 * 1024);
        let expected_limit = datagram_limit(sender.as_raw_fd()).unwrap();
        let sink = FdSink::take(sender.into_raw_fd()).unwrap();
        assert_eq!(sink.atomic_limit(), expected_limit);
        let (send, receive) = std::sync::mpsc::channel();
        // Drain throughout production, not after child exit. ACKs bound scheduler pressure.
        let drain = std::thread::spawn(move || {
            for _ in 0..257 {
                let mut packet = [0_u8; LINE_LIMIT];
                let count = receiver.recv(&mut packet).unwrap();
                send.send(packet[..count].to_vec()).unwrap();
            }
        });
        let collector = Collector::new(
            Config {
                trace: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
                parent: None,
                role: Role::Owner,
                clock: Clock::Host,
                spawn_mono_us: None,
                service_index_stable: true,
            },
            Arc::new(HostTime),
            Arc::new(sink),
        )
        .unwrap();
        let root = collector.start(Step::RuntimeDispatch, None).unwrap();
        for _ in 0..256 {
            collector
                .start(Step::StartDecide, root.parent())
                .unwrap()
                .finish(
                    Outcome::Ok,
                    false,
                    None,
                    Attrs {
                        service_index: Some(3),
                        wave: Some(2),
                        services: Some(4),
                        syncs: Some(1),
                        waited_on_index: Some(0),
                        waited_on_cap: Some(true),
                        generation: Some(7),
                        reason_spec: Some(true),
                        reason_unhealthy: Some(true),
                        reason_exited: Some(true),
                        reason_dead: Some(true),
                        reason_missing: Some(true),
                        reason_forced: Some(true),
                        reason_migrated: Some(true),
                        reason_managed_env: Some(true),
                        changed_image: Some(true),
                        changed_command: Some(true),
                        changed_env: Some(true),
                        changed_managed_env: Some(true),
                        changed_mounts: Some(true),
                        changed_networks: Some(true),
                        changed_limits: Some(true),
                        changed_healthcheck: Some(true),
                        changed_probe: Some(true),
                        changed_ports: Some(true),
                        changed_labels: Some(true),
                        changed_platform: Some(true),
                        changed_other: Some(true),
                        miss_reason: Some(MissReason::InputsChanged),
                        inputs_changed_mask: InputsChangedMask::new(MAX_NUMBER),
                        ..Attrs::default()
                    },
                );
            let packet = receive
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            let count = packet.len();
            assert!(count > 512);
            assert_eq!(packet[count - 1], b'\n');
            let child = Record::parse_line(std::str::from_utf8(&packet[..count]).unwrap()).unwrap();
            assert_eq!(child.cached, None);
            assert_eq!(child.attrs["changed_managed_env"], Attr::Boolean(true));
            assert_eq!(child.attrs["miss_reason"], Attr::Number(2.into()));
            assert_eq!(
                child.attrs["inputs_changed_mask"],
                Attr::Number(MAX_NUMBER.into())
            );
            assert_eq!(
                child.parent.as_ref(),
                root.parent().as_ref().map(|p| &p.span)
            );
        }
        root.finish(Outcome::Ok, false, None, Attrs::default());
        let packet = receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let count = packet.len();
        let root = Record::parse_line(std::str::from_utf8(&packet[..count]).unwrap()).unwrap();
        assert_eq!(root.attrs["service_index_stable"], Attr::Boolean(true));
        drain.join().unwrap();
        assert!(InputsChangedMask::new(MAX_NUMBER + 1).is_none());
    }
}
