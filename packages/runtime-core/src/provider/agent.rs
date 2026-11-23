//! Minimal pinned SmolVM agent protocol. Connecting never boots or recovers a VM.
use crate::CandidateError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 64 * 1024;
fn failure(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("agent_protocol_uncertain", message)
}

pub fn request(path: &Path, body: Value, timeout: Duration) -> Result<Value, CandidateError> {
    let bytes = encode(&body)?;
    let mut stream = UnixStream::connect(path)
        .map_err(|_| failure("Cannot connect to the owned guest socket; no automatic start."))?;
    exchange(&mut stream, &bytes, timeout)
}

/// Bound encoded allocation as well as transmitted bytes. Never report serialization content.
fn encode(body: &Value) -> Result<Vec<u8>, CandidateError> {
    struct Frame(Vec<u8>);
    impl Write for Frame {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_FRAME - self.0.len() {
                return Err(std::io::Error::other("frame limit"));
            }
            let needed = self.0.len() + bytes.len();
            if needed > self.0.capacity() {
                let capacity = needed
                    .max(self.0.capacity().saturating_mul(2))
                    .min(MAX_FRAME);
                self.0.reserve_exact(capacity - self.0.len());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut frame = Frame(Vec::new());
    serde_json::to_writer(&mut frame, body)
        .map_err(|_| failure("Guest request exceeds frame limit."))?;
    Ok(frame.0)
}

fn exchange(
    stream: &mut UnixStream,
    bytes: &[u8],
    timeout: Duration,
) -> Result<Value, CandidateError> {
    let deadline = Instant::now() + timeout;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(bytes)
        .map_err(|e| failure(e.to_string()))?;
    stream
        .set_nonblocking(true)
        .map_err(|_| failure("Cannot configure bounded guest response reads."))?;
    fn read_until(
        stream: &mut UnixStream,
        mut buffer: &mut [u8],
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        while !buffer.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| failure("Guest response deadline exceeded."))?;
            match stream.read(buffer) {
                Ok(0) => return Err(failure("Guest disconnected mid-response.")),
                Ok(count) => {
                    buffer = &mut buffer[count..];
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    let mut descriptor = libc::pollfd {
                        fd: stream.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let milliseconds = (remaining.as_millis() + 1).min(i32::MAX as u128) as i32;
                    // The descriptor is borrowed from the live stream for this synchronous wait.
                    let result = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
                    if result < 0
                        && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                    {
                        return Err(failure("Cannot wait for the guest response."));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(failure(e.to_string())),
            }
        }
        Ok(())
    }
    let mut header = [0; 4];
    read_until(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME {
        return Err(failure("Guest response exceeds frame limit."));
    }
    let mut body = vec![0; length];
    read_until(stream, &mut body, deadline)?;
    serde_json::from_slice(&body).map_err(|_| failure("Malformed guest response."))
}

/// Whether the agent at `path` starts any reply to a ping within `timeout`. No
/// connection, a connection that ends before a reply, and no reply by the deadline are
/// silence; any reply byte, even of an unexpected response, is an answer. Only a stop of
/// a guest that stopped responding relies on this.
pub(super) fn answers_ping(path: &Path, timeout: Duration) -> bool {
    answers_ping_with(|| UnixStream::connect(path), timeout, Instant::now)
}

pub(super) fn answers_ping_with(
    connect: impl FnOnce() -> std::io::Result<UnixStream>,
    timeout: Duration,
    now: impl Fn() -> Instant,
) -> bool {
    let deadline = now() + timeout;
    let Ok(bytes) = encode(&json!({"method":"ping"})) else {
        return false;
    };
    let Ok(mut stream) = connect() else {
        return false;
    };
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&bytes);
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut written = 0;
    let mut reply = [0_u8; 1];
    loop {
        let Some(remaining) = deadline.checked_duration_since(now()) else {
            return false;
        };
        if written < frame.len() {
            match stream.write(&frame[written..]) {
                Ok(count) => written += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        match stream.read(&mut reply) {
            Ok(0) => return false,
            Ok(_) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: if written < frame.len() {
                libc::POLLIN | libc::POLLOUT
            } else {
                libc::POLLIN
            },
            revents: 0,
        };
        let milliseconds = (remaining.as_millis() + 1).min(i32::MAX as u128) as i32;
        // SAFETY: the descriptor is borrowed from the live stream for this synchronous wait.
        unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
    }
}

/// The guest agent protocol version the pinned SmolVM speaks (`smolvm-protocol`
/// `PROTOCOL_VERSION`, 1 in 1.14.3, 1.34.1 and 1.35.4). Recorded as `agent_protocol_version` in
/// `provider-pins.json`.
pub(super) const PROTOCOL_VERSION: u64 = 1;

pub fn ping(path: &Path) -> Result<(), CandidateError> {
    let response = request(path, json!({"method":"ping"}), Duration::from_secs(3))?;
    if response["status"] != "pong" || response["version"] != PROTOCOL_VERSION {
        return Err(failure("Pinned guest protocol version mismatch."));
    }
    Ok(())
}

/// Where the engine tree is mounted in the guest, read-only, from the host share.
const ENGINE_SHARE: &str = "/opt/hack-engine";

/// The search path of every guest command sent with [`exec`] and [`exec_input`]. The guest's
/// own system directories come first and the engine share last (HACK-2434). A utility name
/// (`cat`, `sha256sum`, `stat`) therefore always resolves to the guest's root files, also
/// when the share holds a file of that name: a wrong or stale share cannot put its own file
/// in front of a utility the guest scripts use, including the script that hashes the engine
/// binary. Only names the root files do not have resolve to the share, which is how the
/// engine binaries are found; [`require_engine_names_unshadowed`] refuses a boot whose root
/// files would hide one of them.
pub(super) const GUEST_PATH: &str =
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/hack-engine";

/// The guest's own directories of [`GUEST_PATH`], in order, without the engine share.
fn system_directories() -> impl Iterator<Item = &'static str> {
    GUEST_PATH
        .split(':')
        .filter(|directory| *directory != ENGINE_SHARE)
}

/// Links followed while one search directory is resolved; more is a loop or a layout this
/// check does not understand, and the boot is refused.
const MAX_LINKS: usize = 16;

/// Where the guest path `directory` leads inside the root files tree at `rootfs`, resolved
/// as the guest resolves it: `..` stops at the tree's root, and a symbolic link, relative or
/// absolute, is followed inside the tree. `Ok(None)` when a component does not exist or is
/// not a directory (the guest would find nothing there); `Err` when it does not resolve
/// within [`MAX_LINKS`].
fn guest_directory(rootfs: &Path, directory: &str) -> Result<Option<std::path::PathBuf>, ()> {
    use std::path::Component;
    let mut resolved: Vec<std::ffi::OsString> = Vec::new();
    let mut pending: std::collections::VecDeque<std::ffi::OsString> = Path::new(directory)
        .components()
        .map(|component| component.as_os_str().to_owned())
        .collect();
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        match Path::new(&part).components().next() {
            None | Some(Component::CurDir | Component::RootDir | Component::Prefix(_)) => continue,
            Some(Component::ParentDir) => {
                resolved.pop();
                continue;
            }
            Some(Component::Normal(_)) => {}
        }
        let here = resolved
            .iter()
            .fold(rootfs.to_path_buf(), |path, name| path.join(name))
            .join(&part);
        let Ok(metadata) = std::fs::symlink_metadata(&here) else {
            return Ok(None);
        };
        if metadata.is_dir() {
            resolved.push(part);
            continue;
        }
        if !metadata.file_type().is_symlink() {
            // Not a directory: the guest cannot walk through it, nor search in it.
            return Ok(None);
        }
        links += 1;
        if links > MAX_LINKS {
            return Err(());
        }
        let target = std::fs::read_link(&here).map_err(|_| ())?;
        if target.is_absolute() {
            resolved.clear();
        }
        // The link's own components come before what was still to be walked.
        for component in target.components().rev() {
            pending.push_front(component.as_os_str().to_owned());
        }
    }
    Ok(Some(
        resolved
            .iter()
            .fold(rootfs.to_path_buf(), |path, name| path.join(name)),
    ))
}

/// With the guest's own directories searched first, an engine binary resolves to the share
/// only while the root files hold nothing of its name. Refuse before boot when a file of
/// `engine`'s top level has a namesake in one of the guest's search directories under
/// `rootfs`. Any kind of entry counts, also one the guest could not run (a directory, a
/// dangling link): the check is deliberately wider than what the guest's shell would pick.
/// A search directory that cannot be resolved inside the tree refuses too.
pub(super) fn require_engine_names_unshadowed(
    rootfs: &Path,
    engine: &Path,
) -> Result<(), CandidateError> {
    let unreadable =
        |_| CandidateError::new("artifact_invalid", "Cannot list the prepared engine tree.");
    let refused = |message: &'static str| CandidateError::new("guest_search_order", message);
    let mut directories = Vec::new();
    for directory in system_directories() {
        match guest_directory(rootfs, directory) {
            Ok(Some(path)) => directories.push(path),
            Ok(None) => {}
            Err(()) => {
                return Err(refused(
                    "A search directory in the guest's root files does not resolve inside them; boot refused.",
                ));
            }
        }
    }
    for entry in std::fs::read_dir(engine).map_err(unreadable)? {
        let name = entry.map_err(unreadable)?.file_name();
        if directories
            .iter()
            .any(|directory| std::fs::symlink_metadata(directory.join(&name)).is_ok())
        {
            return Err(refused(
                "The guest's root files hold an entry named like an engine binary, which the guest would find before the engine's; boot refused.",
            ));
        }
    }
    Ok(())
}

pub fn exec(
    path: &Path,
    script: &str,
    arguments: &[&str],
    background: bool,
) -> Result<String, CandidateError> {
    exec_input(path, script, arguments, background, None)
}

/// Fixed noninteractive observation using the caller's original aggregate deadline.
pub(super) fn exec_until(
    path: &Path,
    script: &str,
    arguments: &[&str],
    deadline: Instant,
) -> Result<String, CandidateError> {
    exec_input_until(path, script, arguments, None, deadline)
}

/// Private input follows the same absolute deadline as connect, dispatch and reply.
/// A timed-out exec is uncertain; no late successful reply restores authority.
pub(super) fn exec_input_until(
    path: &Path,
    script: &str,
    arguments: &[&str],
    input: Option<&str>,
    deadline: Instant,
) -> Result<String, CandidateError> {
    let mut stream = connect_until(path, deadline)?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| failure("Guest observation deadline expired."))?;
    let milliseconds = remaining.as_millis().min(40_000);
    if milliseconds == 0 {
        return Err(failure("Guest observation deadline expired."));
    }
    let mut command = vec!["/bin/sh", "-c", script, "hack-local"];
    command.extend_from_slice(arguments);
    let body = json!({"method":"vm_exec","command":command,"env":[["PATH",GUEST_PATH]],"workdir":"/","timeout_ms":milliseconds,"interactive":false,"tty":false,"background":false,"stdin_data":input});
    let bytes = encode(&body)?;
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| failure("Guest observation deadline expired."))?;
    let response = exchange(&mut stream, &bytes, timeout)?;
    if Instant::now() >= deadline {
        return Err(failure("Guest observation deadline expired."));
    }
    decode_execution(response)
}

pub fn exec_input(
    path: &Path,
    script: &str,
    arguments: &[&str],
    background: bool,
    input: Option<&str>,
) -> Result<String, CandidateError> {
    let mut command = vec!["/bin/sh", "-c", script, "hack-local"];
    command.extend_from_slice(arguments);
    let response = request(
        path,
        json!({"method":"vm_exec", "command":command,
        "env":[["PATH",GUEST_PATH]],
        "workdir":"/", "timeout_ms":if background {None} else {Some(40000)},
        "interactive":false,"tty":false,"background":background,"stdin_data":input}),
        Duration::from_secs(45),
    )?;
    decode_execution(response)
}

/// Fixed synchronous guest-cache effect: guest kills its entire exec process group
/// after seven seconds; host response is bounded to eight. Timeout is uncertain.
pub(super) fn release_guest_cache(
    path: &Path,
    owner: &str,
    boot: &str,
) -> Result<(), CandidateError> {
    let script = r#"set -eu; test "$(cat /storage/.hack-local-owner)" = "$1"; test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"; sync; printf 3 > /proc/sys/vm/drop_caches; printf 'cache-release-v1\n'"#;
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut stream = connect_until(path, deadline)?;
    let body = json!({"method":"vm_exec","command":["/bin/sh","-c",script,"hack-local",owner,boot],"env":[["PATH","/usr/sbin:/usr/bin:/sbin:/bin"]],"workdir":"/","timeout_ms":7000,"interactive":false,"tty":false,"background":false,"stdin_data":null});
    let response = exchange(
        &mut stream,
        &encode(&body)?,
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("Cache release deadline expired."))?,
    )?;
    if decode_execution(response)? != "cache-release-v1\n" {
        return Err(failure("Cache release acknowledgement differs."));
    }
    Ok(())
}

