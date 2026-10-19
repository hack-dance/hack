use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::process::{Command, Output};

const RUN: &str = "0123456789abcdef0123456789abcdef";

fn receipt(phase: &str, volume: Value) -> Receipt {
    serde_json::from_value(json!({
        "version":1,"run":RUN,"owner":"owner","namespace":"a".repeat(64),
        "plan_id":"b".repeat(64),"phase":phase,"readiness":{},
        "resources":{
            "volume:www_next":volume,
            "volume:redis":{"kind":"volume","key":"redis","name":"hkg-redis","id":null,"image":null,"phase":"created"}
        }
    }))
    .unwrap()
}
fn cache_volume() -> Value {
    json!({"disposable_caches":["dev/cache/turbopack","dev/cache/images"],"kind":"volume","key":"www_next","name":"hkg-www","id":null,"image":null,"phase":"created"})
}
fn target<'a>(volume: &'a str, path: &'a str) -> CacheQuarantineTarget<'a> {
    CacheQuarantineTarget {
        run: RUN,
        volume,
        path,
    }
}

#[test]
fn only_an_admitted_declared_path_of_a_stopped_owned_volume_is_selectable() {
    let stopped = receipt("stopped-data-retained", cache_volume());
    assert_eq!(
        authorize(&stopped, false, &target("www_next", "dev/cache/turbopack"))
            .unwrap()
            .name,
        "hkg-www"
    );
    // Application data: undeclared volumes, ancestors, siblings and children.
    for (volume, path) in [
        ("redis", "dump"),
        ("redis", "dev/cache/turbopack"),
        ("www_next", "dev/cache"),
        ("www_next", "dev"),
        ("www_next", "dev/cache/turbopack/sst"),
        ("www_next", "server"),
        ("missing", "dev/cache/turbopack"),
    ] {
        assert!(
            authorize(&stopped, false, &target(volume, path)).is_err(),
            "{volume}:{path}"
        );
    }
    // Traversal and absolute forms are refused before any lookup.
    for path in [
        "",
        "/var/lib/docker",
        "../hkg-redis/_data",
        "dev/cache/../../../escape",
        "dev//cache/turbopack",
        "dev/./cache/turbopack",
        "dev/cache/turbopack/",
        "$HOME",
        "dev\\cache",
        "dev/cache/\nturbopack",
    ] {
        assert!(
            authorize(&stopped, false, &target("www_next", path)).is_err(),
            "{path:?}"
        );
    }
    // Active, incomplete and non-retained graphs never admit a move.
    for phase in [
        "ready-observed",
        "preparing",
        "restoring",
        "failed-retained",
        "removed",
    ] {
        let active = receipt(phase, cache_volume());
        assert!(authorize(&active, false, &target("www_next", "dev/cache/turbopack")).is_err());
    }
    assert!(authorize(&stopped, true, &target("www_next", "dev/cache/turbopack")).is_err());
    let mut missing = cache_volume();
    missing["phase"] = json!("absent");
    assert!(
        authorize(
            &receipt("stopped-data-retained", missing),
            false,
            &target("www_next", "dev/cache/turbopack")
        )
        .is_err()
    );
    // A shared dependency cache has consumers beyond this graph.
    let mut shared = cache_volume();
    shared["cache"] = json!({"scope":"c".repeat(64),"fingerprint":"d".repeat(64),"image":format!("sha256:{}","e".repeat(64))});
    assert!(
        authorize(
            &receipt("stopped-data-retained", shared),
            false,
            &target("www_next", "dev/cache/turbopack")
        )
        .is_err()
    );
    // A tampered receipt cannot smuggle a traversal through its declaration.
    let mut forged = cache_volume();
    forged["disposable_caches"] = json!(["../hkg-redis/_data", "/var/lib/docker", ""]);
    let forged = receipt("stopped-data-retained", forged);
    for path in ["../hkg-redis/_data", "/var/lib/docker", ""] {
        assert!(
            authorize(&forged, false, &target("www_next", path)).is_err(),
            "{path:?}"
        );
    }
}

