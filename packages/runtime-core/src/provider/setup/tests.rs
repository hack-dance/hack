use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    thread,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(crate::private_test_root(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            "setup-test",
        ))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn request(stream: &mut TcpStream) -> String {
    // macOS inherits O_NONBLOCK from the listening socket. Restore blocking I/O
    // so the explicit accepted-socket read/write timeouts govern this fixture.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 8192 {
        if stream.read(&mut byte).unwrap() == 0 {
            break;
        }
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).unwrap()
}
fn server(replies: Vec<(&str, &str)>) -> (FilePin, thread::JoinHandle<()>) {
    let replies = replies
        .into_iter()
        .map(|(request, response)| (request.to_owned(), response.to_owned()))
        .collect();
    scripted_server(|_| replies)
}
fn scripted_server(
    replies: impl FnOnce(u16) -> Vec<(String, String)>,
) -> (FilePin, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let pin = FilePin {
        url: format!("http://{}/archive.tgz", listener.local_addr().unwrap()),
        archive_sha256: format!("{:x}", Sha256::digest(b"hello")),
        max_bytes: 16,
        size_bytes: 5,
        redirect_hosts: vec![],
    };
    let replies = replies(listener.local_addr().unwrap().port());
    let handle = thread::spawn(move || {
        let mut redirect_connections = Vec::new();
        for (expected, reply) in replies {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(e) => panic!("fake server accept: {e}"),
                }
            };
            assert!(
                request(&mut stream)
                    .to_ascii_lowercase()
                    .contains(&expected)
            );
            // This script handles one request per TCP connection. HTTP/1.1
            // otherwise permits pooling a redirect's socket while we close it.
            let reply = if reply.contains("\r\nConnection: close\r\n") {
                reply
            } else {
                reply.replacen("\r\n", "\r\nConnection: close\r\n", 1)
            };
            stream.write_all(reply.as_bytes()).unwrap();
            if reply.starts_with("HTTP/1.1 3") {
                // The next hop must connect before this socket reaches EOF.
                // This makes redirect coverage independent of FIN scheduling.
                redirect_connections.push(stream);
            }
        }
    });
    (pin, handle)
}
fn client() -> download::Client {
    download::test_client(
        std::time::Duration::from_secs(2),
        std::time::Duration::from_secs(5),
        None,
    )
}

fn install(
    candidate: &Candidate,
    inputs: Option<OfflineInputs<'_>>,
    files: &[FilePin],
    prepare: impl FnOnce(&Candidate, OfflineInputs<'_>) -> Result<(), CandidateError>,
    verify: impl Fn(&Candidate) -> Result<(), CandidateError>,
) -> Result<&'static str, CandidateError> {
    super::install(candidate, inputs, files, prepare, verify, || Ok(client()))
}

#[test]
fn download_verifies_and_second_run_makes_no_request() {
    let root = Fixture::new();
    let (pin, server) = server(vec![(
        "get /archive.tgz",
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    )]);
    download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap(); // server is gone: another request would fail
    let path = root.0.join("archive.tgz");
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    download::acquire(&client(), &root.0, &pin).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(&path, b"changed").unwrap();
    assert_eq!(
        download::acquire(&client(), &root.0, &pin)
            .unwrap_err()
            .code,
        "setup_cache_invalid"
    );
}

#[test]
fn rejects_hash_truncation_oversize_and_foreign_redirect() {
    for (reply, expected) in [
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nwrong",
            "setup_hash_mismatch",
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe",
            "setup_download",
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n",
            "setup_size_exceeded",
        ),
        (
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n0123456789abcdefg",
            "setup_size_exceeded",
        ),
        (
            "HTTP/1.1 302 Found\r\nLocation: https://other.example/archive.tgz\r\nContent-Length: 0\r\n\r\n",
            "setup_redirect_refused",
        ),
        (
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
            "setup_pin_unavailable",
        ),
    ] {
        let root = Fixture::new();
        let (pin, server) = server(vec![("get /archive.tgz", reply)]);
        let error = download::acquire(&client(), &root.0, &pin).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, expected);
        assert!(error.message.contains("archive.tgz"));
        assert!(!root.0.join("archive.tgz").exists());
    }
}

#[test]
fn interruption_resumes_then_hashes_the_entire_file() {
    let root = Fixture::new();
    let (pin, server) = server(vec![
        (
            "get /archive.tgz",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe",
        ),
        (
            "range: bytes=2-",
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-4/5\r\nContent-Length: 3\r\n\r\nllo",
        ),
    ]);
    assert!(download::acquire(&client(), &root.0, &pin).is_err());
    assert_eq!(fs::read(root.0.join("archive.tgz.part")).unwrap(), b"he");
    download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap();
    assert_eq!(fs::read(root.0.join("archive.tgz")).unwrap(), b"hello");
}

