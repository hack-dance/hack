//! Exact, reviewed names route only to deterministic container-local listeners.
use super::{CandidateError, error};
use std::{collections::BTreeSet, net::Ipv4Addr};

/// Aliasless legacy listeners use localhost. Named listeners receive distinct
/// addresses so two remote destinations can retain the same application port.
pub fn dependency_address(slot: u8, aliases: &[String]) -> Result<Ipv4Addr, CandidateError> {
    if slot >= 32 || aliases.len() > 8 {
        return Err(refused());
    }
    let mut names = BTreeSet::new();
    for name in aliases {
        if crate::provider::publication::normalize_hostname(name)? != *name
            || name == "localhost"
            || name.ends_with(".localhost")
            || name == "localhost.localdomain"
            || !names.insert(name)
        {
            return Err(refused());
        }
    }
    Ok(if aliases.is_empty() {
        Ipv4Addr::LOCALHOST
    } else {
        Ipv4Addr::new(127, 0, 0, slot + 2)
    })
}
pub(super) fn refused() -> CandidateError {
    error(
        "graph_dependency_hosts",
        "Every declared dependency hostname requires one exact reviewed loopback binding.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_names_have_distinct_loopback_addresses_and_no_wildcards() {
        assert_eq!(dependency_address(0, &[]).unwrap(), Ipv4Addr::LOCALHOST);
        assert_eq!(
            dependency_address(0, &["one.example".into()]).unwrap(),
            Ipv4Addr::new(127, 0, 0, 2)
        );
        assert_eq!(
            dependency_address(31, &["two.example".into()]).unwrap(),
            Ipv4Addr::new(127, 0, 0, 33)
        );
        for name in [
            "*.example",
            "127.0.0.1",
            "one.example:443",
            "ONE.example",
            "one.example.",
            "localhost",
            "one.localhost",
            "localhost.localdomain",
        ] {
            assert!(dependency_address(0, &[name.into()]).is_err());
        }
        assert!(dependency_address(32, &[]).is_err());
        assert!(dependency_address(0, &["one.example".into(), "one.example".into()]).is_err());
    }
}
