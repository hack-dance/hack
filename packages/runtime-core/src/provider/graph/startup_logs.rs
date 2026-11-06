//! Transient bounded output of failed services for a foreground startup failure.
//!
//! Startup cleanup removes failed containers and their logs, and persisted failure
//! evidence ([`super::startup_failure`]) stays value-free. Before that cleanup the
//! foreground owner reads a bounded tail of each failed service and attaches it to
//! its failure reply on stderr only. The tail is never journaled, written to a
//! receipt or copied into any file: application output may hold managed values,
//! which the frontend redacts before display.
//!
//! Bounds: at most [`MAX_SERVICES`] services, Docker's last [`MAX_LINES`] lines of
//! each (stdout and stderr together), and [`MAX_STREAM_BYTES`] of whole lines per
//! stream. A line is never cut, so a value cannot be split across the boundary
//! where a redaction would miss it; a line longer than the byte bound is omitted.
use super::{Receipt, hex};
use crate::{
    CandidateError,
    error::{StartupLogTail, StartupLogsDiagnostic},
    project::execution::Observation,
};
use std::collections::BTreeMap;

/// Failed services reported in one reply; the recorded startup failure comes first.
pub(super) const MAX_SERVICES: usize = 3;
/// Lines requested from the engine for each service, both streams together.
pub(super) const MAX_LINES: u16 = 64;
/// UTF-8 bytes of whole lines kept for each stream, so at most 8 KiB per service.
pub(super) const MAX_STREAM_BYTES: usize = 4 * 1024;

impl CandidateError {
    /// Attach a transient tail. Only the foreground failure reply may carry it.
    pub(crate) fn with_startup_logs(mut self, logs: Option<StartupLogsDiagnostic>) -> Self {
        if let Some(logs) = logs.filter(valid) {
            self.startup_logs = Some(Box::new(logs));
        }
        self
    }
}

fn valid(logs: &StartupLogsDiagnostic) -> bool {
    logs.version == 1
        && (1..=MAX_SERVICES).contains(&logs.services.len())
        && logs.services.iter().enumerate().all(|(index, tail)| {
            service_name(&tail.service)
                && !logs.services[..index]
                    .iter()
                    .any(|other| other.service == tail.service)
                && tail.stdout.len() <= MAX_STREAM_BYTES
                && tail.stderr.len() <= MAX_STREAM_BYTES
        })
}

fn service_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// Select up to [`MAX_SERVICES`] owned containers: the recorded startup failure
/// (including a required listener's zero exit), then other failed observations in
/// service-name order. Returns `(service, container ID)` pairs.
pub(super) fn select(
    receipt: &Receipt,
    observed: &BTreeMap<String, Observation>,
) -> Vec<(String, String)> {
    let owned = |service: &str| {
        receipt
            .resources
            .get(&format!("container:{service}"))
            .and_then(|resource| resource.id.clone())
            .filter(|id| hex(id, 64) && service_name(service))
    };
    let mut selected: Vec<(String, String)> = Vec::new();
    if let Some(failure) = &receipt.startup_failure
        && observed.contains_key(&failure.service)
        && owned(&failure.service).as_deref() == Some(failure.container.as_str())
    {
        selected.push((failure.service.clone(), failure.container.clone()));
    }
    for (service, observation) in observed {
        if selected.len() >= MAX_SERVICES {
            break;
        }
        if observation.failed() && !selected.iter().any(|(name, _)| name == service) {
            if let Some(id) = owned(service) {
                selected.push((service.clone(), id));
            }
        }
    }
    selected.truncate(MAX_SERVICES);
    selected
}

/// Decode Docker's multiplexed log frames and bound each stream. Malformed frames
/// yield no tail rather than a partial guess.
pub(super) fn tail(service: &str, frames: &[u8]) -> Option<StartupLogTail> {
    let (stdout, stderr) = demux(frames)?;
    let (stdout, out_truncated) = bound(&stdout);
    let (stderr, err_truncated) = bound(&stderr);
    Some(StartupLogTail {
        service: service.into(),
        stdout,
        stderr,
        truncated: out_truncated || err_truncated,
    })
}