#[test]
fn ignored_range_restarts_and_invalid_range_refuses() {
    for (reply, success) in [
        ("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", true),
        (
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-4/5\r\nContent-Length: 4\r\n\r\nello",
            false,
        ),
    ] {
        let root = Fixture::new();
        let (pin, server) = server(vec![("range: bytes=2-", reply)]);
        fs::write(root.0.join("archive.tgz.part"), b"he").unwrap();
        fs::set_permissions(
            root.0.join("archive.tgz.part"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert_eq!(download::acquire(&client(), &root.0, &pin).is_ok(), success);
        server.join().unwrap();
    }
}

#[test]
fn consent_refuses_without_effects_and_calls_confirmation_once() {
    assert_eq!(
        consent(false, false, || panic!("non-interactive prompt"))
            .unwrap_err()
            .code,
        "E_INTERACTIVE_REQUIRED"
    );
    assert_eq!(
        consent(false, true, || Ok(false)).unwrap_err().code,
        "setup_declined"
    );
    consent(true, false, || panic!("explicit consent prompted")).unwrap();
    let mut called = 0;
    consent(false, true, || {
        called += 1;
        Ok(true)
    })
    .unwrap();
    assert_eq!(called, 1);
}

#[test]
fn compiled_pins_match_manual_preparation_and_use_https() {
    let pins = pins().unwrap();
    assert_eq!(pins.len(), 6);
    for pin in pins {
        assert!(pin.url.starts_with("https://"));
    }
}

#[test]
fn failed_prepare_never_publishes_and_interrupted_staging_is_rerunnable() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let setup = candidate.state_root.join("setup");
    state::private_directory(&setup).unwrap();
    let target = candidate.state_root.join("providers");
    let failure = publish(&candidate, &setup, &target, |staged| {
        state::private_directory(&staged.state_root.join("providers")).unwrap();
        fs::write(
            staged.state_root.join("providers/incomplete"),
            b"incomplete",
        )
        .unwrap();
        fs::set_permissions(
            staged.state_root.join("providers"),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        Err(CandidateError::new(
            "test_preparation",
            "simulated preparation interruption",
        ))
    });
    assert!(failure.is_err());
    assert!(!target.exists());
    publish(&candidate, &setup, &target, |staged| {
        state::private_directory(&staged.state_root.join("providers")).unwrap();
        fs::write(staged.state_root.join("providers/complete"), b"complete").unwrap();
        Ok(())
    })
    .unwrap();
    assert!(target.join("complete").exists());
    assert!(!target.join("incomplete").exists());
}

#[test]
fn unsafe_partial_and_offline_digest_are_not_trusted() {
    let root = Fixture::new();
    let pin = FilePin {
        url: "https://example.test/archive.tgz".into(),
        archive_sha256: format!("{:x}", Sha256::digest(b"hello")),
        max_bytes: 16,
        size_bytes: 5,
        redirect_hosts: vec![],
    };
    let outside = root.0.join("unrelated");
    fs::write(&outside, b"hello").unwrap();
    std::os::unix::fs::symlink(&outside, root.0.join("archive.tgz.part")).unwrap();
    assert_eq!(
        download::acquire(&client(), &root.0, &pin)
            .unwrap_err()
            .code,
        "setup_file"
    );
    fs::write(&outside, b"wrong").unwrap();
    assert_eq!(
        download::verify_input(&outside, &pin).unwrap_err().code,
        "setup_hash_mismatch"
    );
}

fn fixture_prepare(staged: &Candidate, inputs: OfflineInputs<'_>) -> Result<(), CandidateError> {
    assert_eq!(fs::read(inputs.archive).unwrap(), b"hello");
    assert_eq!(fs::read(inputs.engine_archive).unwrap(), b"hello");
    assert_eq!(
        fs::read(inputs.network_tools.join("guest.apk")).unwrap(),
        b"hello"
    );
    let target = staged.state_root.join("providers");
    state::private_directory(&target)?;
    fs::write(target.join("complete"), b"verified").unwrap();
    Ok(())
}
fn fixture_verify(candidate: &Candidate) -> Result<(), CandidateError> {
    match fs::read(candidate.state_root.join("providers/complete")) {
        Ok(bytes) if bytes == b"verified" => Ok(()),
        _ => Err(CandidateError::new(
            "test_incomplete",
            "incomplete provider set",
        )),
    }
}
fn fixture_pins(pin: &FilePin) -> Vec<FilePin> {
    ["provider.tgz", "engine.tgz", "guest.apk"]
        .into_iter()
        .map(|name| FilePin {
            url: pin.url.replace("archive.tgz", name),
            ..pin.clone()
        })
        .collect()
}

#[test]
fn full_setup_orchestration_downloads_once_and_reuses_without_prepare() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let (pin, server) = server(vec![
        (
            "get /provider.tgz",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        ),
        (
            "get /engine.tgz",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        ),
        (
            "get /guest.apk",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        ),
    ]);
    let files = fixture_pins(&pin);
    assert_eq!(
        install(&candidate, None, &files, fixture_prepare, fixture_verify).unwrap(),
        "installed"
    );
    server.join().unwrap();
    assert_eq!(
        install(
            &candidate,
            None,
            &files,
            |_, _| panic!("repeat prepared again"),
            fixture_verify
        )
        .unwrap(),
        "reused"
    );
    // This also proves offline setup reuses the installed set without reading unavailable inputs.
    assert_eq!(
        install(
            &candidate,
            Some(OfflineInputs {
                archive: Path::new("/unavailable"),
                engine_archive: Path::new("/unavailable"),
                network_tools: Path::new("/unavailable")
            }),
            &files,
            |_, _| panic!("repeat prepared again"),
            fixture_verify
        )
        .unwrap(),
        "reused"
    );
}

#[test]
fn offline_setup_and_partial_manual_install_preservation() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let source = root.0.join("inputs");
    state::private_directory(&source).unwrap();
    for name in ["provider.tgz", "engine.tgz", "guest.apk"] {
        fs::write(source.join(name), b"hello").unwrap();
    }
    let pin = FilePin {
        url: "https://unused.example/archive.tgz".into(),
        archive_sha256: format!("{:x}", Sha256::digest(b"hello")),
        max_bytes: 16,
        size_bytes: 5,
        redirect_hosts: vec![],
    };
    let files = fixture_pins(&pin);
    // Offline provider archive paths have the same symlink/hardlink contract as manual prepare.
    let linked = root.0.join("linked.tgz");
    std::os::unix::fs::symlink(source.join("provider.tgz"), &linked).unwrap();
    let engine = root.0.join("engine-hardlink.tgz");
    fs::hard_link(source.join("engine.tgz"), &engine).unwrap();
    assert_eq!(
        install(
            &candidate,
            Some(OfflineInputs {
                archive: &linked,
                engine_archive: &engine,
                network_tools: &source
            }),
            &files,
            fixture_prepare,
            fixture_verify
        )
        .unwrap(),
        "installed"
    );
    assert!(!download_directory(&candidate).exists());
    let other = root.0.join("other-home");
    state::private_directory(&other).unwrap();
    let candidate = Candidate::discover(&other).unwrap();
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers).unwrap();
    fs::write(providers.join("manual-partial"), b"preserve").unwrap();
    let error = install(
        &candidate,
        None,
        &files,
        |_, _| panic!("incomplete install prepared"),
        fixture_verify,
    )
    .unwrap_err();
    assert_eq!(error.code, "setup_existing_invalid");
    assert!(error.message.contains("fresh native home"));
    assert_eq!(
        fs::read(providers.join("manual-partial")).unwrap(),
        b"preserve"
    );
    assert_eq!(fs::read_dir(&providers).unwrap().count(), 1);
    assert!(!download_directory(&candidate).exists());
}

