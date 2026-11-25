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

//!
//! ## Bounds
//!
//! An ignore file can come from a writable shared source, so the matching work it can
//! cause is bounded before and during the walk (Docker sets no limits; these are far
//! above what real projects use, typically a few dozen rules). Over a bound the build
//! refuses `native_build_ignore_bounds`:
//!
//! - at most [`MAX_RULES`] effective rules and [`MAX_PATTERN_TEXT`] bytes of pattern
//!   text after parsing, checked while parsing, so an oversized file costs no more than
//!   reading it. Every rule counts, including ones Hack cannot compile and ones after
//!   such a rule (BuildKit still matches them all), so the fallback never lifts a bound;
//! - per pattern at most [`MAX_PATTERN_BYTES`] bytes, [`MAX_SEGMENTS`] path segments
//!   and [`MAX_WILDCARDS`] wildcards (counted as `*`, `?` and `[` characters, so `**`
//!   counts twice; compiled patterns are also checked by token), which bounds the matcher's
//!   active states and so the cost of one evaluation per path character;
//! - a walk-wide work budget of [`WORK_BUDGET`] units: one per rule consulted for an
//!   entry (parent-directory results included) plus one per matcher step (active
//!   states times path characters, or the compared length for literal patterns).
//!
//! Patterns are compiled once; matching reuses one scratch buffer, so it allocates
//! nothing per rule per entry beyond the per-entry record children inherit.

/// `bufio.Scanner`'s default buffer; a line whose bytes and newline do not fit fails
/// Docker's parser.
const MAX_LINE_BYTES: usize = 64 * 1024;
/// Effective rules (patterns after parsing) a file may hold.
pub(super) const MAX_RULES: usize = 4096;
/// Total pattern text after parsing.
pub(super) const MAX_PATTERN_TEXT: usize = 256 * 1024;
/// One pattern's text.
pub(super) const MAX_PATTERN_BYTES: usize = 1024;
/// Path segments in one pattern.
pub(super) const MAX_SEGMENTS: usize = 64;
/// `*`, `?` and `**` tokens in one pattern.
pub(super) const MAX_WILDCARDS: usize = 32;
/// Matching work units one walk may spend. A 200,000-entry context with 300 ordinary
/// rules spends about 240 million (1,200 per entry), so the bound leaves four times
/// that; an adversarial file at the rule limit is stopped after it, about 35,000
/// entries and a few seconds of CPU in a release build.
pub(super) const WORK_BUDGET: u64 = 1_000_000_000;

#[cfg(test)]
thread_local! {
    /// Line work in the last parse on this thread: one unit per byte plus one per visit.
    pub(super) static PARSE_LINE_WORK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn over_bounds() -> crate::CandidateError {
    crate::CandidateError::new(
        "native_build_ignore_bounds",
        "The build's ignore file has more rules than Hack checks; simplify it.",
    )
}

/// Parsed ignore rules. `fallback` is true when the file used syntax this module does
/// not reproduce; such rules exclude nothing.
#[derive(Debug)]
pub(super) struct Rules {
    patterns: Vec<Pattern>,
    pub(super) fallback: bool,
    /// Work spent so far and the walk's budget (see the module documentation).
    work: std::cell::Cell<u64>,
    budget: u64,
    scratch: std::cell::RefCell<Scratch>,
}

#[derive(Debug)]
struct Pattern {
    /// A `!` pattern: a match re-includes.
    negated: bool,
    text: String,
    kind: Kind,
    /// For a `!` pattern without `**`: its segments, compiled once for
    /// [`Rules::may_include_below`].
    segments: Vec<Vec<Token>>,
}

/// Reused matcher state: sparse state sets marked by generation.
#[derive(Debug, Default)]
struct Scratch {
    current: Vec<usize>,
    next: Vec<usize>,
    pending: Vec<usize>,
    mark: Vec<u32>,
    generation: u32,
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
    /// Parse ignore bytes. Over a bound (see the module documentation) this refuses
    /// `native_build_ignore_bounds`; syntax not reproduced here gives rules that
    /// exclude nothing.
    pub(super) fn parse(bytes: &[u8]) -> Result<Self, crate::CandidateError> {
        let (patterns, fallback) = match parse_patterns(bytes)? {
            Some(patterns) => (patterns, false),
            None => (Vec::new(), true),
        };
        Ok(Self {
            patterns,
            fallback,
            work: std::cell::Cell::new(0),
            budget: WORK_BUDGET,
            scratch: std::cell::RefCell::default(),
        })
    }

    pub(super) fn len(&self) -> usize {
        self.patterns.len()
    }

    /// Work spent so far.
    #[cfg(test)]
    pub(super) fn work(&self) -> u64 {
        self.work.get()
    }

    /// Replace the work budget (tests only).
    #[cfg(test)]
    pub(super) fn with_budget(mut self, budget: u64) -> Self {
        self.budget = budget;
        self
    }

    fn spend(&self, units: u64) -> Result<(), crate::CandidateError> {
        let total = self.work.get().saturating_add(units);
        self.work.set(total);
        if total > self.budget {
            Err(over_bounds())
        } else {
            Ok(())
        }
    }

    /// `MatchesUsingParentResults`: whether `path` is excluded, and the per-pattern
    /// match record its children inherit. `parent` holds one entry per pattern.
    pub(super) fn decide(
        &self,
        path: &str,
        parent: &[bool],
    ) -> Result<(bool, Vec<bool>), crate::CandidateError> {
        self.spend(self.patterns.len() as u64)?;
        let mut scratch = self.scratch.borrow_mut();
        let mut steps = 0_u64;
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
                matched = pattern.matches(path, &mut scratch, &mut steps);
                if steps > 4096 {
                    self.spend(steps)?;
                    steps = 0;
                }
            }
            record[index] = matched;
            if matched {
                excluded = !pattern.negated;
            }
        }
        self.spend(steps)?;
        Ok((excluded, record))
    }

    /// Whether any `!` pattern could match a path strictly beneath directory `dir`
    /// on its own. False only when that is impossible, so an excluded directory is
    /// skipped only when nothing under it can be re-included.
    pub(super) fn may_include_below(&self, dir: &str) -> Result<bool, crate::CandidateError> {
        let depth = dir.split('/').count();
        let mut scratch = self.scratch.borrow_mut();
        let mut steps = 0_u64;
        let mut found = false;
        for pattern in self.patterns.iter().filter(|pattern| pattern.negated) {
            steps += 1;
            if pattern.text.contains("**")
                || (pattern.segments.len() > depth
                    && pattern
                        .segments
                        .iter()
                        .zip(dir.split('/'))
                        .all(|(segment, name)| run(segment, name, &mut scratch, &mut steps)))
            {
                found = true;
                break;
            }
        }
        self.spend(steps)?;
        Ok(found)
    }
}

