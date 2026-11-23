//! Opportunistic base retention, after startup readiness. One worker visits the
//! current and previous build inputs. Each visit takes a nonwaiting provider
//! lease and checks the exclusive fence before admitting idle work. Its shared
//! fence allows read-only receipt reuse while excluding reclaim and pool stop.
use super::{
    BuildPool, LivePool, aliases, idle_retention_fence, image_fence, reclaim, select_build_base,
};
use crate::provider::{
    image_ensure,
    image_policy::{ImagePolicy, ImageTagMode},
    state,
};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

const BUDGET: Duration = Duration::from_secs(30 * 60);

#[derive(Default, Serialize)]
pub struct RetentionReport {
    retained: usize,
    deferred: bool,
    failures: BTreeSet<&'static str>,
}

fn busy(error: &CandidateError) -> bool {
    error.code == "provider_busy"
}

pub(super) fn retain_verified<P: BuildPool>(
    pool: &P,
    lease: &P::Lease,
    base: &super::BuildBase,
    import: impl FnOnce() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let keeper = aliases::keeper(&base.image_id).expect("verified base content ID");
    let present = pool.inspect(lease, &base.image_id)?.is_some_and(|image| {
        image["Id"] == base.image_id && image["Os"] == "linux" && image["Architecture"] == "arm64"
    });
    if !present {
        import()?;
    }
    aliases::tag(pool, lease, &base.image_id, &keeper)
}

pub fn run(
    candidate: &Candidate,
    mut policy: ImagePolicy,
) -> Result<RetentionReport, CandidateError> {
    policy.local_registries.clear();
    policy.tag_mode = ImageTagMode::Normal;
    let deadline = Instant::now() + BUDGET;
    policy.build_deadline = Some(deadline);
    let mut report = RetentionReport::default();
    let _worker = match state::Lock::acquire(&candidate.state_root.join("run/build-base-retention"))
    {
        Ok(worker) => worker,
        Err(error) if busy(&error) => {
            report.deferred = true;
            return Ok(report);
        }
        Err(error) => return Err(error),
    };
    let pool = LivePool {
        candidate,
        build_deadline: Some(deadline),
    };
    let inputs = {
        let _fence = match image_fence(candidate, libc::LOCK_EX) {
            Ok(fence) => fence,
            Err(error) if busy(&error) => {
                report.deferred = true;
                return Ok(report);
            }
            Err(error) => return Err(error),
        };
        reclaim::current_images(candidate)?.inputs
    };
    let mut pins = BTreeSet::new();
    let mut tags = BTreeSet::new();
    for (reference, pin) in inputs {
        if Instant::now() >= deadline {
            report.deferred = true;
            break;
        }
        let result = (|| {
            let (lease, _) = pool.try_lease()?;
            let _fence = idle_retention_fence(candidate)?;
            if pins.insert(pin.clone()) {
                let (base, _) = select_build_base(candidate, &pin, &policy, None)?;
                retain_verified(&pool, &lease, &base, || {
                    image_ensure::retain_build_image(candidate, &pin, &policy, &lease).map(|_| ())
                })?;
                report.retained += 1;
            }
            if !reference.contains('@') && tags.insert(reference.clone()) {
                // Metadata only. A newly available pin will be used for the next
                // solve, whose receipt can then schedule its exact digest.
                select_build_base(candidate, &reference, &policy, None)?;
            }
            Ok::<_, CandidateError>(())
        })();
        if let Err(error) = result {
            if busy(&error) {
                report.deferred = true;
                break;
            }
            report.failures.insert(error.code);
        }
    }
    Ok(report)
}
