//! Bounded non-secret request codec; a socket identity/permission check is still required.
use super::refused;
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub(super) const REQUEST_LIMIT: usize = 96 * 1024;
pub(super) const ACK_LIMIT: usize = 2048;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub service: [u8; 32],
    pub generation: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetireRequest {
    pub version: u8,
    pub owner: [u8; 16],
    pub operation: [u8; 16],
    pub targets: Vec<Target>,
}
impl RetireRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self, CandidateError> {
        if bytes.len() > REQUEST_LIMIT {
            return Err(refused());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        value.digest()?;
        Ok(value)
    }
    pub fn encode(&self) -> Result<Vec<u8>, CandidateError> {
        self.digest()?;
        let bytes = serde_json::to_vec(self).map_err(|_| refused())?;
        if bytes.len() > REQUEST_LIMIT {
            return Err(refused());
        }
        Ok(bytes)
    }
    fn digest(&self) -> Result<[u8; 32], CandidateError> {
        if self.version != 1
            || self.owner == [0; 16]
            || self.operation == [0; 16]
            || self.targets.is_empty()
            || self.targets.len() > 256
        {
            return Err(refused());
        }
        let mut targets: Vec<_> = self.targets.iter().collect();
        targets.sort_unstable_by_key(|target| target.service);
        if targets
            .iter()
            .any(|target| target.service == [0; 32] || target.generation == [0; 32])
            || targets
                .windows(2)
                .any(|pair| pair[0].service == pair[1].service)
        {
            return Err(refused());
        }
        let mut digest = Sha256::new();
        digest.update(b"Hack relay retirement targets v1\0");
        digest.update((targets.len() as u64).to_be_bytes());
        for target in targets {
            digest.update(target.service);
            digest.update(target.generation);
        }
        Ok(digest.finalize().into())
    }
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Acknowledgement {
    version: u8,
    owner: [u8; 16],
    operation: [u8; 16],
    targets: [u8; 32],
    retired: usize,
}
impl Acknowledgement {
    pub(super) fn for_request(request: &RetireRequest) -> Result<Self, CandidateError> {
        Ok(Self {
            version: 1,
            owner: request.owner,
            operation: request.operation,
            targets: request.digest()?,
            retired: request.targets.len(),
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CandidateError> {
        let bytes = serde_json::to_vec(self).map_err(|_| refused())?;
        if bytes.len() > ACK_LIMIT {
            return Err(refused());
        }
        Ok(bytes)
    }
    /// Must be called only on bytes from the verified private owner transport.
    /// Scope matching alone is not authentication of the sender.
    pub fn verify(bytes: &[u8], request: &RetireRequest) -> Result<Self, CandidateError> {
        if bytes.len() > ACK_LIMIT {
            return Err(refused());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        if value != Self::for_request(request)? {
            return Err(refused());
        }
        Ok(value)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SelectionKind {
    SelectGraph,
}

/// Non-secret graph query. Scope equality is not authentication; use the verified
/// private native transport and hold the runtime mutation lease through intent.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionRequest {
    kind: SelectionKind,
    version: u8,
    pub(super) owner: [u8; 16],
    operation: [u8; 16],
    runtime: [u8; 16],
    boot: [u8; 16],
    graph: [u8; 32],
}
impl SelectionRequest {
    pub fn new(
        owner: [u8; 16],
        operation: [u8; 16],
        scope: super::GraphScope,
    ) -> Result<Self, CandidateError> {
        let value = Self {
            kind: SelectionKind::SelectGraph,
            version: 1,
            owner,
            operation,
            runtime: scope.context.runtime,
            boot: scope.context.boot,
            graph: scope.id,
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<(), CandidateError> {
        if self.version != 1 || self.owner == [0; 16] || self.operation == [0; 16] {
            return Err(refused());
        }
        super::GraphScope::new(
            super::Context {
                runtime: self.runtime,
                boot: self.boot,
            },
            self.graph,
        )?;
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>, CandidateError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| refused())?;
        if bytes.len() > ACK_LIMIT {
            return Err(refused());
        }
        Ok(bytes)
    }
    pub(super) fn parse(bytes: &[u8]) -> Result<Self, CandidateError> {
        if bytes.len() > ACK_LIMIT {
            return Err(refused());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        value.validate()?;
        Ok(value)
    }
}
/// A complete scoped observation from the verified owner, including an explicit
/// empty set. It is not a retirement acknowledgement or durable mutation permission.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphSelection {
    request: SelectionRequest,
    targets: Vec<Target>,
}
impl GraphSelection {
    pub fn targets(&self) -> &[Target] {
        &self.targets
    }
    pub(super) fn for_owner(
        owner: &super::RelayOwner,
        request: SelectionRequest,
    ) -> Result<Self, CandidateError> {
        request.validate()?;
        if request.owner != owner.incarnation() {
            return Err(refused());
        }
        let scope = super::GraphScope::new(
            super::Context {
                runtime: request.runtime,
                boot: request.boot,
            },
            request.graph,
        )?;
        let value = Self {
            targets: owner.targets_for_graph(scope)?,
            request,
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<(), CandidateError> {
        self.request.validate()?;
        // Retirement's nonempty set validator also enforces the 256-target bound,
        // nonzero identities and distinct services. Empty selection is explicit.
        if !self.targets.is_empty() {
            RetireRequest {
                version: 1,
                owner: self.request.owner,
                operation: self.request.operation,
                targets: self.targets.clone(),
            }
            .digest()?;
        }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<Vec<u8>, CandidateError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| refused())?;
        if bytes.len() > REQUEST_LIMIT {
            return Err(refused());
        }
        Ok(bytes)
    }
    pub(super) fn verify(bytes: &[u8], request: &SelectionRequest) -> Result<Self, CandidateError> {
        if bytes.len() > REQUEST_LIMIT {
            return Err(refused());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        if value.request != *request {
            return Err(refused());
        }
        value.validate()?;
        Ok(value)
    }
}
