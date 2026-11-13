//! Pinned guest-only networking dependencies, installed before Docker discovers capabilities.
use super::{source_sync, state};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

/// Alpine v3.24 `main`/`aarch64` packages, matching the pinned SmolVM agent rootfs
/// (Alpine 3.24.4, apk-tools 3). Re-pin these with the rootfs whenever the SmolVM pin
/// moves the guest to another Alpine release; `guest-network-tools.sh` checks the release.
pub(super) const PACKAGES: [(&str, &str); 4] = [
    (
        "iptables-1.8.13-r0.apk",
        "9d22aef2e74346e9d537f6dc964786ab14b35580e3ccc0e4001dc3a725e8fe77",
    ),
    (
        "libmnl-1.0.5-r2.apk",
        "0ca382c70f78affef3a4a28016aab25ad8c3ccf1bcdad59f3968d4536a7b2478",
    ),
    (
        "libnftnl-1.3.1-r0.apk",
        "8b31395671e910c294d7f0e29d3ac3c7efe9d89264db255f39aa9944dd4b6cac",
    ),
    (
        "libxtables-1.8.13-r0.apk",
        "7535f18d9c7229178bc5e3809e5fea171033e33dfa054d88846512e1f25eefa8",
    ),
];
fn error(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("network_tools", message)
}
fn read_archive(path: &Path, expected: &str) -> Result<Vec<u8>, CandidateError> {
    state::check_private_directory(path.parent().expect("archive parent"))?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 2 * 1024 * 1024
    {
        return Err(error(
            "Expected a private, singly linked networking archive under 2 MiB.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 != metadata.len() || format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(error("Networking archive size or pinned digest mismatch."));
    }
    Ok(bytes)
}

#[derive(Debug, Serialize)]
pub struct Preparation {
    pub status: &'static str,
    pub package_count: usize,
    pub identity: String,
}

/// Validate the entire pinned input set before mutation, then publish one complete
/// private directory under the same operation lock used by runtime lifecycle work.
/// Interrupted staging is retained and refused; existing installs are never repaired in place.
pub(super) fn prepare(
    candidate: &Candidate,
    directory: &Path,
) -> Result<Preparation, CandidateError> {
    prepare_packages(candidate, directory, &PACKAGES)
}

fn prepare_packages(
    candidate: &Candidate,
    directory: &Path,
    packages: &[(&str, &str)],
) -> Result<Preparation, CandidateError> {
    let archives = packages
        .iter()
        .map(|(name, hash)| read_archive(&directory.join(name), hash))
        .collect::<Result<Vec<_>, _>>()?;
    let identity = format!(
        "{:x}",
        Sha256::digest(packages.iter().map(|(_, hash)| *hash).collect::<String>())
    );
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers)?;
    let target = providers.join("network-tools");
    match target.symlink_metadata() {
        Ok(_) => {
            for (name, hash) in packages {
                read_archive(&target.join(name), hash)?;
            }
            return Ok(Preparation {
                status: "reused",
                package_count: packages.len(),
                identity,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    let staging = providers.join("network-tools-installing");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| error(format!("Cannot create network-tools staging: {e}")))?;
    for ((name, _), bytes) in packages.iter().zip(archives) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(staging.join(name))
            .map_err(|e| error(format!("Cannot create staged archive: {e}")))?;
        file.write_all(&bytes).map_err(state::io)?;
        file.sync_all().map_err(state::io)?;
    }
    for (name, hash) in packages {
        read_archive(&staging.join(name), hash)?;
    }
    File::open(&staging)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)?;
    fs::rename(&staging, &target)
        .map_err(|e| error(format!("Cannot publish network-tools directory: {e}")))?;
    File::open(&providers)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)?;
    Ok(Preparation {
        status: "installed",
        package_count: packages.len(),
        identity,
    })
}

/// Refuse missing or invalid setup before VM creation/start; guest provisioning rechecks bytes.
pub(super) fn verify(candidate: &Candidate) -> Result<(), CandidateError> {
    for (name, hash) in PACKAGES {
        read_archive(&candidate.state_root.join("providers/network-tools").join(name), hash)
            .map_err(|_| error("Pinned network tools are missing or invalid. Run runtime prepare-network-tools --directory <private-pinned-apk-directory> before runtime up."))?;
    }
    Ok(())
}

/// Identity of the pinned package set, as recorded in the guest receipt.
pub(super) fn identity() -> String {
    format!(
        "{:x}",
        Sha256::digest(PACKAGES.iter().map(|(_, hash)| *hash).collect::<String>())
    )
}

pub(super) fn provision(
    candidate: &Candidate,
    owner: &str,
    execute: &mut impl FnMut(&str, &[&str], Option<&str>) -> Result<String, CandidateError>,
) -> Result<(), CandidateError> {
    // Validate every host input before changing guest state, including on reuse.
    let archives = PACKAGES
        .iter()
        .map(|(name, hash)| {
            read_archive(
                &candidate
                    .state_root
                    .join("providers/network-tools")
                    .join(name),
                hash,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let identity = identity();
    let result = execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "check"],
        None,
    )?;
    if result.trim() == "ready" {
        return Ok(());
    }
    if result.trim() != "absent" {
        return Err(error("Unexpected networking provisioning state."));
    }
    let stage = execute(
        "umask 077; mktemp -d /run/hack-local/network-tools.XXXXXXXX",
        &[],
        None,
    )?;
    let stage = stage.trim();
    if !stage.starts_with("/run/hack-local/network-tools.")
        || !stage
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-._".contains(&b))
    {
        return Err(error("Invalid networking staging path."));
    }
    for ((name, hash), bytes) in PACKAGES.iter().zip(archives) {
        let target = format!("{stage}/{name}");
        execute("(set -C; : > \"$1\")", &[&target], None)?;
        source_sync::upload_with(execute, &target, &bytes)?;
        execute(
            "test \"$(sha256sum \"$1\" | cut -d ' ' -f 1)\" = \"$2\"; apk verify \"$1\" >/dev/null",
            &[&target, hash],
            None,
        )?;
    }
    execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "install", stage],
        None,
    )?;
    let result = execute(
        include_str!("guest-network-tools.sh"),
        &[owner, &identity, "check"],
        None,
    )?;
    if result.trim() != "ready" {
        return Err(error("Networking installation was not verified."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-network-prepare-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn candidate(&self) -> Candidate {
            let root = self.0.join("candidate");
            state::private_directory(&root).unwrap();
            Candidate::discover(&root).unwrap()
        }
        fn inputs(&self) -> std::path::PathBuf {
            let root = self.0.join("input");
            state::private_directory(&root).unwrap();
            for name in ["first.apk", "second.apk"] {
                fs::write(root.join(name), b"fixture").unwrap();
                fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o600)).unwrap();
            }
            root
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn missing_or_corrupt_inputs_do_not_create_candidate_state() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str()), ("second.apk", hash.as_str())];
        fs::remove_file(input.join("second.apk")).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!candidate.state_root.exists());
        fs::write(input.join("second.apk"), b"corrupt").unwrap();
        fs::set_permissions(input.join("second.apk"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!candidate.state_root.exists());
        // The public entrypoint cannot accept arbitrary test pins.
        assert!(prepare(&candidate, &input).is_err());
        let missing = verify(&candidate).unwrap_err();
        assert_eq!(missing.code, "network_tools");
        assert!(missing.message.contains("prepare-network-tools"));
        assert!(!candidate.state_root.exists());
    }

    #[test]
    fn complete_install_is_atomic_reusable_and_corruption_is_not_overwritten() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str()), ("second.apk", hash.as_str())];
        assert_eq!(
            prepare_packages(&candidate, &input, &pins).unwrap().status,
            "installed"
        );
        let target = candidate.state_root.join("providers/network-tools");
        let inode = target.metadata().unwrap().ino();
        assert!(
            !candidate
                .state_root
                .join("providers/network-tools-installing")
                .exists()
        );
        assert_eq!(
            prepare_packages(&candidate, &input, &pins).unwrap().status,
            "reused"
        );
        assert_eq!(target.metadata().unwrap().ino(), inode);
        fs::write(target.join("first.apk"), b"corrupt").unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert_eq!(fs::read(target.join("first.apk")).unwrap(), b"corrupt");
    }

    #[test]
    fn interrupted_staging_and_foreign_target_are_retained_and_refused() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let input = fixture.inputs();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let pins = [("first.apk", hash.as_str())];
        let providers = candidate.state_root.join("providers");
        let staging = providers.join("network-tools-installing");
        state::private_directory(&staging).unwrap();
        fs::write(staging.join("evidence"), "retain").unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(!providers.join("network-tools").exists());
        assert_eq!(
            fs::read_to_string(staging.join("evidence")).unwrap(),
            "retain"
        );
        symlink(&input, providers.join("network-tools")).unwrap();
        assert!(prepare_packages(&candidate, &input, &pins).is_err());
        assert!(
            providers
                .join("network-tools")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn archives_reject_corruption_aliases_and_public_files() {
        let root = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-network-tools",
        );
        state::private_directory(&root).unwrap();
        let path = root.join("archive.apk");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        assert_eq!(read_archive(&path, &hash).unwrap(), b"fixture");
        assert!(read_archive(&path, "wrong").is_err());
        let alias = root.join("alias");
        symlink(&path, &alias).unwrap();
        assert!(read_archive(&alias, &hash).is_err());
        std::fs::remove_file(&alias).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(read_archive(&path, &hash).is_err());
        std::fs::remove_file(alias).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_archive(&path, &hash).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pins_match_the_guest_release_and_the_published_table() {
        // The guest script refuses any other Alpine release; the packages must be built for it.
        let script = include_str!("guest-network-tools.sh");
        assert!(script.contains("test \"$(cat /etc/alpine-release)\" = 3.24.4\n"));
        assert!(script.contains("--no-logfile"));
        let guide = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/guides/native-candidate.md"),
        )
        .unwrap();
        assert!(guide.contains("https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/"));
        let rows: Vec<String> = guide
            .lines()
            .filter(|line| line.starts_with("| `") && line.contains(".apk` |"))
            .map(str::to_owned)
            .collect();
        let expected: Vec<String> = PACKAGES
            .iter()
            .map(|(name, hash)| format!("| `{name}` | `{hash}` |"))
            .collect();
        assert_eq!(rows, expected);
    }

    /// The guest script against a fake guest: a private root, a fake `apk` that refuses any
    /// call without the empty repositories file (the apk-tools 3 index refresh that timed out
    /// pools without internet), and `stat` reporting this user as root. Linux only: it needs
    /// GNU `stat` and `sha256sum`.
    #[cfg(target_os = "linux")]
    mod fake_guest {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Output};

        const APK: &str = r#"#!/bin/bash
