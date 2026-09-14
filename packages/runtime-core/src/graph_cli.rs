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
        "Use graph run|restart with --project, --file, --expect-plan, --run-id and --ready service=started|healthy|completed; inspect/reconcile/cleanup require --run-id. Cleanup alone may use --remove-data.",
    )
}
pub fn command(candidate: &Candidate, args: &[&str]) -> Result<Value, CandidateError> {
    let Some((action, args)) = args.split_first() else {
        return Err(invalid());
    };
    if !["run", "restart", "inspect", "reconcile", "cleanup"].contains(action) {
        return Err(invalid());
    }
    let mut singles = BTreeMap::new();
    let mut readiness = BTreeMap::new();
    let mut profiles = Vec::new();
    let mut remove_data = false;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
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
        if key == "--ready" && ["run", "restart"].contains(action) {
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
        } else if key == "--profile" && ["run", "restart"].contains(action) {
            profiles.push(value.to_owned());
        } else if key == "--run-id"
            || (["run", "restart"].contains(action)
                && ["--project", "--file", "--expect-plan", "--timeout-seconds"].contains(&key))
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
        "inspect" => serde_json::to_value(graph::inspect(candidate, run)?)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph snapshot.")),
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
                non_secret_values: &values,
                readiness: &readiness,
                run_id: run,
                timeout: Duration::from_secs(timeout),
            };
            encode(if *action == "run" {
                graph::run(candidate, options)?
            } else {
                graph::restart(candidate, options)?
            })
        }
    }
}
