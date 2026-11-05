//! `runtime build-image` against a fake pool and a fake build client.
//!
//! The fake client is `/bin/sh` reading a script named `build` from the client's private
//! working directory, so no test writes and then executes a fresh binary. It records its
//! argv, the one build-argument variable it was given, and a call count.
use super::*;
use std::{cell::RefCell, os::unix::fs::PermissionsExt};

const IMAGE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET: &str = "literal-value-that-must-not-leak";

struct Fixture {
    root: PathBuf,
    candidate: Candidate,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = crate::test_root::private_test_root(&tmp, "hack-image-build");
        let checkout = root.join("checkout");
        state::private_directory(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        fs::create_dir(project.join("app")).unwrap();
        fs::write(
            project.join("app/Dockerfile"),
            "ARG BASE=alpine:3.20\nFROM ${BASE}\nARG GREETING\nRUN echo hi\n",
        )
        .unwrap();
        fs::write(project.join("app/main.txt"), "one").unwrap();
        Self {
            root,
            candidate,
            project,
        }
    }
    fn request(&self, policy: Policy) -> BuildRequest {
        BuildRequest {
            version: 1,
            project_root: self.project.clone(),
            branch: None,
            context: "app".into(),
            dockerfile: "Dockerfile".into(),
            target: None,
            args: BTreeMap::from([("GREETING".to_owned(), SECRET.to_owned())]),
            policy,
            timeout_seconds: Some(30),
        }
    }
    fn inputs(&self, policy: Policy) -> Inputs {
        prepare(self.request(policy)).unwrap()
    }
    fn scratch(&self, inputs: &Inputs) -> PathBuf {
        builds_root(&self.candidate)
            .join(&inputs.namespace)
            .join(format!("{}.client", inputs.key))
    }
    fn receipt(&self, inputs: &Inputs) -> Receipt {
        state::read(
            &builds_root(&self.candidate)
                .join(&inputs.namespace)
                .join(format!("{}.json", inputs.key)),
        )
        .unwrap()
    }
    /// Install the fake client for this build key. `mode` selects its behavior.
    fn client(&self, inputs: &Inputs, mode: &str) {
        let scratch = self.scratch(inputs);
        state::private_directory(&scratch).unwrap();
        let script = format!(
            r#"set -eu
count=$(cat calls 2>/dev/null || echo 0)
echo $((count + 1)) > calls
printf '%s\n' "$@" > argv
printf '%s' "${{GREETING-}}" > greeting
meta=
previous=
for argument do
  if [ "$previous" = --metadata-file ]; then meta=$argument; fi
  previous=$argument
done
case {mode} in
  ok) printf '{{"containerimage.config.digest":"{IMAGE}"}}' > "$meta" ;;
  fail) exit 3 ;;
  nometa) ;;
  sleep) sleep 30 & echo $! > child.pending; mv child.pending child; wait ;;
