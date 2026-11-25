//! The context digest, its Docker ignore semantics and its stat cache, on temporary
//! trees only.
use super::*;
use crate::provider::image_build::GIB;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    time::Duration,
};

struct Tree {
    root: PathBuf,
}
impl Tree {
    /// `context/` with `main.txt`, `notes.log` and `sub/a.txt`, plus a private `state/`.
    fn new() -> Self {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = crate::test_root::private_test_root(&tmp, "hack-build-context");
        let tree = Self { root };
        fs::create_dir_all(tree.context().join("sub")).unwrap();
        tree.write("main.txt", "one");
        tree.write("notes.log", "log");
        tree.write("sub/a.txt", "a");
        tree
    }
    fn context(&self) -> PathBuf {
        self.root.join("context")
    }
    fn cache(&self) -> PathBuf {
        self.root.join("state").join(cache_name(&self.context()))
    }
    fn write(&self, path: &str, text: &str) {
        fs::write(self.context().join(path), text).unwrap();
    }
    fn digest(&self, ignore: &str) -> String {
        self.walk(ignore, None, SystemTime::now()).digest
    }
    fn walk(&self, ignore: &str, cache: Option<&Path>, now: SystemTime) -> ContextDigest {
        digest(
            &self.context(),
            ignore.as_bytes(),
            cache,
            now,
            Bounds::DEFAULT,
        )
        .unwrap()
    }
    /// Walk with the cache, stamped far enough ahead that every entry is settled.
    fn settled(&self) -> ContextDigest {
        let cache = self.cache();
        self.walk(
            "",
            Some(&cache),
            SystemTime::now() + Duration::from_secs(10),
        )
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Whether `rules` exclude `path`, deciding each ancestor first as the walk does.
fn excluded(rules: &str, path: &str) -> bool {
    let rules = ignore::Rules::parse(rules.as_bytes()).unwrap();
    let mut record = vec![false; rules.len()];
    let mut prefix = String::new();
    let mut result = false;
    for segment in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        let (excluded, next) = rules.decide(&prefix, &record).unwrap();
        result = excluded;
        record = next;
    }
    result
}

#[test]
fn a_slash_less_pattern_matches_only_at_the_root() {
    assert!(excluded("foo", "foo"));
    assert!(!excluded("foo", "x/foo"));
    assert!(excluded("*.txt", "a.txt"));
    assert!(!excluded("*.txt", "d/a.txt"));
    assert!(excluded("d/*.txt", "d/a.txt"));
    assert!(!excluded("d/*.txt", "d/e/a.txt"));
    assert!(excluded("?.txt", "a.txt"));
    assert!(!excluded("?.txt", "ab.txt"));
}

#[test]
fn double_stars_span_any_number_of_segments() {
    for path in ["foo", "x/foo", "x/y/foo"] {
        assert!(excluded("**/foo", path), "{path}");
    }
    assert!(!excluded("**/foo", "xfoo"));
    assert!(excluded("**/*.log", "x/y.log"));
    assert!(excluded("**/*.log", "y.log"));
    assert!(excluded("a/**/b", "a/b"));
    assert!(excluded("a/**/b", "a/x/y/b"));
    assert!(!excluded("a/**/b", "a/x/c"));
    assert!(excluded("a/**", "a/x/y"));
    assert!(!excluded("a/**", "a"));
    assert!(excluded("**", "anything/at/all"));
    assert!(excluded("*/**", "a/b"));
}

#[test]
fn a_matched_directory_excludes_everything_beneath_it_and_the_last_match_wins() {
    assert!(excluded("build", "build/x/y"));
    assert!(excluded("*.txt\n!keep.txt", "other.txt"));
    assert!(!excluded("*.txt\n!keep.txt", "keep.txt"));
    assert!(excluded("!keep.txt\n*.txt", "keep.txt"));
    assert!(!excluded("dist\n!dist/keep", "dist/keep"));
    assert!(excluded("dist\n!dist/keep", "dist/other"));
    // BuildKit records a pattern skipped at the parent as unmatched there (moby
    // MatchesUsingParentResults), so the final `a` does not re-exclude `a/b`.
    assert!(!excluded("a\n!a/b\na", "a/b"));
    assert!(excluded("a\n!a/b\na", "a/c"));
}

#[test]
fn patterns_are_parsed_and_cleaned_like_dockerignore() {
    for rules in [
        "/foo",
        "./foo",
        "foo/",
        "  foo  ",
        "\u{feff}foo",
        "foo\r\n",
        "x/../foo",
    ] {
        assert!(excluded(rules, "foo"), "{rules:?}");
    }
    assert!(!excluded("# foo", "# foo"));
    assert!(!excluded("#foo\n", "foo"));
    assert!(excluded("! foo\nfoo", "foo"));
    assert!(!excluded("foo\n! foo", "foo"));
    assert!(excluded("a.b", "a.b"));
    assert!(!excluded("a.b", "axb"));
    assert!(excluded("a+(b)", "a+(b)"));
}

#[test]
fn whitespace_exposed_by_cleaning_is_trimmed_as_moby_does() {
    // ReadAll strips the slash and exposes a space; New trims it before compiling.
    assert!(excluded("/ foo", "foo"));
    assert!(!excluded("/ foo", " foo"));
    // After a `!`, New's trim sees the `!` first, so the space stays.
    assert!(excluded("*\n!/ foo", "foo"));
    assert!(!excluded("*\n!/ foo", " foo"));
    // A `!` exposed by cleaning becomes a re-include in New.
    assert!(!excluded("*\n/ !foo", "foo"));
    assert!(excluded("*\n/ !foo", "!foo"));
    // Trailing whitespace exposed by cleaning is trimmed for both kinds.
    assert!(excluded("foo /", "foo"));
    assert!(!excluded("*\n!foo /", "foo"));

    // The walk agrees, with both names present.
    let tree = Tree::new();
    tree.write(" foo", "spaced");
    tree.write("foo", "plain");
    let before = tree.digest("/ foo\n");
    tree.write("foo", "plain edited");
    assert_eq!(before, tree.digest("/ foo\n"), "Docker ignores `foo`");
    tree.write(" foo", "spaced edited");
    assert_ne!(before, tree.digest("/ foo\n"), "Docker sends ` foo`");
}

#[test]
fn unsupported_syntax_excludes_nothing() {
    for rules in ["*.log\n[ab].txt", "\\*.log", "!", "a^b", "*.log\n\u{a0}x"] {
        let parsed = ignore::Rules::parse(rules.as_bytes()).unwrap();
        assert!(parsed.fallback, "{rules:?}");
        assert!(!excluded(rules, "x.log"), "{rules:?}");
    }
    assert!(ignore::Rules::parse(&[0xff, b'\n']).unwrap().fallback);
    assert!(!ignore::Rules::parse(b"*.log\n").unwrap().fallback);

    // The walk then hashes the full context.
    let tree = Tree::new();
    let fallback = "*.log\n[x]\n";
    let walked = tree.walk(fallback, None, SystemTime::now());
    assert!(walked.fallback);
    let before = walked.digest;
    tree.write("notes.log", "changed");
    assert_ne!(before, tree.digest(fallback));
}

#[test]
fn excluded_directories_without_reinclusions_are_never_walked() {
    let rules = ignore::Rules::parse(b"node_modules\n!src/keep\n").unwrap();
    assert!(!rules.may_include_below("node_modules").unwrap());
    assert!(rules.may_include_below("src").unwrap());
    assert!(
        ignore::Rules::parse(b"x\n!**/keep\n")
            .unwrap()
            .may_include_below("x")
            .unwrap()
    );

    let tree = Tree::new();
    fs::create_dir(tree.context().join("node_modules")).unwrap();
    let fifo = std::ffi::CString::new(
        tree.context()
            .join("node_modules/pipe")
            .as_os_str()
            .as_bytes(),
    )
    .unwrap();
    // SAFETY: a valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let error = digest(
        &tree.context(),
        b"",
        None,
        SystemTime::now(),
        Bounds::DEFAULT,
    )
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_special");
    assert!(!error.message.contains("pipe"));
    tree.digest("node_modules\n");
}

