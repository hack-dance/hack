use crate::{Result, refused};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::PathBuf,
    time::{Duration, Instant},
};

pub const LIMIT: usize = 1024 * 1024;
pub const DEADLINE: Duration = Duration::from_secs(10);
static STDOUT_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn stdout_started() -> bool {
    STDOUT_STARTED.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub version: u32,
    pub root: PathBuf,
    pub owner_token: String,
    pub processes: Vec<Process>,
    #[serde(default)]
    pub log_path: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Process {
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub version: u32,
    pub root: PathBuf,
    pub owner_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardLaunch {
    pub version: u32,
    pub root: PathBuf,
    pub owner_token: String,
    pub process: Process,
    #[serde(default)]
    pub log_path: Option<PathBuf>,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.len() <= 96
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && name != "."
        && name != ".."
}

pub fn validate_control(version: u32, root: &std::path::Path, token: &str) -> Result<()> {
    if version != 1
        || !root.is_absolute()
        || token.is_empty()
        || token.len() > 256
        || token.contains('\0')
    {
        return Err(refused());
    }
    Ok(())
}

impl Process {
    pub fn validate(&self) -> Result<()> {
        if self
            .display_name
            .as_ref()
            .is_some_and(|name| name.trim().is_empty() || name.len() > 4096 || name.contains('\0'))
        {
            return Err(refused());
        }
        if !valid_name(&self.name)
            || !self.cwd.is_absolute()
            || self.argv.is_empty()
            || self.argv[0].is_empty()
            || self.argv.iter().any(|v| v.contains('\0'))
            || self.env.iter().any(|(key, value)| {
                key.is_empty() || key.contains(['\0', '=']) || value.contains('\0')
            })
        {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn inherited_environment_uses_exec_constraints_not_shell_identifiers() {
        let mut process: super::Process = serde_json::from_value(serde_json::json!({
            "name": "worker", "argv": ["/usr/bin/true"], "cwd": "/",
            "env": {"BASH_FUNC_fixture%%": "() { :; }", "1.name": "synthetic"}
        }))
        .unwrap();
        assert!(process.validate().is_ok());
        for key in ["", "bad=name", "bad\0name"] {
            process.env.insert(key.into(), "synthetic".into());
            assert!(process.validate().is_err());
            process.env.remove(key);
        }
        process.env.insert("VALID".into(), "bad\0value".into());
        assert!(process.validate().is_err());
    }
}

/// Length and deadline, never descriptor closure, delimit a handoff. Polling
/// handles Darwin's brief inheritable-descriptor window without waiting on EOF.
pub fn read<T: DeserializeOwned>(input: &mut (impl Read + AsRawFd)) -> Result<T> {
    let deadline = Instant::now() + DEADLINE;
    let mut header = [0; 4];
    exact(input, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > LIMIT {
        return Err(refused());
    }
    let mut bytes = vec![0; length];
    exact(input, &mut bytes, deadline)?;
    let parsed = serde_json::from_slice(&bytes).map_err(|_| refused());
    bytes.fill(0);
    parsed
}

fn exact(input: &mut (impl Read + AsRawFd), bytes: &mut [u8], deadline: Instant) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let mut fd = libc::pollfd {
            fd: input.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll borrows one initialized descriptor record for this call.
        let result = unsafe {
            libc::poll(
                &mut fd,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if result < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if result <= 0 {
            return Err(refused());
        }
        // Read exactly the polled kernel descriptor. Stdin's high-level Read
        // buffers ahead: polling after a four-byte header would then wait for
        // data already held inside its user-space buffer.
        // SAFETY: the destination slice is writable for its supplied length;
        // read borrows a live descriptor and retains no pointer.
        let count = unsafe {
            libc::read(
                input.as_raw_fd(),
                bytes[offset..].as_mut_ptr().cast(),
                bytes.len() - offset,
            )
        };
        let result = if count < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(count as usize)
        };
        match result {
            Ok(0) => return Err(refused()),
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub fn write(output: &mut (impl Write + AsRawFd), value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    if bytes.is_empty() || bytes.len() > LIMIT {
        return Err(refused());
    }
    let fd = output.as_raw_fd();
    if fd == libc::STDOUT_FILENO {
        STDOUT_STARTED.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    // SAFETY: fcntl borrows this live, exclusively used protocol descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: only integer descriptor flags are changed for bounded writes.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let deadline = Instant::now() + DEADLINE;
    let result = send(fd, &(bytes.len() as u32).to_be_bytes(), deadline)
        .and_then(|()| send(fd, &bytes, deadline));
    // SAFETY: restore the original flags before returning the borrowed fd.
    let restore = unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
    bytes.fill(0);
    result?;
    if restore < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn send(fd: i32, bytes: &[u8], deadline: Instant) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let mut record = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: poll borrows one initialized descriptor record.
        let ready = unsafe {
            libc::poll(
                &mut record,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if ready < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 {
            return Err(refused());
        }
        // SAFETY: bytes remain live for the supplied length; fd is nonblocking.
        let count =
            unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(
                error.kind(),
                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
            ) {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Err(refused());
        }
        offset += count as usize;
    }
    Ok(())
}
