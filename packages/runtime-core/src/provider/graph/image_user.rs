//! A named image or Compose user (`USER app`, `user: postgres:postgres`) resolved to the
//! numeric `UID:GID` that private delivery needs, from the pinned image's own
//! `/etc/passwd` and `/etc/group`. The files are read from the image's overlay2 layers in
//! the guest, newest layer first, so nothing is created or started. A name the image does
//! not define still refuses, as before.
use crate::CandidateError;
use crate::provider::engine::Engine;
use serde_json::Value;

/// At most this many bytes of each account file are read.
const ACCOUNT_FILE_BYTES: usize = 64 * 1024;
/// Images with more layers than this are not searched.
const MAX_LAYERS: usize = 256;

/// The overlay2 layer directories of one image, newest first. Each must be an ordinary
/// path below the engine's overlay2 root; anything else gets no resolution.
const LAYER_ROOT: &str = "/var/lib/docker/overlay2/";

/// Reads one account file from the newest layer that has it. Exit 3: the name is hidden
/// or absent (a whiteout or an opaque `etc` stops the search, as overlayfs does).
const READ_ACCOUNT_FILE: &str = r#"set -eu
name=$1; budget=$2; shift 2
for dir in "$@"; do
  f="$dir/etc/$name"
  if test -L "$f"; then exit 4; fi
  if test -f "$f"; then head -c "$budget" -- "$f"; exit 0; fi
  if test -e "$dir/etc/.wh.$name" || test -e "$dir/etc/.wh..wh..opq"; then exit 3; fi
done
exit 3
"#;

fn numeric(value: &str) -> bool {
    !value.is_empty() && value.len() <= 10 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Whether `user` names an account rather than giving numeric IDs only.
pub(super) fn named(user: &str) -> bool {
    let (uid, gid) = user.split_once(':').unwrap_or((user, ""));
    (!uid.is_empty() && !numeric(uid)) || (!gid.is_empty() && !numeric(gid))
}

/// `uid` and primary `gid` of `name` in passwd text.
fn passwd_entry(passwd: &str, name: &str) -> Option<(String, String)> {
    passwd.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() >= 4 && fields[0] == name && numeric(fields[2]) && numeric(fields[3]))
            .then(|| (fields[2].to_owned(), fields[3].to_owned()))
    })
}

/// `gid` of `name` in group text.
fn group_entry(group: &str, name: &str) -> Option<String> {
    group.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() >= 3 && fields[0] == name && numeric(fields[2])).then(|| fields[2].to_owned())
    })
}

/// Docker's rule: `name` takes its primary group; `name:group` and `uid:group` look the
/// group up; a numeric part is kept. `None` when a name is not defined.
pub(super) fn resolve_text(user: &str, passwd: &str, group: Option<&str>) -> Option<String> {
    let (uid_part, gid_part) = match user.split_once(':') {
        Some((uid, gid)) => (uid, Some(gid)),
        None => (user, None),
    };
    let account = (!numeric(uid_part))
        .then(|| passwd_entry(passwd, uid_part))
        .flatten();
    let uid = if numeric(uid_part) {
        uid_part.to_owned()
    } else {
        account.as_ref()?.0.clone()
    };
    let gid = match gid_part {
        Some(gid) if numeric(gid) => gid.to_owned(),
        Some(gid) if !gid.is_empty() => group_entry(group?, gid)?,
        _ => account?.1,
    };
    Some(format!("{uid}:{gid}"))
}

/// The image's overlay2 layer directories, newest first, or `None` for any other shape.
fn layers(image: &Value) -> Option<Vec<String>> {
    let driver = &image["GraphDriver"];
    if driver["Name"].as_str() != Some("overlay2") {
        return None;
    }
    let mut dirs = Vec::new();
    if let Some(upper) = driver["Data"]["UpperDir"].as_str() {
        dirs.push(upper.to_owned());
    }
    if let Some(lower) = driver["Data"]["LowerDir"].as_str() {
        dirs.extend(lower.split(':').map(str::to_owned));
    }
    let valid = |dir: &String| {
        dir.starts_with(LAYER_ROOT)
            && !dir.split('/').any(|part| part == "..")
            && dir
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    };
    (!dirs.is_empty() && dirs.len() <= MAX_LAYERS && dirs.iter().all(valid)).then_some(dirs)
}

