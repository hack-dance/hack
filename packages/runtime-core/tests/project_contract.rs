use hack_runtime_core::{
    Candidate,
    project::{self, PlanOptions, PlanReport},
};
use std::{
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
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
            .join(format!("hack-project-{token}"));
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
    fn options(&self) -> PlanOptions<'_> {
        PlanOptions {
            project: &self.project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        }
    }
    fn plan(&self) -> PlanReport {
        project::plan(&self.candidate, self.options()).unwrap()
    }
    fn codes(&self) -> Vec<String> {
        self.plan()
            .plan
            .diagnostics
            .into_iter()
            .map(|d| d.code)
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
const BASIC: &str = "services:\n  web:\n    image: alpine:3.21\n    command: [echo, hello]\n";

#[test]
fn local_https_labels_have_typed_review_intent_without_publication() {
    let labels = "    labels:\n      caddy: 'search.livenation.hack, search.livenation.hack.gy'\n      caddy.reverse_proxy: '{{upstreams 6980}}'\n      caddy.tls: internal\n";
    let fixture = Fixture::new(&format!("{BASIC}{labels}"));
    let report = fixture.plan();
    let route = report.plan.services["web"].routing.as_ref().unwrap();
    assert_eq!(route.port, 6980);
    assert_eq!(
        route.hostnames,
        ["search.livenation.hack", "search.livenation.hack.gy"]
    );
    assert!(
        report
            .plan
            .diagnostics
            .iter()
            .any(|d| d.code == "route_binding_required")
    );
    assert!(
        !report
            .plan
            .diagnostics
            .iter()
            .any(|d| d.code == "external_route_or_owner_label")
    );
    assert!(!fixture.candidate.state_root.exists());

    fs::write(
        fixture.project.join("compose.yaml"),
        format!("{BASIC}{}", labels.replace("6980", "6981")),
    )
    .unwrap();
    assert_ne!(report.plan_id, fixture.plan().plan_id);
    fs::write(
        fixture.project.join("compose.yaml"),
        format!("{BASIC}{labels}      caddy.basicauth: private-canary\n"),
    )
    .unwrap();
    let invalid = fixture.plan();
    assert!(invalid.plan.services["web"].routing.is_none());
    assert!(
        invalid
            .plan
            .diagnostics
            .iter()
            .any(|d| d.code == "external_route_or_owner_label")
    );
    assert!(
        !serde_json::to_string(&invalid)
            .unwrap()
            .contains("private-canary")
    );
    fs::write(
        fixture.project.join("compose.yaml"),
        format!("{BASIC}    labels: {{caddy_0: 'search.example'}}\n"),
    )
    .unwrap();
    let indexed = fixture.plan();
    assert!(indexed.plan.services["web"].routing.is_none());
    assert!(
        indexed
            .plan
            .diagnostics
            .iter()
            .any(|d| d.code == "external_route_or_owner_label")
    );
}

#[test]
fn content_generation_is_immutable_and_excludes_managed_environment() {
    let fixture = Fixture::new(BASIC);
    fs::create_dir(fixture.project.join(".hack")).unwrap();
    fs::write(
        fixture.project.join(".hack/hack.env.yaml"),
        "do-not-transfer",
    )
    .unwrap();
    fs::write(fixture.project.join("app.txt"), "revision A").unwrap();
    let plan = fixture.plan();
    let captured = project::snapshot::capture(
        &fixture.project,
        &Default::default(),
        &plan.plan.source_selection.metadata_sha256,
    )
    .unwrap();
    assert!(
        !captured
            .receipt()
            .entries
            .iter()
            .any(|e| e.path.contains("hack.env"))
    );
    fs::write(fixture.project.join("app.txt"), "revision B").unwrap();
    let (_, bytes) = captured.files().find(|(e, _)| e.path == "app.txt").unwrap();
    assert_eq!(bytes, b"revision A");
    assert!(
        project::snapshot::capture(
            &fixture.project,
            &Default::default(),
            &plan.plan.source_selection.metadata_sha256
        )
        .is_err()
    );
    let next = project::snapshot::capture(
        &fixture.project,
        &Default::default(),
        &fixture.plan().plan.source_selection.metadata_sha256,
    )
    .unwrap();
    assert_ne!(captured.receipt().revision, next.receipt().revision);
    assert!(
        !serde_json::to_string(&captured.receipt())
            .unwrap()
            .contains("revision A")
    );
}

#[test]
fn content_capture_rejects_symlink_replacement_and_deletion() {
    let fixture = Fixture::new(BASIC);
    fs::create_dir(fixture.project.join("src")).unwrap();
    fs::write(fixture.project.join("src/app.txt"), "source").unwrap();
    let plan = fixture.plan();
    fs::rename(fixture.project.join("src"), fixture.root.join("outside")).unwrap();
    std::os::unix::fs::symlink(fixture.root.join("outside"), fixture.project.join("src")).unwrap();
    assert!(
        project::snapshot::capture(
            &fixture.project,
            &Default::default(),
            &plan.plan.source_selection.metadata_sha256
        )
        .is_err()
    );
    fs::remove_file(fixture.project.join("src")).unwrap();
    assert!(
        project::snapshot::capture(
            &fixture.project,
            &Default::default(),
            &plan.plan.source_selection.metadata_sha256
        )
        .is_err()
    );
}

#[test]
fn captured_archive_uses_retained_bytes_and_cannot_boot_a_runtime() {
    let fixture = Fixture::new(BASIC);
    fs::write(fixture.project.join("source-Ω.txt"), "Unicode content").unwrap();
    std::os::unix::fs::symlink("source-Ω.txt", fixture.project.join("alias.txt")).unwrap();
    fs::write(
        fixture.project.join("program.sh"),
        "#!/bin/sh\necho captured\n",
    )
    .unwrap();
    fs::set_permissions(
        fixture.project.join("program.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(fixture.project.join(".env.local"), "SECRET_CANARY").unwrap();
    let plan = fixture.plan();
    let snapshot = project::snapshot::capture(
        &fixture.project,
        &Default::default(),
        &plan.plan.source_selection.metadata_sha256,
    )
    .unwrap();
    fs::write(fixture.project.join("program.sh"), "changed").unwrap();
    let bytes = snapshot.archive().unwrap();
    assert_eq!(bytes, snapshot.archive().unwrap());
    assert!(
        !bytes
            .windows(b"SECRET_CANARY".len())
            .any(|w| w == b"SECRET_CANARY")
    );
    let path = fixture.root.join("source.tar");
    fs::write(&path, bytes).unwrap();
    let target = fixture.root.join("extracted");
    fs::create_dir(&target).unwrap();
    // The system tar provides a separate reader from the Rust archive writer.
    assert!(
        Command::new("/usr/bin/tar")
            .args(["-xf"])
            .arg(&path)
            .arg("-C")
            .arg(&target)
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        fs::read(target.join("program.sh")).unwrap(),
        b"#!/bin/sh\necho captured\n"
    );
    assert_ne!(
        fs::metadata(target.join("program.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert!(!target.join(".env.local").exists());
    assert_eq!(
        fs::read_link(target.join("alias.txt")).unwrap(),
        Path::new("source-Ω.txt")
    );
    assert_eq!(
        fs::read(target.join("alias.txt")).unwrap(),
        b"Unicode content"
    );
    let error = hack_runtime_core::provider::publish_source(
        &fixture.candidate,
        &plan.plan.namespace,
        &snapshot,
    )
    .unwrap_err();
    assert_eq!(error.code, "runtime_not_running");
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn source_links_cannot_capture_credentials_or_chained_aliases() {
    for (target, file) in [(".env.local", ".env.local"), ("second", "second")] {
        let fixture = Fixture::new(BASIC);
        fs::write(fixture.project.join(".env.local"), "DO_NOT_READ").unwrap();
        if file == "second" {
            std::os::unix::fs::symlink("compose.yaml", fixture.project.join(file)).unwrap();
        }
        std::os::unix::fs::symlink(target, fixture.project.join("alias")).unwrap();
        let plan = fixture.plan();
        assert!(
            plan.plan
                .diagnostics
                .iter()
                .any(|d| d.code == "source_symlink")
        );
        assert!(
            project::snapshot::capture(
                &fixture.project,
                &Default::default(),
                &plan.plan.source_selection.metadata_sha256
            )
            .is_err()
        );
    }
}

#[test]
fn read_only_plan_and_enrollment_are_distinct_and_idempotent() {
    let fixture = Fixture::new(BASIC);
    let plan = fixture.plan();
    assert!(plan.plan.enrollment_compatible);
    assert!(!plan.plan.runtime_execution_supported);
    assert_eq!(plan.enrollment_diff.state, "new");
    assert!(!fixture.candidate.state_root.exists());
    assert_eq!(plan.plan_id, fixture.plan().plan_id);
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap()
            .state,
        "not-enrolled"
    );
    let before = fs::read(fixture.project.join("compose.yaml")).unwrap();
    let receipt = project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id).unwrap();
    assert_eq!(receipt.state, "enrolled-no-runtime");
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
            .unwrap()
            .plan_id,
        plan.plan_id
    );
    assert_eq!(fixture.plan().enrollment_diff.state, "unchanged");
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap()
            .plan_id,
        Some(plan.plan_id)
    );
    assert_eq!(
        before,
        fs::read(fixture.project.join("compose.yaml")).unwrap()
    );
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
    assert_eq!(fs::read_dir(&fixture.project).unwrap().count(), 1);
}

#[test]
fn wrong_stale_and_wu01_preview_ids_are_rejected_before_enrollment() {
    let fixture = Fixture::new(BASIC);
    let plan = fixture.plan();
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &"0".repeat(64))
            .unwrap_err()
            .code,
        "stale_plan"
    );
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), "read-only-preview")
            .unwrap_err()
            .code,
        "invalid_plan_id"
    );
    fs::write(
        fixture.project.join("compose.yaml"),
        BASIC.replace("hello", "updated"),
    )
    .unwrap();
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
            .unwrap_err()
            .code,
        "stale_plan"
    );
    assert!(!fixture.candidate.state_root.exists());
    let plan = fixture.plan();
    fs::write(fixture.project.join("new-source.txt"), "new source").unwrap();
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
            .unwrap_err()
            .code,
        "stale_plan"
    );
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn unsupported_privileged_external_and_unknown_fields_block_enrollment() {
    for (extra, code) in [
        ("    privileged: true\n", "privileged_service"),
        ("    devices: [/dev/null]\n", "unsupported_field"),
        ("    network_mode: host\n", "unsupported_network_mode"),
        (
            "    container_name: active-v4-service\n",
            "unsupported_field",
        ),
        (
            "    labels: {caddy: private.example}\n",
            "external_route_or_owner_label",
        ),
    ] {
        let fixture = Fixture::new(&format!("{BASIC}{extra}"));
        let plan = fixture.plan();
        assert!(
            plan.plan.diagnostics.iter().any(|d| d.code == code),
            "{code}"
        );
        assert_eq!(
            project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
                .unwrap_err()
                .code,
            "incompatible_compose"
        );
        assert!(!fixture.candidate.state_root.exists());
    }
    let fixture = Fixture::new(&format!(
        "{BASIC}volumes:\n  data: {{external: true}}\nnetworks:\n  active: {{external: true}}\n"
    ));
    assert!(fixture.codes().contains(&"external_volume".into()));
    assert!(fixture.codes().contains(&"external_network".into()));
}

