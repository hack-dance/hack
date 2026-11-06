//! `runtime build-image` against a fake pool and a fake build client.
//!
//! The fake client is `/bin/sh` reading a script named `bake` (its first argument) from
//! the client's private working directory, so no test writes and then executes a fresh
//! binary. It records its argv, its whole environment, a copy of the bake definition,
//! the staged Dockerfile and ignore rules, and a call count.
use super::*;
use std::{
    cell::RefCell,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
};

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
env > env
[ -n "${{EXPERIMENTAL_BUILDKIT_SOURCE_POLICY-}}" ] || exit 9
cat "$EXPERIMENTAL_BUILDKIT_SOURCE_POLICY" > seen-policy.json
printf '%s' "$EXPERIMENTAL_BUILDKIT_SOURCE_POLICY" > seen-policy-path
meta=
file=
previous=
for argument do
  if [ "$previous" = --metadata-file ]; then meta=$argument; fi
  if [ "$previous" = --file ]; then file=$argument; fi
  previous=$argument
done
cat "$file" > seen-bake.json
cat dockerfile/Dockerfile > seen-dockerfile
cat dockerfile/Dockerfile.dockerignore > seen-dockerignore
case {mode} in
  ok) printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  leak)
    printf '#5 0.1 value=%s\n\033[31mred\033[0m\033]0;title\007\n' '{SECRET}' >&2
    printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  fail) exit 3 ;;
  nometa) ;;
  sleep) sleep 30 & echo $! > child.pending; mv child.pending child; wait ;;
