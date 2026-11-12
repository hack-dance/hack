//! A distinct streaming entrypoint never prints a bounded-response footer.
use hack_runtime_core::{
    Candidate, CandidateError,
    provider::graph::{self, LogFollowOptions},
};
use std::collections::BTreeMap;
fn invalid() -> CandidateError {
    CandidateError::new(
        "native_log_arguments",
        "Use graph logs-follow --run-id ID --service NAME --expect-owner ID --expect-plan SHA --expect-namespace SHA [--native] [--tail 0..1000] [--since UNIX_SECONDS] [--timestamps] [--from-start] [--expect-container <64-hex>] [--selection-only].",
    )
}
pub fn command(candidate: &Candidate, args: &[&str]) -> Result<(), CandidateError> {
    let options = parse(args)?;
    if !options.selection_only {
        watch_frontend()?;
    }
    graph::follow_logs(candidate, &options)
}

fn parse<'a>(args: &[&'a str]) -> Result<LogFollowOptions<'a>, CandidateError> {
    let mut values = BTreeMap::new();
    let mut native = false;
    let mut timestamps = false;
    let mut from_start = false;
    let mut selection_only = false;
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--selection-only" && !selection_only {
            selection_only = true;
            continue;
        }
        if key == "--from-start" && !from_start {
            from_start = true;
            continue;
        }
        if key == "--timestamps" && !timestamps {
            timestamps = true;
            continue;
        }
        if key == "--native" && !native {
            native = true;
            continue;
        }
        if ![
            "--run-id",
            "--service",
            "--expect-owner",
            "--expect-plan",
            "--expect-namespace",
            "--tail",
            "--since",
            "--expect-container",
        ]
        .contains(&key)
        {
            return Err(invalid());
        }
        let value = *args.get(index).ok_or_else(invalid)?;
        index += 1;
        if values.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    let get = |key| values.get(key).copied().ok_or_else(invalid);
    if selection_only
        && (timestamps
            || from_start
            || values.contains_key("--tail")
            || values.contains_key("--since"))
    {
        return Err(invalid());
    }
    let options = LogFollowOptions {
        run: get("--run-id")?,
        service: get("--service")?,
        owner: get("--expect-owner")?,
        plan: get("--expect-plan")?,
        namespace: get("--expect-namespace")?,
        native,
        timestamps,
        from_start,
        selection_only,
        expected_container: values.get("--expect-container").copied(),
        tail: values
            .get("--tail")
            .unwrap_or(&"200")
            .parse()
            .map_err(|_| invalid())?,
        since: values
            .get("--since")
            .map(|s| s.parse())
            .transpose()
            .map_err(|_| invalid())?,
    };
    options.validate()?;
    Ok(options)
}

fn watch_frontend() -> Result<(), CandidateError> {
    // This command is a dedicated read-only process. Its frontend holds stdin
    // open as a lifetime pipe; even SIGKILL or an idle/blocked log socket must
    // release the reader. No provider owner or mutation lives in this process.
    std::thread::Builder::new()
        .name("log-lifetime".into())
        .spawn(|| {
            use std::io::Read;
            let mut byte = [0];
            let result = std::io::stdin().read(&mut byte);
            std::process::exit(if matches!(result, Ok(0)) { 0 } else { 1 });
        })
        .map_err(|_| {
            CandidateError::new("native_log_lifetime", "Cannot watch log frontend lifetime.")
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn finite_selection_rejects_stream_options_and_pins_container() {
        let run = "a".repeat(32);
        let digest = "b".repeat(64);
        let args = [
            "--run-id",
            &run,
            "--service",
            "web",
            "--expect-owner",
            &run,
            "--expect-plan",
            &digest,
            "--expect-namespace",
            &digest,
            "--selection-only",
        ];
        assert!(parse(&args).unwrap().selection_only);
        for extra in [
            vec!["--tail", "0"],
            vec!["--since", "1"],
            vec!["--timestamps"],
            vec!["--from-start"],
            vec!["--selection-only"],
        ] {
            assert_eq!(
                parse(&[args.as_slice(), extra.as_slice()].concat())
                    .err()
                    .unwrap()
                    .code,
                "native_log_arguments"
            );
        }
        let pin = [args.as_slice(), &["--expect-container", &digest]].concat();
        assert_eq!(
            parse(&pin).unwrap().expected_container,
            Some(digest.as_str())
        );
        let invalid = [args.as_slice(), &["--expect-container", "invalid"]].concat();
        assert!(parse(&invalid).is_err());
    }

    #[test]
    fn lifetime_child() {
        if std::env::var_os("HACK_TEST_LOG_LIFETIME").is_none() {
            return;
        }
        println!("lifetime-child-entered");
        watch_frontend().unwrap();
        std::thread::sleep(Duration::from_secs(30));
        panic!("idle reader outlived its frontend pipe");
    }

    #[test]
    fn closed_frontend_pipe_ends_idle_reader_process() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "log_follow_cli::tests::lifetime_child",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", std::env::temp_dir())
            .env("XDG_CONFIG_HOME", std::env::temp_dir())
            .env("XDG_STATE_HOME", std::env::temp_dir())
            .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .env("HACK_NO_INTERACTIVE", "1")
            .env("HACK_TEST_LOG_LIFETIME", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        drop(child.stdin.take());
        let until = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= until {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("reader did not exit after frontend death");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert!(output.contains("lifetime-child-entered"));
        assert!(status.success());
    }
}
