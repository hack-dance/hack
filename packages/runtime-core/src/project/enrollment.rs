use super::*;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

const MAX_RECEIPT_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentReceipt {
    pub schema_version: u32,
    pub state: String,
    pub plan_id: String,
    pub plan: PlanData,
}
#[derive(Debug, Serialize)]
pub struct EnrollmentStatus {
    pub state: String,
    pub source: PathBuf,
    pub namespace: String,
    pub plan_id: Option<String>,
    pub runtime_execution_supported: bool,
}
fn directory(candidate: &Candidate, namespace: &str) -> PathBuf {
    candidate.state_root.join("run/workspaces").join(namespace)
}
fn check_directory(candidate: &Candidate, path: &Path) -> Result<(), CandidateError> {
    crate::reject_aliased_state(path)?;
    for path in path
        .ancestors()
        .take_while(|p| p.starts_with(&candidate.state_root))
    {
        let forbidden_mode = if path == candidate.state_root {
            0o022
        } else {
            0o077
        };
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if !metadata.is_dir()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.mode() & forbidden_mode != 0 =>
            {
                return Err(problem(
                    "foreign_enrollment_state",
                    "Enrollment directories must be private and owned by this user.",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(problem(
                    "enrollment_unavailable",
                    "Cannot inspect enrollment directory.",
                ));
            }
        }
    }
    Ok(())
}
pub(super) fn read(
    candidate: &Candidate,
    source: &Path,
    namespace: &str,
) -> Result<Option<EnrollmentReceipt>, CandidateError> {
    let root = directory(candidate, namespace);
    check_directory(candidate, &root)?;
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(problem(
                "enrollment_unavailable",
                "Cannot inspect enrollment.",
            ));
        }
        Ok(_) => {}
    }
    if root.join("enrollment.pending").try_exists().map_err(|_| {
        problem(
            "enrollment_unavailable",
            "Cannot inspect pending enrollment.",
        )
    })? {
        return Err(problem(
            "incomplete_enrollment",
            "Interrupted enrollment is retained for inspection; no automatic adoption or overwrite.",
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("enrollment.json"))
        .map_err(|_| {
            problem(
                "incomplete_enrollment",
                "Enrollment directory has no readable completed receipt; no adoption or overwrite.",
            )
        })?;
    let metadata = file.metadata().map_err(|_| {
        problem(
            "enrollment_unavailable",
            "Cannot inspect enrollment receipt.",
        )
    })?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > MAX_RECEIPT_BYTES
    {
        return Err(problem(
            "foreign_enrollment_state",
            "Unsafe or oversized enrollment receipt.",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| problem("enrollment_unavailable", "Cannot read enrollment receipt."))?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(problem(
            "foreign_enrollment_state",
            "Oversized enrollment receipt.",
        ));
    }
    let receipt: EnrollmentReceipt = serde_json::from_slice(&bytes).map_err(|_| {
        problem(
            "invalid_enrollment",
            "Malformed enrollment receipt; no adoption.",
        )
    })?;
    if receipt.schema_version != 1
        || receipt.state != "enrolled-no-runtime"
        || receipt.plan.schema_version != 1
        || receipt.plan.kind != "compose-enrollment-review-only"
        || receipt.plan.candidate_root != candidate.checkout
        || receipt.plan.source != source
        || receipt.plan.namespace != namespace
        || receipt.plan.runtime_execution_supported
        || !receipt.plan.enrollment_compatible
        || identity(&receipt.plan)? != receipt.plan_id
    {
        return Err(problem(
            "foreign_enrollment_state",
            "Enrollment owner, plan identity or supported schema does not match.",
        ));
    }
    Ok(Some(receipt))
}

pub fn status(candidate: &Candidate, project: &Path) -> Result<EnrollmentStatus, CandidateError> {
    let preview = candidate.plan(project)?;
    let previous = read(candidate, &preview.source, &preview.namespace)?;
    Ok(EnrollmentStatus {
        state: if previous.is_some() {
            "enrolled-no-runtime"
        } else {
            "not-enrolled"
        }
        .into(),
        source: preview.source,
        namespace: preview.namespace,
        plan_id: previous.map(|r| r.plan_id),
        runtime_execution_supported: false,
    })
}

pub fn enroll(
    candidate: &Candidate,
    options: PlanOptions<'_>,
    expected_plan: &str,
) -> Result<EnrollmentReceipt, CandidateError> {
    if expected_plan.len() != 64 || !expected_plan.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(problem(
            "invalid_plan_id",
            "Enrollment requires the SHA-256 plan ID from project plan; WU01 previews are not enrollment plans.",
        ));
    }
    let review = super::plan(
        candidate,
        PlanOptions {
            project: options.project,
            compose_file: options.compose_file,
            profiles: options.profiles,
        },
    )?;
    if review.plan_id != expected_plan {
        return Err(problem(
            "stale_plan",
            "Source/configuration/profile selection changed or the review ID is wrong. Nothing was enrolled.",
        ));
    }
    if !review.plan.enrollment_compatible {
        return Err(problem(
            "incompatible_compose",
            "Resolve the compatibility report before enrollment. Nothing was enrolled.",
        ));
    }
    let parent = candidate.state_root.join("run/workspaces");
    check_directory(candidate, &parent)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&parent)
        .map_err(|_| {
            problem(
                "enrollment_unavailable",
                "Cannot create private enrollment parent.",
            )
        })?;
    check_directory(candidate, &parent)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(parent.join("enrollment.lock"))
        .map_err(|_| problem("enrollment_unavailable", "Cannot acquire enrollment lock."))?;
    let metadata = lock
        .metadata()
        .map_err(|_| problem("enrollment_unavailable", "Cannot inspect enrollment lock."))?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(problem(
            "foreign_enrollment_state",
            "Unsafe enrollment lock.",
        ));
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(problem(
            "enrollment_busy",
            "Another enrollment operation holds this candidate's lock.",
        ));
    }
    // Lock is held through publication and released by close, including every error path.
    let current = super::plan(candidate, options)?;
    if current.plan_id != expected_plan {
        return Err(problem(
            "stale_plan",
            "Input changed while acquiring the enrollment lock. Nothing was enrolled.",
        ));
    }
    if let Some(existing) = read(candidate, &current.plan.source, &current.plan.namespace)? {
        if existing.plan_id == expected_plan {
            return Ok(existing);
        }
        return Err(problem(
            "enrollment_conflict",
            "This source already has a different enrollment. Replacement is not implemented in WU03; its receipt is retained.",
        ));
    }
    let root = directory(candidate, &current.plan.namespace);
    let receipt = EnrollmentReceipt {
        schema_version: 1,
        state: "enrolled-no-runtime".into(),
        plan_id: current.plan_id,
        plan: current.plan,
    };
    let bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|_| problem("serialization_failed", "Cannot encode enrollment receipt."))?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(problem(
            "enrollment_budget",
            "Enrollment receipt exceeds 4 MiB.",
        ));
    }
    DirBuilder::new().mode(0o700).create(&root).map_err(|_| {
        problem(
            "enrollment_conflict",
            "Enrollment directory already exists or could not be created; no overwrite.",
        )
    })?;
    let pending = root.join("enrollment.pending");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .map_err(|_| {
            problem(
                "enrollment_unavailable",
                "Cannot exclusively create enrollment receipt.",
            )
        })?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|_| {
            problem(
                "incomplete_enrollment",
                "Receipt publication interrupted; partial state retained.",
            )
        })?;
    // Exclusive link publication cannot overwrite a concurrently created foreign destination.
    fs::hard_link(&pending, root.join("enrollment.json")).map_err(|_| {
        problem(
            "incomplete_enrollment",
            "Receipt publication interrupted; no destination overwritten.",
        )
    })?;
    fs::remove_file(&pending).map_err(|_| {
        problem(
            "incomplete_enrollment",
            "Receipt publication is incomplete; inspection required.",
        )
    })?;
    File::open(&root).and_then(|f| f.sync_all()).map_err(|_| {
        problem(
            "incomplete_enrollment",
            "Cannot confirm enrollment directory durability.",
        )
    })?;
    File::open(&parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| {
            problem(
                "incomplete_enrollment",
                "Cannot confirm enrollment parent durability.",
            )
        })?;
    read(candidate, &receipt.plan.source, &receipt.plan.namespace)?.ok_or_else(|| {
        problem(
            "incomplete_enrollment",
            "Published enrollment could not be read back.",
        )
    })
}
