//! A host-reserve disk budget is valid only for one independently verified pool whose
//! declared disks already exist: a live running pool, or an exactly clean stopped
//! Development pool that a restart reuses without `machine create`.
//!
//! Every stopped-pool refusal at selection keeps the unchanged fresh-allocation budget and
//! reports its closed code, so an ineligible owner is never admitted on the reserve. A
//! stopped selection is proven in two layers:
//!
//! * Receipt checks ([`stopped`]) are read-only and run around every admission sample,
//!   including the read-only `runtime probe`: the `down`-completed clean-stop marker of the
//!   last boot, its quiescence receipt, creation, rootfs pin, disk identities and sizes,
//!   the recorded executable and user, and a dead recorded provider.
//! * Release checks ([`released`]) take the provider's VM lock, run `lsof` on the owned
//!   disks, probe the owned sockets and audit the provider configuration. They need the
//!   startup lease, so they never contend with another lifecycle operation that may be
//!   handing the VM lock to a provider; they run once the lease is held, before any restart
//!   effect, and immediately before `machine start`.
//!
//! The reserve is used only when a start needs it. Once the lease is held, [`settle`] drops
//! a stopped selection whose every qualifying sample also fits the unchanged fresh budget:
//! that start continues exactly as it would without a selection, on the fresh budget and
//! without release checks. Only a start whose free disk lies between the host reserve and
//! the fresh budget keeps the selection, and it is refused if a release check fails.
//!
//! The start sequence is typed, so a start cannot skip a step: [`restart_only`] needs the
//! [`Settled`] basis that only [`settle`] returns, and both `machine create` and the
//! pre-boot admission need the [`Restart`] that only [`restart_only`] returns. `machine
//! create` also needs a [`FreshCreate`], which no selection can obtain, and `machine start`
//! needs a [`StartPermit`], which only the pre-boot admission ([`admit_boot`]) followed by
//! the final leased recheck ([`BootAdmission::release`]) issues.
use super::{
    Owner, admission, binary, io, lock_absent_disks_within, root, sockets_absent,
    verify_disk_allocation, verify_disks, verify_live,
};
use crate::provider::{Profile, config_audit, identity, state};
use crate::{Candidate, CandidateError};
use serde_json::Value;
use std::fs;
use std::time::Duration;

/// How long a release check waits for `lsof` over the owned disks. `lsof` scans every
/// process, so it is slow on a loaded host (5.4–6.5 s at about 1,850 processes and load
/// 30–80). The wait is longer than `down`'s because only a start that needs the reserve runs
/// it, under the startup lease; a scan that still does not finish refuses the reserve.
const RELEASE_HANDLE_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Basis {
    Running,
    Stopped,
}

pub(super) struct Selection {
    owner: Owner,
    basis: Basis,
}

/// The admission basis chosen before startup: a verified selection, or the fresh budget
/// with the closed reason a retained stopped pool did not qualify for the reserve.
pub(super) struct Choice {
    selection: Option<Selection>,
    refusal: Option<StoppedRefusal>,
}

impl Choice {
    pub(super) fn selected(&self) -> Option<&Selection> {
        self.selection.as_ref()
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(super) fn into_selection(self) -> Option<Selection> {
        self.selection
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(super) fn refusal(&self) -> Option<StoppedRefusal> {
        self.refusal
    }
}

/// Closed reasons a stopped Development owner cannot use the host-reserve budget.
/// Codes are fixed labels without paths, identities or provider output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StoppedRefusal {
    /// The receipt names another machine, executable, user, provider configuration or
    /// unsafe VM lock.
    Foreign,
    /// A provider process, VM lock holder, disk handle or listener may remain.
    Active,
    /// The last stop was not a completed quiesced `down` of the last boot, or an owner
    /// update is pending.
    Dirty,
    /// Creation, disk identities, sizes, rootfs or boot identity are missing or drifted.
    Stale,
}

impl StoppedRefusal {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Foreign => "retained_reserve_foreign_owner",
            Self::Active => "retained_reserve_active_owner",
            Self::Dirty => "retained_reserve_dirty_owner",
            Self::Stale => "retained_reserve_stale_owner",
        }
    }

    fn error(self) -> CandidateError {
        CandidateError::new(
            self.code(),
            "Stopped development ownership is not exactly clean; the retained-disk host reserve was not admitted.",
        )
    }

    /// Classify a lifecycle verification failure into a closed refusal. Missing, replaced
    /// or mis-sized state is stale; any other failure, including an absence probe that
    /// could not complete (for example a slow `lsof`), leaves the provider possibly active.
    fn from_check(error: &CandidateError) -> Self {
        match error.code {
            "foreign_state" | "unaudited_provider_config" => Self::Foreign,
            "provider_state" | "disk_identity_mismatch" | "disk_allocation_mismatch" => Self::Stale,
            _ => Self::Active,
        }
    }
}

