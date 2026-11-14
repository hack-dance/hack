use super::*;

#[test]
fn cold_create_inspection_accepts_only_compiled_removal_markers_from_real_engine() {
    for capture in image_environment::engine_removal_captures() {
        let fixture = Fixture::new();
        let home = Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        state::write(
            &fixture.0.join("compose.yaml"),
            &json!({"services":{"app":{
                "image":capture["imageId"],"network_mode":"none",
                "environment":{"HQ_PLAIN":"plain"},
                "x-hack-unset-environment":[capture["removedKey"]]
            }}}),
        )
        .unwrap();
        let review = project::plan(&candidate, fixture.options()).unwrap();
        let inputs = project::inputs::compile(
            &candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
        )
        .unwrap();
        let readiness = BTreeMap::from([("app".to_owned(), Condition::Started)]);
        let prepared =
            config::prepare(inputs, &readiness, &"a".repeat(32), &"b".repeat(32), None).unwrap();
        let config = &prepared.configs["app"];
        let requested = config["Env"].as_array().unwrap();
        assert_eq!(requested.len(), 2);
        for entry in capture["requestedEnvironment"].as_array().unwrap() {
            assert!(requested.contains(entry));
        }
        let receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":review.plan.namespace,"plan_id":review.plan_id,
            "phase":"preparing","readiness":readiness,"resources":prepared.resources
        }))
        .unwrap();
        let expected =
            image_environment::compose(&capture["imageEnvironment"], &config["Env"]).unwrap();
        let mut inspected = json!({"Config":config,"HostConfig":config["HostConfig"],"State":{"Running":false},"NetworkSettings":{"Networks":{}}});
        inspected["Config"]["Env"] = capture["inspectedEnvironment"].clone();
        // This is the same gate cold start calls between create and start.
        Session::verify_config(&receipt, "app", config, &expected, &inspected).unwrap();
        for extra in [
            json!("UNREQUESTED"),
            capture["removedKey"].clone(),
            json!("HQ_PLAIN=other"),
        ] {
            let mut wrong = inspected.clone();
            wrong["Config"]["Env"].as_array_mut().unwrap().push(extra);
            assert_eq!(
                Session::verify_config(&receipt, "app", config, &expected, &wrong)
                    .unwrap_err()
                    .code,
                "graph_config_mismatch"
            );
        }
        let mut restored = inspected.clone();
        let removed = capture["removedKey"].as_str().unwrap();
        for entry in restored["Config"]["Env"].as_array_mut().unwrap() {
            if entry.as_str() == Some(removed) {
                *entry = json!(format!("{removed}=restored"));
            }
        }
        assert!(Session::verify_config(&receipt, "app", config, &expected, &restored).is_err());
        let mut changed_default = inspected.clone();
        changed_default["Config"]["Env"][2] = json!("PATH=/different");
        assert!(
            Session::verify_config(&receipt, "app", config, &expected, &changed_default).is_err()
        );
    }
}