esac
"#
        );
        fs::write(scratch.join("build"), script).unwrap();
        fs::set_permissions(scratch.join("build"), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn calls(&self, inputs: &Inputs) -> u32 {
        fs::read_to_string(self.scratch(inputs).join("calls"))
            .map(|v| v.trim().parse().unwrap())
            .unwrap_or(0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn identity(incarnation: &str) -> PoolIdentity {
    PoolIdentity {
        incarnation: incarnation.into(),
        boot_id: "boot-1".into(),
        engine_id: "engine-1".into(),
        socket: PathBuf::from("/nonexistent/docker.sock"),
    }
}

/// A fake pool: identities returned per lease in order (the last repeats), images by ID.
struct FakePool {
    removable: RefCell<BTreeMap<String, bool>>,
    removed: RefCell<Vec<String>>,
    identities: RefCell<Vec<PoolIdentity>>,
    images: RefCell<BTreeMap<String, Value>>,
    leases: RefCell<u32>,
    resolve_error: bool,
    available: RefCell<u64>,
    prunes: RefCell<Vec<u64>>,
}
impl FakePool {
    fn new(incarnation: &str) -> Self {
        Self {
            removable: RefCell::new(BTreeMap::new()),
            removed: RefCell::new(Vec::new()),
            identities: RefCell::new(vec![identity(incarnation)]),
            images: RefCell::new(BTreeMap::new()),
            leases: RefCell::new(0),
            resolve_error: false,
            available: RefCell::new(64 * GIB),
            prunes: RefCell::new(Vec::new()),
        }
    }
    /// Register the image the fake client "builds", with the labels the build expects.
    fn built(&self, inputs: &Inputs, incarnation: &str, extra: Value) {
        let mut labels = serde_json::to_value(labels(inputs, &identity(incarnation))).unwrap();
        if let Value::Object(more) = extra {
            labels.as_object_mut().unwrap().extend(more);
        }
        self.images.borrow_mut().insert(
            IMAGE.into(),
            serde_json::json!({"Id": IMAGE, "Architecture": "arm64", "Os": "linux",
                "Size": 5 * GIB, "Config": {"Labels": labels, "Volumes": null}}),
        );
    }
}
impl BuildPool for FakePool {
    type Lease = ();
    fn lease(&self) -> Result<((), PoolIdentity), CandidateError> {
        *self.leases.borrow_mut() += 1;
        let mut identities = self.identities.borrow_mut();
        let current = if identities.len() > 1 {
            identities.remove(0)
        } else {
            identities[0].clone()
        };
        Ok(((), current))
    }
    fn inspect(&self, _: &(), image: &str) -> Result<Option<Value>, CandidateError> {
        Ok(self.images.borrow().get(image).cloned())
    }
    fn resolve(&self, base: &BaseImage) -> Result<BuildBase, CandidateError> {
        if self.resolve_error {
            return Err(CandidateError::new("registry_image", "offline"));
        }
        Ok(BuildBase {
            pinned_reference: format!("docker.io/{}@{PIN}", base.repository()),
            source_digest: PIN.into(),
            image_id: IMAGE.into(),
        })
    }
    fn builder(&self) -> Result<PathBuf, CandidateError> {
        Ok(PathBuf::from("/bin/sh"))
    }
    fn storage_available(&self, _: &()) -> Result<u64, CandidateError> {
        Ok(*self.available.borrow())
    }
    fn prune_cache(&self, _: &(), max_used: u64) -> Result<u64, CandidateError> {
        self.prunes.borrow_mut().push(max_used);
        Ok(7)
    }
}

fn never() -> bool {
    false
}

#[test]
fn cold_build_passes_values_only_through_the_environment_and_records_the_result() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(outcome.image_id, IMAGE);
    assert!(!outcome.reused);
    assert_eq!(
        outcome.base_pins,
        BTreeMap::from([(
            "alpine:3.20".to_owned(),
            format!("docker.io/library/alpine@{PIN}")
        )])
    );
    let scratch = fixture.scratch(&inputs);
    let argv = fs::read_to_string(scratch.join("argv")).unwrap();
    assert!(!argv.contains(SECRET), "argument value reached argv");
    let lines: Vec<&str> = argv.lines().collect();
    assert!(lines.windows(2).any(|w| w == ["--build-arg", "GREETING"]));
    assert!(lines.windows(2).any(|w| w
        == [
            "--build-context",
            &format!("alpine:3.20=docker-image://docker.io/library/alpine@{PIN}")
        ]));
    assert!(lines.windows(2).any(|w| w == ["--platform", "linux/arm64"]));
    assert!(lines.contains(&"--provenance=false"));
    assert!(
        lines
            .windows(2)
            .any(|w| w == ["--label", "io.hack-local.kind=build-image"])
    );
    assert!(
        !argv.contains("pool-1"),
        "the pool incarnation reached argv"
    );
    assert_eq!(
        fs::read_to_string(scratch.join("greeting")).unwrap(),
        SECRET
    );
    let receipt = fixture.receipt(&inputs);
    assert_eq!(receipt.phase, Phase::ContentIdVerified);
    assert_eq!(receipt.image_id.as_deref(), Some(IMAGE));
    let text = fs::read_to_string(
        builds_root(&fixture.candidate)
            .join(&inputs.namespace)
            .join(format!("{}.json", inputs.key)),
    )
    .unwrap();
    assert!(!text.contains(SECRET), "argument value reached the receipt");
}

#[test]
fn verified_image_is_reused_without_running_the_client() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let again = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(again.reused);
    assert_eq!(again.image_id, IMAGE);
    assert_eq!(fixture.calls(&inputs), 1);
    // An explicit rebuild runs the client again.
    let rebuild = fixture.inputs(Policy::Rebuild);
    let rebuilt = run(&fixture.candidate, &pool, &rebuild, &never).unwrap();
    assert!(!rebuilt.reused);
    assert_eq!(fixture.calls(&inputs), 2);
}

#[test]
fn a_new_incarnation_or_a_missing_or_relabeled_image_is_built_again() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();

    // Storage recreated: the old receipt is never trusted.
    let recreated = FakePool::new("pool-2");
    recreated.built(&inputs, "pool-2", serde_json::json!({}));
    assert!(
        !run(&fixture.candidate, &recreated, &inputs, &never)
            .unwrap()
            .reused
    );
    assert_eq!(fixture.calls(&inputs), 2);

    // Image removed from the engine.
    recreated.images.borrow_mut().clear();
    let error = run(&fixture.candidate, &recreated, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_image");
    assert_eq!(fixture.calls(&inputs), 3);
    assert_eq!(fixture.receipt(&inputs).phase, Phase::Failed);

    // Same ID with labels that are not ours is never adopted.
    recreated.built(&inputs, "pool-1", serde_json::json!({}));
    let error = run(&fixture.candidate, &recreated, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_reserved_label");
    assert_eq!(fixture.receipt(&inputs).phase, Phase::Failed);
}

#[test]
fn reserved_labels_and_image_volumes_refuse_adoption() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    pool.built(
        &inputs,
        "pool-1",
        serde_json::json!({"io.hack-local.graph": "forged"}),
    );
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_reserved_label");
    assert!(!error.message.contains("forged"));

    pool.built(
        &inputs,
        "pool-1",
        serde_json::json!({"com.docker.compose.project": "x"}),
    );
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_reserved_label"
    );

    pool.built(&inputs, "pool-1", serde_json::json!({"org.example": "ok"}));
    pool.images.borrow_mut().get_mut(IMAGE).unwrap()["Config"]["Volumes"] =
        serde_json::json!({"/data": {}});
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_image_volumes"
    );

    pool.images.borrow_mut().get_mut(IMAGE).unwrap()["Config"]["Volumes"] = Value::Null;
    pool.images.borrow_mut().get_mut(IMAGE).unwrap()["Architecture"] = "amd64".into();
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_image"
    );
}