pub(super) fn select(candidate: &Candidate, profile: Profile) -> Result<Choice, CandidateError> {
    let fresh = |refusal| Choice {
        selection: None,
        refusal,
    };
    if profile != Profile::Development {
        return Ok(fresh(None));
    }
    match fs::symlink_metadata(root(candidate).join("owner.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(fresh(None)),
        Err(e) => return Err(io(e)),
        Ok(_) => {}
    }
    let owner = Owner::load(candidate)?;
    if owner.profile != profile {
        return Ok(fresh(None));
    }
    if owner.phase != "running" {
        return Ok(match stopped(candidate, &owner) {
            Ok(()) => Choice {
                selection: Some(Selection {
                    owner,
                    basis: Basis::Stopped,
                }),
                refusal: None,
            },
            // A never-created owner has no retained disks, so the fresh budget needs no
            // explanation; a created one reports why its disks were charged again.
            Err(refusal) => fresh(owner.created.then_some(refusal)),
        });
    }
    if !owner.created || owner.storage.is_none() || owner.overlay.is_none() {
        return Err(changed());
    }
    verify_live(candidate, &owner)?;
    verify_disk_allocation(
        owner.storage.as_ref().unwrap(),
        owner.overlay.as_ref().unwrap(),
        profile,
    )?;
    Ok(Choice {
        selection: Some(Selection {
            owner,
            basis: Basis::Running,
        }),
        refusal: None,
    })
}

/// Receipt checks: whether `owner` records an exactly clean stopped Development pool with
/// its retained disks.
///
/// Clean means `down` completed a quiesced stop of the last boot and recorded its
/// clean-stop marker with the `stopped` phase. Any other phase write and every new boot
/// clear that marker, so an interrupted, uncertain, unclean, before-engine or failed-boot
/// stop never qualifies, even when a later refused start rewrote the phase to `stopped`.
/// Read-only and lock-free: it never repairs or adopts state, takes no provider lock and
/// runs no host tool.
pub(super) fn stopped(candidate: &Candidate, owner: &Owner) -> Result<(), StoppedRefusal> {
    if owner.profile != Profile::Development {
        return Err(StoppedRefusal::Foreign);
    }
    match fs::symlink_metadata(root(candidate).join("owner.pending")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(StoppedRefusal::Dirty),
    }
    if owner.phase != "stopped" {
        return Err(StoppedRefusal::Dirty);
    }
    let (Some(storage), Some(overlay), Some(process), Some(boot), Some(daemon), Some(start)) = (
        owner.storage.as_ref(),
        owner.overlay.as_ref(),
        owner.process.as_ref(),
        owner.guest_boot_id.as_deref(),
        owner.daemon_pid,
        owner.daemon_start,
    ) else {
        return Err(StoppedRefusal::Stale);
    };
    if !owner.created || owner.rootfs_digest.is_none() {
        return Err(StoppedRefusal::Stale);
    }
    // Only `down` records this marker, after the guest acknowledged flush and shutdown and
    // provider absence was proven, in the same receipt write as its `stopped` phase.
    if !owner
        .clean_stop
        .as_ref()
        .is_some_and(|clean| clean.names(boot, daemon, start))
    {
        return Err(StoppedRefusal::Dirty);
    }
    // Only `down` writes this receipt, after the guest engine quiesced in this boot.
    let quiesced = state::read::<Value>(&root(candidate).join("quiescence.json"))
        .ok()
        .is_some_and(|receipt| {
            receipt["guest_boot_id"].as_str() == Some(boot)
                && receipt["daemon_pid"].as_u64() == Some(u64::from(daemon))
                && receipt["daemon_start"].as_u64() == Some(start)
                && receipt["result"]
                    .as_str()
                    .is_some_and(|result| result.starts_with("quiesced"))
        });
    if !quiesced {
        return Err(StoppedRefusal::Dirty);
    }
    if process.executable != binary(candidate) || process.uid != unsafe { libc::geteuid() } {
        return Err(StoppedRefusal::Foreign);
    }
    // A live or unobservable recorded PID (including reuse) is never proven absent.
    if identity::alive(process.pid).unwrap_or(true) {
        return Err(StoppedRefusal::Active);
    }
    verify_disks(candidate, owner).map_err(|error| StoppedRefusal::from_check(&error))?;
    verify_disk_allocation(storage, overlay, owner.profile)
        .map_err(|error| StoppedRefusal::from_check(&error))
}

/// Release checks, under the startup lease: the provider the receipt names released its
/// machine (free VM lock, no open disk handle, no owned listener) and the provider's
/// persisted configuration is still this pool's audited one. The VM lock is released on
/// return; the provider's own `machine start` reacquires it.
fn released(
    candidate: &Candidate,
    owner: &Owner,
    lease: &state::Lock,
) -> Result<(), StoppedRefusal> {
    let check = |error: CandidateError| StoppedRefusal::from_check(&error);
    lease.verify_path(&root(candidate)).map_err(check)?;
    lock_absent_disks_within(candidate, owner, RELEASE_HANDLE_WAIT).map_err(check)?;
    sockets_absent(owner).map_err(check)?;
    config_audit::verify(candidate, owner).map_err(check)
}

fn changed() -> CandidateError {
    CandidateError::new(
        "admission_owner_changed",
        "Verified admission ownership changed; no create or boot was admitted.",
    )
}

impl Selection {
    pub(super) fn is_stopped(&self) -> bool {
        self.basis == Basis::Stopped
    }

    /// The selected receipt is unchanged and its basis is still independently proven.
    /// For a stopped selection these are the lock-free receipt checks.
    pub(super) fn reverify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let current = Owner::load(candidate)?;
        if current != self.owner {
            return Err(changed());
        }
        match self.basis {
            Basis::Stopped => stopped(candidate, &current).map_err(StoppedRefusal::error),
            Basis::Running => {
                if current.phase != "running" {
                    return Err(changed());
                }
                verify_live(candidate, &current)?;
                verify_disk_allocation(
                    current.storage.as_ref().ok_or_else(changed)?,
                    current.overlay.as_ref().ok_or_else(changed)?,
                    current.profile,
                )
            }
        }
    }

    /// [`Self::reverify`] plus, for a stopped selection, the release checks that need the
    /// startup lease.
    pub(super) fn reverify_leased(
        &self,
        candidate: &Candidate,
        lease: &state::Lock,
    ) -> Result<(), CandidateError> {
        self.reverify(candidate)?;
        if self.basis == Basis::Stopped {
            released(candidate, &self.owner, lease).map_err(StoppedRefusal::error)?;
            // The receipt cannot have changed under the lease, but bind it after the
            // release probes as well.
            self.reverify(candidate)?;
        }
        Ok(())
    }
}

