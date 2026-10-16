use hack_runtime_core::{
    Candidate, CandidateError,
    project::{PlanOptions, execution::Condition},
    provider::graph,
};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, time::Duration};
fn invalid() -> CandidateError {
    CandidateError::new(
        "graph_arguments",
        "Use graph run|restart|restore with --project, --file, --expect-plan, --run-id and --ready service=started|healthy|completed, plus --source-revision for source mounts; inspect/reconcile/cleanup/archive/export/reconcile-export/prune require --run-id. Cleanup alone may use --remove-data. Bridge reservation requires --run-id, --service, --slot and --expect-generation; start/release require --run-id, --slot and --expect-reservation. bridges/reconcile-bridges require --run-id. Foreground publish-bridge requires --run-id, --slot, --expect-reservation and exactly one of --port or --unix (no --json); --unix accepts up to eight --hostname claims; unpublish-bridge requires --run-id and --expect-reservation.",
    )
}
pub fn command(candidate: &Candidate, args: &[&str]) -> Result<Value, CandidateError> {
    let Some((action, args)) = args.split_first() else {
        return Err(invalid());
    };
    if *action == "storage-inventory" {
        return if args.is_empty() || *args == ["--json"] {
            graph::storage_inventory(candidate)
        } else {
            Err(invalid())
        };
    }
    if ![
        "run",
        "restart",
        "restore",
        "inspect",
        "reconcile",
        "cleanup",
        "archive",
        "export",
        "reconcile-export",
        "prune",
        "reserve-bridge",
        "release-bridge",
        "start-bridge",
        "publish-bridge",
        "unpublish-bridge",
        "bridges",
        "reconcile-bridges",
    ]
    .contains(action)
    {
        return Err(invalid());
    }
    let mut singles = BTreeMap::new();
    let mut readiness = BTreeMap::new();
    let mut profiles = Vec::new();
    let mut remove_data = false;
    let mut json = false;
    let mut unix = false;
    let mut hostnames = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--unix" {
            if unix || *action != "publish-bridge" {
                return Err(invalid());
            }
            unix = true;
            continue;
        }
        if key == "--json" {
            if json {
                return Err(invalid());
            }
            json = true;
            continue;
        }
        if key == "--remove-data" {
            if remove_data || *action != "cleanup" {
                return Err(invalid());
            }
            remove_data = true;
            continue;
        }
        let value = *args.get(index).ok_or_else(invalid)?;
        index += 1;
        if key == "--hostname" && *action == "publish-bridge" {
            if hostnames.len() >= 8 {
                return Err(invalid());
            }
            hostnames.push(
                hack_runtime_core::provider::publication::normalize_hostname(value)
                    .map_err(|_| invalid())?,
            );
        } else if key == "--ready" && ["run", "restart", "restore"].contains(action) {
            let (service, condition) = value.split_once('=').ok_or_else(invalid)?;
            let condition = match condition {
                "started" => Condition::Started,
                "healthy" => Condition::Healthy,
                "completed" => Condition::Completed,
                _ => return Err(invalid()),
            };
            if readiness.insert(service.to_owned(), condition).is_some() {
                return Err(invalid());
            }
        } else if key == "--profile" && ["run", "restart", "restore"].contains(action) {
            profiles.push(value.to_owned());
        } else if ([
            "reserve-bridge",
            "release-bridge",
            "start-bridge",
            "publish-bridge",
        ]
        .contains(action)
            && key == "--slot")
            || (*action == "reserve-bridge" && ["--service", "--expect-generation"].contains(&key))
            || ([
                "release-bridge",
                "start-bridge",
                "publish-bridge",
                "unpublish-bridge",
            ]
            .contains(action)
                && key == "--expect-reservation")
            || (*action == "publish-bridge" && key == "--port")
            || key == "--run-id"
            || (["run", "restart", "restore"].contains(action)
                && [
                    "--project",
                    "--file",
                    "--expect-plan",
                    "--source-revision",
                    "--timeout-seconds",
                ]
                .contains(&key))
        {
            if singles.insert(key, value).is_some() {
                return Err(invalid());
            }
        } else {
            return Err(invalid());
        }
    }
    let run = *singles.get("--run-id").ok_or_else(invalid)?;
    let encode = |v| {
        serde_json::to_value(v)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph receipt."))
    };
    match *action {
        "reserve-bridge" => serde_json::to_value(graph::reserve_bridge(
            candidate,
            graph::ReserveBridgeOptions {
                run,
                service: singles.get("--service").copied().ok_or_else(invalid)?,
                slot: singles
                    .get("--slot")
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                expected_generation: singles
                    .get("--expect-generation")
                    .copied()
                    .ok_or_else(invalid)?,
            },
        )?)
        .map_err(|_| invalid()),
        "publish-bridge" => {
            if json || unix == singles.contains_key("--port") || (!unix && !hostnames.is_empty()) {
                return Err(invalid());
            }
            graph::publish_bridge(
                candidate,
                run,
                singles
                    .get("--slot")
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                singles
                    .get("--expect-reservation")
                    .copied()
                    .ok_or_else(invalid)?,
                singles
                    .get("--port")
                    .map(|value| value.parse().map_err(|_| invalid()))
                    .transpose()?,
                &hostnames,
            )?;
            unreachable!("successful publication replaces the foreground process")
        }
        "unpublish-bridge" => {
            hack_runtime_core::provider::publication::unpublish(
                candidate,
                run,
                singles
                    .get("--expect-reservation")
                    .copied()
                    .ok_or_else(invalid)?,
            )?;
            Ok(serde_json::json!({"run":run,"unpublished":true}))
        }
        "start-bridge" => serde_json::to_value(graph::start_bridge(
            candidate,
            run,
            singles
                .get("--slot")
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
            singles
                .get("--expect-reservation")
                .copied()
                .ok_or_else(invalid)?,
        )?)
        .map_err(|_| invalid()),
        "release-bridge" => graph::release_bridge(
            candidate,
            run,
            singles
                .get("--slot")
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
            singles
                .get("--expect-reservation")
                .copied()
                .ok_or_else(invalid)?,
        ),
        "bridges" => graph::inspect_bridges(candidate, run),
        "reconcile-bridges" => graph::reconcile_bridges(candidate, run),
        "prune" => graph::prune(candidate, run),
        "reconcile-export" => graph::reconcile_export(candidate, run),
        "inspect" => serde_json::to_value(graph::inspect(candidate, run)?)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph snapshot.")),
        "export" => serde_json::to_value(graph::export(candidate, run)?)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph export.")),
        "archive" => encode(graph::archive(candidate, run)?),
        "reconcile" => encode(graph::reconcile(candidate, run)?),
        "cleanup" => encode(graph::cleanup(candidate, run, remove_data)?),
        _ => {
            let project = *singles.get("--project").ok_or_else(invalid)?;
            let file = *singles.get("--file").ok_or_else(invalid)?;
            let expected = *singles.get("--expect-plan").ok_or_else(invalid)?;
            let timeout = singles
                .get("--timeout-seconds")
                .map(|s| s.parse::<u64>().map_err(|_| invalid()))
                .transpose()?
                .unwrap_or(30);
            let values = BTreeMap::new();
            let options = graph::RunOptions {
                project: PlanOptions {
                    project: Path::new(project),
                    compose_file: Path::new(file),
                    profiles: &profiles,
                },
                expected_plan: expected,
                source_revision: singles.get("--source-revision").copied(),
                non_secret_values: &values,
                readiness: &readiness,
                run_id: run,
                timeout: Duration::from_secs(timeout),
            };
            encode(if *action == "run" {
                graph::run(candidate, options)?
            } else if *action == "restore" {
                graph::restore(candidate, options)?
            } else {
                graph::restart(candidate, options)?
            })
        }
    }
}