#[test]
fn client_failure_and_missing_metadata_adopt_nothing() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "fail");
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_failed");
    let receipt = fixture.receipt(&inputs);
    assert_eq!(receipt.phase, Phase::Failed);
    assert!(receipt.image_id.is_none());

    fixture.client(&inputs, "nometa");
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_image");
}

fn wait_dead(pid: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while process_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!process_alive(pid), "a client group member survived");
}

fn process_alive(pid: &str) -> bool {
    let pid: libc::pid_t = pid.trim().parse().unwrap();
    // SAFETY: signal 0 only probes existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn timeout_and_cancellation_stop_the_whole_client_group() {
    let fixture = Fixture::new();
    let mut request = fixture.request(Policy::Missing);
    request.timeout_seconds = Some(1);
    let inputs = prepare(request).unwrap();
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "sleep");
    let started = Instant::now();
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_timeout");
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(fixture.receipt(&inputs).phase, Phase::Canceled);
    // On a loaded host the client may not have forked its child within the budget.
    let child = fixture.scratch(&inputs).join("child");
    if let Ok(pid) = fs::read_to_string(&child) {
        wait_dead(&pid);
    }

    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "sleep");
    let _ = fs::remove_file(&child);
    let marker = child.clone();
    let cancel = move || marker.exists();
    let error = run(&fixture.candidate, &pool, &inputs, &cancel).unwrap_err();
    assert_eq!(error.code, "native_build_canceled");
    assert_eq!(fixture.receipt(&inputs).phase, Phase::Canceled);
    // Cancellation was requested only once the child existed (published atomically).
    wait_dead(&fs::read_to_string(&child).unwrap());

    // A request canceled before the client starts never runs it.
    let error = run(&fixture.candidate, &pool, &inputs, &|| true).unwrap_err();
    assert_eq!(error.code, "native_build_canceled");
}

