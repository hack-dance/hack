//! Cache quarantine is opt-in and single-target: its exact argument shape and
//! reviewed selection are checked before any provider access.
use serde_json::Value;
use std::{fs, path::Path, process::Command};

fn run(home: &Path, arguments: &[String]) -> (Option<i32>, Value) {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .arg("--candidate-root")
        .arg(&checkout)
        .args(arguments)
        .env_clear()
        .env("PATH", "/nonexistent")
        .env("HOME", home)
        .output()
        .unwrap();
    assert!(output.stdout.is_empty(), "{arguments:?}");
    (
        output.status.code(),
        serde_json::from_slice(&output.stderr).unwrap(),
    )
}

#[test]
fn cache_quarantine_requires_one_exact_target_and_reviewed_selection() {
    let home = std::env::temp_dir().join(format!(
        "hack-cache-quarantine-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&home).unwrap();
    let strings = |values: &[&str]| values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    let run_id = "a".repeat(32);
    let full = strings(&[
        "graph",
        "quarantine-cache",
        "--run-id",
        &run_id,
        "--volume",
        "www_next",
        "--path",
        "dev/cache/turbopack",
        "--expect-selection",
        &"b".repeat(64),
        "--json",
    ]);
    let mut cases = Vec::new();
    for flag in ["--run-id", "--volume", "--path", "--expect-selection"] {
        let mut missing = full.clone();
        let index = missing.iter().position(|value| value == flag).unwrap();
        missing.drain(index..index + 2);
        cases.push(missing);
    }
    // A second target, repeated flag, reordered flags or unrelated mutation flag.
    let mut second = full.clone();
    second.extend(strings(&["--path", "dev/cache/images"]));
    cases.push(second);
    let mut duplicate = full.clone();
    duplicate.push("--json".into());
    cases.push(duplicate);
    let mut reordered = full.clone();
    reordered.swap(4, 6);
    reordered.swap(5, 7);
    cases.push(reordered);
    let mut remove = full.clone();
    remove.insert(10, "--remove-data".into());
    cases.push(remove);
    // Read-only selection takes no expected digest.
    let mut inspect = full.clone();
    inspect[1] = "inspect-cache-quarantine".into();
    cases.push(inspect.clone());
    inspect.truncate(8);
    inspect.push("--expect-selection".into());
    cases.push(inspect);
    // Resolution takes the same exact shape and never a mutation flag.
    let mut resolve = full.clone();
    resolve[1] = "resolve-cache-quarantine".into();
    let mut unreviewed = resolve.clone();
    unreviewed.drain(8..10);
    cases.push(unreviewed);
    let mut destructive = resolve.clone();
    destructive.insert(10, "--remove-data".into());
    cases.push(destructive);
    for arguments in cases {
        let (status, failure) = run(&home, &arguments);
        assert_eq!(status, Some(2), "{arguments:?}");
        assert_eq!(failure["code"], "graph_arguments", "{arguments:?}");
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
    // A malformed selection digest refuses before the provider is contacted.
    for (action, selection) in [
        "B".repeat(64),
        "b".repeat(63),
        "b".repeat(65),
        String::new(),
    ]
    .into_iter()
    .flat_map(|s| {
        [
            ("quarantine-cache", s.clone()),
            ("resolve-cache-quarantine", s),
        ]
    }) {
        let mut arguments = full.clone();
        arguments[1] = action.into();
        arguments[9] = selection;
        let (status, failure) = run(&home, &arguments);
        assert_eq!(status, Some(2), "{arguments:?}");
        assert_eq!(failure["code"], "graph_cache_quarantine", "{arguments:?}");
        // Closed, value-free diagnostic: no path or digest is echoed.
        let message = failure["message"].as_str().unwrap();
        assert!(!message.contains("turbopack") && !message.contains("www_next"));
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
    fs::remove_dir(&home).unwrap();
}
