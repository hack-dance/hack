//! Bounded HTTPS transfers with explicit redirect admission and digest-only cache trust.
use super::{FilePin, FileResult, Outcome};
use crate::{CandidateError, provider::state};
use reqwest::{Response, Url, header};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::Duration,
};

const READ_TIMEOUT: Duration = Duration::from_secs(60);
const FILE_TIMEOUT: Duration = Duration::from_secs(1800);

pub(super) struct Client {
    http: reqwest::Client,
    runtime: tokio::runtime::Runtime,
    file_timeout: Duration,
}

fn build_client(
    https_only: bool,
    read_timeout: Duration,
    file_timeout: Duration,
    resolve: Option<(&str, std::net::SocketAddr)>,
) -> Result<Client, CandidateError> {
    let mut builder = reqwest::Client::builder()
        .https_only(https_only)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(read_timeout);
    if let Some((host, address)) = resolve {
        builder = builder.resolve(host, address);
    }
    let http = builder
        .build()
        .map_err(|_| CandidateError::new("setup_download", "Cannot construct HTTPS client."))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CandidateError::new("setup_download", "Cannot construct transfer runtime."))?;
    Ok(Client {
        http,
        runtime,
        file_timeout,
    })
}

#[cfg(test)]
pub(super) fn test_client(
    read_timeout: Duration,
    file_timeout: Duration,
    resolve: Option<(&str, std::net::SocketAddr)>,
) -> Client {
    build_client(false, read_timeout, file_timeout, resolve).unwrap()
}

fn error(pin: &FilePin, code: &'static str, reason: impl std::fmt::Display) -> CandidateError {
    CandidateError::new(
        code,
        format!("{}: {reason}", pin.name().unwrap_or("invalid pin")),
    )
}

pub(super) fn validate_pin(pin: &FilePin) -> Result<(), CandidateError> {
    pin.name()?;
    if pin.max_bytes == 0
        || pin.max_bytes > 128 * 1024 * 1024
        || pin.size_bytes == 0
        || pin.size_bytes > pin.max_bytes
        || pin.archive_sha256.len() != 64
        || !pin
            .archive_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(error(
            pin,
            "setup_pin_invalid",
            "invalid size bound or SHA-256",
        ));
    }
    let url = Url::parse(&pin.url).map_err(|_| error(pin, "setup_pin_invalid", "invalid URL"))?;
    check_url(pin, &url)
}

pub(super) fn client() -> Result<Client, CandidateError> {
    build_client(true, READ_TIMEOUT, FILE_TIMEOUT, None)
}

fn check_url(pin: &FilePin, url: &Url) -> Result<(), CandidateError> {
    let initial =
        Url::parse(&pin.url).map_err(|_| error(pin, "setup_pin_invalid", "invalid source URL"))?;
    // Test transport permits only the fake loopback server; release builds have no HTTP seam.
    let test_http = cfg!(test)
        && initial.scheme() == "http"
        && initial.host_str() == Some("127.0.0.1")
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "mirror.test"))
        && url.port() == initial.port();
    if !(test_http || url.scheme() == "https" && url.port_or_known_default() == Some(443))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !(url.host_str() == initial.host_str()
            || pin
                .redirect_hosts
                .iter()
                .any(|h| Some(h.as_str()) == url.host_str()))
    {
        return Err(error(
            pin,
            "setup_redirect_refused",
            "URL scheme, authority or redirect host is not pinned",
        ));
    }
    Ok(())
}

fn private_file(path: &Path, pin: &FilePin, writable: bool) -> Result<File, CandidateError> {
    crate::reject_aliased_state(
        path.parent()
            .ok_or_else(|| error(pin, "setup_file_unsafe", "archive has no parent"))?,
    )
    .map_err(|_| error(pin, "setup_file_unsafe", "aliased archive path"))?;
    let f = OpenOptions::new()
        .read(true)
        .write(writable)
        .create(writable)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| error(pin, "setup_file", e))?;
    let m = f.metadata().map_err(state::io)?;
    // SAFETY: geteuid has no preconditions.
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > pin.max_bytes
    {
        return Err(error(
            pin,
            "setup_file_unsafe",
            "expected an owned regular archive within its pinned byte bound",
        ));
    }
    Ok(f)
}

fn hash(file: &mut File, pin: &FilePin) -> Result<(), CandidateError> {
    file.seek(SeekFrom::Start(0)).map_err(state::io)?;
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| error(pin, "setup_file", e))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > pin.max_bytes {
            return Err(error(
                pin,
                "setup_size_exceeded",
                "archive exceeds pinned byte bound",
            ));
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != pin.archive_sha256 {
        return Err(error(pin, "setup_hash_mismatch", "pinned SHA-256 mismatch"));
    }
    if total != pin.size_bytes {
        return Err(error(
            pin,
            "setup_size_mismatch",
            "archive length differs from the pinned exact byte length",
        ));
    }
    Ok(())
}

