//! Bounded binary messages for the guest agent and its host runtime client.
//! See the crate README for the v1 field order, units, limits and transitions.
mod fields;
use fields::*;
use std::io::{Read, Write};

/// Maximum payload, excluding the four-byte network-order length.
pub const MAX_FRAME: usize = 65536;
/// Highest implemented command schema.
pub const VERSION: u16 = 1;

/// Choose the highest version implemented by both peers, without assuming
/// that either endpoint has the newest implementation.
pub fn common_version(local: (u16, u16), peer: (u16, u16)) -> Option<u16> {
    let min = local.0.max(peer.0).max(1);
    let max = local.1.min(peer.1);
    (min <= max).then_some(max)
}
pub fn negotiate(min: u16, max: u16) -> Option<u16> {
    common_version((1, VERSION), (min, max))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Io,
    Size,
    Invalid,
}

/// Identity of one execution in one guest-agent incarnation.
#[derive(Clone, PartialEq, Eq)]
pub struct Handle {
    /// Lowercase hyphenated Linux boot UUID.
    pub boot: String,
    /// Lowercase hyphenated UUID minted at agent startup.
    pub incarnation: String,
    /// Random host execution ID, 32 lowercase hex digits.
    pub id: String,
}
impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Handle { .. }")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Interrupt,
    Terminate,
    Kill,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Wire implementations are sealed; field limits apply before allocation.
pub trait Message: private::Sealed + Sized {
    #[doc(hidden)]
    fn encode(&self, writer: &mut &mut [u8]) -> Result<(), Error>;
    #[doc(hidden)]
    fn decode(reader: &mut &[u8]) -> Result<Self, Error>;
}
mod private {
    pub trait Sealed {}
}

// Each field codec defines its Rust type, encoding and validation in both
// directions. Keeping the opcode and ordered fields together prevents drift.
macro_rules! messages {
    ($name:ident, $family:literal; $( $(#[$doc:meta])* $tag:literal => $variant:ident { $( $field:ident : $codec:ty ),* } ),+ $(,)?) => {
        #[derive(Clone,PartialEq,Eq)]
        pub enum $name { $( $(#[$doc])* $variant { $( $field: <$codec as Field>::Value ),* } ),+ }
        impl std::fmt::Debug for $name {
            fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
                f.write_str(match self { $(Self::$variant {..} => stringify!($variant)),+ })
            }
        }
        impl private::Sealed for $name {}
        impl Message for $name {
            fn encode(&self,w:&mut &mut [u8])->Result<(),Error>{
                match self {$(Self::$variant { $($field),* } => {
                    put(w,&[$family,$tag])?;
                    $(<$codec>::write(w,$field)?;)*
                }),+} Ok(())
            }
            fn decode(r:&mut &[u8])->Result<Self,Error>{
                if take(r,1)? != [$family] {return Err(Error::Invalid)}
                match take(r,1)?[0] { $($tag => Ok(Self::$variant { $($field:<$codec>::read(r)?),* })),+, _=>Err(Error::Invalid) }
            }
        }
    }
}
messages!(Request,1;
    /// Offer an inclusive range of supported schema versions.
    1=>Hello{min:U16,max:U16},
    /// Read guest identity and operating-system facts.
    2=>Facts{},
    /// Reserve a handle and launch argv in cwd with explicit env and initial stdin.
    3=>Start{handle:Execution,argv:Arguments,env:Environment,cwd:Directory,stdin:Bytes},
    /// Read the retained process outcome.
    4=>Inspect{handle:Execution},
    /// Deliver a signal to the owned child.
    5=>Signal{handle:Execution,signal:SignalCode},
    /// Read one stream starting at a byte offset.
    6=>Output{handle:Execution,stream:StreamCode,offset:U64},
    /// Discard a recorded result and retain an ID tombstone.
    7=>Release{handle:Execution},
    /// List all unreleased handles owned by this agent.
    8=>List{}
);
messages!(Response,2;
    /// Selected version and identities for this connection.
    1=>Welcome{version:U16,boot:Uuid,incarnation:Uuid},
    /// Architecture, kernel release, agent package version, UTC milliseconds and identities.
    2=>Facts{arch:Text<64>,kernel:Text<256>,agent_version:Text<64>,unix_ms:U64,boot:Uuid,incarnation:Uuid},
    /// No record in the current incarnation at the moment of inspection.
    3=>Absent{},
    /// An owned process has no observed terminal result yet.
    4=>Running{},
    /// The reserved command failed to spawn.
    5=>SpawnFailed{},
    /// The result has been released; the ID cannot start another command.
    6=>Released{},
    /// Process terminated with its normal exit code.
    7=>Exited{code:I32},
    /// Process terminated by a Linux signal number.
    8=>Signaled{signal:I32},
    /// Retained bytes at requested offset, end-of-pipe indicator and loss indicator.
    9=>Output{bytes:Bytes,eof:Flag,truncated:Flag},
    /// The requested effect was accepted.
    10=>Ack{},
    /// The execution belongs to another incarnation or its outcome is uncertain.
    11=>Unknown{},
    /// State or ID conflicts with the request.
    12=>Conflict{},
    /// Agent capacity exhausted.
    13=>Full{},
    /// Invalid request or incompatible handshake.
    14=>Invalid{},
    /// Current unreleased handles, suitable for reconnect reconciliation.
    15=>Handles{handles:Inventory}
);

pub fn read_frame<T: Message>(mut stream: impl Read) -> Result<T, Error> {
    let mut prefix = [0; 4];
    stream.read_exact(&mut prefix).map_err(|_| Error::Io)?;
    let n = u32::from_be_bytes(prefix) as usize;
    if !(1..=MAX_FRAME).contains(&n) {
        return Err(Error::Size);
    }
    let mut buf = vec![0; n];
    stream.read_exact(&mut buf).map_err(|_| Error::Io)?;
    let mut rest = &buf[..];
    let value = T::decode(&mut rest)?;
    if !rest.is_empty() {
        return Err(Error::Invalid);
    }
    Ok(value)
}
pub fn write_frame<T: Message>(mut stream: impl Write, value: &T) -> Result<(), Error> {
    let mut buf = vec![0; MAX_FRAME];
    let mut rest = &mut buf[..];
    value.encode(&mut rest)?;
    let size = MAX_FRAME - rest.len();
    stream
        .write_all(&(size as u32).to_be_bytes())
        .and_then(|()| stream.write_all(&buf[..size]))
        .map_err(|_| Error::Io)
}
