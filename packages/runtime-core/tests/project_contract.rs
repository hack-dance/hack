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
        "services:\n  web:\n    image: alpine:3.21\n    command: [echo, '${INPUT:-fallback}']\n",
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
