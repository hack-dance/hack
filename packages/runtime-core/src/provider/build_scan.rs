//! Pure Dockerfile image-reference scanner for native image builds.
//!
//! A native build pins every image it may pull by digest before BuildKit runs, so it
//! must know those images first. This module reads a Dockerfile, never executes it,
//! and reports the images a build of the selected target can pull: `FROM`,
//! `COPY --from=<image>`, `RUN --mount=...,from=<image>`, and the same forms inside
//! `ONBUILD` triggers of the Dockerfile's own stages. It follows the Dockerfile
//! frontend built into the pinned engine (BuildKit 0.30):
//!
//! - physical lines, comments, parser directives (`escape`), line continuations and
//!   heredoc bodies of `RUN`, `COPY` and `ADD` are read as the frontend reads them;
//! - `FROM` names and `--platform` values expand `$NAME`/`${NAME}` from the global
//!   `ARG`s declared before the first `FROM`, overridden by the build's literal
//!   arguments, plus the frontend's platform arguments for a `linux/arm64` build;
//! - `COPY --from` and `RUN --mount` `from=` values are literal (the frontend refuses
//!   expansion there); a value naming a stage, or a `COPY --from` stage index, is a
//!   stage, `scratch` is empty, and anything else is an image;
//! - only stages reachable from the target contribute images.
//!
//! Whatever the scanner cannot resolve exactly refuses instead of guessing: a frontend
//! selected by `# syntax=` (the frontend itself would be pulled), `${NAME:-...}` and
//! other modifiers, quotes or escapes in references, unknown or uncertain variables,
//! a platform other than `linux/arm64`, an image whose name equals a stage name (a
//! pinned context of that name would replace the stage), duplicate stage names, and
//! unknown instructions or flags. Every image must be a public Docker Hub reference.
//!
//! Messages carry line numbers only; they never echo Dockerfile text or argument
//! values. Not covered here: `ONBUILD` triggers stored in a base image's own
//! configuration, which the build step must inspect on the pinned base images.
use super::image_reference::{ImageReference, NamedReference, normalize};
use crate::CandidateError;
use std::collections::{BTreeMap, BTreeSet};

/// Largest Dockerfile the scanner reads.
pub const MAX_DOCKERFILE_BYTES: usize = 1024 * 1024;
/// Most distinct images one build may pin.
pub const MAX_IMAGE_REFERENCES: usize = 32;
/// Most build stages one Dockerfile may declare.
pub const MAX_STAGES: usize = 256;

/// Platform arguments whose values the scanner knows for a `linux/arm64` build.
const KNOWN_PLATFORM_ARGS: [(&str, &str); 4] = [
    ("BUILDOS", "linux"),
    ("BUILDARCH", "arm64"),
    ("TARGETOS", "linux"),
    ("TARGETARCH", "arm64"),
];
/// Frontend-defined arguments whose exact text the scanner does not assume.
const UNCERTAIN_FRONTEND_ARGS: [&str; 8] = [
    "BUILDPLATFORM",
    "BUILDOSVERSION",
    "BUILDVARIANT",
    "TARGETPLATFORM",
    "TARGETOSVERSION",
    "TARGETVARIANT",
    "TARGETSTAGE",
    "SOURCE_DATE_EPOCH",
];
/// `--platform` spellings that name a frontend platform argument, with its name.
const PLATFORM_VARIABLES: [(&str, &str); 4] = [
    ("$BUILDPLATFORM", "BUILDPLATFORM"),
    ("${BUILDPLATFORM}", "BUILDPLATFORM"),
    ("$TARGETPLATFORM", "TARGETPLATFORM"),
    ("${TARGETPLATFORM}", "TARGETPLATFORM"),
];
const KNOWN_INSTRUCTIONS: [&str; 18] = [
    "add",
    "arg",
    "cmd",
    "copy",
    "entrypoint",
    "env",
    "expose",
    "from",
    "healthcheck",
    "label",
    "maintainer",
    "onbuild",
    "run",
    "shell",
    "stopsignal",
    "user",
    "volume",
    "workdir",
];

/// One scan: the Dockerfile bytes, the build target and the build's literal arguments.
pub struct ScanRequest<'a> {
    pub dockerfile: &'a [u8],
    /// Stage name to build; `None` builds the last stage.
    pub target: Option<&'a str>,
    /// Literal build arguments. Values are used for substitution only and never reported.
    pub args: &'a BTreeMap<String, String>,
}

