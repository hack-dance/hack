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
    ) -> Result<ExecCompletion, CandidateError> {
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
        Ok((17, vec![0, 255], b"err\n".to_vec(), Default::default()))
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
    execution::run(graph, session, RUN_BUDGET).unwrap();
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
    let deadline = Instant::now() + RUN_BUDGET;
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
                RUN_BUDGET
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

/// HACK-2739 and HACK-2742: only the owner's expired lease wait and its own
/// refused check get pre-effect codes, and those codes pass the requester's
/// closed reply-code filter unchanged.
#[test]
fn the_owners_wait_refusals_have_their_own_pre_effect_codes() {
    use exec::{OwnerCommand, owner_wait_refusal};
    let busy = || CandidateError::new("provider_busy", "held");
    let cases = [
        (
            owner_wait_refusal(busy(), false, OwnerCommand::Exec),
            exec::OWNER_EXEC_LEASE_BUSY,
        ),
        (
            owner_wait_refusal(busy(), false, OwnerCommand::Run),
            exec::OWNER_RUN_LEASE_BUSY,
        ),
        // A refused check wins: the wait ended because of it, before any effect.
        (
            owner_wait_refusal(busy(), true, OwnerCommand::Run),
            exec::OWNER_COMMAND_NOT_STARTED,
        ),
        (
            owner_wait_refusal(refused(), true, OwnerCommand::Exec),
            exec::OWNER_COMMAND_NOT_STARTED,
        ),
    ];
    for (mapped, code) in cases {
        assert_eq!(mapped.code, code);
        assert!(
            (1..=64).contains(&mapped.code.len())
                && mapped
                    .code
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        );
    }
    for code in [
        "provider_acquisition_cancelled",
        "native_graph_foreground",
        "managed_environment_expired",
        "runtime_not_running",
    ] {
        for command in [OwnerCommand::Exec, OwnerCommand::Run] {
            assert_eq!(
                owner_wait_refusal(CandidateError::new(code, "kept"), false, command).code,
                code
            );
        }
    }
}

/// HACK-2739 and HACK-2742: the owner's own wait, on a real flock held as a
/// project stop, ends in each command's lease code (scaled: a 300 ms budget for
/// the owner's 15 s bound).
#[cfg(target_os = "macos")]
#[test]
fn the_owners_lease_wait_expires_with_each_commands_pre_effect_code() {
    use crate::provider::engine::command_lease_tests::{hold_lease_as_project_stop, running_pool};
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease_as_project_stop(&candidate, Duration::from_secs(30));
    for (command, code) in [
        (exec::OwnerCommand::Exec, exec::OWNER_EXEC_LEASE_BUSY),
        (exec::OwnerCommand::Run, exec::OWNER_RUN_LEASE_BUSY),
    ] {
        let deadline = Instant::now() + Duration::from_millis(300);
        let refused = exec::owner_command_engine(&candidate, deadline, &|| Ok(()), command)
            .err()
            .unwrap();
        // The exact refusal is asserted only once the deadline has passed (HACK-2741).
        assert!(Instant::now() >= deadline);
        assert_eq!(refused.code, code);
    }
    // HACK-2742 review (L4): each call site passes its own command. `exec::execute`
    // and `exec::interactive` go through `owner_exec_engine`; `run::execute` goes
    // through `run::owner_engine`.
    for (code, refused) in [
        (
            exec::OWNER_EXEC_LEASE_BUSY,
            exec::owner_exec_engine(
                &candidate,
                Instant::now() + Duration::from_millis(300),
                &|| Ok(()),
            )
            .err()
            .unwrap(),
        ),
        (
            exec::OWNER_RUN_LEASE_BUSY,
            run::owner_engine(
                &candidate,
                Instant::now() + Duration::from_millis(300),
                &|| Ok(()),
            )
            .err()
            .unwrap(),
        ),
    ] {
        assert_eq!(refused.code, code);
    }
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// HACK-2742: a pending signal or `hack down` (the owner's check refusing) ends the
/// owner's wait within one backoff step, and the answer says nothing started
/// instead of the plain `refused()` that the CLI reported as "unconfirmed". A
/// check that refuses before the wait gets the same code.
#[cfg(target_os = "macos")]
#[test]
fn a_refused_owner_check_ends_the_wait_as_not_started() {
    use crate::provider::engine::command_lease_tests::{
        hold_lease_as_project_stop, refuses_after, running_pool,
    };
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease_as_project_stop(&candidate, Duration::from_secs(30));
    for command in [exec::OwnerCommand::Exec, exec::OwnerCommand::Run] {
        let started = Instant::now();
        let guard = refuses_after(Duration::from_millis(200), "native_graph_foreground");
        let ended = exec::owner_command_engine(
            &candidate,
            started + Duration::from_secs(30),
            &guard,
            command,
        )
        .err()
        .unwrap();
        assert_eq!(ended.code, exec::OWNER_COMMAND_NOT_STARTED);
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the check did not end the wait: {:?}",
            started.elapsed()
        );
        let at_once = exec::owner_command_engine(
            &candidate,
            Instant::now() + Duration::from_secs(30),
            &|| Err(refused()),
            command,
        )
        .err()
        .unwrap();
        assert_eq!(at_once.code, exec::OWNER_COMMAND_NOT_STARTED);
    }
    release.send(()).unwrap();
    holder.join().unwrap();
}

/// HACK-2742: once the lease is free, a later failure keeps its own code (this
/// fixture's post-acquisition liveness refusal), so only the wait is relabelled.
#[cfg(target_os = "macos")]
#[test]
fn an_owner_failure_after_acquisition_keeps_its_code() {
    use crate::provider::engine::command_lease_tests::{PAST_ACQUISITION, running_pool};
    let (_home, candidate) = running_pool();
    let refused = exec::owner_command_engine(
        &candidate,
        Instant::now() + Duration::from_secs(30),
        &|| Ok(()),
        exec::OwnerCommand::Run,
    )
    .err()
    .unwrap();
    assert_eq!(refused.code, PAST_ACQUISITION, "{}", refused.message);
}
