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
    let rules = ignore::Rules::parse(rules.as_bytes());
    let mut record = vec![false; rules.len()];
    let mut prefix = String::new();
    let mut result = false;
    for segment in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        let (excluded, next) = rules.decide(&prefix, &record);
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
        let parsed = ignore::Rules::parse(rules.as_bytes());
        assert!(parsed.fallback, "{rules:?}");
        assert!(!excluded(rules, "x.log"), "{rules:?}");
    }
    assert!(ignore::Rules::parse(&[0xff, b'\n']).fallback);
    assert!(!ignore::Rules::parse(b"*.log\n").fallback);

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
    let rules = ignore::Rules::parse(b"node_modules\n!src/keep\n");
    assert!(!rules.may_include_below("node_modules"));
    assert!(rules.may_include_below("src"));
    assert!(ignore::Rules::parse(b"x\n!**/keep\n").may_include_below("x"));

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
    });
    assert_eq!(error.code, "native_build_context_bounds");
    assert!(error.message.contains("200000 entries") && !error.message.contains("main"));
    let error = refuse(Bounds {
        entries: 100,
        bytes: 4,
        visited: 1_000,
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
    let source = fs::metadata(context.join("main.txt")).unwrap();
    let copy = fs::metadata(snapshot.context().join("main.txt")).unwrap();
    assert_eq!(
        (copy.mtime(), copy.mtime_nsec()),
        (source.mtime(), source.mtime_nsec())
    );
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
