//! Opportunistic base retention, after startup readiness. One worker visits the
//! current and previous build inputs. Each visit takes a nonwaiting provider
//! lease and checks the exclusive fence before admitting idle work. Its shared
//! fence allows read-only receipt reuse while excluding reclaim and pool stop.
use super::{
    BuildPool, LivePool, aliases, idle_retention_fence, image_fence, reclaim, select_build_base,
};
use crate::provider::{
    image_ensure,
    image_platform::PlatformPolicy,
    image_policy::{ImagePolicy, ImageTagMode},
    image_tag_store, state,
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
    policy.opportunistic_locks = true;
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
            // An intervening solve can retire a queued input between visits.
            if !reclaim::current_images(candidate)?
                .inputs
                .contains(&(reference.clone(), pin.clone()))
            {
                return Ok(());
            }
            if !pins.contains(&pin) {
                let (base, _) = select_build_base(candidate, &pin, &policy, None)?;
                retain_verified(&pool, &lease, &base, || {
                    image_ensure::retain_build_image(candidate, &pin, &policy, &lease).map(|_| ())
                })?;
                pins.insert(pin.clone());
                report.retained += 1;
            }
            if !reference.contains('@') && tags.insert(reference.clone()) {
                let mut tag = image_tag_store::resolve(
                    candidate,
                    &reference,
                    &policy,
                    PlatformPolicy::Native,
                    None,
                )?;
                tag.confirm(|tag| {
                    if pins.contains(&tag.pinned_reference) {
                        return Ok(());
                    }
                    let (base, _) =
                        select_build_base(candidate, &tag.pinned_reference, &policy, None)?;
                    if base.image_id != tag.image_id {
                        return Err(super::refusal(
                            "native_build_base_image",
                            "The refreshed build base proof differs from its selection.",
                        ));
                    }
                    // Keep the previous selection usable offline until the
                    // replacement has both a verified image and its keeper.
                    retain_verified(&pool, &lease, &base, || {
                        image_ensure::retain_build_image(
                            candidate,
                            &tag.pinned_reference,
                            &policy,
                            &lease,
                        )
                        .map(|_| ())
                    })?;
                    pins.insert(tag.pinned_reference.clone());
                    report.retained += 1;
                    Ok(())
                })?;
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
