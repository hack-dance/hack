use hack_vm_protocol::{Response, Signal, Stream};
use std::os::unix::process::ExitStatusExt;
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

const CAP: usize = 65536;

#[derive(Default)]
struct Buffer {
    data: Vec<u8>,
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
            let keep = n.min(CAP - b.data.len());
            b.data.extend_from_slice(&chunk[..keep]);
            b.truncated |= keep != n;
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
    pub fn start(argv: Vec<String>, env: Vec<(String, String)>, input: Vec<u8>) -> Self {
        let mut job = Self {
            process: None,
            status: Response::SpawnFailed {},
            stdout: Pipe::default(),
            stderr: Pipe::default(),
        };
        let Some(exe) = argv.first() else { return job };
        let Ok(mut child) = Command::new(exe)
            .args(&argv[1..])
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
        match self.status {
            Response::Exited { code } => Response::Exited { code },
            Response::Signaled { signal } => Response::Signaled { signal },
            Response::Running {} => Response::Running {},
            _ => Response::SpawnFailed {},
        }
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
        let Ok(pos) = usize::try_from(offset) else {
            return Response::Invalid {};
        };
        let Some(remaining) = pipe.data.get(pos..) else {
            return Response::Invalid {};
        };
        let n = remaining.len().min(4096);
        Response::Output {
            bytes: remaining[..n].to_vec(),
            eof: pipe.eof && n == remaining.len(),
            truncated: pipe.truncated,
        }
    }
}
