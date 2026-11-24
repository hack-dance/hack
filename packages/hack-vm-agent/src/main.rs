//! Run under guest supervision with a socket in a private runtime directory.
use hack_vm_protocol::{Frame, MAX_FRAME, MAX_JOBS, client::Exchange};
mod jobs;
use hack_vm_protocol::{Handle, Request, Response, negotiate, read_frame, write_frame};
use jobs::Job;
use std::{
    collections::HashMap,
    fs, io,
    os::unix::{
        fs::MetadataExt,
        net::{UnixListener, UnixStream},
    },
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Registry {
    admitted: Option<u128>,
    live: HashMap<String, Option<Job>>,
}

struct Agent {
    boot: String,
    incarnation: String,
    kernel: String,
    jobs: Mutex<Registry>,
    work: Condvar,
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
            jobs.live.insert(handle.id.clone(), None);
            drop(jobs);
            let job = Job::start(argv, env, cwd, stdin);
            let status = job.inspect();
            self.jobs.lock().unwrap().live.insert(handle.id, Some(job));
            self.work.notify_one();
            return status;
        }
        let Some(entry) = jobs.live.get_mut(&handle.id) else {
            return if retired_or_live {
                Response::Released {}
            } else {
                Response::Absent {}
            };
        };
        let Some(job) = entry else {
            return if matches!(req, Inspect { .. }) {
                Response::Unknown {}
            } else {
                Response::Conflict {}
            };
        };
        job.refresh();
        match req {
            Inspect { .. } => job.inspect(),
            Signal { signal, .. } => job.signal(signal),
            Output { stream, offset, .. } => job.output(stream, offset),
            Release { .. } if job.finished() => {
                if job.release().is_err() {
                    return Response::Unknown {};
                }
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
    io.deadline = Instant::now() + Duration::from_secs(10);
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
        let reply = agent.dispatch(message);
        io.deadline = Instant::now() + Duration::from_secs(10);
        if write_frame(&mut io, channel, true, &reply).is_err() {
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
        work: Condvar::new(),
    });
    let parent = std::path::Path::new(&socket)
        .parent()
        .ok_or(io::ErrorKind::InvalidInput)?;
    let meta = fs::symlink_metadata(parent)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // Single-threaded startup. An inherited SIG_IGN would auto-reap children.
    if unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) } == libc::SIG_ERR {
        return Err(io::Error::last_os_error());
    }
    let previous = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(&socket);
    unsafe { libc::umask(previous) };
    let listener = bound?;
    let supervisor = agent.clone();
    thread::Builder::new().spawn(move || {
        loop {
            let mut jobs = supervisor
                .work
                .wait_while(supervisor.jobs.lock().unwrap(), |registry| {
                    !registry.live.values().flatten().any(Job::needs_refresh)
                })
                .unwrap();
            for job in jobs.live.values_mut().flatten() {
                job.refresh();
            }
            drop(jobs);
            thread::sleep(Duration::from_millis(5));
        }
    })?;
    let peers = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            thread::sleep(Duration::from_millis(50));
            continue;
        };
        if peers.load(Ordering::Relaxed) >= 16 {
            continue;
        }
        peers.fetch_add(1, Ordering::Relaxed);
        let active = peers.clone();
        let agent = agent.clone();
        if thread::Builder::new()
            .spawn(move || {
                serve(stream, &agent);
                active.fetch_sub(1, Ordering::Relaxed);
            })
            .is_err()
        {
            peers.fetch_sub(1, Ordering::Relaxed);
        }
    }
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("guest agent startup or listener failure");
        std::process::exit(1);
    }
}
