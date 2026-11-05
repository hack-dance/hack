//! Admission of image-declared `VOLUME` targets on Compose-file graphs.
//!
//! An image `VOLUME` makes the engine allocate an anonymous volume unless an explicit
//! mount already occupies that target. Graphs never create anonymous storage, so each
//! declared target must be covered by exactly one explicit mount, and that mount must be
//! a whole (no subpath) graph-owned named volume of this receipt. Dependency-cache
//! volumes have consumers outside the graph and never cover an image volume: copy-up
//! into a shared cache would let one image's files reach other consumers.
//!
//! This is a pure predicate over already-reviewed configuration. It reads no engine
//! state, adds no capability, changes no ownership and does not alter receipt or plan
//! identity. Start, restart, restore and one-off all reach it through `verify_images`.

use super::{CandidateError, Kind, Resource, error};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

/// Closed refusal for an image volume that lacks exactly one owned named cover.
pub(super) const UNCOVERED: &str = "graph_image_volume_uncovered";

/// Same lexical form the Compose review gives mount targets (`fields::safe_absolute`).
fn normalized(target: &str) -> String {
    Path::new(target)
        .components()
        .collect::<std::path::PathBuf>()
        .to_string_lossy()
        .into_owned()
}

fn uncovered() -> CandidateError {
    error(
        UNCOVERED,
        "An image-declared volume is not covered by exactly one owned named volume mount.",
    )
}

