use hack_vm_protocol::{Response, Signal, Stream};
use std::{
    collections::VecDeque,
    io::{self, PipeReader, PipeWriter, Read, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{Child, Command},
};

pub const CAP: usize = 65536;

// Set only the agent end nonblocking. The child gets ordinary blocking pipes.
fn nonblocking(fd: &impl AsRawFd) -> io::Result<()> {
    let fd = fd.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Default)]
struct Output {
    reader: Option<PipeReader>,
    data: VecDeque<u8>,
    first: u64,
    failed: bool,
}
impl Output {
    fn pipe(&mut self) -> io::Result<PipeWriter> {
        let (reader, writer) = io::pipe()?;
        nonblocking(&reader)?;
        self.reader = Some(reader);
        Ok(writer)
    }
    fn drain(&mut self) {
        let Some(reader) = &mut self.reader else {
            return;
        };
        let mut chunk = [0; 4096];
        // Bound work under the lock even if a child writes continuously.
        for _ in 0..16 {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    self.reader = None;
                    return;
                }
                Ok(n) => {
                    let lost = (self.data.len() + n).saturating_sub(CAP);
                    self.data.drain(..lost);
                    self.first += lost as u64;
                    self.data.extend(&chunk[..n]);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
                Err(_) => {
                    self.failed = true;
                    self.reader = None;
                    return;
                }
            }
        }
        // A full burst may still have bytes pending. Close only on EOF/error.
    }
    fn read(&self, offset: u64) -> Response {
        let start_offset = offset.max(self.first);
        let diff = start_offset - self.first;
        if diff > self.data.len() as u64 {
            return Response::Invalid {};
        }
        let index = diff as usize;
        let bytes: Vec<_> = self.data.range(index..).take(4096).copied().collect();
        Response::Output {
            start_offset,
            eof: self.reader.is_none() && index + bytes.len() == self.data.len(),
            truncated: self.first != 0 || self.failed,
            bytes,
        }
    }
}

pub struct Job {
    leader: Option<Child>,
    status: Response,
    input: Option<(PipeWriter, Vec<u8>, usize)>,
    stdout: Output,
    stderr: Output,
}
impl Job {
    pub fn start(
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        input: Vec<u8>,
    ) -> Self {
        let mut job = Self {
            leader: None,
            status: Response::SpawnFailed {},
            input: None,
            stdout: Output::default(),
            stderr: Output::default(),
        };
        let spawn = || -> io::Result<_> {
            let (stdin, writer) = io::pipe()?;
            nonblocking(&writer)?;
            let stdout = job.stdout.pipe()?;
            let stderr = job.stderr.pipe()?;
            let exe = argv.first().ok_or(io::ErrorKind::InvalidInput)?;
            let child = Command::new(exe)
                .args(&argv[1..])
                .current_dir(cwd)
                .env_clear()
                .envs(env)
                .process_group(0)
                .stdin(stdin)
                .stdout(stdout)
                .stderr(stderr)
                .spawn()?;
            Ok((child, writer))
        };
        if let Ok((child, writer)) = spawn() {
            job.leader = Some(child);
            job.status = Response::Running {};
            if !input.is_empty() {
                job.input = Some((writer, input, 0));
            }
        } else {
            job.stdout.reader = None;
            job.stderr.reader = None;
        }
        job
    }

    pub fn needs_refresh(&self) -> bool {
        !self.finished() || self.stdout.reader.is_some() || self.stderr.reader.is_some()
    }
    pub fn refresh(&mut self) {
        if let Some((writer, data, pos)) = &mut self.input {
            match writer.write(&data[*pos..]) {
                Ok(n) => {
                    *pos += n;
                    if *pos == data.len() {
                        self.input = None;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) => {}
                Err(_) => self.input = None,
            }
        }
        self.stdout.drain();
        self.stderr.drain();
        if !matches!(self.status, Response::Running {}) {
            return;
        }
        let Some(child) = &self.leader else { return };
        // WNOWAIT pins both the leader pid and its process group through Release.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if rc == -1 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                self.leader = None;
                self.status = Response::Unknown {};
            }
        } else if unsafe { info.si_pid() } != 0 {
            let code = unsafe { info.si_status() };
            self.status = if info.si_code == libc::CLD_EXITED {
                Response::Exited { code }
            } else {
                Response::Signaled { signal: code }
            };
        }
    }
    pub fn inspect(&self) -> Response {
        self.status.clone()
    }
    pub fn signal(&self, signal: Signal) -> Response {
        let Some(child) = &self.leader else {
            return self.inspect();
        };
        let sig = match signal {
            Signal::Interrupt => libc::SIGINT,
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        let rc = unsafe { libc::kill(-(child.id() as i32), sig) };
        if self.finished() {
            self.inspect()
        } else if rc == 0 {
            Response::Ack {}
        } else {
            Response::Unknown {}
        }
    }
    pub fn finished(&self) -> bool {
        !matches!(self.status, Response::Running {})
    }
    pub fn release(&mut self) -> io::Result<()> {
        if let Some(child) = &mut self.leader {
            // Only a terminal, unreaped child can reach here. Keep ownership
            // across a failed kill so that the host can reconcile and retry.
            if unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) } < 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(err);
                }
            }
            match child.wait() {
                Err(e) if e.raw_os_error() != Some(libc::ECHILD) => return Err(e),
                _ => self.leader = None,
            }
        }
        Ok(())
        // Removing this Job closes all agent pipe ends, including those held
        // open at the other end by descendants that escaped the process group.
    }
    pub fn output(&self, stream: Stream, offset: u64) -> Response {
        match stream {
            Stream::Stdout => self.stdout.read(offset),
            Stream::Stderr => self.stderr.read(offset),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn already_reaped_leader_loses_signal_authority() {
        let mut job = Job::start(vec!["/bin/true".into()], vec![], "/".into(), vec![]);
        job.leader.as_mut().unwrap().wait().unwrap();
        job.refresh();
        assert_eq!(job.inspect(), Response::Unknown {});
        assert!(job.leader.is_none() && job.finished());
        assert_eq!(job.signal(Signal::Kill), Response::Unknown {});
        job.release().unwrap();
    }
}
