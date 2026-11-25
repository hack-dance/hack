//! The non-sensitive project and global settings supported by the desktop form.

use crate::{doctor::shell_quote, runner::CliRunner};
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Options(&'static [&'static str]),
    Overlay,
    Address,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: Kind,
}

const SESSION_MUX: Field = Field {
    key: "sessions.mux",
    label: "Session multiplexer",
    kind: Kind::Options(&["auto", "tmux", "none"]),
};

pub const PROJECT: &[Field] = &[
    Field {
        key: "env.defaultOverlay",
        label: "Default env overlay",
        kind: Kind::Overlay,
    },
    Field {
        key: "worktree.auto_branch",
        label: "Automatic worktree branch",
        kind: Kind::Options(&["true", "false"]),
    },
    Field {
        key: "logs.follow_backend",
        label: "Log source",
        kind: Kind::Options(&["compose", "loki"]),
    },
    Field {
        key: "open.prefer",
        label: "Preferred project address",
        kind: Kind::Options(&["auto", "alias", "dev"]),
    },
    SESSION_MUX,
];

pub const GLOBAL: &[Field] = &[
    SESSION_MUX,
    Field {
        key: "logging.enabled",
        label: "Global logging",
        kind: Kind::Options(&["true", "false"]),
    },
    Field {
        key: "proxy.bind_address",
        label: "Proxy bind address",
        kind: Kind::Address,
    },
];

impl Field {
    pub fn parse(self, input: &str) -> Result<&str, &'static str> {
        let value = input.trim();
        match self.kind {
            Kind::Options(options) if options.contains(&value) => Ok(value),
            Kind::Options(_) => Err("Choose a listed value."),
            Kind::Overlay
                if value.bytes().any(|b| b.is_ascii_alphanumeric())
                    && !value.starts_with('-')
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) =>
            {
                Ok(value)
            }
            Kind::Overlay => Err("Enter an overlay name."),
            Kind::Address if value.parse::<IpAddr>().is_ok() => Ok(value),
            Kind::Address => Err("Enter an IPv4 or IPv6 address."),
        }
    }

    fn argv_value(self, input: &str) -> Result<String, &'static str> {
        let value = self.parse(input)?;
        if matches!(value, "true" | "false") && self.kind != Kind::Overlay {
            return Ok(value.to_owned());
        }
        // A name such as "true" or "0" must be stored as a string.
        Ok(serde_json::Value::String(value.into()).to_string())
    }
}

#[derive(Clone, Debug)]
pub struct Report {
    pub executable: PathBuf,
    pub root: Option<PathBuf>,
    pub current: Option<String>,
    pub names: Vec<String>,
}

impl Report {
    pub fn command(&self, field: Field, input: &str) -> Result<String, &'static str> {
        let arg = field.argv_value(input)?;
        let words = command_args(self.root.as_deref(), field, Some(&arg))?;
        let executable = self.executable.to_str().ok_or("CLI path unavailable")?;
        Ok(std::iter::once(executable)
            .chain(words)
            .map(shell_quote)
            .collect::<Vec<_>>()
            .join(" "))
    }
}

fn command_args<'a>(
    root: Option<&'a Path>,
    field: Field,
    value: Option<&'a str>,
) -> Result<Vec<&'a str>, &'static str> {
    let mut args = vec!["config", if value.is_some() { "set" } else { "get" }];
    if root.is_none() {
        args.push("--global");
    }
    args.push(field.key);
    args.extend(value);
    if let Some(root) = root {
        args.extend(["--path", root.to_str().ok_or("Checkout path unavailable")?]);
    }
    Ok(args)
}

pub(crate) fn read(
    runner: &CliRunner,
    root: Option<PathBuf>,
    field: Field,
) -> Result<Report, &'static str> {
    let executable = runner
        .resolve_program()
        .map_err(|_| "Hack CLI unavailable")?;
    let (out, err, code) = runner
        .run_raw(
            &command_args(root.as_deref(), field, None)?,
            root.as_deref(),
            Duration::from_secs(10),
        )
        .map_err(|_| "Could not read this setting")?;
    let current = match code {
        Some(0) => Some(out.trim().to_owned()),
        Some(1) if err.contains("Key not found:") || err.contains("Missing global config at") => {
            None
        }
        _ => return Err("Could not read this setting"),
    };
    Ok(Report {
        executable,
        root,
        current,
        names: vec![],
    })
}