/// A base image the build may pull.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaseImage {
    /// The familiar name the frontend matches named build contexts against, for
    /// example `node:24` or `library/alpine@sha256:...` as `alpine@sha256:...`.
    pub context_name: String,
    /// The normalized public Docker Hub reference.
    pub reference: NamedReference,
}

impl BaseImage {
    /// The Docker Hub `namespace/repository` path.
    pub fn repository(&self) -> &str {
        &self.reference.path
    }
}

/// One declared build stage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stage {
    pub name: Option<String>,
    /// Whether building the target needs this stage.
    pub reachable: bool,
}

/// The scan result: stages, the selected target and the distinct images in first-use order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DockerfileScan {
    pub stages: Vec<Stage>,
    pub target: usize,
    pub images: Vec<BaseImage>,
}

fn refusal(line: Option<usize>, message: &str) -> CandidateError {
    let message = match line {
        Some(line) => format!("Dockerfile line {line}: {message}"),
        None => format!("Dockerfile: {message}"),
    };
    CandidateError::new("native_build_dockerfile", message)
}

/// Scan a Dockerfile for the images a native build of `request.target` can pull.
pub fn scan(request: &ScanRequest<'_>) -> Result<DockerfileScan, CandidateError> {
    validate_arguments(request.args)?;
    if request.dockerfile.len() > MAX_DOCKERFILE_BYTES {
        return Err(refusal(None, "exceeds the 1 MiB scan limit."));
    }
    let text =
        std::str::from_utf8(request.dockerfile).map_err(|_| refusal(None, "is not UTF-8 text."))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    refuse_frontend_selection(text)?;
    let parsed = parse(text)?;
    resolve(&parsed, request)
}

fn validate_arguments(args: &BTreeMap<String, String>) -> Result<(), CandidateError> {
    for name in args.keys() {
        let reserved = name.starts_with("BUILDKIT_")
            || KNOWN_PLATFORM_ARGS.iter().any(|(known, _)| known == name)
            || UNCERTAIN_FRONTEND_ARGS.contains(&name.as_str());
        if reserved {
            return Err(CandidateError::new(
                "native_build_argument",
                "Build arguments may not set BuildKit frontend or platform arguments.",
            ));
        }
    }
    Ok(())
}

/// Refuse anything the frontend would treat as a request for another frontend:
/// `# syntax=` or `// syntax=` in the leading comment block (after an optional
/// shebang) and a JSON document. Broader than the frontend on purpose.
fn refuse_frontend_selection(text: &str) -> Result<(), CandidateError> {
    if text.trim_start().starts_with('{') {
        return Err(refusal(None, "JSON-form Dockerfiles are not supported."));
    }
    let mut lines = text.split('\n').peekable();
    if lines.peek().is_some_and(|line| line.starts_with("#!")) {
        lines.next();
    }
    for line in lines {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix('#').or_else(|| line.strip_prefix("//")) else {
            break;
        };
        let rest = rest.trim_start();
        let key_end = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        if rest[..key_end].eq_ignore_ascii_case("syntax")
            && rest[key_end..].trim_start().starts_with('=')
        {
            return Err(refusal(
                None,
                "a `# syntax=` frontend directive is not supported for native builds.",
            ));
        }
    }
    Ok(())
}

/// A use of `COPY --from` or `RUN --mount=...,from=` with its literal value.
#[derive(Debug)]
struct Use {
    line: usize,
    value: String,
    /// `COPY --from` accepts a stage index; mount `from=` does not.
    index_allowed: bool,
}

#[derive(Debug)]
struct RawStage {
    line: usize,
    base: String,
    platform: Option<String>,
    name: Option<String>,
    uses: Vec<Use>,
    onbuild: Vec<Use>,
}

#[derive(Debug, Default)]
struct Parsed {
    /// Global `ARG` declarations before the first `FROM`: name and raw default.
    meta_args: Vec<(String, Option<String>)>,
    stages: Vec<RawStage>,
}

/// The `escape` directive from the leading directive block, as the frontend reads it.
fn escape_token(lines: &[&str]) -> Result<char, CandidateError> {
    let mut seen = BTreeSet::new();
    let mut escape = '\\';
    for (index, raw) in lines.iter().enumerate() {
        let line = trim_newline(raw).trim_start();
        let Some(rest) = line.strip_prefix('#') else {
            break;
        };
        let Some((key, value)) = directive(rest.trim_start()) else {
            break;
        };
        let key = key.to_ascii_lowercase();
        if !matches!(key.as_str(), "syntax" | "escape" | "check") {
            break;
        }
        if !seen.insert(key.clone()) {
            return Err(refusal(Some(index + 1), "a parser directive is repeated."));
        }
        if key == "escape" {
            escape = match value {
                "\\" => '\\',
                "`" => '`',
                _ => return Err(refusal(Some(index + 1), "invalid escape directive.")),
            };
        }
    }
    Ok(escape)
}