#[test]
fn a_dead_attempt_is_recorded_indeterminate_and_built_again() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let directory = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&directory).unwrap();
    let path = directory.join(format!("{}.json", inputs.key));
    let leftover = Receipt {
        version: 1,
        checkout: fixture.candidate.checkout.clone(),
        namespace: inputs.namespace.clone(),
        build_key: inputs.key.clone(),
        provider_incarnation: "pool-1".into(),
        provider_boot_id: "boot-1".into(),
        engine_id: "engine-1".into(),
        phase: Phase::Building,
        image_id: None,
        image_bytes: None,
        base_pins: BTreeMap::new(),
    };
    state::write(&path, &leftover).unwrap();
    // Even with an adoptable image present, the dead attempt's receipt is not trusted.
    let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(!outcome.reused);
    assert_eq!(fixture.receipt(&inputs).phase, Phase::ContentIdVerified);

    // A receipt that names another key is never adopted or replaced.
    let mut foreign = leftover;
    foreign.build_key = "0".repeat(64);
    fs::remove_file(&path).unwrap();
    state::write(&path, &foreign).unwrap();
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_receipt"
    );
}

#[test]
fn the_pool_must_be_unchanged_between_admission_and_adoption() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    let mut rebooted = identity("pool-1");
    rebooted.boot_id = "boot-2".into();
    *pool.identities.borrow_mut() = vec![identity("pool-1"), identity("pool-1"), rebooted];
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "runtime_changed");
    assert_eq!(fixture.receipt(&inputs).phase, Phase::Indeterminate);

    // A change before the client starts runs nothing.
    let pool = FakePool::new("pool-1");
    *pool.identities.borrow_mut() = vec![identity("pool-1"), identity("pool-9")];
    let calls = fixture.calls(&inputs);
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "runtime_changed"
    );
    assert_eq!(fixture.calls(&inputs), calls);
}

#[test]
fn the_key_lock_and_the_down_fence_refuse_instead_of_waiting() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    let directory = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&directory).unwrap();
    let held = Flock::try_lock(
        Flock::open(&directory.join(format!("{}.lock", inputs.key))).unwrap(),
        libc::LOCK_EX,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_busy"
    );
    drop(held);

    assert!(require_no_active_build(&fixture.candidate).is_ok());
    let build = Flock::try_lock(
        Flock::open(&builds_root(&fixture.candidate).join("active.lock")).unwrap(),
        libc::LOCK_SH,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        require_no_active_build(&fixture.candidate)
            .unwrap_err()
            .code,
        "provider_busy"
    );
    drop(build);
    assert!(require_no_active_build(&fixture.candidate).is_ok());
}

#[test]
fn base_resolution_failures_run_nothing() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let mut pool = FakePool::new("pool-1");
    pool.resolve_error = true;
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "registry_image"
    );
    assert_eq!(fixture.calls(&inputs), 0);
}

fn code(request: BuildRequest) -> &'static str {
    prepare(request).unwrap_err().code
}

