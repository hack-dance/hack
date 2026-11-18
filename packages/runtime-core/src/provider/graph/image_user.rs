//! A named image or Compose user (`USER app`, `user: postgres:postgres`) resolved to the
//! numeric `UID:GID` that private delivery needs, from the pinned image's own
//! `/etc/passwd` and `/etc/group`. The guest mounts the image's own overlay2 layers as one
//! read-only overlay, so the kernel applies whiteouts and opaque directories exactly as in a
//! container, and nothing is created or started. A symlinked `etc` or account file, an
//! oversized file, or a name the image does not define gets no resolution, so the numeric
//! check refuses it as before.
use crate::CandidateError;
use crate::provider::engine::Engine;
use serde_json::Value;

/// At most this many bytes of each account file are read.
const ACCOUNT_FILE_BYTES: usize = 64 * 1024;
/// Account names longer than this are not looked up.
const MAX_NAME: usize = 64;
/// Images with more layers than this are not searched.
const MAX_LAYERS: usize = 256;

/// The overlay2 layer directories of one image, newest first. Each must be an ordinary
/// path below the engine's overlay2 root; anything else gets no resolution.
const LAYER_ROOT: &str = "/var/lib/docker/overlay2/";

/// Mounts the layers (given by their short `l/` links, top first) read-only, then prints
/// only the fields a name needs, so the report is a few hundred bytes whatever the files
/// hold: `passwd <b64>` holds `name:x:uid:gid` for the first entry with the user's UID and
/// for the user's own entry, and `group <b64>` holds `name:x:gid` for the group. Each is `absent`, `symlink` or `large`
/// instead when the file cannot be used. A single layer is read in place.
const READ_ACCOUNT_LINES: &str = r#"set -eu
budget=$1; user=$2; group=$3; shift 3
root=/var/lib/docker/overlay2
cd "$root"
lower=""
for id in "$@"; do
  case "$id" in ""|*[!A-Za-z0-9]*) exit 5;; esac
  test -d "$id/diff" && test ! -L "$id" && test ! -L "$id/diff" && test -f "$id/link" && test ! -L "$id/link"
  link=$(head -c 64 "$id/link")
  case "$link" in ""|*[!A-Za-z0-9]*) exit 5;; esac
  test -L "l/$link"
  lower="${lower:+$lower:}l/$link"
done
case "$lower" in *:*)
  mnt=$(mktemp -d)
  trap 'umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
  mount -t overlay -o "ro,lowerdir=$lower" overlay "$mnt"
  ;;
