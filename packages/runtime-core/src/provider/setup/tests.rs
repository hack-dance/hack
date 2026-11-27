use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
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
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
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
) -> Result<Installation, CandidateError> {
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
    assert_eq!(pins.len(), 7);
    for pin in &pins {
        assert!(pin.url.starts_with("https://"));
    }
    // The consent listing ends with the image builder, the same pin manual preparation
    // accepts; the provider set that is published as one tree does not contain it.
    let builder = pins.last().unwrap();
    assert_eq!(builder.archive_sha256, artifact::BUILDER_SHA256);
    assert_eq!(
        builder.name().unwrap(),
        format!("buildx-v{}.darwin-arm64", artifact::BUILDER_VERSION)
    );
    assert_eq!(builder.size_bytes, 62_685_504);
    assert_eq!(builder_pin().unwrap().url, builder.url);
    let (provider_set, apart) = pin_set().unwrap();
    assert_eq!(provider_set.len(), 6);
    assert_eq!(apart.url, builder.url);
    assert!(provider_set.iter().all(|pin| pin.url != builder.url));
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
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
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
        install(&candidate, None, &files, fixture_prepare, fixture_verify)
            .unwrap()
            .status,
        "installed"
    );
    server.join().unwrap();
    let downloads = download_directory(&candidate);
    for name in ["provider.tgz", "engine.tgz"] {
        assert!(!downloads.join(name).exists());
    }
    assert_eq!(fs::read(downloads.join("guest.apk")).unwrap(), b"hello");
    assert_eq!(
        install(
            &candidate,
            None,
            &files,
            |_, _| panic!("repeat prepared again"),
            fixture_verify
        )
        .unwrap()
        .status,
        "reused"
    );
    // This also proves offline setup reuses the installed set without reading unavailable inputs.
    assert_eq!(
        install(
            &candidate,
            Some(OfflineInputs {
                archive: Path::new("/unavailable"),
                engine_archive: Path::new("/unavailable"),
                network_tools: Path::new("/unavailable"),
                builder: None,
            }),
            &files,
            |_, _| panic!("repeat prepared again"),
            fixture_verify
        )
        .unwrap()
        .status,
        "reused"
    );
}

#[test]
fn offline_inputs_and_unproven_or_aliased_cache_entries_are_preserved() {
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
    ]);
    let files = fixture_pins(&pin);
    let downloads = download_directory(&candidate);
    state::private_directory(&downloads).unwrap();
    let client = client();
    for pin in &files[..2] {
        download::acquire_provider_archive(&client, &downloads, pin).unwrap();
    }
    server.join().unwrap();
    let archive = downloads.join("provider.tgz");
    let engine = downloads.join("engine.tgz");
    fs::write(downloads.join("guest.apk"), b"hello").unwrap();
    let inputs = OfflineInputs {
        archive: &archive,
        engine_archive: &engine,
        network_tools: &downloads,
        builder: None,
    };
    install(
        &candidate,
        Some(inputs),
        &files,
        fixture_prepare,
        fixture_verify,
    )
    .unwrap();
    install(
        &candidate,
        Some(inputs),
        &files,
        fixture_prepare,
        fixture_verify,
    )
    .unwrap();
    assert_eq!(fs::read(&archive).unwrap(), b"hello");
    assert_eq!(fs::read(&engine).unwrap(), b"hello");

    fs::rename(&archive, root.0.join("original")).unwrap();
    std::os::unix::fs::symlink(root.0.join("original"), &archive).unwrap();
    fs::rename(&engine, root.0.join("old-engine")).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&engine)
        .unwrap()
        .write_all(b"hello")
        .unwrap();
    assert!(download::remove_provider_archive(&downloads, &files[0]).is_err());
    assert!(download::remove_provider_archive(&downloads, &files[1]).is_err());
    install(&candidate, None, &files, fixture_prepare, fixture_verify).unwrap();
    assert!(archive.symlink_metadata().unwrap().is_symlink());
    assert_eq!(fs::read(&engine).unwrap(), b"hello");
}

