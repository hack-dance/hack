//! Point-in-time Compose usage and the desktop's rolling service history.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::models::{Container, ProjectRow, ProjectRuntime, ProjectsPayload, RuntimeService};
use crate::viewmodel::{InstanceKey, instance_runtimes};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
pub const HISTORY_WINDOW: Duration = Duration::from_secs(600);
const MAX_SAMPLES: usize = 120;

/// The bare JSON from `hack usage --json --details --no-host`. A successful
/// no-samples response omits `containers`.
#[derive(Debug, Default, Deserialize)]
pub struct StatsReport {
    #[serde(default)]
    pub containers: Vec<ContainerUsage>,
    #[serde(rename = "sampledAtUnixMs")]
    pub sampled_at_unix_ms: Option<u64>,
}

/// Local clock anchors around one CLI invocation.
#[derive(Clone, Copy)]
pub struct SampleClock {
    pub instant: Instant,
    wall: SystemTime,
}

impl SampleClock {
    #[must_use]
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            wall: SystemTime::now(),
        }
    }
}

impl StatsReport {
    /// Map the CLI's counter observation into the app's monotonic clock.
    /// Missing timing or a clock step leaves CPU and memory readable while
    /// breaking the rate baseline.
    pub fn anchor_time(&mut self, began: SampleClock, received: SampleClock) -> Instant {
        if let Some(observed) = self.observation_time(began, received) {
            return observed;
        }
        for row in &mut self.containers {
            row.started_at = None;
        }
        received.instant
    }

    fn observation_time(&self, began: SampleClock, received: SampleClock) -> Option<Instant> {
        let wall_elapsed = received.wall.duration_since(began.wall).ok()?;
        let mono_elapsed = received.instant.saturating_duration_since(began.instant);
        // Allow for clock reads on either side of ordinary scheduling
        // jitter and the CLI timestamp's millisecond resolution.
        if wall_elapsed.abs_diff(mono_elapsed) > Duration::from_millis(20) {
            return None;
        }
        let stamp = UNIX_EPOCH.checked_add(Duration::from_millis(self.sampled_at_unix_ms?))?;
        let age = received.wall.duration_since(stamp).ok()?;
        let observed = received.instant.checked_sub(age)?;
        (observed >= began.instant).then_some(observed)
    }
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
    #[serde(default)]
    pub io_counter_error_bytes: IoCounterErrorBytes,
}

/// An upper bound on the rounding error of each printed Docker counter.
/// Missing precision prevents rate calculations for that counter.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IoCounterErrorBytes {
    pub net_input: Option<u64>,
    pub net_output: Option<u64>,
    pub block_input: Option<u64>,
    pub block_output: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServiceKey {
    instance: InstanceKey,
    owner: ServiceOwner,
    service: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ServiceOwner {
    Registered(String),
    Checkout(PathBuf),
}

impl ServiceKey {
    /// A registered project uses its own ID. A name reused by a different
    /// unregistered checkout cannot inherit that checkout's history.
    #[must_use]
    pub fn new(
        instance: InstanceKey,
        project: &ProjectRow,
        runtime: Option<&ProjectRuntime>,
        service: &str,
    ) -> Option<Self> {
        let owner = match project.project_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => ServiceOwner::Registered(id.into()),
            None => {
                let dir = runtime
                    .and_then(|rt| rt.working_dir.as_deref())
                    .or(instance.checkout.as_deref())
                    .or_else(|| {
                        project
                            .repo_root
                            .as_deref()
                            .filter(|_| instance.branch.is_none())
                    })?;
                let dir = Path::new(dir);
                if !dir.is_absolute() {
                    return None;
                }
                ServiceOwner::Checkout(dir.into())
            }
        };
        Some(Self {
            instance,
            owner,
            service: service.into(),
        })
    }
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
    pub network_per_second: Option<f64>,
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
    error: Counters,
}

