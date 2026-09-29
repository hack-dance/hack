//! Explicit or pool-allocated service-to-slot enrollment.
use super::{BTreeMap, CandidateError, graph, invalid};
pub(super) fn insert(
    slots: &mut BTreeMap<String, graph::RouteSlot>,
    value: &str,
) -> Result<(), CandidateError> {
    let (service, index) = value.split_once('=').ok_or_else(invalid)?;
    let slot = if index == "auto" {
        graph::RouteSlot::Auto
    } else {
        let slot: u8 = index.parse().map_err(|_| invalid())?;
        if index != slot.to_string() || slot >= 32 {
            return Err(invalid());
        }
        graph::RouteSlot::Explicit(slot)
    };
    if service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        || slots.contains_key(service)
        || matches!(slot, graph::RouteSlot::Explicit(_)) && slots.values().any(|used| *used == slot)
    {
        return Err(invalid());
    }
    slots.insert(service.into(), slot);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enrollment_refuses_ambiguous_duplicate_and_out_of_range_slots() {
        let mut slots = BTreeMap::new();
        insert(&mut slots, "web=0").unwrap();
        insert(&mut slots, "api=31").unwrap();
        insert(&mut slots, "worker=auto").unwrap();
        insert(&mut slots, "other-auto=auto").unwrap();
        for value in [
            "web=1",
            "other=0",
            "other=32",
            "=2",
            "../web=2",
            "web/name=2",
            "x=-1",
            "x=01",
            "x=+1",
            "x=1=2",
            "worker=auto",
            "bad=Auto",
        ] {
            let before = slots.clone();
            assert!(insert(&mut slots, value).is_err(), "{value}");
            assert_eq!(slots, before);
        }
    }
}
