//! Run under guest supervision with a socket in a private runtime directory.
use hack_vm_protocol::client::Exchange;
mod jobs;
use hack_vm_protocol::{Handle, Request, Response, negotiate, read_frame, write_frame};
use jobs::Job;
use std::{
    collections::HashMap,
    fs, io,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

struct Agent {
    boot: String,
    incarnation: String,
    jobs: Mutex<HashMap<String, Option<Job>>>,
}

impl Agent {
    fn valid(&self, h: &Handle) -> bool {
        h.boot == self.boot
            && h.incarnation == self.incarnation
            && h.id.len() == 32
            && h.id.bytes().all(|c| c.is_ascii_hexdigit())
    }
    fn dispatch(&self, req: Request) -> Response {
        use Request::*;
        let handle = match &req {
            Facts {} => {
                return Response::Facts {
                    arch: std::env::consts::ARCH.into(),
                    boot: self.boot.clone(),
                    incarnation: self.incarnation.clone(),
                };
            }
            Hello { .. } => return Response::Invalid {},
            Start { handle, .. }
            | Inspect { handle }
            | Signal { handle, .. }
            | Output { handle, .. }
            | Release { handle } => handle,
        };
        if !self.valid(handle) {
            return Response::Unknown {};
        }
        let mut jobs = self.jobs.lock().unwrap();
        if let Start {
            handle,
            argv,
            env,
            stdin,
        } = req
        {
            if jobs.contains_key(&handle.id) {
                return Response::Conflict {};
            }
            if jobs.len() >= 256 || jobs.values().flatten().count() >= 16 {
                return Response::Full {};
            }
            let slot = jobs.entry(handle.id).or_default();
            *slot = Some(Job::start(argv, env, stdin));
            return slot.as_ref().unwrap().inspect();
        }
        let Some(slot) = jobs.get_mut(&handle.id) else {
            return Response::Absent {};
        };
        let Some(job) = slot else {
            return Response::Released {};
        };
        job.refresh();
        match req {
            Inspect { .. } => job.inspect(),
            Signal { signal, .. } => job.signal(signal),
            Output { stream, offset, .. } => job.output(stream, offset),
            Release { .. } if job.finished() => {
                *slot = None;
                Response::Released {}
            }
            Release { .. } => Response::Conflict {},
            _ => unreachable!(),
        }
    }
}

fn serve(stream: UnixStream, agent: &Agent) {
    let mut io = Exchange {
        stream: &stream,
        deadline: Instant::now() + Duration::from_secs(10),
    };
    let Ok(Request::Hello { min, max }) = read_frame(&mut io) else {
        return;
    };
    let Some(version) = negotiate(min, max) else {
        let _ = write_frame(&mut io, &Response::Invalid {});
        return;
    };
    if write_frame(
        &mut io,
        &Response::Welcome {
            version,
            boot: agent.boot.clone(),
            incarnation: agent.incarnation.clone(),
        },
    )
    .is_err()
    {
        return;
    }
    if let Ok(req) = read_frame(&mut io) {
        let _ = write_frame(&mut io, &agent.dispatch(req));
    }
}

fn run() -> io::Result<()> {
    let socket = std::env::args_os()
        .nth(1)
        .ok_or(io::ErrorKind::InvalidInput)?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    let incarnation = fs::read_to_string("/proc/sys/kernel/random/uuid")?
        .trim()
        .to_owned();
    let agent = Arc::new(Agent {
        boot,
        incarnation,
        jobs: Mutex::default(),
    });
    // SAFETY: single-threaded startup. All later socket creation inherits owner-only permissions.
    unsafe { libc::umask(0o077) };
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600))?;
    let supervisor = agent.clone();
    thread::spawn(move || {
        loop {
            for job in supervisor.jobs.lock().unwrap().values_mut().flatten() {
                job.refresh();
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let peers = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = stream?;
        if peers.load(Ordering::Relaxed) >= 16 {
            continue;
        }
        peers.fetch_add(1, Ordering::Relaxed);
        let peers = peers.clone();
        let agent = agent.clone();
        thread::spawn(move || {
            serve(stream, &agent);
            peers.fetch_sub(1, Ordering::Relaxed);
        });
    }
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("guest agent startup or listener failure");
        std::process::exit(1);
    }
}