/// Which disk allocation an admission sample treats as already paid.
fn owned_pool(choice: &Choice) -> admission::OwnedPool {
    match choice.selected().map(|selected| selected.basis) {
        None => admission::OwnedPool::Fresh,
        Some(Basis::Running) => admission::OwnedPool::Running,
        Some(Basis::Stopped) => admission::OwnedPool::Stopped,
    }
}

/// The host observation behind every lifecycle admission sample.
fn observe_host(
    candidate: &Candidate,
    profile: Profile,
    owned: admission::OwnedPool,
) -> Result<admission::Admission, CandidateError> {
    match owned {
        admission::OwnedPool::Fresh => admission::probe_for(&candidate.checkout, profile),
        owned => admission::probe_owned_development(&candidate.checkout, owned),
    }
}

/// One admission sample on `choice`'s basis. A selection is rechecked around the sample;
/// a fresh sample reports why a retained stopped pool did not qualify for the reserve.
pub(super) fn probe(
    candidate: &Candidate,
    profile: Profile,
    choice: &Choice,
) -> Result<admission::Admission, CandidateError> {
    probe_with(candidate, choice, |owned| {
        observe_host(candidate, profile, owned)
    })
}

fn probe_with(
    candidate: &Candidate,
    choice: &Choice,
    observe: impl FnOnce(admission::OwnedPool) -> Result<admission::Admission, CandidateError>,
) -> Result<admission::Admission, CandidateError> {
    let owned = owned_pool(choice);
    match choice.selected() {
        None => {
            let mut observed = observe(owned)?;
            observed.retained_reserve_refusal = choice.refusal.map(StoppedRefusal::code);
            Ok(observed)
        }
        Some(selected) => {
            selected.reverify(candidate)?;
            let observed = observe(owned)?;
            selected.reverify(candidate)?;
            Ok(observed)
        }
    }
}

/// Once the startup lease is held and before any restart effect, settle the basis this start
/// uses. `samples` are the qualifying samples, including the lease recheck, in the order they
/// will be recorded.
///
/// A live selection is rechecked. A stopped selection's receipt is rechecked; then, if every
/// sample also fits the unchanged fresh budget, the selection is dropped and the samples are
/// recorded on that budget, so the start runs exactly as one without a selection and no
/// release check runs. Otherwise the reserve is needed, and the release checks must pass
/// under the lease.
pub(super) fn settle<'a>(
    candidate: &Candidate,
    choice: &'a mut Choice,
    lease: &state::Lock,
    samples: &mut [admission::Admission],
) -> Result<Settled<'a>, CandidateError> {
    if let Some(selected) = choice.selected() {
        selected.reverify(candidate)?;
        if selected.is_stopped() {
            if !samples.is_empty() && samples.iter().all(admission::fits_fresh_budget) {
                samples.iter_mut().for_each(admission::rebase_fresh);
                choice.selection = None;
            } else {
                selected.reverify_leased(candidate, lease)?;
            }
        }
    }
    Ok(Settled(choice))
}

