//! Compose field semantics reviewed natively: optional dependencies, stdin/TTY
//! intent, inert route declarations and nested interpolation defaults.
use hack_runtime_core::{
    Candidate,
    project::{
        self, PlanData, PlanOptions, PlanReport,
        execution::{Condition, Graph},
        inputs,
    },
};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new(compose: &str) -> Self {
        let mut bytes = [0; 16];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-fields-{token}"));
        fs::create_dir(&root).unwrap();
        let project = root.join("project");
        let checkout = root.join("candidate");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&checkout).unwrap();
        fs::write(project.join("compose.yaml"), compose).unwrap();
        Self {
            root,
            project,
            candidate: Candidate::discover(&checkout).unwrap(),
        }
    }
    fn options<'a>(&'a self, profiles: &'a [String]) -> PlanOptions<'a> {
        PlanOptions {
            branch: None,
            project: &self.project,
            compose_file: Path::new("compose.yaml"),
            profiles,
        }
    }
    fn plan(&self) -> PlanReport {
        project::plan(&self.candidate, self.options(&[])).unwrap()
    }
    fn plan_with(&self, profiles: &[String]) -> PlanReport {
        project::plan(&self.candidate, self.options(profiles)).unwrap()
    }
    fn compile(&self, supplied: &[(&str, &str)]) -> Result<inputs::ExecutionInputs, String> {
        let review = self.plan();
        let values = supplied
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        inputs::compile(&self.candidate, self.options(&[]), &review.plan_id, &values)
            .map_err(|error| error.code.to_owned())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn codes(plan: &PlanData) -> Vec<(&str, &str)> {
    plan.diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.severity.as_str()))
        .collect()
}

/// Plans that do not use a new field keep their exact serialization, so their
/// plan IDs (a digest of that serialization) do not change after upgrade.
fn assert_legacy_serialization(report: &PlanReport) {
    let text = serde_json::to_string(&report.plan).unwrap();
    for key in ["\"required\"", "\"inert_route_labels\"", "\"interactive\""] {
        assert!(!text.contains(key), "{key}");
    }
    let decoded: PlanData = serde_json::from_str(&text).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), text);
}

const OPTIONAL: &str = "services:\n  app:\n    image: alpine:3.21\n    depends_on:\n      db:\n        condition: service_healthy\n        required: false\n      cache:\n        condition: service_started\n  cache:\n    image: alpine:3.21\n  db:\n    image: alpine:3.21\n    profiles: [database]\n    healthcheck:\n      test: [CMD, 'true']\n";

#[test]
fn optional_dependency_on_an_inactive_service_is_skipped_with_a_warning() {
    let fixture = Fixture::new(OPTIONAL);
    let report = fixture.plan();
    assert!(report.plan.enrollment_compatible);
    let edges = &report.plan.services["app"].dependencies;
    assert!(!edges["db"].required);
    assert!(edges["cache"].required);
    assert!(codes(&report.plan).contains(&("optional_dependency_inactive", "warning")));
    let graph = Graph::from_plan(
        &report.plan,
        &BTreeMap::from([
            ("app".into(), Condition::Started),
            ("cache".into(), Condition::Started),
        ]),
    )
    .unwrap();
    assert_eq!(
        graph.services["app"].dependencies,
        BTreeMap::from([("cache".into(), Condition::Started)])
    );
    let text = serde_json::to_string(&report.plan.services["app"].dependencies).unwrap();
    assert_eq!(text.matches("\"required\":false").count(), 1);
    assert!(!text.contains("\"required\":true"));
}

#[test]
fn optional_dependency_on_an_active_service_is_enforced_fail_closed() {
    let fixture = Fixture::new(OPTIONAL);
    let report = fixture.plan_with(&["database".into()]);
    assert!(report.plan.enrollment_compatible);
    assert!(codes(&report.plan).contains(&("optional_dependency_enforced", "warning")));
    let graph = Graph::from_plan(
        &report.plan,
        &BTreeMap::from([
            ("app".into(), Condition::Started),
            ("cache".into(), Condition::Started),
            ("db".into(), Condition::Healthy),
        ]),
    )
    .unwrap();
    assert_eq!(graph.services["app"].dependencies["db"], Condition::Healthy);
}

