//! Incremental launch transport. Only fresh internal processes change cwd, using
//! the opened private root as the Unix socket namespace. Frames and deadlines,
//! rather than descriptor closure, delimit every request and reply.
use crate::{
    Result, os,
    protocol::{self, Launch},
    refused,
    storage::Root,
    supervisor::{self, Receipt},
};
use std::{
    fs,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    process::Child,
    sync::atomic::Ordering,
    thread,
    time::Duration,
};

const SOCKET: &str = "control.sock";

/// Socket permissions alone do not distinguish a same-UID container peer.
#[cfg(target_os = "linux")]
fn verify_peer(stream: &UnixStream) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getsockopt writes at most the supplied live ucred buffer.
    let credentials = unsafe {
        let mut credentials: libc::ucred = std::mem::zeroed();
        let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
        if libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        ) != 0
            || length as usize != std::mem::size_of_val(&credentials)
        {
            return Err(refused());
        }
        credentials
    };
    // SAFETY: geteuid has no preconditions.
    if credentials.uid != unsafe { libc::geteuid() } || credentials.pid <= 1 {
        return Err(refused());
    }
    for namespace in ["pid", "user", "mnt"] {
        let own = fs::metadata(format!("/proc/self/ns/{namespace}"))?;
        let peer = fs::metadata(format!("/proc/{}/ns/{namespace}", credentials.pid))?;
        if own.dev() != peer.dev() || own.ino() != peer.ino() {
            return Err(refused());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_peer(stream: &UnixStream) -> Result<()> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: getpeereid writes two live scalar buffers; the descriptor is live.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    Ok(())
}

struct SocketOwner {
    device: u64,
    inode: u64,
}

impl Drop for SocketOwner {
    fn drop(&mut self) {
        if let Ok(metadata) = checked_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = fs::remove_file(SOCKET);
        }
    }
}

fn checked_socket() -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(SOCKET)?;
    // SAFETY: geteuid only observes this process's effective owner.
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(refused());
    }
    Ok(metadata)
}

fn bind() -> Result<(UnixListener, SocketOwner)> {
    match checked_socket() {
        Ok(_) => fs::remove_file(SOCKET)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(SOCKET)?;
    fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o600))?;
    let metadata = checked_socket()?;
    listener.set_nonblocking(true)?;
    Ok((
        listener,
        SocketOwner {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    ))
}

pub(crate) fn add(request: Launch) -> Result<()> {
    supervisor::validate_launch(&request)?;
    if request.processes.len() != 1 {
        return Err(refused());
    }
    let root = Root::open(&request.root)?;
    root.enter()?;
    let metadata = checked_socket()?;
    let mut stream = connect()?;
    let current = checked_socket()?;
    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
        return Err(refused());
    }
    protocol::write(&mut stream, &request)?;
    let receipt: serde_json::Value = protocol::read(&mut stream)?;
    if receipt["version"] != 1 || !receipt["processes"].is_array() {
        return Err(refused());
    }
    protocol::write(&mut std::io::stdout(), &receipt)?;
    if receipt["outcome"] != "ready" {
        return Err(refused());
    }
    Ok(())
}

fn connect() -> Result<UnixStream> {
    // Darwin lacks SOCK_CLOEXEC. Set both flags immediately after socket and
    // use an explicit frame/deadline; no liveness relies on descriptor closure.
    // SAFETY: socket returns a fresh owned descriptor with no retained pointer.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the new descriptor has exactly one Rust owner.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: integer descriptor flags are set on the live owned socket.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    os::nonblocking(&fd)?;
    // SAFETY: zeroed sockaddr_un is initialized below and passed at exact size.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, byte) in address.sun_path.iter_mut().zip(SOCKET.bytes()) {
        *target = byte as libc::c_char;
    }
    #[cfg(target_os = "macos")]
    {
        address.sun_len = std::mem::size_of_val(&address) as u8;
    }
    // SAFETY: address is initialized, NUL-terminated and live for the supplied size.
    if unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    } != 0
    {
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS) | Some(libc::EAGAIN)
        ) {
            return Err(error);
        }
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: one initialized descriptor record is borrowed for the bounded wait.
        if unsafe { libc::poll(&mut poll, 1, protocol::DEADLINE.as_millis() as i32) } <= 0 {
            return Err(refused());
        }
        let mut result: libc::c_int = 0;
        let mut length = std::mem::size_of_val(&result) as libc::socklen_t;
        // SAFETY: getsockopt writes one live bounded integer and length.
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut result as *mut libc::c_int).cast(),
                &mut length,
            )
        } < 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if result != 0 {
            return Err(std::io::Error::from_raw_os_error(result));
        }
    }
    Ok(UnixStream::from(fd))
}

