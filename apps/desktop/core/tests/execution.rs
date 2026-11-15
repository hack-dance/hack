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
    assert_eq!(
        runner.resolve_program().unwrap(),
        std::path::Path::new("/checked/hack")
    );
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