#[test]
fn inactive_optional_dependencies_skip_condition_requirements_that_active_ones_keep() {
    // A healthy dependency without a healthcheck, and a completion dependency
    // that always restarts: both refuse when the target runs, and neither
    // applies when an optional edge to a profile-disabled target is dropped.
    let healthy = "services:\n  app:\n    image: alpine:3.21\n    depends_on:\n      db:\n        condition: service_healthy\n        required: false\n  db:\n    image: alpine:3.21\n    profiles: [database]\n";
    let completed = "services:\n  app:\n    image: alpine:3.21\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n        required: false\n  migrate:\n    image: alpine:3.21\n    restart: always\n    profiles: [database]\n";
    for (compose, code) in [
        (healthy, "missing_healthcheck"),
        (completed, "nonterminating_completion_dependency"),
    ] {
        let fixture = Fixture::new(compose);
        let inactive = fixture.plan();
        assert!(inactive.plan.enrollment_compatible, "{code}");
        let found = codes(&inactive.plan);
        assert!(
            found.contains(&("optional_dependency_inactive", "warning")),
            "{code}"
        );
        assert!(!found.contains(&(code, "error")), "{code}");
        let graph = Graph::from_plan(
            &inactive.plan,
            &BTreeMap::from([("app".into(), Condition::Started)]),
        )
        .unwrap();
        assert!(graph.services["app"].dependencies.is_empty(), "{code}");
        let active = fixture.plan_with(&["database".into()]);
        assert!(!active.plan.enrollment_compatible, "{code}");
        assert!(codes(&active.plan).contains(&(code, "error")), "{code}");
        // A required edge to the same disabled target still refuses.
        let required = Fixture::new(&compose.replace("        required: false\n", ""));
        assert!(
            codes(&required.plan().plan).contains(&("inactive_dependency", "error")),
            "{code}"
        );
    }
}

#[test]
fn required_and_restart_dependency_rules_are_unchanged() {
    let required = Fixture::new(&OPTIONAL.replace("        required: false\n", ""));
    let report = required.plan();
    assert!(!report.plan.enrollment_compatible);
    assert!(codes(&report.plan).contains(&("inactive_dependency", "error")));
    let restart = Fixture::new(&OPTIONAL.replace("required: false", "restart: true"));
    assert!(codes(&restart.plan().plan).contains(&("unsupported_dependency_option", "error")));
    let missing = Fixture::new(&OPTIONAL.replace("      db:\n", "      absent:\n"));
    assert!(codes(&missing.plan().plan).contains(&("missing_dependency", "error")));
    let invalid = Fixture::new(&OPTIONAL.replace("required: false", "required: 'no'"));
    assert!(project::plan(&invalid.candidate, invalid.options(&[])).is_err());
    let list = Fixture::new(
        "services:\n  app:\n    image: alpine:3.21\n    depends_on: [cache]\n  cache:\n    image: alpine:3.21\n",
    );
    assert_legacy_serialization(&list.plan());
}

#[test]
fn stdin_open_and_tty_are_reviewed_and_tty_warns_about_the_missing_terminal() {
    let fixture = Fixture::new(
        "services:\n  app:\n    image: alpine:3.21\n    stdin_open: true\n    tty: true\n  worker:\n    image: alpine:3.21\n    stdin_open: true\n  quiet:\n    image: alpine:3.21\n    stdin_open: false\n    tty: false\n",
    );
    let report = fixture.plan();
    assert!(report.plan.enrollment_compatible);
    let services = &report.plan.services;
    let app = services["app"].interactive.as_ref().unwrap();
    assert!(app.stdin_open && app.tty);
    let worker = services["worker"].interactive.as_ref().unwrap();
    assert!(worker.stdin_open && !worker.tty);
    assert!(services["quiet"].interactive.is_none());
    let warnings: Vec<_> = report
        .plan
        .diagnostics
        .iter()
        .filter(|d| d.code == "terminal_not_allocated")
        .collect();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].field, "services.app.tty");
    assert_eq!(warnings[0].severity, "warning");
    let invalid = Fixture::new("services:\n  app:\n    image: alpine:3.21\n    tty: 'yes'\n");
    assert!(project::plan(&invalid.candidate, invalid.options(&[])).is_err());
    assert_legacy_serialization(
        &Fixture::new("services:\n  app:\n    image: alpine:3.21\n    stdin_open: false\n").plan(),
    );
}

