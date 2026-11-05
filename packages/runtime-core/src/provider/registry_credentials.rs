//! Read-only registry credential lookup through the host user's existing Docker
//! configuration, following the Docker CLI's order:
//!
//! 1. a `credHelpers` entry for the registry runs `docker-credential-<name> get`;
//! 2. otherwise a `credsStore` runs that helper;
//! 3. otherwise an `auths` entry supplies `auth`, `username`/`password` or `identitytoken`.
//!
//! Nothing is written: no login, store, erase or configuration change. Values stay in
//! zeroizing memory for one acquisition and are never logged, persisted or included in
//! errors; helper stderr is discarded because helpers may print secrets there.
use super::image_policy::ImagePolicy;
use crate::CandidateError;
use base64::Engine as _;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_HELPER_OUTPUT: u64 = 64 * 1024;
/// Helpers may wait on a native approval such as a keychain prompt; that wait is bounded.
const HELPER_TIMEOUT: Duration = Duration::from_secs(60);
/// After the helper exits, how long its stdout may take to close. A descendant that keeps
/// the pipe open cannot extend the wait beyond this.
const HELPER_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// The server address the Docker CLI uses for Docker Hub credentials.
const DOCKER_HUB_SERVER: &str = "https://index.docker.io/v1/";

fn error(message: &str) -> CandidateError {
    CandidateError::new("registry_credentials", message)
}

/// One credential for one registry, held only in zeroizing memory.
pub(super) enum Credential {
    Basic {
        username: Zeroizing<String>,
        password: Zeroizing<String>,
    },
    /// An OAuth2 refresh token (`identitytoken`, or a helper's `<token>` username).
    IdentityToken(Zeroizing<String>),
}