pub(super) fn verify_file(path: &Path, pin: &FilePin) -> Result<(), CandidateError> {
    hash(&mut private_file(path, pin, false)?, pin)
}

/// Offline archives have the manual prepare contract: input paths may be symlinks
/// or hardlinks. No bytes are trusted until their bounded digest matches; preparation
/// rehashes its owned copy before extraction. Guest packages retain their manual
/// private-file policy in `network_tools::prepare`.
pub(super) fn verify_input(path: &Path, pin: &FilePin) -> Result<(), CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| error(pin, "setup_file", e))?;
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file() || metadata.len() > pin.max_bytes {
        return Err(error(
            pin,
            "setup_file_unsafe",
            "offline input must be a regular archive within its pinned bound",
        ));
    }
    hash(&mut file, pin)
}

fn deadline_error(pin: &FilePin) -> CandidateError {
    error(
        pin,
        "setup_download_deadline",
        "overall file deadline exceeded; partial retained for rerun",
    )
}

async fn response(
    client: &Client,
    pin: &FilePin,
    offset: u64,
    deadline: tokio::time::Instant,
) -> Result<Response, CandidateError> {
    let mut url =
        Url::parse(&pin.url).map_err(|_| error(pin, "setup_pin_invalid", "invalid URL"))?;
    for redirects in 0..=5 {
        check_url(pin, &url)?;
        let mut request = client
            .http
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let response = tokio::time::timeout_at(deadline, request.send())
            .await
            .map_err(|_| deadline_error(pin))?
            .map_err(|e| error(pin, "setup_download", e.without_url()))?;
        if matches!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
        ) {
            return Err(error(
                pin,
                "setup_pin_unavailable",
                "upstream no longer serves this pinned file; update Hack or use the offline form",
            ));
        }
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err(error(pin, "setup_redirect_refused", "too many redirects"));
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| error(pin, "setup_redirect_refused", "missing redirect location"))?;
            url = url
                .join(location)
                .map_err(|_| error(pin, "setup_redirect_refused", "invalid redirect location"))?;
            continue;
        }
        return Ok(response);
    }
    unreachable!("bounded redirect loop returns")
}

fn range_length(response: &Response, offset: u64, pin: &FilePin) -> Result<u64, CandidateError> {
    let invalid = || error(pin, "setup_range_invalid", "invalid partial response range");
    let value = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(invalid)?;
    let (span, total) = value
        .strip_prefix("bytes ")
        .and_then(|v| v.split_once('/'))
        .ok_or_else(invalid)?;
    let (start, end) = span.split_once('-').ok_or_else(invalid)?;
    let start = start.parse::<u64>().map_err(|_| invalid())?;
    let end = end.parse::<u64>().map_err(|_| invalid())?;
    let total = total.parse::<u64>().map_err(|_| invalid())?;
    if start != offset
        || end < start
        || total != pin.size_bytes
        || end.checked_add(1) != Some(total)
    {
        return Err(invalid());
    }
    Ok(total - start)
}

/// One request attempt (at most five admitted redirects), never an unbounded retry.
/// A valid partial prefix is only a resume hint; the complete bytes are always rehashed.
pub(super) fn acquire(
    client: &Client,
    directory: &Path,
    pin: &FilePin,
) -> Result<FileResult, CandidateError> {
    client
        .runtime
        .block_on(acquire_inner(client, directory, pin))
}

