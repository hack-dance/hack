//! `runtime build-image` against a fake pool and a fake build client.
//!
//! The fake client is `/bin/sh` reading a script named `bake` (its first argument) from
//! the client's private working directory, so no test writes and then executes a fresh
//! binary. It records its argv, its whole environment, a copy of the bake definition,
//! the staged Dockerfile and ignore rules, and a call count.
use super::*;
use std::{
    cell::RefCell,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
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
    /// A fixture another process created at `root` (see `coordinator_child`).
    fn at(root: PathBuf) -> Self {
        Self {
            candidate: Candidate::discover(&root.join("checkout")).unwrap(),
            project: root.join("project"),
            root,
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
            pins: None,
        }
    }
    fn inputs(&self, policy: Policy) -> Inputs {
        prepare(self.request(policy), &builds_root(&self.candidate)).unwrap()
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
ls -A snapshot/context > seen-entries
case {mode} in
  ok) printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  edit)
    target=$(cat edit-target)
    original=$(cat "$target")
    printf 'edited during the build' > "$target"
    cat snapshot/context/main.txt > seen-during
    printf '%s' "$original" > "$target"
    printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  leak)
    printf '#5 0.1 value=%s\n\033[31mred\033[0m\033]0;title\007\n' '{SECRET}' >&2
    printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  fail) exit 3 ;;
  nometa) ;;
  sleep) sleep 30 & echo $! > child.pending; mv child.pending child; wait ;;
  hold) echo $$ > client-pid.pending; mv client-pid.pending client-pid; sleep 30 ;;
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
    removable: RefCell<BTreeMap<String, bool>>,
    removed: RefCell<Vec<String>>,
    identities: RefCell<Vec<PoolIdentity>>,
    images: RefCell<BTreeMap<String, Value>>,
    leases: RefCell<u32>,
    resolve_error: bool,
    available: RefCell<u64>,
    prunes: RefCell<Vec<u64>>,
    resolve_delay: Duration,
    resolve_deadlines: RefCell<Vec<Instant>>,
    output: Arc<Mutex<Vec<u8>>>,
    /// The manifest digest every base resolves to.
    pin: RefCell<String>,
    /// Digests the fake registry refuses to verify.
    unverifiable: RefCell<Vec<String>>,
    now: RefCell<SystemTime>,
    /// Verify the image builder in this home before use, as the real pool does.
    builder_home: Option<PathBuf>,
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
            resolve_delay: Duration::ZERO,
            resolve_deadlines: RefCell::new(Vec::new()),
            output: Arc::default(),
            pin: RefCell::new(PIN.into()),
            unverifiable: RefCell::new(Vec::new()),
            now: RefCell::new(SystemTime::now()),
            builder_home: None,
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
        // A digest-pinned reference resolves to exactly that digest, as the resolver does.
        let pin = base
            .reference
            .digest
            .clone()
            .unwrap_or_else(|| self.pin.borrow().clone());
        if self.unverifiable.borrow().contains(&pin) {
            return Err(CandidateError::new("registry_image", "unverifiable"));
        }
        Ok(BuildBase {
            pinned_reference: format!("docker.io/{}@{pin}", base.repository()),
            source_digest: pin,
            image_id: IMAGE.into(),
        })
    }
    fn builder(&self) -> Result<PathBuf, CandidateError> {
        if let Some(home) = &self.builder_home {
            artifact::verify_builder(&Candidate::discover(home)?)?;
        }
        Ok(PathBuf::from("/bin/sh"))
    }
    fn output(&self) -> Box<dyn Write + Send> {
        Box::new(Captured(Arc::clone(&self.output)))
    }
    fn storage_available(&self, _: &()) -> Result<u64, CandidateError> {
        Ok(*self.available.borrow())
    }
    fn prune_cache(&self, _: &(), max_used: u64) -> Result<u64, CandidateError> {
        self.prunes.borrow_mut().push(max_used);
        Ok(7)
    }
    fn now(&self) -> SystemTime {
        *self.now.borrow()
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

fn target_context(scratch: &Path) -> String {
    let bake: Value =
        serde_json::from_slice(&fs::read(scratch.join("seen-bake.json")).unwrap()).unwrap();
    bake["target"]["build"]["context"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn with_pins(mut request: BuildRequest, pins: BTreeMap<String, String>) -> BuildRequest {
    request.version = 2;
    request.pins = Some(pins);
    request
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
            "docker.io/library/alpine:3.20".to_owned(),
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
        && w[1] == format!("fs.read={}", scratch.join("snapshot/context").display())));
    // BuildKit was pointed at the private snapshot, which is gone after the run.
    assert_eq!(
        Path::new(target_context(&scratch).as_str()),
        scratch.join("snapshot/context")
    );
    assert!(
        !scratch.join("snapshot").exists(),
        "the snapshot outlived the run"
    );
    assert_eq!(
        fs::read_to_string(scratch.join("seen-entries")).unwrap(),
        "Dockerfile\nmain.txt\n"
    );
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
    let inputs = prepare(request, &builds_root(&fixture.candidate)).unwrap();
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
        image_bytes: Some(5 * GIB),
        base_pins: BTreeMap::new(),
        bases_resolved_at: None,
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
        let error = prepare(
            fixture.request(Policy::Missing),
            &builds_root(&fixture.candidate),
        )
        .unwrap_err();
        assert_eq!(error.code, "native_build_dockerfile", "{dockerfile}");
        assert!(!error.message.contains("100.96.0.1") && !error.message.contains("example.test"));
    }
    fs::write(
        fixture.project.join("app/Dockerfile"),
        "FROM alpine:3.20\nADD main.txt /main.txt\n",
    )
    .unwrap();
    assert!(
        prepare(
            fixture.request(Policy::Missing),
            &builds_root(&fixture.candidate)
        )
        .is_ok()
    );
}

