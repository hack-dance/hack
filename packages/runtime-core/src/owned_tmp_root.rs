//! Panic-safe cleanup of the per-run owner roots that macOS tests create in `/private/tmp`.
//!
//! The foreground transport (`hkgf-<24 hex>`) and the relay startup runtime
//! (`hkro-<24 hex>`) derive a short, fixed owner root for each run under `/private/tmp`.
//! Product code never removes these roots. A test that creates one owns it, and an
//! end-of-test `remove_dir_all(..).unwrap()` leaks it whenever an earlier assertion panics.
//! [`OwnedTmpRoot`] removes the root when it drops, including during unwinding.
//!
//! The guard accepts only those two exact name shapes, so it can never remove anything
//! else. The source check below keeps new test code from introducing an owner root
//! without either the guard or an auditable `// owner-root: <reason>` marker.

use std::{
    fs,
    ops::Deref,
    path::{Path, PathBuf},
};

/// Owner-root name prefixes this guard may remove.
const PREFIXES: [&str; 2] = ["/private/tmp/hkgf-", "/private/tmp/hkro-"];
/// Lowercase hexadecimal digest characters in an owner-root name.
const DIGEST_LEN: usize = 24;

/// A test-owned owner root, removed (best effort) when the guard drops.
///
/// Create the guard as soon as the path is known, before anything can create the
/// directory, so a panic at any later point still removes it. The directory need not
/// exist; removing an absent root is a no-op. A guard owns the path even if a product
/// path or a child process created the directory: create it only in the process that
/// owns the test's cleanup.
#[derive(Debug)]
pub(crate) struct OwnedTmpRoot(PathBuf);

impl OwnedTmpRoot {
    /// Take ownership of `path`.
    ///
    /// # Panics
    ///
    /// Panics unless `path` is exactly `/private/tmp/hkgf-<24 lowercase hex>` or
    /// `/private/tmp/hkro-<24 lowercase hex>`.
    #[track_caller]
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        assert!(
            is_owner_root(&path),
            "E_OWNED_TMP_ROOT: refusing to own a path that is not a test owner root: {}",
            path.display()
        );
        Self(path)
    }
}

