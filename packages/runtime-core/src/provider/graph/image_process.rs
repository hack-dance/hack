//! Process defaults from an already verified immutable image, before wrappers.
//! Compose null inherits; explicit entrypoint (including empty) suppresses image
//! CMD. No shell tokenization, PATH lookup or image selection occurs here: a
//! relative executable name stays relative and the wrapper resolves it through
//! the container's own PATH at exec time, as Docker does.
//! See https://docs.docker.com/reference/compose-file/services/#entrypoint.
use super::process_refusals::Refused;
use super::{CandidateError, error};
use crate::error::ProcessField;
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

fn selected_user(image: &Value, create: &Value) -> Result<String, Refused> {
    fn nonempty(value: Option<&Value>) -> Option<&Value> {
        value.filter(|value| !value.is_null() && value.as_str() != Some(""))
    }
    let user = nonempty(create.get("User")).or_else(|| nonempty(image.get("User")));
    let user = match user {
        None => "",
        Some(value) => value.as_str().ok_or_else(|| Refused {
            field: ProcessField::User,
            error: malformed(),
        })?,
    };
    super::launcher::identity(&json!({"User":user})).map_err(|error| Refused {
        field: ProcessField::User,
        error,
    })?;
    Ok(user.into())
}

/// Docker runs a `CMD-SHELL` health check as the image's `SHELL` (default
/// `/bin/sh -c`) followed by the test text. Express exactly that as an exec-form
/// `CMD` test, which a wrapper can then prefix. Other tests are unchanged.
fn exec_form_health(create: &Value, image: &Value) -> Result<Option<Value>, Refused> {
    let refused = || {
        Refused::new(
            ProcessField::Healthcheck,
            "environment_health",
            "Private delivery requires a bounded health check test; values omitted.",
        )
    };
    let Some(test) = create["Healthcheck"]["Test"].as_array() else {
        return Ok(None);
    };
    if test.first().and_then(Value::as_str) != Some("CMD-SHELL") {
        return Ok(None);
    }
    let [_, Value::String(command)] = test.as_slice() else {
        return Err(refused());
    };
    if command.is_empty() || command.contains('\0') || command.len() > MAX_BYTES {
        return Err(refused());
    }
    let shell: Vec<String> = match image.get("Shell") {
        None | Some(Value::Null) => vec!["/bin/sh".into(), "-c".into()],
        Some(Value::Array(values))
            if !values.is_empty()
                && values.len() <= 16
                && values.iter().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|text| !text.is_empty() && !text.contains('\0'))
                }) =>
        {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        }
        Some(_) => return Err(refused()),
    };
    let mut exec = vec![json!("CMD")];
    exec.extend(shell.into_iter().map(Value::String));
    exec.push(json!(command));
    Ok(Some(json!(exec)))
}
/// Materialize exactly the selected process for a private environment/dependency
/// wrapper. All validation precedes mutation.
///
/// Docker runs `Entrypoint ++ Cmd`; with no entrypoint, `Cmd` alone is the
/// process, so it becomes the materialized entrypoint (the same argv). An
/// executable name without `/` (such as `docker-entrypoint.sh`) is kept as is:
/// the wrapper resolves it through the container's PATH at exec time exactly as
/// Docker does, never through a host or wrapper PATH. A `CMD-SHELL` health check
/// becomes the equivalent exec-form test. Only an empty process refuses.
pub(super) fn apply_private(create: &mut Value, image: &Value) -> Result<(), Refused> {
    let process = resolve(image, create).map_err(|error| Refused {
        field: ProcessField::Entrypoint,
        error,
    })?;
    let (entrypoint, cmd) = if process.entrypoint.is_empty() {
        (process.cmd, Vec::new())
    } else {
        (process.entrypoint, process.cmd)
    };
    if !entrypoint.first().is_some_and(|name| executable(name)) {
        return Err(Refused::new(
            ProcessField::Entrypoint,
            "environment_entrypoint",
            "Private delivery requires an entrypoint or command that names an executable; values omitted.",
        ));
    }
    let user = selected_user(image, create)?;
    let health = exec_form_health(create, image)?;
    create["User"] = json!(user);
    create["Entrypoint"] = json!(entrypoint);
    create["Cmd"] = json!(cmd);
    if let Some(test) = health {
        create["Healthcheck"]["Test"] = test;
    }
    Ok(())
}

/// An exec target Docker would accept: absolute, relative to the working
/// directory, or a bare name resolved through the container's PATH.
pub(super) fn executable(name: &str) -> bool {
    !name.is_empty() && name != "/" && !name.contains('\0')
}