pub(crate) fn write(
    runner: &CliRunner,
    report: &Report,
    field: Field,
    input: &str,
) -> Result<Report, &'static str> {
    let raw = field.argv_value(input)?;
    let (_, _, code) = runner
        .run_raw(
            &command_args(report.root.as_deref(), field, Some(&raw))?,
            report.root.as_deref(),
            Duration::from_secs(20),
        )
        .map_err(|_| "Could not save this setting")?;
    if code != Some(0) {
        return Err("Hack refused the update. Run the shown command in a terminal for detail.");
    }
    let mut new = read(runner, report.root.clone(), field)
        .map_err(|_| "Saved, but could not confirm the current value")?;
    let expected = field.parse(input)?;
    let matches_input = new
        .current
        .as_deref()
        .is_some_and(|current| match field.kind {
            Kind::Address => current.eq_ignore_ascii_case(expected),
            _ => current == expected,
        });
    if !matches_input {
        return Err("Current value differs from the saved input");
    }
    new.names.clone_from(&report.names);
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_uses_the_selected_scope_and_reads_back_the_result() {
        let dir = std::env::temp_dir().join(format!("desktop-config-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let bin = dir.join("hack");
        crate::test_support::script(
            &bin,
            r#"#!/bin/sh
[ "$1" = config ] && [ "$3" = --global ] && [ "$4" = logging.enabled ] || exit 3
case "$2" in
  get) [ "$#" = 4 ] || exit 4
       if [ -f setting ]; then cat setting; else echo 'Key not found: logging.enabled' >&2; exit 1; fi ;;
  set) [ "$#" = 5 ] && [ "$5" = true ] || exit 5
       printf '%s\n' "$5" > setting ;;
  *) exit 6 ;;
esac
"#,
        );
        let runner = CliRunner::new(bin).with_cwd(&dir);
        let field = GLOBAL[1];
        let initial = read(&runner, None, field).unwrap();
        assert_eq!(initial.current, None);
        let result = write(&runner, &initial, field, "true");
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(result.unwrap().current.as_deref(), Some("true"));
    }

    #[test]
    fn retired_mux_can_be_replaced_and_bind_address_readback_is_case_insensitive() {
        let dir =
            std::env::temp_dir().join(format!("desktop-config-repair-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let bin = dir.join("hack");
        crate::test_support::script(
            &bin,
            r#"#!/bin/sh
case "$2:$4:$5" in
  'get:sessions.mux:') if [ -f mux ]; then echo tmux; else echo zellij; fi ;;
  'set:sessions.mux:"tmux"') touch mux ;;
  'get:proxy.bind_address:') if [ -f bind ]; then echo 2001:db8::1; else echo ::1; fi ;;
  'set:proxy.bind_address:"2001:DB8::1"') touch bind ;;
  *) exit 2 ;;
esac
"#,
        );
        let runner = CliRunner::new(bin).with_cwd(&dir);
        for (field, old, input, saved) in [
            (GLOBAL[0], "zellij", "tmux", "tmux"),
            (GLOBAL[2], "::1", "2001:DB8::1", "2001:db8::1"),
        ] {
            let initial = read(&runner, None, field).unwrap();
            assert_eq!(initial.current.as_deref(), Some(old));
            let result = write(&runner, &initial, field, input).unwrap();
            assert_eq!(result.current.as_deref(), Some(saved));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn preview_preserves_scope_and_literal_overlay_names() {
        let mut report = Report {
            executable: "hack-next".into(),
            root: Some("/work/store front".into()),
            current: None,
            names: vec![],
        };
        assert_eq!(
            report.command(PROJECT[0], "true").unwrap(),
            "'hack-next' 'config' 'set' 'env.defaultOverlay' '\"true\"' '--path' '/work/store front'"
        );
        report.root = None;
        assert_eq!(
            report.command(GLOBAL[1], "false").unwrap(),
            "'hack-next' 'config' 'set' '--global' 'logging.enabled' 'false'"
        );
        assert!(GLOBAL[2].parse("local").is_err());
        for invalid in [".", "_", "._-"] {
            assert!(PROJECT[0].parse(invalid).is_err());
        }
    }
}