/// Admit `image_volumes` (the image `Config.Volumes` value) for one compiled container
/// configuration. Null or an empty object passes. Otherwise every declared target needs
/// an empty options object and exactly one mount at the same normalized target; that
/// mount must be a writable-or-read-only `volume` mount without a subpath whose source
/// is a non-cache volume resource of this graph.
pub(super) fn admit(
    image_volumes: &Value,
    config: &Value,
    resources: &BTreeMap<String, Resource>,
) -> Result<(), CandidateError> {
    if image_volumes.is_null() {
        return Ok(());
    }
    let declared = image_volumes.as_object().ok_or_else(uncovered)?;
    if declared.is_empty() {
        return Ok(());
    }
    let mounts = config["HostConfig"]["Mounts"]
        .as_array()
        .ok_or_else(uncovered)?;
    for (target, options) in declared {
        if !options.as_object().is_some_and(|object| object.is_empty()) || !target.starts_with('/')
        {
            return Err(uncovered());
        }
        let target = normalized(target);
        let mut covering = mounts.iter().filter(|mount| {
            mount["Target"]
                .as_str()
                .is_some_and(|value| normalized(value) == target)
        });
        let (Some(mount), None) = (covering.next(), covering.next()) else {
            return Err(uncovered());
        };
        let source = mount["Source"].as_str();
        let owned = resources.values().any(|resource| {
            resource.kind == Kind::Volume
                && resource.cache.is_none()
                && Some(resource.name.as_str()) == source
        });
        if mount["Type"] != "volume" || !mount["VolumeOptions"]["Subpath"].is_null() || !owned {
            return Err(uncovered());
        }
    }
    // A bare `Binds` entry or tmpfs could also occupy a declared target outside Mounts.
    // Compose-file graphs never emit them for volume targets; refuse if they do.
    let tmpfs_covers = |target: &str| {
        config["HostConfig"]["Tmpfs"]
            .as_object()
            .is_some_and(|tmpfs| tmpfs.keys().any(|key| normalized(key) == target))
    };
    if config["HostConfig"]["Binds"]
        .as_array()
        .is_some_and(|binds| !binds.is_empty())
        || declared
            .keys()
            .any(|target| tmpfs_covers(&normalized(target)))
    {
        return Err(uncovered());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn volume(key: &str, name: &str, cache: bool) -> Resource {
        let mut resource: Resource = serde_json::from_value(json!({
            "kind":"volume","key":key,"name":name,"id":null,"image":null,"phase":"reserved"
        }))
        .unwrap();
        if cache {
            resource.cache = Some(super::super::dependency_cache::CacheBinding {
                scope: "c".repeat(64),
                fingerprint: "d".repeat(64),
                image: format!("sha256:{}", "e".repeat(64)),
            });
        }
        resource
    }

    fn resources() -> BTreeMap<String, Resource> {
        let run = "a".repeat(32);
        BTreeMap::from([
            (
                "volume:data".into(),
                volume("data", &format!("hkg-{run}-volume-0"), false),
            ),
            (
                "volume:other".into(),
                volume("other", &format!("hkg-{run}-volume-1"), false),
            ),
        ])
    }

    fn owned(index: usize) -> String {
        format!("hkg-{}-volume-{index}", "a".repeat(32))
    }

    fn config(mounts: Value) -> Value {
        json!({"HostConfig":{"Mounts":mounts}})
    }

    fn mount(source: &str, target: &str) -> Value {
        json!({"Type":"volume","Source":source,"Target":target,"ReadOnly":false})
    }

    fn refused(result: Result<(), CandidateError>) {
        assert_eq!(result.unwrap_err().code, UNCOVERED);
    }

    #[test]
    fn absent_or_empty_image_volumes_pass_without_mounts() {
        for declared in [Value::Null, json!({})] {
            admit(&declared, &config(json!([])), &resources()).unwrap();
        }
    }

    #[test]
    fn one_owned_named_mount_covers_each_declared_target() {
        let declared = json!({"/var/lib/data":{},"/srv/state/":{}});
        let mounts = json!([
            mount(&owned(0), "/var/lib/data"),
            mount(&owned(1), "/srv/state"),
            {"Type":"bind","Source":"/source","Target":"/app","ReadOnly":true}
        ]);
        admit(&declared, &config(mounts), &resources()).unwrap();
        let mut read_only = mount(&owned(0), "/var/lib/data");
        read_only["ReadOnly"] = json!(true);
        admit(
            &json!({"/var/lib/data":{}}),
            &config(json!([read_only])),
            &resources(),
        )
        .unwrap();
    }

    #[test]
    fn uncovered_and_ambiguous_targets_refuse() {
        let declared = json!({"/var/lib/data":{}});
        // No mount, a mount elsewhere, and a nested mount do not cover the target.
        refused(admit(&declared, &config(json!([])), &resources()));
        refused(admit(
            &declared,
            &config(json!([mount(&owned(0), "/var/lib/data/inner")])),
            &resources(),
        ));
        refused(admit(&declared, &json!({"HostConfig":{}}), &resources()));
        // Two mounts at the same target, even of different types, are ambiguous.
        refused(admit(
            &declared,
            &config(json!([
                mount(&owned(0), "/var/lib/data"),
                mount(&owned(1), "/var/lib/data/")
            ])),
            &resources(),
        ));
        // A second declared target without its own cover still refuses.
        refused(admit(
            &json!({"/var/lib/data":{},"/var/log/data":{}}),
            &config(json!([mount(&owned(0), "/var/lib/data")])),
            &resources(),
        ));
    }

    #[test]
    fn bind_subpath_foreign_and_cache_covers_refuse() {
        let declared = json!({"/var/lib/data":{}});
        refused(admit(
            &declared,
            &config(
                json!([{"Type":"bind","Source":"/source","Target":"/var/lib/data","ReadOnly":false}]),
            ),
            &resources(),
        ));
        let mut subpath = mount(&owned(0), "/var/lib/data");
        subpath["VolumeOptions"] = json!({"Subpath":"pg","NoCopy":true});
        refused(admit(&declared, &config(json!([subpath])), &resources()));
        // A volume that is not a resource of this graph is never adopted as a cover.
        refused(admit(
            &declared,
            &config(json!([mount(
                &format!("hkg-{}-volume-0", "b".repeat(32)),
                "/var/lib/data"
            )])),
            &resources(),
        ));
        refused(admit(
            &declared,
            &config(json!([mount("anonymous", "/var/lib/data")])),
            &resources(),
        ));
        let mut with_cache = resources();
        let cache = volume("deps", &format!("hack-cache-v5-{}", "d".repeat(64)), true);
        let cache_name = cache.name.clone();
        assert_eq!(cache.cache.as_ref().unwrap().name(), cache_name);
        with_cache.insert("volume:deps".into(), cache);
        refused(admit(
            &declared,
            &config(json!([mount(&cache_name, "/var/lib/data")])),
            &with_cache,
        ));
    }

    #[test]
    fn non_empty_options_malformed_values_and_side_channels_refuse() {
        let covered = config(json!([mount(&owned(0), "/var/lib/data")]));
        refused(admit(
            &json!({"/var/lib/data":{"driver":"x"}}),
            &covered,
            &resources(),
        ));
        refused(admit(
            &json!({"/var/lib/data":null}),
            &covered,
            &resources(),
        ));
        refused(admit(&json!({"relative":{}}), &covered, &resources()));
        refused(admit(&json!(["/var/lib/data"]), &covered, &resources()));
        let mut binds = covered.clone();
        binds["HostConfig"]["Binds"] = json!(["/x:/y"]);
        refused(admit(&json!({"/var/lib/data":{}}), &binds, &resources()));
        let mut tmpfs = covered;
        tmpfs["HostConfig"]["Tmpfs"] = json!({"/var/lib/data/":"rw"});
        refused(admit(&json!({"/var/lib/data":{}}), &tmpfs, &resources()));
    }
}