fn is_owner_root(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    PREFIXES.iter().any(|prefix| {
        text.strip_prefix(prefix).is_some_and(|digest| {
            digest.len() == DIGEST_LEN
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    })
}

impl Deref for OwnedTmpRoot {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for OwnedTmpRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for OwnedTmpRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

mod tests {
    use super::{OwnedTmpRoot, is_owner_root};
    use std::path::{Path, PathBuf};

    const HEX: &str = "0123456789abcdef01234567";

    #[test]
    fn accepts_only_exact_owner_root_names() {
        for prefix in ["hkgf", "hkro"] {
            // Checked without a guard: dropping one would remove a directory
            // this test never created.
            assert!(is_owner_root(Path::new(&format!(
                "/private/tmp/{prefix}-{HEX}"
            ))));
        }
        for refused in [
            "/private/tmp/hkgf-0123456789ABCDEF01234567".to_owned(),
            format!("/private/tmp/hkgf-{}", &HEX[..23]),
            format!("/private/tmp/hkgf-{HEX}0"),
            format!("/private/tmp/hkgf-{HEX}/"),
            format!("/private/tmp/hkgf-{HEX}/child"),
            format!("/private/tmp/hkgf-{}g", &HEX[..23]),
            format!("/private/tmp/hkl-{HEX}"),
            format!("/private/tmp/hkgfx{HEX}"),
            format!("/tmp/hkgf-{HEX}"),
            format!("/private/tmp/../tmp/hkgf-{HEX}"),
            format!("private/tmp/hkro-{HEX}"),
            "/private/tmp".to_owned(),
            "/".to_owned(),
            String::new(),
        ] {
            let path = PathBuf::from(&refused);
            assert!(
                std::panic::catch_unwind(|| OwnedTmpRoot::new(path)).is_err(),
                "{refused:?}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn drop_removes_the_owned_root_even_while_unwinding() {
        use std::{fs, io::Read};
        let mut bytes = [0; 12];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let digest: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = PathBuf::from(format!("/private/tmp/hkgf-{digest}"));
        let owned = path.clone();
        let unwound = std::panic::catch_unwind(move || {
            let root = OwnedTmpRoot::new(owned);
            fs::DirBuilder::new().create(&*root).unwrap();
            fs::write(root.join("owner.json"), b"fixture").unwrap();
            panic!("assertion before end-of-test cleanup");
        });
        assert!(unwound.is_err());
        assert!(!path.exists());
        // Absence is not an error.
        drop(OwnedTmpRoot::new(path));
    }
}

/// Source check: test code that names an owner root also owns its cleanup.
///
/// The rule is deliberately small and closed so a reviewer can audit every exception.
/// In test code (a file named `tests.rs`, `*_tests.rs` or `*_test.rs`, a file under a
/// `native_test/` or `tests/` directory, or the remainder of a file after its first
/// `#[cfg(test)]`-attributed inline `mod *test*`/`*tests` block), every non-comment line
/// that names an owner root must either construct [`OwnedTmpRoot`] in the same statement
/// or carry a reviewed marker, `// owner-root: <reason>`, in that statement or on the line
/// directly above it. A line names an owner root when it contains one of:
///
/// - the literal prefixes `"/private/tmp/hkgf-` or `"/private/tmp/hkro-`;
/// - `transport::root(`, `root_from_state(` or `selected_root(`;
/// - a call to the free functions `control_root(`, `process_control_root(` or
///   `legacy_control_root(`, plain or path-qualified (not a `.control_root` field or method);
/// - a free call `root(&candidate, &`, the foreground transport's own owner-root
///   function as its test modules call it.
///
/// A statement is the run of lines from just after the previous line ending in `;`, `{`
/// or `}` through the next line ending in `;` or `{`. The check reads source text and can
/// miss a root reached through another name (for example a guard field such as
/// `Reservation::root`); it keeps the known producers honest, not every path.
mod source_check {
    use std::{fs, path::Path};

    /// Accepted reasons. Each names why a site needs no guard of its own.
    const MARKERS: [&str; 3] = [
        // Computes or inspects a path but never creates the directory, or a fixture
        // or other guard that this test holds already owns the directory.
        "// owner-root: path-only",
        // The test removes the root itself as the behaviour under test.
        "// owner-root: deliberate removal",
        // A guard for this path is constructed later in the same function.
        "// owner-root: guarded below",
    ];
    const NEEDLES: [&str; 5] = [
        "\"/private/tmp/hkgf-",
        "\"/private/tmp/hkro-",
        "transport::root(",
        "root_from_state(",
        "selected_root(",
    ];
    /// Needles that count only as calls of a free function (a plain or path-qualified
    /// name), not after another identifier character or a `.` field or method access.
    const FREE_CALLS: [&str; 4] = [
        "control_root(",
        "process_control_root(",
        "legacy_control_root(",
        "root(&candidate, &",
    ];

    fn free_call(line: &str, needle: &str) -> bool {
        line.match_indices(needle).any(|(at, _)| {
            line[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !(before.is_alphanumeric() || before == '_' || before == '.'))
        })
    }

    fn names_owner_root(line: &str) -> bool {
        let code = line.trim_start();
        !code.starts_with("//")
            && (NEEDLES.iter().any(|needle| code.contains(needle))
                || FREE_CALLS.iter().any(|needle| free_call(code, needle)))
    }

    fn whole_file_is_test(relative: &Path) -> bool {
        let name = relative
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        name == "tests.rs"
            || name.ends_with("_tests.rs")
            || name.ends_with("_test.rs")
            || relative.parent().is_some_and(|parent| {
                parent.components().any(|component| {
                    matches!(
                        component.as_os_str().to_str(),
                        Some("native_test" | "tests")
                    )
                })
            })
    }

    /// First line of the first `#[cfg(test)]`-attributed inline test module, if any.
    fn inline_test_module(lines: &[&str]) -> Option<usize> {
        (1..lines.len()).find(|&index| {
            let attribute = lines[index - 1].trim();
            let item = lines[index].trim();
            let Some(rest) = item.strip_suffix('{') else {
                return false;
            };
            let rest = rest.trim_end();
            let name = rest.rsplit(' ').next().unwrap_or("");
            attribute.starts_with("#[cfg(")
                && attribute.contains("test")
                && rest.contains("mod ")
                && name.contains("test")
        })
    }

    fn violations(relative: &Path, source: &str) -> Vec<String> {
        let lines: Vec<&str> = source.lines().collect();
        let start = if whole_file_is_test(relative) {
            0
        } else {
            match inline_test_module(&lines) {
                Some(start) => start,
                None => return Vec::new(),
            }
        };
        let mut found = Vec::new();
        for index in start..lines.len() {
            if !names_owner_root(lines[index]) {
                continue;
            }
            let mut first = index;
            while first > start && !lines[first - 1].trim_end().ends_with([';', '{', '}']) {
                first -= 1;
            }
            let mut last = index;
            while last + 1 < lines.len() && !lines[last].trim_end().ends_with([';', '{']) {
                last += 1;
            }
            let statement = &lines[first..=last];
            let above = first.checked_sub(1).map(|line| lines[line]);
            let marked = |line: &str| MARKERS.iter().any(|marker| line.contains(marker));
            let guarded = statement.iter().any(|line| line.contains("OwnedTmpRoot"));
            if !(guarded || statement.iter().any(|line| marked(line)) || above.is_some_and(marked))
            {
                found.push(format!(
                    "{}:{}: {}",
                    relative.display(),
                    index + 1,
                    lines[index].trim()
                ));
            }
        }
        found
    }

    fn walk(root: &Path, directory: &Path, found: &mut Vec<String>, scanned: &mut usize) {
        let mut entries: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(root, &path, found, scanned);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let relative = path.strip_prefix(root).unwrap();
                // This module names every needle in its own rule text.
                if relative == Path::new("src/owned_tmp_root.rs") {
                    continue;
                }
                *scanned += 1;
                found.extend(violations(relative, &fs::read_to_string(&path).unwrap()));
            }
        }
    }

    #[test]
    fn test_code_that_names_an_owner_root_owns_its_cleanup() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let (mut found, mut scanned) = (Vec::new(), 0);
        walk(root, &root.join("src"), &mut found, &mut scanned);
        assert!(scanned > 100, "source walk found only {scanned} files");
        assert!(
            found.is_empty(),
            "test code names a /private/tmp owner root without `OwnedTmpRoot::new` in the \
             same statement or a reviewed `// owner-root: <reason>` marker ({}):\n{}",
            MARKERS.join(", "),
            found.join("\n")
        );
    }

    #[test]
    fn the_rule_flags_unguarded_sites_and_accepts_guards_and_markers() {
        let test = Path::new("src/provider/graph/foreground/tests.rs");
        let flagged = |source: &str| violations(test, source).len();
        assert_eq!(
            flagged("fn t() {\n    let r = transport::root(&c, &run).unwrap();\n}\n"),
            1
        );
        assert_eq!(
            flagged("fn t() {\n    let r = root(&candidate, &run).unwrap();\n}\n"),
            1
        );
        assert_eq!(
            flagged(
                "fn t() {\n    let r = startup::control_root(\n        a,\n    )\n    .unwrap();\n}\n"
            ),
            1
        );
        assert_eq!(
            flagged("fn t() {\n    let r = process_control_root(&s, &o, \"b\", &r, &p);\n}\n"),
            1
        );
        assert_eq!(
            flagged(
                "fn t() {\n    let r = OwnedTmpRoot::new(\n        transport::root(&c, &run).unwrap(),\n    );\n}\n"
            ),
            0
        );
        assert_eq!(
            flagged(
                "fn t() {\n    // owner-root: path-only\n    let r = transport::root(&c, &run).unwrap();\n}\n"
            ),
            0
        );
        assert_eq!(
            flagged(
                "fn t() {\n    // owner-root: unreviewed reason\n    let r = transport::root(&c, &run).unwrap();\n}\n"
            ),
            1
        );
        // Fields, methods and other functions with similar names are not producers.
        assert_eq!(
            flagged(
                "fn t() {\n    let r = s.control_root.clone();\n    let a = owned_root(&candidate, &run);\n    let b = artifact::root(&candidate);\n}\n"
            ),
            0
        );
        // Product code before a file's inline test module is outside the rule.
        let product = Path::new("src/provider/graph/startup/runtime.rs");
        let source = "fn root() {\n    format!(\"/private/tmp/hkro-{}\", d);\n}\n#[cfg(test)]\nmod owner_scope_tests {\n    let r = control_root(s);\n}\n";
        assert_eq!(violations(product, source).len(), 1);
        assert!(
            violations(product, source)[0].starts_with("src/provider/graph/startup/runtime.rs:6:")
        );
    }
}