#[test]
fn local_server_setup_transitions_the_shared_installation_gate() {
    let root = Fixture::new();
    let candidate = Candidate::discover_installed(&root.0).unwrap();
    assert_eq!(
        inspect_home(&root.0).unwrap().installation_state,
        InstallationState::NotSetUp
    );
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
    install(
        &candidate,
        None,
        &fixture_pins(&pin),
        |staged, inputs| {
            fixture_prepare(staged, inputs)?;
            super::inspection::tests::prepared_records(staged);
            Ok(())
        },
        fixture_verify,
    )
    .unwrap();
    server.join().unwrap();
    let inspection = inspect_home(&root.0).unwrap();
    assert_eq!(inspection.installation_state, InstallationState::Ready);
    assert!(inspect_home_quiescence(&root.0).unwrap().setup_only);
    // The fixture's prepared bytes deliberately are not production artifacts.
    // Readiness guides first use; startup still performs the full content check.
    assert!(artifact::verify(&candidate).is_err());
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
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
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
    let result = install(
        &candidate,
        Some(OfflineInputs {
            archive: &linked,
            engine_archive: &engine,
            network_tools: &source,
            builder: None,
        }),
        &files,
        fixture_prepare,
        fixture_verify,
    )
    .unwrap();
    assert_eq!(result.status, "installed");
    assert_eq!(result.files.len(), files.len());
    for file in result.files {
        assert_eq!(file.outcome, Outcome::Offline);
        assert_eq!(file.downloaded_bytes, 0);
        assert_eq!(file.reused_bytes, file.size_bytes);
    }
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
            archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
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
    assert!(!observe_existing(&candidate, &|_| panic!("absent install verified"), None).unwrap());
    assert!(!candidate.state_root.exists());
    let target = candidate.state_root.join("providers");
    state::private_directory(&target).unwrap();
    fs::write(target.join("complete"), b"verified").unwrap();
    assert_eq!(
        observe_existing(&candidate, &fixture_verify, None)
            .unwrap_err()
            .code,
        "setup_existing_invalid"
    );
    assert!(!candidate.state_root.join("run").exists());
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
    drop(_lock);
    assert!(observe_existing(&candidate, &fixture_verify, None).unwrap());
    assert!(!download_directory(&candidate).exists());
    fs::write(target.join("complete"), b"changed").unwrap();
    let error = observe_existing(&candidate, &fixture_verify, None).unwrap_err();
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

#[test]
fn json_accounts_for_download_resume_cache_and_complete_reuse() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let (pin, server) = server(vec![
        (
            "get /provider.tgz",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        ),
        (
            "range: bytes=2-",
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-4/5\r\nContent-Length: 3\r\n\r\nllo",
        ),
    ]);
    let files = fixture_pins(&pin);
    let downloads = download_directory(&candidate);
    state::private_directory(&downloads).unwrap();
    fs::write(downloads.join("engine.tgz.part"), b"he").unwrap();
    fs::write(downloads.join("guest.apk"), b"hello").unwrap();
    for name in ["engine.tgz.part", "guest.apk"] {
        fs::set_permissions(downloads.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    let result = install(&candidate, None, &files, fixture_prepare, fixture_verify)
        .unwrap()
        .with_probe(serde_json::json!({"supported": true}));
    server.join().unwrap();
    assert_eq!(result["status"], "installed");
    // Installing the provider set alone never prepares or claims the image builder.
    assert_eq!(result["builder"], "not_prepared");
    assert_eq!(result["probe"]["supported"], true);
    assert_eq!(
        result["files"],
        serde_json::json!([
            {"name":"provider.tgz", "outcome":"downloaded", "size_bytes":5, "downloaded_bytes":5, "reused_bytes":0},
            {"name":"engine.tgz", "outcome":"resumed", "size_bytes":5, "downloaded_bytes":3, "reused_bytes":2},
            {"name":"guest.apk", "outcome":"reused", "size_bytes":5, "downloaded_bytes":0, "reused_bytes":5}
        ])
    );
    let reused = install(
        &candidate,
        None,
        &files,
        |_, _| panic!("prepared reuse"),
        fixture_verify,
    )
    .unwrap()
    .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(reused["status"], "reused");
    assert_eq!(reused["files"], serde_json::json!([]));
}

#[test]
fn no_range_support_restarts_with_accurate_byte_counts() {
    let root = Fixture::new();
    let (pin, server) = server(vec![(
        "range: bytes=2-",
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nAccept-Ranges: none\r\n\r\nhello",
    )]);
    fs::write(root.0.join("archive.tgz.part"), b"he").unwrap();
    fs::set_permissions(
        root.0.join("archive.tgz.part"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let result = download::acquire(&client(), &root.0, &pin).unwrap();
    server.join().unwrap();
    assert_eq!(result.outcome, Outcome::Downloaded);
    assert_eq!(result.downloaded_bytes, 5);
    assert_eq!(result.reused_bytes, 0);
    assert_eq!(fs::read(root.0.join("archive.tgz")).unwrap(), b"hello");
}

// These checkpoints exist only in test builds. The helper is an owned subprocess,
// so the parent can kill it at an actual crash boundary without unwinding cleanup.
pub(super) fn publication_checkpoint(phase: &str) {
    if std::env::var("SETUP_TEST_PHASE").as_deref() != Ok(phase) {
        return;
    }
    let root = PathBuf::from(std::env::var_os("SETUP_TEST_ROOT").unwrap());
    fs::write(root.join("checkpoint"), phase).unwrap();
    // Self-expire if the parent fails; the parent always owns and reaps this child.
    thread::sleep(std::time::Duration::from_secs(10));
    std::process::exit(74);
}

#[test]
#[ignore = "owned subprocess entrypoint for setup interruption tests"]
fn setup_interruption_helper() {
    let root = PathBuf::from(std::env::var_os("SETUP_TEST_ROOT").unwrap());
    let candidate = Candidate::discover(&root).unwrap();
    let pin = FilePin {
        url: std::env::var("SETUP_TEST_URL").unwrap(),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
        size_bytes: 5,
        max_bytes: 16,
        redirect_hosts: vec![],
    };
    install(
        &candidate,
        None,
        &fixture_pins(&pin),
        |staged, inputs| {
            let providers = staged.state_root.join("providers");
            state::private_directory(&providers)?;
            fs::write(providers.join("incomplete"), b"incomplete").unwrap();
            publication_checkpoint("preparation");
            fs::remove_file(providers.join("incomplete")).unwrap();
            fixture_prepare(staged, inputs)
        },
        fixture_verify,
    )
    .unwrap();
}

#[test]
fn killed_preparation_and_publication_rerun_without_network_or_partial_install() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for phase in [
        "preparation",
        "before_rename",
        "after_rename",
        "between_unlinks",
    ] {
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
        let mut child = Child(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider::setup::tests::setup_interruption_helper",
                    "--ignored",
                ])
                .env("SETUP_TEST_ROOT", &root.0)
                .env("SETUP_TEST_PHASE", phase)
                .env("SETUP_TEST_URL", &pin.url)
                .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
                .env("HACK_NO_INTERACTIVE", "1")
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        while !root.0.join("checkpoint").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "helper exited before {phase}"
            );
            assert!(Instant::now() < deadline, "helper missed {phase}");
            thread::sleep(Duration::from_millis(5));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        server.join().unwrap(); // dead server proves recovery uses the verified cache
        let target = candidate.state_root.join("providers");
        let published = matches!(phase, "after_rename" | "between_unlinks");
        assert_eq!(target.exists(), published);
        let downloads = download_directory(&candidate);
        assert_eq!(
            downloads.join("provider.tgz").exists(),
            phase != "between_unlinks"
        );
        assert!(downloads.join("engine.tgz").is_file());
        let pins = fixture_pins(&pin);
        if phase == "between_unlinks" {
            assert!(observe_existing(&candidate, &fixture_verify, Some(&pins)).unwrap());
            assert!(!downloads.join("engine.tgz").exists());
        }
        let result = install(&candidate, None, &pins, fixture_prepare, fixture_verify).unwrap();
        assert_eq!(
            result.status,
            if published { "reused" } else { "installed" }
        );
        assert_eq!(result.files.len(), if published { 0 } else { 3 });
        assert!(
            result
                .files
                .iter()
                .all(|f| f.outcome == Outcome::Reused && f.downloaded_bytes == 0)
        );
        fixture_verify(&candidate).unwrap();
        assert!(!target.join("incomplete").exists());
        assert!(!downloads.join("provider.tgz").exists());
        assert!(!downloads.join("engine.tgz").exists());
    }
}

#[test]
fn retry_stalled_headers_then_verify_download() {
    retry_preheader_failure(false);
}

#[test]
fn retry_closed_connection_then_verify_download() {
    retry_preheader_failure(true);
}

fn retry_preheader_failure(close: bool) {
    use std::time::{Duration, Instant};
    let root = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let pin = FilePin {
        url: format!("http://{}/archive.tgz", listener.local_addr().unwrap()),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
        size_bytes: 5,
        max_bytes: 16,
        redirect_hosts: vec![],
    };
    let handle = thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        request(&mut first);
        // A stalled request stays open past the client's timeout without
        // delaying acceptance of the retry.
        let _stalled = (!close).then_some(first);
        let (mut second, _) = listener.accept().unwrap();
        request(&mut second);
        second
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
            .unwrap();
    });
    let client = download::with_header_timeout(
        download::test_client(Duration::from_secs(2), Duration::from_secs(3), None),
        Duration::from_millis(100),
    );
    let start = Instant::now();
    download::acquire(&client, &root.0, &pin).unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(fs::read(root.0.join("archive.tgz")).unwrap(), b"hello");
    handle.join().unwrap();
}

