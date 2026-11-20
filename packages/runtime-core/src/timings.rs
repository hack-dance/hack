//! Opt-in observations only. Names and outcomes cannot carry runtime inputs.
//! Offsets use each process's monotonic clock; parents shift child offsets at spawn.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

pub const SCHEMA: &str = "hack.timings/1";
pub const PREFIX: &str = "HACK_TIMINGS ";
pub const REQUEST_ARGUMENT: &str = "--internal-timings";
pub const RECORD_LIMIT: usize = 2048;
const MAX_NUMBER: u64 = (1 << 53) - 1;

/// Reviewed vocabulary shared with the CLI. Never derive a name from input.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Step {
    #[serde(rename = "command.total")]
    CommandTotal,
    #[serde(rename = "cli.dispatch")]
    CliDispatch,
    #[serde(rename = "project.discover")]
    ProjectDiscover,
    #[serde(rename = "plan.compile")]
    PlanCompile,
    #[serde(rename = "env.resolve")]
    EnvResolve,
    #[serde(rename = "runtime.request")]
    RuntimeRequest,
    #[serde(rename = "runtime.dispatch")]
    RuntimeDispatch,
    #[serde(rename = "vm.boot")]
    VmBoot,
    #[serde(rename = "vm.stop")]
    VmStop,
    #[serde(rename = "container.start")]
    ContainerStart,
    #[serde(rename = "container.stop")]
    ContainerStop,
    #[serde(rename = "container.exec")]
    ContainerExec,
    #[serde(rename = "container.run")]
    ContainerRun,
    #[serde(rename = "container.inspect")]
    ContainerInspect,
    #[serde(rename = "compose.up")]
    ComposeUp,
    #[serde(rename = "compose.down")]
    ComposeDown,
    #[serde(rename = "compose.restart")]
    ComposeRestart,
    #[serde(rename = "compose.exec")]
    ComposeExec,
    #[serde(rename = "compose.run")]
    ComposeRun,
    #[serde(rename = "compose.ps")]
    ComposePs,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Error,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub step: Step,
    pub start_offset_us: u64,
    pub duration_us: u64,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub schema: String,
    /// True means records were omitted; never treat a bounded report as complete.
    pub truncated: bool,
    pub records: Vec<Record>,
}

impl Default for Report {
    fn default() -> Self {
        Self {
            schema: SCHEMA.into(),
            truncated: false,
            records: Vec::new(),
        }
    }
}

impl Report {
    /// Validate at the process boundary, before admitting any records.
    pub fn valid(&self) -> bool {
        self.schema == SCHEMA
            && self.records.len() <= RECORD_LIMIT
            && self.records.iter().enumerate().all(|(index, record)| {
                record.id == index as u64 + 1
                    && record.parent_id.is_none_or(|id| id > 0 && id < record.id)
                    && record.start_offset_us <= MAX_NUMBER
                    && record.duration_us <= MAX_NUMBER
                    && record
                        .start_offset_us
                        .checked_add(record.duration_us)
                        .is_some_and(|end| end <= MAX_NUMBER)
                    && (record.cached.is_none()
                        || (record.cached == Some(true) && record.outcome == Outcome::Skipped))
            })
    }

    /// Join atomically under an observed parent request, without comparing clocks.
    /// The caller supplies the spawn offset, never an offset claimed by a child.
    pub fn join(&mut self, child: &Self, parent_id: u64, spawn_offset_us: u64) -> bool {
        if !self.valid()
            || !child.valid()
            || parent_id == 0
            || parent_id > self.records.len() as u64
        {
            return false;
        }
        let base = self.records.len() as u64;
        if self.records.len() + child.records.len() > RECORD_LIMIT {
            self.truncated = true;
            return false;
        }
        let mut shifted = Vec::with_capacity(child.records.len());
        for record in &child.records {
            let Some(start) = record.start_offset_us.checked_add(spawn_offset_us) else {
                return false;
            };
            if start
                .checked_add(record.duration_us)
                .is_none_or(|end| end > MAX_NUMBER)
            {
                return false;
            }
            shifted.push(Record {
                id: base + record.id,
                parent_id: Some(record.parent_id.map_or(parent_id, |id| base + id)),
                start_offset_us: start,
                ..record.clone()
            });
        }
        self.records.extend(shifted);
        self.truncated |= child.truncated;
        true
    }
}

struct Collector {
    origin: Instant,
    report: Report,
}
static COLLECTOR: OnceLock<Mutex<Collector>> = OnceLock::new();

/// Called once at entry only for an explicit request. Creates no files or threads.
pub fn enable() {
    let _ = COLLECTOR.set(Mutex::new(Collector {
        origin: Instant::now(),
        report: Report::default(),
    }));
}

