//! Service I/O selects a current owned container then fences the actual operation.
use super::{Candidate, CandidateError, Value, graph};
use std::{collections::BTreeMap, time::Duration};

struct Options<'a> {
    run: &'a str,
    service: &'a str,
    tail: u16,
    timeout: Duration,
    workdir: Option<&'a str>,
    argv: Vec<String>,
    environment: bool,
    expected: Option<(&'a str, &'a str, &'a str)>,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "graph_service_arguments",
        "Use graph logs --run-id ID --service NAME [--tail 1..1000] [--json], or graph exec --run-id ID --service NAME [--workdir /path] [--timeout-seconds 1..120] [--json] -- PROGRAM [ARG...]. Exec is noninteractive with stdin EOF; timeout does not prove command termination. Output is returned only to the caller.",
    )
}

fn parse<'a>(action: &str, args: &[&'a str]) -> Result<Options<'a>, CandidateError> {
    let mut values = BTreeMap::new();
    let mut json = false;
    let mut environment = false;
    let mut index = 0;
    let mut argv = Vec::new();
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--" {
            if action != "exec" || index == args.len() {
                return Err(invalid());
            }
            argv = args[index..].iter().map(|s| (*s).to_owned()).collect();
            break;
        }
        if key == "--environment-stdin" {
            if action != "exec" || environment {
                return Err(invalid());
            }
            environment = true;
            continue;
        }
        if key == "--json" {
            if json {
                return Err(invalid());
            }
            json = true;
            continue;
        }
        if !["--run-id", "--service"].contains(&key)
            && !(action == "logs" && key == "--tail")
            && !(action == "exec"
                && [
                    "--workdir",
                    "--timeout-seconds",
                    "--expect-plan",
                    "--expect-container",
                    "--expect-generation",
                ]
                .contains(&key))
        {
            return Err(invalid());
        }
        let value = *args.get(index).ok_or_else(invalid)?;
        index += 1;
        if values.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    let run = *values.get("--run-id").ok_or_else(invalid)?;
    let service = *values.get("--service").ok_or_else(invalid)?;
    if run.len() != 32
        || !run
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || (action == "exec" && (argv.is_empty() || argv.len() > 256 || argv[0].is_empty()))
        || argv.iter().any(|v| v.contains('\0'))
        || argv.iter().map(String::len).sum::<usize>() > 65536
    {
        return Err(invalid());
    }
    let tail = values
        .get("--tail")
        .unwrap_or(&"200")
        .parse::<u16>()
        .map_err(|_| invalid())?;
    let seconds = values
        .get("--timeout-seconds")
        .unwrap_or(&"30")
        .parse::<u64>()
        .map_err(|_| invalid())?;
    let workdir = values.get("--workdir").copied();
    if !(1..=1000).contains(&tail)
        || !(1..=120).contains(&seconds)
        || workdir.is_some_and(|p| !p.starts_with('/') || p.len() > 4096 || p.contains('\0'))
    {
        return Err(invalid());
    }
    let pins = ["--expect-plan", "--expect-container", "--expect-generation"];
    let expected = if environment {
        let p = pins.map(|key| values.get(key).copied());
        let [Some(plan), Some(container), Some(generation)] = p else {
            return Err(invalid());
        };
        if [plan, container, generation].iter().any(|v| {
            v.len() != 64
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(invalid());
        }
        Some((plan, container, generation))
    } else {
        if pins.iter().any(|key| values.contains_key(key)) {
            return Err(invalid());
        }
        None
    };
    Ok(Options {
        environment,
        expected,
        run,
        service,
        tail,
        timeout: Duration::from_secs(seconds),
        workdir,
        argv,
    })
}

