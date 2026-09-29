//! Interrupted publication is retained before an explicitly requested fresh attempt.
use super::{lifecycle::OwnedGuest, source_transfer::Publication, state};
use crate::{Candidate, CandidateError};
use sha2::{Digest, Sha256};

pub(super) fn prepare(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    publication: &Publication,
    reconcile: bool,
) -> Result<String, CandidateError> {
    let directory = candidate
        .state_root
        .join("run/source-publication-intents")
        .join(&publication.namespace);
    state::private_directory(&directory)?;
    let path = directory.join(format!("{}.json", publication.manifest.revision));
    let bytes = serde_json::to_vec(publication).map_err(|_| {
        CandidateError::new("source_publication", "Cannot encode publication intent.")
    })?;
    let owner = format!("{:x}", Sha256::digest(&bytes));
    if path.try_exists().map_err(state::io)? {
        let previous: Publication = state::read_bounded(&path, 16 * 1024 * 1024)?;
        let previous = serde_json::to_vec(&previous).map_err(|_| {
            CandidateError::new("source_publication", "Cannot encode prior intent.")
        })?;
        if previous != bytes {
            return Err(CandidateError::new(
                "foreign_source_publication",
                "Publication intent belongs to another source or provider incarnation.",
            ));
        }
    } else {
        state::write(&path, publication)?;
    }
    let root = format!("/storage/hack-source/{}", publication.namespace);
    let pending = format!("{root}/{}.pending", publication.manifest.revision);
    let complete = format!("{root}/{}", publication.manifest.revision);
    guest.execute(
        r#"
umask 077
for d in /storage/hack-source "$1"; do
  test ! -L "$d"
  if test ! -e "$d"; then mkdir "$d"; fi
  test -d "$d"
  test "$(stat -c %u:%a "$d")" = 0:700
done
if test -e "$3" || test -L "$3"; then
  test ! -L "$3"; test -d "$3"
  test ! -L "$3/archive.sha256"
  test "$(cat "$3/archive.sha256")" = "$4"
  printf reused
  exit 0
fi
if test -e "$2" || test -L "$2"; then
  test "$6" = reconcile
  test ! -L "$2"; test -d "$2"
  test "$(stat -c %u:%a "$2")" = 0:700
  test ! -L "$2/owner"; test -f "$2/owner"
  test "$(stat -c %u:%a:%h "$2/owner")" = 0:600:1
  test "$(cat "$2/owner")" = "$5"
  retained=
  for n in 1 2 3 4 5 6 7 8; do
    target="$3.retained-$n"
    if test ! -e "$target" && test ! -L "$target"; then retained="$target"; break; fi
  done
  test -n "$retained"
  mv -T "$2" "$retained"
  sync
fi
mkdir "$2"
(set -C; printf '%s' "$5" > "$2/owner")
sync
mkdir "$2/tree"
(set -C; : > "$2/source.tar"; : > "$2/files.sha256"; : > "$2/verify.sh")
printf created
"#,
        &[
            &root,
            &pending,
            &complete,
            &publication.archive_sha256,
            &owner,
            if reconcile { "reconcile" } else { "normal" },
        ],
        None,
    )
}
