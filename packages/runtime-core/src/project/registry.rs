//! A deliberately narrow project npm configuration boundary. Templates contain
//! environment references, never resolved credentials or ambient npm configuration.
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use zeroize::Zeroizing;

const MAX_BYTES: usize = 16 * 1024;

/// Canonical, non-secret configuration. Deserialized values must be rebound to
/// a fresh project read before execution; this structure is not delivery proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryTemplate {
    pub template: String,
    pub required_environment: BTreeSet<String>,
    pub sha256: String,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "registry_template_invalid",
        "Project registry configuration is outside the supported non-secret template grammar.",
    )
}

fn unsafe_file() -> CandidateError {
    CandidateError::new(
        "registry_template_unsafe",
        "Project registry configuration is unreadable, changed, or has an unsafe file identity.",
    )
}

/// Parse only bounded registry URLs, exact token environment references and the
/// optional always-auth boolean. Comments are discarded, not copied into output.
/// Errors deliberately omit input fragments, including unrecognized keys.
pub fn parse(input: &str) -> Result<RegistryTemplate, CandidateError> {
    if input.len() > MAX_BYTES
        || input
            .bytes()
            .any(|b| b.is_ascii_control() && !matches!(b, b'\n' | b'\r' | b'\t'))
    {
        return Err(invalid());
    }
    let mut entries = BTreeMap::new();
    let mut registries = BTreeSet::new();
    let mut auth_locations = BTreeSet::new();
    let mut required_environment = BTreeSet::new();
    for (index, line) in input.lines().enumerate() {
        if index >= 256 || line.len() > 2048 {
            return Err(invalid());
        }
        let line = line.trim_matches([' ', '\t', '\r']);
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        let (key, value) = line.split_once('=').ok_or_else(invalid)?;
        let key = key.trim_matches([' ', '\t']);
        let value = value.trim_matches([' ', '\t']);
        let (key, value) = if key == "registry" || scope_registry(key) {
            let location = registry_location(value.strip_prefix("https://").ok_or_else(invalid)?)?;
            registries.insert(location.clone());
            (key.to_owned(), format!("https://{location}"))
        } else if let Some(location) = key
            .strip_prefix("//")
            .and_then(|s| s.strip_suffix(":_authToken"))
        {
            let location = registry_location(location)?;
            let name = value
                .strip_prefix("${")
                .and_then(|s| s.strip_suffix('}'))
                .ok_or_else(invalid)?;
            if !environment_name(name) {
                return Err(invalid());
            }
            required_environment.insert(name.to_owned());
            auth_locations.insert(location.clone());
            (format!("//{location}:_authToken"), format!("${{{name}}}"))
        } else if key == "always-auth" && matches!(value, "true" | "false") {
            (key.to_owned(), value.to_owned())
        } else {
            return Err(invalid());
        };
        if entries.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    if !auth_locations.is_subset(&registries) {
        return Err(invalid());
    }
    let template: String = entries
        .into_iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect();
    Ok(RegistryTemplate {
        sha256: format!("{:x}", Sha256::digest(template.as_bytes())),
        template,
        required_environment,
    })
}

fn environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn scope_registry(key: &str) -> bool {
    let Some(scope) = key
        .strip_prefix('@')
        .and_then(|s| s.strip_suffix(":registry"))
    else {
        return false;
    };
    !scope.is_empty()
        && scope.len() <= 214
        && scope
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && scope.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

/// This is a restricted grammar, not a general URL parser. Reject encoding,
/// authority tricks and traversal instead of normalizing ambiguous URLs.
fn registry_location(location: &str) -> Result<String, CandidateError> {
    let (host, path) = location.split_once('/').unwrap_or((location, ""));
    let labels: Vec<_> = host.split('.').collect();
    if host.len() > 253
        || labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        || !labels
            .last()
            .is_some_and(|label| label.len() >= 2 && label.bytes().all(|b| b.is_ascii_lowercase()))
        || labels.iter().any(|label| {
            matches!(
                *label,
                "localhost"
                    | "local"
                    | "localdomain"
                    | "internal"
                    | "lan"
                    | "home"
                    | "onion"
                    | "invalid"
                    | "test"
            )
        })
    {
        return Err(invalid());
    }
    if path.starts_with('/') {
        return Err(invalid());
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.len() > 1024
        || (!path.is_empty()
            && path.split('/').any(|part| {
                part.is_empty()
                    || matches!(part, "." | "..")
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            }))
    {
        return Err(invalid());
    }
    Ok(if path.is_empty() {
        format!("{host}/")
    } else {
        format!("{host}/{path}/")
    })
}

/// Read only an absolute project's .npmrc. Every component is opened relative
/// to a pinned directory descriptor with no symlink following. Raw input is
/// zeroized, bounded, never logged, and checked for mutation before acceptance.
pub fn read(project: &Path) -> Result<Option<RegistryTemplate>, CandidateError> {
    read_checked(project, || {})
}

fn read_checked(
    project: &Path,
    after_read: impl FnOnce(),
) -> Result<Option<RegistryTemplate>, CandidateError> {
    let Some(mut file) = open_project_file(project)? else {
        return Ok(None);
    };
    let before = file.metadata().map_err(|_| unsafe_file())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_BYTES as u64 {
        return Err(unsafe_file());
    }
    // Reserve the entire read bound up front: growth must not leave an old
    // allocation containing credential bytes outside the zeroizing owner.
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_BYTES + 1));
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_file())?;
    after_read();
    let after = file.metadata().map_err(|_| unsafe_file())?;
    let current = open_project_file(project)?
        .ok_or_else(unsafe_file)?
        .metadata()
        .map_err(|_| unsafe_file())?;
    if bytes.len() > MAX_BYTES
        || bytes.len() as u64 != before.len()
        || !same_file(&before, &after)
        || !same_file(&after, &current)
    {
        return Err(unsafe_file());
    }
    let input = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    parse(input).map(Some)
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    b.is_file()
        && b.nlink() == 1
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}