#[test]
fn an_interrupted_receipt_publication_does_not_block_the_key() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let directory = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&directory).unwrap();
    let receipt = directory.join(format!("{}.json", inputs.key));
    // A process died after creating the temporary file and before renaming it, with
    // no committed receipt yet.
    fs::write(receipt.with_extension("pending"), b"{\"partial").unwrap();
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(fixture.receipt(&inputs).phase, Phase::ContentIdVerified);
    assert!(!receipt.with_extension("pending").exists());
    // The same with a committed receipt present: a rebuild still proceeds.
    fs::write(receipt.with_extension("pending"), b"{").unwrap();
    let rebuild = fixture.inputs(Policy::Rebuild);
    run(&fixture.candidate, &pool, &rebuild, &never).unwrap();
    assert_eq!(fixture.calls(&inputs), 2);
}

/// The environment variable naming the fixture root the coordinator child builds in.
const COORDINATOR_ROOT: &str = "HACK_TEST_IMAGE_BUILD_COORDINATOR_ROOT";

#[test]
#[ignore = "coordinator process killed by a_killed_coordinator_leaves_its_client_fenced"]
fn coordinator_child() {
    let Some(root) = std::env::var_os(COORDINATOR_ROOT) else {
        return;
    };
    // Never cleaned up here: the parent test owns the root, and this process is killed.
    let fixture = std::mem::ManuallyDrop::new(Fixture::at(PathBuf::from(root)));
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    let _ = run(&fixture.candidate, &pool, &inputs, &never);
}