#[test]
fn copied_and_reincluded_files_change_the_digest_and_ignored_ones_do_not() {
    let tree = Tree::new();
    let original = tree.digest("*.log\n");
    tree.write("notes.log", "edited");
    assert_eq!(
        original,
        tree.digest("*.log\n"),
        "an ignored edit changed it"
    );
    tree.write("main.txt", "two");
    let edited = tree.digest("*.log\n");
    assert_ne!(original, edited);
    tree.write("sub/a.txt", "b");
    assert_ne!(edited, tree.digest("*.log\n"));

    tree.write("keep.log", "1");
    let kept = tree.digest("*.log\n!keep.log\n");
    tree.write("keep.log", "2");
    assert_ne!(kept, tree.digest("*.log\n!keep.log\n"));
    // The rules themselves are bound separately; here they change the included set.
    assert_ne!(tree.digest("*.log\n"), tree.digest(""));
}

#[test]
fn metadata_symlinks_directories_and_names_change_the_digest() {
    let tree = Tree::new();
    let context = tree.context();
    let mut seen = vec![tree.digest("")];
    let mut changed = |label: &str| {
        let next = tree.digest("");
        assert!(!seen.contains(&next), "{label} kept the digest");
        seen.push(next);
    };
    fs::set_permissions(context.join("main.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    changed("a mode change");
    std::os::unix::fs::symlink("main.txt", context.join("link")).unwrap();
    changed("a new symlink");
    fs::remove_file(context.join("link")).unwrap();
    std::os::unix::fs::symlink("sub/a.txt", context.join("link")).unwrap();
    changed("a symlink target change");
    fs::create_dir(context.join("empty")).unwrap();
    changed("a new empty directory");
    fs::rename(context.join("sub/a.txt"), context.join("sub/b.txt")).unwrap();
    changed("a rename");
}

#[test]
fn symlinks_are_hashed_as_targets_and_never_followed() {
    let tree = Tree::new();
    let outside = tree.root.join("outside.txt");
    fs::write(&outside, "secret-one").unwrap();
    std::os::unix::fs::symlink(&outside, tree.context().join("out")).unwrap();
    let before = tree.digest("");
    fs::write(&outside, "secret-two").unwrap();
    assert_eq!(before, tree.digest(""));
}

#[test]
fn bounds_refuse_without_naming_paths() {
    let tree = Tree::new();
    let refuse =
        |bounds: Bounds| digest(&tree.context(), b"", None, SystemTime::now(), bounds).unwrap_err();
    let error = refuse(Bounds {
        entries: 3,
        bytes: GIB,
        visited: 1_000,
        ..Bounds::DEFAULT
    });
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(error.message.contains("200000 entries") && !error.message.contains("main"));
    let error = refuse(Bounds {
        entries: 100,
        bytes: 4,
        visited: 1_000,
        ..Bounds::DEFAULT
    });
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(error.message.contains("4 GiB"));
    assert_eq!(Bounds::DEFAULT.entries, 200_000);
    assert_eq!(Bounds::DEFAULT.bytes, 4 * GIB);
    assert_eq!(Bounds::DEFAULT.visited, 1_000_000);
}

#[test]
fn a_walk_through_ignored_directories_is_bounded_too() {
    let tree = Tree::new();
    let ignored = tree.context().join("deps");
    fs::create_dir_all(&ignored).unwrap();
    for index in 0..20 {
        fs::write(ignored.join(format!("f{index}")), "x").unwrap();
    }
    // A re-include under the ignored directory makes the walk enter it.
    let rules = b"deps\n!deps/keep\n";
    let error = digest(
        &tree.context(),
        rules,
        None,
        SystemTime::now(),
        Bounds {
            entries: 1_000,
            bytes: GIB,
            visited: 10,
            ..Bounds::DEFAULT
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(error.message.contains("1000000 entries to examine"));
}

#[test]
fn a_flat_directory_over_the_visit_budget_refuses_while_listing() {
    let tree = Tree::new();
    let flat = tree.context().join("flat");
    fs::create_dir(&flat).unwrap();
    for index in 0..50 {
        fs::write(flat.join(format!("f{index}")), "x").unwrap();
    }
    let bounds = |visited| Bounds {
        entries: 1_000,
        bytes: GIB,
        visited,
        ..Bounds::DEFAULT
    };
    // Root (4 names) + sub (1) + flat (50) = 55 names in all.
    let error = digest(&tree.context(), b"", None, SystemTime::now(), bounds(20)).unwrap_err();
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(!error.message.contains("flat"));
    assert!(digest(&tree.context(), b"", None, SystemTime::now(), bounds(55)).is_ok());
    assert!(digest(&tree.context(), b"", None, SystemTime::now(), bounds(54)).is_err());
}

/// Walk with `hook` run on every file between open and read.
fn walk_with_hook(
    tree: &Tree,
    mut hook: impl FnMut(&Path) + 'static,
) -> Result<ContextDigest, CandidateError> {
    // The seam reports the entry's relative path; hand the test its full path.
    let context = tree.context();
    AFTER_OPEN.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |relative: &Path| {
            hook(&context.join(relative))
        }))
    });
    let result = digest(
        &tree.context(),
        b"",
        None,
        SystemTime::now(),
        Bounds::DEFAULT,
    );
    AFTER_OPEN.with(|slot| *slot.borrow_mut() = None);
    result
}

