use serde::Deserialize;
use std::{ffi::OsStr, sync::LazyLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    pub(crate) env_key: String,
    pub(crate) private_staging_dir: String,
    generated_state_dirs: Vec<String>,
    pub(crate) hack_dir_ignore: Vec<String>,
}

pub(crate) static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../src/project-private-files.json"))
        .expect("embedded project private files policy")
});

/// State directories owned by Hack inside its project configuration directory.
pub(crate) fn generated_state_child(parent: &OsStr, name: &OsStr) -> bool {
    parent.eq_ignore_ascii_case(".hack")
        && POLICY
            .generated_state_dirs
            .iter()
            .any(|dir| name.eq_ignore_ascii_case(dir))
}