#[test]
fn a_killed_coordinator_leaves_its_client_fenced() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "hold");
    let scratch = fixture.scratch(&inputs);
    let mut coordinator = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider::image_build::tests::coordinator_child",
            "--ignored",
            "--nocapture",
        ])
        .env(COORDINATOR_ROOT, &fixture.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !scratch.join("client-pid").exists() {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the client never started"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // SIGKILL: the coordinator drops nothing, as when hack-native itself is killed.
    coordinator.kill().unwrap();
    coordinator.wait().unwrap();
    let client: libc::pid_t = fs::read_to_string(scratch.join("client-pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let root = builds_root(&fixture.candidate);
    let key = root
        .join(&inputs.namespace)
        .join(format!("{}.lock", inputs.key));
    let fence = root.join("active.lock");
    let held = |path: &Path| {
        Flock::try_lock(Flock::open(path).unwrap(), libc::LOCK_SH)
            .unwrap()
            .is_none()
            || Flock::try_lock(Flock::open(path).unwrap(), libc::LOCK_EX)
                .unwrap()
                .is_none()
    };
    assert!(
        held(&key),
        "the key lock was released under a surviving client"
    );
    assert!(
        held(&fence),
        "the build fence was released under a surviving client"
    );
    assert!(require_no_active_build(&fixture.candidate).is_err());
    let pool = FakePool::new("pool-1");
    let busy = run(
        &fixture.candidate,
        &pool,
        &fixture.inputs(Policy::Rebuild),
        &never,
    )
    .unwrap_err();
    assert_eq!(busy.code, "native_build_busy");
    // SAFETY: the surviving client leads its own process group, created for it.
    unsafe { libc::killpg(client, libc::SIGKILL) };
    let started = Instant::now();
    while held(&key) || held(&fence) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "locks were never released"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(require_no_active_build(&fixture.candidate).is_ok());
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
    let inputs = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    let definition = bake_definition(
        &inputs,
        Path::new("/s/context"),
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
    // The build files themselves are excluded, so editing them later leaves the
    // keyed context set unchanged.
    let rules = "*.txt\nDockerfile*\n.dockerignore\n";
    fs::write(app.join(".dockerignore"), rules).unwrap();
    let inputs = fixture.inputs(Policy::Missing);
    // Edits after the scan (while bases resolve) must not reach the client.
    fs::write(app.join("Dockerfile"), "FROM unpinned:latest\nRUN id\n").unwrap();
    fs::write(app.join(".dockerignore"), "!*\n").unwrap();
    fs::write(
        app.join("Dockerfile.dockerignore"),
        "main.txt\nDockerfile*\n",
    )
    .unwrap();
    let pool = FakePool::new("pool-1");
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    let scratch = fixture.scratch(&inputs);
    assert_eq!(fs::read(scratch.join("seen-dockerfile")).unwrap(), scanned);
    assert_eq!(
        fs::read_to_string(scratch.join("seen-dockerignore")).unwrap(),
        rules
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
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(
        fs::read_to_string(fixture.scratch(&inputs).join("seen-dockerignore")).unwrap(),
        "main.txt\nDockerfile*\n"
    );
    fs::remove_file(app.join(".dockerignore")).unwrap();
    let inputs = fixture.inputs(Policy::Rebuild);
    fs::write(app.join(".dockerignore"), "*\n").unwrap();
    fixture.client(&inputs, "ok");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(
        fs::read(fixture.scratch(&inputs).join("seen-dockerignore")).unwrap(),
        b""
    );
    // The snapshot holds only entries recorded before the late ignore file appeared.
    assert_eq!(
        fs::read_to_string(fixture.scratch(&inputs).join("seen-entries")).unwrap(),
        "Dockerfile\nmain.txt\n"
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
    let inputs = prepare(request, &builds_root(&fixture.candidate)).unwrap();
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
        bases_resolved_at: None,
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

#[test]
fn a_home_without_the_image_builder_refuses_by_name_and_runs_nothing() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    fixture.client(&inputs, "ok");
    let mut pool = FakePool::new("pool-1");
    pool.builder_home = Some(fixture.candidate.checkout.clone());
    // The build reports the builder's own refusal unchanged: its code, and fixed text
    // that names the fix instead of the missing file.
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "builder_not_prepared");
    assert!(error.message_fixed);
    assert!(
        error
            .message
            .contains("hack native setup --accept-downloads")
    );
    assert!(!error.message.contains("os error"));
    assert_eq!(fixture.calls(&inputs), 0);
}

fn code(fixture: &Fixture, request: BuildRequest) -> &'static str {
    prepare(request, &builds_root(&fixture.candidate))
        .unwrap_err()
        .code
}

#[test]
fn requests_refuse_unsafe_paths_arguments_and_bounds() {
    let fixture = Fixture::new();
    let base = || fixture.request(Policy::Missing);

    let mut request = base();
    request.version = 3;
    assert_eq!(code(&fixture, request), "native_build_request");
    // Version 1 never carries pins; version 2 may.
    let mut request = base();
    request.pins = Some(BTreeMap::new());
    assert_eq!(code(&fixture, request), "native_build_request");
    assert!(
        prepare(
            with_pins(base(), BTreeMap::new()),
            &builds_root(&fixture.candidate)
        )
        .is_ok()
    );
    let mut request = base();
    request.project_root = PathBuf::from("relative");
    assert_eq!(code(&fixture, request), "native_build_request");
    let mut request = base();
    request.project_root = fixture.project.join("app/..");
    assert_eq!(code(&fixture, request), "native_build_source");
    let mut request = base();
    request.context = "../outside".into();
    assert_eq!(code(&fixture, request), "source_escape");
    let mut request = base();
    request.dockerfile = "../../Dockerfile".into();
    assert_eq!(code(&fixture, request), "source_escape");
    std::os::unix::fs::symlink(fixture.project.join("app"), fixture.project.join("link")).unwrap();
    let mut request = base();
    request.context = "link".into();
    assert_eq!(code(&fixture, request), "source_symlink");
    let mut request = base();
    request.context = "missing".into();
    assert_eq!(code(&fixture, request), "missing_source");
    let mut request = base();
    request.branch = Some("Not_A_Label".into());
    assert_eq!(code(&fixture, request), "native_build_request");
    let mut request = base();
    request.target = Some("-bad".into());
    assert_eq!(code(&fixture, request), "native_build_request");
    for timeout in [0, MAX_TIMEOUT_SECONDS + 1] {
        let mut request = base();
        request.timeout_seconds = Some(timeout);
        assert_eq!(code(&fixture, request), "native_build_request");
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
        assert_eq!(code(&fixture, request), "native_build_argument", "{name}");
    }
    let mut request = base();
    request.args = BTreeMap::from([("GREETING".to_owned(), "a\0b".to_owned())]);
    assert_eq!(code(&fixture, request), "native_build_argument");
    let mut request = base();
    request.args = (0..=MAX_ARGS)
        .map(|i| (format!("A{i}"), "x".into()))
        .collect();
    assert_eq!(code(&fixture, request), "native_build_argument");
    let mut request = base();
    request.args = BTreeMap::from([("BIG".to_owned(), "x".repeat(MAX_ARG_BYTES))]);
    assert_eq!(code(&fixture, request), "native_build_argument");
    // Refusals never echo argument values.
    let mut request = base();
    request.args = BTreeMap::from([("BUILDKIT_SYNTAX".to_owned(), SECRET.to_owned())]);
    assert!(
        !prepare(request, &builds_root(&fixture.candidate))
            .unwrap_err()
            .message
            .contains(SECRET)
    );
}

#[test]
fn the_build_key_binds_local_inputs_and_context_contents() {
    let fixture = Fixture::new();
    let key = |request: BuildRequest| {
        prepare(request, &builds_root(&fixture.candidate))
            .unwrap()
            .key
    };
    let original = key(fixture.request(Policy::Missing));
    assert_eq!(original, key(fixture.request(Policy::Rebuild)));

    fs::write(fixture.project.join("app/main.txt"), "two").unwrap();
    let edited = key(fixture.request(Policy::Missing));
    assert_ne!(original, edited, "a copied file edit kept the key");
    let original = edited;

    let mut request = fixture.request(Policy::Missing);
    request.args.insert("GREETING".into(), "other".into());
    assert_ne!(original, key(request));
    let mut request = fixture.request(Policy::Missing);
    request.branch = Some("feature".into());
    let branched = prepare(request, &builds_root(&fixture.candidate)).unwrap();
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
        code(&fixture, fixture.request(Policy::Missing)),
        "native_build_source"
    );
    fs::remove_file(fixture.project.join("app/.dockerignore")).unwrap();
    fs::hard_link(
        fixture.project.join("app/Dockerfile"),
        fixture.project.join("Dockerfile.copy"),
    )
    .unwrap();
    assert_eq!(
        code(&fixture, fixture.request(Policy::Missing)),
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

    // A rebuild that fails verifies no image: the last verified size still applies.
    *pool.available.borrow_mut() = 10 * GIB;
    fixture.client(&rebuild, "fail");
    let error = run(&fixture.candidate, &pool, &rebuild, &never).unwrap_err();
    assert_eq!(error.code, "native_build_failed");
    let receipt = fixture.receipt(&rebuild);
    assert_eq!(receipt.phase, Phase::Failed);
    assert_eq!(receipt.image_bytes, Some(5 * GIB));
    *pool.available.borrow_mut() = 6 * GIB;
    let error = run(&fixture.candidate, &pool, &rebuild, &never).unwrap_err();
    assert_eq!(error.code, "native_build_storage");
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

#[test]
fn the_key_is_version_two_and_version_one_receipts_are_never_reused() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    assert_eq!(inputs.key_input["v"], 2);
    assert!(
        inputs.key_input["context_sha256"]
            .as_str()
            .is_some_and(hex64)
    );
    // The same inputs under the version-1 document, which had no context digest.
    let mut old = inputs.key_input.clone();
    old["v"] = 1.into();
    old.as_object_mut().unwrap().remove("context_sha256");
    let old_key = sha256_hex(&serde_json::to_vec(&old).unwrap());
    assert_ne!(old_key, inputs.key);

    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let directory = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&directory).unwrap();
    let old_receipt = Receipt {
        version: 1,
        checkout: fixture.candidate.checkout.clone(),
        namespace: inputs.namespace.clone(),
        build_key: old_key.clone(),
        provider_incarnation: "pool-1".into(),
        provider_boot_id: "boot-1".into(),
        engine_id: "engine-1".into(),
        phase: Phase::ContentIdVerified,
        image_id: Some(IMAGE.into()),
        image_bytes: None,
        base_pins: BTreeMap::new(),
        bases_resolved_at: None,
    };
    // At its own path it is never read: the version-2 key builds.
    state::write(&directory.join(format!("{old_key}.json")), &old_receipt).unwrap();
    assert!(
        !run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap()
            .reused
    );
    assert_eq!(fixture.calls(&inputs), 1);
    // At the version-2 path it refuses rather than being adopted.
    let path = directory.join(format!("{}.json", inputs.key));
    fs::remove_file(&path).unwrap();
    state::write(&path, &old_receipt).unwrap();
    assert_eq!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap_err()
            .code,
        "native_build_receipt"
    );
    assert_eq!(fixture.calls(&inputs), 1);
}

#[test]
fn base_resolutions_are_trusted_for_a_day_then_checked_once() {
    const MOVED: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let start = UNIX_EPOCH + Duration::from_secs(1_900_000_000);
    let at = |hours: u64| start + Duration::from_secs(hours * 60 * 60);
    let resolves = || pool.resolve_deadlines.borrow().len();
    *pool.now.borrow_mut() = at(0);
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(resolves(), 1);
    assert_eq!(
        fixture.receipt(&inputs).bases_resolved_at,
        Some(unix_seconds(at(0)))
    );

    // A fresh resolution is reused without asking the registry.
    *pool.now.borrow_mut() = at(23);
    assert!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap()
            .reused
    );
    assert_eq!(resolves(), 1);

    // Older than a day: resolved once; the same digest keeps the image and the time.
    *pool.now.borrow_mut() = at(25);
    let kept = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(kept.reused);
    assert_eq!(resolves(), 2);
    assert_eq!(fixture.calls(&inputs), 1);
    assert_eq!(
        fixture.receipt(&inputs).bases_resolved_at,
        Some(unix_seconds(at(25)))
    );
    *pool.now.borrow_mut() = at(48);
    assert!(
        run(&fixture.candidate, &pool, &inputs, &never)
            .unwrap()
            .reused
    );
    assert_eq!(resolves(), 2);

    // A moved tag builds, resolving only once for the whole operation.
    *pool.now.borrow_mut() = at(50);
    *pool.pin.borrow_mut() = MOVED.into();
    let rebuilt = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(!rebuilt.reused);
    assert_eq!(resolves(), 3);
    assert_eq!(fixture.calls(&inputs), 2);
    assert_eq!(
        rebuilt.base_pins["docker.io/library/alpine:3.20"],
        format!("docker.io/library/alpine@{MOVED}")
    );
    assert_eq!(
        fixture.receipt(&inputs).bases_resolved_at,
        Some(unix_seconds(at(50)))
    );

    // A receipt from before the field (unknown age) or from the future is expired;
    // with the shared records removed, its tags resolve again.
    for recorded in [None, Some(unix_seconds(at(60)))] {
        let _ = fs::remove_dir_all(
            builds_root(&fixture.candidate)
                .join(&inputs.namespace)
                .join("bases"),
        );
        let path = builds_root(&fixture.candidate)
            .join(&inputs.namespace)
            .join(format!("{}.json", inputs.key));
        let mut receipt = fixture.receipt(&inputs);
        receipt.bases_resolved_at = recorded;
        fs::remove_file(&path).unwrap();
        state::write(&path, &receipt).unwrap();
        let before = resolves();
        assert!(
            run(&fixture.candidate, &pool, &inputs, &never)
                .unwrap()
                .reused
        );
        assert_eq!(resolves(), before + 1);
        assert_eq!(fixture.calls(&inputs), 2);
    }
    assert!(resolution_fresh(
        Some(10),
        UNIX_EPOCH + Duration::from_secs(10)
    ));
    assert!(!resolution_fresh(
        Some(10),
        UNIX_EPOCH + Duration::from_secs(10) + BASE_RESOLUTION_TTL
    ));
}

#[test]
fn context_edits_rebuild_and_ignored_edits_reuse() {
    let fixture = Fixture::new();
    let app = fixture.project.join("app");
    fs::write(app.join(".dockerignore"), "*.log\n").unwrap();
    fs::write(app.join("debug.log"), "1").unwrap();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    fs::write(app.join("debug.log"), "2").unwrap();
    let ignored = fixture.inputs(Policy::Missing);
    assert_eq!(ignored.key, inputs.key);
    assert!(
        run(&fixture.candidate, &pool, &ignored, &never)
            .unwrap()
            .reused
    );
    fs::write(app.join("main.txt"), "changed").unwrap();
    let edited = fixture.inputs(Policy::Missing);
    assert_ne!(edited.key, inputs.key);
    // The context cache lives beside the receipts and is not one.
    let cache = builds_root(&fixture.candidate)
        .join(&inputs.namespace)
        .join(context::cache_name(&app));
    assert!(cache.exists());
    assert!(reclaim::run(&fixture.candidate, &pool).is_ok());
}

#[test]
fn edits_during_the_build_never_reach_it_even_when_undone() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "edit");
    // The seam: the fake client changes a copied file and changes it back while it
    // "builds" (A -> B -> A), which no walk before or after could see.
    let main = fixture.project.join("app/main.txt");
    fs::write(
        fixture.scratch(&inputs).join("edit-target"),
        main.as_os_str().as_bytes(),
    )
    .unwrap();
    let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert!(!outcome.reused);
    assert_eq!(fs::read_to_string(&main).unwrap(), "one");
    // BuildKit's context held the keyed bytes the whole time.
    assert_eq!(
        fs::read_to_string(fixture.scratch(&inputs).join("seen-during")).unwrap(),
        "one"
    );
    assert_eq!(fixture.receipt(&inputs).phase, Phase::ContentIdVerified);
}