/// Docker uses either the 12-character ID or the full ID in its JSON.
fn docker_id(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

fn measurable(container: &Container) -> bool {
    container.is_running()
        && container
            .labels
            .get("hack.lifecycle.process")
            .map(String::as_str)
            != Some("true")
}

fn replica_ids(service: &RuntimeService) -> Option<Vec<&str>> {
    let mut ids: Vec<_> = service
        .containers
        .iter()
        .filter(|container| measurable(container))
        .map(|container| container.id.as_deref().map(docker_id))
        .collect::<Option<_>>()?;
    ids.sort_unstable();
    Some(ids)
}

#[must_use]
pub fn has_running_services(projects: &ProjectsPayload) -> bool {
    projects
        .projects
        .iter()
        .filter(|p| !p.is_native())
        .flat_map(instance_runtimes)
        .flat_map(|(_, runtime)| &runtime.services)
        .flat_map(|service| &service.containers)
        .any(measurable)
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
            for (instance, runtime) in instance_runtimes(project) {
                self.record_instance(runtime, &instance, project, &by_service, now);
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
        project: &ProjectRow,
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
            let Some(expected_ids) = replica_ids(service) else {
                continue;
            };
            // The Compose name alone can be reused by a different checkout.
            // Reject partial reads and a set that changed since the listing.
            if !expected_ids.iter().copied().map(Some).eq(rows
                .iter()
                .map(|row| row.container_id.as_deref().map(docker_id)))
            {
                continue;
            }
            let Some(key) =
                ServiceKey::new(instance.clone(), project, Some(runtime), &service.service)
            else {
                continue;
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

    /// The latest complete sample, while it still matches current replicas.
    #[must_use]
    pub fn current(
        &self,
        key: &ServiceKey,
        runtime: &ProjectRuntime,
        now: Instant,
    ) -> Option<&StatsPoint> {
        let series = self.services.get(key)?;
        let sample = series.last.as_ref()?;
        let service = runtime.services.iter().find(|s| s.service == key.service)?;
        let expected = replica_ids(service)?;
        series.points.back().filter(|_| {
            now.saturating_duration_since(sample.at) < SAMPLE_INTERVAL * 2
                && expected
                    .into_iter()
                    .eq(sample.containers.iter().map(|c| c.id.as_str()))
        })
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
                    error: [
                        r.io_counter_error_bytes.net_input,
                        r.io_counter_error_bytes.net_output,
                        r.io_counter_error_bytes.block_input,
                        r.io_counter_error_bytes.block_output,
                    ],
                })
                .collect(),
        };
        let rates = self
            .last
            .as_ref()
            .map_or_else(IoRates::default, |last| counters.rates_since(last));
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
            net_in_per_second: rates.net_in,
            net_out_per_second: rates.net_out,
            network_per_second: rates.network,
            disk_per_second: rates.disk,
            disk_written_bytes: sum_bytes(rows.iter().map(|r| r.block_output_bytes)),
        });
    }
}

#[derive(Default)]
struct IoRates {
    net_in: Option<f64>,
    net_out: Option<f64>,
    network: Option<f64>,
    disk: Option<f64>,
}

#[derive(Clone, Copy)]
struct CounterDelta {
    bytes: u64,
    error: u64,
}

impl CounterDelta {
    fn combined(self, other: Self) -> Option<Self> {
        Some(Self {
            bytes: self.bytes.checked_add(other.bytes)?,
            error: self.error.checked_add(other.error)?,
        })
    }

    fn rate(self, elapsed: Duration) -> Option<f64> {
        // A bucket crossing at high cumulative totals can look like a
        // large burst. Render a gap when rounding could account for
        // at least a quarter of the apparent change.
        if self.error > 0 && self.bytes <= self.error.saturating_mul(4) {
            return None;
        }
        #[allow(clippy::cast_precision_loss)] // display estimate
        Some(self.bytes as f64 / elapsed.as_secs_f64())
    }
}