#[test]
fn a_file_that_changes_while_it_is_read_refuses() {
    let tree = Tree::new();
    // Grows: more bytes than listed are never hashed.
    let error = walk_with_hook(&tree, |path| {
        if path.ends_with("main.txt") {
            let mut file = OpenOptions::new().append(true).open(path).unwrap();
            file.write_all(&[b'x'; 200_000]).unwrap();
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_changed");
    assert!(!error.message.contains("main"));
    // Rewritten at the same size: the final status differs from the listing.
    let error = walk_with_hook(&tree, |path| {
        if path.ends_with("sub/a.txt") {
            std::thread::sleep(Duration::from_millis(20));
            fs::write(path, "b").unwrap();
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_changed");
    // Shrinks: fewer bytes than listed.
    let error = walk_with_hook(&tree, |path| {
        if path.ends_with("notes.log") {
            OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(1)
                .unwrap();
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_changed");
    // Untouched files walk cleanly.
    assert!(walk_with_hook(&tree, |_| {}).is_ok());
}

#[test]
fn unreadable_entries_refuse() {
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return; // root reads mode-000 files
    }
    let tree = Tree::new();
    let path = tree.context().join("main.txt");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    let error = digest(
        &tree.context(),
        b"",
        None,
        SystemTime::now(),
        Bounds::DEFAULT,
    )
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_unreadable");
    assert!(!error.message.contains("main"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn an_unchanged_tree_reads_no_file_contents_from_a_settled_cache() {
    let tree = Tree::new();
    let first = tree.settled();
    assert_eq!(first.files_read, 3);
    assert_eq!(first.entries, 5);
    let mode = fs::metadata(tree.cache()).unwrap().mode();
    assert_eq!(mode & 0o777, 0o600);
    let second = tree.settled();
    assert_eq!(second.files_read, 0, "an unchanged file was read again");
    assert_eq!(second.digest, first.digest);
    // The cache never changes the result.
    assert_eq!(second.digest, tree.digest(""));

    // A rewritten file is read again, and only that file.
    tree.write("main.txt", "a longer body");
    let third = tree.settled();
    assert_eq!(third.files_read, 1);
    assert_ne!(third.digest, first.digest);

    // A pure timestamp change re-reads the file but keeps the digest.
    let path =
        std::ffi::CString::new(tree.context().join("sub/a.txt").as_os_str().as_bytes()).unwrap();
    let times = [
        libc::timespec {
            tv_sec: 1_000_000,
            tv_nsec: 0,
        },
        libc::timespec {
            tv_sec: 1_000_000,
            tv_nsec: 0,
        },
    ];
    // SAFETY: a valid path and two timespecs, as utimensat requires.
    assert_eq!(
        unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
        0
    );
    let fourth = tree.settled();
    assert_eq!(fourth.files_read, 1);
    assert_eq!(fourth.digest, third.digest);
    assert_eq!(tree.settled().files_read, 0);
}

#[test]
fn racy_entries_are_read_again() {
    let tree = Tree::new();
    let cache = tree.cache();
    // Stamped now: every file was modified within the racy window of the write.
    let first = tree.walk("", Some(&cache), SystemTime::now());
    assert_eq!(first.files_read, 3);
    let second = tree.walk("", Some(&cache), SystemTime::now());
    assert_eq!(second.files_read, 3, "a racy entry was trusted");
    assert_eq!(second.digest, first.digest);
    // Trust needs both timestamps strictly older than the write time minus 2 s.
    let at = |seconds: i64| Stat(1, 2, 3, seconds, 0, seconds, 0, 0o100_644);
    let written = Stat::nanos(1_000, 0);
    assert!(!at(998).settled_before(written));
    assert!(at(997).settled_before(written));
    assert!(Stat(1, 2, 3, 997, 999_999_999, 997, 999_999_999, 0).settled_before(written));
    assert!(!Stat(1, 2, 3, 900, 0, 999, 0, 0).settled_before(written));
    assert!(!Stat(1, 2, 3, 999, 0, 900, 0, 0).settled_before(written));
}

#[test]
fn corrupt_foreign_and_other_version_caches_are_ignored_and_rewritten() {
    let tree = Tree::new();
    let cache = tree.cache();
    tree.settled();
    for damage in ["garbage", "mode", "version", "context"] {
        match damage {
            "garbage" => fs::write(&cache, b"{not json").unwrap(),
            "mode" => fs::set_permissions(&cache, fs::Permissions::from_mode(0o644)).unwrap(),
            _ => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
                if damage == "version" {
                    value["version"] = 99.into();
                } else {
                    value["context"] = "0".repeat(64).into();
                }
                fs::write(&cache, serde_json::to_vec(&value).unwrap()).unwrap();
            }
        }
        let walked = tree.settled();
        assert_eq!(walked.files_read, 3, "{damage} cache was trusted");
        assert_eq!(
            tree.settled().files_read,
            0,
            "{damage} cache was not rewritten"
        );
    }
    // A malformed hash invalidates the whole cache.
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
    value["entries"]["main.txt"][1] = "z".repeat(64).into();
    fs::write(&cache, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(tree.settled().files_read, 3, "an invalid hash was trusted");
}

#[test]
fn a_snapshot_holds_exactly_the_keyed_entries_and_is_removed() {
    let tree = Tree::new();
    let context = tree.context();
    fs::set_permissions(context.join("main.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("sub/a.txt", context.join("link")).unwrap();
    fs::create_dir(context.join("empty")).unwrap();
    fs::create_dir(context.join("locked")).unwrap();
    fs::write(context.join("locked/inner"), "x").unwrap();
    fs::set_permissions(context.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();
    let keyed = tree.walk("*.log\n", None, SystemTime::now());
    let holder = tree.root.join("snapshot");
    let snapshot = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| None)
        .unwrap()
        .unwrap();
    let mode = fs::metadata(&holder).unwrap().mode();
    assert_eq!(mode & 0o777, 0o700);
    // Every entry, the root, directories, files and symlinks alike, has the one fixed
    // time: times are not in the key, so they must not reach the image either.
    // (Checked before anything reads the copy, which would update access times.)
    for entry in [
        "",
        "main.txt",
        "sub",
        "sub/a.txt",
        "empty",
        "locked",
        "locked/inner",
        "link",
    ] {
        let path = snapshot.context().join(entry);
        let copy = fs::symlink_metadata(&path).unwrap();
        assert_eq!(
            (
                copy.mtime(),
                copy.mtime_nsec(),
                copy.atime(),
                copy.atime_nsec()
            ),
            (snapshot::SNAPSHOT_TIME, 0, snapshot::SNAPSHOT_TIME, 0),
            "{entry:?}"
        );
    }

    // Re-walking the copy with no rules gives the keyed digest: same entries (the
    // ignored file was never copied), kinds, modes, contents and targets.
    let copied = digest(
        &snapshot.context(),
        b"",
        None,
        SystemTime::now(),
        Bounds::DEFAULT,
    )
    .unwrap();
    assert_eq!(copied.digest, keyed.digest);
    assert!(!snapshot.context().join("notes.log").exists());
    drop(snapshot);
    assert!(!holder.exists(), "the snapshot outlived its guard");
    fs::set_permissions(context.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_snapshot_refuses_any_difference_from_the_record() {
    let tree = Tree::new();
    let context = tree.context();
    std::os::unix::fs::symlink("main.txt", context.join("link")).unwrap();
    let holder = tree.root.join("snapshot");
    let attempt = |change: &dyn Fn()| {
        let keyed = tree.walk("", None, SystemTime::now());
        change();
        let error =
            snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| None).unwrap_err();
        assert!(!holder.exists(), "a refused snapshot was left behind");
        error.code
    };
    let same_size = || fs::write(context.join("main.txt"), "two").unwrap();
    assert_eq!(attempt(&same_size), "native_build_context_changed");
    let grown = || fs::write(context.join("main.txt"), "a longer body").unwrap();
    assert_eq!(attempt(&grown), "native_build_context_changed");
    let mode = || {
        fs::set_permissions(context.join("main.txt"), fs::Permissions::from_mode(0o700)).unwrap()
    };
    assert_eq!(attempt(&mode), "native_build_context_changed");
    let retarget = || {
        fs::remove_file(context.join("link")).unwrap();
        std::os::unix::fs::symlink("sub/a.txt", context.join("link")).unwrap();
    };
    assert_eq!(attempt(&retarget), "native_build_context_changed");
    let gone = || fs::remove_file(context.join("sub/a.txt")).unwrap();
    assert_eq!(attempt(&gone), "native_build_context_changed");
    let swapped = || {
        fs::remove_file(context.join("main.txt")).unwrap();
        std::os::unix::fs::symlink("notes.log", context.join("main.txt")).unwrap();
    };
    assert_eq!(attempt(&swapped), "native_build_context_changed");
    // A stop request ends the copy cleanly, with nothing left.
    let keyed = tree.walk("", None, SystemTime::now());
    let calls = std::cell::Cell::new(0);
    let stopped = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| {
        calls.set(calls.get() + 1);
        (calls.get() > 2).then_some(snapshot::Stopped::Canceled)
    })
    .unwrap()
    .unwrap_err();
    assert_eq!(stopped, snapshot::Stopped::Canceled);
    assert!(!holder.exists());
}

#[test]
fn a_copy_whose_mode_cannot_be_reproduced_refuses() {
    let tree = Tree::new();
    // The injected loss must change the mode even when the fixture was created under 077.
    for target in ["main.txt", "sub"] {
        let path = tree.context().join(target);
        let mode = fs::symlink_metadata(&path).unwrap().mode() & 0o7777;
        fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o004)).unwrap();
    }
    let keyed = tree.walk("", None, SystemTime::now());
    let holder = tree.root.join("snapshot");
    for target in ["main.txt", "sub"] {
        snapshot::BEFORE_MODE_CHECK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |path: &Path| {
                if path.ends_with(target) {
                    let mode = fs::symlink_metadata(path).unwrap().mode() & 0o7777;
                    fs::set_permissions(path, fs::Permissions::from_mode(mode & !0o004)).unwrap();
                }
            }));
        });
        let error = snapshot::Snapshot::create(&tree.context(), &holder, &keyed.recorded, &|| None)
            .unwrap_err();
        snapshot::BEFORE_MODE_CHECK.with(|slot| *slot.borrow_mut() = None);
        assert_eq!(error.code, "native_build_context_copy", "{target}");
        assert!(!error.message.contains(target));
        assert!(!holder.exists());
    }
}

#[test]
fn a_large_file_copy_stops_between_chunks() {
    let tmp = std::env::temp_dir().canonicalize().unwrap();
    let root = crate::test_root::private_test_root(&tmp, "hack-snapshot-chunks");
    let context = root.join("context");
    fs::create_dir(&context).unwrap();
    fs::write(context.join("big"), vec![b'x'; 4 * 1024 * 1024]).unwrap();
    let keyed = digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT).unwrap();
    assert_eq!(keyed.recorded.len(), 2);
    // Two entries poll twice; the third poll can only come from inside the file copy.
    let polls = std::cell::Cell::new(0);
    let holder = root.join("snapshot");
    let stopped = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| {
        polls.set(polls.get() + 1);
        (polls.get() >= 3).then_some(snapshot::Stopped::Expired)
    })
    .unwrap()
    .unwrap_err();
    assert_eq!(stopped, snapshot::Stopped::Expired);
    assert!(!holder.exists());
    fs::remove_dir_all(&root).unwrap();
}

const HOST_SECRET: &str = "host-only-secret-bytes";

/// A tree whose `sub` holds two files, plus a directory outside the context.
fn swappable() -> (Tree, PathBuf) {
    let tree = Tree::new();
    tree.write("sub/b.txt", "b");
    let outside = tree.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("a.txt"), HOST_SECRET).unwrap();
    fs::write(outside.join("b.txt"), HOST_SECRET).unwrap();
    fs::write(outside.join("secret"), HOST_SECRET).unwrap();
    (tree, outside)
}

/// Rename the context's `sub` away and plant a symlink to `outside` in its place.
fn swap(context: &Path, outside: &Path) {
    fs::rename(context.join("sub"), context.join("sub-moved")).unwrap();
    std::os::unix::fs::symlink(outside, context.join("sub")).unwrap();
}

fn secret_hash() -> [u8; 32] {
    let mut out = [0_u8; 32];
    out.copy_from_slice(Sha256::digest(HOST_SECRET.as_bytes()).as_slice());
    out
}

fn holds_no_secret(recorded: &[Entry]) {
    for entry in recorded {
        assert!(
            !matches!(&entry.kind, Kind::File(hash, _) if *hash == secret_hash()),
            "outside content was hashed"
        );
        assert_ne!(entry.path, b"sub/secret".to_vec());
    }
}

#[test]
fn a_directory_swapped_for_a_symlink_before_the_walk_enters_it_refuses() {
    let (tree, outside) = swappable();
    let context = tree.context();
    let fired = std::rc::Rc::new(std::cell::Cell::new(0));
    let (hook_context, hook_outside, hook_fired) =
        (context.clone(), outside.clone(), std::rc::Rc::clone(&fired));
    BEFORE_DESCEND.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |relative: &[u8]| {
            if relative == b"sub" {
                hook_fired.set(hook_fired.get() + 1);
                swap(&hook_context, &hook_outside);
            }
        }))
    });
    let result = digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT);
    BEFORE_DESCEND.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(fired.get(), 1, "the swap never happened");
    match result {
        Err(error) => assert_eq!(error.code, "native_build_context_changed"),
        Ok(walked) => holds_no_secret(&walked.recorded),
    }
}