// Keep this effect's connect and response inside one deadline, including a full
// agent backlog. No thread or detached request outlives the caller.
pub(super) fn connect_until(path: &Path, deadline: Instant) -> Result<UnixStream, CandidateError> {
    if Instant::now() >= deadline {
        return Err(failure("Guest connect deadline expired."));
    }
    use std::os::fd::FromRawFd;
    // SAFETY: socket returns a fresh descriptor, adopted once below.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(failure("Cannot create guest connection."));
    }
    // SAFETY: fd is newly owned and valid.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // SAFETY: the live owned descriptor is the only argument; no pointers retained.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(failure("Cannot secure guest connection."));
    }
    stream
        .set_nonblocking(true)
        .map_err(|_| failure("Cannot bound guest connection."))?;
    // SAFETY: sockaddr_un is plain zero-initialized C storage populated below.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as _;
    let bytes = path.as_os_str().as_encoded_bytes();
    if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(failure("Invalid guest socket path."));
    }
    for (to, from) in address.sun_path.iter_mut().zip(bytes) {
        *to = *from as _;
    }
    // SAFETY: initialized address and exact storage length remain live for connect.
    let status = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as _,
        )
    };
    if status < 0 {
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(failure("Guest connection unavailable."));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("Guest connect deadline expired."))?;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: poll borrows one initialized descriptor entry for the bounded call.
        if unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        } <= 0
            || stream
                .take_error()
                .map_err(|_| failure("Guest connection uncertain."))?
                .is_some()
        {
            return Err(failure("Guest connection uncertain."));
        }
    }
    stream
        .set_nonblocking(false)
        .map_err(|_| failure("Cannot configure guest connection."))?;
    Ok(stream)
}