#[test]
fn retry_permanent_connection_failure_is_bounded_and_names_host_and_attempts() {
    use std::time::{Duration, Instant};
    let root = Fixture::new();
    let (_reservation, address) = crate::provider::test_socket::bound_unlistened_tcp();
    let pin = FilePin {
        url: format!("http://{address}/archive.tgz"),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
        size_bytes: 5,
        max_bytes: 16,
        redirect_hosts: vec![],
    };
    let start = Instant::now();
    let failure = download::acquire(&client(), &root.0, &pin).unwrap_err();
    assert!(failure.message.contains("127.0.0.1"));
    assert!(failure.message.contains("3 attempt(s)"));
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(!root.0.join("archive.tgz").exists());
}

#[test]
fn retry_header_stall_never_renews_the_file_deadline() {
    use std::time::{Duration, Instant};
    let root = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let pin = FilePin {
        url: format!("http://{}/archive.tgz", listener.local_addr().unwrap()),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
        size_bytes: 5,
        max_bytes: 16,
        redirect_hosts: vec![],
    };
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request(&mut stream);
        thread::sleep(Duration::from_millis(200));
    });
    let client = download::test_client(Duration::from_secs(2), Duration::from_millis(100), None);
    let start = Instant::now();
    let failure = download::acquire(&client, &root.0, &pin).unwrap_err();
    assert_eq!(failure.code, "setup_download_deadline");
    assert!(failure.message.contains("1 attempt(s)"));
    assert!(start.elapsed() < Duration::from_secs(1));
    handle.join().unwrap();
}