#[test]
fn a_directory_swapped_after_the_walk_entered_it_keeps_being_read() {
    let (tree, outside) = swappable();
    let context = tree.context();
    let (hook_context, hook_outside) = (context.clone(), outside.clone());
    let mut swapped = false;
    let walked = walk_with_hook(&tree, move |path| {
        if !swapped && path.parent().is_some_and(|p| p.ends_with("sub")) {
            swapped = true;
            swap(&hook_context, &hook_outside);
        }
    })
    .unwrap();
    holds_no_secret(&walked.recorded);
    // Both files of the original directory were read through its descriptor.
    let paths: Vec<&[u8]> = walked.recorded.iter().map(|e| e.path.as_slice()).collect();
    assert!(paths.contains(&b"sub/a.txt".as_slice()) && paths.contains(&b"sub/b.txt".as_slice()));
    assert!(context.join("sub").is_symlink());
}

#[test]
fn a_context_path_through_a_symlink_refuses() {
    let tree = Tree::new();
    let link = tree.root.join("link");
    std::os::unix::fs::symlink(tree.context(), &link).unwrap();
    for path in [link.clone(), link.join("sub")] {
        let error = digest(&path, b"", None, SystemTime::now(), Bounds::DEFAULT).unwrap_err();
        assert_eq!(
            error.code,
            "native_build_context_changed",
            "{}",
            path.display()
        );
    }
}

