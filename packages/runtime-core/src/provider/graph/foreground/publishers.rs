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
#[cfg(all(test, feature = "native-stream-relay"))]
mod exit_tests;

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
    /// Reviewed host port of a loopback TCP publication; `None` for a route.
    port: Option<u16>,
    exited: Option<std::process::ExitStatus>,
    exit_proof: Option<publication::ChildExit>,
}

/// What one publisher child serves: a route's hostname set over Unix, or one
/// reviewed loopback TCP port.
enum Frontend<'a> {
    Hostnames(&'a [String]),
    Port(u16),
}

#[derive(Default)]
pub(super) struct Publishers {
    children: Vec<Owned>,
    probe_generations: BTreeMap<String, String>,
    owner: String,
}

fn command(
    executable: &Path,
    checkout: &Path,
    run: &str,
    slot: u8,
    reservation: &str,
    frontend: Frontend<'_>,
) -> Command {
    let mut command = crate::provider::process::publisher_command(executable);
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("--candidate-root")
        .arg(checkout)
        .args(["graph", "publish-bridge", "--run-id", run, "--slot"])
        .arg(slot.to_string())
        .args(["--expect-reservation", reservation]);
    match frontend {
        Frontend::Hostnames(hostnames) => {
            command.arg("--unix");
            for hostname in hostnames {
                command.args(["--hostname", hostname]);
            }
        }
        Frontend::Port(port) => {
            command.arg("--port").arg(port.to_string());
        }
    }
    command
}

impl Publishers {
    pub(super) fn cleanup(
        &mut self,
        candidate: &Candidate,
        runtime: &mut graph::HostRelayRuntime,
        remove_data: bool,
    ) -> Result<Receipt, CandidateError> {
        self.reap_exited(candidate)?;
        runtime.cleanup(candidate, remove_data)
    }
    /// The caller must hold no Engine/provider lease. The provider reserves the
    /// complete reviewed route set atomically against pool-wide bridge capacity.
    /// On error, call enrolled graph cleanup and then reap this same set.
    pub(super) fn start(
        &mut self,
        candidate: &Candidate,
        receipt: &Receipt,
        signals: &signals::Events,
        deadline: Instant,
        slots: &BTreeMap<String, graph::RouteSlot>,
    ) -> Result<(), CandidateError> {
        if !self.children.is_empty() || receipt.phase != "ready-observed" {
            return Err(refused());
        }
        self.owner.clone_from(&receipt.owner);
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
        let explicit = slots
            .values()
            .filter_map(|choice| match choice {
                graph::RouteSlot::Explicit(slot) => Some(*slot),
                graph::RouteSlot::Auto => None,
            })
            .collect::<Vec<_>>();
        if routes.len() > 32
            || routes
                .keys()
                .map(|name| name.as_str())
                .collect::<BTreeSet<_>>()
                != slots.keys().map(String::as_str).collect::<BTreeSet<_>>()
            || explicit.iter().any(|slot| *slot >= 32)
            || explicit.iter().collect::<BTreeSet<_>>().len() != explicit.len()
            || routes
                .values()
                .any(|route| !graph::routes::valid_intent(route))
        {
            return Err(refused());
        }
        let loopback = receipt
            .resources
            .values()
            .flat_map(|resource| resource.loopback_ports.iter())
            .count();
        if loopback > graph::config::MAX_LOOPBACK_PORTS {
            return Err(refused());
        }
        if routes.is_empty() && loopback == 0 {
            return Ok(());
        }
        let executable = std::env::current_exe().map_err(|_| refused())?;
        self.probe_generations.clear();
        graph::bridges::supervise_probes(
            candidate,
            &receipt.run,
            &mut self.probe_generations,
            true,
            &|| check_deadline(signals, deadline),
        )?;
        if !routes.is_empty() {
            self.start_routes(
                candidate,
                receipt,
                signals,
                deadline,
                slots,
                &routes,
                &executable,
            )?;
        }
        if loopback > 0 {
            self.start_loopback(candidate, receipt, signals, deadline, &executable)?;
        }
        self.verify_live(candidate)
    }

