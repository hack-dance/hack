//! Versioned messages on a private host-to-guest stream.
//! Errors are deliberately independent of peer-controlled fields.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::{Read, Write};

pub const MAX_FRAME: usize = 65536;
pub const VERSION: u16 = 1;

pub fn negotiate(min: u16, max: u16) -> Option<u16> {
    (min <= VERSION && VERSION <= max).then_some(VERSION)
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Handle {
    pub boot: String,
    pub incarnation: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Hello {
        min: u16,
        max: u16,
    },
    Facts {},
    Start {
        handle: Handle,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        stdin: Vec<u8>,
    },
    Inspect {
        handle: Handle,
    },
    Signal {
        handle: Handle,
        signal: Signal,
    },
    Output {
        handle: Handle,
        stream: Stream,
        offset: u64,
    },
    Release {
        handle: Handle,
    },
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Signal {
    Interrupt,
    Terminate,
    Kill,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Welcome {
        version: u16,
        boot: String,
        incarnation: String,
    },
    Facts {
        arch: String,
        boot: String,
        incarnation: String,
    },
    Absent {},
    Running {},
    SpawnFailed {},
    Released {},
    Exited {
        code: i32,
    },
    Signaled {
        signal: i32,
    },
    Output {
        bytes: Vec<u8>,
        eof: bool,
        truncated: bool,
    },
    Ack {},
    Unknown {},
    Conflict {},
    Full {},
    Invalid {},
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Io,
    Size,
    Invalid,
}

/// Both peers must set an absolute exchange deadline on the transport.
pub fn read_frame<T: DeserializeOwned>(mut stream: impl Read) -> Result<T, Error> {
    let mut prefix = [0; 4];
    stream.read_exact(&mut prefix).map_err(|_| Error::Io)?;
    let size = u32::from_be_bytes(prefix) as usize;
    if !(1..=MAX_FRAME).contains(&size) {
        return Err(Error::Size);
    }
    let mut data = vec![0; size];
    stream.read_exact(&mut data).map_err(|_| Error::Io)?;
    serde_json::from_slice(&data).map_err(|_| Error::Invalid)
}

pub fn write_frame<T: Serialize>(mut stream: impl Write, value: &T) -> Result<(), Error> {
    // A fixed-size writer bounds serializer output before touching the transport.
    let mut body = vec![0; MAX_FRAME];
    let mut cursor = std::io::Cursor::new(body.as_mut_slice());
    serde_json::to_writer(&mut cursor, value).map_err(|_| Error::Size)?;
    let size = cursor.position() as usize;
    stream
        .write_all(&(size as u32).to_be_bytes())
        .and_then(|()| stream.write_all(&body[..size]))
        .map_err(|_| Error::Io)
}
