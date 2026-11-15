//! Context adapters never inspect or forward an unbounded environment.
use hack_desktop_core::{execution::ExecutionContext, terminal::CommandSpec};
#[test]
fn unsupported_keys_paths_backends_and_controls_are_refused() {
    let home = ("HOME".to_owned(), "/work/user".to_owned());
    for extra in [
        ("UNLISTED_VALUE", "fixture"),
        ("HACK_HOME", "relative"),
        ("HACK_RUNTIME_BACKEND", "other"),
        ("XDG_RUNTIME_DIR", "relative"),
        ("PATH", "/bin\n/unwanted"),
    ] {
        assert!(
            ExecutionContext::from_values(&[home.clone(), (extra.0.into(), extra.1.into())])
                .is_err()
        );
    }
}
#[test]
fn absent_home_override_stays_absent_and_context_does_not_rediscover_program() {
    let context = ExecutionContext::from_values(&[
        ("HOME".into(), "/work/user".into()),
        ("PATH".into(), "/one:/two".into()),
    ])
    .unwrap();
    assert_eq!(context.value("HACK_HOME"), None);
    assert!(context.install_refusal().is_none());
    let runner = context.runner("/checked/hack").unwrap();
    // Checked-context runners verify the pinned executable on every use; a
    // missing one is a missing CLI, never a rediscovered one.
    assert!(matches!(
        runner.resolve_program(),
        Err(hack_desktop_core::runner::RunError::NotFound)
    ));
    assert!(runner.effective_env("HACK_HOME").is_none());
    let rebound = ExecutionContext::capture(&runner).unwrap();
    assert_eq!(context, rebound);
    let command = context
        .bind(&CommandSpec {
            program: "/checked/hack".into(),
            args: vec!["global".into(), "trust".into()],
        })
        .unwrap();
    assert_eq!(command.program, "/usr/bin/env");
    assert_eq!(command.args[0], "-i");
    assert!(command.args.contains(&"/checked/hack".into()));
    assert!(!command.args.iter().any(|a| a.starts_with("HACK_HOME=")));
    assert!(
        context
            .bind(&CommandSpec {
                program: "hack".into(),
                args: vec![]
            })
            .is_err()
    );
}
#[test]
fn absolute_xdg_config_home_is_kept_and_relative_is_ignored_like_the_cli() {
    let base = [
        ("HOME".to_owned(), "/work/user".to_owned()),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ];
    let with = |value: &str| {
        let mut values = base.to_vec();
        values.push(("XDG_CONFIG_HOME".into(), value.into()));
        ExecutionContext::from_values(&values).unwrap()
    };
    assert_eq!(
        with("/work/user/cfg").value("XDG_CONFIG_HOME"),
        Some("/work/user/cfg")
    );
    assert_eq!(with("relative/cfg").value("XDG_CONFIG_HOME"), None);
    let runner = with("/work/user/cfg").runner("/checked/hack").unwrap();
    assert_eq!(
        runner.effective_env("XDG_CONFIG_HOME").as_deref(),
        Some(std::ffi::OsStr::new("/work/user/cfg"))
    );
}
#[test]
fn docker_selectors_are_kept_when_supported_and_refused_otherwise() {
    let with = |extra: &[(&str, &str)]| {
        let mut values = vec![
            ("HOME".to_owned(), "/work/user".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ];
        values.extend(
            extra
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        ExecutionContext::from_values(&values)
    };
    let context = with(&[
        ("DOCKER_CONTEXT", "fixture-context"),
        ("DOCKER_CONFIG", "/work/user/docker"),
        ("DOCKER_HOST", "unix:///work/user/docker.sock"),
    ])
    .unwrap();
    assert_eq!(context.value("DOCKER_CONTEXT"), Some("fixture-context"));
    assert_eq!(context.value("DOCKER_CONFIG"), Some("/work/user/docker"));
    assert_eq!(
        context.value("DOCKER_HOST"),
        Some("unix:///work/user/docker.sock")
    );
    let runner = context.runner("/checked/hack").unwrap();
    assert_eq!(
        runner.effective_env("DOCKER_CONTEXT").as_deref(),
        Some(std::ffi::OsStr::new("fixture-context"))
    );
    for bad in [
        ("DOCKER_CONTEXT", "bad context"),
        ("DOCKER_CONFIG", "relative/docker"),
        ("DOCKER_HOST", "unix://relative.sock"),
        ("DOCKER_HOST", "fd://"),
    ] {
        assert!(with(&[bad]).is_err(), "{bad:?}");
    }
}
#[test]
fn native_runtime_selectors_are_kept_when_absolute() {
    let with = |key: &str, value: &str| {
        ExecutionContext::from_values(&[
            ("HOME".to_owned(), "/work/user".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            (key.to_owned(), value.to_owned()),
        ])
    };
    for key in ["HACK_NATIVE_HOME", "HACK_NATIVE_BINARY"] {
        let context = with(key, "/work/user/native").unwrap();
        assert_eq!(context.value(key), Some("/work/user/native"));
        assert!(with(key, "relative/native").is_err(), "{key}");
    }
}
#[test]
fn checked_runner_refuses_a_cli_whose_location_became_writable_after_the_check() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "execution-verified-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let program = dir.join("hack");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let context = ExecutionContext::from_values(&[
        ("HOME".into(), "/work/user".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ])
    .unwrap();
    let runner = context.runner(program.to_str().unwrap()).unwrap();
    assert_eq!(runner.resolve_program().unwrap(), program, "checked");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(matches!(
        runner.resolve_program(),
        Err(hack_desktop_core::runner::RunError::Spawn(_))
    ));
    let _ = std::fs::remove_dir_all(dir);
}