impl Credential {
    /// `Basic` authorization value for a registry or token realm, when this credential has one.
    pub(super) fn basic_header(&self) -> Option<Zeroizing<String>> {
        match self {
            Self::Basic { username, password } => {
                let joined = Zeroizing::new(format!("{}:{}", username.as_str(), password.as_str()));
                Some(Zeroizing::new(format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(joined.as_bytes())
                )))
            }
            Self::IdentityToken(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct Config {
    #[serde(default)]
    auths: BTreeMap<String, AuthEntry>,
    #[serde(rename = "credsStore")]
    creds_store: Option<String>,
    #[serde(rename = "credHelpers", default)]
    cred_helpers: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct AuthEntry {
    auth: Option<String>,
    username: Option<String>,
    password: Option<String>,
    identitytoken: Option<String>,
}

impl Drop for AuthEntry {
    fn drop(&mut self) {
        for value in [
            &mut self.auth,
            &mut self.username,
            &mut self.password,
            &mut self.identitytoken,
        ]
        .into_iter()
        .flatten()
        {
            value.zeroize();
        }
    }
}

#[derive(Deserialize)]
struct HelperReply {
    #[serde(rename = "Username", default)]
    username: String,
    #[serde(rename = "Secret", default)]
    secret: String,
}

impl Drop for HelperReply {
    fn drop(&mut self) {
        self.username.zeroize();
        self.secret.zeroize();
    }
}

/// The hostnames a Docker configuration key may name for `domain`, as the Docker CLI
/// converts keys: scheme and any path are ignored.
fn matches(key: &str, domain: &str) -> bool {
    let host = key
        .strip_prefix("https://")
        .or_else(|| key.strip_prefix("http://"))
        .unwrap_or(key);
    let host = host.split('/').next().unwrap_or_default();
    if domain == "docker.io" {
        matches!(
            host,
            "index.docker.io" | "docker.io" | "registry-1.docker.io"
        )
    } else {
        host == domain
    }
}

fn server_address(domain: &str) -> &str {
    if domain == "docker.io" {
        DOCKER_HUB_SERVER
    } else {
        domain
    }
}

fn config_path(policy: &ImagePolicy) -> Option<PathBuf> {
    let directory = match &policy.docker_config {
        Some(directory) => directory.clone(),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".docker"),
    };
    Some(directory.join("config.json"))
}

fn read_config(policy: &ImagePolicy) -> Result<Option<Config>, CandidateError> {
    let Some(path) = config_path(policy) else {
        return Ok(None);
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("Cannot read the Docker configuration file.")),
    };
    let metadata = file
        .metadata()
        .map_err(|_| error("Cannot inspect the Docker configuration file."))?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG {
        return Err(error(
            "The Docker configuration must be a regular file no larger than 1 MiB.",
        ));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot read the Docker configuration file."))?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err(error("The Docker configuration exceeds 1 MiB."));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| error("The Docker configuration file is not valid JSON."))
}

fn helper_name(name: &str) -> Result<&str, CandidateError> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(error(
            "The configured Docker credential helper name is invalid.",
        ));
    }
    Ok(name)
}

fn helper_executable(policy: &ImagePolicy, name: &str) -> Result<PathBuf, CandidateError> {
    let directories = match &policy.helper_path {
        Some(directories) => directories.clone(),
        None => std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default(),
    };
    directories
        .into_iter()
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(format!("docker-credential-{name}")))
        .find(|path| {
            std::fs::metadata(path)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .ok_or_else(|| error("The configured Docker credential helper was not found on PATH."))
}

/// Collect reader chunks into `output` until the pipe closes (true) or `until` passes
/// (false). Collection stops once more than the output limit has arrived.
fn drain(
    chunks: &mpsc::Receiver<Zeroizing<Vec<u8>>>,
    output: &mut Zeroizing<Vec<u8>>,
    until: Instant,
) -> bool {
    loop {
        let wait = until.saturating_duration_since(Instant::now());
        match chunks.recv_timeout(wait) {
            Ok(chunk) => {
                let room = (MAX_HELPER_OUTPUT as usize + 1).saturating_sub(output.len());
                output.extend_from_slice(&chunk[..chunk.len().min(room)]);
                if output.len() as u64 > MAX_HELPER_OUTPUT {
                    return true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return false,
            Err(mpsc::RecvTimeoutError::Disconnected) => return true,
        }
    }
}

/// Run `docker-credential-<name> get` for one server address. Helper output is bounded and
/// its stderr discarded.
///
/// Every wait is bounded by `timeout`, independently of the helper's descendants: the
/// helper runs in its own process group, and stdout is drained by a detached reader whose
/// chunks are collected with deadlines. A helper that does not exit in time has its whole
/// process group killed. A helper that exits while a descendant still holds stdout gets a
/// short drain grace; its reply is whatever it wrote before exiting, and the reader is
/// abandoned until the descendant closes the pipe.
fn run_helper(
    policy: &ImagePolicy,
    name: &str,
    server: &str,
    timeout: Duration,
) -> Result<Option<Credential>, CandidateError> {
    let executable = helper_executable(policy, helper_name(name)?)?;
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(executable)
        .arg("get")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| error("Cannot start the Docker credential helper."))?;
    let written = child
        .stdin
        .take()
        .map(|mut stdin| stdin.write_all(server.as_bytes()));
    let (sender, chunks) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buffer = Zeroizing::new([0_u8; 8192]);
            let mut total = 0_u64;
            while total <= MAX_HELPER_OUTPUT {
                match stdout.read(buffer.as_mut()) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        total += n as u64;
                        if sender.send(Zeroizing::new(buffer[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    // Reserved up front so collection never reallocates and leaves unzeroized copies.
    let mut output = Zeroizing::new(Vec::with_capacity(MAX_HELPER_OUTPUT as usize + 1));
    let mut closed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                let poll = Instant::now() + Duration::from_millis(20);
                if closed {
                    std::thread::sleep(poll.saturating_duration_since(Instant::now()));
                } else {
                    closed = drain(&chunks, &mut output, poll);
                }
            }
            _ => {
                // The child is not reaped yet, so its pid still names its process group.
                if let Ok(group) = i32::try_from(child.id()) {
                    // SAFETY: killpg only sends a signal to the helper's own group.
                    unsafe { libc::killpg(group, libc::SIGKILL) };
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(error(
                    "The Docker credential helper did not finish in time.",
                ));
            }
        }
    };
    if !closed {
        drain(
            &chunks,
            &mut output,
            deadline.min(Instant::now() + HELPER_DRAIN_GRACE),
        );
    }
    if output.len() as u64 > MAX_HELPER_OUTPUT {
        return Err(error(
            "The Docker credential helper reply exceeds its limit.",
        ));
    }
    if !status.success() {
        // The helper protocol reports an absent entry as a failure with this message on stdout.
        if output
            .windows(b"credentials not found".len())
            .any(|w| w.eq_ignore_ascii_case(b"credentials not found"))
        {
            return Ok(None);
        }
        return Err(error(
            "The Docker credential helper failed; its output was discarded.",
        ));
    }
    if written.is_some_and(|result| result.is_err()) {
        return Err(error(
            "Cannot send the server address to the Docker credential helper.",
        ));
    }
    let reply: HelperReply = serde_json::from_slice(&output)
        .map_err(|_| error("The Docker credential helper reply is invalid."))?;
    if reply.secret.is_empty() {
        return Ok(None);
    }
    Ok(Some(if reply.username == "<token>" {
        Credential::IdentityToken(Zeroizing::new(reply.secret.clone()))
    } else {
        Credential::Basic {
            username: Zeroizing::new(reply.username.clone()),
            password: Zeroizing::new(reply.secret.clone()),
        }
    }))
}

fn file_credential(entry: &AuthEntry) -> Result<Option<Credential>, CandidateError> {
    if let Some(token) = entry.identitytoken.as_deref().filter(|t| !t.is_empty()) {
        return Ok(Some(Credential::IdentityToken(Zeroizing::new(
            token.to_owned(),
        ))));
    }
    if let Some(auth) = entry.auth.as_deref().filter(|a| !a.is_empty()) {
        let decoded = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(auth.trim())
                .map_err(|_| error("A Docker configuration auth entry is invalid."))?,
        );
        let text = std::str::from_utf8(&decoded)
            .map_err(|_| error("A Docker configuration auth entry is invalid."))?;
        let (username, password) = text
            .split_once(':')
            .ok_or_else(|| error("A Docker configuration auth entry is invalid."))?;
        return Ok(Some(Credential::Basic {
            username: Zeroizing::new(username.to_owned()),
            password: Zeroizing::new(password.to_owned()),
        }));
    }
    match (entry.username.as_deref(), entry.password.as_deref()) {
        (Some(username), Some(password)) if !password.is_empty() => Ok(Some(Credential::Basic {
            username: Zeroizing::new(username.to_owned()),
            password: Zeroizing::new(password.to_owned()),
        })),
        _ => Ok(None),
    }
}

/// The host user's credential for `domain` (`host[:port]`, or `docker.io`), or `None` when
/// the configuration names none. Called only after a registry challenges a request.
pub(super) fn lookup(
    policy: &ImagePolicy,
    domain: &str,
) -> Result<Option<Credential>, CandidateError> {
    let Some(config) = read_config(policy)? else {
        return Ok(None);
    };
    if let Some((_, helper)) = config
        .cred_helpers
        .iter()
        .find(|(key, _)| matches(key, domain))
    {
        return run_helper(policy, helper, server_address(domain), HELPER_TIMEOUT);
    }
    if let Some(store) = config.creds_store.as_deref().filter(|s| !s.is_empty()) {
        return run_helper(policy, store, server_address(domain), HELPER_TIMEOUT);
    }
    // Prefer an exact key; otherwise the first converted key that names the registry.
    let entry = config
        .auths
        .get(server_address(domain))
        .or_else(|| config.auths.get(domain))
        .or_else(|| {
            config
                .auths
                .iter()
                .find(|(key, _)| matches(key, domain))
                .map(|(_, entry)| entry)
        });
    entry.map_or(Ok(None), file_credential)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{fs, os::unix::fs::OpenOptionsExt};

    /// A private fixture directory with a Docker configuration and fake helpers. The real
    /// user configuration, keychain and helpers are never consulted.
    pub(crate) struct DockerFixture {
        pub(crate) root: PathBuf,
    }

    impl DockerFixture {
        pub(crate) fn new(config: &serde_json::Value) -> Self {
            let root = crate::private_test_root(&std::env::temp_dir(), "hkg-docker-config");
            fs::write(
                root.join("config.json"),
                serde_json::to_vec(config).unwrap(),
            )
            .unwrap();
            Self { root }
        }

        pub(crate) fn helper(&self, name: &str, script: &str) {
            let path = self.root.join(format!("docker-credential-{name}"));
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o700)
                .open(&path)
                .unwrap();
            file.write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
                .unwrap();
        }

        pub(crate) fn policy(&self) -> ImagePolicy {
            ImagePolicy {
                docker_config: Some(self.root.clone()),
                helper_path: Some(vec![self.root.clone()]),
                ..ImagePolicy::default()
            }
        }
    }

    impl Drop for DockerFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn basic(credential: Option<Credential>) -> String {
        credential.unwrap().basic_header().unwrap().to_string()
    }

    fn encoded(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    #[test]
    fn file_entries_match_like_the_docker_cli_and_absent_entries_are_anonymous() {
        let f = DockerFixture::new(&serde_json::json!({
            "auths": {
                "https://index.docker.io/v1/": {"auth": encoded("hub-user:hub-fixture")},
                "https://registry.test:5000/v2/": {"username": "u", "password": "p"},
                "token.test": {"identitytoken": "refresh-fixture"},
            },
            "unrelated": {"kept": true}
        }));
        let policy = f.policy();
        assert_eq!(
            basic(lookup(&policy, "docker.io").unwrap()),
            format!("Basic {}", encoded("hub-user:hub-fixture"))
        );
        assert_eq!(
            basic(lookup(&policy, "registry.test:5000").unwrap()),
            format!("Basic {}", encoded("u:p"))
        );
        assert!(matches!(
            lookup(&policy, "token.test").unwrap(),
            Some(Credential::IdentityToken(token)) if token.as_str() == "refresh-fixture"
        ));
        // A different port or host is a different registry.
        assert!(lookup(&policy, "registry.test").unwrap().is_none());
        assert!(lookup(&policy, "other.test").unwrap().is_none());
        let missing = ImagePolicy {
            docker_config: Some(f.root.join("absent")),
            ..ImagePolicy::default()
        };
        assert!(lookup(&missing, "docker.io").unwrap().is_none());
    }

    #[test]
    fn helpers_take_precedence_and_report_absent_entries_without_failing() {
        let f = DockerFixture::new(&serde_json::json!({
            "auths": {"helper.test": {"auth": encoded("file:ignored")}},
            "credHelpers": {"helper.test": "fixture", "missing.test": "absent", "bad.test": "../x"},
            "credsStore": "store"
        }));
        // The helper receives exactly the server address on stdin.
        f.helper(
            "fixture",
            r#"[ "$1" = get ] || exit 3; read -r server || true; [ "$server" = helper.test ] || exit 4; printf '{"ServerURL":"helper.test","Username":"u","Secret":"s"}'; echo "leaked secret" >&2"#,
        );
        f.helper(
            "store",
            r#"read -r server || true; if [ "$server" = "https://index.docker.io/v1/" ]; then printf '{"Username":"<token>","Secret":"refresh"}'; else echo "credentials not found in native keychain"; exit 1; fi"#,
        );
        let policy = f.policy();
        assert_eq!(
            basic(lookup(&policy, "helper.test").unwrap()),
            format!("Basic {}", encoded("u:s"))
        );
        assert!(matches!(
            lookup(&policy, "docker.io").unwrap(),
            Some(Credential::IdentityToken(token)) if token.as_str() == "refresh"
        ));
        assert!(lookup(&policy, "ghcr.io").unwrap().is_none());
        assert_eq!(
            lookup(&policy, "missing.test").err().unwrap().code,
            "registry_credentials"
        );
        assert_eq!(
            lookup(&policy, "bad.test").err().unwrap().code,
            "registry_credentials"
        );
    }

    /// The pid a fixture helper recorded for its background descendant.
    fn descendant(f: &DockerFixture, name: &str) -> i32 {
        let path = f.root.join(format!("docker-credential-{name}.pid"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(pid) = fs::read_to_string(&path)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "helper recorded no descendant");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the fixture process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn helper_descendants_holding_stdout_cannot_extend_the_bounded_wait() {
        // The helper replies and exits while a background descendant keeps stdout open.
        let f = DockerFixture::new(&serde_json::json!({"credsStore": "lingers"}));
        f.helper(
            "lingers",
            r#"read -r server || true; printf '{"Username":"u","Secret":"s"}'; sleep 30 & echo $! > "$0.pid""#,
        );
        let started = Instant::now();
        let credential = lookup(&f.policy(), "registry.test").unwrap();
        let elapsed = started.elapsed();
        let pid = descendant(&f, "lingers");
        let still_holding = alive(pid);
        // SAFETY: the fixture's own background sleep is stopped.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        assert_eq!(basic(credential), format!("Basic {}", encoded("u:s")));
        assert!(still_holding, "the descendant must still hold stdout");
        assert!(
            elapsed < HELPER_DRAIN_GRACE + Duration::from_secs(3),
            "{elapsed:?}"
        );

        // A helper that never exits is stopped at its bound with its whole process group,
        // even while a descendant holds stdout.
        let f = DockerFixture::new(&serde_json::json!({"credsStore": "hangs"}));
        f.helper("hangs", r#"sleep 30 & echo $! > "$0.pid"; sleep 30"#);
        let started = Instant::now();
        let failure = run_helper(
            &f.policy(),
            "hangs",
            "registry.test",
            Duration::from_secs(1),
        )
        .err()
        .unwrap();
        let elapsed = started.elapsed();
        assert!(
            failure.message.contains("did not finish in time"),
            "{failure:?}"
        );
        assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
        let pid = descendant(&f, "hangs");
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let survived = alive(pid);
        // SAFETY: cleanup of the fixture's own background sleep if the group kill missed it.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        assert!(!survived, "the helper's process group must be killed");
    }

    #[test]
    fn failing_helpers_and_malformed_configuration_refuse_without_echoing_values() {
        let f = DockerFixture::new(&serde_json::json!({"credsStore": "fails"}));
        f.helper(
            "fails",
            "echo PRIVATE_CANARY; echo PRIVATE_CANARY >&2; exit 2",
        );
        let failure = lookup(&f.policy(), "registry.test").err().unwrap();
        assert!(!failure.message.contains("PRIVATE_CANARY"));
        fs::write(
            f.root.join("config.json"),
            b"{\"auths\":{\"a.test\":{\"auth\":\"%%\"}}}",
        )
        .unwrap();
        let failure = lookup(&f.policy(), "a.test").err().unwrap();
        assert!(!failure.message.contains("%%"));
        fs::write(f.root.join("config.json"), b"PRIVATE_CANARY").unwrap();
        assert!(
            !lookup(&f.policy(), "a.test")
                .err()
                .unwrap()
                .message
                .contains("PRIVATE_CANARY")
        );
    }
}
