use super::{lifecycle::OwnedGuest, source_sync, state};
use crate::{
    Candidate, CandidateError,
    project::snapshot::{ContentRevision, Snapshot},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Publication {
    pub checkout: PathBuf,
    pub namespace: String,
    pub provider_incarnation: String,
    pub manifest: ContentRevision,
    pub archive_sha256: String,
}

fn identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn publication_path(
    candidate: &Candidate,
    namespace: &str,
    revision: &str,
) -> Result<PathBuf, CandidateError> {
    if !identity(namespace) || !identity(revision) {
        return Err(CandidateError::new(
            "invalid_source_identity",
            "Invalid immutable source identity.",
        ));
    }
    Ok(candidate
        .state_root
        .join("run/source-publications")
        .join(namespace)
        .join(format!("{revision}.json")))
}

pub(super) fn load(
    candidate: &Candidate,
    namespace: &str,
    revision: &str,
) -> Result<Publication, CandidateError> {
    let path = publication_path(candidate, namespace, revision)?;
    crate::reject_aliased_state(path.parent().expect("publication parent"))?;
    if !path.try_exists().map_err(state::io)? {
        return Err(CandidateError::new(
            "source_not_published",
            "The requested immutable source revision is not published.",
        ));
    }
    let record: Publication = state::read_bounded(&path, 16 * 1024 * 1024)?;
    record.manifest.validate()?;
    if record.checkout != candidate.checkout
        || record.namespace != namespace
        || record.manifest.revision != revision
        || !identity(&record.archive_sha256)
    {
        return Err(CandidateError::new(
            "foreign_source_publication",
            "Immutable source receipt belongs to another identity.",
        ));
    }
    Ok(record)
}

pub(super) fn verify_published(
    guest: &OwnedGuest<'_>,
    record: &Publication,
) -> Result<(), CandidateError> {
    if record.provider_incarnation != guest.incarnation() {
        return Err(CandidateError::new(
            "foreign_source_publication",
            "Immutable source belongs to another provider incarnation.",
        ));
    }
    let root = format!(
        "/storage/hack-source/{}/{}",
        record.namespace, record.manifest.revision
    );
    let script = source_sync::verification(Some(&record.manifest));
    guest.execute(
        r#"
for path in /storage/hack-source "$4" "$1" "$1/tree"; do test ! -L "$path"; test -d "$path"; done
test ! -L "$1/archive.sha256"
test "$(cat "$1/archive.sha256")" = "$2"
test ! -L "$1/verify.sh"
test "$(sha256sum "$1/verify.sh" | cut -d ' ' -f 1)" = "$3"
(cd "$1/tree"; sh ../verify.sh)
test -z "$(find "$1/tree" ! -type l -perm /222 -print -quit)"
"#,
        &[
            &root,
            &record.archive_sha256,
            &digest(script.as_bytes()),
            &format!("/storage/hack-source/{}", record.namespace),
        ],
        None,
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TransferReceipt {
    pub revision: String,
    pub namespace: String,
    pub guest_path: String,
    pub archive_sha256: String,
    pub total_bytes: u64,
    pub state: &'static str,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn publish(
    candidate: &Candidate,
    namespace: &str,
    snapshot: &Snapshot,
) -> Result<TransferReceipt, CandidateError> {
    snapshot.receipt().validate()?;
    if namespace.len() != 64
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(CandidateError::new(
            "invalid_namespace",
            "Source transfer requires a candidate workspace identity.",
        ));
    }
    let guest = OwnedGuest::connect(candidate)?;
    let archive = snapshot.archive()?;
    let archive_sha = digest(&archive);
    let mut checksums = String::new();
    for (entry, _) in snapshot.files() {
        if let Some(sha) = &entry.sha256 {
            checksums.push_str(&format!("{sha}  ./{}\n", entry.path));
        }
    }
    let manifest_sha = digest(checksums.as_bytes());
    let revision = &snapshot.receipt().revision;
    let root = format!("/storage/hack-source/{namespace}");
    let pending = format!("{root}/{revision}.pending");
    let complete = format!("{root}/{revision}");
    let state = guest.execute(
        r#"
umask 077
for d in /storage/hack-source "$1"; do
  test ! -L "$d"
  if test ! -e "$d"; then mkdir "$d"; fi
  test -d "$d"
  test "$(stat -c %u:%a "$d")" = 0:700
done
if test -e "$3" || test -L "$3"; then
  test ! -L "$3"
  test -d "$3"
  test ! -L "$3/archive.sha256"
  test "$(cat "$3/archive.sha256")" = "$4"
  printf reused
else
  mkdir "$2"
  mkdir "$2/tree"
  (set -C; : > "$2/source.tar"; : > "$2/files.sha256")
  printf created
fi
"#,
        &[&root, &pending, &complete, &archive_sha],
        None,
    )?;
    if state == "created" {
        for (name, bytes) in [
            ("source.tar", archive.as_slice()),
            ("files.sha256", checksums.as_bytes()),
        ] {
            source_sync::upload(&guest, &format!("{pending}/{name}"), bytes)?;
        }
        guest.execute(
            r#"
test "$(sha256sum "$1/source.tar" | cut -d ' ' -f 1)" = "$2"
test "$(sha256sum "$1/files.sha256" | cut -d ' ' -f 1)" = "$3"
tar -xf "$1/source.tar" -C "$1/tree"
(cd "$1/tree"; sha256sum -c ../files.sha256 >/dev/null)
chmod -R a-w "$1/tree"
(set -C; printf '%s\n' "$2" > "$1/archive.sha256")
rm "$1/source.tar"
sync
test ! -e "$4"
test ! -L "$4"
mv -T "$1" "$4"
sync
"#,
            &[&pending, &archive_sha, &manifest_sha, &complete],
            None,
        )?;
    } else if state != "reused" {
        return Err(CandidateError::new(
            "source_transfer_uncertain",
            "Unexpected source transfer acknowledgement.",
        ));
    }
    guest.execute(
        r#"
test ! -L "$1/files.sha256"
test ! -L "$1/tree"
test "$(sha256sum "$1/files.sha256" | cut -d ' ' -f 1)" = "$2"
(cd "$1/tree"; sha256sum -c ../files.sha256 >/dev/null)
"#,
        &[&complete, &manifest_sha],
        None,
    )?;
    let verification = source_sync::verification(Some(snapshot.receipt()));
    let verifier = format!("{complete}/verify.sh");
    let created = guest.execute(
        r#"
test ! -L "$1"
if test -e "$1"; then
  test -f "$1"
  test "$(sha256sum "$1" | cut -d ' ' -f 1)" = "$2"
  printf reused
else
  (set -C; : > "$1")
  printf created
fi
"#,
        &[&verifier, &digest(verification.as_bytes())],
        None,
    )?;
    if created == "created" {
        source_sync::upload(&guest, &verifier, verification.as_bytes())?;
    } else if created != "reused" {
        return Err(CandidateError::new(
            "source_transfer_uncertain",
            "Immutable verifier acknowledgement is invalid.",
        ));
    }
    guest.execute(
        r#"test ! -L "$1"; test -f "$1"; chmod 444 "$1""#,
        &[&verifier],
        None,
    )?;
    let publication = Publication {
        checkout: candidate.checkout.clone(),
        namespace: namespace.into(),
        provider_incarnation: guest.incarnation().into(),
        manifest: snapshot.receipt().clone(),
        archive_sha256: archive_sha.clone(),
    };
    verify_published(&guest, &publication)?;
    let path = publication_path(candidate, namespace, revision)?;
    state::private_directory(path.parent().expect("publication parent"))?;
    if path.try_exists().map_err(state::io)? {
        let previous = load(candidate, namespace, revision)?;
        if previous.provider_incarnation != publication.provider_incarnation
            || previous.archive_sha256 != archive_sha
        {
            return Err(CandidateError::new(
                "foreign_source_publication",
                "A conflicting immutable source receipt already exists.",
            ));
        }
    } else {
        state::write(&path, &publication)?;
    }
    Ok(TransferReceipt {
        revision: revision.clone(),
        namespace: namespace.into(),
        guest_path: format!("{complete}/tree"),
        archive_sha256: archive_sha,
        total_bytes: snapshot.receipt().total_bytes,
        state: "guest-content-verified-no-job-started",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_load_reads_a_regular_receipt_and_refuses_aliases() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-publication-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        state::private_directory(&root).unwrap();
        let source = root.join("source");
        state::private_directory(&source).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        std::fs::write(
            source.join("compose.yaml"),
            "services:\n  app:\n    image: busybox:latest\n",
        )
        .unwrap();
        let plan = crate::project::plan(
            &candidate,
            crate::project::PlanOptions {
                project: &source,
                compose_file: std::path::Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let snapshot = crate::project::snapshot::capture(
            &source,
            &Default::default(),
            &plan.plan.source_selection.metadata_sha256,
        )
        .unwrap();
        let namespace = "b".repeat(64);
        let revision = &snapshot.receipt().revision;
        assert_eq!(
            load(&candidate, &namespace, revision).err().unwrap().code,
            "source_not_published"
        );
        let path = publication_path(&candidate, &namespace, revision).unwrap();
        state::private_directory(path.parent().unwrap()).unwrap();
        let record = Publication {
            checkout: candidate.checkout.clone(),
            namespace: namespace.clone(),
            provider_incarnation: "owned".into(),
            manifest: snapshot.receipt().clone(),
            archive_sha256: "c".repeat(64),
        };
        state::write(&path, &record).unwrap();
        assert_eq!(
            load(&candidate, &namespace, revision)
                .unwrap()
                .manifest
                .revision,
            *revision
        );
        let retained = path.with_extension("retained");
        std::fs::rename(&path, &retained).unwrap();
        std::os::unix::fs::symlink(&retained, &path).unwrap();
        assert!(load(&candidate, &namespace, revision).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&retained, &path).unwrap();
        assert!(load(&candidate, &namespace, revision).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