#[test]
fn a_context_edited_after_its_key_refuses_before_the_client_runs() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let cache = builds_root(&fixture.candidate)
        .join(&inputs.namespace)
        .join(context::cache_name(&fixture.project.join("app")));
    assert!(cache.exists());
    fs::write(fixture.project.join("app/main.txt"), "two").unwrap();
    let error = run(&fixture.candidate, &pool, &inputs, &never).unwrap_err();
    assert_eq!(error.code, "native_build_context_changed");
    assert!(!error.message.contains("main"));
    assert_eq!(fixture.calls(&inputs), 0, "the client ran on unkeyed bytes");
    assert!(!fixture.scratch(&inputs).join("snapshot").exists());
    // No attempt was recorded, and the possibly stale stat cache is gone.
    assert!(
        !builds_root(&fixture.candidate)
            .join(&inputs.namespace)
            .join(format!("{}.json", inputs.key))
            .exists()
    );
    assert!(!cache.exists());
}

#[test]
fn cancellation_during_the_snapshot_adopts_nothing_and_leaves_no_copy() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let snapshot = fixture.scratch(&inputs).join("snapshot");
    // Requested once the copy has begun (its root exists).
    let marker = snapshot.join("context");
    let cancel = move || marker.exists();
    let error = run(&fixture.candidate, &pool, &inputs, &cancel).unwrap_err();
    assert_eq!(error.code, "native_build_canceled");
    assert_eq!(fixture.calls(&inputs), 0);
    assert!(!snapshot.exists(), "the snapshot outlived a canceled copy");
    assert!(
        !builds_root(&fixture.candidate)
            .join(&inputs.namespace)
            .join(format!("{}.json", inputs.key))
            .exists()
    );
}

