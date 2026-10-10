use super::*;

struct Executing<'a> {
    backend: &'a Fake,
    calls: Cell<usize>,
    restart: bool,
    unknown: bool,
    data_refusal: bool,
}
impl Backend for Executing<'_> {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        self.backend.request(method, path, body)
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
        if self.data_refusal {
            return Err(refused());
        }
        self.backend.verify_data(receipt, deadline, fresh)
    }
    fn exec(
        &self,
        id: &str,
        selected: &ExecSelection,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(i32, Vec<u8>, Vec<u8>, bool), CandidateError> {
        managed_environment::remaining_until(deadline)?;
        fresh()?;
        assert_eq!(
            id,
            self.backend.receipt().resources["container:web"]
                .id
                .as_ref()
                .unwrap()
        );
        assert_eq!(selected.argv, ["tool", "$literal; value", ""]);
        assert_eq!(selected.workdir.as_deref(), Some("/app"));
        self.calls.set(self.calls.get() + 1);
        if self.unknown {
            return Err(refused());
        }
        if self.restart {
            self.backend
                .state
                .borrow_mut()
                .containers
                .values_mut()
                .next()
                .unwrap()["State"]["StartedAt"] = json!("2026-10-09T00:00:01.000000000Z");
        }
        Ok((17, vec![0, 255], b"err\n".to_vec(), false))
    }
}
fn selected() -> ExecSelection {
    ExecSelection {
        service: "web".into(),
        argv: vec!["tool".into(), "$literal; value".into(), "".into()],
        workdir: Some("/app".into()),
    }
}
fn ready(session: &mut Session<'_, Fake>, graph: &execution::Graph) {
    execution::run(graph, session, Duration::from_secs(2)).unwrap();
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .values_mut()
        .next()
        .unwrap()["State"]["StartedAt"] = json!("2026-10-09T00:00:00.000000000Z");
}
#[test]
fn finite_exec_uses_exact_live_member_and_one_original_source_data_deadline() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    ready(&mut session, &graph);
    {
        let mut state = session.backend.state.borrow_mut();
        state.log_source_deadlines.clear();
        state.log_data_deadlines.clear();
    }
    let backend = Executing {
        backend: &session.backend,
        calls: Cell::new(0),
        restart: false,
        unknown: false,
        data_refusal: false,
    };
    let original = fs::read(session.root.join("state.json")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let result =
        exec::execute_with(&backend, session.receipt.clone(), &selected(), deadline).unwrap();
    assert_eq!(result.exit_code, 17);
    assert_eq!(result.stdout_base64, "AP8=");
    assert_eq!(result.stderr_base64, "ZXJyCg==");
    assert_eq!(backend.calls.get(), 1);
    assert_eq!(fs::read(session.root.join("state.json")).unwrap(), original);
    let state = session.backend.state.borrow();
    assert!(state.log_source_deadlines.iter().all(|d| *d == deadline));
    assert!(state.log_data_deadlines.iter().all(|d| *d == deadline));
}
#[test]
fn finite_exec_refuses_changed_member_or_data_before_command_and_withholds_restart_or_unknown_completion()
 {
    for mode in [
        "owner",
        "image",
        "not-running",
        "paused",
        "restart-state",
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
                _ => {}
            }
        }
        let backend = Executing {
            backend: &session.backend,
            calls: Cell::new(0),
            restart: mode == "restart",
            unknown: mode == "unknown",
            data_refusal: mode == "data",
        };
        let mut request = selected();
        if mode == "selection" {
            request.service = "foreign".into();
        }
        let deadline = Instant::now()
            + if mode == "deadline" {
                Duration::ZERO
            } else {
                Duration::from_secs(2)
            };
        assert!(
            exec::execute_with(&backend, session.receipt.clone(), &request, deadline).is_err(),
            "{mode}"
        );
        assert_eq!(
            backend.calls.get(),
            usize::from(matches!(mode, "restart" | "unknown")),
            "{mode}"
        );
    }
}
