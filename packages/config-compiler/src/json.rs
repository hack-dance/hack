use crate::Diagnostic;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 64;

pub struct Document {
    pub value: Value,
    pub positions: BTreeMap<String, (usize, usize)>,
}
struct Parser<'a> {
    text: &'a str,
    offset: usize,
    line: usize,
    column: usize,
    positions: BTreeMap<String, (usize, usize)>,
}

pub fn parse(bytes: &[u8]) -> Result<Document, Diagnostic> {
    parse_with_limit(bytes, MAX_INPUT_BYTES)
}

pub(crate) fn parse_with_limit(bytes: &[u8], limit: usize) -> Result<Document, Diagnostic> {
    if bytes.len() > limit {
        return Err(Diagnostic::new("input_too_large", "", 1, 1));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Diagnostic::new("invalid_utf8", "", 1, 1))?;
    let mut parser = Parser {
        text,
        offset: 0,
        line: 1,
        column: 1,
        positions: BTreeMap::new(),
    };
    let value = parser.value("", 0)?;
    parser.space();
    if parser.offset != text.len() {
        return Err(parser.error("invalid_json", ""));
    }
    Ok(Document {
        value,
        positions: parser.positions,
    })
}

pub fn child(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}
impl Parser<'_> {
    fn position(&self) -> (usize, usize) {
        (self.line, self.column)
    }
    fn advance(&mut self) {
        if self.byte() == Some(b'\n') {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += 1;
        }
        self.offset += 1;
    }
    fn error(&self, code: &str, pointer: &str) -> Diagnostic {
        let (line, column) = self.position();
        Diagnostic::new(code, pointer, line, column)
    }
    fn byte(&self) -> Option<u8> {
        self.text.as_bytes().get(self.offset).copied()
    }
    fn space(&mut self) {
        while matches!(self.byte(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.advance();
        }
    }
    fn consume(&mut self, value: u8, pointer: &str) -> Result<(), Diagnostic> {
        self.space();
        if self.byte() != Some(value) {
            return Err(self.error("invalid_json", pointer));
        }
        self.advance();
        Ok(())
    }
    fn string(&mut self, pointer: &str) -> Result<String, Diagnostic> {
        let start = self.offset;
        self.consume(b'"', pointer)?;
        let mut escaped = false;
        while let Some(byte) = self.byte() {
            self.advance();
            if byte == b'"' && !escaped {
                return serde_json::from_str(&self.text[start..self.offset])
                    .map_err(|_| self.error("invalid_json", pointer));
            }
            escaped = byte == b'\\' && !escaped;
        }
        Err(self.error("invalid_json", pointer))
    }
    fn value(&mut self, pointer: &str, depth: usize) -> Result<Value, Diagnostic> {
        self.space();
        if depth > MAX_DEPTH {
            return Err(self.error("depth_limit", pointer));
        }
        self.positions.insert(pointer.into(), self.position());
        match self.byte() {
            Some(b'{') => {
                self.advance();
                self.space();
                let mut map = Map::new();
                if self.byte() == Some(b'}') {
                    self.advance();
                    return Ok(Value::Object(map));
                }
                loop {
                    self.space();
                    let key_position = self.position();
                    let key = self.string(pointer)?;
                    let nested = child(pointer, &key);
                    if map.contains_key(&key) {
                        return Err(Diagnostic::new(
                            "duplicate_key",
                            &nested,
                            key_position.0,
                            key_position.1,
                        ));
                    }
                    self.consume(b':', &nested)?;
                    let value = self.value(&nested, depth + 1)?;
                    map.insert(key, value);
                    self.space();
                    match self.byte() {
                        Some(b'}') => {
                            self.advance();
                            break;
                        }
                        Some(b',') => self.advance(),
                        _ => return Err(self.error("invalid_json", pointer)),
                    }
                }
                Ok(Value::Object(map))
            }
            Some(b'[') => {
                self.advance();
                self.space();
                let mut values = Vec::new();
                if self.byte() == Some(b']') {
                    self.advance();
                    return Ok(Value::Array(values));
                }
                loop {
                    values.push(self.value(&child(pointer, &values.len().to_string()), depth + 1)?);
                    self.space();
                    match self.byte() {
                        Some(b']') => {
                            self.advance();
                            break;
                        }
                        Some(b',') => self.advance(),
                        _ => return Err(self.error("invalid_json", pointer)),
                    }
                }
                Ok(Value::Array(values))
            }
            Some(b'"') => self.string(pointer).map(Value::String),
            Some(_) => {
                let start = self.offset;
                while let Some(byte) = self.byte() {
                    if matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b',' | b'}' | b']') {
                        break;
                    }
                    self.advance();
                }
                let token = &self.text[start..self.offset];
                serde_json::from_str(token).map_err(|_| self.error("invalid_json", pointer))
            }
            None => Err(self.error("invalid_json", pointer)),
        }
    }
}