#[test]
fn explicit_external_network_replacement_is_owned_internal_and_review_bound() {
    let original =
        format!("{BASIC}    networks: [legacy]\nnetworks:\n  legacy: {{external: true}}\n");
    let fixture = Fixture::new(&original);
    let blocked = fixture.plan();
    assert!(!blocked.plan.enrollment_compatible);
    let replacement = original.replace("external: true", "external: true, x-hack-isolated: true");
    fs::write(fixture.project.join("compose.yaml"), &replacement).unwrap();
    let review = fixture.plan();
    assert!(review.plan.enrollment_compatible);
    assert_ne!(blocked.plan_id, review.plan_id);
    assert_eq!(review.plan.services["web"].networks, ["legacy"]);
    assert!(review.plan.networks["legacy"].internal);
    assert_eq!(review.plan.networks["legacy"].driver, "bridge");
    assert!(
        review
            .plan
            .diagnostics
            .iter()
            .any(|d| { d.code == "isolated_network_replacement" && d.severity == "warning" })
    );
    assert!(!fixture.candidate.state_root.exists());
    project::enroll(&fixture.candidate, fixture.options(), &review.plan_id).unwrap();
    assert_eq!(
        fs::read_to_string(fixture.project.join("compose.yaml")).unwrap(),
        replacement
    );
    fs::write(fixture.project.join("compose.yaml"), original).unwrap();
    assert!(project::enroll(&fixture.candidate, fixture.options(), &review.plan_id).is_err());
}

#[test]
fn network_replacement_does_not_waive_other_compatibility_errors() {
    let fixture = Fixture::new(&format!(
        "{BASIC}    labels: {{caddy: private.example}}\n    volumes: ['${{HOME}}/.aws:/root/.aws:ro']\n    networks: [legacy]\nnetworks:\n  legacy: {{external: true, x-hack-isolated: true}}\nvolumes:\n  old: {{external: true}}\n"
    ));
    let codes = fixture.codes();
    assert!(!codes.contains(&"external_network".into()));
    for code in [
        "external_route_or_owner_label",
        "unresolved_mount_source",
        "external_volume",
    ] {
        assert!(codes.contains(&code.into()));
    }
    assert!(!fixture.plan().plan.enrollment_compatible);
    for declaration in [
        "external: true, x-hack-isolated: false",
        "external: true, x-hack-isolated: true, driver: overlay",
    ] {
        let fixture = Fixture::new(&format!("{BASIC}networks:\n  legacy: {{{declaration}}}\n"));
        assert!(!fixture.plan().plan.enrollment_compatible);
    }
    for declaration in [
        "x-hack-isolated: true",
        "external: false, x-hack-isolated: true",
        "external: true, x-hack-isolated: 'true'",
        "external: true, internal: 'true', x-hack-isolated: true",
    ] {
        let fixture = Fixture::new(&format!("{BASIC}networks:\n  legacy: {{{declaration}}}\n"));
        assert!(project::plan(&fixture.candidate, fixture.options()).is_err());
        assert!(!fixture.candidate.state_root.exists());
    }
}

#[test]
fn environment_values_are_never_resolved_returned_or_persisted() {
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, 'INLINE_COMMAND_CANARY', '${FROM_HOST}', '$$ESCAPED']\n    environment:\n      PASSWORD: INLINE_ENV_CANARY\n      FROM_HOST:\n      DATABASE_URL: '${DATABASE_URL:-INLINE_DEFAULT_CANARY}'\n    env_file: settings\n    labels: {note: INLINE_LABEL_CANARY}\n",
    );
    fs::write(
        fixture.project.join("settings"),
        "PRIVATE_ENV_FILE_CANARY=secret",
    )
    .unwrap();
    fs::set_permissions(
        fixture.project.join("settings"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    fs::write(fixture.project.join(".env"), "AMBIENT_ENV_CANARY=secret").unwrap();
    let plan = fixture.plan();
    assert!(plan.plan.enrollment_compatible);
    let text = serde_json::to_string(&plan).unwrap();
    for canary in [
        "INLINE_COMMAND_CANARY",
        "INLINE_ENV_CANARY",
        "INLINE_DEFAULT_CANARY",
        "INLINE_LABEL_CANARY",
        "PRIVATE_ENV_FILE_CANARY",
        "AMBIENT_ENV_CANARY",
    ] {
        assert!(!text.contains(canary));
    }
    assert_eq!(
        plan.plan.services["web"].environment["FROM_HOST"].environment_references,
        vec!["FROM_HOST"]
    );
    assert!(
        plan.plan.services["web"]
            .command
            .as_ref()
            .unwrap()
            .arguments[3]
            .environment_references
            .is_empty()
    );
    assert!(
        !plan
            .plan
            .source_selection
            .entries
            .iter()
            .any(|e| e.path == "settings" || e.path == ".env")
    );
    let receipt = project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id).unwrap();
    assert!(!serde_json::to_string(&receipt).unwrap().contains("CANARY"));
}