esac
"#
        );
        fs::write(scratch.join("bake"), script).unwrap();
        fs::set_permissions(scratch.join("bake"), fs::Permissions::from_mode(0o600)).unwrap();
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
    identities: RefCell<Vec<PoolIdentity>>,
    images: RefCell<BTreeMap<String, Value>>,
    leases: RefCell<u32>,
    resolve_error: bool,
    resolve_delay: Duration,
    resolve_deadlines: RefCell<Vec<Instant>>,
    output: Arc<Mutex<Vec<u8>>>,
}
impl FakePool {
    fn new(incarnation: &str) -> Self {
        Self {
            identities: RefCell::new(vec![identity(incarnation)]),
            images: RefCell::new(BTreeMap::new()),
            leases: RefCell::new(0),
            resolve_error: false,
            resolve_delay: Duration::ZERO,
            resolve_deadlines: RefCell::new(Vec::new()),
            output: Arc::default(),
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
                "Config": {"Labels": labels, "Volumes": null}}),
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
    fn resolve(
        &self,
        base: &BaseImage,
        deadline: Instant,
        _: &dyn Fn() -> bool,
    ) -> Result<BuildBase, CandidateError> {
        self.resolve_deadlines.borrow_mut().push(deadline);
        std::thread::sleep(self.resolve_delay);
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
    fn output(&self) -> Box<dyn Write + Send> {
        Box::new(Captured(Arc::clone(&self.output)))
    }
}

/// The caller's stream as the fake pool sees it.
struct Captured(Arc<Mutex<Vec<u8>>>);
impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn never() -> bool {
    false
}

#[test]
fn cold_build_passes_values_only_through_the_private_definition_and_records_the_result() {
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
    // `sh` ran the script named by the first argument, so that argument was `bake`.
    assert_eq!(lines.last(), Some(&"build"));
    assert!(lines.contains(&"--provenance=false") && lines.contains(&"--sbom=false"));
    assert!(lines.windows(2).any(|w| w[0] == "--allow"
        && w[1] == format!("fs.read={}", fixture.project.join("app").display())));
    assert!(
        !argv.contains("pool-1"),
        "the pool incarnation reached argv"
    );
    let env = fs::read_to_string(scratch.join("env")).unwrap();
    assert!(
        !env.contains(SECRET),
        "argument value reached the client environment"
    );
    assert!(!env.lines().any(|line| line.starts_with("GREETING=")));
    let bake: Value =
        serde_json::from_slice(&fs::read(scratch.join("seen-bake.json")).unwrap()).unwrap();
    let target = &bake["target"]["build"];
    assert_eq!(target["args"], serde_json::json!({"GREETING": SECRET}));
    assert_eq!(
        target["contexts"],
        serde_json::json!({
            "alpine:3.20": format!("docker-image://docker.io/library/alpine@{PIN}")
        })
    );
    assert_eq!(target["platforms"], serde_json::json!(["linux/arm64"]));
    assert_eq!(target["output"], serde_json::json!(["type=docker"]));
    assert_eq!(target["labels"]["io.hack-local.kind"], "build-image");
    assert_eq!(target["tags"], serde_json::json!([inputs.tag()]));
    // The definition carries argument values; it is gone once the client has run.
    assert!(!scratch.join("definition").join(BAKE_DEFINITION).exists());
    // The client ran under the source policy for exactly these pins, from a private
    // file removed with the definition.
    let policy_path = PathBuf::from(fs::read_to_string(scratch.join("seen-policy-path")).unwrap());
    assert_eq!(policy_path, scratch.join("definition").join(SOURCE_POLICY));
    assert!(!policy_path.exists(), "the source policy outlived the run");
    let policy: Value =
        serde_json::from_slice(&fs::read(scratch.join("seen-policy.json")).unwrap()).unwrap();
    let pinned = format!("docker.io/library/alpine@{PIN}");
    assert_eq!(policy, build_policy::document([pinned.as_str()]).unwrap());
    assert_eq!(
        policy_decision(&policy, &format!("docker-image://{pinned}")),
        "ALLOW"
    );
    for denied in [
        "docker-image://docker.io/library/alpine:3.20",
        "docker-image://docker.io/library/busybox:latest",
        "oci-layout://store@sha256:x",
        "https://example.test/archive.tgz",
        "git://example.test/repo.git",
        "docker-image+blob://docker.io/library/alpine@sha256:x",
    ] {
        assert_eq!(policy_decision(&policy, denied), "DENY", "{denied}");
    }
    assert_eq!(policy_decision(&policy, "local://context"), "ALLOW");
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
fn environment_names_are_plain_arguments_that_never_reach_the_client_environment() {
    let fixture = Fixture::new();
    let names = [
        "DYLD_INSERT_LIBRARIES",
        "LD_PRELOAD",
        "GODEBUG",
        "PATH",
        "HTTPS_PROXY",
        "KUBECONFIG",
        "DOCKER_HOST",
    ];
    let mut request = fixture.request(Policy::Missing);
    for name in names {
        request
            .args
            .insert(name.to_owned(), format!("{SECRET}-{name}"));
    }
    let inputs = prepare(request).unwrap();
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let scratch = fixture.scratch(&inputs);
    let env = fs::read_to_string(scratch.join("env")).unwrap();
    assert!(
        !env.contains(SECRET),
        "an argument value reached the client environment"
    );
    // The client environment is exactly the fixed allowlist (plus what `sh` adds itself).
    let allowed = [
        "PATH",
        "LANG",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONFIG",
        "BUILDX_CONFIG",
        "BUILDX_NO_DEFAULT_ATTESTATIONS",
        "DOCKER_CLI_HINTS",
        "EXPERIMENTAL_BUILDKIT_SOURCE_POLICY",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
    ];
    for line in env.lines() {
        let name = line.split('=').next().unwrap();
        assert!(allowed.contains(&name), "unexpected client variable {name}");
    }
    assert!(
        env.lines()
            .any(|line| line == "PATH=/usr/bin:/bin:/usr/sbin:/sbin")
    );
    assert!(
        !env.lines()
            .any(|line| line.starts_with("DYLD_") || line.starts_with("GODEBUG="))
    );
    let bake: Value =
        serde_json::from_slice(&fs::read(scratch.join("seen-bake.json")).unwrap()).unwrap();
    for name in names {
        assert_eq!(
            bake["target"]["build"]["args"][name],
            format!("{SECRET}-{name}")
        );
    }
}

/// BuildKit's evaluation of a source identifier: the last matching rule wins and an
/// unmatched source is allowed. `WILDCARD` patterns here use only a trailing `*`.
fn policy_decision(policy: &Value, identifier: &str) -> &'static str {
    let mut decision = "ALLOW";
    for rule in policy["rules"].as_array().unwrap() {
        let pattern = rule["selector"]["identifier"].as_str().unwrap();
        let matched = match rule["selector"]["match_type"].as_str().unwrap() {
            "EXACT" => identifier == pattern,
            "WILDCARD" => identifier.starts_with(pattern.strip_suffix('*').unwrap()),
            other => panic!("unexpected match type {other}"),
        };
        if matched {
            decision = if rule["action"] == "DENY" {
                "DENY"
            } else {
                "ALLOW"
            };
        }
    }
    decision
}

#[test]
fn private_build_files_are_removed_even_when_the_client_fails() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "fail");
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_failed");
    let scratch = fixture.scratch(&inputs);
    assert!(
        scratch.join("seen-policy.json").exists(),
        "the client did not run"
    );
    assert!(!scratch.join("definition").join(BAKE_DEFINITION).exists());
    assert!(!scratch.join("definition").join(SOURCE_POLICY).exists());
}