#[test]
fn requests_refuse_unsafe_paths_arguments_and_bounds() {
    let fixture = Fixture::new();
    let base = || fixture.request(Policy::Missing);

    let mut request = base();
    request.version = 2;
    assert_eq!(code(request), "native_build_request");
    let mut request = base();
    request.project_root = PathBuf::from("relative");
    assert_eq!(code(request), "native_build_request");
    let mut request = base();
    request.project_root = fixture.project.join("app/..");
    assert_eq!(code(request), "native_build_source");
    let mut request = base();
    request.context = "../outside".into();
    assert_eq!(code(request), "source_escape");
    let mut request = base();
    request.dockerfile = "../../Dockerfile".into();
    assert_eq!(code(request), "source_escape");
    std::os::unix::fs::symlink(fixture.project.join("app"), fixture.project.join("link")).unwrap();
    let mut request = base();
    request.context = "link".into();
    assert_eq!(code(request), "source_symlink");
    let mut request = base();
    request.context = "missing".into();
    assert_eq!(code(request), "missing_source");
    let mut request = base();
    request.branch = Some("Not_A_Label".into());
    assert_eq!(code(request), "native_build_request");
    let mut request = base();
    request.target = Some("-bad".into());
    assert_eq!(code(request), "native_build_request");
    for timeout in [0, MAX_TIMEOUT_SECONDS + 1] {
        let mut request = base();
        request.timeout_seconds = Some(timeout);
        assert_eq!(code(request), "native_build_request");
    }
    for name in [
        "PATH",
        "home",
        "DOCKER_HOST",
        "BUILDX_CONFIG",
        "BUILDKIT_SYNTAX",
        "HTTPS_PROXY",
        "no_proxy",
        "LC_ALL",
        "GIT_DIR",
        "SSH_AUTH_SOCK",
        "1BAD",
        "bad-name",
        "",
    ] {
        let mut request = base();
        request.args = BTreeMap::from([(name.to_owned(), "x".to_owned())]);
        assert_eq!(code(request), "native_build_argument", "{name}");
    }
    let mut request = base();
    request.args = BTreeMap::from([("GREETING".to_owned(), "a\0b".to_owned())]);
    assert_eq!(code(request), "native_build_argument");
    let mut request = base();
    request.args = (0..=MAX_ARGS)
        .map(|i| (format!("A{i}"), "x".into()))
        .collect();
    assert_eq!(code(request), "native_build_argument");
    let mut request = base();
    request.args = BTreeMap::from([("BIG".to_owned(), "x".repeat(MAX_ARG_BYTES))]);
    assert_eq!(code(request), "native_build_argument");
    // Refusals never echo argument values.
    let mut request = base();
    request.args = BTreeMap::from([("DOCKER_HOST".to_owned(), SECRET.to_owned())]);
    assert!(!prepare(request).unwrap_err().message.contains(SECRET));
}

#[test]
fn the_build_key_binds_local_inputs_but_not_context_contents() {
    let fixture = Fixture::new();
    let key = |request: BuildRequest| prepare(request).unwrap().key;
    let original = key(fixture.request(Policy::Missing));
    assert_eq!(original, key(fixture.request(Policy::Rebuild)));

    fs::write(fixture.project.join("app/main.txt"), "two").unwrap();
    assert_eq!(original, key(fixture.request(Policy::Missing)));

    let mut request = fixture.request(Policy::Missing);
    request.args.insert("GREETING".into(), "other".into());
    assert_ne!(original, key(request));
    let mut request = fixture.request(Policy::Missing);
    request.branch = Some("feature".into());
    let branched = prepare(request).unwrap();
    assert_ne!(original, branched.key);
    assert_ne!(
        branched.namespace,
        fixture.inputs(Policy::Missing).namespace
    );

    fs::write(fixture.project.join("app/.dockerignore"), "*.txt\n").unwrap();
    let ignored = key(fixture.request(Policy::Missing));
    assert_ne!(original, ignored);
    fs::write(
        fixture.project.join("app/Dockerfile.dockerignore"),
        "*.md\n",
    )
    .unwrap();
    assert_ne!(ignored, key(fixture.request(Policy::Missing)));

    fs::write(
        fixture.project.join("app/Dockerfile"),
        "FROM alpine:3.21\nRUN echo hi\n",
    )
    .unwrap();
    assert_ne!(original, key(fixture.request(Policy::Missing)));

    let inputs = fixture.inputs(Policy::Missing);
    let tag = inputs.tag();
    assert!(tag.starts_with("hack-local-build/"));
    assert_eq!(tag.len(), "hack-local-build/".len() + 12 + 1 + 32);
}

