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
