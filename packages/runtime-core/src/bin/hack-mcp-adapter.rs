//! Experimental stdio bridge to an explicitly selected local MCP backend.
//! Optional native-owner startup; no reconnection, replay or credential logging.
#[path = "mcp_artifact/mod.rs"]
mod artifact;
#[path = "mcp_adapter/startup.rs"]
mod startup;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

const FRAME_LIMIT: usize = 4096;
const CONTEXT_LIMIT: usize = 256 * 1024;

fn main() {
    if let Err(error) = run() {
        // Errors are fixed descriptions, never backend frames or environment values.
        eprintln!("hack MCP adapter: {error}");
        std::process::exit(1);
    }
}

fn error(message: &'static str) -> io::Error {
    io::Error::other(message)
}

fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if artifact::describe(&args, "adapter") {
        return Ok(());
    }
    if !matches!(args.len(), 4 | 8)
        || args[0] != "--socket"
        || args[2] != "--backend-id"
        || (args.len() == 8 && (args[4] != "--owner" || args[6] != "--backend"))
    {
        return Err(error(
            "usage: --socket PATH --backend-id ID [--owner ABSOLUTE_OWNER --backend ABSOLUTE_BACKEND]",
        ));
    }
    let backend_id = args[3]
        .to_str()
        .ok_or_else(|| error("invalid backend identity"))?;
    if backend_id.is_empty() || backend_id.len() > 256 {
        return Err(error("invalid backend identity"));
    }
    let path = Path::new(&args[1]);
    let stream = if args.len() == 8 {
        startup::connect(path, backend_id, Path::new(&args[5]), Path::new(&args[7]))?
    } else {
        verify_endpoint(path)?;
        connect_backend(path)?
    };
    verify_peer(&stream)?;
    let mut reader = BufReader::with_capacity(8192, stream);
    let deadline = Instant::now() + Duration::from_secs(5);
    let greeting: Greeting = read_frame(&mut reader, deadline)?;
    if greeting.hack_mcp != 1 || greeting.backend_id != backend_id {
        return Err(error("backend identity or protocol mismatch"));
    }
    let context = capture_context()?;
    reader
        .get_ref()
        .set_write_timeout(Some(Duration::from_secs(5)))?;
    reader
        .get_mut()
        .write_all(&context)
        .map_err(|_| error("context transfer failed"))?;
    let ready: Ready = read_frame(&mut reader, deadline)?;
    if ready.hack_mcp != 1 || !ready.ready {
        return Err(error("backend refused session context"));
    }
    reader.get_ref().set_read_timeout(None)?;
    reader.get_ref().set_write_timeout(None)?;
    relay(reader)
}

fn connect_backend(path: &Path) -> io::Result<UnixStream> {
    let path = path.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    // A full Unix accept queue can block connect before socket timeouts exist.
    // The process exits on timeout, terminating this worker and closing its fd;
    // no retry or session context transfer happens in the worker.
    std::thread::Builder::new()
        .name("mcp-connect".into())
        .stack_size(128 * 1024)
        .spawn(move || {
            let _ = sender.send(UnixStream::connect(path));
        })
        .map_err(|_| error("cannot start backend connection"))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| error("backend connection timed out"))?
        .map_err(|failure| io::Error::new(failure.kind(), "backend connection failed"))
}

fn verify_endpoint(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| error("invalid socket path"))?;
    let directory =
        fs::symlink_metadata(parent).map_err(|_| error("socket directory unavailable"))?;
    // SAFETY: geteuid has no pointer arguments or caller preconditions.
    let uid = unsafe { libc::geteuid() };
    if !directory.is_dir() || directory.uid() != uid || directory.mode() & 0o077 != 0 {
        return Err(error(
            "socket directory is not private and owned by this user",
        ));
    }
    let socket = fs::symlink_metadata(path)
        .map_err(|failure| io::Error::new(failure.kind(), "socket endpoint unavailable"))?;
    if !socket.file_type().is_socket() || socket.uid() != uid || socket.mode() & 0o077 != 0 {
        return Err(error(
            "socket endpoint is not private and owned by this user",
        ));
    }
    Ok(())
}

