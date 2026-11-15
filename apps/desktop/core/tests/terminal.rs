//! Scripts run only fake executables. Launch adapters record argv, never open GUI.
use hack_desktop_core::terminal::{CommandSpec, Launcher, Platform, Script};
use std::os::unix::fs::PermissionsExt;
use std::{
    ffi::OsString,
    io::{BufRead, Write},
    path::{Path, PathBuf},
};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "terminal-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Fake {
    calls: std::cell::RefCell<Vec<(PathBuf, Vec<OsString>)>>,
    fail: bool,
}
impl Launcher for Fake {
    fn launch(&self, p: &Path, a: &[OsString]) -> Result<(), String> {
        self.calls.borrow_mut().push((p.into(), a.into()));
        if self.fail {
            Err("fixture refused".into())
        } else {
            Ok(())
        }
    }
}
fn spec() -> CommandSpec {
    CommandSpec {
        program: "hack".into(),
        args: vec!["global".into(), "trust".into()],
    }
}
#[test]
fn private_script_fixed_adapters_and_failure_cleanup() {
    let t = Tree::new();
    let fake = Fake {
        calls: Default::default(),
        fail: true,
    };
    let script = Script::create(&t.0, &spec()).unwrap();
    let path = script.path().to_owned();
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(script.open(Platform::Mac, None, &fake).is_err());
    assert!(!path.exists());
    let calls = fake.calls.borrow();
    assert_eq!(calls[0].0, Path::new("/usr/bin/open"));
    assert_eq!(
        calls[0].1[..3],
        [
            OsString::from("-g"),
            OsString::from("-a"),
            OsString::from("Terminal")
        ]
    );
    drop(calls);
    let script = Script::create(&t.0, &spec()).unwrap();
    let path = script.path().to_owned();
    assert!(script.open(Platform::Linux, None, &fake).is_err());
    assert!(!path.exists());
    assert_eq!(fake.calls.borrow().len(), 1);
    let script = Script::create(&t.0, &spec()).unwrap();
    let fake = Fake {
        calls: Default::default(),
        fail: false,
    };
    let path = script.path().to_owned();
    script
        .open(
            Platform::Linux,
            Some(Path::new("/usr/bin/xdg-terminal-exec")),
            &fake,
        )
        .unwrap();
    assert_eq!(fake.calls.borrow()[0].1, vec![OsString::from(path)]);
}
#[test]
fn enter_required_quoted_argv_and_cleanup_after_command() {
    let t = Tree::new();
    let fake = t.0.join("fake hack");
    let marker = t.0.join("ran");
    std::fs::write(
        &fake,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$MARKER\"\nexit 7\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let values = vec![
        "a'b".into(),
        "$(touch forbidden); `id` $HOME".into(),
        "space argument".into(),
    ];
    let script = Script::create(
        &t.0,
        &CommandSpec {
            program: fake.to_str().unwrap().into(),
            args: values.clone(),
        },
    )
    .unwrap();
    let path = script.path().to_owned();
    let mut child = std::process::Command::new("/bin/sh")
        .arg(&path)
        .env("MARKER", &marker)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("fake hack"));
    line.clear();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("Press Enter"));
    assert!(!marker.exists());
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"\n").unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("Press Enter to close"));
    assert!(line.contains("exit 7"));
    assert!(
        child.try_wait().unwrap().is_none(),
        "output remains visible until close confirmation"
    );
    assert!(path.exists());
    input.write_all(b"\n").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(7));
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        format!("{}\n", values.join("\n"))
    );
    assert!(!path.exists());
    assert!(!path.parent().unwrap().exists());
}
#[test]
fn eof_cancels_and_controls_rejected() {
    let t = Tree::new();
    let script = Script::create(&t.0, &spec()).unwrap();
    let path = script.path().to_owned();
    let status = std::process::Command::new("/bin/sh")
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success());
    assert!(!path.exists());
    for bad in ["hack\nwhoami", "hack\0oops", ""] {
        assert!(
            Script::create(
                &t.0,
                &CommandSpec {
                    program: bad.into(),
                    args: vec![]
                }
            )
            .is_err()
        );
    }
}

#[test]
fn authored_sequence_waits_for_enter_runs_both_and_stops_on_failure() {
    for exit in [0, 3] {
        let t = Tree::new();
        let fake_program = t.0.join("fake-brew");
        let receipt = t.0.join("receipt");
        std::fs::write(
            &fake_program,
            format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RECEIPT\"\nexit {exit}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&fake_program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let specs: Vec<_> = hack_desktop_core::upgrade::homebrew_commands()
            .into_iter()
            .map(|mut c| {
                c.program = fake_program.to_str().unwrap().into();
                c
            })
            .collect();
        let script = Script::create_sequence(&t.0, &specs).unwrap();
        let mut child = std::process::Command::new(script.path())
            .env("RECEIPT", &receipt)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        assert!(!receipt.exists());
        child.stdin.take().unwrap().write_all(b"\n").unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(exit));
        assert_eq!(
            std::fs::read_to_string(receipt).unwrap(),
            if exit == 0 {
                "upgrade hack\nupgrade --cask hack-desktop\n"
            } else {
                "upgrade hack\n"
            }
        );
        assert!(!script.path().exists());
    }
}

#[test]
fn system_launcher_drains_launcher_output_and_passes_only_listed_environment() {
    // A stand-in launcher (no terminal opens): 256 KB on each stream would
    // fill an undrained pipe, so it can only finish if output is discarded.
    // HACK_HOME is set for the test process but is not on the launch list.
    assert!(
        std::env::var_os("HACK_HOME").is_some(),
        "precondition: run through scripts/test.sh"
    );
    let tree = Tree::new();
    let marker = tree.0.join("done");
    let script = format!(
        "head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2; printf '%s' \"${{HACK_HOME-unset}}\" > '{}'",
        marker.display()
    );
    hack_desktop_core::terminal::SystemLauncher
        .launch(
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from(script)],
        )
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while std::fs::read_to_string(&marker).map_or(true, |s| s.is_empty()) {
        assert!(
            std::time::Instant::now() < deadline,
            "launcher blocked on its output"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "unset");
}

#[test]
fn script_temp_root_writable_by_others_is_refused() {
    let tree = Tree::new();
    let spec = CommandSpec {
        program: "/usr/bin/true".into(),
        args: vec![],
    };
    let shared = tree.0.join("shared");
    std::fs::create_dir(&shared).unwrap();
    // Writable by others without the sticky bit: the private script directory
    // could be renamed away and replaced before the terminal reads it.
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Script::create(&shared, &spec).is_err());
    assert_eq!(
        std::fs::read_dir(&shared).unwrap().count(),
        0,
        "nothing created"
    );
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(Script::create(&shared, &spec).is_ok());
}

#[test]
fn script_uses_the_validated_root_not_a_replaceable_alias() {
    let tree = Tree::new();
    let spec = CommandSpec {
        program: "/usr/bin/true".into(),
        args: vec![],
    };
    let private = tree.0.join("private");
    let shared = tree.0.join("shared");
    for dir in [&private, &shared] {
        std::fs::create_dir(dir).unwrap();
    }
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
    // An alias in a directory others can change, pointing at a safe root.
    let alias = shared.join("alias");
    std::os::unix::fs::symlink(&private, &alias).unwrap();
    let script = Script::create(&alias, &spec).unwrap();
    let canonical = std::fs::canonicalize(&private).unwrap();
    assert!(
        script.path().starts_with(&canonical),
        "{} must not go through the alias",
        script.path().display()
    );
}
