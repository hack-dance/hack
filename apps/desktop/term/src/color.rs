//! An sRGB colour, shared by the emulator and the Ghostty config reader.

/// An sRGB colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub const fn from_u32(hex: u32) -> Self {
        Self::new((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
    }

    /// `0xRRGGBB`.
    pub fn to_u32(self) -> u32 {
        (u32::from(self.r) << 16) | (u32::from(self.g) << 8) | u32::from(self.b)
    }

    /// `#RRGGBB`, `RRGGBB`, `#RGB` or `RGB`.
    pub fn from_hex(text: &str) -> Option<Self> {
        let hex = text.strip_prefix('#').unwrap_or(text);
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let v = |s: &str| u8::from_str_radix(s, 16).ok();
        match hex.len() {
            6 => Some(Self::new(v(&hex[0..2])?, v(&hex[2..4])?, v(&hex[4..6])?)),
            3 => {
                let d = |i: usize| v(&hex[i..=i]).map(|n| n * 17);
                Some(Self::new(d(0)?, d(1)?, d(2)?))
            }
            _ => None,
        }
    }
}
