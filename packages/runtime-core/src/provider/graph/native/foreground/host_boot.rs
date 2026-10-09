//! Stable native host boot authority. Calendar boot time is not an incarnation ID.
use super::{CandidateError, refused};
use serde::{Deserialize, Deserializer, Serialize};

/// Persisted boot qualifiers are canonical, nonzero UUIDs. No timestamp fallback.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub(super) struct Session(String);
impl Session {
    fn parse(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 36
            || bytes.iter().enumerate().any(|(i, byte)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    *byte != b'-'
                } else {
                    !byte.is_ascii_digit() && !(b'a'..=b'f').contains(byte)
                }
            })
            || !bytes
                .iter()
                .any(|byte| matches!(byte, b'1'..=b'9' | b'a'..=b'f'))
        {
            return None;
        }
        Some(Self(value.into()))
    }
}
impl<'de> Deserialize<'de> for Session {
    fn deserialize<D: Deserializer<'de>>(reader: D) -> Result<Self, D::Error> {
        let value = String::deserialize(reader)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("Invalid host boot qualifier"))
    }
}

fn decode(buffer: &[u8; 37], length: usize) -> Result<Session, CandidateError> {
    if length != buffer.len() || buffer[36] != 0 {
        return Err(refused());
    }
    let text = std::str::from_utf8(&buffer[..36]).map_err(|_| refused())?;
    // XNU publishes uppercase UUID text; only the native reader normalizes it.
    Session::parse(&text.to_ascii_lowercase()).ok_or_else(refused)
}

pub(super) fn read() -> Result<Session, CandidateError> {
    #[cfg(test)]
    if let Some(value) = test::next() {
        return value.ok_or_else(refused);
    }
    let mut buffer = [0u8; 37];
    let mut length = buffer.len();
    // SAFETY: the read-only sysctl writes at most this fixed initialized buffer;
    // its size pointer is live, newp is null, and no pointer is retained.
    if unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(refused());
    }
    decode(&buffer, length)
}

#[cfg(test)]
pub(super) mod test {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque};
    thread_local! {
        static OVERRIDE: RefCell<Option<VecDeque<Option<Session>>>> = const { RefCell::new(None) };
    }
    pub(super) fn next() -> Option<Option<Session>> {
        OVERRIDE.with(|cell| {
            let mut state = cell.borrow_mut();
            let values = state.as_mut()?;
            if values.len() > 1 {
                values.pop_front()
            } else {
                values.front().cloned()
            }
        })
    }
    pub(in super::super) struct Guard(Option<VecDeque<Option<Session>>>);
    impl Guard {
        pub(in super::super) fn set(value: Option<&str>) -> Self {
            Self::sequence(&[value])
        }
        pub(in super::super) fn sequence(values: &[Option<&str>]) -> Self {
            assert!(!values.is_empty());
            Self(OVERRIDE.with(|cell| {
                cell.replace(Some(
                    values
                        .iter()
                        .map(|value| value.map(|v| Session::parse(v).unwrap()))
                        .collect(),
                ))
            }))
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            OVERRIDE.with(|cell| cell.replace(self.0.take()));
        }
    }
    #[test]
    fn fixed_native_buffer_normalizes_only_valid_exact_uuid() {
        let mut buffer = *b"12345678-ABCD-ABCD-ABCD-123456789ABC\0";
        assert!(
            decode(&buffer, 37).unwrap()
                == Session::parse("12345678-abcd-abcd-abcd-123456789abc").unwrap()
        );
        for length in [0, 36, 38] {
            assert!(decode(&buffer, length).is_err());
        }
        buffer[36] = b'x';
        assert!(decode(&buffer, 37).is_err());
        for value in [
            "00000000-0000-0000-0000-000000000000",
            "12345678-abcd-abcd-abcd-123456789abg",
            "12345678_abcd-abcd-abcd-123456789abc",
        ] {
            let bytes: [u8; 37] = format!("{value}\0").into_bytes().try_into().unwrap();
            assert!(decode(&bytes, 37).is_err());
        }
        buffer = *b"12345678-ABCD-ABCD-ABCD-123456789ABC\0";
        buffer[0] = 0xff;
        assert!(decode(&buffer, 37).is_err());
        buffer[0] = 0;
        assert!(decode(&buffer, 37).is_err());
    }
    #[test]
    fn persisted_uuid_is_closed_and_reader_unavailability_never_falls_back() {
        for value in [
            serde_json::Value::Null,
            serde_json::json!(1),
            serde_json::json!("12345678-ABCD-ABCD-ABCD-123456789ABC"),
            serde_json::json!("00000000-0000-0000-0000-000000000000"),
        ] {
            assert!(serde_json::from_value::<Session>(value).is_err());
        }
        let _guard = Guard::set(None);
        assert!(read().is_err());
    }
}