pub(super) fn command(
    candidate: &Candidate,
    action: &str,
    args: &[&str],
) -> Result<Value, CandidateError> {
    let options = parse(action, args)?;
    let managed = if options.environment {
        use std::os::fd::{FromRawFd, OwnedFd};
        if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
            return Err(invalid());
        }
        // SAFETY: explicit one-shot input transfers checked stdin ownership; the
        // receiver validates descriptor type, bounded length and EOF.
        Some(hack_runtime_core::provider::managed_environment::receive(
            unsafe { OwnedFd::from_raw_fd(0) },
            options.expected.ok_or_else(invalid)?.0,
            options.run,
        )?)
    } else {
        None
    };
    let selection = graph::service_selection(candidate, options.run, options.service)?;
    if action == "exec-selection" {
        return serde_json::to_value(selection).map_err(|_| invalid());
    }
    if let Some((plan, container, generation)) = options.expected {
        if selection.plan != plan
            || selection.container != container
            || selection.generation != generation
        {
            return Err(CandidateError::new(
                "graph_service_exec",
                "Fresh exec selection changed; no command was started.",
            ));
        }
    }
    if action == "logs" {
        return serde_json::to_value(graph::service_logs(
            candidate,
            &graph::ServiceLogOptions {
                run: options.run,
                service: options.service,
                expected_container: &selection.container,
                expected_boot: &selection.boot,
                expected_generation: &selection.generation,
                tail: options.tail,
            },
        )?)
        .map_err(|_| invalid());
    }
    let exec_options = graph::ServiceExecOptions {
        run: options.run,
        service: options.service,
        expected_container: &selection.container,
        expected_boot: &selection.boot,
        expected_generation: &selection.generation,
        argv: &options.argv,
        workdir: options.workdir,
        timeout: options.timeout,
    };
    let result = if let Some(managed) = managed.as_ref() {
        graph::service_exec_with_environment(candidate, exec_options, managed)?
    } else {
        graph::service_exec(candidate, exec_options)?
    };
    serde_json::to_value(result).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    const RUN: &str = "11111111111111111111111111111111";
    #[test]
    fn fresh_exec_requires_all_exact_pins_before_private_input() {
        let hash = "a".repeat(64);
        let args = [
            "--run-id",
            RUN,
            "--service",
            "web",
            "--environment-stdin",
            "--expect-plan",
            &hash,
            "--expect-container",
            &hash,
            "--expect-generation",
            &hash,
            "--",
            "/bin/true",
        ];
        assert!(parse("exec", &args).unwrap().environment);
        for index in [4, 5, 7, 9] {
            let mut bad = args.to_vec();
            if index == 4 {
                bad.remove(index);
            } else {
                bad.drain(index..index + 2);
            }
            assert!(parse("exec", &bad).is_err());
        }
        assert!(
            parse(
                "exec-selection",
                &["--run-id", RUN, "--service", "web", "--environment-stdin"]
            )
            .is_err()
        );
        assert!(
            parse(
                "exec-selection",
                &["--run-id", RUN, "--service", "web", "--json"]
            )
            .is_ok()
        );
    }
    #[test]
    fn exec_preserves_literal_arguments_and_separator() {
        let parsed = parse(
            "exec",
            &[
                "--run-id",
                RUN,
                "--service",
                "web",
                "--",
                "printf",
                "%s",
                "a b",
                "$(unsafe)",
                "--json",
            ],
        )
        .unwrap();
        assert_eq!(parsed.argv, ["printf", "%s", "a b", "$(unsafe)", "--json"]);
        assert_eq!(parsed.timeout, Duration::from_secs(30));
    }
    #[test]
    fn invalid_commands_refuse_before_selecting_runtime() {
        for suffix in [
            vec![],
            vec!["--"],
            vec!["--", ""],
            vec!["--tail", "1", "--", "echo"],
            vec!["--timeout-seconds", "121", "--", "echo"],
            vec!["--workdir", "relative", "--", "echo"],
            vec!["--json", "--json", "--", "echo"],
        ] {
            let mut args = vec!["--run-id", RUN, "--service", "web"];
            args.extend(suffix);
            assert!(parse("exec", &args).is_err());
        }
        assert!(
            parse(
                "exec",
                &["--run-id", RUN, "--service", "web", "--", "echo", "\0"]
            )
            .is_err()
        );
    }
    #[test]
    fn logs_require_bounded_tail_and_exact_flags() {
        for name in ["api.worker".to_owned(), "a".repeat(128)] {
            assert!(parse("logs", &["--run-id", RUN, "--service", &name]).is_ok());
            assert!(parse("exec", &["--run-id", RUN, "--service", &name, "--", "true"]).is_ok());
        }
        assert!(parse("logs", &["--run-id", RUN, "--service", &"a".repeat(129)]).is_err());
        let base = ["--run-id", RUN, "--service", "web"];
        assert_eq!(parse("logs", &base).unwrap().tail, 200);
        for suffix in [
            ["--tail", "0"],
            ["--tail", "1001"],
            ["--follow", "true"],
            ["--service", "other"],
        ] {
            let mut args = base.to_vec();
            args.extend(suffix);
            assert!(parse("logs", &args).is_err());
        }
    }
}