#[test]
fn active_or_stopped_consumers_refuse_before_any_observation() {
    for state in ["running", "exited", "created", "paused"] {
        let containers = json!([
            {"State":"running","Mounts":[{"Type":"volume","Name":"hkg-redis"}]},
            {"State":state,"Mounts":[{"Type":"bind","Name":""},{"Type":"volume","Name":"hkg-www"}]}
        ]);
        assert!(volume_subpaths::no_consumers(&containers, "hkg-www").is_err());
    }
    assert!(
        volume_subpaths::no_consumers(
            &json!([{"State":"running","Mounts":[{"Type":"volume","Name":"hkg-redis"}]}]),
            "hkg-www"
        )
        .is_ok()
    );
}

#[test]
fn observation_output_is_closed_and_bounded() {
    assert_eq!(parse_observation("absent\n").unwrap(), None);
    assert_eq!(
        parse_observation("present 12:34 100 4096 3\n").unwrap(),
        Some(("12:34".into(), 100, 4096, 3))
    );
    for malformed in [
        "",
        "absent",
        "present 12:34 100 4096 3",
        "present 12:34 100 4096 0\n",
        "present 12 100 4096 3\n",
        "present 12:34 -1 4096 3\n",
        "present 12:34 100 4096 3 extra\n",
        "present 12:34 100 4096\n",
        "present 12:34 99999999999999999999999 1 1\n",
        "present 12:34 1 1 1\nabsent\n",
    ] {
        assert!(parse_observation(malformed).is_err(), "{malformed:?}");
    }
}

fn selection(target_identity: &str) -> Selection {
    Selection {
        version: 1,
        run: RUN.into(),
        owner: "owner".into(),
        receipt_sha256: "f".repeat(64),
        volume: "www_next".into(),
        volume_name: "hkg-www".into(),
        volume_created: "2026-09-28T19:10:13Z".into(),
        root_identity: "7:100".into(),
        path: "dev/cache/turbopack".into(),
        target_identity: target_identity.into(),
        target_bytes: 647,
        allocated_bytes: 8192,
        entries: 3,
    }
}
fn record(target_identity: &str, completed: bool) -> Record {
    let selection = selection(target_identity);
    Record {
        version: 1,
        selection_sha256: selection.sha256().unwrap(),
        selection,
        completed,
    }
}

