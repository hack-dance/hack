use serde::{Deserialize, Serialize};

/// Names are chosen with the owner and never migrated in place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum PoolLayout {
    #[default]
    Legacy,
    CompactV1,
}

impl PoolLayout {
    pub(super) fn is_legacy(&self) -> bool {
        *self == Self::Legacy
    }

    pub(super) fn project(self, digest: &str) -> String {
        match self {
            Self::Legacy => format!("/mnt/hack-projects/{digest}"),
            Self::CompactV1 => format!("/mnt/hp/{}", &digest[..16]),
        }
    }

    pub(super) fn bridge(self, slot: u8) -> String {
        match self {
            Self::Legacy => format!("/run/hack-local/bridge-{slot:02}.sock"),
            Self::CompactV1 => format!("/run/hb/{slot:02}"),
        }
    }

    pub(super) fn dependency(self, slot: u8) -> String {
        match self {
            Self::Legacy => format!("/run/hack-dependencies/dependency-{slot:02}.sock"),
            Self::CompactV1 => format!("/run/hd/{slot:02}"),
        }
    }
}
