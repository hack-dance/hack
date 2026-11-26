//! Explicit foreground authority bound to the candidate pool's lifetime.
use super::super::{lifecycle, state, status};
use crate::{Candidate, CandidateError};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
fn socket(owner: &state::Owner) -> PathBuf {
    PathBuf::from(format!(
        "/private/tmp/hka-{}-{}/route.sock",
        unsafe { libc::geteuid() },
        owner.token
    ))
}
pub fn inspect(c: &Candidate) -> Result<serde_json::Value, CandidateError> {
    let owner = state::Owner::load(c)?;
    let path = socket(&owner);
    let state = if path
        .parent()
        .is_some_and(|p| !p.exists() && !p.is_symlink())
    {
        serde_json::json!({"present":false})
    } else {
        super::ownership::inspect(c, &path)?
    };
    Ok(serde_json::json!({"socket":path,"authority":state,"automatic_start":false}))
}
pub fn serve(c: &Candidate) -> Result<(), CandidateError> {
    serve_with_certificate_limit(c, None, None)
}
/// `caddy_admin` names the admin socket of the Caddy that routes through this
/// authority; that Caddy is asked to stop when serving ends (HACK-2720).
pub fn serve_with_certificate_limit(
    c: &Candidate,
    limit: Option<usize>,
    caddy_admin: Option<&Path>,
) -> Result<(), CandidateError> {
    if let Some(admin) = caddy_admin {
        super::caddy_admin_path(admin)?;
    }
    serve_with_startup_wait(
        c,
        limit,
        lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
        &owner_present,
        caddy_admin,
    )
}

fn owner_gone() -> CandidateError {
    CandidateError::new(
        "provider_acquisition_cancelled",
        "The hostname authority's owner exited while startup waited for the provider lease; nothing was admitted.",
    )
}

/// The managed authority's owner keeps the write end of its stdin FIFO for the
/// authority's whole lifetime (see `serve_locked`), so end of file means the
/// owner is gone (it exited, was killed, or closed its end): a startup that still
/// waits for the lease stops waiting, and a serving authority stops serving
/// (`serve_clients`, HACK-2720). Only a FIFO is that channel: any
/// other stdin is left for `serve_locked` to refuse after acquisition, exactly as
/// before. Payload is never a command and is discarded, as `serve_locked` does.
fn owner_present() -> Result<(), CandidateError> {
    owner_pipe_open(0)
}

/// One non-blocking `read` tells the three cases apart on every FIFO: 0 is end
/// of file (no writer left), `EAGAIN` is a live writer with nothing to say, and
/// bytes are payload from a live writer. `poll` cannot be used for this: on a
/// named FIFO Darwin's `poll` reports neither `POLLIN` nor `POLLHUP` after the
/// last writer closes (it returns 0 with `revents` 0), so a killed owner went
/// unnoticed and the authority waited out its whole lease wait, then served an
/// orphaned socket. Production stdin is exactly such a named FIFO
/// (`spawnNativeHttpsChild` opens it with `exec ... < "$fifo"`). `getppid` was not
/// chosen: it misses an owner that closes its end without exiting, and depends on
/// the shell exec'ing the runtime; `kqueue` is Darwin-only.
///
/// The open file description is this process's own (the shell opened it and
/// exec'd), so setting `O_NONBLOCK` for the one read affects no other reader. The
/// previous flags are restored before returning, so the descriptor keeps the
/// mode it was opened with.
pub(super) fn owner_pipe_open(fd: libc::c_int) -> Result<(), CandidateError> {
    let mut input = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, input.as_mut_ptr()) } != 0 {
        return Ok(());
    }
    let input = unsafe { input.assume_init() };
    if input.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Ok(());
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Ok(());
    }
    if flags & libc::O_NONBLOCK == 0
        && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Ok(());
    }
    let mut bytes = [0u8; 64];
    let read = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
    if flags & libc::O_NONBLOCK == 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
    }
    // Only end of file is the owner's exit. `EAGAIN` is a live writer; any
    // other error (such as `EINTR`) proves nothing, and the next attempt checks
    // again.
    if read == 0 { Err(owner_gone()) } else { Ok(()) }
}