#[test]
fn graph_profiles_health_completion_and_ports_have_real_negative_controls() {
    let fixture = Fixture::new(
        "services:\n  db:\n    image: alpine:3.21\n    profiles: [database]\n  web:\n    image: alpine:3.21\n    depends_on:\n      db: {condition: service_healthy}\n",
    );
    let codes = fixture.codes();
    assert!(codes.contains(&"inactive_dependency".into()));
    assert!(codes.contains(&"missing_healthcheck".into()));
    let fixture = Fixture::new(
        "services:\n  first:\n    image: alpine:3.21\n    depends_on: [second]\n  second:\n    image: alpine:3.21\n    depends_on: [first]\n",
    );
    assert!(fixture.codes().contains(&"dependency_cycle".into()));
    let fixture = Fixture::new(
        "services:\n  init:\n    image: alpine:3.21\n    restart: always\n  app:\n    image: alpine:3.21\n    depends_on:\n      init: {condition: service_completed_successfully}\n",
    );
    assert!(
        fixture
            .codes()
            .contains(&"nonterminating_completion_dependency".into())
    );
    let fixture = Fixture::new(
        "services:\n  first:\n    image: alpine:3.21\n    ports: ['8080:80']\n  second:\n    image: alpine:3.21\n    ports: ['127.0.0.1:8080:90']\n",
    );
    assert!(fixture.codes().contains(&"port_conflict".into()));
}

#[test]
fn useful_graph_models_build_mounts_health_limits_and_loopback_proposal() {
    let fixture = Fixture::new(
        "services:\n  db:\n    image: postgres:17\n    healthcheck:\n      test: [CMD-SHELL, 'pg_isready -U postgres']\n      interval: 1s\n      timeout: 500ms\n      retries: 3\n    volumes: ['data:/var/lib/postgresql/data']\n  setup:\n    image: alpine:3.21\n    depends_on:\n      db: {condition: service_healthy}\n    command: [sh, -c, 'echo setup']\n  web:\n    build:\n      context: .\n      dockerfile: Dockerfile\n      args: {BUILD_TOKEN: '${BUILD_TOKEN}'}\n    depends_on:\n      setup: {condition: service_completed_successfully}\n    volumes: ['./src:/workspace:ro']\n    ports: ['8080:3000']\n    cpus: '0.5'\n    mem_limit: 256m\n    pids_limit: 128\n    profiles: [web]\nvolumes:\n  data: {}\n",
    );
    fs::write(fixture.project.join("Dockerfile"), "FROM alpine:3.21").unwrap();
    fs::create_dir(fixture.project.join("src")).unwrap();
    fs::write(fixture.project.join("src/main.txt"), "code").unwrap();
    let profiles = vec!["web".into()];
    let plan = project::plan(
        &fixture.candidate,
        PlanOptions {
            project: &fixture.project,
            compose_file: Path::new("compose.yaml"),
            profiles: &profiles,
        },
    )
    .unwrap();
    assert!(
        plan.plan.enrollment_compatible,
        "{:?}",
        plan.plan.diagnostics
    );
    assert!(plan.plan.services["web"].active);
    assert_eq!(
        plan.plan.services["web"].limits.memory_bytes,
        Some(256 * 1024 * 1024)
    );
    assert_eq!(
        plan.plan.services["web"].ports[0].proposed_host_ip,
        "127.0.0.1"
    );
    assert_eq!(
        plan.plan.services["db"]
            .healthcheck
            .as_ref()
            .unwrap()
            .interval_nanos,
        Some(1_000_000_000)
    );
    assert!(
        plan.plan
            .diagnostics
            .iter()
            .any(|d| d.code == "proposed_loopback_binding")
    );
    assert_eq!(plan.plan.services["web"].mounts[0].source, "src");
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn invalid_limits_ports_commands_and_conflicting_owners_are_rejected() {
    for extra in [
        "    cpus: -1\n",
        "    mem_limit: -1\n",
        "    pids_limit: 0\n",
        "    ports: ['70000:80']\n",
        "    ports: ['8000-8001:80']\n",
        "    environment: [A=one, A=two]\n",
    ] {
        let fixture = Fixture::new(&format!("{BASIC}{extra}"));
        assert!(
            project::plan(&fixture.candidate, fixture.options()).is_err(),
            "{extra}"
        );
    }
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: echo hello\n    network_mode: none\n    networks: [default]\n    cpus: 1\n    deploy: {resources: {limits: {cpus: '2'}}}\n",
    );
    let codes = fixture.codes();
    for code in ["conflicting_network_owners", "conflicting_limits"] {
        assert!(codes.contains(&code.into()));
    }
}

#[test]
fn host_root_secret_mounts_symlink_escape_and_special_ignore_files_are_refused() {
    let fixture = Fixture::new(&format!("{BASIC}    volumes: ['/:/host']\n"));
    assert_eq!(
        project::plan(&fixture.candidate, fixture.options())
            .unwrap_err()
            .code,
        "source_escape"
    );
    let fixture = Fixture::new(&format!(
        "{BASIC}    volumes: ['./.env:/workspace/value']\n"
    ));
    fs::write(fixture.project.join(".env"), "secret").unwrap();
    assert_eq!(
        project::plan(&fixture.candidate, fixture.options())
            .unwrap_err()
            .code,
        "excluded_source"
    );
    let fixture = Fixture::new(&format!("{BASIC}    volumes: ['./escape:/workspace']\n"));
    std::os::unix::fs::symlink(&fixture.root, fixture.project.join("escape")).unwrap();
    assert_eq!(
        project::plan(&fixture.candidate, fixture.options())
            .unwrap_err()
            .code,
        "source_symlink"
    );
    let fixture = Fixture::new(BASIC);
    let secret = fixture.root.join("credential");
    fs::write(&secret, "SECRET_IGNORE_CANARY").unwrap();
    std::os::unix::fs::symlink(&secret, fixture.project.join(".gitignore")).unwrap();
    let error = project::plan(&fixture.candidate, fixture.options()).unwrap_err();
    assert_eq!(error.code, "invalid_ignore_rules");
    assert!(!error.message.contains("SECRET_IGNORE_CANARY"));
}

#[test]
fn source_selection_honors_local_ignore_and_excludes_generated_credentials_without_copying() {
    let fixture = Fixture::new(BASIC);
    fs::write(
        fixture.project.join(".gitignore"),
        "ignored/\n*.tmp\n!keep.tmp\n",
    )
    .unwrap();
    for name in [
        "ignored",
        "src",
        "node_modules",
        ".aws",
        ".worktrees",
        ".delta",
        ".ai",
    ] {
        fs::create_dir(fixture.project.join(name)).unwrap();
        fs::write(fixture.project.join(name).join("value.txt"), "value").unwrap();
    }
    for name in ["skip.tmp", "keep.tmp", "private.key"] {
        fs::write(fixture.project.join(name), "value").unwrap();
    }
    // An excluded directory's ignore-file alias must never be consulted.
    std::os::unix::fs::symlink(
        fixture.project.join("private.key"),
        fixture.project.join("node_modules/.gitignore"),
    )
    .unwrap();
    let plan = fixture.plan();
    assert!(plan.plan.enrollment_compatible);
    let paths: Vec<_> = plan
        .plan
        .source_selection
        .entries
        .iter()
        .map(|e| e.path.as_str())
        .collect();
    assert!(paths.contains(&"src/value.txt"));
    assert!(paths.contains(&"keep.tmp"));
    for name in [
        "ignored/value.txt",
        "node_modules/value.txt",
        ".worktrees/value.txt",
        ".delta/value.txt",
        ".ai/value.txt",
        ".aws/value.txt",
        "private.key",
        "skip.tmp",
    ] {
        assert!(!paths.contains(&name), "{name}");
    }
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn enrollment_never_overwrites_a_foreign_alias_partial_receipt_or_different_plan() {
    let fixture = Fixture::new(BASIC);
    let plan = fixture.plan();
    let receipt = project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id).unwrap();
    let file = fixture
        .candidate
        .state_root
        .join("run/workspaces")
        .join(&receipt.plan.namespace)
        .join("enrollment.json");
    let bytes = fs::read(&file).unwrap();
    fs::write(
        fixture.project.join("compose.yaml"),
        BASIC.replace("hello", "different"),
    )
    .unwrap();
    let updated = fixture.plan();
    assert_eq!(
        updated.enrollment_diff.state,
        "different-plan-replacement-not-implemented"
    );
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &updated.plan_id)
            .unwrap_err()
            .code,
        "enrollment_conflict"
    );
    assert_eq!(fs::read(&file).unwrap(), bytes);
    fs::write(file.with_extension("pending"), "partial").unwrap();
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap_err()
            .code,
        "incomplete_enrollment"
    );
    fs::remove_file(file.with_extension("pending")).unwrap();
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(fixture.project.join("compose.yaml"), &file).unwrap();
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap_err()
            .code,
        "incomplete_enrollment"
    );
}

