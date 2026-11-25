//! Room for a new dependency cache volume (HACK-2576).
//!
//! A cache volume is shared by content: every change to its inputs (lockfile, image,
//! command, env) makes a new one, and a writable cache is scoped per instance. Graph
//! cleanup only releases a cache, never deletes it, so a pool owner reached 64 cache
//! volumes in ordinary use, and from then on every start that needed a cache refused
//! for ever (`graph_cache_capacity`).
//!
//! Now the oldest cache volumes that nothing refers to are deleted to make room. A
//! volume is referred to when its name appears in any graph receipt that is not
//! `removed` (a retained run must find every volume it recorded when it restores, or
//! the restore refuses `graph_data_missing`), in any native-authored receipt, or in a
//! cache quarantine record. A receipt or record that cannot be read refuses as before.
//! The engine refuses to delete a volume a container still uses; such a volume is
//! kept. The caller holds the provider lease.
use crate::CandidateError;
use serde_json::Value;
use std::{fs, path::Path};

/// Cache volumes one pool owner keeps.
pub(super) const LIMIT: usize = 64;
/// Bound on entries read from one directory and on one file's bytes.
const ENTRIES: usize = 1024;
const BYTES: u64 = 4 * 1024 * 1024;

fn unreadable() -> CandidateError {
    CandidateError::new(
        "graph_cache_inventory",
        "Cannot verify cache volume admission inventory.",
    )
}

/// The bytes of every record that may refer to a cache volume, under `run_dir`
/// (`<state root>/run`): graph receipts not `removed`, native-authored receipts and
/// cache quarantine records. An absent directory has none.
pub(super) fn references(run_dir: &Path) -> Result<Vec<Vec<u8>>, CandidateError> {
    let mut found = Vec::new();
    for (directory, receipts) in [
        ("graphs", Some(true)),
        ("native-graphs", Some(false)),
        ("cache-quarantine", None),
    ] {
        let parent = run_dir.join(directory);
        match fs::symlink_metadata(&parent) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(unreadable()),
            Ok(metadata) if !metadata.is_dir() => return Err(unreadable()),
            Ok(_) => {}
        }
        let entries: Vec<_> = fs::read_dir(&parent)
            .map_err(|_| unreadable())?
            .take(ENTRIES + 1)
            .collect::<Result<_, _>>()
            .map_err(|_| unreadable())?;
        if entries.len() > ENTRIES {
            return Err(unreadable());
        }
        for entry in entries {
            let path = match receipts {
                Some(_) => entry.path().join("state.json"),
                None => entry.path(),
            };
            let metadata = match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && receipts.is_some() => {
                    // A run directory without a receipt: its pending journal may name
                    // a cache, so the whole directory counts.
                    found.push(read_tree(&entry.path())?);
                    continue;
                }
                Err(_) => return Err(unreadable()),
                Ok(metadata) => metadata,
            };
            if metadata.is_dir() {
                found.push(read_tree(&path)?);
                continue;
            }
            let bytes = read(&path)?;
            if receipts == Some(true) && phase(&bytes).as_deref() == Some("removed") {
                // A removed run holds no data; the engine still refuses a volume in use.
                if !pending(&entry.path()) {
                    continue;
                }
            }
            found.push(bytes);
            if receipts.is_some() && pending(&entry.path()) {
                found.push(read(&entry.path().join("state.pending"))?);
            }
        }
    }
    Ok(found)
}

fn pending(run: &Path) -> bool {
    let path = run.join("state.pending");
    path.exists() || path.is_symlink()
}
fn read(path: &Path) -> Result<Vec<u8>, CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| unreadable())?;
    if !metadata.is_file() || metadata.len() > BYTES {
        return Err(unreadable());
    }
    fs::read(path).map_err(|_| unreadable())
}
/// Every file directly in `directory`, concatenated. Anything else in it (a
/// subdirectory, a symlink) or more entries than the bound cannot be read as "no
/// reference", so it refuses.
fn read_tree(directory: &Path) -> Result<Vec<u8>, CandidateError> {
    if !fs::symlink_metadata(directory).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(unreadable());
    }
    let entries: Vec<_> = fs::read_dir(directory)
        .map_err(|_| unreadable())?
        .take(ENTRIES + 1)
        .collect::<Result<_, _>>()
        .map_err(|_| unreadable())?;
    if entries.len() > ENTRIES {
        return Err(unreadable());
    }
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend(read(&entry.path())?);
        bytes.push(b'\n');
    }
    Ok(bytes)
}
fn phase(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()?
        .get("phase")?
        .as_str()
        .map(str::to_owned)
}