struct ObservedServer {
    pin: FilePin,
    requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ObservedServer {
    /// Empty replies close before headers; a valid fallback exposes unwanted replays.
    fn start(replies: Vec<&'static str>) -> Self {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let pin = FilePin {
            url: format!("http://{}/archive.tgz", listener.local_addr().unwrap()),
            archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
            size_bytes: 5,
            max_bytes: 16,
            redirect_hosts: vec![],
        };
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (counted, stopped) = (requests.clone(), stop.clone());
        let handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !stopped.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("observed server accept: {e}"),
                };
                assert!(request(&mut stream).starts_with("GET /archive.tgz "));
                let index = counted.fetch_add(1, Ordering::SeqCst);
                let reply = replies.get(index).copied().unwrap_or(
                    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Self {
            pin,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn count(&self) -> usize {
        self.requests.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for ObservedServer {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

#[test]
fn retry_cannot_turn_a_checksum_or_length_failure_into_success() {
    for (reply, code) in [
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nwrong",
            "setup_hash_mismatch",
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nhell",
            "setup_size_mismatch",
        ),
    ] {
        let root = Fixture::new();
        let server = ObservedServer::start(vec!["", reply]);
        let failure = download::acquire(&client(), &root.0, &server.pin).unwrap_err();
        assert_eq!(failure.code, code);
        assert_eq!(server.count(), 2);
        assert!(!root.0.join("archive.tgz").exists());
        assert_eq!(
            fs::metadata(root.0.join("archive.tgz.part")).unwrap().len(),
            0
        );
    }
}

#[test]
fn retry_never_replays_an_interrupted_body_and_preserves_its_partial() {
    let root = Fixture::new();
    let server = ObservedServer::start(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhe",
    ]);
    let failure = download::acquire(&client(), &root.0, &server.pin).unwrap_err();
    assert_eq!(failure.code, "setup_download");
    assert_eq!(server.count(), 1);
    assert!(!root.0.join("archive.tgz").exists());
    assert_eq!(fs::read(root.0.join("archive.tgz.part")).unwrap(), b"he");
}

#[test]
fn retry_never_replays_a_setup_http_refusal() {
    for (reply, code) in [
        (
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "setup_pin_unavailable",
        ),
        (
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "setup_download",
        ),
        (
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "setup_download",
        ),
    ] {
        let root = Fixture::new();
        let server = ObservedServer::start(vec![reply]);
        let failure = download::acquire(&client(), &root.0, &server.pin).unwrap_err();
        assert_eq!(failure.code, code);
        assert_eq!(server.count(), 1);
        assert!(!root.0.join("archive.tgz").exists());
    }
}

const BUILDER_BYTES: &[u8] = b"hello";
const SERVED: &str = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";

/// The image builder's download pin beside `fixture_pins`.
fn builder_file_pin(pin: &FilePin) -> FilePin {
    FilePin {
        url: pin.url.replace("archive.tgz", "builder.bin"),
        ..pin.clone()
    }
}

/// `ensure_builder` with the real preparation and the real build-time verification,
/// against a test pin for the served bytes instead of the signed release.
fn ensure(
    candidate: &Candidate,
    source: BuilderSource<'_>,
    pin: &FilePin,
) -> Result<(Builder, Option<FileResult>), CandidateError> {
    let binary = artifact::test_binary_pin(BUILDER_BYTES);
    ensure_builder(
        candidate,
        source,
        pin,
        |candidate, file| artifact::prepare_binary(candidate, file, &binary).map(drop),
        |candidate| artifact::verify_binary(candidate, &binary).map(drop),
        || Ok(client()),
    )
}

/// The check a native image build runs before it executes the builder.
fn build_time_verify(candidate: &Candidate) -> Result<(), CandidateError> {
    artifact::verify_binary(candidate, &artifact::test_binary_pin(BUILDER_BYTES)).map(drop)
}

type Entry = (String, Vec<u8>, u32, u64, i64, i64);

/// Every entry below `root` by relative path: kind, bytes (or link target), mode, inode
/// and modification time. Equal entries were neither rewritten nor replaced.
fn snapshot(root: &Path) -> std::collections::BTreeMap<String, Entry> {
    use std::os::unix::fs::MetadataExt;
    fn visit(base: &Path, path: &Path, entries: &mut std::collections::BTreeMap<String, Entry>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let (kind, bytes) = if metadata.is_dir() {
                ("directory", Vec::new())
            } else if metadata.is_file() {
                ("file", fs::read(&path).unwrap())
            } else {
                (
                    "symlink",
                    fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec(),
                )
            };
            entries.insert(
                path.strip_prefix(base)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned(),
                (
                    kind.to_owned(),
                    bytes,
                    metadata.mode(),
                    metadata.ino(),
                    metadata.mtime(),
                    metadata.mtime_nsec(),
                ),
            );
            if metadata.is_dir() {
                visit(base, &path, entries);
            }
        }
    }
    let mut entries = std::collections::BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

#[test]
fn setup_with_downloads_installs_the_builder_and_a_build_time_verify_passes() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let (pin, server) = server(vec![
        ("get /provider.tgz", SERVED),
        ("get /engine.tgz", SERVED),
        ("get /guest.apk", SERVED),
        ("get /builder.bin", SERVED),
    ]);
    let builder = builder_file_pin(&pin);
    assert_eq!(
        build_time_verify(&candidate).unwrap_err().code,
        "builder_not_prepared"
    );
    // The same order as `run`: the provider set is published, then the builder is added.
    let result = install(
        &candidate,
        None,
        &fixture_pins(&pin),
        fixture_prepare,
        fixture_verify,
    )
    .unwrap()
    .with_builder(ensure(&candidate, BuilderSource::Download, &builder).unwrap())
    .with_probe(serde_json::json!({"supported": true}));
    server.join().unwrap();
    assert_eq!(result["status"], "installed");
    assert_eq!(result["builder"], "installed");
    let downloaded = |name: &str| {
        serde_json::json!({"name": name, "outcome": "downloaded", "size_bytes": 5,
            "downloaded_bytes": 5, "reused_bytes": 0})
    };
    assert_eq!(
        result["files"],
        serde_json::json!([
            downloaded("provider.tgz"),
            downloaded("engine.tgz"),
            downloaded("guest.apk"),
            downloaded("builder.bin")
        ])
    );
    build_time_verify(&candidate).unwrap();
    fixture_verify(&candidate).unwrap();
    let executable = candidate
        .state_root
        .join("providers/test-client-1.2.3/test-client");
    assert_eq!(fs::read(&executable).unwrap(), BUILDER_BYTES);
    assert_eq!(
        fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
        0o700
    );

    // A second setup finds the builder prepared: the server is gone, so a request would
    // fail, and a second preparation would panic.
    let again = ensure_builder(
        &candidate,
        BuilderSource::Download,
        &builder,
        |_, _| panic!("a prepared builder was prepared again"),
        build_time_verify,
        || panic!("a prepared builder was downloaded again"),
    )
    .unwrap();
    assert_eq!(again.0, Builder::Reused);
    assert!(again.1.is_none());
    let reused = Installation::reused()
        .with_builder(again)
        .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(reused["status"], "reused");
    assert_eq!(reused["builder"], "reused");
    assert_eq!(reused["files"], serde_json::json!([]));
}

#[test]
fn a_changed_builder_is_reported_and_left_alone_and_replacing_it_by_hand_works() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let (pin, server) = server(vec![
        ("get /provider.tgz", SERVED),
        ("get /engine.tgz", SERVED),
        ("get /guest.apk", SERVED),
        ("get /builder.bin", SERVED),
    ]);
    let builder = builder_file_pin(&pin);
    install(
        &candidate,
        None,
        &fixture_pins(&pin),
        fixture_prepare,
        fixture_verify,
    )
    .unwrap();
    ensure(&candidate, BuilderSource::Download, &builder).unwrap();
    server.join().unwrap(); // gone: any later request would fail
    let providers = candidate.state_root.join("providers");
    let tree = providers.join("test-client-1.2.3");
    let executable = tree.join("test-client");
    let record = providers.join("test-client.json");
    let offline_file = root.0.join("builder-file");
    fs::write(&offline_file, BUILDER_BYTES).unwrap();

    // Setup reports a builder that does not verify and changes nothing: with no source,
    // with download consent and with the offline file alike. It does not fail the home.
    let untouched = |source: BuilderSource<'_>| {
        let before = snapshot(&providers);
        let outcome = ensure_builder(
            &candidate,
            source,
            &builder,
            |_, _| panic!("a changed builder was prepared over"),
            build_time_verify,
            || panic!("a changed builder was downloaded again"),
        )
        .unwrap();
        assert_eq!(outcome.0, Builder::Changed);
        assert!(outcome.1.is_none());
        assert_eq!(snapshot(&providers), before);
        let reported = Installation::reused()
            .with_builder(outcome)
            .with_probe(serde_json::json!({"supported": true}));
        assert_eq!(reported["status"], "reused");
        assert_eq!(reported["builder"], "changed");
        assert_eq!(reported["files"], serde_json::json!([]));
        // The build keeps its own refusal.
        assert_eq!(
            build_time_verify(&candidate).unwrap_err().code,
            "artifact_digest_mismatch"
        );
    };
    let every_source = |state: &str| {
        for source in [
            BuilderSource::Absent,
            BuilderSource::Download,
            BuilderSource::File(&offline_file),
        ] {
            untouched(source);
        }
        fixture_verify(&candidate).expect(state);
    };
    // Other bytes under an intact record.
    fs::write(&executable, b"other").unwrap();
    every_source("changed bytes");
    // The record removed while the changed directory stays: still changed, not absent,
    // so setup is never told to prepare over it.
    fs::remove_file(&record).unwrap();
    every_source("changed bytes without a record");

