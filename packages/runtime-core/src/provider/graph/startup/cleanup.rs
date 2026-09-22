//! Exact guest startup artifacts, validated before deletion and absent after it.
use super::*;
pub(in crate::provider::graph) fn apply(
    engine: &Engine<'_>,
    receipt: &Receipt,
    remove: bool,
) -> Result<(), CandidateError> {
    let Some(startup) = &receipt.relay_startup else {
        return Ok(());
    };
    if startup.control_only {
        return absent(engine, receipt);
    }
    let generations = startup
        .services
        .values()
        .map(|s| s.generation.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let output = engine.guest().execute_cleanup(
        SCRIPT,
        &[
            &receipt.run,
            &receipt.owner,
            &startup.artifact,
            &generations,
            if remove { "remove" } else { "check" },
            &startup
                .guest_root
                .map(|(d, i)| format!("{d}:{i}"))
                .unwrap_or_else(|| "-".into()),
        ],
    )?;
    if output != "startup-cleanup-v1\n" {
        return Err(error(
            "graph_startup_cleanup",
            "Guest startup artifacts changed.",
        ));
    }
    Ok(())
}
pub(in crate::provider::graph) fn retire_service(
    engine: &Engine<'_>,
    receipt: &Receipt,
    service: &str,
) -> Result<(), CandidateError> {
    let Some(startup) = &receipt.relay_startup else {
        return Ok(());
    };
    let Some(selected) = startup.services.get(service) else {
        return Ok(());
    };
    let generations = startup
        .services
        .values()
        .map(|s| s.generation.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let identity = startup
        .guest_root
        .map(|(d, i)| format!("{d}:{i}"))
        .ok_or_else(|| {
            error(
                "graph_startup_cleanup",
                "Missing startup directory identity.",
            )
        })?;
    let output = engine.guest().execute_cleanup(
        SCRIPT,
        &[
            &receipt.run,
            &receipt.owner,
            &startup.artifact,
            &generations,
            "remove-generation",
            &identity,
            &selected.generation,
        ],
    )?;
    if output != "startup-cleanup-v1\n" {
        return Err(error(
            "graph_startup_cleanup",
            "One-off startup removal was not confirmed.",
        ));
    }
    Ok(())
}
pub(in crate::provider::graph) fn absent(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if receipt.relay_startup.is_some() {
        let path = format!("/storage/hack-graph-startup/{}", receipt.run);
        let output = engine.guest().execute_cleanup(ABSENT, &[&path])?;
        if output != "startup-absent-v1\n" {
            return Err(error(
                "graph_startup_cleanup",
                "Guest startup artifacts remain.",
            ));
        }
    }
    Ok(())
}
const ABSENT: &str = "set -eu; test ! -e \"$1\"; test ! -L \"$1\"; printf 'startup-absent-v1\\n'";

#[cfg(test)]
mod absence_tests {
    use super::*;
    #[test]
    fn independent_absence_refuses_existing_and_dangling_artifacts() {
        let root = crate::provider::graph::tests::Fixture::new();
        let path = root.0.join("startup");
        let observe = || {
            std::process::Command::new("sh")
                .args(["-c", ABSENT, "sh"])
                .arg(&path)
                .output()
                .unwrap()
        };
        assert!(observe().status.success());
        std::fs::create_dir(&path).unwrap();
        let result = observe();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        std::fs::remove_dir(&path).unwrap();
        std::os::unix::fs::symlink(root.0.join("missing"), &path).unwrap();
        let result = observe();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert!(path.symlink_metadata().unwrap().file_type().is_symlink());
    }
}

macro_rules! pending_check {
    () => {
        r#"
 test -f "$item"; test "$(stat -c %u:%g:%h "$item")" = 0:0:1
 test "$(stat -c %s "$item")" -le 2097152
 case "$(stat -c %a "$item")" in
  600) ;;
  555) test "$(sha256sum "$item" | cut -d' ' -f1)" = "$3" ;;
  *) exit 64;;
 esac
"#
    };
}
const SCRIPT: &str = concat!(
    r#"
root="/storage/hack-graph-startup/$1"
if test ! -e "$root" && test ! -L "$root"; then printf 'startup-cleanup-v1\n'; exit 0; fi
test ! -L /storage/hack-graph-startup; test "$(stat -c %u:%g:%a /storage/hack-graph-startup)" = 0:0:700
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
if test "$6" != -; then test "$(stat -c %d:%i "$root")" = "$6"; fi
if test ! -e "$root/owner" && test ! -L "$root/owner"; then
 test "$6" != -
 for item in "$root"/* "$root"/.[!.]* "$root"/..?*; do test ! -e "$item"; test ! -L "$item"; done
 if test "$5" = remove; then rmdir "$root"; sync -f /storage/hack-graph-startup; fi
 printf 'startup-cleanup-v1\n'; exit 0
fi
test ! -L "$root/owner"; test -f "$root/owner"; test "$(stat -c %u:%g:%a:%h:%s "$root/owner")" = 0:0:444:1:33
test "$(cat "$root/owner")" = "$2"
for item in "$root"/* "$root"/.[!.]* "$root"/..?*; do
 if test ! -e "$item" && test ! -L "$item"; then continue; fi
 name=${item##*/}; test ! -L "$item"
 case "$name" in
 owner) ;;
 helper) test -f "$item"; test "$(stat -c %u:%g:%a:%h "$item")" = 0:0:555:1; test "$(sha256sum "$item" | cut -d' ' -f1)" = "$3" ;;
 helper.pending)
