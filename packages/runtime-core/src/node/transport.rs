use super::{Request, Result, Store, error, now, private_directory, try_lock};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::{
    fs::{FileTypeExt, MetadataExt},
    net::{UnixListener, UnixStream},
    process::CommandExt,
};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const FRAME_LIMIT: usize = 128 * 1024;

pub fn call(root: &Path, request: &Request) -> Result<serde_json::Value> {
    private_directory(root, false)?;
    let mut stream =
        UnixStream::connect(root.join("node.sock")).map_err(|e| error(format!("connect: {e}")))?;
    timeouts(&stream)?;
    if peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Err(error("Unexpected server UID."));
    }
    write_frame(&mut stream, &serde_json::to_vec(request).map_err(error)?)?;
    serde_json::from_slice(&read_response(&mut stream)?).map_err(error)
}

/// Explicit foreground service. Disconnects never own a job's lifetime.
pub fn serve(root: &Path, executable: &Path, checkout: &Path) -> Result<()> {
    private_directory(root, true)?;
    let _lock = try_lock(&root.join("node.lock"))?.ok_or_else(|| error("Node already serving."))?;
    let mut store = Store::open(root, true)?;
    let socket = root.join("node.sock");
    if let Ok(m) = socket.symlink_metadata() {
        if !m.file_type().is_socket() || m.uid() != unsafe { libc::geteuid() } {
            return Err(error("Refusing non-owned socket path."));
        }
        std::fs::remove_file(&socket).map_err(error)?;
    }
    // The private parent directory excludes other principals throughout socket creation.
    let listener = UnixListener::bind(&socket).map_err(error)?;
    listener.set_nonblocking(true).map_err(error)?;
    let mut workers: HashMap<String, Child> = HashMap::new();
    loop {
        schedule(&mut store, executable, checkout, &mut workers)?;
        match listener.accept() {
            Ok((mut stream, _)) => {
                let response = handle_stream(&mut stream, &mut store, checkout);
                let value = match response {
                    Ok(value) => serde_json::json!({"ok":true,"result":value}),
                    Err(e) => serde_json::json!({"ok":false,"error":e}),
                };
                // An acknowledgement failure does not roll back acceptance or abort serving.
                let _ = write_frame(&mut stream, &serde_json::to_vec(&value).map_err(error)?);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(error(e)),
        }
    }
}
fn handle_stream(
    stream: &mut UnixStream,
    store: &mut Store,
    checkout: &Path,
) -> Result<serde_json::Value> {
    timeouts(stream)?;
    let uid = peer_uid(stream)?;
    if uid != unsafe { libc::geteuid() } {
        return Err(error("Peer UID is not authorized."));
    }
    let request: Request = serde_json::from_slice(&read_frame(stream)?).map_err(error)?;
    if let Ok(candidate) = crate::Candidate::discover(checkout) {
        if super::root(&candidate) == store.root {
            return store.handle_for_candidate(&request, uid, &candidate);
        }
    }
    store.handle(&request, uid)
}
fn timeouts(stream: &UnixStream) -> Result<()> {
    stream.set_nonblocking(false).map_err(error)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| error(format!("read timeout: {e}")))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| error(format!("write timeout: {e}")))
}
fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut header = [0; 4];
    read_bounded(stream, &mut header, deadline)?;
    read_payload(stream, header, deadline)
}

fn read_response(stream: &mut UnixStream) -> Result<Vec<u8>> {
    // Admission may verify a full immutable tree before the server can acknowledge it.
    // Once the response begins, its frame still has the ordinary strict transfer deadline.
    let mut header = [0; 4];
    let response_deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() >= response_deadline {
            return Err(error(
                "Operation response deadline exceeded; acceptance may be uncertain.",
            ));
        }
        match stream.read(&mut header[..1]) {
            Ok(0) => return Err(error("Connection closed before the operation reply.")),
            Ok(_) => break,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(e) => return Err(error(format!("read response: {e}"))),
        }
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    read_bounded(stream, &mut header[1..], deadline)?;
    read_payload(stream, header, deadline)
}

