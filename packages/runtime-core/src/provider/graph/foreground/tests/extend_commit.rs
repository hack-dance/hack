use super::fixture;
use crate::owned_tmp_root::OwnedTmpRoot;
use crate::provider::engine::fixture::with_provider;
use crate::provider::graph::{self, startup::Driver as _};
use crate::provider::{Profile, artifact, environment::ManagedInput, identity, state};
use crate::{CandidateError, project};
use project::{NormalizedComposeOptions, PlanOptions, execution::Condition};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

struct ProviderAlias {
    link: PathBuf,
    target: PathBuf,
}

impl Drop for ProviderAlias {
    fn drop(&mut self) {
        if fs::read_link(&self.link).is_ok_and(|target| target == self.target) {
            fs::remove_file(&self.link).unwrap();
        }
    }
}

fn fake_engine(
    image: String,
    web_id: &str,
    web: Rc<RefCell<Value>>,
    redis_id: String,
) -> impl FnMut(Method, &str, Option<&Value>) -> Result<Value, CandidateError> + use<> {
    let inspect_image = format!("/v1.53/images/{image}/json");
    let inspect_web = format!("/v1.53/containers/{web_id}/json");
    let inspect_redis = format!("/v1.53/containers/{redis_id}/json");
    let start_redis = format!("/v1.53/containers/{redis_id}/start");
    let mut redis = Value::Null;
    move |method, path, body| match (method, path) {
        (Method::GET, "/version") => Ok(json!({
            "Version": artifact::ENGINE_VERSION, "Os": "linux", "Arch": "arm64", "ApiVersion": "1.53"
        })),
        (Method::GET, path) if path == inspect_image => {
            Ok(json!({"Id": image, "Os": "linux", "Architecture": "arm64", "Config": {}}))
        }
        (Method::GET, path) if path == inspect_web => Ok(web.borrow().clone()),
        (Method::POST, path) if path.starts_with("/v1.53/containers/create?name=") => {
            assert!(redis.is_null());
            let name = path.split_once('=').unwrap().1;
            let config = body.unwrap();
            redis = json!({
                "Id": redis_id, "Name": name, "Image": image, "Config": config,
                "HostConfig": config["HostConfig"], "State": {"Status": "created", "Running": false}
            });
            Ok(json!({"Id": redis_id}))
        }
        (Method::GET, path) if path == inspect_redis => {
            assert!(!redis.is_null());
            Ok(redis.clone())
        }
        (Method::GET, path)
            if redis.is_null()
                && path.starts_with("/v1.53/containers/hkg-")
                && path.ends_with("/json") =>
        {
            Err(CandidateError::new(
                "engine_not_found",
                "Fixture container has not been created.",
            ))
        }
        (Method::POST, path) if path == start_redis => {
            assert_eq!(redis["State"]["Status"], "created");
            redis["State"] = json!({"Status": "running", "Running": true});
            Ok(Value::Null)
        }
        (method, path) => panic!("unexpected fixture Engine request {method} {path}"),
    }
}

