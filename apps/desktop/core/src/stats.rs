//! Point-in-time Compose usage and the desktop's rolling service history.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::models::{ProjectRuntime, ProjectsPayload};
use crate::viewmodel::InstanceKey;

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
pub const HISTORY_WINDOW: Duration = Duration::from_secs(600);
const MAX_SAMPLES: usize = 120;

/// The bare JSON from `hack usage --json --details --no-host`. A successful
/// no-samples response omits `containers`.
#[derive(Debug, Default, Deserialize)]
pub struct StatsReport {
    #[serde(default)]
    pub containers: Vec<ContainerUsage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    pub container_id: Option<String>,
    pub project: String,
    pub service: String,
    pub started_at: Option<String>,
    pub cpu_percent: Option<f64>,
    #[serde(default, deserialize_with = "crate::usage::byte_count")]
    pub mem_used_bytes: Option<u64>,
    pub configured_memory_limit_bytes: Option<u64>,
    #[serde(default, deserialize_with = "crate::usage::byte_count")]
    pub net_input_bytes: Option<u64>,
    #[serde(default, deserialize_with = "crate::usage::byte_count")]
    pub net_output_bytes: Option<u64>,
    #[serde(default, deserialize_with = "crate::usage::byte_count")]
    pub block_input_bytes: Option<u64>,
    #[serde(default, deserialize_with = "crate::usage::byte_count")]
    pub block_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServiceKey {
    pub instance: InstanceKey,
    pub project_id: Option<String>,
    pub service: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MemoryLimit {
    #[default]
    Unknown,
    Unlimited,
    Bytes(u64),
}

#[derive(Debug, Clone, Copy)]
pub struct StatsPoint {
    pub at: Instant,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<u64>,
    pub memory_limit: MemoryLimit,
    pub net_in_per_second: Option<f64>,
    pub net_out_per_second: Option<f64>,
    pub disk_per_second: Option<f64>,
    pub disk_written_bytes: Option<u64>,
}

#[derive(Debug, Default)]
pub struct StatsHistory {
    services: HashMap<ServiceKey, Series>,
}

type Counters = [Option<u64>; 4];

#[derive(Debug, Default)]
struct Series {
    points: VecDeque<StatsPoint>,
    last: Option<CounterSample>,
}

#[derive(Debug)]
struct CounterSample {
    at: Instant,
    containers: Vec<ContainerCounters>,
}

#[derive(Debug)]
struct ContainerCounters {
    id: String,
    started_at: Option<String>,
    totals: Counters,
}

/// Docker uses either the 12-character ID or the full ID in its JSON.
fn docker_id(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

impl StatsHistory {
    /// Drop aged-out samples and inactive series, even when the CLI reports
    /// nothing. A failed read also breaks the baseline for the next rate.
    pub fn record(&mut self, projects: &ProjectsPayload, report: &StatsReport, now: Instant) {
        self.prune(now);
        let mut by_service: HashMap<(&str, &str), Vec<&ContainerUsage>> = HashMap::new();
        for row in &report.containers {
            by_service
                .entry((&row.project, &row.service))
                .or_default()
                .push(row);
        }
        for rows in by_service.values_mut() {
            rows.sort_unstable_by_key(|row| row.container_id.as_deref().map(docker_id));
        }

        for project in projects.projects.iter().filter(|p| !p.is_native()) {
            let instances = project
                .runtime
                .iter()
                .map(|rt| (InstanceKey::project(&project.name), rt))
                .chain(project.branch_runtime.iter().map(|branch| {
                    (
                        InstanceKey::branch(&project.name, &branch.branch),
                        &branch.runtime,
                    )
                }));
            for (instance, runtime) in instances {
                self.record_instance(
                    runtime,
                    &instance,
                    project.project_id.as_deref(),
                    &by_service,
                    now,
                );
            }
        }
        // A missing/partial sample, stopped service or absent project must
        // never be used as a base for the next counter delta.
        for series in self.services.values_mut() {
            if series.last.as_ref().is_some_and(|sample| sample.at != now) {
                series.last = None;
            }
        }
    }

    fn record_instance(
        &mut self,
        runtime: &ProjectRuntime,
        instance: &InstanceKey,
        project_id: Option<&str>,
        by_service: &HashMap<(&str, &str), Vec<&ContainerUsage>>,
        now: Instant,
    ) {
        let Some(compose_project) = runtime.project.as_deref() else {
            return;
        };
        for service in &runtime.services {
            let Some(rows) = by_service.get(&(compose_project, service.service.as_str())) else {
                continue;
            };
            let expected_ids: Option<Vec<_>> = service
                .containers
                .iter()
                .filter(|c| {
                    c.is_running()
                        && c.labels.get("hack.lifecycle.process").map(String::as_str)
                            != Some("true")
                })
                .map(|c| c.id.as_deref().map(docker_id))
                .collect();
            let Some(mut expected_ids) = expected_ids else {
                continue;
            };
            expected_ids.sort_unstable();
            // The Compose name alone can be reused by a different checkout.
            // Reject partial reads and a set that changed since the listing.
            if !expected_ids.iter().copied().map(Some).eq(rows
                .iter()
                .map(|row| row.container_id.as_deref().map(docker_id)))
            {
                continue;
            }
            let key = ServiceKey {
                instance: instance.clone(),
                project_id: project_id.map(str::to_owned),
                service: service.service.clone(),
            };
            self.services.entry(key).or_default().push(rows, now);
        }
    }

    pub fn prune(&mut self, now: Instant) {
        self.services.retain(|_, series| {
            while series
                .points
                .front()
                .is_some_and(|p| now.saturating_duration_since(p.at) >= HISTORY_WINDOW)
            {
                series.points.pop_front();
            }
            !series.points.is_empty()
        });
    }

    /// Kept when the service stops, until all its points age out.
    pub fn points(
        &self,
        key: &ServiceKey,
        now: Instant,
    ) -> impl DoubleEndedIterator<Item = &StatsPoint> {
        self.services
            .get(key)
            .into_iter()
            .flat_map(|s| &s.points)
            .filter(move |p| now.saturating_duration_since(p.at) < HISTORY_WINDOW)
    }

    /// Whether the most recent attempt had a complete sample for this service.
    #[must_use]
    pub fn fresh(&self, key: &ServiceKey, now: Instant) -> bool {
        self.services
            .get(key)
            .and_then(|series| series.last.as_ref())
            .is_some_and(|sample| now.saturating_duration_since(sample.at) < SAMPLE_INTERVAL * 2)
    }
}

impl Series {
    fn push(&mut self, rows: &[&ContainerUsage], now: Instant) {
        let counters = CounterSample {
            at: now,
            containers: rows
                .iter()
                .map(|r| ContainerCounters {
                    id: r
                        .container_id
                        .as_deref()
                        .map(docker_id)
                        .unwrap_or_default()
                        .into(),
                    started_at: r.started_at.clone(),
                    totals: [
                        r.net_input_bytes,
                        r.net_output_bytes,
                        r.block_input_bytes,
                        r.block_output_bytes,
                    ],
                })
                .collect(),
        };
        let [net_in, net_out, disk_read, disk_written] = self
            .last
            .as_ref()
            .map_or([None; 4], |last| counters.rates_since(last));
        self.last = Some(counters);

        let cpu_percent = rows
            .iter()
            .map(|r| r.cpu_percent.filter(|v| v.is_finite() && *v >= 0.0))
            .sum::<Option<f64>>()
            .filter(|v| v.is_finite());
        let memory_bytes = sum_bytes(rows.iter().map(|r| r.mem_used_bytes));
        let memory_limit = if rows
            .iter()
            .any(|r| r.configured_memory_limit_bytes == Some(0))
        {
            MemoryLimit::Unlimited
        } else {
            sum_bytes(rows.iter().map(|r| r.configured_memory_limit_bytes))
                .map_or(MemoryLimit::Unknown, MemoryLimit::Bytes)
        };
        if self.points.len() == MAX_SAMPLES {
            self.points.pop_front();
        }
        self.points.push_back(StatsPoint {
            at: now,
            cpu_percent,
            memory_bytes,
            memory_limit,
            net_in_per_second: net_in,
            net_out_per_second: net_out,
            disk_per_second: disk_read.zip(disk_written).map(|(r, w)| r + w),
            disk_written_bytes: sum_bytes(rows.iter().map(|r| r.block_output_bytes)),
        });
    }
}

impl CounterSample {
    fn rates_since(&self, previous: &Self) -> [Option<f64>; 4] {
        let elapsed = self.at.saturating_duration_since(previous.at);
        if elapsed.is_zero()
            || elapsed >= SAMPLE_INTERVAL * 2
            || self.containers.len() != previous.containers.len()
        {
            return [None; 4];
        }
        let pairs = self.containers.iter().zip(&previous.containers);
        if pairs
            .clone()
            .any(|(now, before)| now.id != before.id || now.started_at != before.started_at)
        {
            return [None; 4];
        }
        std::array::from_fn(|i| {
            let delta = sum_bytes(
                pairs
                    .clone()
                    .map(|(now, before)| now.totals[i]?.checked_sub(before.totals[i]?)),
            )?;
            #[allow(clippy::cast_precision_loss)] // display rate from Docker's rounded counters
            Some(delta as f64 / elapsed.as_secs_f64())
        })
    }
}

fn sum_bytes(mut bytes: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    bytes.try_fold(0_u64, |total, n| total.checked_add(n?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BranchRuntime, Container, ProjectRow, RuntimeService};

    fn instance(compose: &str, ids: &[&str]) -> ProjectRuntime {
        ProjectRuntime {
            project: Some(compose.into()),
            services: vec![RuntimeService {
                service: "api".into(),
                containers: ids
                    .iter()
                    .map(|id| Container {
                        id: Some((*id).into()),
                        state: "running".into(),
                        ..Container::default()
                    })
                    .collect(),
            }],
            ..ProjectRuntime::default()
        }
    }

    fn projects() -> ProjectsPayload {
        ProjectsPayload {
            projects: vec![ProjectRow {
                name: "shop".into(),
                project_id: Some("registered-shop".into()),
                runtime: Some(instance("shop", &["0123456789ab", "111111111111"])),
                branch_runtime: vec![BranchRuntime {
                    branch: "preview".into(),
                    runtime: instance("shop--preview", &["222222222222"]),
                    ..BranchRuntime::default()
                }],
                ..ProjectRow::default()
            }],
            ..ProjectsPayload::default()
        }
    }

    fn key(instance: InstanceKey) -> ServiceKey {
        ServiceKey {
            instance,
            project_id: Some("registered-shop".into()),
            service: "api".into(),
        }
    }

    fn report() -> StatsReport {
        let std_row = |id: &str, project: &str, limit| ContainerUsage {
            container_id: Some(id.into()),
            project: project.into(),
            service: "api".into(),
            started_at: Some("old start".into()),
            cpu_percent: Some(1.5),
            mem_used_bytes: Some(100),
            configured_memory_limit_bytes: limit,
            net_input_bytes: Some(500),
            net_output_bytes: Some(1000),
            block_input_bytes: Some(500),
            block_output_bytes: Some(1000),
        };
        StatsReport {
            containers: vec![
                std_row("0123456789abcdef", "shop", Some(1000)),
                std_row("111111111111", "shop", Some(1000)),
                std_row("222222222222", "shop--preview", Some(0)),
            ],
        }
    }

    #[test]
    fn samples_past_and_current_replicas_and_isolates_branch_and_registration() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let main = key(InstanceKey::project("shop"));
        let preview = key(InstanceKey::branch("shop", "preview"));
        let mut report = report();
        history.record(&projects(), &report, now);
        let sample = history.points(&main, now).next_back().unwrap();
        assert_eq!(sample.net_in_per_second, None);
        assert_eq!(sample.cpu_percent, Some(3.0));
        assert_eq!(sample.memory_bytes, Some(200));
        assert_eq!(sample.memory_limit, MemoryLimit::Bytes(2000));
        assert_eq!(
            history
                .points(&preview, now)
                .next_back()
                .unwrap()
                .memory_limit,
            MemoryLimit::Unlimited
        );
        let mut unrelated = main.clone();
        unrelated.project_id = Some("new-registration".into());
        assert_eq!(history.points(&unrelated, now).count(), 0);

        report.containers[0].net_input_bytes = Some(600);
        report.containers[1].net_input_bytes = Some(530);
        report.containers[2].net_input_bytes = Some(610);
        report.containers.reverse();
        let t = now + Duration::from_secs(6);
        history.record(&projects(), &report, t);
        let sample = history.points(&main, t).next_back().unwrap();
        assert_eq!(sample.net_in_per_second, Some(130.0 / 6.0));
        assert_eq!(sample.net_out_per_second, Some(0.0));
        assert_eq!(
            history
                .points(&preview, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            Some(110.0 / 6.0)
        );
    }

    #[test]
    fn reset_missing_replica_and_gap_do_not_create_network_spikes() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let main = key(InstanceKey::project("shop"));
        let mut sample = report();
        history.record(&projects(), &sample, now);
        sample.containers[0].started_at = Some("new start".into());
        sample.containers[0].net_input_bytes = Some(600);
        let t = now + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&main, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );
        // A reset in just one replica must not be hidden by the other going up.
        sample.containers[0].net_input_bytes = Some(100);
        sample.containers[1].net_input_bytes = Some(5000);
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&main, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );
        let mut partial = report();
        partial.containers.remove(1);
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &partial, t);
        assert!(!history.fresh(&main, t));
        assert_eq!(history.points(&main, t).count(), 3);
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&main, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );
        let t = t + HISTORY_WINDOW;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&main, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );
    }

    #[test]
    fn bounded_ring_keeps_recent_points_and_reclaims_expired_services() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let main = key(InstanceKey::project("shop"));
        let listing = projects();
        let report = report();
        for seconds in 0..150 {
            history.record(&listing, &report, now + Duration::from_secs(seconds));
        }
        let t = now + Duration::from_secs(149);
        assert_eq!(history.points(&main, t).count(), MAX_SAMPLES);
        assert_eq!(
            history.points(&main, t).next().unwrap().at,
            now + Duration::from_secs(30)
        );
        history.record(&listing, &StatsReport::default(), t + HISTORY_WINDOW);
        assert!(history.services.is_empty());
    }

    #[test]
    fn older_samples_keep_counters_and_do_not_treat_engine_capacity_as_a_compose_limit() {
        let report: StatsReport = serde_json::from_value(serde_json::json!({
            "runtime_ok": true,
            "containers": [{
                "containerId": "222222222222",
                "project": "shop--preview",
                "service": "api",
                "memUsedBytes": 212.3,
                "memLimitBytes": 8_000,
                "netInputBytes": 100.5,
                "netOutputBytes": null
            }]
        }))
        .unwrap();
        assert_eq!(report.containers[0].mem_used_bytes, Some(212));
        assert_eq!(report.containers[0].net_input_bytes, Some(101));
        let preview = key(InstanceKey::branch("shop", "preview"));
        let mut history = StatsHistory::default();
        let now = Instant::now();
        history.record(&projects(), &report, now);
        assert_eq!(
            history
                .points(&preview, now)
                .next_back()
                .unwrap()
                .memory_limit,
            MemoryLimit::Unknown
        );
    }
}