#[test]
fn a_snapshot_never_copies_through_a_swapped_directory() {
    // Swapped before the copy enters it: refused, nothing left.
    let (tree, outside) = swappable();
    let context = tree.context();
    let keyed = tree.walk("", None, SystemTime::now());
    let holder = tree.root.join("snapshot");
    let (hook_context, hook_outside) = (context.clone(), outside.clone());
    BEFORE_DESCEND.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |relative: &[u8]| {
            if relative == b"sub" {
                swap(&hook_context, &hook_outside);
            }
        }))
    });
    let result = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| None);
    BEFORE_DESCEND.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(result.unwrap_err().code, "native_build_context_changed");
    assert!(!holder.exists());

    // Swapped after the copy entered it: the held descriptor keeps reading the
    // original directory, and no outside byte reaches the copy.
    let (tree, outside) = swappable();
    let context = tree.context();
    let keyed = tree.walk("", None, SystemTime::now());
    let holder = tree.root.join("snapshot");
    let (hook_context, hook_outside) = (context.clone(), outside.clone());
    let mut swapped = false;
    snapshot::BEFORE_MODE_CHECK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |path: &Path| {
            if !swapped && path.ends_with("sub/a.txt") {
                swapped = true;
                swap(&hook_context, &hook_outside);
            }
        }))
    });
    let created = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| None);
    snapshot::BEFORE_MODE_CHECK.with(|slot| *slot.borrow_mut() = None);
    let created = created.unwrap().unwrap();
    assert!(context.join("sub").is_symlink(), "the swap never happened");
    let copy = created.context();
    assert_eq!(fs::read_to_string(copy.join("sub/a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(copy.join("sub/b.txt")).unwrap(), "b");
    assert!(!copy.join("sub/secret").exists());
    assert!(!copy.join("sub").is_symlink());
}

fn bounds_code(bytes: &[u8]) -> &'static str {
    match ignore::Rules::parse(bytes) {
        Ok(_) => "ok",
        Err(error) => error.code,
    }
}

/// Three hundred rules of the kinds real projects use.
fn realistic_rules() -> String {
    let mut rules = String::new();
    for index in 0..60 {
        rules.push_str(&format!("generated{index}\n"));
        rules.push_str(&format!("**/cache{index}\n"));
        rules.push_str(&format!("*.tmp{index}\n"));
        rules.push_str(&format!("build/out{index}/**\n"));
        rules.push_str(&format!("!build/out{index}/keep*.txt\n"));
    }
    rules
}

/// A synthetic relative path for entry `index`, as a walk would decide it.
fn synthetic(index: usize) -> String {
    format!(
        "src/module{}/sub{}/file{index}.rs",
        index % 97,
        (index / 97) % 13
    )
}

#[test]
fn an_adversarial_ignore_file_refuses_at_parse_with_bounded_work() {
    // About 1 MB of `??` rules (the ignore reader's limit), each a valid pattern.
    let rule = "??\n";
    let adversarial = rule.repeat(349_000);
    assert!(adversarial.len() as u64 <= 1024 * 1024);
    let error = ignore::Rules::parse(adversarial.as_bytes()).unwrap_err();
    assert_eq!(error.code, "native_build_ignore_bounds");
    // Allow a full line-length scan (including the trailing empty line), then
    // only enough normalization and compilation to reach the first excess rule.
    let max_work = adversarial.len() + 1 + (ignore::MAX_RULES + 1) * rule.len();
    let work = ignore::PARSE_LINE_WORK.get();
    assert!(
        (1..=max_work).contains(&work),
        "line work {work} outside 1..={max_work}"
    );

    // A missing context would fail to open if the walk touched it before refusing.
    let tree = Tree::new();
    let error = digest(
        &tree.context().join("missing"),
        adversarial.as_bytes(),
        None,
        SystemTime::now(),
        Bounds::DEFAULT,
    )
    .unwrap_err();
    assert_eq!(error.code, "native_build_ignore_bounds");
    assert!(!error.message.contains("??"));
}

#[test]
fn the_match_budget_stops_a_walk_with_the_most_rules() {
    // At the rule limit the file parses, but the walk's work is bounded.
    let rules = ignore::Rules::parse("??\n".repeat(ignore::MAX_RULES).as_bytes())
        .unwrap()
        .with_budget(1_000_000);
    let started = std::time::Instant::now();
    let record = vec![false; rules.len()];
    let mut decided = 0;
    let error = loop {
        match rules.decide(&synthetic(decided), &record) {
            Ok(_) => decided += 1,
            Err(error) => break error,
        }
    };
    assert_eq!(error.code, "native_build_ignore_bounds");
    // It stopped within one entry's work of the budget.
    assert!(decided > 0 && rules.work() <= 1_000_000 + 4 * 1024 * 1024);
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "{:?}",
        started.elapsed()
    );
    // The real budget lets 4096 rules decide a small context.
    let tree = Tree::new();
    assert!(
        digest(
            &tree.context(),
            "??\n".repeat(ignore::MAX_RULES).as_bytes(),
            None,
            SystemTime::now(),
            Bounds::DEFAULT
        )
        .is_ok()
    );
}