    /// Loopback TCP publications start after routes, each through its own
    /// reserved bridge. A refusal leaves earlier publishers owned by this set
    /// for the caller's enrolled cleanup, as for routes.
    fn start_loopback(
        &mut self,
        candidate: &Candidate,
        receipt: &Receipt,
        signals: &signals::Events,
        deadline: Instant,
        executable: &Path,
    ) -> Result<(), CandidateError> {
        check_deadline(signals, deadline)?;
        // `started` readiness can finish while an image healthcheck is still
        // starting; wait for those endpoints within the same startup deadline.
        let reserved = retry_pending_endpoint(
            || super::super::bridges::reserve_loopback_ports(candidate, receipt),
            || {
                std::thread::sleep(PENDING_ENDPOINT_POLL);
                check_deadline(signals, deadline)
            },
        )?;
        for (port, selected) in reserved {
            check_deadline(signals, deadline)?;
            let assignment = &selected.assignment;
            graph::start_bridge(
                candidate,
                &receipt.run,
                selected.slot,
                &assignment.reservation,
            )?;
            check_deadline(signals, deadline)?;
            let child = command(
                executable,
                &candidate.checkout,
                &receipt.run,
                selected.slot,
                &assignment.reservation,
                Frontend::Port(port),
            )
            .spawn()
            .map_err(|_| refused())?;
            self.children.push(Owned {
                child,
                run: receipt.run.clone(),
                reservation: assignment.reservation.clone(),
                hostnames: Vec::new(),
                port: Some(port),
                exited: None,
                exit_proof: None,
            });
            self.await_published(candidate, signals, deadline)?;
        }
        Ok(())
    }