async fn acquire_inner(
    client: &Client,
    directory: &Path,
    pin: &FilePin,
) -> Result<FileResult, CandidateError> {
    // One absolute deadline spans all redirect headers and body reads; successful
    // progress never renews it. Reqwest separately bounds each read to 60 seconds.
    let deadline = tokio::time::Instant::now() + client.file_timeout;
    state::check_private_directory(directory)?;
    let destination = directory.join(pin.name()?);
    match destination.symlink_metadata() {
        Ok(_) => {
            verify_file(&destination, pin).map_err(|e| error(pin, "setup_cache_invalid", format!("{}; cached file under .hack-local/setup/downloads was preserved. Move it aside and rerun setup, or use offline inputs", e.code)))?;
            return FileResult::new(pin, Outcome::Reused, 0);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(error(pin, "setup_file", e)),
    }
    let partial = directory.join(format!("{}.part", pin.name()?));
    let mut file = private_file(&partial, pin, true)?;
    let offset = file.metadata().map_err(state::io)?.len();
    if offset > 0 && hash(&mut file, pin).is_ok() {
        commit(file, &partial, &destination, directory, pin)?;
        return FileResult::new(pin, Outcome::Reused, 0);
    }
    // A full-size invalid partial cannot be extended safely. Restart in this invocation.
    let offset = if offset >= pin.size_bytes {
        file.set_len(0).map_err(state::io)?;
        0
    } else {
        offset
    };
    let mut response = response(client, pin, offset, deadline).await?;
    let expected = match response.status() {
        reqwest::StatusCode::OK => {
            file.set_len(0).map_err(state::io)?;
            file.seek(SeekFrom::Start(0)).map_err(state::io)?;
            response.content_length()
        }
        reqwest::StatusCode::PARTIAL_CONTENT if offset > 0 => {
            file.seek(SeekFrom::End(0)).map_err(state::io)?;
            Some(range_length(&response, offset, pin)?)
        }
        // The server cannot resume this prefix; discard it and report. Next invocation restarts.
        reqwest::StatusCode::RANGE_NOT_SATISFIABLE => {
            file.set_len(0).map_err(state::io)?;
            return Err(error(
                pin,
                "setup_range_invalid",
                "server refused resume; partial reset, rerun setup",
            ));
        }
        status => return Err(error(pin, "setup_download", format!("HTTP {status}"))),
    };
    let start = file.stream_position().map_err(state::io)?;
    if expected.is_some_and(|n| n > pin.max_bytes - start) {
        file.set_len(0).map_err(state::io)?;
        return Err(error(
            pin,
            "setup_size_exceeded",
            "response exceeds pinned byte bound",
        ));
    }
    if expected.is_some_and(|n| n != pin.size_bytes - start) {
        file.set_len(0).map_err(state::io)?;
        return Err(error(
            pin,
            "setup_size_mismatch",
            "declared length differs from the pinned exact byte length",
        ));
    }
    let mut count = 0;
    loop {
        let chunk = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| deadline_error(pin))?
            .map_err(|_| {
                error(
                    pin,
                    "setup_download",
                    "body read interrupted or timed out; partial retained for rerun",
                )
            })?;
        let Some(chunk) = chunk else {
            break;
        };
        let n = chunk.len();
        count += n as u64;
        if count > pin.max_bytes - start || expected.is_some_and(|length| count > length) {
            file.set_len(0).map_err(state::io)?;
            return Err(error(
                pin,
                "setup_size_exceeded",
                "body exceeds pinned byte bound or declared length",
            ));
        }
        if count > pin.size_bytes - start {
            file.set_len(0).map_err(state::io)?;
            return Err(error(
                pin,
                "setup_size_mismatch",
                "body exceeds pinned exact byte length",
            ));
        }
        file.write_all(&chunk)
            .map_err(|e| error(pin, "setup_file", e))?;
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(deadline_error(pin));
    }
    file.sync_all().map_err(state::io)?;
    if start + count < pin.size_bytes {
        return Err(error(
            pin,
            "setup_truncated",
            "body ended before the pinned exact length; partial retained for rerun",
        ));
    }
    if expected.is_some_and(|length| count != length) {
        return Err(error(
            pin,
            "setup_truncated",
            "truncated body; partial retained for rerun",
        ));
    }
    if let Err(e) = hash(&mut file, pin) {
        file.set_len(0).map_err(state::io)?;
        return Err(e);
    }
    commit(file, &partial, &destination, directory, pin)?;
    FileResult::new(
        pin,
        if start > 0 {
            Outcome::Resumed
        } else {
            Outcome::Downloaded
        },
        count,
    )
}

fn commit(
    file: File,
    partial: &Path,
    destination: &Path,
    directory: &Path,
    pin: &FilePin,
) -> Result<(), CandidateError> {
    file.sync_all().map_err(state::io)?;
    // Caller owns the setup operation lock; no other setup can replace either pathname.
    fs::rename(partial, destination).map_err(|e| error(pin, "setup_file", e))?;
    File::open(directory)
        .and_then(|d| d.sync_all())
        .map_err(state::io)
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    #[test]
    fn https_downgrades_credentials_and_unlisted_hosts_refuse() {
        let pin = FilePin {
            url: "https://example.test/archive.tgz".into(),
            archive_sha256: "0".repeat(64),
            size_bytes: 5,
            max_bytes: 16,
            redirect_hosts: vec!["mirror.test".into()],
        };
        for url in [
            "http://example.test/archive.tgz",
            "https://other.test/archive.tgz",
            "https://user@example.test/archive.tgz",
            "https://example.test:444/archive.tgz",
        ] {
            assert_eq!(
                check_url(&pin, &Url::parse(url).unwrap()).unwrap_err().code,
                "setup_redirect_refused"
            );
        }
        check_url(
            &pin,
            &Url::parse("https://mirror.test/archive.tgz").unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn production_client_refuses_http_without_reaching_the_fake_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = client().unwrap();
        let result = client.runtime.block_on(
            client
                .http
                .get(format!(
                    "http://{}/archive.tgz",
                    listener.local_addr().unwrap()
                ))
                .send(),
        );
        assert!(result.is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
