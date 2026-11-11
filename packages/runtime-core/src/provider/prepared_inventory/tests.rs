use super::*;

fn list(entries: &[&str]) -> String {
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend_from_slice(format!("./{entry}").as_bytes());
        bytes.push(0);
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn encoded(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

const TOOLS_FILES: &str = "aa  /usr/sbin/xtables-legacy-multi\nbb  /usr/lib/libmnl.so.0.2.0\n";

/// A report shaped like a clean seed's, as observed live, with overrides by key.
fn report(overrides: &[(&str, String)]) -> String {
    let mut fields: Vec<(String, String)> = vec![
        ("owner_marker".into(), "0".into()),
        ("engine_id".into(), "0".into()),
        (
            "storage_top".into(),
            list(&["docker", "containerd", "lost+found", "layers", "containers"]),
        ),
        (
            "docker_top".into(),
            list(&["image", "overlay2", "volumes", "containers", "network"]),
        ),
        ("docker_containers".into(), list(&[])),
        (
            "docker_volumes".into(),
            list(&["metadata.db", "backingFsBlockDev"]),
        ),
        ("docker_network".into(), list(&[])),
        ("images".into(), list(&[])),
        (
            "upper_files".into(),
            list(&[
                "usr/sbin/xtables-legacy-multi",
                "usr/lib/libmnl.so.0.2.0",
                "etc/hack-local-network-tools/owner",
                "lib/apk/db/installed",
                "lib/apk/db/lock",
                "etc/resolv.conf",
            ]),
        ),
        (
            "upper_links".into(),
            list(&["run/docker.sock", "workspace"]),
        ),
        (
            "upper_dirs".into(),
            list(&[
                "usr",
                "usr/sbin",
                "usr/lib",
                "etc",
                "etc/hack-local-network-tools",
                "etc/iptables",
                "lib",
                "lib/apk",
                "lib/apk/db",
                "run",
                "run/hack-local",
                "run/smolvm",
                "run/smolvm/virtiofs",
                "run/smolvm/virtiofs/smolvm0",
                "opt",
                "opt/hack-engine",
            ]),
        ),
        ("upper_other".into(), list(&[])),
        ("tools_owner".into(), encoded("prepared-base:base-1")),
        ("tools_identity".into(), encoded("fddf")),
        ("tools_files".into(), encoded(TOOLS_FILES)),
        ("tools_check".into(), "ok".into()),
    ];
    for (key, value) in overrides {
        let slot = fields
            .iter_mut()
            .find(|(existing, _)| existing == key)
            .expect("known field");
        slot.1 = value.clone();
    }
    let mut text = String::new();
    for (key, value) in fields {
        text.push_str(&format!("{key} {value}\n"));
    }
    for dir in ["containerd", "layers", "containers"] {
        text.push_str(&format!("storage_dir {dir} {}\n", list(&[])));
    }
    text.push_str("end prepared-inventory-v1\n");
    text
}

#[test]
fn a_clean_seed_report_has_no_unexpected_entries() {
    let inventory = evaluate(&report(&[]), &[]).unwrap();
    assert!(
        inventory.unexpected.is_empty(),
        "{:?}",
        inventory.unexpected
    );
    assert!(!inventory.owner_marker_present && !inventory.engine_id_present);
    assert_eq!((inventory.containers, inventory.volumes), (0, 0));
    assert_eq!(inventory.network_tools_owner, "prepared-base:base-1");
    assert!(inventory.network_tools_files_verified);
}

#[test]
fn every_class_of_leftover_is_reported_by_path() {
    let cases: [(&str, String, &str); 10] = [
        (
            "storage_top",
            list(&["docker", "hack-graph-startup"]),
            "storage:hack-graph-startup",
        ),
        (
            "docker_top",
            list(&["image", "buildkit"]),
            "storage:docker/buildkit",
        ),
        (
            "docker_network",
            list(&["files/local-kv.db"]),
            "storage:docker/network/files/local-kv.db",
        ),
        ("images", list(&["abc"]), "image:abc"),
        (
            "upper_files",
            list(&["root/.docker/config.json"]),
            "overlay:root/.docker/config.json",
        ),
        (
            "upper_links",
            list(&["etc/secret-link"]),
            "overlay-link:etc/secret-link",
        ),
        (
            "upper_dirs",
            list(&["mnt/hack-projects/0a"]),
            "overlay-dir:mnt/hack-projects/0a",
        ),
        (
            "upper_dirs",
            list(&["run/smolvm/virtiofs/tag/nested"]),
            "overlay-dir:run/smolvm/virtiofs/tag/nested",
        ),
        (
            "upper_other",
            list(&["var/lib/whiteout"]),
            "overlay-special:var/lib/whiteout",
        ),
        (
            "upper_files",
            list(&["run/hack-dependencies/dependency-01.sock"]),
            "overlay:run/hack-dependencies/dependency-01.sock",
        ),
    ];
    for (key, value, expected) in cases {
        let inventory = evaluate(&report(&[(key, value)]), &[]).unwrap();
        assert!(
            inventory.unexpected.iter().any(|entry| entry == expected),
            "{key}: {:?}",
            inventory.unexpected
        );
    }
    // Storage directories that must be empty report every non-directory entry.
    let with_dir = report(&[]).replace(
        &format!("storage_dir containerd {}\n", list(&[])),
        &format!("storage_dir containerd {}\n", list(&["io/meta.db"])),
    );
    assert_eq!(
        evaluate(&with_dir, &[]).unwrap().unexpected,
        ["storage:containerd/io/meta.db"]
    );
}

#[test]
fn identity_containers_volumes_and_tools_are_reported_as_facts() {
    let inventory = evaluate(
        &report(&[
            ("owner_marker", "1".into()),
            ("engine_id", "1".into()),
            ("docker_containers", list(&["c1", "c2"])),
            ("docker_volumes", list(&["metadata.db", "app-data"])),
            ("tools_owner", encoded("0123456789abcdef0123456789abcdef")),
            ("tools_check", "failed".into()),
        ]),
        &[],
    )
    .unwrap();
    assert!(inventory.owner_marker_present && inventory.engine_id_present);
    assert_eq!((inventory.containers, inventory.volumes), (2, 1));
    assert_eq!(
        inventory.network_tools_owner,
        "0123456789abcdef0123456789abcdef"
    );
    assert!(!inventory.network_tools_files_verified);
}

#[test]
fn allowed_images_are_accepted_and_others_reported() {
    let inventory = evaluate(&report(&[("images", list(&["a", "b"]))]), &["a".into()]).unwrap();
    assert_eq!(inventory.images, ["a", "b"]);
    assert_eq!(inventory.unexpected, ["image:b"]);
}

#[test]
fn malformed_reports_are_refused() {
    let clean = report(&[]);
    for (label, text) in [
        ("no end", clean.replace("end prepared-inventory-v1\n", "")),
        ("after end", format!("{clean}extra 1\n")),
        (
            "duplicate",
            clean.replacen("owner_marker 0\n", "owner_marker 0\nowner_marker 0\n", 1),
        ),
        ("missing", clean.replacen("engine_id 0\n", "", 1)),
        (
            "bad flag",
            clean.replacen("owner_marker 0\n", "owner_marker yes\n", 1),
        ),
        (
            "bad base64",
            clean.replacen(
                &format!("images {}\n", list(&[])),
                "images !!notbase64\n",
                1,
            ),
        ),
        (
            "path escapes",
            report(&[(
                "upper_files",
                base64::engine::general_purpose::STANDARD.encode(b"/etc/passwd\0"),
            )]),
        ),
        (
            "unknown storage dir",
            clean.replacen("storage_dir layers", "storage_dir elsewhere", 1),
        ),
    ] {
        let refused = evaluate(&text, &[]).unwrap_err();
        assert_eq!(refused.code, "prepared_base_unverified", "{label}");
    }
}

#[test]
fn the_empty_attach_directories_of_smolvm_1_34_are_allowed_and_nothing_below_them() {
    let mut dirs = vec![
        "run",
        "run/smolvm",
        "run/smolvm/attach",
        "run/smolvm/attach/ro",
        "run/smolvm/attach/rw",
    ];
    let inventory = evaluate(&report(&[("upper_dirs", list(&dirs))]), &[]).unwrap();
    assert!(
        inventory.unexpected.is_empty(),
        "{:?}",
        inventory.unexpected
    );
    dirs.push("run/smolvm/attach/rw/share");
    let inventory = evaluate(
        &report(&[
            ("upper_dirs", list(&dirs)),
            ("upper_files", list(&["run/smolvm/attach/ro/file"])),
        ]),
        &[],
    )
    .unwrap();
    assert_eq!(
        inventory.unexpected,
        [
            "overlay-dir:run/smolvm/attach/rw/share",
            "overlay:run/smolvm/attach/ro/file",
        ]
    );
}

/// `guest-prepared-inventory.sh` against a fake guest: its absolute paths point into a private
/// root, and fake `blkid`, `mount` and `umount` stand in for the guest's. The fake `mount` can
/// refuse a read-only mount the way util-linux 2.42 in the SmolVM 1.34.1 guest does (a warning on
/// stdout, exit 32). Linux only: it needs GNU `find`, `base64` and `sha256sum`.
#[cfg(target_os = "linux")]
mod fake_guest {
    use super::evaluate;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;
    use std::process::{Command, Output};

    const MOUNT: &str = r#"#!/bin/bash
set -eu
test "$1" = -n; shift
opts=
if test "$1" = -o; then opts=$2; shift 2; fi
echo "mount $opts" >> "$FAKE_STATE/log"
case "$opts" in
  ro)
    if test -e "$FAKE_STATE/ro-refused"; then
      printf 'mount warning:\n      * vdb: Can'"'"'t mount, would change RO state\n'; exit 32
    fi
    echo "36 25 254:16 / $2 ro,relatime - ext4 $1 ro" > "$FAKE_STATE/mountinfo" ;;
  "") echo "36 25 254:16 / $2 rw,relatime - ext4 $1 rw" > "$FAKE_STATE/mountinfo" ;;
  remount,bind,ro)
    if test -e "$FAKE_STATE/remount-refused"; then echo "remount refused" >&2; exit 32; fi
    if test -e "$FAKE_STATE/remount-noop"; then exit 0; fi
    sed -i 's/ rw,relatime / ro,relatime /' "$FAKE_STATE/mountinfo" ;;
  *) exit 99 ;;
