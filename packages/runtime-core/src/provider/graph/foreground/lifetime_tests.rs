//! Production owner event handling and real native publisher; no guest or VM.
use super::*;
use crate::provider::process::native_publisher_tests::NativePublisher;
use std::{
    fs,
    io::Read,
    os::{
        fd::AsFd,
        unix::{fs::DirBuilderExt, net::UnixListener, process::CommandExt},
    },
    process::{Command, Stdio},
};
const PROBE: &str = "provider::graph::foreground::lifetime_tests::lifetime_probe";

#[test]
fn frontend_loss_wakes_owner_and_confirms_native_publisher_cleanup() {
    exercise("frontend");
}
#[test]
fn publisher_crash_wakes_owner_and_confirms_cleanup_before_frontend_exit() {
    exercise("publisher");
}
fn exercise(cause: &str) {
    // Use the same canonical, short socket parent as the native publisher probe.
    let root = fs::canonicalize("/tmp")
        .unwrap()
        .join(format!("owner-loss-{}-{cause}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", PROBE, "--nocapture"])
        .env("HACK_OWNER_LIFETIME_ROLE", "frontend")
        .env("HACK_OWNER_LIFETIME_CAUSE", cause)
        .env("HACK_OWNER_LIFETIME_ROOT", &root)
        .env("HOME", &root)
        .env("XDG_CONFIG_HOME", &root)
        .env("XDG_STATE_HOME", &root)
        .env("XDG_CACHE_HOME", &root)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env("HACK_NO_INTERACTIVE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready.json").exists() {
        assert!(parent.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    if cause == "frontend" {
        drop(parent.stdin.take());
    }
    while !root.join("stopped.json").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let stopped: Value =
        serde_json::from_slice(&fs::read(root.join("stopped.json")).unwrap()).unwrap();
    assert_eq!(stopped["publisher_absent"], true);
    drop(parent.stdin.take());
    assert!(parent.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lifetime_probe() {
    let Ok(role) = std::env::var("HACK_OWNER_LIFETIME_ROLE") else {
        return;
    };
    let root = std::path::PathBuf::from(std::env::var_os("HACK_OWNER_LIFETIME_ROOT").unwrap());
    if role == "frontend" {
        // This helper must exit before its owner. Waiting here would prevent
        // the frontend-loss event under test; the owner has a five-second deadline.
        #[allow(
            clippy::zombie_processes,
            reason = "frontend exits first; bounded owner is reparented"
        )]
        let _owner = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", PROBE, "--nocapture"])
            .env("HACK_OWNER_LIFETIME_ROLE", "owner")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
        return;
    }
    let listener = UnixListener::bind(root.join("owner.sock")).unwrap();
    let events = signals::Events::new_descriptor(listener.as_fd()).unwrap();
    events.watch_frontend().unwrap();
    let mut publisher = NativePublisher::new(root.join("pub"));
    events.watch_child(&publisher.child).unwrap();
    fs::write(root.join("ready.json"), b"{}").unwrap();
    let crashed = std::env::var("HACK_OWNER_LIFETIME_CAUSE").as_deref() == Ok("publisher");
    if crashed {
        publisher.child.kill().unwrap();
    }
    let wake = events.wait_until(Some(Instant::now() + Duration::from_secs(5)));
    // Clean our owned publisher even when the wake assertion fails.
    if crashed {
        publisher.confirm_crash();
        assert_eq!(wake.unwrap(), signals::Wake::PublisherExit);
    } else {
        publisher.stop();
        assert!(matches!(
            wake.unwrap(),
            signals::Wake::Signal | signals::Wake::FrontendExit
        ));
    }
    fs::write(root.join("stopped.json"), b"{\"publisher_absent\":true}").unwrap();
}