/// Exit status reserved across every guest script for one meaning: the guest's owner
/// token, boot ID or engine identity does not match the receipt. No script may use it for
/// any other failure. It decodes to `guest_identity_mismatch`, never `guest_command_failed`,
/// so a refusal to act on an unidentified guest is never mistaken for a command that ran and
/// failed (see `lifecycle::quiesce_stalled`).
pub(super) const GUEST_IDENTITY_REFUSED: i64 = 86;

/// Error details are guest-controlled and may echo input values. Retain only a numeric exit code.
fn decode_execution(response: Value) -> Result<String, CandidateError> {
    if response["status"] == "completed" && response["exit_code"] == GUEST_IDENTITY_REFUSED {
        return Err(CandidateError::new(
            "guest_identity_mismatch",
            "Guest owner, boot or engine identity does not match the receipt; phase retained. Guest output omitted.",
        ));
    }
    if response["status"] != "completed" || response["exit_code"] != 0 {
        let exit = response["exit_code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into());
        return Err(CandidateError::new(
            "guest_command_failed",
            format!(
                "Owned guest check failed (exit {exit}); phase retained. Guest output omitted."
            ),
        ));
    }
    let encoded = response["stdout"]
        .as_str()
        .ok_or_else(|| failure("Missing base64 guest output."))?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| failure("Invalid base64 guest output."))?;
    String::from_utf8(decoded).map_err(|_| failure("Guest receipt is not UTF-8."))
}