#[test]
fn dockerfile_and_ignore_inputs_must_be_plain_files() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(
        fixture.project.join("app/main.txt"),
        fixture.project.join("app/.dockerignore"),
    )
    .unwrap();
    assert_eq!(
        code(fixture.request(Policy::Missing)),
        "native_build_source"
    );
    fs::remove_file(fixture.project.join("app/.dockerignore")).unwrap();
    fs::hard_link(
        fixture.project.join("app/Dockerfile"),
        fixture.project.join("Dockerfile.copy"),
    )
    .unwrap();
    assert_eq!(
        code(fixture.request(Policy::Missing)),
        "native_build_source"
    );
}

#[test]
fn owner_labels_never_carry_the_incarnation() {
    let label = owner_label("0123456789abcdef0123456789abcdef");
    assert_eq!(label.len(), 32);
    assert!(!label.contains("0123456789abcdef"));
    assert_ne!(label, owner_label("another"));
}

/// Run guest-daemon.sh with `dockerd` replaced by a shell function that records its argv.
fn daemon_arguments(mode: &str) -> (bool, String) {
    let tmp = std::env::temp_dir().canonicalize().unwrap();
    let root = crate::test_root::private_test_root(&tmp, "hack-guest-daemon");
    let script = format!(
        "dockerd() {{ printf '%s\\n' \"$@\" > '{}/argv'; }}\n{}",
        root.display(),
        include_str!("../guest-daemon.sh")
    );
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", &script, "daemon-test", mode])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    let argv = fs::read_to_string(root.join("argv")).unwrap_or_default();
    fs::remove_dir_all(&root).unwrap();
    (status.code() == Some(64), argv)
}

#[test]
fn only_egress_pools_get_the_fixed_build_bridge() {
    let (refused, argv) = daemon_arguments("isolated");
    assert!(!refused);
    assert!(argv.lines().any(|l| l == "--bridge=none"));
    assert!(!argv.contains("--bip"));
    for mode in ["internet", "approved-hosts", "host-gateway"] {
        let (refused, argv) = daemon_arguments(mode);
        assert!(!refused, "{mode}");
        let lines: Vec<&str> = argv.lines().collect();
        assert!(lines.contains(&"--bip=10.213.255.1/24"), "{mode}");
        assert!(lines.contains(&"--icc=false"), "{mode}");
        assert!(!lines.contains(&"--bridge=none"), "{mode}");
        assert!(lines.contains(&"--iptables=true"), "{mode}");
        assert_eq!(
            lines.contains(&"--host-gateway-ip=100.96.0.1"),
            mode == "host-gateway"
        );
    }
    let (refused, argv) = daemon_arguments("bridge");
    assert!(refused);
    assert!(argv.is_empty());
    assert_eq!(BUILD_NETWORK_SUBNET, "10.213.255.0/24");
}