#[test]
fn extend_run_commits_combined_provenance_with_cleared_intent() {
    let (_home, candidate, run) = fixture();
    let fixture = graph::tests::Fixture::new();
    let project = &fixture.0;
    let file = Path::new("compose.yaml");
    let image = format!("sha256:{}", "c".repeat(64));
    let web = json!({"image":image,"network_mode":"none","volumes":["./src:/app:ro"]});
    let redis = json!({"image":image,"network_mode":"none"});
    let old = json!({"services":{"web":web}}).to_string();
    let selected = json!({"services":{"redis":redis}}).to_string();
    // Preserve the file's order in the CLI identity. Serde's sorted-key bytes
    // give a different identity, even though they represent the same services.
    let full = format!(r#"{{"services":{{"web":{web},"redis":{redis}}}}}"#);
    fs::create_dir(project.join("src")).unwrap();
    fs::write(project.join("src/marker"), "source").unwrap();
    fs::write(project.join(file), &old).unwrap();

    let namespace = candidate.plan(project).unwrap().namespace;
    let hash = |bytes: &str| format!("{:x}", crate::Hex(Sha256::digest(bytes.as_bytes())));
    let old_hash = hash(&old);
    let original_hash = hash(&full);
    let compose = NormalizedComposeOptions {
        project,
        branch: None,
        expected_namespace: &namespace,
        compose_file: file,
        expected_compose_sha256: &old_hash,
        compose_bytes: old.as_bytes(),
        profiles: &[],
    };
    let cold = project::plan_normalized(&candidate, compose).unwrap();
    let old_input = graph::extend::Input::read(compose, &cold.plan).unwrap();
    let old_contract = graph::source::review_shared_contract(&cold.plan).unwrap();
    let old_identity = graph::NormalizedInputIdentity {
        namespace: namespace.clone(),
        original_compose_sha256: old_hash.clone(),
        normalized_compose_sha256: cold.plan.compose_sha256.clone(),
    };

    let share = crate::provider::ProjectShareIntent::approve(project, true).unwrap();
    let mut owner = state::Owner::create_with_project_share(
        &candidate,
        Profile::Research,
        None,
        Default::default(),
        None,
        Some(share),
    )
    .unwrap();
    let approved_share = owner.project_share.as_ref().unwrap();
    let guest_mount = approved_share.guest_path.clone();
    let guest_source = approved_share.bind_path("src").unwrap();
    let _alias = ProviderAlias {
        link: owner.short_home.clone(),
        target: candidate.state_root.join("run/smolvm/home"),
    };
    let boot = "a1234567-1234-4123-8123-a12345678901";
    owner.phase = "running".into();
    owner.guest_boot_id = Some(boot.into());
    owner.save(&candidate).unwrap();
    drop(state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
    let _control = OwnedTmpRoot::new(
        graph::startup::process_control_root(
            &candidate.state_root,
            &owner.token,
            boot,
            &run,
            &identity::observe(std::process::id() as i32).unwrap(),
        )
        .unwrap(),
    );
    let root = graph::directory(&candidate, &run).unwrap();
    state::private_directory(&root).unwrap();

    let web_id = "d".repeat(64);
    let redis_id = "e".repeat(64);
    let mut receipt: graph::Receipt = serde_json::from_value(json!({
        "version": 1, "run": run, "owner": owner.token, "namespace": namespace,
        "plan_id": cold.plan_id, "phase": "ready-observed", "normalized_input": old_identity,
        "readiness": {"web": "started"}, "resources": {}
    }))
    .unwrap();
    let web_inspection = Rc::new(RefCell::new(Value::Null));
    let ((input, plan_id, contract), writes) = with_provider(
        &candidate,
        root.join("state.json"),
        fake_engine(
            image.clone(),
            &web_id,
            Rc::clone(&web_inspection),
            redis_id.clone(),
        ),
        move |script, args, input| {
            assert!(input.is_none());
            assert_eq!(args.len(), 1);
            if script.contains("startup-absent-v1") {
                assert!(args[0].starts_with("/storage/hack-graph-startup/"));
                "startup-absent-v1\n".into()
            } else {
                if script.contains("realpath") {
                    assert_eq!(args[0], guest_source);
                } else {
                    assert!(script.contains("virtiofs"));
                    assert_eq!(args[0], guest_mount);
                }
                String::new()
            }
        },
        || {
            let budget = Duration::from_secs(10);
            let mut startup = graph::HostRelayRuntime::new_for_run(
                &candidate,
                Path::new("unused"),
                &"0".repeat(64),
                Vec::new(),
                &run,
            )
            .unwrap();
            startup.extension_input = Some(old_input);
            startup.early_publications = Some(super::super::publishers::EarlyPublications::new(
                &BTreeMap::new(),
                Instant::now() + budget,
            ));
            let engine = graph::Engine::connect(&candidate).unwrap();
            let source =
                graph::source::prepare_mode(&candidate, &engine, &cold.plan, None, false, true)
                    .unwrap()
                    .unwrap();
            let cold_inputs = project::inputs::compile_scoped_normalized(
                &candidate,
                compose,
                &cold.plan_id,
                &BTreeMap::new(),
                &BTreeMap::new(),
            )
            .unwrap()
            .executable;
            let mut prepared = graph::config::prepare(
                cold_inputs,
                &receipt.readiness,
                &run,
                &owner.token,
                Some(&source),
            )
            .unwrap();
            receipt.resources = prepared.resources;
            let web = receipt.resources.get_mut("container:web").unwrap();
            web.id = Some(web_id.clone());
            web.phase = "started".into();
            let web = &receipt.resources["container:web"];
            *web_inspection.borrow_mut() = json!({
                "Id": web_id, "Name": web.name, "Image": image,
                "Config": {"Labels": graph::expected_labels(&receipt, web)},
                "HostConfig": prepared.configs["web"]["HostConfig"],
                "State": {"Status": "running", "Running": true}
            });
            receipt.source = Some(source.binding);
            startup
                .prepare(&engine, &mut receipt, &root, &mut prepared.configs)
                .unwrap();
            drop(engine);
            let generation = graph::service_exec_generation(&receipt).unwrap();

            fs::write(project.join(file), &full).unwrap();
            let full_options = NormalizedComposeOptions {
                expected_compose_sha256: &original_hash,
                compose_bytes: full.as_bytes(),
                ..compose
            };
            let reviewed = project::plan_normalized(&candidate, full_options).unwrap();
            let contract = graph::source::review_shared_contract(&reviewed.plan).unwrap();
            assert_ne!(contract, old_contract);
            let input = graph::NormalizedInputIdentity {
                namespace: namespace.clone(),
                original_compose_sha256: original_hash.clone(),
                normalized_compose_sha256: reviewed.plan.compose_sha256.clone(),
            };
            let combined = graph::foreground::CombinedExtensionInput::new(
                &reviewed.plan_id,
                &input.normalized_compose_sha256,
                full.as_bytes(),
            )
            .unwrap();
            let compose = NormalizedComposeOptions {
                compose_bytes: selected.as_bytes(),
                ..full_options
            };
            let selected_review = project::plan_normalized(&candidate, compose).unwrap();
            let result = graph::extend::run(
                &candidate,
                graph::extend::Selection {
                    options: graph::NormalizedRunOptions {
                        compose,
                        run: graph::RunOptions {
                            project: PlanOptions {
                                project,
                                branch: None,
                                profiles: &[],
                                compose_file: file,
                            },
                            expected_plan: &selected_review.plan_id,
                            readiness: &BTreeMap::from([("redis".into(), Condition::Started)]),
                            shared_source: false,
                            live_source: false,
                            release_initializer_cache: BTreeSet::new(),
                            routing_enrolled: false,
                            loopback_ports: false,
                            source_revision: None,
                            non_secret_values: &BTreeMap::new(),
                            run_id: &run,
                            timeout: budget,
                        },
                    },
                    generation: &generation,
                    combined: Some(combined),
                    managed: ManagedInput {
                        values: &BTreeMap::new(),
                        files: &BTreeMap::new(),
                    },
                    deadline: Instant::now() + budget,
                },
                &mut startup,
            )
            .unwrap();
            assert_eq!(result.services, BTreeSet::from(["redis".into()]));
            (input, reviewed.plan_id, contract)
        },
    );

    let (commit, prior) = writes.split_last().unwrap();
    let before: Vec<graph::Receipt> = prior
        .iter()
        .map(|bytes| serde_json::from_slice(bytes).unwrap())
        .collect();
    let pending = BTreeSet::from(["redis".into()]);
    assert!(
        before
            .iter()
            .skip(1)
            .all(|state| state.extending == pending)
    );
    assert_eq!(before.last().unwrap().extending, pending);
    for state in before {
        assert_eq!(state.normalized_input.as_ref(), Some(&old_identity));
        assert!(state.input_plan_id.is_none());
        assert_eq!(
            state.source.unwrap().shared_contract.as_ref(),
            Some(&old_contract)
        );
    }

    let (saved, _) = graph::load_at(root.clone(), &run, &owner.token).unwrap();
    assert_eq!(fs::read(root.join("state.json")).unwrap(), *commit);
    assert!(
        saved.extending.is_empty(),
        "the combined receipt must clear append intent"
    );
    assert_eq!(saved.normalized_input, Some(input));
    assert_eq!(saved.input_plan_id, Some(plan_id));
    assert_eq!(saved.source.unwrap().shared_contract, Some(contract));
    assert_eq!(saved.resources["container:web"].id, Some(web_id));
    assert_eq!(saved.resources["container:redis"].id, Some(redis_id));
    assert!(!root.join("state.pending").exists());
}
