//! The guest's memory peak for a boot, and the pool's short history of them.
//!
//! `guest-memory-peak.sh` keeps one status line in the guest for the current boot.
//! `runtime down` reads it once before the stop and appends it to
//! `guest-memory-peaks.json` beside the pool's owner record; `runtime status` reports
//! that file. This is a record only: nothing here changes a guest's size, and no failure
//! here may change what a start or a stop does. Every reader treats a missing, foreign or
//! malformed record as "no history".
use super::state;
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// Boots kept in the history.
const KEEP: usize = 5;
/// Graph runs listed with one boot; a home with more records none of them.
const MAX_GRAPHS: usize = 64;
/// Upper bound on the whole guest read in `runtime down`, connect and reply included.
pub(super) const READ_BUDGET: Duration = Duration::from_secs(2);
const FILE: &str = "guest-memory-peaks.json";
const VERSION: u32 = 1;
const GRAPH_DIRECTORIES: [&str; 2] = ["run/graphs", "run/native-graphs"];

/// Prints the sampler's status line for this owner and boot, or nothing. It always
/// exits 0: a guest that is not this boot yields no reading, never a failure.
pub(super) const READ_SCRIPT: &str = r#"set -u
test "$(cat /storage/.hack-local-owner 2>/dev/null)" = "${1-}" || exit 0
test "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" = "${2-}" || exit 0
cat /run/hack-local/memory-peak.status 2>/dev/null
exit 0"#;

/// One boot's status line. `None` fields are counters the guest could not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reading {
    /// Highest `MemTotal - MemAvailable` seen, in KiB.
    pub peak_kib: u64,
    /// Samples behind the peak, one every five seconds.
    pub samples: u64,
    pub total_kib: u64,
    /// Microseconds some task stalled on memory since boot.
    pub some_stall_us: Option<u64>,
    /// Microseconds every runnable task stalled on memory since boot.
    pub full_stall_us: Option<u64>,
    pub oom_kills: Option<u64>,
    pub major_faults: Option<u64>,
}

/// A graph run the home recorded when the reading was taken, running or retained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphRun {
    pub run: String,
    /// The run's plan id, when its receipt could be read.
    pub plan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Boot {
    pub boot_id: String,
    pub guest_memory_mib: u32,
    pub cpus: u32,
    pub reading: Reading,
    pub graphs: Vec<GraphRun>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    version: u32,
    boots: Vec<Boot>,
}

fn field(part: Option<&str>, name: &str) -> Option<Option<u64>> {
    let value = part?.strip_prefix(name)?.strip_prefix('=')?;
    if value == "unavailable" {
        return Some(None);
    }
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok().map(Some)
}

/// Decode the guest's status line. Anything but exactly the sampler's line, with at
/// least one sample and a peak no larger than the guest, is no reading.
pub(super) fn parse(output: &str) -> Option<Reading> {
    let line = output.strip_suffix('\n')?;
    if line.len() > 512 || line.contains('\n') {
        return None;
    }
    let mut parts = line.split(' ');
    if parts.next()? != "memory-peak-v1" {
        return None;
    }
    let reading = Reading {
        peak_kib: field(parts.next(), "peak_kib")??,
        samples: field(parts.next(), "samples")??,
        total_kib: field(parts.next(), "total_kib")??,
        some_stall_us: field(parts.next(), "some_us")?,
        full_stall_us: field(parts.next(), "full_us")?,
        oom_kills: field(parts.next(), "oom_kill")?,
        major_faults: field(parts.next(), "pgmajfault")?,
    };
    if parts.next().is_some() || reading.samples == 0 || reading.peak_kib > reading.total_kib {
        return None;
    }
    Some(reading)
}

fn is_run_id(name: &str) -> bool {
    name.len() == 32
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_plan_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Deserialize)]
struct PlanOnly {
    plan_id: Option<String>,
}

/// The graph runs under `state_root`, sorted. Empty when a directory cannot be listed or
/// holds more than [`MAX_GRAPHS`] runs: the list is context for a reading, not proof.
pub(super) fn graph_runs(state_root: &Path) -> Vec<GraphRun> {
    let mut runs = Vec::new();
    for directory in GRAPH_DIRECTORIES {
        let Ok(entries) = fs::read_dir(state_root.join(directory)) else {
            continue;
        };
        for entry in entries.take(MAX_GRAPHS + 1) {
            let Ok(entry) = entry else {
                return Vec::new();
            };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !is_run_id(&name) {
                continue;
            }
            if runs.len() == MAX_GRAPHS {
                return Vec::new();
            }
            let plan = state::read::<PlanOnly>(&entry.path().join("state.json"))
                .ok()
                .and_then(|receipt| receipt.plan_id)
                .filter(|plan| is_plan_id(plan));
            runs.push(GraphRun { run: name, plan });
        }
    }
    runs.sort_by(|a, b| a.run.cmp(&b.run));
    runs
}

fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

/// The recorded boots, oldest first. `None` when there is no usable record.
pub(super) fn history(root: &Path) -> Option<Vec<Boot>> {
    let history: History = state::read(&path(root)).ok()?;
    (history.version == VERSION && history.boots.len() <= KEEP).then_some(history.boots)
}

