//! Bounded one-use bytes from an inherited private pipe or local stream.
//! Delivery syntax is not sender authority. Callers validate the payload schema
//! and authorize the operation without exposing returned bytes in diagnostics.
use crate::CandidateError;
use std::{
    fs::File,
    io::Read,
    os::fd::{AsRawFd, OwnedFd},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub(crate) const MAX_RECEIVE_BYTES: usize = 256 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "private_input_refused",
        "Private descriptor input was refused.",
    )
}
/// Consumes and closes the descriptor on every outcome. Only pipes and AF_UNIX
/// stream sockets qualify; regular files, terminals and network sockets refuse.
/// Requires EOF within one anchored budget (at most five seconds) and at most
/// `maximum` bytes (1..=262144). The payload may be empty; callers own its schema.
/// The descriptor and any duplicates must be transferred by the trusted launcher:
/// nonblocking flags share an open-file description with remaining duplicates.
pub fn receive(
    fd: OwnedFd,
    budget: Duration,
    maximum: usize,
) -> Result<Zeroizing<Vec<u8>>, CandidateError> {
    if budget.is_zero()
        || budget > Duration::from_secs(5)
        || maximum == 0
        || maximum > MAX_RECEIVE_BYTES
    {
        return Err(refused());
    }
    let deadline = Instant::now() + budget;
    let mut file = File::from(fd);
    validate(&file)?;
    // Allocate once, including one overflow byte; no growth can leave an old
    // allocation containing private bytes. Zeroizing covers every error path.
    let mut bytes = Zeroizing::new(vec![0_u8; maximum + 1]);
    let mut used = 0;
    loop {
        wait(&file, deadline)?;
        match file.read(&mut bytes[used..]) {
            Ok(0) => break,
            Ok(n) => {
                used += n;
                if used > maximum {
                    return Err(refused());
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return Err(refused()),
        }
    }
    if Instant::now() >= deadline {
        return Err(refused());
    }
    bytes.truncate(used);
    Ok(bytes)
}

fn validate(file: &File) -> Result<(), CandidateError> {
    use std::os::unix::fs::FileTypeExt;
    let kind = file.metadata().map_err(|_| refused())?.file_type();
    let fd = file.as_raw_fd();
    if kind.is_socket() {
        // SAFETY: sockaddr_storage is a C integer/byte structure; zero is a valid
        // initialized representation before getsockname fills its writable bytes.
        let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
        // SAFETY: address is writable storage of the supplied length; fd stays live.
        if unsafe {
            libc::getsockname(
                fd,
                (&mut address as *mut libc::sockaddr_storage).cast(),
                &mut length,
            )
        } != 0
            || i32::from(address.ss_family) != libc::AF_UNIX
        {
            return Err(refused());
        }
        let mut socket_type: libc::c_int = 0;
        let mut type_length = std::mem::size_of_val(&socket_type) as libc::socklen_t;
        // SAFETY: socket_type is initialized writable storage with its exact
        // length. The owned descriptor remains live throughout this call.
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                (&mut socket_type as *mut libc::c_int).cast(),
                &mut type_length,
            )
        } != 0
            || type_length as usize != std::mem::size_of_val(&socket_type)
            || socket_type != libc::SOCK_STREAM
        {
            return Err(refused());
        }
    } else if !kind.is_fifo() {
        return Err(refused());
    }
    // SAFETY: these fcntl commands inspect/update only flags on this owned live fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
    {
        return Err(refused());
    }
    Ok(())
}

fn wait(file: &File, deadline: Instant) -> Result<(), CandidateError> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let mut descriptor = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one initialized pollfd remains live for this synchronous call.
        let result = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                remaining.as_millis().clamp(1, 5000) as i32,
            )
        };
        if Instant::now() >= deadline || descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0
        {
            return Err(refused());
        }
        if result > 0 && descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            return Ok(());
        }
        if result < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(refused());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::{TcpListener, TcpStream},
        os::{
            fd::FromRawFd,
            unix::net::{UnixDatagram, UnixStream},
        },
    };
    fn local(bytes: &[u8]) -> OwnedFd {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(bytes).unwrap();
        drop(writer);
        reader.into()
    }
    #[test]
    fn exact_eof_delivers_bounded_bytes_and_pipe_input() {
        assert_eq!(
            &*receive(local(b"value"), Duration::from_secs(1), 5).unwrap(),
            b"value"
        );
        assert!(
            receive(local(b""), Duration::from_secs(1), 5)
                .unwrap()
                .is_empty()
        );
        let mut raw = [-1; 2];
        // SAFETY: pipe writes exactly two descriptors into the initialized array.
        assert_eq!(unsafe { libc::pipe(raw.as_mut_ptr()) }, 0);
        // SAFETY: successful pipe returns two distinct owned descriptors, each
        // transferred exactly once and closed by its resulting RAII owner.
        let reader = unsafe { OwnedFd::from_raw_fd(raw[0]) };
        let mut writer = File::from(unsafe { OwnedFd::from_raw_fd(raw[1]) });
        writer.write_all(b"pipe").unwrap();
        drop(writer);
        assert_eq!(
            &*receive(reader, Duration::from_secs(1), 4).unwrap(),
            b"pipe"
        );
    }
    #[test]
    fn missing_eof_and_oversize_never_return_partial_input() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"value").unwrap();
        let began = Instant::now();
        assert_eq!(
            receive(reader.into(), Duration::from_millis(30), 5)
                .unwrap_err()
                .code,
            "private_input_refused"
        );
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(receive(local(b"overflow"), Duration::from_secs(1), 7).is_err());
        for (budget, limit) in [
            (Duration::ZERO, 1),
            (Duration::from_secs(6), 1),
            (Duration::from_secs(1), 0),
            (Duration::from_secs(1), MAX_RECEIVE_BYTES + 1),
        ] {
            assert!(receive(local(b"x"), budget, limit).is_err());
        }
    }
    #[test]
    fn full_explicit_budgets_require_eof() {
        for limit in [65536, MAX_RECEIVE_BYTES] {
            let (reader, mut writer) = UnixStream::pair().unwrap();
            let worker = std::thread::spawn(move || {
                writer
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let bytes = vec![b'x'; limit];
                writer.write_all(&bytes)
            });
            let received = receive(reader.into(), Duration::from_secs(2), limit);
            assert!(worker.join().unwrap().is_ok());
            let received = received.unwrap();
            assert_eq!(received.len(), limit);
            assert!(received.iter().all(|b| *b == b'x'));
        }
    }
    #[test]
    fn files_tcp_datagrams_and_terminals_refuse() {
        let file = File::open(std::env::current_exe().unwrap()).unwrap();
        assert!(receive(file.into(), Duration::from_secs(1), 16).is_err());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        assert!(receive(stream.into(), Duration::from_secs(1), 16).is_err());
        let (datagram, _peer) = UnixDatagram::pair().unwrap();
        assert!(receive(datagram.into(), Duration::from_secs(1), 16).is_err());
        let (mut master, mut slave) = (-1, -1);
        // SAFETY: openpty writes two descriptors; optional name/termios/winsize
        // pointers are null so libc chooses defaults and writes no other memory.
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        // SAFETY: each successful openpty descriptor is uniquely adopted once.
        let _master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        assert!(receive(slave, Duration::from_secs(1), 16).is_err());
    }
}