"#,
    pending_check!(),
    r#"
 ;;
 *)
  case " $4 " in *" $name "*) ;; *) exit 61;; esac
  test -d "$item"; test "$(stat -c %u:%g:%a "$item")" = 0:0:555
  for child in "$item"/* "$item"/.[!.]* "$item"/..?*; do
   if test ! -e "$child" && test ! -L "$child"; then continue; fi
   leaf=${child##*/}; test ! -L "$child"; test -f "$child"; test "$(stat -c %u:%g:%h "$child")" = 0:0:1
   case "$leaf" in
   release) test "$(stat -c %a:%s "$child")" = 444:33; test "$(cat "$child")" = "$name" ;;
   pending) test "$(stat -c %s "$child")" -le 33; case "$(stat -c %a "$child")" in 600|444) ;; *) exit 62;; esac ;;
   *) exit 63;;
   esac
  done
 ;;
 esac
done
if test "$5" = remove-generation; then
 case " $4 " in *" $7 "*) ;; *) exit 61;; esac
 directory="$root/$7"
 if test -d "$directory"; then
  for leaf in release pending; do if test -f "$directory/$leaf"; then rm "$directory/$leaf"; fi; done
  rmdir "$directory"; sync -f "$root"
 fi
fi
if test "$5" = remove; then
 for generation in $4; do
  directory="$root/$generation"
  if test -d "$directory"; then
   for leaf in release pending; do if test -f "$directory/$leaf"; then rm "$directory/$leaf"; fi; done
   rmdir "$directory"
  fi
 done
 for leaf in helper helper.pending; do if test -f "$root/$leaf"; then rm "$root/$leaf"; fi; done
 rm "$root/owner"; rmdir "$root"; sync -f /storage/hack-graph-startup
fi
printf 'startup-cleanup-v1\n'"#
);

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    #[test]
    fn interrupted_published_mode_requires_full_hash_but_partial_upload_remains_removable() {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let item = fixture.0.join("helper.pending");
        std::fs::write(&item, b"owned-artifact").unwrap();
        // Host metadata commands differ from the Linux guest. Supply only their
        // deterministic observations; execute the exact production decision block.
        let harness = format!(
            r#"
set -eu
item=$1; mode=$2; expected=$3; actual=$4; length=$5
stat() {{
 case "$2" in
  %u:%g:%h) printf '0:0:1\n' ;;
  %s) printf '%s\n' "$length" ;;
  %a) printf '%s\n' "$mode" ;;
  *) exit 90;;
 esac
}}
sha256sum() {{ printf '%s  artifact\n' "$actual"; }}
{}
"#,
            pending_check!()
        );
        for (mode, actual, length, accepted) in [
            ("555", "matching", "14", true),
            ("555", "wrong", "14", false),
            ("600", "partial-not-matching", "7", true),
            ("600", "matching", "2097153", false),
            ("755", "matching", "14", false),
        ] {
            let result = Command::new("/bin/sh")
                .args([
                    "-c",
                    &harness,
                    "sh",
                    item.to_str().unwrap(),
                    mode,
                    "matching",
                    actual,
                    length,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert_eq!(
                result.success(),
                accepted,
                "pending mode/hash case {mode}/{actual}"
            );
            assert_eq!(std::fs::read(&item).unwrap(), b"owned-artifact");
        }
    }
}
