//! Explicit native foreground lifetime; dead ownership never authorizes adoption or replay.
use super::*;
use crate::provider::graph::foreground::{signals, transport};
use serde::{Deserialize, Serialize};
use std::{cell::Cell, io::Write};
mod owner;
pub(super) use owner::DirectGuard;
#[cfg(test)]
mod tests;
const LIMIT: usize = 64 * 1024;

fn refused() -> CandidateError {
    error(
        "native_graph_foreground",
        "Native foreground ownership is changed, unavailable or uncertain; its exact evidence was preserved. Use tagged native control for a live owner; no recovery or replay was attempted.",
    )
}
pub(super) fn require_unpublished(candidate: &Candidate, run: &str) -> Result<(), CandidateError> {
    if owner::present(candidate, run)? {
        return Err(refused());
    }
    Ok(())
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Status,
    Cleanup,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RequestKind {
    NativeGraphControl,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    kind: RequestKind,
    run: String,
    review: String,
    action: Action,
}
impl Request {
    fn validate(&self, review: &native_input::Review) -> Result<(), CandidateError> {
        if self.version != 2 || self.run != review.scope().run || self.review != review.review_id()
        {
            return Err(refused());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ReplyKind {
    NativeGraphControlReply,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    kind: ReplyKind,
    run: String,
    review: String,
    result: Outcome,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "kebab-case", deny_unknown_fields)]
enum Outcome {
    Status {
        #[serde(deserialize_with = "decode_snapshot")]
        snapshot: Snapshot,
    },
    Cleaned {
        receipt: Receipt,
    },
    Refused {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_failures: Option<crate::error::StopFailuresDiagnostic>,
    },
}

// The native wire closes nested observation fields without changing the shared
// execution Observation codec used by existing Compose readers.
fn decode_snapshot<'de, D: serde::Deserializer<'de>>(reader: D) -> Result<Snapshot, D::Error> {
    #[derive(Deserialize)]
    #[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
    enum WireObservation {
        Created {},
        Running { health: execution::Health },
        Exited { code: i64 },
        Dead {},
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct WireSnapshot {
        receipt: Receipt,
        observations: BTreeMap<String, Option<WireObservation>>,
    }
    let decoded = WireSnapshot::deserialize(reader)?;
    Ok(Snapshot {
        receipt: decoded.receipt,
        observations: decoded
            .observations
            .into_iter()
            .map(|(key, value)| {
                (
                    key,
                    value.map(|value| match value {
                        WireObservation::Created {} => Observation::Created,
                        WireObservation::Running { health } => Observation::Running { health },
                        WireObservation::Exited { code } => Observation::Exited { code },
                        WireObservation::Dead {} => Observation::Dead,
                    }),
                )
            })
            .collect(),
    })
}
impl Reply {
    fn validate(&self, expected: &Receipt) -> Result<(), CandidateError> {
        let review = &expected.review;
        if self.version != 2 || self.run != review.scope().run || self.review != review.review_id()
        {
            return Err(refused());
        }
        let receipt = match &self.result {
            Outcome::Status { snapshot } => {
                if snapshot
                    .observations
                    .keys()
                    .ne(snapshot.receipt.readiness.keys())
                {
                    return Err(refused());
                }
                &snapshot.receipt
            }
            Outcome::Cleaned { receipt } => {
                if receipt.phase != Phase::Removed {
                    return Err(refused());
                }
                receipt
            }
            Outcome::Refused {
                code,
                stop_failures,
            } => {
                if code.is_empty()
                    || code.len() > 64
                    || !code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    || stop_failures.as_ref().is_some_and(|detail| {
                        !detail.valid()
                            || !matches!(
                                code.as_str(),
                                "engine_protocol" | "engine_rejected" | "engine_not_found"
                            )
                            || detail
                                .failures
                                .iter()
                                .any(|failure| !expected.readiness.contains_key(&failure.service))
                    })
                {
                    return Err(refused());
                }
                return Ok(());
            }
        };
        if receipt.review != *review
            || receipt.owner != expected.owner
            || receipt.boot != expected.boot
        {
            return Err(refused());
        }
        receipt.validate(review.scope().run, &receipt.owner)
    }
}

/// This process remains supervised until TERM/INT or authenticated exact-run cleanup.
/// Startup and cleanup use the owning native runtime; no Compose receipt is constructed.
pub fn serve(
    candidate: &Candidate,
    prepared: selection::Prepared,
) -> Result<Receipt, CandidateError> {
    prepared.assert_fresh(candidate)?;
    let review = prepared.input().review().clone();
    let run = review.scope().run.to_owned();
    let mut publication = owner::Publication::bind(candidate, &review)?;
    let signals = match signals::Events::new_descriptor(publication.descriptor()) {
        Ok(signals) => signals,
        Err(error) => {
            publication.finish()?;
            return Err(error);
        }
    };
    let admitted = Cell::new(false);
    let attempt = {
        let check = || {
            publication.verify()?;
            if signals.pending() {
                return Err(error(
                    "native_graph_canceled",
                    "Native foreground startup canceled; values omitted.",
                ));
            }
            Ok(())
        };
        runtime::run_guarded(candidate, prepared, Some(&check), Some(&admitted))
    };
    let receipt = match attempt {
        Ok(receipt) => receipt,
        Err(error) => {
            if admitted.get() {
                if runtime::cleanup_guarded(
                    candidate,
                    &run,
                    Some(&review),
                    Some(&|| publication.verify()),
                )
                .is_ok()
                {
                    publication.finish()?;
                }
            } else if std::fs::symlink_metadata(journal::directory(candidate, &run)?)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                publication.finish()?;
            }
            return Err(error);
        }
    };
    let clean = || {
        runtime::cleanup_guarded(
            candidate,
            &run,
            Some(&review),
            Some(&|| publication.verify()),
        )
    };
    if signals.pending() {
        let receipt = clean()?;
        publication.finish()?;
        return Ok(receipt);
    }
    publication.verify()?;
    {
        let ready = json!({"version":2,"kind":"native-graph-foreground-ready","run":run,"review":review.review_id(),"receipt":receipt});
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &ready).map_err(|_| refused())?;
        writeln!(stdout)
            .and_then(|_| stdout.flush())
            .map_err(|_| refused())?;
    }
    loop {
        if signals.wait()? {
            let receipt = clean()?;
            publication.finish()?;
            return Ok(receipt);
        }
        let Some(mut stream) = publication.accept()? else {
            continue;
        };
        let request: Request = match transport::read(&mut stream, Duration::from_secs(5), 4096) {
            Ok(request) => request,
            Err(_) => continue,
        };
        if request.validate(&review).is_err() {
            continue;
        }
        publication.verify()?;
        let result = match request.action {
            Action::Status => inspect(candidate, &run).map(|snapshot| Outcome::Status { snapshot }),
            Action::Cleanup => clean().map(|receipt| Outcome::Cleaned { receipt }),
        };
        let result = result.unwrap_or_else(|error| Outcome::Refused {
            code: error.code.into(),
            stop_failures: error.stop_failures,
        });
        let cleaned = matches!(result, Outcome::Cleaned { .. });
        let reply = Reply {
            version: 2,
            kind: ReplyKind::NativeGraphControlReply,
            run: run.clone(),
            review: review.review_id().into(),
            result,
        };
        reply.validate(&receipt)?;
        // Cleanup completion remains durable if the authenticated caller loses the reply.
        let _ = transport::write(&mut stream, &reply, Duration::from_secs(5));
        if cleaned {
            let Outcome::Cleaned { receipt } = reply.result else {
                return Err(refused());
            };
            publication.finish()?;
            return Ok(receipt);
        }
    }
}

pub struct RequestOptions<'a> {
    pub run: &'a str,
    pub action: Action,
}
/// Bounded authenticated native-only request. A timeout never authorizes replay or killing the owner.
pub fn request(
    candidate: &Candidate,
    options: RequestOptions<'_>,
) -> Result<Value, CandidateError> {
    let pin = owner::Pin::load(candidate, options.run)?;
    let review = pin.review();
    let expected = journal::read_control(candidate, review)?;
    let mut stream = pin.connect()?;
    let input = Request {
        version: 2,
        kind: RequestKind::NativeGraphControl,
        run: options.run.into(),
        review: review.review_id().into(),
        action: options.action,
    };
    transport::write(&mut stream, &input, Duration::from_secs(5))?;
    let reply: Reply = transport::read(&mut stream, Duration::from_secs(30), LIMIT)?;
    pin.verify()?;
    reply.validate(&expected)?;
    if let Outcome::Refused {
        code,
        stop_failures,
    } = reply.result
    {
        let mut error = refused().with_cause_code(code);
        error.stop_failures = stop_failures;
        return Err(error);
    }
    serde_json::to_value(reply).map_err(|_| refused())
}
