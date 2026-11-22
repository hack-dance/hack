//! Docker `.dockerignore` rules, as BuildKit applies them to a build context.
//!
//! This follows moby `patternmatcher/ignorefile.ReadAll` for parsing and
//! `PatternMatcher::MatchesUsingParentResults` (what BuildKit's file sync uses) for
//! matching:
//!
//! - A UTF-8 BOM on the first line is dropped; a line starting with `#` is a comment;
//!   lines are trimmed and empty ones skipped. A leading `!` re-includes.
//! - Patterns are cleaned (`filepath.Clean`) and lose one leading `/`, then match the
//!   whole slash-separated path relative to the context root: `*` and `?` never cross
//!   `/`, `**` spans any number of segments. A pattern without a slash therefore
//!   matches only at the root (unlike gitignore).
//! - A pattern that matches a directory also matches everything beneath it, and the
//!   last matching pattern wins.
//!
//! The digest only needs the safe direction: including a file Docker ignores costs an
//! extra rebuild, excluding a file Docker includes would miss a change. Any syntax this
//! module does not reproduce exactly (character classes, `\` escapes, `^`, control
//! characters, non-ASCII whitespace, invalid UTF-8, over-long lines, a bare `!`) makes
//! the whole file exclude nothing for hashing purposes, so the full context is hashed.

/// `bufio.Scanner`'s default token limit; a longer line fails Docker's parser.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Parsed ignore rules. `fallback` is true when the file used syntax this module does
/// not reproduce; such rules exclude nothing.
#[derive(Debug)]
pub(super) struct Rules {
    patterns: Vec<Pattern>,
    pub(super) fallback: bool,
}

#[derive(Debug)]
struct Pattern {
    /// A `!` pattern: a match re-includes.
    negated: bool,
    text: String,
    kind: Kind,
}

/// The four match strategies of `patternmatcher.Pattern.compile`.
#[derive(Debug)]
enum Kind {
    Exact,
    /// Literal text followed by a final `**`: a plain prefix test.
    Prefix,
    /// A leading `**` followed by literal text: a plain suffix test.
    Suffix,
    Tokens(Vec<Token>),
}

/// One element of the regular expression `compile` builds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Token {
    Literal(char),
    /// `*`: `[^/]*`.
    Star,
    /// `?`: `[^/]`.
    Question,
    /// `**` (and `**/`) before more text: `(.*/)?`.
    AnyDirectories,
    /// A final `**` after a wildcard: `.*`.
    AnyTail,
}