#[test]
fn build_network_script_parses_and_ignores_isolated_pools() {
    let script = include_str!("../guest-build-network.sh");
    let run = |args: &[&str]| {
        std::process::Command::new("/bin/sh")
            .args(["-c", script, "network-test"])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .code()
    };
    assert!(
        std::process::Command::new("/bin/sh")
            .args(["-n", "-c", script])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(run(&["isolated", "boot"]), Some(0));
    assert_eq!(run(&["bridge", "boot"]), Some(64));
    assert_eq!(run(&[]), Some(64));
    assert!(script.contains(BUILD_NETWORK_MARKER));
}

#[test]
fn cold_builds_need_free_storage_and_successful_builds_prune_the_cache() {
    assert_eq!(storage_required(None), 6 * GIB);
    assert_eq!(storage_required(Some(GIB)), 6 * GIB);
    assert_eq!(storage_required(Some(5 * GIB)), 10 * GIB);
    assert_eq!(storage_required(Some(u64::MAX)), u64::MAX);

    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    *pool.available.borrow_mut() = 6 * GIB - 1;
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_storage");
    assert_eq!(fixture.calls(&inputs), 0);

    *pool.available.borrow_mut() = 6 * GIB;
    let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(outcome.cache_reclaimed_bytes, Some(7));
    assert_eq!(*pool.prunes.borrow(), vec![CACHE_BUDGET]);
    assert_eq!(fixture.receipt(&inputs).image_bytes, Some(5 * GIB));

    // The next cold build of this key needs twice the last verified image.
    let rebuild = fixture.inputs(Policy::Rebuild);
    let error = run(&fixture.candidate, &pool, &rebuild, &never).unwrap_err();
    assert_eq!(error.code, "native_build_storage");
    // A warm reuse needs no free-space headroom.
    let reused = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(reused.reused);
    assert_eq!(pool.prunes.borrow().len(), 1);
}

impl reclaim::ReclaimPool for FakePool {
    fn build_images(&self, _: &()) -> Result<Vec<Value>, CandidateError> {
        Ok(self
            .images
            .borrow()
            .values()
            .map(
                |image| serde_json::json!({"Id": image["Id"], "Labels": image["Config"]["Labels"]}),
            )
            .collect())
    }
    fn remove(&self, _: &(), image: &str) -> Result<bool, CandidateError> {
        let allowed = self.removable.borrow().get(image).copied().unwrap_or(true);
        if allowed {
            self.removed.borrow_mut().push(image.to_owned());
            self.images.borrow_mut().remove(image);
        }
        Ok(allowed)
    }
}

#[test]
fn reclamation_keeps_current_referenced_in_use_and_foreign_images() {
    const OLD: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const KEPT: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const BUSY: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let current = pool.images.borrow()[IMAGE].clone();
    for id in [OLD, KEPT, BUSY] {
        let mut superseded = current.clone();
        superseded["Id"] = id.into();
        pool.images.borrow_mut().insert(id.into(), superseded);
    }
    pool.removable.borrow_mut().insert(BUSY.into(), false);
    let graphs = fixture.candidate.state_root.join("run/graphs/0123");
    state::private_directory(&graphs).unwrap();
    fs::write(
        graphs.join("receipt.json"),
        format!("{{\"image\":\"{KEPT}\"}}"),
    )
    .unwrap();

    // Nothing is removed while a build is admitted.
    let build = Flock::try_lock(
        Flock::open(&builds_root(&fixture.candidate).join("active.lock")).unwrap(),
        libc::LOCK_SH,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        reclaim::run(&fixture.candidate, &pool).unwrap_err().code,
        "provider_busy"
    );
    drop(build);

    let report = reclaim::run(&fixture.candidate, &pool).unwrap();
    assert_eq!(report.removed, vec![OLD.to_owned()]);
    assert_eq!(report.retained[IMAGE], reclaim::Retained::Current);
    assert_eq!(report.retained[KEPT], reclaim::Retained::Referenced);
    assert_eq!(report.retained[BUSY], reclaim::Retained::EngineRefused);
    assert_eq!(report.cache_reclaimed_bytes, Some(7));
    // Another pool's images are never this pool's to remove.
    let other = FakePool::new("pool-2");
    other
        .images
        .borrow_mut()
        .extend(pool.images.borrow().clone());
    let report = reclaim::run(&fixture.candidate, &other).unwrap();
    assert!(report.removed.is_empty());
    assert!(
        report
            .retained
            .values()
            .all(|r| *r == reclaim::Retained::NotOwned)
    );
}