#[test]
fn actual_cli_does_not_use_ambient_environment_or_execute_a_global_runtime() {
    let fixture =
        Fixture::new("services:\n  web:\n    image: alpine:3.21\n    environment: [FROM_HOST]\n");
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .env_clear()
        .env("PATH", "")
        .env("FROM_HOST", "AMBIENT_CLI_SECRET_CANARY")
        .env("DOCKER_HOST", "unix:///foreign-do-not-connect.sock")
        .args([
            "--candidate-root",
            compiled.to_str().unwrap(),
            "project",
            "plan",
            "--project",
            fixture.project.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(!output.contains("AMBIENT_CLI_SECRET_CANARY"));
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["plan"]["runtime_execution_supported"], false);
    assert_eq!(value["plan"]["enrollment_compatible"], true);
}

#[test]
fn nested_interpolation_is_validated_without_exposing_defaults() {
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    environment: {VALUE: '${OUTER:-${INNER:-PRIVATE_DEFAULT}}'}\n",
    );
    let plan = fixture.plan();
    assert_eq!(
        plan.plan.services["web"].environment["VALUE"].environment_references,
        vec!["INNER", "OUTER"]
    );
    assert!(
        !serde_json::to_string(&plan)
            .unwrap()
            .contains("PRIVATE_DEFAULT")
    );
    for template in ["${OUTER:-${INNER}", "${VALUE:bad}", "${VALUE", "${}"] {
        fs::write(fixture.project.join("compose.yaml"),format!("services:\n  web:\n    image: alpine:3.21\n    environment: {{VALUE: '{template}'}}\n")).unwrap();
        assert_eq!(
            project::plan(&fixture.candidate, fixture.options())
                .unwrap_err()
                .code,
            "invalid_interpolation"
        );
    }
}

#[test]
fn compose_relative_paths_and_normalized_reserved_targets_are_checked() {
    let fixture = Fixture::new(BASIC);
    fs::create_dir(fixture.project.join("config")).unwrap();
    fs::create_dir(fixture.project.join("src")).unwrap();
    fs::write(
        fixture.project.join("config/compose.yaml"),
        format!("{BASIC}    volumes: ['../src:/workspace:ro']\n"),
    )
    .unwrap();
    let plan = project::plan(
        &fixture.candidate,
        PlanOptions {
            project: &fixture.project,
            compose_file: Path::new("config/compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    assert_eq!(plan.plan.services["web"].mounts[0].source, "src");
    fs::write(
        fixture.project.join("compose.yaml"),
        format!("{BASIC}    volumes: ['./src://var//run']\n"),
    )
    .unwrap();
    assert!(fixture.codes().contains(&"reserved_mount_target".into()));
}

#[test]
fn source_and_receipt_hardlinks_and_forged_ownership_are_refused() {
    let fixture = Fixture::new(BASIC);
    let external = fixture.root.join("external");
    fs::write(&external, "external").unwrap();
    fs::hard_link(&external, fixture.project.join("linked")).unwrap();
    assert!(fixture.codes().contains(&"source_hardlink".into()));
    fs::remove_file(fixture.project.join("linked")).unwrap();
    let plan = fixture.plan();
    let receipt = project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id).unwrap();
    let file = fixture
        .candidate
        .state_root
        .join("run/workspaces")
        .join(receipt.plan.namespace)
        .join("enrollment.json");
    let twin = fixture.root.join("receipt-twin");
    fs::hard_link(&file, &twin).unwrap();
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap_err()
            .code,
        "foreign_enrollment_state"
    );
    fs::remove_file(twin).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["plan"]["candidate_root"] = "/foreign-candidate".into();
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        project::status(&fixture.candidate, &fixture.project)
            .unwrap_err()
            .code,
        "foreign_enrollment_state"
    );
}

#[test]
fn a_live_enrollment_lock_refuses_another_writer() {
    use std::os::{fd::AsRawFd, unix::fs::DirBuilderExt};
    let fixture = Fixture::new(BASIC);
    let plan = fixture.plan();
    let parent = fixture.candidate.state_root.join("run/workspaces");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&parent)
        .unwrap();
    let lock = fs::File::create(parent.join("enrollment.lock")).unwrap();
    fs::set_permissions(
        parent.join("enrollment.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
            .unwrap_err()
            .code,
        "enrollment_busy"
    );
    assert!(!parent.join(&plan.plan.namespace).exists());
    // Release the test lock explicitly before asserting that another writer can acquire it.
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) }, 0);
    drop(lock);
    assert_eq!(
        project::enroll(&fixture.candidate, fixture.options(), &plan.plan_id)
            .unwrap()
            .state,
        "enrolled-no-runtime"
    );
}