#[test]
fn durable_records_are_private_exact_bounded_and_refuse_torn_or_forged_state() {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    state::private_directory(&candidate.state_root.join("run")).unwrap();
    let records = Records::load(&candidate).unwrap();
    assert!(records.pending("hkg-www").unwrap().is_none());
    let pending = record("7:200", false);
    records.write(&pending).unwrap();
    let loaded = Records::load(&candidate).unwrap();
    assert_eq!(
        loaded.pending("hkg-www").unwrap().unwrap().selection,
        pending.selection
    );
    assert!(loaded.pending("hkg-redis").unwrap().is_none());
    let directory = candidate.state_root.join("run/cache-quarantine");
    let path = directory.join(format!("{}.json", &pending.selection_sha256[..32]));
    // A record whose selection no longer matches its digest is never resumed.
    let mut forged: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    forged["selection"]["path"] = json!("server");
    fs::write(&path, serde_json::to_vec_pretty(&forged).unwrap()).unwrap();
    assert!(Records::load(&candidate).is_err());
    fs::remove_file(&path).unwrap();
    records.write(&pending).unwrap();
    // Torn write evidence and foreign entries refuse automatic replay.
    fs::write(path.with_extension("pending"), b"torn").unwrap();
    assert!(Records::load(&candidate).is_err());
    fs::remove_file(path.with_extension("pending")).unwrap();
    fs::write(directory.join("foreign"), b"").unwrap();
    assert!(Records::load(&candidate).is_err());
    fs::remove_file(directory.join("foreign")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Records::load(&candidate).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    // Two unresolved operations for one volume are ambiguous.
    let second = record("7:300", false);
    records.write(&second).unwrap();
    assert!(
        Records::load(&candidate)
            .unwrap()
            .pending("hkg-www")
            .is_err()
    );
    // Completion is retained as diagnosis evidence, not collected.
    records
        .write(&Record {
            completed: true,
            ..second.clone()
        })
        .unwrap();
    records
        .write(&Record {
            completed: true,
            ..pending.clone()
        })
        .unwrap();
    let done = Records::load(&candidate).unwrap();
    assert!(done.pending("hkg-www").unwrap().is_none());
    assert_eq!(done.records.len(), 2);
    let mut invalid = pending.clone();
    invalid.selection.target_bytes += 1;
    assert!(records.write(&invalid).is_err());
}

/// Run a production guest script on this host. Linux runs it unchanged; macOS
/// receives PATH shims translating GNU `stat -c`, util-linux `flock`, and
/// `sync -f` to the same syscalls (lstat, fstat of fd 9, flock, fsync).
fn script(fixture: &Path, program: &str, args: &[&str]) -> Output {
    let mut command = Command::new("sh");
    command.args(["-c", program, "sh"]).args(args);
    if cfg!(target_os = "macos") {
        let bin = fixture.join("shim");
        if !bin.exists() {
            fs::create_dir(&bin).unwrap();
            for (name, body) in [
                (
                    "stat",
                    r#"#!/bin/sh
if test "$1" = -Lc; then exec python3 -c 'import os; s=os.fstat(9); print(str(s.st_dev)+":"+str(s.st_ino))'; fi
test "$1" = -c || exit 70
format=$2; shift 2
case "$format" in
 %d:%i) exec /usr/bin/stat -f '%d:%i' "$@";;
 %d) exec /usr/bin/stat -f '%d' "$@";;
 %u:%a) exec /usr/bin/stat -f '%u:%Lp' "$@";;
 %s) exec /usr/bin/stat -f '%z' "$@";;
 '%b %B') exec /usr/bin/stat -f '%b 512' "$@";;
esac
exit 70
"#,
                ),
                (
                    "flock",
                    r#"#!/bin/sh
test "$1" = -w && test "$3" = 9 || exit 70
exec python3 -c 'import fcntl,time
end=time.monotonic()+float(__import__("sys").argv[1])
while True:
 try:
  fcntl.flock(9, fcntl.LOCK_EX|fcntl.LOCK_NB)
  break
 except BlockingIOError:
  if time.monotonic() >= end: raise SystemExit(1)
  time.sleep(0.01)' "$2"
"#,
                ),
                (
                    "sync",
                    r#"#!/bin/sh
test "$1" = -f || exit 70
exec python3 -c 'import os,sys; fd=os.open(sys.argv[1],os.O_RDONLY); os.fsync(fd); os.close(fd)' "$2"
"#,
                ),
            ] {
                let path = bin.join(name);
                fs::write(&path, body).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        command.env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        );
    }
    command.output().unwrap()
}
fn identity(path: &Path) -> String {
    let m = fs::symlink_metadata(path).unwrap();
    format!("{}:{}", m.dev(), m.ino())
}
fn stdout(output: Output) -> String {
    assert!(
        output.status.success(),
        "status={}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// A synthetic volume: a corrupt cache, a sibling persistent marker, and app data.
struct Volume {
    fixture: super::super::tests::Fixture,
    root: PathBuf,
    quarantine: PathBuf,
    target: PathBuf,
}
const PATH: &str = "dev/cache/turbopack";
const ID: &str = "0123456789abcdef0123456789abcdef";
impl Volume {
    fn new() -> Self {
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("hkg-www/_data");
        let target = root.join(PATH);
        fs::create_dir_all(target.join("sst")).unwrap();
        fs::write(target.join("sst/00001.sst"), vec![7; 1000]).unwrap();
        fs::write(target.join("CURRENT"), b"corrupt-checksum").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", target.join("link")).unwrap();
        fs::write(root.join("dev/cache/marker"), b"persistent").unwrap();
        fs::write(root.join("BUILD_ID"), b"keep").unwrap();
        let quarantine = fixture.0.join("hkg-www/hack-quarantine");
        Self {
            fixture,
            root,
            quarantine,
            target,
        }
    }
    fn observe(&self, path: &str) -> Output {
        script(
            &self.fixture.0,
            OBSERVE,
            &[self.root.to_str().unwrap(), &identity(&self.root), path],
        )
    }
    fn move_with(
        &self,
        quarantine: &Path,
        id: &str,
        root_identity: &str,
        target_identity: &str,
    ) -> Output {
        script(
            &self.fixture.0,
            MOVE,
            &[
                self.root.to_str().unwrap(),
                quarantine.to_str().unwrap(),
                id,
                PATH,
                root_identity,
                target_identity,
            ],
        )
    }
    fn move_target(&self, target_identity: &str) -> Output {
        self.move_with(&self.quarantine, ID, &identity(&self.root), target_identity)
    }
    fn untouched_application_data(&self) {
        assert_eq!(
            fs::read(self.root.join("dev/cache/marker")).unwrap(),
            b"persistent"
        );
        assert_eq!(fs::read(self.root.join("BUILD_ID")).unwrap(), b"keep");
    }
}

#[test]
fn observation_measures_exact_bytes_without_following_links() {
    let volume = Volume::new();
    let output = stdout(volume.observe(PATH));
    let (observed, bytes, allocated, entries) = parse_observation(&output).unwrap().unwrap();
    assert_eq!(observed, identity(&volume.target));
    // Two regular files; the symlink target's size is never read.
    assert_eq!(bytes, 1000 + 16);
    assert!(allocated > 0);
    // target, sst, sst/00001.sst, CURRENT, link
    assert_eq!(entries, 5);
    assert_eq!(stdout(volume.observe("dev/cache/absent")), "absent\n");
    assert!(!volume.observe("../escape").status.success());
    assert!(!volume.observe("dev/../BUILD_ID").status.success());
    assert!(!volume.observe("BUILD_ID").status.success());
    assert!(
        !script(
            &volume.fixture.0,
            OBSERVE,
            &[volume.root.to_str().unwrap(), "0:0", PATH]
        )
        .status
        .success()
    );
    volume.untouched_application_data();
}

#[test]
fn move_is_a_retaining_rename_that_resumes_after_interruption() {
    let volume = Volume::new();
    let target_identity = identity(&volume.target);
    assert_eq!(
        stdout(volume.move_target(&target_identity)),
        "cache-quarantine-v1 moved\n"
    );
    let destination = volume.quarantine.join(ID);
    assert!(!volume.target.exists());
    assert_eq!(identity(&destination), target_identity);
    assert_eq!(
        fs::read(destination.join("sst/00001.sst")).unwrap(),
        vec![7; 1000]
    );
    assert_eq!(
        fs::read(destination.join("CURRENT")).unwrap(),
        b"corrupt-checksum"
    );
    assert_eq!(
        fs::metadata(&volume.quarantine)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    volume.untouched_application_data();
    // Host loss after the guest rename but before host completion: replay
    // recognizes the exact inode at its destination and moves nothing else.
    assert_eq!(
        stdout(volume.move_target(&target_identity)),
        "cache-quarantine-v1 resumed\n"
    );
    // A regenerated cache at the source is a different directory; the pending
    // operation refuses rather than moving the new bytes too.
    fs::create_dir(&volume.target).unwrap();
    fs::write(volume.target.join("fresh"), b"new").unwrap();
    assert!(!volume.move_target(&target_identity).status.success());
    assert_eq!(fs::read(volume.target.join("fresh")).unwrap(), b"new");
    assert_eq!(identity(&destination), target_identity);
}

#[test]
fn interrupted_before_rename_resumes_by_moving_the_recorded_directory() {
    let volume = Volume::new();
    let target_identity = identity(&volume.target);
    // Intent was durable and the quarantine root was created, then the host died.
    fs::create_dir(&volume.quarantine).unwrap();
    fs::set_permissions(&volume.quarantine, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        stdout(volume.move_target(&target_identity)),
        "cache-quarantine-v1 moved\n"
    );
    assert_eq!(identity(&volume.quarantine.join(ID)), target_identity);
}

#[test]
fn replaced_symlinked_or_ambiguous_targets_refuse_without_effects() {
    // Replaced: same path, different directory incarnation.
    let volume = Volume::new();
    let original = identity(&volume.target);
    fs::rename(&volume.target, volume.root.join("dev/cache/old")).unwrap();
    fs::create_dir(&volume.target).unwrap();
    assert!(!volume.move_target(&original).status.success());
    assert!(volume.target.exists() && !volume.quarantine.join(ID).exists());

    // Symlinked target pointing at application data outside the cache.
    let volume = Volume::new();
    let original = identity(&volume.target);
    fs::remove_dir_all(&volume.target).unwrap();
    std::os::unix::fs::symlink(&volume.root, &volume.target).unwrap();
    assert!(!volume.move_target(&original).status.success());
    assert!(!volume.observe(PATH).status.success());
    assert!(fs::symlink_metadata(&volume.target).unwrap().is_symlink());
    volume.untouched_application_data();

    // Symlinked ancestor redirecting the walk outside the volume.
    let volume = Volume::new();
    let outside = volume.fixture.0.join("outside/cache/turbopack");
    fs::create_dir_all(&outside).unwrap();
    let original = identity(&outside);
    fs::rename(volume.root.join("dev"), volume.fixture.0.join("dev-moved")).unwrap();
    std::os::unix::fs::symlink(volume.fixture.0.join("outside"), volume.root.join("dev")).unwrap();
    assert!(!volume.move_target(&original).status.success());
    assert!(!volume.observe(PATH).status.success());
    assert!(outside.exists());

    // Resume never adopts a different directory found at the destination.
    let volume = Volume::new();
    let original = identity(&volume.target);
    fs::create_dir_all(volume.quarantine.join(ID)).unwrap();
    fs::set_permissions(&volume.quarantine, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(&volume.target, volume.root.join("dev/cache/elsewhere")).unwrap();
    assert!(!volume.move_target(&original).status.success());

    // Source and destination both present: never choose one.
    let volume = Volume::new();
    let original = identity(&volume.target);
    fs::create_dir_all(volume.quarantine.join(ID)).unwrap();
    fs::set_permissions(&volume.quarantine, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!volume.move_target(&original).status.success());
    assert!(volume.target.join("CURRENT").exists());
}

#[test]
fn foreign_quarantine_root_lock_and_identity_refuse_without_effects() {
    let volume = Volume::new();
    let original = identity(&volume.target);
    // Group/world-accessible quarantine root.
    fs::create_dir(&volume.quarantine).unwrap();
    fs::set_permissions(&volume.quarantine, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!volume.move_target(&original).status.success());
    fs::remove_dir(&volume.quarantine).unwrap();
    // Symlinked quarantine root.
    let elsewhere = volume.fixture.0.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &volume.quarantine).unwrap();
    assert!(!volume.move_target(&original).status.success());
    assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    fs::remove_file(&volume.quarantine).unwrap();
    // Quarantine outside the volume's own directory (even a private one), a
    // malformed id, or a replaced volume root.
    fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        !volume
            .move_with(&elsewhere, ID, &identity(&volume.root), &original)
            .status
            .success()
    );
    assert!(
        !volume
            .move_with(
                &volume.quarantine,
                "../escape",
                &identity(&volume.root),
                &original
            )
            .status
            .success()
    );
    assert!(
        !volume
            .move_with(&volume.quarantine, ID, "0:0", &original)
            .status
            .success()
    );
    assert!(volume.target.exists());
    // A live holder of the volume root lock excludes the move.
    {
        use std::os::fd::AsRawFd;
        let directory = fs::File::open(&volume.root).unwrap();
        // SAFETY: the owned descriptor stays open for the duration of flock.
        assert_eq!(
            unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert!(!volume.move_target(&original).status.success());
        assert!(volume.target.exists());
    }
    assert_eq!(
        stdout(volume.move_target(&original)),
        "cache-quarantine-v1 moved\n"
    );
    volume.untouched_application_data();
}
