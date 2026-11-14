use super::*;

#[test]
fn cold_start_uses_real_engine_removal_markers_and_refuses_unrequested_or_changed_env() {
    for capture in image_environment::engine_removal_captures() {
        let mut invalid = Vec::new();
        for extra in [
            json!("UNREQUESTED"),
            capture["removedKey"].clone(),
            json!("HQ_PLAIN=other"),
            json!(17),
        ] {
            let mut actual = capture["inspectedEnvironment"].clone();
            actual.as_array_mut().unwrap().push(extra);
            invalid.push(actual);
        }
        let mut restored = capture["inspectedEnvironment"].clone();
        let removed = capture["removedKey"].as_str().unwrap();
        for entry in restored.as_array_mut().unwrap() {
            if entry.as_str() == Some(removed) {
                *entry = json!(format!("{removed}=restored"));
            }
        }
        invalid.push(restored);
        let mut changed_default = capture["inspectedEnvironment"].clone();
        changed_default[2] = json!("PATH=/different");
        invalid.push(changed_default);
        for (actual, accepted) in std::iter::once((capture["inspectedEnvironment"].clone(), true))
            .chain(invalid.into_iter().map(|value| (value, false)))
        {
            let mut project = basic();
            project["services"]["web"]["image"] = capture["imageId"].clone();
            let fixture = Fixture::new(project);
            let (graph, mut session) =
                fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
            // Supply the reviewed public removal intent and a pinned-image
            // expectation; the fake engine returns the separately captured Env.
            session.configs.get_mut("web").unwrap()["Env"] =
                capture["requestedEnvironment"].clone();
            session.expected_environment.insert(
                "web".into(),
                image_environment::compose(
                    &capture["imageEnvironment"],
                    &session.configs["web"]["Env"],
                )
                .unwrap(),
            );
            session.backend.state.borrow_mut().inspected_environment = Some(actual);
            let result = execution::run(&graph, &mut session, RUN_BUDGET);
            let state = session.backend.state.borrow();
            assert!(state.effects.iter().any(|effect| effect == "create:web"));
            if accepted {
                result.unwrap();
                assert_eq!(session.receipt.phase, Phase::ReadyObserved);
                assert!(state.effects.iter().any(|effect| effect == "start:web"));
            } else {
                assert_eq!(result.unwrap_err().code, "graph_config_mismatch");
                assert!(!state.effects.iter().any(|effect| effect == "start:web"));
                assert_ne!(session.receipt.phase, Phase::ReadyObserved);
            }
        }
    }
}