    // The remedy setup prints: remove the directory and the record by hand, then run
    // setup with consent. The verified download is still cached, so nothing is requested.
    fs::remove_file(&executable).unwrap();
    fs::remove_dir(&tree).unwrap();
    assert_eq!(
        build_time_verify(&candidate).unwrap_err().code,
        "builder_not_prepared"
    );
    let replaced = ensure(&candidate, BuilderSource::Download, &builder).unwrap();
    assert_eq!(replaced.0, Builder::Installed);
    assert_eq!(replaced.1.as_ref().unwrap().outcome, Outcome::Reused);
    build_time_verify(&candidate).unwrap();
    assert_eq!(fs::read(&executable).unwrap(), BUILDER_BYTES);

    // The same remedy with only the directory removed (a stale record stays), and with
    // an interrupted record write left behind: setup with consent still completes.
    fs::write(&executable, b"other").unwrap();
    assert_eq!(
        ensure(&candidate, BuilderSource::Absent, &builder)
            .unwrap()
            .0,
        Builder::Changed
    );
    fs::remove_file(&executable).unwrap();
    fs::remove_dir(&tree).unwrap();
    let pending = record.with_extension("pending");
    fs::write(&pending, b"partial").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        ensure(&candidate, BuilderSource::Download, &builder)
            .unwrap()
            .0,
        Builder::Installed
    );
    assert!(!pending.exists());
    build_time_verify(&candidate).unwrap();
    fixture_verify(&candidate).unwrap();
}