/// A second project directory whose Dockerfile shares the first one's base tag.
fn second_build(fixture: &Fixture, policy: Policy, pins: BTreeMap<String, String>) -> Inputs {
    let other = fixture.project.join("other");
    let _ = fs::create_dir(&other);
    fs::write(other.join("Dockerfile"), "FROM alpine:3.20\nRUN echo two\n").unwrap();
    let mut request = fixture.request(policy);
    request.context = "other".into();
    let request = with_pins(request, pins);
    prepare(request, &builds_root(&fixture.candidate)).unwrap()
}

#[test]
fn passed_pins_are_hints_used_only_when_a_shared_record_backs_them() {
    const MOVED: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    let fixture = Fixture::new();
    let pool = FakePool::new("pool-1");
    let start = UNIX_EPOCH + Duration::from_secs(1_900_000_000);
    *pool.now.borrow_mut() = start;
    let resolves = || pool.resolve_deadlines.borrow().len();
    let build = |inputs: &Inputs| {
        pool.built(inputs, "pool-1", serde_json::json!({}));
        fixture.client(inputs, "ok");
        run(&fixture.candidate, &pool, inputs, &never).unwrap()
    };
    let first = fixture.inputs(Policy::Missing);
    let passed = build(&first).base_pins;
    assert_eq!(resolves(), 1);
    // The tag moves upstream. The shared record of the first resolution backs the
    // passed pin, so the second Dockerfile gets the same base under either policy.
    *pool.pin.borrow_mut() = MOVED.into();
    for policy in [Policy::Missing, Policy::Rebuild] {
        let second = second_build(&fixture, policy, passed.clone());
        assert_ne!(second.key, first.key);
        let built = build(&second);
        assert_eq!(built.base_pins, passed, "{policy:?}");
        assert_eq!(resolves(), 1, "{policy:?} resolved");
        let bake: Value = serde_json::from_slice(
            &fs::read(fixture.scratch(&second).join("seen-bake.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            bake["target"]["build"]["contexts"]["alpine:3.20"],
            format!("docker-image://docker.io/library/alpine@{PIN}")
        );
    }
    // A backed pin carries the record's time: 23 hours later it is still the first
    // resolution's time, not now.
    *pool.now.borrow_mut() = start + Duration::from_secs(23 * 60 * 60);
    let late = second_build(&fixture, Policy::Rebuild, passed.clone());
    build(&late);
    assert_eq!(resolves(), 1);
    assert_eq!(
        fixture.receipt(&late).bases_resolved_at,
        Some(unix_seconds(start))
    );

    // No record: the passed pin still binds; the resolver verifies that exact digest.
    let bases = builds_root(&fixture.candidate)
        .join(&first.namespace)
        .join("bases");
    fs::remove_dir_all(&bases).unwrap();
    let second = second_build(&fixture, Policy::Rebuild, passed.clone());
    let verified = build(&second);
    assert_eq!(resolves(), 2);
    assert_eq!(verified.base_pins, passed);
    // The check wrote no tag record, and the receipt carries the time of the earlier
    // resolution its own previous receipt recorded for this pin, not now.
    assert!(!bases.exists());
    assert_eq!(
        fixture.receipt(&second).bases_resolved_at,
        Some(unix_seconds(start))
    );
    // A record naming another pin (the moved tag) does not replace the passed pin.
    let moved = BTreeMap::from([(
        "docker.io/library/alpine:3.20".to_owned(),
        format!("docker.io/library/alpine@{MOVED}"),
    )]);
    assert_eq!(
        build(&second_build(&fixture, Policy::Rebuild, BTreeMap::new())).base_pins,
        moved
    );
    assert_eq!(resolves(), 3);
    assert_eq!(
        build(&second_build(&fixture, Policy::Rebuild, passed.clone())).base_pins,
        passed
    );
    assert_eq!(resolves(), 4);

    // A fresh receipt whose pin differs from the passed pin builds on the passed one.
    let request = with_pins(fixture.request(Policy::Missing), moved.clone());
    let repinned = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    assert_eq!(repinned.key, first.key);
    let calls = fixture.calls(&first);
    let rebuilt = build(&repinned);
    assert!(!rebuilt.reused);
    assert_eq!(rebuilt.base_pins, moved);
    assert_eq!(fixture.calls(&first), calls + 1);
    // A pin of another repository is never substituted: it refuses.
    let request = with_pins(
        fixture.request(Policy::Missing),
        BTreeMap::from([(
            "docker.io/library/alpine:3.20".to_owned(),
            format!("docker.io/library/busybox@{PIN}"),
        )]),
    );
    let foreign = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    let error = run(&fixture.candidate, &pool, &foreign, &never).unwrap_err();
    assert_eq!(error.code, "native_build_base_pin");
    assert!(!error.message.contains("busybox"));
    assert_eq!(fixture.calls(&first), calls + 1);
}

#[test]
fn a_passed_pin_binds_even_against_another_fresh_receipt() {
    const Y: &str = "sha256:abababababababababababababababababababababababababababababababab";
    let fixture = Fixture::new();
    let pool = FakePool::new("pool-1");
    let build = |inputs: &Inputs| {
        pool.built(inputs, "pool-1", serde_json::json!({}));
        fixture.client(inputs, "ok");
        run(&fixture.candidate, &pool, inputs, &never)
    };
    // Service A pinned the tag to X; a forced rebuild of B then moved B's receipt and
    // the shared record to Y. Both receipts are fresh.
    let a = fixture.inputs(Policy::Missing);
    let x = build(&a).unwrap().base_pins;
    *pool.pin.borrow_mut() = Y.into();
    let y = build(&second_build(&fixture, Policy::Rebuild, BTreeMap::new()))
        .unwrap()
        .base_pins;
    assert_ne!(x, y);
    let y_resolved_at = unix_seconds(*pool.now.borrow());
    assert!(build(&a).unwrap().reused, "A's fast path keeps X");
    // With no pin passed, B keeps its own fresh receipt, as before.
    let b = second_build(&fixture, Policy::Missing, BTreeMap::new());
    let calls = fixture.calls(&b);
    let kept = build(&b).unwrap();
    assert!(kept.reused);
    assert_eq!(kept.base_pins, y);
    // With A's X passed, B builds on X, not its receipt's Y.
    let b = second_build(&fixture, Policy::Missing, x.clone());
    let bound = build(&b).unwrap();
    assert!(!bound.reused);
    assert_eq!(bound.base_pins, x);
    assert_eq!(fixture.calls(&b), calls + 1);
    let bake: Value =
        serde_json::from_slice(&fs::read(fixture.scratch(&b).join("seen-bake.json")).unwrap())
            .unwrap();
    assert_eq!(
        bake["target"]["build"]["contexts"]["alpine:3.20"],
        format!("docker-image://docker.io/library/alpine@{PIN}")
    );
    // Verifying X by digest left the shared tag record alone: it still says Y, with
    // the time of the lookup that found Y.
    let record = base_record_path(
        &builds_root(&fixture.candidate).join(&b.namespace),
        "docker.io/library/alpine:3.20",
    );
    let shared =
        read_base_record(&record, "docker.io/library/alpine:3.20", *pool.now.borrow()).unwrap();
    assert_eq!(shared.pinned_reference, y["docker.io/library/alpine:3.20"]);
    assert_eq!(shared.resolved_at, y_resolved_at);
    // No evidence dates X for B (the record and B's receipt held Y), so its time is
    // unknown and never fresh.
    assert_eq!(fixture.receipt(&b).bases_resolved_at, None);
    // A later independent command (no pins) for B follows the registry's Y again.
    let later = build(&second_build(&fixture, Policy::Missing, BTreeMap::new())).unwrap();
    assert!(!later.reused);
    assert_eq!(later.base_pins, y);
    assert_eq!(fixture.calls(&b), calls + 2);
    // When X cannot be verified (and no record backs it), B refuses instead of using Y.
    build(&second_build(&fixture, Policy::Rebuild, BTreeMap::new())).unwrap();
    pool.unverifiable.borrow_mut().push(PIN.into());
    let error = build(&second_build(&fixture, Policy::Missing, x.clone())).unwrap_err();
    assert_eq!(error.code, "native_build_base_pin");
    assert_eq!(fixture.calls(&b), calls + 3);
}

#[test]
fn a_dockerfile_digest_is_never_replaced_by_a_passed_pin() {
    const OTHER: &str = "sha256:9999999999999999999999999999999999999999999999999999999999999999";
    let fixture = Fixture::new();
    fs::write(
        fixture.project.join("app/Dockerfile"),
        format!("FROM alpine@{PIN}\nRUN echo hi\n"),
    )
    .unwrap();
    let probe = fixture.inputs(Policy::Rebuild);
    let reference = probe.images[0].reference.canonical();
    assert!(reference.ends_with(PIN));
    // Even a record that holds the passed pin does not back it for a digest base.
    let forged = format!("docker.io/library/alpine@{OTHER}");
    let pool = FakePool::new("pool-1");
    write_base_record(
        &base_record_path(
            &builds_root(&fixture.candidate).join(&probe.namespace),
            &reference,
        ),
        &BaseRecord {
            version: BASE_RECORD_VERSION,
            reference: reference.clone(),
            pinned_reference: forged.clone(),
            source_digest: OTHER.into(),
            resolved_at: unix_seconds(*pool.now.borrow()),
        },
    );
    let request = fixture.request(Policy::Rebuild);
    let request = with_pins(
        request,
        BTreeMap::from([(reference.clone(), forged.clone())]),
    );
    let inputs = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    assert_eq!(
        pool.resolve_deadlines.borrow().len(),
        1,
        "the digest was not resolved"
    );
    assert_ne!(outcome.base_pins[&reference], forged);
}

#[test]
fn requests_at_every_bound_fit_the_request_reader() {
    let fixture = Fixture::new();
    // `count` pins whose references and values total exactly `bytes`.
    let pins = |count: usize, bytes: usize| -> BTreeMap<String, String> {
        let value = |index: usize| format!("docker.io/library/i{index:04}@{PIN}");
        let fixed: usize = (0..count).map(|index| value(index).len()).sum();
        let per_key = (bytes - fixed) / count;
        let extra = (bytes - fixed) % count;
        (0..count)
            .map(|index| {
                let length = per_key + usize::from(index < extra);
                let prefix = format!("docker.io/library/i{index:04}:");
                let key = format!("{prefix}{}", "t".repeat(length - prefix.len()));
                (key, value(index))
            })
            .collect()
    };
    let total = |pins: &BTreeMap<String, String>| -> usize {
        pins.iter().map(|(k, v)| k.len() + v.len()).sum()
    };
    let at_bound = pins(MAX_PINS, MAX_PIN_BYTES);
    assert_eq!(
        (at_bound.len(), total(&at_bound)),
        (MAX_PINS, MAX_PIN_BYTES)
    );
    assert!(at_bound.keys().all(|key| key.len() <= 512));
    // Arguments at their byte bound, every value byte escaped by JSON as `\u00XX`.
    let mut args = serde_json::Map::new();
    let per_arg = MAX_ARG_BYTES / MAX_ARGS;
    for index in 0..MAX_ARGS {
        let name = format!("A{index:02}");
        args.insert(name.clone(), "\u{1}".repeat(per_arg - name.len()).into());
    }
    let request = |pins: &BTreeMap<String, String>| {
        serde_json::json!({
            "version": 2,
            "project_root": fixture.project,
            "context": "app",
            "dockerfile": "Dockerfile",
            "target": "t".repeat(128),
            "args": args,
            "policy": "missing",
            "timeout_seconds": 30,
            "pins": pins,
        })
    };
    let path = fixture.root.join("request.json");
    let write = |value: &Value| {
        let bytes = serde_json::to_vec(value).unwrap();
        let _ = fs::remove_file(&path);
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        bytes.len() as u64
    };
    let size = write(&request(&at_bound));
    assert!(size > 500 * 1024 && size <= MAX_REQUEST_BYTES, "{size}");
    // The same reader `runtime build-image` uses, then the request bounds.
    let read: BuildRequest = state::read_bounded(&path, MAX_REQUEST_BYTES).unwrap();
    assert!(validate_request(&read).is_ok());

    // One byte over the pins' total, or one entry over the count, refuses.
    let over = pins(MAX_PINS, MAX_PIN_BYTES + 1);
    write(&request(&over));
    let read: BuildRequest = state::read_bounded(&path, MAX_REQUEST_BYTES).unwrap();
    assert_eq!(
        validate_request(&read).unwrap_err().code,
        "native_build_request"
    );
    let mut counted = pins(MAX_PINS, MAX_PIN_BYTES - 100);
    counted.insert(
        "docker.io/library/z:1".into(),
        format!("docker.io/library/z@{PIN}"),
    );
    assert_eq!(counted.len(), MAX_PINS + 1);
    let request = with_pins(fixture.request(Policy::Missing), counted);
    assert_eq!(code(&fixture, request), "native_build_request");
    // A file over the reader's limit is refused before parsing.
    fs::remove_file(&path).unwrap();
    fs::write(&path, vec![b' '; MAX_REQUEST_BYTES as usize + 1]).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(state::read_bounded::<BuildRequest>(&path, MAX_REQUEST_BYTES).is_err());
    // Malformed values and quoting characters refuse; other references are ignored.
    for (key, value) in [
        ("docker.io/library/alpine:3.20", "alpine".to_owned()),
        (
            "docker.io/library/a\"b:1",
            format!("docker.io/library/a@{PIN}"),
        ),
        ("", format!("docker.io/library/a@{PIN}")),
    ] {
        let request = with_pins(
            fixture.request(Policy::Missing),
            BTreeMap::from([(key.to_owned(), value)]),
        );
        assert_eq!(code(&fixture, request), "native_build_request", "{key}");
    }
    assert_eq!(MAX_PINS, 1024);
    assert_eq!(MAX_PIN_BYTES, 128 * 1024);
    assert_eq!(MAX_REQUEST_BYTES, 640 * 1024);
}

#[test]
fn outcomes_report_protocol_two() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    for _ in 0..2 {
        let outcome = run(&fixture.candidate, &pool, &inputs, &never).unwrap();
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["protocol"], 2);
        assert_eq!(
            value["base_pins"]["docker.io/library/alpine:3.20"],
            format!("docker.io/library/alpine@{PIN}")
        );
    }
}