/// `^([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(.+?)\s*$`
fn directive(text: &str) -> Option<(&str, &str)> {
    let first = text.chars().next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let key_end = text
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(text.len());
    let rest = text[key_end..].trim_start().strip_prefix('=')?;
    let value = rest.trim();
    (!value.is_empty()).then_some((&text[..key_end], value))
}

fn trim_newline(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

/// The frontend's continuation rule: a trailing escape token (optionally followed by
/// spaces or tabs) continues the line unless the token itself is escaped.
fn trim_continuation(line: &str, escape: char) -> (&str, bool) {
    let trimmed = line.trim_end_matches([' ', '\t']);
    if let Some(before) = trimmed.strip_suffix(escape) {
        if before.is_empty() {
            return ("", false);
        }
        if !before.ends_with(escape) {
            return (before, false);
        }
    }
    (line, true)
}

fn is_frontend_whitespace(c: char) -> bool {
    matches!(c, '\t' | '\u{b}' | '\u{c}' | '\r' | ' ')
}

struct Instruction {
    command: String,
    flags: Vec<String>,
    args: String,
}

/// Split `COMMAND [--flags] args` the way the frontend's `splitCommand` does.
fn split_instruction(line: &str, escape: char) -> Instruction {
    let line = line.trim();
    let (command, rest) = match line.find(is_frontend_whitespace) {
        Some(at) => (
            &line[..at],
            line[at..].trim_start_matches(is_frontend_whitespace),
        ),
        None => (line, ""),
    };
    let (args, flags) = if rest.is_empty() {
        (String::new(), Vec::new())
    } else {
        extract_flags(rest, escape)
    };
    Instruction {
        command: command.to_ascii_lowercase(),
        flags,
        args: args.trim().to_string(),
    }
}

/// Port of the frontend's `extractBuilderFlags`: leading `--name[=value]` words with
/// quotes removed and escapes applied; returns the remaining text and the flag words.
fn extract_flags(line: &str, escape: char) -> (String, Vec<String>) {
    #[derive(PartialEq)]
    enum Phase {
        Spaces,
        Word,
        Quote,
    }
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut words = Vec::new();
    let mut phase = Phase::Spaces;
    let mut word = String::new();
    let mut quote = '\0';
    let mut blank_ok = false;
    let mut pos = 0;
    loop {
        let at_end = pos == chars.len();
        if phase == Phase::Spaces {
            if at_end {
                break;
            }
            let ch = chars[pos].1;
            if ch.is_whitespace() {
                pos += 1;
                continue;
            }
            if ch != '-' || pos + 1 == chars.len() || chars[pos + 1].1 != '-' {
                return (line[chars[pos].0..].to_string(), words);
            }
            phase = Phase::Word;
        }
        if at_end {
            if word != "--" && (blank_ok || !word.is_empty()) {
                words.push(word);
            }
            break;
        }
        let mut ch = chars[pos].1;
        if phase == Phase::Word {
            if ch.is_whitespace() {
                phase = Phase::Spaces;
                if word == "--" {
                    return (line[chars[pos].0..].to_string(), words);
                }
                if blank_ok || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                word.clear();
                blank_ok = false;
                pos += 1;
                continue;
            }
            if ch == '\'' || ch == '"' {
                quote = ch;
                blank_ok = true;
                phase = Phase::Quote;
                pos += 1;
                continue;
            }
            if ch == escape {
                if pos + 1 == chars.len() {
                    pos += 1;
                    continue;
                }
                pos += 1;
                ch = chars[pos].1;
            }
            word.push(ch);
            pos += 1;
            continue;
        }
        // Phase::Quote
        if ch == quote {
            phase = Phase::Word;
            pos += 1;
            continue;
        }
        if ch == escape {
            if pos + 1 == chars.len() {
                phase = Phase::Word;
                pos += 1;
                continue;
            }
            pos += 1;
            ch = chars[pos].1;
        }
        word.push(ch);
        pos += 1;
    }
    (String::new(), words)
}

#[derive(Clone, Copy, PartialEq)]
enum FlagKind {
    Value,
    Bool,
    Repeated,
}

/// Parse flag words against an instruction's flag set; returns values by flag name.
/// Unknown, duplicated or malformed flags refuse, as the frontend would fail on them.
fn parse_flags(
    words: &[String],
    allowed: &[(&str, FlagKind)],
    line: usize,
) -> Result<BTreeMap<String, Vec<String>>, CandidateError> {
    let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for word in words {
        let Some(body) = word.strip_prefix("--") else {
            return Err(refusal(Some(line), "unsupported instruction flag."));
        };
        let (name, value) = match body.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (body, None),
        };
        let Some((_, kind)) = allowed.iter().find(|(known, _)| *known == name) else {
            return Err(refusal(Some(line), "unsupported instruction flag."));
        };
        let entry = values.entry(name.to_string()).or_default();
        let malformed = match kind {
            FlagKind::Value => value.is_none() || !entry.is_empty(),
            FlagKind::Bool => {
                !entry.is_empty()
                    || value.is_some_and(|v| !matches!(v, "true" | "false" | "1" | "0"))
            }
            FlagKind::Repeated => value.is_none(),
        };
        if malformed {
            return Err(refusal(
                Some(line),
                "malformed or repeated instruction flag.",
            ));
        }
        entry.push(value.unwrap_or("").to_string());
    }
    Ok(values)
}