fn verify_peer(stream: &UnixStream) -> io::Result<()> {
    // SAFETY: geteuid has no pointer arguments or caller preconditions.
    let uid = unsafe { libc::geteuid() };
    if peer_uid(stream)? != uid {
        return Err(error("backend peer belongs to another user"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the stream owns a live connected fd; both outputs are valid writable uid/gid storage.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(error("cannot verify backend peer identity"));
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the live connected fd and correctly sized writable ucred/length storage
    // satisfy getsockopt's contract. The returned size is checked before use.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(error("cannot verify backend peer identity"));
    }
    Ok(credentials.uid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_uid(_: &UnixStream) -> io::Result<libc::uid_t> {
    Err(error("peer verification is unsupported on this host"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Greeting {
    hack_mcp: u32,
    backend_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    hack_mcp: u32,
    ready: bool,
}

fn read_frame<T: serde::de::DeserializeOwned>(
    reader: &mut BufReader<UnixStream>,
    deadline: Instant,
) -> io::Result<T> {
    let mut frame = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| error("backend handshake timed out"))?;
        reader.get_ref().set_read_timeout(Some(remaining))?;
        let available = reader
            .fill_buf()
            .map_err(|_| error("backend handshake read failed"))?;
        if available.is_empty() {
            return Err(error("backend closed during handshake"));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if frame.len() + count > FRAME_LIMIT {
            return Err(error("backend handshake frame too large"));
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return serde_json::from_slice(&frame).map_err(|_| error("invalid backend handshake"));
        }
    }
}

#[derive(Serialize)]
struct Context {
    hack_mcp: u32,
    cwd: String,
    env: BTreeMap<String, String>,
}

fn capture_context() -> io::Result<Vec<u8>> {
    let cwd = std::env::current_dir()
        .map_err(|_| error("session directory unavailable"))?
        .into_os_string()
        .into_string()
        .map_err(|_| error("session directory is not UTF-8"))?;
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        let key = key
            .into_string()
            .map_err(|_| error("session environment is not UTF-8"))?;
        let value = value
            .into_string()
            .map_err(|_| error("session environment is not UTF-8"))?;
        env.insert(key, value);
    }
    let mut bytes = serde_json::to_vec(&Context {
        hack_mcp: 1,
        cwd,
        env,
    })
    .map_err(|_| error("session context encoding failed"))?;
    if bytes.len() > CONTEXT_LIMIT {
        return Err(error("session context exceeds size limit"));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn relay(reader: BufReader<UnixStream>) -> io::Result<()> {
    reader.get_ref().set_nonblocking(true)?;
    let mut writer = SocketWriter(reader.get_ref().try_clone()?);
    let mut output = BoundedOutput::new()?;
    // Publish one terminal state so EOF and failure cannot be read from different instants.
    let input_state = Arc::new(AtomicU8::new(0));
    let state = Arc::clone(&input_state);
    std::thread::Builder::new()
        .name("mcp-stdin".into())
        .stack_size(128 * 1024)
        .spawn(move || {
            let result = copy_bounded(&mut io::stdin().lock(), &mut writer);
            state.store(if result.is_ok() { 1 } else { 2 }, Ordering::Release);
            let _ = writer.0.shutdown(if result.is_ok() {
                Shutdown::Write
            } else {
                Shutdown::Both
            });
        })
        .map_err(|_| error("stdin relay could not start"))?;
    let mut input = SocketReader(reader);
    let result = copy_bounded(&mut input, &mut output);
    let _ = input.0.get_ref().shutdown(Shutdown::Both);
    result.map_err(|_| error("backend output relay failed"))?;
    match input_state.load(Ordering::Acquire) {
        1 => Ok(()),
        2 => Err(error("stdin relay failed")),
        _ => Err(error("backend disconnected; requests were not replayed")),
    }
}

struct SocketReader(BufReader<UnixStream>);
impl Read for SocketReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.0.read(bytes) {
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    let mut fd = libc::pollfd {
                        fd: self.0.get_ref().as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    // SAFETY: fd is live; one writable pollfd is supplied. A negative timeout waits without polling CPU.
                    let result = unsafe { libc::poll(&mut fd, 1, -1) };
                    if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                    {
                        return Err(error("backend readiness check failed"));
                    }
                }
                result => return result,
            }
        }
    }
}

struct SocketWriter(UnixStream);
impl Write for SocketWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.0.write(bytes) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(|| error("backend stopped reading stdin"))?;
                    let mut fd = libc::pollfd {
                        fd: self.0.as_raw_fd(),
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    // SAFETY: fd is live; one writable pollfd is supplied for a bounded wait.
                    let result = unsafe {
                        libc::poll(
                            &mut fd,
                            1,
                            remaining.as_millis().clamp(1, 5000) as libc::c_int,
                        )
                    };
                    if result == 0 {
                        return Err(error("backend stopped reading stdin"));
                    }
                    if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                    {
                        return Err(error("backend write readiness check failed"));
                    }
                    if fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                        return Err(error("backend disconnected while stdin was blocked"));
                    }
                }
                result => return result,
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Keep stdout flags untouched: duplicated descriptors can share flags with the
/// parent. A dedicated worker may block, but the relay waits at most five seconds
/// for its acknowledgement and exits the process on failure. Only one 16 KiB
/// chunk can be outstanding. Idle workers sleep without a periodic wakeup.
struct BoundedOutput {
    chunks: mpsc::SyncSender<Vec<u8>>,
    completed: mpsc::Receiver<io::Result<usize>>,
}

impl BoundedOutput {
    fn new() -> io::Result<Self> {
        let (chunks, pending) = mpsc::sync_channel::<Vec<u8>>(1);
        let (done, completed) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("mcp-stdout".into())
            .stack_size(128 * 1024)
            .spawn(move || {
                let stdout = io::stdout();
                let mut output = stdout.lock();
                while let Ok(bytes) = pending.recv() {
                    let result = output
                        .write_all(&bytes)
                        .and_then(|()| output.flush())
                        .map(|()| bytes.len());
                    let failed = result.is_err();
                    if done.send(result).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|_| error("stdout relay could not start"))?;
        Ok(Self { chunks, completed })
    }
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let bytes = &bytes[..bytes.len().min(16 * 1024)];
        self.chunks
            .try_send(bytes.to_vec())
            .map_err(|_| error("stdout relay unavailable"))?;
        self.completed
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| error("stdout consumer stalled"))?
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn copy_bounded(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = match input.read(&mut buffer) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Ok(());
        }
        output.write_all(&buffer[..count])?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connected_peer_is_verified() {
        let (first, _second) = UnixStream::pair().unwrap();
        verify_peer(&first).unwrap();
    }
    #[test]
    fn frames_keep_following_bytes_and_reject_oversize() {
        let (first, mut second) = UnixStream::pair().unwrap();
        second
            .write_all(b"{\"hack_mcp\":1,\"ready\":true}\nnext")
            .unwrap();
        let mut reader = BufReader::new(first);
        let ready: Ready =
            read_frame(&mut reader, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(ready.ready);
        let mut suffix = [0_u8; 4];
        reader.read_exact(&mut suffix).unwrap();
        assert_eq!(&suffix, b"next");
        second.write_all(&vec![b'a'; FRAME_LIMIT + 1]).unwrap();
        assert!(read_frame::<Ready>(&mut reader, Instant::now() + Duration::from_secs(1)).is_err());
    }
    #[test]
    fn copy_preserves_binary_payload() {
        let payload = vec![255; 100_000];
        let mut output = Vec::new();
        copy_bounded(&mut payload.as_slice(), &mut output).unwrap();
        assert_eq!(output, payload);
    }
}
