//! Explicit bounded application log reads. Output is returned to the caller, never journaled.
use super::{Kind, Resource, error, hex, inspect_resource, service_exec_generation};
use crate::provider::engine::{LogLine, LogTail, inspection::Inspection};
use crate::{Candidate, CandidateError};
use serde::Serialize;

pub struct ServiceLogOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub expected_container: &'a str,
    pub expected_boot: &'a str,
    pub expected_generation: &'a str,
    pub tail: u16,
}

#[derive(Debug, Serialize)]
pub struct ServiceLogResult {
    pub container: String,
    /// The retained lines of each stream, kept for callers that read them apart.
    pub stdout: String,
    pub stderr: String,
    /// The same retained lines in engine order (interleaved by time); whole lines only.
    pub lines: Vec<LogLine>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ServiceSelection {
    pub run: String,
    pub service: String,
    pub plan: String,
    pub owner: String,
    pub namespace: String,
    pub container: String,
    pub boot: String,
    pub generation: String,
}

/// Select the current immutable identity for a later service operation. The later
/// operation must recheck this selection under its own lease before any effects.
pub fn service_selection(
    candidate: &Candidate,
    run: &str,
    service: &str,
) -> Result<ServiceSelection, CandidateError> {
    let placeholder = "0".repeat(64);
    validate(&ServiceLogOptions {
        run,
        service,
        expected_container: &placeholder,
        expected_boot: "selection",
        expected_generation: &placeholder,
        tail: 1,
    })?;
    let engine = reader(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    super::startup::require_dependency_rebind_complete(&root, &receipt)?;
    if journal_pending(&root)? {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Container || resource.key != service {
        return Err(refused());
    }
    let container = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?;
    if inspect_resource(&engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    Ok(ServiceSelection {
        run: receipt.run.clone(),
        service: service.into(),
        plan: receipt.plan_id.clone(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        container: container.to_owned(),
        boot: engine.boot_id()?.to_owned(),
        generation: service_exec_generation(&receipt)?,
    })
}

/// Selection and snapshots read lease-free on macOS, like `graph logs-follow`: a
/// warming graph's start loop holds the provider lease, and these reads check the
/// recorded container identity before and after instead.
#[cfg(target_os = "macos")]
fn reader(candidate: &Candidate) -> Result<super::super::engine::Observer<'_>, CandidateError> {
    super::super::engine::Observer::connect(candidate)
}
#[cfg(not(target_os = "macos"))]
fn reader(candidate: &Candidate) -> Result<super::Engine<'_>, CandidateError> {
    super::Engine::connect_cleanup(candidate)
}
trait Snapshot: Inspection {
    fn tail(&self, id: &str, tail: u16) -> Result<LogTail, CandidateError>;
}
#[cfg(target_os = "macos")]
impl Snapshot for super::super::engine::Observer<'_> {
    fn tail(&self, id: &str, tail: u16) -> Result<LogTail, CandidateError> {
        self.logs_tail_lines(id, tail)
    }
}
#[cfg(not(target_os = "macos"))]
impl Snapshot for super::Engine<'_> {
    fn tail(&self, id: &str, tail: u16) -> Result<LogTail, CandidateError> {
        self.logs_tail_lines(id, tail)
    }
}
fn load(
    candidate: &Candidate,
    engine: &impl Inspection,
    run: &str,
) -> Result<(super::Receipt, std::path::PathBuf), CandidateError> {
    super::load_at(super::directory(candidate, run)?, run, engine.incarnation())
}

fn refused() -> CandidateError {
    error(
        "graph_service_logs",
        "Service log selection is invalid or changed; inspect the graph before requesting logs again.",
    )
}

fn journal_pending(root: &std::path::Path) -> Result<bool, CandidateError> {
    match root.join("state.pending").symlink_metadata() {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}

fn validate(options: &ServiceLogOptions<'_>) -> Result<(), CandidateError> {
    if !hex(options.run, 32)
        || !hex(options.expected_container, 64)
        || !hex(options.expected_generation, 64)
        || options.expected_boot.is_empty()
        || options.expected_boot.len() > 128
        || options.expected_boot.bytes().any(|b| b.is_ascii_control())
        || options.service.is_empty()
        || options.service.len() > 128
        || !options
            .service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || !(1..=1000).contains(&options.tail)
    {
        return Err(refused());
    }
    Ok(())
}

fn selected(resource: &Resource, options: &ServiceLogOptions<'_>) -> Result<(), CandidateError> {
    if resource.kind != Kind::Container
        || resource.key != options.service
        || resource.id.as_deref() != Some(options.expected_container)
    {
        return Err(refused());
    }
    Ok(())
}

/// Read an explicitly selected service, including exited services, without the lease on macOS.
/// Immutable identity and ownership are checked before and after reading. Application
/// logs may contain sensitive values; callers must not persist them as diagnostic receipts.
/// Text is UTF-8-lossy whole lines, newest kept within the engine's bounded tail
/// budget; truncation is explicit.
pub fn service_logs(
    candidate: &Candidate,
    options: &ServiceLogOptions<'_>,
) -> Result<ServiceLogResult, CandidateError> {
    validate(options)?;
    snapshot(candidate, options, &reader(candidate)?)
}

fn snapshot(
    candidate: &Candidate,
    options: &ServiceLogOptions<'_>,
    engine: &impl Snapshot,
) -> Result<ServiceLogResult, CandidateError> {
    let (receipt, root) = load(candidate, engine, options.run)?;
    if engine.boot_id()? != options.expected_boot
        || service_exec_generation(&receipt)? != options.expected_generation
        || journal_pending(&root)?
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", options.service))
        .ok_or_else(refused)?;
    selected(resource, options)?;
    if inspect_resource(engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    let tail = engine.tail(options.expected_container, options.tail)?;
    if inspect_resource(engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    let (stdout, stderr) = tail.split();
    Ok(ServiceLogResult {
        container: options.expected_container.to_owned(),
        stdout,
        stderr,
        lines: tail.lines,
        truncated: tail.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const RUN: &str = "11111111111111111111111111111111";
    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn options() -> ServiceLogOptions<'static> {
        ServiceLogOptions {
            run: RUN,
            service: "web",
            expected_container: ID,
            expected_boot: "boot",
            expected_generation: ID,
            tail: 200,
        }
    }
    #[test]
    fn invalid_or_unbounded_selection_is_rejected_before_provider_access() {
        for tail in [0, 1001, u16::MAX] {
            assert!(validate(&ServiceLogOptions { tail, ..options() }).is_err());
        }
        for service in ["", "../web", "web/json", "web\n"] {
            assert!(
                validate(&ServiceLogOptions {
                    service,
                    ..options()
                })
                .is_err()
            );
        }
        assert!(
            validate(&ServiceLogOptions {
                expected_container: "web",
                ..options()
            })
            .is_err()
        );
        assert!(
            validate(&ServiceLogOptions {
                expected_generation: "",
                ..options()
            })
            .is_err()
        );
        assert!(validate(&options()).is_ok());
    }
    #[test]
    fn only_recorded_container_identity_is_selected() {
        let mut resource: Resource = serde_json::from_value(serde_json::json!({
            "kind":"container", "key":"web", "name":"owned-web", "id":ID,
            "image":format!("sha256:{ID}"), "phase":"observed"
        }))
        .unwrap();
        assert!(selected(&resource, &options()).is_ok());
        resource.kind = Kind::Network;
        assert!(selected(&resource, &options()).is_err());
        resource.kind = Kind::Container;
        resource.id = None;
        assert!(selected(&resource, &options()).is_err());
        resource.id = Some("b".repeat(64));
        assert!(selected(&resource, &options()).is_err());
    }
    /// Reads with the recorded identity; asserts the provider lease stays held by
    /// another owner (a warming start loop) for every read.
    struct Warming<'a> {
        receipt: &'a super::super::Receipt,
        pool: std::path::PathBuf,
        reads: std::cell::Cell<u32>,
    }
    impl Warming<'_> {
        fn leased(&self) {
            self.reads.set(self.reads.get() + 1);
            assert!(matches!(
                super::super::state::Lock::acquire(&self.pool),
                Err(e) if e.code == "provider_busy"
            ));
        }
    }
    impl Inspection for Warming<'_> {
        fn incarnation(&self) -> &str {
            &self.receipt.owner
        }
        fn boot_id(&self) -> Result<&str, CandidateError> {
            Ok("boot")
        }
        fn verify(&self) -> Result<(), CandidateError> {
            Ok(())
        }
        fn get(&self, path: &str) -> Result<serde_json::Value, CandidateError> {
            self.leased();
            let resource = self
                .receipt
                .resources
                .values()
                .find(|r| path.contains(r.id.as_deref().unwrap()))
                .unwrap();
            Ok(
                serde_json::json!({"Id":resource.id,"Name":resource.name,"Image":resource.image,
                "Config":{"Labels":super::super::expected_labels(self.receipt, resource)},
                "State":{"Status":"running","Running":true}}),
            )
        }
        fn probe_status(&self, _: &str) -> Result<Option<String>, CandidateError> {
            panic!("no probe")
        }
    }
    impl Snapshot for Warming<'_> {
        fn tail(&self, id: &str, _: u16) -> Result<LogTail, CandidateError> {
            self.leased();
            Ok(LogTail {
                lines: vec![LogLine {
                    stream: crate::provider::engine::LogStream::Stdout,
                    text: format!("{}\n", &id[..1]),
                }],
                truncated: false,
            })
        }
    }
    #[test]
    fn snapshots_of_a_warming_graph_complete_while_its_owner_holds_the_lease() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let container = |key: &str, id: char| {
            serde_json::json!({"key":key,"kind":"container","name":format!("hkg-{RUN}-container-{}", u8::from(key == "web")),
                "id":id.to_string().repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))})
        };
        let receipt: super::super::Receipt = serde_json::from_value(serde_json::json!({
            "version":1,"run":RUN,"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"preparing","readiness":{"api":"started","web":"started"},
            "resources":{"container:api":container("api", 'a'),"container:web":container("web", 'e')}}))
        .unwrap();
        let root = super::super::directory(&candidate, RUN).unwrap();
        super::super::state::private_directory(&root).unwrap();
        super::super::state::write(&root.join("state.json"), &receipt).unwrap();
        let pool = candidate.state_root.join("run/smolvm");
        let _start_loop = super::super::state::Lock::acquire(&pool).unwrap();
        let reader = Warming {
            receipt: &receipt,
            pool,
            reads: std::cell::Cell::new(0),
        };
        let generation = service_exec_generation(&receipt).unwrap();
        // One service, then every service as the all-services read calls it.
        for (service, id) in [("web", 'e'), ("api", 'a'), ("web", 'e')] {
            let container = id.to_string().repeat(64);
            let result = snapshot(
                &candidate,
                &ServiceLogOptions {
                    service,
                    expected_container: &container,
                    expected_generation: &generation,
                    ..options()
                },
                &reader,
            )
            .unwrap();
            let json = serde_json::to_value(&result).unwrap();
            assert_eq!(json["container"], container.as_str());
            assert_eq!(json["stdout"], format!("{id}\n"));
            assert_eq!(json["stderr"], "");
            assert_eq!(json["truncated"], false);
        }
        // Identity checked before and after each read.
        assert_eq!(reader.reads.get(), 9);
    }
}
