//! Prepare fresh owned volumes with a private durable authority record. Only
//! unconsumed pending preparation can resume; completed/live caches are read-only.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};

fn refused() -> CandidateError {
    error(
        "graph_volume_subpath",
        "Owned volume subpaths are missing, unsafe or exceed their budget; no live volume repair was attempted.",
    )
}
fn selected(
    configs: &BTreeMap<String, Value>,
    volume: &str,
) -> Result<Vec<String>, CandidateError> {
    let mut directories = BTreeSet::new();
    for config in configs.values() {
        for mount in config["HostConfig"]["Mounts"]
            .as_array()
            .ok_or_else(refused)?
        {
            if mount["Type"] != "volume" || mount["Source"] != volume {
                continue;
            }
            let Some(value) = mount.get("VolumeOptions").and_then(|v| v.get("Subpath")) else {
                continue;
            };
            let value = value
                .as_str()
                .filter(|v| project::valid_volume_subpath(v))
                .ok_or_else(refused)?;
            let mut prefix = String::new();
            for part in value.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                directories.insert(prefix.clone());
                if directories.len() > 512 {
                    return Err(refused());
                }
            }
        }
    }
    let values = directories.into_iter().collect::<Vec<_>>();
    if values.iter().map(String::len).sum::<usize>() > 65536 {
        return Err(refused());
    }
    Ok(values)
}
// This authority is outside the application-writable volume. Completed records
// are retained: an application removing directories must never reactivate repair.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preparation {
    version: u32,
    owner: String,
    volume: Value,
    directories: Vec<String>,
    identity: String,
    completed: bool,
}
impl Preparation {
    fn matches(&self, owner: &str, volume: &Value, paths: &[String]) -> bool {
        self.version == 1
            && self.owner == owner
            && self.volume == *volume
            && self.directories == paths
            && valid_identity(&self.identity)
    }
}
pub(super) fn valid_identity(value: &str) -> bool {
    value.len() <= 48
        && value.split_once(':').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes().all(|v| v.is_ascii_digit())
                && b.bytes().all(|v| v.is_ascii_digit())
        })
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}
fn private_directory(path: &Path) -> Result<(), CandidateError> {
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or memory requirements.
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err(refused());
    }
    Ok(())
}
fn journal_path(candidate: &Candidate, name: &str, fresh: bool) -> Result<PathBuf, CandidateError> {
    let parent = candidate.state_root.join("run/volume-preparation");
    private_directory(&candidate.state_root.join("run"))?;
    if !exists(&parent)? && fresh {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&parent)
            .map_err(|_| refused())?;
        fs::File::open(parent.parent().ok_or_else(refused)?)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())?;
    }
    if exists(&parent)? {
        private_directory(&parent)?;
        // Retain records for the lifetime of the volume. Refuse new preparation
        // at this bound; there is deliberately no automatic record collection.
        let mut count = 0;
        for entry in fs::read_dir(&parent).map_err(|_| refused())? {
            let entry = entry.map_err(|_| refused())?;
            count += 1;
            if count > 256 || !entry.file_type().map_err(|_| refused())?.is_file() {
                return Err(refused());
            }
        }
        if fresh && count >= 256 {
            return Err(refused());
        }
    }
    Ok(parent.join(format!("{:x}.json", Sha256::digest(name.as_bytes()))))
}
fn write_preparation(path: &Path, record: &Preparation) -> Result<(), CandidateError> {
    // JSON escaping and inspect metadata also count toward the durable read cap.
    if serde_json::to_vec_pretty(record)
        .map_err(|_| refused())?
        .len()
        > 131072
    {
        return Err(refused());
    }
    state::write(path, record)
}
fn read_preparation(path: &Path) -> Result<Option<Preparation>, CandidateError> {
    if exists(&path.with_extension("pending"))? {
        return Err(refused());
    }
    if exists(path)? {
        Ok(Some(state::read_bounded(path, 131072)?))
    } else {
        Ok(None)
    }
}
fn forget_record(
    path: &Path,
    owner: &str,
    name: &str,
    labels: &Value,
) -> Result<(), CandidateError> {
    let Some(record) = read_preparation(path)? else {
        return Ok(());
    };
    if record.version != 1
        || record.owner != owner
        || record.volume["Name"] != name
        || record.volume["Labels"] != *labels
    {
        return Err(refused());
    }
    fs::remove_file(path).map_err(|_| refused())?;
    fs::File::open(path.parent().ok_or_else(refused)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| refused())
}
/// Only ordinary graph-owned volume deletion can reclaim its preparation record.
/// Shared caches retain authority until a separately authorized cache GC exists.
pub(super) fn forget_removed(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<(), CandidateError> {
    if resource.kind != Kind::Volume || resource.cache.is_some() {
        return Ok(());
    }
    if inspect_resource(engine, receipt, resource)?.is_some() {
        return Err(refused());
    }
    let path = journal_path(engine.guest().candidate(), &resource.name, false)?;
    forget_record(
        &path,
        &receipt.owner,
        &resource.name,
        &expected_labels(receipt, resource),
    )
}
fn no_consumers(value: &Value, volume: &str) -> Result<(), CandidateError> {
    let containers = value
        .as_array()
        .filter(|v| v.len() <= 4096)
        .ok_or_else(refused)?;
    for container in containers {
        let mounts = container["Mounts"].as_array().ok_or_else(refused)?;
        for mount in mounts {
            let kind = mount["Type"].as_str().ok_or_else(refused)?;
            if !["volume", "bind", "tmpfs"].contains(&kind) {
                return Err(refused());
            }
            if kind == "volume" {
                let name = mount["Name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .ok_or_else(refused)?;
                if name == volume {
                    return Err(refused());
                }
            }
        }
    }
    Ok(())
}
pub(super) fn prepare(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
    configs: &BTreeMap<String, Value>,
    fresh: bool,
) -> Result<(), CandidateError> {
    if resource.kind != Kind::Volume {
        return Ok(());
    }
    let paths = selected(configs, &resource.name)?;
    if paths.is_empty() {
        return Ok(());
    }
    let before = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
    // The pinned daemon's data root is a verified ext4 bind, not a host path.
    let expected = format!("/var/lib/docker/volumes/{}/_data", resource.name);
    if before["Mountpoint"] != expected {
        return Err(refused());
    }
    let journal = journal_path(engine.guest().candidate(), &resource.name, fresh)?;
    let mut record = read_preparation(&journal)?;
    if fresh {
        if record.is_some() || before["CreatedAt"].as_str().is_none_or(str::is_empty) {
            return Err(refused());
        }
        no_consumers(
            &engine.request(Method::GET, "/v1.53/containers/json?all=true", None)?,
            &resource.name,
        )?;
        // Read-only capture. Losing the host before the durable write below does
        // not authorize later repair of this otherwise unrecorded volume.
        let identity = engine.guest().execute(IDENTITY, &[&expected], None)?;
        let identity = identity.trim_end_matches('\n').to_owned();
        if !valid_identity(&identity) {
            return Err(refused());
        }
        let new = Preparation {
            version: 1,
            owner: receipt.owner.clone(),
            volume: before.clone(),
            directories: paths.clone(),
            identity,
            completed: false,
        };
        write_preparation(&journal, &new)?;
        #[cfg(test)]
        fault_pause(
            &directory(engine.guest().candidate(), &receipt.run)?,
            &receipt.run,
            "volume-preparation-pending",
        )?;
        record = Some(new);
    }
    if let Some(record) = &record {
        if !record.matches(&receipt.owner, &before, &paths) {
            return Err(refused());
        }
    }
    let pending = record.as_ref().is_some_and(|r| !r.completed);
    if pending {
        no_consumers(
            &engine.request(Method::GET, "/v1.53/containers/json?all=true", None)?,
            &resource.name,
        )?;
    }
    let mode = if pending { "recover" } else { "existing" };
    let identity = record.as_ref().map_or("", |r| r.identity.as_str());
    let mut args = vec![expected.as_str(), mode, identity];
    args.extend(paths.iter().map(String::as_str));
    let output = engine.guest().execute(SCRIPT, &args, None)?;
    if output != "volume-subpaths-v1\n" {
        return Err(refused());
    }
    let after = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
    if before != after {
        return Err(refused());
    }
    if pending {
        #[cfg(test)]
        fault_pause(
            &directory(engine.guest().candidate(), &receipt.run)?,
            &receipt.run,
            "volume-preparation-guest-complete",
        )?;
        let mut record = record.ok_or_else(refused)?;
        record.completed = true;
        // No graph container is created until this synchronized completion fence
        // commits. A torn pending file is retained and refuses automatic replay.
        write_preparation(&journal, &record)?;
    }
    Ok(())
}
pub(super) fn directory_identity(
    engine: &Engine<'_>,
    resource: &Resource,
    inspected: &Value,
) -> Result<String, CandidateError> {
    let expected = format!("/var/lib/docker/volumes/{}/_data", resource.name);
    if inspected["Mountpoint"].as_str() != Some(expected.as_str()) {
        return Err(refused());
    }
    let identity = engine
        .guest()
        .execute(IDENTITY, &[&expected, "existing"], None)?;
    let identity = identity.trim_end_matches('\n').to_owned();
    if !valid_identity(&identity) {
        return Err(refused());
    }
    Ok(identity)
}
const IDENTITY: &str = r#"set -efu
root=$1
parent=$root
while test "$parent" != /; do test ! -L "$parent"; test -d "$parent"; parent=${parent%/*}; test -n "$parent" || parent=/; done
if test "${2:-fresh}" = fresh; then test -z "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)"; fi
stat -c %d:%i "$root"
"#;
// The directory descriptor remains locked across orphaned guest preparation.
// Matching pending host authority is the only caller allowed to select recover.
const SCRIPT: &str = r#"set -efu
root=$1; mode=$2; expected_identity=$3; shift 3
case "$mode" in recover|existing) ;; *) exit 64;; esac
parent=$root
while test "$parent" != /; do test ! -L "$parent"; test -d "$parent"; parent=${parent%/*}; test -n "$parent" || parent=/; done
identity=$(stat -c %d:%i "$root")
if test -n "$expected_identity"; then test "$identity" = "$expected_identity"; fi
if test "$mode" = recover; then
 test -n "$expected_identity"
 exec 9<"$root"
 flock -w 5 9
 test "$(stat -c %d:%i "$root")" = "$identity"
 test "$(stat -Lc %d:%i /proc/self/fd/9)" = "$identity"
 # Exact comparison per entry avoids trusting newline-delimited filenames.
 # Unknown entries terminate traversal; at most the 512 selected directories
 # can pass, and no application data, files or links are accepted.
 invalid=$(find "$root" -mindepth 1 -maxdepth 17 -exec sh -c '
  root=$1; path=$2; shift 2
  test ! -L "$path" && test -d "$path" || exit 1
  relative=${path#"$root"/}
  for expected do test "$relative" != "$expected" || exit 0; done
  exit 1
 ' sh "$root" {} "$@" \; -o -exec printf refused \; -quit)
 test -z "$invalid"
fi
for relative in "$@"; do
 test "$(stat -c %d:%i "$root")" = "$identity"
 path=$root
 previous_ifs=$IFS; IFS=/; set -- $relative; IFS=$previous_ifs
 for part in "$@"; do
  case "$part" in ''|.|..) exit 65;; esac
  path=$path/$part
  test ! -L "$path"
  if test ! -e "$path"; then
   test "$mode" = recover
   mkdir -m 755 "$path"
  fi
  test -d "$path"
 done
done
test "$(stat -c %d:%i "$root")" = "$identity"
# Flush the guest filesystem before the independently durable host completion.
if test "$mode" = recover; then sync -f "$root"; fi
printf 'volume-subpaths-v1\n'
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;
    fn run(root: &Path, mode: &str, paths: &[&str]) -> std::process::Output {
        let metadata = fs::metadata(root).unwrap();
        run_identity(
            root,
            mode,
            paths,
            &format!("{}:{}", metadata.dev(), metadata.ino()),
        )
    }
    fn run_identity(
        root: &Path,
        mode: &str,
        paths: &[&str],
        identity: &str,
    ) -> std::process::Output {
        // macOS has neither util-linux flock nor /proc. These shims use the
        // same OS flock and inode checks, not substituted recovery decisions.
        let script = if cfg!(target_os = "macos") {
            format!(
                r#"stat() {{
 if test "$3" = /proc/self/fd/9; then
  python3 -c 'import os; s=os.fstat(9); print(str(s.st_dev)+":"+str(s.st_ino))'
 else
  /usr/bin/stat -L -f '%d:%i' "$3"
 fi
}}
sync() {{
 python3 -c 'import os,sys; fd=os.open(sys.argv[1],os.O_RDONLY); os.fsync(fd); os.close(fd)' "$2"
}}
flock() {{
 python3 -c 'import fcntl,time
end=time.monotonic()+5
while True:
 try:
  fcntl.flock(9, fcntl.LOCK_EX|fcntl.LOCK_NB)
  break
 except BlockingIOError:
  if time.monotonic() >= end: raise SystemExit(1)
  time.sleep(0.01)'
}}
{SCRIPT}"#
            )
        } else {
            SCRIPT.into()
        };
        let mounts = paths
            .iter()
            .map(|path| json!({"Type":"volume","Source":"test","VolumeOptions":{"Subpath":path}}))
            .collect::<Vec<_>>();
        let paths = selected(
            &BTreeMap::from([("test".into(), json!({"HostConfig":{"Mounts":mounts}}))]),
            "test",
        )
        .unwrap();
        Command::new("sh")
            .args(["-c", &script, "sh"])
            .arg(root)
            .arg(if mode == "fresh" { "recover" } else { mode })
            .arg(identity)
            .args(paths)
            .output()
            .unwrap()
    }
    fn succeeded(output: std::process::Output) {
        assert!(
            output.status.success(),
            "status={}; stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"volume-subpaths-v1\n");
    }
    #[test]
    fn fresh_subpaths_are_distinct_and_reuse_never_repairs_or_follows_links() {
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("volume");
        fs::create_dir(&root).unwrap();
        let paths = ["workspaces/apps/one", "workspaces/packages/two"];
        succeeded(run(&root, "fresh", &paths));
        fs::write(root.join(paths[0]).join("sentinel"), "one").unwrap();
        fs::write(root.join(paths[1]).join("sentinel"), "two").unwrap();
        succeeded(run(&root, "existing", &paths));
        assert_eq!(
            fs::read(root.join(paths[0]).join("sentinel")).unwrap(),
            b"one"
        );
        assert_eq!(
            fs::read(root.join(paths[1]).join("sentinel")).unwrap(),
            b"two"
        );
        assert!(!run(&root, "fresh", &["new"]).status.success());
        assert!(!root.join("new").exists());
        assert!(!run(&root, "existing", &["missing/child"]).status.success());
        assert!(!root.join("missing").exists());
        fs::write(root.join("file"), "keep").unwrap();
        assert!(!run(&root, "existing", &["file/child"]).status.success());
        std::os::unix::fs::symlink(&fixture.0, root.join("link")).unwrap();
        assert!(!run(&root, "existing", &["link/escaped"]).status.success());
        assert!(!fixture.0.join("escaped").exists());
    }
    #[test]
    fn interrupted_empty_skeleton_recovers_but_data_and_aliases_do_not() {
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("volume");
        fs::create_dir_all(root.join("workspace/a")).unwrap();
        let paths = ["workspace/a/deps", "workspace/b/deps"];
        // Simulate interruption between two mkdir effects, then after all mkdir
        // effects but before host completion. Both use the production script.
        succeeded(run(&root, "recover", &paths));
        succeeded(run(&root, "recover", &paths));
        fs::write(root.join("workspace/a/deps/data"), "keep").unwrap();
        assert!(!run(&root, "recover", &paths).status.success());
        assert_eq!(
            fs::read(root.join("workspace/a/deps/data")).unwrap(),
            b"keep"
        );
        fs::remove_file(root.join("workspace/a/deps/data")).unwrap();
        fs::create_dir(root.join("\n")).unwrap();
        assert!(!run(&root, "recover", &paths).status.success());
        fs::remove_dir(root.join("\n")).unwrap();
        fs::remove_dir(root.join("workspace/b/deps")).unwrap();
        std::os::unix::fs::symlink(&fixture.0, root.join("workspace/b/deps")).unwrap();
        assert!(!run(&root, "recover", &paths).status.success());
        assert!(!fixture.0.join("data").exists());
    }
    #[test]
    fn authority_binds_volume_creation_owner_layout_and_private_record() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        state::private_directory(&candidate.state_root.join("run")).unwrap();
        let path = journal_path(&candidate, "volume", true).unwrap();
        let volume = json!({"Name":"volume","CreatedAt":"creation-one"});
        let paths = vec!["workspace".into()];
        let record = Preparation {
            version: 1,
            owner: "owner".into(),
            volume: volume.clone(),
            directories: paths.clone(),
            identity: "1:2".into(),
            completed: false,
        };
        assert!(record.matches("owner", &volume, &paths));
        assert!(!record.matches("other", &volume, &paths));
        assert!(!record.matches(
            "owner",
            &json!({"Name":"volume","CreatedAt":"creation-two"}),
            &paths
        ));
        assert!(!record.matches("owner", &volume, &["other".into()]));
        state::write(&path, &record).unwrap();
        let loaded: Preparation = state::read_bounded(&path, 131072).unwrap();
        assert!(!loaded.completed);
        let completed = Preparation {
            completed: true,
            ..loaded
        };
        state::write(&path, &completed).unwrap();
        assert!(
            state::read_bounded::<Preparation>(&path, 131072)
                .unwrap()
                .completed
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(state::read_bounded::<Preparation>(&path, 131072).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(fixture.0.join("foreign"), &path).unwrap();
        assert!(state::read_bounded::<Preparation>(&path, 131072).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"truncated").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(state::read_bounded::<Preparation>(&path, 131072).is_err());
        for n in 0..256 {
            fs::write(path.parent().unwrap().join(format!("record-{n}")), b"").unwrap();
        }
        assert!(journal_path(&candidate, "new", true).is_err());
    }
    #[test]
    fn pending_journal_is_not_promoted_and_removed_volume_record_is_reclaimed() {
        let fixture = super::super::tests::Fixture::new();
        let path = fixture.0.join("preparation.json");
        let labels = json!({"owner":"owned"});
        let record = Preparation {
            version: 1,
            owner: "owned".into(),
            volume: json!({"Name":"volume","Labels":labels}),
            directories: vec!["deps".into()],
            identity: "1:2".into(),
            completed: true,
        };
        assert!(read_preparation(&path).unwrap().is_none());
        state::write(&path, &record).unwrap();
        fs::write(path.with_extension("pending"), b"truncated").unwrap();
        assert!(read_preparation(&path).is_err());
        assert!(forget_record(&path, "owned", "volume", &labels).is_err());
        assert!(path.exists());
        fs::remove_file(path.with_extension("pending")).unwrap();
        assert!(forget_record(&path, "foreign", "volume", &labels).is_err());
        assert!(forget_record(&path, "owned", "volume", &json!({"owner":"replacement"})).is_err());
        assert!(path.exists());
        forget_record(&path, "owned", "volume", &labels).unwrap();
        assert!(!path.exists());
        forget_record(&path, "owned", "volume", &labels).unwrap();
    }
    #[test]
    fn encoded_record_budget_refuses_before_pending_file() {
        let fixture = super::super::tests::Fixture::new();
        let path = fixture.0.join("preparation.json");
        let record = Preparation {
            version: 1,
            owner: "owner".into(),
            volume: json!({"Name":"volume"}),
            directories: vec!["\"".repeat(65536)],
            identity: "1:2".into(),
            completed: false,
        };
        assert!(write_preparation(&path, &record).is_err());
        assert!(!path.exists());
        assert!(!path.with_extension("pending").exists());
    }
    #[test]
    fn identity_mismatch_and_live_preparation_lock_refuse_without_mkdir() {
        use std::os::fd::AsRawFd;
        let fixture = super::super::tests::Fixture::new();
        let root = fixture.0.join("volume");
        fs::create_dir(&root).unwrap();
        assert!(
            !run_identity(&root, "recover", &["deps"], "0:0")
                .status
                .success()
        );
        assert!(!root.join("deps").exists());
        let directory = fs::File::open(&root).unwrap();
        // SAFETY: this live owned descriptor remains open throughout flock.
        assert_eq!(
            unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert!(!run(&root, "recover", &["deps"]).status.success());
        assert!(!root.join("deps").exists());
        drop(directory);
        succeeded(run(&root, "recover", &["deps"]));
    }
    #[test]
    fn consumers_include_stopped_containers_and_uncertain_inventory_refuses() {
        for state in ["running", "exited", "created"] {
            assert!(
                no_consumers(
                    &json!([{"State":state,"Mounts":[{"Type":"volume","Name":"selected"}]}]),
                    "selected"
                )
                .is_err()
            );
        }
        assert!(
            no_consumers(
                &json!([{"Mounts":[{"Type":"volume","Name":"other"}]}]),
                "selected"
            )
            .is_ok()
        );
        for uncertain in [
            Value::Null,
            json!([{}]),
            json!([{"Mounts":[{"Type":"volume"}]}]),
        ] {
            assert!(no_consumers(&uncertain, "selected").is_err());
        }
    }
    #[test]
    fn selection_rejects_escape_and_bounds_derived_directories() {
        for value in [
            "",
            "/absolute",
            "../escape",
            "a/../b",
            "a//b",
            "a/./b",
            "a/",
            "$HOME",
            "a\0b",
        ] {
            let config = json!({"HostConfig":{"Mounts":[{"Type":"volume","Source":"owned","VolumeOptions":{"Subpath":value}}]}});
            assert!(selected(&BTreeMap::from([("service".into(), config)]), "owned").is_err());
        }
        let mounts = (0..513).map(|n|json!({"Type":"volume","Source":"owned","VolumeOptions":{"Subpath":format!("p{n}")}})).collect::<Vec<_>>();
        assert!(
            selected(
                &BTreeMap::from([("service".into(), json!({"HostConfig":{"Mounts":mounts}}))]),
                "owned"
            )
            .is_err()
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "volume_subpaths/native_test.rs"]
mod native_test;
