use hack_vm_protocol::{Response, Signal, Stream};
use std::os::unix::process::ExitStatusExt;
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

pub const CAP: usize = 65536;

#[derive(Default)]
struct Buffer {
    data: std::collections::VecDeque<u8>,
    first: u64,
    eof: bool,
    truncated: bool,
}
type Pipe = Arc<Mutex<Buffer>>;

fn drain(mut reader: impl Read + Send + 'static, sink: Pipe) {
    thread::spawn(move || {
        let mut chunk = [0; 4096];
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    sink.lock().unwrap().truncated = true;
                    break;
                }
            };
            let mut b = sink.lock().unwrap();
            let drop_count = (b.data.len() + n).saturating_sub(CAP);
            b.data.drain(..drop_count);
            b.first += drop_count as u64;
            b.data.extend(&chunk[..n]);
        }
        sink.lock().unwrap().eof = true;
    });
}

pub struct Job {
    process: Option<Child>,
    status: Response,
    stdout: Pipe,
    stderr: Pipe,
}
impl Job {
    pub fn start(
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        input: Vec<u8>,
    ) -> Self {
        let mut job = Self {
            process: None,
            status: Response::SpawnFailed {},
            stdout: Pipe::default(),
            stderr: Pipe::default(),
        };
        let Some(exe) = argv.first() else { return job };
        let Ok(mut child) = Command::new(exe)
            .args(&argv[1..])
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        else {
            return job;
        };
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
        drain(child.stdout.take().unwrap(), job.stdout.clone());
        drain(child.stderr.take().unwrap(), job.stderr.clone());
        job.process = Some(child);
        job.status = Response::Running {};
        job
    }

    // All child inspection, signal delivery and reaping share the registry lock.
    pub fn refresh(&mut self) {
        if let Some(child) = &mut self.process
            && let Ok(Some(status)) = child.try_wait()
        {
            self.status = match status.code() {
                Some(code) => Response::Exited { code },
                None => Response::Signaled {
                    signal: status.signal().unwrap(),
                },
            };
            self.process = None;
        }
    }
    pub fn inspect(&self) -> Response {
        self.status.clone()
    }
    pub fn signal(&self, signal: Signal) -> Response {
        let Some(child) = &self.process else {
            return self.inspect();
        };
        let sig = match signal {
            Signal::Interrupt => libc::SIGINT,
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // SAFETY: the unreaped child remains owned while the registry is locked.
        if unsafe { libc::kill(child.id() as i32, sig) } == 0 {
            Response::Ack {}
        } else {
            Response::Unknown {}
        }
    }
    pub fn finished(&self) -> bool {
        self.process.is_none()
            && (matches!(self.status, Response::SpawnFailed {})
                || (self.stdout.lock().unwrap().eof && self.stderr.lock().unwrap().eof))
    }
    pub fn output(&self, stream: Stream, offset: u64) -> Response {
        let pipe = match stream {
            Stream::Stdout => &self.stdout,
            Stream::Stderr => &self.stderr,
        }
        .lock()
        .unwrap();
        let start_offset = offset.max(pipe.first);
        let Ok(index) = usize::try_from(start_offset - pipe.first) else {
            return Response::Invalid {};
        };
        if index > pipe.data.len() {
            return Response::Invalid {};
        }
        let bytes: Vec<_> = pipe.data.range(index..).take(4096).copied().collect();
        Response::Output {
            start_offset,
            eof: matches!(self.status, Response::SpawnFailed {})
                || (pipe.eof && index + bytes.len() == pipe.data.len()),
            truncated: offset < pipe.first || pipe.truncated,
            bytes,
        }
    }
}
