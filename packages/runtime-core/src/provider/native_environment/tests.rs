use super::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::DirBuilderExt,
    sync::atomic::{AtomicU64, Ordering},
};
struct Fixture {
    root: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-environment-codec-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        Self { root, candidate }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn intent() -> Value {
    let boot = "12345678-abcd-abcd-abcd-123456789abc";
    json!({"version":2,"kind":"native-environment-allocation","binding":{"namespace":"a".repeat(64),"run":"b".repeat(32),"review":"c".repeat(64),"container":format!("hkn-{}-container-0","b".repeat(32))},"service":"web","uid":0,"gid":0,"slot":format!("hack-env-lease-{boot}-{}","d".repeat(32)),"incarnation":"e".repeat(32),"boot":boot})
}
#[test]
fn native_allocation_codec_has_no_compose_alias_and_refuses_unknown_private_fields() {
    let fixture = Fixture::new();
    let valid = intent();
    let slot = valid["slot"].as_str().unwrap();
    let path = root(&fixture.candidate).join(format!("{slot}.json"));
    state::private_directory(path.parent().unwrap()).unwrap();
    state::write(&path, &valid).unwrap();
    assert_eq!(
        read(&fixture.candidate, slot).unwrap().binding.run,
        "b".repeat(32)
    );
    for (pointer, value) in [
        ("/version", json!(1)),
        ("/kind", json!("environment-allocation")),
        (
            "/binding/container",
            json!(format!("hkg-{}-container-0", "b".repeat(32))),
        ),
        (
            "/binding/container",
            json!(format!("hkn-{}-container-00", "b".repeat(32))),
        ),
        (
            "/binding/container",
            json!(format!("hkn-{}-container-32", "b".repeat(32))),
        ),
        ("/binding/review", json!("short")),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        state::write(&path, &bad).unwrap();
        assert!(read(&fixture.candidate, slot).is_err());
    }
    let mut bad = valid.clone();
    bad["values"] = json!({"TOKEN":"private-native-canary"});
    state::write(&path, &bad).unwrap();
    let error = read(&fixture.candidate, slot).err().unwrap();
    assert!(!error.message.contains("private-native-canary"));
    state::write(&path, &valid).unwrap();
    state::write(&path.with_extension("pending"), &valid).unwrap();
    assert!(read(&fixture.candidate, slot).is_err());
}
#[test]
fn native_and_compose_history_share_capacity_even_when_compose_history_is_absent() {
    let fixture = Fixture::new();
    let native = root(&fixture.candidate);
    state::private_directory(&native).unwrap();
    for index in 0..4094 {
        fs::write(native.join(format!("{index}.json")), b"uncertain").unwrap();
    }
    assert!(environment_recovery::preflight_records(&fixture.candidate, 2).is_ok());
    assert!(environment_recovery::preflight_records(&fixture.candidate, 3).is_err());
    let compose = fixture.candidate.state_root.join("run/environment-leases");
    state::private_directory(&compose).unwrap();
    fs::write(compose.join("one.json"), b"uncertain").unwrap();
    assert!(environment_recovery::preflight_records(&fixture.candidate, 1).is_ok());
    assert!(environment_recovery::preflight_records(&fixture.candidate, 2).is_err());
}
