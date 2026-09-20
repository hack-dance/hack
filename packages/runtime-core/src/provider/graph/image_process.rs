//! Process defaults from an already verified immutable image, before wrappers.
//! Compose null inherits; explicit entrypoint (including empty) suppresses image
//! CMD. No shell tokenization, PATH lookup or image selection occurs here.
//! See https://docs.docker.com/reference/compose-file/services/#entrypoint.
use super::{CandidateError, error};
use serde_json::{Value, json};

const MAX_ARGUMENTS: usize = 4096;
const MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Resolved {
    pub(super) entrypoint: Vec<String>,
    pub(super) cmd: Vec<String>,
}

fn malformed() -> CandidateError {
    error(
        "image_process",
        "Selected image or Compose process arguments are malformed or exceed the bounded profile; values omitted.",
    )
}

fn selected<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn argv(
    value: Option<&Value>,
    count: &mut usize,
    bytes: &mut usize,
) -> Result<Vec<String>, CandidateError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(malformed)?;
    *count = count
        .checked_add(values.len())
        .filter(|count| *count <= MAX_ARGUMENTS)
        .ok_or_else(malformed)?;
    values
        .iter()
        .map(|value| {
            let text = value
                .as_str()
                .filter(|text| !text.contains('\0'))
                .ok_or_else(malformed)?;
            *bytes = bytes
                .checked_add(text.len())
                .and_then(|n| n.checked_add(1))
                .filter(|n| *n <= MAX_BYTES)
                .ok_or_else(malformed)?;
            Ok(text.into())
        })
        .collect()
}

/// Both inputs are config objects (`image["Config"]`, not the full inspection).
/// The caller must pin image identity and retain its Engine lease. Override fields
/// are not concatenated with image defaults; explicit empty lists remain empty.
pub(super) fn resolve(image: &Value, create: &Value) -> Result<Resolved, CandidateError> {
    if !image.is_object() || !create.is_object() {
        return Err(malformed());
    }
    let override_entry = selected(create, "Entrypoint");
    let entry = override_entry.or_else(|| selected(image, "Entrypoint"));
    let cmd = selected(create, "Cmd").or_else(|| {
        if override_entry.is_none() {
            selected(image, "Cmd")
        } else {
            None
        }
    });
    let (mut count, mut bytes) = (0, 0);
    Ok(Resolved {
        entrypoint: argv(entry, &mut count, &mut bytes)?,
        cmd: argv(cmd, &mut count, &mut bytes)?,
    })
}

/// Materialize exactly the selected process for a private environment/dependency
/// wrapper. All validation precedes mutation. Relative executable names remain
/// unsupported here; private launch must never add ambient PATH resolution.
/// An empty entrypoint is preserved by `resolve` but refused by this adapter,
/// even when Cmd alone names an absolute executable (a separate argv-only gate).
pub(super) fn apply_private(create: &mut Value, image: &Value) -> Result<(), CandidateError> {
    let process = resolve(image, create)?;
    if !process
        .entrypoint
        .first()
        .is_some_and(|name| name.starts_with('/') && name != "/")
    {
        return Err(error(
            "environment_entrypoint",
            "Private delivery requires a pinned absolute entrypoint; values omitted.",
        ));
    }
    create["Entrypoint"] = json!(process.entrypoint);
    create["Cmd"] = json!(process.cmd);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherits_image_entrypoint_but_keeps_actual_compose_command() {
        let image = json!({"Entrypoint":["/usr/local/bin/docker-entrypoint.sh"],"Cmd":["node"]});
        let command = json!([
            "bun", "run", "dev", "--", "--port", "6980", "--host", "0.0.0.0"
        ]);
        let mut create = json!({"Cmd":command,"Env":["PUBLIC=literal"],"User":"0:0"});
        apply_private(&mut create, &image).unwrap();
        assert_eq!(create["Entrypoint"], image["Entrypoint"]);
        assert_eq!(create["Cmd"], command);
        assert_eq!(create["Env"], json!(["PUBLIC=literal"]));
        assert_eq!(create["User"], "0:0");
    }

    #[test]
    fn null_inherits_and_explicit_empty_suppresses_defaults() {
        let image = json!({"Entrypoint":["/image"],"Cmd":["default", ""]});
        for create in [json!({}), json!({"Entrypoint":null,"Cmd":null})] {
            assert_eq!(
                resolve(&image, &create).unwrap(),
                Resolved {
                    entrypoint: vec!["/image".into()],
                    cmd: vec!["default".into(), "".into()]
                }
            );
        }
        assert_eq!(
            resolve(&image, &json!({"Cmd":[]})).unwrap().cmd,
            Vec::<String>::new()
        );
        for entry in [json!([]), json!(["/override"])] {
            let resolved = resolve(&image, &json!({"Entrypoint":entry})).unwrap();
            assert_eq!(json!(resolved.entrypoint), entry);
            assert!(resolved.cmd.is_empty());
        }
        let value = resolve(&image, &json!({"Entrypoint":[],"Cmd":["/explicit"]})).unwrap();
        assert!(value.entrypoint.is_empty());
        assert_eq!(value.cmd, vec!["/explicit"]);
    }

    #[test]
    fn refuses_path_lookup_or_empty_entry_without_partial_mutation() {
        for image in [
            json!({"Entrypoint":["relative"],"Cmd":[]}),
            json!({"Entrypoint":null,"Cmd":["/absolute"]}),
        ] {
            let mut create = json!({});
            let before = create.clone();
            assert_eq!(
                apply_private(&mut create, &image).unwrap_err().code,
                "environment_entrypoint"
            );
            assert_eq!(create, before);
        }
        let mut create = json!({"Entrypoint":[],"Cmd":["/explicit"]});
        let before = create.clone();
        assert!(apply_private(&mut create, &json!({"Entrypoint":["/image"]})).is_err());
        assert_eq!(create, before);
    }

    #[test]
    fn exact_override_does_not_use_unselected_image_arguments() {
        let value = resolve(
            &json!({"Entrypoint":"unselected", "Cmd":true}),
            &json!({"Entrypoint":["/app","space argument"],"Cmd":["", "a=b"]}),
        )
        .unwrap();
        assert_eq!(value.entrypoint, vec!["/app", "space argument"]);
        assert_eq!(value.cmd, vec!["", "a=b"]);
    }

    #[test]
    fn selected_malformed_nul_and_aggregate_budgets_refuse_value_free() {
        for bad in [
            json!("canary"),
            json!([17]),
            json!(["canary\0"]),
            json!(["x".repeat(MAX_BYTES)]),
            json!(vec![""; MAX_ARGUMENTS + 1]),
        ] {
            let image = json!({"Entrypoint":["/image"],"Cmd":bad});
            let failure = resolve(&image, &json!({})).unwrap_err();
            assert!(!failure.message.contains("canary"));
        }
        let image = json!({"Entrypoint":["/image"],"Cmd":vec!["";MAX_ARGUMENTS]});
        assert!(resolve(&image, &json!({})).is_err());
        assert!(resolve(&Value::Null, &json!({})).is_err());
        assert!(resolve(&json!({}), &Value::Null).is_err());
    }
}
