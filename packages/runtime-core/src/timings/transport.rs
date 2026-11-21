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
struct HostTime;
impl TimeSource for HostTime {
    fn sample(&self) -> Option<(u64, u64)> {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes exactly one live timespec and retains no pointer.
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
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
        if !(3..=255).contains(&fd) {
            return None;
        }
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
            4096
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
        Some(Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            limit,
        })
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

/// Invalid/unavailable diagnostics never change the product command's result.
/// Only a reserved leading argument is consumed; stderr remains untouched.
pub fn enable_argument(argument: &str) -> bool {
    if installed().is_some() {
        return false;
    }
    let Some(value) = argument.strip_prefix(REQUEST_PREFIX) else {
        return false;
    };
    let parts: Vec<_> = value.split(':').collect();
    if !(5..=6).contains(&parts.len()) || !valid_id(parts[1], 32) || !valid_id(parts[2], 16) {
        return false;
    }
    let (Ok(fd), Ok(spawn)) = (parts[0].parse::<i32>(), parts[3].parse::<u64>()) else {
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
    let Some(sink) = FdSink::take(fd) else {
        return false;
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
    fn datagram_keeps_the_full_approved_attribute_set_atomic() {
        let (sender, receiver) = std::os::unix::net::UnixDatagram::pair().unwrap();
        receiver
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let sink = FdSink::take(sender.into_raw_fd()).unwrap();
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
        let mut packet = [0_u8; 4096];
        let count = receiver.recv(&mut packet).unwrap();
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
        root.finish(Outcome::Ok, false, None, Attrs::default());
        let count = receiver.recv(&mut packet).unwrap();
        let root = Record::parse_line(std::str::from_utf8(&packet[..count]).unwrap()).unwrap();
        assert_eq!(root.attrs["service_index_stable"], Attr::Boolean(true));
        assert_eq!(child.parent.as_ref(), Some(&root.span));
        assert!(InputsChangedMask::new(MAX_NUMBER + 1).is_none());
    }
}
