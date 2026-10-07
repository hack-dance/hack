use hack_config_compiler::local::{
    DocumentRole, MAX_REQUEST_BYTES, ResolveResult, local_schema, resolve,
};
use hack_config_compiler::{
    CompileResult, Diagnostic, MAX_INPUT_BYTES, artifacts, compile, protocol,
};
use std::io::{self, Read, Write};
use std::path::Path;

fn emit(value: &impl serde::Serialize) -> Result<(), ()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value).map_err(|_| ())?;
    out.write_all(b"\n").map_err(|_| ())
}
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = match args.as_slice() {
        [flag] if flag == "--protocol" => {
            if emit(&protocol()).is_ok() {
                0
            } else {
                1
            }
        }
        [command, directory] if command == "generate" => generate(Path::new(directory)),
        [command, rest @ ..] if command == "resolve" => {
            let mut profiles = Vec::new();
            for pair in rest.chunks(2) {
                if pair.len() != 2 || pair[0] != "--profile" {
                    return usage();
                }
                profiles.push(pair[1].clone());
            }
            let mut bytes = Vec::new();
            let result = if io::stdin()
                .take((MAX_REQUEST_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .is_err()
            {
                ResolveResult::failure(
                    DocumentRole::Request,
                    Diagnostic::new("input_read_failed", "", 1, 1),
                )
            } else {
                resolve(&bytes, &profiles)
            };
            let failed = matches!(result, ResolveResult::Failure { .. });
            if emit(&result).is_err() || failed {
                1
            } else {
                0
            }
        }
        [command, rest @ ..] if command == "compile" => {
            let mut profiles = Vec::new();
            for pair in rest.chunks(2) {
                if pair.len() != 2 || pair[0] != "--profile" {
                    return usage();
                }
                profiles.push(pair[1].clone());
            }
            let mut bytes = Vec::new();
            let result = if io::stdin()
                .take((MAX_INPUT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .is_err()
            {
                CompileResult::failure(Diagnostic::new("input_read_failed", "", 1, 1))
            } else {
                compile(&bytes, &profiles)
            };
            let failed = matches!(result, CompileResult::Failure { .. });
            if emit(&result).is_err() || failed {
                1
            } else {
                0
            }
        }
        _ => return usage(),
    };
    std::process::ExitCode::from(status)
}
fn usage() -> std::process::ExitCode {
    eprintln!(
        "Usage: hack-config-compiler --protocol | compile [--profile NAME]... | resolve [--profile NAME]... | generate DIR"
    );
    std::process::ExitCode::from(2)
}
fn generate(directory: &Path) -> u8 {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let (schema, dto) = artifacts()?;
        std::fs::create_dir_all(directory)?;
        std::fs::write(directory.join("hack.project.schema.json"), schema)?;
        std::fs::write(directory.join("native-config.ts"), dto)?;
        std::fs::write(directory.join("hack.local.schema.json"), local_schema()?)?;
        Ok(())
    })();
    if result.is_err() {
        eprintln!("Compiler artifact generation failed.");
        1
    } else {
        0
    }
}