/// A result wrapper: disabled collection neither reads a clock nor allocates.
/// Parentage is explicit, so scopes cannot leak across concurrent operations.
pub fn measure<T, E>(
    step: Step,
    parent_id: Option<u64>,
    action: impl FnOnce(Option<u64>) -> Result<T, E>,
) -> Result<T, E> {
    let Some(lock) = COLLECTOR.get() else {
        return action(None);
    };
    let id = lock.lock().ok().and_then(|mut collector| {
        if collector.report.records.len() >= RECORD_LIMIT {
            collector.report.truncated = true;
            return None;
        }
        let id = collector.report.records.len() as u64 + 1;
        let start = micros(collector.origin.elapsed());
        collector.report.records.push(Record {
            id,
            parent_id: parent_id.filter(|parent| *parent > 0 && *parent < id),
            step,
            start_offset_us: start,
            duration_us: 0,
            outcome: Outcome::Error,
            cached: None,
        });
        Some(id)
    });
    let result = action(id);
    if let Some(id) = id
        && let Ok(mut collector) = lock.lock()
    {
        let end = micros(collector.origin.elapsed());
        let record = &mut collector.report.records[id as usize - 1];
        record.duration_us = end.saturating_sub(record.start_offset_us);
        record.outcome = if result.is_ok() {
            Outcome::Ok
        } else {
            Outcome::Error
        };
    }
    result
}

fn micros(duration: std::time::Duration) -> u64 {
    duration.as_micros().min(u128::from(MAX_NUMBER)) as u64
}

/// Best-effort diagnostics must never replace the command's result or error.
/// The caller owns the captured stderr pipe. Nothing is emitted when disabled.
pub fn emit() {
    use std::io::Write;
    if let Some(lock) = COLLECTOR.get()
        && let Ok(collector) = lock.lock()
        && let Ok(json) = serde_json::to_string(&collector.report)
    {
        let _ = writeln!(std::io::stderr().lock(), "{PREFIX}{json}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: u64, parent_id: Option<u64>) -> Record {
        Record {
            id,
            parent_id,
            step: Step::RuntimeDispatch,
            start_offset_us: 5,
            duration_us: 10,
            outcome: Outcome::Ok,
            cached: None,
        }
    }
    #[test]
    fn closed_format_round_trip_and_rejections() {
        let report = Report {
            records: vec![record(1, None)],
            ..Report::default()
        };
        let bytes = serde_json::to_vec(&report).unwrap();
        let decoded: Report = serde_json::from_slice(&bytes).unwrap();
        assert!(decoded.valid());
        assert_eq!(report, decoded);
        assert!(serde_json::from_str::<Step>("\"user.value\"").is_err());
        let mut invalid = decoded;
        invalid.records[0].cached = Some(true);
        assert!(!invalid.valid());
        invalid.records[0].outcome = Outcome::Skipped;
        assert!(invalid.valid());
        invalid.records[0].parent_id = Some(1);
        assert!(!invalid.valid());
    }
    #[test]
    fn child_join_shifts_offsets_and_remaps_nested_parents() {
        let mut parent = Report {
            records: vec![record(1, None)],
            ..Report::default()
        };
        let child = Report {
            records: vec![record(1, None), record(2, Some(1))],
            ..Report::default()
        };
        assert!(parent.join(&child, 1, 100));
        assert_eq!(parent.records[1].id, 2);
        assert_eq!(parent.records[1].parent_id, Some(1));
        assert_eq!(parent.records[2].parent_id, Some(2));
        assert_eq!(parent.records[2].start_offset_us, 105);
        assert!(parent.valid());
        let before = parent.clone();
        assert!(!parent.join(&child, 99, 100));
        assert!(!parent.join(&child, 1, MAX_NUMBER));
        assert_eq!(parent, before);
    }
    #[test]
    fn disabled_wrapper_preserves_errors_and_has_no_span() {
        let result = measure(Step::VmBoot, None, |id| {
            assert_eq!(id, None);
            Err::<(), _>("unchanged")
        });
        assert_eq!(result, Err("unchanged"));
    }

    #[test]
    fn invalid_numbers_fields_and_bounded_joins_are_not_admitted() {
        let mut report = Report {
            records: vec![record(1, None)],
            ..Report::default()
        };
        let mut json = serde_json::to_value(&report).unwrap();
        json["records"][0]["detail"] = serde_json::json!("unreviewed");
        assert!(serde_json::from_value::<Report>(json).is_err());
        report.records[0].duration_us = MAX_NUMBER;
        assert!(!report.valid());
        report.records[0].duration_us = 10;
        report.schema = "unknown".into();
        assert!(!report.valid());
        report.schema = SCHEMA.into();
        report.records = (1..=RECORD_LIMIT as u64)
            .map(|id| record(id, None))
            .collect();
        let child = Report {
            records: vec![record(1, None)],
            ..Report::default()
        };
        assert!(!report.join(&child, 1, 100));
        assert!(report.truncated);
        assert_eq!(report.records.len(), RECORD_LIMIT);
        assert!(report.valid());
    }
}