#[test]
fn a_cancellation_during_adoption_never_records_a_verified_image() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    fixture.client(&inputs, "ok");
    let scratch = fixture.scratch(&inputs);
    // True only once the client has run and the snapshot is gone: after every earlier
    // check, while the image is adopted.
    let cancel = move || scratch.join("calls").exists() && !scratch.join("snapshot").exists();
    let error = run(&fixture.candidate, &pool, &inputs, &cancel).unwrap_err();
    assert_eq!(error.code, "native_build_canceled");
    assert_eq!(fixture.calls(&inputs), 1);
    let receipt = fixture.receipt(&inputs);
    assert_eq!(receipt.phase, Phase::Canceled);
    assert!(receipt.image_id.is_none());
}

#[test]
fn base_resolutions_are_shared_across_builds_of_a_namespace_for_a_day() {
    const MOVED: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    let fixture = Fixture::new();
    let first = fixture.inputs(Policy::Missing);
    let mut request = fixture.request(Policy::Missing);
    request.args.insert("OTHER".into(), "x".into());
    let second = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    assert_ne!(first.key, second.key);
    assert_eq!(first.namespace, second.namespace);
    let pool = FakePool::new("pool-1");
    let start = UNIX_EPOCH + Duration::from_secs(1_900_000_000);
    *pool.now.borrow_mut() = start;
    let resolves = || pool.resolve_deadlines.borrow().len();
    for inputs in [&first, &second] {
        fixture.client(inputs, "ok");
    }
    // The fake engine holds one image ID; label it for the key about to build.
    let build = |inputs: &Inputs| {
        pool.built(inputs, "pool-1", serde_json::json!({}));
        run(&fixture.candidate, &pool, inputs, &never).unwrap()
    };
    build(&first);
    assert_eq!(resolves(), 1);
    // The tag moves upstream; the second build of the same command keeps the first pin.
    *pool.pin.borrow_mut() = MOVED.into();
    *pool.now.borrow_mut() = start + Duration::from_secs(60);
    let outcome = build(&second);
    assert_eq!(resolves(), 1, "a fresh shared resolution was repeated");
    assert_eq!(
        outcome.base_pins["docker.io/library/alpine:3.20"],
        format!("docker.io/library/alpine@{PIN}")
    );
    // Its receipt carries the record's time, not this build's.
    assert_eq!(
        fixture.receipt(&second).bases_resolved_at,
        Some(unix_seconds(start))
    );
    let record = base_record_path(
        &builds_root(&fixture.candidate).join(&first.namespace),
        "docker.io/library/alpine:3.20",
    );
    let mode = fs::metadata(&record).unwrap().mode();
    assert_eq!(mode & 0o777, 0o600);

    // After 24 hours one build resolves and records; the next one reuses that.
    *pool.now.borrow_mut() = start + BASE_RESOLUTION_TTL + Duration::from_secs(1);
    let rebuilt = build(&first);
    assert!(!rebuilt.reused);
    assert_eq!(resolves(), 2);
    let rebuilt = build(&second);
    assert!(!rebuilt.reused);
    assert_eq!(resolves(), 2);
    assert_eq!(
        rebuilt.base_pins["docker.io/library/alpine:3.20"],
        format!("docker.io/library/alpine@{MOVED}")
    );

    // An explicit rebuild always asks the registry; a malformed record is ignored.
    build(&fixture.inputs(Policy::Rebuild));
    assert_eq!(resolves(), 3);
    fs::write(&record, b"{not json").unwrap();
    fs::remove_file(
        builds_root(&fixture.candidate)
            .join(&second.namespace)
            .join(format!("{}.json", second.key)),
    )
    .unwrap();
    build(&second);
    assert_eq!(resolves(), 4);
    let read = read_base_record(&record, "docker.io/library/alpine:3.20", *pool.now.borrow());
    assert!(read.is_some(), "the malformed record was not rewritten");
    assert!(read_base_record(&record, "docker.io/library/busybox:1", *pool.now.borrow()).is_none());
    // Reclamation still reads the namespace directory.
    assert!(reclaim::run(&fixture.candidate, &pool).is_ok());
}