#[test]
fn receipts_with_the_most_and_longest_accepted_pins_stay_readable() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let mut receipt = Receipt {
        version: 1,
        checkout: fixture.candidate.checkout.clone(),
        namespace: inputs.namespace.clone(),
        build_key: inputs.key.clone(),
        provider_incarnation: "i".repeat(128),
        provider_boot_id: "b".repeat(128),
        engine_id: "e".repeat(128),
        phase: Phase::ContentIdVerified,
        image_id: Some(IMAGE.into()),
        base_pins: BTreeMap::new(),
    };
    // The scanner's bounds: 32 images, Docker Hub paths up to 200 bytes, tags up to
    // 128, each with a digest; the pinned reference keeps the name and adds the pin.
    for index in 0..build_scan::MAX_IMAGE_REFERENCES {
        let repository = format!("{index:03}{}/{}", "r".repeat(96), "p".repeat(100));
        let name = format!("{repository}:{}@{PIN}", "t".repeat(128));
        receipt
            .base_pins
            .insert(name.clone(), format!("docker.io/{name}"));
    }
    let directory = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&directory).unwrap();
    let path = directory.join(format!("{}.json", inputs.key));
    state::write(&path, &receipt).unwrap();
    assert!(fs::metadata(&path).unwrap().len() > 16 * 1024);
    let read = read_receipt(&path).unwrap().unwrap();
    assert_eq!(read.base_pins.len(), build_scan::MAX_IMAGE_REFERENCES);
}

#[test]
fn remote_add_sources_refuse_before_any_build_effect() {
    let fixture = Fixture::new();
    for dockerfile in [
        "FROM alpine:3.20\nADD http://100.96.0.1:8080/secret /secret\n",
        "FROM alpine:3.20\nADD https://example.test/a.tgz /a\n",
        "FROM alpine:3.20\nADD git@example.test:org/repo.git /src\n",
        "FROM alpine:3.20\nARG SRC\nADD $SRC /src\n",
        "FROM alpine:3.20 AS base\nONBUILD ADD https://example.test/a /a\n",
    ] {
        fs::write(fixture.project.join("app/Dockerfile"), dockerfile).unwrap();
        let error = prepare(fixture.request(Policy::Missing)).unwrap_err();
        assert_eq!(error.code, "native_build_dockerfile", "{dockerfile}");
        assert!(!error.message.contains("100.96.0.1") && !error.message.contains("example.test"));
    }
    fs::write(
        fixture.project.join("app/Dockerfile"),
        "FROM alpine:3.20\nADD main.txt /main.txt\n",
    )
    .unwrap();
    assert!(prepare(fixture.request(Policy::Missing)).is_ok());
}

#[test]
fn bake_definitions_never_evaluate_project_text() {
    assert_eq!(bake_literal("${HOME}"), "$${HOME}");
    assert_eq!(
        bake_literal("%{ if true }x%{ endif }"),
        "%%{ if true }x%%{ endif }"
    );
    assert_eq!(bake_literal("$${x} a$ % \\${y}"), "$$${x} a$ % \\$${y}");
    let escaped = bake_strings(serde_json::json!({"a${b}": ["${c}", {"d": "%{e}"}], "n": 1}));
    assert_eq!(
        escaped,
        serde_json::json!({"a$${b}": ["$${c}", {"d": "%%{e}"}], "n": 1})
    );
    let fixture = Fixture::new();
    let mut request = fixture.request(Policy::Missing);
    request
        .args
        .insert("TEMPLATE".into(), "${HOME}%{ if true }".into());
    let inputs = prepare(request).unwrap();
    let definition = bake_definition(
        &inputs,
        Path::new("/s/Dockerfile"),
        &BTreeMap::new(),
        &BTreeMap::new(),
    );
    assert_eq!(
        definition["target"]["build"]["args"]["TEMPLATE"],
        "$${HOME}%%{ if true }"
    );
}

