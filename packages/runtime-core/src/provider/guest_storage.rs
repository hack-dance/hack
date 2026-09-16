//! Allowlisted engine storage observations. Engine reclaimability is not cleanup authority.
use super::engine::Observer;
use crate::{Candidate, CandidateError};
use serde_json::{Value, json};
use std::collections::BTreeSet;
fn error() -> CandidateError {
    CandidateError::new(
        "guest_storage",
        "Private engine storage response is incomplete, invalid or exceeds inventory bounds.",
    )
}
fn count(v: &Value, key: &str) -> Result<u64, CandidateError> {
    match v.get(key) {
        None => Ok(0),
        Some(n) => n.as_u64().ok_or_else(error),
    }
}
fn size(v: &Value, key: &str) -> Result<Option<u64>, CandidateError> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(n) if n.as_i64() == Some(-1) => Ok(None),
        Some(n) => n.as_u64().map(Some).ok_or_else(error),
    }
}
fn identity(v: &Value, key: &str) -> Result<String, CandidateError> {
    let id = v[key].as_str().ok_or_else(error)?;
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(error());
    }
    Ok(id.into())
}
fn decode(value: Value) -> Result<Value, CandidateError> {
    let mut categories = serde_json::Map::new();
    for (field, kind) in [
        ("ImageUsage", "images"),
        ("ContainerUsage", "containers"),
        ("VolumeUsage", "volumes"),
        ("BuildCacheUsage", "build_cache"),
    ] {
        let summary = value
            .get(field)
            .filter(|v| v.is_object())
            .ok_or_else(error)?;
        let items = match summary.get("Items") {
            None | Some(Value::Null) => &[][..],
            Some(Value::Array(items)) => items.as_slice(),
            _ => return Err(error()),
        };
        let total = count(summary, "TotalCount")?;
        let active = count(summary, "ActiveCount")?;
        if items.len() > 4096 || total != items.len() as u64 || active > total {
            return Err(error());
        }
        let mut seen = BTreeSet::new();
        let mut records = Vec::new();
        for item in items {
            if !item.is_object() {
                return Err(error());
            }
            let id = identity(
                item,
                if kind == "volumes" {
                    "Name"
                } else if kind == "build_cache" {
                    "ID"
                } else {
                    "Id"
                },
            )?;
            if !seen.insert(id.clone()) {
                return Err(error());
            }
            let record = match kind {
                "volumes" => {
                    let usage = item.get("UsageData").unwrap_or(&Value::Null);
                    if !usage.is_null() && !usage.is_object() {
                        return Err(error());
                    }
                    json!({"name":id,"bytes":size(usage,"Size")?,"container_references":size(usage,"RefCount")?})
                }
                "images" => {
                    json!({"id":id,"bytes":size(item,"Size")?,"shared_bytes":size(item,"SharedSize")?,"container_references":size(item,"Containers")?})
                }
                "containers" => {
                    json!({"id":id,"writable_bytes":size(item,"SizeRw")?,"rootfs_bytes":size(item,"SizeRootFs")?})
                }
                _ => json!({"id":id,"bytes":size(item,"Size")?}),
            };
            records.push(record);
        }
        categories.insert(kind.into(),json!({"count":total,"engine_active_count":active,"engine_total_bytes":count(summary,"TotalSize")?,"engine_reported_reclaimable_bytes":count(summary,"Reclaimable")?,"items":records}));
    }
    Ok(
        json!({"scope":"verified-private-engine-storage-observation","atomic_snapshot":false,"cleanup_authorized":false,"guest_bytes_are_host_allocated_bytes":false,"reference_scope":"engine container references only; retained graph and branch intent is not classified","categories":categories}),
    )
}
pub fn inspect(candidate: &Candidate) -> Result<Value, CandidateError> {
    decode(Observer::connect(candidate)?.storage_usage()?)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Value {
        json!({"ImageUsage":{},"ContainerUsage":{},"VolumeUsage":{},"BuildCacheUsage":{}})
    }
    #[test]
    fn allowlist_preserves_unknown_usage_without_leaking_commands_or_labels() {
        let mut v = empty();
        v["VolumeUsage"] = json!({"TotalCount":1,"Items":[{"Name":"owned-volume","UsageData":{"Size":-1,"RefCount":0},"Mountpoint":"PRIVATE_SENTINEL","Labels":{"secret":"PRIVATE_SENTINEL"}}]});
        v["ContainerUsage"] = json!({"TotalCount":1,"Items":[{"Id":"a".repeat(64),"SizeRw":123,"Command":"PRIVATE_SENTINEL","Labels":{"secret":"PRIVATE_SENTINEL"}}]});
        let report = decode(v).unwrap();
        assert!(!report.to_string().contains("PRIVATE_SENTINEL"));
        assert_eq!(
            report["categories"]["volumes"]["items"][0]["bytes"],
            Value::Null
        );
        assert_eq!(
            report["categories"]["volumes"]["items"][0]["container_references"],
            0
        );
        assert_eq!(report["cleanup_authorized"], false);
    }
    #[test]
    fn missing_categories_duplicate_records_and_unknown_counts_refuse() {
        assert!(decode(json!({})).is_err());
        let mut v = empty();
        v["ImageUsage"] = json!({"TotalCount":2,"Items":[{"Id":"a"},{"Id":"a"}]});
        assert!(decode(v).is_err());
        let mut v = empty();
        v["VolumeUsage"] = json!({"TotalCount":1});
        assert!(decode(v).is_err());
        let mut v = empty();
        v["ImageUsage"] = json!({"TotalCount":0,"ActiveCount":1});
        assert!(decode(v).is_err());
        let mut v = empty();
        v["VolumeUsage"] = json!({"TotalCount":1,"Items":[{"Name":"v","UsageData":{"Size":-2}}]});
        assert!(decode(v).is_err());
        assert!(decode(empty()).is_ok());
    }
}