#[test]
fn a_fifo_compose_input_is_rejected_without_waiting_for_a_writer() {
    let fixture = Fixture::new(BASIC);
    let fifo = fixture.project.join("fifo.yaml");
    let path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let error = project::plan(
        &fixture.candidate,
        PlanOptions {
            project: &fixture.project,
            compose_file: Path::new("fifo.yaml"),
            profiles: &[],
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_compose_file");
}

#[test]
fn malformed_images_and_control_characters_in_source_names_are_refused() {
    for image in [
        "alpine::tag",
        "Uppercase/repo:tag",
        "repo..name:tag",
        "registry:bad/repo:tag",
        "https://registry/repo",
        "user:password@registry/repo",
    ] {
        let fixture = Fixture::new(&format!("services:\n  web:\n    image: '{image}'\n"));
        assert_eq!(
            project::plan(&fixture.candidate, fixture.options())
                .unwrap_err()
                .code,
            "invalid_image"
        );
    }
    let fixture = Fixture::new(BASIC);
    fs::write(fixture.project.join("source-\n.txt"), "code").unwrap();
    assert_eq!(
        project::plan(&fixture.candidate, fixture.options())
            .unwrap_err()
            .code,
        "unsupported_source_name"
    );
}

#[test]
fn merged_environment_is_reviewable_and_ambient_mounts_return_redacted_diagnostics() {
    let fixture = Fixture::new(
        "services:\n  app:\n    image: alpine:3.21\n    environment:\n      <<: &defaults {FROM_DEFAULT: '${INPUT}', OVERRIDE: hidden-default}\n      OVERRIDE: hidden-explicit\n    volumes:\n      - '${HOME}/.aws:/root/.aws:ro'\n",
    );
    let report = fixture.plan();
    assert!(!report.plan.enrollment_compatible);
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("hidden-default"));
    assert!(!text.contains("hidden-explicit"));
    assert!(!text.contains("${HOME}"));
    assert!(fixture.codes().contains(&"unresolved_mount_source".into()));
    let service = &report.plan.services["app"];
    assert_eq!(
        service.environment["FROM_DEFAULT"].environment_references,
        vec!["INPUT"]
    );
    assert!(service.environment.contains_key("OVERRIDE"));
    assert!(!service.environment.contains_key("<<"));
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn incremental_archive_contains_only_changed_content_and_orders_removals() {
    let fixture = Fixture::new(BASIC);
    fs::create_dir_all(fixture.project.join("old/nested")).unwrap();
    fs::write(fixture.project.join("old/nested/file.txt"), "A").unwrap();
    fs::write(fixture.project.join("stable.txt"), "keep").unwrap();
    let capture = || {
        let plan = fixture.plan();
        project::snapshot::capture(
            &fixture.project,
            &Default::default(),
            &plan.plan.source_selection.metadata_sha256,
        )
        .unwrap()
    };
    let first = capture();
    first.receipt().validate().unwrap();
    let mut forged = first.receipt().clone();
    forged.entries[0].path = "../escape".into();
    assert!(forged.validate().is_err());
    fs::rename(fixture.project.join("old"), fixture.project.join("new")).unwrap();
    fs::write(fixture.project.join("new/nested/file.txt"), "B").unwrap();
    let second = capture();
    let delta = second.delta(Some(first.receipt()));
    assert_eq!(delta.transferred_file_bytes, 1);
    assert_eq!(
        delta
            .removed_entries
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        ["old/nested/file.txt", "old/nested", "old"]
    );
    let encoded = second.delta_archive(&delta).unwrap();
    let mut archive = tar::Archive::new(encoded.as_slice());
    let paths: Vec<_> = archive
        .entries()
        .unwrap()
        .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(paths, ["new", "new/nested", "new/nested/file.txt"]);
    assert!(
        second
            .delta(Some(second.receipt()))
            .changed_paths
            .is_empty()
    );
    assert!(first.delta_archive(&delta).is_err());
}

#[test]
fn native_watcher_observes_atomic_replacement_without_polling_source() {
    let fixture = Fixture::new(BASIC);
    fs::write(fixture.project.join(".editor-save"), "saved").unwrap();
    let watcher = project::watcher::SourceWatcher::new(&fixture.project).unwrap();
    fs::rename(
        fixture.project.join(".editor-save"),
        fixture.project.join("saved.txt"),
    )
    .unwrap();
    assert!(
        watcher
            .wait(std::time::Duration::from_secs(8))
            .unwrap()
            .is_some()
    );
}

#[test]
fn native_watcher_coalesces_a_burst_into_a_complete_inventory() {
    let fixture = Fixture::new(BASIC);
    let selection = fixture.plan().plan.source_selection.metadata_sha256;
    let watcher = project::watcher::SourceWatcher::new(&fixture.project).unwrap();
    let batch = fixture.project.join("burst");
    fs::create_dir(&batch).unwrap();
    for index in 0..512 {
        let original = batch.join(format!("file-{index}.txt"));
        let temporary = batch.join(format!(".save-{index}"));
        fs::write(&original, "before").unwrap();
        fs::write(&temporary, format!("after-{index}")).unwrap();
        fs::rename(&temporary, &original).unwrap();
        if index % 2 == 0 {
            fs::remove_file(original).unwrap();
        } else {
            fs::rename(original, batch.join(format!("renamed-{index}.txt"))).unwrap();
        }
    }
    assert!(
        watcher
            .wait(std::time::Duration::from_secs(8))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        project::snapshot::capture(&fixture.project, &Default::default(), &selection)
            .err()
            .unwrap()
            .code,
        "source_changed"
    );
    let selection = fixture.plan().plan.source_selection.metadata_sha256;
    let snapshot =
        project::snapshot::capture(&fixture.project, &Default::default(), &selection).unwrap();
    let entries: Vec<_> = snapshot
        .receipt()
        .entries
        .iter()
        .filter(|e| e.path.starts_with("burst/"))
        .collect();
    assert_eq!(entries.len(), 256);
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(entry.kind, "file", "unexpected entry {index}");
        assert!(entry.path.starts_with("burst/renamed-"));
    }
    for index in (1..512).step_by(2) {
        let path = format!("burst/renamed-{index}.txt");
        let (entry, bytes) = snapshot
            .files()
            .find(|(entry, _)| entry.path == path)
            .unwrap();
        assert_eq!(entry.path, path);
        assert_eq!(bytes, format!("after-{index}").as_bytes());
    }
}

#[test]
fn publication_reconcile_cli_requires_the_reviewed_plan() {
    let fixture = Fixture::new(BASIC);
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .env_clear()
        .env("PATH", "")
        .args([
            "--candidate-root",
            compiled.to_str().unwrap(),
            "project",
            "publish-source",
            "--project",
            fixture.project.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &"0".repeat(64),
            "--reconcile",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.contains("stale_plan"), "{stderr}");
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn execution_dependency_compiler_preserves_review_conditions_and_refuses_invalid_goals() {
    use project::execution::{Condition, Graph};
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  init:\n    image: alpine:3.21\n    command: ['true']\n  web:\n    image: alpine:3.21\n    depends_on:\n      init:\n        condition: service_completed_successfully\n    healthcheck:\n      test: [CMD, echo, ready]\n",
    );
    let mut plan = fixture.plan().plan;
    assert!(plan.enrollment_compatible);
    let goals = BTreeMap::from([
        ("init".into(), Condition::Completed),
        ("web".into(), Condition::Healthy),
    ]);
    let graph = Graph::from_plan(&plan, &goals).unwrap();
    assert_eq!(
        graph.services["web"].dependencies["init"],
        Condition::Completed
    );
    assert_eq!(graph.services["web"].ready, Condition::Healthy);
    assert!(Graph::from_plan(&plan, &BTreeMap::new()).is_err());
    plan.services.get_mut("web").unwrap().healthcheck = None;
    assert_eq!(
        Graph::from_plan(&plan, &goals).unwrap_err().code,
        "graph_readiness"
    );
    plan.enrollment_compatible = false;
    assert_eq!(
        Graph::from_plan(&plan, &goals).unwrap_err().code,
        "graph_incompatible"
    );
}

#[test]
fn executable_inputs_preserve_argv_and_resolve_only_explicit_values() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${INPUT}', '$$LITERAL', '']\n    entrypoint: []\n    environment:\n      INPUT:\n      EMPTY: ''\n      COUNT: 2\n    healthcheck:\n      test: 'test -n \"$$INPUT\"'\n",
    );
    let review = fixture.plan();
    let sentinel = "private-fixture-value-$NOT_RECURSIVE";
    let values = BTreeMap::from([("INPUT".into(), sentinel.into())]);
    let compiled = inputs::compile(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &values,
    )
    .unwrap();
    let service = &compiled.services["web"];
    assert_eq!(
        service.command.as_ref().unwrap(),
        &["echo", sentinel, "$LITERAL", ""]
    );
    assert_eq!(service.entrypoint, Some(vec![]));
    assert_eq!(
        service.environment,
        vec!["COUNT=2", "EMPTY=", &format!("INPUT={sentinel}")]
    );
    assert_eq!(
        service.health_test,
        Some(vec!["CMD-SHELL".into(), "test -n \"$INPUT\"".into()])
    );
    assert!(
        !serde_json::to_string(&compiled.review)
            .unwrap()
            .contains(sentinel)
    );
    let failure = inputs::compile(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "execution_environment_missing");
    assert!(!serde_json::to_string(&failure).unwrap().contains(sentinel));
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn executable_inputs_reject_stale_review_and_accept_simple_command_strings() {
    use project::inputs;
    let fixture = Fixture::new(BASIC);
    let old = fixture.plan();
    fs::write(
        fixture.project.join("compose.yaml"),
        BASIC.replace("hello", "changed"),
    )
    .unwrap();
    assert_eq!(
        inputs::compile(
            &fixture.candidate,
            fixture.options(),
            &old.plan_id,
            &Default::default()
        )
        .err()
        .unwrap()
        .code,
        "execution_plan_changed"
    );
    fs::write(
        fixture.project.join("compose.yaml"),
        "services:\n  web:\n    image: alpine:3.21\n    command: 'echo hello'\n",
    )
    .unwrap();
    let review = fixture.plan();
    let inputs = inputs::compile(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &Default::default(),
    )
    .unwrap();
    assert_eq!(
        inputs.services["web"].command.as_ref().unwrap(),
        &["echo", "hello"]
    );
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn executable_expansion_is_bounded_and_null_differs_from_empty_override() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: null\n    entrypoint: ''\n    environment: [INPUT]\n",
    );
    let review = fixture.plan();
    let values = BTreeMap::from([("INPUT".into(), "".into())]);
    let compiled = inputs::compile(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &values,
    )
    .unwrap();
    assert_eq!(compiled.services["web"].command, None);
    assert_eq!(compiled.services["web"].entrypoint, Some(vec![]));
    assert_eq!(compiled.services["web"].environment, ["INPUT="]);
    for value in ["x".repeat(1024 * 1024 + 1), "nul\0value".into()] {
        let values = BTreeMap::from([("INPUT".into(), value)]);
        assert_eq!(
            inputs::compile(
                &fixture.candidate,
                fixture.options(),
                &review.plan_id,
                &values
            )
            .err()
            .unwrap()
            .code,
            "execution_input_budget"
        );
    }
}