pub(crate) fn serve(request: Launch) -> Result<()> {
    supervisor::validate_launch(&request)?;
    let root = Root::open(&request.root)?;
    let _instance_lock = root.lock_wait(".instance.lock")?;
    let launch_lock = root.lock_wait(".stop.lock")?;
    for state in root.states()? {
        if os::recorded_live(&state, false)? {
            return Err(refused());
        }
    }
    os::session()?;
    os::signals()?;
    root.enter()?;
    let (listener, _socket_owner) = bind()?;
    let mut children = Vec::new();
    let outcome = (|| {
        for process in request.processes {
            supervisor::start_guard(
                &request.root,
                &request.owner_token,
                request.log_path.as_deref(),
                process,
                &mut children,
            )?;
        }
        protocol::write(
            &mut std::io::stdout(),
            &Receipt::new(
                std::process::id(),
                "ready",
                root.states()?
                    .into_iter()
                    .filter(|s| s.owner_token == request.owner_token)
                    .collect(),
            ),
        )?;
        drop(launch_lock);
        supervisor::detach_stdio()?;
        loop {
            if os::STOP.load(Ordering::Relaxed) {
                return Err(refused());
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(true)?;
                    let mut response_started = false;
                    let added = handle_add(
                        &root,
                        &request.owner_token,
                        request.log_path.as_deref(),
                        &mut stream,
                        &mut children,
                        &mut response_started,
                    );
                    if added.is_err() && !response_started {
                        let _ = protocol::write(
                            &mut stream,
                            &Receipt::new(std::process::id(), "refused", Vec::new()),
                        );
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error),
            }
            let mut live = false;
            for child in &mut children {
                if child.try_wait()?.is_none() {
                    live = true;
                }
            }
            if !live {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if outcome.is_err() {
        supervisor::rollback(&mut children);
    }
    outcome
}

fn handle_add(
    root: &Root,
    owner: &str,
    log_path: Option<&std::path::Path>,
    stream: &mut UnixStream,
    children: &mut Vec<Child>,
    response_started: &mut bool,
) -> Result<()> {
    verify_peer(stream)?;
    let request: Launch = protocol::read(stream)?;
    supervisor::validate_launch(&request)?;
    if request.root != root.path
        || request.owner_token != owner
        || request.processes.len() != 1
        || request.log_path.as_deref() != log_path
    {
        return Err(refused());
    }
    let _stop_lock = root.lock_wait(".stop.lock")?;
    let process = request.processes.into_iter().next().ok_or_else(refused)?;
    let states = root.states()?;
    let mut live = 0;
    for state in &states {
        let present = os::recorded_live(state, false)?;
        if present {
            if state.owner_token != owner
                || matches!(state.phase.as_str(), "stopping" | "kill-pending")
                || matches!(os::observe_state(state), os::Observation::Unknown)
            {
                return Err(refused());
            }
            live += 1;
        }
        if state.name.eq_ignore_ascii_case(&process.name) && (present || state.name != process.name)
        {
            return Err(refused());
        }
    }
    // A stop that completed while add waited closes this owner's admission.
    // A later hook may start a fresh owner once its instance lock is released.
    if live == 0 || live >= 128 {
        return Err(refused());
    }
    let before = children.len();
    let started = supervisor::start_guard(&root.path, owner, log_path, process, children);
    if started.is_err() {
        supervisor::rollback(&mut children[before..]);
        return Err(refused());
    }
    let receipt = Receipt::new(
        std::process::id(),
        "ready",
        root.states()?
            .into_iter()
            .filter(|state| state.owner_token == owner)
            .collect(),
    );
    *response_started = true;
    protocol::write(stream, &receipt)
}
