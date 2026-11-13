//! Engine's logs API accepts Unix seconds with a fractional nanosecond suffix.
//! Keep calendar parsing independent of the host timezone and libc global state.
use super::valid_timestamp;

pub(in crate::provider) fn unix_nanos(text: &str) -> Option<String> {
    if !valid_timestamp(text) {
        return None;
    }
    let number = |start, end| text.get(start..end)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > months[(month - 1) as usize] {
        return None;
    }
    let leaps_before = |y: i64| (y - 1) / 4 - (y - 1) / 100 + (y - 1) / 400;
    let days = (year - 1970) * 365 + leaps_before(year) - leaps_before(1970)
        + months[..(month - 1) as usize].iter().sum::<i64>()
        + day
        - 1;
    let (zone_start, offset) = if text.ends_with('Z') {
        (text.len() - 1, 0)
    } else {
        let start = text.len() - 6;
        let (h, m) = (number(start + 1, start + 3)?, number(start + 4, start + 6)?);
        if h > 23 || m > 59 {
            return None;
        }
        (
            start,
            (h * 3600 + m * 60)
                * if text.as_bytes()[start] == b'+' {
                    1
                } else {
                    -1
                },
        )
    };
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset;
    if seconds < 0 {
        return None;
    }
    let fraction = if zone_start > 19 {
        text.get(20..zone_start)?
    } else {
        ""
    };
    Some(format!("{seconds}.{fraction:0<9}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts_utc_offsets_and_leap_days_without_losing_nanoseconds() {
        for (source, expected) in [
            ("1970-01-01T00:00:00Z", "0.000000000"),
            ("2026-01-01T00:00:00.123456789Z", "1767225600.123456789"),
            (
                "2026-01-01T02:00:00.123456789+02:00",
                "1767225600.123456789",
            ),
            ("2025-12-31T18:30:00.1-05:30", "1767225600.100000000"),
            ("2000-03-01T00:00:00Z", "951868800.000000000"),
            ("2024-02-29T00:00:00Z", "1709164800.000000000"),
        ] {
            assert_eq!(unix_nanos(source).as_deref(), Some(expected));
        }
        for source in [
            "2025-02-29T00:00:00Z",
            "2024-02-30T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:00+24:00",
            "0001-01-01T00:00:00Z",
        ] {
            assert!(unix_nanos(source).is_none());
        }
    }
}