#[test]
fn client_output_reaches_the_caller_redacted_and_without_terminal_controls() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "leak");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let output = String::from_utf8(pool.output.lock().unwrap().clone()).unwrap();
    assert_eq!(output, "#5 0.1 value=[redacted]\n[31mred[0m]0;title\n");
    assert!(!output.contains(SECRET));
}

#[test]
fn the_client_builds_the_scanned_dockerfile_and_ignore_rules_not_later_edits() {
    let fixture = Fixture::new();
    let app = fixture.project.join("app");
    let scanned = fs::read(app.join("Dockerfile")).unwrap();
    fs::write(app.join(".dockerignore"), "*.txt\n").unwrap();
    let inputs = fixture.inputs(Policy::Missing);
    // Edits after the scan (while bases resolve) must not reach the client.
    fs::write(app.join("Dockerfile"), "FROM unpinned:latest\nRUN id\n").unwrap();
    fs::write(app.join(".dockerignore"), "!*\n").unwrap();
    fs::write(app.join("Dockerfile.dockerignore"), "main.txt\n").unwrap();
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let scratch = fixture.scratch(&inputs);
    assert_eq!(fs::read(scratch.join("seen-dockerfile")).unwrap(), scanned);
    assert_eq!(
        fs::read_to_string(scratch.join("seen-dockerignore")).unwrap(),
        "*.txt\n"
    );
    let bake: Value =
        serde_json::from_slice(&fs::read(scratch.join("seen-bake.json")).unwrap()).unwrap();
    let file = PathBuf::from(bake["target"]["build"]["dockerfile"].as_str().unwrap());
    assert!(file.starts_with(&scratch), "the client read a project path");

    // A Dockerfile-specific ignore file wins; with none at all, the private rules are
    // empty, so a context .dockerignore created later is never applied.
    let inputs = fixture.inputs(Policy::Rebuild);
    fs::remove_file(app.join("Dockerfile.dockerignore")).unwrap();
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(
        fs::read_to_string(fixture.scratch(&inputs).join("seen-dockerignore")).unwrap(),
        "main.txt\n"
    );
    fs::remove_file(app.join(".dockerignore")).unwrap();
    let inputs = fixture.inputs(Policy::Rebuild);
    fs::write(app.join(".dockerignore"), "*\n").unwrap();
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(
        fs::read(fixture.scratch(&inputs).join("seen-dockerignore")).unwrap(),
        b""
    );
}

#[test]
fn the_time_budget_starts_before_base_resolution() {
    let fixture = Fixture::new();
    let mut inputs = fixture.inputs(Policy::Missing);
    inputs.timeout = Duration::from_millis(300);
    let mut pool = FakePool::new("pool-1");
    pool.resolve_delay = Duration::from_millis(400);
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    let started = Instant::now();
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    let finished = Instant::now();
    assert_eq!(error.code, "native_build_timeout");
    assert_eq!(fixture.calls(&inputs), 0, "the client ran after the budget");
    // Resolution got the operation's deadline, which had passed when it returned.
    let deadlines = pool.resolve_deadlines.borrow();
    assert_eq!(deadlines.len(), 1);
    assert!(deadlines[0] >= started + inputs.timeout && deadlines[0] < finished);
}

#[test]
fn blocking_resolution_yields_to_the_deadline_and_to_cancellation() {
    let slow = || {
        std::thread::sleep(Duration::from_secs(3));
        Ok(())
    };
    let started = Instant::now();
    let error = interruptible(slow, started + Duration::from_millis(100), &never).unwrap_err();
    assert_eq!(error.code, "native_build_timeout");
    let error = interruptible(slow, started + Duration::from_secs(60), &|| true).unwrap_err();
    assert_eq!(error.code, "native_build_canceled");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        interruptible(|| Ok(7), Instant::now() + Duration::from_secs(5), &never).unwrap(),
        7
    );
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
        "BUILDX_CONFIG",
        "BUILDKIT_SYNTAX",
        "buildkit_inline_cache",
        "SOURCE_DATE_EPOCH",
        "TARGETPLATFORM",
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
    request.args = BTreeMap::from([("BUILDKIT_SYNTAX".to_owned(), SECRET.to_owned())]);
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