fn serve_with_startup_wait(
    c: &Candidate,
    limit: Option<usize>,
    wait: Duration,
    owner: &dyn Fn() -> Result<(), CandidateError>,
    caddy_admin: Option<&Path>,
) -> Result<(), CandidateError> {
    // Graph inspection, commands and a graph stop also hold this lease. Wait before
    // admission (checking that the owner is still there before every attempt), then
    // reload the current pool identity; neither socket publication nor serving is
    // replayed.
    let root = c.state_root.join("run/smolvm");
    let lock = state::wait_for_acquisition(
        Instant::now() + wait,
        owner,
        || state::Lock::acquire(&root),
        state::acquisition_expired,
    )?;
    owner()?;
    let current = status(c)?;
    if current.phase != "running" || current.process_alive != Some(true) {
        return Err(super::error());
    }
    let owner = state::Owner::load(c)?;
    let path = socket(&owner);
    state::private_directory(path.parent().ok_or_else(super::error)?)?;
    let budget = limit
        .map(|limit| {
            super::certificates::Budget::open(&super::certificates::root(c), &owner.token, limit)
        })
        .transpose()?;
    super::serve_locked(c, &path, Some(lock), budget, 0, caddy_admin)
}
/// Caller holds the provider operation lock, fencing concurrent managed startup.
pub(crate) fn stop(c: &Candidate, owner: &state::Owner) -> Result<(), CandidateError> {
    let path = socket(owner);
    let parent = path.parent().ok_or_else(super::error)?;
    if !parent.exists() && !parent.is_symlink() {
        return Ok(());
    }
    let inspection = super::ownership::inspect(c, &path)?;
    if inspection["present"] == false {
        return Ok(());
    }
    let hash = inspection["sha256"].as_str().ok_or_else(super::error)?;
    super::ownership::stop(c, &path, hash)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "hkl-authority-admission-{}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    crate::next_test_scratch()
                ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn candidate(&self) -> Candidate {
            Candidate::discover(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn authority_startup_waits_for_inspection_before_reading_pool_state() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let held = state::Lock::acquire(&root).unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let start = Instant::now();
        // The production bound: the release above ends the wait, so a busy host
        // that runs the releasing thread late cannot turn this into a timeout
        // (HACK-2743).
        let result = serve_with_startup_wait(
            &candidate,
            None,
            lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
            &|| Ok(()),
            None,
        );
        worker.join().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100));
        // The exact production path gets past contention and rejects the unprepared
        // pool. It must not publish an authority just because the lock became free.
        assert!(matches!(result, Err(e) if e.code == "hostname_authority"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(!root.join("owner.json").exists());
        assert!(
            !candidate
                .state_root
                .join("run/certificate-admission")
                .exists()
        );
        assert!(state::Lock::acquire(&root).is_ok());
    }

    #[test]
    fn authority_startup_contention_deadline_admits_no_pool_or_socket_effect() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let _held = state::Lock::acquire(&root).unwrap();
        let start = Instant::now();
        let result = serve_with_startup_wait(
            &candidate,
            None,
            Duration::from_millis(100),
            &|| Ok(()),
            None,
        );
        assert!(start.elapsed() >= Duration::from_millis(75));
        assert!(
            matches!(result, Err(e) if e.code == "provider_busy" && e.message.contains("no operation was admitted"))
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(!root.join("owner.json").exists());
        assert!(
            !candidate
                .state_root
                .join("run/certificate-admission")
                .exists()
        );
        assert!(matches!(state::Lock::acquire(&root), Err(e) if e.code == "provider_busy"));
    }

    /// HACK-2707: a `hack down` of the run whose ready line started the authority
    /// holds the lease for its whole graph stop, longer than the ordinary startup
    /// wait. The authority's production wait outlasts such a holder, then reloads
    /// the pool exactly as before (an unprepared pool still refuses, unpublished).
    #[test]
    fn authority_startup_outlasts_a_holder_longer_than_the_ordinary_startup_wait() {
        assert!(lifecycle::AUTHORITY_STARTUP_LEASE_WAIT >= Duration::from_secs(30));
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let held = state::Lock::acquire(&root).unwrap();
        let hold = lifecycle::STARTUP_LEASE_WAIT + Duration::from_millis(500);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(hold);
            drop(held);
        });
        let start = Instant::now();
        let result = serve_with_startup_wait(
            &candidate,
            None,
            lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
            &|| Ok(()),
            None,
        );
        worker.join().unwrap();
        assert!(start.elapsed() >= hold);
        assert!(
            matches!(&result, Err(e) if e.code == "hostname_authority"),
            "{result:?}"
        );
        assert!(!root.join("owner.json").exists());
        assert!(state::Lock::acquire(&root).is_ok());
    }

    /// The longer wait is not a longer hang: once the owner is gone (its stdin
    /// pipe closed), a startup still waiting stops before its next attempt.
    #[test]
    fn authority_startup_wait_ends_once_its_owner_is_gone() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let _held = state::Lock::acquire(&root).unwrap();
        let checks = std::cell::Cell::new(0u32);
        let start = Instant::now();
        let result = serve_with_startup_wait(
            &candidate,
            None,
            lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
            &|| {
                checks.set(checks.get() + 1);
                if checks.get() >= 3 {
                    Err(owner_gone())
                } else {
                    Ok(())
                }
            },
            None,
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(
            matches!(&result, Err(e) if e.code == "provider_acquisition_cancelled"),
            "{result:?}"
        );
        assert_eq!(checks.get(), 3);
        assert!(!root.join("owner.json").exists());
        assert!(
            !candidate
                .state_root
                .join("run/certificate-admission")
                .exists()
        );
    }

    /// The production check reads only the owner pipe: a closed pipe is the
    /// owner's exit, an open one is a live owner (stray payload is discarded).
    #[test]
    fn owner_pipe_end_of_file_is_the_owners_exit() {
        use std::{io::Write, os::fd::AsRawFd};
        // Close-on-exec ends (see `owner_fifo`): a process another test spawns
        // must not keep the writer open past the close below.
        let (reader, mut writer) = std::io::pipe().unwrap();
        let idle = owner_pipe_open(reader.as_raw_fd());
        writer.write_all(b"x").unwrap();
        let payload = owner_pipe_open(reader.as_raw_fd());
        drop(writer);
        let closed = owner_pipe_open(reader.as_raw_fd());
        drop(reader);
        assert!(idle.is_ok());
        assert!(payload.is_ok());
        assert!(matches!(closed, Err(e) if e.code == "provider_acquisition_cancelled"));
    }

    /// A named FIFO opened the way `spawnNativeHttpsChild` opens the
    /// authority's stdin: a reader exists before the writer opens, and the
    /// authority's end is a blocking read end. Returns (reader, writer).
    ///
    /// Both ends are close-on-exec, opened that way atomically (HACK-2743).
    /// Other tests in this process spawn children all the time (the HTTP probe
    /// helpers live for seconds), and a child spawned while an inheritable
    /// writer was open kept the FIFO's write side open after the test closed
    /// its own: end of file never came, and the loop rightly kept serving.
    /// Production avoids the same leak by opening the owner's writer only
    /// after spawning the authority (`spawnNativeHttpsChild`).
    fn owner_fifo(fixture: &Fixture) -> (libc::c_int, libc::c_int) {
        let path = fixture.0.join("owner-stdin");
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let reader = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        assert!(reader >= 0);
        let writer = unsafe { libc::open(name.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
        assert!(writer >= 0);
        for fd in [reader, writer] {
            let descriptor = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(descriptor >= 0 && descriptor & libc::FD_CLOEXEC != 0);
        }
        let flags = unsafe { libc::fcntl(reader, libc::F_GETFL) };
        assert_eq!(
            unsafe { libc::fcntl(reader, libc::F_SETFL, flags & !libc::O_NONBLOCK) },
            0
        );
        (reader, writer)
    }

    /// Production stdin is a named FIFO, not an anonymous pipe. On Darwin `poll`
    /// reports nothing on a named FIFO whose writer has closed (`revents` 0), so
    /// the old `poll`-based check never saw a killed owner (#1260 review, M1).
    /// The check must see end of file there too, leave a blocking descriptor
    /// blocking for `serve_locked`, and treat a live writer as present.
    #[test]
    fn owner_fifo_end_of_file_is_the_owners_exit() {
        let fixture = Fixture::new();
        let (reader, writer) = owner_fifo(&fixture);
        let blocking = unsafe { libc::fcntl(reader, libc::F_GETFL) };
        assert!(owner_pipe_open(reader).is_ok(), "a live writer is present");
        assert_eq!(unsafe { libc::fcntl(reader, libc::F_GETFL) }, blocking);
        assert_eq!(unsafe { libc::write(writer, b"x".as_ptr().cast(), 1) }, 1);
        assert!(owner_pipe_open(reader).is_ok(), "payload is discarded");
        unsafe { libc::close(writer) };
        let closed = owner_pipe_open(reader);
        assert_eq!(unsafe { libc::fcntl(reader, libc::F_GETFL) }, blocking);
        unsafe { libc::close(reader) };
        assert!(
            matches!(&closed, Err(e) if e.code == "provider_acquisition_cancelled"),
            "{closed:?}"
        );
    }

    /// The whole startup wait, with the production owner check reading a real
    /// named FIFO whose writer goes away while the lease is held: the wait ends
    /// at once instead of running to its 30 s bound and then serving.
    #[test]
    fn authority_startup_wait_ends_when_the_owner_fifo_closes() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let _held = state::Lock::acquire(&root).unwrap();
        let (reader, writer) = owner_fifo(&fixture);
        let closer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            unsafe { libc::close(writer) };
        });
        let start = Instant::now();
        let result = serve_with_startup_wait(
            &candidate,
            None,
            lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
            &|| owner_pipe_open(reader),
            None,
        );
        closer.join().unwrap();
        unsafe { libc::close(reader) };
        assert!(start.elapsed() >= Duration::from_millis(100));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(&result, Err(e) if e.code == "provider_acquisition_cancelled"),
            "{result:?}"
        );
        assert!(!root.join("owner.json").exists());
    }

    /// A private directory short enough for a Unix socket path on macOS and
    /// Linux (the fixture's temporary directory is not, on macOS).
    struct SocketDirectory(PathBuf);
    impl SocketDirectory {
        fn new(tag: &str) -> Self {
            let path = fs::canonicalize("/tmp").unwrap().join(format!(
                "hka-{tag}-{}-{}",
                std::process::id(),
                crate::next_test_scratch()
            ));
            state::private_directory(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for SocketDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A stand-in for the owner's Caddy admin socket: returns the one request it
    /// receives (empty if none arrives) and answers as Caddy does before it exits.
    fn caddy_admin(directory: &SocketDirectory) -> (PathBuf, std::thread::JoinHandle<Vec<u8>>) {
        caddy_admin_in(&directory.0)
    }
    fn caddy_admin_in(directory: &Path) -> (PathBuf, std::thread::JoinHandle<Vec<u8>>) {
        use std::io::{Read, Write};
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("admin.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Darwin refuses these on a stream whose peer has
                        // already closed; its bytes are still readable.
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut request = Vec::new();
                        let mut bytes = [0u8; 256];
                        while !request.ends_with(b"\r\n\r\n") {
                            match stream.read(&mut bytes) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => request.extend_from_slice(&bytes[..n]),
                            }
                        }
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        return request;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
            Vec::new()
        });
        (path, handle)
    }

    /// HACK-2720: a serving authority with no clients notices that its owner is
    /// gone. The owner pipe is a real named FIFO opened as production opens it.
    /// While the writer stays open the authority keeps serving (no false exit
    /// past one owner-check interval); once the writer closes (the owner was
    /// killed) the loop ends within the bound, asks its Caddy to stop through the
    /// admin socket, and removes its socket and receipt, as a cooperative stop
    /// does. Before the fix the loop waited in `poll` with no timeout and Darwin
    /// never reported the closed FIFO, so it served forever.
    // `serve_locked` records the authority's receipt with its own process
    // identity, which only macOS can observe (`identity::observe`; the managed
    // authority runs only beside the macOS VM). The serving loop itself is
    // checked on every host by the `serving_loop_*` tests below.
    #[cfg(target_os = "macos")]
    #[test]
    fn serving_authority_exits_soon_after_its_owner_fifo_closes() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let sockets = SocketDirectory::new("serve");
        let socket = sockets.0.join("route.sock");
        let receipt = sockets.0.join("route.sock.identity");
        let session = SocketDirectory::new("caddy");
        let (admin, caddy) = caddy_admin(&session);
        let (reader, writer) = owner_fifo(&fixture);
        let (done, ended) = std::sync::mpsc::channel();
        let (served, admin_path) = (socket.clone(), admin.clone());
        // On its own thread, so a loop that never notices fails this test
        // instead of hanging it.
        std::thread::spawn(move || {
            let result = super::super::serve_locked(
                &candidate,
                &served,
                None,
                None,
                reader,
                Some(admin_path.as_path()),
            );
            let _ = done.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "the authority never served");
            std::thread::sleep(Duration::from_millis(10));
        }
        // A healthy owner holds the pipe longer than one check interval.
        let interval = Duration::from_millis(super::super::OWNER_CHECK_MS as u64);
        std::thread::sleep(interval + interval / 2);
        assert!(
            socket.exists() && ended.try_recv().is_err(),
            "the authority stopped while its owner held the pipe"
        );
        let closed = Instant::now();
        unsafe { libc::close(writer) };
        let result = ended
            .recv_timeout(2 * interval)
            .expect("the authority kept serving after its owner's pipe closed");
        let after = closed.elapsed();
        unsafe { libc::close(reader) };
        let request = caddy.join().unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert!(after < 2 * interval, "noticed after {after:?}");
        assert!(
            request.starts_with(b"POST /stop HTTP/1.1\r\n"),
            "{:?}",
            String::from_utf8_lossy(&request)
        );
        assert!(!socket.exists() && !receipt.exists());
    }

    /// Caddy is asked to stop only through a private admin socket: one in a
    /// directory other users can enter is left alone.
    #[test]
    fn caddy_is_stopped_only_through_a_private_admin_socket() {
        use std::os::unix::fs::PermissionsExt;
        let session = SocketDirectory::new("open");
        let (admin, caddy) = caddy_admin(&session);
        fs::set_permissions(&session.0, fs::Permissions::from_mode(0o755)).unwrap();
        let patience = Duration::from_secs(2);
        let started = Instant::now();
        super::super::stop_caddy(&admin, patience);
        // Refused at once: well short of the patience it would otherwise spend.
        let elapsed = started.elapsed();
        assert!(elapsed < patience / 2, "{elapsed:?}");
        fs::set_permissions(&session.0, fs::Permissions::from_mode(0o700)).unwrap();
        // The stand-in is still waiting: end it with a request of our own,
        // kept open until the stand-in has read it.
        let mut probe = std::os::unix::net::UnixStream::connect(&admin).unwrap();
        std::io::Write::write_all(&mut probe, b"GET / HTTP/1.1\r\n\r\n").unwrap();
        assert!(caddy.join().unwrap().starts_with(b"GET / "));
        drop(probe);
    }

    /// The cooperative stop (`stop-hostname-authority`, which recovery uses for
    /// an orphaned authority) ends serving too, and its Caddy goes with it, while
    /// the owner pipe stays open. It makes one attempt: here the owner itself
    /// stops its Caddy.
    // `serve_locked` records the authority's receipt with its own process
    // identity, which only macOS can observe (`identity::observe`; the managed
    // authority runs only beside the macOS VM). The serving loop itself is
    // checked on every host by the `serving_loop_*` tests below.
    #[cfg(target_os = "macos")]
    #[test]
    fn cooperative_stop_also_stops_caddy() {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Write};
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let sockets = SocketDirectory::new("coop");
        let socket = sockets.0.join("route.sock");
        let receipt = sockets.0.join("route.sock.identity");
        let session = SocketDirectory::new("coopcaddy");
        let (admin, caddy) = caddy_admin(&session);
        let (reader, writer) = owner_fifo(&fixture);
        let (done, ended) = std::sync::mpsc::channel();
        let (served, admin_path) = (socket.clone(), admin.clone());
        std::thread::spawn(move || {
            let result = super::super::serve_locked(
                &candidate,
                &served,
                None,
                None,
                reader,
                Some(admin_path.as_path()),
            );
            let _ = done.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !receipt.exists() {
            assert!(Instant::now() < deadline, "the authority never served");
            std::thread::sleep(Duration::from_millis(10));
        }
        let hash = format!(
            "{:x}",
            crate::Hex(Sha256::digest(fs::read(&receipt).unwrap()))
        );
        let mut client = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        client
            .write_all(
                format!("POST /stop?identity={hash} HTTP/1.1\r\nHost: local\r\n\r\n").as_bytes(),
            )
            .unwrap();
        let result = ended
            .recv_timeout(Duration::from_secs(3))
            .expect("the cooperative stop did not end serving");
        let mut rest = Vec::new();
        let _ = client.read_to_end(&mut rest);
        unsafe { libc::close(writer) };
        unsafe { libc::close(reader) };
        assert!(result.is_ok(), "{result:?}");
        assert!(
            caddy
                .join()
                .unwrap()
                .starts_with(b"POST /stop HTTP/1.1\r\n")
        );
        assert!(!socket.exists() && !receipt.exists());
    }

    /// #1271 review, M1: an owner killed after it spawned Caddy but before Caddy
    /// bound its admin socket. With patience the stop waits for the socket to
    /// appear in the session directory, then stops that Caddy.
    ///
    /// The stand-in binds and then sets mode 0600, as Caddy does. The patience
    /// is the test's own and generous: the stop returns as soon as it has
    /// stopped the stand-in, so only a stop that never reaches it waits it out
    /// (HACK-2743: a 2 s patience left a loaded host little room).
    #[test]
    fn caddy_still_starting_is_stopped_once_its_admin_socket_appears() {
        let session = SocketDirectory::new("late");
        let admin = session.0.join("admin.sock");
        let directory = session.0.clone();
        let late = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            caddy_admin_in(&directory).1
        });
        let started = Instant::now();
        super::super::stop_caddy(&admin, Duration::from_secs(10));
        let elapsed = started.elapsed();
        let request = late.join().unwrap().join().unwrap();
        assert!(elapsed >= Duration::from_millis(400), "{elapsed:?}");
        assert!(
            request.starts_with(b"POST /stop HTTP/1.1\r\n"),
            "{:?}",
            String::from_utf8_lossy(&request)
        );
    }

    /// HACK-2743: Caddy binds its admin socket before it applies `|0600`, so a
    /// Caddy still starting can show a socket others could open. The stop must
    /// not connect to it, and must not give up on it either: it waits, within
    /// its patience, until the socket is private, then stops that Caddy.
    #[test]
    fn caddy_stop_waits_for_its_admin_socket_to_become_private() {
        use std::os::unix::fs::PermissionsExt;
        let session = SocketDirectory::new("mode");
        let (admin, caddy) = caddy_admin(&session);
        fs::set_permissions(&admin, fs::Permissions::from_mode(0o644)).unwrap();
        let (done, stopped) = std::sync::mpsc::channel();
        let target = admin.clone();
        let stopper = std::thread::spawn(move || {
            super::super::stop_caddy(&target, Duration::from_secs(10));
            let _ = done.send(());
        });
        // Several retry steps: a stop that gave up has finished by now.
        assert!(
            stopped.recv_timeout(Duration::from_millis(300)).is_err(),
            "the stop gave up on a socket that was not private yet"
        );
        fs::set_permissions(&admin, fs::Permissions::from_mode(0o600)).unwrap();
        stopper.join().unwrap();
        let request = caddy.join().unwrap();
        assert!(
            request.starts_with(b"POST /stop HTTP/1.1\r\n"),
            "{:?}",
            String::from_utf8_lossy(&request)
        );
    }

    /// Every way the admin socket can fail to answer ends within its bound: a
    /// missing socket (with and without patience), one that refuses connections,
    /// and one that accepts but never answers.
    #[test]
    fn caddy_stop_is_bounded_when_its_admin_socket_is_missing_refusing_or_silent() {
        use std::os::unix::fs::PermissionsExt;
        let patience = Duration::from_secs(2);
        // The lower bounds show the patience was spent; the upper bounds only
        // show the stop ended, so they allow one I/O timeout of scheduling
        // slack rather than a fraction of a retry step (HACK-2743).
        let io = super::super::CADDY_STOP_IO;
        let waited = patience + io;
        let silent_bound = super::super::CADDY_STOP_WAIT + 2 * io;
        let missing = SocketDirectory::new("missing");
        let admin = missing.0.join("admin.sock");
        let started = Instant::now();
        super::super::stop_caddy(&admin, Duration::ZERO);
        assert!(started.elapsed() < Duration::from_millis(200));
        let started = Instant::now();
        super::super::stop_caddy(&admin, patience);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(1900) && elapsed < waited,
            "missing: {elapsed:?}"
        );

        let refusing = SocketDirectory::new("refusing");
        let admin = refusing.0.join("admin.sock");
        // Dropping a listener leaves its socket file, which then refuses.
        drop(std::os::unix::net::UnixListener::bind(&admin).unwrap());
        fs::set_permissions(&admin, fs::Permissions::from_mode(0o600)).unwrap();
        let started = Instant::now();
        super::super::stop_caddy(&admin, patience);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(1900) && elapsed < waited,
            "refusing: {elapsed:?}"
        );

        let silent = SocketDirectory::new("silent");
        let admin = silent.0.join("admin.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&admin).unwrap();
        fs::set_permissions(&admin, fs::Permissions::from_mode(0o600)).unwrap();
        let started = Instant::now();
        super::super::stop_caddy(&admin, patience);
        let elapsed = started.elapsed();
        assert!(elapsed < silent_bound, "silent: {elapsed:?}");
    }

    /// A listener for the serving loop alone, in a private short directory.
    fn loop_listener(directory: &SocketDirectory) -> (PathBuf, std::os::unix::net::UnixListener) {
        let path = directory.0.join("route.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        (path, listener)
    }

    /// HACK-2720 on every host: the serving loop with no clients, on a real
    /// named FIFO, keeps serving while the owner holds its writer (past one
    /// check interval) and ends within the bound once the writer closes, with
    /// `OwnerGone`. Linux reports the hangup through `poll` at once; Darwin
    /// reports nothing and the bounded wait plus the non-blocking read find it.
    ///
    /// The bound is the contract: one owner-check interval, plus one more for
    /// scheduling. A child process alive across the close stands in for the
    /// processes other tests spawn under full-suite load (HACK-2743): it must
    /// not inherit the owner's writer and so keep the owner "present".
    #[test]
    fn serving_loop_exits_soon_after_its_owner_fifo_closes() {
        let interval = Duration::from_millis(super::super::OWNER_CHECK_MS as u64);
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let directory = SocketDirectory::new("loop");
        let (_path, listener) = loop_listener(&directory);
        let (reader, writer) = owner_fifo(&fixture);
        let mut bystander = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let (done, ended) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result =
                super::super::serve_clients(&candidate, &listener, &"0".repeat(64), None, reader);
            let _ = done.send(result);
        });
        std::thread::sleep(interval + interval / 2);
        assert!(
            ended.try_recv().is_err(),
            "the loop stopped while its owner held the pipe"
        );
        let closed = Instant::now();
        unsafe { libc::close(writer) };
        let outcome = ended.recv_timeout(2 * interval);
        let after = closed.elapsed();
        let _ = bystander.kill();
        let _ = bystander.wait();
        let result = outcome.expect("the loop kept serving after its owner's pipe closed");
        unsafe { libc::close(reader) };
        assert!(
            matches!(result, Ok(super::super::ServeEnd::OwnerGone)),
            "{result:?}"
        );
        assert!(after < 2 * interval, "noticed after {after:?}");
    }

    /// The cooperative stop ends the serving loop on every host, with
    /// `Stopped`, while the owner still holds its pipe; a stop naming another
    /// receipt does not.
    #[test]
    fn serving_loop_ends_on_a_cooperative_stop_naming_its_receipt() {
        use std::io::{Read, Write};
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let directory = SocketDirectory::new("loopstop");
        let (path, listener) = loop_listener(&directory);
        let (reader, writer) = owner_fifo(&fixture);
        let fingerprint = "a".repeat(64);
        let (done, ended) = std::sync::mpsc::channel();
        let own = fingerprint.clone();
        std::thread::spawn(move || {
            let result = super::super::serve_clients(&candidate, &listener, &own, None, reader);
            let _ = done.send(result);
        });
        let stop = |hash: &str| {
            let mut client = std::os::unix::net::UnixStream::connect(&path).unwrap();
            client
                .write_all(
                    format!("POST /stop?identity={hash} HTTP/1.1\r\nHost: local\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut rest = Vec::new();
            let _ = client.read_to_end(&mut rest);
        };
        stop(&"b".repeat(64));
        assert!(
            ended.recv_timeout(Duration::from_millis(500)).is_err(),
            "a stop naming another receipt ended serving"
        );
        stop(&fingerprint);
        let result = ended
            .recv_timeout(Duration::from_secs(3))
            .expect("the cooperative stop did not end serving");
        unsafe { libc::close(writer) };
        unsafe { libc::close(reader) };
        assert!(
            matches!(result, Ok(super::super::ServeEnd::Stopped)),
            "{result:?}"
        );
    }
}