/// Decode a guest reply as `exec` does, for tests that run a guest script locally.
#[cfg(test)]
pub(super) fn decode_execution_for_test(response: Value) -> Result<String, CandidateError> {
    decode_execution(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A root tree with the guest's search directories, each holding the stubs named.
    struct Tree(std::path::PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    impl Tree {
        fn new(name: &str) -> Self {
            let root = crate::test_root::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                &format!("hack-guest-path-{name}"),
            );
            for directory in GUEST_PATH.split(':') {
                std::fs::create_dir_all(root.join(directory.trim_start_matches('/'))).unwrap();
            }
            Self(root)
        }

        /// An executable at `path` (inside the tree) that prints `says`.
        fn stub(&self, path: &str, says: &str) {
            use std::os::unix::fs::PermissionsExt;
            let file = self.0.join(path);
            std::fs::write(&file, format!("#!/bin/sh\necho {says}\n")).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        /// What `script` prints when run with `order` (a search path) moved under the tree.
        fn run(&self, order: &str, script: &str) -> String {
            let path = order
                .split(':')
                .map(|directory| format!("{}{directory}", self.0.display()))
                .collect::<Vec<_>>()
                .join(":");
            let output = std::process::Command::new("/bin/sh")
                .env_clear()
                .env("PATH", path)
                .args(["-c", script])
                .output()
                .unwrap();
            String::from_utf8(output.stdout).unwrap()
        }
    }

    /// HACK-2434: a guest command's utilities come from the guest's own directories, also when
    /// the engine share holds files of the same names; engine binaries still come from the share.
    #[test]
    fn guest_commands_search_the_guests_own_directories_before_the_engine_share() {
        let order: Vec<&str> = GUEST_PATH.split(':').collect();
        assert_eq!(order.last(), Some(&ENGINE_SHARE));
        assert_eq!(
            order.iter().filter(|entry| **entry == ENGINE_SHARE).count(),
            1
        );
        assert_eq!(
            system_directories().collect::<Vec<_>>(),
            [
                "/usr/local/sbin",
                "/usr/local/bin",
                "/usr/sbin",
                "/usr/bin",
                "/sbin",
                "/bin"
            ]
        );

        let tree = Tree::new("order");
        // The guest's own utilities, spread over its directories as in a real root tree.
        tree.stub("bin/cat", "system-cat");
        tree.stub("usr/bin/sha256sum", "system-sha256sum");
        tree.stub("usr/bin/stat", "system-stat");
        tree.stub("usr/local/bin/smolvm-agent", "system-agent");
        // A share that also holds files of those names, beside the engine binaries.
        for name in ["cat", "sha256sum", "stat", "smolvm-agent"] {
            tree.stub(&format!("opt/hack-engine/{name}"), &format!("share-{name}"));
        }
        tree.stub("opt/hack-engine/dockerd", "engine-dockerd");
        tree.stub("opt/hack-engine/docker", "engine-docker");
        let script = "cat; sha256sum; stat; smolvm-agent; dockerd; docker";
        assert_eq!(
            tree.run(GUEST_PATH, script),
            "system-cat\nsystem-sha256sum\nsystem-stat\nsystem-agent\nengine-dockerd\nengine-docker\n"
        );
        // The order this replaces ran the share's files first: every utility name above
        // would have come from the share.
        let old = format!(
            "{ENGINE_SHARE}:{}",
            system_directories().collect::<Vec<_>>().join(":")
        );
        assert_eq!(
            tree.run(&old, script),
            "share-cat\nshare-sha256sum\nshare-stat\nshare-smolvm-agent\nengine-dockerd\nengine-docker\n"
        );
    }

    #[test]
    fn root_files_that_would_hide_an_engine_binary_refuse_the_boot() {
        let engine_names = ["dockerd", "containerd", "docker", "runc", "docker-init"];
        let fixture = |name: &str| {
            let tree = Tree::new(name);
            for binary in engine_names {
                tree.stub(&format!("opt/hack-engine/{binary}"), binary);
            }
            // Utilities in the root files and other files on the share are no conflict.
            tree.stub("bin/cat", "cat");
            tree.stub("usr/bin/dockerd-helper", "another name");
            tree
        };
        let check =
            |tree: &Tree| require_engine_names_unshadowed(&tree.0, &tree.0.join("opt/hack-engine"));
        check(&fixture("clean")).unwrap();
        // A namesake in any of the guest's own directories refuses, whatever kind of entry.
        for (index, directory) in system_directories().enumerate() {
            let tree = fixture(&format!("shadow-{index}"));
            let binary = engine_names[index % engine_names.len()];
            let path = format!("{}/{binary}", directory.trim_start_matches('/'));
            match index % 3 {
                0 => tree.stub(&path, "shadow"),
                1 => std::fs::create_dir(tree.0.join(&path)).unwrap(),
                _ => std::os::unix::fs::symlink("/nowhere", tree.0.join(&path)).unwrap(),
            }
            let refused = check(&tree).unwrap_err();
            assert_eq!(refused.code, "guest_search_order", "{path}");
            assert!(refused.message_fixed);
        }
        // A search directory that is a link is followed inside the tree, as the guest would:
        // the namesake exists only where the link leads.
        let linked = |name: &str, link: &str, target: &str, shadow: &str| {
            let tree = fixture(name);
            std::fs::remove_dir(tree.0.join(link)).unwrap();
            std::os::unix::fs::symlink(target, tree.0.join(link)).unwrap();
            check(&tree).unwrap();
            let shadow = tree.0.join(shadow);
            std::fs::create_dir_all(shadow.parent().unwrap()).unwrap();
            std::fs::write(shadow, b"shadow").unwrap();
            check(&tree).unwrap_err().code
        };
        // Relative, and absolute from the tree's root.
        assert_eq!(
            linked("relative", "usr/sbin", "../lib/tools", "lib/tools/runc"),
            "guest_search_order"
        );
        assert_eq!(
            linked("absolute", "usr/sbin", "/lib/tools", "lib/tools/runc"),
            "guest_search_order"
        );
        // `..` stops at the tree's root instead of leaving it.
        assert_eq!(
            linked(
                "clamped",
                "usr/local/bin",
                "../../../../../opt/vendor/bin",
                "opt/vendor/bin/dockerd"
            ),
            "guest_search_order"
        );
        // A chain of links, one of them absolute.
        let tree = fixture("chain");
        std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
        std::os::unix::fs::symlink("first", tree.0.join("usr/sbin")).unwrap();
        std::os::unix::fs::symlink("/usr/second", tree.0.join("usr/first")).unwrap();
        std::fs::create_dir_all(tree.0.join("usr/second")).unwrap();
        check(&tree).unwrap();
        tree.stub("usr/second/containerd", "shadow");
        assert_eq!(check(&tree).unwrap_err().code, "guest_search_order");
        // A namesake outside the tree, where a link resolved against the host would look,
        // is not the guest's.
        let tree = fixture("outside");
        let outside = Tree::new("outside-host");
        outside.stub("bin/docker", "host");
        std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
        let target = format!(
            "../../{}/bin",
            outside.0.file_name().unwrap().to_str().unwrap()
        );
        std::os::unix::fs::symlink(&target, tree.0.join("usr/sbin")).unwrap();
        // Resolved on the host, as the first version of this check did, the link reaches
        // the planted file; resolved as the guest does, it stays inside the tree.
        assert!(tree.0.join("usr").join(&target).join("docker").exists());
        check(&tree).unwrap();
        // A regular file is not walked through: the guest stops there, so what lies behind
        // `..` after it is not one of its search directories.
        for target in [
            "/marker/../tools",
            "/marker/./../tools",
            "marker/../../tools",
        ] {
            let tree = fixture("not-a-directory");
            std::fs::write(tree.0.join("marker"), b"file").unwrap();
            std::fs::write(tree.0.join("usr/marker"), b"file").unwrap();
            std::fs::create_dir_all(tree.0.join("tools")).unwrap();
            tree.stub("tools/runc", "unreachable");
            std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
            std::os::unix::fs::symlink(target, tree.0.join("usr/sbin")).unwrap();
            check(&tree).unwrap();
        }
        // A search directory that is a regular file holds nothing.
        let tree = fixture("file-directory");
        std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
        std::fs::write(tree.0.join("usr/sbin"), b"file").unwrap();
        check(&tree).unwrap();
        // A link loop cannot be resolved and refuses; a link to nothing has nothing in it.
        let tree = fixture("loop");
        std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
        std::os::unix::fs::symlink("sbin", tree.0.join("usr/sbin")).unwrap();
        assert_eq!(check(&tree).unwrap_err().code, "guest_search_order");
        let tree = fixture("nowhere");
        std::fs::remove_dir(tree.0.join("usr/sbin")).unwrap();
        std::os::unix::fs::symlink("/nowhere", tree.0.join("usr/sbin")).unwrap();
        check(&tree).unwrap();
        // An engine tree that is missing refuses too.
        let tree = fixture("unlisted");
        assert_eq!(
            require_engine_names_unshadowed(&tree.0, &tree.0.join("opt/missing"))
                .unwrap_err()
                .code,
            "artifact_invalid"
        );
        // Both request builders send this order: no search path in this file starts with
        // the share any more.
        assert!(!include_str!("agent.rs").contains(concat!("\"/opt/hack-engine", ":")));
    }
    #[test]
    fn failed_guest_output_and_malformed_metadata_never_enter_errors() {
        let sentinel = "synthetic-private-input";
        for response in [
            json!({"status":"completed", "exit_code":23, "stdout":STANDARD.encode(sentinel), "stderr":STANDARD.encode(sentinel)}),
            json!({"status":sentinel, "exit_code":sentinel, "stderr":sentinel}),
            json!({"status":"completed", "exit_code":{"detail":sentinel}, "stderr":STANDARD.encode(sentinel)}),
            json!({"status":"completed", "exit_code":0, "stdout":sentinel}),
            json!({"status":"completed", "exit_code":0, "stdout":STANDARD.encode([0xff]), "stderr":sentinel}),
        ] {
            let failure = decode_execution(response).unwrap_err();
            let serialized = serde_json::to_string(&failure).unwrap();
            assert!(!serialized.contains(sentinel));
            assert!(!serialized.contains(&STANDARD.encode(sentinel)));
        }
        let failure = decode_execution(json!({"status":"completed", "exit_code":23})).unwrap_err();
        assert_eq!(failure.code, "guest_command_failed");
        assert!(failure.message.contains("exit 23"));
    }

    /// HACK-1968: only a completed command's reserved status is an identity refusal; an
    /// engine timeout (42) and a command the agent did not complete stay ordinary failures.
    #[test]
    fn only_the_reserved_exit_status_is_an_identity_refusal() {
        let sentinel = "synthetic-private-input";
        let refused = decode_execution(json!({"status":"completed", "exit_code":GUEST_IDENTITY_REFUSED, "stderr":STANDARD.encode(sentinel)})).unwrap_err();
        assert_eq!(refused.code, "guest_identity_mismatch");
        assert!(refused.message_fixed);
        assert!(!serde_json::to_string(&refused).unwrap().contains(sentinel));
        for response in [
            json!({"status":"completed", "exit_code":42}),
            json!({"status":"timeout", "exit_code":GUEST_IDENTITY_REFUSED}),
            json!({"status":"completed", "exit_code":"86"}),
        ] {
            assert_eq!(
                decode_execution(response).unwrap_err().code,
                "guest_command_failed"
            );
        }
    }

    #[test]
    fn successful_public_receipts_are_preserved() {
        let receipt = "public-fixture-receipt\n";
        assert_eq!(decode_execution(json!({"status":"completed", "exit_code":0, "stdout":STANDARD.encode(receipt), "stderr":STANDARD.encode("ignored diagnostic")})).unwrap(), receipt);
    }

    #[test]
    fn encoded_frame_budget_counts_json_escaping_and_accepts_exact_limit() {
        let exact = json!("x".repeat(MAX_FRAME - 2));
        assert_eq!(encode(&exact).unwrap().len(), MAX_FRAME);
        assert!(encode(&json!("x".repeat(MAX_FRAME - 1))).is_err());
        // The raw value fits, but JSON escaping makes its wire representation exceed the budget.
        assert!(encode(&json!("\n".repeat(MAX_FRAME / 2))).is_err());
        assert_eq!(
            encode(&json!({"stdin_data":"line\n'\\$"})).unwrap(),
            serde_json::to_vec(&json!({"stdin_data":"line\n'\\$"})).unwrap()
        );
    }

    #[test]
    fn oversized_sensitive_input_is_refused_before_connecting() {
        let error = request(
            Path::new("/nonexistent/hack-test-agent.sock"),
            json!({"stdin_data":"synthetic-sensitive-input".repeat(MAX_FRAME)}),
            Duration::from_millis(10),
        )
        .unwrap_err();
        assert_eq!(error.message, "Guest request exceeds frame limit.");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-sensitive-input")
        );
    }

    #[test]
    fn guest_echo_over_wire_is_not_retained_in_failure() {
        let sentinel = "synthetic-wire-private-value";
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let mut header = [0; 4];
            peer.read_exact(&mut header).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(header) as usize];
            peer.read_exact(&mut bytes).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["stdin_data"], sentinel);
            let response = serde_json::to_vec(&json!({"status":"completed", "exit_code":1, "stderr":STANDARD.encode(body["stdin_data"].as_str().unwrap())})).unwrap();
            peer.write_all(&(response.len() as u32).to_be_bytes())
                .unwrap();
            peer.write_all(&response).unwrap();
        });
        let response = exchange(
            &mut client,
            &encode(&json!({"stdin_data":sentinel})).unwrap(),
            Duration::from_secs(1),
        )
        .unwrap();
        let error = decode_execution(response).unwrap_err();
        assert!(!serde_json::to_string(&error).unwrap().contains(sentinel));
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains(&STANDARD.encode(sentinel))
        );
        worker.join().unwrap();
    }

    #[test]
    fn oversized_frame_is_rejected_before_body_allocation() {
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let mut header = [0; 4];
            peer.read_exact(&mut header).unwrap();
            let mut request = vec![0; u32::from_be_bytes(header) as usize];
            peer.read_exact(&mut request).unwrap();
            peer.write_all(&((MAX_FRAME + 1) as u32).to_be_bytes())
                .unwrap();
        });
        assert_eq!(
            exchange(
                &mut client,
                &encode(&json!({"method":"ping"})).unwrap(),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .code,
            "agent_protocol_uncertain"
        );
        worker.join().unwrap();
    }
    #[test]
    fn a_stalled_mid_frame_has_a_wall_clock_deadline() {
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(&100_u32.to_be_bytes()).unwrap();
        peer.write_all(b"{").unwrap();
        let start = Instant::now();
        assert!(
            exchange(
                &mut client,
                &encode(&json!({"method":"ping"})).unwrap(),
                Duration::from_millis(50)
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