#[test]
fn a_complete_home_gains_only_the_builder_and_only_with_consent() {
    use std::os::unix::fs::MetadataExt;
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    // A complete home from an older build: a prepared provider tree with nested
    // directories, its record and its retained archive, and no image builder.
    let tree = artifact::tree_fixture::prepare(&candidate, &root.0);
    let verify = |candidate: &Candidate| artifact::verify_tree(candidate, &tree).map(drop);
    drop(state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
    assert!(observe_existing(&candidate, &verify, None).unwrap());
    let providers = candidate.state_root.join("providers");
    let before = snapshot(&providers);
    let record = fs::read(providers.join(tree.record_name())).unwrap();
    let identity = fs::metadata(&providers).unwrap().ino();
    assert!(before.len() > 12, "the fixture tree is not trivial");
    let builder = FilePin {
        url: "http://127.0.0.1:9/builder.bin".into(),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(BUILDER_BYTES))),
        max_bytes: 16,
        size_bytes: 5,
        redirect_hosts: vec![],
    };

    // Without consent or an offline file nothing is requested and nothing is written:
    // setup still succeeds and reports the builder as not prepared.
    let observed = ensure_builder(
        &candidate,
        BuilderSource::Absent,
        &builder,
        |_, _| panic!("the builder was prepared without a source"),
        build_time_verify,
        || panic!("a network client was built without consent"),
    )
    .unwrap();
    assert_eq!(observed.0, Builder::NotPrepared);
    assert!(observed.1.is_none());
    let reported = Installation::reused()
        .with_builder(observed)
        .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(reported["status"], "reused");
    assert_eq!(reported["builder"], "not_prepared");
    assert_eq!(reported["files"], serde_json::json!([]));
    assert_eq!(snapshot(&providers), before);
    assert!(!candidate.state_root.join("setup").exists());
    assert!(!download_directory(&candidate).exists());

    // With consent only the builder is requested, and only the builder is added.
    let (pin, server) = server(vec![("get /builder.bin", SERVED)]);
    let builder = builder_file_pin(&pin);
    let added = ensure(&candidate, BuilderSource::Download, &builder).unwrap();
    server.join().unwrap(); // one scripted reply: any other request would have failed
    assert_eq!(added.0, Builder::Installed);
    let file = added.1.as_ref().unwrap();
    assert_eq!(file.name, "builder.bin");
    assert_eq!(file.outcome, Outcome::Downloaded);
    assert_eq!(file.downloaded_bytes, 5);
    let reported = Installation::reused()
        .with_builder(added)
        .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(reported["status"], "reused");
    assert_eq!(reported["builder"], "installed");
    assert_eq!(reported["files"].as_array().unwrap().len(), 1);

    // The provider tree, its record and its retained archive are the same files with the
    // same bytes, modes and times: nothing was re-prepared or published again.
    let after = snapshot(&providers);
    for (path, entry) in &before {
        assert_eq!(after.get(path), Some(entry), "{path} changed");
    }
    assert_eq!(
        fs::read(providers.join(tree.record_name())).unwrap(),
        record
    );
    assert_eq!(fs::metadata(&providers).unwrap().ino(), identity);
    let added: Vec<&str> = after
        .keys()
        .filter(|path| !before.contains_key(*path))
        .map(String::as_str)
        .collect();
    assert_eq!(
        added,
        [
            "test-client-1.2.3",
            "test-client-1.2.3/test-client",
            "test-client.json"
        ]
    );
    verify(&candidate).unwrap();
    assert!(observe_existing(&candidate, &verify, None).unwrap());
    build_time_verify(&candidate).unwrap();
    assert_eq!(
        fs::read(download_directory(&candidate).join("builder.bin")).unwrap(),
        BUILDER_BYTES
    );
}