fn read_payload(stream: &mut UnixStream, header: [u8; 4], deadline: Instant) -> Result<Vec<u8>> {
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > FRAME_LIMIT {
        return Err(error("Frame length outside 1..131072 bytes."));
    }
    let mut bytes = vec![0; size];
    read_bounded(stream, &mut bytes, deadline)?;
    Ok(bytes)
}
fn read_bounded(stream: &mut UnixStream, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
        if Instant::now() >= deadline {
            return Err(error("Frame deadline exceeded."));
        }
        // Keep the initial timeout: on macOS changing it after the peer has closed
        // can fail even though the complete response is already buffered.
        let count = stream
            .read(bytes)
            .map_err(|e| error(format!("read: {e}")))?;
        if count == 0 {
            return Err(error("Incomplete frame."));
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}
fn write_frame(stream: &mut UnixStream, bytes: &[u8]) -> Result<()> {
    if bytes.len() > FRAME_LIMIT {
        return Err(error("Response exceeds frame budget."));
    }
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(bytes);
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut remaining = frame.as_slice();
    while !remaining.is_empty() {
        if Instant::now() >= deadline {
            return Err(error("Write frame deadline exceeded."));
        }
        let count = stream.write(remaining).map_err(error)?;
        if count == 0 {
            return Err(error("Incomplete frame write."));
        }
        remaining = &remaining[count..];
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: valid socket and writable uid/gid pointers.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(error(format!(
            "peer uid: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(uid)
}
#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: kernel fills correctly sized ucred for this connected socket.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(error(std::io::Error::last_os_error()));
    }
    Ok(credentials.uid)
}

fn schedule(
    store: &mut Store,
    executable: &Path,
    checkout: &Path,
    workers: &mut HashMap<String, Child>,
) -> Result<()> {
    let mut exited = Vec::new();
    for (id, child) in workers.iter_mut() {
        if child.try_wait().map_err(error)?.is_some() {
            exited.push(id.clone());
        }
    }
    for id in exited {
        workers.remove(&id);
    }
    for receipt in store.list()? {
        if matches!(
            receipt.state.as_str(),
            "preparing" | "running" | "finishing"
        ) && !workers.contains_key(&receipt.job_id)
        {
            if let Some(_lock) = try_lock(&store.lock_path(&receipt.job_id)?)? {
                store.update(&receipt.job_id, |r| { r.state = "quarantined".into(); r.detail = Some("Supervisor absent; launch or cleanup uncertain. Never automatically replayed.".into()); Ok(()) })?;
            }
        }
        if receipt.state == "queued" && receipt.queue_deadline_ms <= now() {
            store.update(&receipt.job_id, |r| {
                if r.state == "queued" {
                    r.state = "queue_expired".into();
                }
                Ok(())
            })?;
        }
    }
    // One concurrent fixture per node, including uncertain work. Quarantine deliberately
    // prevents new execution until later operator reconciliation exists.
    let jobs = store.list()?;
    if jobs.iter().any(|r| {
        matches!(
            r.state.as_str(),
            "preparing" | "running" | "finishing" | "quarantined"
        )
    }) {
        return Ok(());
    }
    if let Some(job) = jobs.iter().find(|r| r.state == "queued") {
        let claimed = store.update(&job.job_id, |r| {
            if r.state == "queued" && !r.cancel_requested {
                r.state = "preparing".into();
            }
            Ok(())
        })?;
        if claimed.state != "preparing" {
            return Ok(());
        }
        let mut command = Command::new(executable);
        command
            .args(["--candidate-root"])
            .arg(checkout)
            .args(["__job_supervisor"])
            .arg(&store.root)
            .arg(&job.job_id)
            .env_clear()
            .current_dir(&store.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe and touches no Rust state in the child.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        match command.spawn() {
            Ok(child) => {
                workers.insert(job.job_id.clone(), child);
            }
            Err(e) => {
                store.update(&job.job_id, |r| {
                    r.state = "quarantined".into();
                    r.detail = Some(format!("Supervisor launch failed: {e}"));
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_wait_allows_admission_but_stalled_frames_stay_bounded() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        timeouts(&client).unwrap();
        timeouts(&server).unwrap();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            write_frame(&mut server, b"{} ").unwrap();
        });
        assert_eq!(read_response(&mut client).unwrap(), b"{} ");
        sender.join().unwrap();
        let (mut client, mut server) = UnixStream::pair().unwrap();
        timeouts(&client).unwrap();
        timeouts(&server).unwrap();
        server.write_all(&[0]).unwrap();
        let start = Instant::now();
        assert!(read_response(&mut client).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
