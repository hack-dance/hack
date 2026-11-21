//! Opt-in engine diagnostics, separate from command stdout and structured errors.
//! Only fixed command/endpoint names and numeric counters reach the inherited file.
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

pub const FILE_ENV: &str = "HACK_ENGINE_REQUESTS_FILE";
static ENABLED: AtomicBool = AtomicBool::new(false);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Default, Serialize)]
struct Counts {
    engine_requests: u64,
    engine_connections: u64,
    engine_transports: u64,
    endpoints: BTreeMap<String, u64>,
}
struct Session {
    file: File,
    role: &'static str,
    command: &'static str,
    counts: Counts,
}

/// Install file diagnostics from the explicitly inherited environment setting.
/// Failure to open/write diagnostics never changes command output or status.
/// This temporary counter record will join span attrs when timing records land.
#[must_use]
pub fn from_environment(args: &[String]) -> ReportOnDrop {
    if let Some(path) = std::env::var_os(FILE_ENV).filter(|p| std::path::Path::new(p).is_absolute())
    {
        if let Ok(file) = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
        {
            if !file.metadata().is_ok_and(|m| m.is_file()) {
                return ReportOnDrop;
            }
            if let Ok(mut session) = SESSION.lock() {
                let (role, command) = command_name(args);
                *session = Some(Session {
                    file,
                    role,
                    command,
                    counts: Counts::default(),
                });
                ENABLED.store(true, Ordering::Relaxed);
            }
        }
    }
    ReportOnDrop
}

/// Runtime children with a closed environment inherit only this diagnostic setting.
/// This is for runtime executables, never guest/application or credential processes.
pub(crate) fn inherit(command: &mut std::process::Command) {
    if let Some(path) = std::env::var_os(FILE_ENV) {
        command.env(FILE_ENV, path);
    }
}

pub struct ReportOnDrop;
impl Drop for ReportOnDrop {
    fn drop(&mut self) {
        report();
    }
}

#[derive(Serialize)]
struct Report<'a> {
    role: &'static str,
    command: &'static str,
    #[serde(flatten)]
    counts: &'a Counts,
}

/// Flush a disjoint counter delta while an owner remains alive. Call before its
/// ready notification; final reporting then contains only subsequent work.
pub fn checkpoint() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut session) = SESSION.lock() {
        if let Some(session) = session.as_mut() {
            let record = Report {
                role: session.role,
                command: session.command,
                counts: &session.counts,
            };
            if let Ok(mut bytes) = serde_json::to_vec(&record) {
                bytes.push(b'\n');
                // SAFETY: the live owned file descriptor is retained throughout.
                // Serialize appenders across processes without touching runtime locks.
                if unsafe { libc::flock(session.file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                    let written = session.file.write_all(&bytes).is_ok();
                    // SAFETY: unlock the same live descriptor locked above.
                    unsafe { libc::flock(session.file.as_raw_fd(), libc::LOCK_UN) };
                    if written {
                        session.counts = Counts::default();
                    }
                }
            }
        }
    }
}

/// Flush before an explicit exit that skips destructors. Idempotent per process.
pub fn report() {
    checkpoint();
    ENABLED.store(false, Ordering::Relaxed);
}

fn count(update: impl FnOnce(&mut Counts)) {
    if ENABLED.load(Ordering::Relaxed) {
        if let Ok(mut session) = SESSION.lock() {
            if let Some(session) = session.as_mut() {
                update(&mut session.counts);
            }
        }
    }
}
pub(super) fn record(method: &str, path: &str) {
    count(|c| {
        c.engine_requests += 1;
        *c.endpoints.entry(key(method, path)).or_default() += 1;
    });
}
pub(super) fn connection() {
    count(|c| c.engine_connections += 1);
}
pub(super) fn transport() {
    count(|c| c.engine_transports += 1);
}

pub(super) fn instrument(
    builder: reqwest::blocking::ClientBuilder,
) -> reqwest::blocking::ClientBuilder {
    if ENABLED.load(Ordering::Relaxed) {
        builder.connector_layer(ConnectionLayer)
    } else {
        builder
    }
}

fn command_name(args: &[String]) -> (&'static str, &'static str) {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    let args = if args.first() == Some(&"--candidate-root") {
        &args[2.min(args.len())..]
    } else {
        &args[..]
    };
    match args {
        ["graph", "native", "serve", ..] => ("owner", "graph.native.serve"),
        ["graph", "serve" | "serve-restore", ..] => ("owner", "graph.serve"),
        ["graph", "publish-bridge", ..] => ("owner", "graph.publish-bridge"),
        ["node", "serve", ..] => ("owner", "node.serve"),
        ["__job_supervisor", ..] => ("owner", "job.supervisor"),
        ["graph", "native", ..] => ("runtime", "graph.native"),
        ["graph", "exec" | "exec-interactive", ..] => ("runtime", "graph.exec"),
        ["graph", "logs" | "logs-follow", ..] => ("runtime", "graph.logs"),
        ["graph", ..] => ("runtime", "graph"),
        ["runtime", "up", ..] => ("runtime", "runtime.up"),
        ["runtime", "down", ..] => ("runtime", "runtime.down"),
        ["runtime", "engine-info", ..] => ("runtime", "runtime.engine-info"),
        ["runtime", ..] => ("runtime", "runtime"),
        ["project", ..] => ("runtime", "project"),
        _ => ("runtime", "other"),
    }
}

