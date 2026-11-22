//! Run under guest supervision with a socket in a private runtime directory.
use hack_vm_protocol::{Frame, MAX_FRAME, MAX_JOBS, client::Exchange};
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

#[derive(Default)]
struct Registry {
    admitted: Option<u128>,
    live: HashMap<String, Job>,
}

struct Agent {
    boot: String,
    incarnation: String,
    kernel: String,
    jobs: Mutex<Registry>,
}

impl Agent {
    fn dispatch(&self, req: Request) -> Response {
        use Request::*;
        let handle = match &req {
            List {} => {
                let jobs = self.jobs.lock().unwrap();
                let mut handles: Vec<_> = jobs
                    .live
                    .keys()
                    .map(|id| Handle {
                        boot: self.boot.clone(),
                        incarnation: self.incarnation.clone(),
                        id: id.clone(),
                    })
                    .collect();
                handles.sort_unstable_by(|a, b| a.id.cmp(&b.id));
                return Response::Handles { handles };
            }
            Facts {} => {
                let Ok(elapsed) =
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                else {
                    return Response::Unknown {};
                };

                return Response::Facts {
                    unix_ms: elapsed.as_millis() as u64,
                    kernel: self.kernel.clone(),
                    agent_version: env!("CARGO_PKG_VERSION").into(),
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
        if self.boot != handle.boot || self.incarnation != handle.incarnation {
            return Response::Unknown {};
        }
        let Ok(counter) = u128::from_str_radix(&handle.id, 16) else {
            return Response::Invalid {};
        };
        let mut jobs = self.jobs.lock().unwrap();
        let retired_or_live = jobs.admitted.is_some_and(|last| counter <= last);
        if let Start {
            handle,
            argv,
            env,
            cwd,
            stdin,
        } = req
        {
            if retired_or_live {
                return Response::Conflict {};
            }
            if jobs.live.len() >= usize::from(MAX_JOBS) {
                return Response::Full {};
            }
            jobs.admitted = Some(counter);
            return jobs
                .live
                .entry(handle.id)
                .or_insert_with(|| Job::start(argv, env, cwd, stdin))
                .inspect();
        }
        let Some(job) = jobs.live.get_mut(&handle.id) else {
            return if retired_or_live {
                Response::Released {}
            } else {
                Response::Absent {}
            };
        };
        job.refresh();
        match req {
            Inspect { .. } => job.inspect(),
            Signal { signal, .. } => job.signal(signal),
            Output { stream, offset, .. } => job.output(stream, offset),
            Release { .. } if job.finished() => {
                jobs.live.remove(&handle.id);
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
    let Ok(Frame {
        channel: 0,
        end: true,
        message: Request::Hello { min, max, .. },
    }) = read_frame(&mut io)
    else {
        return;
    };
    let Some(version) = negotiate(min, max) else {
        let _ = write_frame(&mut io, 0, true, &Response::Invalid {});
        return;
    };
    if write_frame(
        &mut io,
        0,
        true,
        &Response::Welcome {
            capabilities: 0,
            max_frame: MAX_FRAME as u32,
            max_jobs: MAX_JOBS,
            output_retention: jobs::CAP as u32,
            version,
            boot: agent.boot.clone(),
            incarnation: agent.incarnation.clone(),
        },
    )
    .is_err()
    {
        return;
    }
    let mut last = 0;
    loop {
        io.deadline = Instant::now() + Duration::from_secs(10);
        let Ok(Frame {
            channel,
            end: true,
            message,
        }) = read_frame(&mut io)
        else {
            return;
        };
        if channel <= last {
            return;
        }
        last = channel;
        if write_frame(&mut io, channel, true, &agent.dispatch(message)).is_err() {
            return;
        }
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
        kernel: fs::read_to_string("/proc/sys/kernel/osrelease")?
            .trim()
            .to_owned(),
        jobs: Mutex::default(),
    });
    // SAFETY: single-threaded startup. All later socket creation inherits owner-only permissions.
    unsafe { libc::umask(0o077) };
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600))?;
    let supervisor = agent.clone();
    thread::spawn(move || {
        loop {
            for job in supervisor.jobs.lock().unwrap().live.values_mut() {
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
