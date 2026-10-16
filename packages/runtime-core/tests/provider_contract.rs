use hack_runtime_core::{Candidate, provider};
use std::io::Read;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0_u8; 16];
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-lifecycle-{token}"));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn read_only_engine_observation_does_not_initialize_a_runtime() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    assert_eq!(
        provider::engine_info(&candidate).unwrap_err().code,
        "runtime_not_running"
    );
    assert!(!candidate.state_root.exists());
}

#[test]
fn status_down_and_recovery_of_an_uninitialized_candidate_create_no_state() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    for status in [
        provider::status(&candidate).unwrap(),
        provider::down(&candidate).unwrap(),
        provider::recover(&candidate).unwrap(),
    ] {
        assert_eq!(status.phase, "uninitialized");
        assert_eq!(status.process_alive, Some(false));
        assert!(!status.persistent_disks_identified);
    }
    assert!(!candidate.state_root.exists());
}

#[test]
fn an_unverified_engine_archive_never_reaches_extraction_or_creates_state() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let archive = fixture.0.join("untrusted.tgz");
    std::fs::write(&archive, b"not a trusted tar archive").unwrap();
    assert!(
        matches!(provider::prepare_engine(&candidate,&archive),Err(e) if e.code=="artifact_digest_mismatch")
    );
    assert!(!candidate.state_root.exists());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn an_unverified_provider_archive_never_reaches_signature_checks_or_extraction() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let archive = fixture.0.join("untrusted.tgz");
    std::fs::write(&archive, b"not a trusted tar archive").unwrap();
    assert!(
        matches!(provider::prepare(&candidate,&archive),Err(e) if e.code=="artifact_digest_mismatch")
    );
    assert!(!candidate.state_root.exists());
}

#[cfg(unix)]
#[test]
fn status_rejects_an_aliased_provider_directory_without_contacting_it() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let foreign = fixture.0.join("foreign");
    std::fs::create_dir(&foreign).unwrap();
    std::fs::create_dir_all(candidate.state_root.join("run")).unwrap();
    std::os::unix::fs::symlink(&foreign, candidate.state_root.join("run/smolvm")).unwrap();
    assert_eq!(
        provider::status(&candidate).unwrap_err().code,
        "aliased_state"
    );
    assert_eq!(std::fs::read_dir(foreign).unwrap().count(), 0);
}

#[test]
fn invalid_or_unavailable_bridges_have_no_runtime_effects() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    assert_eq!(
        provider::up_with_bridge(
            &candidate,
            provider::Profile::Development,
            Some(provider::BridgeIntent { slots: 0 })
        )
        .unwrap_err()
        .code,
        "bridge_capacity"
    );
    assert!(!candidate.state_root.exists());
    #[cfg(not(feature = "native-stream-relay"))]
    {
        assert_eq!(
            provider::up_with_bridge(
                &candidate,
                provider::Profile::Development,
                Some(provider::BridgeIntent::new(1).unwrap())
            )
            .unwrap_err()
            .code,
            "bridge_unavailable"
        );
        assert!(!candidate.state_root.exists());
    }
}

#[test]
fn invalid_dependency_capacity_does_not_initialize_runtime_state() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    for slots in [0, 33, u8::MAX] {
        let error = provider::up_with_sockets(
            &candidate,
            provider::Profile::Development,
            None,
            Some(provider::DependencySocketIntent { slots }),
        )
        .unwrap_err();
        assert_eq!(error.code, "dependency_socket");
        assert!(!candidate.state_root.exists());
    }
    let error = provider::up_with_sockets(
        &candidate,
        provider::Profile::Development,
        Some(provider::BridgeIntent::new(32).unwrap()),
        Some(provider::DependencySocketIntent::new(1).unwrap()),
    )
    .unwrap_err();
    assert_eq!(error.code, "dependency_socket");
    assert!(!candidate.state_root.exists());
}
