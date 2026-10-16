//! Owned foreground publisher children. Graph journals, never child PIDs, authorize
//! publication retirement. Caller must retain this set across partial failures.
use super::{Candidate, CandidateError, Receipt, signals};
use crate::provider::{graph, publication};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_route_publisher",
        "Owned route publication is incomplete, stale or outside its lifetime; cleanup evidence must be retained.",
    )
}

struct Owned {
    child: Child,
    run: String,
    reservation: String,
    hostnames: Vec<String>,
}

#[derive(Default)]
pub(super) struct Publishers {
    children: Vec<Owned>,
}

fn command(
    executable: &Path,
    checkout: &Path,
    run: &str,
    slot: u8,
    reservation: &str,
    hostnames: &[String],
) -> Command {
    let mut command = Command::new(executable);
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("--candidate-root")
        .arg(checkout)
        .args(["graph", "publish-bridge", "--run-id", run, "--slot"])
        .arg(slot.to_string())
        .args(["--expect-reservation", reservation, "--unix"]);
    for hostname in hostnames {
        command.args(["--hostname", hostname]);
    }
    command
}

impl Publishers {
    /// The caller must hold no Engine/provider lease. Slots are explicitly reviewed;
    /// the run-filtered bridge inspection API cannot safely discover global vacancies.
    /// Existing bridge reservation validates capacity and conflicts atomically.
    /// On error, call enrolled graph cleanup and then reap this same set.
    pub(super) fn start(
        &mut self,
        candidate: &Candidate,
        receipt: &Receipt,
        signals: &signals::Events,
        deadline: Instant,
        slots: &BTreeMap<String, u8>,
    ) -> Result<(), CandidateError> {
        if !self.children.is_empty() || receipt.phase != "ready-observed" {
            return Err(refused());
        }
        let routes = receipt
            .resources
            .values()
            .filter_map(|resource| {
                resource
                    .routing
                    .as_ref()
                    .map(|route| (&resource.key, route))
            })
            .collect::<BTreeMap<_, _>>();
        if routes.len() > 32
            || routes
                .keys()
                .map(|name| name.as_str())
                .collect::<BTreeSet<_>>()
                != slots.keys().map(String::as_str).collect::<BTreeSet<_>>()
            || slots.values().any(|slot| *slot >= 32)
            || slots.values().collect::<BTreeSet<_>>().len() != slots.len()
            || routes
                .values()
                .any(|route| !graph::routes::valid_intent(route))
        {
            return Err(refused());
        }
        if routes.is_empty() {
            return Ok(());
        }
        let executable = std::env::current_exe().map_err(|_| refused())?;
        for (service, route) in routes {
            check_deadline(signals, deadline)?;
            // Each helper acquires/releases its own Engine lease before returning.
            let snapshot = graph::inspect(candidate, &receipt.run)?;
            if snapshot.receipt.owner != receipt.owner
                || snapshot.receipt.plan_id != receipt.plan_id
            {
                return Err(refused());
            }
            let endpoint = snapshot.guest_endpoints.get(service).ok_or_else(refused)?;
            let slot = slots[service];
            let assignment = graph::reserve_bridge(
                candidate,
                graph::ReserveBridgeOptions {
                    run: &receipt.run,
                    service,
                    slot,
                    expected_generation: &endpoint.generation,
                },
            )?;
            check_deadline(signals, deadline)?;
            graph::start_bridge(candidate, &receipt.run, slot, &assignment.reservation)?;
            check_deadline(signals, deadline)?;
            let child = command(
                &executable,
                &candidate.checkout,
                &receipt.run,
                slot,
                &assignment.reservation,
                &route.hostnames,
            )
            .spawn()
            .map_err(|_| refused())?;
            self.children.push(Owned {
                child,
                run: receipt.run.clone(),
                reservation: assignment.reservation,
                hostnames: route.hostnames.clone(),
            });
            let owned = self.children.last().ok_or_else(refused)?;
            signals.watch_child(&owned.child)?;
            loop {
                check_deadline(signals, deadline)?;
                if self
                    .children
                    .last_mut()
                    .ok_or_else(refused)?
                    .child
                    .try_wait()
                    .map_err(|_| refused())?
                    .is_some()
                {
                    return Err(refused());
                }
                let owned = self.children.last().ok_or_else(refused)?;
                if published(candidate, owned).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        self.verify_live(candidate)
    }

    /// Point-in-time publisher ownership, not guest health or TLS request proof.
    pub(super) fn verify_live(&mut self, candidate: &Candidate) -> Result<(), CandidateError> {
        for owned in &mut self.children {
            if owned.child.try_wait().map_err(|_| refused())?.is_some() {
                return Err(refused());
            }
            published(candidate, owned)?;
        }
        Ok(())
    }

    /// Call only after graph-owned cleanup. Never kills a publisher or substitutes
    /// process absence for publication/bridge retirement. Timeout retains handles.
    pub(super) fn reap_after_cleanup(
        &mut self,
        signals: &signals::Events,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        for owned in &self.children {
            signals.unwatch_child(&owned.child)?;
        }
        loop {
            let mut all = true;
            for owned in &mut self.children {
                all &= owned.child.try_wait().map_err(|_| refused())?.is_some();
            }
            if all {
                self.children.clear();
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn check_deadline(signals: &signals::Events, deadline: Instant) -> Result<(), CandidateError> {
    if signals.pending() || Instant::now() >= deadline {
        Err(refused())
    } else {
        Ok(())
    }
}

fn published(candidate: &Candidate, owned: &Owned) -> Result<(), CandidateError> {
    for hostname in &owned.hostnames {
        let value = publication::lookup_hostname(candidate, hostname)?;
        if !matches_publication(&value, hostname, &owned.run, &owned.reservation) {
            return Err(refused());
        }
    }
    Ok(())
}

fn matches_publication(
    value: &serde_json::Value,
    hostname: &str,
    run: &str,
    reservation: &str,
) -> bool {
    value["hostname"] == hostname
        && value["run"] == run
        && value["reservation"] == reservation
        && value["state"] == "publication-observed"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_must_match_every_owned_identity_field() {
        let value = serde_json::json!({"hostname":"one.example","run":"run","reservation":"reservation","state":"publication-observed"});
        assert!(matches_publication(
            &value,
            "one.example",
            "run",
            "reservation"
        ));
        for key in ["hostname", "run", "reservation", "state"] {
            let mut changed = value.clone();
            changed[key] = serde_json::json!("different");
            assert!(!matches_publication(
                &changed,
                "one.example",
                "run",
                "reservation"
            ));
        }
    }

    #[test]
    fn child_argv_has_exact_public_scope_and_no_environment_overlay() {
        let command = command(
            Path::new("/candidate"),
            Path::new("/checkout"),
            "run",
            3,
            "reservation",
            &["one.example".into(), "two.example".into()],
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "--candidate-root",
                "/checkout",
                "graph",
                "publish-bridge",
                "--run-id",
                "run",
                "--slot",
                "3",
                "--expect-reservation",
                "reservation",
                "--unix",
                "--hostname",
                "one.example",
                "--hostname",
                "two.example"
            ]
        );
        assert_eq!(command.get_program(), "/candidate");
        assert_eq!(command.get_envs().count(), 0);
    }
}
