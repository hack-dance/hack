//! Aggregate reservations while the provider mutation lease excludes other starts.
use super::*;

#[derive(Default, Debug, PartialEq, Eq)]
struct Budget {
    services: u64,
    memory: u64,
    nano_cpus: u64,
}
impl Budget {
    fn add(&mut self, config: &Value) -> Result<(), CandidateError> {
        let memory = config["HostConfig"]["Memory"]
            .as_u64()
            .ok_or_else(invalid)?;
        let cpu = config["HostConfig"]["NanoCpus"]
            .as_u64()
            .ok_or_else(invalid)?;
        // Engine zero means shared VM capacity, not a missing reservation field.
        if (memory != 0 && !(16 * 1024 * 1024..=MAX_MEMORY_BYTES).contains(&memory))
            || (cpu != 0 && !(100_000_000..=2_000_000_000).contains(&cpu))
        {
            return Err(invalid());
        }
        self.services += 1;
        self.memory += memory;
        self.nano_cpus += cpu;
        if self.services > 32
            || self.memory > MAX_TOTAL_MEMORY_BYTES
            || self.nano_cpus > 4_000_000_000
        {
            return Err(error(
                "graph_capacity_reserved",
                "Combined graph reservations exceed 32 services, four CPUs or the development guest memory reservation budget.",
            ));
        }
        Ok(())
    }
}
fn invalid() -> CandidateError {
    error(
        "graph_capacity_uncertain",
        "A graph container has missing or unsupported resource limits.",
    )
}

pub(super) fn check(
    candidate: &Candidate,
    engine: &Engine<'_>,
    except: Option<&str>,
    requested: &BTreeMap<String, Value>,
) -> Result<(), CandidateError> {
    let mut budget = Budget::default();
    for config in requested.values() {
        budget.add(config)?;
    }
    let runs = storage_inventory::runs(&candidate.state_root.join("run/graphs"))?;
    if runs.len() == 64 && except.is_none() {
        return Err(error(
            "graph_retention_budget",
            "64 graph attempts are retained; explicit archival is required.",
        ));
    }
    for run in runs {
        if except == Some(run.as_str()) {
            continue;
        }
        let (receipt, root) = load(candidate, engine, &run)?;
        initializer_cache::require_resolved(&receipt)?;
        if root.join("state.pending").exists() || root.join("state.pending").is_symlink() {
            return Err(error(
                "graph_capacity_reserved",
                "An interrupted graph journal retains its reservation.",
            ));
        }
        if ["removed", "stopped-data-retained"].contains(&receipt.phase.as_str()) {
            continue;
        }
        if receipt.phase != "ready-observed" {
            return Err(error(
                "graph_capacity_reserved",
                "An active or uncertain graph requires recovery before admitting more work.",
            ));
        }
        for resource in receipt
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            if resource.phase != "started" || resource.id.is_none() {
                return Err(invalid());
            }
            let value = inspect_resource(engine, &receipt, resource)?.ok_or_else(invalid)?;
            // Exited containers still reserve their limits until explicit cleanup: a restart
            // must not silently consume capacity already given to another branch.
            budget.add(&value)?;
        }
    }
    Ok(())
}

