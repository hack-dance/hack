//! Explicit tagged native source reaches the owning runtime without Compose normalization.
use super::*;
use hack_runtime_core::provider::graph::native;
use std::{
    os::fd::{FromRawFd, OwnedFd},
    time::Instant,
};

fn refused() -> CandidateError {
    CandidateError::new(
        "native_graph_arguments",
        "Use graph native plan --source-file FILE, run|serve --source-file FILE --expect-review SHA [--environment-stdin] [--timeout-seconds 1..300] [--storage-witness-tool FILE --expect-storage-witness-tool SHA], inspect|cleanup|recovery-selection --run-id ID, recover-live-owner --run-id ID --expect-receipt SHA --expect-owner SHA, or control --run-id ID --action status|cleanup; optional --json. Foreground ownership and its recovery require macOS. Native source and private envelopes require their exact kind/version; values omitted.",
    )
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn command(candidate: &Candidate, args: &[&str]) -> Result<Value, CandidateError> {
    let (action, args) = args.split_first().ok_or_else(refused)?;
    let mut singles = BTreeMap::new();
    let mut private = false;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index] {
            "--json" if !json => {
                json = true;
                index += 1;
            }
            "--environment-stdin" if !private => {
                private = true;
                index += 1;
            }
            key @ ("--source-file"
            | "--expect-review"
            | "--timeout-seconds"
            | "--run-id"
            | "--action"
            | "--expect-receipt"
            | "--expect-owner"
            | "--storage-witness-tool"
            | "--expect-storage-witness-tool") => {
                let value = *args
                    .get(index + 1)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(refused)?;
                if singles.insert(key, value).is_some() {
                    return Err(refused());
                }
                index += 2;
            }
            _ => return Err(refused()),
        }
    }
    if *action == "recover-live-owner" {
        if private || singles.len() != 3 {
            return Err(refused());
        }
        let run = *singles
            .get("--run-id")
            .filter(|run| hex(run, 32))
            .ok_or_else(refused)?;
        let receipt = *singles
            .get("--expect-receipt")
            .filter(|receipt| hex(receipt, 64))
            .ok_or_else(refused)?;
        let owner = *singles
            .get("--expect-owner")
            .filter(|owner| hex(owner, 64))
            .ok_or_else(refused)?;
        #[cfg(target_os = "macos")]
        {
            return serde_json::to_value(native::foreground::recovery::recover(
                candidate,
                native::foreground::recovery::Options {
                    run,
                    expect_receipt: receipt,
                    expect_owner: owner,
                },
            )?)
            .map_err(|_| refused());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (run, receipt, owner);
            return Err(foreground_unavailable());
        }
    }
    if *action == "recovery-selection" {
        if private || singles.len() != 1 {
            return Err(refused());
        }
        let run = *singles
            .get("--run-id")
            .filter(|run| hex(run, 32))
            .ok_or_else(refused)?;
        #[cfg(target_os = "macos")]
        {
            return serde_json::to_value(native::foreground::recovery::select(candidate, run)?)
                .map_err(|_| refused());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = run;
            return Err(foreground_unavailable());
        }
    }
    if *action == "control" {
        if private || singles.len() != 2 {
            return Err(refused());
        }
        let run = *singles
            .get("--run-id")
            .filter(|run| hex(run, 32))
            .ok_or_else(refused)?;
        let action = match singles.get("--action").copied() {
            Some("status") => "status",
            Some("cleanup") => "cleanup",
            _ => return Err(refused()),
        };
        #[cfg(target_os = "macos")]
        {
            use hack_runtime_core::provider::graph::native::foreground::{Action, RequestOptions};
            return native::foreground::request(
                candidate,
                RequestOptions {
                    run,
                    action: if action == "status" {
                        Action::Status
                    } else {
                        Action::Cleanup
                    },
                },
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (run, action);
            return Err(foreground_unavailable());
        }
    }
    if ["inspect", "cleanup"].contains(action) {
        if private || singles.len() != 1 {
            return Err(refused());
        }
        let run = *singles
            .get("--run-id")
            .filter(|run| hex(run, 32))
            .ok_or_else(refused)?;
        return if *action == "inspect" {
            serde_json::to_value(native::inspect(candidate, run)?).map_err(|_| refused())
        } else {
            serde_json::to_value(native::cleanup(candidate, run)?).map_err(|_| refused())
        };
    }
    if !["plan", "run", "serve", "frontend-plan", "frontend-serve"].contains(action)
        || singles.contains_key("--run-id")
        || singles.contains_key("--action")
        || singles.contains_key("--expect-receipt")
        || singles.contains_key("--expect-owner")
    {
        return Err(refused());
    }
    let path = Path::new(singles.get("--source-file").ok_or_else(refused)?);
    let timeout = singles
        .get("--timeout-seconds")
        .map(|value| value.parse::<u64>().map_err(|_| refused()))
        .transpose()?
        .unwrap_or(30);
    if !(1..=300).contains(&timeout)
        || (["plan", "frontend-plan"].contains(action)
            && (private
                || singles.contains_key("--expect-review")
                || singles.contains_key("--storage-witness-tool")
                || singles.contains_key("--expect-storage-witness-tool")
                || singles.contains_key("--timeout-seconds")))
    {
        return Err(refused());
    }
    let storage_tool = match (
        singles.get("--storage-witness-tool"),
        singles.get("--expect-storage-witness-tool"),
    ) {
        (None, None) => None,
        (Some(path), Some(digest)) if Path::new(path).is_absolute() && hex(digest, 64) => {
            Some(native::StorageTool::read(Path::new(path), digest)?)
        }
        _ => return Err(refused()),
    };
    #[cfg(not(target_os = "macos"))]
    if ["serve", "frontend-serve"].contains(action) {
        return Err(foreground_unavailable());
    }
    let started = Instant::now();
    let mut deadline = started
        .checked_add(Duration::from_secs(timeout))
        .ok_or_else(refused)?;
    let source = if ["frontend-plan", "frontend-serve"].contains(action) {
        native::selection::Source::read_frontend(path, *action == "frontend-serve")?
    } else {
        native::selection::Source::read(path)?
    };
    if ["plan", "frontend-plan"].contains(action) {
        return serde_json::to_value(source.select(candidate, deadline)?.review())
            .map_err(|_| refused());
    }
    let expected = *singles
        .get("--expect-review")
        .filter(|review| hex(review, 64))
        .ok_or_else(refused)?;
    let run = source.run_id().to_owned();
    let mut selected = source.select(candidate, deadline)?;
    if selected.review().review_id() != expected {
        return Err(CandidateError::new(
            "native_graph_review_changed",
            "Native authored selection or public environment policy changed; no provider work was started.",
        ));
    }
    let managed = if private {
        // SAFETY: duplicate checked stdin into an owned descriptor; the bounded private receiver
        // verifies its type, deadline, EOF and schema. The original process descriptor stays owned.
        let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err(refused());
        }
        let managed = hack_runtime_core::provider::managed_environment::receive_native(
            unsafe { OwnedFd::from_raw_fd(fd) },
            expected,
            &run,
        )?;
        deadline = deadline.min(managed.deadline());
        Some(managed)
    } else {
        None
    };
    selected.restrict_deadline(deadline)?;
    let empty = BTreeMap::new();
    let prepared = selected.prepare(
        candidate,
        managed.as_ref().map_or(&empty, |managed| managed.values()),
    )?;
    drop(managed);
    if storage_tool.is_some() && prepared.input().inputs().storage.is_empty() {
        return Err(refused());
    }
    #[cfg(target_os = "macos")]
    if ["serve", "frontend-serve"].contains(action) {
        return serde_json::to_value(native::foreground::serve_with_storage_tool(
            candidate,
            prepared,
            storage_tool.as_ref(),
        )?)
        .map_err(|_| refused());
    }
    serde_json::to_value(native::run_with_storage_tool(
        candidate,
        prepared,
        storage_tool.as_ref(),
    )?)
    .map_err(|_| refused())
}

#[cfg(not(target_os = "macos"))]
fn foreground_unavailable() -> CandidateError {
    CandidateError::new(
        "native_graph_foreground_unsupported",
        "Native foreground ownership requires the supported macOS provider; no private descriptor or provider was used.",
    )
}