#[test]
fn same_host_redirect_succeeds() {
    // The fixture retains the first socket until the target request completes.
    // Without Connection: close, a pooled request stalls on that retained socket.
    let root = Fixture::new();
    let (pin, server) = server(vec![
        (
            "get /archive.tgz",
            "HTTP/1.1 302 Found\r\nLocation: /redirected.tgz\r\nContent-Length: 0\r\n\r\n",
        ),
        (
            "get /redirected.tgz",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        ),
    ]);
    download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap();
}

#[test]
fn explicitly_allowed_redirect_host_uses_only_the_local_server() {
    let root = Fixture::new();
    let (mut pin, server) = scripted_server(|port| {
        vec![
            (
                "get /archive.tgz".into(),
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://mirror.test:{port}/archive.tgz\r\nContent-Length: 0\r\n\r\n"
                ),
            ),
            (
                "host: mirror.test:".into(),
                "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello".into(),
            ),
        ]
    });
    pin.redirect_hosts.push("mirror.test".into());
    let url = reqwest::Url::parse(&pin.url).unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], url.port().unwrap()));
    let client = download::test_client(
        std::time::Duration::from_secs(2),
        std::time::Duration::from_secs(5),
        Some(("mirror.test", address)),
    );
    download::acquire(&client, &root.0, &pin).unwrap();
    server.join().unwrap();
    assert_eq!(fs::read(root.0.join("archive.tgz")).unwrap(), b"hello");
}