/// Files-only private delivery keeps the selected process unchanged and only pins the
/// numeric owner that staged mode-0400 members must match. Validation precedes mutation.
pub(super) fn apply_file_owner(create: &mut Value, image: &Value) -> Result<(), Refused> {
    if !image.is_object() || !create.is_object() {
        return Err(Refused {
            field: ProcessField::User,
            error: malformed(),
        });
    }
    let user = selected_user(image, create)?;
    create["User"] = json!(user);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_owner_pins_numeric_image_user_without_changing_process() {
        let image = json!({"Entrypoint":["entry"],"Cmd":["serve"],"User":"65532"});
        let mut create = json!({"Cmd":["serve","--flag"]});
        apply_file_owner(&mut create, &image).unwrap();
        assert_eq!(create, json!({"Cmd":["serve","--flag"],"User":"65532"}));
        let mut explicit = json!({"User":"1001:1002"});
        apply_file_owner(&mut explicit, &image).unwrap();
        assert_eq!(explicit["User"], "1001:1002");
        let mut root = json!({});
        apply_file_owner(&mut root, &json!({})).unwrap();
        assert_eq!(root["User"], "");
        for user in ["app", "1:staff", "-1"] {
            let mut create = json!({});
            assert!(apply_file_owner(&mut create, &json!({"User":user})).is_err());
            assert!(create.get("User").is_none());
        }
    }

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
    fn private_wrapper_inherits_image_user_without_resolving_its_group() {
        for user in ["1001:1002", "1001", "0:0", ""] {
            let image = json!({"Entrypoint":["/image"],"User":user});
            for mut create in [json!({}), json!({"User":null}), json!({"User":""})] {
                apply_private(&mut create, &image).unwrap();
                assert_eq!(create["User"], user);
            }
        }
        let mut create = json!({"User":"2001:2002"});
        apply_private(
            &mut create,
            &json!({"Entrypoint":["/image"],"User":"unselected-name"}),
        )
        .unwrap();
        assert_eq!(create["User"], "2001:2002");
        for user in [
            json!("named"),
            json!("1001:group"),
            json!(true),
            json!("4294967295"),
        ] {
            let mut create = json!({});
            let before = create.clone();
            assert!(
                apply_private(&mut create, &json!({"Entrypoint":["/image"],"User":user})).is_err()
            );
            assert_eq!(create, before);
        }
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
    fn relative_stock_entrypoints_stay_relative_for_container_path_lookup() {
        // A stock image such as `ENTRYPOINT ["docker-entrypoint.sh"]` keeps its
        // exact argv; the wrapper resolves the name through the container PATH.
        let image = json!({"Entrypoint":["docker-entrypoint.sh"],"Cmd":["mysqld"]});
        let mut create = json!({});
        apply_private(&mut create, &image).unwrap();
        assert_eq!(create["Entrypoint"], json!(["docker-entrypoint.sh"]));
        assert_eq!(create["Cmd"], json!(["mysqld"]));
        let mut relative = json!({"Entrypoint":["./bin/start"],"Cmd":null});
        apply_private(&mut relative, &json!({})).unwrap();
        assert_eq!(relative["Entrypoint"], json!(["./bin/start"]));
    }

    #[test]
    fn command_only_process_is_the_same_argv_as_docker_runs() {
        for (image, create, argv) in [
            (
                json!({"Cmd":["python3","-m","http.server"]}),
                json!({}),
                json!(["python3", "-m", "http.server"]),
            ),
            (
                json!({"Entrypoint":["/image"]}),
                json!({"Entrypoint":[],"Cmd":["/explicit","a"]}),
                json!(["/explicit", "a"]),
            ),
            (
                json!({"Entrypoint":null,"Cmd":["/absolute"]}),
                json!({}),
                json!(["/absolute"]),
            ),
        ] {
            let mut create = create;
            apply_private(&mut create, &image).unwrap();
            assert_eq!(create["Entrypoint"], argv);
            assert_eq!(create["Cmd"], json!([]));
        }
    }

    #[test]
    fn refuses_an_empty_process_without_partial_mutation() {
        for (image, create) in [
            (json!({"Entrypoint":null,"Cmd":null}), json!({})),
            (json!({"Entrypoint":["/image"]}), json!({"Entrypoint":[]})),
            (json!({"Entrypoint":[""],"Cmd":["x"]}), json!({})),
            (json!({"Entrypoint":["/"]}), json!({})),
        ] {
            let mut create = create;
            let before = create.clone();
            let refused = apply_private(&mut create, &image).unwrap_err();
            assert_eq!(refused.error.code, "environment_entrypoint");
            assert_eq!(refused.field, ProcessField::Entrypoint);
            assert_eq!(create, before);
        }
    }

    #[test]
    fn shell_form_health_becomes_the_exec_form_docker_runs() {
        let image = json!({"Entrypoint":["docker-entrypoint.sh"]});
        let mut create = json!({"Healthcheck":{"Test":["CMD-SHELL","mysqladmin ping -h localhost"],"Retries":3}});
        apply_private(&mut create, &image).unwrap();
        assert_eq!(
            create["Healthcheck"],
            json!({"Test":["CMD","/bin/sh","-c","mysqladmin ping -h localhost"],"Retries":3})
        );
        let shell = json!({"Entrypoint":["/e"],"Shell":["/bin/bash","-o","pipefail","-c"]});
        let mut create = json!({"Healthcheck":{"Test":["CMD-SHELL","true"]}});
        apply_private(&mut create, &shell).unwrap();
        assert_eq!(
            create["Healthcheck"]["Test"],
            json!(["CMD", "/bin/bash", "-o", "pipefail", "-c", "true"])
        );
        // Exec-form tests, including relative names, are unchanged.
        let mut create = json!({"Healthcheck":{"Test":["CMD","mysqladmin","ping"]}});
        apply_private(&mut create, &image).unwrap();
        assert_eq!(
            create["Healthcheck"]["Test"],
            json!(["CMD", "mysqladmin", "ping"])
        );
        for test in [
            json!(["CMD-SHELL"]),
            json!(["CMD-SHELL", ""]),
            json!(["CMD-SHELL", "a", "b"]),
        ] {
            let mut create = json!({"Healthcheck":{"Test":test}});
            let before = create.clone();
            let refused = apply_private(&mut create, &image).unwrap_err();
            assert_eq!(refused.field, ProcessField::Healthcheck);
            assert_eq!(create, before);
        }
        let mut create = json!({"Healthcheck":{"Test":["CMD-SHELL","true"]}});
        assert!(apply_private(&mut create, &json!({"Entrypoint":["/e"],"Shell":"sh"})).is_err());
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