#[test]
fn a_realistic_ignore_file_stays_far_inside_the_budget() {
    let rules = ignore::Rules::parse(realistic_rules().as_bytes()).unwrap();
    assert_eq!(rules.len(), 300);
    let mut record = vec![false; rules.len()];
    const SAMPLE: usize = 5_000;
    for index in 0..SAMPLE {
        // Children inherit their parent's record, as in the walk.
        let (_, next) = rules.decide(&synthetic(index), &record).unwrap();
        if index % 50 == 0 {
            record = next;
        }
    }
    // Scaled to a 200,000-entry context, the work stays under a third of the budget.
    let per_entry = rules.work() / SAMPLE as u64;
    assert!(
        per_entry * 200_000 * 3 < ignore::WORK_BUDGET,
        "{per_entry} units per entry"
    );
}

#[test]
fn ignore_bounds_are_exact() {
    let lines = |count: usize, rule: &str| format!("{rule}\n").repeat(count);
    assert_eq!(bounds_code(lines(ignore::MAX_RULES, "a").as_bytes()), "ok");
    assert_eq!(
        bounds_code(lines(ignore::MAX_RULES + 1, "a").as_bytes()),
        "native_build_ignore_bounds"
    );
    // Comments and blank lines are not rules.
    let commented = format!("{}# note\n\n", lines(ignore::MAX_RULES, "a"));
    assert_eq!(bounds_code(commented.as_bytes()), "ok");
    // Pattern text: 256 rules of 1024 bytes is exactly the total.
    let long = "a".repeat(ignore::MAX_PATTERN_BYTES);
    let total = lines(ignore::MAX_PATTERN_TEXT / ignore::MAX_PATTERN_BYTES, &long);
    assert_eq!(bounds_code(total.as_bytes()), "ok");
    assert_eq!(
        bounds_code(format!("{total}b\n").as_bytes()),
        "native_build_ignore_bounds"
    );
    let longer = "a".repeat(ignore::MAX_PATTERN_BYTES + 1);
    assert_eq!(bounds_code(long.as_bytes()), "ok");
    assert_eq!(bounds_code(longer.as_bytes()), "native_build_ignore_bounds");
    // Docker's scanner fits a line, its `\r` and its `\n` in 64 KiB; a longer one is
    // refused even as a comment, whitespace or the last line.
    let buffer = 64 * 1024;
    let fits = |content: usize, end: &str| format!("#{}{end}", "c".repeat(content - 1));
    assert_eq!(bounds_code(fits(buffer - 1, "\n").as_bytes()), "ok");
    assert_eq!(
        bounds_code(fits(buffer, "\n").as_bytes()),
        "native_build_ignore_bounds"
    );
    assert_eq!(bounds_code(fits(buffer - 2, "\r\n").as_bytes()), "ok");
    assert_eq!(
        bounds_code(fits(buffer - 1, "\r\n").as_bytes()),
        "native_build_ignore_bounds"
    );
    assert_eq!(
        bounds_code(fits(buffer, "").as_bytes()),
        "native_build_ignore_bounds"
    );
    let blank = format!("{}\n", " ".repeat(buffer));
    assert_eq!(bounds_code(blank.as_bytes()), "native_build_ignore_bounds");
    // Segments and wildcards per pattern.
    let segments = |count: usize| vec!["s"; count].join("/");
    assert_eq!(bounds_code(segments(ignore::MAX_SEGMENTS).as_bytes()), "ok");
    assert_eq!(
        bounds_code(segments(ignore::MAX_SEGMENTS + 1).as_bytes()),
        "native_build_ignore_bounds"
    );
    let wild = |count: usize| "?".repeat(count);
    assert_eq!(bounds_code(wild(ignore::MAX_WILDCARDS).as_bytes()), "ok");
    assert_eq!(
        bounds_code(wild(ignore::MAX_WILDCARDS + 1).as_bytes()),
        "native_build_ignore_bounds"
    );
    // A file Hack cannot reproduce still excludes nothing rather than refusing.
    assert!(ignore::Rules::parse(b"[ab]\n").unwrap().fallback);
    assert_eq!(
        (
            ignore::MAX_RULES,
            ignore::MAX_PATTERN_TEXT,
            ignore::MAX_PATTERN_BYTES,
            ignore::MAX_SEGMENTS,
            ignore::MAX_WILDCARDS,
            ignore::WORK_BUDGET
        ),
        (4096, 256 * 1024, 1024, 64, 32, 1_000_000_000)
    );
}