fn demux(mut frames: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    while !frames.is_empty() {
        let header = frames.get(..8)?;
        if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] {
            return None;
        }
        let size = u32::from_be_bytes(header[4..8].try_into().ok()?) as usize;
        let payload = frames.get(8..8usize.checked_add(size)?)?;
        if header[0] == 1 {
            stdout.extend_from_slice(payload);
        } else {
            stderr.extend_from_slice(payload);
        }
        frames = &frames[8 + size..];
    }
    Some((stdout, stderr))
}

/// Keep the last whole lines within [`MAX_LINES`] and [`MAX_STREAM_BYTES`]. A final
/// line without a newline is complete: the process wrote it before exiting.
fn bound(bytes: &[u8]) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    let body = text.strip_suffix('\n').unwrap_or(&text);
    if body.is_empty() {
        return (String::new(), false);
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    let mut truncated = false;
    for line in body.rsplit('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let cost = line.len() + usize::from(!kept.is_empty());
        if kept.len() == usize::from(MAX_LINES) || size + cost > MAX_STREAM_BYTES {
            truncated = true;
            break;
        }
        kept.push(line);
        size += cost;
    }
    kept.reverse();
    (kept.join("\n"), truncated)
}

/// Read the tails of failed services of `run` before cleanup removes them. Every
/// failure is ignored: the original startup error and cleanup stay authoritative.
/// The engine lease is released before returning.
#[cfg(target_os = "macos")]
pub(super) fn capture(candidate: &crate::Candidate, run: &str) -> Option<StartupLogsDiagnostic> {
    let engine = super::Engine::connect_cleanup(candidate).ok()?;
    let (receipt, _) = super::load(candidate, &engine, run).ok()?;
    let mut observed = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        let Some(service) = key.strip_prefix("container:") else {
            continue;
        };
        if resource.kind != super::Kind::Container || resource.id.is_none() {
            continue;
        }
        // Inspection rechecks owned labels and immutable identity before any read.
        if let Ok(Some(value)) = super::inspect_resource(&engine, &receipt, resource)
            && let Ok(observation) = super::observation(&value)
        {
            observed.insert(service.to_owned(), observation);
        }
    }
    let services: Vec<_> = select(&receipt, &observed)
        .into_iter()
        .filter_map(|(service, id)| {
            let frames = engine.logs_tail_frames(&id, MAX_LINES).ok()?;
            tail(&service, &frames)
        })
        .collect();
    (!services.is_empty()).then_some(StartupLogsDiagnostic {
        version: 1,
        services,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(stream: u8, payload: &str) -> Vec<u8> {
        let mut bytes = vec![stream, 0, 0, 0];
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload.as_bytes());
        bytes
    }
    fn receipt() -> Receipt {
        let container = |key: &str, id: char| json!({"key":key,"kind":"container","name":format!("hkg-{key}"),"id":id.to_string().repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))});
        serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"failed-retained",
            "readiness":{"api":"started","db":"healthy","init":"completed","web":"started","worker":"started"},
            "resources":{
                "container:api":container("api", '1'),
                "container:db":container("db", '2'),
                "container:init":container("init", '3'),
                "container:web":container("web", '4'),
                "container:worker":container("worker", '5')
            }
        }))
        .unwrap()
    }

    #[test]
    fn reply_carries_only_the_last_whole_lines_within_bounds() {
        let mut frames = Vec::new();
        for line in 0..100 {
            frames.extend(frame(1, &format!("out {line}\n")));
        }
        frames.extend(frame(2, "first error\r\nfinal error without newline"));
        let tail = tail("web", &frames).unwrap();
        let lines: Vec<_> = tail.stdout.lines().collect();
        assert_eq!(lines.len(), usize::from(MAX_LINES));
        assert_eq!(lines[0], "out 36");
        assert_eq!(lines.last(), Some(&"out 99"));
        assert_eq!(tail.stderr, "first error\nfinal error without newline");
        assert!(tail.truncated);

        let long = format!("{}\n", "x".repeat(1000));
        let frames: Vec<u8> = (0..10).flat_map(|_| frame(1, &long)).collect();
        let tail = super::tail("web", &frames).unwrap();
        assert!(tail.stdout.len() <= MAX_STREAM_BYTES);
        assert_eq!(tail.stdout.lines().count(), 4);
        assert!(tail.stdout.lines().all(|line| line.len() == 1000));
        assert!(tail.truncated);

        // A line beyond the byte bound is omitted whole, never cut.
        let tail = super::tail("web", &frame(2, &"y".repeat(MAX_STREAM_BYTES + 1))).unwrap();
        assert_eq!(tail.stderr, "");
        assert!(tail.truncated);

        let error = CandidateError::new("graph_startup_application_failed", "Startup failed.")
            .with_startup_logs(Some(StartupLogsDiagnostic {
                version: 1,
                services: vec![super::tail("web", &frame(2, "synthetic failure\n")).unwrap()],
            }));
        let reply: serde_json::Value = serde_json::to_value(&error).unwrap();
        assert_eq!(reply["code"], "graph_startup_application_failed");
        assert_eq!(
            reply["startup_logs"],
            json!({"version":1,"services":[{"service":"web","stdout":"","stderr":"synthetic failure","truncated":false}]})
        );
    }

    #[test]
    fn malformed_frames_and_unbounded_replies_are_refused() {
        assert!(tail("web", &[3, 0, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(tail("web", &[1, 0, 0, 0, 0, 0, 0, 9, b'x']).is_none());
        assert!(tail("web", &[1, 0, 0]).is_none());
        assert_eq!(tail("web", &[]).unwrap().stdout, "");
        let one = |service: &str, stdout: String| StartupLogTail {
            service: service.into(),
            stdout,
            stderr: String::new(),
            truncated: false,
        };
        for services in [
            vec![],
            vec![one("web", "x".repeat(MAX_STREAM_BYTES + 1))],
            vec![one("../web", String::new())],
            vec![one("web", String::new()), one("web", String::new())],
            (0..=MAX_SERVICES)
                .map(|n| one(&format!("s{n}"), String::new()))
                .collect(),
        ] {
            let error = CandidateError::new("graph_budget", "Startup failed.").with_startup_logs(
                Some(StartupLogsDiagnostic {
                    version: 1,
                    services,
                }),
            );
            assert!(error.startup_logs.is_none());
        }
        assert!(
            !serde_json::to_string(&CandidateError::new("graph_budget", "Startup failed."))
                .unwrap()
                .contains("startup_logs")
        );
    }

    #[test]
    fn recorded_failure_leads_a_bounded_failed_selection() {
        let mut receipt = receipt();
        super::super::startup_failure::record(&mut receipt, "web", Observation::Exited { code: 0 })
            .unwrap();
        let observed = BTreeMap::from([
            ("api".to_string(), Observation::Exited { code: 3 }),
            ("db".to_string(), Observation::Dead),
            ("init".to_string(), Observation::Exited { code: 0 }),
            ("web".to_string(), Observation::Exited { code: 0 }),
            ("worker".to_string(), Observation::Exited { code: 1 }),
        ]);
        let selected = select(&receipt, &observed);
        assert_eq!(
            selected,
            vec![
                ("web".to_string(), "4".repeat(64)),
                ("api".to_string(), "1".repeat(64)),
                ("db".to_string(), "2".repeat(64)),
            ]
        );
        // A completed initializer and a removed container are not failures to tail.
        let observed = BTreeMap::from([("init".to_string(), Observation::Exited { code: 0 })]);
        assert!(select(&receipt, &observed).is_empty());
    }

    #[test]
    fn persisted_failure_evidence_cannot_hold_application_output() {
        let mut receipt = receipt();
        super::super::startup_failure::record(&mut receipt, "api", Observation::Exited { code: 3 })
            .unwrap();
        let mut persisted = serde_json::to_value(&receipt).unwrap();
        assert!(!persisted.to_string().contains("startup_logs"));
        persisted["startup_failure"]["stderr"] = json!("synthetic output");
        assert!(serde_json::from_value::<Receipt>(persisted.clone()).is_err());
        persisted["startup_failure"]
            .as_object_mut()
            .unwrap()
            .remove("stderr");
        persisted["startup_logs"] = json!({"version":1,"services":[]});
        assert!(serde_json::from_value::<Receipt>(persisted).is_err());
    }
}
