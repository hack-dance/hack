use super::*;

/// Stand-in one-off transport over the shared fake engine. One-off containers live
/// in their own map so the canonical member inventory keeps its existing fences.
struct Running<'a> {
    backend: &'a Fake,
    calls: Cell<usize>,
    mode: &'static str,
    one_offs: RefCell<BTreeMap<String, Value>>,
}
impl Running<'_> {
    fn register(&self, name: &str, config: &Value) -> String {
        let id = format!("{:064x}", 0x0ff + self.one_offs.borrow().len());
        let mut process = config.clone();
        process.as_object_mut().unwrap().remove("HostConfig");
        self.one_offs.borrow_mut().insert(
            name.into(),
            json!({"Id":id,"Name":format!("/{name}"),"Image":config["Image"],"Config":process,"HostConfig":config["HostConfig"],"Mounts":[],"State":{"Running":true,"Status":"running","Pid":7,"ExitCode":0,"Paused":false,"Restarting":false}}),
        );
        id
    }
}
impl Backend for Running<'_> {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        if let Some(rest) = path.strip_prefix("/v1.53/containers/") {
            if let Some(selected) = rest.strip_suffix("/json") {
                if let Some(value) = self.one_offs.borrow().values().find(|value| {
                    value["Id"] == selected
                        || value["Name"].as_str().unwrap().trim_start_matches('/') == selected
                }) {
                    return Ok(value.clone());
                }
                if selected.contains("-oneoff-") {
                    return Err(error("engine_not_found", "absent"));
                }
            }
            if let Some(id) = rest.strip_suffix("?force=true&v=true") {
                assert_eq!(method, Method::DELETE);
                let name = self
                    .one_offs
                    .borrow()
                    .iter()
                    .find(|(_, value)| value["Id"] == id)
                    .map(|(name, _)| name.clone())
                    .expect("recorded one-off");
                self.one_offs.borrow_mut().remove(&name);
                self.backend
                    .state
                    .borrow_mut()
                    .effects
                    .push("delete:one-off".into());
                return Ok(Value::Null);
            }
        }
        self.backend.request(method, path, body)
    }
    fn verify_source(&self, receipt: &Receipt, active: bool) -> Result<(), CandidateError> {
        self.backend.verify_source(receipt, active)
    }
    fn verify_source_until(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        self.backend.verify_source_until(receipt, deadline)
    }
    fn verify_data(
        &self,
        receipt: &Receipt,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        if self.mode == "data" {
            return Err(refused());
        }
        self.backend.verify_data(receipt, deadline, fresh)
    }
    fn stop(
        &self,
        selected: &[(String, u64)],
        admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        self.backend.stop(selected, admitted)
    }
    fn one_off(
        &self,
        name: &str,
        config: &Value,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<OneOffCompletion, CandidateError> {
        managed_environment::remaining_until(deadline)?;
        fresh()?;
        let member = self.backend.receipt().resources["container:web"]
            .id
            .clone()
            .unwrap();
        assert!(name.starts_with(&format!("hkn-{RUN}-oneoff-")));
        assert_eq!(name.len(), format!("hkn-{RUN}-oneoff-").len() + 32);
        assert_eq!(config["Image"], image());
        assert_eq!(config["Cmd"], json!(["tool", "$literal; value", ""]));
        assert_eq!(config["Entrypoint"], json!(["/bin/entry"]));
        assert_eq!(config["Env"], json!(["EXACT=literal value", "PATH=/bin"]));
        assert_eq!(config["User"], "1000:1000");
        assert_eq!(config["WorkingDir"], "/app");
        assert_eq!(config["Tty"], false);
        assert_eq!(config["OpenStdin"], false);
        assert_eq!(
            config["HostConfig"]["NetworkMode"],
            format!("container:{member}")
        );
        assert_eq!(config["HostConfig"]["AutoRemove"], false);
        assert_eq!(config["HostConfig"]["Mounts"], json!([]));
        assert_eq!(config["HostConfig"]["CapDrop"], json!(["ALL"]));
        assert!(config.get("NetworkingConfig").is_none());
        assert!(config.get("Healthcheck").is_none());
        let labels = &config["Labels"];
        assert_eq!(labels["io.hack-local.kind"], "one-off");
        assert_eq!(labels["io.hack-local.graph"], RUN);
        assert_eq!(labels["io.hack-local.owner"], OWNER);
        assert_eq!(labels["io.hack-local.resource"], "web");
        assert_eq!(labels["io.hack-local.one-off"], &name[name.len() - 32..]);
        self.calls.set(self.calls.get() + 1);
        if self.mode == "unknown" {
            self.register(name, config);
            return Err(refused());
        }
        if self.mode == "restart" {
            self.backend
                .state
                .borrow_mut()
                .containers
                .values_mut()
                .next()
                .unwrap()["State"]["StartedAt"] = json!("2026-10-09T00:00:01.000000000Z");
        }
        let id = self.register(name, config);
        self.one_offs.borrow_mut().remove(name);
        Ok((id, 17, vec![0, 255], b"err\n".to_vec(), false))
    }
}
fn selected() -> run::RunSelection {
    run::RunSelection {
        service: "web".into(),
        argv: vec!["tool".into(), "$literal; value".into(), "".into()],
        workdir: Some("/app".into()),
    }
}
fn ready(session: &mut Session<'_, Fake>, graph: &execution::Graph) {
    execution::run(graph, session, RUN_BUDGET).unwrap();
    let mut state = session.backend.state.borrow_mut();
    let member = state.containers.values_mut().next().unwrap();
    member["State"]["StartedAt"] = json!("2026-10-09T00:00:00.000000000Z");
    member["Config"]["Entrypoint"] = json!(["/bin/entry"]);
    member["Config"]["Env"] = json!(["EXACT=literal value", "PATH=/bin"]);
    member["Config"]["User"] = json!("1000:1000");
    member["Config"]["WorkingDir"] = json!("/srv");
    member["HostConfig"]["Init"] = json!(false);
}
/// Records are private 0600 files; the secure reader refuses anything else.
fn write_record(path: &Path, value: &Value) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(value.to_string().as_bytes())
        .unwrap();
}
fn records(root: &Path) -> Vec<String> {
    match fs::read_dir(root.join("one-off")) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect(),
        Err(error) => {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
            Vec::new()
        }
    }
}