fn key(method: &str, path: &str) -> String {
    let method = match method {
        "GET" | "HEAD" | "POST" | "DELETE" | "PUT" => method,
        _ => "OTHER",
    };
    let route = path
        .strip_prefix("http://hack-local")
        .unwrap_or(path)
        .split('?')
        .next()
        .unwrap_or("");
    let route = route.strip_prefix("/v1.53").unwrap_or(route);
    // Collection actions precede object routes. Return only constants, never a
    // path segment supplied by the caller. Image references may contain slashes.
    const FIXED: &[&str] = &[
        "/version",
        "/info",
        "/_ping",
        "/events",
        "/system/df",
        "/build/prune",
        "/containers/json",
        "/containers/create",
        "/containers/prune",
        "/images/json",
        "/images/create",
        "/images/load",
        "/images/prune",
        "/networks",
        "/networks/create",
        "/networks/prune",
        "/volumes",
        "/volumes/create",
        "/volumes/prune",
    ];
    const OBJECTS: &[(&str, &str, &str)] = &[
        ("/containers/", "/json", "/containers/{id}/json"),
        ("/containers/", "/start", "/containers/{id}/start"),
        ("/containers/", "/stop", "/containers/{id}/stop"),
        ("/containers/", "/wait", "/containers/{id}/wait"),
        ("/containers/", "/logs", "/containers/{id}/logs"),
        ("/containers/", "/exec", "/containers/{id}/exec"),
        ("/containers/", "/archive", "/containers/{id}/archive"),
        ("/containers/", "/update", "/containers/{id}/update"),
        ("/containers/", "/kill", "/containers/{id}/kill"),
        ("/exec/", "/start", "/exec/{id}/start"),
        ("/exec/", "/json", "/exec/{id}/json"),
        ("/exec/", "/resize", "/exec/{id}/resize"),
        ("/networks/", "/connect", "/networks/{id}/connect"),
        ("/networks/", "/disconnect", "/networks/{id}/disconnect"),
        ("/images/", "/json", "/images/{id}/json"),
    ];
    let endpoint = FIXED
        .iter()
        .copied()
        .find(|fixed| *fixed == route)
        .or_else(|| {
            OBJECTS.iter().find_map(|(prefix, suffix, template)| {
                let id = route.strip_prefix(prefix)?.strip_suffix(suffix)?;
                (!id.is_empty() && (*prefix == "/images/" || !id.contains('/')))
                    .then_some(*template)
            })
        })
        .or_else(|| {
            [
                ("/containers/", "/containers/{id}"),
                ("/images/", "/images/{id}"),
                ("/networks/", "/networks/{id}"),
                ("/volumes/", "/volumes/{id}"),
            ]
            .iter()
            .find_map(|(prefix, template)| {
                route
                    .strip_prefix(prefix)
                    .filter(|id| !id.is_empty() && (*prefix == "/images/" || !id.contains('/')))
                    .map(|_| *template)
            })
        })
        .unwrap_or("/other");
    format!("{method} {endpoint}")
}

/// Counts actual HTTP connector calls rather than assuming each request opens a socket.
#[derive(Clone)]
pub(super) struct ConnectionLayer;
#[derive(Clone)]
pub(super) struct ConnectionService<S>(S);
impl<S> tower_layer::Layer<S> for ConnectionLayer {
    type Service = ConnectionService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        ConnectionService(inner)
    }
}
impl<S: tower_service::Service<T>, T> tower_service::Service<T> for ConnectionService<S> {
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;
    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }
    fn call(&mut self, request: T) -> Self::Future {
        connection();
        self.0.call(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_endpoints_never_return_ids_or_query_values() {
        for (path, expected) in [
            ("/v1.53/images/create?fromImage=hidden", "/images/create"),
            ("/v1.53/containers/prune", "/containers/prune"),
            (
                "/v1.53/images/registry.invalid/team/app:tag/json",
                "/images/{id}/json",
            ),
            (
                "/v1.53/containers/hidden/logs?secret=value",
                "/containers/{id}/logs",
            ),
            ("/v1.53/exec/hidden/start", "/exec/{id}/start"),
            ("/unexpected/hidden/value", "/other"),
        ] {
            assert_eq!(key("POST", path), format!("POST {expected}"));
        }
        assert_eq!(key("hidden", "/version"), "OTHER /version");
        assert_eq!(
            command_name(&["unknown-private-argument".into()]),
            ("runtime", "other")
        );
    }
}