#[test]
fn rules_after_an_unsupported_pattern_still_count_against_the_bounds() {
    // BuildKit matches every rule, so the fallback must not lift any bound.
    for unsupported in ["[ab].txt", "\\*.log", "!", "x\u{a0}y"] {
        let over_rules = format!("{unsupported}\n{}", "a\n".repeat(ignore::MAX_RULES));
        assert_eq!(
            bounds_code(over_rules.as_bytes()),
            "native_build_ignore_bounds",
            "{unsupported:?} + rules"
        );
        let long = "a".repeat(ignore::MAX_PATTERN_BYTES);
        let over_text = format!(
            "{unsupported}\n{}b\n",
            format!("{long}\n").repeat(ignore::MAX_PATTERN_TEXT / ignore::MAX_PATTERN_BYTES)
        );
        assert_eq!(
            bounds_code(over_text.as_bytes()),
            "native_build_ignore_bounds",
            "{unsupported:?} + text"
        );
        let over_wild = format!("{unsupported}\n{}\n", "?".repeat(ignore::MAX_WILDCARDS + 1));
        assert_eq!(
            bounds_code(over_wild.as_bytes()),
            "native_build_ignore_bounds",
            "{unsupported:?} + wildcards"
        );
        // A small rule set after it still takes the fallback (excludes nothing).
        let small = format!("{unsupported}\n*.log\nbuild\n!build/keep\n");
        let rules = ignore::Rules::parse(small.as_bytes()).unwrap();
        assert!(rules.fallback, "{unsupported:?}");
        assert_eq!(rules.len(), 0);
    }
    // The unsupported pattern itself counts too, and so does invalid UTF-8.
    let at_limit = format!("[ab]\n{}", "a\n".repeat(ignore::MAX_RULES - 1));
    assert!(ignore::Rules::parse(at_limit.as_bytes()).unwrap().fallback);
    let mut invalid = vec![0xff, b'\n'];
    invalid.extend("a\n".repeat(ignore::MAX_RULES).as_bytes());
    assert_eq!(bounds_code(&invalid), "native_build_ignore_bounds");
    // A wildcard-heavy unsupported pattern is bounded like any other.
    assert_eq!(
        bounds_code(format!("[{}]\n", "*".repeat(ignore::MAX_WILDCARDS)).as_bytes()),
        "native_build_ignore_bounds"
    );
}

#[test]
fn hard_links_are_part_of_the_key_and_recreated_in_the_snapshot() {
    let tree = Tree::new();
    let context = tree.context();
    let unlinked = tree.digest("");
    // `sub/twin` and `main.txt` become one inode: the key changes although every
    // name's content, mode and path set would otherwise match a copy.
    fs::hard_link(context.join("main.txt"), context.join("sub/twin")).unwrap();
    let linked = tree.walk("", None, SystemTime::now());
    fs::remove_file(context.join("sub/twin")).unwrap();
    fs::copy(context.join("main.txt"), context.join("sub/twin")).unwrap();
    let copied = tree.digest("");
    assert_ne!(linked.digest, copied, "link structure is not in the key");
    assert_ne!(copied, unlinked);
    fs::remove_file(context.join("sub/twin")).unwrap();
    fs::hard_link(context.join("main.txt"), context.join("sub/twin")).unwrap();
    let relinked = tree.walk("", None, SystemTime::now());
    assert_eq!(relinked.digest, linked.digest);
    let twin = relinked
        .recorded
        .iter()
        .find(|entry| entry.path == b"sub/twin")
        .unwrap();
    assert_eq!(twin.link.as_deref(), Some(b"main.txt".as_slice()));
    // A link to a name outside the included set is a plain file.
    let ignored = tree.walk("main.txt\n", None, SystemTime::now());
    assert!(ignored.recorded.iter().all(|entry| entry.link.is_none()));

    // The snapshot holds one inode for both names, equal to its key.
    let holder = tree.root.join("snapshot");
    let snapshot = snapshot::Snapshot::create(&context, &holder, &relinked.recorded, &|| None)
        .unwrap()
        .unwrap();
    let copy = snapshot.context();
    let (first, second) = (
        fs::symlink_metadata(copy.join("main.txt")).unwrap(),
        fs::symlink_metadata(copy.join("sub/twin")).unwrap(),
    );
    assert_eq!((first.dev(), first.ino()), (second.dev(), second.ino()));
    assert_eq!(first.nlink(), 2);
    let again = digest(&copy, b"", None, SystemTime::now(), Bounds::DEFAULT).unwrap();
    assert_eq!(again.digest, relinked.digest);
    drop(snapshot);

    // A link broken after the key walk refuses instead of copying two files.
    fs::remove_file(context.join("sub/twin")).unwrap();
    fs::copy(context.join("main.txt"), context.join("sub/twin")).unwrap();
    let error =
        snapshot::Snapshot::create(&context, &holder, &relinked.recorded, &|| None).unwrap_err();
    assert_eq!(error.code, "native_build_context_changed");
    assert!(!holder.exists());
}

/// Nest `levels` directories named `d` under `root` with `mkdirat`, one component at a
/// time, as a container writing a shared folder would (the full path can exceed
/// `PATH_MAX`), with a file `leaf` at the bottom.
fn deep_tree(root: &Path, levels: usize) {
    let mut directory = fsat::Dir::open(root).unwrap();
    for _ in 0..levels {
        directory.mkdir(b"d", 0o755).unwrap();
        directory = directory.dir(b"d").unwrap();
    }
    directory
        .create(b"leaf", 0o644)
        .unwrap()
        .write_all(b"x")
        .unwrap();
}

