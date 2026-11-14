//! Publish executable fixtures only after their writer is closed.
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub fn script(path: &Path, body: impl AsRef<[u8]>) {
    let pending = path.with_extension("pending");
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .unwrap();
    writer.write_all(body.as_ref()).unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::rename(pending, path).unwrap();
}

/// One scheduling budget for the entire fake-daemon conversation, not a
/// production socket timeout. Never pass zero to set_read_timeout.
pub const DAEMON_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

pub fn remaining(deadline: std::time::Instant) -> std::time::Duration {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|duration| !duration.is_zero())
        .expect("fake daemon exceeded its overall fixture deadline")
}

/// Read a complete, bounded HTTP header, including delayed/partial writes.
/// Socket waits consume the same overall budget as listener acceptance.
pub fn read_request(stream: &mut std::os::unix::net::UnixStream, deadline: std::time::Instant) {
    use std::io::Read;
    // Darwin/BSD accept inherits O_NONBLOCK from the listener. Linux does
    // not, so normalize explicitly before installing a read timeout.
    stream.set_nonblocking(false).unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        stream.set_read_timeout(Some(remaining(deadline))).unwrap();
        let mut chunk = [0; 512];
        let n = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            Err(error) => {
                panic!("fake daemon request did not arrive within fixture deadline: {error}")
            }
        };
        assert_ne!(n, 0, "client closed before completing fake daemon request");
        request.extend_from_slice(&chunk[..n]);
        assert!(
            request.len() <= 4096,
            "fake daemon request header exceeds fixture bound"
        );
    }
    assert!(request.starts_with(b"GET /v1/"));
}