*) mnt="$root/$1/diff";;
esac
report() {
  name=$1; key=$2; f="$mnt/etc/$name"
  if test -L "$mnt/etc" || test -L "$f"; then echo "$name symlink"; return; fi
  if ! test -f "$f"; then echo "$name absent"; return; fi
  if test "$(stat -c %s "$f")" -gt "$budget"; then echo "$name large"; return; fi
  if test "$name" = passwd; then
    lines=$(awk -F: -v n="$key" '
      function ok() { return length($1) <= 64 && $3 ~ /^[0-9]+$/ && length($3) <= 10 && $4 ~ /^[0-9]+$/ && length($4) <= 10 }
      NR == FNR { if ($1 == n && u == "" && ok()) u = $3; next }
      u != "" && $3 == u && !first && ok() { print $1 ":x:" $3 ":" $4; first = 1 }
      $1 == n && own == "" && ok() { own = $1 ":x:" $3 ":" $4 }
      END { if (own != "") print own }' "$f" "$f")
  else
    lines=$(awk -F: -v n="$key" '$1 == n && length($1) <= 64 && $3 ~ /^[0-9]+$/ && length($3) <= 10 { print $1 ":x:" $3; exit }' "$f")
  fi
  printf '%s %s\n' "$name" "$(printf '%s\n' "$lines" | base64 -w0)"
}
if test -n "$user"; then report passwd "$user"; fi
if test -n "$group"; then report group "$group"; fi
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

/// The image's overlay2 layer IDs, newest first, or `None` for any other shape. Each
/// directory must be `<root>/<id>/diff` with a plain alphanumeric ID.
fn layers(image: &Value) -> Option<Vec<String>> {
    let driver = &image["GraphDriver"];
    if driver["Name"].as_str() != Some("overlay2") {
        return None;
    }
    let mut dirs = Vec::new();
    if let Some(upper) = driver["Data"]["UpperDir"].as_str() {
        dirs.push(upper);
    }
    if let Some(lower) = driver["Data"]["LowerDir"].as_str() {
        dirs.extend(lower.split(':'));
    }
    let id = |dir: &str| {
        dir.strip_prefix(LAYER_ROOT)?
            .strip_suffix("/diff")
            .filter(|id| {
                !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .map(str::to_owned)
    };
    let ids: Option<Vec<String>> = dirs.into_iter().map(id).collect();
    ids.filter(|ids| !ids.is_empty() && ids.len() <= MAX_LAYERS)
}

/// Account files by name: `Some(text)` when present and readable, `None` when absent.
/// A symlinked, oversized or unreadable file stops resolution (`Err(())`).
fn parse_files(output: &str) -> Result<std::collections::BTreeMap<String, Option<String>>, ()> {
    use base64::Engine as _;
    let mut files = std::collections::BTreeMap::new();
    for line in output.lines() {
        let (name, value) = line.split_once(' ').ok_or(())?;
        let text = match value {
            "absent" => None,
            "symlink" | "large" => return Err(()),
            encoded => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| ())?;
                if bytes.len() > ACCOUNT_FILE_BYTES {
                    return Err(());
                }
                Some(String::from_utf8(bytes).map_err(|_| ())?)
            }
        };
        files.insert(name.to_owned(), text);
    }
    Ok(files)
}

/// The numeric `UID:GID` for a named `user` in the inspected `image`, or `None` when the
/// image does not define it or its account files cannot be read safely. Read-only.
pub(super) fn resolve(
    engine: &Engine<'_>,
    image: &Value,
    user: &str,
) -> Result<Option<String>, CandidateError> {
    let Some(ids) = layers(image) else {
        return Ok(None);
    };
    let (uid, gid) = user.split_once(':').unwrap_or((user, ""));
    let user_name = if numeric(uid) { "" } else { uid };
    let group_name = if gid.is_empty() || numeric(gid) {
        ""
    } else {
        gid
    };
    // Account names longer than this are never resolved; the guest report stays bounded.
    if user_name.len() > MAX_NAME || group_name.len() > MAX_NAME {
        return Ok(None);
    }
    let budget = ACCOUNT_FILE_BYTES.to_string();
    let mut arguments: Vec<&str> = vec![&budget, user_name, group_name];
    arguments.extend(ids.iter().map(String::as_str));
    let Ok(output) = engine.guest().execute(READ_ACCOUNT_LINES, &arguments, None) else {
        return Ok(None);
    };
    let Ok(files) = parse_files(&output) else {
        return Ok(None);
    };
    let passwd = files.get("passwd").cloned().flatten().unwrap_or_default();
    // Only a bare name becomes a bare UID, which Docker maps to the first account with it.
    if !user.contains(':') && !first_with_uid_is(&passwd, user_name) {
        return Ok(None);
    }
    let group = files.get("group").cloned().flatten();
    Ok(resolve_text(user, &passwd, group.as_deref()))
}

/// Docker resolves a numeric UID to the first account with that UID. Writing a bare name
/// as its UID is only faithful when that first account is the name itself; otherwise the
/// process would get another account's groups, so the name is left unresolved.
fn first_with_uid_is(passwd: &str, name: &str) -> bool {
    let Some((uid, _)) = passwd_entry(passwd, name) else {
        return false;
    };
    passwd
        .lines()
        .find(|line| line.split(':').nth(2) == Some(uid.as_str()))
        .and_then(|line| line.split(':').next())
        == Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/sh\npostgres:x:70:70::/var/lib/postgresql:/bin/sh\ntemporal:x:1000:1000::/srv/temporal:/bin/sh\n";
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
                "/var/lib/docker/overlay2/a1/diff",
                "/var/lib/docker/overlay2/b2/diff:/var/lib/docker/overlay2/c3/diff"
            ))
            .unwrap(),
            ["a1", "b2", "c3"]
        );
        assert!(layers(&image("vfs", "/var/lib/docker/overlay2/a/diff", "")).is_none());
        assert!(layers(&image("overlay2", "/tmp/a/diff", "")).is_none());
        assert!(layers(&image("overlay2", "/var/lib/docker/overlay2/../x/diff", "")).is_none());
        assert!(layers(&image("overlay2", "/var/lib/docker/overlay2/a b/diff", "")).is_none());
        assert!(layers(&image("overlay2", "/var/lib/docker/overlay2/a/merged", "")).is_none());
    }

    #[test]
    fn account_files_are_decoded_and_unsafe_files_stop_resolution() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(PASSWD);
        let files = parse_files(&format!("passwd {encoded}\ngroup absent\n")).unwrap();
        assert_eq!(files["passwd"].as_deref(), Some(PASSWD));
        assert_eq!(files["group"], None);
        assert!(parse_files("passwd symlink\n").is_err());
        assert!(parse_files("group large\n").is_err());
        assert!(parse_files("passwd !!notbase64\n").is_err());
        // A shared UID whose first account is another name is not resolved.
        let shared = "first:x:1000:100::/:/bin/sh\napp:x:1000:200::/:/bin/sh\n";
        assert!(!first_with_uid_is(shared, "app"));
        assert!(first_with_uid_is(shared, "first"));
        assert!(first_with_uid_is(PASSWD, "temporal"));
        assert!(!first_with_uid_is(PASSWD, "missing"));
        // With an explicit group the identity is UID:GID, so a shared UID is not ambiguous.
        assert_eq!(resolve_text("app:200", shared, None).unwrap(), "1000:200");
        assert_eq!(
            resolve_text("app:staff", shared, Some("staff:x:300\n")).unwrap(),
            "1000:300"
        );
        // A group-only lookup needs no passwd file.
        assert_eq!(
            resolve_text("1000:shared", "", Some(GROUP)).unwrap(),
            "1000:2000"
        );
    }
}
