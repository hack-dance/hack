use super::{Candidate, CandidateError, Value};
use std::collections::BTreeMap;
fn invalid() -> CandidateError {
    CandidateError::new(
        "graph_one_off_arguments",
        "Use graph run-selection --run-id ID --service NAME --json, or run-service with exact plan/generation/boot, --environment-stdin, --timeout-seconds 1..300, optional --workdir, and -- [COMMAND...].",
    )
}
struct Options<'a> {
    run: &'a str,
    service: &'a str,
    plan: Option<&'a str>,
    generation: Option<&'a str>,
    boot: Option<&'a str>,
    workdir: Option<&'a str>,
    seconds: u64,
    argv: Vec<String>,
}
fn parse<'a>(action: &str, args: &[&'a str]) -> Result<Options<'a>, CandidateError> {
    let mut values = BTreeMap::new();
    let mut json = false;
    let mut environment = false;
    let mut argv = Vec::new();
    let mut separated = false;
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--" {
            if action != "run-service" {
                return Err(invalid());
            }
            separated = true;
            argv = args[index..].iter().map(|s| s.to_string()).collect();
            break;
        }
        if key == "--json" {
            if json {
                return Err(invalid());
            }
            json = true;
            continue;
        }
        if key == "--environment-stdin" {
            if environment || action != "run-service" {
                return Err(invalid());
            }
            environment = true;
            continue;
        }
        if !["--run-id", "--service"].contains(&key)
            && !(action == "run-service"
                && [
                    "--expect-plan",
                    "--expect-generation",
                    "--expect-boot",
                    "--workdir",
                    "--timeout-seconds",
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
    let hex = |v: &str, n| {
        v.len() == n
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !json
        || !hex(run, 32)
        || service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || argv.len() > 256
        || argv.first().is_some_and(String::is_empty)
        || argv.iter().any(|v| v.contains('\0') || v.len() > 16384)
        || argv.iter().map(String::len).sum::<usize>() > 65536
    {
        return Err(invalid());
    }
    let plan = values.get("--expect-plan").copied();
    let generation = values.get("--expect-generation").copied();
    let boot = values.get("--expect-boot").copied();
    let workdir = values.get("--workdir").copied();
    let seconds = values
        .get("--timeout-seconds")
        .unwrap_or(&"300")
        .parse::<u64>()
        .map_err(|_| invalid())?;
    if !(1..=300).contains(&seconds)
        || workdir.is_some_and(|v| !v.starts_with('/') || v.contains('\0') || v.len() > 4096)
    {
        return Err(invalid());
    }
    if action == "run-service"
        && (!separated
            || !environment
            || !plan.is_some_and(|v| hex(v, 64))
            || !generation.is_some_and(|v| hex(v, 64))
            || !boot.is_some_and(|v| !v.is_empty() && v.len() <= 128 && !v.contains('\0')))
    {
        return Err(invalid());
    }
    Ok(Options {
        run,
        service,
        plan,
        generation,
        boot,
        workdir,
        seconds,
        argv,
    })
}
pub(super) fn command(
    candidate: &Candidate,
    action: &str,
    args: &[&str],
) -> Result<Value, CandidateError> {
    let options = parse(action, args)?;
    #[cfg(target_os = "macos")]
    {
        use hack_runtime_core::provider::graph::foreground::jobs;
        if action == "run-selection" {
            return jobs::selection(candidate, options.run, options.service);
        }
        use std::os::fd::{FromRawFd, OwnedFd};
        if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
            return Err(invalid());
        }
        // SAFETY: validated one-shot command transfers checked stdin ownership to the bounded receiver.
        let managed = hack_runtime_core::provider::managed_environment::receive(
            unsafe { OwnedFd::from_raw_fd(0) },
            options.plan.ok_or_else(invalid)?,
            options.run,
        )?;
        jobs::command(
            candidate,
            jobs::CommandOptions {
                run: options.run,
                service: options.service,
                plan: options.plan.ok_or_else(invalid)?,
                generation: options.generation.ok_or_else(invalid)?,
                boot: options.boot.ok_or_else(invalid)?,
                argv: options.argv,
                workdir: options.workdir.map(str::to_owned),
                timeout_seconds: options.seconds,
            },
            &managed,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            candidate,
            options.run,
            options.service,
            options.plan,
            options.generation,
            options.boot,
            options.workdir,
            options.seconds,
            options.argv,
        );
        Err(invalid())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_exact_selection_before_private_input() {
        let r = "a".repeat(32);
        assert!(
            parse(
                "run-selection",
                &["--run-id", &r, "--service", "db-ops", "--json"]
            )
            .is_ok()
        );
        assert!(
            parse(
                "run-service",
                &["--run-id", &r, "--service", "db-ops", "--json", "--"]
            )
            .is_err()
        );
    }
    #[test]
    fn preserves_default_command_and_refuses_repeated_options() {
        let r = "a".repeat(32);
        let p = "b".repeat(64);
        let mut args = vec![
            "--run-id",
            &r,
            "--service",
            "task",
            "--json",
            "--expect-plan",
            &p,
            "--expect-generation",
            &p,
            "--expect-boot",
            "boot",
            "--environment-stdin",
            "--",
        ];
        assert!(parse("run-service", &args).unwrap().argv.is_empty());
        args.insert(0, "--json");
        assert!(parse("run-service", &args).is_err());
    }
}