#[test]
fn executable_compiler_does_not_guess_interpolation_operators_or_load_env_files() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${INPUT:?required}']\n",
    );
    let review = fixture.plan();
    let values = BTreeMap::from([("INPUT".into(), "provided".into())]);
    assert_eq!(
        inputs::compile(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &values
        )
        .err()
        .unwrap()
        .code,
        "execution_interpolation"
    );
    fs::write(
        fixture.project.join("fixture.env"),
        "INPUT=never-load-this-value\n",
    )
    .unwrap();
    fs::write(
        fixture.project.join("compose.yaml"),
        "services:\n  web:\n    image: alpine:3.21\n    env_file: fixture.env\n",
    )
    .unwrap();
    let review = fixture.plan();
    let failure = inputs::compile(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &values,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "execution_input_unsupported");
    assert!(
        !serde_json::to_string(&failure)
            .unwrap()
            .contains("never-load-this-value")
    );
}

#[test]
fn health_start_interval_is_reviewed_and_absent_values_preserve_serialization() {
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    healthcheck:\n      test: [CMD, 'true']\n      interval: 1s\n      start_period: 10s\n      start_interval: 100ms\n",
    );
    let review = fixture.plan();
    let health = review.plan.services["web"].healthcheck.as_ref().unwrap();
    assert_eq!(health.interval_nanos, Some(1_000_000_000));
    assert_eq!(health.start_interval_nanos, Some(100_000_000));
    assert_eq!(health.start_period_nanos, Some(10_000_000_000));
    assert!(review.plan.enrollment_compatible);
    let mut absent = health.clone();
    absent.start_interval_nanos = None;
    let value = serde_json::to_value(&absent).unwrap();
    assert!(value.get("start_interval_nanos").is_none());
    let decoded: project::HealthPlan = serde_json::from_value(value).unwrap();
    assert!(decoded.start_interval_nanos.is_none());
    fs::write(fixture.project.join("compose.yaml"), "services:\n  web:\n    image: alpine:3.21\n    healthcheck:\n      test: [CMD, 'true']\n      start_interval: invalid\n").unwrap();
    assert!(project::plan(&fixture.candidate, fixture.options()).is_err());
}

#[test]
fn scoped_environment_is_service_owned_and_separate_from_executable_configuration() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '$PUBLIC']\n    environment: {TOKEN: null, LABEL: '$PUBLIC'}\n  worker:\n    image: alpine:3.21\n    environment: [TOKEN]\n",
    );
    let review = fixture.plan();
    let public = BTreeMap::from([("PUBLIC".into(), "fixture-label".into())]);
    let managed = BTreeMap::from([
        (
            "web".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-web-$NO_EXPANSION\n'".into())]),
        ),
        (
            "worker".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-worker".into())]),
        ),
    ]);
    let result = inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &public,
        &managed,
    )
    .unwrap();
    assert!(result.executable.requires_managed_environment());
    assert_eq!(result.managed_environment, managed);
    assert_eq!(
        result.executable.services["web"].environment,
        ["LABEL=fixture-label"]
    );
    assert!(result.executable.services["worker"].environment.is_empty());
    assert_eq!(
        result.executable.services["web"].command.as_ref().unwrap(),
        &["echo", "fixture-label"]
    );
    let serialized = serde_json::to_string(&result.executable.review).unwrap();
    for values in managed.values() {
        for value in values.values() {
            assert!(!serialized.contains(value));
        }
    }
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn scoped_environment_refuses_cross_service_fallback_and_conflicting_owners() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    environment: {TOKEN: null, LABEL: fixed}\n  worker:\n    image: alpine:3.21\n    environment: [TOKEN]\n  inactive:\n    image: alpine:3.21\n    profiles: [optional]\n",
    );
    let review = fixture.plan();
    let values = BTreeMap::from([("TOKEN".into(), "synthetic-sensitive-value".into())]);
    let valid = BTreeMap::from([
        ("web".into(), values.clone()),
        ("worker".into(), values.clone()),
    ]);
    for case in 0..8 {
        let mut managed = valid.clone();
        let mut public = BTreeMap::new();
        let code = match case {
            0 => {
                managed.remove("worker");
                "execution_environment_missing"
            }
            1 => {
                managed.insert("unknown".into(), values.clone());
                "execution_environment_owner"
            }
            2 => {
                managed.insert("inactive".into(), values.clone());
                "execution_environment_owner"
            }
            3 => {
                managed
                    .get_mut("web")
                    .unwrap()
                    .insert("LABEL".into(), "synthetic-override".into());
                "execution_environment_owner"
            }
            4 => {
                managed
                    .get_mut("web")
                    .unwrap()
                    .insert("EXTRA".into(), "synthetic-extra".into());
                "execution_environment_owner"
            }
            5 => {
                public = values.clone();
                "execution_environment_owner"
            }
            6 => {
                managed
                    .get_mut("web")
                    .unwrap()
                    .insert("TOKEN".into(), "bad\0value".into());
                "execution_input_budget"
            }
            _ => {
                managed
                    .get_mut("web")
                    .unwrap()
                    .insert("TOKEN".into(), "x".repeat(1024 * 1024));
                "execution_input_budget"
            }
        };
        let failure = inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &public,
            &managed,
        )
        .err()
        .unwrap();
        assert_eq!(failure.code, code, "case {case}");
        assert!(
            !serde_json::to_string(&failure)
                .unwrap()
                .contains("synthetic")
        );
    }
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn scoped_environment_cannot_interpolate_into_any_executable_field() {
    use project::inputs;
    use std::collections::BTreeMap;
    for field in [
        "command: [echo, '$TOKEN']",
        "entrypoint: ['$TOKEN']",
        "user: '$TOKEN'",
        "healthcheck: {test: [CMD, '$TOKEN']}",
        "environment: {TOKEN: null, OTHER: '$TOKEN'}",
    ] {
        let environment = if field.starts_with("environment:") {
            ""
        } else {
            "    environment: [TOKEN]\n"
        };
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    {field}\n{environment}"
        ));
        let review = fixture.plan();
        let managed = BTreeMap::from([(
            "web".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-no-leak".into())]),
        )]);
        let failure = inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &BTreeMap::new(),
            &managed,
        )
        .err()
        .unwrap();
        assert_eq!(failure.code, "execution_environment_missing", "{field}");
        assert!(
            !serde_json::to_string(&failure)
                .unwrap()
                .contains("synthetic-no-leak")
        );
        assert!(!fixture.candidate.state_root.exists());
    }
}

#[test]
fn scoped_environment_preserves_empty_values_and_enforces_a_shared_budget() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    environment: [TOKEN]\n  worker:\n    image: alpine:3.21\n    environment: [TOKEN]\n",
    );
    let review = fixture.plan();
    let mut managed = BTreeMap::from([
        (
            "web".into(),
            BTreeMap::from([("TOKEN".into(), String::new())]),
        ),
        (
            "worker".into(),
            BTreeMap::from([("TOKEN".into(), String::new())]),
        ),
    ]);
    let result = inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
        &managed,
    )
    .unwrap();
    assert_eq!(result.managed_environment, managed);
    assert!(result.executable.requires_managed_environment());
    for values in managed.values_mut() {
        values.insert("TOKEN".into(), "x".repeat(600_000));
    }
    let failure = inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
        &managed,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "execution_input_budget");
    fs::write(
        fixture.project.join("compose.yaml"),
        "services: {web: {image: alpine:3.22}}",
    )
    .unwrap();
    let failure = inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &BTreeMap::new(),
        &managed,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "execution_plan_changed");
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn native_http_health_is_explicit_reviewed_and_rejects_mixed_semantics() {
    let native = r#"{"port":3000,"path":"/health","interval_ms":1000,"timeout_ms":200,"retries":3,"start_period_ms":0}"#;
    let document = |extra: &str| {
        format!(
            "services:\n  web:\n    image: alpine\n    healthcheck:\n      x-hack-http: {native}\n{extra}  client:\n    image: alpine\n    depends_on:\n      web:\n        condition: service_healthy\n"
        )
    };
    let fixture = Fixture::new(&document(""));
    let plan = fixture.plan();
    assert!(
        !plan
            .plan
            .diagnostics
            .iter()
            .any(|d| d.code == "missing_healthcheck" || d.code == "compose_extension_metadata")
    );
    let probe = plan.plan.services["web"]
        .healthcheck
        .as_ref()
        .unwrap()
        .native_http
        .as_ref()
        .unwrap();
    assert_eq!(probe.port, 3000);
    assert_eq!(probe.interval_ms, 1000);
    let malformed = Fixture::new(&document("      test: [CMD, /bin/true]\n"));
    assert!(project::plan(&malformed.candidate, malformed.options()).is_err());
    let malformed = Fixture::new(&document("").replace("/health", "/bad path"));
    assert!(project::plan(&malformed.candidate, malformed.options()).is_err());
}

