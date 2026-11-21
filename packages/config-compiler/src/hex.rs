//! Lower-case hexadecimal text for digest bytes.
//!
//! `sha2 0.11` returns a digest as a `hybrid_array::Array`, which does not implement
//! `LowerHex`; the `generic-array` type that `sha2 0.10` returned did. Records, pins and
//! comparisons throughout this crate use that text, so it is produced in one place.
use std::fmt;

/// Formats bytes as two lower-case hexadecimal digits each, in order, with no prefix or
/// separator: `format!("{:x}", Hex(Sha256::digest(input)))` is the 64-character digest text.
/// Width, fill, precision and `#` are ignored.
pub struct Hex<T: AsRef<[u8]>>(pub T);

impl<T: AsRef<[u8]>> fmt::LowerHex for Hex<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0.as_ref() {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Hex;

    #[test]
    fn every_byte_becomes_two_lower_case_digits_in_order() {
        assert_eq!(format!("{:x}", Hex([0x00, 0x0f, 0xa0, 0xff])), "000fa0ff");
        assert_eq!(format!("{:x}", Hex(&[0x01_u8, 0x23][..])), "0123");
        assert_eq!(format!("{:x}", Hex(Vec::new())), "");
        assert_eq!(
            format!("sha256:{:x}", Hex(vec![0xab; 32])),
            format!("sha256:{}", "ab".repeat(32))
        );
        let all: Vec<u8> = (0..=255).collect();
        let expected: String = all.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(format!("{:x}", Hex(&all)), expected);
    }
}
