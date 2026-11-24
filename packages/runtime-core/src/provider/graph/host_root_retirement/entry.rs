use super::*;
use crate::provider::identity::ProcessIdentity;

const BUDGET: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Relay {
    version: u8,
    root: PathBuf,
    identity: FileId,
    owner: String,
    boot: String,
    process: ProcessIdentity,
}

fn inventory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    directory(candidate, run)?;
    Ok(candidate.state_root.join("run/host-relay-roots").join(run))
}

/// Called only for a new, exclusively created directory before relay publication.
pub(in crate::provider::graph) fn record_relay(
    candidate: &Candidate,
    run: &str,
    root: &Path,
    owner: &str,
    boot: &str,
    process: &ProcessIdentity,
) -> Result<(), CandidateError> {
    if startup::process_control_root(&candidate.state_root, owner, boot, run, process)? != root {
        return Err(refused());
    }
    let records = inventory(candidate, run)?;
    state::private_directory(&records)?;
    if fs::read_dir(&records)
        .map_err(state::io)?
        .take(BUDGET)
        .count()
        >= BUDGET
    {
        return Err(refused());
    }
    let name = root.file_name().ok_or_else(refused)?;
    state::write(
        &records.join(name).with_extension("json"),
        &Relay {
            version: 1,
            root: root.into(),
            identity: directory_id(root)?,
            owner: owner.into(),
            boot: boot.into(),
            process: process.clone(),
        },
    )
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Root {
    path: PathBuf,
    relay: bool,
    selection: Selection,
}

fn select_root(path: PathBuf, relay: bool) -> Result<Option<(Root, state::Lock)>, CandidateError> {
    if absent(&path)? {
        if !absent(&quarantine(&path))? {
            return Err(refused());
        }
        return Ok(None);
    }
    let (selection, lock) = select(&path, relay)?;
    Ok(Some((
        Root {
            path,
            relay,
            selection,
        },
        lock,
    )))
}

fn relay_records(candidate: &Candidate, run: &str) -> Result<Vec<Relay>, CandidateError> {
    let records = inventory(candidate, run)?;
    if absent(&records)? {
        return Ok(Vec::new());
    }
    state::check_private_directory(&records)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&records).map_err(state::io)?.take(BUDGET + 1) {
        let path = entry.map_err(state::io)?.path();
        if result.len() >= BUDGET || path.extension().and_then(|s| s.to_str()) != Some("json") {
            return Err(refused());
        }
        let relay: Relay = state::read(&path)?;
        if relay.version != 1
            || startup::process_control_root(
                &candidate.state_root,
                &relay.owner,
                &relay.boot,
                run,
                &relay.process,
            )? != relay.root
            || relay
                .root
                .file_name()
                .map(|n| records.join(n).with_extension("json"))
                != Some(path)
        {
            return Err(refused());
        }
        result.push(relay);
    }
    Ok(result)
}

/// Explicit post-prune retirement. Automatic archive housekeeping already holds the
/// provider lease and cannot enter this lock order.
pub fn retire_pruned(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    directory(candidate, run)?;
    let gate = publication_gate::Guard::acquire(candidate)?;
    let target = retention::consumed(candidate, run)?;
    state::check_private_directory(&target)?;
    let foreground = foreground::transport::root(candidate, run)?;
    let journal = target.join("host-retirement.json");
    let completed = target.join("host-retirement-complete.json");
    if !absent(&completed)? {
        let _engine = Engine::connect_cleanup(candidate)?;
        retention::verify_pruned(candidate, run)?;
        let count: usize = state::read(&completed)?;
        return Ok(json!({"run":run,"retired_roots":count}));
    }
    let records = relay_records(candidate, run)?;
    let mut selected = Vec::new();
    if absent(&journal)? {
        if !absent(&foreground)? {
            let (selection, lock) =
                foreground::transport::prunable_root(candidate, run, &foreground)?;
            inventory_matches(&foreground, true, &selection.files)?;
            selected.push((
                Root {
                    path: foreground.clone(),
                    relay: false,
                    selection,
                },
                Some(lock),
            ));
        } else if !absent(&quarantine(&foreground))? {
            return Err(refused());
        }
        for relay in &records {
            if absent(&relay.root)? {
                continue;
            }
            if directory_id(&relay.root)? != relay.identity
                || !crate::provider::identity::incarnation_gone(&relay.process)?
            {
                return Err(refused());
            }
            if let Some((root, lock)) = select_root(relay.root.clone(), true)? {
                selected.push((root, Some(lock)));
            }
        }
    } else {
        let roots: Vec<Root> = state::read(&journal)?;
        if roots.len() > BUDGET + 1 {
            return Err(refused());
        }
        for root in roots {
            let valid = if root.relay {
                records.iter().any(|relay| {
                    relay.root == root.path && relay.identity == root.selection.directory
                })
            } else {
                root.path == foreground
            };
            if !valid {
                return Err(refused());
            }
            let lock = lock_selection(&root.path, root.relay, &root.selection)?;
            selected.push((root, lock));
        }
    }
    let engine = Engine::connect_cleanup(candidate)?;
    gate.verify(candidate)?;
    retention::verify_pruned(candidate, run)?;
    engine.verify()?;
    if absent(&journal)? {
        super::super::journal::retain_file(
            &target,
            "host-retirement.pending",
            "host-retirement-recovery",
            1024 * 1024,
        )?;
        let roots: Vec<_> = selected.iter().map(|(root, _)| root).collect();
        write_plan(&journal, &roots, &|_| Ok(()))?;
    }
    for (root, lock) in &selected {
        gate.verify(candidate)?;
        retire(
            &root.path,
            root.relay,
            &root.selection,
            lock.as_ref(),
            &|_| Ok(()),
        )?;
    }
    super::super::journal::retain_file(
        &target,
        "host-retirement-complete.pending",
        "host-retirement-recovery",
        1024 * 1024,
    )?;
    state::write(&completed, &selected.len())?;
    Ok(json!({"run":run,"retired_roots":selected.len()}))
}
