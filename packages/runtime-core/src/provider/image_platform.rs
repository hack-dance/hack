//! Linux image platforms the guest can run, and the explicit policy that selects one.
//!
//! The guest is Linux arm64. `linux/amd64` runs only under Rosetta 2 x86_64 translation in a
//! pool that was booted with it (`Owner::amd64_emulation`), and only for a service that opted
//! in. Selection never substitutes silently: without an opt-in policy only arm64 is admitted.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One concrete image platform.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImagePlatform {
    #[default]
    #[serde(rename = "linux/arm64")]
    LinuxArm64,
    #[serde(rename = "linux/amd64")]
    LinuxAmd64,
}

impl ImagePlatform {
    /// The OCI `os/architecture` name, as Compose `platform` writes it.
    pub fn name(self) -> &'static str {
        match self {
            Self::LinuxArm64 => "linux/arm64",
            Self::LinuxAmd64 => "linux/amd64",
        }
    }

    /// The architecture Docker reports for a loaded image of this platform.
    pub fn architecture(self) -> &'static str {
        match self {
            Self::LinuxArm64 => "arm64",
            Self::LinuxAmd64 => "amd64",
        }
    }

    /// Whether running this platform requires Rosetta translation in the guest.
    pub fn emulated(self) -> bool {
        self == Self::LinuxAmd64
    }

    /// Whether an index or config platform names exactly this platform. arm64 accepts an
    /// absent or `v8` variant; amd64 accepts only an absent variant, so microarchitecture
    /// levels such as `v3` are never chosen implicitly.
    pub fn matches(self, os: &str, architecture: &str, variant: Option<&str>) -> bool {
        os == "linux"
            && architecture == self.architecture()
            && match self {
                Self::LinuxArm64 => variant.is_none_or(|v| v == "v8"),
                Self::LinuxAmd64 => variant.is_none(),
            }
    }

    /// Whether an image configuration document targets exactly this platform.
    pub fn matches_config(self, config: &Value) -> bool {
        let variant = match config.get("variant") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => return false,
        };
        match (config["os"].as_str(), config["architecture"].as_str()) {
            (Some(os), Some(architecture)) => self.matches(os, architecture, variant),
            _ => false,
        }
    }
}

/// How a service's image platform is chosen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PlatformPolicy {
    /// Linux arm64 only (the default, and the only choice without an opt-in).
    #[default]
    Native,
    /// Linux arm64 when the image publishes it, otherwise Linux amd64 under emulation.
    PreferNative,
    /// Linux amd64 under emulation, even when the image also publishes arm64.
    Amd64,
}

impl PlatformPolicy {
    /// `native`, `prefer-native` or `amd64`, as `runtime ensure-image --emulation` takes them.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "native" => Some(Self::Native),
            "prefer-native" => Some(Self::PreferNative),
            "amd64" => Some(Self::Amd64),
            _ => None,
        }
    }

    /// Platforms in preference order.
    pub fn candidates(self) -> &'static [ImagePlatform] {
        match self {
            Self::Native => &[ImagePlatform::LinuxArm64],
            Self::PreferNative => &[ImagePlatform::LinuxArm64, ImagePlatform::LinuxAmd64],
            Self::Amd64 => &[ImagePlatform::LinuxAmd64],
        }
    }

    /// Whether this policy may select an emulated platform.
    pub fn may_emulate(self) -> bool {
        self != Self::Native
    }

    /// The policy that admits exactly `platform`.
    pub fn exact(platform: ImagePlatform) -> Self {
        match platform {
            ImagePlatform::LinuxArm64 => Self::Native,
            ImagePlatform::LinuxAmd64 => Self::Amd64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platforms_match_exact_linux_architectures_and_variants() {
        let arm = ImagePlatform::LinuxArm64;
        let amd = ImagePlatform::LinuxAmd64;
        assert!(arm.matches("linux", "arm64", None));
        assert!(arm.matches("linux", "arm64", Some("v8")));
        assert!(!arm.matches("linux", "arm64", Some("v9")));
        assert!(!arm.matches("darwin", "arm64", None));
        assert!(amd.matches("linux", "amd64", None));
        assert!(!amd.matches("linux", "amd64", Some("v3")));
        assert!(!amd.matches("linux", "arm64", None));
        assert!(amd.matches_config(&json!({"os":"linux","architecture":"amd64"})));
        assert!(!amd.matches_config(&json!({"os":"linux","architecture":"amd64","variant":"v2"})));
        assert!(!amd.matches_config(&json!({"os":"linux","architecture":"amd64","variant":1})));
        assert!(arm.matches_config(&json!({"os":"linux","architecture":"arm64","variant":"v8"})));
        assert!(!arm.matches_config(&json!({"os":"linux","architecture":"amd64"})));
        assert_eq!(serde_json::to_value(amd).unwrap(), json!("linux/amd64"));
        assert!(amd.emulated() && !arm.emulated());
    }

    #[test]
    fn policies_parse_closed_names_and_order_native_first() {
        assert_eq!(
            PlatformPolicy::parse("native"),
            Some(PlatformPolicy::Native)
        );
        assert_eq!(
            PlatformPolicy::parse("prefer-native"),
            Some(PlatformPolicy::PreferNative)
        );
        assert_eq!(PlatformPolicy::parse("amd64"), Some(PlatformPolicy::Amd64));
        assert_eq!(PlatformPolicy::parse("linux/amd64"), None);
        assert_eq!(
            PlatformPolicy::Native.candidates(),
            &[ImagePlatform::LinuxArm64]
        );
        assert_eq!(
            PlatformPolicy::PreferNative.candidates(),
            &[ImagePlatform::LinuxArm64, ImagePlatform::LinuxAmd64]
        );
        assert!(!PlatformPolicy::Native.may_emulate());
        assert!(PlatformPolicy::PreferNative.may_emulate());
    }
}