#[test]
fn finite_one_off_derives_the_exact_member_and_discards_its_record_after_proven_removal() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    ready(&mut session, &graph);
    {
        let mut state = session.backend.state.borrow_mut();
        state.log_source_deadlines.clear();
        state.log_data_deadlines.clear();
    }
    let backend = Running {
        backend: &session.backend,
        calls: Cell::new(0),
        mode: "ok",
        one_offs: RefCell::new(BTreeMap::new()),
    };
    let original = fs::read(session.root.join("state.json")).unwrap();
    let deadline = Instant::now() + RUN_BUDGET;
    let result = run::execute_with(
        &backend,
        session.receipt.clone(),
        &session.root,
        &selected(),
        deadline,
    )
    .unwrap();
    assert_eq!(result.exit_code, 17);
    assert_eq!(result.stdout_base64, "AP8=");
    assert_eq!(result.stderr_base64, "ZXJyCg==");
    assert_eq!(
        result.member,
        session.receipt.resources["container:web"]
            .id
            .clone()
            .unwrap()
    );
    assert_ne!(result.container, result.member);
    assert!(result.valid(&selected()));
    assert_eq!(backend.calls.get(), 1);
    assert!(backend.one_offs.borrow().is_empty());
    assert!(records(&session.root).is_empty());
    assert_eq!(fs::read(session.root.join("state.json")).unwrap(), original);
    let state = session.backend.state.borrow();
    assert!(state.log_source_deadlines.iter().all(|d| *d == deadline));
    assert!(state.log_data_deadlines.iter().all(|d| *d == deadline));
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["name"], result.name);
    assert!(!value.to_string().contains("literal value"));
}

#[test]
fn finite_one_off_refuses_changed_member_mounts_or_data_before_create_and_retains_its_record_after_unknown_completion()
 {
    for mode in [
        "owner",
        "image",
        "not-running",
        "paused",
        "restart-state",
        "mounts",
        "host-mounts",
        "env",
        "data",
        "restart",
        "unknown",
        "deadline",
        "selection",
    ] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        ready(&mut session, &graph);
        {
            let mut state = session.backend.state.borrow_mut();
            let value = state.containers.values_mut().next().unwrap();
            match mode {
                "owner" => value["Config"]["Labels"]["io.hack-local.owner"] = json!("f".repeat(32)),
                "image" => value["Image"] = json!(format!("sha256:{}", "f".repeat(64))),
                "not-running" => value["State"]["Running"] = json!(false),
                "paused" => value["State"]["Paused"] = json!("false"),
                "restart-state" => value["State"]["Restarting"] = Value::Null,
                "mounts" => {
                    value["Mounts"] = json!([{"Type":"bind","Source":"/private","Destination":"/run/hack-environment.json"}])
                }
                "host-mounts" => value["HostConfig"]["Mounts"] = json!([{"Type":"bind"}]),
                "env" => value["Config"]["Env"] = json!(["EXACT=literal value", 7]),
                _ => {}
            }
        }
        let backend = Running {
            backend: &session.backend,
            calls: Cell::new(0),
            mode,
            one_offs: RefCell::new(BTreeMap::new()),
        };
        let mut request = selected();
        if mode == "selection" {
            request.service = "foreign".into();
        }
        let deadline = Instant::now()
            + if mode == "deadline" {
                Duration::ZERO
            } else {
                RUN_BUDGET
            };
        assert!(
            run::execute_with(
                &backend,
                session.receipt.clone(),
                &session.root,
                &request,
                deadline
            )
            .is_err(),
            "{mode}"
        );
        let attempted = matches!(mode, "restart" | "unknown");
        assert_eq!(backend.calls.get(), usize::from(attempted), "{mode}");
        assert_eq!(
            records(&session.root).len(),
            usize::from(attempted),
            "{mode}"
        );
        assert_eq!(
            backend.one_offs.borrow().len(),
            usize::from(mode == "unknown"),
            "{mode}"
        );
    }
}

