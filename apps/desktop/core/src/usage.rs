//! Resource use per service for the Services tab (DESIGN.md section 10).
//!
//! - CPU and memory: `hack usage --json --by-service --path <root>`
//!   (`hack.usage.by-service.v1`, #852): one row per running service and
//!   per instance (`composeProject` is the instance's Compose project; a
//!   branch instance's is `<project>--<branch>`), replicas summed, `null`
//!   where Docker reported no usable value. Compose only.
//! - Emulation: `hack ps --json --path <root> [--branch <name>]` (#904):
//!   a Compose item whose image architecture differs from the engine's has
//!   `emulated: true`; the key is absent otherwise.
//!
//! Read-only. A value the CLI did not report is unknown (a dash), never 0.

use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// The schema `usage --by-service` reports.
pub const USAGE_SCHEMA: &str = "hack.usage.by-service.v1";

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ServiceUsage {
    #[serde(rename = "composeProject")]
    pub compose_project: String,
    pub service: String,
    pub containers: u32,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: Option<f64>,
    #[serde(rename = "memUsedBytes")]
    pub mem_used_bytes: Option<u64>,
    #[serde(rename = "memLimitBytes")]
    pub mem_limit_bytes: Option<u64>,
}

/// `hack usage --json --by-service` → `data`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct UsageReport {
    pub schema: String,
    pub project: Option<String>,
    pub backend: Option<String>,
    pub services: Vec<ServiceUsage>,
}

impl UsageReport {
    /// Read a report, refusing one whose schema this app does not know.
    ///
    /// # Errors
    /// Not the by-service schema, or not its shape.
    pub fn from_value(v: serde_json::Value) -> Result<Self, String> {
        let r: Self =
            serde_json::from_value(v).map_err(|e| format!("unexpected usage report: {e}"))?;
        if r.schema != USAGE_SCHEMA {
            return Err(format!(
                "usage report schema {:?} is not {USAGE_SCHEMA}",
                r.schema
            ));
        }
        Ok(r)
    }

    /// This instance's rows, by service.
    #[must_use]
    pub fn for_instance(&self, compose_project: &str) -> BTreeMap<String, ServiceUsage> {
        self.services
            .iter()
            .filter(|s| s.compose_project == compose_project)
            .map(|s| (s.service.clone(), s.clone()))
            .collect()
    }
}

/// The instance total: CPU and memory summed over `running`, only when
/// every one of them has both values (a partial sum would understate it).
#[must_use]
pub fn total(rows: &BTreeMap<String, ServiceUsage>, running: &[String]) -> Option<(f64, u64)> {
    if running.is_empty() {
        return None;
    }
    let mut cpu = 0.0;
    let mut mem = 0u64;
    for name in running {
        let row = rows.get(name)?;
        cpu += row.cpu_percent?;
        mem = mem.saturating_add(row.mem_used_bytes?);
    }
    Some((cpu, mem))
}

/// `3.2%`; can pass 100% when a service uses several cores.
#[must_use]
pub fn cpu(percent: f64) -> String {
    format!("{percent:.1}%")
}

/// Binary units: `512 KiB`, `104 MiB`, `1.3 GiB`.
#[must_use]
pub fn bytes(n: u64) -> String {
    const KIB: f64 = 1024.0;
    #[allow(clippy::cast_precision_loss)] // display only
    let n = n as f64;
    if n >= KIB * KIB * KIB {
        format!("{:.1} GiB", n / (KIB * KIB * KIB))
    } else if n >= KIB * KIB {
        format!("{:.0} MiB", n / (KIB * KIB))
    } else if n >= KIB {
        format!("{:.0} KiB", n / KIB)
    } else {
        format!("{n:.0} B")
    }
}

/// The services `hack ps --json` marks `emulated: true` (Compose items: an
/// envelope's `data.items` or a bare object's `items`).
#[must_use]
pub fn emulated_services(ps: &serde_json::Value) -> BTreeSet<String> {
    let items = ps
        .get("items")
        .or_else(|| ps.get("data").and_then(|d| d.get("items")))
        .and_then(serde_json::Value::as_array);
    items
        .into_iter()
        .flatten()
        .filter(|i| i.get("emulated").and_then(serde_json::Value::as_bool) == Some(true))
        .filter_map(|i| {
            i.get("Service")
                .or_else(|| i.get("service"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> UsageReport {
        UsageReport::from_value(serde_json::json!({
            "schema": "hack.usage.by-service.v1", "project": "shop", "backend": "compose",
            "services": [
                {"composeProject": "shop", "service": "api", "containers": 1, "cpuPercent": 3.25, "memUsedBytes": 104857600u64, "memLimitBytes": 2147483648u64},
                {"composeProject": "shop", "service": "db", "containers": 1, "cpuPercent": 1.0, "memUsedBytes": 314572800u64, "memLimitBytes": null},
                {"composeProject": "shop--preview", "service": "api", "containers": 2, "cpuPercent": 9.0, "memUsedBytes": 1073741824u64, "memLimitBytes": null},
                {"composeProject": "shop", "service": "worker", "containers": 1, "cpuPercent": null, "memUsedBytes": null, "memLimitBytes": null}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn rows_are_taken_for_the_instance_shown() {
        let r = report();
        let base = r.for_instance("shop");
        assert_eq!(base.keys().collect::<Vec<_>>(), vec!["api", "db", "worker"]);
        let branch = r.for_instance("shop--preview");
        assert_eq!(branch["api"].containers, 2);
        assert!(r.for_instance("other").is_empty());
    }

    #[test]
    fn the_total_needs_every_running_service_to_have_a_value() {
        let base = report().for_instance("shop");
        let (cpu_sum, mem) = total(&base, &["api".into(), "db".into()]).expect("both reported");
        assert!((cpu_sum - 4.25).abs() < 1e-9);
        assert_eq!(mem, 104_857_600 + 314_572_800);
        assert_eq!(
            total(&base, &["api".into(), "worker".into()]),
            None,
            "worker unknown"
        );
        assert_eq!(
            total(&base, &["api".into(), "cache".into()]),
            None,
            "no row"
        );
        assert_eq!(total(&base, &[]), None);
    }

    #[test]
    fn values_read_as_designed() {
        assert_eq!(cpu(3.25), "3.2%");
        assert_eq!(cpu(152.0), "152.0%");
        assert_eq!(bytes(104_857_600), "100 MiB");
        assert_eq!(bytes(1_395_864_371), "1.3 GiB");
        assert_eq!(bytes(2048), "2 KiB");
        assert_eq!(bytes(12), "12 B");
    }

    #[test]
    fn another_schema_is_refused() {
        assert!(
            UsageReport::from_value(serde_json::json!({"schema": "x", "services": []})).is_err()
        );
    }

    #[test]
    fn emulated_services_are_read_from_either_ps_form() {
        let bare = serde_json::json!({"items": [
            {"Service": "api", "emulated": true},
            {"Service": "db"},
            {"Service": "worker", "emulated": false}
        ]});
        assert_eq!(emulated_services(&bare), BTreeSet::from(["api".to_owned()]));
        let envelope = serde_json::json!({"ok": true, "data": {"items": [{"Service": "web", "emulated": true}]}});
        assert_eq!(
            emulated_services(&envelope),
            BTreeSet::from(["web".to_owned()])
        );
        assert!(emulated_services(&serde_json::json!({})).is_empty());
    }
}