set -eu
if test "${1:-}" != --repositories-file || test "${2:-}" != /dev/null; then
  echo "apk called with repositories: $*" >> "$FAKE_STATE/refused"; exit 99
fi
shift 2
installed="$FAKE_STATE/installed"; touch "$installed"
case "$1" in
  --print-arch) echo aarch64 ;;
  info)
    case "$2" in
      -e) grep -qx "$3" "$installed" ;;
      -L) printf '%s-1.0 contains:\nusr/lib/%s.so\n\n' "$3" "$3" ;;
      -v) sed 's/$/-1.0/' "$installed" ;;
      *) exit 98 ;;
    esac ;;
  add)
    if test -e "$FAKE_STATE/fail-add"; then exit 1; fi
    for file in "$@"; do
      case "$file" in
        *.apk) name=$(basename "$file" .apk)
          mkdir -p "$FAKE_ROOT/usr/lib"; printf '%s' "$name" > "$FAKE_ROOT/usr/lib/$name.so"
          grep -qx "$name" "$installed" || echo "$name" >> "$installed" ;;
      esac
    done ;;
  *) exit 97 ;;
esac
"#;
        const STAT: &str =
            "#!/bin/bash\nout=$(/usr/bin/stat \"$@\")\necho \"${out/#$(id -u):/0:}\"\n";

        struct Guest {
            dir: PathBuf,
        }
        impl Drop for Guest {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.dir);
            }
        }
        impl Guest {
            fn new(name: &str) -> Self {
                let dir = crate::private_test_root(
                    &std::env::temp_dir().canonicalize().unwrap(),
                    &format!("hack-network-guest-{name}"),
                );
                for sub in ["bin", "state", "root", "stage", "etc"] {
                    fs::create_dir(dir.join(sub)).unwrap();
                }
                for (name, body) in [
                    ("apk", APK),
                    ("stat", STAT),
                    ("iptables", "#!/bin/sh\nexit 0\n"),
                ] {
                    let path = dir.join("bin").join(name);
                    fs::write(&path, body).unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
                }
                fs::write(dir.join("etc/alpine-release"), "3.24.4\n").unwrap();
                for package in ["iptables", "libmnl", "libnftnl", "libxtables"] {
                    fs::write(dir.join("stage").join(format!("{package}.apk")), b"apk").unwrap();
                }
                Self { dir }
            }
            fn receipt(&self) -> PathBuf {
                self.dir.join("etc/hack-local-network-tools")
            }
            fn run(&self, owner: &str, mode: &str) -> Output {
                let script = include_str!("guest-network-tools.sh")
                    .replace(
                        "/etc/hack-local-network-tools",
                        &self.receipt().display().to_string(),
                    )
                    .replace(
                        "/etc/alpine-release",
                        &self.dir.join("etc/alpine-release").display().to_string(),
                    )
                    .replace("\"/$path\"", "\"$FAKE_ROOT/$path\"");
                let path = format!("{}:/usr/bin:/bin", self.dir.join("bin").display());
                Command::new("/bin/bash")
                    .args([
                        "-c",
                        &script,
                        "network-tools",
                        owner,
                        "identity-fixture",
                        mode,
                    ])
                    .arg(self.dir.join("stage"))
                    .env_clear()
                    .env("PATH", path)
                    .env("FAKE_STATE", self.dir.join("state"))
                    .env("FAKE_ROOT", self.dir.join("root"))
                    .output()
                    .unwrap()
            }
            fn stdout(&self, owner: &str, mode: &str) -> String {
                let output = self.run(owner, mode);
                assert!(
                    output.status.success(),
                    "{mode}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout).unwrap()
            }
            fn refused_apk_calls(&self) -> bool {
                Path::new(&self.dir.join("state/refused")).exists()
            }
        }

        #[test]
        fn a_fresh_install_reads_only_the_installed_database_and_is_then_ready() {
            let guest = Guest::new("fresh");
            assert_eq!(guest.stdout("owner-a", "check"), "absent\n");
            guest.stdout("owner-a", "install");
            assert_eq!(guest.stdout("owner-a", "check"), "ready\n");
            assert!(
                !guest.refused_apk_calls(),
                "every apk call must skip repositories"
            );
            // Another pool's owner never reuses this receipt.
            assert!(!guest.run("owner-b", "check").status.success());
        }

        #[test]
        fn a_failed_first_install_resumes_on_retry() {
            let guest = Guest::new("retry");
            fs::write(guest.dir.join("state/fail-add"), b"").unwrap();
            assert!(!guest.run("owner-a", "install").status.success());
            assert!(guest.receipt().is_dir() && !guest.receipt().join("ready").exists());
            // The retry sees its own incomplete receipt: absent, then installed and ready.
            fs::remove_file(guest.dir.join("state/fail-add")).unwrap();
            assert_eq!(guest.stdout("owner-a", "check"), "absent\n");
            guest.stdout("owner-a", "install");
            assert_eq!(guest.stdout("owner-a", "check"), "ready\n");
            assert!(!guest.refused_apk_calls());
        }

        #[test]
        fn an_incomplete_receipt_of_another_pool_or_package_set_is_refused() {
            let guest = Guest::new("foreign");
            fs::write(guest.dir.join("state/fail-add"), b"").unwrap();
            assert!(!guest.run("owner-a", "install").status.success());
            fs::remove_file(guest.dir.join("state/fail-add")).unwrap();
            assert!(!guest.run("owner-b", "check").status.success());
            assert!(!guest.run("owner-b", "install").status.success());
            // An interruption before the owner was written still resumes.
            fs::write(guest.receipt().join("owner"), b"").unwrap();
            guest.stdout("owner-a", "install");
            assert_eq!(guest.stdout("owner-a", "check"), "ready\n");
        }

        #[test]
        fn an_unowned_package_or_a_changed_installed_file_is_refused() {
            let guest = Guest::new("unowned");
            fs::write(guest.dir.join("state/installed"), "libmnl\n").unwrap();
            assert_eq!(guest.run("owner-a", "check").status.code(), Some(81));

            let guest = Guest::new("changed");
            guest.stdout("owner-a", "install");
            fs::write(guest.dir.join("root/usr/lib/libmnl.so"), b"changed").unwrap();
            assert!(!guest.run("owner-a", "check").status.success());
        }
    }
}