const FROM_FLAGS: [(&str, FlagKind); 1] = [("platform", FlagKind::Value)];
const COPY_FLAGS: [(&str, FlagKind); 6] = [
    ("chown", FlagKind::Value),
    ("from", FlagKind::Value),
    ("chmod", FlagKind::Value),
    ("link", FlagKind::Bool),
    ("exclude", FlagKind::Repeated),
    ("parents", FlagKind::Bool),
];
const ADD_FLAGS: [(&str, FlagKind); 7] = [
    ("chown", FlagKind::Value),
    ("chmod", FlagKind::Value),
    ("link", FlagKind::Bool),
    ("keep-git-dir", FlagKind::Bool),
    ("checksum", FlagKind::Value),
    ("unpack", FlagKind::Bool),
    ("exclude", FlagKind::Repeated),
];
const RUN_FLAGS: [(&str, FlagKind); 4] = [
    ("mount", FlagKind::Repeated),
    ("network", FlagKind::Value),
    ("security", FlagKind::Value),
    ("device", FlagKind::Repeated),
];

/// A literal `--from`/`from=` value: anything the frontend would expand or unquote refuses.
fn literal_source(value: &str, escape: char, line: usize) -> Result<String, CandidateError> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| matches!(c, '$' | '\'' | '"' | '\\' | '`') || c == escape || c.is_whitespace())
    {
        return Err(refusal(
            Some(line),
            "a build source must be a literal stage or image name without variables or quotes.",
        ));
    }
    Ok(value.to_string())
}