/// How many cache volumes `owner` has, and which of them nothing in `references`
/// names, oldest first (`CreatedAt`, then name). Only plain names are offered.
pub(super) fn evictable(
    volumes: &[Value],
    owner: &str,
    references: &[Vec<u8>],
) -> (usize, Vec<String>) {
    let caches: Vec<_> = volumes
        .iter()
        .filter(|v| {
            v["Labels"]["io.hack-local.owner"] == owner
                && v["Labels"]["io.hack-local.kind"] == "dependency-cache"
        })
        .collect();
    let mut unreferenced: Vec<(String, String)> = caches
        .iter()
        .filter_map(|v| {
            let name = v["Name"].as_str()?;
            let plain = !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
            let quoted = format!("\"{name}\"");
            let named = references.iter().any(|bytes| {
                bytes
                    .windows(quoted.len())
                    .any(|window| window == quoted.as_bytes())
            });
            (plain && !named).then(|| {
                (
                    v["CreatedAt"].as_str().unwrap_or_default().to_owned(),
                    name.to_owned(),
                )
            })
        })
        .collect();
    unreferenced.sort();
    (
        caches.len(),
        unreferenced.into_iter().map(|(_, name)| name).collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache(name: &str, created: &str) -> Value {
        json!({"Name":name,"CreatedAt":created,"Labels":{
            "io.hack-local.owner":"owner","io.hack-local.kind":"dependency-cache"}})
    }

    #[test]
    fn only_unreferenced_caches_of_this_owner_are_offered_oldest_first() {
        let volumes = vec![
            cache("hkc-new", "2026-11-20T00:00:00Z"),
            cache("hkc-old", "2026-01-01T00:00:00Z"),
            cache("hkc-kept", "2025-01-01T00:00:00Z"),
            cache("hkc-mid", "2026-06-01T00:00:00Z"),
            cache("bad name", "2024-01-01T00:00:00Z"),
            json!({"Name":"other","CreatedAt":"2020-01-01T00:00:00Z","Labels":{
                "io.hack-local.owner":"another","io.hack-local.kind":"dependency-cache"}}),
            json!({"Name":"data","Labels":{"io.hack-local.owner":"owner","io.hack-local.kind":"volume"}}),
        ];
        let references = vec![br#"{"resources":{"v":{"name":"hkc-kept"}}}"#.to_vec()];
        let (count, offered) = evictable(&volumes, "owner", &references);
        assert_eq!(count, 5);
        assert_eq!(offered, ["hkc-old", "hkc-mid", "hkc-new"]);
        // A name that only appears as a prefix of another is not a reference.
        let prefix = vec![br#""hkc-old-2""#.to_vec()];
        assert!(
            evictable(&volumes, "owner", &prefix)
                .1
                .contains(&"hkc-old".to_owned())
        );
    }

    #[test]
    fn retained_runs_native_receipts_and_quarantine_records_refer_removed_runs_do_not() {
        let run = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-cache-retention-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        let write = |path: &str, body: &str| {
            let path = run.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        };
        assert!(references(&run).unwrap().is_empty());
        write(
            "graphs/a/state.json",
            r#"{"phase":"stopped-data-retained","x":"hkc-a"}"#,
        );
        write("graphs/b/state.json", r#"{"phase":"removed","x":"hkc-b"}"#);
        write("graphs/c/state.json", r#"{"phase":"removed","x":"hkc-c"}"#);
        write("graphs/c/state.pending", r#"{"x":"hkc-c2"}"#);
        write(
            "native-graphs/d/state.json",
            r#"{"phase":"stopped","x":"hkc-d"}"#,
        );
        write("cache-quarantine/e.json", r#"{"x":"hkc-e"}"#);
        let all = references(&run).unwrap().concat();
        let has = |name: &str| String::from_utf8_lossy(&all).contains(&format!("\"{name}\""));
        for name in ["hkc-a", "hkc-c", "hkc-c2", "hkc-d", "hkc-e"] {
            assert!(has(name), "{name}");
        }
        assert!(!has("hkc-b"));
        // An unreadable receipt refuses instead of reading as no reference.
        std::os::unix::fs::symlink("/nonexistent", run.join("graphs/f")).unwrap();
        assert!(references(&run).is_err());
        let _ = fs::remove_dir_all(&run);
    }
}