#[test]
fn extra_hosts_review_and_compile_list_mapping_and_explicit_interpolation() {
    use project::inputs;
    use std::collections::BTreeMap;
    for declaration in [
        "['API.Example.:host-gateway', 'search.example=host-gateway']",
        "{API.Example.: host-gateway, search.example: host-gateway}",
        "['${ALIAS}:${TARGET}', 'search.example=host-gateway']",
    ] {
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: {declaration}\n"
        ));
        let review = fixture.plan();
        assert!(review.plan.enrollment_compatible);
        assert!(
            review
                .plan
                .diagnostics
                .iter()
                .any(|d| d.code == "explicit_dependency_binding_required")
        );
        assert_eq!(review.plan.services["web"].extra_hosts.len(), 2);
        let values = BTreeMap::from([
            ("ALIAS".into(), "API.Example.".into()),
            ("TARGET".into(), "host-gateway".into()),
        ]);
        let compiled = inputs::compile(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &values,
        )
        .unwrap();
        assert_eq!(
            compiled.services["web"].extra_hosts,
            BTreeMap::from([
                ("api.example".into(), "host-gateway".into()),
                ("search.example".into(), "host-gateway".into())
            ])
        );
        let serialized = serde_json::to_string(&review).unwrap();
        assert!(!serialized.contains("API.Example"));
        assert!(!serialized.contains("search.example"));
        assert!(!fixture.candidate.state_root.exists());
    }
}

#[test]
fn extra_hosts_reject_ambiguous_names_targets_and_over_budget() {
    use project::inputs;
    use std::collections::BTreeMap;
    for declaration in [
        "['api.example:host-gateway', 'API.EXAMPLE.=host-gateway']",
        "{api.example: host-gateway, API.EXAMPLE.: host-gateway}",
        "['*.example:host-gateway']",
        "['127.0.0.1:host-gateway']",
        "['api.example:127.0.0.1']",
        "['api.example:host.docker.internal']",
        "['api.example']",
        "{api.example: 42}",
    ] {
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: {declaration}\n"
        ));
        assert_eq!(
            project::plan(&fixture.candidate, fixture.options())
                .unwrap_err()
                .code,
            "invalid_extra_hosts"
        );
    }
    let entries = (0..33)
        .map(|n| format!("'alias{n}.example:host-gateway'"))
        .collect::<Vec<_>>()
        .join(",");
    let fixture = Fixture::new(&format!(
        "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: [{entries}]\n"
    ));
    assert_eq!(
        project::plan(&fixture.candidate, fixture.options())
            .unwrap_err()
            .code,
        "invalid_extra_hosts"
    );
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: ['api.example:host-gateway', '${ALIAS}:${TARGET}']\n",
    );
    let review = fixture.plan();
    for (alias, target, code) in [
        ("API.EXAMPLE.", "host-gateway", "invalid_extra_hosts"),
        ("other.example", "127.0.0.1", "invalid_extra_hosts"),
        ("bad\0name", "host-gateway", "execution_input_budget"),
    ] {
        let values = BTreeMap::from([
            ("ALIAS".into(), alias.into()),
            ("TARGET".into(), target.into()),
        ]);
        assert_eq!(
            inputs::compile(
                &fixture.candidate,
                fixture.options(),
                &review.plan_id,
                &values
            )
            .err()
            .unwrap()
            .code,
            code
        );
    }
}

#[test]
fn extra_hosts_plan_identity_changes_without_literal_disclosure() {
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: ['private-alias.example:host-gateway']\n",
    );
    let before = fixture.plan();
    fs::write(fixture.project.join("compose.yaml"), "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: ['other-private.example:host-gateway']\n").unwrap();
    let after = fixture.plan();
    assert_ne!(before.plan_id, after.plan_id);
    assert!(
        !serde_json::to_string(&before)
            .unwrap()
            .contains("private-alias")
    );
    assert!(
        !serde_json::to_string(&after)
            .unwrap()
            .contains("other-private")
    );
}

#[test]
fn extra_hosts_conditional_prefix_and_environment_default_use_only_explicit_inputs() {
    use project::inputs;
    use std::collections::BTreeMap;
    let fixture = Fixture::new(
        "services:\n  web:\n    image: alpine:3.21\n    extra_hosts: ['${HACK_REMOTE_RUNNER:+runner-noop-}vpc-tm-content-search-qa-iwwbua2zizenrkot6vtd3icrla.us-east-1.es.amazonaws.com:host-gateway', '${HACK_REMOTE_RUNNER:+runner-noop-}5klznku3031g8areuraj.us-east-1.aoss.amazonaws.com:host-gateway']\n    environment: {HACK_REMOTE_RUNNER: '${HACK_REMOTE_RUNNER:-0}'}\n",
    );
    let review = fixture.plan();
    for supplied in [None, Some(""), Some("1")] {
        let values = supplied
            .map(|v| BTreeMap::from([("HACK_REMOTE_RUNNER".into(), v.into())]))
            .unwrap_or_default();
        let compiled = inputs::compile(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &values,
        )
        .unwrap();
        assert_eq!(compiled.services["web"].extra_hosts.len(), 2);
        for alias in compiled.services["web"].extra_hosts.keys() {
            assert_eq!(alias.starts_with("runner-noop-"), supplied == Some("1"));
        }
        assert_eq!(
            compiled.services["web"].environment,
            [if supplied == Some("1") {
                "HACK_REMOTE_RUNNER=1"
            } else {
                "HACK_REMOTE_RUNNER=0"
            }]
        );
    }
    for expression in [
        "${INPUT:?required}",
        "${INPUT:+${OTHER}}",
        "${INPUT:-$OTHER}",
        "${INPUT-fallback}",
    ] {
        let fixture = Fixture::new(&format!(
            "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '{expression}']\n"
        ));
        let review = fixture.plan();
        assert_eq!(
            inputs::compile(
                &fixture.candidate,
                fixture.options(),
                &review.plan_id,
                &BTreeMap::new()
            )
            .err()
            .unwrap()
            .code,
            "execution_interpolation"
        );
    }
}

