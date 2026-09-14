use super::*;

/// Recreate acknowledged, removed compute around the same verified named data. This is explicit
/// execution of the unchanged reviewed graph, not replay of an interrupted attempt.
pub fn restore(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
    if options.timeout.is_zero() || options.timeout > Duration::from_secs(600) {
        return Err(error("graph_budget", "Invalid restore timeout."));
    }
    let inputs = project::inputs::compile(
        candidate,
        options.project,
        options.expected_plan,
        options.non_secret_values,
    )?;
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Restore requires the development VM profile.",
        ));
    }
    let (mut receipt, root) = load(candidate, &engine, options.run_id)?;
    if root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
        || receipt.phase != "stopped-data-retained"
        || receipt.plan_id != inputs.review.plan_id
        || receipt.readiness != *options.readiness
    {
        return Err(error(
            "graph_restore_refused",
            "Restore requires completed ordinary cleanup and the unchanged plan and readiness goals.",
        ));
    }
    check_reservations(candidate, &engine, Some(options.run_id))?;
    super::super::source_job::check_reservations(&engine)?;
    let source = source::prepare(
        candidate,
        &engine,
        &inputs.review.plan,
        options.source_revision,
    )?;
    source::unchanged(&source, &receipt)?;
    let prepared = config::prepare(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source.as_ref(),
    )?;
    if prepared.namespace != receipt.namespace
        || prepared.resources.keys().ne(receipt.resources.keys())
    {
        return Err(error(
            "graph_receipt",
            "Restore resources differ from the reviewed graph.",
        ));
    }
    verify_images(&engine, &prepared.resources)?;
    for resource in receipt.resources.values() {
        let present = inspect_resource(&engine, &receipt, resource)?.is_some();
        if resource.kind == Kind::Volume {
            if !present {
                return Err(error(
                    "graph_data_missing",
                    "Retained volume is missing; restore will not recreate it.",
                ));
            }
        } else {
            let mut by_name = resource.clone();
            by_name.id = None;
            if resource.phase != "absent"
                || present
                || inspect_resource(&engine, &receipt, &by_name)?.is_some()
            {
                return Err(error(
                    "graph_restore_refused",
                    "Restore requires confirmed absence of every prior container and network.",
                ));
            }
        }
    }
    retain_previous(&root, &receipt)?;
    receipt.phase = "restoring".into();
    for (key, resource) in &mut receipt.resources {
        if resource.kind != Kind::Volume {
            *resource = prepared.resources[key].clone();
        }
    }
    let mut session = Session {
        engine,
        root,
        receipt,
        configs: prepared.configs,
        restarting: false,
    };
    session.save()?;
    #[cfg(test)]
    session.fault_pause("restore-intent")?;
    let result = (|| {
        session.create_resources(true)?;
        execution::run(&prepared.graph, &mut session, options.timeout)
    })();
    if let Err(failure) = result {
        session.receipt.phase = "failed-retained".into();
        session.save()?;
        return Err(failure);
    }
    Ok(session.receipt)
}

fn retain_previous(root: &std::path::Path, receipt: &Receipt) -> Result<(), CandidateError> {
    for index in 1..=8 {
        let path = root.join(format!("restore-{index}"));
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                fs::File::open(root)
                    .map_err(state::io)?
                    .sync_all()
                    .map_err(state::io)?;
                state::write(&path.join("previous.json"), receipt)?;
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(state::io(e)),
        }
    }
    Err(error(
        "graph_restore_retention",
        "Eight restore histories are retained; no history was overwritten.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_history_is_bounded_and_never_overwritten() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = Receipt {
            version: 1,
            run: "a".repeat(32),
            owner: "b".repeat(32),
            namespace: "c".repeat(64),
            plan_id: "d".repeat(64),
            phase: "stopped-data-retained".into(),
            source: None,
            readiness: BTreeMap::new(),
            resources: BTreeMap::new(),
        };
        for index in 1..=8 {
            receipt.plan_id = format!("{index:064x}");
            retain_previous(&fixture.0, &receipt).unwrap();
        }
        let first = fs::read(fixture.0.join("restore-1/previous.json")).unwrap();
        assert_eq!(
            retain_previous(&fixture.0, &receipt).unwrap_err().code,
            "graph_restore_retention"
        );
        assert_eq!(
            fs::read(fixture.0.join("restore-1/previous.json")).unwrap(),
            first
        );
        assert!(!fixture.0.join("restore-9").exists());
        for index in 1..=8 {
            let previous: Receipt =
                state::read(&fixture.0.join(format!("restore-{index}/previous.json"))).unwrap();
            assert_eq!(previous.plan_id, format!("{index:064x}"));
        }
    }
}
