//! `runtime build-image` against a fake pool and a fake build client.
//!
//! The fake client is `/bin/sh` reading a script named `bake` (its first argument) from
//! the client's private working directory, so no test writes and then executes a fresh
//! binary. It records its argv, its whole environment, a copy of the bake definition,
//! the staged Dockerfile and ignore rules, and a call count.
use super::*;
use std::{
    cell::RefCell,
    collections::BTreeSet,
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
(cd snapshot/context && find . -print) > seen-tree
case {mode} in
  ok) printf '{{"build":{{"containerimage.config.digest":"{IMAGE}"}}}}' > "$meta" ;;
  given) printf '{{"build":{{"containerimage.config.digest":"%s"}}}}' "$(cat image-id)" > "$meta" ;;
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
    freed_by_prune: u64,
    trims: RefCell<u32>,
    trim_fails: bool,
    prunes: RefCell<Vec<u64>>,
    resolve_delay: Duration,
    resolve_deadlines: RefCell<Vec<Instant>>,
    output: Arc<Mutex<Vec<u8>>>,
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
            freed_by_prune: 0,
            trims: RefCell::new(0),
            trim_fails: false,
            prunes: RefCell::new(Vec::new()),
            resolve_delay: Duration::ZERO,
            resolve_deadlines: RefCell::new(Vec::new()),
            output: Arc::default(),
            builder_home: None,
        }
    }
    /// Register `id` as the image the fake client in mode `given` "builds" for `inputs`.
    fn built_as(&self, inputs: &Inputs, incarnation: &str, id: &str) {
        let labels = serde_json::to_value(labels(inputs, &identity(incarnation))).unwrap();
        self.images.borrow_mut().insert(
            id.into(),
            serde_json::json!({"Id": id, "Architecture": "arm64", "Os": "linux",
                "Size": GIB, "Config": {"Labels": labels, "Volumes": null}}),
        );
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
        Ok(BuildBase {
            pinned_reference: format!("docker.io/{}@{PIN}", base.repository()),
            source_digest: PIN.into(),
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
        *self.available.borrow_mut() += self.freed_by_prune;
        Ok(7)
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
        declaration: None,
        sequence: None,
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
        declaration: None,
        sequence: None,
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
    request.version = 2;
    assert_eq!(code(&fixture, request), "native_build_request");
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
    fn trim(&self, _: &()) -> Result<(), CandidateError> {
        *self.trims.borrow_mut() += 1;
        if self.trim_fails {
            Err(invalid("Trim interrupted."))
        } else {
            Ok(())
        }
    }
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
fn explicit_reclaim_trims_only_after_enough_guest_space_is_freed() {
    let fixture = Fixture::new();
    for (freed, allowed, fails, expected) in [
        (256 * 1024 * 1024 - 1, true, false, false),
        (256 * 1024 * 1024, true, false, true),
        (256 * 1024 * 1024, true, true, false),
        (256 * 1024 * 1024, false, false, false),
    ] {
        let mut pool = FakePool::new("pool-1");
        pool.freed_by_prune = freed;
        pool.trim_fails = fails;
        let report = if allowed {
            reclaim::run(&fixture.candidate, &pool, true).unwrap()
        } else {
            reclaim::best_effort(&fixture.candidate, &pool).report
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json.get("trim").is_some(), expected);
        if expected {
            assert_eq!(json["trim"]["guest_bytes_freed"], freed);
            assert!(json["trim"]["seconds"].as_f64().unwrap() >= 0.0);
        }
        assert_eq!(*pool.trims.borrow(), u32::from(expected || fails));
        assert_eq!(report.cache_reclaimed_bytes, Some(7));
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
        reclaim::run(&fixture.candidate, &pool, true)
            .unwrap_err()
            .code,
        "provider_busy"
    );
    drop(build);

    let report = reclaim::run(&fixture.candidate, &pool, true).unwrap();
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
    let report = reclaim::run(&fixture.candidate, &other, true).unwrap();
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
        declaration: None,
        sequence: None,
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
    assert!(reclaim::run(&fixture.candidate, &pool, true).is_ok());
}

#[test]
fn hack_state_is_pruned_before_hashing_or_snapshotting() {
    let fixture = Fixture::new();
    let unrelated_key = fixture.inputs(Policy::Missing).key;
    let hack = fixture.project.join(".hack");
    let builds = builds_root(&fixture.candidate);
    let private_paths = [
        ".internal/branch-usage.json",
        ".internal/lifecycle/project.log",
        ".internal/native-runs/main.json.starting-first",
        ".internal/compose.env.override.yml",
        ".branch/compose.override.yml",
        ".env",
        ".env.state.json",
        ".env.local",
        "hack.env.local.yaml",
        "hack.env.dev.local.yaml",
        ".hack.env.dev.local.yaml.pending.tmp",
        ".hack-staging/env.tmp",
        "tickets/cache",
    ];
    for name in private_paths {
        let path = hack.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "fixture").unwrap();
    }
    fs::write(fixture.project.join(".hack.secret.key"), "fixture").unwrap();
    let nested = fixture.project.join("child/.hack/.internal");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("branch-usage.json"), "nested state").unwrap();
    fs::write(hack.join(".env.example"), "example").unwrap();
    fs::write(hack.join(".dockerignore"), "!**\n").unwrap();
    fs::write(fixture.project.join(".dockerignore"), "!**\n").unwrap();
    fs::create_dir_all(hack.join("src/.internal")).unwrap();
    fs::write(hack.join("src/.internal/keep"), "source").unwrap();
    fs::write(hack.join("Dockerfile"), "FROM scratch\nCOPY . /app\n").unwrap();

    let request = |context: &str, dockerfile: &str| BuildRequest {
        context: context.into(),
        dockerfile: dockerfile.into(),
        ..fixture.request(Policy::Missing)
    };
    let first = prepare(request(".hack", "Dockerfile"), &builds).unwrap();
    let pool = FakePool::new("pool-1");
    for (context, dockerfile) in [(".hack", "Dockerfile"), (".", ".hack/Dockerfile")] {
        let inputs = prepare(request(context, dockerfile), &builds).unwrap();
        pool.built(&inputs, "pool-1", serde_json::json!({}));
        fixture.client(&inputs, "ok");
        assert!(
            !run(&fixture.candidate, &pool, &inputs, &never)
                .unwrap()
                .reused
        );
        let tree = fs::read_to_string(fixture.scratch(&inputs).join("seen-tree")).unwrap();
        for name in private_paths.into_iter().chain([".hack.secret.key"]) {
            assert!(!tree.lines().any(|line| line.ends_with(&format!("/{name}"))));
        }
        assert!(
            tree.lines()
                .any(|line| line.ends_with("/src/.internal/keep"))
        );
        assert!(tree.lines().any(|line| line.ends_with("/.env.example")));
    }

    fs::write(hack.join(private_paths[0]), "rewritten usage").unwrap();
    fs::write(
        hack.join(private_paths[1]),
        "fixture\nappended lifecycle line",
    )
    .unwrap();
    fs::remove_file(hack.join(private_paths[2])).unwrap();
    fs::write(
        hack.join(".internal/native-runs/main.json.starting-second"),
        "12345",
    )
    .unwrap();
    fs::write(
        hack.join(".internal/native-runs/main.json"),
        "new run record",
    )
    .unwrap();
    let next = prepare(request(".hack", "Dockerfile"), &builds).unwrap();
    assert_eq!(
        first.key_input["context_sha256"],
        next.key_input["context_sha256"]
    );
    assert_eq!(first.key, next.key);
    pool.built(&next, "pool-1", serde_json::json!({}));
    assert!(
        run(&fixture.candidate, &pool, &next, &never)
            .unwrap()
            .reused
    );
    assert_eq!(fixture.calls(&first), 1);
    assert_eq!(fixture.inputs(Policy::Missing).key, unrelated_key);
}

#[test]
fn explicit_local_copy_of_private_state_has_an_actionable_error() {
    let fixture = Fixture::new();
    let builds = builds_root(&fixture.candidate);
    let request = || BuildRequest {
        context: ".".into(),
        dockerfile: "app/Dockerfile".into(),
        ..fixture.request(Policy::Missing)
    };
    for instruction in [
        "COPY ./.hack/.internal/lifecycle/project.log /app",
        "COPY [\"/.hack.secret.key\", \"/app\"]",
        "COPY '.hack/.env' /app",
    ] {
        fs::write(
            fixture.project.join("app/Dockerfile"),
            format!("FROM scratch\n{instruction}\n"),
        )
        .unwrap();
        let error = prepare(request(), &builds).unwrap_err();
        assert_eq!(error.code, "native_build_copy_private");
        assert!(error.message_fixed);
        assert!(error.message.contains(
            "Hack's own machine-local file or directory, which is never sent to a build"
        ));
    }
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

/// Build `inputs` with the fake client reporting image `id`.
fn build_as(fixture: &Fixture, pool: &FakePool, inputs: &Inputs, id: &str) -> BuildOutcome {
    fixture.client(inputs, "given");
    fs::write(fixture.scratch(inputs).join("image-id"), id).unwrap();
    pool.built_as(inputs, "pool-1", id);
    run(&fixture.candidate, pool, inputs, &never).unwrap()
}

fn numbered(index: usize) -> String {
    format!("sha256:{index:064x}")
}

#[test]
fn ten_edits_of_one_build_leave_its_current_and_previous_images() {
    let fixture = Fixture::new();
    let pool = FakePool::new("pool-1");
    let mut keys = Vec::new();
    for edit in 1..=10 {
        fs::write(fixture.project.join("app/main.txt"), format!("edit {edit}")).unwrap();
        let inputs = fixture.inputs(Policy::Missing);
        let outcome = build_as(&fixture, &pool, &inputs, &numbered(edit));
        assert!(!outcome.reused);
        keys.push(inputs.key.clone());
    }
    keys.dedup();
    assert_eq!(keys.len(), 10, "every edit had its own key");
    assert_eq!(pool.images.borrow().len(), 10);
    // A retained run still references the image of edit 3. Its restore history names
    // the images of edits 2 to 8, as eight stopped generations would; history is
    // diagnostic, so those are not references (HACK-2554).
    let graphs = fixture.candidate.state_root.join("run/graphs/0123");
    state::private_directory(&graphs).unwrap();
    fs::write(
        graphs.join("receipt.json"),
        format!("{{\"image\":\"{}\"}}", numbered(3)),
    )
    .unwrap();
    let history: Vec<String> = (2..=8).map(numbered).collect();
    fs::write(
        graphs.join("restore-history.json"),
        serde_json::to_vec(&history).unwrap(),
    )
    .unwrap();
    let report = reclaim::run(&fixture.candidate, &pool, true).unwrap();
    let left: BTreeSet<String> = pool.images.borrow().keys().cloned().collect();
    assert_eq!(
        left,
        BTreeSet::from([numbered(3), numbered(9), numbered(10)])
    );
    assert_eq!(report.removed.len(), 7);
    assert_eq!(report.retained[&numbered(10)], reclaim::Retained::Current);
    assert_eq!(report.retained[&numbered(9)], reclaim::Retained::Previous);
    assert_eq!(report.retained[&numbered(3)], reclaim::Retained::Referenced);

    // Without the reference, exactly the current and previous images remain.
    fs::remove_dir_all(fixture.candidate.state_root.join("run/graphs")).unwrap();
    reclaim::run(&fixture.candidate, &pool, true).unwrap();
    let left: BTreeSet<String> = pool.images.borrow().keys().cloned().collect();
    assert_eq!(left, BTreeSet::from([numbered(9), numbered(10)]));

    // Reverting to edit 9 reuses it and makes it current; edit 10 becomes previous.
    fs::write(fixture.project.join("app/main.txt"), "edit 9").unwrap();
    let reverted = fixture.inputs(Policy::Missing);
    assert!(
        run(&fixture.candidate, &pool, &reverted, &never)
            .unwrap()
            .reused
    );
    fs::write(fixture.project.join("app/main.txt"), "edit 11").unwrap();
    let eleventh = fixture.inputs(Policy::Missing);
    build_as(&fixture, &pool, &eleventh, &numbered(11));
    let report = reclaim::run(&fixture.candidate, &pool, true).unwrap();
    assert_eq!(report.removed, vec![numbered(10)]);
    let left: BTreeSet<String> = pool.images.borrow().keys().cloned().collect();
    assert_eq!(left, BTreeSet::from([numbered(9), numbered(11)]));
}

#[test]
fn receipts_without_a_declaration_and_other_declarations_keep_their_images() {
    let fixture = Fixture::new();
    let pool = FakePool::new("pool-1");
    // Two builds of another target are another declaration, kept on their own.
    let mut request = fixture.request(Policy::Missing);
    request.target = Some("other".into());
    fs::write(
        fixture.project.join("app/Dockerfile"),
        "FROM alpine:3.20 AS other\nRUN echo hi\n",
    )
    .unwrap();
    let other = prepare(request, &builds_root(&fixture.candidate)).unwrap();
    build_as(&fixture, &pool, &other, &numbered(1));
    for edit in 2..=4 {
        fs::write(fixture.project.join("app/main.txt"), format!("edit {edit}")).unwrap();
        build_as(
            &fixture,
            &pool,
            &fixture.inputs(Policy::Missing),
            &numbered(edit),
        );
    }
    // A receipt from before declarations existed protects its image.
    let old = fixture.inputs(Policy::Missing);
    let directory = builds_root(&fixture.candidate).join(&old.namespace);
    let path = directory.join(format!("{}.json", "0".repeat(64)));
    let mut receipt = fixture.receipt(&old);
    receipt.build_key = "0".repeat(64);
    receipt.image_id = Some(numbered(2));
    receipt.declaration = None;
    receipt.sequence = None;
    state::write(&path, &receipt).unwrap();
    let report = reclaim::run(&fixture.candidate, &pool, true).unwrap();
    assert_eq!(report.retained[&numbered(1)], reclaim::Retained::Current);
    assert_eq!(report.retained[&numbered(2)], reclaim::Retained::Current);
    assert_eq!(report.retained[&numbered(3)], reclaim::Retained::Previous);
    assert_eq!(report.retained[&numbered(4)], reclaim::Retained::Current);
    assert!(report.removed.is_empty());
}

#[test]
fn best_effort_reclamation_reports_instead_of_refusing() {
    let fixture = Fixture::new();
    let pool = FakePool::new("pool-1");
    let build = Flock::try_lock(
        Flock::open(&builds_root(&fixture.candidate).join("active.lock")).unwrap_or_else(|_| {
            state::private_directory(&builds_root(&fixture.candidate)).unwrap();
            Flock::open(&builds_root(&fixture.candidate).join("active.lock")).unwrap()
        }),
        libc::LOCK_SH,
    )
    .unwrap()
    .unwrap();
    let busy = reclaim::best_effort(&fixture.candidate, &pool);
    let value = serde_json::to_value(&busy).unwrap();
    assert_eq!(value["skipped"]["code"], "provider_busy");
    assert_eq!(value["removed"], serde_json::json!([]));
    drop(build);
    let value = serde_json::to_value(reclaim::best_effort(&fixture.candidate, &pool)).unwrap();
    assert!(value.get("skipped").is_none());
    assert!(value["retained"].is_object());
}

/// A snapshot tree under `<key>.client` in `namespace`, owned per `owner`.
fn stranded_tree(namespace: &Path, key: &str, owner: Option<&crate::node::ProcessIdentity>) {
    let scratch = namespace.join(format!("{key}.client"));
    let tree = scratch.join("snapshot/context");
    state::private_directory(&tree).unwrap();
    fs::write(tree.join("big.bin"), vec![b'x'; 4096]).unwrap();
    if let Some(owner) = owner {
        state::write(&scratch.join("snapshot.owner"), owner).unwrap();
    }
}

fn own_identity() -> crate::node::ProcessIdentity {
    match crate::node::inspect_process(i32::try_from(std::process::id()).unwrap()).unwrap() {
        crate::node::Observed::Present(identity) => identity,
        crate::node::Observed::Gone => panic!("this process is gone"),
    }
}

#[test]
fn snapshots_of_dead_owners_are_removed_at_the_next_build_of_any_key() {
    let fixture = Fixture::new();
    let inputs = fixture.inputs(Policy::Missing);
    let namespace = builds_root(&fixture.candidate).join(&inputs.namespace);
    state::private_directory(&namespace).unwrap();
    let live = own_identity();
    // A process that has exited and been reaped: its pid has no live process.
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let dead_pid = i32::try_from(child.id()).unwrap();
    child.wait().unwrap();
    let dead = crate::node::ProcessIdentity {
        pid: dead_pid,
        ..live.clone()
    };
    let reused = crate::node::ProcessIdentity {
        start: live.start + 1,
        ..live.clone()
    };
    let key = |c: char| c.to_string().repeat(64);
    stranded_tree(&namespace, &key('1'), Some(&dead));
    stranded_tree(&namespace, &key('2'), Some(&live));
    stranded_tree(&namespace, &key('3'), Some(&reused));
    stranded_tree(&namespace, &key('4'), None);
    // A foreign tree: a symlinked `.client` pointing outside, with a dead owner.
    let outside = fixture.root.join("outside");
    stranded_tree(&outside, &key('5'), Some(&dead));
    std::os::unix::fs::symlink(
        outside.join(format!("{}.client", key('5'))),
        namespace.join(format!("{}.client", key('5'))),
    )
    .unwrap();
    // A dead owner whose key is still locked (a surviving client) keeps its tree.
    stranded_tree(&namespace, &key('6'), Some(&dead));
    let held = Flock::try_lock(
        Flock::open(&namespace.join(format!("{}.lock", key('6')))).unwrap(),
        libc::LOCK_EX,
    )
    .unwrap()
    .unwrap();

    fixture.client(&inputs, "ok");
    let pool = FakePool::new("pool-1");
    pool.built(&inputs, "pool-1", serde_json::json!({}));
    run(&fixture.candidate, &pool, &inputs, &never).unwrap();
    drop(held);

    let tree = |base: &Path, c: char| base.join(format!("{}.client/snapshot", key(c)));
    assert!(
        !tree(&namespace, '1').exists(),
        "a dead owner's tree was kept"
    );
    assert!(
        !namespace
            .join(format!("{}.client/snapshot.owner", key('1')))
            .exists()
    );
    assert!(
        tree(&namespace, '2').exists(),
        "a live owner's tree was removed"
    );
    assert!(
        !tree(&namespace, '3').exists(),
        "a reused pid kept the tree"
    );
    assert!(
        tree(&namespace, '4').exists(),
        "an unknown owner's tree was removed"
    );
    assert!(
        tree(&outside, '5').join("context/big.bin").exists(),
        "a foreign tree was touched"
    );
    assert!(
        tree(&namespace, '6').exists(),
        "a locked key's tree was removed"
    );
    // The build's own snapshot is gone too, and its owner record with it.
    assert!(!fixture.scratch(&inputs).join("snapshot").exists());
    assert!(!fixture.scratch(&inputs).join("snapshot.owner").exists());
}
