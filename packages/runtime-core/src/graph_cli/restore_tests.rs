use super::*;
use std::{fs, path::PathBuf};

const RUN: &str = "11111111111111111111111111111111";
const PLAN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GENERATION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn shared_and_filtered_source_modes_cannot_be_combined_or_used_for_inspection() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let candidate = Candidate::discover(&root).unwrap();
    for args in [
        vec!["run", "--live-source", "--shared-source"],
        vec!["run", "--shared-source", "--live-source"],
        vec!["serve", "--shared-source", "--shared-source"],
        vec!["inspect", "--shared-source"],
        vec!["cleanup", "--shared-source"],
    ] {
        assert_eq!(
            command(&candidate, &args).unwrap_err().code,
            "graph_arguments"
        );
    }
}

fn valid() -> Vec<&'static str> {
    vec![
        "--run-id",
        RUN,
        "--expect-plan",
        PLAN,
        "--expect-generation",
        GENERATION,
        "--environment-stdin",
    ]
}

#[test]
fn owner_restore_requires_explicit_private_delivery_and_all_bound_identities() {
    let args = valid();
    let options = restore_options(&args).unwrap();
    assert_eq!(
        (options.run, options.plan, options.generation),
        (RUN, PLAN, GENERATION)
    );
    let reordered = [
        "--json",
        "--environment-stdin",
        "--expect-generation",
        GENERATION,
        "--expect-plan",
        PLAN,
        "--run-id",
        RUN,
    ];
    assert!(restore_options(&reordered).is_ok());
    for absent in [
        "--run-id",
        "--expect-plan",
        "--expect-generation",
        "--environment-stdin",
    ] {
        let mut args = valid();
        let index = args.iter().position(|value| *value == absent).unwrap();
        args.remove(index);
        if absent != "--environment-stdin" {
            args.remove(index);
        }
        assert_eq!(
            restore_options(&args).err().unwrap().code,
            "graph_arguments"
        );
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "hack-restore-args-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn owner_restore_invalid_cli_requests_refuse_before_stdin_or_state_effects() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let mut invalid_requests = Vec::new();
    for extra in [
        vec!["--project", "/does-not-exist"],
        vec!["--file", "compose.yaml"],
        vec!["--dependencies", "private.json"],
        vec!["--ready", "app=completed"],
        vec!["--remove-data"],
        vec!["--source-revision", PLAN],
        vec!["--timeout-seconds", "1"],
        vec!["--profile", "default"],
        vec!["--environment-stdin"],
        vec!["--run-id", RUN],
        vec!["--expect-plan", PLAN],
        vec!["--expect-generation", GENERATION],
        vec!["--json", "--json"],
        vec!["--unknown"],
    ] {
        let mut args = valid();
        args.extend(extra);
        invalid_requests.push(args);
    }
    for (index, value) in [
        (1, "short"),
        (1, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        (3, "bad"),
        (5, ""),
        (
            5,
            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ),
    ] {
        let mut args = valid();
        args[index] = value;
        invalid_requests.push(args);
    }
    invalid_requests.push(vec!["--run-id"]);
    invalid_requests.push(Vec::new());
    for mut args in invalid_requests {
        args.insert(0, "owner-restore");
        assert_eq!(
            command(&candidate, &args).unwrap_err().code,
            "graph_arguments"
        );
        assert!(!candidate.state_root.exists());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}

#[test]
#[cfg(not(target_os = "macos"))]
fn owner_restore_valid_arguments_remain_unsupported_without_reading_stdin() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let mut args = valid();
    args.insert(0, "owner-restore");
    assert_eq!(
        command(&candidate, &args).unwrap_err().code,
        "unsupported_host"
    );
    assert!(!candidate.state_root.exists());
}

#[test]
fn live_source_invalid_requests_refuse_before_stdin_or_state_effects() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    for action in ["run", "serve", "restart", "restore"] {
        for flags in [
            vec!["--live-source"],
            vec!["--live-source", "--source-revision", PLAN, "--live-source"],
        ] {
            let mut args = vec![action, "--run-id", RUN];
            if action == "serve" {
                args.push("--environment-stdin");
            }
            args.extend(flags);
            assert_eq!(
                command(&candidate, &args).unwrap_err().code,
                "graph_arguments"
            );
        }
    }
    for action in [
        "inspect",
        "reconcile",
        "cleanup",
        "archive",
        "export",
        "prune",
        "owner-status",
        "owner-restore",
        "dependency-plan",
        "storage-inventory",
        "reserve-bridge",
        "release-bridge",
        "start-bridge",
        "publish-bridge",
        "unpublish-bridge",
        "bridges",
        "reconcile-bridges",
        "reconcile-export",
    ] {
        assert_eq!(
            command(&candidate, &[action, "--live-source", "--run-id", RUN])
                .unwrap_err()
                .code,
            "graph_arguments"
        );
    }
    assert!(!candidate.state_root.exists());
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
}

#[test]
fn initializer_cache_release_invalid_selection_is_pre_effect() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    for action in ["restart", "restore", "cleanup", "inspect", "owner-status"] {
        assert_eq!(
            command(
                &candidate,
                &[
                    action,
                    "--run-id",
                    RUN,
                    "--release-initializer-cache",
                    "deps"
                ]
            )
            .unwrap_err()
            .code,
            "graph_arguments"
        );
    }
    for flags in [
        vec!["--release-initializer-cache"],
        vec!["--release-initializer-cache", "../deps"],
        vec![
            "--release-initializer-cache",
            "deps",
            "--release-initializer-cache",
            "deps",
        ],
    ] {
        let mut args = vec!["serve", "--run-id", RUN, "--environment-stdin"];
        args.extend(flags);
        assert_eq!(
            command(&candidate, &args).unwrap_err().code,
            "graph_arguments"
        );
    }
    assert!(!candidate.state_root.exists());
}

#[test]
fn stopped_normalized_restore_refuses_unscoped_or_replayed_effect_flags() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    for args in [
        vec![
            "serve-restore",
            "--run-id",
            RUN,
            "--project",
            "/absent",
            "--file",
            "compose.yml",
            "--expect-plan",
            PLAN,
            "--expect-generation",
            GENERATION,
        ],
        vec![
            "serve-restore",
            "--run-id",
            RUN,
            "--release-initializer-cache",
            "deps",
        ],
        vec!["restore-selection", "--run-id", RUN, "--environment-stdin"],
        vec![
            "restore-selection",
            "--run-id",
            RUN,
            "--expect-generation",
            GENERATION,
        ],
        vec!["restore-selection", "--run-id", RUN, "--remove-data"],
    ] {
        assert_eq!(
            command(&candidate, &args).unwrap_err().code,
            "graph_arguments"
        );
        assert!(!candidate.state_root.exists());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}
