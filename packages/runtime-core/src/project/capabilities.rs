//! Linux capability profile for Compose-file graph containers.
//!
//! Compose-file services receive the Docker engine's default capability set, adjusted
//! by `cap_add` and `cap_drop` with Docker's own precedence rules, so stock images that
//! start as root and then drop privileges (database entrypoints that `chown` their data
//! directory before switching users) behave as they do under Docker. The development VM
//! is the isolation boundary between project code and the host; `no-new-privileges`
//! stays on, and `privileged` stays refused.
//!
//! Lowering never relies on the engine's implicit default. It always emits
//! `CapDrop: ["ALL"]` plus the explicit effective set in `CapAdd`, so the request, the
//! inspected container and the existing `CapDrop` guards describe one exact profile.
//!
//! The VM can host several projects and worktrees at once, and Hack places its own
//! helper processes inside service containers. `cap_add` therefore accepts only
//! capabilities whose effect stays inside the container's own namespaces and cgroup
//! limits. Capabilities that act on the shared VM kernel, its clock, accounting, audit
//! or security modules, that are known container escape primitives, or that would let
//! an application inspect Hack-owned helpers are refused during review.
use super::{CapabilityPlan, Diagnostic};
use crate::CandidateError;
use serde_json::Value;
use std::collections::BTreeSet;

/// Docker/moby's default container capability set (`daemon/pkg/oci/caps/defaults.go`)
/// for the pinned engine (`docker-29.5.2`, see `provider-pins.json`), in moby order.
/// Changing the pinned engine requires re-checking this list.
pub const DOCKER_DEFAULT: [&str; 14] = [
    "CAP_CHOWN",
    "CAP_DAC_OVERRIDE",
    "CAP_FSETID",
    "CAP_FOWNER",
    "CAP_MKNOD",
    "CAP_NET_RAW",
    "CAP_SETGID",
    "CAP_SETUID",
    "CAP_SETFCAP",
    "CAP_SETPCAP",
    "CAP_NET_BIND_SERVICE",
    "CAP_SYS_CHROOT",
    "CAP_KILL",
    "CAP_AUDIT_WRITE",
];

/// Capabilities outside the default set that `cap_add` may grant. Each is scoped to
/// the container's own network or IPC namespace, or bounded by its cgroup limits.
pub const ADMITTED_ADDITIONS: [&str; 5] = [
    // Interfaces, routes and firewall rules of the container's own network namespace.
    "CAP_NET_ADMIN",
    "CAP_NET_BROADCAST",
    // Scheduling and NUMA policy; commonly declared for database images.
    "CAP_SYS_NICE",
    // Memory locking, still charged to the container's memory limit.
    "CAP_IPC_LOCK",
    // IPC objects in the container's own IPC namespace.
    "CAP_IPC_OWNER",
];

/// Every capability name the pinned engine knows (Linux capabilities 0 through 40).
/// A name outside this list is refused as unknown, as Docker refuses it.
pub const KNOWN: [&str; 41] = [
    "CAP_CHOWN",
    "CAP_DAC_OVERRIDE",
    "CAP_DAC_READ_SEARCH",
    "CAP_FOWNER",
    "CAP_FSETID",
    "CAP_KILL",
    "CAP_SETGID",
    "CAP_SETUID",
    "CAP_SETPCAP",
    "CAP_LINUX_IMMUTABLE",
    "CAP_NET_BIND_SERVICE",
    "CAP_NET_BROADCAST",
    "CAP_NET_ADMIN",
    "CAP_NET_RAW",
    "CAP_IPC_LOCK",
    "CAP_IPC_OWNER",
    "CAP_SYS_MODULE",
    "CAP_SYS_RAWIO",
    "CAP_SYS_CHROOT",
    "CAP_SYS_PTRACE",
    "CAP_SYS_PACCT",
    "CAP_SYS_ADMIN",
    "CAP_SYS_BOOT",
    "CAP_SYS_NICE",
    "CAP_SYS_RESOURCE",
    "CAP_SYS_TIME",
    "CAP_SYS_TTY_CONFIG",
    "CAP_MKNOD",
    "CAP_LEASE",
    "CAP_AUDIT_WRITE",
    "CAP_AUDIT_CONTROL",
    "CAP_SETFCAP",
    "CAP_MAC_OVERRIDE",
    "CAP_MAC_ADMIN",
    "CAP_SYSLOG",
    "CAP_WAKE_ALARM",
    "CAP_BLOCK_SUSPEND",
    "CAP_AUDIT_READ",
    "CAP_PERFMON",
    "CAP_BPF",
    "CAP_CHECKPOINT_RESTORE",
];