#[test]
fn preparation_never_reads_inputs_through_a_swapped_directory() {
    let fixture = Fixture::new();
    let app = fixture.project.join("app");
    fs::write(app.join(".dockerignore"), "*.log\n").unwrap();
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let foreign = "FROM busybox:1.36\nRUN echo outside\n";
    fs::write(outside.join("Dockerfile"), foreign).unwrap();
    fs::write(outside.join(".dockerignore"), "outside-rules\n").unwrap();
    fs::write(outside.join("Dockerfile.dockerignore"), "outside-rules\n").unwrap();
    let original = fs::read(app.join("Dockerfile")).unwrap();
    // The swap happens after the request's paths were validated, as the input reads
    // enter `app`, once for each kind of input in turn.
    for (fires_on, label) in [(1, "Dockerfile"), (2, "ignore files")] {
        let (hook_app, hook_outside) = (app.clone(), outside.clone());
        let mut seen = 0;
        context::BEFORE_DESCEND.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |relative: &[u8]| {
                if relative == b"app" {
                    seen += 1;
                    if seen == fires_on {
                        fs::rename(&hook_app, hook_app.with_file_name("app-moved")).unwrap();
                        std::os::unix::fs::symlink(&hook_outside, &hook_app).unwrap();
                    }
                }
            }))
        });
        let prepared = prepare(
            fixture.request(Policy::Missing),
            &builds_root(&fixture.candidate),
        );
        context::BEFORE_DESCEND.with(|slot| *slot.borrow_mut() = None);
        assert!(app.is_symlink(), "{label}: the swap never happened");
        match prepared {
            Err(error) => {
                assert!(
                    matches!(
                        error.code,
                        "native_build_source" | "native_build_context_changed"
                    ),
                    "{label}: {}",
                    error.code
                );
                assert!(!error.message.contains("outside"));
            }
            Ok(inputs) => {
                assert_eq!(inputs.dockerfile, original, "{label}");
                assert_ne!(inputs.ignore, b"outside-rules\n", "{label}");
            }
        }
        // Put the project back for the next case.
        fs::remove_file(&app).unwrap();
        fs::rename(app.with_file_name("app-moved"), &app).unwrap();
    }
}