/// Append `boot`, replacing an earlier reading of the same boot, and keep the last
/// [`KEEP`]. The caller holds the pool's operation lock. An unusable record is replaced.
pub(super) fn record(root: &Path, boot: Boot) -> Result<(), CandidateError> {
    let mut boots = history(root).unwrap_or_default();
    boots.retain(|recorded| recorded.boot_id != boot.boot_id);
    boots.push(boot);
    let excess = boots.len().saturating_sub(KEEP);
    boots.drain(..excess);
    let target = path(root);
    // `state::write` refuses to replace a pending file. One left by an interrupted write of
    // this record is ours alone, under the lock the caller holds.
    match fs::remove_file(target.with_extension("pending")) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(state::io(error)),
    }
    state::write(
        &target,
        &History {
            version: VERSION,
            boots,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    const LINE: &str = "memory-peak-v1 peak_kib=3343816 samples=42 total_kib=6087220 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n";

    fn reading(peak_kib: u64) -> Reading {
        Reading {
            peak_kib,
            samples: 42,
            total_kib: 6_087_220,
            some_stall_us: Some(1_075_081),
            full_stall_us: Some(40_211),
            oom_kills: Some(0),
            major_faults: Some(2065),
        }
    }

    fn boot(id: &str, peak_kib: u64) -> Boot {
        Boot {
            boot_id: id.to_owned(),
            guest_memory_mib: 6144,
            cpus: 4,
            reading: reading(peak_kib),
            graphs: Vec::new(),
        }
    }

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-guest-memory-peak-{}-{}",
                std::process::id(),
                crate::next_test_scratch()
            ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn private_directory() -> Scratch {
        Scratch::new()
    }

    #[test]
    fn the_sampler_line_decodes_and_unavailable_counters_stay_unknown() {
        assert_eq!(parse(LINE), Some(reading(3_343_816)));
        let partial = "memory-peak-v1 peak_kib=10 samples=1 total_kib=20 some_us=unavailable full_us=unavailable oom_kill=unavailable pgmajfault=unavailable\n";
        assert_eq!(
            parse(partial),
            Some(Reading {
                peak_kib: 10,
                samples: 1,
                total_kib: 20,
                some_stall_us: None,
                full_stall_us: None,
                oom_kills: None,
                major_faults: None,
            })
        );
    }

    #[test]
    fn anything_but_the_exact_line_is_no_reading() {
        let no_samples = LINE.replace("samples=42", "samples=0");
        let no_total = LINE.replace("total_kib=6087220", "total_kib=unavailable");
        let above_total = LINE.replace("peak_kib=3343816", "peak_kib=6087221");
        let reordered = LINE.replace("peak_kib=3343816 samples=42", "samples=42 peak_kib=3343816");
        let negative = LINE.replace("oom_kill=0", "oom_kill=-1");
        let overflow = LINE.replace("pgmajfault=2065", "pgmajfault=99999999999999999999");
        let extra = LINE.replace('\n', " extra=1\n");
        let two_lines = format!("{LINE}{LINE}");
        for output in [
            "",
            "\n",
            LINE.trim_end(),
            "memory-peak-v2 peak_kib=1 samples=1 total_kib=2 some_us=0 full_us=0 oom_kill=0 pgmajfault=0\n",
            &no_samples,
            &no_total,
            &above_total,
            &reordered,
            &negative,
            &overflow,
            &extra,
            &two_lines,
        ] {
            assert_eq!(parse(output), None, "{output:?}");
        }
    }

    #[test]
    fn the_history_keeps_the_last_five_boots_and_one_reading_per_boot() {
        let directory = private_directory();
        let root = directory.path();
        assert_eq!(history(root), None);
        for index in 0..7_u64 {
            record(root, boot(&format!("boot-{index}"), 1000 + index)).unwrap();
        }
        // A second reading of the newest boot replaces the first.
        record(root, boot("boot-6", 2000)).unwrap();
        let boots = history(root).unwrap();
        assert_eq!(
            boots.iter().map(|b| b.boot_id.as_str()).collect::<Vec<_>>(),
            ["boot-2", "boot-3", "boot-4", "boot-5", "boot-6"]
        );
        assert_eq!(boots[4].reading.peak_kib, 2000);
        let mode = fs::metadata(path(root)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_unusable_record_or_an_interrupted_write_is_replaced() {
        let directory = private_directory();
        let root = directory.path();
        fs::write(path(root), b"{not json").unwrap();
        fs::set_permissions(path(root), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(path(root).with_extension("pending"), b"partial").unwrap();
        assert_eq!(history(root), None);
        record(root, boot("boot-a", 1)).unwrap();
        assert_eq!(history(root).unwrap().len(), 1);
        // A record from a later format is not read as this one.
        fs::write(path(root), br#"{"version":2,"boots":[]}"#).unwrap();
        assert_eq!(history(root), None);
    }

    #[test]
    fn graph_runs_list_run_ids_with_their_plan_when_the_receipt_reads() {
        let directory = private_directory();
        let state_root = directory.path();
        let run_a = "a".repeat(32);
        let run_b = "b".repeat(32);
        let plan = "c".repeat(64);
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(state_root.join("run/graphs").join(&run_b))
            .unwrap();
        builder
            .create(state_root.join("run/native-graphs").join(&run_a))
            .unwrap();
        builder
            .create(state_root.join("run/graphs/not-a-run"))
            .unwrap();
        let receipt = state_root
            .join("run/graphs")
            .join(&run_b)
            .join("state.json");
        fs::write(
            &receipt,
            format!(r#"{{"plan_id":"{plan}","phase":"running"}}"#),
        )
        .unwrap();
        fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            graph_runs(state_root),
            [
                GraphRun {
                    run: run_a,
                    plan: None
                },
                GraphRun {
                    run: run_b,
                    plan: Some(plan)
                },
            ]
        );
        assert_eq!(graph_runs(&state_root.join("absent")), []);
    }
}
