//! Bounded guest ENOSPC and interrupted-rename convergence controls.
use super::{SyncSession, engine::Engine, source_sync, state};
use crate::{Candidate, CandidateError, project};
use serde_json::json;
use std::{fs, path::Path};

fn failure(message: &str) -> CandidateError {
    CandidateError::new("source_failure_test", message)
}

#[test]
#[ignore = "Manual owned development VM only; requires external watchdog; uses a bounded private tmpfs"]
fn owned_source_failures_live() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").map_err(|_| failure("Candidate root required."))?,
    ))?;
    let status = super::status(&candidate)?;
    if status.phase != "running" || status.profile != Some(super::Profile::Development) {
        return Err(failure("Owned development VM required."));
    }
    let source = std::env::temp_dir()
        .canonicalize()
        .map_err(state::io)?
        .join(format!(
            "hack-sync-failure-{}-{}",
            std::process::id(),
            crate::node::now()
        ));
    fs::create_dir(&source).map_err(state::io)?;
    fs::write(
        source.join("compose.yaml"),
        "services:\n  app:\n    image: busybox:latest\n",
    )
    .map_err(state::io)?;
    fs::create_dir(source.join("before")).map_err(state::io)?;
    fs::write(source.join("before/name.txt"), "rename-control\n").map_err(state::io)?;
    let mut random = 0x12345678_u32;
    let bytes: Vec<u8> = (0..2 * 1024 * 1024)
        .map(|_| {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            random as u8
        })
        .collect();
    fs::write(source.join("blob.bin"), bytes).map_err(state::io)?;
    let capture = || {
        let report = project::plan(
            &candidate,
            project::PlanOptions {
                project: &source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )?;
        let snapshot = project::snapshot::capture(
            &source,
            &Default::default(),
            &report.plan.source_selection.metadata_sha256,
        )?;
        Ok::<_, CandidateError>((report.plan.namespace, snapshot))
    };
    let (namespace, first) = capture()?;
    let root = format!("/storage/hack-workspaces/{namespace}");
    let mount_name = format!("hack-sync-test-{namespace}");
    let mut writer = SyncSession::open(&candidate, &namespace, &source)?;
    let engine = Engine::connect(&candidate)?;
    engine.guest().execute(
        r#"
umask 077
test ! -L /storage/hack-workspaces
mkdir -p /storage/hack-workspaces
test "$(stat -c %u:%a /storage/hack-workspaces)" = 0:700
test ! -e "$1"; test ! -L "$1"
mkdir "$1"
mount -t tmpfs -o size=1048576,mode=700 "$2" "$1"
printf '%s' "$3" > "$1/owner"
"#,
        &[&root, &mount_name, engine.guest().incarnation()],
        None,
    )?;
    drop(engine);
    let mut phase = "force-enospc";
    let result = (|| {
        let refused = writer
            .apply(&first, false)
            .expect_err("1 MiB staging accepted 2 MiB input");
        let pending = source_sync::sync_status(&candidate, &namespace)?.expect("sync receipt");
        if pending.acknowledged_revision.is_some()
            || pending.pending_revision.as_deref() != Some(&first.receipt().revision)
        {
            return Err(failure("Failed transfer falsely acknowledged content."));
        }
        if writer.apply(&first, false).is_ok() {
            return Err(failure("Interrupted transfer silently retried."));
        }
        phase = "verify-full-tmpfs-and-resize";
        {
            let engine = Engine::connect(&candidate)?;
            engine.guest().execute(
                r#"
test "$(findmnt -n -o SOURCE --mountpoint "$1")" = "$2"
test "$(findmnt -n -o FSTYPE --mountpoint "$1")" = tmpfs
test "$(df -Pk "$1" | tail -1 | awk '{print $4}')" = 0 || { echo tmpfs-not-full >&2; exit 1; }
mount -o remount,size=16777216 "$1"
"#,
                &[&root, &mount_name],
                None,
            )?;
        }
        phase = "reconcile-enospc";
        let repaired = writer.apply(&first, true)?;
        if !repaired.reconciled || repaired.guest_tree_inode != pending.guest_tree_inode {
            return Err(failure("Disk-full repair replaced its watched root."));
        }
        phase = "reject-corrupt-verifier-cache";
        {
            let engine = Engine::connect(&candidate)?;
            engine.guest().execute(
                "test ! -L \"$1/verify-current.sh\"; printf '\\n: corrupted-cache\\n' >> \"$1/verify-current.sh\"",
                &[&root], None,
            )?;
        }
        let corrupt_cache = writer
            .apply(&first, false)
            .expect_err("Corrupt verifier cache was reused");
        let cache_repair = writer.apply(&first, true)?;
        if cache_repair.acknowledged_revision != repaired.acknowledged_revision
            || cache_repair.guest_tree_inode != repaired.guest_tree_inode
        {
            return Err(failure("Verifier cache repair changed source identity."));
        }
        phase = "interrupt-rename";
        fs::rename(source.join("before"), source.join("after")).map_err(state::io)?;
        let (_, second) = capture()?;
        {
            let engine = Engine::connect(&candidate)?;
            engine.guest().execute(
                "test ! -e \"$1/tree/after\"; mv \"$1/tree/before\" \"$1/tree/after\"",
                &[&root],
                None,
            )?;
        }
        let interrupted = writer
            .apply(&second, false)
            .expect_err("Partial guest rename accepted as old revision");
        phase = "reconcile-rename";
        let renamed = writer.apply(&second, true)?;
        if renamed.acknowledged_revision.as_deref() != Some(&second.receipt().revision)
            || renamed.guest_tree_inode != repaired.guest_tree_inode
        {
            return Err(failure(
                "Interrupted rename did not converge on its stable root.",
            ));
        }
        let engine = Engine::connect(&candidate)?;
        engine.guest().execute(
            &format!(
                "cd \"$1/tree\"\n{}",
                source_sync::verification(Some(second.receipt()))
            ),
            &[&root],
            None,
        )?;
        Ok(
            json!({"disk_full_refusal":refused.code,"pending":pending,"disk_full_repair":repaired,
            "cache_refusal":corrupt_cache.code,"cache_repair":cache_repair,
            "rename_refusal":interrupted.code,"rename_repair":renamed,"guest_manifest_verified":true}),
        )
    })();
    drop(writer);
    let cleanup = Engine::connect_cleanup(&candidate).and_then(|engine| {
        engine.guest().execute(
            r#"
test "$(findmnt -n -o SOURCE --mountpoint "$1")" = "$2"
test "$(findmnt -n -o FSTYPE --mountpoint "$1")" = tmpfs
umount "$1"
rmdir "$1"
test ! -e "$1"
"#,
            &[&root, &mount_name],
            None,
        )
    });
    let directory = candidate.state_root.join("review/wu05/source-failures");
    state::private_directory(&directory)?;
    state::write(
        &directory.join("result.json"),
        &json!({"passed":result.is_ok() && cleanup.is_ok(),
        "evidence":result.as_ref().ok(),"failure":result.as_ref().err().map(|e| &e.message),
        "guest_tmpfs_absent":cleanup.is_ok(),"fixture_source":source,"phase":phase}),
    )?;
    cleanup?;
    result.map(|_| ())
}