    fn await_published(
        &mut self,
        candidate: &Candidate,
        signals: &signals::Events,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        let owned = self.children.last().ok_or_else(refused)?;
        signals.watch_child(&owned.child)?;
        loop {
            check_deadline(signals, deadline)?;
            if self.reap_exited(candidate)? {
                return Err(refused());
            }
            let owned = self.children.last().ok_or_else(refused)?;
            if published(candidate, owned).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn start_routes(
        &mut self,
        candidate: &Candidate,
        receipt: &Receipt,
        signals: &signals::Events,
        deadline: Instant,
        slots: &BTreeMap<String, graph::RouteSlot>,
        routes: &BTreeMap<&String, &crate::project::RoutingPlan>,
        executable: &Path,
    ) -> Result<(), CandidateError> {
        check_deadline(signals, deadline)?;
        let reserved = super::super::bridges::reserve_routes(candidate, receipt, slots)?;
        for (service, route) in routes {
            check_deadline(signals, deadline)?;
            let selected = reserved.get(*service).ok_or_else(refused)?;
            let slot = selected.slot;
            let assignment = &selected.assignment;
            check_deadline(signals, deadline)?;
            graph::start_bridge(candidate, &receipt.run, slot, &assignment.reservation)?;
            check_deadline(signals, deadline)?;
            let child = command(
                executable,
                &candidate.checkout,
                &receipt.run,
                slot,
                &assignment.reservation,
                Frontend::Hostnames(&route.hostnames),
            )
            .spawn()
            .map_err(|_| refused())?;
            self.children.push(Owned {
                child,
                run: receipt.run.clone(),
                reservation: assignment.reservation.clone(),
                hostnames: route.hostnames.clone(),
                port: None,
                exited: None,
                exit_proof: None,
            });
            self.await_published(candidate, signals, deadline)?;
        }
        Ok(())
    }

    /// Point-in-time publisher ownership, not guest health or TLS request proof.
    pub(super) fn verify_live(&mut self, candidate: &Candidate) -> Result<(), CandidateError> {
        if !self.observe_live(candidate)? {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn observe_live(&mut self, candidate: &Candidate) -> Result<bool, CandidateError> {
        let exited = self.reap_exited(candidate)?;
        for owned in &mut self.children {
            if owned.exited.is_none() {
                published(candidate, owned)?;
            }
        }
        Ok(!exited)
    }
    pub(super) fn reap_exited(&mut self, candidate: &Candidate) -> Result<bool, CandidateError> {
        self.reap_exited_with_notice(candidate, |run, port| {
            exit_notice(&mut std::io::stdout().lock(), run, port)
        })
    }

    fn reap_exited_with_notice(
        &mut self,
        candidate: &Candidate,
        mut notice: impl FnMut(&str, Option<u16>) -> std::io::Result<()>,
    ) -> Result<bool, CandidateError> {
        let mut exited = false;
        for owned in &mut self.children {
            if owned.exited.is_none() {
                owned.exited = publication::reap_child(
                    candidate,
                    &self.owner,
                    &owned.run,
                    &owned.reservation,
                    &mut owned.child,
                    &mut owned.exit_proof,
                )?;
                if owned.exited.is_some() {
                    // A dead frontend can close stdout before its publisher is
                    // reaped. Presentation must not prevent retaining cleanup;
                    // identity and journal errors above still refuse normally.
                    let _ = notice(&owned.run, owned.port);
                }
            }
            exited |= owned.exited.is_some();
        }
        Ok(exited)
    }

    pub(super) fn has_exited(&self) -> bool {
        self.children.iter().any(|owned| owned.exited.is_some())
    }

    /// Presentation only; each entry belongs to this owner's retained child.
    pub(super) fn port_status(&self) -> Vec<serde_json::Value> {
        self.children.iter().filter_map(|owned| owned.port.map(|port| {
            serde_json::json!({"port":port,"state":if owned.exited.is_some() {"down"} else {"observed"}})
        })).collect()
    }

    /// The foreground owner alone follows engine restart generations. Fully
    /// retire and reap one old reservation before reserving its replacement;
    /// neighboring publishers remain enrolled and watched throughout.
    pub(super) fn supervise_restarts(
        &mut self,
        candidate: &Candidate,
        run: &str,
        signals: &signals::Events,
    ) -> Result<(), CandidateError> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let check = || check_deadline(signals, deadline);
        graph::bridges::supervise_probes(
            candidate,
            run,
            &mut self.probe_generations,
            false,
            &check,
        )?;
        for selected in graph::bridges::changed_publications(candidate, run)? {
            let index = self
                .children
                .iter()
                .position(|child| {
                    child.run == run && child.reservation == selected.previous.reservation
                })
                .ok_or_else(refused)?;
            check_deadline(signals, deadline)?;
            if !graph::bridges::retire_rebind(candidate, &selected, &check)? {
                continue;
            }
            self.reap_one_after_cleanup(index, signals, deadline)?;
            let assignment = match graph::bridges::reserve_rebind(candidate, &selected, &check) {
                Err(error) if error.code == "published_port_in_use" => {
                    eprintln!("Published port busy; publication remains retired.");
                    continue;
                }
                outcome => outcome?,
            };
            check_deadline(signals, deadline)?;
            graph::start_bridge(candidate, run, selected.slot, &assignment.reservation)?;
            check_deadline(signals, deadline)?;
            let executable = std::env::current_exe().map_err(|_| refused())?;
            let frontend = self.frontend_for(candidate, run, &assignment)?;
            let reservation = assignment.reservation.clone();
            let child = command(
                &executable,
                &candidate.checkout,
                run,
                selected.slot,
                &assignment.reservation,
                match frontend.0 {
                    Some(port) => Frontend::Port(port),
                    None => Frontend::Hostnames(&frontend.1),
                },
            )
            .spawn()
            .map_err(|_| refused())?;
            self.children.push(Owned {
                child,
                run: run.into(),
                reservation: assignment.reservation,
                port: frontend.0,
                hostnames: frontend.1,
                exited: None,
                exit_proof: None,
            });
            if let Err(error) = self.await_published(candidate, signals, deadline) {
                // The listener can be taken after reservation. Never reuse this
                // launch intent: fully retire it and retain unrelated children.
                let exited = self.reap_exited(candidate)?;
                let busy = exited
                    && frontend.0.is_some_and(|port| {
                        publication::require_loopback_port_free(port)
                            .is_err_and(|e| e.code == "published_port_in_use")
                    });
                if !busy {
                    return Err(error);
                }
                graph::release_bridge(candidate, run, selected.slot, &reservation)?;
                self.reap_one_after_cleanup(
                    self.children.len() - 1,
                    signals,
                    Instant::now() + Duration::from_secs(5),
                )?;
                eprintln!("Published port busy; publication remains retired.");
            }
        }
        Ok(())
    }

    fn frontend_for(
        &self,
        candidate: &Candidate,
        run: &str,
        assignment: &graph::bridges::Assignment,
    ) -> Result<(Option<u16>, Vec<String>), CandidateError> {
        if let Some(port) = assignment.loopback_port {
            return Ok((Some(port.host_port), Vec::new()));
        }
        let snapshot = graph::inspect(candidate, run)?;
        let route = snapshot
            .receipt
            .resources
            .get(&format!("container:{}", assignment.service))
            .and_then(|r| r.routing.as_ref())
            .ok_or_else(refused)?;
        Ok((None, route.hostnames.clone()))
    }

    /// Exact single-child counterpart of whole-graph reaping. No kill, PID-based
    /// retirement or handle loss on timeout; the bridge journal authorizes this.
    fn reap_one_after_cleanup(
        &mut self,
        index: usize,
        signals: &signals::Events,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        signals.unwatch_child(&self.children.get(index).ok_or_else(refused)?.child)?;
        loop {
            if self
                .children
                .get_mut(index)
                .ok_or_else(refused)?
                .child
                .try_wait()
                .map_err(|_| refused())?
                .is_some()
            {
                self.children.remove(index);
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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

fn exit_notice(
    output: &mut impl std::io::Write,
    run: &str,
    port: Option<u16>,
) -> std::io::Result<()> {
    let notice = serde_json::json!({"kind":"graph_publisher_exit","run":run,"port":port});
    serde_json::to_writer(&mut *output, &notice).map_err(|error| {
        std::io::Error::new(
            error.io_error_kind().unwrap_or(std::io::ErrorKind::Other),
            error,
        )
    })?;
    writeln!(output).and_then(|_| output.flush())
}

const PENDING_ENDPOINT_POLL: Duration = Duration::from_millis(100);

/// Repeats `attempt` only while it refuses with `bridge_endpoint_pending`; each
/// refusal wrote nothing. `wait` bounds the loop: its error ends it unchanged.
/// Every other outcome, success or refusal, returns at once.
fn retry_pending_endpoint<T>(
    mut attempt: impl FnMut() -> Result<T, CandidateError>,
    mut wait: impl FnMut() -> Result<(), CandidateError>,
) -> Result<T, CandidateError> {
    loop {
        match attempt() {
            Err(refusal) if refusal.code == "bridge_endpoint_pending" => wait()?,
            outcome => return outcome,
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
    if let Some(port) = owned.port {
        let value = publication::lookup_port(candidate, &owned.run, &owned.reservation, port)?;
        return if value["state"] == "publication-observed" && value["port"] == port {
            Ok(())
        } else {
            Err(refused())
        };
    }
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
            Frontend::Hostnames(&["one.example".into(), "two.example".into()]),
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

    #[test]
    fn loopback_child_argv_names_only_its_reviewed_port() {
        let command = command(
            Path::new("/candidate"),
            Path::new("/checkout"),
            "run",
            4,
            "reservation",
            Frontend::Port(8787),
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
                "4",
                "--expect-reservation",
                "reservation",
                "--port",
                "8787"
            ]
        );
        assert_eq!(command.get_envs().count(), 0);
    }

    #[test]
    fn pending_endpoint_waits_within_the_bound_but_other_refusals_do_not() {
        let pending = || CandidateError::new("bridge_endpoint_pending", "pending");
        let mut attempts = 0;
        let mut waits = 0;
        let reserved = retry_pending_endpoint(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(pending())
                } else {
                    Ok(attempts)
                }
            },
            || {
                waits += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!((reserved, waits), (3, 2));

        let mut waits = 0;
        let expired = retry_pending_endpoint(
            || Err::<(), _>(pending()),
            || {
                waits += 1;
                if waits < 2 { Ok(()) } else { Err(refused()) }
            },
        )
        .unwrap_err();
        assert_eq!((expired.code, waits), ("graph_route_publisher", 2));

        let mut attempts = 0;
        let unavailable = retry_pending_endpoint(
            || {
                attempts += 1;
                Err::<(), _>(CandidateError::new("bridge_endpoint_unavailable", "gone"))
            },
            || panic!("a permanent refusal must not wait"),
        )
        .unwrap_err();
        assert_eq!(
            (unavailable.code, attempts),
            ("bridge_endpoint_unavailable", 1)
        );
    }
}
