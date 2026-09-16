//! Execute the production recovery block; guest metadata/lock checks are qualified separately.
use std::{fs, process::Command};

#[test]
fn interrupted_fence_publication_requires_canonical_same_generation_transition() {
    let source = include_str!("../src/provider/graph/relay-fence.sh");
    let recovery = source
        .split(" # Resume only complete,")
        .nth(1)
        .unwrap()
        .split(" case \"$action\" in\n start)")
        .next()
        .unwrap();
    let script = format!(
        "set -efu\ncontrol=$1; action=$2; phase=$3; serial=7; seen=7; allocation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; previous=$allocation\nprivate_file() {{ test -f \"$1\"; }}\n # Resume only complete,{recovery}"
    );
    let root = std::env::temp_dir().join(format!("hack-fence-contract-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let allocation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (phase, next) in [
        ("preparing", "launching"),
        ("preparing", "discarding"),
        ("discarding", "discarding"),
        ("discarding", "discarded"),
        ("discarded", "discarded"),
        ("launching", "closing"),
        ("closing", "closing"),
        ("closing", "stopped"),
        ("stopped", "closing"),
    ] {
        for action in ["stop", "remove", "start", "inspect"] {
            let before = format!("7 {allocation} {phase}\n");
            let pending = format!("7 {allocation} {next}\n");
            fs::write(root.join("state"), &before).unwrap();
            fs::write(root.join("pending"), &pending).unwrap();
            let status = Command::new("/bin/sh")
                .args(["-c", &script, "fence-test"])
                .arg(&root)
                .args([action, phase])
                .output()
                .unwrap()
                .status;
            let allowed = matches!(action, "stop" | "remove");
            assert_eq!(status.success(), allowed, "{action}: {phase} -> {next}");
            if allowed {
                assert!(!root.join("pending").exists());
                assert_eq!(fs::read_to_string(root.join("state")).unwrap(), pending);
            } else {
                assert_eq!(fs::read_to_string(root.join("state")).unwrap(), before);
                assert_eq!(fs::read_to_string(root.join("pending")).unwrap(), pending);
            }
        }
    }
    for pending in [
        format!("7 {allocation} closing"),
        format!("7 {allocation} closing\n\n"),
        format!("8 {allocation} closing\n"),
        "7 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb closing\n".into(),
        format!("7 {allocation} stopped\n"),
        format!("7 {allocation} closing extra\n"),
        String::new(),
    ] {
        let before = format!("7 {allocation} launching\n");
        fs::write(root.join("state"), &before).unwrap();
        fs::write(root.join("pending"), &pending).unwrap();
        assert!(
            !Command::new("/bin/sh")
                .args(["-c", &script, "fence-test"])
                .arg(&root)
                .args(["stop", "launching"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(fs::read_to_string(root.join("state")).unwrap(), before);
        assert_eq!(fs::read_to_string(root.join("pending")).unwrap(), pending);
    }
    fs::remove_dir_all(root).unwrap();
}