#[test]
fn hostnames_without_an_upstream_are_inert_and_partial_route_labels_still_refuse() {
    let fixture = Fixture::new(
        "services:\n  worker:\n    image: alpine:3.21\n    labels:\n      caddy: worker.example.test\n      caddy.tls: internal\n      other: kept\n",
    );
    let report = fixture.plan();
    assert!(report.plan.enrollment_compatible);
    let worker = &report.plan.services["worker"];
    assert!(worker.inert_route_labels);
    assert!(worker.routing.is_none());
    assert!(codes(&report.plan).contains(&("inert_route_declaration", "warning")));
    assert!(!codes(&report.plan).contains(&("route_binding_required", "warning")));
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("worker.example.test")
    );
    for labels in [
        "      caddy: worker.example.test\n",
        "      caddy.tls: internal\n",
        "      caddy: worker.example.test\n      caddy.tls: external\n",
        "      caddy: worker.example.test\n      caddy.tls: internal\n      caddy.header: x\n",
        "      caddy: '*.example.test'\n      caddy.tls: internal\n",
    ] {
        let partial = Fixture::new(&format!(
            "services:\n  worker:\n    image: alpine:3.21\n    labels:\n{labels}"
        ));
        let plan = project::plan(&partial.candidate, partial.options(&[]))
            .unwrap()
            .plan;
        assert!(!plan.enrollment_compatible, "{labels}");
        assert!(
            codes(&plan).contains(&("external_route_or_owner_label", "error")),
            "{labels}"
        );
        assert!(!plan.services["worker"].inert_route_labels);
    }
    let routed = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    labels:\n      caddy: web.example.test\n      caddy.reverse_proxy: '{{upstreams 3000}}'\n      caddy.tls: internal\n",
    );
    let report = routed.plan();
    assert!(report.plan.services["web"].routing.is_some());
    assert_legacy_serialization(&report);
}

#[test]
fn nested_defaults_resolve_like_compose_within_depth_and_operator_bounds() {
    let case = |expression: &str, supplied: &[(&str, &str)]| {
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '{expression}']\n"
        ));
        fixture
            .compile(supplied)
            .map(|compiled| compiled.services["web"].command.clone().unwrap()[1].clone())
    };
    let ok = |expression: &str, supplied: &[(&str, &str)], expected: &str| {
        assert_eq!(
            case(expression, supplied).as_deref(),
            Ok(expected),
            "{expression} {supplied:?}"
        );
    };
    ok("${A:-${B:-}}", &[], "");
    ok("${A:-${B:-fallback}}", &[], "fallback");
    ok("${A:-${B:-fallback}}", &[("B", "inner")], "inner");
    ok(
        "${A:-${B:-fallback}}",
        &[("A", "outer"), ("B", "inner")],
        "outer",
    );
    ok(
        "${A:-${B:-fallback}}",
        &[("A", ""), ("B", "inner")],
        "inner",
    );
    ok("${A:-x${B:-y}z}", &[], "xyz");
    ok("${A:-$$x}", &[], "$x");
    ok("${A:+on-${B:-default}}", &[("A", "1")], "on-default");
    ok("${A:+on-${B:-default}}", &[], "");
    // An unselected word is validated but its inputs are not required.
    ok("${A:-${B}}", &[("A", "set")], "set");
    ok("${A:+${B}}", &[], "");
    ok(
        "pre-${A:-${B:-${C:-${D:-deep}}}}-post",
        &[],
        "pre-deep-post",
    );
    for refused in [
        "${A:-${B:-${C:-${D:-${E:-x}}}}}",
        "${A:-$B}",
        "${A:-$(date)}",
        "${A:-${B:?required}}",
        "${A:-{x}",
        "${A:-${B-x}}",
    ] {
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '{refused}']\n"
        ));
        // Review accepts each form; only execution refuses it.
        assert!(
            project::plan(&fixture.candidate, fixture.options(&[])).is_ok(),
            "{refused}"
        );
        assert_eq!(
            fixture.compile(&[]).err().as_deref(),
            Some("execution_interpolation"),
            "{refused}"
        );
    }
    assert_eq!(
        case("${A:-${B}}", &[]).err().as_deref(),
        Some("execution_environment_missing")
    );
}