#[test]
fn offline_setup_prepares_the_builder_only_from_its_own_input() {
    let root = Fixture::new();
    let candidate = Candidate::discover(&root.0).unwrap();
    let source = root.0.join("inputs");
    state::private_directory(&source).unwrap();
    for name in ["provider.tgz", "engine.tgz", "guest.apk", "builder-file"] {
        fs::write(source.join(name), b"hello").unwrap();
    }
    fs::write(source.join("other-file"), b"wrong").unwrap();
    let pin = FilePin {
        url: "https://unused.example/archive.tgz".into(),
        archive_sha256: format!("{:x}", crate::Hex(Sha256::digest(b"hello"))),
        max_bytes: 16,
        size_bytes: 5,
        redirect_hosts: vec![],
    };
    let builder = builder_file_pin(&pin);
    let offline = |source: BuilderSource<'_>| {
        let binary = artifact::test_binary_pin(BUILDER_BYTES);
        ensure_builder(
            &candidate,
            source,
            &builder,
            |candidate, file| artifact::prepare_binary(candidate, file, &binary).map(drop),
            build_time_verify,
            || panic!("offline setup built a network client"),
        )
    };

    // Without the builder input offline setup works as before: three offline files, a
    // published provider set, no builder and no download directory.
    let provider = source.join("provider.tgz");
    let engine = source.join("engine.tgz");
    let without = OfflineInputs {
        archive: &provider,
        engine_archive: &engine,
        network_tools: &source,
        builder: None,
    };
    let result = install(
        &candidate,
        Some(without),
        &fixture_pins(&pin),
        fixture_prepare,
        fixture_verify,
    )
    .unwrap()
    .with_builder(offline(BuilderSource::select(Some(without), false)).unwrap())
    .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(result["status"], "installed");
    assert_eq!(result["builder"], "not_prepared");
    assert_eq!(result["files"].as_array().unwrap().len(), 3);
    assert_eq!(
        build_time_verify(&candidate).unwrap_err().code,
        "builder_not_prepared"
    );

    // A file that is not the pinned builder is refused before anything is prepared.
    let other = source.join("other-file");
    let wrong = OfflineInputs {
        builder: Some(&other),
        ..without
    };
    assert_eq!(
        offline(BuilderSource::select(Some(wrong), false))
            .unwrap_err()
            .code,
        "setup_hash_mismatch"
    );
    assert_eq!(
        build_time_verify(&candidate).unwrap_err().code,
        "builder_not_prepared"
    );

    // With the pinned file, the same home gains the builder; its provider set is reused.
    let file = source.join("builder-file");
    let with = OfflineInputs {
        builder: Some(&file),
        ..without
    };
    let result = install(
        &candidate,
        Some(with),
        &fixture_pins(&pin),
        |_, _| panic!("a published provider set was prepared again"),
        fixture_verify,
    )
    .unwrap()
    .with_builder(offline(BuilderSource::select(Some(with), false)).unwrap())
    .with_probe(serde_json::json!({"supported": true}));
    assert_eq!(result["status"], "reused");
    assert_eq!(result["builder"], "installed");
    assert_eq!(
        result["files"],
        serde_json::json!([{"name": "builder.bin", "outcome": "offline", "size_bytes": 5,
            "downloaded_bytes": 0, "reused_bytes": 5}])
    );
    build_time_verify(&candidate).unwrap();
    // The caller's file is copied, never moved, and offline setup never downloads.
    assert_eq!(fs::read(&file).unwrap(), BUILDER_BYTES);
    assert!(!download_directory(&candidate).exists());
}