/// Image and stage uses of one `COPY`/`ADD`/`RUN` instruction.
fn instruction_uses(
    instruction: &Instruction,
    escape: char,
    line: usize,
) -> Result<Vec<Use>, CandidateError> {
    let mut uses = Vec::new();
    match instruction.command.as_str() {
        "copy" => {
            let flags = parse_flags(&instruction.flags, &COPY_FLAGS, line)?;
            if let Some(value) = flags.get("from").and_then(|v| v.first()) {
                uses.push(Use {
                    line,
                    value: literal_source(value, escape, line)?,
                    index_allowed: true,
                });
            }
        }
        "add" => {
            parse_flags(&instruction.flags, &ADD_FLAGS, line)?;
        }
        "run" => {
            let flags = parse_flags(&instruction.flags, &RUN_FLAGS, line)?;
            for mount in flags.get("mount").into_iter().flatten() {
                if mount.contains('"') {
                    return Err(refusal(
                        Some(line),
                        "quoted mount options are not supported.",
                    ));
                }
                for field in mount.split(',') {
                    if let Some((key, value)) = field.split_once('=') {
                        if key.eq_ignore_ascii_case("from") {
                            uses.push(Use {
                                line,
                                value: literal_source(value, escape, line)?,
                                index_allowed: false,
                            });
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(uses)
}

/// Whether the frontend parses these arguments as a JSON string array (exec form).
fn json_form(args: &str, line: usize) -> Result<bool, CandidateError> {
    let args = args.trim_start();
    if !args.starts_with('[') {
        return Ok(false);
    }
    match serde_json::from_str::<Vec<serde_json::Value>>(args) {
        Ok(values) if values.iter().all(serde_json::Value::is_string) => Ok(true),
        Ok(_) => Err(refusal(
            Some(line),
            "a JSON-form argument list must contain strings.",
        )),
        Err(_) => Ok(false),
    }
}

/// Shell words with quotes and escapes kept raw, as the heredoc detector lexes a line.
fn raw_words(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            '\\' => {
                word.push(c);
                word.push(chars.next()?);
                in_word = true;
            }
            '\'' => {
                word.push(c);
                loop {
                    let next = chars.next()?;
                    word.push(next);
                    if next == '\'' {
                        break;
                    }
                }
                in_word = true;
            }
            '"' => {
                word.push(c);
                loop {
                    let next = chars.next()?;
                    word.push(next);
                    if next == '\\' {
                        word.push(chars.next()?);
                    } else if next == '"' {
                        break;
                    }
                }
                in_word = true;
            }
            _ => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

/// A heredoc word, `^(\d*)<<(-?)\s*([^<]*)$`: its terminator and whether tabs are chomped.
fn heredoc(word: &str, line: usize) -> Result<Option<(String, bool)>, CandidateError> {
    let rest = word.trim_start_matches(|c: char| c.is_ascii_digit());
    let Some(rest) = rest.strip_prefix("<<") else {
        return Ok(None);
    };
    let (rest, chomp) = match rest.strip_prefix('-') {
        Some(rest) => (rest, true),
        None => (rest, false),
    };
    let rest = rest.trim_start_matches(['\t', '\n', '\u{c}', '\r', ' ']);
    if rest.is_empty() || rest.contains('<') {
        return Ok(None);
    }
    if rest.contains('\\') {
        return Err(refusal(
            Some(line),
            "escaped heredoc delimiters are not supported.",
        ));
    }
    let mut name = String::new();
    let mut quote = None;
    for c in rest.chars() {
        match (quote, c) {
            (None, '\'' | '"') => quote = Some(c),
            (Some(open), c) if c == open => quote = None,
            (None, c) if c.is_whitespace() => return Ok(None),
            _ => name.push(c),
        }
    }
    if quote.is_some() || name.is_empty() {
        return Err(refusal(Some(line), "unrecognized heredoc delimiter."));
    }
    Ok(Some((name, chomp)))
}

fn heredoc_capable(
    instruction: &Instruction,
    escape: char,
    line: usize,
) -> Result<bool, CandidateError> {
    let inner;
    let instruction = if instruction.command == "onbuild" {
        inner = split_instruction(&instruction.args, escape);
        &inner
    } else {
        instruction
    };
    Ok(
        matches!(instruction.command.as_str(), "run" | "copy" | "add")
            && !json_form(&instruction.args, line)?,
    )
}

fn parse(text: &str) -> Result<Parsed, CandidateError> {
    let lines: Vec<&str> = text.split('\n').collect();
    let escape = escape_token(&lines)?;
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < lines.len() {
        let start = index + 1;
        let first = trim_newline(lines[index]).trim_start();
        index += 1;
        if first.starts_with('#') {
            continue;
        }
        let (first, mut end) = trim_continuation(first, escape);
        if end && first.is_empty() {
            continue;
        }
        let mut logical = first.to_string();
        while !end && index < lines.len() {
            let raw = trim_newline(lines[index]);
            index += 1;
            let trimmed = raw.trim_start();
            if trimmed.starts_with('#') || trimmed.is_empty() {
                continue;
            }
            let (part, done) = trim_continuation(raw, escape);
            logical.push_str(part);
            end = done;
        }
        let instruction = split_instruction(&logical, escape);
        if heredoc_capable(&instruction, escape, start)? && logical.contains("<<") {
            let words =
                raw_words(&logical).ok_or_else(|| refusal(Some(start), "unterminated quote."))?;
            for word in words {
                let Some((terminator, chomp)) = heredoc(&word, start)? else {
                    continue;
                };
                let mut terminated = false;
                while index < lines.len() {
                    let body = trim_newline(lines[index]);
                    index += 1;
                    let body = if chomp {
                        body.trim_start_matches('\t')
                    } else {
                        body
                    };
                    if body == terminator {
                        terminated = true;
                        break;
                    }
                }
                if !terminated {
                    return Err(refusal(Some(start), "unterminated heredoc."));
                }
            }
        }
        dispatch(&mut parsed, instruction, escape, start)?;
    }
    if parsed.stages.is_empty() {
        return Err(refusal(None, "declares no build stage."));
    }
    Ok(parsed)
}

fn dispatch(
    parsed: &mut Parsed,
    instruction: Instruction,
    escape: char,
    line: usize,
) -> Result<(), CandidateError> {
    let command = instruction.command.as_str();
    if !KNOWN_INSTRUCTIONS.contains(&command) {
        return Err(refusal(Some(line), "unknown instruction."));
    }
    if parsed.stages.is_empty() && command != "arg" && command != "from" {
        return Err(refusal(Some(line), "only ARG may precede the first FROM."));
    }
    match command {
        "from" => {
            let flags = parse_flags(&instruction.flags, &FROM_FLAGS, line)?;
            let words: Vec<&str> = instruction
                .args
                .split(is_frontend_whitespace)
                .filter(|w| !w.is_empty())
                .collect();
            let name = match words.as_slice() {
                [_] => None,
                [_, keyword, name] if keyword.eq_ignore_ascii_case("as") => {
                    let name = name.to_ascii_lowercase();
                    let valid = name.starts_with(|c: char| c.is_ascii_lowercase())
                        && name.chars().all(|c| {
                            c.is_ascii_lowercase()
                                || c.is_ascii_digit()
                                || matches!(c, '-' | '_' | '.')
                        });
                    if !valid {
                        return Err(refusal(Some(line), "invalid build stage name."));
                    }
                    Some(name)
                }
                _ => return Err(refusal(Some(line), "FROM must name one image or stage.")),
            };
            if name
                .as_ref()
                .is_some_and(|name| parsed.stages.iter().any(|s| s.name.as_ref() == Some(name)))
            {
                return Err(refusal(Some(line), "duplicate build stage name."));
            }
            if parsed.stages.len() == MAX_STAGES {
                return Err(refusal(Some(line), "declares more than 256 build stages."));
            }
            parsed.stages.push(RawStage {
                line,
                base: words[0].to_string(),
                platform: flags.get("platform").and_then(|v| v.first()).cloned(),
                name,
                uses: Vec::new(),
                onbuild: Vec::new(),
            });
        }
        "arg" => {
            let words = argument_words(&instruction.args, escape);
            if words.is_empty() {
                return Err(refusal(Some(line), "ARG requires a name."));
            }
            for word in words {
                let (name, value) = match word.split_once('=') {
                    Some((name, value)) => (name.to_string(), Some(value.to_string())),
                    None => (word, None),
                };
                if name.is_empty() {
                    return Err(refusal(Some(line), "ARG requires a name."));
                }
                if parsed.stages.is_empty() {
                    parsed.meta_args.push((name, value));
                }
            }
        }
        "onbuild" => {
            if !instruction.flags.is_empty() {
                return Err(refusal(Some(line), "unsupported instruction flag."));
            }
            let inner = split_instruction(&instruction.args, escape);
            if !KNOWN_INSTRUCTIONS.contains(&inner.command.as_str())
                || matches!(inner.command.as_str(), "onbuild" | "from" | "maintainer")
            {
                return Err(refusal(Some(line), "unsupported ONBUILD trigger."));
            }
            let uses = instruction_uses(&inner, escape, line)?;
            if let Some(stage) = parsed.stages.last_mut() {
                stage.onbuild.extend(uses);
            }
        }
        _ => {
            let uses = instruction_uses(&instruction, escape, line)?;
            if let Some(stage) = parsed.stages.last_mut() {
                stage.uses.extend(uses);
            }
        }
    }
    Ok(())
}

/// Port of the frontend's `parseWords`: whitespace-separated words, quotes kept,
/// the escape token keeping the character it escapes.
fn argument_words(text: &str, escape: char) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            None if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            None => {
                started = true;
                if c == '\'' || c == '"' {
                    quote = Some(c);
                    word.push(c);
                } else if c == escape {
                    if let Some(next) = chars.next() {
                        word.push(c);
                        word.push(next);
                    }
                } else {
                    word.push(c);
                }
            }
            Some(open) => {
                if c == open {
                    quote = None;
                    word.push(c);
                } else if c == escape && open != '\'' {
                    if let Some(next) = chars.next() {
                        word.push(c);
                        word.push(next);
                    }
                } else {
                    word.push(c);
                }
            }
        }
    }
    if started {
        words.push(word);
    }
    words
}

/// A global argument value: known text, or present with text the scanner cannot know.
type Env = BTreeMap<String, Option<String>>;

/// Expand `$NAME` and `${NAME}`. Any other `$` form, quote, escape, unknown or
/// uncertain variable yields `None`.
fn expand(word: &str, env: &Env) -> Option<String> {
    let mut out = String::new();
    let mut chars = word.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '$' => {
                let braced = chars.peek() == Some(&'{');
                if braced {
                    chars.next();
                }
                let mut name = String::new();
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_alphanumeric() || next == '_' {
                        name.push(next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if braced && chars.next() != Some('}') {
                    return None;
                }
                if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
                    return None;
                }
                out.push_str(env.get(&name)?.as_deref()?);
            }
            '\'' | '"' | '\\' | '`' => return None,
            _ => out.push(c),
        }
    }
    Some(out)
}

/// The value of a global `ARG` default: quotes removed, `$NAME`/`${NAME}` expanded.
/// Anything else is recorded as uncertain and refuses only when a reference uses it.
fn argument_value(raw: &str, env: &Env) -> Option<String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(c) = rest.chars().next() {
        match c {
            '\'' => {
                let body = &rest[1..];
                let end = body.find('\'')?;
                out.push_str(&body[..end]);
                rest = &body[end + 1..];
            }
            '"' => {
                let body = &rest[1..];
                let end = body.find('"')?;
                out.push_str(&expand(&body[..end], env)?);
                rest = &body[end + 1..];
            }
            _ => {
                let end = rest.find(['\'', '"']).unwrap_or(rest.len());
                out.push_str(&expand(&rest[..end], env)?);
                rest = &rest[end..];
            }
        }
    }
    Some(out)
}

fn global_env(parsed: &Parsed, args: &BTreeMap<String, String>) -> Env {
    let mut env: Env = KNOWN_PLATFORM_ARGS
        .iter()
        .map(|(name, value)| ((*name).to_string(), Some((*value).to_string())))
        .collect();
    for name in UNCERTAIN_FRONTEND_ARGS {
        env.insert(name.to_string(), None);
    }
    for (name, default) in &parsed.meta_args {
        if let Some(value) = args.get(name) {
            env.insert(name.clone(), Some(value.clone()));
        } else if let Some(default) = default {
            let value = argument_value(default, &env);
            env.insert(name.clone(), value);
        }
    }
    // The frontend rewrites this one from the resolved build epoch.
    env.insert("SOURCE_DATE_EPOCH".into(), None);
    env
}

#[derive(Clone, Debug)]
enum Source {
    Scratch,
    Stage(usize),
    Image(String),
}

/// Whether a reachable stage's `--platform` selects `linux/arm64`.
///
/// `$BUILDPLATFORM` and `$TARGETPLATFORM` select it only while they keep the
/// frontend's value. A global `ARG` default replaces that value (the frontend
/// expands `--platform` against the global arguments), so an overridden one must
/// itself expand to `linux/arm64`. A bare global `ARG` keeps the frontend's value.
fn platform_supported(raw: &str, env: &Env, parsed: &Parsed) -> bool {
    let frontend_value = PLATFORM_VARIABLES
        .iter()
        .find(|(spelling, _)| *spelling == raw)
        .is_some_and(|(_, name)| {
            !parsed
                .meta_args
                .iter()
                .any(|(declared, default)| declared == name && default.is_some())
        });
    frontend_value
        || expand(raw, env)
            .is_some_and(|value| matches!(value.as_str(), "linux/arm64" | "linux/arm64/v8"))
}

fn stage_by_name(parsed: &Parsed, name: &str) -> Option<usize> {
    let name = name.to_ascii_lowercase();
    parsed
        .stages
        .iter()
        .position(|stage| stage.name.as_deref() == Some(name.as_str()))
}

fn use_source(parsed: &Parsed, source: &Use) -> Result<Source, CandidateError> {
    let value = source.value.as_str();
    if source.index_allowed && value.bytes().all(|b| b.is_ascii_digit()) {
        return value
            .parse::<usize>()
            .ok()
            .filter(|index| *index < parsed.stages.len())
            .map(Source::Stage)
            .ok_or_else(|| refusal(Some(source.line), "invalid build stage index."));
    }
    if source.index_allowed && value.starts_with(['+', '-']) {
        return Err(refusal(Some(source.line), "invalid build stage index."));
    }
    if let Some(index) = stage_by_name(parsed, value) {
        return Ok(Source::Stage(index));
    }
    if value == "scratch" {
        return Ok(Source::Scratch);
    }
    Ok(Source::Image(value.to_string()))
}

fn base_image(name: &str, line: usize) -> Result<BaseImage, CandidateError> {
    match normalize(name) {
        Ok(ImageReference::Named(reference)) if reference.docker_hub_repository().is_some() => {
            let path = reference
                .path
                .strip_prefix("library/")
                .unwrap_or(&reference.path);
            let mut familiar = path.to_string();
            if let Some(tag) = &reference.tag {
                familiar.push(':');
                familiar.push_str(tag);
            }
            if let Some(digest) = &reference.digest {
                familiar.push('@');
                familiar.push_str(digest);
            }
            let context_name = familiar
                .strip_suffix(":latest")
                .map_or(familiar.clone(), str::to_string);
            Ok(BaseImage {
                context_name,
                reference,
            })
        }
        _ => Err(CandidateError::new(
            "native_build_base_image",
            format!(
                "Dockerfile line {line}: build images must be public Docker Hub [namespace/]repository[:tag][@sha256] references."
            ),
        )),
    }
}

fn resolve(parsed: &Parsed, request: &ScanRequest<'_>) -> Result<DockerfileScan, CandidateError> {
    let env = global_env(parsed, request.args);
    // Each stage's base as the frontend registers it: an earlier stage of that name,
    // `scratch`, or an image. `None` marks a name the scanner cannot expand.
    let mut bases: Vec<Option<Source>> = Vec::with_capacity(parsed.stages.len());
    for (index, stage) in parsed.stages.iter().enumerate() {
        let base = expand(&stage.base, &env)
            .filter(|name| !name.is_empty())
            .map(|name| {
                if name == "scratch" {
                    Source::Scratch
                } else if let Some(earlier) = parsed.stages[..index]
                    .iter()
                    .position(|s| s.name.as_deref() == Some(name.as_str()))
                {
                    Source::Stage(earlier)
                } else {
                    Source::Image(name)
                }
            });
        bases.push(base);
    }
    let target = match request.target {
        Some(target) => stage_by_name(parsed, target)
            .ok_or_else(|| refusal(None, "the build target stage is not declared."))?,
        None => parsed.stages.len() - 1,
    };

    let mut reachable = vec![false; parsed.stages.len()];
    let mut pending = vec![target];
    let mut images: Vec<(String, usize)> = Vec::new();
    while let Some(index) = pending.pop() {
        if std::mem::replace(&mut reachable[index], true) {
            continue;
        }
        let stage = &parsed.stages[index];
        if let Some(platform) = &stage.platform {
            if !platform_supported(platform, &env, parsed) {
                return Err(refusal(
                    Some(stage.line),
                    "native builds support only the linux/arm64 platform.",
                ));
            }
        }
        let mut sources = Vec::new();
        match &bases[index] {
            Some(base) => sources.push((base.clone(), stage.line)),
            None => {
                return Err(refusal(
                    Some(stage.line),
                    "the FROM name uses a variable the scanner cannot resolve.",
                ));
            }
        }
        for used in &stage.uses {
            sources.push((use_source(parsed, used)?, used.line));
        }
        // ONBUILD triggers of every ancestor stage run in this stage (a superset of the
        // frontend's inheritance, so no trigger image is missed).
        let mut ancestor = &bases[index];
        while let Some(Source::Stage(parent)) = ancestor {
            for used in &parsed.stages[*parent].onbuild {
                sources.push((use_source(parsed, used)?, used.line));
            }
            ancestor = &bases[*parent];
        }
        for (source, line) in sources {
            match source {
                Source::Scratch => {}
                Source::Stage(next) => pending.push(next),
                Source::Image(name) => images.push((name, line)),
            }
        }
    }

    let mut admitted: Vec<BaseImage> = Vec::new();
    let mut lines: Vec<(usize, BaseImage)> = Vec::new();
    for (name, line) in images {
        lines.push((line, base_image(&name, line)?));
    }
    lines.sort_by_key(|(line, _)| *line);
    for (line, image) in lines {
        if parsed
            .stages
            .iter()
            .any(|stage| stage.name.as_deref() == Some(image.context_name.as_str()))
        {
            return Err(refusal(
                Some(line),
                "an image name equals a build stage name; rename the stage.",
            ));
        }
        if !admitted
            .iter()
            .any(|known| known.reference == image.reference)
        {
            if admitted.len() == MAX_IMAGE_REFERENCES {
                return Err(refusal(None, "uses more than 32 distinct images."));
            }
            admitted.push(image);
        }
    }
    Ok(DockerfileScan {
        stages: parsed
            .stages
            .iter()
            .zip(reachable)
            .map(|(stage, reachable)| Stage {
                name: stage.name.clone(),
                reachable,
            })
            .collect(),
        target,
        images: admitted,
    })
}

#[cfg(test)]
mod tests;
