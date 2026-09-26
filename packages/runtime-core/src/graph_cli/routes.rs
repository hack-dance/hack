//! Explicit service-to-slot enrollment, with no implicit global slot discovery.
use super::{BTreeMap, CandidateError, invalid};
pub(super) fn insert(slots: &mut BTreeMap<String, u8>, value: &str) -> Result<(), CandidateError> {
    let (service, index) = value.split_once('=').ok_or_else(invalid)?;
    let slot: u8 = index.parse().map_err(|_| invalid())?;
    if service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        || index != slot.to_string()
        || slot >= 32
        || slots.contains_key(service)
        || slots.values().any(|used| *used == slot)
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
        ] {
            let before = slots.clone();
            assert!(insert(&mut slots, value).is_err(), "{value}");
            assert_eq!(slots, before);
        }
    }
}