fn read(engine: &Engine<'_>, dirs: &[String], name: &str) -> Option<String> {
    let budget = ACCOUNT_FILE_BYTES.to_string();
    let mut arguments: Vec<&str> = vec![name, &budget];
    arguments.extend(dirs.iter().map(String::as_str));
    engine
        .guest()
        .execute(READ_ACCOUNT_FILE, &arguments, None)
        .ok()
}

/// The numeric `UID:GID` for a named `user` in the inspected `image`, or `None` when the
/// image does not define it or its layers cannot be read. Read-only.
pub(super) fn resolve(
    engine: &Engine<'_>,
    image: &Value,
    user: &str,
) -> Result<Option<String>, CandidateError> {
    let Some(dirs) = layers(image) else {
        return Ok(None);
    };
    let Some(passwd) = read(engine, &dirs, "passwd") else {
        return Ok(None);
    };
    let needs_group = user
        .split_once(':')
        .is_some_and(|(_, gid)| !gid.is_empty() && !numeric(gid));
    let group = if needs_group {
        read(engine, &dirs, "group")
    } else {
        None
    };
    Ok(resolve_text(user, &passwd, group.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/sh\npostgres:x:70:70::/var/lib/postgresql:/bin/sh\ntemporal:x:1000:1000::/home/temporal:/bin/sh\n";
    const GROUP: &str = "root:x:0:\npostgres:x:70:\ntemporal:x:1000:\nshared:x:2000:temporal\n";

    #[test]
    fn named_users_resolve_by_docker_rules_and_unknown_names_do_not() {
        assert!(named("temporal"));
        assert!(named("1000:shared"));
        assert!(named("temporal:1000"));
        assert!(!named("1000"));
        assert!(!named("1000:1000"));
        assert!(!named(""));
        assert_eq!(resolve_text("temporal", PASSWD, None).unwrap(), "1000:1000");
        assert_eq!(resolve_text("postgres", PASSWD, None).unwrap(), "70:70");
        assert_eq!(
            resolve_text("temporal:shared", PASSWD, Some(GROUP)).unwrap(),
            "1000:2000"
        );
        assert_eq!(
            resolve_text("1000:shared", PASSWD, Some(GROUP)).unwrap(),
            "1000:2000"
        );
        assert_eq!(resolve_text("temporal:5", PASSWD, None).unwrap(), "1000:5");
        assert!(resolve_text("missing", PASSWD, None).is_none());
        assert!(resolve_text("temporal:missing", PASSWD, Some(GROUP)).is_none());
        assert!(resolve_text("temporal:shared", PASSWD, None).is_none());
        // A malformed line never resolves.
        assert!(resolve_text("bad", "bad:x:notanumber:0::/:/bin/sh\n", None).is_none());
    }

    #[test]
    fn only_ordinary_overlay2_layer_directories_are_searched() {
        let image = |name: &str, upper: &str, lower: &str| json!({"GraphDriver":{"Name":name,"Data":{"UpperDir":upper,"LowerDir":lower}}});
        assert_eq!(
            layers(&image(
                "overlay2",
                "/var/lib/docker/overlay2/a/diff",
                "/var/lib/docker/overlay2/b/diff:/var/lib/docker/overlay2/c/diff"
            ))
            .unwrap(),
            [
                "/var/lib/docker/overlay2/a/diff",
                "/var/lib/docker/overlay2/b/diff",
                "/var/lib/docker/overlay2/c/diff"
            ]
        );
        assert!(layers(&image("vfs", "/var/lib/docker/overlay2/a", "")).is_none());
        assert!(layers(&image("overlay2", "/tmp/a", "")).is_none());
        assert!(layers(&image("overlay2", "/var/lib/docker/overlay2/../x", "")).is_none());
        assert!(layers(&image("overlay2", "/var/lib/docker/overlay2/a b", "")).is_none());
    }
}