#[test]
fn cleanup_reaps_a_recorded_one_off_before_stopping_members_and_refuses_foreign_labels() {
    for foreign in [true, false] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        ready(&mut session, &graph);
        let backend = Running {
            backend: &session.backend,
            calls: Cell::new(0),
            mode: "unknown",
            one_offs: RefCell::new(BTreeMap::new()),
        };
        assert!(
            run::execute_with(
                &backend,
                session.receipt.clone(),
                &session.root,
                &selected(),
                Instant::now() + RUN_BUDGET
            )
            .is_err()
        );
        assert_eq!(records(&session.root).len(), 1);
        assert_eq!(backend.one_offs.borrow().len(), 1);
        if foreign {
            backend.one_offs.borrow_mut().values_mut().next().unwrap()["Config"]["Labels"]["io.hack-local.plan"] =
                json!("f".repeat(64));
            let before = session.backend.state.borrow().effects.clone();
            assert!(cleanup_using(&backend, &mut session.receipt, &session.root).is_err());
            assert_eq!(session.backend.state.borrow().effects, before);
            assert_eq!(records(&session.root).len(), 1);
            assert_eq!(backend.one_offs.borrow().len(), 1);
            assert_eq!(session.receipt.phase, Phase::ReadyObserved);
            continue;
        }
        cleanup_using(&backend, &mut session.receipt, &session.root).unwrap();
        assert_eq!(session.receipt.phase, Phase::Removed);
        assert!(records(&session.root).is_empty());
        assert!(backend.one_offs.borrow().is_empty());
        let effects = session.backend.state.borrow().effects.clone();
        let reaped = effects
            .iter()
            .position(|effect| effect == "delete:one-off")
            .unwrap();
        let stopped = effects
            .iter()
            .position(|effect| effect.starts_with("stop:"))
            .unwrap();
        assert!(reaped < stopped);
        // A stale record for an already absent one-off is discarded without effects.
        let root = session.root.clone();
        let record = json!({"version":1,"kind":"native-graph-one-off","run":RUN,"review":session.receipt.review.review_id(),"service":"web","member":session.receipt.resources["container:web"].id,"name":format!("hkn-{RUN}-oneoff-{}", "a".repeat(32))});
        write_record(
            &root
                .join("one-off")
                .join(format!("{}.json", "a".repeat(32))),
            &record,
        );
        let before = session.backend.state.borrow().effects.clone();
        run::reap(&backend, &session.receipt, &root).unwrap();
        assert_eq!(session.backend.state.borrow().effects, before);
        assert!(records(&root).is_empty());
    }
}

#[test]
fn one_off_records_close_their_kind_run_review_member_and_name() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    ready(&mut session, &graph);
    let backend = Running {
        backend: &session.backend,
        calls: Cell::new(0),
        mode: "ok",
        one_offs: RefCell::new(BTreeMap::new()),
    };
    let directory = session.root.join("one-off");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let valid = json!({"version":1,"kind":"native-graph-one-off","run":RUN,"review":session.receipt.review.review_id(),"service":"web","member":session.receipt.resources["container:web"].id,"name":format!("hkn-{RUN}-oneoff-{}", "a".repeat(32))});
    for (pointer, value) in [
        ("/version", json!(2)),
        ("/kind", json!("native-graph-runtime")),
        ("/run", json!("f".repeat(32))),
        ("/review", json!("f".repeat(64))),
        ("/service", json!("foreign")),
        ("/member", json!("f".repeat(64))),
        ("/name", json!(format!("hkn-{RUN}-container-0"))),
        (
            "/name",
            json!(format!("hkn-{RUN}-oneoff-{}", "b".repeat(32))),
        ),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        let path = directory.join(format!("{}.json", "a".repeat(32)));
        write_record(&path, &bad);
        assert!(
            run::reap(&backend, &session.receipt, &session.root).is_err(),
            "{pointer}"
        );
        fs::remove_file(&path).unwrap();
    }
    let path = directory.join(format!("{}.json", "a".repeat(32)));
    // The exact valid record for an absent one-off is discarded without effects.
    write_record(&path, &valid);
    run::reap(&backend, &session.receipt, &session.root).unwrap();
    assert!(records(&session.root).is_empty());
    let mut extra = valid.clone();
    extra["argv"] = json!(["secret"]);
    write_record(&path, &extra);
    assert!(run::reap(&backend, &session.receipt, &session.root).is_err());
    fs::remove_file(&path).unwrap();
    write_record(
        &directory.join(format!("{}.pending", "a".repeat(32))),
        &json!({}),
    );
    assert!(run::reap(&backend, &session.receipt, &session.root).is_err());
}