#[test]
fn nested_defaults_share_the_expanded_budget() {
    let large = "x".repeat(600 * 1024);
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${A:-${B:-}}', '${C:-${D:-}}']\n",
    );
    assert!(fixture.compile(&[("B", &large)]).is_ok());
    assert_eq!(
        fixture
            .compile(&[("B", &large), ("D", &large)])
            .err()
            .as_deref(),
        Some("execution_input_budget")
    );
}

#[test]
fn nested_default_words_charge_the_budget_exactly_once() {
    // `echo` (4 bytes) + a nested word of two 400 KiB values + a second
    // top-level value fill the 1 MiB budget exactly. A double charge of nested
    // output would refuse the exact fit; one more byte must refuse.
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${A:-${B}${B}}', '${C:-${D}}']\n",
    );
    let half = "x".repeat(400 * 1024);
    let fill = "y".repeat(1024 * 1024 - 4 - 2 * half.len());
    let compiled = fixture.compile(&[("B", &half), ("D", &fill)]).unwrap();
    let command = compiled.services["web"].command.clone().unwrap();
    assert_eq!(command[1].len(), 2 * half.len());
    assert_eq!(command[2], fill);
    let over = format!("{fill}y");
    assert_eq!(
        fixture
            .compile(&[("B", &half), ("D", &over)])
            .err()
            .as_deref(),
        Some("execution_input_budget")
    );
}

#[test]
fn references_to_managed_service_inputs_refuse_instead_of_using_defaults() {
    let canary = "synthetic-managed-canary";
    for (field, value) in [
        ("command", "[echo, '${TOKEN:-fallback}']"),
        ("command", "[echo, '${OTHER:-${TOKEN:-}}']"),
        ("command", "[echo, '${OTHER:+${TOKEN}}']"),
        ("command", "[echo, '$TOKEN']"),
        ("environment", "{TOKEN: null, LABEL: '${TOKEN:-fallback}'}"),
        ("user", "'${TOKEN:-1000}'"),
    ] {
        let environment = if field == "environment" {
            String::new()
        } else {
            "    environment: [TOKEN]\n".into()
        };
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n{environment}    {field}: {value}\n  other:\n    image: alpine:3.21\n    command: [echo, '${{TOKEN:-unmanaged-here}}']\n"
        ));
        let review = fixture.plan();
        let managed = BTreeMap::from([(
            "web".to_owned(),
            BTreeMap::from([("TOKEN".to_owned(), canary.to_owned())]),
        )]);
        let error = inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(&[]),
            &review.plan_id,
            &BTreeMap::new(),
            &managed,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "execution_environment_owner", "{field} {value}");
        assert!(!error.message.contains(canary));
        assert!(!error.message.contains("TOKEN"));
    }
    // A service that does not receive the managed input keeps Compose defaults.
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    environment: [TOKEN]\n  other:\n    image: alpine:3.21\n    command: [echo, '${TOKEN:-unmanaged-here}']\n",
    );
    let review = fixture.plan();
    let managed = BTreeMap::from([(
        "web".to_owned(),
        BTreeMap::from([("TOKEN".to_owned(), canary.to_owned())]),
    )]);
    let compiled = inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(&[]),
        &review.plan_id,
        &BTreeMap::new(),
        &managed,
    )
    .unwrap();
    assert_eq!(
        compiled.executable.services["other"]
            .command
            .as_ref()
            .unwrap(),
        &["echo", "unmanaged-here"]
    );
}
