//! Opt-in process-local dispatch counts. Only fixed endpoint templates leave this
//! module; object identities, query values and payloads are never retained.
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

static ENABLED: AtomicBool = AtomicBool::new(false);
static COUNTS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// Enable counting for this command process. The returned guard reports on stderr
/// on normal return, including errors. It cannot report after abrupt termination.
pub fn enable() -> ReportOnDrop {
    ENABLED.store(true, Ordering::Relaxed);
    ReportOnDrop
}

/// Command-lifetime report guard. Counts include all threads in this process,
/// but do not include requests made by child processes or other owners.
pub struct ReportOnDrop;

#[derive(Serialize)]
struct Report<'a> {
    kind: &'static str,
    total: u64,
    endpoints: &'a BTreeMap<String, u64>,
}

impl Drop for ReportOnDrop {
    fn drop(&mut self) {
        report();
    }
}

/// Emit the final record before an explicit command exit that skips destructors.
/// Calling this more than once emits at most one report.
pub fn report() {
    if ENABLED.swap(false, Ordering::Relaxed) {
        if let Ok(counts) = COUNTS.lock() {
            let report = Report {
                kind: "engine_requests",
                total: counts.values().sum(),
                endpoints: &counts,
            };
            if let Ok(json) = serde_json::to_string(&report) {
                // Diagnostic output failure must not change command status.
                use std::io::Write;
                let _ = writeln!(std::io::stderr().lock(), "{json}");
            }
        }
    }
}

pub(super) fn record(method: &str, path: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut counts) = COUNTS.lock() {
        *counts.entry(key(method, path)).or_default() += 1;
    }
}

fn key(method: &str, path: &str) -> String {
    let method = match method {
        "GET" | "HEAD" | "POST" | "DELETE" | "PUT" => method,
        _ => "OTHER",
    };
    let path = path.strip_prefix("http://hack-local").unwrap_or(path);
    let route = path.split('?').next().unwrap_or("");
    let route = route.strip_prefix("/v1.53").unwrap_or(route);
    let parts: Vec<_> = route.split('/').collect();
    let endpoint = match parts.as_slice() {
        ["", "version"] => "/version".into(),
        ["", "info"] => "/info".into(),
        ["", "build", "prune"] => "/build/prune".into(),
        ["", "_ping"] => "/_ping".into(),
        ["", "events"] => "/events".into(),
        ["", "system", "df"] => "/system/df".into(),
        ["", "containers", "json"] => "/containers/json".into(),
        ["", "images", "json"] => "/images/json".into(),
        ["", "networks"] => "/networks".into(),
        ["", "containers", "create"] => "/containers/create".into(),
        ["", "images", "load"] => "/images/load".into(),
        ["", "networks", "create"] => "/networks/create".into(),
        ["", "volumes"] => "/volumes".into(),
        ["", "volumes", "create"] => "/volumes/create".into(),
        ["", resource, _] if ["containers", "images", "networks", "volumes"].contains(resource) => {
            format!("/{resource}/{{id}}")
        }
        ["", resource, _, action]
            if ["containers", "images", "networks", "exec"].contains(resource)
                && [
                    "json",
                    "start",
                    "stop",
                    "wait",
                    "logs",
                    "exec",
                    "resize",
                    "archive",
                    "update",
                    "connect",
                    "disconnect",
                    "kill",
                ]
                .contains(action) =>
        {
            format!("/{resource}/{{id}}/{action}")
        }
        _ => "/other".into(),
    };
    format!("{method} {endpoint}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_omit_object_and_query_values() {
        assert_eq!(
            key("GET", "/v1.53/containers/private-id/logs?secret=value"),
            "GET /containers/{id}/logs"
        );
        assert_eq!(
            key(
                "POST",
                "http://hack-local/v1.53/containers/private-id/stop?t=7"
            ),
            "POST /containers/{id}/stop"
        );
        assert_eq!(
            key("POST", "/v1.53/exec/private-id/start"),
            "POST /exec/{id}/start"
        );
        assert_eq!(key("GET", "/unexpected/private/value"), "GET /other");
        assert_eq!(key("private", "/version"), "OTHER /version");
    }
}