fn open_project_file(project: &Path) -> Result<Option<File>, CandidateError> {
    if !project.is_absolute() {
        return Err(unsafe_file());
    }
    let mut parent = File::open("/").map_err(|_| unsafe_file())?;
    for component in project.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                parent = open_relative(&parent, name.as_encoded_bytes(), true)?
                    .ok_or_else(unsafe_file)?;
            }
            _ => return Err(unsafe_file()),
        }
    }
    open_relative(&parent, b".npmrc", false)
}

fn open_relative(
    parent: &File,
    name: &[u8],
    directory: bool,
) -> Result<Option<File>, CandidateError> {
    let name = CString::new(name).map_err(|_| unsafe_file())?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: parent owns a live directory descriptor and name is NUL terminated.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(unsafe_file())
        };
    }
    // SAFETY: successful openat returns a fresh descriptor, owned exclusively here.
    Ok(Some(unsafe { File::from_raw_fd(fd) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let parent = std::env::temp_dir().canonicalize().unwrap();
            let path = parent.join(format!(
                "hack-registry-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, value: &str) {
            fs::write(self.0.join(".npmrc"), value).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn canonical_scoped_default_and_environment_references() {
        let input = "# discarded\nregistry=https://registry.npmjs.org\n@event-agent:registry = https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\nalways-auth=true\n";
        let parsed = parse(input).unwrap();
        assert_eq!(
            parsed.required_environment,
            BTreeSet::from(["GITHUB_TOKEN".into()])
        );
        assert_eq!(
            parsed.template,
            "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n@event-agent:registry=https://npm.pkg.github.com/\nalways-auth=true\nregistry=https://registry.npmjs.org/\n"
        );
        assert_eq!(
            parsed.sha256,
            format!("{:x}", Sha256::digest(parsed.template.as_bytes()))
        );
        assert_eq!(parse(&parsed.template).unwrap(), parsed);
        let reversed = input.lines().rev().collect::<Vec<_>>().join("\n");
        assert_eq!(parse(&reversed).unwrap(), parsed);
        assert!(parse("registry=https://packages.example.com/npm/team/\n//packages.example.com/npm/team/:_authToken=${TOKEN_2}\n").is_ok());
    }

    #[test]
    fn rejects_credentials_duplicates_and_unsupported_directives_without_echo() {
        for input in [
            "//npm.pkg.github.com/:_authToken=synthetic-secret",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=prefix${TOKEN}",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${TOKEN}suffix",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${TOKEN:-fallback}",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${TOKEN}${OTHER}",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${1TOKEN}",
            "registry=https://npm.pkg.github.com\nregistry=https://npm.pkg.github.com/",
            "registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${TOKEN}\n//npm.pkg.github.com:_authToken=${OTHER}",
            "//npm.pkg.github.com/:_authToken=${TOKEN}",
            "registry=https://npm.pkg.github.com/a/\n//npm.pkg.github.com/:_authToken=${TOKEN}",
            "registry=https://registry.npmjs.org/\n//npm.pkg.github.com/:_authToken=${TOKEN}",
            "always-auth=true\nalways-auth=false",
            "always-auth=1",
            "userconfig=/host/.npmrc",
            "_auth=synthetic-secret",
            "synthetic-secret=value",
            "ignore-scripts=true",
        ] {
            let error = parse(input).unwrap_err();
            assert!(!format!("{error:?}").contains("synthetic-secret"));
        }
    }

    #[test]
    fn rejects_url_injection_and_traversal() {
        for url in [
            "http://npm.pkg.github.com/",
            "https://user:secret@npm.pkg.github.com/",
            "https://127.0.0.1/",
            "https://127.1/",
            "https://[::1]/",
            "https://localhost/",
            "https://npm.local/",
            "https://npm.internal/",
            "https://*.example.com/",
            "https://EXAMPLE.com/",
            "https://npm.example.com:443/",
            "https://npm.example.com/?secret=x",
            "https://npm.example.com/#fragment",
            "https://npm.example.com/a/../b/",
            "https://npm.example.com/%2e%2e/",
            "https://npm.example.com/a//b/",
            "https://npm.example.com/\\host",
            "https://npm.example.com/${TOKEN}/",
            "https://npm.example.com/\r_auth=secret",
            "https://npm.example.com/\0",
        ] {
            assert!(parse(&format!("registry={url}")).is_err());
        }
        assert!(parse("@../bad:registry=https://npm.pkg.github.com/").is_err());
        assert!(parse(&"#".repeat(MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn bounded_project_only_read_and_missing() {
        let fixture = Fixture::new();
        assert_eq!(read(&fixture.0).unwrap(), None);
        fixture.write("registry=https://registry.npmjs.org/");
        assert_eq!(
            read(&fixture.0).unwrap(),
            Some(parse("registry=https://registry.npmjs.org/").unwrap())
        );
        fixture.write(&"#".repeat(MAX_BYTES + 1));
        assert!(read(&fixture.0).is_err());
        fs::write(fixture.0.join(".npmrc"), [0xff]).unwrap();
        assert!(read(&fixture.0).is_err());
        assert!(read(Path::new("relative-project")).is_err());
    }

    #[test]
    fn rejects_symlink_ancestors_leaf_hardlinks_and_nonregular_files() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        other.write("registry=https://registry.npmjs.org/");
        symlink(other.0.join(".npmrc"), fixture.0.join(".npmrc")).unwrap();
        assert!(read(&fixture.0).is_err());
        fs::remove_file(fixture.0.join(".npmrc")).unwrap();
        fs::hard_link(other.0.join(".npmrc"), fixture.0.join(".npmrc")).unwrap();
        assert!(read(&fixture.0).is_err());
        fs::remove_file(fixture.0.join(".npmrc")).unwrap();
        fs::create_dir(fixture.0.join(".npmrc")).unwrap();
        assert!(read(&fixture.0).is_err());
        symlink(&other.0, fixture.0.join("alias")).unwrap();
        assert!(read(&fixture.0.join("alias")).is_err());
        fs::create_dir(other.0.join("child")).unwrap();
        assert!(read(&fixture.0.join("alias/child")).is_err());
        assert!(read(&fixture.0.join("../")).is_err());
    }

    #[test]
    fn rejects_mutation_replacement_and_new_hardlink_during_read() {
        let fixture = Fixture::new();
        fixture.write("registry=https://registry.npmjs.org/");
        assert!(
            read_checked(&fixture.0, || fixture
                .write("registry=https://npm.pkg.github.com/"))
            .is_err()
        );
        fixture.write("registry=https://registry.npmjs.org/");
        assert!(
            read_checked(&fixture.0, || {
                fs::rename(fixture.0.join(".npmrc"), fixture.0.join("old")).unwrap();
                fixture.write("registry=https://registry.npmjs.org/");
            })
            .is_err()
        );
        assert!(
            read_checked(&fixture.0, || {
                fs::hard_link(fixture.0.join(".npmrc"), fixture.0.join("alias")).unwrap();
            })
            .is_err()
        );
    }
}
