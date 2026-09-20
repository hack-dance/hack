use super::*;
use hack_runtime_core::project::{self, PlanOptions};
use std::{collections::BTreeMap, fs, io::Read, path::PathBuf};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn plan_capture_preserves_mountpoints_registry_and_content_edits_without_secrets() {
    let root = std::env::temp_dir().join(format!(
        "hk-capture-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let fixture = Fixture(root);
    let source = fixture.0.join("project");
    fs::create_dir(&source).unwrap();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    fs::write(source.join(".gitignore"), "node_modules/\n.npmrc\n").unwrap();
    fs::create_dir(source.join("node_modules")).unwrap();
    fs::write(
        source.join("node_modules/private"),
        "excluded-dependency-canary",
    )
    .unwrap();
    fs::write(source.join(".env"), "TOKEN=excluded-secret-canary").unwrap();
    fs::write(source.join("bun.lock"), "{}").unwrap();
    fs::write(source.join("app.js"), "export default 'before';").unwrap();
    let registry = "@scope:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n";
    fs::write(source.join(".npmrc"), registry).unwrap();
    fs::write(source.join("compose.yaml"), "services:\n  web:\n    image: fixture\n    labels:\n      hack.dependencies.cache-volume: deps\n    volumes:\n      - .:/app:ro\n      - deps:/app/node_modules\nvolumes:\n  deps: {}\n").unwrap();
    let plan = || {
        project::plan(
            &candidate,
            PlanOptions {
                project: &source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap()
        .plan
    };
    let initial = plan();
    let before = capture_plan_source(&initial).unwrap();
    before.receipt().verify_mountpoints(&initial).unwrap();
    before.receipt().verify_registry(&initial).unwrap();
    assert!(
        before
            .receipt()
            .entries
            .iter()
            .any(|entry| entry.path == "node_modules" && entry.kind == "directory")
    );
    let archive = before.archive().unwrap();
    let mut tar = tar::Archive::new(archive.as_slice());
    let mut files = BTreeMap::new();
    for item in tar.entries().unwrap() {
        let mut item = item.unwrap();
        let name = item.path().unwrap().to_string_lossy().into_owned();
        let mut data = Vec::new();
        item.read_to_end(&mut data).unwrap();
        files.insert(name, data);
    }
    assert!(
        files[".npmrc"]
            .windows(b"${GITHUB_TOKEN}".len())
            .any(|bytes| bytes == b"${GITHUB_TOKEN}")
    );
    assert!(!files.contains_key(".env") && !files.contains_key("node_modules/private"));
    assert!(!files.values().any(|data| {
        data.windows(b"excluded-secret-canary".len())
            .any(|part| part == b"excluded-secret-canary")
    }));
    fs::write(
        source.join("app.js"),
        "export default 'after ordinary edit';",
    )
    .unwrap();
    let changed = plan();
    let after = capture_plan_source(&changed).unwrap();
    assert_ne!(before.receipt().revision, after.receipt().revision);
    after.receipt().verify_mountpoints(&changed).unwrap();
    after.receipt().verify_registry(&changed).unwrap();
    assert_eq!(fs::read_to_string(source.join(".npmrc")).unwrap(), registry);
    assert_eq!(
        fs::read_to_string(source.join("node_modules/private")).unwrap(),
        "excluded-dependency-canary"
    );
}

#[test]
fn plan_capture_materializes_reviewed_next_declarations_without_reading_ignored_files() {
    let root = std::env::temp_dir().join(format!(
        "hk-generated-capture-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let fixture = Fixture(root);
    let source = fixture.0.join("project");
    fs::create_dir_all(source.join("apps/www")).unwrap();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    fs::write(source.join(".gitignore"), "next-env.d.ts\n").unwrap();
    fs::write(source.join(".env"), "TOKEN=excluded-generated-canary").unwrap();
    let seed = concat!(
        "/// <reference types=\"next\" />\n",
        "/// <reference types=\"next/image-types/global\" />\n",
        "import \"./.next/dev/types/routes.d.ts\";\n",
        "import \"./.next/dev/types/root-params.d.ts\";\n",
        "\n// NOTE: This file should not be edited\n",
        "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n"
    );
    let document = serde_json::json!({
        "services": {"web": {
            "image": format!("sha256:{}", "a".repeat(64)),
            "network_mode": "none",
            "volumes": [".:/app:ro"]
        }},
        "x-hack-generated-files": {"apps/www/next-env.d.ts": seed}
    });
    fs::write(
        source.join("compose.yaml"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let plan = || {
        project::plan(
            &candidate,
            PlanOptions {
                project: &source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap()
        .plan
    };
    let review = plan();
    let initial = capture_plan_source(&review).unwrap();
    assert!(!source.join("apps/www/next-env.d.ts").exists());
    let generated = initial
        .files()
        .find(|(entry, _)| entry.path == "apps/www/next-env.d.ts")
        .unwrap();
    assert_eq!(generated.1, seed.as_bytes());
    assert_eq!(
        generated.0.sha256.as_deref(),
        Some("0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc")
    );
    fs::write(
        source.join("apps/www/next-env.d.ts"),
        "excluded-generated-canary",
    )
    .unwrap();
    let next = capture_plan_source(&plan()).unwrap();
    assert_eq!(initial.receipt().revision, next.receipt().revision);
    assert!(next.files().all(|(_, bytes)| {
        !bytes
            .windows(b"excluded-generated-canary".len())
            .any(|part| part == b"excluded-generated-canary")
    }));
    assert_eq!(
        fs::read_to_string(source.join("apps/www/next-env.d.ts")).unwrap(),
        "excluded-generated-canary"
    );
}