/// Docker's magic value that selects every capability.
pub const ALL: &str = "ALL";

/// The bounded number of entries in one `cap_add` or `cap_drop` list.
const MAX_ENTRIES: usize = 64;

/// Normalize like Docker's `NormalizeLegacyCapabilities`: upper-case, add the
/// `CAP_` prefix and keep `ALL` as the magic value. Unknown names return `None`.
fn normalize(value: &str) -> Option<String> {
    let upper = value.to_ascii_uppercase();
    if upper == ALL {
        return Some(upper);
    }
    let name = if upper.starts_with("CAP_") {
        upper
    } else {
        format!("CAP_{upper}")
    };
    KNOWN.contains(&name.as_str()).then_some(name)
}

fn admitted_addition(name: &str) -> bool {
    DOCKER_DEFAULT.contains(&name) || ADMITTED_ADDITIONS.contains(&name)
}

fn list(value: Option<&Value>) -> Result<Vec<String>, CandidateError> {
    let invalid = || {
        super::problem(
            "invalid_capability_list",
            "cap_add and cap_drop must be lists of at most 64 capability names.",
        )
    };
    let values = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(values)) if values.len() <= MAX_ENTRIES => values,
        _ => return Err(invalid()),
    };
    values
        .iter()
        .map(|value| value.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect()
}