esac
"#;
    const UMOUNT: &str =
        "#!/bin/bash\necho umount >> \"$FAKE_STATE/log\"\n: > \"$FAKE_STATE/mountinfo\"\n";
    const BLKID: &str =
        "#!/bin/sh\necho '/dev/vdb: LABEL=\"smolvm-overlay\" UUID=\"fixture\" TYPE=\"ext4\"'\n";

    struct Guest {
        dir: PathBuf,
    }
    impl Drop for Guest {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    impl Guest {
        /// A clean seed as a 1.34.1 verifier boot leaves it, including the empty attach
        /// directories.
        fn new(name: &str) -> Self {
            let dir = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                &format!("hack-inventory-guest-{name}"),
            );
            for sub in [
                "bin",
                "state",
                "root/storage/docker/volumes",
                "root/storage/containerd",
                "root/etc/hack-local-network-tools",
                "root/mnt/upper/etc",
                "root/mnt/upper/run/smolvm/virtiofs/smolvm0",
                "root/mnt/upper/run/smolvm/attach/ro",
                "root/mnt/upper/run/smolvm/attach/rw",
                "root/mnt/upper/run/hack-local",
            ] {
                fs::create_dir_all(dir.join(sub)).unwrap();
            }
            fs::write(
                dir.join("root/mnt/upper/etc/resolv.conf"),
                "nameserver fixture\n",
            )
            .unwrap();
            symlink("/run", dir.join("root/mnt/upper/run/docker.sock")).unwrap();
            fs::write(dir.join("root/storage/docker/volumes/metadata.db"), "").unwrap();
            fs::write(dir.join("state/mountinfo"), "").unwrap();
            for (name, body) in [("mount", MOUNT), ("umount", UMOUNT), ("blkid", BLKID)] {
                let path = dir.join("bin").join(name);
                fs::write(&path, body).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            Self { dir }
        }
        fn flag(&self, name: &str) {
            fs::write(self.dir.join("state").join(name), "").unwrap();
        }
        fn run(&self) -> Output {
            let root = self.dir.join("root");
            let script = include_str!("../guest-prepared-inventory.sh")
                .replace(
                    "/proc/self/mountinfo",
                    &self.dir.join("state/mountinfo").display().to_string(),
                )
                .replace(
                    "/etc/hack-local-network-tools",
                    &root
                        .join("etc/hack-local-network-tools")
                        .display()
                        .to_string(),
                )
                .replace(
                    "mountpoint=/mnt",
                    &format!("mountpoint={}", root.join("mnt").display()),
                )
                .replace("/storage", &root.join("storage").display().to_string());
            let path = format!("{}:/usr/bin:/bin", self.dir.join("bin").display());
            Command::new("/bin/bash")
                .args(["-c", &script, "inventory"])
                .env_clear()
                .env("PATH", path)
                .env("FAKE_STATE", self.dir.join("state"))
                .output()
                .unwrap()
        }
        fn log(&self) -> String {
            fs::read_to_string(self.dir.join("state/log")).unwrap_or_default()
        }
    }

    fn report(output: &Output) -> String {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout.clone()).unwrap()
    }

    #[test]
    fn a_refused_read_only_mount_stays_out_of_the_report_and_the_overlay_is_read_read_only() {
        let guest = Guest::new("ro-refused");
        guest.flag("ro-refused");
        let output = guest.run();
        let text = report(&output);
        assert!(!text.contains("mount warning"), "{text}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("would change RO state"));
        assert_eq!(
            guest.log(),
            "mount ro\nmount \nmount remount,bind,ro\numount\n"
        );
        let inventory = evaluate(&text, &[]).unwrap();
        assert!(
            inventory.unexpected.is_empty(),
            "{:?}",
            inventory.unexpected
        );
    }

    #[test]
    fn a_read_only_mount_that_succeeds_is_used_as_is() {
        let guest = Guest::new("ro-allowed");
        let text = report(&guest.run());
        assert_eq!(guest.log(), "mount ro\numount\n");
        assert!(evaluate(&text, &[]).unwrap().unexpected.is_empty());
    }

    #[test]
    fn nothing_is_read_when_the_mount_cannot_be_made_read_only() {
        let guest = Guest::new("remount-refused");
        guest.flag("ro-refused");
        guest.flag("remount-refused");
        let output = guest.run();
        assert!(!output.status.success());
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(!text.contains("upper_"), "{text}");
        assert_eq!(
            guest.log(),
            "mount ro\nmount \nmount remount,bind,ro\numount\n"
        );
    }

    #[test]
    fn nothing_is_read_when_the_remount_leaves_the_mount_writable() {
        let guest = Guest::new("remount-noop");
        guest.flag("ro-refused");
        guest.flag("remount-noop");
        let output = guest.run();
        assert!(!output.status.success());
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(!text.contains("upper_"), "{text}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not mounted read-only"));
        assert_eq!(
            guest.log(),
            "mount ro\nmount \nmount remount,bind,ro\numount\n"
        );
    }
}