/// Remove what [`deep_tree`] made, bottom up through descriptors.
fn remove_deep_tree(root: &Path, levels: usize) {
    let mut directory = fsat::Dir::open(root).unwrap();
    for _ in 0..levels {
        directory = directory.dir(b"d").unwrap();
    }
    directory.remove(b"leaf", false).unwrap();
    for _ in 0..levels {
        let parent = directory.dir(b"..").unwrap();
        parent.remove(b"d", true).unwrap();
        directory = parent;
    }
}

fn peak_path_bytes() -> usize {
    PEAK_PATH_BYTES.with(std::cell::Cell::get)
}

#[test]
fn a_tree_deeper_than_the_bound_refuses_with_little_held() {
    let tree = Tree::new();
    let context = tree.context();
    deep_tree(&context, 3_000);
    let result = digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT);
    let peak = peak_path_bytes();
    remove_deep_tree(&context, 3_000);
    let error = result.unwrap_err();
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(
        error.message.contains("256 path components"),
        "{}",
        error.message
    );
    // Fixed text: it names the limit, never a path.
    assert!(error.message_fixed && !error.message.contains("d/d"));
    // It stopped at the depth bound: about 256 paths of up to 512 bytes, never the
    // 9 MB a 3,000-level walk would hold.
    assert!(peak < 256 * 1024, "{peak} path bytes held");
}

#[test]
fn a_tree_within_the_depth_bound_hashes_and_snapshots() {
    let tree = Tree::new();
    let context = tree.context();
    deep_tree(&context, 200);
    let keyed = digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT).unwrap();
    assert!(peak_path_bytes() <= MAX_PATH_BYTES);
    let leaf = format!("{}leaf", "d/".repeat(200));
    assert!(
        keyed
            .recorded
            .iter()
            .any(|entry| entry.path == leaf.as_bytes())
    );
    let holder = tree.root.join("snapshot");
    let snapshot = snapshot::Snapshot::create(&context, &holder, &keyed.recorded, &|| None)
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(snapshot.context().join(&leaf)).unwrap(), b"x");
    drop(snapshot);
    remove_deep_tree(&context, 200);
    // One level past the bound refuses; exactly at it passes.
    deep_tree(&context, MAX_DEPTH - 1);
    assert!(digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT).is_ok());
    remove_deep_tree(&context, MAX_DEPTH - 1);
    deep_tree(&context, MAX_DEPTH);
    let refused = digest(&context, b"", None, SystemTime::now(), Bounds::DEFAULT);
    remove_deep_tree(&context, MAX_DEPTH);
    assert_eq!(refused.unwrap_err().code, "native_build_context_bounds");
}

#[test]
fn included_paths_over_their_byte_bound_refuse() {
    let tree = Tree::new();
    let wide = tree.context().join("wide");
    fs::create_dir(&wide).unwrap();
    for index in 0..40 {
        fs::write(wide.join(format!("{index:03}{}", "n".repeat(200))), "x").unwrap();
    }
    let walk = |path_bytes| {
        digest(
            &tree.context(),
            b"",
            None,
            SystemTime::now(),
            Bounds {
                path_bytes,
                ..Bounds::DEFAULT
            },
        )
    };
    let error = walk(4_000).unwrap_err();
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(error.message.contains("32 MiB"), "{}", error.message);
    assert!(peak_path_bytes() <= 4_000);
    assert!(!error.message.contains("nnnn"));
    assert!(walk(64 * 1024).is_ok());
    assert_eq!(MAX_DEPTH, 256);
    assert_eq!(MAX_PATH_BYTES, 32 * 1024 * 1024);
}

#[test]
fn a_cache_with_paths_over_the_bounds_is_ignored() {
    let tree = Tree::new();
    let cache = tree.cache();
    tree.settled();
    assert_eq!(tree.settled().files_read, 0);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
    let template = value["entries"]["main.txt"].clone();
    value["entries"][format!("{}x", "a/".repeat(MAX_DEPTH))] = template;
    fs::write(&cache, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        tree.settled().files_read,
        3,
        "an over-deep cache was trusted"
    );
    // It was rewritten within the bounds and is trusted again.
    assert_eq!(tree.settled().files_read, 0);
}

#[test]
fn deep_snapshot_uses_bounded_descriptor_headroom() {
    crate::provider::test_executable::run_isolated(
        "provider::image_build::context::tests::deep_snapshot_at_fixed_descriptor_limits",
        crate::provider::test_executable::ISOLATED_HANG_GUARD,
    );
}

#[test]
#[ignore = "isolated descriptor-limit fixture launched by deep_snapshot_uses_bounded_descriptor_headroom"]
fn deep_snapshot_at_fixed_descriptor_limits() {
    let limit = libc::rlimit {
        rlim_cur: 256,
        rlim_max: 10_240,
    };
    // SAFETY: this is a single-test child and limit points to initialized storage.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
    let tree = Tree::new();
    let leaf = tree.context().join("d/".repeat(200));
    fs::create_dir_all(&leaf).unwrap();
    fs::write(leaf.join("file"), "payload").unwrap();
    let keyed = tree.walk("", None, SystemTime::now());
    let error = snapshot::Snapshot::create(
        &tree.context(),
        &tree.root.join("low"),
        &keyed.recorded,
        &|| None,
    )
    .unwrap_err();
    assert_eq!(error.code, "native_build_context_descriptor_limit");

    crate::raise_open_file_limit();
    let mut observed = limit;
    // SAFETY: observed is writable storage for the current child's limit.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut observed) },
        0
    );
    assert_eq!((observed.rlim_cur, observed.rlim_max), (10_240, 10_240));
    let snapshot = snapshot::Snapshot::create(
        &tree.context(),
        &tree.root.join("raised"),
        &keyed.recorded,
        &|| None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        fs::read(snapshot.context().join("d/".repeat(200)).join("file")).unwrap(),
        b"payload"
    );

    let system_limit = std::io::Error::from_raw_os_error(libc::ENFILE);
    assert_eq!(
        read_error(system_limit).code,
        "native_build_context_descriptor_limit"
    );
}
