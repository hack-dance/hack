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
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
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