fn go_trim(text: &str) -> &str {
    text.trim_matches(|c| matches!(c, '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' '))
}

/// Go's `filepath.Clean` for slash-separated paths.
fn clean(path: &str) -> String {
    let rooted = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    match (rooted, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_owned(),
        (false, false) => joined,
    }
}

impl Rules {
    pub(super) fn parse(bytes: &[u8]) -> Self {
        match parse_patterns(bytes) {
            Some(patterns) => Self {
                patterns,
                fallback: false,
            },
            None => Self {
                patterns: Vec::new(),
                fallback: true,
            },
        }
    }

    pub(super) fn len(&self) -> usize {
        self.patterns.len()
    }

    /// `MatchesUsingParentResults`: whether `path` is excluded, and the per-pattern
    /// match record its children inherit. `parent` holds one entry per pattern.
    pub(super) fn decide(&self, path: &str, parent: &[bool]) -> (bool, Vec<bool>) {
        let mut excluded = false;
        let mut record = vec![false; self.patterns.len()];
        for (index, pattern) in self.patterns.iter().enumerate() {
            let mut matched = parent.get(index).copied().unwrap_or(false);
            if !matched {
                // An evaluation that cannot change the outcome is skipped, and then
                // not recorded for children, exactly as upstream does.
                if pattern.negated != excluded {
                    continue;
                }
                matched = pattern.matches(path);
            }
            record[index] = matched;
            if matched {
                excluded = !pattern.negated;
            }
        }
        (excluded, record)
    }

    /// Whether any `!` pattern could match a path strictly beneath directory `dir`
    /// on its own. False only when that is impossible, so an excluded directory is
    /// skipped only when nothing under it can be re-included.
    pub(super) fn may_include_below(&self, dir: &str) -> bool {
        let dir: Vec<&str> = dir.split('/').collect();
        self.patterns
            .iter()
            .filter(|pattern| pattern.negated)
            .any(|pattern| {
                if pattern.text.contains("**") {
                    return true;
                }
                let segments: Vec<&str> = pattern.text.split('/').collect();
                segments.len() > dir.len()
                    && segments
                        .iter()
                        .zip(&dir)
                        .all(|(segment, name)| segment_matches(segment, name))
            })
    }
}

fn parse_patterns(bytes: &[u8]) -> Option<Vec<Pattern>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut patterns = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        let mut line = raw.strip_suffix('\r').unwrap_or(raw);
        if index == 0 {
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.len() > MAX_LINE_BYTES {
            return None;
        }
        if line.starts_with('#') {
            continue;
        }
        if line
            .chars()
            .any(|c| (c.is_whitespace() && !c.is_ascii()) || (c.is_control() && c != '\t'))
            && !go_trim(line).is_empty()
        {
            return None;
        }
        let line = go_trim(line);
        if line.is_empty() {
            continue;
        }
        // ignorefile.ReadAll: clean the body, drop one leading slash, keep the `!`.
        let (invert, body) = match line.strip_prefix('!') {
            Some(rest) => (true, go_trim(rest)),
            None => (false, line),
        };
        let mut cleaned = if body.is_empty() {
            String::new()
        } else {
            clean(body)
        };
        if cleaned.len() > 1 && cleaned.starts_with('/') {
            cleaned.remove(0);
        }
        // patternmatcher.New cleans again with the `!` still attached.
        let full = clean(&if invert {
            format!("!{cleaned}")
        } else {
            cleaned
        });
        let (negated, text) = match full.strip_prefix('!') {
            Some("") => return None,
            Some(rest) => (true, rest.to_owned()),
            None => (false, full),
        };
        patterns.push(Pattern::compile(negated, text)?);
    }
    Some(patterns)
}

impl Pattern {
    /// `patternmatcher.Pattern.compile`, or `None` for syntax not reproduced here.
    fn compile(negated: bool, text: String) -> Option<Self> {
        if text.contains(['[', ']', '\\', '^']) {
            return None;
        }
        #[derive(PartialEq)]
        enum Detected {
            Exact,
            Prefix,
            Suffix,
            Tokens,
        }
        let chars: Vec<char> = text.chars().collect();
        let mut tokens = Vec::new();
        let mut detected = Detected::Exact;
        let mut position = 0;
        let mut iteration = 0;
        while position < chars.len() {
            let ch = chars[position];
            position += 1;
            match ch {
                '*' if chars.get(position) == Some(&'*') => {
                    position += 1;
                    if chars.get(position) == Some(&'/') {
                        position += 1;
                    }
                    if position == chars.len() {
                        if detected == Detected::Exact {
                            detected = Detected::Prefix;
                        } else {
                            tokens.push(Token::AnyTail);
                            detected = Detected::Tokens;
                        }
                    } else {
                        tokens.push(Token::AnyDirectories);
                        detected = Detected::Tokens;
                    }
                    if iteration == 0 {
                        detected = Detected::Suffix;
                    }
                }
                '*' => {
                    tokens.push(Token::Star);
                    detected = Detected::Tokens;
                }
                '?' => {
                    tokens.push(Token::Question);
                    detected = Detected::Tokens;
                }
                other => tokens.push(Token::Literal(other)),
            }
            iteration += 1;
        }
        let kind = match detected {
            Detected::Exact => Kind::Exact,
            Detected::Prefix if text.ends_with("**") => Kind::Prefix,
            Detected::Suffix if text.starts_with("**") => Kind::Suffix,
            Detected::Tokens => Kind::Tokens(tokens),
            _ => return None,
        };
        Some(Self {
            negated,
            text,
            kind,
        })
    }

    fn matches(&self, path: &str) -> bool {
        match &self.kind {
            Kind::Exact => path == self.text,
            Kind::Prefix => path.starts_with(&self.text[..self.text.len() - 2]),
            Kind::Suffix => {
                let suffix = &self.text[2..];
                path.ends_with(suffix) || suffix.strip_prefix('/') == Some(path)
            }
            Kind::Tokens(tokens) => run(tokens, path),
        }
    }
}

/// Whether one slash-free pattern segment matches one path segment.
fn segment_matches(segment: &str, name: &str) -> bool {
    let tokens: Vec<Token> = segment
        .chars()
        .map(|c| match c {
            '*' => Token::Star,
            '?' => Token::Question,
            other => Token::Literal(other),
        })
        .collect();
    run(&tokens, name)
}

/// Simulate the anchored expression `tokens` over `path` (an NFA, linear in both).
/// States `0..=n` sit before token `i`; state `n + 1 + i` is inside the `.*` of an
/// `AnyDirectories` token `i`. Go's `.` does not match a newline; `[^/]` does.
fn run(tokens: &[Token], path: &str) -> bool {
    let n = tokens.len();
    let size = 2 * (n + 1);
    let close = |set: &mut Vec<bool>, start: usize| {
        let mut pending = vec![start];
        while let Some(state) = pending.pop() {
            if set[state] {
                continue;
            }
            set[state] = true;
            if state < n {
                match tokens[state] {
                    Token::Star | Token::AnyTail => pending.push(state + 1),
                    Token::AnyDirectories => {
                        pending.push(state + 1);
                        pending.push(n + 1 + state);
                    }
                    Token::Literal(_) | Token::Question => {}
                }
            }
        }
    };
    let mut current = vec![false; size];
    close(&mut current, 0);
    for c in path.chars() {
        let mut next = vec![false; size];
        let mut any = false;
        for state in 0..size {
            if !current[state] {
                continue;
            }
            if state < n {
                let target = match tokens[state] {
                    Token::Literal(literal) if c == literal => Some(state + 1),
                    Token::Question if c != '/' => Some(state + 1),
                    Token::Star if c != '/' => Some(state),
                    Token::AnyTail if c != '\n' => Some(state),
                    _ => None,
                };
                if let Some(target) = target {
                    close(&mut next, target);
                    any = true;
                }
            } else if state > n {
                let token = state - n - 1;
                if c != '\n' {
                    close(&mut next, state);
                    any = true;
                }
                if c == '/' {
                    close(&mut next, token + 1);
                    any = true;
                }
            }
        }
        if !any {
            return false;
        }
        current = next;
    }
    current[n]
}
