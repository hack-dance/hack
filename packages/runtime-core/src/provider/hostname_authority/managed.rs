//! Explicit foreground authority bound to the candidate pool's lifetime.
use super::super::{lifecycle, state, status};
use crate::{Candidate, CandidateError};
use std::{
    path::PathBuf,
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
    serve_with_certificate_limit(c, None)
}
pub fn serve_with_certificate_limit(
    c: &Candidate,
    limit: Option<usize>,
) -> Result<(), CandidateError> {
    serve_with_startup_wait(
        c,
        limit,
        lifecycle::AUTHORITY_STARTUP_LEASE_WAIT,
        &owner_present,
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
/// owner is gone (it exited, was killed, or closed its end) and a startup that
/// still waits for the lease stops waiting. Only a FIFO is that channel: any
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
/// previous flags are restored before returning, because `serve_locked` reads
/// the same descriptor after its own `poll`.
fn owner_pipe_open(fd: libc::c_int) -> Result<(), CandidateError> {
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
    super::serve_locked(c, &path, Some(lock), budget)
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
        let result = serve_with_startup_wait(&candidate, None, Duration::from_secs(2), &|| Ok(()));
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
        let result =
            serve_with_startup_wait(&candidate, None, Duration::from_millis(100), &|| Ok(()));
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
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let idle = owner_pipe_open(fds[0]);
        assert_eq!(unsafe { libc::write(fds[1], b"x".as_ptr().cast(), 1) }, 1);
        let payload = owner_pipe_open(fds[0]);
        unsafe { libc::close(fds[1]) };
        let closed = owner_pipe_open(fds[0]);
        unsafe { libc::close(fds[0]) };
        assert!(idle.is_ok());
        assert!(payload.is_ok());
        assert!(matches!(closed, Err(e) if e.code == "provider_acquisition_cancelled"));
    }

    /// A named FIFO opened the way `spawnNativeHttpsChild` opens the
    /// authority's stdin: a reader exists before the writer opens, and the
    /// authority's end is a blocking read end. Returns (reader, writer).
    fn owner_fifo(fixture: &Fixture) -> (libc::c_int, libc::c_int) {
        let path = fixture.0.join("owner-stdin");
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let reader = unsafe { libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
        assert!(reader >= 0);
        let writer = unsafe { libc::open(name.as_ptr(), libc::O_WRONLY) };
        assert!(writer >= 0);
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
}
