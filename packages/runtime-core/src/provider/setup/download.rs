//! Bounded HTTPS transfers with explicit redirect admission and digest-only cache trust.
use super::FilePin;
use crate::{CandidateError, provider::state};
use reqwest::{
    Url,
    blocking::{Client, Response},
    header,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::Duration,
};

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
    Client::builder()
        .https_only(!cfg!(test))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|_| CandidateError::new("setup_download", "Cannot construct HTTPS client."))
}

fn check_url(pin: &FilePin, url: &Url) -> Result<(), CandidateError> {
    let initial =
        Url::parse(&pin.url).map_err(|_| error(pin, "setup_pin_invalid", "invalid source URL"))?;
    // Test transport permits only the fake loopback server; release builds have no HTTP seam.
    let test_http = cfg!(test)
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

fn response(client: &Client, pin: &FilePin, offset: u64) -> Result<Response, CandidateError> {
    let mut url =
        Url::parse(&pin.url).map_err(|_| error(pin, "setup_pin_invalid", "invalid URL"))?;
    for redirects in 0..=5 {
        check_url(pin, &url)?;
        let mut request = client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let response = request
            .send()
            .map_err(|e| error(pin, "setup_download", e.without_url()))?;
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
    if start != offset || end < start || total > pin.max_bytes || end.checked_add(1) != Some(total)
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
) -> Result<(), CandidateError> {
    state::check_private_directory(directory)?;
    let destination = directory.join(pin.name()?);
    match destination.symlink_metadata() {
        Ok(_) => return verify_file(&destination, pin).map_err(|e| error(pin, "setup_cache_invalid", format!("{}; cached file {} was preserved. Move it aside and rerun setup, or use offline inputs", e.message, destination.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(error(pin, "setup_file", e)),
    }
    let partial = directory.join(format!("{}.part", pin.name()?));
    let mut file = private_file(&partial, pin, true)?;
    let offset = file.metadata().map_err(state::io)?.len();
    if offset > 0 && hash(&mut file, pin).is_ok() {
        return commit(file, &partial, &destination, directory, pin);
    }
    // A full-size invalid partial cannot be extended safely. Restart in this invocation.
    let offset = if offset == pin.max_bytes {
        file.set_len(0).map_err(state::io)?;
        0
    } else {
        offset
    };
    let mut response = response(client, pin, offset)?;
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
    let mut count = 0;
    let mut buffer = [0_u8; 65536];
    loop {
        let n = response.read(&mut buffer).map_err(|e| {
            error(
                pin,
                "setup_download",
                format!("interrupted body ({e}); partial retained for rerun"),
            )
        })?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > pin.max_bytes - start || expected.is_some_and(|length| count > length) {
            file.set_len(0).map_err(state::io)?;
            return Err(error(
                pin,
                "setup_size_exceeded",
                "body exceeds pinned byte bound or declared length",
            ));
        }
        file.write_all(&buffer[..n])
            .map_err(|e| error(pin, "setup_file", e))?;
    }
    file.sync_all().map_err(state::io)?;
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
    commit(file, &partial, &destination, directory, pin)
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