/// Review `cap_add` and `cap_drop`. Unknown and refused names become error
/// diagnostics, so enrollment and execution refuse the whole plan. Absent or empty
/// lists return `None`, which keeps existing plan identities unchanged.
pub(super) fn review(
    add: Option<&Value>,
    drop: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<CapabilityPlan>, CandidateError> {
    let mut reviewed = [BTreeSet::new(), BTreeSet::new()];
    for (index, (key, value)) in [("cap_add", add), ("cap_drop", drop)]
        .into_iter()
        .enumerate()
    {
        let entries = list(value)?;
        for (position, entry) in entries.iter().enumerate() {
            let path = format!("{field}.{key}[{position}]");
            let Some(name) = normalize(entry) else {
                diagnostics.push(Diagnostic::error(
                    "unknown_capability",
                    &path,
                    "Capability names must be Linux capabilities known to the pinned engine (with or without the CAP_ prefix) or ALL; interpolated names are not resolved.",
                ));
                continue;
            };
            if key == "cap_add" && name == ALL {
                diagnostics.push(Diagnostic::error(
                    "capability_refused",
                    &path,
                    "cap_add: ALL grants every capability, including ones that act on the shared development VM; list the needed capabilities instead.",
                ));
                continue;
            }
            if key == "cap_add" && !admitted_addition(&name) {
                diagnostics.push(Diagnostic::error(
                    "capability_refused",
                    &path,
                    "This capability can act on the shared development VM kernel or on Hack-owned helpers in the container; native services accept only Docker's default set plus NET_ADMIN, NET_BROADCAST, SYS_NICE, IPC_LOCK and IPC_OWNER.",
                ));
                continue;
            }
            reviewed[index].insert(name);
        }
    }
    let [add, drop] = reviewed;
    if add.is_empty() && drop.is_empty() {
        return Ok(None);
    }
    Ok(Some(CapabilityPlan {
        add: add.into_iter().collect(),
        drop: drop.into_iter().collect(),
    }))
}

/// The effective capability set with Docker's `TweakCapabilities` precedence: no
/// adjustments keep the defaults; `cap_drop: ALL` keeps only `cap_add`; otherwise
/// `cap_drop` removes from the defaults and `cap_add` is applied after it, so a name in
/// both lists is kept. `cap_add: ALL` never reaches here because review refuses it.
/// The result is sorted, deduplicated and uses canonical `CAP_` names.
///
/// Returns an error if a plan carries a name review would have refused, so a
/// hand-edited or older plan can never widen the profile at lowering time.
pub fn effective(plan: Option<&CapabilityPlan>) -> Result<Vec<String>, CandidateError> {
    let refused = || {
        CandidateError::new(
            "graph_capabilities",
            "A reviewed capability adjustment is outside the admitted native profile.",
        )
    };
    let mut result: BTreeSet<String> = DOCKER_DEFAULT.iter().map(|&n| n.to_owned()).collect();
    let Some(plan) = plan else {
        return Ok(result.into_iter().collect());
    };
    if plan
        .add
        .iter()
        .any(|name| name == ALL || !admitted_addition(name))
        || plan
            .drop
            .iter()
            .any(|name| name != ALL && !KNOWN.contains(&name.as_str()))
    {
        return Err(refused());
    }
    if plan.drop.iter().any(|name| name == ALL) {
        result.clear();
    } else {
        for name in &plan.drop {
            result.remove(name);
        }
    }
    result.extend(plan.add.iter().cloned());
    Ok(result.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reviewed(add: Value, drop: Value) -> (Option<CapabilityPlan>, Vec<String>) {
        let mut diagnostics = Vec::new();
        let plan = review(Some(&add), Some(&drop), "services.db", &mut diagnostics).unwrap();
        (
            plan,
            diagnostics
                .into_iter()
                .map(|d| format!("{}:{}", d.code, d.field))
                .collect(),
        )
    }

    fn plan(add: &[&str], drop: &[&str]) -> CapabilityPlan {
        CapabilityPlan {
            add: add.iter().map(|&n| n.to_owned()).collect(),
            drop: drop.iter().map(|&n| n.to_owned()).collect(),
        }
    }

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut names: Vec<String> = names.iter().map(|&n| n.to_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn default_profile_is_exactly_the_pinned_engine_default_set() {
        assert_eq!(effective(None).unwrap(), sorted(&DOCKER_DEFAULT));
        assert_eq!(effective(None).unwrap().len(), 14);
        // Each default and admitted name is a known capability exactly once.
        let known: BTreeSet<_> = KNOWN.iter().collect();
        assert_eq!(known.len(), KNOWN.len());
        assert!(DOCKER_DEFAULT.iter().all(|name| known.contains(name)));
        assert!(ADMITTED_ADDITIONS.iter().all(|name| known.contains(name)));
        assert!(
            ADMITTED_ADDITIONS
                .iter()
                .all(|name| !DOCKER_DEFAULT.contains(name))
        );
        // Escape primitives and VM-wide capabilities are never part of the profile.
        for name in [
            "CAP_SYS_ADMIN",
            "CAP_SYS_MODULE",
            "CAP_SYS_RAWIO",
            "CAP_DAC_READ_SEARCH",
            "CAP_SYS_PTRACE",
            "CAP_SYS_TIME",
            "CAP_BPF",
            "CAP_PERFMON",
            "CAP_LINUX_IMMUTABLE",
        ] {
            assert!(!admitted_addition(name), "{name}");
        }
    }

    #[test]
    fn review_normalizes_like_docker_and_keeps_absent_lists_out_of_the_plan() {
        let mut diagnostics = Vec::new();
        assert!(
            review(None, None, "services.db", &mut diagnostics)
                .unwrap()
                .is_none()
        );
        assert!(
            review(
                Some(&json!([])),
                Some(&Value::Null),
                "services.db",
                &mut diagnostics
            )
            .unwrap()
            .is_none()
        );
        assert!(diagnostics.is_empty());
        let (plan, codes) = reviewed(
            json!(["net_admin", "CAP_SYS_NICE", "sys_nice", "chown"]),
            json!(["all", "cap_mknod"]),
        );
        assert!(codes.is_empty(), "{codes:?}");
        assert_eq!(
            plan.unwrap(),
            self::plan(
                &["CAP_CHOWN", "CAP_NET_ADMIN", "CAP_SYS_NICE"],
                &["ALL", "CAP_MKNOD"]
            )
        );
    }

    #[test]
    fn review_refuses_unknown_all_and_out_of_profile_additions() {
        let (plan, codes) = reviewed(
            json!([
                "ALL",
                "SYS_ADMIN",
                "SYS_PTRACE",
                "NOT_A_CAP",
                "${CAP}",
                "NET_ADMIN"
            ]),
            json!(["SYS_ADMIN", "BOGUS"]),
        );
        assert_eq!(
            codes,
            [
                "capability_refused:services.db.cap_add[0]",
                "capability_refused:services.db.cap_add[1]",
                "capability_refused:services.db.cap_add[2]",
                "unknown_capability:services.db.cap_add[3]",
                "unknown_capability:services.db.cap_add[4]",
                "unknown_capability:services.db.cap_drop[1]",
            ]
        );
        // Dropping any known capability only narrows the profile.
        assert_eq!(
            plan.unwrap(),
            self::plan(&["CAP_NET_ADMIN"], &["CAP_SYS_ADMIN"])
        );
        for invalid in [json!("NET_ADMIN"), json!([1]), json!(vec!["KILL"; 65])] {
            let mut diagnostics = Vec::new();
            assert_eq!(
                review(Some(&invalid), None, "services.db", &mut diagnostics)
                    .unwrap_err()
                    .code,
                "invalid_capability_list"
            );
        }
    }

    #[test]
    fn effective_set_follows_docker_tweak_precedence() {
        let defaults = sorted(&DOCKER_DEFAULT);
        // Drop removes from the defaults; add applies after drop.
        let mut expected = defaults.clone();
        expected.retain(|name| name != "CAP_NET_RAW" && name != "CAP_MKNOD");
        expected.push("CAP_NET_ADMIN".into());
        expected.sort();
        assert_eq!(
            effective(Some(&plan(
                &["CAP_NET_ADMIN"],
                &["CAP_NET_RAW", "CAP_MKNOD"]
            )))
            .unwrap(),
            expected
        );
        // A name in both lists is kept, as Docker applies cap_add last.
        assert_eq!(
            effective(Some(&plan(&["CAP_CHOWN"], &["CAP_CHOWN"]))).unwrap(),
            defaults
        );
        // Drop ALL keeps only the explicit additions.
        assert_eq!(
            effective(Some(&plan(&["CAP_CHOWN", "CAP_SETUID"], &["ALL"]))).unwrap(),
            ["CAP_CHOWN", "CAP_SETUID"]
        );
        assert!(effective(Some(&plan(&[], &["ALL"]))).unwrap().is_empty());
        // Redundant default additions change nothing; dropping an absent cap is a no-op.
        assert_eq!(
            effective(Some(&plan(&["CAP_KILL"], &["CAP_SYS_ADMIN"]))).unwrap(),
            defaults
        );
    }

    #[test]
    fn effective_refuses_plans_that_bypassed_review() {
        for plan in [
            plan(&["ALL"], &[]),
            plan(&["CAP_SYS_ADMIN"], &[]),
            plan(&["CAP_SYS_PTRACE"], &["ALL"]),
            plan(&["NET_ADMIN"], &[]),
            plan(&[], &["BOGUS"]),
        ] {
            assert_eq!(
                effective(Some(&plan)).unwrap_err().code,
                "graph_capabilities"
            );
        }
    }
}