pub(super) fn unchanged(actual: &Value, expected: &Value) -> Result<(), CandidateError> {
    for field in ["Memory", "NanoCpus"] {
        if actual["HostConfig"][field] != expected["HostConfig"][field] {
            return Err(error(
                "graph_capacity_changed",
                "Restart resource limits differ from the reviewed graph.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(memory: u64, cpu: u64) -> Value {
        json!({"HostConfig":{"Memory":memory,"NanoCpus":cpu}})
    }
    #[test]
    fn shared_pool_entries_count_globally_and_preserve_explicit_reservations() {
        let mut budget = Budget::default();
        for _ in 0..32 {
            budget.add(&config(0, 0)).unwrap();
        }
        assert_eq!(
            budget,
            Budget {
                services: 32,
                memory: 0,
                nano_cpus: 0
            }
        );
        assert_eq!(
            budget.add(&config(0, 0)).unwrap_err().code,
            "graph_capacity_reserved"
        );
        let mut mixed = Budget::default();
        mixed.add(&config(0, 0)).unwrap();
        mixed.add(&config(64 * 1024 * 1024, 0)).unwrap();
        mixed.add(&config(0, 2_000_000_000)).unwrap();
        mixed.add(&config(0, 2_000_000_000)).unwrap();
        assert_eq!(
            mixed,
            Budget {
                services: 4,
                memory: 64 * 1024 * 1024,
                nano_cpus: 4_000_000_000
            }
        );
        assert_eq!(
            mixed.add(&config(0, 100_000_000)).unwrap_err().code,
            "graph_capacity_reserved"
        );
        unchanged(&config(0, 0), &config(0, 0)).unwrap();
        for capped in [config(16 * 1024 * 1024, 0), config(0, 100_000_000)] {
            assert_eq!(
                unchanged(&config(0, 0), &capped).unwrap_err().code,
                "graph_capacity_changed"
            );
            assert_eq!(
                unchanged(&capped, &config(0, 0)).unwrap_err().code,
                "graph_capacity_changed"
            );
        }
        for field in ["Memory", "NanoCpus"] {
            for value in [
                Value::Null,
                json!(-1),
                json!("0"),
                json!(0.5),
                json!(1),
                json!(u64::MAX),
            ] {
                let mut invalid = config(0, 0);
                invalid["HostConfig"][field] = value;
                assert_eq!(
                    Budget::default().add(&invalid).unwrap_err().code,
                    "graph_capacity_uncertain"
                );
            }
            let mut missing = config(0, 0);
            missing["HostConfig"].as_object_mut().unwrap().remove(field);
            assert_eq!(
                Budget::default().add(&missing).unwrap_err().code,
                "graph_capacity_uncertain"
            );
        }
    }
    #[test]
    fn omitted_compose_limits_compile_into_admissible_engine_configs() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        let services:serde_json::Map<String,Value>=(0..32).map(|i|(format!("job-{i}"),json!({"image":format!("sha256:{}","a".repeat(64)),"network_mode":"none","command":["true"]}))).collect();
        let goals = services
            .keys()
            .map(|name| (name.clone(), Condition::Completed))
            .collect();
        state::write(
            &fixture.0.join("compose.yaml"),
            &json!({"services":services}),
        )
        .unwrap();
        let options = || project::PlanOptions {
            project: &fixture.0,
            compose_file: std::path::Path::new("compose.yaml"),
            profiles: &[],
        };
        let plan = project::plan(&candidate, options()).unwrap();
        let inputs =
            project::inputs::compile(&candidate, options(), &plan.plan_id, &BTreeMap::new())
                .unwrap();
        let prepared =
            super::super::config::prepare(inputs, &goals, &"a".repeat(32), &"b".repeat(32), None)
                .unwrap();
        let mut budget = Budget::default();
        for config in prepared.configs.values() {
            budget.add(config).unwrap();
        }
        assert_eq!(
            budget,
            Budget {
                services: 32,
                memory: 0,
                nano_cpus: 0
            }
        );
        assert!(!candidate.state_root.exists());
    }
    #[test]
    fn installer_and_web_reservations_preserve_guest_headroom() {
        let mut budget = Budget::default();
        budget
            .add(&config(3 * 1024 * 1024 * 1024, 2_000_000_000))
            .unwrap();
        budget
            .add(&config(2 * 1024 * 1024 * 1024, 1_500_000_000))
            .unwrap();
        budget.add(&config(256 * 1024 * 1024, 500_000_000)).unwrap();
        assert_eq!(budget.memory, 5376 * 1024 * 1024);
        assert!(
            budget.memory + GUEST_MEMORY_RESERVE_BYTES
                <= super::super::super::Profile::Development.memory_mib() as u64 * 1024 * 1024
        );
        assert_eq!(
            budget
                .add(&config(16 * 1024 * 1024, 100_000_000))
                .unwrap_err()
                .code,
            "graph_capacity_reserved"
        );
        Budget::default()
            .add(&config(MAX_MEMORY_BYTES, 100_000_000))
            .unwrap();
        assert_eq!(
            Budget::default()
                .add(&config(MAX_MEMORY_BYTES + 1, 100_000_000))
                .unwrap_err()
                .code,
            "graph_capacity_uncertain"
        );
    }

    #[test]
    fn combined_limits_include_every_service_and_reject_overcommit() {
        let mut cpu = Budget::default();
        let big = config(64 * 1024 * 1024, 2_000_000_000);
        cpu.add(&big).unwrap();
        cpu.add(&big).unwrap();
        assert!(cpu.add(&config(16 * 1024 * 1024, 100_000_000)).is_err());
        let mut memory = Budget::default();
        for _ in 0..5 {
            memory
                .add(&config(1024 * 1024 * 1024, 100_000_000))
                .unwrap();
        }
        memory.add(&config(512 * 1024 * 1024, 100_000_000)).unwrap();
        assert_eq!(memory.memory, MAX_TOTAL_MEMORY_BYTES);
        assert!(memory.add(&config(16 * 1024 * 1024, 100_000_000)).is_err());
        let mut services = Budget::default();
        for _ in 0..32 {
            services
                .add(&config(16 * 1024 * 1024, 100_000_000))
                .unwrap();
        }
        assert!(
            services
                .add(&config(16 * 1024 * 1024, 100_000_000))
                .is_err()
        );
        assert!(Budget::default().add(&json!({})).is_err());
        Budget::default().add(&config(0, 100_000_000)).unwrap();
        Budget::default().add(&config(64 * 1024 * 1024, 0)).unwrap();
        unchanged(&big, &big).unwrap();
        assert!(unchanged(&big, &config(32 * 1024 * 1024, 2_000_000_000)).is_err());
    }
}
