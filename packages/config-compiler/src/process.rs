//! Authored workload process intent only. No signal delivery, init process or restart execution occurs here.
use crate::{Diagnostic, json::child, model::Workload, validate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Unlike a normal command, an explicitly empty exec list clears the image entrypoint.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum Entrypoint {
    Exec {
        exec: Vec<String>,
    },
    Shell {
        #[schemars(length(min = 1))]
        shell: String,
    },
}

/// Portable signal spelling; numeric IDs and backend aliases are intentionally not accepted.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub enum ShutdownSignal {
    #[serde(rename = "SIGHUP")]
    Hup,
    #[serde(rename = "SIGTERM")]
    Term,
    #[serde(rename = "SIGINT")]
    Int,
    #[serde(rename = "SIGQUIT")]
    Quit,
    #[serde(rename = "SIGILL")]
    Ill,
    #[serde(rename = "SIGTRAP")]
    Trap,
    #[serde(rename = "SIGABRT")]
    Abrt,
    #[serde(rename = "SIGBUS")]
    Bus,
    #[serde(rename = "SIGFPE")]
    Fpe,
    #[serde(rename = "SIGKILL")]
    Kill,
    #[serde(rename = "SIGUSR1")]
    Usr1,
    #[serde(rename = "SIGSEGV")]
    Segv,
    #[serde(rename = "SIGUSR2")]
    Usr2,
    #[serde(rename = "SIGPIPE")]
    Pipe,
    #[serde(rename = "SIGALRM")]
    Alrm,
    #[serde(rename = "SIGSTKFLT")]
    Stkflt,
    #[serde(rename = "SIGCHLD")]
    Chld,
    #[serde(rename = "SIGCONT")]
    Cont,
    #[serde(rename = "SIGSTOP")]
    Stop,
    #[serde(rename = "SIGTSTP")]
    Tstp,
    #[serde(rename = "SIGTTIN")]
    Ttin,
    #[serde(rename = "SIGTTOU")]
    Ttou,
    #[serde(rename = "SIGURG")]
    Urg,
    #[serde(rename = "SIGXCPU")]
    Xcpu,
    #[serde(rename = "SIGXFSZ")]
    Xfsz,
    #[serde(rename = "SIGVTALRM")]
    Vtalrm,
    #[serde(rename = "SIGPROF")]
    Prof,
    #[serde(rename = "SIGWINCH")]
    Winch,
    #[serde(rename = "SIGIO")]
    Io,
    #[serde(rename = "SIGPWR")]
    Pwr,
    #[serde(rename = "SIGSYS")]
    Sys,
}

/// Omitted fields preserve image/backend defaults; at least one authored field is required.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[schemars(extend("minProperties" = 1))]
pub struct Shutdown {
    #[serde(
        default,
        deserialize_with = "crate::model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "ShutdownSignal")]
    #[ts(optional, type = "ShutdownSignal")]
    pub signal: Option<ShutdownSignal>,
    #[serde(
        default,
        deserialize_with = "crate::model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", regex(pattern = "^[0-9]*[1-9][0-9]*(?:ms|s|m|h)$"))]
    #[ts(optional, type = "string")]
    pub grace: Option<String>,
}

/// Retry count only applies to failure-triggered restart. Jobs cannot request perpetual restart.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Restart {
    No {},
    Always {},
    UnlessStopped {},
    OnFailure {
        #[serde(
            default,
            deserialize_with = "crate::model::present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "u32", range(min = 1, max = 4294967295_u64))]
        #[ts(optional, type = "number")]
        max_retries: Option<u32>,
    },
}

pub(crate) fn normalize(
    workload: &mut Workload,
    job: bool,
    pointer: &str,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    if let Some(entrypoint) = &workload.entrypoint {
        let valid = match entrypoint {
            Entrypoint::Exec { exec } => {
                exec.first().is_none_or(|first| !first.is_empty())
                    && exec.iter().all(|argument| !argument.contains('\0'))
            }
            Entrypoint::Shell { shell } => !shell.is_empty() && !shell.contains('\0'),
        };
        if !valid {
            return Err(at("invalid_entrypoint", &child(pointer, "entrypoint")));
        }
    }
    if let Some(shutdown) = &mut workload.shutdown {
        if shutdown.signal.is_none() && shutdown.grace.is_none() {
            return Err(at("invalid_shutdown", &child(pointer, "shutdown")));
        }
        if let Some(grace) = &mut shutdown.grace {
            *grace = validate::duration(grace)
                .ok_or_else(|| at("invalid_duration", &format!("{pointer}/shutdown/grace")))?;
        }
    }
    if let Some(restart) = &workload.restart {
        if job
            && matches!(
                restart,
                Restart::Always { .. } | Restart::UnlessStopped { .. }
            )
        {
            return Err(at("invalid_restart", &child(pointer, "restart")));
        }
        if matches!(
            restart,
            Restart::OnFailure {
                max_retries: Some(0)
            }
        ) {
            return Err(at(
                "invalid_restart",
                &format!("{pointer}/restart/max_retries"),
            ));
        }
    }
    Ok(())
}
