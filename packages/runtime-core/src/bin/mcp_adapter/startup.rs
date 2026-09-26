//! Opt-in startup orchestration. Only the native owner mutates ownership state.
#[path = "cancellation.rs"]
mod cancellation;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::{connect_backend, error, verify_endpoint};

struct Launcher(Child);

impl Drop for Launcher {
    fn drop(&mut self) {
        // Reap only our direct launcher. Never signal the detached shared backend.
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[derive(PartialEq, Eq)]
struct Endpoint(u64, u64, i64, i64);

fn endpoint(path: &Path) -> io::Result<Option<Endpoint>> {
    match verify_endpoint(path) {
        Ok(()) => {
            let stat = fs::symlink_metadata(path)
                .map_err(|_| error("socket endpoint changed during startup"))?;
            Ok(Some(Endpoint(
                stat.dev(),
                stat.ino(),
                stat.ctime(),
                stat.ctime_nsec(),
            )))
        }
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(failure) => Err(failure),
    }
}

pub(super) fn connect(
    path: &Path,
    backend_id: &str,
    owner: &Path,
    backend: &Path,
) -> io::Result<UnixStream> {
    let cancellation = cancellation::Cancellation::install()?;
    if !path.is_absolute() || !owner.is_absolute() || !backend.is_absolute() {
        return Err(error(
            "managed socket and executable paths must be absolute",
        ));
    }
    let directory = path.parent().ok_or_else(|| error("invalid socket path"))?;
    if path.file_name().is_none_or(|name| name != "mcp.sock") {
        return Err(error("managed endpoint must be named mcp.sock"));
    }
    // The owner rejects aliases. Canonicalization is for its directory argument;
    // verify_endpoint still rejects a symlink in the supplied final directory.
    let canonical =
        fs::canonicalize(directory).map_err(|_| error("socket directory unavailable"))?;
    let mut attempted = endpoint(path)?;
    if attempted.is_some() {
        match connect_backend(path) {
            Ok(stream) => {
                cancellation.check()?;
                return Ok(stream);
            }
            Err(failure)
                if matches!(
                    failure.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) => {}
            Err(failure) => return Err(failure),
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let launch = || -> io::Result<Launcher> {
        Ok(Launcher(
            Command::new(owner)
                .arg("--detach")
                .arg("--supervise")
                .arg("--directory")
                .arg(&canonical)
                .arg("--")
                .arg(backend)
                .arg(&canonical)
                .arg(backend_id)
                // The first client's environment is session context, not shared
                // backend configuration. Transfer it only after authentication.
                .env_clear()
                .current_dir(&canonical)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| error("cannot start backend owner"))?,
        ))
    };
    cancellation.check()?;
    let mut launcher = launch()?;
    let mut retry_at = Instant::now() + Duration::from_millis(100);
    loop {
        cancellation.check()?;
        // A losing owner can exit before the winning owner publishes; neither
        // launcher success nor failure substitutes for endpoint authentication.
        if let Some(status) = launcher
            .0
            .try_wait()
            .map_err(|_| error("cannot observe backend owner"))?
        {
            if status.code() == Some(75) {
                // The previous owner may be retiring (socket already removed,
                // lease still held), not necessarily publishing a replacement.
                if Instant::now() >= retry_at && Instant::now() < deadline {
                    launcher = launch()?;
                    retry_at = Instant::now() + Duration::from_millis(100);
                }
            } else if !status.success() {
                return Err(error("backend owner failed"));
            }
        }
        if Instant::now() >= deadline {
            return Err(error("managed backend startup timed out"));
        }
        // Publication creates the receipt only after chmod. Do not treat the
        // brief bind-to-private-mode window as an unsafe pre-existing endpoint.
        // The protocol gate below still supplies the actual readiness proof.
        if fs::symlink_metadata(canonical.join(".mcp-receipt.json")).is_err() {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let current = endpoint(path)?;
        if current.is_some() && current != attempted {
            attempted = current;
            match connect_backend(path) {
                Ok(stream) => {
                    cancellation.check()?;
                    return Ok(stream);
                }
                Err(failure)
                    if matches!(
                        failure.kind(),
                        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                    ) => {}
                Err(failure) => return Err(failure),
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
