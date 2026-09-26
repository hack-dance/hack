//! Persisted relay identity remains readable on every supported host.
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RelayProcess {
    pub pid: u32,
    pub start: u64,
    pub port: u16,
    #[serde(default = "legacy_address", skip_serializing_if = "is_legacy_address")]
    pub address: Ipv4Addr,
}
fn legacy_address() -> Ipv4Addr {
    Ipv4Addr::LOCALHOST
}
fn is_legacy_address(address: &Ipv4Addr) -> bool {
    *address == Ipv4Addr::LOCALHOST
}