#[test]
fn redirect_loop_stops_at_the_pinned_limit() {
    let root = Fixture::new();
    let (pin, server) = server(vec![
        (
            "get /archive.tgz",
            "HTTP/1.1 302 Found\r\nLocation: /archive.tgz\r\nContent-Length: 0\r\n\r\n"
        );
        6
    ]);
    let error = download::acquire(&client(), &root.0, &pin).unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, "setup_redirect_refused");
    assert!(error.message.contains("too many redirects"));
}

#[test]
fn exact_length_and_retired_pin_errors_are_named_and_path_free() {
    for (reply, expected) in [
        (
            "HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n",
            "setup_pin_unavailable",
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nhell",
            "setup_size_mismatch",
        ),
        (
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello!",
            "setup_size_mismatch",
        ),
    ] {
        let root = Fixture::new();
        let (pin, server) = server(vec![("get /archive.tgz", reply)]);
        let error = download::acquire(&client(), &root.0, &pin).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, expected);
        assert!(!error.message.contains(root.0.to_str().unwrap()));
        if expected == "setup_pin_unavailable" {
            assert!(
                error
                    .message
                    .contains("update Hack or use the offline form")
            );
        }
    }
    let root = Fixture::new();
    let (mut pin, server) = server(vec![(
        "get /archive.tgz",
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    )]);
    download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap();
    pin.size_bytes = 6; // A matching hash alone cannot bypass the exact-length pin.
    assert_eq!(
        download::verify_file(&root.0.join("archive.tgz"), &pin)
            .unwrap_err()
            .code,
        "setup_size_mismatch"
    );
    fs::write(root.0.join("archive.tgz"), b"wrong").unwrap();
    let error = download::acquire(&client(), &root.0, &pin).unwrap_err();
    assert_eq!(error.code, "setup_cache_invalid");
    assert!(!error.message.contains(root.0.to_str().unwrap()));
}

#[test]
fn per_read_timeout_and_overall_deadline_bound_a_slow_body() {
    use std::time::Duration;
    for (read_timeout, file_timeout, expected) in [
        (
            Duration::from_millis(100),
            Duration::from_secs(3),
            "setup_download",
        ),
        (
            Duration::from_secs(2),
            Duration::from_millis(350),
            "setup_download_deadline",
        ),
    ] {
        let root = Fixture::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let pin = FilePin {
            url: format!("http://{}/archive.tgz", listener.local_addr().unwrap()),
            archive_sha256: format!("{:x}", Sha256::digest(b"hello")),
            max_bytes: 16,
            size_bytes: 5,
            redirect_hosts: vec![],
        };
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request(&mut stream);
            if stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nh")
                .is_err()
            {
                return;
            }
            thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(b"e");
            thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(b"l");
            thread::sleep(Duration::from_millis(150));
        });
        let client = download::test_client(read_timeout, file_timeout, None);
        let error = download::acquire(&client, &root.0, &pin).unwrap_err();
        handle.join().unwrap();
        assert_eq!(error.code, expected);
        assert!(!root.0.join("archive.tgz").exists());
    }
}

#[test]
fn existing_install_observation_never_writes_or_acquires_inputs() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    assert!(!observe_existing(&candidate, &|_| panic!("absent install verified")).unwrap());
    assert!(!candidate.state_root.exists());
    let target = candidate.state_root.join("providers");
    state::private_directory(&target).unwrap();
    fs::write(target.join("complete"), b"verified").unwrap();
    assert_eq!(
        observe_existing(&candidate, &fixture_verify)
            .unwrap_err()
            .code,
        "setup_existing_invalid"
    );
    assert!(!candidate.state_root.join("run").exists());
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
    drop(_lock);
    assert!(observe_existing(&candidate, &fixture_verify).unwrap());
    assert!(!download_directory(&candidate).exists());
    fs::write(target.join("complete"), b"changed").unwrap();
    let error = observe_existing(&candidate, &fixture_verify).unwrap_err();
    assert_eq!(error.code, "setup_existing_invalid");
    assert!(!error.message.contains(root.0.to_str().unwrap()));
}

#[test]
fn body_without_content_length_retains_a_short_prefix_for_resume() {
    let root = Fixture::new();
    let (pin, server) = server(vec![
        (
            "get /archive.tgz",
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhe",
        ),
        (
            "range: bytes=2-",
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-4/5\r\nContent-Length: 3\r\n\r\nllo",
        ),
    ]);
    assert_eq!(
        download::acquire(&client(), &root.0, &pin)
            .unwrap_err()
            .code,
        "setup_truncated"
    );
    assert_eq!(fs::read(root.0.join("archive.tgz.part")).unwrap(), b"he");
    download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap();
    assert_eq!(fs::read(root.0.join("archive.tgz")).unwrap(), b"hello");
}
