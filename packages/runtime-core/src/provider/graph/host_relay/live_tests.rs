use super::*;
mod recovery;
use crate::provider::{self, relay_loop::Limits, relay_owner::OwnerLimits};
use std::{
    net::TcpListener,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

/// Created exclusively by this fixture. Replacement paths are retained, never removed.
struct ControlRoot {
    path: PathBuf,
    identity: (u64, u64, u32),
    removed: bool,
}
impl ControlRoot {
    fn temporary() -> Result<Self, CandidateError> {
        Self::create(
            fs::canonicalize("/tmp")
                .map_err(state::io)?
                .join(format!("hack-relay-live-{}", std::process::id())),
        )
    }
    fn create(path: PathBuf) -> Result<Self, CandidateError> {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(state::io)?;
        let metadata = fs::symlink_metadata(&path).map_err(state::io)?;
        Ok(Self {
            path,
            identity: (metadata.dev(), metadata.ino(), metadata.uid()),
            removed: false,
        })
    }
    fn cleanup(&mut self) -> Result<(), CandidateError> {
        if self.removed {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(&self.path).map_err(state::io)?;
        if !metadata.is_dir()
            || metadata.mode() & 0o077 != 0
            || (metadata.dev(), metadata.ino(), metadata.uid()) != self.identity
        {
            return Err(refused());
        }
        fs::remove_dir_all(&self.path).map_err(state::io)?;
        match fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.removed = true;
                Ok(())
            }
            _ => Err(refused()),
        }
    }
}
impl Drop for ControlRoot {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

/// Declared after ControlRoot, so unwinding joins the worker before removing its root.
struct ControlWorker {
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<Result<(), CandidateError>>>,
}
impl ControlWorker {
    fn finish(&mut self) -> Result<(), CandidateError> {
        self.stop.store(true, Ordering::Release);
        match self.handle.take() {
            Some(handle) => handle.join().map_err(|_| refused())?,
            None => Ok(()),
        }
    }
}
impl Drop for ControlWorker {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[test]
fn private_control_fixture_can_publish() -> Result<(), CandidateError> {
    use crate::provider::relay_owner::publication::ControlListener;
    let mut root = ControlRoot::temporary()?;
    let mut owner = RelayOwner::new(
        Context {
            runtime: [11; 16],
            boot: [12; 16],
        },
        OwnerLimits {
            registrations: 1,
            controls: 1,
            relay: Limits {
                max_flows: 1,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(1),
            },
        },
    )?;
    let control = ControlListener::bind(&root.path, &mut owner)?;
    let _pin = crate::provider::relay_owner::publication::PinnedEndpoint::load(
        &root.path,
        Context {
            runtime: [11; 16],
            boot: [12; 16],
        },
    )?;
    drop(control);
    root.cleanup()
}

/// Reads only the graph-owned local volume selected by engine labels and identity.
fn persistent_sentinel(candidate: &Candidate, receipt: &Receipt) -> Result<String, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let resource = receipt.resources.get("volume:data").ok_or_else(refused)?;
    let inspected = inspect_resource(&engine, receipt, resource)?.ok_or_else(refused)?;
    let mountpoint = inspected["Mountpoint"]
        .as_str()
        .filter(|path| Path::new(path).is_absolute())
        .ok_or_else(refused)?;
    let output = engine.guest().execute_cleanup(
        "test -d \"$1\"\ntest ! -L \"$1\"\ntest ! -L \"$1/relay-sentinel\"\ntest -f \"$1/relay-sentinel\"\ntest \"$(cat \"$1/relay-sentinel\")\" = owned-persistent-sentinel\nprintf 'owned-volume-sentinel-verified\\n'",
        &[mountpoint],
    )?;
    if output != "owned-volume-sentinel-verified\n" {
        return Err(refused());
    }
    Ok(mountpoint.into())
}

#[test]
#[ignore = "Private owned development VM, pinned image, dedicated graph and external watchdog required"]
fn owned_graph_registration_live() -> Result<(), CandidateError> {
    let root = std::env::var("HACK_RELAY_GRAPH_ROOT").expect("explicit private root");
    let candidate = Candidate::discover(Path::new(&root))?;
    if std::env::var_os("HACK_RELAY_GRAPH_CLEANUP").is_some() {
        let status = provider::down(&candidate)?;
        assert_eq!(status.process_alive, Some(false));
        println!("owned-graph-relay-cleanup-complete");
        return Ok(());
    }
    let run_id = std::env::var("HACK_RELAY_GRAPH_RUN").expect("owned run");
    if matches!(
        std::env::var("HACK_RELAY_GRAPH_OPERATION").as_deref(),
        Ok("cleanup" | "resume-cleanup" | "confirm-cleanup")
    ) {
        return recovery::child(&candidate, &run_id);
    }
    let recovery = std::env::var_os("HACK_RELAY_GRAPH_RECOVERY").is_some();
    let auxiliary = std::env::var_os("HACK_RELAY_GRAPH_AUXILIARY").is_some();
    let bridge = std::env::var_os("HACK_RELAY_GRAPH_BRIDGE").is_some();
    let restore_fixture = std::env::var_os("HACK_RELAY_GRAPH_RESTORE").is_some();
    assert!(
        !restore_fixture || (auxiliary && bridge && !recovery),
        "restore requires auxiliary bridge without crash recovery"
    );
    assert!(
        !bridge || ((recovery || restore_fixture) && auxiliary),
        "bridge requires auxiliary recovery or restore"
    );
    assert!(
        !recovery || auxiliary,
        "recovery requires auxiliary fixture"
    );
    if auxiliary && !cfg!(feature = "environment-launcher") {
        return Err(error(
            "relay_auxiliary_feature",
            "Auxiliary qualification requires environment-launcher/all-features.",
        ));
    }
    assert_eq!(provider::status(&candidate)?.phase, "uninitialized");
    let project = std::env::var("HACK_RELAY_GRAPH_PROJECT").expect("dedicated project");
    assert!(hex(&run_id, 32));
    let options = || PlanOptions {
        project: Path::new(&project),
        compose_file: Path::new("compose.json"),
        profiles: &[],
    };
    let admission =
        provider::admission::probe_for(&candidate.checkout, provider::Profile::Development)?;
    assert!(admission.admitted);
    let review = project::plan(&candidate, options())?;
    assert!(review.plan.enrollment_compatible);
    let result = (|| {
        if bridge {
            provider::up_with_bridge(
                &candidate,
                provider::Profile::Development,
                Some(provider::BridgeIntent::new(1)?),
            )?;
        } else {
            provider::up_with_profile(&candidate, provider::Profile::Development)?;
        }
        provider::load_image(
            &candidate,
            Path::new(&std::env::var("HACK_RELAY_GRAPH_IMAGE_ARCHIVE").expect("image archive")),
            "74bb8d8c567eb02d5019ac0117efff81571c67d66899e6ad9b6c6cdf74d5dbfe",
            "sha256:862bef9be2a18d4c737c040c247594ad9810bfe8166cc67b0f85f7aa5dc5479c",
        )?;
        let readiness = BTreeMap::from([(
            "web".into(),
            if auxiliary {
                Condition::Healthy
            } else {
                Condition::Started
            },
        )]);
        let public = BTreeMap::new();
        let run_options = RunOptions {
            live_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: options(),
            expected_plan: &review.plan_id,
            source_revision: None,
            non_secret_values: &public,
            readiness: &readiness,
            run_id: &run_id,
            timeout: Duration::from_secs(120),
        };
        let receipt = if auxiliary {
            run_with_environment(
                &candidate,
                run_options,
                &BTreeMap::from([(
                    "web".into(),
                    BTreeMap::from([("TOKEN".into(), "synthetic-relay-auxiliary".into())]),
                )]),
                Duration::from_secs(120),
            )?
        } else {
            run(&candidate, run_options)?
        };
        if bridge {
            recovery::start_and_verify_live_bridge(&candidate, &receipt)?;
        }
        let persistent_mount = if auxiliary {
            assert!(receipt.environment_attached);
            assert!(!receipt.probes.is_empty());
            Some(persistent_sentinel(&candidate, &receipt)?)
        } else {
            None
        };
        let container = receipt.resources["container:web"]
            .id
            .as_deref()
            .expect("container id");
        let listener = TcpListener::bind("127.0.0.1:0").map_err(state::io)?;
        let endpoint = || {
            HostEndpoint::capture(
                std::process::id() as i32,
                listener.local_addr().unwrap().port(),
            )
        };
        let selection = HostRelayService::observe(&candidate, &run_id, "web")?;
        assert!(
            Engine::connect_cleanup(&candidate).is_err(),
            "selection must hold the mutation lease"
        );
        let limits = || OwnerLimits {
            registrations: 5,
            controls: 1,
            relay: Limits {
                max_flows: 2,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(1),
            },
        };
        let context = selection.context();
        let scope = selection.scope();
        let mut owner = RelayOwner::new(context, limits())?;
        let first = selection.register(&mut owner, endpoint()?)?;
        let search = HostRelayService::observe(&candidate, &run_id, "web")?.register_binding(
            &mut owner,
            "search.internal",
            endpoint()?,
        )?;
        let database = HostRelayService::observe(&candidate, &run_id, "web")?.register_binding(
            &mut owner,
            "database.internal",
            endpoint()?,
        )?;
        assert_ne!(first.target.service, search.target.service);
        assert_ne!(search.target.service, database.target.service);
        assert_eq!(owner.targets_for_graph(scope)?.len(), 3);
        let second = if auxiliary {
            HostRelayService::observe(&candidate, &run_id, "web")?.register_binding(
                &mut owner,
                "queue.internal",
                endpoint()?,
            )?
        } else {
            // Successful acquisition proves registration released its lease.
            let engine = Engine::connect(&candidate)?;
            engine.request(
                Method::POST,
                &format!("/v1.53/containers/{container}/stop?t=1"),
                None,
            )?;
            drop(engine);
            assert!(HostRelayService::observe(&candidate, &run_id, "web").is_err());
            let engine = Engine::connect(&candidate)?;
            engine.request(
                Method::POST,
                &format!("/v1.53/containers/{container}/start"),
                None,
            )?;
            drop(engine);
            let grant = HostRelayService::observe(&candidate, &run_id, "web")?
                .register(&mut owner, endpoint()?)?;
            assert_ne!(
                first.target.service, grant.target.service,
                "same-container restart reused service identity"
            );
            grant
        };
        let mut wrong = RelayOwner::new(
            Context {
                boot: [7; 16],
                ..context
            },
            limits(),
        )?;
        assert!(
            HostRelayService::observe(&candidate, &run_id, "web")?
                .register(&mut wrong, endpoint()?)
                .is_err()
        );
        let targets = owner.targets_for_graph(scope)?;
        assert_eq!(
            targets.len(),
            4,
            "all dependencies and older generations must be included"
        );
        use crate::provider::relay_owner::publication::ControlListener;
        use std::{io::Read, os::fd::AsFd, os::unix::net::UnixStream, time::Instant};
        let (flow, mut guest) = UnixStream::pair().map_err(state::io)?;
        guest
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(state::io)?;
        let flow_started = Instant::now();
        owner.admit(&second.target, flow, Duration::from_secs(5))?;
        let unrelated =
            owner.register_graph(GraphScope::new(context, [6; 32])?, [6; 32], endpoint()?)?;
        let (other_flow, mut other_guest) = UnixStream::pair().map_err(state::io)?;
        other_guest.set_nonblocking(true).map_err(state::io)?;
        owner.admit(&unrelated.target, other_flow, Duration::from_secs(5))?;
        // A short private publication root avoids sockaddr_un length dependence.
        let mut control_root = ControlRoot::temporary()?;
        let control = ControlListener::bind(&control_root.path, &mut owner)?;
        let pin = control.endpoint();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopping);
        let worker = thread::spawn(move || -> Result<(), CandidateError> {
            // Recovery owns five bounded child crash windows plus native observation.
            let deadline = Instant::now()
                + Duration::from_secs(if recovery || restore_fixture {
                    180
                } else {
                    120
                });
            while !stop.load(Ordering::Acquire) {
                if Instant::now() >= deadline {
                    return Err(refused());
                }
                if owner.tick_with_wakeup(Duration::from_millis(10), control.as_fd())? {
                    control.accept(&mut owner, Duration::from_secs(5))?;
                }
            }
            Ok(())
        });
        let mut worker = ControlWorker {
            stop: stopping,
            handle: Some(worker),
        };
        if recovery {
            let recovered = recovery::exercise(&candidate, &receipt, &control_root.path, context);
            worker.finish()?;
            control_root.cleanup()?;
            recovered?;
            if bridge {
                println!(
                    "owned-graph-relay-bridge-recovery-complete: live-helper-read-only-refusal, interrupted-effect, archived-confirmation"
                );
            }
            assert!(HostRelayService::observe(&candidate, &run_id, "web").is_err());
            // Supply valid managed inputs so the rejection specifically proves the retained consumed-ID reservation.
            let replay = run_with_environment(
                &candidate,
                RunOptions {
                    live_source: false,
                    release_initializer_cache: std::collections::BTreeSet::new(),
                    routing_enrolled: false,
                    project: options(),
                    expected_plan: &review.plan_id,
                    source_revision: None,
                    non_secret_values: &public,
                    readiness: &readiness,
                    run_id: &run_id,
                    timeout: Duration::from_secs(10),
                },
                &BTreeMap::from([(
                    "web".into(),
                    BTreeMap::from([("TOKEN".into(), "synthetic-relay-auxiliary".into())]),
                )]),
                Duration::from_secs(120),
            );
            assert_eq!(
                replay.err().ok_or_else(refused)?.code,
                "graph_replay_refused"
            );
            return Ok(());
        }
        let result = cleanup_with_relay(&candidate, &run_id, false, &pin);
        // Inspect before stopping the owner: owner Drop itself revokes every flow.
        let observations = result.as_ref().map(|_| {
            let within_admission_budget = flow_started.elapsed() < Duration::from_secs(5);
            let retired = guest.read(&mut [0]);
            let unrelated = other_guest.read(&mut [0]);
            (within_admission_budget, retired, unrelated)
        });
        if let Ok((within_admission_budget, retired, unrelated)) = observations {
            assert!(
                within_admission_budget,
                "qualification exceeded pending-admission lifetime; this cannot prove unrelated grant preservation"
            );
            assert_eq!(retired.map_err(state::io)?, 0);
            assert_eq!(
                unrelated.unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
        let cleanup = result?;
        assert_eq!(cleanup.phase, "stopped-data-retained");
        if let Some(before) = persistent_mount {
            assert_eq!(persistent_sentinel(&candidate, &cleanup)?, before);
            assert!(cleanup.environment_attached);
            assert!(
                cleanup
                    .probes
                    .values()
                    .all(|probe| probe.phase == "retired")
            );
            println!(
                "owned-graph-relay-auxiliary-complete: scoped-environment, native-http-probe, persistent-volume-sentinel"
            );
        }
        assert!(HostRelayService::observe(&candidate, &run_id, "web").is_err());
        if restore_fixture {
            let prior = cleanup.relay_cleanup.as_ref().ok_or_else(refused)?;
            assert_eq!(prior.phase, cleanup_enrollment::Phase::Confirmed);
            let before_mount = persistent_sentinel(&candidate, &cleanup)?;
            let before_volume = &cleanup.resources["volume:data"];
            let restored = restore_with_environment(
                &candidate,
                RunOptions {
                    live_source: false,
                    release_initializer_cache: std::collections::BTreeSet::new(),
                    routing_enrolled: false,
                    project: options(),
                    expected_plan: &review.plan_id,
                    source_revision: None,
                    non_secret_values: &public,
                    readiness: &readiness,
                    run_id: &run_id,
                    timeout: Duration::from_secs(120),
                },
                &BTreeMap::from([(
                    "web".into(),
                    BTreeMap::from([("TOKEN".into(), "synthetic-relay-auxiliary".into())]),
                )]),
                Duration::from_secs(120),
            )?;
            assert_eq!(restored.phase, "ready-observed");
            assert_eq!(restored.resources["volume:data"].id, before_volume.id);
            assert_eq!(restored.resources["volume:data"].name, before_volume.name);
            assert_eq!(persistent_sentinel(&candidate, &restored)?, before_mount);
            let dormant = restored.relay_cleanup.as_ref().ok_or_else(refused)?;
            assert_eq!(dormant.phase, cleanup_enrollment::Phase::Dormant);
            assert_eq!(dormant.operation, prior.operation);
            assert_eq!(dormant.effect, prior.effect);
            let engine = Engine::connect_cleanup(&candidate)?;
            let (durable, _) = load(&candidate, &engine, &run_id)?;
            assert_eq!(
                durable.relay_cleanup.as_ref().ok_or_else(refused)?.phase,
                cleanup_enrollment::Phase::Dormant
            );
            drop(engine);
            assert!(
                inspect(&candidate, &run_id)?
                    .guest_endpoints
                    .contains_key("web"),
                "restored managed service did not regain a healthy endpoint"
            );
            assert_eq!(
                super::super::cleanup(&candidate, &run_id, false)
                    .err()
                    .ok_or_else(refused)?
                    .code,
                "graph_relay_enrollment"
            );
            // A valid same-VM owner at another root is not this graph's enrolled owner.
            let mut other_root = ControlRoot::create(
                fs::canonicalize("/tmp")
                    .map_err(state::io)?
                    .join(format!("hack-relay-other-{}", std::process::id())),
            )?;
            let mut other_owner = RelayOwner::new(context, limits())?;
            let other_control = ControlListener::bind(&other_root.path, &mut other_owner)?;
            let other_pin = other_control.endpoint();
            let receipt_path = directory(&candidate, &run_id)?.join("state.json");
            let before_bytes = fs::read(&receipt_path).map_err(state::io)?;
            let before_inode = fs::symlink_metadata(&receipt_path)
                .map_err(state::io)?
                .ino();
            let before_sentinel = persistent_sentinel(&candidate, &restored)?;
            let wrong_root = cleanup_with_relay(&candidate, &run_id, true, &other_pin);
            assert_eq!(
                wrong_root.err().ok_or_else(refused)?.code,
                "graph_relay_enrollment",
                "different valid owner root must refuse before attempting owner exchange"
            );
            assert_eq!(fs::read(&receipt_path).map_err(state::io)?, before_bytes);
            assert_eq!(
                fs::symlink_metadata(&receipt_path)
                    .map_err(state::io)?
                    .ino(),
                before_inode
            );
            assert_eq!(persistent_sentinel(&candidate, &restored)?, before_sentinel);
            assert!(
                inspect(&candidate, &run_id)?
                    .guest_endpoints
                    .contains_key("web")
            );
            drop(other_pin);
            drop(other_control);
            drop(other_owner);
            other_root.cleanup()?;
            println!(
                "owned-graph-relay-wrong-root-refusal-complete: same-context, distinct-owner-root, unchanged-receipt, healthy-data"
            );
            let removed = cleanup_with_relay(&candidate, &run_id, true, &pin)?;
            assert_eq!(removed.phase, "removed");
            let latest = removed.relay_cleanup.as_ref().ok_or_else(refused)?;
            assert_eq!(latest.phase, cleanup_enrollment::Phase::Confirmed);
            assert_ne!(latest.operation, prior.operation);
            let journal = crate::provider::relay_owner::lifecycle_intent::Inspection::load(
                &control_root.path,
                context,
            )?;
            assert_eq!(
                journal.phase,
                crate::provider::relay_owner::lifecycle_intent::Phase::Confirmed
            );
            assert_eq!(journal.selection.operation, latest.operation);
            assert!(!journal.acknowledgement_pending);
            let engine = Engine::connect_cleanup(&candidate)?;
            for resource in removed.resources.values() {
                assert!(inspect_resource(&engine, &removed, resource)?.is_none());
            }
            drop(engine);
            println!(
                "owned-graph-relay-restore-complete: fresh-scoped-environment, persistent-volume-identity, dormant-enrollment, new-cleanup-operation, acknowledged-removal"
            );
        }
        worker.finish()?;
        control_root.cleanup()?;
        if !auxiliary {
            println!(
                "owned-graph-relay-base-lifecycle-complete: stopped-refusal, restart-rotation"
            );
        }
        println!(
            "owned-graph-relay-registration-complete: lease-release, wrong-owner-refusal, multi-dependency-complete-retirement, integrated-cleanup, cleanup-refusal"
        );
        Ok(())
    })();
    let stopped = provider::down(&candidate)?;
    assert_eq!(stopped.process_alive, Some(false));
    result
}