impl CounterSample {
    fn rates_since(&self, previous: &Self) -> IoRates {
        let elapsed = self.at.saturating_duration_since(previous.at);
        if elapsed.is_zero()
            || elapsed >= SAMPLE_INTERVAL * 2
            || self.containers.len() != previous.containers.len()
        {
            return IoRates::default();
        }
        let pairs = self.containers.iter().zip(&previous.containers);
        if pairs.clone().any(|(now, before)| {
            now.id != before.id
                || now.started_at.as_ref().is_none_or(String::is_empty)
                || now.started_at != before.started_at
        }) {
            return IoRates::default();
        }
        let [net_in, net_out, disk_read, disk_write] = std::array::from_fn(|i| {
            let bytes = sum_bytes(
                pairs
                    .clone()
                    .map(|(now, before)| now.totals[i]?.checked_sub(before.totals[i]?)),
            )?;
            let error = sum_bytes(
                pairs
                    .clone()
                    .map(|(now, before)| now.error[i]?.checked_add(before.error[i]?)),
            )?;
            Some(CounterDelta { bytes, error })
        });
        let both = |first: Option<CounterDelta>, second: Option<CounterDelta>| {
            first?.combined(second?)?.rate(elapsed)
        };
        IoRates {
            network: both(net_in, net_out),
            disk: both(disk_read, disk_write),
            net_in: net_in.and_then(|delta| delta.rate(elapsed)),
            net_out: net_out.and_then(|delta| delta.rate(elapsed)),
        }
    }
}