/// The admission basis this start settled under the startup lease. Only [`settle`] issues
/// it, and [`restart_only`] needs it.
#[derive(Clone, Copy)]
pub(super) struct Settled<'a>(&'a Choice);

impl Settled<'_> {
    pub(super) fn selected(&self) -> Option<&Selection> {
        self.0.selected()
    }
}

/// Authority for create or restart effects and for the pre-boot admission. Only
/// [`restart_only`] issues it.
pub(super) struct Restart<'a>(&'a Choice);

/// Before a restart effect under the startup lease: a selection continues only as a
/// restart of its clean stopped pool's verified retained disks.
pub(super) fn restart_only<'a>(
    candidate: &Candidate,
    settled: Settled<'a>,
    owner: &Owner,
    lease: &state::Lock,
) -> Result<Restart<'a>, CandidateError> {
    let choice = settled.0;
    let Some(selected) = choice.selected() else {
        return Ok(Restart(choice));
    };
    if !selected.is_stopped() || !owner.created || *owner != selected.owner {
        return Err(CandidateError::new(
            "admission_owner_changed",
            "Reserve-qualified ownership no longer names its selected pool; no create or boot was admitted.",
        ));
    }
    selected.reverify_leased(candidate, lease)?;
    Ok(Restart(choice))
}

/// Authority to run `machine create`: only a start without a reserve selection allocates
/// new disks.
pub(super) struct FreshCreate(());

pub(super) fn fresh_create(restart: &Restart<'_>) -> Result<FreshCreate, CandidateError> {
    if restart.0.selected().is_some() {
        return Err(CandidateError::new(
            "admission_owner_changed",
            "A reserve-qualified start never creates a machine; no create or boot was admitted.",
        ));
    }
    Ok(FreshCreate(()))
}

/// The pre-boot admission passed on this start's basis.
pub(super) struct BootAdmission<'a> {
    selection: Option<&'a Selection>,
}

/// Authority to run `machine start`, issued only by [`BootAdmission::release`].
pub(super) struct StartPermit(());

/// The pre-boot admission's outcome. A refusal leaves the provider untouched; the caller
/// records the stop before returning it.
pub(super) enum BootGate<'a> {
    Admitted(BootAdmission<'a>),
    Refused(CandidateError),
}

/// A fresh admission immediately before boot, on the same basis as qualification, closes
/// installation and lock delays: unchanged fresh budget without a selection; a selection's
/// reserve basis rechecked around the sample. Swapouts must not have grown since the
/// qualifying window's last sample.
pub(super) fn admit_boot<'a>(
    candidate: &Candidate,
    profile: Profile,
    restart: &Restart<'a>,
    baseline_swapouts: Option<u64>,
) -> Result<BootGate<'a>, CandidateError> {
    admit_boot_with(candidate, restart.0, baseline_swapouts, |owned| {
        observe_host(candidate, profile, owned)
    })
}

fn admit_boot_with<'a>(
    candidate: &Candidate,
    choice: &'a Choice,
    baseline_swapouts: Option<u64>,
    observe: impl FnOnce(admission::OwnedPool) -> Result<admission::Admission, CandidateError>,
) -> Result<BootGate<'a>, CandidateError> {
    let admission = probe_with(candidate, choice, observe)?;
    if !admission.admitted {
        return Ok(BootGate::Refused(CandidateError::new(
            "admission_rejected",
            admission.reasons.join(" "),
        )));
    }
    if admission.swapouts != baseline_swapouts {
        return Ok(BootGate::Refused(CandidateError::new(
            "admission_rejected",
            "Swapouts changed after qualification; refusing boot.",
        )));
    }
    Ok(BootGate::Admitted(BootAdmission {
        selection: choice.selected(),
    }))
}

impl BootAdmission<'_> {
    /// The last check before `machine start` hands the VM lock to the provider: the
    /// selection, if any, is rechecked under the startup lease after every pre-boot effect.
    pub(super) fn release(
        self,
        candidate: &Candidate,
        lease: &state::Lock,
    ) -> Result<StartPermit, CandidateError> {
        if let Some(selected) = self.selection {
            selected.reverify_leased(candidate, lease)?;
        }
        Ok(StartPermit(()))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
