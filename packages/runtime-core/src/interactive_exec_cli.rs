//! The terminal is inherited unchanged; fd 3 is the private duplex control
//! channel. Its input is length-delimited and its output is value-free JSON.
use hack_runtime_core::{
    Candidate, CandidateError,
    provider::graph::interactive_exec::{self, Options},
};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Write,
    os::fd::{FromRawFd, OwnedFd},
};

fn invalid() -> CandidateError {
    CandidateError::new(
        "interactive_exec_arguments",
        "Use graph exec-interactive --run-id ID --service NAME --expect-owner ID --expect-plan SHA --expect-namespace SHA [--native] [--workdir DIR] [--expect-container ID --expect-generation SHA] -- PROGRAM [ARG...].",
    )
}

pub fn command(candidate: &Candidate, args: &[&str]) -> Result<i32, CandidateError> {
    let mut values = BTreeMap::new();
    let mut native = false;
    let mut index = 0;
    let mut argv = Vec::new();
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--" {
            argv = args[index..].iter().map(|v| (*v).to_owned()).collect();
            break;
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
            "--workdir",
            "--expect-container",
            "--expect-generation",
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
    let options = Options {
        run: get("--run-id")?,
        service: get("--service")?,
        owner: get("--expect-owner")?,
        plan: get("--expect-plan")?,
        namespace: get("--expect-namespace")?,
        native,
        argv: &argv,
        workdir: values.get("--workdir").copied(),
        expected_container: values.get("--expect-container").copied(),
        expected_generation: values.get("--expect-generation").copied(),
    };
    options.validate()?;
    // SAFETY: this dedicated entrypoint owns the explicitly inherited fd 3.
    // Duplicate the report end before the terminal session consumes its leash.
    if unsafe { libc::fcntl(3, libc::F_GETFD) } < 0 {
        return Err(invalid());
    }
    let frontend = File::from(unsafe { OwnedFd::from_raw_fd(3) });
    hack_runtime_core::provider::private_input::validate_duplex(&frontend)?;
    let mut report = frontend.try_clone().map_err(|_| invalid())?;
    let result = interactive_exec::execute(candidate, &options, frontend.into());
    let (code, value) = match result {
        Ok(completion) => (
            completion.exit_code,
            serde_json::json!({"version":1,"outcome":"completed","completion":completion}),
        ),
        Err(error) => (
            1,
            serde_json::json!({"version":1,"outcome":"refused","code":error.code,"session":error.session()}),
        ),
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
    // The report is under 1 KiB and never contains command output or values.
    report.write_all(&bytes).map_err(|_| invalid())?;
    report.write_all(b"\n").map_err(|_| invalid())?;
    Ok(code)
}

pub fn sessions(candidate: &Candidate, run: &str, service: &str) -> Result<(), CandidateError> {
    if run.len() != 32
        || !run
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(invalid());
    }
    #[cfg(target_os = "macos")]
    {
        let records = hack_runtime_core::provider::interactive_session::retained(candidate)?;
        let sessions: Vec<_> = records
            .into_iter()
            .filter(|r| r.binding.run == run && r.binding.service == service)
            .map(|r| r.session)
            .collect();
        println!("{}", serde_json::json!({"version":1,"sessions":sessions}));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (candidate, run, service);
        Err(invalid())
    }
}