fn sum_bytes(mut bytes: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    bytes.try_fold(0_u64, |total, n| total.checked_add(n?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BranchCheckout, BranchCopy, BranchRuntime, Container, ProjectRow, RuntimeService,
    };
    use crate::source::Snapshot;
    use crate::viewmodel::{AppModel, Event};

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
            owner: ServiceOwner::Registered("registered-shop".into()),
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
            io_counter_error_bytes: IoCounterErrorBytes {
                net_input: Some(0),
                net_output: Some(0),
                block_input: Some(0),
                block_output: Some(0),
            },
        };
        StatsReport {
            containers: vec![
                std_row("0123456789abcdef", "shop", Some(1000)),
                std_row("111111111111", "shop", Some(1000)),
                std_row("222222222222", "shop--preview", Some(0)),
            ],
            ..StatsReport::default()
        }
    }

    fn select_sidebar_copy(listing: &ProjectsPayload, checkout: &str) -> (InstanceKey, ProjectRow) {
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(Ok(Snapshot {
            cli_version: "test".into(),
            projects: listing.clone(),
            daemon: None,
            doctor: None,
            daemon_compatible: None,
        })));
        let copy = model
            .list()
            .running
            .into_iter()
            .flat_map(|row| row.branches)
            .find(|row| row.key.checkout.as_deref() == Some(checkout))
            .expect("running copy in the sidebar");
        model.apply(Event::SelectInstance(copy.key));
        (model.selected_key().unwrap(), model.selected_row().unwrap())
    }

    #[test]
    fn observed_branch_history_uses_the_sidebar_checkout_and_records_once() {
        let checkout = "/work/shop-preview";
        let working_dir = format!("{checkout}/.hack");
        let mut listing = projects();
        let project = &mut listing.projects[0];
        let runtime = &mut project.branch_runtime[0].runtime;
        runtime.working_dir = Some(working_dir.clone());
        runtime.services[0].containers[0].working_dir = Some(working_dir);
        project.branch_copies.push(BranchCopy {
            branch: Some("preview".into()),
            checkout: BranchCheckout {
                root: checkout.into(),
                kind: "worktree".into(),
            },
            compose_project: Some("shop--preview".into()),
            runtime: Some(runtime.clone()),
            ..BranchCopy::default()
        });

        let (instance, row) = select_sidebar_copy(&listing, checkout);
        assert_eq!(
            instance,
            InstanceKey::branch_at("shop", "preview", Some(checkout.into()))
        );
        let runtime = row.runtime.as_ref().unwrap();
        let selected = ServiceKey::new(instance, &row, Some(runtime), "api").unwrap();
        let now = Instant::now();
        let mut history = StatsHistory::default();
        history.record(&listing, &report(), now);
        assert_eq!(history.points(&selected, now).count(), 1);
        assert_eq!(
            history
                .current(&selected, runtime, now)
                .unwrap()
                .cpu_percent,
            Some(1.5)
        );
        assert_eq!(
            history
                .points(&key(InstanceKey::branch("shop", "preview")), now)
                .count(),
            0
        );
    }

    #[test]
    fn linked_base_runtime_alone_starts_sampling_and_keeps_its_own_history() {
        let checkout = "/work/shop-linked";
        let mut listing = projects();
        let project = &mut listing.projects[0];
        project.project_id = None;
        project.repo_root = Some("/work/shop".into());
        project.branch_runtime.clear();
        project.branch_copies.push(BranchCopy {
            branch_name: "linked".into(),
            checkout: BranchCheckout {
                root: checkout.into(),
                kind: "worktree".into(),
            },
            compose_project: Some("shop".into()),
            runtime: project.runtime.take(),
            ..BranchCopy::default()
        });

        let (instance, row) = select_sidebar_copy(&listing, checkout);
        assert_eq!(instance.checkout.as_deref(), Some(checkout));
        assert!(instance.branch.is_none());
        let runtime = row.runtime.as_ref().unwrap();
        let selected = ServiceKey::new(instance, &row, Some(runtime), "api").unwrap();
        assert!(has_running_services(&listing));
        let now = Instant::now();
        let mut history = StatsHistory::default();
        history.record(&listing, &report(), now);
        assert_eq!(history.points(&selected, now).count(), 1);
        assert_eq!(
            history
                .current(&selected, runtime, now)
                .unwrap()
                .cpu_percent,
            Some(3.0)
        );
        let primary = ServiceKey::new(
            InstanceKey::project("shop"),
            &listing.projects[0],
            None,
            "api",
        )
        .unwrap();
        assert_eq!(history.points(&primary, now).count(), 0);
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
        unrelated.owner = ServiceOwner::Registered("new-registration".into());
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
        assert!(
            history
                .current(&main, projects().projects[0].runtime.as_ref().unwrap(), t)
                .is_none()
        );
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
    fn unknown_container_start_and_rounding_do_not_look_like_measured_traffic() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let preview = key(InstanceKey::branch("shop", "preview"));
        let mut sample = report();
        let row = &mut sample.containers[2];
        row.started_at = None;
        row.net_input_bytes = Some(1_230_000_000);
        row.io_counter_error_bytes.net_input = Some(5_000_000);
        history.record(&projects(), &sample, now);
        sample.containers[2].net_input_bytes = Some(1_330_000_000);
        let t = now + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&preview, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );

        sample.containers[2].started_at = Some("recognized start".into());
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        sample.containers[2].net_input_bytes = Some(1_340_000_000);
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&preview, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );

        sample.containers[2].net_input_bytes = Some(1_440_000_000);
        let t = t + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        assert_eq!(
            history
                .points(&preview, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            Some(20_000_000.0)
        );
    }

    #[test]
    fn reusing_an_unregistered_compose_name_in_another_checkout_starts_a_new_series() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let mut listing = projects();
        let project = &mut listing.projects[0];
        project.project_id = None;
        project.runtime.as_mut().unwrap().working_dir = Some("/work/first/.hack".into());
        let key_for = |project: &ProjectRow| {
            ServiceKey::new(
                InstanceKey::project("shop"),
                project,
                project.runtime.as_ref(),
                "api",
            )
            .unwrap()
        };
        let first = key_for(project);
        history.record(&listing, &report(), now);
        let runtime = listing.projects[0].runtime.as_mut().unwrap();
        runtime.working_dir = Some("/work/second/.hack".into());
        runtime.services[0].containers[0].id = Some("333333333333".into());
        let second = key_for(&listing.projects[0]);
        let mut sample = report();
        sample.containers[0].container_id = Some("333333333333".into());
        let t = now + SAMPLE_INTERVAL;
        history.record(&listing, &sample, t);
        assert_ne!(first, second);
        assert_eq!(history.points(&first, t).next_back().unwrap().at, now);
        assert_eq!(history.points(&second, t).count(), 1);
        assert_eq!(
            history
                .points(&second, t)
                .next_back()
                .unwrap()
                .net_in_per_second,
            None
        );
    }

    #[test]
    fn lifecycle_processes_do_not_start_background_usage_reads() {
        let mut listing = projects();
        assert!(has_running_services(&listing));
        let project = &mut listing.projects[0];
        project.branch_runtime.clear();
        for container in &mut project.runtime.as_mut().unwrap().services[0].containers {
            container
                .labels
                .insert("hack.lifecycle.process".into(), "true".into());
        }
        assert!(!has_running_services(&listing));
    }

    #[test]
    fn a_replacement_replica_keeps_history_but_invalidates_current_metrics() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let mut listing = projects();
        let main = key(InstanceKey::project("shop"));
        history.record(&listing, &report(), now);
        let t = now + Duration::from_secs(1);
        let runtime = listing.projects[0].runtime.as_mut().unwrap();
        assert!(history.current(&main, runtime, t).is_some());
        runtime.services[0].containers[0].id = Some("333333333333".into());
        assert!(history.current(&main, runtime, t).is_none());
        assert_eq!(history.points(&main, t).count(), 1);
    }

    #[test]
    fn combined_traffic_and_disk_rates_can_resolve_with_one_idle_rounded_counter() {
        let mut history = StatsHistory::default();
        let now = Instant::now();
        let preview = key(InstanceKey::branch("shop", "preview"));
        let mut sample = report();
        sample.containers[2].net_output_bytes = Some(4200);
        sample.containers[2].io_counter_error_bytes.net_output = Some(50);
        sample.containers[2].io_counter_error_bytes.block_output = Some(50);
        history.record(&projects(), &sample, now);
        sample.containers[2].net_input_bytes = Some(1_000_500);
        sample.containers[2].block_input_bytes = Some(1_000_500);
        let t = now + SAMPLE_INTERVAL;
        history.record(&projects(), &sample, t);
        let point = history.points(&preview, t).next_back().unwrap();
        assert_eq!(point.net_in_per_second, Some(200_000.0));
        assert_eq!(point.net_out_per_second, None);
        assert_eq!(point.network_per_second, Some(200_000.0));
        assert_eq!(point.disk_per_second, Some(200_000.0));
    }

    #[test]
    fn differing_verification_delays_use_the_same_counter_interval() {
        let now = Instant::now();
        let clock = |seconds| {
            let offset = Duration::from_secs(seconds);
            SampleClock {
                instant: now + offset,
                wall: UNIX_EPOCH + Duration::from_secs(1_000) + offset,
            }
        };
        let preview = key(InstanceKey::branch("shop", "preview"));
        for (first_delay, second_delay) in [(0, 2), (2, 0)] {
            let mut history = StatsHistory::default();
            let mut sample = report();
            sample.sampled_at_unix_ms = Some(1_001_000);
            let first = sample.anchor_time(clock(0), clock(1 + first_delay));
            history.record(&projects(), &sample, first);

            sample.sampled_at_unix_ms = Some(1_006_000);
            sample.containers[2].net_input_bytes = Some(1500);
            sample.containers[2].block_input_bytes = Some(1500);
            let second = sample.anchor_time(clock(5), clock(6 + second_delay));
            history.record(&projects(), &sample, second);
            let point = history.points(&preview, second).next_back().unwrap();
            assert_eq!(point.at, now + Duration::from_secs(6));
            assert_eq!(point.network_per_second, Some(200.0));
            assert_eq!(point.disk_per_second, Some(200.0));
        }
    }

    #[test]
    fn a_wall_clock_step_breaks_rate_evidence() {
        let began = SampleClock::now();
        let received = SampleClock {
            instant: began.instant + Duration::from_secs(1),
            wall: began.wall + Duration::from_secs(2),
        };
        let mut sample = report();
        let millis = began.wall.duration_since(UNIX_EPOCH).unwrap().as_millis();
        sample.sampled_at_unix_ms = Some(u64::try_from(millis).unwrap() + 500);
        assert_eq!(sample.anchor_time(began, received), received.instant);
        assert!(sample.containers.iter().all(|row| row.started_at.is_none()));
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