/// The compiled patterns, `Ok(None)` for syntax not reproduced here, or the bounds
/// refusal as soon as a bound is crossed.
fn parse_patterns(bytes: &[u8]) -> Result<Option<Vec<Pattern>>, crate::CandidateError> {
    #[cfg(test)]
    PARSE_LINE_WORK.set(0);
    // BuildKit matches every rule of the file whether or not Hack can compile it, so
    // the file-wide and per-pattern bounds apply to every line; a line Hack cannot
    // reproduce only selects the fallback (exclude nothing) and counting goes on.
    // Docker's scanner holds a line, its `\r` and its `\n` in one 64 KiB buffer and
    // fails on anything longer, comment or blank, before any trimming. Measured on
    // the file's own bytes so nothing longer reaches the build.
    if bytes.split(|byte| *byte == b'\n').any(|line| {
        #[cfg(test)]
        PARSE_LINE_WORK.with(|work| work.set(work.get() + line.len() + 1));
        line.len() >= MAX_LINE_BYTES
    }) {
        return Err(over_bounds());
    }
    let text = String::from_utf8_lossy(bytes);
    let mut fallback = matches!(text, std::borrow::Cow::Owned(_));
    let mut patterns = Vec::new();
    let mut rules = 0_usize;
    let mut total = 0_usize;
    let mut count = |pattern: &str| -> Result<(), crate::CandidateError> {
        rules += 1;
        total += pattern.len();
        if rules > MAX_RULES
            || total > MAX_PATTERN_TEXT
            || pattern.len() > MAX_PATTERN_BYTES
            || pattern.split('/').count() > MAX_SEGMENTS
            || pattern
                .chars()
                .filter(|c| matches!(c, '*' | '?' | '['))
                .count()
                > MAX_WILDCARDS
        {
            Err(over_bounds())
        } else {
            Ok(())
        }
    };
    for (index, raw) in text.split('\n').enumerate() {
        #[cfg(test)]
        PARSE_LINE_WORK.with(|work| work.set(work.get() + raw.len() + 1));
        let mut line = raw.strip_suffix('\r').unwrap_or(raw);
        if index == 0 {
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.starts_with('#') {
            continue;
        }
        if line
            .chars()
            .any(|c| (c.is_whitespace() && !c.is_ascii()) || (c.is_control() && c != '\t'))
            && !go_trim(line).is_empty()
        {
            // Docker rejects or reads such a line differently; counted as written.
            fallback = true;
            count(go_trim(line))?;
            continue;
        }
        let line = go_trim(line);
        if line.is_empty() {
            continue;
        }
        // ignorefile.ReadAll: trim the body after a `!`, clean it, drop one leading
        // slash, then put the `!` back.
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
        let read_all = if invert {
            format!("!{cleaned}")
        } else {
            cleaned
        };
        // patternmatcher.New: trim the whole pattern again (so `/ foo` becomes `foo`,
        // while `!/ foo` keeps ` foo`), skip an empty one, clean it with any `!` still
        // attached, then split off the `!`.
        let trimmed = go_trim(&read_all);
        if trimmed.is_empty() {
            continue;
        }
        let full = clean(trimmed);
        let (negated, text) = match full.strip_prefix('!') {
            Some("") => {
                fallback = true;
                count("")?;
                continue;
            }
            Some(rest) => (true, rest.to_owned()),
            None => (false, full),
        };
        count(&text)?;
        if fallback {
            continue;
        }
        match Pattern::compile(negated, text)? {
            Some(pattern) => patterns.push(pattern),
            None => fallback = true,
        }
    }
    Ok((!fallback).then_some(patterns))
}

impl Pattern {
    /// `patternmatcher.Pattern.compile`, `None` for syntax not reproduced here, or the
    /// bounds refusal for a pattern over its complexity bounds.
    fn compile(negated: bool, text: String) -> Result<Option<Self>, crate::CandidateError> {
        if text.contains(['[', ']', '\\', '^']) {
            return Ok(None);
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
        if tokens
            .iter()
            .filter(|token| !matches!(token, Token::Literal(_)))
            .count()
            > MAX_WILDCARDS
        {
            return Err(over_bounds());
        }
        let kind = match detected {
            Detected::Exact => Kind::Exact,
            Detected::Prefix if text.ends_with("**") => Kind::Prefix,
            Detected::Suffix if text.starts_with("**") => Kind::Suffix,
            Detected::Tokens => Kind::Tokens(tokens),
            _ => return Ok(None),
        };
        let segments = if negated && !text.contains("**") {
            text.split('/').map(segment_tokens).collect()
        } else {
            Vec::new()
        };
        Ok(Some(Self {
            negated,
            text,
            kind,
            segments,
        }))
    }

    /// Match `path`, adding the work done to `steps`.
    fn matches(&self, path: &str, scratch: &mut Scratch, steps: &mut u64) -> bool {
        let compared = 1 + self.text.len().min(path.len()) as u64 / 32;
        match &self.kind {
            Kind::Exact => {
                *steps += compared;
                path == self.text
            }
            Kind::Prefix => {
                *steps += compared;
                path.starts_with(&self.text[..self.text.len() - 2])
            }
            Kind::Suffix => {
                *steps += compared;
                let suffix = &self.text[2..];
                path.ends_with(suffix) || suffix.strip_prefix('/') == Some(path)
            }
            Kind::Tokens(tokens) => run(tokens, path, scratch, steps),
        }
    }
}

/// One slash-free pattern segment as matcher tokens.
fn segment_tokens(segment: &str) -> Vec<Token> {
    segment
        .chars()
        .map(|c| match c {
            '*' => Token::Star,
            '?' => Token::Question,
            other => Token::Literal(other),
        })
        .collect()
}

/// Simulate the anchored expression `tokens` over `path` (an NFA, linear in both),
/// adding one step per active state per character to `steps`. States `0..=n` sit
/// before token `i`; state `n + 1 + i` is inside the `.*` of an `AnyDirectories` token
/// `i`. Go's `.` does not match a newline; `[^/]` does.
fn run(tokens: &[Token], path: &str, scratch: &mut Scratch, steps: &mut u64) -> bool {
    let n = tokens.len();
    let size = 2 * (n + 1);
    if scratch.mark.len() < size {
        scratch.mark.resize(size, 0);
    }
    let Scratch {
        current,
        next,
        pending,
        mark,
        generation,
    } = scratch;
    let mut advance = |mark: &mut Vec<u32>| {
        if *generation == u32::MAX {
            mark.iter_mut().for_each(|value| *value = 0);
            *generation = 0;
        }
        *generation += 1;
        *generation
    };
    // Add `start` and its empty-transition closure to `set` (marked `stamp`).
    let close = |set: &mut Vec<usize>,
                 pending: &mut Vec<usize>,
                 mark: &mut Vec<u32>,
                 stamp: u32,
                 start: usize| {
        pending.push(start);
        while let Some(state) = pending.pop() {
            if mark[state] == stamp {
                continue;
            }
            mark[state] = stamp;
            set.push(state);
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
    current.clear();
    let mut stamp = advance(mark);
    close(current, pending, mark, stamp, 0);
    for c in path.chars() {
        *steps += current.len() as u64 + 1;
        next.clear();
        stamp = advance(mark);
        for &state in current.iter() {
            if state < n {
                let target = match tokens[state] {
                    Token::Literal(literal) if c == literal => Some(state + 1),
                    Token::Question if c != '/' => Some(state + 1),
                    Token::Star if c != '/' => Some(state),
                    Token::AnyTail if c != '\n' => Some(state),
                    _ => None,
                };
                if let Some(target) = target {
                    close(next, pending, mark, stamp, target);
                }
            } else if state > n {
                let token = state - n - 1;
                if c != '\n' {
                    close(next, pending, mark, stamp, state);
                }
                if c == '/' {
                    close(next, pending, mark, stamp, token + 1);
                }
            }
        }
        if next.is_empty() {
            return false;
        }
        std::mem::swap(current, next);
    }
    mark[n] == stamp
}