#[cfg(all(target_os = "macos", feature = "environment-launcher"))]
#[test]
fn foreground_private_environment_refuses_scope_before_dependency_owner_effects() {
    use std::{io::Write, process::Stdio};
    let fixture =
        Fixture::new("services:\n  web:\n    image: alpine:3.21\n    environment: [TOKEN]\n");
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let candidate = Candidate::discover(&compiled).unwrap();
    let plan = project::plan(&candidate, fixture.options())
        .unwrap()
        .plan_id;
    let run = fixture
        .root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .strip_prefix("hack-project-")
        .unwrap();
    let canary = "private-ingress-value-must-not-appear";
    for (services, expected) in [
        (
            serde_json::json!({"other":{"TOKEN":canary}}),
            "execution_environment_owner",
        ),
        (
            serde_json::json!({"web":{"OTHER":canary}}),
            "execution_environment_missing",
        ),
    ] {
        let payload = serde_json::to_vec(&serde_json::json!({
            "version":1,"plan":plan,"run":run,"lifetime_seconds":120,"services":services,
        }))
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .env_clear()
            .args([
                "--candidate-root",
                compiled.to_str().unwrap(),
                "graph",
                "serve",
                "--project",
                fixture.project.to_str().unwrap(),
                "--file",
                "compose.yaml",
                "--expect-plan",
                &plan,
                "--run-id",
                run,
                "--ready",
                "web=started",
                "--dependencies",
                fixture
                    .root
                    .join("absent-dependencies.json")
                    .to_str()
                    .unwrap(),
                "--expect-dependencies",
                &"a".repeat(64),
                "--environment-stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&payload).unwrap();
        let result = child.wait_with_output().unwrap();
        assert_eq!(result.status.code(), Some(2));
        let error: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(error["code"], expected);
        assert!(result.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&result.stderr).contains(canary));
        assert!(!candidate.state_root.join("run/graphs").join(run).exists());
    }
}

#[test]
fn dependency_cache_declaration_is_typed_and_requires_runtime_binding() {
    let mut compose = serde_json::json!({"services":{"deps":{"image":"fixture", "volumes":["node_modules:/app/node_modules"], "labels":{
        "hack.dependencies.cache-volume":"node_modules", "hack.dependencies.lockfiles":"bun.lock", "hack.dependencies.bootstrap":"true", "caddy":"router-canary"
    }}}, "volumes":{"node_modules":{}}});
    let fixture = Fixture::new(&compose.to_string());
    let before = fixture.plan();
    let cache = before.plan.services["deps"]
        .dependency_cache
        .as_ref()
        .unwrap();
    assert_eq!(cache.volume, "node_modules");
    assert!(cache.bootstrap && cache.lockfiles_explicit);
    let codes = fixture.codes();
    assert!(
        codes
            .iter()
            .any(|c| c == "dependency_cache_binding_required")
    );
    assert!(codes.iter().any(|c| c == "external_route_or_owner_label"));
    assert!(
        !serde_json::to_string(&before)
            .unwrap()
            .contains("router-canary")
    );
    compose["services"]["deps"]["labels"]["hack.dependencies.lockfiles"] =
        serde_json::json!("other.lock");
    fs::write(fixture.project.join("compose.yaml"), compose.to_string()).unwrap();
    assert_ne!(before.plan_id, fixture.plan().plan_id);
    compose["services"]["deps"]["volumes"] = serde_json::json!([]);
    fs::write(fixture.project.join("compose.yaml"), compose.to_string()).unwrap();
    assert!(project::plan(&fixture.candidate, fixture.options()).is_err());
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn dependency_cache_optional_bootstrap_label_is_not_a_malformed_cache() {
    let fixture = Fixture::new(
        "services:\n  deps:\n    image: fixture\n    labels:\n      hack.dependencies.bootstrap: 'true'\n",
    );
    assert!(
        fixture.plan().plan.services["deps"]
            .dependency_cache
            .is_none()
    );
    let codes = fixture.codes();
    assert!(
        codes
            .iter()
            .any(|code| code == "external_route_or_owner_label")
    );
    assert!(
        !codes
            .iter()
            .any(|code| code == "dependency_cache_binding_required")
    );
}

fn registry_fixture() -> Fixture {
    let compose = serde_json::json!({"services":{"deps":{"image":"alpine:3.21", "volumes":[".:/app:ro", "node_modules:/app/node_modules"], "labels":{
        "hack.dependencies.cache-volume":"node_modules", "hack.dependencies.lockfiles":"bun.lock", "hack.dependencies.bootstrap":"true"
    }}}, "volumes":{"node_modules":{}}});
    let fixture = Fixture::new(&compose.to_string());
    fs::write(fixture.project.join("bun.lock"), "fixture-lock").unwrap();
    fs::write(fixture.project.join(".npmrc"), "@fixture:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${REGISTRY_TOKEN}\n").unwrap();
    fixture
}

#[test]
fn registry_template_is_reviewed_materialized_and_stale_configuration_is_refused() {
    let fixture = registry_fixture();
    let review = fixture.plan();
    let registry = review.plan.registry.as_ref().unwrap();
    assert!(registry.required_environment.contains("REGISTRY_TOKEN"));
    let capture = || {
        project::snapshot::capture(
            &fixture.project,
            &Default::default(),
            &review.plan.source_selection.metadata_sha256,
        )
        .unwrap()
    };
    let raw = capture();
    assert!(!raw.receipt().entries.iter().any(|e| e.path == ".npmrc"));
    assert!(raw.receipt().verify_registry(&review.plan).is_err());
    let snapshot = raw
        .with_mountpoints(&review.plan)
        .unwrap()
        .with_registry(&review.plan)
        .unwrap();
    snapshot.receipt().verify_registry(&review.plan).unwrap();
    let (_, bytes) = snapshot.files().find(|(e, _)| e.path == ".npmrc").unwrap();
    assert_eq!(bytes, registry.template.as_bytes());
    let revision = snapshot.receipt().revision.clone();
    assert_eq!(
        snapshot
            .with_registry(&review.plan)
            .unwrap()
            .receipt()
            .revision,
        revision
    );
    assert!(!fixture.project.join("node_modules").exists());
    fs::write(
        fixture.project.join(".npmrc"),
        "registry=https://registry.npmjs.org/\n",
    )
    .unwrap();
    assert!(capture().with_registry(&review.plan).is_err());
    assert_ne!(review.plan_id, fixture.plan().plan_id);
}

#[test]
fn registry_credentials_require_private_delivery_and_never_enter_public_environment() {
    use std::collections::BTreeMap;
    let fixture = registry_fixture();
    let review = fixture.plan();
    let empty = BTreeMap::new();
    let managed = BTreeMap::from([(
        "deps".into(),
        BTreeMap::from([("REGISTRY_TOKEN".into(), "synthetic-registry-canary".into())]),
    )]);
    assert!(
        project::inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &empty,
            &BTreeMap::new()
        )
        .is_err()
    );
    let result = project::inputs::compile_scoped(
        &fixture.candidate,
        fixture.options(),
        &review.plan_id,
        &empty,
        &managed,
    )
    .unwrap();
    assert!(result.executable.requires_managed_environment());
    assert_eq!(result.managed_environment, managed);
    assert!(result.executable.services["deps"].environment.is_empty());
    assert!(
        !serde_json::to_string(&result.executable.review)
            .unwrap()
            .contains("synthetic-registry-canary")
    );
    let public = BTreeMap::from([("REGISTRY_TOKEN".into(), "synthetic-registry-canary".into())]);
    assert!(
        project::inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &public,
            &BTreeMap::new()
        )
        .is_err()
    );
    let blank = BTreeMap::from([(
        "deps".into(),
        BTreeMap::from([("REGISTRY_TOKEN".into(), String::new())]),
    )]);
    assert!(
        project::inputs::compile_scoped(
            &fixture.candidate,
            fixture.options(),
            &review.plan_id,
            &empty,
            &blank
        )
        .is_err()
    );
}

#[test]
fn registry_capture_does_not_change_reviewed_mount_permissions() {
    let fixture = registry_fixture();
    let compose = fs::read_to_string(fixture.project.join("compose.yaml"))
        .unwrap()
        .replace(".:/app:ro", ".:/app:rw");
    fs::write(fixture.project.join("compose.yaml"), compose).unwrap();
    let review = fixture.plan();
    assert!(
        !review.plan.services["deps"]
            .mounts
            .iter()
            .find(|m| m.kind == "bind")
            .unwrap()
            .read_only
    );
    let captured = project::snapshot::capture(
        &fixture.project,
        &Default::default(),
        &review.plan.source_selection.metadata_sha256,
    )
    .unwrap()
    .with_registry(&review.plan)
    .unwrap();
    captured.receipt().verify_registry(&review.plan).unwrap();
    assert_eq!(review.plan_id, fixture.plan().plan_id);
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn named_volume_subpaths_are_explicit_canonical_and_plan_bound() {
    let make = |path: &str| {
        format!(
            "services:\n  app:\n    image: alpine\n    volumes:\n      - type: volume\n        source: cache\n        target: /app/node_modules\n        volume:\n          subpath: {path:?}\nvolumes:\n  cache: {{}}\n"
        )
    };
    let fixture = Fixture::new(&make("workspaces/one"));
    let first = project::plan(&fixture.candidate, fixture.options()).unwrap();
    assert_eq!(
        first.plan.services["app"].mounts[0].subpath.as_deref(),
        Some("workspaces/one")
    );
    fs::write(fixture.project.join("compose.yaml"), make("workspaces/two")).unwrap();
    let second = project::plan(&fixture.candidate, fixture.options()).unwrap();
    assert_ne!(first.plan.compose_sha256, second.plan.compose_sha256);
    for path in ["../escape", "/absolute", "a//b", "a/./b", "a/", "${PATH}"] {
        fs::write(fixture.project.join("compose.yaml"), make(path)).unwrap();
        assert!(project::plan(&fixture.candidate, fixture.options()).is_err());
    }
}
